import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { adapterFor } from './adapters/index.js';
import type { ShareTarget } from './adapters/types.js';
import type { Hub, Profile } from './config.js';
import type { Context } from './context.js';
import { exists, readJsonIfExists, readTextIfExists, symlinkTargetOf } from './fsx.js';
import {
  ITEM_KINDS,
  hashPath,
  libraryDir,
  listLibrary,
  loadCatalog,
  loadSharedSettings,
  mainFile,
  SHAREABLE_SETTINGS,
  type LibraryItem,
  type PluginEntry,
  type ShareKind,
} from './library.js';
import { withHubLock } from './lock.js';
import { previewPluginMcp } from './plugins.js';
import { loadState, recordKey, saveState, stateFile, type InstallRecord } from './state.js';
import { plural } from './text.js';
import { withTransaction, type Transaction } from './tx.js';

export type ActionType =
  | 'link'
  | 'copy'
  | 'update-copy'
  | 'remove'
  | 'write-block'
  | 'write-settings'
  | 'install-plugin'
  | 'uninstall-plugin'
  | 'detach-folder'
  | 'adopt'
  | 'forget';

/** pending → will change · done → changed now · ok → already right · blocked → needs a flag/approval */
export type ActionStatus = 'pending' | 'done' | 'ok' | 'blocked' | 'conflict' | 'unsupported' | 'failed';

export interface Action {
  type: ActionType;
  kind: ShareKind;
  name: string;
  path?: string;
  status: ActionStatus;
  reason?: string;
}

export interface Plan {
  profile: string;
  actions: Action[];
}

export interface ReconcileOptions {
  dryRun?: boolean;
  /** Overwrite conflicting copies/settings and write into folders managed by another tool. */
  force?: boolean;
  /** Replace a whole-folder symlink (cpm's share = ["skills"]) with per-item links. */
  detach?: boolean;
}

/** An action plus how to perform it and how the install records change once it succeeds. */
interface Step extends Action {
  /** File changes, run inside one transaction. */
  run?: (tx: Transaction) => Promise<void>;
  /** Tool commands (plugins), run after the transaction; can't be rolled back, so they go last. */
  external?: () => Promise<void>;
  /** Set (record) or drop (null) this item's record. */
  record?: InstallRecord | null;
  /** Replace every record of `kind` for `file` (instruction blocks, settings keys). */
  replaceRecords?: { kind: ShareKind; file: string; records: InstallRecord[] };
}

const BEGIN = '<!-- aihub:begin: managed by AI-Hub, change with `aihub share`/`aihub unshare` -->';
const END = '<!-- aihub:end -->';

/**
 * Why the file's managed block can't be safely rewritten, if it can't: markers must come as exactly
 * one begin followed by one end, or none at all. Anything else would make a rewrite eat user text.
 */
export function blockProblem(text: string): string | undefined {
  const begins = text.split(BEGIN).length - 1;
  const ends = text.split(END).length - 1;
  if (begins === 0 && ends === 0) return undefined;
  if (begins === 1 && ends === 1 && text.indexOf(BEGIN) < text.indexOf(END)) return undefined;
  return 'its AI-Hub block markers are missing, repeated or out of order; fix or delete the block by hand, then apply again';
}

/** Replace, add or drop the hub's managed block, leaving the rest of the file as it is. */
export function replaceBlock(text: string, body: string | undefined): string {
  const start = text.indexOf(BEGIN);
  const end = start === -1 ? -1 : text.indexOf(END, start);
  const block = body === undefined ? '' : `${BEGIN}\n${body}\n${END}\n`;
  if (end !== -1) {
    const before = text.slice(0, start);
    const after = text.slice(end + END.length).replace(/^\n/, '');
    if (block) return before + block + after;
    const joined = before.replace(/\n+$/, '') + (before && after ? '\n\n' : '') + after;
    return joined.trim() ? joined.replace(/\n*$/, '\n') : '';
  }
  if (!block) return text;
  return text.trim() ? `${text.replace(/\n*$/, '\n\n')}${block}` : block;
}

