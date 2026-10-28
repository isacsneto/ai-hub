import fs from 'node:fs/promises';
import path from 'node:path';
import { saveHub, timestamp, type Hub } from './config.js';
import type { Context } from './context.js';
import { GUARD_PLIST } from './discover.js';
import { atomicWrite, ensureDir, exists, readJsonIfExists } from './fsx.js';

/** managedBy values the hub can take over from. */
const TAKEOVER_FROM = new Set(['claude-account-guard', 'cpm', 'claude-profiles']);

interface TakeoverRecord {
  at: string;
  plistBackup?: string;
  profiles: { id: string; managedBy: string }[];
}

const recordFile = (ctx: Context) => path.join(ctx.hubDir, 'takeover.json');

export interface TakeoverPlan {
  steps: string[];
  notes: string[];
  profiles: string[];
}

/**
 * Hand folders managed by claude-account-guard / cpm / Claude Profiles over to the hub:
 * stop the guard's LaunchAgent (its plist is kept in ~/.aihub/backups) and clear managedBy.
 * Reversible with `aihub takeover --undo`.
 */
export async function takeover(ctx: Context, hub: Hub, opts: { dryRun?: boolean } = {}): Promise<TakeoverPlan> {
  const plist = path.join(ctx.home, GUARD_PLIST);
  const hasGuard = await exists(plist);
  const managed = hub.profiles.filter((p) => p.managedBy && TAKEOVER_FROM.has(p.managedBy));
  const steps: string[] = [];
  const notes = [
    'cpm keeps working for its own wrappers (claude-work…); avoid `cpm install` re-creating whole-folder links: set share = [] in ~/.claude-profiles/config.toml.',
    'Claude Profiles.app launchers keep working; the hub only stops treating their folders as read-only.',
  ];
  if (hasGuard) steps.push(`stop LaunchAgent local.claude-account-guard and move its plist to ~/.aihub/backups`);
  for (const p of managed) steps.push(`${p.id}: stop treating as managed by ${p.managedBy}`);
  if (opts.dryRun || (!hasGuard && !managed.length)) return { steps, notes, profiles: managed.map((p) => p.id) };

  // A later takeover (say, after importing another cpm profile) adds to the first one's record,
  // so --undo still restores everything.
  const previous = (await readJsonIfExists(recordFile(ctx))) as TakeoverRecord | undefined;
  const record: TakeoverRecord = previous ?? { at: new Date().toISOString(), profiles: [] };
  for (const p of managed) {
    if (!record.profiles.some((r) => r.id === p.id)) record.profiles.push({ id: p.id, managedBy: p.managedBy! });
  }
  if (hasGuard) {
    const dir = path.join(ctx.hubDir, 'backups', `${timestamp()}-takeover`);
    await ensureDir(dir);
    const backup = path.join(dir, path.basename(plist));
    await fs.copyFile(plist, backup);
    record.plistBackup = backup;
  }
  // Write the record before changing anything, so nothing is ever done that --undo doesn't know about.
  await atomicWrite(recordFile(ctx), JSON.stringify(record, null, 2) + '\n');
  if (hasGuard) {
    const uid = process.getuid?.() ?? 501;
    await ctx.sys.run('/bin/launchctl', ['bootout', `gui/${uid}`, plist]); // fine if it wasn't loaded
    await fs.rm(plist);
  }
  for (const p of managed) delete p.managedBy;
  await saveHub(ctx, hub);
  return { steps, notes, profiles: managed.map((p) => p.id) };
}

export async function undoTakeover(ctx: Context, hub: Hub, opts: { dryRun?: boolean } = {}): Promise<string[]> {
  const record = (await readJsonIfExists(recordFile(ctx))) as TakeoverRecord | undefined;
  if (!record) throw new Error('No takeover to undo.');
  if (opts.dryRun) {
    return [
      ...(record.plistBackup ? ['restore and start the claude-account-guard LaunchAgent'] : []),
      ...record.profiles.filter(({ id }) => hub.profiles.some((p) => p.id === id)).map(({ id, managedBy }) => `${id}: managed by ${managedBy} again`),
    ];
  }
  const done: string[] = [];
  if (record.plistBackup && (await exists(record.plistBackup))) {
    const plist = path.join(ctx.home, GUARD_PLIST);
    await ensureDir(path.dirname(plist), 0o755);
    await fs.copyFile(record.plistBackup, plist);
    const uid = process.getuid?.() ?? 501;
    await ctx.sys.run('/bin/launchctl', ['bootstrap', `gui/${uid}`, plist]);
    done.push('restored and started the claude-account-guard LaunchAgent');
  }
  for (const { id, managedBy } of record.profiles) {
    const p = hub.profiles.find((q) => q.id === id);
    if (p) {
      p.managedBy = managedBy;
      done.push(`${id}: managed by ${managedBy} again`);
    }
  }
  await saveHub(ctx, hub);
  await fs.rm(recordFile(ctx));
  return done;
}
