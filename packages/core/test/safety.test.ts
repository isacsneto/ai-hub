import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { restoreHub } from '../src/backup.js';
import { saveHub, type Hub, type Profile } from '../src/config.js';
import { createContext, realSystem } from '../src/context.js';
import { GUARD_PLIST } from '../src/discover.js';
import { addToLibrary, itemPath, setSharedSetting } from '../src/library.js';
import { blockProblem, reconcile, replaceBlock } from '../src/share.js';
import { setSharing } from '../src/sharing-config.js';
import { loadState } from '../src/state.js';
import { takeover, undoTakeover } from '../src/takeover.js';
import { abandonUnfinishedUndo, undoLast } from '../src/tx.js';
import { ctxFor, fakeSystem, tempHome, write } from './helpers.js';

/** Regression tests for the code review: each one used to lose or overwrite something. */
async function setup() {
  const home = await tempHome();
  const ctx = ctxFor(home, fakeSystem({ run: (cmd) => (cmd === 'git' ? { code: 1 } : {}) }));
  await write(`${home}/cw/settings.json`, '{\n  "theme": "dark"\n}\n');
  await write(`${home}/cx/config.toml`, '');
  await write(`${home}/src/review/SKILL.md`, '---\nname: review\n---\nBody\n');
  await write(`${home}/src/other/SKILL.md`, '---\nname: other\n---\nBody\n');
  await write(`${home}/src/style.md`, '# Coding style\nUse tabs.\n');
  await write(`${home}/src/deploy.md`, '# Deploy\n');
  await addToLibrary(ctx, 'skills', `${home}/src/review`);
  await addToLibrary(ctx, 'skills', `${home}/src/other`);
  await addToLibrary(ctx, 'commands', `${home}/src/deploy.md`);
  await addToLibrary(ctx, 'instructions', `${home}/src/style.md`);
  const hub: Hub = {
    version: 1,
    profiles: [
      { id: 'cw', tool: 'claude-code', label: 'Claude work', home: '~/cw' },
      { id: 'cx', tool: 'codex', label: 'Codex work', home: '~/cx' },
    ],
  };
  await saveHub(ctx, hub);
  const [cw, cx] = hub.profiles as [Profile, Profile];
  return { home, ctx, hub, cw, cx };
}

describe('undo never loses edits', () => {
  it('leaves a CLAUDE.md edited after the apply alone', async () => {
    const { home, ctx, hub, cw } = await setup();
    await setSharing(ctx, hub, 'instructions', 'style', ['cw'], true);
    await reconcile(ctx, hub, cw);
    await fs.appendFile(`${home}/cw/CLAUDE.md`, '\nMy own notes\n');
    const r = await undoLast(ctx);
    expect(await fs.readFile(`${home}/cw/CLAUDE.md`, 'utf8')).toContain('My own notes');
    expect(r?.kept.join()).toMatch(/edited since/);
    expect(r?.failed).toEqual([]);
  });

  it('leaves an edited Codex copy alone, but still removes an untouched one', async () => {
    const { home, ctx, hub, cx } = await setup();
    await setSharing(ctx, hub, 'commands', 'deploy', ['cx'], true);
    await reconcile(ctx, hub, cx);
    await fs.writeFile(`${home}/cx/prompts/deploy.md`, 'EDITED');
    await undoLast(ctx);
    expect(await fs.readFile(`${home}/cx/prompts/deploy.md`, 'utf8')).toBe('EDITED');

    await fs.rm(`${home}/cx/prompts/deploy.md`);
    await reconcile(ctx, hub, cx);
    await undoLast(ctx);
    await expect(fs.access(`${home}/cx/prompts/deploy.md`)).rejects.toThrow();
  });
});

