#!/usr/bin/env bash
# Builds release/AI-Hub-<version>-<arch>-mac.zip and release/SHA256SUMS.txt, the two files the
# in-app updater expects on a GitHub release. Run from apps/desktop after `npm run build` at the root.
set -euo pipefail
cd "$(dirname "$0")/.."

ARCH="${ARCH:-$(uname -m)}"
VERSION=$(node -p "require('./package.json').version")
rm -rf release

npx electron-vite build
npx electron-builder --mac dir "--$ARCH" --publish never

APP=$(find release -maxdepth 2 -name 'AI-Hub.app' -type d | head -n1)
[ -n "$APP" ] || { echo "AI-Hub.app was not produced" >&2; exit 1; }

# Ad-hoc signature: required to run on Apple Silicon, and what the updater verifies.
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

ZIP="release/AI-Hub-$VERSION-$ARCH-mac.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
(cd release && shasum -a 256 "$(basename "$ZIP")" > SHA256SUMS.txt)
echo "Built $ZIP"
cat release/SHA256SUMS.txt
