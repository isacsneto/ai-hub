import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { timestamp } from './config.js';
import type { Context } from './context.js';
import { atomicWrite, ensureDir, exists, readJsonIfExists } from './fsx.js';
import { hashPath } from './library.js';
import { withHubLock } from './lock.js';

/**
 * One reversible filesystem change. `backup` is where the previous content was moved to; `hash`
 * is what the hub left there, so undo can tell whether someone has edited it since.
 */
export type Op =
  | { op: 'mkdir'; path: string }
  | { op: 'symlink'; path: string; target: string }
  | { op: 'copy'; path: string; hash?: string }
  | { op: 'write'; path: string; backup?: string; hash?: string; records?: boolean }
  | { op: 'remove'; path: string; backup: string };

interface Journal {
  label: string;
  createdAt: string;
  ops: Op[];
  /** False until the run finished; a crashed run's journal still lists what it did, for undo. */
  committed?: boolean;
  undone?: string;
  /** An undo or rollback stopped partway: `ops` now lists only what is left, for the next undo to retry. */
  unfinished?: boolean;
}

export interface UndoResult {
  label: string;
  /** Changes reversed by this run. */
  reverted: number;
  /** Left as they are on purpose (edited since, or something new in the way); final, never retried. */
  kept: string[];
  /** Couldn't be reversed (permissions, disk); still in the journal, so the next undo retries them. */
  failed: string[];
  /** This run finished an undo that stopped partway before. */
  resumed: boolean;
}

export const journalRoot = (ctx: Context) => path.join(ctx.hubDir, 'journal');

/**
 * Every change the hub makes inside a tool folder goes through a Transaction. Nothing is ever
 * deleted outright: replaced or removed things are moved into the journal folder, so a failed
 * run rolls back and `aihub undo` can reverse the last one.
 */
export class Transaction {
  readonly ops: Op[] = [];
  readonly dir: string;
  private n = 0;

  constructor(
    private ctx: Context,
    readonly label: string,
  ) {
    // The random part keeps two runs started in the same millisecond apart.
    this.dir = path.join(journalRoot(ctx), `${timestamp()}-${label.replace(/[^\w.-]+/g, '-')}-${randomBytes(3).toString('hex')}`);
    this.createdAt = new Date().toISOString();
  }

  private readonly createdAt: string;

  /** Write-ahead: the journal on disk always lists every change made so far. */
  private async record(op?: Op, extra: Partial<Journal> = {}): Promise<void> {
    if (op) this.ops.push(op);
    if (!this.ops.length) return;
    const journal: Journal = { label: this.label, createdAt: this.createdAt, ops: this.ops, committed: false, ...extra };
    await atomicWrite(path.join(this.dir, 'journal.json'), JSON.stringify(journal, null, 2) + '\n');
  }

  private async backupSlot(p: string): Promise<string> {
    await ensureDir(path.join(this.dir, 'backup'));
    return path.join(this.dir, 'backup', `${this.n++}-${path.basename(p)}`);
  }

  /** Create missing parent folders, recording each one so rollback removes only what we made. */
  async mkdirp(dir: string): Promise<void> {
    const missing: string[] = [];
    for (let d = dir; !(await exists(d)); d = path.dirname(d)) missing.unshift(d);
    for (const d of missing) {
      try {
        await fs.mkdir(d);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue; // made by someone else meanwhile: not ours
        throw err;
      }
      await this.record({ op: 'mkdir', path: d });
    }
  }

  async symlink(target: string, p: string): Promise<void> {
    if (await exists(p)) throw new Error(`${p} already exists`);
    await this.mkdirp(path.dirname(p));
    await fs.symlink(target, p);
    await this.record({ op: 'symlink', path: p, target });
  }

  async copy(src: string, p: string): Promise<void> {
    if (await exists(p)) throw new Error(`${p} already exists`);
    await this.mkdirp(path.dirname(p));
    // Recorded before copying, so a copy cut short is still cleaned up; the hash marks it complete.
    const op: Op = { op: 'copy', path: p };
    await this.record(op);
    await fs.cp(src, p, { recursive: true, dereference: true, errorOnExist: true });
    op.hash = await hashPath(p);
    await this.record();
  }

