#!/usr/bin/env node
import { Argument, Command } from 'commander';
import { registerLaunchers } from './commands/launchers.js';
import { registerSharing } from './commands/sharing.js';
import { MARK, action, csv, ctx, dim, folderOf, paint, printActions, table, who } from './ui.js';
import {
  AIHUB_VERSION,
  BROWSERS,
  TOOL_IDS,
  adapterFor,
  adoptProfile,
  applyImport,
  cleanLabel,
  contractHome,
  createProfile,
  defaultLabel,
  discover,
  doctor,
  getProfile,
  loadHub,
  newProfileFolder,
  plural,
  reconcile,
  relabelProfile,
  deleteProfile,
  moveToTrash,
  saveHub,
  shellQuote,
  type Finding,
  type Profile,
  type ToolId,
} from '@aihub/core';

const program = new Command('aihub')
  .description('Run several AI accounts side by side, each isolated, sharing only what you choose.')
  .version(AIHUB_VERSION)
  .enablePositionalOptions();

// ---------- commands ----------

program
  .command('list')
  .alias('ls')
  .description('List registered profiles and who is signed in to each')
  .option('--json', 'machine-readable output')
  .action(
    action(async (opts: { json?: boolean }) => {
      const hub = await loadHub(ctx);
      const ids = await Promise.all(hub.profiles.map((p) => adapterFor(p).identity(ctx, p)));
      if (opts.json) {
        console.log(JSON.stringify(hub.profiles.map((p, i) => ({ ...p, identity: ids[i] })), null, 2));
        return;
      }
      if (!hub.profiles.length) {
        console.log('No profiles yet. Run `aihub import` to find your existing accounts.');
        return;
      }
      const rows = hub.profiles.map((p, i) => [
        p.id,
        p.tool,
        p.label,
        p.tool === 'claude-desktop' ? dim('login lives in the app') : who(ids[i]),
        folderOf(p),
        dim(p.tool === 'claude-desktop' && p.codeProfile ? `code tab → ${p.codeProfile}` : (p.managedBy ?? '')),
      ]);
      console.log(table(['ID', 'TOOL', 'LABEL', 'ACCOUNT', 'FOLDER', ''], rows));
    }),
  );

program
  .command('inspect <id>')
  .description("Show a profile's folders, account, skills and MCP server names")
  .option('--json', 'machine-readable output')
  .action(
    action(async (id: string, opts: { json?: boolean }) => {
      const hub = await loadHub(ctx);
      const p = getProfile(hub, id);
      const adapter = adapterFor(p);
      const paths = adapter.paths(ctx, p);
      const [identity, inv] = await Promise.all([adapter.identity(ctx, p), adapter.inventory(ctx, p)]);
      if (opts.json) {
        console.log(JSON.stringify({ profile: p, paths, identity, inventory: inv }, null, 2));
        return;
      }
      const c = (s: string) => contractHome(s, ctx.home);
      const cred =
        paths.credential.kind === 'keychain'
          ? `Keychain item "${paths.credential.service}"`
          : paths.credential.kind === 'file'
            ? c(paths.credential.path)
            : paths.credential.detail;
      console.log(`${paint('bold', p.label)}  ${dim(`${p.id} · ${adapter.displayName}`)}`);
      console.log(`  account   ${who(identity)}${identity.org && identity.org !== identity.email ? dim(` (${identity.org})`) : ''}`);
      console.log(`  folder    ${c(paths.root)}${paths.isDefault ? dim(' (tool default)') : ''}`);
      console.log(`  login     ${cred}`);
      if (paths.mcpFile) console.log(`  mcp       ${inv.mcpServers.join(', ') || dim('none')}  ${dim(c(paths.mcpFile))}`);
      console.log(`  history   ${inv.historyPresent.map(c).join(', ') || dim('none yet')}`);
      if (p.tool === 'claude-desktop') {
        console.log(`  code tab  ${p.codeProfile ?? paint('yellow', 'default ~/.claude (not isolated)')}`);
      }
      if (paths.skillsDir) {
        const linked = inv.skillsDirLinkedTo ? paint('yellow', ` (whole folder → ${c(inv.skillsDirLinkedTo)})`) : '';
        console.log(`  skills    ${inv.skills.length}${linked}`);
        for (const s of inv.skills) {
          const tag = s.broken ? paint('red', ' broken') : s.linkTarget ? dim(` → ${s.linkTarget}`) : '';
          console.log(`    ${s.name}${tag}`);
        }
      }
      const plan = await reconcile(ctx, hub, p, { dryRun: true });
      if (plan.actions.length) {
        console.log('  shared');
        printActions(plan.actions, '    ');
      }
      if (p.managedBy) console.log(dim(`  managed by ${p.managedBy}: the hub only reads this folder`));
    }),
  );

