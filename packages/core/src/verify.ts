import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ToolId } from './config.js';
import type { Context } from './context.js';
import { atomicWrite, exists, readJsonIfExists } from './fsx.js';

/**
 * Re-check a terminal tool's isolation on this Mac when it's newer than the tested versions: run it
 * against empty temporary folders in a clean environment and see that it stays inside them (no
 * login, no MCP servers, its files written there). No model calls, no real profile touched.
 * Results are kept per version in ~/.aihub/state/verified.json, so each version is checked once.
 */

export type Probe = { ok: boolean; detail: string };
export const PROBED_TOOLS = ['claude-code', 'codex', 'codex-desktop'] as const satisfies readonly ToolId[];

const cacheFile = (ctx: Context) => path.join(ctx.hubDir, 'state', 'verified.json');

async function probe(ctx: Context, tool: (typeof PROBED_TOOLS)[number], bin: string): Promise<Probe> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-verify-'));
  // Only what a fresh login shell would have: no inherited CLAUDE_CONFIG_DIR, tokens or session vars.
  // PATH keeps the tool's own folder and Homebrew's, for tools that run on a node from there.
  const PATH = [path.dirname(bin), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  const env = { HOME: ctx.home, PATH, USER: ctx.env.USER ?? '', TERM: 'dumb' };
  const run = async (args: string[], extra: Record<string, string>) => {
    const r = await ctx.sys.run(bin, args, { env: { ...env, ...extra }, timeoutMs: 30_000 });
    return `${r.stdout}\n${r.stderr}`;
  };
  try {
    if (tool === 'claude-code') {
      const dir = path.join(tmp, 'claude');
      const mcp = await run(['mcp', 'list'], { CLAUDE_CONFIG_DIR: dir });
      const own = await exists(path.join(dir, '.claude.json'));
      const ok = /No MCP servers configured/i.test(mcp) && own;
      return { ok, detail: ok ? 'an empty CLAUDE_CONFIG_DIR kept its own settings and had no MCP servers' : 'an empty CLAUDE_CONFIG_DIR did not stay separate' };
    }
    const dir = path.join(tmp, 'codex');
    await fs.mkdir(dir);
    const login = await run(['login', 'status'], { CODEX_HOME: dir });
    const mcp = await run(['mcp', 'list'], { CODEX_HOME: dir });
    const ok = /Not logged in/i.test(login) && /No MCP servers configured/i.test(mcp);
    return { ok, detail: ok ? 'an empty CODEX_HOME was signed out and had no MCP servers' : 'an empty CODEX_HOME did not stay separate' };
  } catch (err) {
    return { ok: false, detail: `the check could not run: ${(err as Error).message}` };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** The probe result for this tool version, running it only the first time a version is seen. */
export async function verifiedOnThisMac(ctx: Context, tool: (typeof PROBED_TOOLS)[number], version: string, bin: string): Promise<Probe> {
  const file = cacheFile(ctx);
  const cache = ((await readJsonIfExists(file).catch(() => undefined)) ?? {}) as Record<string, Probe & { at: string }>;
  const key = `${tool}@${version}`;
  const known = cache[key];
  if (known?.ok) return known; // a failure is retried next time: it may have been a timeout
  const result = await probe(ctx, tool, bin);
  cache[key] = { ...result, at: new Date().toISOString() };
  await atomicWrite(file, JSON.stringify(cache, null, 2) + '\n').catch(() => undefined);
  return result;
}
