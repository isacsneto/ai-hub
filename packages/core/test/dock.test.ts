import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { realSystem, type RunResult } from '../src/context.js';
import { addToDock, dockApps, removeFromDock } from '../src/dock.js';
import { ctxFor, tempHome, write } from './helpers.js';

const tile = (url: string) =>
  `<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>${url}</string><key>_CFURLStringType</key><integer>15</integer></dict><key>file-label</key><string>x</string></dict><key>tile-type</key><string>file-tile</string></dict>`;

/** Real PlistBuddy and plutil on a fake Dock file: defaults export/import read and write it, killall is skipped. */
async function fakeDock() {
  const home = await tempHome();
  const dock = await write(
    `${home}/dock.plist`,
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>autohide</key><true/><key>persistent-apps</key><array>${tile('file:///Applications/Safari.app/')}${tile('file:///Applications/Google%20Chrome.app/')}</array></dict></plist>\n`,
  );
  const restarts: string[] = [];
  const ok: RunResult = { code: 0, stdout: '', stderr: '' };
  const ctx = ctxFor(home, {
    ...realSystem,
    async run(cmd, args, opts) {
      if (cmd === '/usr/bin/defaults' && args[0] === 'export') return fs.copyFile(dock, args[2]!).then(() => ok);
      if (cmd === '/usr/bin/defaults' && args[0] === 'import') return fs.copyFile(args[2]!, dock).then(() => ok);
      if (cmd === '/usr/bin/killall') return restarts.push(args[0]!), ok;
      return realSystem.run(cmd, args, opts);
    },
  });
  return { ctx, dock, restarts };
}

describe('Dock tiles for launchers', () => {
  it('adds once, follows a rename in place, and removes cleanly', async () => {
    const { ctx, dock, restarts } = await fakeDock();
    const original = await fs.readFile(dock, 'utf8');
    const a = '/Users/me/Applications/AI-Hub/Claude Code · Work.app';
    const b = '/Users/me/Applications/AI-Hub/Claude Code · Job.app';
    expect(await dockApps(ctx)).toEqual(['/Applications/Safari.app', '/Applications/Google Chrome.app']);

    expect(await addToDock(ctx, a)).toBe(true);
    expect(await addToDock(ctx, a)).toBe(false); // already there
    expect(await dockApps(ctx)).toEqual(['/Applications/Safari.app', '/Applications/Google Chrome.app', a]);
    expect(restarts).toEqual(['Dock']);

    expect(await removeFromDock(ctx, a, b)).toBe(true);
    expect(await dockApps(ctx)).toEqual(['/Applications/Safari.app', '/Applications/Google Chrome.app', b]);

    expect(await removeFromDock(ctx, b)).toBe(true);
    expect(await removeFromDock(ctx, b)).toBe(false);
    expect(await dockApps(ctx)).toEqual(['/Applications/Safari.app', '/Applications/Google Chrome.app']);
    // Other settings come back untouched.
    expect((await fs.readFile(dock, 'utf8')).includes('<key>autohide</key>')).toBe(true);
    expect(original.includes('Google%20Chrome')).toBe(true);
  });
});
