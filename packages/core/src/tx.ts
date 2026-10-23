import fs from 'node:fs/promises';
import path from 'node:path';
import { timestamp } from './config.js';
import type { Context } from './context.js';
import { atomicWrite, ensureDir, exists, readJsonIfExists } from './fsx.js';

/** One reversible filesystem change. `backup` is where the previous content was moved to. */
export type Op =
  | { op: 'mkdir'; path: string }
  | { op: 'symlink'; path: string; target: string }
  | { op: 'copy'; path: string }
  | { op: 'write'; path: string; backup?: string }
  | { op: 'remove'; path: string; backup: string };

interface Journal {
  label: string;
  createdAt: string;
  ops: Op[];
  undone?: string;
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
    this.dir = path.join(journalRoot(ctx), `${timestamp()}-${label.replace(/[^\w.-]+/g, '-')}`);
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
      await fs.mkdir(d);
      this.ops.push({ op: 'mkdir', path: d });
    }
  }

  async symlink(target: string, p: string): Promise<void> {
    if (await exists(p)) throw new Error(`${p} already exists`);
    await this.mkdirp(path.dirname(p));
    await fs.symlink(target, p);
    this.ops.push({ op: 'symlink', path: p, target });
  }

  async copy(src: string, p: string): Promise<void> {
    if (await exists(p)) throw new Error(`${p} already exists`);
    await this.mkdirp(path.dirname(p));
    await fs.cp(src, p, { recursive: true, dereference: true, errorOnExist: true });
    this.ops.push({ op: 'copy', path: p });
  }

  async write(p: string, content: string): Promise<void> {
    let backup: string | undefined;
    if (await exists(p)) {
      backup = await this.backupSlot(p);
      await fs.copyFile(p, backup);
    } else {
      await this.mkdirp(path.dirname(p));
    }
    const mode = backup ? (await fs.stat(backup)).mode & 0o777 : 0o644;
    await atomicWrite(p, content, mode);
    this.ops.push({ op: 'write', path: p, ...(backup ? { backup } : {}) });
  }

  /** Move something out of the way (into the journal). Works for links, files and folders. */
  async remove(p: string): Promise<void> {
    const backup = await this.backupSlot(p);
    try {
      await fs.rename(p, backup);
    } catch {
      await fs.cp(p, backup, { recursive: true, verbatimSymlinks: true });
      await fs.rm(p, { recursive: true, force: true });
    }
    this.ops.push({ op: 'remove', path: p, backup });
  }

  async rollback(): Promise<string[]> {
    const problems: string[] = [];
    for (const o of [...this.ops].reverse()) {
      try {
        await revert(o);
      } catch (err) {
        problems.push(`${o.op} ${o.path}: ${(err as Error).message}`);
      }
    }
    this.ops.length = 0;
    return problems;
  }

  async commit(): Promise<void> {
    if (!this.ops.length) return;
    const journal: Journal = { label: this.label, createdAt: new Date().toISOString(), ops: this.ops };
    await atomicWrite(path.join(this.dir, 'journal.json'), JSON.stringify(journal, null, 2) + '\n');
  }
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
      await fs.rm(o.path, { recursive: true, force: true });
      return;
    case 'write':
      if (o.backup) await fs.copyFile(o.backup, o.path);
      else await fs.rm(o.path, { force: true });
      return;
    case 'remove':
      if (await exists(o.path)) throw new Error('something new is in its place; left both');
      await fs.rename(o.backup, o.path);
      return;
  }
}

/** Run `fn` in a transaction: commit on success, roll everything back on failure. */
export async function withTransaction<T>(ctx: Context, label: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
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
}

/** Reverse the most recent committed transaction that hasn't been undone. */
export async function undoLast(ctx: Context): Promise<{ label: string; reverted: number; problems: string[] } | undefined> {
  let dirs: string[];
  try {
    dirs = (await fs.readdir(journalRoot(ctx))).sort().reverse();
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const file = path.join(journalRoot(ctx), d, 'journal.json');
    const journal = (await readJsonIfExists(file)) as Journal | undefined;
    if (!journal || journal.undone) continue;
    const problems: string[] = [];
    for (const o of [...journal.ops].reverse()) {
      try {
        await revert(o);
      } catch (err) {
        problems.push(`${o.op} ${o.path}: ${(err as Error).message}`);
      }
    }
    journal.undone = new Date().toISOString();
    await atomicWrite(file, JSON.stringify(journal, null, 2) + '\n');
    return { label: journal.label, reverted: journal.ops.length, problems };
  }
  return undefined;
}
