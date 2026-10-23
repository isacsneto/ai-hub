import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveHub, type Hub, type Profile } from '../src/config.js';
import type { Context } from '../src/context.js';
import { doctor } from '../src/doctor.js';
import { GUARD_PLIST } from '../src/discover.js';
import { addToLibrary, itemPath, saveCatalog, setSharedSetting } from '../src/library.js';
import { reconcile, replaceBlock, type Plan } from '../src/share.js';
import { promote, setSharing } from '../src/sharing-config.js';
import { loadState } from '../src/state.js';
import { takeover, undoTakeover } from '../src/takeover.js';
import { undoLast } from '../src/tx.js';
import { ctxFor, executable, fakeSystem, tempHome, write, type FakeSystem } from './helpers.js';

const statuses = (plan: Plan) => Object.fromEntries(plan.actions.map((a) => [`${a.kind}/${a.name}`, a.status]));

async function setup(extra: Partial<Record<'claude' | 'codex', Partial<Profile>>> = {}) {
  const home = await tempHome();
  const sys = fakeSystem({ run: (cmd) => (cmd === 'git' ? { code: 1 } : {}) });
  const ctx = ctxFor(home, sys);
  await write(`${home}/cw/settings.json`, '{\n  "theme": "dark"\n}\n');
  await write(`${home}/cx/config.toml`, '');
  await write(`${home}/src/review/SKILL.md`, '---\nname: review\ndescription: Review code\n---\nBody v1\n');
  await write(`${home}/src/style.md`, '# Coding style\nUse tabs.\n');
  await write(`${home}/src/deploy.md`, '# Deploy\nv1\n');
  await addToLibrary(ctx, 'skills', `${home}/src/review`);
  await addToLibrary(ctx, 'commands', `${home}/src/deploy.md`);
  await addToLibrary(ctx, 'instructions', `${home}/src/style.md`);
  const hub: Hub = {
    version: 1,
    profiles: [
      { id: 'cw', tool: 'claude-code', label: 'Claude work', home: '~/cw', ...extra.claude } as Profile,
      { id: 'cx', tool: 'codex', label: 'Codex work', home: '~/cx', ...extra.codex } as Profile,
    ],
  };
  await saveHub(ctx, hub);
  const [cw, cx] = hub.profiles as [Profile, Profile];
  return { home, ctx, sys, hub, cw, cx };
}

const share = async (ctx: Context, hub: Hub, kind: Parameters<typeof setSharing>[2], name: string, ids: string[], on = true, opts = {}) =>
  setSharing(ctx, hub, kind, name, ids, on, opts);

