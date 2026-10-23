import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { Context } from './context.js';
import { atomicWrite, ensureDir, readTextIfExists } from './fsx.js';

export const TOOL_IDS = ['claude-code', 'claude-desktop', 'codex', 'codex-desktop', 'cursor', 'browser'] as const;
export type ToolId = (typeof TOOL_IDS)[number];

export const ProfileId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'use 1–40 lowercase letters, digits and dashes');

const PathString = z.string().min(1);

const Icon = z.strictObject({
  base: z.string().optional(),
  badge: z.string().min(1).max(2).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'use a #RRGGBB color')
    .optional(),
  image: PathString.optional(),
});

const ItemList = z.union([z.literal('all'), z.array(z.string())]);

/** What this profile takes from the library. Desired state: `aihub apply` makes the folder match it. */
const Sharing = z.strictObject({
  skills: ItemList.optional(),
  agents: ItemList.optional(),
  commands: ItemList.optional(),
  instructions: z.array(z.string()).optional(),
  /** Plugin ids (name@marketplace) from the library catalog, installed into this profile on its own. */
  plugins: z.array(z.string()).optional(),
  /** Plugins whose MCP servers you approved for this profile. Others with MCP servers are held back. */
  allowMcp: z.array(z.string()).optional(),
  /** Keys from the library's shared settings (approved list only) to write into this profile. */
  settings: z.array(z.string()).optional(),
});

const id = ProfileId;
const base = {
  label: z.string().min(1),
  icon: Icon.optional(),
  sharing: Sharing.optional(),
  /** Set when another tool (cpm, claude-account-guard…) owns this folder; the hub then only reads it. */
  managedBy: z.string().optional(),
  adoptedAt: z.string().optional(),
};

// Key order here is the key order in hub.yaml: id, tool and folder first.
const ClaudeCodeProfile = z.strictObject({
  id,
  tool: z.literal('claude-code'),
  /** CLAUDE_CONFIG_DIR. The login is tied to this exact path, so the hub never moves it. */
  home: PathString,
  ...base,
});

const CodexProfile = z.strictObject({
  id,
  tool: z.literal('codex'),
  /** CODEX_HOME. */
  home: PathString,
  ...base,
});

const ClaudeDesktopProfile = z.strictObject({
  id,
  tool: z.literal('claude-desktop'),
  /** Electron --user-data-dir: Desktop login, chats and Desktop MCP. */
  dataDir: PathString,
  /** claude-code profile whose CLAUDE_CONFIG_DIR the Code tab uses. Unset → default ~/.claude. */
  codeProfile: ProfileId.optional(),
  /** Claude.app to launch; auto-detected when unset. */
  app: PathString.optional(),
  /** Existing launcher bundle (e.g. one made by Claude Profiles.app). */
  launcher: PathString.optional(),
  ...base,
});

const CodexDesktopProfile = z.strictObject({
  id,
  tool: z.literal('codex-desktop'),
  /** CODEX_HOME the ChatGPT/Codex app runs with; its login is that folder's Codex login. */
  codexHome: PathString,
  app: PathString.optional(),
  ...base,
});

const CursorProfile = z.strictObject({
  id,
  tool: z.literal('cursor'),
  /** --user-data-dir: Cursor login (state.vscdb), settings and chat history. */
  dataDir: PathString,
  /** --extensions-dir; unset → shared ~/.cursor/extensions. */
  extensionsDir: PathString.optional(),
  /**
   * Cursor derives ~/.cursor (global mcp.json, skills, plugins) from $HOME, which --user-data-dir
   * doesn't move. "isolated" launches it with HOME=<dataDir>/home (experimental).
   */
  homeMode: z.enum(['shared', 'isolated']).default('shared'),
  app: PathString.optional(),
  ...base,
});

export const BROWSERS = ['chrome', 'edge', 'brave', 'chromium', 'vivaldi'] as const;

const BrowserProfile = z.strictObject({
  id,
  tool: z.literal('browser'),
  browser: z.enum(BROWSERS),
  /** Site to open, e.g. https://claude.ai or https://chatgpt.com. */
  url: z.url(),
  /** Chromium --user-data-dir: cookies, login and history for this account only. */
  dataDir: PathString,
  /** Open as a standalone app window (--app) instead of a normal tab. */
  appWindow: z.boolean().default(true),
  ...base,
});

