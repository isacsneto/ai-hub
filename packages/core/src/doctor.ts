import path from 'node:path';
import { adapterFor, adapterForTool, usesGlobalDirs } from './adapters/index.js';
import type { Identity } from './adapters/types.js';
import type { Hub, Profile, ToolId } from './config.js';
import type { Context } from './context.js';
import { detectGuard } from './discover.js';
import { exists, listEntries, readJsonIfExists, readTextIfExists } from './fsx.js';
import { contractHome, resolvePath } from './paths.js';
import { reconcile } from './share.js';
import { loadState } from './state.js';
import { plural } from './text.js';
import { PROBED_TOOLS, verifiedOnThisMac } from './verify.js';

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

const major = (v: string) => v.split('.')[0];

/** The command a version check runs: the CLI itself, or the Codex CLI bundled in the ChatGPT/Codex app. */
async function probeBinary(ctx: Context, tool: ToolId, profile: Profile): Promise<string | undefined> {
  if (tool === 'codex-desktop') {
    const app = await adapterForTool(tool).findBinary(ctx, profile as never);
    const bundled = app && path.join(app, 'Contents/Resources/codex-cli/bin/codex');
    return bundled && (await exists(bundled)) ? bundled : undefined;
  }
  return adapterForTool(tool).findBinary(ctx, profile as never);
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

  // Claude Code falls back to the `ant` CLI's login (~/.config/anthropic) for config folders without
  // their own. Harmless while every Claude profile is signed in; a profile that signs out would
  // quietly run on that account instead of asking to log in.
  if (profiles.some((p) => p.tool === 'claude-code' || p.tool === 'claude-desktop')) {
    const store = path.join(ctx.home, '.config/anthropic');
    const creds = (await listEntries(path.join(store, 'credentials'))).filter((e) => !e.isDir);
    if (creds.length) {
      const active = (await readTextIfExists(path.join(store, 'active_config')))?.trim() || 'default';
      // Only the non-secret fields: whose login it is and until when.
      const cred = (await readJsonIfExists(path.join(store, 'credentials', `${active}.json`)).catch(() => undefined)) as
        | { account_email?: unknown; expires_at?: unknown }
        | undefined;
      const email = typeof cred?.account_email === 'string' ? cred.account_email : undefined;
      const expired = typeof cred?.expires_at === 'number' && cred.expires_at * 1000 < Date.now();
      const signedOut: string[] = [];
      for (const p of profiles.filter((q) => q.tool === 'claude-code')) {
        if ((await adapterFor(p).identity(ctx, p)).status === 'signed-out') signedOut.push(p.label);
      }
      const about = [email, active !== 'default' && `profile "${active}"`, expired && 'expired'].filter(Boolean).join(', ');
      const who = `the \`ant\` CLI's login${about ? ` (${about})` : ''} in ~/.config/anthropic`;
      add(
        signedOut.length
          ? {
              level: 'warn',
              kind: 'isolation',
              message: `${signedOut.join(', ')} ${signedOut.length === 1 ? 'is' : 'are'} not signed in, so Claude Code falls back to ${who} instead of asking you to log in.`,
              hint: 'Sign those profiles in (Open in Terminal, then /login), or run `ant auth logout` if you no longer use the ant CLI.',
            }
          : {
              level: 'info',
              kind: 'isolation',
              message: `Claude Code would fall back to ${who} for a profile that isn't signed in. All your Claude Code profiles are signed in, so none does.`,
              hint: "If you don't use the ant CLI, `ant auth logout` removes this fallback.",
            },
      );
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
  // Profiles can point at another app copy (`app`) or browser, so versions are checked per variant.
  const variants = new Map<string, { tool: ToolId; profile: Profile; name: string }>();
  for (const p of profiles) {
    const which = 'browser' in p ? p.browser : 'app' in p && p.app ? path.basename(p.app, '.app') : '';
    const key = `${p.tool}|${which}`;
    if (!variants.has(key)) variants.set(key, { tool: p.tool, profile: p, name: adapterForTool(p.tool).displayName + (which ? ` (${which})` : '') });
  }
  for (const { tool, profile, name } of variants.values()) {
    const adapter = adapterForTool(tool);
    const version = (await adapter.detectVersion(ctx, profile as never)) ?? null;
    versions[tool] ??= version;
    const tested = adapter.tested;
    if (!version) {
      add({ level: 'error', kind: 'state', tool, message: `${name} is not installed or not on PATH.` });
    } else if (!tested.versions.length) {
      add({ level: 'info', kind: 'untested', tool, message: `${name} ${version}: behavior is documented, not version-tested.` });
    } else if (tested.versions.includes(version)) {
      add({ level: 'ok', kind: 'untested', tool, message: `${name} ${version} matches the tested version.` });
    } else {
      const newest = [...tested.versions].sort(compareVersions).at(-1)!;
      if (compareVersions(version, newest) < 0) {
        add({ level: 'info', kind: 'untested', tool, message: `${name} ${version} is older than the last tested version (${newest}).` });
      } else if ((PROBED_TOOLS as readonly string[]).includes(tool)) {
        // Terminal tools are re-checked on this Mac, once per new version.
        const bin = await probeBinary(ctx, tool, profile);
        const r = bin ? await verifiedOnThisMac(ctx, tool as (typeof PROBED_TOOLS)[number], version, bin) : { ok: false, detail: 'its command was not found' };
        add({
          level: r.ok ? 'ok' : 'warn',
          kind: 'untested',
          tool,
          message: r.ok
            ? `${name} ${version} is newer than the tested ${newest}; re-checked on this Mac: ${r.detail}.`
            : `${name} ${version} is newer than the tested ${newest}, and the check on this Mac failed: ${r.detail}.`,
          ...(r.ok ? {} : { hint: 'Run scripts/phase0-remaining.sh from a normal Terminal to see what changed.' }),
        });
      } else if (major(version) === major(newest)) {
        // Desktop apps and browsers isolate with Chromium's --user-data-dir, which doesn't change between minor releases.
        add({ level: 'ok', kind: 'untested', tool, message: `${name} ${version} is in the same major version as the tested ${newest}.` });
      } else {
        add({
          level: 'warn',
          kind: 'untested',
          tool,
          message: `${name} ${version} is a new major version (tested: ${newest}); isolation results may differ.`,
          hint: 'Re-run scripts/phase0-remaining.sh and update packages/core/src/adapters/tested.ts.',
        });
      }
    }
  }
  for (const tool of new Set(profiles.map((p) => p.tool))) {
    const adapter = adapterForTool(tool);
    const tested = adapter.tested;
    if (tested.isolatedHistory !== 'tested') {
      add({
        level: 'info',
        kind: 'untested',
        tool,
        message: `${adapter.displayName}: history separation is ${tested.isolatedHistory} (separate folders), not yet checked with two accounts.`,
      });
    }
    // Every-profile folders only matter when two accounts (two folders) read them; with one, nothing is shared.
    const readers = new Set(profiles.filter((p) => p.tool === tool && usesGlobalDirs(p)).map((p) => adapterFor(p).paths(ctx, p).root));
    if (readers.size < 2) continue;
    for (const g of tested.globalSkillDirs) {
      const entries = await listEntries(resolvePath(g.path, ctx.home));
      if (!entries.length) continue;
      add({
        level: g.evidence === 'tested' ? 'info' : 'warn',
        kind: 'untested',
        tool,
        message: `${g.path} holds ${plural(entries.length, 'item')} (${entries.map((e) => e.name).join(', ')}). ${g.note}`,
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
      const target = `${contractHome(inv.skillsDirLinkedTo, ctx.home)}${owner ? ` (${owner.label})` : ''}`;
      // Set up on purpose by the tool that manages the folder (cpm's share = ["skills"]): worth knowing, not a fault.
      add(
        p.managedBy
          ? {
              level: 'info',
              kind: 'config',
              profile: p.id,
              message: `skills/ links to ${target}, set up by ${p.managedBy}: every skill there is available in this profile too.`,
              hint: `To pick skills one by one instead: aihub takeover, then aihub share skill <name> ${p.id} --detach`,
            }
          : {
              level: 'warn',
              kind: 'config',
              profile: p.id,
              message: `skills/ is a single link to ${target}: all of those skills are shared, all or nothing.`,
              hint: `Pick skills one by one instead: aihub share skill <name> ${p.id} --detach`,
            },
      );
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
          message: `${plural(of('pending').length, 'sharing change')} not applied yet: ${of('pending').map(label).join(', ')}.`,
          hint: `aihub apply ${p.id}`,
        });
      }
      for (const a of of('conflict')) add({ level: 'warn', kind: 'state', profile: p.id, message: `${label(a)}: ${a.reason}` });
      for (const a of of('blocked')) add({ level: 'info', kind: 'config', profile: p.id, message: `${label(a)}: ${a.reason}` });
      for (const a of of('unsupported')) add({ level: 'info', kind: 'unsupported', profile: p.id, message: `${label(a)}: ${a.reason}` });
      if (plan.actions.length && plan.actions.every((a) => a.status === 'ok')) {
        add({ level: 'ok', kind: 'config', profile: p.id, message: plan.actions.length === 1 ? 'The shared item is in place.' : `All ${plural(plan.actions.length, 'shared item')} in place.` });
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
