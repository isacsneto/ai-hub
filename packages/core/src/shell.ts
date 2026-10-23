import fs from 'node:fs/promises';
import path from 'node:path';
import type { Hub } from './config.js';
import { readTextIfExists } from './fsx.js';

export const PROFILE_FILE = '.aihub-profile';

/** Nearest .aihub-profile from `dir` upwards (like .nvmrc). */
export async function findProfileFile(dir: string): Promise<{ id: string; file: string } | undefined> {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const file = path.join(d, PROFILE_FILE);
    const text = await readTextIfExists(file);
    if (text?.trim()) return { id: text.trim().split(/\s+/)[0]!, file };
    if (d === path.dirname(d)) return undefined;
  }
}

export async function writeProfileFile(dir: string, id: string): Promise<string> {
  const file = path.join(dir, PROFILE_FILE);
  await fs.writeFile(file, `${id}\n`);
  return file;
}

/**
 * Shell code for ~/.zshrc / ~/.bashrc: one command per CLI profile, plus switching the shell's
 * profile when entering a folder with a .aihub-profile file.
 */
export function shellInit(hub: Hub, shell: 'zsh' | 'bash', cmd = 'aihub'): string {
  const ids = hub.profiles.filter((p) => p.tool === 'claude-code' || p.tool === 'codex').map((p) => p.id);
  const lines = [
    `# AI-Hub shell integration. Load with: eval "$(${cmd} shell-init ${shell})"`,
    // Don't shadow existing commands (e.g. cpm's claude-work wrapper): they do the same thing.
    ...ids.map((id) => `command -v ${id} >/dev/null 2>&1 || ${id}() { ${cmd} run ${id} "$@"; }`),
    `_aihub_find() {
  local d="$PWD"
  while :; do
    if [ -s "$d/${PROFILE_FILE}" ]; then head -n1 "$d/${PROFILE_FILE}" | tr -d '[:space:]'; return; fi
    [ "$d" = "/" ] && return
    d="$(dirname "$d")"
  done
}`,
    `_aihub_auto() {
  local want; want="$(_aihub_find)"
  if [ -n "$want" ] && [ "$want" != "\${AIHUB_PROFILE:-}" ]; then
    eval "$(${cmd} env "$want")" && export AIHUB_AUTO=1 && echo "aihub: using $want here" >&2
  elif [ -z "$want" ] && [ -n "\${AIHUB_AUTO:-}" ]; then
    unset CLAUDE_CONFIG_DIR CODEX_HOME AIHUB_PROFILE AIHUB_AUTO
    echo "aihub: back to the default profiles" >&2
  fi
}`,
    shell === 'zsh'
      ? 'autoload -Uz add-zsh-hook && add-zsh-hook chpwd _aihub_auto'
      : 'PROMPT_COMMAND="_aihub_auto${PROMPT_COMMAND:+;$PROMPT_COMMAND}"',
    '_aihub_auto',
    '',
  ];
  return lines.join('\n');
}
