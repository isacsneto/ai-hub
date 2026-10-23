import path from 'node:path';
import type { Context } from './context.js';
import { atomicWrite, readJsonIfExists } from './fsx.js';
import type { ShareKind } from './library.js';

/**
 * What the hub put into a profile. Kept in ~/.aihub/state/<id>.json, not in the tool folder,
 * and it's the only basis for ever removing something: no record → not ours → never touched.
 */
export interface InstallRecord {
  kind: ShareKind;
  name: string;
  strategy: 'symlink' | 'copy' | 'block' | 'json-key' | 'plugin-cli';
  path: string;
  /** Library content hash at install time (copies, blocks) or hash of the value we wrote (settings). */
  hash?: string;
  installedAt: string;
}

export interface ProfileState {
  version: 1;
  installs: InstallRecord[];
}

export const stateFile = (ctx: Context, id: string) => path.join(ctx.hubDir, 'state', `${id}.json`);

export async function loadState(ctx: Context, id: string): Promise<ProfileState> {
  return ((await readJsonIfExists(stateFile(ctx, id))) as ProfileState | undefined) ?? { version: 1, installs: [] };
}

export async function saveState(ctx: Context, id: string, state: ProfileState): Promise<void> {
  await atomicWrite(stateFile(ctx, id), JSON.stringify(state, null, 2) + '\n');
}

export const recordKey = (r: Pick<InstallRecord, 'kind' | 'name'>) => `${r.kind}/${r.name}`;
