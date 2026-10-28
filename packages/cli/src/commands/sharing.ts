import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import {
  addToLibrary,
  contractHome,
  getLibraryItem,
  getProfile,
  libraryLog,
  listLibrary,
  loadCatalog,
  loadHub,
  loadSharedSettings,
  mainFile,
  parseShareKind,
  plural,
  previewPluginMcp,
  profilesSharing,
  promote,
  reconcile,
  reconcileAll,
  removeFromLibrary,
  restoreLibrary,
  saveCatalog,
  saveHub,
  setSharedSetting,
  setSharing,
  takeover,
  undoLast,
  undoTakeover,
  withHubLock,
  abandonUnfinishedUndo,
  type Plan,
} from '@aihub/core';
import { action, ctx, dim, itemKind, paint, printPlans, table } from '../ui.js';

const singular = (k: string) => k.replace(/s$/, '');

export function registerSharing(program: Command): void {
  const library = program.command('library').alias('lib').description('The shared library: skills, agents, commands, instructions');

  library
    .command('list')
    .alias('ls')
    .description('List library items and which profiles take each')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const hub = await loadHub(ctx);
        const items = [];
        for (const i of await listLibrary(ctx)) items.push({ ...i, sharedWith: await profilesSharing(ctx, hub, i.kind, i.name) });
        const plugins = [];
        for (const pl of await loadCatalog(ctx)) plugins.push({ ...pl, sharedWith: await profilesSharing(ctx, hub, 'plugins', pl.id) });
        const settings = [];
        for (const [key, value] of Object.entries(await loadSharedSettings(ctx))) {
          settings.push({ key, value, sharedWith: await profilesSharing(ctx, hub, 'settings', key) });
        }
        if (opts.json) {
          console.log(JSON.stringify({ items, plugins, settings }, null, 2));
          return;
        }
        if (!items.length && !plugins.length && !settings.length) {
          console.log('The library is empty. Add with `aihub library add skill <folder>` or `aihub library promote <profile> skill <name>`.');
          return;
        }
        const who = (ids: string[]) => ids.join(', ') || dim('nobody');
        const rows = [
          ...items.map((i) => [singular(i.kind), i.name, who(i.sharedWith), dim(i.description ?? '')]),
          ...plugins.map((pl) => ['plugin', pl.id, who(pl.sharedWith), dim(pl.source ?? '')]),
          ...settings.map((s) => ['setting', s.key, who(s.sharedWith), dim(JSON.stringify(s.value).slice(0, 60))]),
        ];
        console.log(table(['KIND', 'NAME', 'SHARED WITH', 'DETAILS'], rows));
      }),
    );

  library
    .command('add <kind> <path>')
    .description('Copy a skill folder or .md file into the library')
    .option('--name <name>', 'name in the library (default: folder/file name)')
    .action(
      action(async (kind: string, src: string, opts: { name?: string }) => {
        const item = await addToLibrary(ctx, itemKind(kind), path.resolve(src.replace(/^~(?=\/|$)/, ctx.home)), opts.name);
        console.log(`Added ${singular(item.kind)} "${item.name}". Share it with: aihub share ${singular(item.kind)} ${item.name} <profile…>`);
      }),
    );

  library
    .command('show <kind> <name>')
    .description("Print an item's main file")
    .action(
      action(async (kind: string, name: string) => {
        console.log(await fs.readFile(mainFile(await getLibraryItem(ctx, itemKind(kind), name)), 'utf8'));
      }),
    );

  library
    .command('remove <kind> <name>')
    .description('Delete an item from the library (refused while any profile takes it)')
    .action(
      action(async (kind: string, name: string) => {
        const hub = await loadHub(ctx);
        const k = itemKind(kind);
        const users = await profilesSharing(ctx, hub, k, name);
        if (users.length) throw new Error(`Still shared with ${users.join(', ')}. First: aihub unshare ${singular(k)} ${name} ${users.join(' ')}`);
        await removeFromLibrary(ctx, k, name);
        console.log(`Removed ${singular(k)} "${name}" (still in \`aihub library log\`).`);
      }),
    );

  library
    .command('promote <profile> <kind> <name>')
    .description("Move a profile's own skill/agent/command into the library and share it back")
    .option('--force', 'even if another tool manages the profile')
    .action(
      action(async (profileId: string, kind: string, name: string, opts: { force?: boolean }) => {
        const hub = await loadHub(ctx);
        const { strategy } = await promote(ctx, hub, profileId, itemKind(kind), name, opts);
        console.log(
          `Moved "${name}" into the library; ${profileId} now uses it as a ${strategy === 'symlink' ? 'link' : 'tracked copy'}.` +
            ' The original is kept in the journal (`aihub undo` puts it back).',
        );
      }),
    );

  library
    .command('log')
    .description('Library change history')
    .action(
      action(async () => {
        const log = await libraryLog(ctx);
        if (!log.length) console.log('No history yet (needs git).');
        for (const e of log) console.log(`${paint('yellow', e.rev)}  ${dim(e.date.slice(0, 16).replace('T', ' '))}  ${e.message}`);
      }),
    );

  library
    .command('restore <rev>')
    .description('Bring the library back to an earlier revision (then run `aihub apply`)')
    .action(
      action(async (rev: string) => {
        await restoreLibrary(ctx, rev);
        console.log(`Library restored to ${rev}. Run \`aihub apply\` to update profiles.`);
      }),
    );

  const plugin = program.command('plugin').description('Plugin catalog: one shared list, installed per profile');

  plugin
    .command('add <id>')
    .description('Add name@marketplace to the catalog')
    .option('--source <source>', 'marketplace source for profiles that lack it (owner/repo, URL or path)')
    .action(
      action(async (id: string, opts: { source?: string }) => {
        const rest = (await loadCatalog(ctx)).filter((p) => p.id !== id);
        await saveCatalog(ctx, [...rest, { id, ...(opts.source ? { source: opts.source } : {}) }]);
        const mcp = await previewPluginMcp(ctx, await loadHub(ctx), { id });
        console.log(`Added ${id} to the catalog.`);
        if (mcp.servers.length) console.log(paint('yellow', `It adds MCP servers: ${mcp.servers.join(', ')}. Profiles need --allow-mcp to get it.`));
        else if (!mcp.known) console.log(dim("Its MCP servers can't be checked offline, so sharing it needs --allow-mcp."));
      }),
    );

  plugin
    .command('remove <id>')
    .description('Remove from the catalog (refused while shared)')
    .action(
      action(async (id: string) => {
        const users = await profilesSharing(ctx, await loadHub(ctx), 'plugins', id);
        if (users.length) throw new Error(`Still shared with ${users.join(', ')}.`);
        await saveCatalog(ctx, (await loadCatalog(ctx)).filter((p) => p.id !== id));
        console.log(`Removed ${id} from the catalog.`);
      }),
    );

  plugin
    .command('preview <id>')
    .description('Which MCP servers a plugin would add (checked offline)')
    .action(
      action(async (id: string) => {
        const mcp = await previewPluginMcp(ctx, await loadHub(ctx), { id });
        if (!mcp.known && !mcp.servers.length) console.log("Unknown: the plugin's files aren't available locally.");
        else console.log(mcp.servers.length ? `MCP servers: ${mcp.servers.join(', ')}${mcp.known ? '' : ' (maybe more)'}` : 'No MCP servers.');
        if (mcp.from) console.log(dim(`from ${contractHome(mcp.from, ctx.home)}`));
      }),
    );

  const setting = program.command('setting').description('Shared settings.json values (approved keys only)');

  setting
    .command('set <key> <value>')
    .description(`Set a shared value (JSON, or a plain string), e.g. aihub setting set model opus`)
    .action(
      action(async (key: string, raw: string) => {
        let value: unknown = raw;
        try {
          value = JSON.parse(raw);
        } catch {
          // plain strings like `opus` don't need JSON quotes
        }
        await setSharedSetting(ctx, key, value);
        console.log(`Set ${key}. Share it with: aihub share setting ${key} <profile…>`);
      }),
    );

  setting
    .command('unset <key>')
    .action(
      action(async (key: string) => {
        const users = await profilesSharing(ctx, await loadHub(ctx), 'settings', key);
        if (users.length) throw new Error(`Still shared with ${users.join(', ')}.`);
        await setSharedSetting(ctx, key, undefined);
        console.log(`Removed ${key}.`);
      }),
    );

  for (const on of [true, false]) {
    program
      .command(`${on ? 'share' : 'unshare'} <kind> <name> <profiles...>`)
      .description(
        on
          ? 'Give profiles a library item (kind: skill, agent, command, instruction, plugin, setting; name can be "all")'
          : 'Take a library item away from profiles',
      )
      .option('--allow-mcp', 'plugins: approve the MCP servers this plugin adds')
      .option('--detach', 'replace a whole-folder link (from cpm) with per-item links')
      .option('--force', 'overwrite changed copies/values, or write into folders another tool manages')
      .option('--dry-run', 'show what would change, change nothing')
      .option('--no-apply', 'only record the choice in hub.yaml')
      .action(
        action(
          async (
            kind: string,
            name: string,
            ids: string[],
            opts: { allowMcp?: boolean; detach?: boolean; force?: boolean; dryRun?: boolean; apply: boolean },
          ) => {
            const plans = await withHubLock(ctx, async () => {
              const hub = await loadHub(ctx);
              const profiles = await setSharing(ctx, hub, parseShareKind(kind), name, ids, on, { allowMcp: opts.allowMcp });
              if (!opts.dryRun) await saveHub(ctx, hub);
              if (!opts.apply) return undefined;
              const out: Plan[] = [];
              for (const p of profiles) out.push(await reconcile(ctx, hub, p, opts));
              return out;
            });
            if (plans) printPlans(plans, opts.dryRun);
            else console.log(opts.dryRun ? 'Would record this in hub.yaml (dry run: nothing saved).' : 'Recorded in hub.yaml. Apply with: aihub apply');
          },
        ),
      );
  }

  program
    .command('apply [profile]')
    .description("Make profiles' folders match their sharing choices (all profiles by default)")
    .option('--dry-run', 'show what would change, change nothing')
    .option('--detach', 'replace whole-folder links (from cpm) with per-item links')
    .option('--force', 'overwrite changed copies/values, or write into folders another tool manages')
    .option('--json', 'machine-readable output')
    .action(
      action(async (id: string | undefined, opts: { dryRun?: boolean; detach?: boolean; force?: boolean; json?: boolean }) => {
        const hub = await loadHub(ctx);
        const plans = id ? [await reconcile(ctx, hub, getProfile(hub, id), opts)] : await reconcileAll(ctx, hub, opts);
        if (opts.json) {
          console.log(JSON.stringify(plans, null, 2));
          if (plans.some((p) => ('error' in p && p.error) || p.actions.some((a) => a.status === 'failed'))) process.exitCode = 1;
        } else printPlans(plans, opts.dryRun);
      }),
    );

  program
    .command('undo')
    .description('Reverse the last change the hub made inside tool folders')
    .option('--skip', 'stop retrying an undo that stopped partway, leaving the rest as it is')
    .action(
      action(async (opts: { skip?: boolean }) => {
        if (opts.skip) {
          const a = await abandonUnfinishedUndo(ctx);
          console.log(
            a
              ? `Stopped undoing "${a.label}"; ${plural(a.left, 'change')} not reversed. The next undo goes to the run before it.`
              : 'No undo stopped partway; nothing to skip.',
          );
          return;
        }
        const r = await undoLast(ctx);
        if (!r) {
          console.log('Nothing to undo.');
          return;
        }
        const what = `${r.resumed ? 'Finished undoing' : 'Undid'} "${r.label}" (${plural(r.reverted, 'change')})`;
        console.log(r.failed.length ? `${what}, but ${plural(r.failed.length, 'change')} couldn't be reversed:` : `${what}.`);
        for (const f of r.failed) console.log(paint('red', `  ✗ ${f}`));
        for (const k of r.kept) console.log(paint('yellow', `  ⚠ ${k}`));
        if (r.failed.length) {
          process.exitCode = 1;
          console.log(dim('Fix that and run `aihub undo` again to finish (`aihub undo --skip` gives up on the rest).'));
        } else {
          console.log(dim('hub.yaml still has the sharing choices; `aihub apply` would redo them.'));
        }
      }),
    );

  program
    .command('takeover')
    .description('Let the hub manage folders that claude-account-guard / cpm / Claude Profiles own now')
    .option('--dry-run', 'show what would happen')
    .option('--undo', 'give them back')
    .action(
      action(async (opts: { dryRun?: boolean; undo?: boolean }) => {
        const hub = await loadHub(ctx);
        if (opts.undo) {
          for (const line of await undoTakeover(ctx, hub, opts)) console.log(`${opts.dryRun ? '→' : '✓'} ${line}`);
          return;
        }
        const plan = await takeover(ctx, hub, opts);
        if (!plan.steps.length) {
          console.log('Nothing is managed by another tool.');
          return;
        }
        for (const step of plan.steps) console.log(`${opts.dryRun ? '→' : '✓'} ${step}`);
        for (const note of plan.notes) console.log(dim(`  note: ${note}`));
        if (opts.dryRun) console.log(dim('\nDry run. `aihub takeover` does it; `aihub takeover --undo` reverses it.'));
      }),
    );
}
