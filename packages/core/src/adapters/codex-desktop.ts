import path from 'node:path';
import type { CodexDesktopProfile } from '../config.js';
import type { Context } from '../context.js';
import { APP_ENV_STRIP, cleanEnv } from '../env.js';
import { exists } from '../fsx.js';
import { resolvePath } from '../paths.js';
import { readPlistString } from '../plist.js';
import { codex } from './codex.js';
import { TESTED } from './tested.js';
import type { ToolAdapter } from './types.js';

/** ChatGPT.app is the Codex desktop app (bundle com.openai.codex); its account is the Codex login. */
const APPS = ['/Applications/ChatGPT.app', '/Applications/Codex.app'];

async function findApp(ctx: Context, p?: CodexDesktopProfile): Promise<string | undefined> {
  const candidates = p?.app ? [resolvePath(p.app, ctx.home)] : [...APPS, ...APPS.map((a) => path.join(ctx.home, a.slice(1)))];
  for (const c of candidates) if (await exists(path.join(c, 'Contents/Info.plist'))) return c;
  return undefined;
}

/** View of the profile as the Codex folder it runs on, so identity/inventory reuse the Codex adapter. */
const asCodex = (p: CodexDesktopProfile) => ({ id: p.id, tool: 'codex' as const, label: p.label, home: p.codexHome });

export const codexDesktop: ToolAdapter<CodexDesktopProfile> = {
  tool: 'codex-desktop',
  displayName: 'ChatGPT / Codex app',
  tested: TESTED['codex-desktop'],
  findBinary: findApp,

  async detectVersion(ctx, p) {
    const app = await findApp(ctx, p);
    return app ? readPlistString(ctx, path.join(app, 'Contents/Info.plist'), 'CFBundleShortVersionString') : undefined;
  },

  paths: (ctx, p) => codex.paths(ctx, asCodex(p)),
  identity: (ctx, p) => codex.identity(ctx, asCodex(p)),
  inventory: (ctx, p) => codex.inventory(ctx, asCodex(p)),

  async launchSpec(ctx, _hub, p, args) {
    const app = await findApp(ctx, p);
    if (!app) throw new Error('ChatGPT.app (Codex) was not found in /Applications.');
    const paths = codex.paths(ctx, asCodex(p));
    const open = paths.isDefault ? ['-a', app] : ['-n', '-a', app, '--env', `CODEX_HOME=${paths.root}`];
    return { command: '/usr/bin/open', args: [...open, ...(args.length ? ['--args', ...args] : [])], env: cleanEnv(ctx.env, APP_ENV_STRIP) };
  },

  looksLikeRoot: (dir) => codex.looksLikeRoot(dir),
};
