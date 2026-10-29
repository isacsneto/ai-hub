import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { loadHub, saveHub, type Hub } from '../src/config.js';
import { createAccount } from '../src/new-account.js';
import { accountOf } from '../src/registry.js';
import { ctxFor, fakeSystem, tempHome } from './helpers.js';

async function setup() {
  const home = await tempHome();
  const ctx = ctxFor(home, fakeSystem());
  const hub: Hub = { version: 1, profiles: [{ id: 'claude-acme', tool: 'claude-code', label: 'Claude Code · Acme', home: '~/acme', icon: { color: '#3B7DD8' } }] };
  await saveHub(ctx, hub);
  return { home, ctx, hub };
}

describe('new accounts from the app', () => {
  it('creates Claude Code plus the desktop app on its folder, as one account', async () => {
    const { home, ctx, hub } = await setup();
    const made = await createAccount(ctx, hub, { kind: 'claude', name: 'Acme', app: true });
    // "claude-acme" is taken, so both get the next free id.
    expect(made.map((p) => [p.id, p.label])).toEqual([
      ['claude-acme-2', 'Claude Code · Acme'],
      ['claude-desktop-acme', 'Claude · Acme'],
    ]);
    expect(made[1]).toMatchObject({ codeProfile: 'claude-acme-2', dataDir: '~/.aihub/profiles/claude-desktop-acme' });
    expect(made[0]!.icon).toEqual({ color: '#5DCAA5', badge: 'A' }); // first unused color
    await fs.access(`${home}/.aihub/profiles/claude-acme-2`);
    const saved = await loadHub(ctx);
    expect(saved.profiles.map((p) => accountOf(ctx, saved, p))).toEqual(['claude-acme', 'claude-acme-2', 'claude-acme-2']);
  });

  it('gives the ChatGPT/Codex app the Codex profile folder', async () => {
    const { ctx, hub } = await setup();
    const made = await createAccount(ctx, hub, { kind: 'codex', name: 'Side project', app: true });
    expect(made.map((p) => p.id)).toEqual(['codex-side-project', 'chatgpt-side-project']);
    expect(made[1]).toMatchObject({ tool: 'codex-desktop', codexHome: '~/.aihub/profiles/codex-side-project', label: 'ChatGPT · Side Project' });
  });

  it('creates only the terminal profile when the app is off, and web accounts per site', async () => {
    const { ctx, hub } = await setup();
    expect((await createAccount(ctx, hub, { kind: 'claude', name: 'Solo', app: false })).map((p) => p.tool)).toEqual(['claude-code']);
    const [web] = await createAccount(ctx, hub, { kind: 'web', name: 'Work', url: 'https://chatgpt.com', browser: 'chrome' });
    expect(web).toMatchObject({ id: 'web-work', label: 'ChatGPT · Work', browser: 'chrome', appWindow: true });
  });

  it('refuses an empty name or a site that is not a web address', async () => {
    const { ctx, hub } = await setup();
    await expect(createAccount(ctx, hub, { kind: 'cursor', name: '  ', isolatedHome: false })).rejects.toThrow(/name/);
    await expect(createAccount(ctx, hub, { kind: 'web', name: 'X', url: 'file:///etc/passwd', browser: 'chrome' })).rejects.toThrow(/web address/);
    expect((await loadHub(ctx)).profiles).toHaveLength(1);
  });
});