/** The managed block (markers included) as it is in the file, if there is one. */
function blockText(text: string): string | undefined {
  const start = text.indexOf(BEGIN);
  const end = start === -1 ? -1 : text.indexOf(END, start);
  return end === -1 ? undefined : text.slice(start, end + END.length);
}

const textHash = (s: string) => createHash('sha256').update(s).digest('hex');
const valueHash = (v: unknown) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex');
const now = () => new Date().toISOString();

const isLinkedFolder = async (dir: string) => (await symlinkTargetOf(dir)) !== undefined;

/** Files the hub rewrites must be real files: writing would turn a link (into dotfiles, say) into a copy. */
async function linkedFileReason(file: string): Promise<string | undefined> {
  const to = await symlinkTargetOf(file);
  return to ? `${path.basename(file)} is a link to ${to}; the hub won't replace it with a file (make it a regular file to share here)` : undefined;
}

/** Whether an install record points inside the profile; anything else (a stale or edited record) is never touched. */
const insideProfile = (ctx: Context, p: Profile, file: string) => {
  const root = adapterFor(p).paths(ctx, p).root;
  return path.resolve(file).startsWith(root + path.sep);
};

/**
 * Make a profile's folder match its `sharing` choices. Plans first; unless dryRun, applies the plan
 * in a transaction. Only things recorded in the hub's state are ever removed or replaced.
 */
export async function reconcile(ctx: Context, hub: Hub, p: Profile, opts: ReconcileOptions = {}): Promise<Plan> {
  // Plan and apply under one lock, so a second change can't act on a plan made before the first applied.
  return opts.dryRun ? reconcileUnlocked(ctx, hub, p, opts) : withHubLock(ctx, () => reconcileUnlocked(ctx, hub, p, opts));
}