export const ProfileSchema = z.discriminatedUnion('tool', [
  ClaudeCodeProfile,
  CodexProfile,
  ClaudeDesktopProfile,
  CodexDesktopProfile,
  CursorProfile,
  BrowserProfile,
]);

const Preferences = z.strictObject({
  /** Terminal app the generated launchers open CLI profiles in. */
  terminal: z.enum(['Terminal', 'iTerm', 'Ghostty']).default('Terminal'),
  /** Where `aihub launchers` writes app bundles. */
  launchersDir: PathString.default('~/Applications/AI-Hub'),
});

export const HubSchema = z
  .strictObject({
    version: z.literal(1),
    preferences: Preferences.optional(),
    profiles: z.array(ProfileSchema).default([]),
  })
  .superRefine((hub, issue) => {
    const seen = new Set<string>();
    hub.profiles.forEach((p, i) => {
      if (seen.has(p.id)) {
        issue.addIssue({ code: 'custom', path: ['profiles', i, 'id'], message: `duplicate id "${p.id}"` });
      }
      seen.add(p.id);
    });
    hub.profiles.forEach((p, i) => {
      if (p.tool !== 'claude-desktop' || !p.codeProfile) return;
      const target = hub.profiles.find((q) => q.id === p.codeProfile);
      if (!target || target.tool !== 'claude-code') {
        issue.addIssue({
          code: 'custom',
          path: ['profiles', i, 'codeProfile'],
          message: `"${p.codeProfile}" is not a claude-code profile`,
        });
      }
    });
  });

export type Profile = z.infer<typeof ProfileSchema>;
export type ClaudeCodeProfile = z.infer<typeof ClaudeCodeProfile>;
export type CodexProfile = z.infer<typeof CodexProfile>;
export type ClaudeDesktopProfile = z.infer<typeof ClaudeDesktopProfile>;
export type CodexDesktopProfile = z.infer<typeof CodexDesktopProfile>;
export type CursorProfile = z.infer<typeof CursorProfile>;
export type BrowserProfile = z.infer<typeof BrowserProfile>;
export type Preferences = z.infer<typeof Preferences>;
export type Sharing = z.infer<typeof Sharing>;

export function preferences(hub: Hub): Preferences {
  return Preferences.parse(hub.preferences ?? {});
}


export type Hub = z.infer<typeof HubSchema>;

export const emptyHub = (): Hub => ({ version: 1, profiles: [] });

export function hubFile(ctx: Context): string {
  return path.join(ctx.hubDir, 'hub.yaml');
}

export function parseHub(text: string, source = 'hub.yaml'): Hub {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    throw new Error(`${source} is not valid YAML: ${(err as Error).message}`);
  }
  if (raw == null) return emptyHub();
  const result = HubSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`${source} is invalid:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export async function loadHub(ctx: Context): Promise<Hub> {
  const file = hubFile(ctx);
  const text = await readTextIfExists(file);
  return text === undefined ? emptyHub() : parseHub(text, file);
}

const HEADER =
  '# AI-Hub registry: which profiles exist and what they share.\n' +
  '# Holds no secrets: logins, tokens and MCP config stay inside each tool\'s own folder.\n';

const KEEP_BACKUPS = 20;

export function timestamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

/** Validate, keep a copy of the previous file, then write atomically. */
export async function saveHub(ctx: Context, hub: Hub): Promise<void> {
  const valid = HubSchema.parse(hub);
  const file = hubFile(ctx);
  await ensureDir(ctx.hubDir);
  const previous = await readTextIfExists(file);
  if (previous !== undefined) {
    const dir = path.join(ctx.hubDir, 'backups', 'hub-yaml');
    await atomicWrite(path.join(dir, `${timestamp()}.yaml`), previous);
    const old = (await fs.readdir(dir)).sort().slice(0, -KEEP_BACKUPS);
    await Promise.all(old.map((f) => fs.rm(path.join(dir, f), { force: true })));
  }
  await atomicWrite(file, HEADER + YAML.stringify(valid));
}
