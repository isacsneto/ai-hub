import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { Context } from './context.js';
import { atomicWrite, ensureDir, exists, isDirectory, readJsonIfExists, readTextIfExists } from './fsx.js';

/** Items stored as files/folders in the library and placed into profiles. */
export const ITEM_KINDS = ['skills', 'agents', 'commands', 'instructions'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
/** Everything `aihub share` understands. */
export type ShareKind = ItemKind | 'plugins' | 'settings';
export const SHARE_KINDS: readonly ShareKind[] = [...ITEM_KINDS, 'plugins', 'settings'];

/** Accepts "skill", "skills", "Skill" … */
export function parseShareKind(s: string): ShareKind {
  const k = s.toLowerCase().replace(/s?$/, 's') as ShareKind;
  if (!SHARE_KINDS.includes(k)) throw new Error(`Unknown kind "${s}". Use one of: ${SHARE_KINDS.join(', ')}.`);
  return k;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function assertItemName(name: string): void {
  if (!NAME.test(name) || name.includes('..')) {
    throw new Error(`"${name}" is not a valid item name (letters, digits, . _ -; max 64).`);
  }
}

/** settings.json keys the hub may share. Anything that can hold secrets (env, apiKeyHelper…) is excluded. */
export const SHAREABLE_SETTINGS = [
  'permissions',
  'statusLine',
  'outputStyle',
  'model',
  'alwaysThinkingEnabled',
  'includeCoAuthoredBy',
  'spinnerTipsEnabled',
] as const;

export interface LibraryItem {
  kind: ItemKind;
  name: string;
  path: string;
  hash: string;
  description?: string;
}

export const libraryDir = (ctx: Context) => path.join(ctx.hubDir, 'library');

export function itemPath(ctx: Context, kind: ItemKind, name: string): string {
  assertItemName(name);
  return kind === 'skills'
    ? path.join(libraryDir(ctx), 'skills', name)
    : path.join(libraryDir(ctx), kind, `${name}.md`);
}

const IGNORED = new Set(['.DS_Store', '.git']);

/** Content hash of a file or folder (relative paths + bytes), stable across machines. */
export async function hashPath(p: string): Promise<string> {
  const h = createHash('sha256');
  const walk = async (abs: string, rel: string): Promise<void> => {
    const st = await fs.stat(abs);
    if (st.isDirectory()) {
      for (const name of (await fs.readdir(abs)).sort()) {
        if (IGNORED.has(name)) continue;
        await walk(path.join(abs, name), rel ? `${rel}/${name}` : name);
      }
    } else {
      h.update(`${rel}\0`);
      h.update(await fs.readFile(abs));
      h.update('\0');
    }
  };
  await walk(p, '');
  return h.digest('hex');
}

function describe(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  const desc = fm?.[1]?.match(/^description:\s*(.+)$/m)?.[1];
  if (desc) return desc.replace(/^["']|["']$/g, '').trim();
  return text.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

export function mainFile(item: Pick<LibraryItem, 'kind' | 'path'>): string {
  return item.kind === 'skills' ? path.join(item.path, 'SKILL.md') : item.path;
}

export async function listLibrary(ctx: Context, kind?: ItemKind): Promise<LibraryItem[]> {
  const out: LibraryItem[] = [];
  for (const k of kind ? [kind] : ITEM_KINDS) {
    const dir = path.join(libraryDir(ctx), k);
    let names: string[] = [];
    try {
      names = (await fs.readdir(dir)).sort();
    } catch {
      continue;
    }
    for (const entry of names) {
      if (entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      if (k === 'skills' ? !(await isDirectory(full)) : !entry.endsWith('.md')) continue;
      const name = k === 'skills' ? entry : entry.slice(0, -3);
      if (!NAME.test(name)) continue;
      const item = { kind: k, name, path: full };
      out.push({ ...item, hash: await hashPath(full), description: describe(await readTextIfExists(mainFile(item))) });
    }
  }
  return out;
}

export async function getLibraryItem(ctx: Context, kind: ItemKind, name: string): Promise<LibraryItem> {
  const item = (await listLibrary(ctx, kind)).find((i) => i.name === name);
  if (!item) throw new Error(`No ${kind.replace(/s$/, '')} "${name}" in the library. See \`aihub library list\`.`);
  return item;
}

/** Copy a skill folder or .md file into the library. Symlinks are followed so the library is self-contained. */
export async function addToLibrary(
  ctx: Context,
  kind: ItemKind,
  source: string,
  name?: string,
): Promise<LibraryItem> {
  const isDir = await isDirectory(source);
  if (kind === 'skills') {
    if (!isDir || !(await exists(path.join(source, 'SKILL.md')))) {
      throw new Error(`${source} is not a skill folder (it needs a SKILL.md).`);
    }
  } else if (isDir || !source.endsWith('.md')) {
    throw new Error(`${kind} are single .md files; ${source} isn't one.`);
  }
  const itemName = name ?? path.basename(source).replace(/\.md$/, '');
  const dest = itemPath(ctx, kind, itemName);
  if (await exists(dest)) throw new Error(`The library already has ${kind.replace(/s$/, '')} "${itemName}".`);
  await ensureDir(path.dirname(dest));
  await fs.cp(source, dest, { recursive: true, dereference: true, errorOnExist: true });
  await commitLibrary(ctx, `add ${kind}/${itemName}`);
  return getLibraryItem(ctx, kind, itemName);
}

export async function removeFromLibrary(ctx: Context, kind: ItemKind, name: string): Promise<void> {
  const item = await getLibraryItem(ctx, kind, name);
  await fs.rm(item.path, { recursive: true, force: true });
  await commitLibrary(ctx, `remove ${kind}/${name}`);
}

// ---------- plugin catalog ----------

const PluginEntry = z.strictObject({
  /** name@marketplace, as `claude plugin install` takes it. */
  id: z.string().regex(/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/, 'use name@marketplace'),
  /** Marketplace source for `claude plugin marketplace add` (GitHub owner/repo, URL or path). */
  source: z.string().optional(),
});
const Catalog = z.strictObject({ plugins: z.array(PluginEntry).default([]) });
export type PluginEntry = z.infer<typeof PluginEntry>;

const catalogFile = (ctx: Context) => path.join(libraryDir(ctx), 'plugins.yaml');

export async function loadCatalog(ctx: Context): Promise<PluginEntry[]> {
  const text = await readTextIfExists(catalogFile(ctx));
  return text ? Catalog.parse(YAML.parse(text) ?? {}).plugins : [];
}

export async function saveCatalog(ctx: Context, plugins: PluginEntry[]): Promise<void> {
  await atomicWrite(catalogFile(ctx), YAML.stringify(Catalog.parse({ plugins })));
  await commitLibrary(ctx, 'update plugin catalog');
}

export async function getPluginEntry(ctx: Context, id: string): Promise<PluginEntry> {
  const entry = (await loadCatalog(ctx)).find((p) => p.id === id);
  if (!entry) throw new Error(`Plugin "${id}" is not in the library catalog. Add it with \`aihub plugin add ${id}\`.`);
  return entry;
}

// ---------- shared settings ----------

const settingsFile = (ctx: Context) => path.join(libraryDir(ctx), 'settings.json');

export async function loadSharedSettings(ctx: Context): Promise<Record<string, unknown>> {
  return ((await readJsonIfExists(settingsFile(ctx))) as Record<string, unknown> | undefined) ?? {};
}

export async function setSharedSetting(ctx: Context, key: string, value: unknown | undefined): Promise<void> {
  if (!(SHAREABLE_SETTINGS as readonly string[]).includes(key)) {
    throw new Error(`"${key}" can't be shared. Allowed: ${SHAREABLE_SETTINGS.join(', ')}.`);
  }
  const all = await loadSharedSettings(ctx);
  if (value === undefined) delete all[key];
  else all[key] = value;
  await atomicWrite(settingsFile(ctx), JSON.stringify(all, null, 2) + '\n');
  await commitLibrary(ctx, `${value === undefined ? 'unset' : 'set'} setting ${key}`);
}

// ---------- history (git) ----------

async function git(ctx: Context, args: string[]) {
  return ctx.sys.run('git', ['-C', libraryDir(ctx), ...args], {
    env: { ...ctx.env, GIT_AUTHOR_NAME: 'AI-Hub', GIT_AUTHOR_EMAIL: 'aihub@localhost', GIT_COMMITTER_NAME: 'AI-Hub', GIT_COMMITTER_EMAIL: 'aihub@localhost' },
  });
}

/** Every library change becomes a commit, so `aihub library log/restore` can go back. Best effort without git. */
export async function commitLibrary(ctx: Context, message: string): Promise<void> {
  const dir = libraryDir(ctx);
  await ensureDir(dir);
  if (!(await exists(path.join(dir, '.git')))) {
    const init = await git(ctx, ['init', '-q']);
    if (init.code !== 0) return;
    await atomicWrite(path.join(dir, '.gitignore'), '.DS_Store\n', 0o644);
  }
  await git(ctx, ['add', '-A']);
  await git(ctx, ['commit', '-q', '-m', message]);
}

export async function libraryLog(ctx: Context, limit = 30): Promise<{ rev: string; date: string; message: string }[]> {
  const r = await git(ctx, ['log', `-${limit}`, '--format=%h%x09%cI%x09%s']);
  if (r.code !== 0) return [];
  return r.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [rev = '', date = '', message = ''] = line.split('\t');
      return { rev, date, message };
    });
}

/** Bring the whole library back to an earlier revision, as a new commit (history is kept). */
export async function restoreLibrary(ctx: Context, rev: string): Promise<void> {
  if (!/^[0-9a-f]{4,40}$/.test(rev)) throw new Error(`"${rev}" is not a revision id.`);
  const r = await git(ctx, ['read-tree', '-u', '--reset', rev]);
  if (r.code !== 0) throw new Error(`Could not restore ${rev}: ${r.stderr.trim()}`);
  await git(ctx, ['commit', '-q', '-m', `restore ${rev}`]);
}
