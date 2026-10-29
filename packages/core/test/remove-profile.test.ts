import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { loadHub, saveHub, type Hub } from '../src/config.js';
import { addToLibrary } from '../src/library.js';
import { deleteProfile, moveToTrash, removalInfo } from '../src/remove-profile.js';
import { reconcile } from '../src/share.js';
import { setSharing } from '../src/sharing-config.js';
import { accountOf } from '../src/registry.js';
import { stateFile } from '../src/state.js';
import { undoLast } from '../src/tx.js';
import { ctxFor, fakeSystem, tempHome, write } from './helpers.js';

async function setup() {
  const home = await tempHome();
  const ctx = ctxFor(home, fakeSystem({ run: (cmd) => (cmd === 'git' ? { code: 1 } : cmd === '/bin/ps' ? { stdout: '' } : {}) }));
  await write(`${home}/cw/settings.json`, '{}\n');
  await write(`${home}/.aihub/profiles/fresh/settings.json`, '{}\n');
  await write(`${home}/src/review/SKILL.md`, '---\nname: review\n---\nBody\n');
  await addToLibrary(ctx, 'skills', `${home}/src/review`);
  const hub: Hub = {
    version: 1,
    profiles: [
      { id: 'cw', tool: 'claude-code', label: 'Claude · Work', home: '~/cw' },
      { id: 'fresh', tool: 'claude-code', label: 'Claude · Fresh', home: '~/.aihub/profiles/fresh' },
      { id: 'desk', tool: 'claude-desktop', label: 'Desktop · Work', dataDir: '~/desk', codeProfile: 'fresh' },
    ],
  };
  await saveHub(ctx, hub);
  await setSharing(ctx, hub, 'skills', 'review', ['cw'], true);
  await saveHub(ctx, hub);
  await reconcile(ctx, hub, hub.profiles[0]!);
  return { home, ctx, hub };
}

describe('removing a profile', () => {
  it('keeps the folder and what was shared into it, unless asked to take that out', async () => {
    const { home, ctx, hub } = await setup();
    expect(await removalInfo(ctx, hub, 'cw')).toMatchObject({ folder: '~/cw', shared: 1, canTrash: false, usedBy: [] });
    const r = await deleteProfile(ctx, hub, 'cw');
    expect(r).toMatchObject({ unshared: 0, leftInPlace: 1, trashed: false });
    expect((await fs.lstat(`${home}/cw/skills/review`)).isSymbolicLink()).toBe(true);
    await fs.access(stateFile(ctx, 'cw')); // kept: adding it back manages the link again
    expect((await loadHub(ctx)).profiles.map((p) => p.id)).toEqual(['fresh', 'desk']);
  });

  it('takes shared items out in one undoable step', async () => {
    const { home, ctx, hub } = await setup();
    const r = await deleteProfile(ctx, hub, 'cw', { unshare: true });
    expect(r).toMatchObject({ unshared: 1, leftInPlace: 0 });
    await expect(fs.lstat(`${home}/cw/skills/review`)).rejects.toThrow();
    await expect(fs.access(stateFile(ctx, 'cw'))).rejects.toThrow();
    await fs.access(`${home}/cw/settings.json`); // the folder itself is untouched

    await undoLast(ctx);
    expect((await fs.lstat(`${home}/cw/skills/review`)).isSymbolicLink()).toBe(true);
  });

  it('leaves items in a folder another tool manages', async () => {
    const { home, ctx, hub } = await setup();
    hub.profiles[0] = { ...hub.profiles[0]!, managedBy: 'cpm' } as Hub['profiles'][number];
    const r = await deleteProfile(ctx, hub, 'cw', { unshare: true });
    expect(r).toMatchObject({ unshared: 0, leftInPlace: 1 });
    expect((await fs.lstat(`${home}/cw/skills/review`)).isSymbolicLink()).toBe(true);
  });

  it("refuses while a Desktop profile's Code tab uses it", async () => {
    const { ctx, hub } = await setup();
    expect((await removalInfo(ctx, hub, 'fresh')).usedBy).toEqual(['Desktop · Work']);
    await expect(deleteProfile(ctx, hub, 'fresh')).rejects.toThrow(/Desktop · Work uses "Claude · Fresh" for the Code tab/);
    expect((await loadHub(ctx)).profiles).toHaveLength(3);
  });

  it('moves only folders the hub created to the Trash', async () => {
    const { home, ctx, hub } = await setup();
    const trash = (dir: string) => moveToTrash(ctx, dir);
    await expect(deleteProfile(ctx, hub, 'cw', { trash })).rejects.toThrow(/wasn't created by AI-Hub/);
    await fs.access(`${home}/cw/settings.json`);

    await deleteProfile(ctx, hub, 'desk');
    const info = await removalInfo(ctx, hub, 'fresh');
    expect(info.canTrash).toBe(true);
    const r = await deleteProfile(ctx, hub, 'fresh', { trash });
    expect(r.trashed).toBe(true);
    await expect(fs.access(`${home}/.aihub/profiles/fresh`)).rejects.toThrow();
    await fs.access(`${home}/.Trash/fresh/settings.json`);
    expect((await loadHub(ctx)).profiles.map((p) => p.id)).toEqual(['cw']);
  });

  it("won't trash the folder of an app that is still open", async () => {
    const home = await tempHome();
    const root = `${home}/.aihub/profiles/gpt`;
    const ctx = ctxFor(
      home,
      fakeSystem({ run: (cmd) => (cmd === '/bin/ps' ? { stdout: `  42 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${root} --no-first-run\n` } : { code: 1 }) }),
    );
    await write(`${root}/Local State`, '{}');
    const hub: Hub = { version: 1, profiles: [{ id: 'gpt', tool: 'browser', label: 'ChatGPT · Work', browser: 'chrome', url: 'https://chatgpt.com', dataDir: '~/.aihub/profiles/gpt', appWindow: true }] };
    await saveHub(ctx, hub);
    await expect(deleteProfile(ctx, hub, 'gpt', { trash: (d) => moveToTrash(ctx, d) })).rejects.toThrow(/still open/);
    await fs.access(`${root}/Local State`);
  });
});

describe('one card per account', () => {
  it('puts a desktop app with the CLI profile whose folder it uses', async () => {
    const home = await tempHome();
    const ctx = ctxFor(home, fakeSystem());
    const hub: Hub = {
      version: 1,
      profiles: [
        { id: 'work', tool: 'claude-code', label: 'Work', home: '~/.claude-profiles/work' },
        { id: 'desk', tool: 'claude-desktop', label: 'Claude Work', dataDir: '~/desk', codeProfile: 'work' },
        { id: 'desk-alone', tool: 'claude-desktop', label: 'Claude Other', dataDir: '~/desk2' },
        { id: 'codex', tool: 'codex', label: 'Codex', home: '~/.codex' },
        { id: 'gpt-app', tool: 'codex-desktop', label: 'ChatGPT app', codexHome: '~/.codex' },
        { id: 'gpt-other', tool: 'codex-desktop', label: 'ChatGPT other', codexHome: '~/elsewhere' },
      ],
    };
    expect(hub.profiles.map((p) => accountOf(ctx, hub, p))).toEqual(['work', 'work', 'desk-alone', 'codex', 'codex', 'gpt-other']);
  });
});
