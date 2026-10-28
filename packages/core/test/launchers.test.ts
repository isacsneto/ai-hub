import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { Hub, Profile } from '../src/config.js';
import { labelInitial, renderIcon } from '../src/icons.js';
import { buildLauncher, removeLauncher } from '../src/launchers.js';
import { findProfileFile, shellInit, writeProfileFile } from '../src/shell.js';
import { ctxFor, executable, fakeSystem, tempHome, write } from './helpers.js';

async function setup() {
  const home = await tempHome();
  await executable(`${home}/bin/claude`);
  const image = `${home}/base.png`;
  await sharp({ create: { width: 64, height: 64, channels: 4, background: '#ff8800' } }).png().toFile(image);
  const app = `${home}/Apps/Claude.app`;
  await write(`${app}/Contents/Info.plist`, '<plist><dict></dict></plist>');
  const hub: Hub = {
    version: 1,
    preferences: { terminal: 'iTerm', launchersDir: '~/Launchers', reopenAfterUpdate: true },
    profiles: [
      { id: 'cw', tool: 'claude-code', label: 'Claude Work', home: '~/cw', icon: { image, badge: 'W', color: '#3B7DD8' } },
      { id: 'desk', tool: 'claude-desktop', label: 'Desk Work', dataDir: '~/desk', codeProfile: 'cw', app, icon: { image } },
    ],
  };
  const [cw, desk] = hub.profiles as [Profile, Profile];
  return { home, hub, cw, desk, sys: fakeSystem() };
}

describe('launchers', () => {
  it('builds a CLI launcher that opens the chosen terminal with a clean, profile-specific session', async () => {
    const { home, hub, cw, sys } = await setup();
    // Even if this shell already points at the profile, the session must still export it.
    const ctx = ctxFor(home, sys, { CLAUDE_CONFIG_DIR: `${home}/cw`, SHELL: '/bin/zsh' });
    const app = await buildLauncher(ctx, hub, cw);
    expect(app).toBe(`${home}/Launchers/Claude Work.app`);
    const plist = await fs.readFile(`${app}/Contents/Info.plist`, 'utf8');
    expect(plist).toContain('<string>dev.aihub.cw</string>');
    expect(await fs.readFile(`${app}/Contents/MacOS/launcher`, 'utf8')).toContain("open -a iTerm");
    const session = await fs.readFile(`${app}/Contents/Resources/session.command`, 'utf8');
    expect(session).toContain('CLAUDE_*|ANTHROPIC_*|CLAUDECODE) unset');
    expect(session).toContain(`export CLAUDE_CONFIG_DIR=${home}/cw`);
    expect(session).toContain(`exec ${home}/bin/claude`);
    expect((await fs.stat(`${app}/Contents/MacOS/launcher`)).mode & 0o111).toBeTruthy();
    expect(sys.calls.map((c) => path.basename(c.cmd))).toEqual(expect.arrayContaining(['iconutil', 'codesign']));
  });

  it('bakes the exact open command for Desktop profiles', async () => {
    const { home, hub, desk, sys } = await setup();
    const app = await buildLauncher(ctxFor(home, sys), hub, desk);
    expect(await fs.readFile(`${app}/Contents/MacOS/launcher`, 'utf8')).toBe(
      `#!/bin/bash\nexec /usr/bin/open -n -a ${home}/Apps/Claude.app --env CLAUDE_CONFIG_DIR=${home}/cw --args --user-data-dir=${home}/desk\n`,
    );
  });

  it('rebuilds its own launchers but never replaces an app it did not make', async () => {
    const { home, hub, cw, sys } = await setup();
    const ctx = ctxFor(home, sys);
    await buildLauncher(ctx, hub, cw);
    await buildLauncher(ctx, hub, cw);
    await write(`${home}/Other/Claude Work.app/Contents/Info.plist`, '<plist><dict><key>CFBundleIdentifier</key><string>com.someone.else</string></dict></plist>');
    await expect(buildLauncher(ctx, hub, cw, { dir: '~/Other' })).rejects.toThrow(/wasn't made by AI-Hub/);
    await expect(removeLauncher(ctx, hub, cw, { dir: '~/Other' })).rejects.toThrow(/wasn't made by AI-Hub/);
    expect(await removeLauncher(ctx, hub, cw)).toBe(`${home}/Launchers/Claude Work.app`);
  });
});

describe('icons', () => {
  it('badges the base image, or generates a tile when there is none', async () => {
    const { home, cw } = await setup();
    const ctx = ctxFor(home);
    const badged = await sharp(await renderIcon(ctx, cw, 256)).raw().toBuffer({ resolveWithObject: true });
    expect(badged.info).toMatchObject({ width: 256, height: 256 });
    // Bottom-right is the badge color (#3B7DD8), the top-left is the base image (#ff8800).
    const px = (x: number, y: number) => [...badged.data.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 3)];
    expect(px(10, 10)).toEqual([255, 136, 0]);
    expect(px(200, 230)).toEqual([59, 125, 216]);

    const plain: Profile = { id: 'b', tool: 'browser', browser: 'chrome', url: 'https://claude.ai', dataDir: '~/b', appWindow: true, label: 'Web', icon: { color: '#7C5CC4' } };
    const tile = await sharp(await renderIcon(ctx, plain, 128)).metadata();
    expect(tile).toMatchObject({ width: 128, height: 128, format: 'png' });
  });

  it('leaves the app icon alone until a badge or color is chosen', async () => {
    const { home, cw } = await setup();
    const ctx = ctxFor(home);
    const plain = await sharp(await renderIcon(ctx, { ...cw, icon: { image: cw.icon!.image } }, 256)).raw().toBuffer();
    expect([...plain.subarray((230 * 256 + 200) * 4, (230 * 256 + 200) * 4 + 3)]).toEqual([255, 136, 0]);
  });

  it('takes the badge letter from the distinguishing part of the label', () => {
    expect(labelInitial('Claude Code · Work')).toBe('W');
    expect(labelInitial('personal')).toBe('P');
    expect(labelInitial('· ')).toBe('');
  });
});

describe('shell integration', () => {
  it('defines one command per CLI profile without shadowing existing ones, and an auto-switch hook', () => {
    const hub: Hub = {
      version: 1,
      profiles: [
        { id: 'claude-work', tool: 'claude-code', label: 'w', home: '~/w' },
        { id: 'desk', tool: 'claude-desktop', label: 'd', dataDir: '~/d' },
      ],
    };
    const zsh = shellInit(hub, 'zsh');
    expect(zsh).toContain('command -v claude-work >/dev/null 2>&1 || claude-work() { aihub run claude-work "$@"; }');
    expect(zsh).not.toContain('desk()');
    expect(zsh).toContain('add-zsh-hook chpwd _aihub_auto');
    expect(shellInit(hub, 'bash')).toContain('PROMPT_COMMAND="_aihub_auto');
  });

  it('finds the nearest .aihub-profile upwards', async () => {
    const home = await tempHome();
    await fs.mkdir(`${home}/proj/src/deep`, { recursive: true });
    await writeProfileFile(`${home}/proj`, 'claude-work');
    expect(await findProfileFile(`${home}/proj/src/deep`)).toEqual({ id: 'claude-work', file: `${home}/proj/.aihub-profile` });
    expect(await findProfileFile(home)).toBeUndefined();
  });
});
