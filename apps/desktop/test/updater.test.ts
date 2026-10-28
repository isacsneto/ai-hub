import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { checksumFor, installTarget, pickAssets, swapScript, versionOf, zipName, type Release } from '../src/main/updater';

const sh = promisify(execFile);

const asset = (name: string) => ({ name, browser_download_url: `https://github.com/x/y/releases/download/v0.2.0/${name}`, size: 1 });

describe('updater', () => {
  const release: Release = {
    tag_name: 'v0.2.0',
    html_url: 'https://github.com/x/y/releases/tag/v0.2.0',
    assets: [asset('AI-Hub-0.2.0-arm64-mac.zip'), asset('AI-Hub-0.2.0-x64-mac.zip'), asset('SHA256SUMS.txt')],
  };

  it('picks the zip for this architecture together with the checksum file', () => {
    expect(versionOf('v0.2.0')).toBe('0.2.0');
    expect(pickAssets(release, 'arm64')?.zip.name).toBe(zipName('0.2.0', 'arm64'));
    expect(pickAssets(release, 'x64')?.zip.name).toBe('AI-Hub-0.2.0-x64-mac.zip');
    expect(pickAssets({ ...release, assets: release.assets.slice(0, 1) }, 'arm64')).toBeUndefined();
  });

  it('reads `shasum -a 256` output and matches exact file names only', () => {
    const sums = `${'a'.repeat(64)}  AI-Hub-0.2.0-arm64-mac.zip\n${'b'.repeat(64)} *AI-Hub-0.2.0-x64-mac.zip\n`;
    expect(checksumFor(sums, 'AI-Hub-0.2.0-arm64-mac.zip')).toBe('a'.repeat(64));
    expect(checksumFor(sums, 'AI-Hub-0.2.0-x64-mac.zip')).toBe('b'.repeat(64));
    expect(checksumFor(sums, 'AI-Hub-0.2.0-arm64-mac.zip.evil')).toBeUndefined();
  });

  it('only updates a real, non-translocated app bundle', () => {
    expect(installTarget('/Applications/AI-Hub.app/Contents/MacOS/AI-Hub')).toEqual({ app: '/Applications/AI-Hub.app' });
    expect(installTarget('/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')).toEqual({
      app: '/repo/node_modules/electron/dist/Electron.app',
    });
    expect(installTarget('/usr/local/bin/node')).toHaveProperty('problem');
    expect(installTarget('/private/var/folders/x/AppTranslocation/1234/d/AI-Hub.app/Contents/MacOS/AI-Hub')).toHaveProperty('problem');
  });
});

describe('swap script', () => {
  /** Fake bundles: the running app (old), a staged update (new) and an older backup. */
  async function setup(name = "AI Hub's") {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-swap-'));
    const dir = path.join(root, name); // spaces and quotes in every path
    const app = path.join(dir, 'Applications/AI-Hub.app');
    const work = path.join(dir, 'work');
    const next = path.join(work, 'unpacked/AI-Hub.app');
    const backups = path.join(dir, 'backups/app');
    const bundles = [[app, '0.1.0'], [next, '0.2.0'], [path.join(backups, 'AI-Hub-0.0.1.app'), '0.0.1']] as const;
    for (const [d, v] of bundles) {
      await fs.mkdir(path.join(d, 'Contents'), { recursive: true });
      await sh('/usr/bin/plutil', ['-create', 'xml1', path.join(d, 'Contents/Info.plist')]);
      await sh('/usr/bin/plutil', ['-insert', 'CFBundleShortVersionString', '-string', v, path.join(d, 'Contents/Info.plist')]);
    }
    const script = (pid: number, w = work, n = next) =>
      swapScript({ pid, app, next: n, backup: path.join(backups, 'AI-Hub-0.1.0.app'), work: w, current: '0.1.0', relaunch: false });
    const read = async (d: string) =>
      (await sh('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(d, 'Contents/Info.plist')]).catch(() => ({ stdout: 'missing' }))).stdout.trim();
    return { app, work, next, backups, script, read };
  }
  const run = (script: string) => sh('/bin/bash', ['-c', script]);
  const gonePid = async () => (await sh('/bin/bash', ['-c', 'sleep 0 & echo $!'])).stdout.trim();

  it('swaps in the new app, keeps only the newest backup and cleans up', async () => {
    const t = await setup();
    await run(t.script(Number(await gonePid())));
    expect(await t.read(t.app)).toBe('0.2.0');
    expect(await fs.readdir(t.backups)).toEqual(['AI-Hub-0.1.0.app']);
    expect(await t.read(path.join(t.backups, 'AI-Hub-0.1.0.app'))).toBe('0.1.0');
    await expect(fs.access(t.work)).rejects.toThrow();
  });

  it('puts the old app back when the new one cannot be moved in', async () => {
    const t = await setup();
    await fs.rm(t.next, { recursive: true });
    await run(t.script(Number(await gonePid())));
    expect(await t.read(t.app)).toBe('0.1.0');
    expect(await fs.readdir(t.backups)).toContain('AI-Hub-0.0.1.app');
  });

  it('lets only one of two installs swap, whether they overlap or run back to back', async () => {
    const t = await setup();
    const pid = Number(await gonePid());
    // A second download staged its own copy in its own work folder.
    const work2 = `${t.work}2`;
    await fs.cp(t.work, work2, { recursive: true });
    const next2 = path.join(work2, 'unpacked/AI-Hub.app');
    await Promise.all([run(t.script(pid)), run(t.script(pid, work2, next2))]);
    await run(t.script(pid, work2, next2));
    expect(await t.read(t.app)).toBe('0.2.0');
    expect(await t.read(path.join(t.backups, 'AI-Hub-0.1.0.app'))).toBe('0.1.0');
  });
});
