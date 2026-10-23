#!/usr/bin/env bash
# Remaining Phase 0 isolation checks for AI-Hub.
#
# Run from a normal Terminal window, NOT from inside Claude Code or Codex (their sessions skew
# login checks). Results go to ./phase0-results-<date>.txt (git-ignored: it may contain emails).
#
# What it touches:
#   - temp folders under $TMPDIR, removed at exit
#   - one probe skill symlinked into ~/.codex/skills, removed at exit
#   - asks before anything that costs a model call or opens an app
# It prints Keychain item NAMES only, never secrets.
set -u

if [ -n "${CLAUDECODE:-}" ] || [ -n "${CODEX_SANDBOX:-}" ] || [ -n "${CODEX_THREAD_ID:-}" ]; then
  echo "Please run this from a normal Terminal window, not inside Claude Code or Codex." >&2
  exit 1
fi

OUT="$PWD/phase0-results-$(date +%Y%m%d-%H%M).txt"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/aihub-phase0.XXXXXX")
PROBE_LINK="$HOME/.codex/skills/aihub-probe-symlink"
cleanup() { rm -f "$PROBE_LINK"; rm -rf "$TMP"; }
trap cleanup EXIT

CODEX=$(command -v codex || echo /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex)
log() { printf '%s\n' "$*" | tee -a "$OUT"; }
ask() { local a; read -r -p "$1 [y/N] " a; [[ "$a" =~ ^[Yy] ]]; }
answer() { local a; read -r -p "$1 " a; log "    answer: ${a:-<skipped>}"; }

log "AI-Hub Phase 0 — $(date '+%F %T')"
log "claude $(claude --version 2>/dev/null | head -1) · codex $("$CODEX" --version 2>/dev/null) · macOS $(sw_vers -productVersion)"
log ""

# 1 ─ Is `claude auth status` trustworthy outside a Claude Code session?
log "1. Claude Code: fresh CLAUDE_CONFIG_DIR, clean environment"
mkdir -p "$TMP/claude-fresh"
r=$(env -i HOME="$HOME" PATH="$PATH" USER="$USER" CLAUDE_CONFIG_DIR="$TMP/claude-fresh" claude auth status 2>&1 |
  grep -E '"(loggedIn|authMethod)"' | tr -d ' \n')
log "   $r"
log "   expected: loggedIn false. If true, auth status can't be used to check isolation."
[ -d "$HOME/.config/anthropic/credentials" ] &&
  log "   ~/.config/anthropic holds a shared Anthropic profile: empty folders fall back to it (that's why they look logged in)"
log ""

# 2 ─ Codex: symlinked skills, and whether ~/.agents/skills is read for every profile.
log "2. Codex skills: symlinked skill + ~/.agents/skills"
mkdir -p "$TMP/aihub-probe-symlink"
cat > "$TMP/aihub-probe-symlink/SKILL.md" <<'EOF'
---
name: aihub-probe-symlink
description: Probe skill created by the AI-Hub Phase 0 script. Do not use.
---
Probe only.
EOF
if [ -e "$PROBE_LINK" ]; then
  log "   skipped: $PROBE_LINK already exists"
elif ask "   This runs one short 'codex exec' on your default Codex account. Continue?"; then
  ln -s "$TMP/aihub-probe-symlink" "$PROBE_LINK"
  list=$("$CODEX" exec --skip-git-repo-check -s read-only \
    "List the names of every skill available to you, one per line. Output nothing else." 2>/dev/null)
  rm -f "$PROBE_LINK"
  grep -q 'aihub-probe-symlink' <<<"$list" && log "   symlinked skill in CODEX_HOME/skills: LOADED" ||
    log "   symlinked skill in CODEX_HOME/skills: NOT loaded"
  only_global=$(comm -23 <(ls "$HOME/.agents/skills" 2>/dev/null | sort) <(ls "$HOME/.codex/skills" 2>/dev/null | sort))
  for s in $only_global; do
    grep -q "$s" <<<"$list" && log "   $s (only in ~/.agents/skills): LOADED → global for every Codex profile" ||
      log "   $s (only in ~/.agents/skills): not loaded"
  done
  log "   raw skill list: $(tr '\n' ',' <<<"$list")"
