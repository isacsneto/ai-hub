import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCode, claudeKeychainService } from '../src/adapters/claude-code.js';
import { claudeDesktop } from '../src/adapters/claude-desktop.js';
import { codex } from '../src/adapters/codex.js';
import type { ClaudeCodeProfile, ClaudeDesktopProfile, CodexProfile, Hub } from '../src/config.js';
import { ctxFor, executable, fakeSystem, tempHome, write } from './helpers.js';

describe('claude-code', () => {
  it('derives the Keychain item from the config dir path (Phase 0 evidence)', () => {
    expect(claudeKeychainService('/Users/me/.claude-profiles/work')).toBe('Claude Code-credentials-54d2fa65');
    expect(claudeKeychainService()).toBe('Claude Code-credentials');
  });

  it('keeps .claude.json in $HOME for the default dir and inside the dir otherwise', async () => {
    const home = await tempHome();
    const ctx = ctxFor(home);
    const def = claudeCode.paths(ctx, { id: 'a', tool: 'claude-code', label: 'a', home: '~/.claude' });
    const work = claudeCode.paths(ctx, { id: 'b', tool: 'claude-code', label: 'b', home: '~/w' });
    expect(def).toMatchObject({ isDefault: true, configFile: `${home}/.claude.json` });
    expect(def.credential).toEqual({ kind: 'keychain', service: 'Claude Code-credentials' });
    expect(work).toMatchObject({ isDefault: false, configFile: `${home}/w/.claude.json` });
    expect(work.credential).toEqual({ kind: 'keychain', service: claudeKeychainService(`${home}/w`) });
  });

  it('reads the account from .claude.json and the login from the Keychain', async () => {
    const home = await tempHome();
    const p: ClaudeCodeProfile = { id: 'w', tool: 'claude-code', label: 'w', home: '~/w' };
    await write(
      `${home}/w/.claude.json`,
      JSON.stringify({ oauthAccount: { emailAddress: 'me@work.com', organizationName: 'Work' } }),
    );
    const signedIn = ctxFor(home, fakeSystem({ keychain: [claudeKeychainService(`${home}/w`)] }));
    expect(await claudeCode.identity(signedIn, p)).toEqual({ status: 'signed-in', email: 'me@work.com', org: 'Work' });
    const signedOut = ctxFor(home, fakeSystem({ keychain: ['Claude Code-credentials'] }));
    expect(await claudeCode.identity(signedOut, p)).toMatchObject({ status: 'signed-out', email: 'me@work.com' });
  });

  it('strips inherited tokens and only sets CLAUDE_CONFIG_DIR for non-default dirs', async () => {
    const home = await tempHome();
    await executable(`${home}/bin/claude`);
    const ctx = ctxFor(home, fakeSystem(), {
      CLAUDE_CODE_OAUTH_TOKEN: 'secret',
      ANTHROPIC_API_KEY: 'secret',
      CLAUDE_CONFIG_DIR: '/somewhere/else',
      CLAUDECODE: '1',
      KEEP_ME: 'yes',
    });
    const hub: Hub = { version: 1, profiles: [] };
    const work = await claudeCode.launchSpec(ctx, hub, { id: 'w', tool: 'claude-code', label: 'w', home: '~/w' }, ['--resume']);
    expect(work.args).toEqual(['--resume']);
    expect(work.env).toMatchObject({ CLAUDE_CONFIG_DIR: `${home}/w`, KEEP_ME: 'yes' });
    expect(work.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(work.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(work.env).not.toHaveProperty('CLAUDECODE');
    const def = await claudeCode.launchSpec(ctx, hub, { id: 'd', tool: 'claude-code', label: 'd', home: '~/.claude' }, []);
    expect(def.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
  });
});

describe('codex', () => {
  const p: CodexProfile = { id: 'c', tool: 'codex', label: 'c', home: '~/cx' };

  it('asks `codex login status` with this profile’s CODEX_HOME', async () => {
    const home = await tempHome();
    await executable(`${home}/bin/codex`);
    const sys = fakeSystem({
      run: (_cmd, args, env) =>
        args.join(' ') === 'login status' && env?.CODEX_HOME === `${home}/cx`
          ? { stdout: 'Logged in using ChatGPT\n' }
          : { stdout: 'Not logged in\n', code: 1 },
    });
    expect(await codex.identity(ctxFor(home, sys), p)).toEqual({ status: 'signed-in', detail: 'via ChatGPT' });
    const other: CodexProfile = { ...p, home: '~/other' };
    expect(await codex.identity(ctxFor(home, sys), other)).toEqual({ status: 'signed-out' });
  });

  it('lists MCP server names from config.toml and isolates the launch env', async () => {
    const home = await tempHome();
    await executable(`${home}/bin/codex`);
    await write(`${home}/cx/config.toml`, '[mcp_servers.github]\ncommand = "x"\n[mcp_servers.node_repl]\ncommand = "y"\n');
    const ctx = ctxFor(home, fakeSystem(), { OPENAI_API_KEY: 'secret', CODEX_HOME: '/elsewhere' });
    expect((await codex.inventory(ctx, p)).mcpServers).toEqual(['github', 'node_repl']);
    const spec = await codex.launchSpec(ctx, { version: 1, profiles: [] }, p, ['exec', 'hi']);
    expect(spec.env.CODEX_HOME).toBe(`${home}/cx`);
    expect(spec.env).not.toHaveProperty('OPENAI_API_KEY');
  });
});

describe('claude-desktop', () => {
  async function setup() {
    const home = await tempHome();
    const app = path.join(home, 'Apps/Claude.app');
    await write(path.join(app, 'Contents/Info.plist'), '<plist><dict></dict></plist>');
    const hub: Hub = {
      version: 1,
      profiles: [
        { id: 'claude-default', tool: 'claude-code', label: 'd', home: '~/.claude' },
        { id: 'claude-work', tool: 'claude-code', label: 'w', home: '~/.claude-profiles/work' },
      ],
    };
    return { home, app, hub, ctx: ctxFor(home) };
  }

  it('passes the Code-tab CLAUDE_CONFIG_DIR and its own data dir', async () => {
    const { home, app, hub, ctx } = await setup();
    const p: ClaudeDesktopProfile = {
      id: 'acme', tool: 'claude-desktop', label: 'Acme', dataDir: '~/.claude-instances/acme', codeProfile: 'claude-work', app,
    };
    const spec = await claudeDesktop.launchSpec(ctx, hub, p, []);
    expect(spec.command).toBe('/usr/bin/open');
    expect(spec.args).toEqual([
      '-n', '-a', app,
      '--env', `CLAUDE_CONFIG_DIR=${home}/.claude-profiles/work`,
      '--args', `--user-data-dir=${home}/.claude-instances/acme`,
    ]);
  });

  it('never passes CLAUDE_CONFIG_DIR for the default ~/.claude (it would change the Keychain item)', async () => {
    const { app, hub, ctx } = await setup();
    const p: ClaudeDesktopProfile = {
      id: 'def', tool: 'claude-desktop', label: 'Default',
      dataDir: '~/Library/Application Support/Claude', codeProfile: 'claude-default', app,
    };
    expect((await claudeDesktop.launchSpec(ctx, hub, p, [])).args).toEqual(['-a', app]);
  });
});