async function reconcileUnlocked(ctx: Context, hub: Hub, p: Profile, opts: ReconcileOptions): Promise<Plan> {
  const adapter = adapterFor(p);
  const sharing = p.sharing ?? {};
  const state = await loadState(ctx, p.id);
  const records = new Map(state.installs.map((r) => [recordKey(r), r]));
  const library = await listLibrary(ctx);
  const lib = new Map(library.map((i) => [`${i.kind}/${i.name}`, i]));
  const steps: Step[] = [];
  const wantedKeys = new Set<string>();

  const target = (kind: ShareKind, name: string): ShareTarget =>
    adapter.shareTarget?.(ctx, p, kind, name) ?? {
      strategy: 'unsupported',
      reason: `${adapter.displayName} keeps these on the account or in the app, not in files`,
    };
  const unsupported = (kind: ShareKind, name: string, t: ShareTarget): Step => ({
    type: 'link', kind, name, status: 'unsupported', reason: t.strategy === 'unsupported' ? t.reason : 'unsupported',
  });

  // ---- skills, agents, commands: links or managed copies ----
  for (const kind of ['skills', 'agents', 'commands'] as const) {
    const list = sharing[kind];
    const explicit = list !== 'all';
    const names = list === 'all' ? library.filter((i) => i.kind === kind).map((i) => i.name) : (list ?? []);
    for (const name of names) {
      wantedKeys.add(`${kind}/${name}`);
      const t = target(kind, name);
      const item = lib.get(`${kind}/${name}`);
      if (t.strategy === 'unsupported') {
        if (explicit) steps.push(unsupported(kind, name, t));
      } else if (!item) {
        steps.push({ type: 'link', kind, name, status: 'conflict', reason: 'not in the library' });
      } else if (t.strategy === 'symlink') {
        steps.push(await planLink(item, t.path, records.get(`${kind}/${name}`)));
      } else if (t.strategy === 'copy') {
        steps.push(await planCopy(item, t.path, records.get(`${kind}/${name}`), opts));
      }
    }
  }

  // ---- instructions: one managed block per file ----
  const blocks = new Map<string, { style: 'import' | 'inline'; items: LibraryItem[] }>();
  for (const name of sharing.instructions ?? []) {
    wantedKeys.add(`instructions/${name}`);
    const t = target('instructions', name);
    const item = lib.get(`instructions/${name}`);
    if (t.strategy !== 'block') steps.push({ ...unsupported('instructions', name, t), type: 'write-block' });
    else if (!item) steps.push({ type: 'write-block', kind: 'instructions', name, status: 'conflict', reason: 'not in the library' });
    else {
      const b = blocks.get(t.path) ?? { style: t.style, items: [] };
      b.items.push(item);
      blocks.set(t.path, b);
    }
  }
  for (const r of state.installs) {
    if (r.kind === 'instructions' && !blocks.has(r.path)) blocks.set(r.path, { style: 'import', items: [] });
  }
  for (const [file, { style, items }] of blocks) {
    const prior = state.installs.filter((r) => r.kind === 'instructions' && r.path === file);
    steps.push(insideProfile(ctx, p, file) ? await planBlock(file, style, items, prior, opts) : { type: 'forget', kind: 'instructions', name: '(block)', path: file, status: 'pending', reason: 'recorded outside the profile; left alone', replaceRecords: { kind: 'instructions', file, records: [] }, run: async () => {} });
  }

  // ---- settings.json keys ----
  const keys = sharing.settings ?? [];
  const priorKeys = state.installs.filter((r) => r.kind === 'settings');
  if (keys.length || priorKeys.length) {
    keys.forEach((k) => wantedKeys.add(`settings/${k}`));
    const t = target('settings', keys[0] ?? priorKeys[0]!.name);
    if (t.strategy === 'json-key') steps.push(...(await planSettings(t.path, keys, await loadSharedSettings(ctx), priorKeys, opts)));
    else for (const k of keys) steps.push({ ...unsupported('settings', k, t), type: 'write-settings' });
  }

  // ---- plugins: shared catalog, each profile installs its own copy ----
  const catalog = await loadCatalog(ctx);
  for (const id of sharing.plugins ?? []) {
    wantedKeys.add(`plugins/${id}`);
    const t = target('plugins', id);
    const entry = catalog.find((e) => e.id === id);
    if (t.strategy !== 'plugin-cli' || !adapter.plugins) steps.push({ ...unsupported('plugins', id, t), type: 'install-plugin' });
    else if (!entry) steps.push({ type: 'install-plugin', kind: 'plugins', name: id, status: 'conflict', reason: 'not in the library catalog' });
    else steps.push(await planPlugin(ctx, hub, p, entry, records.get(`plugins/${id}`)));
  }

  // ---- recorded items that are no longer wanted ----
  for (const r of state.installs) {
    if (wantedKeys.has(recordKey(r)) || r.kind === 'instructions' || r.kind === 'settings') continue;
    steps.push(r.kind === 'plugins' ? planPluginRemoval(ctx, p, r) : await planRemoval(ctx, p, r, opts));
  }

  // ---- a folder that is one big symlink (cpm) has to become a real folder first ----
  const linked = new Map<string, string>();
  for (const s of steps) {
    if (s.status !== 'pending' || !s.path || !['link', 'copy', 'update-copy'].includes(s.type)) continue;
    const dir = path.dirname(s.path);
    const to = await symlinkTargetOf(dir);
    if (to) linked.set(dir, to);
  }
  for (const [dir, to] of linked) {
    const visible = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => !n.startsWith('.'));
    if (opts.detach) {
      steps.unshift({
        type: 'detach-folder', kind: 'skills', name: path.basename(dir), path: dir, status: 'pending',
        reason: `replaces the link to ${to}; stops showing: ${visible.join(', ') || 'nothing'}`,
        run: async (tx) => {
          await tx.remove(dir); // moves only the link into the journal; its target is untouched
          await tx.mkdirp(dir);
        },
      });
      continue;
    }
    for (const s of steps) {
      if (s.status === 'pending' && s.path && path.dirname(s.path) === dir) {
        s.status = 'blocked';
        s.reason = `${path.basename(dir)}/ is one link to ${to}; --detach switches it to per-item links (the ${plural(visible.length, 'item')} now visible through it would stop showing)`;
      }
    }
  }

  // ---- folders owned by another tool are read-only unless forced ----
  if (p.managedBy && !opts.force) {
    for (const s of steps) {
      if (s.status !== 'pending') continue;
      s.status = 'blocked';
      s.reason = `managed by ${p.managedBy}; run \`aihub takeover\` or pass --force`;
    }
  }

  if (!opts.dryRun) await execute(ctx, p, steps, state.installs);
  return { profile: p.id, actions: steps.map(({ run: _r, external: _e, record: _rec, replaceRecords: _rr, ...a }) => a) };
}

