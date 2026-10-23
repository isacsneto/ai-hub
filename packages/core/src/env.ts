import type { Env } from './context.js';

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