else
  log "   skipped by user"
fi
log ""

# 3 ─ Codex: where MCP OAuth tokens live.
log "3. Codex MCP OAuth storage"
log "   config: $(grep -E '^\s*mcp_oauth_credentials_store' "$HOME/.codex/config.toml" 2>/dev/null || echo 'mcp_oauth_credentials_store not set (tool default)')"
log "   Keychain item names mentioning codex/mcp: $(security dump-keychain 2>/dev/null | grep '"svce"' | grep -ioE '"[^"]*(codex|mcp)[^"]*"$' | sort -u | tr '\n' ' ')"
log ""

# 4 ─ Plugins: is any plugin folder shared between Claude profiles?
log "4. Claude plugin folders per profile"
for d in "$HOME/.claude" "$HOME"/.claude-profiles/*/; do
  d=${d%/}
  [ -d "$d" ] || continue
  if [ -L "$d/plugins" ]; then where="symlink → $(readlink "$d/plugins")"; elif [ -d "$d/plugins" ]; then where="own folder"; else where="none"; fi
  n=$(node -e 'try{const j=require(process.argv[1]);console.log(Object.keys(j.plugins||{}).length)}catch{console.log(0)}' "$d/plugins/installed_plugins.json")
  log "   ${d/#$HOME/~}: plugins $where, $n installed"
done
log "   To finish: install the same plugin in two profiles (claude-<a> plugin install …) and re-run."
log ""

# 5 ─ ChatGPT app (it is the Codex app, com.openai.codex): a second instance with its own CODEX_HOME?
log "5. ChatGPT/Codex app second instance (aihub tool: codex-desktop)"
if ask "   Open a second ChatGPT app instance with an empty CODEX_HOME?"; then
  mkdir -p "$TMP/codex-second"
  open -n -a ChatGPT --env CODEX_HOME="$TMP/codex-second"
  answer "   Did a SECOND instance open, and is it signed out? (describe, then quit it)"
else
  log "   skipped by user"
fi
log ""

# 6 ─ Cursor: login per --user-data-dir, and the isolated-home mode for ~/.cursor (MCP).
log "6. Cursor"
if [ -d /Applications/Cursor.app ] && ask "   Open Cursor with an empty --user-data-dir (and a separate HOME)?"; then
  mkdir -p "$TMP/cursor-data/home"
  mkdir -p "$TMP/cursor-data/home/Library"
  ln -s "$HOME/Library/Keychains" "$TMP/cursor-data/home/Library/Keychains"
  for f in .gitconfig .ssh .zshrc; do [ -e "$HOME/$f" ] && ln -s "$HOME/$f" "$TMP/cursor-data/home/$f"; done
  open -n -a Cursor --env HOME="$TMP/cursor-data/home" --args --user-data-dir="$TMP/cursor-data"
  answer "   Is this Cursor signed out, and does Settings → MCP show NO servers from your normal ~/.cursor/mcp.json? (then quit it)"
  log "   files created under the isolated HOME: $(cd "$TMP/cursor-data/home" 2>/dev/null && find . -maxdepth 2 -newer "$OUT" | head -10 | tr '\n' ' ')"
else
  log "   skipped"
fi
log ""

# 7 ─ Manual checks.
log "7. Manual checks"
log "   a) Open your second Claude Desktop instance → Code tab → run /status."
answer "      Which account does it show?"
log "   b) Keep claude-work and claude open side by side for a day (token refresh)."
answer "      Still signed in to the right accounts afterwards? (y/n/later)"
log ""
log "Done. Results saved to $OUT"
log "Update packages/core/src/adapters/tested.ts with what changed, then run: aihub doctor"