async function planLink(item: LibraryItem, at: string, rec: InstallRecord | undefined): Promise<Step> {
  const base = { kind: item.kind, name: item.name, path: at };
  const record: InstallRecord = { kind: item.kind, name: item.name, strategy: 'symlink', path: at, installedAt: rec?.installedAt ?? now() };
  // Inside a whole-folder link, what we'd see belongs to the other folder; plan as a fresh install.
  const st = (await isLinkedFolder(path.dirname(at))) ? undefined : await fs.lstat(at).catch(() => undefined);
  if (!st) {
    return { ...base, type: 'link', status: 'pending', reason: rec ? 'link was missing; re-creating' : undefined, record, run: (tx) => tx.symlink(item.path, at) };
  }
  if (st.isSymbolicLink() && path.resolve(path.dirname(at), await fs.readlink(at)) === item.path) {
    return rec ? { ...base, type: 'link', status: 'ok' } : { ...base, type: 'adopt', status: 'pending', record, run: async () => {} };
  }
  return { ...base, type: 'link', status: 'conflict', reason: `${path.basename(at)} already exists there and isn't the library's; left alone` };
}

async function planCopy(item: LibraryItem, at: string, rec: InstallRecord | undefined, opts: ReconcileOptions): Promise<Step> {
  const base = { kind: item.kind, name: item.name, path: at };
  const record: InstallRecord = { kind: item.kind, name: item.name, strategy: 'copy', path: at, hash: item.hash, installedAt: now() };
  if ((await isLinkedFolder(path.dirname(at))) || !(await exists(at))) {
    return { ...base, type: 'copy', status: 'pending', reason: rec ? 'copy was missing; re-copying' : undefined, record, run: (tx) => tx.copy(item.path, at) };
  }
  const local = await hashPath(at);
  if (local === item.hash) {
    return rec?.hash === item.hash ? { ...base, type: 'copy', status: 'ok' } : { ...base, type: 'adopt', status: 'pending', record, run: async () => {} };
  }
  const replace = async (tx: Transaction) => {
    await tx.remove(at);
    await tx.copy(item.path, at);
  };
  if (rec && local === rec.hash) return { ...base, type: 'update-copy', status: 'pending', reason: 'library version changed', record, run: replace };
  if (rec && opts.force) {
    return { ...base, type: 'update-copy', status: 'pending', reason: 'overwriting changes made in the profile (--force; old copy kept in the journal)', record, run: replace };
  }
  return {
    ...base, type: 'copy', status: 'conflict',
    reason: rec ? 'changed inside the profile since it was copied; left alone (--force overwrites)' : `${path.basename(at)} already exists there and isn't from the library; left alone`,
  };
}

