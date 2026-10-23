import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeKeychainService } from '../src/adapters/claude-code.js';
import { loadHub, saveHub, type Hub } from '../src/config.js';
import { discover, GUARD_PLIST, shellAssignment } from '../src/discover.js';
import { doctor } from '../src/doctor.js';
import { adoptProfile, applyImport, removeProfile } from '../src/registry.js';
import { ctxFor, fakeSystem, tempHome, write } from './helpers.js';

/** A home folder shaped like the real one: default ~/.claude, cpm profiles and a Claude Profiles app. */
async function fixtureHome() {
  const home = await tempHome();
  await write(`${home}/.claude/settings.json`, '{}');
  await write(`${home}/.claude.json`, JSON.stringify({ oauthAccount: { emailAddress: 'me@personal.com' } }));
  await write(
    `${home}/.claude-profiles/config.toml`,
    'version = 1\n[profiles.personal]\ndescription = "Personal"\n[profiles.work]\ndescription = "Work account"\n[profiles.ghost]\n',
  );
  await write(`${home}/.claude-profiles/personal/settings.json`, '{}');
  await write(`${home}/.claude-profiles/work/.claude.json`, JSON.stringify({ oauthAccount: { emailAddress: 'me@work.com' } }));
  const app = `${home}/Applications/Claude Acme.app/Contents`;
  await write(
    `${app}/Info.plist`,
    '<?xml version="1.0"?><plist><dict><key>CFBundleDisplayName</key><string>Claude Acme</string>' +
      '<key>CFBundleIdentifier</key><string>local.claude-profiles.claudeacme</string></dict></plist>',
  );
  await write(
    `${app}/MacOS/launcher`,
    '#!/bin/bash\nDATA_DIR="$HOME/.claude-instances/claudeacme"\nCONFIG_DIR="$HOME/.claude-profiles/work"\nexec open\n',
  );
  await write(`${home}/.claude-instances/claudeacme/Cookies`);
  await write(`${home}/${GUARD_PLIST}`, '<plist/>');
  const sys = fakeSystem({
    keychain: ['Claude Code-credentials', claudeKeychainService(`${home}/.claude-profiles/work`)],
  });
  return { home, ctx: ctxFor(home, sys) };
}

describe('discover', () => {
  it('parses NAME="..." launcher lines with $HOME', () => {
    expect(shellAssignment('X=1\nDATA_DIR="$HOME/a"\n', 'DATA_DIR', '/h')).toBe('/h/a');
    expect(shellAssignment('DATA_DIR="$OTHER/a"', 'DATA_DIR', '/h')).toBeUndefined();
  });

  it('finds default, cpm and Claude Profiles setups and links the Code tab', async () => {
    const { ctx } = await fixtureHome();
    const found = await discover(ctx, { version: 1, profiles: [] });
    const byId = Object.fromEntries(found.map((c) => [c.profile.id, c]));
    expect(Object.keys(byId).sort()).toEqual(['claude-default', 'claude-desktop-acme', 'claude-personal', 'claude-work']);
    expect(byId['claude-default']!.identity).toMatchObject({ status: 'signed-in', email: 'me@personal.com' });
    expect(byId['claude-work']!.identity).toMatchObject({ status: 'signed-in', email: 'me@work.com' });
    expect(byId['claude-personal']!.warnings).toContain('not signed in');
    expect(byId['claude-work']!.profile.managedBy).toBe('claude-account-guard');
    expect(byId['claude-desktop-acme']!.profile).toMatchObject({
      tool: 'claude-desktop',
      label: 'Claude Acme',
      dataDir: '~/.claude-instances/claudeacme',
      codeProfile: 'claude-work',
    });
  });

  it('recognizes already-registered folders under another id', async () => {
    const { ctx } = await fixtureHome();
    const hub: Hub = { version: 1, profiles: [{ id: 'my-work', tool: 'claude-code', label: 'w', home: '~/.claude-profiles/work' }] };
    const found = await discover(ctx, hub);
    const work = found.find((c) => c.profile.tool === 'claude-code' && c.registeredAs === 'my-work');
    expect(work?.state).toBe('registered');
    const acme = found.find((c) => c.profile.tool === 'claude-desktop');
    expect(acme?.profile).toMatchObject({ codeProfile: 'my-work' });
  });
});

