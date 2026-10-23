import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { browser } from '../src/adapters/browser.js';
import { codexDesktop } from '../src/adapters/codex-desktop.js';
import { cursor } from '../src/adapters/cursor.js';
import type { BrowserProfile, CodexDesktopProfile, CursorProfile, Hub } from '../src/config.js';
import { ctxFor, fakeSystem, tempHome, write } from './helpers.js';

const hub: Hub = { version: 1, profiles: [] };
const app = async (home: string, name: string) => {
  await write(`${home}/Applications/${name}/Contents/Info.plist`, '<plist><dict></dict></plist>');
  return `${home}/Applications/${name}`;
};

describe('cursor', () => {
  it('launches with its own data and extensions folders; ~/.cursor stays shared by default', async () => {
    const home = await tempHome();
    const a = await app(home, 'Cursor.app');
    const p: CursorProfile = { id: 'cu', tool: 'cursor', label: 'Cursor work', dataDir: '~/cu', extensionsDir: '~/cu-ext', homeMode: 'shared', app: a };
    const ctx = ctxFor(home);
    expect((await cursor.launchSpec(ctx, hub, p, [])).args).toEqual([
      '-n', '-a', a, '--args', `--user-data-dir=${home}/cu`, `--extensions-dir=${home}/cu-ext`,
    ]);
    expect(cursor.paths(ctx, p).mcpFile).toBe(`${home}/.cursor/mcp.json`);
  });

  it('isolated home: sets HOME, moves ~/.cursor, and links git/ssh config in', async () => {
    const home = await tempHome();
    const a = await app(home, 'Cursor.app');
    await write(`${home}/.gitconfig`, '[user]');
    const p: CursorProfile = { id: 'cu', tool: 'cursor', label: 'Cursor work', dataDir: '~/cu', homeMode: 'isolated', app: a };
    const ctx = ctxFor(home);
    await cursor.prepareLaunch!(ctx, p);
    expect(await fs.readlink(`${home}/cu/home/.gitconfig`)).toBe(`${home}/.gitconfig`);
    expect((await cursor.launchSpec(ctx, hub, p, [])).args).toContain(`HOME=${home}/cu/home`);
    expect(cursor.paths(ctx, p).mcpFile).toBe(`${home}/cu/home/.cursor/mcp.json`);
  });

  it('reads the signed-in email without selecting token values', async () => {
    const home = await tempHome();
    await write(`${home}/cu/User/globalStorage/state.vscdb`);
    const sys = fakeSystem({
      run: (_c, args) => ({ stdout: args.at(-1)!.includes('cachedEmail') ? 'me@work.com\n' : '1\n' }),
    });
    const p: CursorProfile = { id: 'cu', tool: 'cursor', label: 'c', dataDir: '~/cu', homeMode: 'shared' };
    expect(await cursor.identity(ctxFor(home, sys), p)).toEqual({ status: 'signed-in', email: 'me@work.com' });
    expect(sys.calls.every((c) => !/select value .*accessToken/.test(c.args.at(-1) ?? ''))).toBe(true);
  });
});

describe('browser and ChatGPT app', () => {
  it('opens the site as an app window in its own Chromium profile folder', async () => {
    const home = await tempHome();
    await app(home, 'Google Chrome.app');
    const p: BrowserProfile = { id: 'gpt', tool: 'browser', browser: 'chrome', url: 'https://chatgpt.com', dataDir: '~/gpt', appWindow: true, label: 'ChatGPT work' };
    const spec = await browser.launchSpec(ctxFor(home), hub, p, []);
    expect(spec.args).toEqual(expect.arrayContaining([`--user-data-dir=${home}/gpt`, '--app=https://chatgpt.com']));
  });

  it('runs the ChatGPT/Codex app with the profile’s CODEX_HOME', async () => {
    const home = await tempHome();
    const a = await app(home, 'ChatGPT.app');
    const p: CodexDesktopProfile = { id: 'cd', tool: 'codex-desktop', label: 'Codex app work', codexHome: '~/cx', app: a };
    expect((await codexDesktop.launchSpec(ctxFor(home), hub, p, [])).args).toEqual(['-n', '-a', a, '--env', `CODEX_HOME=${home}/cx`]);
    const def: CodexDesktopProfile = { ...p, codexHome: '~/.codex' };
    expect((await codexDesktop.launchSpec(ctxFor(home), hub, def, [])).args).toEqual(['-a', a]);
  });
});
