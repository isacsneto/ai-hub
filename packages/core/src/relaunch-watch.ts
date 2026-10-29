import path from 'node:path';
import { claudeDesktop } from './adapters/claude-desktop.js';
import { preferences, type ClaudeDesktopProfile, type Hub } from './config.js';
import type { Context } from './context.js';
import { resolvePath } from './paths.js';
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
  | { type: 'reopen-failed'; profile: ClaudeDesktopProfile; message: string };

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
/** An exit counts as part of an update only this close to the version change, either side. */
const NEAR_CHANGE_MS = 30_000;
/** How long after the exit a wrong relaunch is still waited for. */
const WAIT_MS = 120_000;
/** A default window seen this soon before the exit or the update was the user's own: never closed. */
const OWN_DEFAULT_MS = 120_000;
/** A longer gap between ticks means the Mac slept: start over rather than act on stale state. */
const GAP_MS = 30_000;

const hasArg = (args: string, arg: string) => {
  for (let i = args.indexOf(` ${arg}`); i !== -1; i = args.indexOf(` ${arg}`, i + 1)) {
    const after = args[i + arg.length + 1];
    if (after === undefined || after === ' ') return true;
  }
  return false;
};

/**
 * The decision, in short: a profile counts as wrongly relaunched only when (1) its window quit close
 * to a change of the app's version, (2) a new default-account window appeared after that, and (3) the
 * profile didn't come back by itself within SETTLE_MS. Then the profile is reopened; the new default
 * window is closed only if no default window was open around the update, so the user's own one stays.
 * A quit without a relaunch (an update installed on quit, or a plain quit) never matches (2).
 */
export class UpdateRelaunchWatcher {
  private running = new Map<string, number>();
  private versions = new Map<string, { version: string; changedAt?: number; defaultSeenBefore?: number }>();
  private pending = new Map<string, { target: WatchTarget; exitedAt: number; defaultBeforeExit?: number }>();
  /** When each default-account main process was first seen. */
  private firstSeen = new Map<number, number>();
  /** Last tick at which each app had a default window open. */
  private lastDefaultAt = new Map<string, number>();
  private lastTick?: number;

  constructor(private deps: WatchDeps) {}

