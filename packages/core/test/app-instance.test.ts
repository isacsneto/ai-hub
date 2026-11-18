import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isInstance, openOrFocus, openOrFocusScript, type AppInstance } from '../src/app-instance.js';
import type { LaunchSpec } from '../src/adapters/types.js';
import { ctxFor, fakeSystem, tempHome } from './helpers.js';

const APP = '/Applications/Claude.app';
const PS = [
  `  101 ${APP}/Contents/MacOS/Claude --user-data-dir=/Users/me/.claude-instances/work`,
  `  102 ${APP}/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=renderer --user-data-dir=/Users/me/x`,
  `  103 ${APP}/Contents/MacOS/Claude --user-data-dir=/Users/me/My Work --startup`,
  `  104 /Applications/Cursor.app/Contents/MacOS/Cursor`,
];
const withDefault = [...PS, `  105 ${APP}/Contents/MacOS/Claude`];

// Each case: the instance asked for, the ps lines, and the pid that is its copy (or none).
const CASES: [string, AppInstance, string[], number | undefined][] = [
  ['default, while only other profiles run', { app: APP }, PS, undefined],
  ['default, running', { app: APP }, withDefault, 105],
  ['a profile, running', { app: APP, dataDir: '/Users/me/.claude-instances/work' }, PS, 101],
  ['a folder name with a space', { app: APP, dataDir: '/Users/me/My Work' }, PS, 103],
  ['a folder that only starts another one', { app: APP, dataDir: '/Users/me/My' }, PS, undefined],
  ['a profile that is closed', { app: APP, dataDir: '/Users/me/other' }, withDefault, undefined],
];

const spec = (instance: AppInstance): LaunchSpec => ({
  command: '/usr/bin/open',
  args: ['-n', '-a', instance.app, ...(instance.dataDir ? ['--args', `--user-data-dir=${instance.dataDir}`] : [])],
  env: {},
  instance,
});

describe('finding a profile\'s running copy of an app', () => {
  it.each(CASES)('%s', (_name, inst, lines, pid) => {
    const found = lines.map((l) => l.trim().match(/^(\d+) (.*)$/)!).find((m) => isInstance(m[2]!, inst));
    expect(found ? Number(found[1]) : undefined).toBe(pid);
  });

  it.each(CASES)('launcher script, %s', (_name, inst, lines, pid) => {
    // The launcher up to its lookup, reading the same ps lines from stdin, then printing what it found.
    const script = openOrFocusScript(spec(inst));
    const lookup = script.slice(0, script.indexOf('\n[ -n "$pid" ]')).replace('/bin/ps -axww -o pid=,args=', '/bin/cat');
    const out = execFileSync('/bin/bash', ['-c', `${lookup}\necho "$pid"`], { input: lines.join('\n') + '\n' }).toString().trim();
    expect(out === '' ? undefined : Number(out)).toBe(pid);
  });
});

describe('openOrFocus', () => {
  async function run(lines: string[], inst: AppInstance, focusCode = 0) {
    const sys = fakeSystem({
      run: (cmd) => (cmd === '/bin/ps' ? { stdout: lines.join('\n') } : cmd === '/usr/bin/osascript' ? { code: focusCode } : {}),
    });
    const used = await openOrFocus(ctxFor(await tempHome(), sys), spec(inst));
    return { used, cmds: sys.calls.map((c) => [c.cmd, ...c.args.slice(-1)].join(' ')) };
  }

  it('brings the default copy forward, not another profile\'s', async () => {
    const { used, cmds } = await run(withDefault, { app: APP });
    expect(used).toBe(true);
    expect(cmds).toEqual(['/bin/ps pid=,args=', '/usr/bin/osascript 105']);
  });

  it('starts a new copy when only other profiles run (open -a would pick theirs)', async () => {
    const { used, cmds } = await run(PS, { app: APP });
    expect(used).toBe(false);
    expect(cmds.at(-1)).toBe(`/usr/bin/open ${APP}`);
  });

  it('starts a new copy when the process quit before it could be brought forward', async () => {
    const { used, cmds } = await run(withDefault, { app: APP }, 1);
    expect(used).toBe(false);
    expect(cmds.at(-1)).toBe(`/usr/bin/open ${APP}`);
  });
});