program
  .command('import')
  .description('Find existing accounts (default folders, cpm, Claude Profiles apps) and register them in place')
  .option('--apply', 'register them (default is a dry run)')
  .option('--only <ids>', 'comma-separated ids to register')
  .option('--skip <ids>', 'comma-separated ids to leave out')
  .option('--json', 'machine-readable output')
  .action(
    action(async (opts: { apply?: boolean; only?: string; skip?: string; json?: boolean }) => {
      const hub = await loadHub(ctx);
      const found = await discover(ctx, hub);
      if (opts.json && !opts.apply) {
        console.log(JSON.stringify(found, null, 2));
        return;
      }
      const only = csv(opts.only);
      const skip = csv(opts.skip);
      const rows = found.map((c) => {
        const picked = c.state === 'new' && (!only || only.includes(c.profile.id)) && !skip?.includes(c.profile.id);
        const state =
          c.state === 'registered'
            ? dim(`already ${c.registeredAs}`)
            : picked
              ? paint('green', opts.apply ? 'added' : 'new')
              : dim('skipped');
        const extra = [
          c.profile.tool === 'claude-desktop' && c.profile.codeProfile ? `code tab → ${c.profile.codeProfile}` : '',
          ...c.warnings,
        ]
          .filter(Boolean)
          .join('; ');
        return [state, c.profile.id, c.profile.label, who(c.identity), folderOf(c.profile), dim(extra)];
      });
      if (!found.length) {
        console.log('Nothing found to import.');
        return;
      }
      if (opts.apply) {
        const { added, snapshot } = await applyImport(ctx, hub, found, { only, skip });
        console.log(table(['', 'ID', 'LABEL', 'ACCOUNT', 'FOLDER', 'NOTES'], rows));
        console.log(
          added.length
            ? `\nRegistered ${plural(added.length, 'profile')}. Nothing inside their folders was changed.\nInventory snapshot: ${contractHome(snapshot!, ctx.home)}`
            : '\nNothing new to register.',
        );
      } else {
        console.log(table(['', 'ID', 'LABEL', 'ACCOUNT', 'FOLDER', 'NOTES'], rows));
        console.log(dim('\nDry run. Register with `aihub import --apply` (use --only/--skip to choose).'));
      }
    }),
  );

const toolArgument = () => new Argument('<tool>').choices(TOOL_IDS);

/** Options that only mean something for some tools; anything else is an error rather than silently ignored. */
const TOOL_OPTIONS: Record<string, { flag: string; tools: ToolId[] }> = {
  codeProfile: { flag: '--code-profile', tools: ['claude-desktop'] },
  codexHome: { flag: '--codex-home', tools: ['codex-desktop'] },
  codexProfile: { flag: '--codex-profile', tools: ['codex-desktop'] },
  browser: { flag: '--browser', tools: ['browser'] },
  url: { flag: '--url', tools: ['browser'] },
  isolatedHome: { flag: '--isolated-home', tools: ['cursor'] },
  folder: { flag: '--folder', tools: TOOL_IDS.filter((t) => t !== 'codex-desktop') },
};

function rejectOtherToolOptions(tool: ToolId, opts: object): void {
  for (const [key, value] of Object.entries(opts)) {
    const rule = TOOL_OPTIONS[key];
    if (rule && value !== undefined && !rule.tools.includes(tool)) {
      throw new Error(`${rule.flag} doesn't apply to ${tool} profiles (only ${rule.tools.join(', ')}).`);
    }
  }
}

program
  .command('adopt')
  .description('Register one existing folder as a profile, leaving it where it is')
  .addArgument(toolArgument())
  .argument('<folder>', 'CLAUDE_CONFIG_DIR / CODEX_HOME / Desktop --user-data-dir')
  .requiredOption('--id <id>', 'profile id, e.g. claude-work')
  .option('--label <label>', 'display name')
  .option('--code-profile <id>', 'claude-desktop: claude-code profile for the Code tab')
  .option('--force', "adopt even if the folder doesn't look like that tool's")
  .action(
    action(async (tool: ToolId, folder: string, opts: { id: string; label?: string; codeProfile?: string; force?: boolean }) => {
      rejectOtherToolOptions(tool, opts);
      const hub = await loadHub(ctx);
      const label = cleanLabel(opts.label ?? '') || defaultLabel(tool, opts.id);
      if (tool === 'codex-desktop' || tool === 'browser') {
        throw new Error(`Use \`aihub profile add ${tool}\`; there is no existing folder to adopt.`);
      }
      const p: Profile =
        tool === 'claude-desktop'
          ? { id: opts.id, tool, label, dataDir: folder, ...(opts.codeProfile ? { codeProfile: opts.codeProfile } : {}) }
          : tool === 'cursor'
            ? { id: opts.id, tool, label, dataDir: folder, homeMode: 'shared' }
            : { id: opts.id, tool, label, home: folder };
      const { snapshot } = await adoptProfile(ctx, hub, p, { force: opts.force });
      console.log(`Adopted ${p.id} at ${folderOf(p)}. Nothing inside the folder was changed.`);
      console.log(dim(`Inventory snapshot: ${contractHome(snapshot, ctx.home)}`));
    }),
  );