async function planRemoval(ctx: Context, p: Profile, r: InstallRecord, opts: ReconcileOptions): Promise<Step> {
  const base = { type: 'remove' as const, kind: r.kind, name: r.name, path: r.path };
  const forget = (reason: string): Step => ({ ...base, type: 'forget', status: 'pending', reason, record: null, run: async () => {} });
  if (!insideProfile(ctx, p, r.path)) return forget('recorded outside the profile folder; left alone');
  // Never reach through a whole-folder link into another profile's folder.
  if (await isLinkedFolder(path.dirname(r.path))) return forget('its folder is now a link to elsewhere; left alone');
  const st = await fs.lstat(r.path).catch(() => undefined);
  if (!st) return forget('already gone');
  if (r.strategy === 'symlink') {
    const to = st.isSymbolicLink() ? path.resolve(path.dirname(r.path), await fs.readlink(r.path)) : '';
    if (to.startsWith(libraryDir(ctx) + path.sep)) return { ...base, status: 'pending', record: null, run: (tx) => tx.remove(r.path) };
    return forget('replaced by something else; left alone');
  }
  if (r.strategy === 'copy') {
    if (opts.force || (await hashPath(r.path)) === r.hash) return { ...base, status: 'pending', record: null, run: (tx) => tx.remove(r.path) };
    return { ...base, status: 'conflict', reason: 'changed inside the profile; left alone (--force removes it, keeping a copy in the journal)' };
  }
  return forget('not a file the hub placed');
}

async function planBlock(
  file: string,
  style: 'import' | 'inline',
  items: LibraryItem[],
  prior: InstallRecord[],
  opts: ReconcileOptions,
): Promise<Step> {
  const name = items.map((i) => i.name).join(', ') || '(removing block)';
  const text = (await readTextIfExists(file)) ?? '';
  const problem = (await linkedFileReason(file)) ?? blockProblem(text);
  if (problem) return { type: 'write-block', kind: 'instructions', name, path: file, status: 'conflict', reason: problem };
  let body: string | undefined;
  if (items.length && style === 'import') body = items.map((i) => `@${mainFile(i)}`).join('\n');
  else if (items.length) {
    const parts: string[] = [];
    for (const i of items) parts.push(`<!-- aihub:item ${i.name} -->\n${((await readTextIfExists(mainFile(i))) ?? '').trim()}`);
    body = parts.join('\n\n');
  }
  const next = replaceBlock(text, body);
  // Text typed inside the block (an inline AGENTS.md copy is easy to edit in place) would be lost on rewrite.
  // Records from before blockHash existed can't tell, so those blocks are rewritten as before.
  const current = blockText(text);
  const wrote = prior.find((r) => r.blockHash)?.blockHash;
  const edited = next !== text && current !== undefined && wrote !== undefined && textHash(current) !== wrote;
  if (edited && !opts.force) {
    return {
      type: 'write-block', kind: 'instructions', name, path: file, status: 'conflict',
      reason: 'the AI-Hub block was edited by hand since the hub wrote it; left alone (move your changes out of the block or into the library, or --force overwrites; the old file is kept in the journal)',
    };
  }
  const nextBlock = blockText(next);
  return {
    type: 'write-block', kind: 'instructions', name, path: file,
    status: next === text ? 'ok' : 'pending',
    ...(edited ? { reason: 'overwriting changes made inside the block (--force; old file kept in the journal)' } : {}),
    run: (tx) => tx.write(file, next),
    replaceRecords: {
      kind: 'instructions', file,
      records: items.map((i) => ({
        kind: 'instructions', name: i.name, strategy: 'block', path: file, hash: i.hash,
        ...(nextBlock ? { blockHash: textHash(nextBlock) } : {}),
        installedAt: now(),
      })),
    },
  };
}

