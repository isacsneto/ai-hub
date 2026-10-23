import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { adapterFor } from './adapters/index.js';
import { preferences, type Hub, type Profile } from './config.js';
import type { Context } from './context.js';
import { shellQuote } from './env.js';
import { atomicWrite, exists } from './fsx.js';
import { renderIcon, writeIcns } from './icons.js';
import { resolvePath } from './paths.js';
import { readPlistString } from './plist.js';

export const LAUNCHER_BUNDLE_PREFIX = 'dev.aihub.';

/** Variables a CLI session clears before setting its own (same rule as `aihub run`). */
const STRIP_GLOBS: Partial<Record<Profile['tool'], string[]>> = {
  'claude-code': ['CLAUDE_*', 'ANTHROPIC_*', 'CLAUDECODE'],
  codex: ['CODEX_*', 'OPENAI_API_KEY'],
};

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function launcherPath(ctx: Context, hub: Hub, p: Profile, dir?: string): string {
  const base = resolvePath(dir ?? preferences(hub).launchersDir, ctx.home);
  return path.join(base, `${p.label.replace(/[/:]/g, '-')}.app`);
}

function infoPlist(p: Profile): string {
  const kv = (k: string, v: string) => `\t<key>${k}</key><string>${escapeXml(v)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    kv('CFBundleName', p.label),
    kv('CFBundleDisplayName', p.label),
    kv('CFBundleIdentifier', `${LAUNCHER_BUNDLE_PREFIX}${p.id}`),
    kv('CFBundleExecutable', 'launcher'),
    kv('CFBundleIconFile', 'icon'),
    kv('CFBundlePackageType', 'APPL'),
    kv('CFBundleShortVersionString', '1.0'),
    kv('CFBundleVersion', '1'),
    kv('AIHubProfile', p.id),
    '</dict></plist>',
    '',
  ].join('\n');
}

/** Script a terminal runs for a CLI profile: clean env, set the profile's folder, exec the tool. */
export async function sessionScript(ctx: Context, hub: Hub, p: Profile): Promise<string> {
  const spec = await adapterFor(p).launchSpec(ctx, hub, p, []);
  const globs = STRIP_GLOBS[p.tool] ?? [];
  // Everything matching the strip list is cleared first, so every such variable the profile needs
  // (CLAUDE_CONFIG_DIR, CODEX_HOME) must be exported, even if this shell happens to have it already.
  const stripped = (k: string) => globs.some((g) => new RegExp(`^${g.replace('*', '.*')}$`).test(k));
  const sets = Object.entries(spec.env).filter(([k, v]) => v !== undefined && stripped(k));
  const shell = (ctx.env.SHELL ?? '/bin/zsh').endsWith('bash') ? '/bin/bash' : '/bin/zsh';
  return [
    `#!${shell} -l`,
    `# AI-Hub session for "${p.label}" (${p.id}). Regenerate with: aihub launcher build ${p.id}`,
    `while IFS='=' read -r name _; do case "$name" in ${globs.join('|') || '__none__'}) unset "$name" ;; esac; done < <(env)`,
    ...sets.map(([k, v]) => `export ${k}=${shellQuote(v!)}`),
    `export AIHUB_PROFILE=${shellQuote(p.id)}`,
    `printf '\\033]0;%s\\007' ${shellQuote(p.label)}`,
    'cd "$HOME"',
    `exec ${shellQuote(spec.command)}`,
    '',
  ].join('\n');
}

async function launcherScript(ctx: Context, hub: Hub, p: Profile): Promise<string> {
  if (p.tool === 'claude-code' || p.tool === 'codex') {
    const terminal = preferences(hub).terminal;
    return `#!/bin/bash\nexec /usr/bin/open -a ${shellQuote(terminal)} "$(dirname "$0")/../Resources/session.command"\n`;
  }
  // GUI tools: bake the exact `open` command so the launcher works without Node.
  const adapter = adapterFor(p);
  await adapter.prepareLaunch?.(ctx, p);
  const spec = await adapter.launchSpec(ctx, hub, p, []);
  return `#!/bin/bash\nexec ${[spec.command, ...spec.args].map(shellQuote).join(' ')}\n`;
}

async function assertOurs(ctx: Context, app: string): Promise<void> {
  if (!(await exists(app))) return;
  const id = await readPlistString(ctx, path.join(app, 'Contents/Info.plist'), 'CFBundleIdentifier');
  if (!id?.startsWith(LAUNCHER_BUNDLE_PREFIX)) {
    throw new Error(`${app} exists and wasn't made by AI-Hub; leaving it alone. Rename the profile label or use --dir.`);
  }
}

/** Build (or rebuild) a small .app that launches the profile, with its own name and icon. */
export async function buildLauncher(ctx: Context, hub: Hub, p: Profile, opts: { dir?: string } = {}): Promise<string> {
  const app = launcherPath(ctx, hub, p, opts.dir);
  await assertOurs(ctx, app);
  const tmp = `${app}.tmp-${randomBytes(4).toString('hex')}`;
  try {
    await fs.mkdir(path.join(tmp, 'Contents/MacOS'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'Contents/Resources'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'Contents/Info.plist'), infoPlist(p));
    await fs.writeFile(path.join(tmp, 'Contents/MacOS/launcher'), await launcherScript(ctx, hub, p), { mode: 0o755 });
    if (p.tool === 'claude-code' || p.tool === 'codex') {
      await fs.writeFile(path.join(tmp, 'Contents/Resources/session.command'), await sessionScript(ctx, hub, p), { mode: 0o755 });
    }
    await writeIcns(ctx, await renderIcon(ctx, p), path.join(tmp, 'Contents/Resources/icon.icns'));
    await fs.rm(app, { recursive: true, force: true });
    await fs.rename(tmp, app);
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw err;
  }
  // Ad-hoc signature so Gatekeeper treats it as a local app; harmless if it fails.
  await ctx.sys.run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
  return app;
}

export async function removeLauncher(ctx: Context, hub: Hub, p: Profile, opts: { dir?: string } = {}): Promise<string | undefined> {
  const app = launcherPath(ctx, hub, p, opts.dir);
  if (!(await exists(app))) return undefined;
  await assertOurs(ctx, app);
  await fs.rm(app, { recursive: true, force: true });
  return app;
}

/**
 * Launch a profile from a GUI (the desktop app, the menu bar): CLI profiles open in the preferred
 * terminal through a session script; app profiles run their `open` command.
 */
export async function launchProfile(ctx: Context, hub: Hub, p: Profile): Promise<void> {
  const adapter = adapterFor(p);
  if (p.tool === 'claude-code' || p.tool === 'codex') {
    const file = path.join(ctx.hubDir, 'sessions', `${p.id}.command`);
    await atomicWrite(file, await sessionScript(ctx, hub, p), 0o700);
    const r = await ctx.sys.run('/usr/bin/open', ['-a', preferences(hub).terminal, file]);
    if (r.code !== 0) throw new Error(`Could not open ${preferences(hub).terminal}: ${r.stderr.trim()}`);
    return;
  }
  await adapter.prepareLaunch?.(ctx, p);
  const spec = await adapter.launchSpec(ctx, hub, p, []);
  const r = await ctx.sys.run(spec.command, spec.args, { env: spec.env });
  if (r.code !== 0) throw new Error(`Launch failed: ${r.stderr.trim()}`);
}
