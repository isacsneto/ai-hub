import { describe, expect, it } from 'vitest';
import type { ClaudeDesktopProfile } from '../src/config.js';
import { SETTLE_MS, UpdateRelaunchWatcher, type WatchEvent, type WatchTarget } from '../src/relaunch-watch.js';

const APP = '/Applications/Claude.app';
const BIN = `${APP}/Contents/MacOS/Claude`;
const desk = (id: string, dataDir: string): ClaudeDesktopProfile => ({ id, tool: 'claude-desktop', label: id, dataDir });
const work = desk('desk-work', '/u/.aihub/profiles/desk-work');
const target = (p: ClaudeDesktopProfile): WatchTarget => ({ profile: p, app: APP, root: p.dataDir });
const profileProc = (pid: number, p = work) => ({ pid, args: `${BIN} --user-data-dir=${p.dataDir}` });
const defaultProc = (pid: number) => ({ pid, args: BIN });
const helper = (pid: number) => ({ pid, args: `${APP}/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=gpu-process --user-data-dir=${work.dataDir}` });
const SETTLE_TICKS = Math.ceil(SETTLE_MS / 3000) + 1;

/** A fake Mac: set the processes and the app version, then advance the clock tick by tick. */
function world(targets: WatchTarget[] = [target(work)], reopen?: () => Promise<void>) {
  const w = {
    t: 0,
    version: '1.0',
    targets,
    procs: [] as { pid: number; args: string }[],
    reopened: [] as string[],
    terminated: [] as number[],
    events: [] as WatchEvent[],
  };
  const watcher = new UpdateRelaunchWatcher({
    now: () => w.t,
    processes: async () => w.procs,
    appVersion: async () => w.version,
    reopen: reopen ?? (async (p) => void w.reopened.push(p.id)),
    terminate: (pid) => void w.terminated.push(pid),
    report: (e) => void w.events.push(e),
  });
  const tick = async (ms = 3000) => {
    w.t += ms;
    await watcher.tick(w.targets);
  };
  const ticks = async (n: number) => {
    for (let i = 0; i < n; i++) await tick();
  };
  return { w, tick, ticks };
}

