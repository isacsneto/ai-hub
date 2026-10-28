import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { browser } from '../src/adapters/browser.js';
import { claudeDesktop } from '../src/adapters/claude-desktop.js';
import { codexDesktop } from '../src/adapters/codex-desktop.js';
import { cursor } from '../src/adapters/cursor.js';
import { cleanLabel, parseHub, type Hub } from '../src/config.js';
import { discover } from '../src/discover.js';
import { sessionScript } from '../src/launchers.js';
import { shellInit } from '../src/shell.js';
import { ctxFor, executable, fakeSystem, tempHome, write } from './helpers.js';

const sh = promisify(execFile);

describe('apps opened with `open`', () => {
  it("don't inherit the caller's account variables or ELECTRON_RUN_AS_NODE", async () => {
    const home = await tempHome();
    const app = `${home}/Apps/X.app`;
    await write(`${app}/Contents/Info.plist`, '<plist><dict></dict></plist>');
    const ctx = ctxFor(home, fakeSystem(), {
      CLAUDE_CONFIG_DIR: '/other', ANTHROPIC_API_KEY: 'k', CODEX_HOME: '/other', OPENAI_API_KEY: 'k',
      ELECTRON_RUN_AS_NODE: '1', AIHUB_PROFILE: 'x', KEEP: 'yes',
    });
    const hub: Hub = { version: 1, profiles: [{ id: 'c', tool: 'claude-code', label: 'c', home: '~/.claude' }] };
    const specs = [
      await claudeDesktop.launchSpec(ctx, hub, { id: 'd', tool: 'claude-desktop', label: 'd', dataDir: '~/d', codeProfile: 'c', app }, []),
      await codexDesktop.launchSpec(ctx, hub, { id: 'g', tool: 'codex-desktop', label: 'g', codexHome: '~/.codex', app }, []),
      await cursor.launchSpec(ctx, hub, { id: 'u', tool: 'cursor', label: 'u', dataDir: '~/u', homeMode: 'shared', app }, []),
      await browser.launchSpec(ctx, hub, { id: 'b', tool: 'browser', label: 'b', browser: 'chrome', url: 'https://claude.ai', dataDir: '~/b', appWindow: true }, []),
    ];
    for (const spec of specs) {
      expect(Object.keys(spec.env).sort()).toEqual(expect.arrayContaining(['KEEP']));
      for (const k of ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CODEX_HOME', 'OPENAI_API_KEY', 'ELECTRON_RUN_AS_NODE', 'AIHUB_PROFILE']) {
        expect(spec.env).not.toHaveProperty(k);
      }
    }
  });
});

describe('labels', () => {
  it('rejects line breaks in hub.yaml and cleans imported ones', () => {
    expect(() => parseHub('version: 1\nprofiles:\n  - {id: a, tool: claude-code, label: "Work\\ntouch x", home: ~/a}\n', 'hub.yaml')).toThrow(/one line/);
    expect(cleanLabel('  Work\n\ttouch x  ')).toBe('Work touch x');
  });

  it('keeps labels out of generated shell code', async () => {
    const home = await tempHome();
    await executable(`${home}/bin/claude`);
    const ctx = ctxFor(home);
    const hub: Hub = { version: 1, profiles: [{ id: 'w', tool: 'claude-code', label: `Work "$(touch ${home}/PWNED)"`, home: '~/w' }] };
    const script = await sessionScript(ctx, hub, hub.profiles[0]!);
    await write(`${home}/s.sh`, script.replace(/^exec .*$/m, 'exit 0'));
    await sh('/bin/bash', [`${home}/s.sh`], { env: { HOME: home, PATH: '/usr/bin:/bin' } });
    await expect(fs.access(`${home}/PWNED`)).rejects.toThrow();
  });
});

describe('discover', () => {
  it('gives every candidate its own id', async () => {
    const home = await tempHome();
    await write(`${home}/.claude/settings.json`, '{}');
    await write(`${home}/.claude-profiles/config.toml`, 'version = 1\n[profiles.default]\n');
    await write(`${home}/.claude-profiles/default/settings.json`, '{}');
    const found = await discover(ctxFor(home), { version: 1, profiles: [] });
    const ids = found.filter((c) => c.profile.tool === 'claude-code').map((c) => c.profile.id);
    expect(ids).toEqual(['claude-default', 'claude-default-2']);
  });
});

describe('shell integration', () => {
  it('drops the previous folder’s Claude account when the next folder uses Codex', async () => {
    const home = await tempHome();
    // A stand-in `aihub env` that prints what the real one would.
    await write(
      `${home}/bin/aihub`,
      '#!/bin/sh\ncase "$2" in cw) echo "export CLAUDE_CONFIG_DIR=$HOME/.cw; export AIHUB_PROFILE=cw";; cx) echo "export CODEX_HOME=$HOME/.cx; export AIHUB_PROFILE=cx";; esac\n',
    );
    await fs.chmod(`${home}/bin/aihub`, 0o755);
    await write(`${home}/a/.aihub-profile`, 'cw\n');
    await write(`${home}/b/.aihub-profile`, 'cx\n');
    const hub: Hub = { version: 1, profiles: [] };
    await write(`${home}/init.sh`, shellInit(hub, 'bash'));
    const { stdout } = await sh(
      '/bin/bash',
      ['-c', `. ${home}/init.sh; cd ${home}/a; _aihub_auto; cd ${home}/b; _aihub_auto; echo "C=\${CLAUDE_CONFIG_DIR:-none} X=\${CODEX_HOME:-none}"`],
      { env: { HOME: home, PATH: `${home}/bin:/usr/bin:/bin` } },
    );
    expect(stdout.trim()).toBe(`C=none X=${home}/.cx`);
  });
});
