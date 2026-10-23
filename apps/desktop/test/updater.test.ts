import { describe, expect, it } from 'vitest';
import { checksumFor, installTarget, pickAssets, versionOf, zipName, type Release } from '../src/main/updater';

const asset = (name: string) => ({ name, browser_download_url: `https://github.com/x/y/releases/download/v0.2.0/${name}`, size: 1 });

describe('updater', () => {
  const release: Release = {
    tag_name: 'v0.2.0',
    html_url: 'https://github.com/x/y/releases/tag/v0.2.0',
    assets: [asset('AI-Hub-0.2.0-arm64-mac.zip'), asset('AI-Hub-0.2.0-x64-mac.zip'), asset('SHA256SUMS.txt')],
  };

  it('picks the zip for this architecture together with the checksum file', () => {
    expect(versionOf('v0.2.0')).toBe('0.2.0');
    expect(pickAssets(release, 'arm64')?.zip.name).toBe(zipName('0.2.0', 'arm64'));
    expect(pickAssets(release, 'x64')?.zip.name).toBe('AI-Hub-0.2.0-x64-mac.zip');
    expect(pickAssets({ ...release, assets: release.assets.slice(0, 1) }, 'arm64')).toBeUndefined();
  });

  it('reads `shasum -a 256` output and matches exact file names only', () => {
    const sums = `${'a'.repeat(64)}  AI-Hub-0.2.0-arm64-mac.zip\n${'b'.repeat(64)} *AI-Hub-0.2.0-x64-mac.zip\n`;
    expect(checksumFor(sums, 'AI-Hub-0.2.0-arm64-mac.zip')).toBe('a'.repeat(64));
    expect(checksumFor(sums, 'AI-Hub-0.2.0-x64-mac.zip')).toBe('b'.repeat(64));
    expect(checksumFor(sums, 'AI-Hub-0.2.0-arm64-mac.zip.evil')).toBeUndefined();
  });

  it('only updates a real, non-translocated app bundle', () => {
    expect(installTarget('/Applications/AI-Hub.app/Contents/MacOS/AI-Hub')).toEqual({ app: '/Applications/AI-Hub.app' });
    expect(installTarget('/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')).toEqual({
      app: '/repo/node_modules/electron/dist/Electron.app',
    });
    expect(installTarget('/usr/local/bin/node')).toHaveProperty('problem');
    expect(installTarget('/private/var/folders/x/AppTranslocation/1234/d/AI-Hub.app/Contents/MacOS/AI-Hub')).toHaveProperty('problem');
  });
});
