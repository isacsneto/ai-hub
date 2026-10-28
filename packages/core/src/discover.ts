import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { adapterFor, defaultCursorDataDir, defaultDesktopDataDir } from './adapters/index.js';
import type { Identity } from './adapters/types.js';
import { cleanLabel, type ClaudeCodeProfile, type Hub, type Profile } from './config.js';
import type { Context } from './context.js';
import { exists, isDirectory, readTextIfExists } from './fsx.js';
import { contractHome, resolvePath } from './paths.js';
import { readPlistString } from './plist.js';

export const GUARD_PLIST = 'Library/LaunchAgents/local.claude-account-guard.plist';
const CLAUDE_PROFILES_PREFIX = 'local.claude-profiles.';
const PALETTE = ['#3B7DD8', '#5DCAA5', '#E0A55E', '#7C5CC4', '#D25F8C', '#4CA9B2'];

export interface Candidate {
  profile: Profile;
  /** Where it was found, e.g. "cpm (~/.claude-profiles/config.toml)". */
  source: string;
  identity?: Identity;
  warnings: string[];
  state: 'new' | 'registered';
  /** Id of the existing hub profile with the same folder, when state is "registered". */
  registeredAs?: string;
}

export function toProfileId(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'profile';
}

export async function detectGuard(ctx: Context): Promise<boolean> {
  return exists(path.join(ctx.home, GUARD_PLIST));
}

/** Value of NAME="..." in a generated launcher script, with $HOME expanded. */
export function shellAssignment(script: string, name: string, home: string): string | undefined {
  const m = script.match(new RegExp(`^\\s*${name}="([^"]*)"\\s*$`, 'm'));
  if (!m?.[1]) return undefined;
  const value = m[1].replace(/\$\{HOME\}|\$HOME/g, home);
  return value.includes('$') ? undefined : value;
}

async function readCpm(ctx: Context) {
  const files = [
    path.join(ctx.home, '.claude-profiles/config.toml'),
    path.join(ctx.home, '.config/cpm/config.toml'),
  ];
  for (const file of files) {
    const text = await readTextIfExists(file);
    if (text === undefined) continue;
    let cfg: Record<string, unknown>;
    try {
      cfg = parseToml(text) as Record<string, unknown>;
    } catch {
      return { file, error: `Could not parse ${contractHome(file, ctx.home)}`, profiles: [] };
    }
    const profilesDir =
      typeof cfg.profiles_dir === 'string'
        ? resolvePath(cfg.profiles_dir, ctx.home)
        : path.join(ctx.home, '.claude-profiles');
    const table = (cfg.profiles ?? {}) as Record<string, { description?: unknown }>;
    const profiles = Object.entries(table).map(([name, v]) => ({
      name,
      description: typeof v?.description === 'string' ? v.description : undefined,
      dir: path.join(profilesDir, name),
    }));
    return { file, profiles };
  }
  return undefined;
}

async function readClaudeProfilesInstances(ctx: Context) {
  const found: { app: string; slug: string; label: string; dataDir: string; configDir?: string }[] = [];
  for (const appsDir of [path.join(ctx.home, 'Applications'), '/Applications']) {
    let names: string[] = [];
    try {
      names = await fs.readdir(appsDir);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => n.endsWith('.app')).sort()) {
      const app = path.join(appsDir, name);
      const plist = path.join(app, 'Contents/Info.plist');
      const bundleId = await readPlistString(ctx, plist, 'CFBundleIdentifier');
      if (!bundleId?.startsWith(CLAUDE_PROFILES_PREFIX) || bundleId.endsWith('.manager')) continue;
      const slug = bundleId.slice(CLAUDE_PROFILES_PREFIX.length);
      const script = (await readTextIfExists(path.join(app, 'Contents/MacOS/launcher'))) ?? '';
      found.push({
        app,
        slug,
        label: cleanLabel((await readPlistString(ctx, plist, 'CFBundleDisplayName')) ?? '') || name.replace(/\.app$/, ''),
        dataDir:
          shellAssignment(script, 'DATA_DIR', ctx.home) ?? path.join(ctx.home, '.claude-instances', slug),
        configDir: shellAssignment(script, 'CONFIG_DIR', ctx.home),
      });
    }
  }
  return found;
}

const rootOf = (ctx: Context, p: Profile) => adapterFor(p).paths(ctx, p).root;

/**
 * Find existing setups the hub can adopt where they are: default tool folders, cpm profiles and
 * Claude Profiles.app Desktop instances. Read-only.
 */
