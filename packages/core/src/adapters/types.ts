import type { Hub, Profile, ToolId } from '../config.js';
import type { Context, Env } from '../context.js';
import type { DirEntryInfo } from '../fsx.js';
import type { PluginEntry, ShareKind } from '../library.js';

/** How much we know about a capability, for the exact version that was checked. */
export type Evidence = 'tested' | 'assumed' | 'untested' | 'no' | 'n/a';

export interface TestedCapabilities {
  versions: string[];
  date: string;
  isolatedLogin: Evidence;
  isolatedMcp: Evidence;
  isolatedHistory: Evidence;
  /** How the Phase 2 sharing engine will place library skills into this tool's profiles. */
  skillShare: 'symlink' | 'copy' | 'native' | 'unsupported';
  /** Folders the tool reads for every profile, regardless of its isolation variable. */
  globalSkillDirs: { path: string; evidence: Evidence; note: string }[];
  notes: string[];
}

export interface Identity {
  status: 'signed-in' | 'signed-out' | 'unknown';
  email?: string;
  org?: string;
  detail?: string;
}

export type Credential =
  | { kind: 'keychain'; service: string }
  | { kind: 'file'; path: string }
  | { kind: 'unknown'; detail: string };

export interface ProfilePaths {
  root: string;
  /** True for the tool's built-in default location (no isolation variable is passed). */
  isDefault: boolean;
  configFile?: string;
  mcpFile?: string;
  skillsDir?: string;
  historyPaths: string[];
  credential: Credential;
}

export interface Inventory {
  rootExists: boolean;
  skills: DirEntryInfo[];
  /** Set when the whole skills/ folder is a symlink (e.g. cpm's share = ["skills"]). */
  skillsDirLinkedTo?: string;
  /** Names only, never the server config. */
  mcpServers: string[];
  historyPresent: string[];
  warnings: string[];
}

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Env;
}

/** Where and how a library item lands in a profile. */
export type ShareTarget =
  | { strategy: 'symlink' | 'copy'; path: string }
  /** One managed block in an instructions file: `import` writes @path lines, `inline` copies the text. */
  | { strategy: 'block'; path: string; style: 'import' | 'inline' }
  | { strategy: 'json-key'; path: string }
  | { strategy: 'plugin-cli'; path: string }
  | { strategy: 'unsupported'; reason: string };

export interface PluginOps {
  isInstalled(ctx: Context, p: Profile, id: string): Promise<boolean>;
  /** Argument lists for the tool binary, run with the profile's launch environment. */
  commands(ctx: Context, p: Profile, entry: PluginEntry, action: 'install' | 'uninstall'): Promise<string[][]>;
}

export interface ToolAdapter<P extends Profile = Profile> {
  tool: ToolId;
  displayName: string;
  tested: TestedCapabilities;
  findBinary(ctx: Context, p?: P): Promise<string | undefined>;
  detectVersion(ctx: Context, p?: P): Promise<string | undefined>;
  paths(ctx: Context, p: P): ProfilePaths;
  identity(ctx: Context, p: P): Promise<Identity>;
  inventory(ctx: Context, p: P): Promise<Inventory>;
  launchSpec(ctx: Context, hub: Hub, p: P, args: string[]): Promise<LaunchSpec>;
  /** Heuristic used by `adopt` to catch pointing the wrong tool at a folder. */
  looksLikeRoot(dir: string): Promise<boolean>;
  /** Where a shared item goes. Tools without file-based sharing leave this out. */
  shareTarget?(ctx: Context, p: P, kind: ShareKind, name: string): ShareTarget;
  plugins?: PluginOps;
  /** Last-moment setup before launching (e.g. Cursor's isolated HOME). */
  prepareLaunch?(ctx: Context, p: P): Promise<void>;
}
