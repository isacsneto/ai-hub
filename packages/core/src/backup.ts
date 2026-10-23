import fs from 'node:fs/promises';
import path from 'node:path';
import { hubFile, parseHub, timestamp } from './config.js';
import type { Context } from './context.js';
import { ensureDir, exists, readTextIfExists } from './fsx.js';

/**
 * What an export contains: the registry, the library (with its history) and install records.
 * Never profiles/ (tool data, logins), the journal (may hold copies of tool config) or backups.
 */
const INCLUDED = ['hub.yaml', 'library', 'state'] as const;

export async function exportHub(ctx: Context, out: string): Promise<string[]> {
  const present: string[] = [];
  for (const name of INCLUDED) if (await exists(path.join(ctx.hubDir, name))) present.push(name);
  if (!present.length) throw new Error('Nothing to export yet.');
  await ensureDir(path.dirname(out), 0o755);
  const r = await ctx.sys.run('/usr/bin/tar', ['-czf', out, '-C', ctx.hubDir, ...present]);
  if (r.code !== 0) throw new Error(`tar failed: ${r.stderr.trim()}`);
  await fs.chmod(out, 0o600);
  return present;
}

/** Restore an export. The current registry/library/state are moved to backups first. */
export async function restoreHub(ctx: Context, file: string, opts: { force?: boolean } = {}): Promise<string> {
  if ((await exists(hubFile(ctx))) && !opts.force) {
    throw new Error('A hub already exists here; pass --force to replace it (the current one is kept in backups).');
  }
  const list = await ctx.sys.run('/usr/bin/tar', ['-tzf', file]);
  if (list.code !== 0) throw new Error(`Not a readable archive: ${list.stderr.trim()}`);
  const members = list.stdout.split('\n').filter(Boolean);
  const allowed = (m: string) =>
    !m.startsWith('/') && !m.split('/').includes('..') && INCLUDED.some((n) => m === n || m === `${n}/` || m.startsWith(`${n}/`));
  const bad = members.filter((m) => !allowed(m));
  if (bad.length) throw new Error(`Refusing archive with unexpected entries: ${bad.slice(0, 5).join(', ')}`);

  const keep = path.join(ctx.hubDir, 'backups', `${timestamp()}-before-restore`);
  await ensureDir(keep);
  for (const name of INCLUDED) {
    const p = path.join(ctx.hubDir, name);
    if (await exists(p)) await fs.rename(p, path.join(keep, name));
  }
  const putBack = async () => {
    for (const name of INCLUDED) {
      await fs.rm(path.join(ctx.hubDir, name), { recursive: true, force: true });
      if (await exists(path.join(keep, name))) await fs.rename(path.join(keep, name), path.join(ctx.hubDir, name));
    }
  };
  const r = await ctx.sys.run('/usr/bin/tar', ['-xzf', file, '-C', ctx.hubDir]);
  try {
    if (r.code !== 0) throw new Error(`tar failed: ${r.stderr.trim()}`);
    parseHub((await readTextIfExists(hubFile(ctx))) ?? '', 'restored hub.yaml');
  } catch (err) {
    await putBack();
    throw err;
  }
  return keep;
}