export async function discover(ctx: Context, hub: Hub): Promise<Candidate[]> {
  const guard = await detectGuard(ctx);
  const out: Candidate[] = [];
  const add = (profile: Profile, source: string, warnings: string[] = []) => {
    const color = PALETTE[out.length % PALETTE.length]!;
    // "Acme work account" → A, "Claude Acme" → A; "Claude Code (default)" gets no badge.
    const rest = profile.label.replace(/\(.*?\)/g, '').replace(/\b(claude|codex|code|desktop)\b/gi, '');
    const badge = rest.match(/[a-z0-9]/i)?.[0]?.toUpperCase();
    profile.icon ??= { color, ...(badge ? { badge } : {}) };
    // Two sources can suggest the same id (a cpm profile named "default" next to ~/.claude).
    const wanted = profile.id;
    for (let n = 2; out.some((c) => c.profile.id === profile.id); n++) profile.id = `${wanted}-${n}`;
    out.push({ profile, source, warnings, state: 'new' });
  };
  const claudeByRoot = (root: string) =>
    out.find((c) => c.profile.tool === 'claude-code' && rootOf(ctx, c.profile) === root)?.profile as
      | ClaudeCodeProfile
      | undefined;

  if (await isDirectory(path.join(ctx.home, '.claude'))) {
    add({ id: 'claude-default', tool: 'claude-code', label: 'Claude Code (default)', home: '~/.claude' }, 'default location');
  }

  const cpm = await readCpm(ctx);
  if (cpm) {
    const source = `cpm (${contractHome(cpm.file, ctx.home)})`;
    for (const cp of cpm.profiles) {
      if (!(await isDirectory(cp.dir))) continue;
      add(
        {
          id: toProfileId(`claude-${cp.name}`),
          tool: 'claude-code',
          label: cleanLabel(cp.description ?? '') || `Claude ${cp.name}`,
          home: contractHome(cp.dir, ctx.home),
          managedBy: guard ? 'claude-account-guard' : 'cpm',
        },
        source,
      );
    }
  }

  if (await isDirectory(path.join(ctx.home, '.codex'))) {
    add({ id: 'codex-default', tool: 'codex', label: 'Codex (default)', home: '~/.codex' }, 'default location');
  }

  const codexApp = ['/Applications/ChatGPT.app', '/Applications/Codex.app'];
  if ((await isDirectory(path.join(ctx.home, '.codex'))) && (await Promise.all(codexApp.map((a) => exists(a)))).some(Boolean)) {
    add({ id: 'codex-desktop-default', tool: 'codex-desktop', label: 'ChatGPT / Codex app (default)', codexHome: '~/.codex' }, 'default location');
  }

  if ((await exists('/Applications/Cursor.app')) && (await isDirectory(defaultCursorDataDir(ctx.home)))) {
    add(
      { id: 'cursor-default', tool: 'cursor', label: 'Cursor (default)', dataDir: contractHome(defaultCursorDataDir(ctx.home), ctx.home), homeMode: 'shared' },
      'default location',
    );
  }

  const hasClaudeApp =
    (await exists('/Applications/Claude.app')) || (await exists(path.join(ctx.home, 'Applications/Claude.app')));
  if (hasClaudeApp && (await isDirectory(defaultDesktopDataDir(ctx.home)))) {
    const code = claudeByRoot(path.join(ctx.home, '.claude'));
    add(
      {
        id: 'claude-desktop-default',
        tool: 'claude-desktop',
        label: 'Claude Desktop (default)',
        dataDir: contractHome(defaultDesktopDataDir(ctx.home), ctx.home),
        ...(code ? { codeProfile: code.id } : {}),
      },
      'default location',
    );
  }

  for (const inst of await readClaudeProfilesInstances(ctx)) {
    const warnings: string[] = [];
    let code = inst.configDir ? claudeByRoot(resolvePath(inst.configDir, ctx.home)) : undefined;
    if (inst.configDir && !code) {
      code = {
        id: toProfileId(`claude-${inst.slug.replace(/^claude-?/, '')}-code`),
        tool: 'claude-code',
        label: `${inst.label} (Code tab)`,
        home: contractHome(inst.configDir, ctx.home),
      };
      add(code, `Code tab folder of ${inst.label}`);
    }
    if (!inst.configDir) {
      warnings.push('launcher passes no CLAUDE_CONFIG_DIR: its Code tab uses your default ~/.claude');
    }
    add(
      {
        id: toProfileId(`claude-desktop-${inst.slug.replace(/^claude-?/, '') || inst.slug}`),
        tool: 'claude-desktop',
        label: inst.label,
        dataDir: contractHome(inst.dataDir, ctx.home),
        ...(code ? { codeProfile: code.id } : {}),
        launcher: contractHome(inst.app, ctx.home),
        managedBy: guard ? 'claude-account-guard' : 'claude-profiles',
      },
      `Claude Profiles.app (${contractHome(inst.app, ctx.home)})`,
      warnings,
    );
  }

  // Match against what is already registered: same folder → registered; same id, other folder → rename.
  const renamed = new Map<string, string>();
  for (const c of out) {
    const root = rootOf(ctx, c.profile);
    const same = hub.profiles.find((p) => p.tool === c.profile.tool && rootOf(ctx, p) === root);
    if (same) {
      c.state = 'registered';
      c.registeredAs = same.id;
      renamed.set(c.profile.id, same.id);
      continue;
    }
    let id = c.profile.id;
    const taken = (x: string) => hub.profiles.some((p) => p.id === x) || out.some((o) => o !== c && o.profile.id === x);
    for (let n = 2; taken(id); n++) id = `${c.profile.id}-${n}`;
    if (id !== c.profile.id) renamed.set(c.profile.id, id);
    c.profile.id = id;
  }
  for (const c of out) {
    if (c.profile.tool === 'claude-desktop' && c.profile.codeProfile) {
      c.profile.codeProfile = renamed.get(c.profile.codeProfile) ?? c.profile.codeProfile;
    }
  }

  for (const c of out) {
    if (c.profile.tool === 'claude-desktop' || c.profile.tool === 'codex-desktop') continue;
    c.identity = await adapterFor(c.profile).identity(ctx, c.profile);
    if (c.identity.status === 'signed-out') c.warnings.push('not signed in');
  }
  return out;
}