describe('undo that stops partway', () => {
  it('keeps what it could not reverse and retries it next time', async () => {
    const { home, ctx, hub, cw } = await setup();
    await setSharing(ctx, hub, 'skills', 'other', ['cw'], true);
    await reconcile(ctx, hub, cw); // the earlier run
    await setSharing(ctx, hub, 'skills', 'review', ['cw'], true);
    await reconcile(ctx, hub, cw);

    await fs.chmod(`${home}/cw/skills`, 0o500); // the link to review can't be removed now
    try {
      const first = await undoLast(ctx);
      expect(first?.failed.join()).toMatch(/symlink .*review/);
      expect(first?.resumed).toBe(false);
    } finally {
      await fs.chmod(`${home}/cw/skills`, 0o755);
    }
    expect((await fs.lstat(`${home}/cw/skills/review`)).isSymbolicLink()).toBe(true);

    // The retry finishes the same run instead of going back to the earlier one.
    const second = await undoLast(ctx);
    expect(second).toMatchObject({ resumed: true, failed: [], reverted: 1 });
    await expect(fs.lstat(`${home}/cw/skills/review`)).rejects.toThrow();
    expect((await fs.lstat(`${home}/cw/skills/other`)).isSymbolicLink()).toBe(true);
  });

  it('can give up on the rest and go on to the run before', async () => {
    const { home, ctx, hub, cw } = await setup();
    await setSharing(ctx, hub, 'skills', 'other', ['cw'], true);
    await reconcile(ctx, hub, cw);
    await setSharing(ctx, hub, 'skills', 'review', ['cw'], true);
    await reconcile(ctx, hub, cw);
    expect(await abandonUnfinishedUndo(ctx)).toBeUndefined(); // nothing stopped partway yet

    await fs.chmod(`${home}/cw/skills`, 0o500);
    try {
      await undoLast(ctx);
    } finally {
      await fs.chmod(`${home}/cw/skills`, 0o755);
    }
    expect(await abandonUnfinishedUndo(ctx)).toMatchObject({ left: 1 });
    const next = await undoLast(ctx);
    expect(next?.resumed).toBe(false);
    await expect(fs.lstat(`${home}/cw/skills/other`)).rejects.toThrow();
    expect((await fs.lstat(`${home}/cw/skills/review`)).isSymbolicLink()).toBe(true); // left as it was
  });
});

describe('managed blocks edited by hand', () => {
  it('leaves an AGENTS.md block edited in place alone unless forced', async () => {
    const { home, ctx, hub, cx } = await setup();
    await setSharing(ctx, hub, 'instructions', 'style', ['cx'], true);
    await reconcile(ctx, hub, cx);
    const agents = `${home}/cx/AGENTS.md`;
    const edited = (await fs.readFile(agents, 'utf8')).replace('Use tabs.', 'Use tabs, except in YAML.');
    await fs.writeFile(agents, edited);

    // A library change would rewrite the block; the hand edit makes that a conflict.
    await write(itemPath(ctx, 'instructions', 'style'), '# Coding style\nUse tabs.\nWrap at 100.\n');
    const plan = await reconcile(ctx, hub, cx);
    expect(plan.actions.find((a) => a.kind === 'instructions')).toMatchObject({ status: 'conflict' });
    expect(await fs.readFile(agents, 'utf8')).toBe(edited);
    // Unsharing would drop the block, which is just as much a loss.
    await setSharing(ctx, hub, 'instructions', 'style', ['cx'], false);
    expect((await reconcile(ctx, hub, cx, { dryRun: true })).actions.find((a) => a.kind === 'instructions')?.status).toBe('conflict');
    await setSharing(ctx, hub, 'instructions', 'style', ['cx'], true);

    const forced = await reconcile(ctx, hub, cx, { force: true });
    expect(forced.actions.find((a) => a.kind === 'instructions')).toMatchObject({ status: 'done' });
    const now = await fs.readFile(agents, 'utf8');
    expect(now).toContain('Wrap at 100.');
    expect(now).not.toContain('except in YAML');
  });

  it('still rewrites a block nobody touched, and text outside the block never counts as an edit', async () => {
    const { home, ctx, hub, cx } = await setup();
    await setSharing(ctx, hub, 'instructions', 'style', ['cx'], true);
    await reconcile(ctx, hub, cx);
    await fs.appendFile(`${home}/cx/AGENTS.md`, '\nMy own notes\n');
    await write(itemPath(ctx, 'instructions', 'style'), '# Coding style\nUse spaces.\n');
    const plan = await reconcile(ctx, hub, cx);
    expect(plan.actions.find((a) => a.kind === 'instructions')).toMatchObject({ status: 'done' });
    const text = await fs.readFile(`${home}/cx/AGENTS.md`, 'utf8');
    expect(text).toContain('Use spaces.');
    expect(text).toContain('My own notes');
  });
});

