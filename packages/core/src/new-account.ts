import path from 'node:path';
import { BROWSER_APPS } from './adapters/browser.js';
import { BROWSERS, cleanLabel, type Hub, type Profile } from './config.js';
import type { Context } from './context.js';
import { toProfileId } from './discover.js';
import { exists } from './fsx.js';
import { createProfile, defaultLabel, newProfileFolder } from './registry.js';

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

/** Create the profiles for a new account; returns them, CLI profile first. */
export async function createAccount(ctx: Context, hub: Hub, spec: NewAccount): Promise<Profile[]> {
  const name = cleanLabel(spec.name);
  if (!name) throw new Error('Give the account a name, e.g. "Work" or "Acme".');
  const slug = toProfileId(name);
  const taken = new Set(hub.profiles.map((p) => p.id));
  const freeId = (base: string) => {
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    return id;
  };
  // Each new account gets the next unused color, and its first letter as the badge.
  const used = new Set(hub.profiles.map((p) => p.icon?.color));
  const color = COLORS.find((c) => !used.has(c)) ?? COLORS[hub.profiles.length % COLORS.length]!;
  const badge = name.replace(/[^\p{L}\p{N}]/gu, '').charAt(0).toUpperCase();
  const icon = { color, ...(badge ? { badge } : {}) };
  const labelFor = (tool: Profile['tool'], url?: string) => defaultLabel(tool, slug, url);

  const made: Profile[] = [];
  const add = async (p: Profile) => {
    await createProfile(ctx, hub, p);
    made.push(p);
  };

  if (spec.kind === 'claude') {
    const id = freeId(`claude-${slug}`);
    await add({ id, tool: 'claude-code', label: labelFor('claude-code'), home: newProfileFolder(ctx, id), icon });
    if (spec.app) {
      const deskId = freeId(`claude-desktop-${slug}`);
      await add({ id: deskId, tool: 'claude-desktop', label: labelFor('claude-desktop'), dataDir: newProfileFolder(ctx, deskId), codeProfile: id, icon });
    }
  } else if (spec.kind === 'codex') {
    const id = freeId(`codex-${slug}`);
    const home = newProfileFolder(ctx, id);
    await add({ id, tool: 'codex', label: labelFor('codex'), home, icon });
    if (spec.app) await add({ id: freeId(`chatgpt-${slug}`), tool: 'codex-desktop', label: labelFor('codex-desktop'), codexHome: home, icon });
  } else if (spec.kind === 'cursor') {
    const id = freeId(`cursor-${slug}`);
    await add({ id, tool: 'cursor', label: labelFor('cursor'), dataDir: newProfileFolder(ctx, id), homeMode: spec.isolatedHome ? 'isolated' : 'shared', icon });
  } else {
    if (!URL.canParse(spec.url) || !/^https?:$/.test(new URL(spec.url).protocol)) throw new Error(`"${spec.url}" isn't a web address.`);
    const id = freeId(`web-${slug}`);
    await add({ id, tool: 'browser', label: defaultLabel('browser', id, spec.url), browser: spec.browser, url: spec.url, dataDir: newProfileFolder(ctx, id), appWindow: true, icon });
  }
  return made;
}
