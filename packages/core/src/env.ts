import type { Env } from './context.js';

/** Variables that pick a Claude account or config folder. */
export const CLAUDE_ENV_STRIP = [/^CLAUDE_/, /^CLAUDECODE$/, /^ANTHROPIC_/];
/** Variables that pick a Codex account or config folder. */
export const CODEX_ENV_STRIP = [/^CODEX_/, /^OPENAI_API_KEY$/];
/**
 * Apps started with `open` inherit the caller's whole environment. Drop everything account-related,
 * plus ELECTRON_RUN_AS_NODE (set by the bundled `aihub` command; it would start an Electron app as plain Node).
 */
export const APP_ENV_STRIP = [...CLAUDE_ENV_STRIP, ...CODEX_ENV_STRIP, /^ELECTRON_RUN_AS_NODE$/, /^AIHUB_/];

/**
 * Copy of `base` without variables matching `strip`, plus `set`.
 * Stripping inherited tokens and config-dir variables is what keeps one profile from
 * silently running with another profile's identity.
 */
export function cleanEnv(base: Env, strip: RegExp[], set: Env = {}): Env {
  const out: Env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || strip.some((re) => re.test(key))) continue;
    out[key] = value;
  }
  return { ...out, ...set };
}

export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
