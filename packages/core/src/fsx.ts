import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function ensureDir(p: string, mode = 0o700): Promise<void> {
  await fs.mkdir(p, { recursive: true, mode });
}

/** Write via temp file + rename so a crash never leaves a half-written file. */
export async function atomicWrite(file: string, data: string, mode = 0o600): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await fs.writeFile(tmp, data, { mode });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Parse a JSON file, or undefined when it is missing. Parse errors name the file but never echo
 * its contents, since tool config files can hold secrets.
 */
export async function readJsonIfExists(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  if (!text.trim()) return undefined; // e.g. Cursor ships an empty ~/.cursor/mcp.json
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Could not parse JSON in ${file}`);
  }
}

export async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

export interface DirEntryInfo {
  name: string;
  /** Raw link target when the entry is a symlink. */
  linkTarget?: string;
  /** Resolved absolute target when the entry is a symlink. */
  resolvedTarget?: string;
  broken: boolean;
  isDir: boolean;
}

/** Non-hidden entries of a directory, with symlink details. Missing directory → []. */
export async function listEntries(dir: string): Promise<DirEntryInfo[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: DirEntryInfo[] = [];
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const lst = await fs.lstat(full);
    if (lst.isSymbolicLink()) {
      const linkTarget = await fs.readlink(full);
      const resolvedTarget = path.resolve(dir, linkTarget);
      let isDir = false;
      let broken = false;
      try {
        isDir = (await fs.stat(full)).isDirectory();
      } catch {
        broken = true;
      }
      out.push({ name, linkTarget, resolvedTarget, broken, isDir });
    } else {
      out.push({ name, broken: false, isDir: lst.isDirectory() });
    }
  }
  return out;
}

/** Where a path points if it is itself a symlink (e.g. a whole skills/ dir), else undefined. */
export async function symlinkTargetOf(p: string): Promise<string | undefined> {
  try {
    const lst = await fs.lstat(p);
    if (!lst.isSymbolicLink()) return undefined;
    return path.resolve(path.dirname(p), await fs.readlink(p));
  } catch {
    return undefined;
  }
}
