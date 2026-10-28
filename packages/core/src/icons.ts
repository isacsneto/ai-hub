import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { adapterFor, claudeDesktop, codexDesktop } from './adapters/index.js';
import type { Profile } from './config.js';
import type { Context } from './context.js';
import { exists } from './fsx.js';
import { resolvePath } from './paths.js';
import { readPlistString } from './plist.js';

const DEFAULT_COLOR = '#6B7280';

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The .icns of an app bundle, via CFBundleIconFile. */
async function appIcon(ctx: Context, app: string | undefined): Promise<string | undefined> {
  if (!app) return undefined;
  const name = await readPlistString(ctx, path.join(app, 'Contents/Info.plist'), 'CFBundleIconFile');
  if (!name) return undefined;
  const file = path.join(app, 'Contents/Resources', name.endsWith('.icns') ? name : `${name}.icns`);
  return (await exists(file)) ? file : undefined;
}

/** Image the profile's icon starts from: a custom image, else the tool's app icon. */
export async function baseIconFile(ctx: Context, p: Profile): Promise<string | undefined> {
  if (p.icon?.image) return resolvePath(p.icon.image, ctx.home);
  // CLI tools have no app of their own; they borrow the matching desktop app's icon.
  const app =
    p.tool === 'claude-code'
      ? await claudeDesktop.findBinary(ctx)
      : p.tool === 'codex'
        ? await codexDesktop.findBinary(ctx)
        : await adapterFor(p).findBinary(ctx, p);
  return appIcon(ctx, app);
}

async function loadBase(ctx: Context, file: string, size: number): Promise<Buffer> {
  let input = file;
  let tmp: string | undefined;
  if (file.endsWith('.icns')) {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-icon-'));
    input = path.join(tmp, 'base.png');
    const r = await ctx.sys.run('/usr/bin/sips', ['-s', 'format', 'png', file, '--out', input]);
    if (r.code !== 0) throw new Error(`Could not read ${file}: ${r.stderr.trim()}`);
  }
  try {
    return await sharp(input).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  } finally {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** A plain rounded square with a letter, for profiles with no base image. */
function generatedSvg(size: number, color: string, letter: string): string {
  const r = size * 0.22;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <rect x="${size * 0.1}" y="${size * 0.1}" width="${size * 0.8}" height="${size * 0.8}" rx="${r}" fill="${color}"/>
  <text x="50%" y="50%" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-weight="700" font-size="${size * 0.42}"
    fill="#fff" text-anchor="middle" dominant-baseline="central">${escapeXml(letter)}</text>
</svg>`;
}

/** Colored dot with a 1–2 letter badge, for the bottom-right corner. */
function badgeSvg(size: number, color: string, text: string): string {
  const d = size * 0.44;
  const c = d / 2;
  const fontSize = (text.length > 1 ? 0.38 : 0.5) * d;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}">
  <circle cx="${c}" cy="${c}" r="${c - d * 0.02}" fill="#fff"/>
  <circle cx="${c}" cy="${c}" r="${c - d * 0.09}" fill="${color}"/>
  <text x="50%" y="50%" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-weight="700" font-size="${fontSize}" fill="#fff" text-anchor="middle" dominant-baseline="central">${escapeXml(text)}</text>
</svg>`;
}

/** First letter of the part of the label that tells profiles apart ("Claude Code · Work" → "W"). */
export function labelInitial(label: string): string {
  const part = label.split('·').pop() ?? label;
  return part.replace(/[^\p{L}\p{N}]/gu, '').charAt(0).toUpperCase();
}

/** The profile's icon as a square PNG: base app icon + badge, or a generated tile. */
export async function renderIcon(ctx: Context, p: Profile, size = 1024): Promise<Buffer> {
  const color = p.icon?.color ?? DEFAULT_COLOR;
  const badge = p.icon?.badge || labelInitial(p.label) || '?';
  const file = await baseIconFile(ctx, p);
  // No usable base image (none set, app missing, unreadable icns): fall back to a generated tile.
  const base = file ? await loadBase(ctx, file, size).catch(() => undefined) : undefined;
  if (!base) return sharp(Buffer.from(generatedSvg(size, color, badge))).png().toBuffer();
  // Without a chosen badge or color the plain app icon is clearer than a grey dot.
  if (!p.icon?.badge && !p.icon?.color) return base;
  const overlay = await sharp(Buffer.from(badgeSvg(size, color, badge))).png().toBuffer();
  const offset = Math.round(size - size * 0.44 - size * 0.04);
  return sharp(base).composite([{ input: overlay, left: offset, top: offset }]).png().toBuffer();
}

const ICONSET: [number, string][] = [
  [16, '16x16'], [32, '16x16@2x'], [32, '32x32'], [64, '32x32@2x'], [128, '128x128'],
  [256, '128x128@2x'], [256, '256x256'], [512, '256x256@2x'], [512, '512x512'], [1024, '512x512@2x'],
];

/** Turn a 1024px PNG into an .icns with macOS iconutil. */
export async function writeIcns(ctx: Context, png: Buffer, out: string): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-iconset-'));
  const set = path.join(dir, 'icon.iconset');
  try {
    await fs.mkdir(set);
    for (const [px, name] of ICONSET) await sharp(png).resize(px, px).png().toFile(path.join(set, `icon_${name}.png`));
    const r = await ctx.sys.run('/usr/bin/iconutil', ['-c', 'icns', set, '-o', out]);
    if (r.code !== 0) throw new Error(`iconutil failed: ${r.stderr.trim()}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
