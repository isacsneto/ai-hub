import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { compareVersions, readPlistString, realSystem, type Context } from '@aihub/core';

/**
 * Updates from GitHub Releases, without Squirrel.Mac (which needs an Apple Developer ID).
 * A release must carry `AI-Hub-<version>-<arch>-mac.zip` and `SHA256SUMS.txt`; the CI release
 * workflow produces both. The zip is only installed if its SHA-256 matches, it unpacks to an app
 * with our bundle id and the advertised version, and its (ad-hoc) code signature verifies.
 */

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface Release {
  tag_name: string;
  html_url: string;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  assets: ReleaseAsset[];
}

export type UpdateStatus =
  | { state: 'idle'; current: string; checkedAt?: string }
  | { state: 'checking'; current: string }
  | { state: 'up-to-date'; current: string; checkedAt: string }
  | { state: 'available'; current: string; latest: string; notes: string; url: string; checkedAt: string }
  | { state: 'downloading'; current: string; latest: string; received: number; total: number }
  | { state: 'installing'; current: string; latest: string }
  | { state: 'error'; current: string; message: string };

export const versionOf = (tag: string) => tag.replace(/^v/, '');

export function zipName(version: string, arch: string = process.arch): string {
  return `AI-Hub-${version}-${arch}-mac.zip`;
}

/** The zip for this machine plus the checksum file, or undefined when the release lacks them. */
export function pickAssets(release: Release, arch: string = process.arch) {
  const version = versionOf(release.tag_name);
  const zip = release.assets.find((a) => a.name === zipName(version, arch));
  const sums = release.assets.find((a) => a.name === 'SHA256SUMS.txt');
  return zip && sums ? { zip, sums, version } : undefined;
}

/** `shasum -a 256` output → hash for one file name. */
export function checksumFor(sums: string, file: string): string | undefined {
  for (const line of sums.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m && m[2] === file) return m[1]!.toLowerCase();
  }
  return undefined;
}

/** Where the running .app lives (…/AI-Hub.app), or a reason it can't be replaced in place. */
export function installTarget(execPath: string): { app: string } | { problem: string } {
  const app = path.resolve(execPath, '../../..');
  if (!app.endsWith('.app')) return { problem: 'AI-Hub is not running from an app bundle (development build).' };
  if (app.includes('/AppTranslocation/')) {
    return { problem: 'macOS is running AI-Hub from a temporary location. Move AI-Hub.app to /Applications, open it from there, then update.' };
  }
  return { app };
}

const headers = { 'User-Agent': 'AI-Hub-updater', Accept: 'application/vnd.github+json' };

export async function fetchLatestRelease(repo: string): Promise<Release | undefined> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
  if (res.status === 404) return undefined; // no releases yet
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${repo}`);
  return (await res.json()) as Release;
}

export interface CheckResult {
  release?: Release;
  latest?: string;
  available: boolean;
  /** A newer version exists, but its release has no build for this Mac. */
  missingBuild?: boolean;
}

export async function checkForUpdate(repo: string, current: string, arch: string = process.arch): Promise<CheckResult> {
  const release = await fetchLatestRelease(repo);
  if (!release || release.draft || release.prerelease) return { available: false };
  const latest = versionOf(release.tag_name);
  const newer = compareVersions(latest, current) > 0;
  const usable = !!pickAssets(release, arch);
  return { release, latest, available: newer && usable, missingBuild: newer && !usable };
}

/** Stream a download to `file`, returning its SHA-256. Write errors (e.g. a full disk) reject instead of crashing. */
async function download(url: string, file: string, onProgress: (received: number, total: number) => void): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': headers['User-Agent'] } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const hash = createHash('sha256');
  let received = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      received += chunk.length;
      onProgress(received, total);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as ReadableStream), tap, createWriteStream(file));
  return hash.digest('hex');
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The script that swaps the app once `pid` has exited. A lock in the backup folder keeps two
 * installs from interleaving; a failed swap puts the old app back; only the newest backup is kept.
 */
export function swapScript(o: {
  pid: number;
  app: string;
  next: string;
  backup: string;
  work: string;
  /** Version being replaced: if the installed app is no longer it, another install already ran. */
  current: string;
  relaunch: boolean;
}): string {
  const backups = path.dirname(o.backup);
  const lock = path.join(backups, '.installing');
  const plist = path.join(o.app, 'Contents/Info.plist');
  return [
    '#!/bin/bash',
    `while kill -0 ${o.pid} 2>/dev/null; do sleep 0.2; done`,
    // A lock left by a crashed install expires after 10 minutes.
    `find ${q(lock)} -maxdepth 0 -mmin +10 -exec rm -rf {} + 2>/dev/null`,
    `if mkdir ${q(lock)} 2>/dev/null; then`,
    `  if [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' ${q(plist)} 2>/dev/null)" = ${q(o.current)} ]; then`,
    `    rm -rf ${q(o.backup)}`,
    `    if mv ${q(o.app)} ${q(o.backup)}; then`,
    `      if mv ${q(o.next)} ${q(o.app)}; then`,
    `        for old in ${q(backups)}/AI-Hub-*.app; do [ "$old" = ${q(o.backup)} ] || rm -rf "$old"; done`,
    '      else',
    `        mv ${q(o.backup)} ${q(o.app)}`,
    '      fi',
    '    fi',
    '  fi',
    `  rmdir ${q(lock)}`,
    o.relaunch ? `  open ${q(o.app)}` : '  :',
    'fi',
    `rm -rf ${q(o.work)}`,
    '',
  ].join('\n');
}