  /** `records`: p is a hub install-records file (see revert). */
  async write(p: string, content: string, opts: { records?: boolean } = {}): Promise<void> {
    // Writing replaces the file, which would silently turn a link (e.g. into dotfiles) into a copy.
    if ((await fs.lstat(p).catch(() => undefined))?.isSymbolicLink()) {
      throw new Error(`${p} is a symbolic link; the hub won't replace it with a file`);
    }
    let backup: string | undefined;
    if (await exists(p)) {
      backup = await this.backupSlot(p);
      await fs.copyFile(p, backup);
    } else {
      await this.mkdirp(path.dirname(p));
    }
    const op: Op = { op: 'write', path: p, ...(backup ? { backup } : {}), ...(opts.records ? { records: true } : {}) };
    await this.record(op);
    const mode = backup ? (await fs.stat(backup)).mode & 0o777 : 0o644;
    await atomicWrite(p, content, mode);
    op.hash = await hashPath(p);
    await this.record();
  }

  /** Move something out of the way (into the journal). Works for links, files and folders. */
  async remove(p: string): Promise<void> {
    const backup = await this.backupSlot(p);
    // Recorded first: if the move is cut short, undo still knows where the original went.
    await this.record({ op: 'remove', path: p, backup });
    try {
      await fs.rename(p, backup);
    } catch {
      await fs.cp(p, backup, { recursive: true, verbatimSymlinks: true });
      await fs.rm(p, { recursive: true, force: true });
    }
  }

  async rollback(): Promise<string[]> {
    const { kept, failed, remaining } = await revertAll(this.ops);
    if (remaining.length) {
      // What couldn't be reversed stays in the journal, so `aihub undo` can finish the rollback.
      this.ops.splice(0, this.ops.length, ...remaining);
      await this.record(undefined, { unfinished: true });
    } else {
      await this.record(undefined, { undone: new Date().toISOString() });
    }
    this.ops.length = 0;
    return [...failed, ...kept];
  }

  async commit(): Promise<void> {
    await this.record(undefined, { committed: true });
  }
}

/** Undo left this alone on purpose, so nothing is lost; unlike other errors it isn't retried. */
class Kept extends Error {}

/** Has the hub's copy or write been edited since? Then undo leaves it alone rather than lose the edit. */
async function changedSince(o: { path: string; hash?: string }): Promise<boolean> {
  if (!o.hash) return false; // never completed: whatever is there is ours
  return (await hashPath(o.path).catch(() => undefined)) !== o.hash && (await exists(o.path));
}

