import path from 'node:path';
import { adapterFor, adapterForTool } from './adapters/index.js';
import type { Identity } from './adapters/types.js';
import type { Hub, Profile, ToolId } from './config.js';
import type { Context } from './context.js';
import { detectGuard } from './discover.js';
import { listEntries, readTextIfExists } from './fsx.js';
import { contractHome, resolvePath } from './paths.js';
import { reconcile } from './share.js';
import { loadState } from './state.js';

export type FindingLevel = 'ok' | 'info' | 'warn' | 'error';
/**
 * isolation: two accounts can see each other's state · untested: we have no evidence for this version
 * unsupported: the tool can't do it · config/state: fix in hub.yaml or the folder · external: owned by another tool
 */
export type FindingKind = 'isolation' | 'untested' | 'unsupported' | 'config' | 'state' | 'external';

export interface Finding {
  level: FindingLevel;
  kind: FindingKind;
  profile?: string;
  tool?: ToolId;
  message: string;
  hint?: string;
}

export interface DoctorReport {
  findings: Finding[];
  versions: Partial<Record<ToolId, string | null>>;
  identities: Record<string, Identity>;
  errors: number;
  warnings: number;
}

/** Numeric comparison of the x.y.z part; pre-release tags are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (v.split('-')[0] ?? '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export const LEAKY_LAUNCHD_VARS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CONFIG_DIR',
  'OPENAI_API_KEY',
  'CODEX_HOME',
];

const loginHint: Record<ToolId, (id: string) => string> = {
  'claude-code': (id) => `aihub run ${id} auth login`,
  codex: (id) => `aihub run ${id} login`,
  'claude-desktop': (id) => `aihub run ${id}`,
  'codex-desktop': (id) => `aihub run ${id}`,
  cursor: (id) => `aihub run ${id}`,
  browser: (id) => `aihub run ${id}`,
};

export async function doctor(ctx: Context, hub: Hub, opts: { only?: string } = {}): Promise<DoctorReport> {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);
  const profiles = opts.only ? hub.profiles.filter((p) => p.id === opts.only) : hub.profiles;
  const rootOf = (p: Profile) => adapterFor(p).paths(ctx, p).root;

  if (!hub.profiles.length) {
    add({ level: 'info', kind: 'config', message: 'No profiles registered yet.', hint: 'aihub import' });
  }

  // Variables set with `launchctl setenv` reach every app opened from Finder/Dock and new Terminal
  // windows, overriding per-profile logins and folders. Only presence is checked, never the value.
  if (ctx.sys.platform === 'darwin') {
    for (const name of LEAKY_LAUNCHD_VARS) {
      const r = await ctx.sys.run('/bin/launchctl', ['getenv', name]);
      if (r.code === 0 && r.stdout.trim()) {
        add({
          level: 'error',
          kind: 'isolation',
          message: `${name} is set for every app via launchd: anything not started through AI-Hub may use that value instead of its profile's own.`,
          hint: `launchctl unsetenv ${name}   (and remove whatever runs \`launchctl setenv ${name}\`)`,
        });
      }
    }
  }

  // Claude Code falls back to the shared Anthropic profile store for config folders without a login.
  if (profiles.some((p) => p.tool === 'claude-code' || p.tool === 'claude-desktop')) {
    const store = path.join(ctx.home, '.config/anthropic');
    const creds = (await listEntries(path.join(store, 'credentials'))).filter((e) => !e.isDir);
    if (creds.length) {
      const active = (await readTextIfExists(path.join(store, 'active_config')))?.trim() || 'default';
      add({
        level: 'warn',
        kind: 'isolation',
        message: `Shared Anthropic profile in ~/.config/anthropic (active: ${active}): Claude profiles that aren't signed in fall back to it instead of failing.`,
        hint: 'Sign every Claude profile in (aihub run <id> auth login), or remove that profile if you no longer use it.',
      });
    }
  }

  if (await detectGuard(ctx)) {
    add({
      level: 'info',
      kind: 'external',
      message: 'claude-account-guard LaunchAgent is installed; it manages ~/.claude-profiles and Claude Profiles apps.',
      hint: 'The hub only reads folders marked managedBy. `aihub takeover` hands them to the hub (reversible with --undo).',
    });
  }

  // Per tool: binary, version vs. tested evidence, global folders.
  const versions: DoctorReport['versions'] = {};
  for (const tool of new Set(profiles.map((p) => p.tool))) {
    const adapter = adapterForTool(tool);
    const version = (await adapter.detectVersion(ctx)) ?? null;
    versions[tool] = version;
    const tested = adapter.tested;
    if (!version) {
      add({ level: 'error', kind: 'state', tool, message: `${adapter.displayName} is not installed or not on PATH.` });
    } else if (!tested.versions.length) {
      add({ level: 'info', kind: 'untested', tool, message: `${adapter.displayName} ${version}: behavior is documented, not version-tested.` });
    } else if (tested.versions.includes(version)) {
      add({ level: 'ok', kind: 'untested', tool, message: `${adapter.displayName} ${version} matches the tested version.` });
    } else {
      const newest = [...tested.versions].sort(compareVersions).at(-1)!;
      const newer = compareVersions(version, newest) > 0;
      add({
        level: newer ? 'warn' : 'info',
        kind: 'untested',
        tool,
        message: `${adapter.displayName} ${version} is ${newer ? 'newer' : 'older'} than the last tested version (${newest}); isolation results may differ.`,
        hint: 'Re-run scripts/phase0-remaining.sh and update packages/core/src/adapters/tested.ts.',
      });
    }
    if (tested.isolatedHistory !== 'tested') {
      add({
        level: 'info',
        kind: 'untested',
        tool,
        message: `${adapter.displayName}: history separation is ${tested.isolatedHistory} (separate folders), not yet checked with two accounts.`,
      });
    }
    for (const g of tested.globalSkillDirs) {
      const entries = await listEntries(resolvePath(g.path, ctx.home));
      if (!entries.length) continue;
      add({
        level: g.evidence === 'tested' ? 'info' : 'warn',
        kind: 'untested',
        tool,
        message: `${g.path} holds ${entries.length} item(s) (${entries.map((e) => e.name).join(', ')}). ${g.note}`,
      });
    }
  }

  // Per profile.
  const identities: Record<string, Identity> = {};
  for (const p of profiles) {
    const adapter = adapterFor(p);
    const paths = adapter.paths(ctx, p);
    const where = contractHome(paths.root, ctx.home);
    const inv = await adapter.inventory(ctx, p);
    if (!inv.rootExists) {
      add({ level: 'error', kind: 'state', profile: p.id, message: `Folder ${where} does not exist.` });
      continue;
    }
    if (p.managedBy) {
      add({ level: 'info', kind: 'external', profile: p.id, message: `Managed by ${p.managedBy}; the hub only reads it.` });
    }
    for (const w of inv.warnings) add({ level: 'warn', kind: 'state', profile: p.id, message: w });

    const id = await adapter.identity(ctx, p);
    identities[p.id] = id;
    if (id.status === 'signed-in') {
      const who = [id.email, id.org && id.org !== id.email ? `(${id.org})` : '', id.detail].filter(Boolean).join(' ');
      add({ level: 'ok', kind: 'state', profile: p.id, message: `Signed in${who ? ': ' + who : ''}.` });
    } else if (id.status === 'signed-out') {
      add({
        level: 'warn',
        kind: 'state',
        profile: p.id,
        message: `Not signed in${id.email ? ` (${id.detail}: ${id.email})` : ''}.`,
        hint: loginHint[p.tool](p.id),
      });
    } else if (id.detail) {
      add({ level: 'info', kind: 'unsupported', profile: p.id, message: `Account not readable from files; ${id.detail}.` });
    }

    if (inv.skillsDirLinkedTo) {
      const owner = hub.profiles.find((q) => q.id !== p.id && path.join(rootOf(q), 'skills') === inv.skillsDirLinkedTo);
      add({
        level: 'warn',
        kind: 'config',
        profile: p.id,
        message: `skills/ is a single link to ${contractHome(inv.skillsDirLinkedTo, ctx.home)}${owner ? ` (${owner.id})` : ''}: all of those skills are shared, all or nothing.`,
        hint: `Pick skills one by one instead: aihub share skill <name> ${p.id} --detach`,
      });
    }
    for (const s of inv.skills.filter((e) => e.broken)) {
      add({ level: 'warn', kind: 'state', profile: p.id, message: `Skill "${s.name}" is a broken link → ${s.linkTarget}.` });
    }
    if (inv.mcpServers.length) {
      add({ level: 'info', kind: 'state', profile: p.id, message: `MCP servers (private): ${inv.mcpServers.join(', ')}.` });
    }

    if (p.sharing || (await loadState(ctx, p.id)).installs.length) {
      const plan = await reconcile(ctx, hub, p, { dryRun: true });
      const of = (st: string) => plan.actions.filter((a) => a.status === st);
      const label = (a: { kind: string; name: string }) => `${a.kind}/${a.name}`;
      if (of('pending').length) {
        add({
          level: 'warn', kind: 'config', profile: p.id,
          message: `${of('pending').length} sharing change(s) not applied yet: ${of('pending').map(label).join(', ')}.`,
          hint: `aihub apply ${p.id}`,
        });
      }
      for (const a of of('conflict')) add({ level: 'warn', kind: 'state', profile: p.id, message: `${label(a)}: ${a.reason}` });
      for (const a of of('blocked')) add({ level: 'info', kind: 'config', profile: p.id, message: `${label(a)}: ${a.reason}` });
      for (const a of of('unsupported')) add({ level: 'info', kind: 'unsupported', profile: p.id, message: `${label(a)}: ${a.reason}` });
      if (plan.actions.length && plan.actions.every((a) => a.status === 'ok')) {
        add({ level: 'ok', kind: 'config', profile: p.id, message: `All ${plan.actions.length} shared item(s) in place.` });
      }
    }

    if (p.tool === 'claude-desktop' && !paths.isDefault && !p.codeProfile) {
      add({
        level: 'warn',
        kind: 'isolation',
        profile: p.id,
        message: 'No codeProfile: its Code tab uses your default ~/.claude (that login, MCP servers and history).',
        hint: `Set codeProfile for ${p.id} in hub.yaml.`,
      });
    }
  }

  // Across profiles.
  for (let i = 0; i < hub.profiles.length; i++) {
    for (let j = i + 1; j < hub.profiles.length; j++) {
      const [a, b] = [hub.profiles[i]!, hub.profiles[j]!];
      if (opts.only && a.id !== opts.only && b.id !== opts.only) continue;
      if (a.tool === b.tool && rootOf(a) === rootOf(b)) {
        add({
          level: 'error',
          kind: 'isolation',
          message: `${a.id} and ${b.id} use the same folder ${contractHome(rootOf(a), ctx.home)}: same login, MCP and history.`,
          hint: 'Remove one of them with `aihub profile remove`.',
        });
      }
      if (a.tool === 'claude-desktop' && b.tool === 'claude-desktop' && a.codeProfile && a.codeProfile === b.codeProfile) {
        add({
          level: 'warn',
          kind: 'isolation',
          message: `${a.id} and ${b.id} share the Code-tab profile ${a.codeProfile}.`,
        });
      }
      const [ia, ib] = [identities[a.id], identities[b.id]];
      if (a.tool === b.tool && ia?.status === 'signed-in' && ib?.status === 'signed-in' && ia.email && ia.email === ib.email) {
        add({ level: 'info', kind: 'state', message: `${a.id} and ${b.id} are both signed in as ${ia.email}.` });
      }
    }
  }

  return {
    findings,
    versions,
    identities,
    errors: findings.filter((f) => f.level === 'error').length,
    warnings: findings.filter((f) => f.level === 'warn').length,
  };
}
