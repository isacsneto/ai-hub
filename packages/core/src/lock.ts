import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Context } from './context.js';
import { ensureDir } from './fsx.js';

const held = new AsyncLocalStorage<ReadonlySet<string>>();
const queues = new Map<string, Promise<void>>();

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Create the lock file, waiting for another live process to finish; a dead holder's lock is taken over. */
async function acquire(file: string, timeoutMs: number): Promise<void> {
  await ensureDir(path.dirname(file));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.writeFile(file, String(process.pid), { flag: 'wx' });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const pid = Number(await fs.readFile(file, 'utf8').catch(() => ''));
    if (!pid || !alive(pid)) {
      await fs.rm(file, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`Another AI-Hub change is in progress (process ${pid}). Try again in a moment.`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Run `fn` while holding the hub lock, so two changes (two clicks, or the app and the CLI) never
 * interleave their reads and writes. Re-entrant: nested calls in the same async flow just run.
 */
export async function withHubLock<T>(ctx: Context, fn: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
  const key = ctx.hubDir;
  if (held.getStore()?.has(key)) return fn();
  // Queue callers in this process first, so they don't spin on the file.
  const prev = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  queues.set(key, tail);
  await prev;
  const file = path.join(key, '.lock');
  try {
    await acquire(file, timeoutMs);
    try {
      return await held.run(new Set([...(held.getStore() ?? []), key]), fn);
    } finally {
      await fs.rm(file, { force: true });
    }
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}