describe('files the hub rewrites', () => {
  it('refuses to replace a symlinked CLAUDE.md or settings.json with a file', async () => {
    const { home, ctx, hub, cw } = await setup();
    await write(`${home}/dotfiles/CLAUDE.md`, '# shared dotfile\n');
    await fs.symlink(`${home}/dotfiles/CLAUDE.md`, `${home}/cw/CLAUDE.md`);
    await setSharing(ctx, hub, 'instructions', 'style', ['cw'], true);
    const plan = await reconcile(ctx, hub, cw);
    expect(plan.actions.find((a) => a.kind === 'instructions')).toMatchObject({ status: 'conflict', reason: expect.stringMatching(/is a link/) });
    expect((await fs.lstat(`${home}/cw/CLAUDE.md`)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(`${home}/dotfiles/CLAUDE.md`, 'utf8')).toBe('# shared dotfile\n');
  });

  it('refuses to rewrite a block whose markers are damaged', async () => {
    const BEGIN = '<!-- aihub:begin: managed by AI-Hub, change with `aihub share`/`aihub unshare` -->';
    const damaged = `# Mine\n\n${BEGIN}\n@/lib/a.md\n\nMy paragraph\n`;
    expect(blockProblem(damaged)).toMatch(/markers/);
    expect(blockProblem(replaceBlock('# Mine\n', '@/lib/a.md'))).toBeUndefined();
    expect(blockProblem('# Mine\n')).toBeUndefined();

    const { home, ctx, hub, cw } = await setup();
    await write(`${home}/cw/CLAUDE.md`, damaged);
    await setSharing(ctx, hub, 'instructions', 'style', ['cw'], true);
    expect((await reconcile(ctx, hub, cw)).actions.find((a) => a.kind === 'instructions')?.status).toBe('conflict');
    expect(await fs.readFile(`${home}/cw/CLAUDE.md`, 'utf8')).toBe(damaged);
  });
});

describe('settings allowlist', () => {
  it('never writes keys outside the allowlist, even if library/settings.json has them', async () => {
    const { home, ctx, hub, cw } = await setup();
    await write(path.join(ctx.hubDir, 'library/settings.json'), JSON.stringify({ env: { KEY: 'x' }, apiKeyHelper: '/bin/evil' }));
    cw.sharing = { settings: ['env', 'apiKeyHelper'] };
    const plan = await reconcile(ctx, hub, cw);
    expect(plan.actions.every((a) => a.status === 'conflict')).toBe(true);
    expect(await fs.readFile(`${home}/cw/settings.json`, 'utf8')).not.toContain('evil');
  });

  it('rejects prototype names like toString', async () => {
    const { ctx, hub } = await setup();
    await setSharedSetting(ctx, 'model', 'opus');
    await expect(setSharing(ctx, hub, 'settings', 'toString', ['cw'], true)).rejects.toThrow(/can't be shared/);
  });
});

describe('concurrency', () => {
  it('serializes two applies of one profile instead of failing one', async () => {
    const { home, ctx, hub } = await setup();
    const a: Hub = structuredClone(hub);
    const b: Hub = structuredClone(hub);
    a.profiles[0]!.sharing = { skills: ['other'] };
    b.profiles[0]!.sharing = { skills: ['review', 'other'], instructions: ['style'] };
    const results = await Promise.allSettled([reconcile(ctx, a, a.profiles[0]!), reconcile(ctx, b, b.profiles[0]!)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((await fs.readdir(`${home}/cw/skills`)).sort()).toEqual(['other', 'review']);
    expect((await loadState(ctx, 'cw')).installs.map((i) => i.name).sort()).toEqual(['other', 'review', 'style']);
  });
});

describe('install records', () => {
  it('ignores records that point outside the profile', async () => {
    const { home, ctx, hub, cw } = await setup();
    await write(`${home}/precious/notes.md`, 'keep me');
    await write(
      path.join(ctx.hubDir, 'state/cw.json'),
      JSON.stringify({ version: 1, installs: [{ kind: 'skills', name: 'x', strategy: 'copy', path: `${home}/precious/notes.md`, installedAt: '' }] }),
    );
    await reconcile(ctx, hub, cw, { force: true });
    expect(await fs.readFile(`${home}/precious/notes.md`, 'utf8')).toBe('keep me');
  });
});

describe('takeover', () => {
  it('a second takeover keeps the first one undoable', async () => {
    const home = await tempHome();
    const ctx = ctxFor(home, fakeSystem());
    await write(path.join(home, GUARD_PLIST), '<plist/>');
    await write(`${home}/a/settings.json`, '{}');
    await write(`${home}/b/settings.json`, '{}');
    const hub: Hub = { version: 1, profiles: [{ id: 'a', tool: 'claude-code', label: 'A', home: '~/a', managedBy: 'claude-account-guard' }] };
    await takeover(ctx, hub);
    hub.profiles.push({ id: 'b', tool: 'claude-code', label: 'B', home: '~/b', managedBy: 'cpm' });
    await takeover(ctx, hub);
    expect(await undoTakeover(ctx, hub, { dryRun: true })).toHaveLength(3);
    expect(hub.profiles.map((p) => p.managedBy)).toEqual([undefined, undefined]);
    await undoTakeover(ctx, hub);
    expect(await fs.readFile(path.join(home, GUARD_PLIST), 'utf8')).toBe('<plist/>');
    expect(hub.profiles.map((p) => p.managedBy)).toEqual(['claude-account-guard', 'cpm']);
  });
});

describe('restore', () => {
  it("doesn't restore git hooks or config that would run on the next library change", async () => {
    const src = await tempHome();
    execSync(`mkdir -p ${src}/library && git -C ${src}/library init -q && printf 'version: 1\\nprofiles: []\\n' > ${src}/hub.yaml`);
    await fs.writeFile(`${src}/library/.git/hooks/pre-commit`, `#!/bin/sh\ntouch ${src}/PWNED\n`, { mode: 0o755 });
    execSync(`git -C ${src}/library config core.fsmonitor "touch ${src}/PWNED2"`);
    execSync(`tar -czf ${src}/evil.tgz -C ${src} hub.yaml library`);
    const home = await tempHome();
    const ctx = createContext({ HOME: home, AIHUB_HOME: `${home}/.aihub`, PATH: process.env.PATH }, realSystem);
    await restoreHub(ctx, `${src}/evil.tgz`);
    await setSharedSetting(ctx, 'model', 'opus');
    await expect(fs.access(`${src}/PWNED`)).rejects.toThrow();
    await expect(fs.access(`${src}/PWNED2`)).rejects.toThrow();
  });

  it('refuses archives with links', async () => {
    const src = await tempHome();
    execSync(`mkdir -p ${src}/library && printf 'version: 1\\nprofiles: []\\n' > ${src}/hub.yaml && ln -s /etc ${src}/library/etc`);
    execSync(`tar -czf ${src}/links.tgz -C ${src} hub.yaml library`);
    const home = await tempHome();
    const ctx = createContext({ HOME: home, AIHUB_HOME: `${home}/.aihub`, PATH: process.env.PATH }, realSystem);
    await expect(restoreHub(ctx, `${src}/links.tgz`)).rejects.toThrow(/links/);
  });
});