async function planSettings(
  file: string,
  keys: string[],
  shared: Record<string, unknown>,
  prior: InstallRecord[],
  opts: ReconcileOptions,
): Promise<Step[]> {
  const base = (name: string) => ({ type: 'write-settings' as const, kind: 'settings' as const, name, path: file });
  const linked = await linkedFileReason(file);
  if (linked) return keys.map((k) => ({ ...base(k), status: 'conflict', reason: linked }));
  let current: Record<string, unknown>;
  try {
    current = ((await readJsonIfExists(file)) as Record<string, unknown> | undefined) ?? {};
  } catch (err) {
    return keys.map((k) => ({ ...base(k), status: 'conflict', reason: (err as Error).message }));
  }
  const next = { ...current };
  const steps: Step[] = [];
  const keep: InstallRecord[] = [];
  for (const key of keys) {
    const rec = prior.find((r) => r.name === key);
    // The allowlist is enforced here too: library/settings.json can be hand-edited or restored.
    if (!(SHAREABLE_SETTINGS as readonly string[]).includes(key)) {
      steps.push({ ...base(key), status: 'conflict', reason: `"${key}" isn't a shareable setting` });
      if (rec) keep.push(rec);
      continue;
    }
    if (!Object.hasOwn(shared, key)) {
      steps.push({ ...base(key), status: 'conflict', reason: 'not set in the library (`aihub setting set`)' });
      if (rec) keep.push(rec);
      continue;
    }
    const record: InstallRecord = { kind: 'settings', name: key, strategy: 'json-key', path: file, hash: valueHash(shared[key]), installedAt: now() };
    const has = Object.hasOwn(current, key);
    if (has && valueHash(current[key]) === record.hash) {
      steps.push(rec ? { ...base(key), status: 'ok' } : { ...base(key), type: 'adopt', status: 'pending' });
      keep.push(record);
    } else if (has && !(rec && valueHash(current[key]) === rec.hash) && !opts.force) {
      steps.push({ ...base(key), status: 'conflict', reason: 'the profile sets its own value; left alone (--force overwrites)' });
      if (rec) keep.push(rec);
    } else {
      next[key] = shared[key];
      keep.push(record);
      steps.push({ ...base(key), status: 'pending' });
    }
  }
  for (const r of prior.filter((r) => !keys.includes(r.name))) {
    if (Object.hasOwn(current, r.name) && valueHash(current[r.name]) === r.hash) {
      delete next[r.name];
      steps.push({ ...base(r.name), status: 'pending', reason: 'no longer shared: removing the key' });
    } else {
      steps.push({ ...base(r.name), type: 'forget', status: 'pending', reason: 'changed in the profile since; left alone' });
    }
  }
  const pending = steps.filter((s) => s.status === 'pending');
  for (const s of pending) s.run = async () => {};
  if (pending[0]) {
    const changed = JSON.stringify(next) !== JSON.stringify(current);
    if (changed) pending[0].run = (tx) => tx.write(file, JSON.stringify(next, null, 2) + '\n');
    pending[0].replaceRecords = { kind: 'settings', file, records: keep };
  }
  return steps;
}

async function planPlugin(ctx: Context, hub: Hub, p: Profile, entry: PluginEntry, rec: InstallRecord | undefined): Promise<Step> {
  const adapter = adapterFor(p);
  const base = { kind: 'plugins' as const, name: entry.id, path: adapter.paths(ctx, p).root };
  if (await adapter.plugins!.isInstalled(ctx, p, entry.id)) {
    if (rec) return { ...base, type: 'install-plugin', status: 'ok' };
    // Installed before the hub knew about it: track it, but never uninstall it on unshare.
    const record: InstallRecord = { kind: 'plugins', name: entry.id, strategy: 'plugin-cli', path: base.path, hash: 'preexisting', installedAt: now() };
    return { ...base, type: 'adopt', status: 'pending', record, run: async () => {} };
  }
  const mcp = await previewPluginMcp(ctx, hub, entry);
  if (!p.sharing?.allowMcp?.includes(entry.id) && (mcp.servers.length || !mcp.known)) {
    const what = mcp.servers.length ? `adds MCP servers: ${mcp.servers.join(', ')}` : "its MCP servers can't be checked offline (remote source)";
    return { ...base, type: 'install-plugin', status: 'blocked', reason: `${what}; approve with --allow-mcp` };
  }
  return {
    ...base, type: 'install-plugin', status: 'pending',
    reason: mcp.servers.length ? `approved MCP servers: ${mcp.servers.join(', ')}` : undefined,
    record: { kind: 'plugins', name: entry.id, strategy: 'plugin-cli', path: base.path, installedAt: now() },
    external: () => runPluginCommands(ctx, hub, p, entry, 'install'),
  };
}