describe('reopening a Claude profile after an update', () => {
  it('reopens the profile and closes the default window the update opened instead', async () => {
    const { w, tick, ticks } = world();
    w.procs = [profileProc(10), helper(11)];
    await ticks(2);
    // The update: the profile quits, the new version lands, Claude comes back without its folder.
    w.procs = [defaultProc(20)];
    w.version = '2.0';
    await tick();
    expect(w.reopened).toEqual([]); // gives Claude the chance to come back right first
    await ticks(SETTLE_TICKS);
    expect(w.reopened).toEqual(['desk-work']);
    expect(w.terminated).toEqual([20]);
    expect(w.events[0]).toMatchObject({ type: 'reopened', closedDefault: true });

    // Done: a default window the user opens afterwards is theirs.
    w.procs = [profileProc(30), defaultProc(31)];
    await ticks(30);
    expect(w.reopened).toEqual(['desk-work']);
    expect(w.terminated).toEqual([20]);
  });

  it('acts when the wrong window shows up only after the version changed', async () => {
    const { w, tick, ticks } = world();
    w.procs = [profileProc(10)];
    await ticks(2);
    w.procs = [];
    await tick();
    w.version = '2.0';
    await ticks(2);
    w.procs = [defaultProc(20)];
    await ticks(SETTLE_TICKS);
    expect(w.reopened).toEqual(['desk-work']);
    expect(w.terminated).toEqual([20]);
  });

  it('does nothing when Claude comes back in the right folder by itself', async () => {
    const { w, tick, ticks } = world();
    w.procs = [profileProc(10)];
    await ticks(2);
    w.procs = [];
    w.version = '2.0';
    await tick();
    w.procs = [profileProc(40)];
    await ticks(10);
    expect(w.reopened).toEqual([]);
    expect(w.terminated).toEqual([]);
  });

  it('does nothing when an update installs on quit without relaunching', async () => {
    const { w, tick, ticks } = world();
    w.procs = [profileProc(10)];
    await ticks(2);
    w.procs = [];
    w.version = '2.0';
    await tick();
    await ticks(60);
    expect(w.reopened).toEqual([]);
  });

  it('leaves alone a profile you quit, even if you then open the default and it updates', async () => {
    const { w, ticks } = world();
    w.procs = [profileProc(10)];
    await ticks(2);
    w.procs = [];
    await ticks(15); // quit by hand
    w.procs = [defaultProc(51)]; // the user opens plain Claude
    await ticks(10);
    w.version = '2.0'; // which then updates and restarts
    w.procs = [defaultProc(52)];
    await ticks(20);
    expect(w.reopened).toEqual([]);
    expect(w.terminated).toEqual([]);
  });

  it('keeps a default window that was already open', async () => {
    const { w, tick, ticks } = world();
    w.procs = [profileProc(10), defaultProc(5)];
    await ticks(2);
    w.procs = [defaultProc(5), defaultProc(20)];
    w.version = '2.0';
    await tick();
    await ticks(SETTLE_TICKS);
    expect(w.reopened).toEqual(['desk-work']);
    expect(w.terminated).toEqual([]);
    expect(w.events[0]).toMatchObject({ type: 'reopened', closedDefault: false });
  });

  it('keeps your default window when it restarts for the same update a moment earlier', async () => {
    const { w, tick, ticks } = world();
    w.procs = [profileProc(10), defaultProc(5)];
    await ticks(2);
    w.procs = [profileProc(10)]; // the default quits first
    await tick();
    w.procs = [];
    w.version = '2.0';
    await tick();
    w.procs = [defaultProc(6)]; // and comes back
    await ticks(SETTLE_TICKS);
    expect(w.reopened).toEqual(['desk-work']);
    expect(w.terminated).toEqual([]);
  });

  it('still knows about your default window after a tick without targets', async () => {
    const { w, tick, ticks } = world();
    w.procs = [profileProc(10), defaultProc(5)];
    await ticks(2);
    const saved = w.targets;
    w.targets = [];
    await tick();
    w.targets = saved;
    w.procs = [profileProc(10), defaultProc(5)];
    await tick(); // tracking starts again
    w.procs = [defaultProc(5), defaultProc(20)];
    w.version = '2.0';
    await tick();
    await ticks(SETTLE_TICKS);
    expect(w.terminated).toEqual([]);
  });

  it('forgets a profile removed while it waits', async () => {
    const { w, tick, ticks } = world();
    w.procs = [profileProc(10)];
    await ticks(2);
    w.procs = [defaultProc(20)];
    w.version = '2.0';
    await tick();
    w.targets = [];
    await ticks(SETTLE_TICKS);
    expect(w.reopened).toEqual([]);
    expect(w.terminated).toEqual([]);
  });

  it('starts over after the Mac slept instead of acting on what changed meanwhile', async () => {
    const { w, tick, ticks } = world();
    w.procs = [profileProc(10)];
    await ticks(2);
    w.procs = [defaultProc(20)];
    w.version = '2.0';
    await tick(8 * 3600_000);
    await ticks(10);
    expect(w.reopened).toEqual([]);
    expect(w.terminated).toEqual([]);
  });

  it("doesn't take a folder whose name continues with a space for another profile", async () => {
    const short = desk('desk-my', '/u/My');
    const long = desk('desk-my-work', '/u/My Work');
    const { w, tick, ticks } = world([target(short), target(long)]);
    w.procs = [profileProc(10, short), profileProc(11, long)];
    await ticks(2);
    w.procs = [profileProc(11, long), defaultProc(20)]; // only "My" quits
    w.version = '2.0';
    await tick();
    await ticks(SETTLE_TICKS);
    expect(w.reopened).toEqual(['desk-my']);
  });

  it('reports a reopen that fails, without retrying it', async () => {
    let tries = 0;
    const { w, tick, ticks } = world([target(work)], async () => {
      tries++;
      throw new Error('Claude.app was not found');
    });
    w.procs = [profileProc(10)];
    await ticks(2);
    w.procs = [defaultProc(20)];
    w.version = '2.0';
    await tick();
    await ticks(SETTLE_TICKS + 5);
    expect(tries).toBe(1);
    expect(w.events).toEqual([expect.objectContaining({ type: 'reopen-failed', message: 'Claude.app was not found' })]);
  });
});
