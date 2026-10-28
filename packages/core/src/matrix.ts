import { adapterFor, TESTED, usesGlobalDirs } from './adapters/index.js';
import type { Hub } from './config.js';
import type { Context } from './context.js';
import { listEntries } from './fsx.js';
import { listLibrary, loadCatalog, loadSharedSettings, type ShareKind } from './library.js';
import { contractHome, resolvePath } from './paths.js';
import { previewPluginMcp, type McpPreview } from './plugins.js';
import { reconcile, type ActionStatus } from './share.js';
import { profilesSharing } from './sharing-config.js';

export interface MatrixRow {
  kind: ShareKind;
  name: string;
  description?: string;
  mcp?: McpPreview;
}

export interface MatrixCell {
  shared: boolean;
  supported: boolean;
  /** Why it's unsupported, blocked or in conflict. */
  reason?: string;
  status?: ActionStatus;
}

export interface SharingMatrix {
  rows: MatrixRow[];
  profiles: { id: string; label: string; tool: string }[];
  /** cells[profileId]["kind/name"] */
  cells: Record<string, Record<string, MatrixCell>>;
  /** Folders a tool reads for every profile: anything in them is shared with everyone. */
  everyone: { tool: string; path: string; entries: string[]; note: string }[];
}

/** Everything the sharing grid needs, computed with dry-run plans (nothing is changed). */
export async function sharingMatrix(ctx: Context, hub: Hub): Promise<SharingMatrix> {
  const rows: MatrixRow[] = (await listLibrary(ctx)).map((i) => ({ kind: i.kind, name: i.name, description: i.description }));
  for (const pl of await loadCatalog(ctx)) rows.push({ kind: 'plugins', name: pl.id, description: pl.source, mcp: await previewPluginMcp(ctx, hub, pl) });
  for (const [key, value] of Object.entries(await loadSharedSettings(ctx))) {
    rows.push({ kind: 'settings', name: key, description: JSON.stringify(value).slice(0, 80) });
  }

  const cells: SharingMatrix['cells'] = {};
  for (const p of hub.profiles) {
    const adapter = adapterFor(p);
    const plan = await reconcile(ctx, hub, p, { dryRun: true });
    const row: Record<string, MatrixCell> = {};
    for (const r of rows) {
      const target = adapter.shareTarget?.(ctx, p, r.kind, r.name);
      const supported = !!target && target.strategy !== 'unsupported';
      const action = plan.actions.find(
        (a) => a.kind === r.kind && (a.name === r.name || (r.kind === 'instructions' && a.name.split(', ').includes(r.name))),
      );
      row[`${r.kind}/${r.name}`] = {
        shared: (await profilesSharing(ctx, hub, r.kind, r.name)).includes(p.id),
        supported,
        reason: !supported
          ? target?.strategy === 'unsupported' ? target.reason : `${adapter.displayName} keeps these in the app or account`
          : action?.reason,
        status: action?.status,
      };
    }
    cells[p.id] = row;
  }

  const everyone: SharingMatrix['everyone'] = [];
  for (const tool of new Set(hub.profiles.filter(usesGlobalDirs).map((p) => p.tool))) {
    for (const g of TESTED[tool].globalSkillDirs) {
      const entries = (await listEntries(resolvePath(g.path, ctx.home))).map((e) => e.name);
      if (entries.length) everyone.push({ tool, path: contractHome(resolvePath(g.path, ctx.home), ctx.home), entries, note: g.note });
    }
  }

  return { rows, profiles: hub.profiles.map((p) => ({ id: p.id, label: p.label, tool: p.tool })), cells, everyone };
}