const profile = program.command('profile').description('Create, edit or remove profiles');

profile
  .command('add')
  .description('Create a new, fully isolated profile')
  .addArgument(toolArgument())
  .argument('<id>', 'profile id, e.g. codex-work')
  .option('--label <label>', 'display name')
  .option('--folder <path>', 'where its data lives (default ~/.aihub/profiles/<id>)')
  .option('--code-profile <id>', 'claude-desktop: claude-code profile for the Code tab')
  .option('--codex-home <path>', 'codex-desktop: CODEX_HOME the app runs with')
  .option('--codex-profile <id>', "codex-desktop: use this codex profile's folder")
  .option('--browser <name>', `browser: ${BROWSERS.join(', ')}`)
  .option('--url <url>', 'browser: site to open, e.g. https://chatgpt.com')
  .option('--isolated-home', 'cursor: give Cursor its own HOME so ~/.cursor (MCP, skills) is separate (experimental)')
  .option('--badge <text>', 'icon badge, 1–2 characters')
  .option('--color <hex>', 'icon color, #RRGGBB')
  .action(
    action(
      async (
        tool: ToolId,
        id: string,
        opts: {
          label?: string; folder?: string; codeProfile?: string; codexHome?: string; codexProfile?: string;
          browser?: string; url?: string; isolatedHome?: boolean; badge?: string; color?: string;
        },
      ) => {
        rejectOtherToolOptions(tool, opts);
        if (opts.codexHome && opts.codexProfile) throw new Error('Use --codex-profile or --codex-home, not both.');
        const hub = await loadHub(ctx);
        const folder = opts.folder ?? newProfileFolder(ctx, id);
        const icon = opts.badge || opts.color ? { badge: opts.badge, color: opts.color } : undefined;
        const common = { id, label: cleanLabel(opts.label ?? '') || defaultLabel(tool, id, opts.url), ...(icon ? { icon } : {}) };
        let p: Profile;
        if (tool === 'claude-desktop') {
          p = { ...common, tool, dataDir: folder, ...(opts.codeProfile ? { codeProfile: opts.codeProfile } : {}) };
        } else if (tool === 'codex-desktop') {
          const from = opts.codexProfile ? getProfile(hub, opts.codexProfile) : undefined;
          if (from && from.tool !== 'codex') throw new Error(`${opts.codexProfile} is not a codex profile.`);
          const codexHome = from?.tool === 'codex' ? from.home : opts.codexHome;
          if (!codexHome) throw new Error('codex-desktop needs --codex-profile <id> or --codex-home <path>.');
          p = { ...common, tool, codexHome };
        } else if (tool === 'cursor') {
          p = { ...common, tool, dataDir: folder, homeMode: opts.isolatedHome ? 'isolated' : 'shared' };
        } else if (tool === 'browser') {
          if (!opts.browser || !opts.url) throw new Error('browser profiles need --browser and --url.');
          p = { ...common, tool, browser: opts.browser as (typeof BROWSERS)[number], url: opts.url, dataDir: folder, appWindow: true };
        } else {
          p = { ...common, tool, home: folder };
        }
        await createProfile(ctx, hub, p);
        console.log(`Created ${id} at ${folderOf(p)}.`);
        if (tool === 'claude-code') console.log(`Sign in with: aihub run ${id} auth login`);
        if (tool === 'codex') console.log(`Sign in with: aihub run ${id} login`);
        if (tool === 'cursor' && !opts.isolatedHome) {
          console.log(paint('yellow', 'Note: ~/.cursor (MCP servers, skills) is shared with every Cursor profile unless --isolated-home.'));
        }
        if (tool === 'claude-desktop') {
          if (!opts.codeProfile) {
            console.log(paint('yellow', 'No --code-profile: its Code tab will use your default ~/.claude.'));
          }
          console.log(`Open it and sign in with: aihub run ${id}`);
        }
      },
    ),
  );