async function revert(o: Op): Promise<void> {
  switch (o.op) {
    case 'mkdir':
      await fs.rmdir(o.path).catch(() => undefined); // only if still empty
      return;
    case 'symlink': {
      const st = await fs.lstat(o.path).catch(() => undefined);
      if (st?.isSymbolicLink() && (await fs.readlink(o.path)) === o.target) await fs.rm(o.path);
      return;
    }
    case 'copy':
      if (await changedSince(o)) throw new Kept('edited since the hub placed it; left as is');
      await fs.rm(o.path, { recursive: true, force: true });
      return;
    case 'write':
      if (o.records) return revertRecords(o.path, o.backup);
      if (await changedSince(o)) throw new Kept('edited since the hub wrote it; left as is');
      if (o.backup) await fs.copyFile(o.backup, o.path);
      else await fs.rm(o.path, { force: true });
      return;
    case 'remove':
      if (!(await exists(o.backup))) return; // the move never happened
      if (await exists(o.path)) throw new Kept(`something new is in its place; left it, and the original is in ${o.backup}`);
      try {
        await fs.rename(o.backup, o.path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        await fs.cp(o.backup, o.path, { recursive: true, verbatimSymlinks: true });
        await fs.rm(o.backup, { recursive: true, force: true });
      }
      return;
  }
}

/**
 * Install records go back to how they were, except plugin records: undo never uninstalls plugins,
 * and plugin installs are recorded after the transaction, so their current records stay true.
 */
async function revertRecords(file: string, backup: string | undefined): Promise<void> {
  type Records = { version: 1; installs: { kind: string }[] };
  const now = ((await readJsonIfExists(file)) as Records | undefined)?.installs ?? [];
  const before = backup ? (((await readJsonIfExists(backup)) as Records | undefined)?.installs ?? []) : [];
  const installs = [...before.filter((r) => r.kind !== 'plugins'), ...now.filter((r) => r.kind === 'plugins')];
  await atomicWrite(file, JSON.stringify({ version: 1, installs }, null, 2) + '\n');
}

async function revertAll(ops: Op[]): Promise<{ kept: string[]; failed: string[]; remaining: Op[] }> {
  const kept: string[] = [];
  const failed: string[] = [];
  const remaining: Op[] = [];
  for (const o of [...ops].reverse()) {
    try {
      await revert(o);
    } catch (err) {
      const line = `${o.op} ${o.path}: ${(err as Error).message}`;
      if (err instanceof Kept) kept.push(line);
      else {
        failed.push(line);
        remaining.unshift(o); // keeps the original order, so a retry reverses in reverse again
      }
    }
  }
  return { kept, failed, remaining };
}

/** Run `fn` in a transaction, holding the hub lock: commit on success, roll everything back on failure. */
export async function withTransaction<T>(ctx: Context, label: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return withHubLock(ctx, async () => {
    const tx = new Transaction(ctx, label);
    try {
      const result = await fn(tx);
      await tx.commit();
      return result;
    } catch (err) {
      const problems = await tx.rollback();
      if (problems.length) {
        (err as Error).message += `\nRollback was incomplete:\n  ${problems.join('\n  ')}`;
      }
      throw err;
    }
  });
}

/**
 * Reverse the most recent run that hasn't been undone. If some changes can't be reversed, they stay
 * in the journal and the next call retries them before going further back.
 */
export async function undoLast(ctx: Context): Promise<UndoResult | undefined> {
  return withHubLock(ctx, () => undoLastUnlocked(ctx));
}

/** The newest journal not yet undone (uncommitted ones are runs that crashed midway). */
async function lastOpenJournal(ctx: Context): Promise<{ file: string; journal: Journal } | undefined> {
  let dirs: string[];
  try {
    dirs = (await fs.readdir(journalRoot(ctx))).sort().reverse();
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const file = path.join(journalRoot(ctx), d, 'journal.json');
    const journal = (await readJsonIfExists(file)) as Journal | undefined;
    if (journal && !journal.undone) return { file, journal };
  }
  return undefined;
}

async function undoLastUnlocked(ctx: Context): Promise<UndoResult | undefined> {
  const open = await lastOpenJournal(ctx);
  if (!open) return undefined;
  const { file, journal } = open;
  const resumed = !!journal.unfinished;
  const { kept, failed, remaining } = await revertAll(journal.ops);
  const reverted = journal.ops.length - remaining.length - kept.length;
  if (remaining.length) {
    journal.ops = remaining;
    journal.unfinished = true;
  } else {
    journal.undone = new Date().toISOString();
  }
  await atomicWrite(file, JSON.stringify(journal, null, 2) + '\n');
  return { label: journal.label, reverted, kept, failed, resumed };
}

/**
 * Stop retrying an undo that stopped partway: what it couldn't reverse stays as it is, and the next
 * undo goes on to the run before it. Returns the label and how many changes were left, if any.
 */
export async function abandonUnfinishedUndo(ctx: Context): Promise<{ label: string; left: number } | undefined> {
  return withHubLock(ctx, async () => {
    const open = await lastOpenJournal(ctx);
    if (!open?.journal.unfinished) return undefined;
    const { file, journal } = open;
    journal.undone = new Date().toISOString();
    await atomicWrite(file, JSON.stringify(journal, null, 2) + '\n');
    return { label: journal.label, left: journal.ops.length };
  });
}
