import type { Context } from './context.js';
import { readTextIfExists } from './fsx.js';

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** A top-level string value from an Info.plist. XML is parsed directly; binary plists go through plutil. */
export async function readPlistString(ctx: Context, file: string, key: string): Promise<string | undefined> {
  const text = await readTextIfExists(file);
  if (text === undefined) return undefined;
  if (text.includes('<plist')) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = text.match(new RegExp(`<key>${escaped}</key>\\s*<string>([^<]*)</string>`));
    return m?.[1] !== undefined ? decodeXml(m[1]) : undefined;
  }
  const r = await ctx.sys.run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', file]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}
