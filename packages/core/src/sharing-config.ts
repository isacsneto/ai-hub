import fs from 'node:fs/promises';
import path from 'node:path';
import { adapterFor } from './adapters/index.js';
import { saveHub, type Hub, type Profile, type Sharing } from './config.js';
import type { Context } from './context.js';
import { symlinkTargetOf } from './fsx.js';
import {
  addToLibrary,
  getLibraryItem,
  getPluginEntry,
  ITEM_KINDS,
  listLibrary,
  loadSharedSettings,
  SHAREABLE_SETTINGS,
  type ItemKind,
  type ShareKind,
} from './library.js';
import { getProfile } from './registry.js';
import { loadState, recordKey, saveState } from './state.js';
import { withTransaction } from './tx.js';

type ListKey = 'skills' | 'agents' | 'commands';
const isListKind = (k: ShareKind): k is ListKey => k === 'skills' || k === 'agents' || k === 'commands';

/** Check the thing exists before recording a choice about it, so hub.yaml never points at nothing. */
async function assertExists(ctx: Context, kind: ShareKind, name: string): Promise<void> {
  if ((ITEM_KINDS as readonly string[]).includes(kind)) await getLibraryItem(ctx, kind as ItemKind, name);
  else if (kind === 'plugins') await getPluginEntry(ctx, name);
  else if (!(SHAREABLE_SETTINGS as readonly string[]).includes(name)) {
    throw new Error(`"${name}" can't be shared. Allowed: ${SHAREABLE_SETTINGS.join(', ')}.`);
  } else if (!Object.hasOwn(await loadSharedSettings(ctx), name)) {
    throw new Error(`Setting "${name}" isn't in the library. Set it first: aihub setting set ${name} '<json>'`);
  }
}

/**
 * Turn one item on or off for some profiles in hub.yaml (the caller saves and applies).
 * `name` may be "all" for skills/agents/commands.
 */
export async function setSharing(
  ctx: Context,
  hub: Hub,
  kind: ShareKind,
  name: string,
  profileIds: string[],
  on: boolean,
  opts: { allowMcp?: boolean } = {},
): Promise<Profile[]> {
  if (name === 'all' && !isListKind(kind)) throw new Error(`"all" works for skills, agents and commands only.`);
  if (on && name !== 'all') await assertExists(ctx, kind, name);
  const profiles = profileIds.map((id) => getProfile(hub, id));
  for (const p of profiles) {
    const s: Sharing = (p.sharing ??= {});
    if (isListKind(kind)) {
      if (name === 'all') {
        if (on) s[kind] = 'all';
        else delete s[kind];
      } else {
        let list = s[kind];
        if (list === 'all') {
          if (on) continue;
          // Unsharing one item from "all" pins the rest explicitly.
          list = (await listLibrary(ctx, kind)).map((i) => i.name);
        }
        s[kind] = toggle(list ?? [], name, on);
      }
    } else if (kind === 'instructions') {
      s.instructions = toggle(s.instructions ?? [], name, on);
    } else if (kind === 'plugins') {
      s.plugins = toggle(s.plugins ?? [], name, on);
      if (!on) s.allowMcp = toggle(s.allowMcp ?? [], name, false);
      else if (opts.allowMcp) s.allowMcp = toggle(s.allowMcp ?? [], name, true);
    } else {
      s.settings = toggle(s.settings ?? [], name, on);
    }
    for (const k of Object.keys(s) as (keyof Sharing)[]) {
      const v = s[k];
      if (Array.isArray(v) && !v.length) delete s[k];
    }
    if (!Object.keys(s).length) delete p.sharing;
  }
  return profiles;
}

function toggle(list: string[], name: string, on: boolean): string[] {
  const without = list.filter((n) => n !== name);
  return on ? [...without, name] : without;
}

/** Which profiles take a given item (for the UI matrix and safe library removal). */
export async function profilesSharing(ctx: Context, hub: Hub, kind: ShareKind, name: string): Promise<string[]> {
  return hub.profiles
    .filter((p) => {
      const s = p.sharing;
      if (!s) return false;
      if (isListKind(kind)) return s[kind] === 'all' || (Array.isArray(s[kind]) && (s[kind] as string[]).includes(name));
      const list = kind === 'instructions' ? s.instructions : kind === 'plugins' ? s.plugins : s.settings;
      return list?.includes(name) ?? false;
    })
    .map((p) => p.id);
}

/**
 * Move an item that lives in one profile into the library, and share it back to that profile
 * (a link for Claude Code, a tracked copy for Codex). The original is kept in the journal.
 */
export async function promote(
  ctx: Context,
  hub: Hub,
  profileId: string,
  kind: ItemKind,
  name: string,
  opts: { force?: boolean } = {},
): Promise<{ strategy: string }> {
  const p = getProfile(hub, profileId);
  if (p.managedBy && !opts.force) throw new Error(`${p.id} is managed by ${p.managedBy}; run \`aihub takeover\` or pass --force.`);
  const t = adapterFor(p).shareTarget?.(ctx, p, kind, name);
  if (!t || (t.strategy !== 'symlink' && t.strategy !== 'copy')) {
    throw new Error(`${kind} in ${adapterFor(p).displayName} profiles can't be promoted.`);
  }
  const owner = await symlinkTargetOf(path.dirname(t.path));
  if (owner) {
    throw new Error(`${path.dirname(t.path)} is a link to ${owner}; promote it from the profile that owns that folder.`);
  }
  const st = await fs.lstat(t.path).catch(() => undefined);
  if (!st) throw new Error(`${p.id} has no ${kind.replace(/s$/, '')} "${name}" at ${t.path}.`);
  if (st.isSymbolicLink()) {
    throw new Error(`${t.path} is already a link to ${await fs.readlink(t.path)}; add that folder with \`aihub library add\` instead.`);
  }
  const item = await addToLibrary(ctx, kind, t.path, name);
  if (t.strategy === 'symlink') {
    await withTransaction(ctx, `promote-${p.id}-${name}`, async (tx) => {
      await tx.remove(t.path);
      await tx.symlink(item.path, t.path);
    });
  }
  const state = await loadState(ctx, p.id);
  const record = { kind, name, strategy: t.strategy, path: t.path, ...(t.strategy === 'copy' ? { hash: item.hash } : {}), installedAt: new Date().toISOString() };
  state.installs = [...state.installs.filter((r) => recordKey(r) !== recordKey(record)), record];
  await saveState(ctx, p.id, state);
  await setSharing(ctx, hub, kind, name, [p.id], true);
  await saveHub(ctx, hub);
  return { strategy: t.strategy };
}