describe('managed block', () => {
  it('adds, replaces and removes only its own block', () => {
    const a = replaceBlock('# Mine\n', 'one');
    expect(a).toMatch(/^# Mine\n\n<!-- aihub:begin.*-->\none\n<!-- aihub:end -->\n$/s);
    expect(replaceBlock(a, 'two')).toContain('\ntwo\n');
    expect(replaceBlock(a, undefined)).toBe('# Mine\n');
    expect(replaceBlock('', undefined)).toBe('');
  });
});

describe('skills', () => {
  it('links skills into Claude Code and Codex, and is idempotent', async () => {
    const { home, ctx, hub, cw, cx } = await setup();
    await share(ctx, hub, 'skills', 'review', ['cw', 'cx']);
    expect(statuses(await reconcile(ctx, hub, cw))).toEqual({ 'skills/review': 'done' });
    expect(statuses(await reconcile(ctx, hub, cx))).toEqual({ 'skills/review': 'done' });
    expect(await fs.readlink(`${home}/cw/skills/review`)).toBe(itemPath(ctx, 'skills', 'review'));
    expect(await fs.readlink(`${home}/cx/skills/review`)).toBe(itemPath(ctx, 'skills', 'review'));
    expect(statuses(await reconcile(ctx, hub, cw))).toEqual({ 'skills/review': 'ok' });
    expect(statuses(await reconcile(ctx, hub, cx))).toEqual({ 'skills/review': 'ok' });
  });

  it('copies commands into Codex prompts/, updates stale copies, never overwrites local edits without --force', async () => {
    const { home, ctx, hub, cx } = await setup();
    const local = `${home}/cx/prompts/deploy.md`;
    await share(ctx, hub, 'commands', 'deploy', ['cx']);
    await reconcile(ctx, hub, cx);
    expect((await fs.lstat(local)).isSymbolicLink()).toBe(false);
    await write(itemPath(ctx, 'commands', 'deploy'), '# Deploy\nv2\n');
    const plan = await reconcile(ctx, hub, cx, { dryRun: true });
    expect(plan.actions[0]).toMatchObject({ type: 'update-copy', status: 'pending' });
    await reconcile(ctx, hub, cx);
    expect(await fs.readFile(local, 'utf8')).toContain('v2');

    await write(local, 'edited locally');
    await write(itemPath(ctx, 'commands', 'deploy'), 'v3');
    expect(statuses(await reconcile(ctx, hub, cx))).toEqual({ 'commands/deploy': 'conflict' });
    expect(await fs.readFile(local, 'utf8')).toBe('edited locally');
    expect(statuses(await reconcile(ctx, hub, cx, { force: true }))).toEqual({ 'commands/deploy': 'done' });
    expect(await fs.readFile(local, 'utf8')).toBe('v3');
  });

  it('never replaces a skill the profile already has', async () => {
    const { home, ctx, hub, cw } = await setup();
    await write(`${home}/cw/skills/review/SKILL.md`, 'my own');
    await share(ctx, hub, 'skills', 'review', ['cw']);
    const plan = await reconcile(ctx, hub, cw);
    expect(plan.actions[0]).toMatchObject({ status: 'conflict' });
    expect(await fs.readFile(`${home}/cw/skills/review/SKILL.md`, 'utf8')).toBe('my own');
  });

  it('unsharing removes only what the hub placed and keeps the library', async () => {
    const { home, ctx, hub, cw, cx } = await setup();
    await write(`${home}/cw/skills/mine/SKILL.md`, 'mine');
    await share(ctx, hub, 'skills', 'review', ['cw', 'cx']);
    await reconcile(ctx, hub, cw);
    await reconcile(ctx, hub, cx);
    await share(ctx, hub, 'skills', 'review', ['cw', 'cx'], false);
    expect(statuses(await reconcile(ctx, hub, cw))).toEqual({ 'skills/review': 'done' });
    expect(statuses(await reconcile(ctx, hub, cx))).toEqual({ 'skills/review': 'done' });
    expect(await fs.readdir(`${home}/cw/skills`)).toEqual(['mine']);
    expect(await fs.readdir(`${home}/cx/skills`)).toEqual([]);
    expect(await fs.readFile(itemPath(ctx, 'skills', 'review') + '/SKILL.md', 'utf8')).toContain('Body v1');
    expect((await loadState(ctx, 'cw')).installs).toEqual([]);
  });

  it('undo restores both the files and the hub’s records', async () => {
    const { home, ctx, hub, cx } = await setup();
    await share(ctx, hub, 'skills', 'review', ['cx']);
    await reconcile(ctx, hub, cx);
    await share(ctx, hub, 'skills', 'review', ['cx'], false);
    await reconcile(ctx, hub, cx);
    await undoLast(ctx);
    expect(await fs.readdir(`${home}/cx/skills`)).toEqual(['review']);
    expect((await loadState(ctx, 'cx')).installs.map((r) => r.name)).toEqual(['review']);
    // hub.yaml still says "not shared", so the next apply removes it again: undo is consistent.
    expect(statuses(await reconcile(ctx, hub, cx, { dryRun: true }))).toEqual({ 'skills/review': 'pending' });
  });

  it('rolls back everything when one change fails', async () => {
    const { home, ctx, hub, cw } = await setup();
    await write(`${home}/src/helper.md`, '# helper agent');
    await addToLibrary(ctx, 'agents', `${home}/src/helper.md`);
    await write(`${home}/cw/agents`, 'a file where the agents folder should be');
    await share(ctx, hub, 'skills', 'review', ['cw']);
    await share(ctx, hub, 'agents', 'helper', ['cw']);
    await expect(reconcile(ctx, hub, cw)).rejects.toThrow();
    await expect(fs.lstat(`${home}/cw/skills/review`)).rejects.toThrow();
    expect((await loadState(ctx, 'cw')).installs).toEqual([]);
  });

  it('"all" follows the library; unsharing one item pins the rest', async () => {
    const { home, ctx, hub, cw } = await setup();
    await write(`${home}/src/second/SKILL.md`, '# second');
    await addToLibrary(ctx, 'skills', `${home}/src/second`);
    await share(ctx, hub, 'skills', 'all', ['cw']);
    expect(Object.keys(statuses(await reconcile(ctx, hub, cw))).sort()).toEqual(['skills/review', 'skills/second']);
    await share(ctx, hub, 'skills', 'second', ['cw'], false);
    expect(cw.sharing?.skills).toEqual(['review']);
  });
});

describe('whole-folder links (cpm)', () => {
  it('blocks until --detach, then swaps the link for a real folder; undo restores it', async () => {
    const { home, ctx, hub, cw } = await setup();
    await write(`${home}/other/skills/theirs/SKILL.md`, 'theirs');
    await fs.symlink(`${home}/other/skills`, `${home}/cw/skills`);
    await share(ctx, hub, 'skills', 'review', ['cw']);
    const blocked = await reconcile(ctx, hub, cw);
    expect(blocked.actions[0]).toMatchObject({ status: 'blocked' });
    expect(blocked.actions[0]!.reason).toMatch(/--detach/);
    expect(await fs.readdir(`${home}/other/skills`)).toEqual(['theirs']);

    const plan = await reconcile(ctx, hub, cw, { detach: true });
    expect(plan.actions.map((a) => `${a.type}:${a.status}`)).toEqual(['detach-folder:done', 'link:done']);
    expect((await fs.lstat(`${home}/cw/skills`)).isSymbolicLink()).toBe(false);
    expect(await fs.readdir(`${home}/cw/skills`)).toEqual(['review']);
    expect(await fs.readdir(`${home}/other/skills`)).toEqual(['theirs']);

    const undone = await undoLast(ctx);
    expect(undone?.problems).toEqual([]);
    expect(await fs.readlink(`${home}/cw/skills`)).toBe(`${home}/other/skills`);
  });
});

describe('instructions and settings', () => {
  it('imports instructions into CLAUDE.md and inlines them into AGENTS.md, keeping user text', async () => {
    const { home, ctx, hub, cw, cx } = await setup();
    await write(`${home}/cw/CLAUDE.md`, '# My notes\n');
    await share(ctx, hub, 'instructions', 'style', ['cw', 'cx']);
    await reconcile(ctx, hub, cw);
    await reconcile(ctx, hub, cx);
    const claudeMd = await fs.readFile(`${home}/cw/CLAUDE.md`, 'utf8');
    expect(claudeMd).toContain('# My notes');
    expect(claudeMd).toContain(`@${itemPath(ctx, 'instructions', 'style')}`);
    expect(await fs.readFile(`${home}/cx/AGENTS.md`, 'utf8')).toContain('Use tabs.');
    expect(statuses(await reconcile(ctx, hub, cw))).toEqual({ 'instructions/style': 'ok' });

    await share(ctx, hub, 'instructions', 'style', ['cw'], false);
    await reconcile(ctx, hub, cw);
    expect(await fs.readFile(`${home}/cw/CLAUDE.md`, 'utf8')).toBe('# My notes\n');
  });

  it('writes approved settings keys, respects the profile’s own values, and removes only unchanged keys', async () => {
    const { home, ctx, hub, cw } = await setup();
    await expect(setSharedSetting(ctx, 'env', {})).rejects.toThrow(/can't be shared/);
    await setSharedSetting(ctx, 'statusLine', { type: 'command', command: 'echo hi' });
    await setSharedSetting(ctx, 'model', 'opus');
    await write(`${home}/cw/settings.json`, JSON.stringify({ theme: 'dark', model: 'sonnet' }));
    await share(ctx, hub, 'settings', 'statusLine', ['cw']);
    await share(ctx, hub, 'settings', 'model', ['cw']);
    expect(statuses(await reconcile(ctx, hub, cw))).toEqual({ 'settings/statusLine': 'done', 'settings/model': 'conflict' });
    const json = JSON.parse(await fs.readFile(`${home}/cw/settings.json`, 'utf8'));
    expect(json).toEqual({ theme: 'dark', model: 'sonnet', statusLine: { type: 'command', command: 'echo hi' } });

    await share(ctx, hub, 'settings', 'statusLine', ['cw'], false);
    await share(ctx, hub, 'settings', 'model', ['cw'], false);
    await reconcile(ctx, hub, cw);
    expect(JSON.parse(await fs.readFile(`${home}/cw/settings.json`, 'utf8'))).toEqual({ theme: 'dark', model: 'sonnet' });
  });
});

describe('plugins', () => {
  async function pluginSetup() {
    const s = await setup();
    await executable(`${s.home}/bin/claude`);
    const mkt = `${s.home}/cw/plugins/marketplaces/acme`;
    await write(
      `${mkt}/.claude-plugin/marketplace.json`,
      JSON.stringify({ plugins: [{ name: 'quiet', source: './quiet' }, { name: 'loud', source: './loud' }, { name: 'remote', source: { source: 'github', repo: 'x/y' } }] }),
    );
    await write(`${mkt}/quiet/.claude-plugin/plugin.json`, '{}');
    await write(`${mkt}/loud/.mcp.json`, JSON.stringify({ mcpServers: { github: {}, slack: {} } }));
    await write(`${s.home}/cw/plugins/known_marketplaces.json`, JSON.stringify({ acme: {} }));
    await saveCatalog(s.ctx, [{ id: 'quiet@acme' }, { id: 'loud@acme' }, { id: 'remote@acme' }, { id: 'new@other', source: 'other/repo' }]);
    return s;
  }
  const pluginCalls = (sys: FakeSystem) => sys.calls.filter((c) => c.args[0] === 'plugin').map((c) => c.args.join(' '));

  it('holds back plugins that add (or might add) MCP servers until approved', async () => {
    const { ctx, sys, hub, cw, home } = await pluginSetup();
    for (const id of ['quiet@acme', 'loud@acme', 'remote@acme']) await share(ctx, hub, 'plugins', id, ['cw']);
    const plan = await reconcile(ctx, hub, cw);
    expect(statuses(plan)).toEqual({ 'plugins/quiet@acme': 'done', 'plugins/loud@acme': 'blocked', 'plugins/remote@acme': 'blocked' });
    expect(plan.actions[1]!.reason).toMatch(/github, slack/);
    expect(pluginCalls(sys)).toEqual(['plugin install quiet@acme --scope user']);
    expect(sys.calls.find((c) => c.args[0] === 'plugin')!.env?.CLAUDE_CONFIG_DIR).toBe(`${home}/cw`);

    await share(ctx, hub, 'plugins', 'loud@acme', ['cw'], true, { allowMcp: true });
    expect(statuses(await reconcile(ctx, hub, cw))['plugins/loud@acme']).toBe('done');
  });

  it('adds a missing marketplace first, and uninstalls on unshare unless it was there before', async () => {
    const { ctx, sys, hub, cw, home } = await pluginSetup();
    await share(ctx, hub, 'plugins', 'new@other', ['cw'], true, { allowMcp: true });
    await reconcile(ctx, hub, cw);
    expect(pluginCalls(sys)).toEqual(['plugin marketplace add other/repo', 'plugin install new@other --scope user']);

    await write(`${home}/cw/plugins/installed_plugins.json`, JSON.stringify({ plugins: { 'new@other': [{}], 'quiet@acme': [{}] } }));
    await share(ctx, hub, 'plugins', 'quiet@acme', ['cw']);
    expect(statuses(await reconcile(ctx, hub, cw))['plugins/quiet@acme']).toBe('done'); // adopted, not reinstalled
    await share(ctx, hub, 'plugins', 'new@other', ['cw'], false);
    await share(ctx, hub, 'plugins', 'quiet@acme', ['cw'], false);
    await reconcile(ctx, hub, cw);
    expect(pluginCalls(sys).slice(2)).toEqual(['plugin uninstall new@other']);
  });

  it('reports plugins as unsupported for Codex', async () => {
    const { ctx, hub, cx } = await pluginSetup();
    await share(ctx, hub, 'plugins', 'quiet@acme', ['cx']);
    expect(statuses(await reconcile(ctx, hub, cx))).toEqual({ 'plugins/quiet@acme': 'unsupported' });
  });
});

describe('ownership', () => {
  it('leaves folders managed by another tool alone unless forced', async () => {
    const { home, ctx, hub, cw } = await setup({ claude: { managedBy: 'cpm' } });
    await share(ctx, hub, 'skills', 'review', ['cw']);
    expect(statuses(await reconcile(ctx, hub, cw))).toEqual({ 'skills/review': 'blocked' });
    await expect(fs.lstat(`${home}/cw/skills/review`)).rejects.toThrow();
    expect(statuses(await reconcile(ctx, hub, cw, { force: true }))).toEqual({ 'skills/review': 'done' });
  });

  it('promotes a profile’s own skill into the library and links it back', async () => {
    const { home, ctx, hub } = await setup();
    await write(`${home}/cw/skills/local/SKILL.md`, '# local skill');
    await promote(ctx, hub, 'cw', 'skills', 'local');
    expect(await fs.readlink(`${home}/cw/skills/local`)).toBe(itemPath(ctx, 'skills', 'local'));
    expect(await fs.readFile(`${itemPath(ctx, 'skills', 'local')}/SKILL.md`, 'utf8')).toBe('# local skill');
    expect(hub.profiles[0]!.sharing?.skills).toEqual(['local']);
  });

  it('takeover stops the guard and clears managedBy; undo puts both back', async () => {
    const { home, ctx, sys, hub } = await setup({ claude: { managedBy: 'claude-account-guard' } });
    await write(path.join(home, GUARD_PLIST), '<plist/>');
    expect((await takeover(ctx, hub, { dryRun: true })).steps).toHaveLength(2);
    await takeover(ctx, hub);
    await expect(fs.stat(path.join(home, GUARD_PLIST))).rejects.toThrow();
    expect(hub.profiles[0]!.managedBy).toBeUndefined();
    expect(sys.calls.some((c) => c.args[0] === 'bootout')).toBe(true);
    await undoTakeover(ctx, hub);
    expect(await fs.readFile(path.join(home, GUARD_PLIST), 'utf8')).toBe('<plist/>');
    expect(hub.profiles[0]!.managedBy).toBe('claude-account-guard');
  });

  it('doctor flags login tokens set for every app via launchd, without showing them', async () => {
    const home = await tempHome();
    const sys = fakeSystem({
      run: (cmd, args) => (cmd === '/bin/launchctl' && args[1] === 'CLAUDE_CODE_OAUTH_TOKEN' ? { stdout: 'sk-secret-value\n' } : {}),
    });
    const report = await doctor(ctxFor(home, sys), { version: 1, profiles: [] });
    const f = report.findings.find((x) => x.message.startsWith('CLAUDE_CODE_OAUTH_TOKEN'));
    expect(f).toMatchObject({ level: 'error', kind: 'isolation' });
    expect(JSON.stringify(report)).not.toContain('sk-secret-value');
  });

  it('doctor warns that unsigned Claude profiles fall back to the shared Anthropic profile', async () => {
    const { home, ctx, hub } = await setup();
    await write(`${home}/.config/anthropic/credentials/default.json`, '{"token":"secret"}');
    await write(`${home}/.config/anthropic/active_config`, 'work\n');
    const report = await doctor(ctx, hub);
    const f = report.findings.find((x) => x.message.includes('~/.config/anthropic'));
    expect(f).toMatchObject({ level: 'warn', kind: 'isolation' });
    expect(f!.message).toContain('active: work');
    expect(JSON.stringify(report)).not.toContain('secret');
  });

  it('doctor reports sharing changes that are not applied yet', async () => {
    const { ctx, hub } = await setup();
    await share(ctx, hub, 'skills', 'review', ['cw']);
    const report = await doctor(ctx, hub, { only: 'cw' });
    expect(report.findings).toContainEqual(expect.objectContaining({ profile: 'cw', hint: 'aihub apply cw' }));
  });
});
