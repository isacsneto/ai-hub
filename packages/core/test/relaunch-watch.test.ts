import { describe, expect, it } from 'vitest';
import type { ClaudeDesktopProfile } from '../src/config.js';
import { SETTLE_MS, UpdateRelaunchWatcher, type WatchEvent, type WatchTarget } from '../src/relaunch-watch.js';

const APP = '/Applications/Claude.app';
const BIN = `${APP}/Contents/MacOS/Claude`;
const work: ClaudeDesktopProfile = { id: 'desk-work', tool: 'claude-desktop', label: 'Claude · Work', dataDir: '/u/.aihub/profiles/desk-work' };
const target: WatchTarget = { profile: work, app: APP, root: work.dataDir };
const profileProc = (pid: number) => ({ pid, args: `${BIN} --user-data-dir=${work.dataDir}` });
const defaultProc = (pid: number) => ({ pid, args: BIN });
const helper = (pid: number) => ({ pid, args: `${APP}/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=gpu-process --user-data-dir=${work.dataDir}` });

/** A fake Mac: set the processes and the app version, then advance the clock tick by tick. */
function world() {
  const w = {
    t: 0,
    version: '1.0',
    procs: [] as { pid: number; args: string }[],
    reopened: [] as string[],
    terminated: [] as number[],
    events: [] as WatchEvent[],
  };
  const watcher = new UpdateRelaunchWatcher({
    now: () => w.t,
    processes: async () => w.procs,
    appVersion: async () => w.version,
    reopen: async (p) => void w.reopened.push(p.id),
    terminate: (pid) => void w.terminated.push(pid),
    report: (e) => void w.events.push(e),
  });
  const tick = async (ms = 3000) => {
    w.t += ms;
    await watcher.tick([target]);
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
    await ticks(Math.ceil(SETTLE_MS / 3000));
    expect(w.reopened).toEqual(['desk-work']);
    expect(w.terminated).toEqual([20]);
    expect(w.events[0]).toMatchObject({ type: 'reopened', closedDefault: true });

    // Only once, and a default window that shows up late is closed too.
    w.procs = [profileProc(30), defaultProc(31)];
    await ticks(3);
    expect(w.reopened).toEqual(['desk-work']);
    expect(w.terminated).toEqual([20, 31]);
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

  it('leaves alone a profile you quit yourself', async () => {
    const { w, ticks } = world();
    w.procs = [profileProc(10)];
    await ticks(2);
    w.procs = [];
    await ticks(60);
    w.version = '2.0'; // an update much later doesn't count
    w.procs = [defaultProc(50)];
    await ticks(10);
    expect(w.reopened).toEqual([]);
    expect(w.terminated).toEqual([]);
  });

  it('keeps a default window that was already open', async () => {
    const { w, tick, ticks } = world();
    w.procs = [profileProc(10), defaultProc(5)];
    await ticks(2);
    w.procs = [defaultProc(5)];
    w.version = '2.0';
    await tick();
    await ticks(5);
    expect(w.reopened).toEqual(['desk-work']);
    expect(w.terminated).toEqual([]);
    expect(w.events[0]).toMatchObject({ type: 'reopened', closedDefault: false });
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

  it('reports a reopen that fails, without retrying it', async () => {
    const events: WatchEvent[] = [];
    let t = 0;
    let procs = [profileProc(10)];
    let version = '1.0';
    let tries = 0;
    const watcher = new UpdateRelaunchWatcher({
      now: () => t,
      processes: async () => procs,
      appVersion: async () => version,
      reopen: async () => {
        tries++;
        throw new Error('Claude.app was not found');
      },
      terminate: () => {},
      report: (e) => void events.push(e),
    });
    const tick = async () => {
      t += 3000;
      await watcher.tick([target]);
    };
    for (let i = 0; i < 2; i++) await tick();
    procs = [];
    version = '2.0';
    for (let i = 0; i < 12; i++) await tick();
    expect(tries).toBe(1);
    expect(events).toEqual([expect.objectContaining({ type: 'reopen-failed', message: 'Claude.app was not found' })]);
  });
});
