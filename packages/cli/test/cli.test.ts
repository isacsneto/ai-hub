import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/** Runs the built CLI (npm run build first) against a throwaway HOME. */
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const exec = promisify(execFile);

async function cli() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-cli-'));
  const env = { HOME: home, AIHUB_HOME: `${home}/.aihub`, PATH: process.env.PATH ?? '/usr/bin:/bin', NO_COLOR: '1' };
  const run = async (args: string[], cwd = home) => {
    try {
      const r = await exec(process.execPath, [CLI, ...args], { env, cwd });
      return { code: 0, out: r.stdout + r.stderr };
    } catch (err) {
      const e = err as { code: number; stdout: string; stderr: string };
      return { code: e.code, out: e.stdout + e.stderr };
    }
  };
  return { home, run };
}

describe('aihub CLI', () => {
  it('names new profiles readably and rejects options for other tools', async () => {
    const { run } = await cli();
    expect((await run(['profile', 'add', 'claude-code', 'claude-work'])).code).toBe(0);
    expect((await run(['list'])).out).toContain('Claude Code · Work');
    const bad = await run(['profile', 'add', 'browser', 'b1', '--browser', 'chrome', '--url', 'https://claude.ai', '--isolated-home']);
    expect(bad.code).not.toBe(0);
    expect(bad.out).toMatch(/--isolated-home doesn't apply to browser/);
  });

  it('only links CLI profiles to folders, and unlink without a file is not an error', async () => {
    const { home, run } = await cli();
    await run(['profile', 'add', 'browser', 'web', '--browser', 'chrome', '--url', 'https://claude.ai']);
    expect((await run(['link', 'web'])).out).toMatch(/only claude-code and codex/);
    const un = await run(['unlink']);
    expect(un).toMatchObject({ code: 0 });
    expect(un.out).toContain('No .aihub-profile');
    await expect(fs.access(path.join(home, '.aihub-profile'))).rejects.toThrow();
  });

  it("says a dry run didn't record anything", async () => {
    const { home, run } = await cli();
    await run(['profile', 'add', 'claude-code', 'cw']);
    await fs.mkdir(path.join(home, 'src/s'), { recursive: true });
    await fs.writeFile(path.join(home, 'src/s/SKILL.md'), '---\nname: s\n---\n');
    await run(['library', 'add', 'skill', path.join(home, 'src/s')]);
    const r = await run(['share', 'skill', 's', 'cw', '--dry-run', '--no-apply']);
    expect(r.out).toContain('nothing saved');
    expect(await fs.readFile(path.join(home, '.aihub/hub.yaml'), 'utf8')).not.toContain('sharing');
  });

  it('rejects a bad icon size and a multi-line label', async () => {
    const { run } = await cli();
    await run(['profile', 'add', 'claude-code', 'cw']);
    expect((await run(['icon', 'cw', '--size', 'abc'])).out).toMatch(/--size must be/);
    await run(['profile', 'set', 'cw', '--label', 'Work\ntouch /tmp/x']);
    expect((await run(['list'])).out).toContain('Work touch /tmp/x');
  });
});
