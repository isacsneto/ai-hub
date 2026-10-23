import type { Profile, ToolId } from '../config.js';
import { browser } from './browser.js';
import { claudeCode } from './claude-code.js';
import { claudeDesktop } from './claude-desktop.js';
import { codexDesktop } from './codex-desktop.js';
import { codex } from './codex.js';
import { cursor } from './cursor.js';
import type { ToolAdapter } from './types.js';

const ADAPTERS = {
  'claude-code': claudeCode,
  'claude-desktop': claudeDesktop,
  codex,
  'codex-desktop': codexDesktop,
  cursor,
  browser,
} satisfies Record<ToolId, ToolAdapter<never>>;

export function adapterFor<P extends Profile>(p: P): ToolAdapter<P> {
  return ADAPTERS[p.tool] as unknown as ToolAdapter<P>;
}

export function adapterForTool(tool: ToolId): ToolAdapter<Profile> {
  return ADAPTERS[tool] as unknown as ToolAdapter<Profile>;
}

export { browser, claudeCode, claudeDesktop, codex, codexDesktop, cursor };
export { BROWSER_APPS } from './browser.js';
export { defaultCursorDataDir } from './cursor.js';
export { claudeKeychainService } from './claude-code.js';
export { defaultDesktopDataDir } from './claude-desktop.js';
export { TESTED } from './tested.js';
export type * from './types.js';
