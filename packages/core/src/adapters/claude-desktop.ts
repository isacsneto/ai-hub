import path from 'node:path';
import type { ClaudeDesktopProfile } from '../config.js';
import type { Context } from '../context.js';
import { exists, readJsonIfExists } from '../fsx.js';
import { resolvePath } from '../paths.js';
import { readPlistString } from '../plist.js';
import { claudeCode } from './claude-code.js';
import { TESTED } from './tested.js';
import type { Identity, Inventory, ProfilePaths, ToolAdapter } from './types.js';

export function defaultDesktopDataDir(home: string): string {
  return path.join(home, 'Library/Application Support/Claude');
}

async function findClaudeApp(ctx: Context, p?: ClaudeDesktopProfile): Promise<string | undefined> {
  const candidates = p?.app
    ? [resolvePath(p.app, ctx.home)]
    : ['/Applications/Claude.app', path.join(ctx.home, 'Applications/Claude.app')];
  for (const c of candidates) if (await exists(path.join(c, 'Contents/Info.plist'))) return c;
  return undefined;
}

export const claudeDesktop: ToolAdapter<ClaudeDesktopProfile> = {
  tool: 'claude-desktop',
  displayName: 'Claude Desktop',
  tested: TESTED['claude-desktop'],

  findBinary: findClaudeApp,

  async detectVersion(ctx, p) {
    const app = await findClaudeApp(ctx, p);
    if (!app) return undefined;
    return readPlistString(ctx, path.join(app, 'Contents/Info.plist'), 'CFBundleShortVersionString');
  },

  paths(ctx, p): ProfilePaths {
    const root = resolvePath(p.dataDir, ctx.home);
    return {
      root,
      isDefault: root === defaultDesktopDataDir(ctx.home),
      configFile: path.join(root, 'claude_desktop_config.json'),
      mcpFile: path.join(root, 'claude_desktop_config.json'),
      historyPaths: [path.join(root, 'claude-code-sessions'), path.join(root, 'IndexedDB')],
      credential: { kind: 'unknown', detail: 'Electron session cookies inside the data folder' },
    };
  },

  async identity(_ctx, p): Promise<Identity> {
    // The Desktop login sits in encrypted cookies; we don't decrypt them, so the account is unknown.
    return {
      status: 'unknown',
      detail: p.codeProfile ? `Code tab uses profile ${p.codeProfile}` : 'Code tab uses the default ~/.claude',
    };
  },

  async inventory(ctx, p): Promise<Inventory> {
    const paths = this.paths(ctx, p);
    const warnings: string[] = [];
    let cfg: { mcpServers?: Record<string, unknown> } | undefined;
    try {
      cfg = (await readJsonIfExists(paths.mcpFile!)) as typeof cfg;
    } catch (err) {
      warnings.push((err as Error).message);
    }
    const historyPresent: string[] = [];
    for (const h of paths.historyPaths) if (await exists(h)) historyPresent.push(h);
    return {
      rootExists: await exists(paths.root),
      skills: [],
      mcpServers: Object.keys(cfg?.mcpServers ?? {}).sort(),
      historyPresent,
      warnings,
    };
  },

  async launchSpec(ctx, hub, p, args) {
    const app = await findClaudeApp(ctx, p);
    if (!app) throw new Error('Claude.app was not found in /Applications or ~/Applications.');
    const paths = this.paths(ctx, p);
    const openArgs = paths.isDefault ? ['-a', app] : ['-n', '-a', app];

    if (p.codeProfile) {
      const code = hub.profiles.find((q) => q.id === p.codeProfile);
      if (!code || code.tool !== 'claude-code') {
        throw new Error(`codeProfile "${p.codeProfile}" is not a claude-code profile.`);
      }
      const codePaths = claudeCode.paths(ctx, code);
      // Same rule as the CLI: never pass CLAUDE_CONFIG_DIR for the default ~/.claude.
      if (!codePaths.isDefault) openArgs.push('--env', `CLAUDE_CONFIG_DIR=${codePaths.root}`);
    }

    const appArgs = [...(paths.isDefault ? [] : [`--user-data-dir=${paths.root}`]), ...args];
    if (appArgs.length) openArgs.push('--args', ...appArgs);
    return { command: '/usr/bin/open', args: openArgs, env: ctx.env };
  },

  async looksLikeRoot(dir) {
    for (const marker of ['claude_desktop_config.json', 'config.json', 'Cookies']) {
      if (await exists(path.join(dir, marker))) return true;
    }
    return false;
  },
};
