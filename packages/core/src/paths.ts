import os from 'node:os';
import path from 'node:path';

export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/** Absolute, normalized path. Relative paths are rejected: hub.yaml must be unambiguous. */
export function resolvePath(p: string, home: string): string {
  const expanded = expandHome(p.trim(), home);
  if (!path.isAbsolute(expanded)) {
    throw new Error(`Path must be absolute or start with ~/: ${p}`);
  }
  return path.normalize(expanded).replace(/(.)\/+$/, '$1');
}

/** Inverse of expandHome, for storing readable paths in hub.yaml and printing. */
export function contractHome(p: string, home: string): string {
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~/' + p.slice(home.length + 1);
  return p;
}

export function defaultHome(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? os.homedir();
}
