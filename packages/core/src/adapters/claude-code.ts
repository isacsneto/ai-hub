import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ClaudeCodeProfile } from '../config.js';
import { findExecutable, type Context } from '../context.js';
import { cleanEnv } from '../env.js';
import { exists, listEntries, readJsonIfExists, symlinkTargetOf } from '../fsx.js';
import { resolvePath } from '../paths.js';
import { TESTED } from './tested.js';
import type { Identity, Inventory, ProfilePaths, ShareTarget, ToolAdapter } from './types.js';

const CREDENTIAL_SERVICE = 'Claude Code-credentials';

/**
 * Keychain service Claude Code uses for a config dir. Verified on 2.1.309: the suffix for
 * /Users/me/.claude-profiles/work is 54d2fa65 (checked against the real Keychain item on 2026-10-23). The default ~/.claude has no suffix.
 */
export function claudeKeychainService(configDir?: string): string {
  if (!configDir) return CREDENTIAL_SERVICE;
  const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
  return `${CREDENTIAL_SERVICE}-${hash}`;
}

/** Inherited CLAUDE_* / ANTHROPIC_* values (tokens, config dirs, session ids) must not leak in. */
export const CLAUDE_ENV_STRIP = [/^CLAUDE_/, /^CLAUDECODE$/, /^ANTHROPIC_/];

async function jsonKeys(file: string, key: string): Promise<string[]> {
  const j = (await readJsonIfExists(file).catch(() => undefined)) as Record<string, unknown> | undefined;
  const v = key ? j?.[key] : j;
  return v && typeof v === 'object' ? Object.keys(v) : [];
}

interface ClaudeJson {
  oauthAccount?: { emailAddress?: string; organizationName?: string };
  mcpServers?: Record<string, unknown>;
}

export const claudeCode: ToolAdapter<ClaudeCodeProfile> = {
  tool: 'claude-code',
  displayName: 'Claude Code',
  tested: TESTED['claude-code'],

  findBinary(ctx) {
    return findExecutable(ctx, 'claude', [path.join(ctx.home, '.local/bin/claude')]);
  },

  async detectVersion(ctx) {
    const bin = await this.findBinary(ctx);
    if (!bin) return undefined;
    const r = await ctx.sys.run(bin, ['--version'], { timeoutMs: 10_000 });
    return r.stdout.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/)?.[0];
  },

  paths(ctx, p): ProfilePaths {
    const root = resolvePath(p.home, ctx.home);
    const isDefault = root === path.join(ctx.home, '.claude');
    // With the default dir, Claude Code keeps .claude.json in $HOME instead of inside the dir.
    const configFile = isDefault ? path.join(ctx.home, '.claude.json') : path.join(root, '.claude.json');
    return {
      root,
      isDefault,
      configFile,
      mcpFile: configFile,
      skillsDir: path.join(root, 'skills'),
      historyPaths: [path.join(root, 'projects'), path.join(root, 'history.jsonl')],
      credential:
        ctx.sys.platform === 'darwin'
          ? { kind: 'keychain', service: claudeKeychainService(isDefault ? undefined : root) }
          : { kind: 'file', path: path.join(root, '.credentials.json') },
    };
  },

  async identity(ctx, p): Promise<Identity> {
    const paths = this.paths(ctx, p);
    const cfg = (await readJsonIfExists(paths.configFile!)) as ClaudeJson | undefined;
    const account = cfg?.oauthAccount;
    const fileCredential = path.join(paths.root, '.credentials.json');
    const hasCredential =
      (paths.credential.kind === 'keychain' && (await ctx.sys.keychainHasService(paths.credential.service))) ||
      (await exists(fileCredential));
    const named = { email: account?.emailAddress, org: account?.organizationName };
    if (hasCredential) return { status: 'signed-in', ...named };
    return {
      status: 'signed-out',
      ...named,
      detail: account?.emailAddress ? 'last account seen here; no saved login' : 'no saved login',
    };
  },

  async inventory(ctx, p): Promise<Inventory> {
    const paths = this.paths(ctx, p);
    const warnings: string[] = [];
    let cfg: ClaudeJson | undefined;
    try {
      cfg = (await readJsonIfExists(paths.configFile!)) as ClaudeJson | undefined;
    } catch (err) {
      warnings.push((err as Error).message);
    }
    const historyPresent: string[] = [];
    for (const h of paths.historyPaths) if (await exists(h)) historyPresent.push(h);
    return {
      rootExists: await exists(paths.root),
      skills: await listEntries(paths.skillsDir!),
      skillsDirLinkedTo: await symlinkTargetOf(paths.skillsDir!),
      mcpServers: Object.keys(cfg?.mcpServers ?? {}).sort(),
      historyPresent,
      warnings,
    };
  },

  async launchSpec(ctx, _hub, p, args) {
    const bin = await this.findBinary(ctx);
    if (!bin) throw new Error('Claude Code (`claude`) was not found on PATH.');
    const paths = this.paths(ctx, p);
    // The default dir must run without CLAUDE_CONFIG_DIR: setting it changes the Keychain item name.
    const set = paths.isDefault ? {} : { CLAUDE_CONFIG_DIR: paths.root };
    return { command: bin, args, env: cleanEnv(ctx.env, CLAUDE_ENV_STRIP, set) };
  },

  shareTarget(ctx, p, kind, name): ShareTarget {
    const root = this.paths(ctx, p).root;
    switch (kind) {
      case 'skills':
        return { strategy: 'symlink', path: path.join(root, 'skills', name) };
      case 'agents':
        return { strategy: 'symlink', path: path.join(root, 'agents', `${name}.md`) };
      case 'commands':
        return { strategy: 'symlink', path: path.join(root, 'commands', `${name}.md`) };
      case 'instructions':
        // CLAUDE.md supports @path imports, so library edits show up without re-syncing.
        return { strategy: 'block', style: 'import', path: path.join(root, 'CLAUDE.md') };
      case 'settings':
        return { strategy: 'json-key', path: path.join(root, 'settings.json') };
      case 'plugins':
        return { strategy: 'plugin-cli', path: path.join(root, 'plugins') };
    }
  },

  plugins: {
    async isInstalled(ctx, p, id) {
      const root = claudeCode.paths(ctx, p as ClaudeCodeProfile).root;
      return (await jsonKeys(path.join(root, 'plugins/installed_plugins.json'), 'plugins')).includes(id);
    },
    async commands(ctx, p, entry, action) {
      if (action === 'uninstall') return [['plugin', 'uninstall', entry.id]];
      const root = claudeCode.paths(ctx, p as ClaudeCodeProfile).root;
      const marketplace = entry.id.split('@')[1]!;
      const known = await jsonKeys(path.join(root, 'plugins/known_marketplaces.json'), '');
      const cmds: string[][] = [];
      if (!known.includes(marketplace)) {
        if (!entry.source) {
          throw new Error(`Marketplace "${marketplace}" isn't added in ${p.id} and the catalog has no source for it.`);
        }
        cmds.push(['plugin', 'marketplace', 'add', entry.source]);
      }
      cmds.push(['plugin', 'install', entry.id, '--scope', 'user']);
      return cmds;
    },
  },

  async looksLikeRoot(dir) {
    for (const marker of ['settings.json', '.claude.json', 'projects', 'history.jsonl']) {
      if (await exists(path.join(dir, marker))) return true;
    }
    return false;
  },
};
