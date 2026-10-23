#!/usr/bin/env bash
# Usage: scripts/release.sh 0.2.0
# Sets the version everywhere, commits, tags v0.2.0 and pushes. The Release workflow then builds
# the app and publishes it on GitHub, where installed copies pick it up as an update.
set -euo pipefail
version="${1:?usage: scripts/release.sh <x.y.z>}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Use a plain x.y.z version." >&2; exit 1; }
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain)" ] || { echo "Commit or stash your changes first." >&2; exit 1; }
git rev-parse "v$version" >/dev/null 2>&1 && { echo "Tag v$version already exists." >&2; exit 1; }

npm version "$version" --no-git-tag-version --workspaces --include-workspace-root >/dev/null
sed -i '' -E "s/AIHUB_VERSION = '[^']+'/AIHUB_VERSION = '$version'/" packages/core/src/version.ts
npm install --package-lock-only >/dev/null

npm run build >/dev/null && npm test >/dev/null || { echo "Build or tests failed; nothing committed." >&2; git checkout -- .; exit 1; }

git commit -am "Release v$version"
git tag "v$version"
git push origin HEAD "v$version"
echo "Pushed v$version. Follow the build: gh run watch \$(gh run list -w Release -L1 --json databaseId -q '.[0].databaseId')"
