import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Context } from './context.js';

/**
 * The Dock's apps live in the com.apple.dock defaults, under persistent-apps. Changes go through a
 * copy: export, edit the copy with PlistBuddy, import it back, restart the Dock. Only entries for
 * the app asked about are added or removed; everything else is written back as it was read.
 */

const DOMAIN = 'com.apple.dock';
const BUDDY = '/usr/libexec/PlistBuddy';

/** "file:///Users/me/Applications/A%20B.app/" or a plain path → "/Users/me/Applications/A B.app". */
function entryPath(url: string): string {
  const p = url.startsWith('file://') ? fileURLToPath(url) : url;
  return p.replace(/\/+$/, '');
}

async function run(ctx: Context, cmd: string, args: string[]): Promise<string> {
  const r = await ctx.sys.run(cmd, args);
  if (r.code !== 0) throw new Error(`${path.basename(cmd)} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

async function withDockCopy<T>(ctx: Context, fn: (file: string) => Promise<T>): Promise<T> {
  const file = path.join(os.tmpdir(), `aihub-dock-${randomBytes(4).toString('hex')}.plist`);
  try {
    await run(ctx, '/usr/bin/defaults', ['export', DOMAIN, file]);
    return await fn(file);
  } finally {
    await fs.rm(file, { force: true });
  }
}

/** The app paths in the Dock, in order (the URL strings of persistent-apps). */
async function readApps(ctx: Context, file: string): Promise<string[]> {
  const r = await ctx.sys.run('/usr/bin/plutil', ['-extract', 'persistent-apps', 'xml1', '-o', '-', file]);
  if (r.code !== 0) return []; // no persistent-apps yet
  // Each tile has exactly one _CFURLString, so the n-th match is the n-th app.
  return [...r.stdout.matchAll(/<key>_CFURLString<\/key>\s*<string>([^<]*)<\/string>/g)].map((m) => entryPath(m[1]!.replace(/&amp;/g, '&')));
}

/** A file tile for the app, the way the Dock writes one when you drag an app in, at position `i`. */
async function insertTile(ctx: Context, file: string, i: number, app: string): Promise<void> {
  const at = `:persistent-apps:${i}`;
  // Percent-encoded, so the URL has no spaces for PlistBuddy to split on.
  const url = pathToFileURL(app).href.replace(/\/?$/, '/');
  for (const cmd of [
    `Add ${at} dict`,
    `Add ${at}:tile-type string file-tile`,
    `Add ${at}:tile-data dict`,
    `Add ${at}:tile-data:file-data dict`,
    `Add ${at}:tile-data:file-data:_CFURLString string ${url}`,
    `Add ${at}:tile-data:file-data:_CFURLStringType integer 15`,
  ]) {
    await run(ctx, BUDDY, ['-c', cmd, file]);
  }
}

async function save(ctx: Context, file: string): Promise<void> {
  await run(ctx, '/usr/bin/defaults', ['import', DOMAIN, file]);
  await ctx.sys.run('/usr/bin/killall', ['Dock']); // the Dock reloads its settings when it restarts
}

export async function dockApps(ctx: Context): Promise<string[]> {
  return withDockCopy(ctx, (file) => readApps(ctx, file));
}

/** Add an app at the end of the Dock's apps, unless it's already there. Returns whether it was added. */
export async function addToDock(ctx: Context, app: string): Promise<boolean> {
  return withDockCopy(ctx, async (file) => {
    const apps = await readApps(ctx, file);
    if (apps.includes(app)) return false;
    if (!apps.length) await ctx.sys.run(BUDDY, ['-c', 'Add :persistent-apps array', file]); // fails harmlessly if it exists
    await insertTile(ctx, file, apps.length, app);
    await save(ctx, file);
    return true;
  });
}

/** Remove an app's tiles from the Dock. With `replacement`, put that app in the same place instead. */
export async function removeFromDock(ctx: Context, app: string, replacement?: string): Promise<boolean> {
  return withDockCopy(ctx, async (file) => {
    const apps = await readApps(ctx, file);
    const at = apps.map((a, i) => (a === app ? i : -1)).filter((i) => i >= 0);
    if (!at.length) return false;
    // Highest index first, so earlier indexes stay valid.
    for (const i of [...at].reverse()) await run(ctx, BUDDY, ['-c', `Delete :persistent-apps:${i}`, file]);
    if (replacement && !apps.includes(replacement)) {
      await insertTile(ctx, file, at[0]!, replacement);
    }
    await save(ctx, file);
    return true;
  });
}