async function run(cmd: string, args: string[]): Promise<void> {
  const r = await realSystem.run(cmd, args, { timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`${path.basename(cmd)} failed: ${(r.stderr || r.stdout).trim()}`);
}

/**
 * Download, verify and stage the update, then hand off to a small script that swaps the app once
 * this process has exited and reopens it. The previous version is kept in ~/.aihub/backups/app.
 */
export async function downloadAndInstall(opts: {
  ctx: Context;
  release: Release;
  current: string;
  execPath: string;
  bundleId: string;
  onProgress: (received: number, total: number) => void;
  quit: () => void;
  /** Reopen the app after swapping (default true; tests turn it off). */
  relaunch?: boolean;
}): Promise<void> {
  const target = installTarget(opts.execPath);
  if ('problem' in target) throw new Error(target.problem);
  await fs.access(path.dirname(target.app), fs.constants.W_OK).catch(() => {
    throw new Error(`Can't write to ${path.dirname(target.app)}; move AI-Hub.app somewhere you own (like /Applications) and retry.`);
  });
  const assets = pickAssets(opts.release);
  if (!assets) throw new Error(`Release ${opts.release.tag_name} has no ${zipName(versionOf(opts.release.tag_name))} with checksums.`);

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-update-'));
  try {
    await stage(opts, target.app, assets, work);
  } catch (err) {
    await fs.rm(work, { recursive: true, force: true });
    throw err;
  }
  opts.quit();
}

async function stage(
  opts: Parameters<typeof downloadAndInstall>[0],
  app: string,
  assets: NonNullable<ReturnType<typeof pickAssets>>,
  work: string,
): Promise<void> {
  const zip = path.join(work, assets.zip.name);
  const sumsRes = await fetch(assets.sums.browser_download_url, { headers: { 'User-Agent': headers['User-Agent'] } });
  if (!sumsRes.ok) throw new Error(`Checksum download failed (${sumsRes.status})`);
  const sums = await sumsRes.text();
  const expected = checksumFor(sums, assets.zip.name);
  if (!expected) throw new Error('The release checksum file does not list the app zip.');
  const actual = await download(assets.zip.browser_download_url, zip, opts.onProgress);
  if (actual !== expected) throw new Error('Downloaded update does not match its published SHA-256; not installing.');

  const unpacked = path.join(work, 'unpacked');
  await run('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
  const apps = (await fs.readdir(unpacked)).filter((n) => n.endsWith('.app'));
  if (apps.length !== 1) throw new Error('Unexpected update archive layout.');
  const next = path.join(unpacked, apps[0]!);
  const plist = path.join(next, 'Contents/Info.plist');
  const [bundleId, version] = await Promise.all([
    readPlistString(opts.ctx, plist, 'CFBundleIdentifier'),
    readPlistString(opts.ctx, plist, 'CFBundleShortVersionString'),
  ]);
  if (bundleId !== opts.bundleId) throw new Error(`Update is a different app (${bundleId}); not installing.`);
  if (version !== assets.version) throw new Error(`Update says it is ${version}, release says ${assets.version}; not installing.`);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', next]);
  await realSystem.run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', next]);

  const backupDir = path.join(opts.ctx.hubDir, 'backups', 'app');
  await fs.mkdir(backupDir, { recursive: true });
  const backup = path.join(backupDir, `AI-Hub-${opts.current}.app`);
  const script = path.join(work, 'install.sh');
  await fs.writeFile(script, swapScript({ pid: process.pid, app, next, backup, work, current: opts.current, relaunch: opts.relaunch !== false }), { mode: 0o700 });
  spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref();
}
