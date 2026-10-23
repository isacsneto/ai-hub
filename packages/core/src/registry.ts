import path from 'node:path';
import { adapterFor } from './adapters/index.js';
import type { Candidate } from './discover.js';
import { saveHub, timestamp, type Hub, type Profile } from './config.js';
import type { Context } from './context.js';
import { atomicWrite, ensureDir, isDirectory } from './fsx.js';
import { contractHome } from './paths.js';

export function getProfile(hub: Hub, id: string): Profile {
  const p = hub.profiles.find((q) => q.id === id);
  if (!p) {
    const known = hub.profiles.map((q) => q.id).join(', ') || 'none yet: run `aihub import`';
    throw new Error(`No profile "${id}". Known profiles: ${known}`);
  }
  return p;
}

export function profileRoot(ctx: Context, p: Profile): string {
  return adapterFor(p).paths(ctx, p).root;
}

/** Two profiles of the same tool on the same folder would share login, MCP and history. */
function assertIsolated(ctx: Context, hub: Hub, p: Profile): void {
  if (hub.profiles.some((q) => q.id === p.id)) throw new Error(`A profile named "${p.id}" already exists.`);
  const root = profileRoot(ctx, p);
  const clash = hub.profiles.find((q) => q.tool === p.tool && profileRoot(ctx, q) === root);
  if (clash) {
    throw new Error(`${contractHome(root, ctx.home)} already belongs to profile "${clash.id}".`);
  }
}

/**
 * Record a names-only inventory before the hub starts tracking a folder. Phase 1 never writes
 * inside tool folders, so this is the whole "backup": it shows what was there at adoption time.
 */
export async function snapshotInventory(ctx: Context, profiles: Profile[], label: string): Promise<string> {
  const dir = path.join(ctx.hubDir, 'backups', `${timestamp()}-${label}`);
  const rows = [];
  for (const p of profiles) {
    const inv = await adapterFor(p).inventory(ctx, p);
    rows.push({
      id: p.id,
      tool: p.tool,
      root: contractHome(profileRoot(ctx, p), ctx.home),
      skills: inv.skills.map((s) => (s.linkTarget ? `${s.name} -> ${s.linkTarget}` : s.name)),
      skillsDirLinkedTo: inv.skillsDirLinkedTo && contractHome(inv.skillsDirLinkedTo, ctx.home),
      mcpServers: inv.mcpServers,
      historyPresent: inv.historyPresent.map((h) => contractHome(h, ctx.home)),
    });
  }
  await ensureDir(dir);
  await atomicWrite(path.join(dir, 'inventory.json'), JSON.stringify(rows, null, 2) + '\n');
  return dir;
}

/** Register an existing folder where it is. Nothing inside the folder is touched. */
export async function adoptProfile(
  ctx: Context,
  hub: Hub,
  p: Profile,
  opts: { force?: boolean } = {},
): Promise<{ snapshot: string }> {
  assertIsolated(ctx, hub, p);
  const adapter = adapterFor(p);
  const root = profileRoot(ctx, p);
  if (!(await isDirectory(root))) throw new Error(`${contractHome(root, ctx.home)} does not exist.`);
  if (!opts.force && !(await adapter.looksLikeRoot(root))) {
    throw new Error(
      `${contractHome(root, ctx.home)} doesn't look like a ${adapter.displayName} folder. Use --force if you're sure.`,
    );
  }
  const adopted = { ...p, adoptedAt: new Date().toISOString() };
  const snapshot = await snapshotInventory(ctx, [adopted], `adopt-${p.id}`);
  hub.profiles.push(adopted);
  await saveHub(ctx, hub);
  return { snapshot };
}

/** A brand-new isolated profile, with its folder under ~/.aihub/profiles unless one is given. */
export async function createProfile(ctx: Context, hub: Hub, p: Profile): Promise<void> {
  assertIsolated(ctx, hub, p);
  if (p.tool === 'claude-desktop' && p.codeProfile) getProfile(hub, p.codeProfile);
  await ensureDir(profileRoot(ctx, p));
  hub.profiles.push(p);
  await saveHub(ctx, hub);
}

export function newProfileFolder(ctx: Context, id: string): string {
  return contractHome(path.join(ctx.hubDir, 'profiles', id), ctx.home);
}

/** Stop tracking a profile. Its folder and login are left exactly as they are. */
export async function removeProfile(ctx: Context, hub: Hub, id: string) {
  const p = getProfile(hub, id);
  // Dropping a Code-tab link would make that Desktop profile fall back to ~/.claude, so refuse.
  const users = hub.profiles.filter((q) => q.tool === 'claude-desktop' && q.codeProfile === id);
  if (users.length) {
    throw new Error(`${users.map((u) => u.id).join(', ')} use "${id}" for the Code tab. Remove those first.`);
  }
  hub.profiles = hub.profiles.filter((q) => q.id !== id);
  await saveHub(ctx, hub);
  return { root: profileRoot(ctx, p) };
}

/**
 * Register the chosen discovered candidates. A Desktop profile can only come in together with its
 * Code-tab profile; without it, the Code tab would quietly fall back to the default ~/.claude.
 */
export async function applyImport(
  ctx: Context,
  hub: Hub,
  candidates: Candidate[],
  opts: { only?: string[]; skip?: string[] } = {},
): Promise<{ added: Profile[]; snapshot?: string }> {
  const chosen = candidates.filter(
    (c) =>
      c.state === 'new' &&
      (!opts.only?.length || opts.only.includes(c.profile.id)) &&
      !opts.skip?.includes(c.profile.id),
  );
  const ids = new Set([...hub.profiles.map((p) => p.id), ...chosen.map((c) => c.profile.id)]);
  for (const c of chosen) {
    const p = c.profile;
    if (p.tool === 'claude-desktop' && p.codeProfile && !ids.has(p.codeProfile)) {
      throw new Error(`${p.id} needs its Code-tab profile ${p.codeProfile}. Import both, or skip ${p.id}.`);
    }
  }
  if (!chosen.length) return { added: [] };
  const now = new Date().toISOString();
  const added = chosen.map((c) => ({ ...c.profile, adoptedAt: now }));
  const staging: Hub = { ...hub, profiles: [...hub.profiles] };
  for (const p of added) {
    assertIsolated(ctx, staging, p);
    staging.profiles.push(p);
  }
  const snapshot = await snapshotInventory(ctx, added, 'import');
  hub.profiles.push(...added);
  await saveHub(ctx, hub);
  return { added, snapshot };
}
