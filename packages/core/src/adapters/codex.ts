import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { CodexProfile } from '../config.js';
import { findExecutable, type Context } from '../context.js';
import { CODEX_ENV_STRIP, cleanEnv } from '../env.js';
import { exists, listEntries, readTextIfExists, symlinkTargetOf } from '../fsx.js';
import { resolvePath } from '../paths.js';
import { TESTED } from './tested.js';
import type { Identity, Inventory, ProfilePaths, ShareTarget, ToolAdapter } from './types.js';

/** The Codex CLI ships inside the ChatGPT app when it isn't installed on its own. */
const BUNDLED_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';

export { CODEX_ENV_STRIP };

async function readConfig(file: string): Promise<{ config?: Record<string, unknown>; error?: string }> {
  const text = await readTextIfExists(file);
  if (text === undefined) return {};
  try {
    return { config: parseToml(text) as Record<string, unknown> };
  } catch {
    return { error: `Could not parse TOML in ${file}` };
  }
}

export const codex: ToolAdapter<CodexProfile> = {
  tool: 'codex',
  displayName: 'Codex',
  tested: TESTED.codex,

  findBinary(ctx) {
    return findExecutable(ctx, 'codex', [BUNDLED_CODEX]);
  },

  async detectVersion(ctx) {
    const bin = await this.findBinary(ctx);
    if (!bin) return undefined;
    const r = await ctx.sys.run(bin, ['--version'], { timeoutMs: 10_000 });
    return r.stdout.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/)?.[0];
  },

  paths(ctx, p): ProfilePaths {
    const root = resolvePath(p.home, ctx.home);
    return {
      root,
      isDefault: root === path.join(ctx.home, '.codex'),
      configFile: path.join(root, 'config.toml'),
      mcpFile: path.join(root, 'config.toml'),
      skillsDir: path.join(root, 'skills'),
      historyPaths: ['sessions', 'history.jsonl', 'session_index.jsonl'].map((f) => path.join(root, f)),
      credential: { kind: 'file', path: path.join(root, 'auth.json') },
    };
  },

  async identity(ctx, p): Promise<Identity> {
    const paths = this.paths(ctx, p);
    const { config } = await readConfig(paths.configFile!);
    if (config?.cli_auth_credentials_store === 'keyring') {
      paths.credential = { kind: 'unknown', detail: 'OS keyring (item name not verified)' };
    }
    const bin = await this.findBinary(ctx);
    if (bin) {
      const env = cleanEnv(ctx.env, CODEX_ENV_STRIP, { CODEX_HOME: paths.root });
      const r = await ctx.sys.run(bin, ['login', 'status'], { env, timeoutMs: 10_000 });
      const out = `${r.stdout}\n${r.stderr}`;
      const via = out.match(/Logged in using (.+)/)?.[1]?.trim();
      if (via) return { status: 'signed-in', detail: `via ${via}` };
      if (/Not logged in/i.test(out)) return { status: 'signed-out' };
    }
    if (paths.credential.kind === 'file' && (await exists(paths.credential.path))) {
      return { status: 'signed-in', detail: 'auth.json present' };
    }
    return { status: 'unknown', detail: bin ? 'login status unreadable' : 'codex binary not found' };
  },

  async inventory(ctx, p): Promise<Inventory> {
    const paths = this.paths(ctx, p);
    const { config, error } = await readConfig(paths.configFile!);
    const mcp = (config?.mcp_servers ?? {}) as Record<string, unknown>;
    const historyPresent: string[] = [];
    for (const h of paths.historyPaths) if (await exists(h)) historyPresent.push(h);
    return {
      rootExists: await exists(paths.root),
      skills: await listEntries(paths.skillsDir!),
      skillsDirLinkedTo: await symlinkTargetOf(paths.skillsDir!),
      mcpServers: Object.keys(mcp).sort(),
      historyPresent,
      warnings: error ? [error] : [],
    };
  },

  async launchSpec(ctx, _hub, p, args) {
    const bin = await this.findBinary(ctx);
    if (!bin) throw new Error('Codex (`codex`) was not found on PATH or inside ChatGPT.app.');
    const paths = this.paths(ctx, p);
    const set = paths.isDefault ? {} : { CODEX_HOME: paths.root };
    return { command: bin, args, env: cleanEnv(ctx.env, [...CODEX_ENV_STRIP, /^ELECTRON_RUN_AS_NODE$/], set) };
  },

  shareTarget(ctx, p, kind, name): ShareTarget {
    const root = this.paths(ctx, p).root;
    switch (kind) {
      case 'skills':
        // Verified in Phase 0: Codex loads symlinked skill folders.
        return { strategy: 'symlink', path: path.join(root, 'skills', name) };
      case 'commands':
        return { strategy: 'copy', path: path.join(root, 'prompts', `${name}.md`) };
      case 'instructions':
        // AGENTS.md has no import syntax: the text is copied into a managed block.
        return { strategy: 'block', style: 'inline', path: path.join(root, 'AGENTS.md') };
      case 'agents':
        return { strategy: 'unsupported', reason: 'Codex has no user-level agent files' };
      case 'settings':
        return { strategy: 'unsupported', reason: 'shared settings are Claude Code settings.json keys' };
      case 'plugins':
        return { strategy: 'unsupported', reason: 'Codex plugins are not managed by the hub yet' };
    }
  },

  async looksLikeRoot(dir) {
    for (const marker of ['config.toml', 'auth.json', 'sessions']) {
      if (await exists(path.join(dir, marker))) return true;
    }
    return false;
  },
};