function planPluginRemoval(ctx: Context, p: Profile, r: InstallRecord): Step {
  const base = { kind: 'plugins' as const, name: r.name, path: r.path };
  if (r.hash === 'preexisting') {
    return { ...base, type: 'forget', status: 'pending', reason: 'was installed before the hub; left installed', record: null, run: async () => {} };
  }
  return {
    ...base, type: 'uninstall-plugin', status: 'pending', record: null,
    external: () => runPluginCommands(ctx, { version: 1, profiles: [p] }, p, { id: r.name }, 'uninstall'),
  };
}

async function runPluginCommands(ctx: Context, hub: Hub, p: Profile, entry: PluginEntry, action: 'install' | 'uninstall') {
  const adapter = adapterFor(p);
  const spec = await adapter.launchSpec(ctx, hub, p, []);
  for (const args of await adapter.plugins!.commands(ctx, p, entry, action)) {
    const r = await ctx.sys.run(spec.command, args, { env: spec.env, timeoutMs: 180_000 });
    if (r.code !== 0) {
      throw new Error(`\`${path.basename(spec.command)} ${args.join(' ')}\` failed: ${(r.stderr || r.stdout).trim().split('\n').at(-1) ?? ''}`);
    }
  }
}

async function execute(ctx: Context, p: Profile, steps: Step[], installs: InstallRecord[]): Promise<void> {
  const map = new Map(installs.map((r) => [recordKey(r), r]));
  const commitRecords = (s: Step) => {
    if (s.record === null) map.delete(recordKey(s));
    else if (s.record) map.set(recordKey(s.record), s.record);
    if (s.replaceRecords) {
      const { kind, file, records } = s.replaceRecords;
      for (const [k, r] of map) if (r.kind === kind && r.path === file) map.delete(k);
      for (const r of records) map.set(recordKey(r), r);
    }
  };
  const fileSteps = steps.filter((s) => s.status === 'pending' && s.run);
  if (fileSteps.length) {
    await withTransaction(ctx, `apply-${p.id}`, async (tx) => {
      for (const s of fileSteps) await s.run!(tx);
      for (const s of fileSteps) commitRecords(s);
      // Records are part of the transaction, so rollback and `aihub undo` restore them too.
      await tx.write(stateFile(ctx, p.id), JSON.stringify({ version: 1, installs: [...map.values()] }, null, 2) + '\n', { records: true });
    });
    for (const s of fileSteps) s.status = 'done';
  }
  // Already-correct blocks still refresh their records (e.g. after state was lost).
  for (const s of steps) if (s.status === 'ok' && s.replaceRecords) commitRecords(s);
  for (const s of steps.filter((s) => s.status === 'pending' && s.external)) {
    try {
      await s.external!();
      s.status = 'done';
      commitRecords(s);
    } catch (err) {
      s.status = 'failed';
      s.reason = (err as Error).message;
    }
  }
  await saveState(ctx, p.id, { version: 1, installs: [...map.values()] });
}

/** Reconcile every profile. Profiles that fail don't stop the others. */
export async function reconcileAll(ctx: Context, hub: Hub, opts: ReconcileOptions = {}) {
  const out: (Plan & { error?: string })[] = [];
  for (const p of hub.profiles) {
    try {
      out.push(await reconcile(ctx, hub, p, opts));
    } catch (err) {
      out.push({ profile: p.id, actions: [], error: (err as Error).message });
    }
  }
  return out;
}

export { ITEM_KINDS };
