import path from 'node:path';
import type { BrowserProfile } from '../config.js';
import type { Context } from '../context.js';
import { APP_ENV_STRIP, cleanEnv } from '../env.js';
import { ensureDir, exists } from '../fsx.js';
import { resolvePath } from '../paths.js';
import { readPlistString } from '../plist.js';
import { TESTED } from './tested.js';
import type { ProfilePaths, ToolAdapter } from './types.js';

/** Chromium-family browsers: all take --user-data-dir, so each profile is its own cookie jar. */
export const BROWSER_APPS: Record<BrowserProfile['browser'], string> = {
  chrome: 'Google Chrome.app',
  edge: 'Microsoft Edge.app',
  brave: 'Brave Browser.app',
  chromium: 'Chromium.app',
  vivaldi: 'Vivaldi.app',
};

async function findApp(ctx: Context, p?: BrowserProfile): Promise<string | undefined> {
  const names = p ? [BROWSER_APPS[p.browser]] : Object.values(BROWSER_APPS);
  for (const n of names) {
    for (const dir of ['/Applications', path.join(ctx.home, 'Applications')]) {
      const app = path.join(dir, n);
      if (await exists(path.join(app, 'Contents/Info.plist'))) return app;
    }
  }
  return undefined;
}

export const browser: ToolAdapter<BrowserProfile> = {
  tool: 'browser',
  displayName: 'Browser profile',
  tested: TESTED.browser,
  findBinary: findApp,

  async detectVersion(ctx, p) {
    const app = await findApp(ctx, p);
    return app ? readPlistString(ctx, path.join(app, 'Contents/Info.plist'), 'CFBundleShortVersionString') : undefined;
  },

  paths(ctx, p): ProfilePaths {
    const root = resolvePath(p.dataDir, ctx.home);
    return {
      root,
      isDefault: false,
      historyPaths: [path.join(root, 'Default/History')],
      credential: { kind: 'unknown', detail: 'site cookies inside the profile folder' },
    };
  },

  async identity() {
    return { status: 'unknown', detail: 'signed in on the website' };
  },

  async inventory(ctx, p) {
    const paths = this.paths(ctx, p);
    const historyPresent: string[] = [];
    for (const h of paths.historyPaths) if (await exists(h)) historyPresent.push(h);
    return { rootExists: await exists(paths.root), skills: [], mcpServers: [], historyPresent, warnings: [] };
  },

  async prepareLaunch(ctx, p) {
    await ensureDir(this.paths(ctx, p).root);
  },

  async launchSpec(ctx, _hub, p, args) {
    const app = await findApp(ctx, p);
    if (!app) throw new Error(`${BROWSER_APPS[p.browser].replace(/\.app$/, '')} is not installed.`);
    const root = this.paths(ctx, p).root;
    const page = p.appWindow ? `--app=${p.url}` : p.url;
    return {
      command: '/usr/bin/open',
      args: ['-n', '-a', app, '--args', `--user-data-dir=${root}`, '--no-first-run', '--no-default-browser-check', page, ...args],
      env: cleanEnv(ctx.env, APP_ENV_STRIP),
    };
  },

  async looksLikeRoot(dir) {
    return exists(path.join(dir, 'Local State'));
  },
};