profile
  .command('remove <id>')
  .description("Stop tracking a profile (its folder and login are kept)")
  .option('--unshare', 'first take out what the hub shared into it, except plugins (`aihub undo` puts it back)')
  .option('--trash', 'move its folder to the Trash, login and history included (only folders the hub created)')
  .action(
    action(async (id: string, opts: { unshare?: boolean; trash?: boolean }) => {
      if (opts.unshare && opts.trash) throw new Error('Use --unshare or --trash, not both (the Trash takes everything).');
      const r = await deleteProfile(ctx, id, {
        unshare: opts.unshare,
        ...(opts.trash ? { trash: (dir: string) => moveToTrash(ctx, dir) } : {}),
      });
      console.log(`Removed ${id} from the hub.`);
      if (r.trashed) console.log(`Moved ${r.folder} to the Trash.`);
      else console.log(`Its folder ${r.folder} and login were kept.`);
      if (r.unshared) console.log(`Took out ${plural(r.unshared, 'shared item')} (\`aihub undo\` puts them back).`);
      if (r.leftInPlace) console.log(dim(`${plural(r.leftInPlace, 'shared item')} stayed in the folder${opts.unshare ? '' : ' (--unshare takes them out)'}.`));
      if (r.launcher) console.log(`Removed the launcher ${r.launcher}.`);
    }),
  );

profile
  .command('set <id>')
  .description("Change a profile's label or icon")
  .option('--label <label>')
  .option('--badge <text>', '1–2 characters')
  .option('--color <hex>', '#RRGGBB')
  .action(
    action(async (id: string, opts: { label?: string; badge?: string; color?: string }) => {
      const hub = await loadHub(ctx);
      const p = getProfile(hub, id);
      const rebuilt = opts.label ? await relabelProfile(ctx, hub, p, opts.label) : undefined;
      if (opts.badge || opts.color) {
        p.icon = { ...p.icon, ...(opts.badge ? { badge: opts.badge } : {}), ...(opts.color ? { color: opts.color } : {}) };
      }
      await saveHub(ctx, hub);
      console.log(`Updated ${id}.`);
      if (rebuilt) console.log(dim(`Launcher renamed: ${contractHome(rebuilt, ctx.home)}`));
    }),
  );

program
  .command('run <id> [args...]')
  .description('Launch a profile; extra arguments go to the tool (e.g. aihub run claude-work --resume)')
  .passThroughOptions()
  .allowUnknownOption()
  .action(
    action(async (id: string, args: string[]) => {
      const hub = await loadHub(ctx);
      const p = getProfile(hub, id);
      const adapter = adapterFor(p);
      await adapter.prepareLaunch?.(ctx, p);
      const spec = await adapter.launchSpec(ctx, hub, p, args);
      process.exitCode = await ctx.sys.runInteractive(spec.command, spec.args, spec.env);
    }),
  );

program
  .command('env <id>')
  .description('Print shell lines that switch the current shell to a profile: eval "$(aihub env <id>)"')
  .action(
    action(async (id: string) => {
      const hub = await loadHub(ctx);
      const p = getProfile(hub, id);
      if (p.tool !== 'claude-code' && p.tool !== 'codex') throw new Error('Only CLI profiles (claude-code, codex) can switch a shell; use `aihub run`.');
      const spec = await adapterFor(p).launchSpec(ctx, hub, p, []);
      const lines: string[] = [];
      for (const key of Object.keys(ctx.env).sort()) if (!(key in spec.env)) lines.push(`unset ${key}`);
      for (const [key, value] of Object.entries(spec.env)) {
        if (value !== undefined && ctx.env[key] !== value) lines.push(`export ${key}=${shellQuote(value)}`);
      }
      lines.push(`export AIHUB_PROFILE=${shellQuote(p.id)}`);
      console.log(lines.join('\n'));
    }),
  );

program
  .command('doctor [id]')
  .description('Check isolation, logins, versions against tested evidence, and broken links')
  .option('--json', 'machine-readable output')
  .action(
    action(async (id: string | undefined, opts: { json?: boolean }) => {
      const hub = await loadHub(ctx);
      if (id) getProfile(hub, id);
      const report = await doctor(ctx, hub, { only: id });
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        const groups = new Map<string, Finding[]>();
        for (const f of report.findings) {
          const key = f.profile ?? (f.tool ? `tool: ${f.tool}` : 'hub');
          groups.set(key, [...(groups.get(key) ?? []), f]);
        }
        for (const [key, fs] of groups) {
          console.log(paint('bold', key));
          for (const f of fs) {
            const kind = f.kind === 'isolation' ? paint('red', ' [isolation]') : '';
            console.log(`  ${MARK[f.level]} ${f.message}${kind}`);
            if (f.hint) console.log(dim(`      → ${f.hint}`));
          }
        }
        const summary = `${plural(report.errors, 'error')}, ${plural(report.warnings, 'warning')}`;
        console.log('\n' + (report.errors ? paint('red', summary) : report.warnings ? paint('yellow', summary) : paint('green', summary)));
      }
      if (report.errors) process.exitCode = 1;
    }),
  );

registerSharing(program);
registerLaunchers(program);

// Explicit 'node' argv layout: also correct when the CLI runs inside AI-Hub.app (ELECTRON_RUN_AS_NODE).
await program.parseAsync(process.argv, { from: 'node' });
