import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hubFile, loadHub, parseHub, saveHub, type Hub } from '../src/config.js';
import { contractHome, expandHome, resolvePath } from '../src/paths.js';
import { ctxFor, tempHome } from './helpers.js';

describe('paths', () => {
  it('expands, normalizes and contracts ~', () => {
    expect(expandHome('~/x', '/h')).toBe('/h/x');
    expect(resolvePath('~/a//b/', '/h')).toBe('/h/a/b');
    expect(contractHome('/h/a', '/h')).toBe('~/a');
    expect(contractHome('/other', '/h')).toBe('/other');
  });

  it('rejects relative paths so hub.yaml is unambiguous', () => {
    expect(() => resolvePath('profiles/x', '/h')).toThrow(/absolute/);
  });
});

describe('hub.yaml', () => {
  const hub: Hub = {
    version: 1,
    profiles: [
      { id: 'claude-work', tool: 'claude-code', label: 'Work', home: '~/.claude-profiles/work' },
      { id: 'desk-work', tool: 'claude-desktop', label: 'Desk', dataDir: '~/d', codeProfile: 'claude-work' },
    ],
  };

  it('round-trips and keeps a backup of the previous file', async () => {
    const ctx = ctxFor(await tempHome());
    expect(await loadHub(ctx)).toEqual({ version: 1, profiles: [] });
    await saveHub(ctx, hub);
    await saveHub(ctx, { ...hub, profiles: hub.profiles.slice(0, 1) });
    expect((await loadHub(ctx)).profiles).toHaveLength(1);
    const backups = await fs.readdir(path.join(ctx.hubDir, 'backups', 'hub-yaml'));
    expect(backups).toHaveLength(1);
    expect((await fs.stat(hubFile(ctx))).mode & 0o777).toBe(0o600);
  });

  it('rejects duplicate ids', () => {
    const text = JSON.stringify({ version: 1, profiles: [hub.profiles[0], hub.profiles[0]] });
    expect(() => parseHub(text)).toThrow(/duplicate id/);
  });

  it('rejects a codeProfile that is not a claude-code profile', () => {
    const text = JSON.stringify({ version: 1, profiles: [{ ...hub.profiles[1], codeProfile: 'nope' }] });
    expect(() => parseHub(text)).toThrow(/not a claude-code profile/);
  });

  it('rejects unknown keys (typos would otherwise be ignored silently)', () => {
    const text = JSON.stringify({ version: 1, profiles: [{ ...hub.profiles[0], hoem: '~/x' }] });
    expect(() => parseHub(text)).toThrow(/hoem/);
  });
});
