import path from 'node:path';
import { z } from 'zod';
import { BROWSER_APPS } from './adapters/browser.js';
import { BROWSERS, cleanLabel, HubSchema, saveHub, type Hub, type Profile } from './config.js';
import type { Context } from './context.js';
import { toProfileId } from './discover.js';
import { ensureDir, exists } from './fsx.js';
import { resolvePath } from './paths.js';
import { defaultLabel, newProfileFolder, profileRoot } from './registry.js';
import { stateFile } from './state.js';

/**
 * What the app's "New profile" asks for: an account, and which programs open it. A desktop app
 * always comes with the CLI profile whose folder it uses (Claude Desktop's Code tab, the
 * ChatGPT/Codex app's CODEX_HOME), so the two share one login and show up as one account.
 */
export type NewAccount =
  | { kind: 'claude'; name: string; app: boolean }
  | { kind: 'codex'; name: string; app: boolean }
  | { kind: 'cursor'; name: string; isolatedHome: boolean }
  | { kind: 'web'; name: string; url: string; browser: (typeof BROWSERS)[number] };

const COLORS = ['#3B7DD8', '#5DCAA5', '#E0A55E', '#7C5CC4', '#D25F8C', '#4CA9B2'];

export async function installedBrowsers(ctx: Context): Promise<(typeof BROWSERS)[number][]> {
  const out: (typeof BROWSERS)[number][] = [];
  for (const b of BROWSERS) {
    for (const dir of ['/Applications', path.join(ctx.home, 'Applications')]) {
      if (await exists(path.join(dir, BROWSER_APPS[b]))) {
        out.push(b);
        break;
      }
    }
  }
  return out;
}

export const NewAccountSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('claude'), name: z.string(), app: z.boolean() }),
  z.strictObject({ kind: z.literal('codex'), name: z.string(), app: z.boolean() }),
  z.strictObject({ kind: z.literal('cursor'), name: z.string(), isolatedHome: z.boolean() }),
  z.strictObject({ kind: z.literal('web'), name: z.string(), url: z.string(), browser: z.enum(BROWSERS) }),
]);

const PREFIX: Record<NewAccount['kind'], string[]> = {
  claude: ['claude-', 'claude-desktop-'],
  codex: ['codex-', 'chatgpt-'],
  cursor: ['cursor-'],
  web: ['web-'],
};

/**
 * Create the profiles for a new account; returns them, CLI profile first. Everything is checked
 * before anything is created, so a failure leaves no half-made account or stray folder behind.
 */
export async function createAccount(ctx: Context, hub: Hub, input: NewAccount): Promise<Profile[]> {
  const spec = NewAccountSchema.parse(input);
  const name = cleanLabel(spec.name);
  if (!name) throw new Error('Give the account a name, e.g. "Work" or "Acme".');
  if (spec.kind === 'web' && (!URL.canParse(spec.url) || !/^https?:$/.test(new URL(spec.url).protocol))) {
    throw new Error(`"${spec.url}" isn't a web address.`);
  }
  // Ids hold at most 40 characters: leave room for the longest prefix and a "-NN" suffix.
  const room = 40 - Math.max(...PREFIX[spec.kind].map((p) => p.length)) - 3;
  const slug = toProfileId(name).slice(0, room).replace(/-+$/, '') || 'account';
  const taken = new Set(hub.profiles.map((p) => p.id));
  // An id whose folder or records are still on disk (a profile removed but kept) would quietly
  // bring back that old login, so those ids are skipped too.
  const freeId = async (base: string) => {
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      if (taken.has(id) || (await exists(resolvePath(newProfileFolder(ctx, id), ctx.home))) || (await exists(stateFile(ctx, id)))) continue;
      taken.add(id);
      return id;
    }
  };
  // Each new account gets the next unused color, and its first letter as the badge.
  const used = new Set(hub.profiles.map((p) => p.icon?.color));
  const color = COLORS.find((c) => !used.has(c)) ?? COLORS[hub.profiles.length % COLORS.length]!;
  const badge = name.replace(/[^\p{L}\p{N}]/gu, '').charAt(0).toUpperCase();
  const icon = { color, ...(badge ? { badge } : {}) };
  // The product name, then the account name exactly as typed: "Claude Code · Société".
  const labelFor = (tool: Profile['tool'], url?: string) => `${defaultLabel(tool, '', url)} · ${name}`.slice(0, 80);

  const made: Profile[] = [];
  if (spec.kind === 'claude') {
    const id = await freeId(`claude-${slug}`);
    made.push({ id, tool: 'claude-code', label: labelFor('claude-code'), home: newProfileFolder(ctx, id), icon });
    if (spec.app) {
      const deskId = await freeId(`claude-desktop-${slug}`);
      made.push({ id: deskId, tool: 'claude-desktop', label: labelFor('claude-desktop'), dataDir: newProfileFolder(ctx, deskId), codeProfile: id, icon });
    }
  } else if (spec.kind === 'codex') {
    const id = await freeId(`codex-${slug}`);
    const home = newProfileFolder(ctx, id);
    made.push({ id, tool: 'codex', label: labelFor('codex'), home, icon });
    if (spec.app) made.push({ id: await freeId(`chatgpt-${slug}`), tool: 'codex-desktop', label: labelFor('codex-desktop'), codexHome: home, icon });
  } else if (spec.kind === 'cursor') {
    const id = await freeId(`cursor-${slug}`);
    made.push({ id, tool: 'cursor', label: labelFor('cursor'), dataDir: newProfileFolder(ctx, id), homeMode: spec.isolatedHome ? 'isolated' : 'shared', icon });
  } else {
    const id = await freeId(`web-${slug}`);
    made.push({ id, tool: 'browser', label: labelFor('browser', spec.url), browser: spec.browser, url: spec.url, dataDir: newProfileFolder(ctx, id), appWindow: true, icon });
  }

  // Validate the whole result first, then create the folders and save once.
  HubSchema.parse({ ...hub, profiles: [...hub.profiles, ...made] });
  for (const p of made) await ensureDir(profileRoot(ctx, p));
  hub.profiles.push(...made);
  await saveHub(ctx, hub);
  return made;
}
