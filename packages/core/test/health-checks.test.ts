import { mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Hub } from '../src/config.js';
import { doctor } from '../src/doctor.js';
import { ctxFor, executable, fakeSystem, tempHome, write } from './helpers.js';

/** A Mac with a `claude` whose version and behavior with an empty CLAUDE_CONFIG_DIR are chosen per test. */
async function claudeMac(opts: { version: string; staysSeparate: boolean }) {
  const home = await tempHome();
  await executable(`${home}/bin/claude`);
  const sys = fakeSystem({
    run: (cmd, args, env) => {
      if (!cmd.endsWith('/claude')) return {};
      if (args[0] === '--version') return { stdout: `${opts.version} (Claude Code)` };
      if (args.join(' ') === 'mcp list' && env?.CLAUDE_CONFIG_DIR) {
        if (!opts.staysSeparate) return { stdout: 'github: npx github-mcp - ✔ Connected' };
        mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true }); // like the real claude
        writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), '{}');
        return { stdout: 'No MCP servers configured. Use `claude mcp add` to add a server.' };
      }
      return {};
    },
  });
  const ctx = ctxFor(home, sys);
  const hub: Hub = { version: 1, profiles: [{ id: 'cc', tool: 'claude-code', label: 'Claude Code · Work', home: '~/cc' }] };
  await write(`${home}/cc/.credentials.json`, '{}');
  const probes = () => sys.calls.filter((c) => c.args.join(' ') === 'mcp list').length;
  return { home, ctx, hub, probes };
}

const versionFinding = (r: Awaited<ReturnType<typeof doctor>>, tool: string) => r.findings.find((f) => f.tool === tool && f.kind === 'untested' && /version|re-checked|check on this Mac/.test(f.message));

describe('Health: newer tool versions', () => {
  it('re-checks a newer Claude Code on this Mac once, and passes it', async () => {
    const { ctx, hub, probes } = await claudeMac({ version: '9.9.9', staysSeparate: true });
    const first = versionFinding(await doctor(ctx, hub), 'claude-code');
    expect(first).toMatchObject({ level: 'ok' });
    expect(first!.message).toMatch(/re-checked on this Mac: an empty CLAUDE_CONFIG_DIR kept its own settings/);
    await doctor(ctx, hub);
    expect(probes()).toBe(1); // remembered for this version
  });

  it('warns when the check on this Mac fails, and tries again next time', async () => {
    const { ctx, hub, probes } = await claudeMac({ version: '9.9.9', staysSeparate: false });
    expect(versionFinding(await doctor(ctx, hub), 'claude-code')).toMatchObject({ level: 'warn' });
    await doctor(ctx, hub);
    expect(probes()).toBe(2);
  });

  it('accepts a newer desktop app in the same major version, and warns on a new major', async () => {
    const home = await tempHome();
    const ctx = ctxFor(home, fakeSystem());
    const plist = (v: string) =>
      write(`${home}/Apps/Claude.app/Contents/Info.plist`, `<plist><dict><key>CFBundleShortVersionString</key><string>${v}</string></dict></plist>`);
    const hub: Hub = { version: 1, profiles: [{ id: 'desk', tool: 'claude-desktop', label: 'Claude · Work', dataDir: '~/desk', app: '~/Apps/Claude.app' }] };
    await plist('4.99.1');
    expect(versionFinding(await doctor(ctx, hub), 'claude-desktop')).toMatchObject({ level: 'ok' });
    await plist('5.0.0');
    expect(versionFinding(await doctor(ctx, hub), 'claude-desktop')).toMatchObject({ level: 'warn' });
  });
});

describe('Health: the ant CLI login fallback', () => {
  async function withAnt(signedIn: boolean) {
    const { home, ctx, hub } = await claudeMac({ version: '2.1.310', staysSeparate: true });
    if (!signedIn) await rm(`${home}/cc/.credentials.json`);
    await write(`${home}/.config/anthropic/active_config`, 'default\n');
    await write(`${home}/.config/anthropic/credentials/default.json`, JSON.stringify({ account_email: 'me@example.com', expires_at: 1_000_000_000, access_token: 'secret' }));
    const f = (await doctor(ctx, hub)).findings.find((x) => x.message.includes('~/.config/anthropic'));
    return f!;
  }

  it('is a note while every Claude profile is signed in', async () => {
    const f = await withAnt(true);
    expect(f.level).toBe('info');
    expect(f.message).toMatch(/ant` CLI's login \(me@example\.com, expired\)/);
    expect(f.message).not.toMatch(/secret/);
  });

  it('warns, naming the profile, once one is signed out', async () => {
    const f = await withAnt(false);
    expect(f.level).toBe('warn');
    expect(f.message).toMatch(/Claude Code · Work is not signed in/);
  });
});
