import path from 'node:path';
import { claudeDesktop } from './adapters/claude-desktop.js';
import { preferences, type ClaudeDesktopProfile, type Hub } from './config.js';
import type { Context } from './context.js';
import { readPlistString } from './plist.js';

/**
 * Claude Desktop updates itself and restarts. Some versions restart without the --user-data-dir
 * (and CLAUDE_CONFIG_DIR) the profile was opened with, so the window that comes back is the default
 * account. The watcher notices that and puts it right: reopen the profile, close the default
 * window the update opened. When Claude comes back in the right folder by itself, it does nothing.
 */

export interface WatchTarget {
  profile: ClaudeDesktopProfile;
  /** The Claude.app this profile runs. */
  app: string;
  /** Its --user-data-dir. */
  root: string;
}

export type WatchEvent =
  | { type: 'reopened'; profile: ClaudeDesktopProfile; closedDefault: boolean }
  | { type: 'reopen-failed'; profile: ClaudeDesktopProfile; message: string }
  | { type: 'closed-default'; pid: number };

export interface WatchDeps {
  now(): number;
  processes(): Promise<{ pid: number; args: string }[]>;
  appVersion(app: string): Promise<string | undefined>;
  reopen(profile: ClaudeDesktopProfile): Promise<void>;
  terminate(pid: number): void;
  report(event: WatchEvent): void;
}

/** Wait this long after the update before acting, so Claude gets the chance to come back right. */
export const SETTLE_MS = 12_000;
/** A profile that quit counts as updated only if the app's version changes this close to the quit. */
const UPDATE_WINDOW_MS = 120_000;
const CHANGED_BEFORE_EXIT_MS = 30_000;
/** For this long after acting, a default window that shows up late is closed too. */
const SWEEP_MS = 60_000;
/** A longer gap between ticks means the Mac slept: start over rather than act on stale state. */
const GAP_MS = 30_000;

const hasArg = (args: string, arg: string) => {
  for (let i = args.indexOf(` ${arg}`); i !== -1; i = args.indexOf(` ${arg}`, i + 1)) {
    const after = args[i + arg.length + 1];
    if (after === undefined || after === ' ') return true;
  }
  return false;
};

export class UpdateRelaunchWatcher {
  private running = new Map<string, number>();
  private versions = new Map<string, { version?: string; changedAt?: number }>();
  private pending = new Map<string, { target: WatchTarget; exitedAt: number; defaultsBefore: Set<number> }>();
  private sweeps: { app: string; until: number; keep: Set<number> }[] = [];
  private lastDefaults = new Map<string, Set<number>>();
  private lastTick?: number;

  constructor(private deps: WatchDeps) {}

  async tick(targets: WatchTarget[]): Promise<void> {
    const now = this.deps.now();
    const slept = this.lastTick !== undefined && now - this.lastTick > GAP_MS;
    this.lastTick = now;

    const apps = [...new Set(targets.map((t) => t.app))];
    for (const app of apps) {
      const version = await this.deps.appVersion(app);
      const known = this.versions.get(app);
      // Mid-swap the bundle can be missing for a moment; keep the last version seen.
      if (!version) continue;
      if (!known?.version) this.versions.set(app, { version });
      else if (known.version !== version) this.versions.set(app, { version, changedAt: now });
    }

    const mains = (await this.deps.processes()).filter((p) => apps.some((a) => p.args.startsWith(`${a}/Contents/MacOS/`)));
    const defaultsOf = (app: string) =>
      mains.filter((p) => p.args.startsWith(`${app}/Contents/MacOS/`) && !p.args.includes(' --user-data-dir=')).map((p) => p.pid);
    const instanceOf = (t: WatchTarget) =>
      mains.find((p) => p.args.startsWith(`${t.app}/Contents/MacOS/`) && hasArg(p.args, `--user-data-dir=${t.root}`));
    const remember = () => (this.lastDefaults = new Map(apps.map((a) => [a, new Set(defaultsOf(a))])));

    if (slept) {
      this.running = new Map(targets.flatMap((t) => (instanceOf(t) ? [[t.profile.id, instanceOf(t)!.pid] as const] : [])));
      this.pending.clear();
      this.sweeps = [];
      remember();
      return;
    }

    this.sweeps = this.sweeps.filter((s) => now <= s.until);
    for (const s of this.sweeps) {
      for (const pid of defaultsOf(s.app)) {
        if (s.keep.has(pid)) continue;
        s.keep.add(pid);
        this.deps.terminate(pid);
        this.deps.report({ type: 'closed-default', pid });
      }
    }

    for (const t of targets) {
      const inst = instanceOf(t);
      if (inst) {
        this.running.set(t.profile.id, inst.pid);
        this.pending.delete(t.profile.id); // back by itself, in the right folder
      } else if (this.running.delete(t.profile.id)) {
        this.pending.set(t.profile.id, { target: t, exitedAt: now, defaultsBefore: this.lastDefaults.get(t.app) ?? new Set() });
      }
    }

    for (const [id, p] of this.pending) {
      const changedAt = this.versions.get(p.target.app)?.changedAt;
      const updated = changedAt !== undefined && changedAt >= p.exitedAt - CHANGED_BEFORE_EXIT_MS;
      if (!updated) {
        if (now - p.exitedAt > UPDATE_WINDOW_MS) this.pending.delete(id); // quit by hand
        continue;
      }
      if (now - Math.max(p.exitedAt, changedAt) < SETTLE_MS) continue;
      this.pending.delete(id);
      // Only close a default window the update opened: one that was already open stays.
      let closedDefault = false;
      if (!p.defaultsBefore.size) {
        const sweep = { app: p.target.app, until: now + SWEEP_MS, keep: new Set<number>() };
        for (const pid of defaultsOf(p.target.app)) {
          sweep.keep.add(pid);
          this.deps.terminate(pid);
          closedDefault = true;
        }
        this.sweeps.push(sweep);
      }
      try {
        await this.deps.reopen(p.target.profile);
        this.deps.report({ type: 'reopened', profile: p.target.profile, closedDefault });
      } catch (err) {
        this.deps.report({ type: 'reopen-failed', profile: p.target.profile, message: (err as Error).message });
      }
    }
    remember();
  }
}

/** Claude Desktop profiles with their own folder, unless `preferences.reopenAfterUpdate` is off. */
export async function watchTargets(ctx: Context, hub: Hub): Promise<WatchTarget[]> {
  if (!preferences(hub).reopenAfterUpdate) return [];
  const out: WatchTarget[] = [];
  for (const p of hub.profiles) {
    if (p.tool !== 'claude-desktop') continue;
    const paths = claudeDesktop.paths(ctx, p);
    if (paths.isDefault) continue;
    const app = await claudeDesktop.findBinary(ctx, p);
    if (app) out.push({ profile: p, app, root: paths.root });
  }
  return out;
}

export async function listProcesses(ctx: Context): Promise<{ pid: number; args: string }[]> {
  const r = await ctx.sys.run('/bin/ps', ['-axww', '-o', 'pid=,args=']);
  if (r.code !== 0) return [];
  return r.stdout.split('\n').flatMap((line) => {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    return m ? [{ pid: Number(m[1]), args: m[2]! }] : [];
  });
}

export const appVersion = (ctx: Context, app: string) =>
  readPlistString(ctx, path.join(app, 'Contents/Info.plist'), 'CFBundleShortVersionString');
