import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import {
  buildLauncher,
  contractHome,
  exportHub,
  restoreHub,
  findProfileFile,
  getProfile,
  loadHub,
  PROFILE_FILE,
  removeLauncher,
  renderIcon,
  shellInit,
  writeProfileFile,
} from '@aihub/core';
import { action, ctx, dim } from '../ui.js';

export function registerLaunchers(program: Command): void {
  const launcher = program.command('launcher').description('App launchers with per-profile names and icons');

  launcher
    .command('build [profiles...]')
    .description('Create or refresh launcher apps (all profiles by default) in ~/Applications/AI-Hub')
    .option('--dir <path>', 'write them somewhere else')
    .action(
      action(async (ids: string[], opts: { dir?: string }) => {
        const hub = await loadHub(ctx);
        const profiles = ids.length ? ids.map((id) => getProfile(hub, id)) : hub.profiles;
        for (const p of profiles) {
          try {
            console.log(`✓ ${contractHome(await buildLauncher(ctx, hub, p, opts), ctx.home)}`);
          } catch (err) {
            console.log(`✗ ${p.id}: ${(err as Error).message}`);
            process.exitCode = 1;
          }
        }
        console.log(dim('Drag them to the Dock, or open with Spotlight. Rebuild after changing a label or icon.'));
      }),
    );

  launcher
    .command('remove <profile>')
    .option('--dir <path>', 'where it was built')
    .action(
      action(async (id: string, opts: { dir?: string }) => {
        const hub = await loadHub(ctx);
        const app = await removeLauncher(ctx, hub, getProfile(hub, id), opts);
        console.log(app ? `Removed ${contractHome(app, ctx.home)}.` : 'No launcher found.');
      }),
    );

  program
    .command('icon <profile>')
    .description("Render a profile's icon to a PNG to preview it")
    .option('--out <file>', 'output file', '')
    .option('--size <px>', 'size in pixels', '512')
    .action(
      action(async (id: string, opts: { out: string; size: string }) => {
        const hub = await loadHub(ctx);
        const out = path.resolve(opts.out || `${id}-icon.png`);
        const size = Number(opts.size);
        if (!Number.isInteger(size) || size < 16 || size > 2048) throw new Error('--size must be a whole number of pixels from 16 to 2048.');
        await fs.writeFile(out, await renderIcon(ctx, getProfile(hub, id), size));
        console.log(`Wrote ${contractHome(out, ctx.home)}`);
      }),
    );

  program
    .command('shell-init [shell]')
    .description('Shell code for ~/.zshrc: eval "$(aihub shell-init zsh)"')
    .action(
      action(async (shell = (ctx.env.SHELL ?? '').endsWith('bash') ? 'bash' : 'zsh') => {
        if (shell !== 'zsh' && shell !== 'bash') throw new Error('Use zsh or bash.');
        process.stdout.write(shellInit(await loadHub(ctx), shell));
      }),
    );

  program
    .command('link <profile>')
    .description(`Use a profile automatically in this folder (writes ${PROFILE_FILE}; needs shell-init)`)
    .action(
      action(async (id: string) => {
        const p = getProfile(await loadHub(ctx), id);
        // The shell hook runs `aihub env`, which only CLI profiles support.
        if (p.tool !== 'claude-code' && p.tool !== 'codex') throw new Error(`${id} is a ${p.tool} profile; only claude-code and codex profiles can be linked to a folder.`);
        console.log(`Wrote ${contractHome(await writeProfileFile(process.cwd(), id), ctx.home)}`);
      }),
    );

  program
    .command('unlink')
    .description(`Remove ${PROFILE_FILE} from this folder`)
    .action(
      action(async () => {
        const file = path.join(process.cwd(), PROFILE_FILE);
        if (!(await fs.lstat(file).catch(() => undefined))) {
          console.log(`No ${PROFILE_FILE} in this folder.`);
          return;
        }
        await fs.rm(file);
        console.log(`Removed ${PROFILE_FILE}.`);
      }),
    );

  program
    .command('which')
    .description('Which profile applies in this folder')
    .action(
      action(async () => {
        const found = await findProfileFile(process.cwd());
        if (found) console.log(`${found.id}  ${dim(`from ${contractHome(found.file, ctx.home)}`)}`);
        else console.log(ctx.env.AIHUB_PROFILE ? `${ctx.env.AIHUB_PROFILE}  ${dim('(from the environment)')}` : 'default profiles (no .aihub-profile here)');
      }),
    );

  program
    .command('export <file>')
    .description('Save hub.yaml, the library and install records to a .tar.gz (never logins or tool folders)')
    .action(
      action(async (file: string) => {
        const out = path.resolve(file);
        const parts = await exportHub(ctx, out);
        console.log(`Wrote ${contractHome(out, ctx.home)} (${parts.join(', ')}).`);
      }),
    );

  program
    .command('restore <file>')
    .description('Restore an export (the current hub is moved to backups first)')
    .option('--force', 'replace an existing hub')
    .action(
      action(async (file: string, opts: { force?: boolean }) => {
        const kept = await restoreHub(ctx, path.resolve(file), opts);
        console.log(`Restored. The previous hub is in ${contractHome(kept, ctx.home)}. Run \`aihub apply\` to update profiles.`);
      }),
    );
}