describe('import and registry', () => {
  it('refuses to import a Desktop profile without its Code-tab profile', async () => {
    const { ctx } = await fixtureHome();
    const hub = await loadHub(ctx);
    const found = await discover(ctx, hub);
    await expect(applyImport(ctx, hub, found, { skip: ['claude-work'] })).rejects.toThrow(/needs its Code-tab profile/);
  });

  it('registers in place, snapshots an inventory and leaves tool folders untouched', async () => {
    const { home, ctx } = await fixtureHome();
    const before = await fs.readdir(`${home}/.claude-profiles/work`);
    const hub = await loadHub(ctx);
    const { added, snapshot } = await applyImport(ctx, hub, await discover(ctx, hub), { skip: ['claude-personal'] });
    expect(added.map((p) => p.id)).toEqual(['claude-default', 'claude-work', 'claude-desktop-acme']);
    expect((await loadHub(ctx)).profiles).toHaveLength(3);
    expect(await fs.readdir(`${home}/.claude-profiles/work`)).toEqual(before);
    const inv = JSON.parse(await fs.readFile(path.join(snapshot!, 'inventory.json'), 'utf8'));
    expect(inv[1]).toMatchObject({ id: 'claude-work', root: '~/.claude-profiles/work' });
    // A second import finds nothing new.
    const again = await discover(ctx, await loadHub(ctx));
    expect(again.filter((c) => c.state === 'new').map((c) => c.profile.id)).toEqual(['claude-personal']);
  });

  it('will not adopt a folder that already belongs to another profile', async () => {
    const { ctx } = await fixtureHome();
    const hub = await loadHub(ctx);
    await adoptProfile(ctx, hub, { id: 'a', tool: 'claude-code', label: 'a', home: '~/.claude' });
    await expect(adoptProfile(ctx, hub, { id: 'b', tool: 'claude-code', label: 'b', home: '~/.claude/' })).rejects.toThrow(
      /already belongs to profile "a"/,
    );
  });

  it('will not remove a Code-tab profile a Desktop profile depends on', async () => {
    const { ctx } = await fixtureHome();
    const hub = await loadHub(ctx);
    await applyImport(ctx, hub, await discover(ctx, hub));
    await expect(removeProfile(ctx, hub, 'claude-work')).rejects.toThrow(/Code tab/);
    await removeProfile(ctx, hub, 'claude-desktop-acme');
    await removeProfile(ctx, hub, 'claude-work');
    expect((await loadHub(ctx)).profiles.map((p) => p.id)).not.toContain('claude-work');
  });
});

describe('doctor', () => {
  it('flags two profiles on one folder as an isolation failure', async () => {
    const { ctx } = await fixtureHome();
    const hub: Hub = {
      version: 1,
      profiles: [
        { id: 'a', tool: 'claude-code', label: 'a', home: '~/.claude' },
        { id: 'b', tool: 'claude-code', label: 'b', home: '~/.claude' },
      ],
    };
    const report = await doctor(ctx, hub);
    expect(report.findings).toContainEqual(expect.objectContaining({ level: 'error', kind: 'isolation' }));
    expect(report.errors).toBeGreaterThan(0);
  });

  it('warns about whole-folder skill links, broken links and a Desktop Code tab on ~/.claude', async () => {
    const { home, ctx } = await fixtureHome();
    await write(`${home}/.claude/skills/real/SKILL.md`, '# real');
    await fs.mkdir(`${home}/w`, { recursive: true });
    await write(`${home}/w/settings.json`, '{}');
    await fs.symlink(`${home}/.claude/skills`, `${home}/w/skills`);
    await fs.symlink(`${home}/missing`, `${home}/.claude/skills/gone`);
    const hub: Hub = {
      version: 1,
      profiles: [
        { id: 'base', tool: 'claude-code', label: 'base', home: '~/.claude' },
        { id: 'w', tool: 'claude-code', label: 'w', home: '~/w' },
        { id: 'desk', tool: 'claude-desktop', label: 'desk', dataDir: '~/.claude-instances/claudeacme' },
      ],
    };
    await saveHub(ctx, hub);
    const msgs = (await doctor(ctx, hub)).findings.map((f) => `${f.profile}|${f.kind}|${f.message}`);
    expect(msgs).toContainEqual(expect.stringMatching(/^w\|config\|skills\/ is a single link to ~\/\.claude\/skills \(base\)/));
    expect(msgs).toContainEqual(expect.stringMatching(/^base\|state\|Skill "gone" is a broken link/));
    expect(msgs).toContainEqual(expect.stringMatching(/^desk\|isolation\|No codeProfile/));
  });
});
