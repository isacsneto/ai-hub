# AI-Hub

Run several AI accounts side by side (Claude Code, Claude Desktop, Codex, the ChatGPT/Codex app, Cursor, and web accounts in their own browser profiles). Each account stays isolated, and you share only what you choose.

- **Always separate:** logins, MCP servers, connectors and history. Each one stays inside its profile's folder.
- **Shared when you pick it:** skills, agents, commands, instruction files, plugins and a short list of approved settings. These live once in a library and go into the profiles you choose.

## Install the app

1. Download `AI-Hub-<version>-arm64-mac.zip` from [Releases](https://github.com/isacsneto/ai-hub/releases/latest), unzip it, and move **AI-Hub.app** to `/Applications`.
2. The app isn't signed with an Apple Developer ID, so the first time, right-click it and choose **Open**. (Or run `xattr -dr com.apple.quarantine /Applications/AI-Hub.app`.)
3. Optional: **AI-Hub menu → Install Command Line Tool** puts `aihub` in `~/.local/bin`. It runs the CLI bundled inside the app, so it updates along with the app.

### Updates

The app checks this repo's latest GitHub release when it starts and every 6 hours. You can also use **Check for updates** in the sidebar or the menu. When a newer version is out, a banner offers **Install and restart**. Before installing, the app checks that:
- the zip's SHA-256 matches the release's `SHA256SUMS.txt`,
- the app inside has the same bundle id,
- its version matches the release,
- its code signature verifies.

The previous version is kept in `~/.aihub/backups/app/`. Apple Silicon only, for now.

To publish a new version, run `scripts/release.sh 0.2.0`. It sets the version, commits, tags and pushes; the **Release** workflow then builds the app and publishes the GitHub release.

## Quick start (from source)

```sh
npm install
npm run build
npm link -w @aihub/cli            # puts `aihub` on your PATH

aihub import                      # dry run: finds the accounts already on this Mac
aihub import --apply              # register them where they are (--only / --skip)
aihub list
aihub doctor
aihub run claude-work             # launch a profile; extra args go to the tool
```

Desktop app from source: `npm run desktop` (it also lives in the menu bar as "◎ AI"). Package it yourself with `npm run package`, which writes `apps/desktop/release/`.

## Profiles

| Tool | What isolates it | New profile |
|---|---|---|
| `claude-code` | `CLAUDE_CONFIG_DIR` | `aihub profile add claude-code claude-work` |
| `claude-desktop` | `--user-data-dir`, plus `CLAUDE_CONFIG_DIR` for its Code tab | `aihub profile add claude-desktop desk-work --code-profile claude-work` |
| `codex` | `CODEX_HOME` | `aihub profile add codex codex-work` |
| `codex-desktop` | the ChatGPT/Codex app with that profile's `CODEX_HOME` | `aihub profile add codex-desktop gpt-app-work --codex-profile codex-work` |
| `cursor` | `--user-data-dir` (`--isolated-home` also separates `~/.cursor`, where MCP lives) | `aihub profile add cursor cursor-work --isolated-home` |
| `browser` | its own Chromium `--user-data-dir` | `aihub profile add browser chatgpt-work --browser chrome --url https://chatgpt.com` |

New profiles live in `~/.aihub/profiles/<id>`. Existing ones are adopted where they are. The hub never moves a folder, because Claude Code ties each login to the folder path.

## Sharing

```sh
aihub library add skill ./my-skill            # or: aihub library promote claude-default skill pr-review
aihub library add instruction ./coding-style.md
aihub share skill pr-review claude-work codex-work
aihub share instruction coding-style claude-work codex-work
aihub plugin add github@claude-plugins-official
aihub share plugin github@claude-plugins-official claude-work --allow-mcp
aihub setting set model opus && aihub share setting model claude-work
aihub apply --dry-run                         # what would change, everywhere
aihub undo                                    # reverse the last change made in tool folders
```

How each item gets into a profile:

| | Claude Code | Codex |
|---|---|---|
| skills | symlink | symlink (verified in Phase 0) |
| agents / commands | symlink | commands → copied into `prompts/` |
| instructions | `@import` lines in a managed block in `CLAUDE.md` | copied into a managed block in `AGENTS.md` |
| plugins | installed separately in each profile (`claude plugin install`) | not managed |
| settings | approved keys in `settings.json` | not supported |

Safety rules:
- **It only removes what it put there.** The hub records every item it places in `~/.aihub/state/` and never touches anything without such a record. A copy you edited, or text you changed inside the hub's block in `CLAUDE.md`/`AGENTS.md`, is left alone unless you pass `--force`.
- **Every change can be undone.** Changes happen in one transaction: replaced or removed things are moved into `~/.aihub/journal/`, a failed run rolls back, and `aihub undo` reverses the last run. The journal is written as changes happen, so a run cut short can be undone too. Undo leaves alone any file you edited after the hub wrote it, and says so. If something can't be put back (a permissions problem, say), it stays in the journal and the next `aihub undo` retries it; `aihub undo --skip` gives up on it.
- **Linked files stay linked.** If `CLAUDE.md` or `settings.json` is a symlink (into dotfiles, say), the hub won't replace it with a file; it reports a conflict instead. A managed block with damaged markers is also left for you to fix.
- **One change at a time.** The app and the CLI share a lock in `~/.aihub`, so two changes never interleave.
- **Plugins that bring MCP servers wait for approval.** The hub reads the plugin's marketplace files on disk; nothing is downloaded. Plugins with MCP servers, or with files it can't read offline, need `--allow-mcp` for each profile.
- **Folders owned by other tools are read-only.** Profiles managed by another tool (cpm, claude-account-guard) are only read until `aihub takeover`, which can be reversed with `--undo`.
- **Whole-folder links (cpm's `share = ["skills"]`) aren't silently replaced.** Switching to per-item links needs `--detach`.

## Launchers, icons, shell

```sh
aihub profile set claude-work --badge W --color "#3B7DD8"
aihub icon claude-work                    # preview PNG
aihub launcher build                      # ~/Applications/AI-Hub/<Label>.app with the badged icon
eval "$(aihub shell-init zsh)"            # in ~/.zshrc: a command per profile and per-folder switching
aihub link claude-work                    # this folder (and below) uses claude-work
```

CLI profiles open in your terminal (`preferences.terminal` in `hub.yaml`: Terminal, iTerm or Ghostty). Launchers for app profiles contain the exact `open …` command, so they work without Node.

## Backup

```sh
aihub export ~/aihub-backup.tgz           # hub.yaml + library (with history) + install records
aihub restore ~/aihub-backup.tgz --force  # current hub is moved to ~/.aihub/backups first
aihub library log / restore <rev>         # every library change is a git commit
```

Exports never include profile folders, logins or the journal.

## What has been verified

`packages/core/src/adapters/tested.ts` records what was tested, and on which version. `aihub doctor` and the Health page warn when a tool is newer than that. To re-check after a tool update, run this from a normal Terminal:

```sh
scripts/phase0-remaining.sh
```

This tool isolates accounts and their data, not files. Every profile runs as your macOS user.

## Layout

```
packages/core    adapters (one per tool), library, sharing engine, transactions, icons, launchers, doctor
packages/cli     the `aihub` command
apps/desktop     Electron app: Profiles, Sharing grid, Library, Health; menu bar launcher
scripts/         Phase 0 isolation checks
```

Development: `npm test` (vitest, against temporary home folders) and `npm run build`. Set `AIHUB_HOME=/some/dir` to use a hub other than `~/.aihub`. To check the desktop app without a visible window: `AIHUB_SMOKE=/tmp/shots npx electron apps/desktop` saves a screenshot of each page.
