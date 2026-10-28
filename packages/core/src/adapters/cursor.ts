import fs from 'node:fs/promises';
import path from 'node:path';
import type { CursorProfile } from '../config.js';
import type { Context } from '../context.js';
import { APP_ENV_STRIP, cleanEnv } from '../env.js';
import { exists, readJsonIfExists } from '../fsx.js';
import { resolvePath } from '../paths.js';
import { readPlistString } from '../plist.js';
import { TESTED } from './tested.js';
import type { Identity, Inventory, ProfilePaths, ToolAdapter } from './types.js';

export const defaultCursorDataDir = (home: string) => path.join(home, 'Library/Application Support/Cursor');

/**
 * Linked into an isolated HOME so git, ssh and the shell still work inside Cursor. Library/Keychains
 * is required: Electron's safe storage looks for the login keychain under $HOME.
 */
const HOME_LINKS = ['Library/Keychains', '.gitconfig', '.config/git', '.ssh', '.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.npmrc'];

async function findApp(ctx: Context, p?: CursorProfile): Promise<string | undefined> {
  const candidates = p?.app
    ? [resolvePath(p.app, ctx.home)]
    : ['/Applications/Cursor.app', path.join(ctx.home, 'Applications/Cursor.app')];
  for (const c of candidates) if (await exists(path.join(c, 'Contents/Info.plist'))) return c;
  return undefined;
}

function cursorHome(ctx: Context, p: CursorProfile): string {
  return p.homeMode === 'isolated' ? path.join(resolvePath(p.dataDir, ctx.home), 'home') : ctx.home;
}

const stateDb = (root: string) => path.join(root, 'User/globalStorage/state.vscdb');

export const cursor: ToolAdapter<CursorProfile> = {
  tool: 'cursor',
  displayName: 'Cursor',
  tested: TESTED.cursor,
  findBinary: findApp,

  async detectVersion(ctx, p) {
    const app = await findApp(ctx, p);
    return app ? readPlistString(ctx, path.join(app, 'Contents/Info.plist'), 'CFBundleShortVersionString') : undefined;
  },

  paths(ctx, p): ProfilePaths {
    const root = resolvePath(p.dataDir, ctx.home);
    return {
      root,
      isDefault: root === defaultCursorDataDir(ctx.home),
      configFile: path.join(root, 'User/settings.json'),
      // Cursor derives ~/.cursor from $HOME, not from --user-data-dir.
      mcpFile: path.join(cursorHome(ctx, p), '.cursor/mcp.json'),
      historyPaths: [stateDb(root), path.join(root, 'User/workspaceStorage')],
      credential: { kind: 'unknown', detail: 'cursorAuth/* entries in User/globalStorage/state.vscdb' },
    };
  },

  async identity(ctx, p): Promise<Identity> {
    const db = stateDb(this.paths(ctx, p).root);
    if (!(await exists(db))) return { status: 'signed-out', detail: 'no state database yet' };
    // Only the cached email and whether a token row exists; token values are never selected.
    const q = (sql: string) => ctx.sys.run('/usr/bin/sqlite3', ['-readonly', '-cmd', '.timeout 3000', db, sql], { timeoutMs: 8000 });
    const [email, token] = await Promise.all([
      q("select value from ItemTable where key='cursorAuth/cachedEmail'"),
      q("select count(*) from ItemTable where key='cursorAuth/accessToken'"),
    ]);
    if (token.code !== 0) return { status: 'unknown', detail: 'state database unreadable' };
    const mail = email.stdout.trim() || undefined;
    return token.stdout.trim() === '1' ? { status: 'signed-in', email: mail } : { status: 'signed-out', email: mail };
  },

  async inventory(ctx, p): Promise<Inventory> {
    const paths = this.paths(ctx, p);
    const warnings: string[] = [];
    let mcp: Record<string, unknown> | undefined;
    try {
      mcp = (await readJsonIfExists(paths.mcpFile!)) as typeof mcp;
    } catch (err) {
      warnings.push((err as Error).message);
    }
    const historyPresent: string[] = [];
    for (const h of paths.historyPaths) if (await exists(h)) historyPresent.push(h);
    const servers = (mcp?.mcpServers ?? {}) as Record<string, unknown>;
    return { rootExists: await exists(paths.root), skills: [], mcpServers: Object.keys(servers).sort(), historyPresent, warnings };
  },

  async prepareLaunch(ctx, p) {
    if (p.homeMode !== 'isolated') return;
    const home = cursorHome(ctx, p);
    await fs.mkdir(path.join(home, '.cursor'), { recursive: true, mode: 0o700 });
    for (const rel of HOME_LINKS) {
      const src = path.join(ctx.home, rel);
      const dest = path.join(home, rel);
      if (!(await exists(src)) || (await exists(dest))) continue;
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.symlink(src, dest);
    }
  },

  async launchSpec(ctx, _hub, p, args) {
    const app = await findApp(ctx, p);
    if (!app) throw new Error('Cursor.app was not found in /Applications or ~/Applications.');
    const paths = this.paths(ctx, p);
    const open = paths.isDefault ? ['-a', app] : ['-n', '-a', app];
    if (p.homeMode === 'isolated') open.push('--env', `HOME=${cursorHome(ctx, p)}`);
    const appArgs = [
      ...(paths.isDefault ? [] : [`--user-data-dir=${paths.root}`]),
      ...(p.extensionsDir ? [`--extensions-dir=${resolvePath(p.extensionsDir, ctx.home)}`] : []),
      ...args,
    ];
    return { command: '/usr/bin/open', args: [...open, ...(appArgs.length ? ['--args', ...appArgs] : [])], env: cleanEnv(ctx.env, APP_ENV_STRIP) };
  },

  async looksLikeRoot(dir) {
    return (await exists(path.join(dir, 'User'))) || (await exists(path.join(dir, 'Preferences')));
  },
};
