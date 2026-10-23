import path from 'node:path';
import { adapterFor } from './adapters/index.js';
import type { Hub } from './config.js';
import type { Context } from './context.js';
import { readJsonIfExists } from './fsx.js';
import type { PluginEntry } from './library.js';

export interface McpPreview {
  /** False when the plugin's files aren't available locally (remote source), so its MCP use is unknown. */
  known: boolean;
  servers: string[];
  /** Folder the answer came from. */
  from?: string;
}

const keysOf = (v: unknown): string[] => (v && typeof v === 'object' ? Object.keys(v) : []);

async function serversInPluginDir(dir: string): Promise<string[]> {
  const out = new Set<string>();
  const mcpJson = (await readJsonIfExists(path.join(dir, '.mcp.json')).catch(() => undefined)) as
    | Record<string, unknown>
    | undefined;
  for (const k of keysOf(mcpJson?.mcpServers ?? mcpJson)) out.add(k);
  const manifest = (await readJsonIfExists(path.join(dir, '.claude-plugin/plugin.json')).catch(() => undefined)) as
    | { mcpServers?: unknown }
    | undefined;
  if (typeof manifest?.mcpServers === 'string') {
    const ref = (await readJsonIfExists(path.join(dir, manifest.mcpServers)).catch(() => undefined)) as
      | Record<string, unknown>
      | undefined;
    for (const k of keysOf(ref?.mcpServers ?? ref)) out.add(k);
  } else {
    for (const k of keysOf(manifest?.mcpServers)) out.add(k);
  }
  return [...out].sort();
}

/**
 * What MCP servers a plugin would add, read from a marketplace some Claude profile already has
 * cloned. Nothing is downloaded; if no local copy exists the answer is "unknown".
 */
export async function previewPluginMcp(ctx: Context, hub: Hub, entry: PluginEntry): Promise<McpPreview> {
  const [name, marketplace] = entry.id.split('@') as [string, string];
  const roots = hub.profiles.filter((p) => p.tool === 'claude-code').map((p) => adapterFor(p).paths(ctx, p).root);
  for (const root of new Set(roots)) {
    const mktDir = path.join(root, 'plugins/marketplaces', marketplace);
    const catalog = (await readJsonIfExists(path.join(mktDir, '.claude-plugin/marketplace.json')).catch(
      () => undefined,
    )) as { plugins?: { name: string; source?: unknown; mcpServers?: unknown }[] } | undefined;
    const listed = catalog?.plugins?.find((p) => p.name === name);
    if (!listed) continue;
    const inline = keysOf(listed.mcpServers);
    if (typeof listed.source === 'string') {
      const dir = path.resolve(mktDir, listed.source);
      const servers = [...new Set([...inline, ...(await serversInPluginDir(dir))])].sort();
      return { known: true, servers, from: dir };
    }
    // Remote source (git, url…): only inline declarations are visible without downloading it.
    return { known: false, servers: inline, from: mktDir };
  }
  return { known: false, servers: [] };
}
