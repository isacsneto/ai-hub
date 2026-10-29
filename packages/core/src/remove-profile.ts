import fs from 'node:fs/promises';
import path from 'node:path';
import { loadHub, saveHub, type Hub } from './config.js';
import type { Context } from './context.js';
import { exists } from './fsx.js';
import { removeLauncher } from './launchers.js';
import { withHubLock } from './lock.js';
import { contractHome } from './paths.js';
import { getProfile, profileRoot } from './registry.js';
import { listProcesses } from './relaunch-watch.js';
import { reconcile } from './share.js';
import { loadState, stateFile } from './state.js';

export interface RemovalInfo {
  folder: string;
  /** Things the hub placed in the folder (links, copies, blocks, settings, plugins). */
  shared: number;
  /** Desktop profiles whose Code tab uses this profile; it can't be removed while there are any. */
  usedBy: string[];
  /** Other profiles on the same folder (Codex and the ChatGPT/Codex app); their data goes with it if it's trashed. */
  sharesFolderWith: string[];
  /**
   * The folder may go to the Trash: the hub created it (~/.aihub/profiles/<id>) and no other profile
   * uses it. Adopted folders never do.
   */
  canTrash: boolean;
  /** Managed by another tool: its folder is read-only, so shared items stay in place. */
  readOnly: boolean;
}

export async function removalInfo(ctx: Context, hub: Hub, id: string): Promise<RemovalInfo> {
  const p = getProfile(hub, id);
  const root = profileRoot(ctx, p);
  const sharesFolderWith = hub.profiles.filter((q) => q.id !== id && profileRoot(ctx, q) === root).map((q) => q.label);
  return {
    folder: contractHome(root, ctx.home),
    shared: (await loadState(ctx, id)).installs.length,
    usedBy: hub.profiles.filter((q) => q.tool === 'claude-desktop' && q.codeProfile === id).map((q) => q.label),
    sharesFolderWith,
    canTrash: path.resolve(root).startsWith(path.join(ctx.hubDir, 'profiles') + path.sep) && !sharesFolderWith.length,
    readOnly: !!p.managedBy,
  };
}

/** Rename into ~/.Trash, which macOS empties like any other trashed file. */
export async function moveToTrash(ctx: Context, dir: string): Promise<void> {
  const trash = path.join(ctx.home, '.Trash');
  await fs.mkdir(trash, { recursive: true });
  let dest = path.join(trash, path.basename(dir));
  for (let n = 2; await exists(dest); n++) dest = path.join(trash, `${path.basename(dir)} ${n}`);
  await fs.rename(dir, dest);
}

/**
 * Whether a process runs on the folder: as --user-data-dir=<folder> (apps) or CLAUDE_CONFIG_DIR /
 * CODEX_HOME=<folder> (terminal sessions). `others` are other profiles' folders: ps joins arguments
 * with spaces, so "/x/My" must not count a process that runs on "/x/My Work".
 */
async function folderInUse(ctx: Context, root: string, others: string[]): Promise<boolean> {
  const longer = others.filter((o) => o.startsWith(`${root} `)).map((o) => o.slice(root.length));
  const uses = (line: string) =>
    line
      .split(`=${root}`)
      .slice(1)
      .some((rest) => rest === '' || rest[0] === '/' || (rest[0] === ' ' && !longer.some((l) => rest.startsWith(l))));
  return (await listProcesses(ctx, { env: true })).some((q) => uses(q.args));
}

export interface RemoveResult {
  folder: string;
  /** Shared items taken out of the folder (undo with `aihub undo`). */
  unshared: number;
  /** Shared items still in the folder (read-only folder, or edited since): they stay as they are. */
  leftInPlace: number;
  launcher?: string;
  trashed: boolean;
}

/**
 * Remove a profile from the hub. By default its folder and login stay exactly as they are.
 * `unshare` first takes out what the hub shared into it, except plugins (one transaction, so `aihub
 * undo` puts it back); `trash` moves a folder the hub created to the Trash instead, login and history included.
 * hub.yaml is read under the hub lock, so a change made meanwhile (another window, the CLI) isn't lost.
 */
export async function deleteProfile(
  ctx: Context,
  id: string,
  opts: { unshare?: boolean; trash?: (dir: string) => Promise<void> } = {},
): Promise<RemoveResult> {
  return withHubLock(ctx, async () => {
    const hub = await loadHub(ctx);
    const p = getProfile(hub, id);
    const info = await removalInfo(ctx, hub, id);
    if (info.usedBy.length) {
      throw new Error(`${info.usedBy.join(', ')} use${info.usedBy.length === 1 ? 's' : ''} "${p.label}" for the Code tab. Remove ${info.usedBy.length === 1 ? 'that' : 'those'} first.`);
    }
    const root = profileRoot(ctx, p);
    const result: RemoveResult = { folder: info.folder, unshared: 0, leftInPlace: info.shared, trashed: false };

    if (opts.trash) {
      if (info.sharesFolderWith.length) {
        throw new Error(`${info.folder} is also used by ${info.sharesFolderWith.join(', ')}, so it isn't moved to the Trash.`);
      }
      if (!info.canTrash) throw new Error(`${info.folder} wasn't created by AI-Hub, so it isn't moved to the Trash.`);
      if (await folderInUse(ctx, root, hub.profiles.map((q) => profileRoot(ctx, q)))) throw new Error(`${p.label} is still open (an app window or a terminal session). Quit it first, then remove it.`);
      if (await exists(root)) await opts.trash(root);
      result.trashed = true;
      result.leftInPlace = 0;
    } else if (opts.unshare && info.shared) {
      // Plugins stay: they're uninstalled by a command undo can't reverse.
      const { plugins, allowMcp } = p.sharing ?? {};
      const bare = { ...p, sharing: plugins?.length ? { plugins, ...(allowMcp ? { allowMcp } : {}) } : undefined };
      await reconcile(ctx, { ...hub, profiles: hub.profiles.map((q) => (q.id === id ? bare : q)) }, bare);
      result.leftInPlace = (await loadState(ctx, id)).installs.length;
      result.unshared = info.shared - result.leftInPlace;
    }
    // Records of items still in place are kept, so adding the profile back manages them again.
    if (!result.leftInPlace) await fs.rm(stateFile(ctx, id), { force: true });

    try {
      const launcher = await removeLauncher(ctx, hub, p);
      if (launcher) result.launcher = contractHome(launcher, ctx.home); // its Dock tile goes with it
    } catch {
      // Something else lives at the launcher's path: not ours to delete.
    }
    hub.profiles = hub.profiles.filter((q) => q.id !== id);
    await saveHub(ctx, hub);
    return result;
  });
}