  async tick(targets: WatchTarget[]): Promise<void> {
    const now = this.deps.now();
    const slept = this.lastTick !== undefined && now - this.lastTick > GAP_MS;
    this.lastTick = now;

    // A profile removed (or the preference turned off) is no longer watched, even mid-wait.
    const ids = new Set(targets.map((t) => t.profile.id));
    for (const id of [...this.pending.keys(), ...this.running.keys()]) {
      if (!ids.has(id)) {
        this.pending.delete(id);
        this.running.delete(id);
      }
    }
    if (!targets.length) return; // nothing to watch: no ps every 3 seconds

    const apps = [...new Set(targets.map((t) => t.app))];
    const before = new Map(this.lastDefaultAt);
    for (const app of apps) {
      const version = await this.deps.appVersion(app);
      const known = this.versions.get(app);
      // Mid-swap the bundle can be missing for a moment; keep the last version seen.
      if (!version) continue;
      if (!known) this.versions.set(app, { version });
      else if (known.version !== version) this.versions.set(app, { version, changedAt: now, defaultSeenBefore: before.get(app) });
    }

    const procs = await this.deps.processes();
    const mainsOf = (app: string) => procs.filter((p) => p.args.startsWith(`${app}/Contents/MacOS/`));
    const defaultsOf = (app: string) => mainsOf(app).filter((p) => !p.args.includes(' --user-data-dir=')).map((p) => p.pid);
    // ps joins arguments with spaces, so "/x/My" also matches "/x/My Work": the longest folder wins.
    const ownerOf = (args: string, app: string) =>
      targets
        .filter((t) => t.app === app && hasArg(args, `--user-data-dir=${t.root}`))
        .sort((a, b) => b.root.length - a.root.length)[0];
    const instanceOf = (t: WatchTarget) => mainsOf(t.app).find((p) => ownerOf(p.args, t.app) === t);

    const alive = new Set(procs.map((p) => p.pid));
    for (const pid of this.firstSeen.keys()) if (!alive.has(pid)) this.firstSeen.delete(pid);
    for (const app of apps) {
      const pids = defaultsOf(app);
      for (const pid of pids) if (!this.firstSeen.has(pid)) this.firstSeen.set(pid, now);
      if (pids.length) this.lastDefaultAt.set(app, now);
    }

    if (slept) {
      this.running.clear();
      for (const t of targets) {
        const inst = instanceOf(t);
        if (inst) this.running.set(t.profile.id, inst.pid);
      }
      this.pending.clear();
      return;
    }

    for (const t of targets) {
      const inst = instanceOf(t);
      if (inst) {
        this.running.set(t.profile.id, inst.pid);
        this.pending.delete(t.profile.id); // back by itself, in the right folder
      } else if (this.running.delete(t.profile.id)) {
        this.pending.set(t.profile.id, { target: t, exitedAt: now, defaultBeforeExit: before.get(t.app) });
      }
    }

    for (const [id, p] of this.pending) {
      const app = p.target.app;
      const v = this.versions.get(app);
      const changedAt = v?.changedAt;
      const updated = changedAt !== undefined && Math.abs(changedAt - p.exitedAt) <= NEAR_CHANGE_MS;
      const since = Math.min(p.exitedAt, changedAt ?? p.exitedAt);
      const fresh = updated ? defaultsOf(app).filter((pid) => (this.firstSeen.get(pid) ?? 0) >= since) : [];
      if (!fresh.length || now - Math.max(p.exitedAt, changedAt!) < SETTLE_MS) {
        if (now - p.exitedAt > WAIT_MS) this.pending.delete(id); // quit by hand, or the update didn't relaunch
        continue;
      }
      this.pending.delete(id);
      // Only sightings from before the exit/update count: later ones may be the window the update opened.
      const ownDefault = [p.defaultBeforeExit, v?.defaultSeenBefore].some((t) => t !== undefined && t < since && t >= since - OWN_DEFAULT_MS);
      if (!ownDefault) for (const pid of fresh) this.deps.terminate(pid);
      try {
        await this.deps.reopen(p.target.profile);
        this.deps.report({ type: 'reopened', profile: p.target.profile, closedDefault: !ownDefault });
      } catch (err) {
        this.deps.report({ type: 'reopen-failed', profile: p.target.profile, message: (err as Error).message });
      }
    }
  }
}

/** Claude Desktop profiles with their own folder, unless `preferences.reopenAfterUpdate` is off. */
export async function watchTargets(ctx: Context, hub: Hub): Promise<WatchTarget[]> {
  if (preferences(hub).reopenAfterUpdate === false) return [];
  const out: WatchTarget[] = [];
  for (const p of hub.profiles) {
    if (p.tool !== 'claude-desktop') continue;
    const paths = claudeDesktop.paths(ctx, p);
    if (paths.isDefault) continue;
    // Mid-update the bundle can be missing for a moment: keep watching where it was.
    const app = (await claudeDesktop.findBinary(ctx, p)) ?? (p.app ? resolvePath(p.app, ctx.home) : '/Applications/Claude.app');
    out.push({ profile: p, app, root: paths.root });
  }
  return out;
}

/** Running processes and their command lines; with `env`, each line also lists the environment (own processes only). */
export async function listProcesses(ctx: Context, opts: { env?: boolean } = {}): Promise<{ pid: number; args: string }[]> {
  const r = await ctx.sys.run('/bin/ps', [opts.env ? '-axeww' : '-axww', '-o', 'pid=,args=']);
  if (r.code !== 0) return [];
  return r.stdout.split('\n').flatMap((line) => {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    return m ? [{ pid: Number(m[1]), args: m[2]! }] : [];
  });
}

export const appVersion = (ctx: Context, app: string) =>
  readPlistString(ctx, path.join(app, 'Contents/Info.plist'), 'CFBundleShortVersionString');
