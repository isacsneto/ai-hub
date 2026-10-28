import type { Profile, ToolId } from '../config.js';
import type { Evidence, TestedCapabilities } from './types.js';

/**
 * What has actually been verified, per tool and version (Phase 0, run on macOS 15 / Darwin 24.6).
 * `doctor` warns when an installed version is newer than everything listed here.
 * Update this after re-running scripts/phase0-remaining.sh.
 */
export const TESTED: Record<ToolId, TestedCapabilities> = {
  'claude-code': {
    versions: ['2.1.309'],
    date: '2026-10-23',
    isolatedLogin: 'tested',
    isolatedMcp: 'tested',
    isolatedHistory: 'assumed',
    skillShare: 'symlink',
    globalSkillDirs: [],
    notes: [
      'Keychain item is "Claude Code-credentials" for ~/.claude, and "Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[0:8]>" otherwise. Moving a profile folder logs it out.',
      'Symlinked skill folders load (~/.claude/skills/* → ~/.agents/skills/*).',
      '~/.agents/skills is not read directly: find-skills there does not load.',
      '`claude auth status` reports loggedIn (oauth_token) for empty folders because of the shared ~/.config/anthropic profile; a real request from such a folder fails with "Login expired" while that profile is expired (2026-10-23).',
      'Folders without their own login fall back to ~/.config/anthropic; doctor warns when it holds credentials.',
    ],
  },
  codex: {
    versions: ['0.163.0-alpha.11.1'],
    date: '2026-10-23',
    isolatedLogin: 'tested',
    isolatedMcp: 'tested',
    isolatedHistory: 'assumed',
    skillShare: 'symlink',
    globalSkillDirs: [
      {
        path: '~/.agents/skills',
        evidence: 'tested',
        note: 'Codex loads every skill here in every profile, whatever CODEX_HOME is.',
      },
    ],
    notes: [
      'Fresh CODEX_HOME reports "Not logged in"; MCP added there stays in its own config.toml.',
      'A symlinked skill folder in CODEX_HOME/skills loads (Phase 0, 2026-10-23).',
      'MCP OAuth storage: no Keychain items found; mcp_oauth_credentials_store is unset (tool default).',
    ],
  },
  'claude-desktop': {
    versions: ['3.6556.2'],
    date: '2026-10-23',
    isolatedLogin: 'tested',
    isolatedMcp: 'tested',
    isolatedHistory: 'tested',
    skillShare: 'unsupported',
    globalSkillDirs: [],
    notes: [
      'Separate --user-data-dir per account works (verified with a second Desktop instance in daily use).',
      'The Code tab only stays separate when launched with --env CLAUDE_CONFIG_DIR=<its claude-code profile>.',
      'Desktop skills and connectors live on the claude.ai account, not in files.',
    ],
  },
  'codex-desktop': {
    versions: ['26.1016.61520'],
    date: '2026-10-23',
    isolatedLogin: 'tested',
    isolatedMcp: 'assumed',
    isolatedHistory: 'assumed',
    skillShare: 'unsupported',
    globalSkillDirs: [],
    notes: [
      'ChatGPT.app is the Codex app (com.openai.codex) and reads ~/.codex; its account is the Codex login.',
      'A second instance with --env CODEX_HOME=<empty folder> opens signed out (Phase 0, 2026-10-23).',
      'Share skills through the matching codex profile; the app reads the same folder.',
    ],
  },
  cursor: {
    versions: ['3.27.6'],
    date: '2026-10-23',
    isolatedLogin: 'assumed',
    isolatedMcp: 'no',
    isolatedHistory: 'assumed',
    skillShare: 'unsupported',
    globalSkillDirs: [{ path: '~/.cursor', evidence: 'tested', note: 'Global mcp.json, skills and plugins: shared by every Cursor profile unless homeMode is "isolated".' }],
    notes: [
      'Login lives in User/globalStorage/state.vscdb (cursorAuth/*), inside --user-data-dir.',
      'The ~/.cursor folder is built from os.homedir() ($HOME), so --user-data-dir does not move it.',
      'homeMode "isolated" sets HOME for Cursor and links .gitconfig/.ssh/shell files and ~/Library/Keychains in (experimental).',
      'Without the Keychains link Cursor fails with "A keychain cannot be found to store Cursor key" (Phase 0).',
    ],
  },
  browser: {
    versions: [],
    date: '2026-10-23',
    isolatedLogin: 'assumed',
    isolatedMcp: 'n/a',
    isolatedHistory: 'assumed',
    skillShare: 'unsupported',
    globalSkillDirs: [],
    notes: ['Chromium --user-data-dir gives each profile its own cookies, logins and history.'],
  },
};

/** Whether a profile reads its tool's every-profile folders (globalSkillDirs). Cursor's isolated HOME moves ~/.cursor. */
export function usesGlobalDirs(p: Profile): boolean {
  return !(p.tool === 'cursor' && p.homeMode === 'isolated');
}

/** Isolation evidence for one profile: the tool's, adjusted for profile options that change it. */
export function isolationFor(p: Profile): { login: Evidence; mcp: Evidence; history: Evidence } {
  const t = TESTED[p.tool];
  return {
    login: t.isolatedLogin,
    // An isolated HOME gives Cursor its own ~/.cursor/mcp.json; that mode is still experimental.
    mcp: t.isolatedMcp === 'no' && !usesGlobalDirs(p) ? 'assumed' : t.isolatedMcp,
    history: t.isolatedHistory,
  };
}
