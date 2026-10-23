import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { exportHub, restoreHub } from '../src/backup.js';
import { loadHub, saveHub } from '../src/config.js';
import { createContext, realSystem } from '../src/context.js';
import { tempHome, write } from './helpers.js';

// Uses the real `tar`, which ships with macOS and Linux.
const ctxAt = (home: string) => createContext({ HOME: home, AIHUB_HOME: `${home}/.aihub`, PATH: '/usr/bin:/bin' }, realSystem);

describe('export / restore', () => {
  it('round-trips the registry and library, but never profile folders or the journal', async () => {
    const home = await tempHome();
    const ctx = ctxAt(home);
    await saveHub(ctx, { version: 1, profiles: [{ id: 'a', tool: 'codex', label: 'A', home: '~/.aihub/profiles/a' }] });
    await write(`${home}/.aihub/library/skills/x/SKILL.md`, '# x');
    await write(`${home}/.aihub/profiles/a/auth.json`, '{"secret":true}');
    await write(`${home}/.aihub/journal/j/journal.json`, '{}');
    const parts = await exportHub(ctx, `${home}/out/hub.tgz`);
    expect(parts).toEqual(['hub.yaml', 'library']);

    const other = await tempHome();
    const ctx2 = ctxAt(other);
    await restoreHub(ctx2, `${home}/out/hub.tgz`);
    expect((await loadHub(ctx2)).profiles.map((p) => p.id)).toEqual(['a']);
    expect(await fs.readFile(`${other}/.aihub/library/skills/x/SKILL.md`, 'utf8')).toBe('# x');
    await expect(fs.stat(`${other}/.aihub/profiles`)).rejects.toThrow();
    await expect(restoreHub(ctx2, `${home}/out/hub.tgz`)).rejects.toThrow(/--force/);
    const kept = await restoreHub(ctx2, `${home}/out/hub.tgz`, { force: true });
    expect(await fs.readdir(kept)).toEqual(expect.arrayContaining(['hub.yaml', 'library']));
  });

  it('refuses archives with anything else in them', async () => {
    const home = await tempHome();
    const ctx = ctxAt(home);
    await write(`${home}/evil/profiles/x/auth.json`, '{}');
    await realSystem.run('/usr/bin/tar', ['-czf', `${home}/evil.tgz`, '-C', `${home}/evil`, 'profiles']);
    await expect(restoreHub(ctx, `${home}/evil.tgz`)).rejects.toThrow(/unexpected entries/);
  });
});
