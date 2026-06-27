#!/usr/bin/env bash
# Build, sign, notarize, and deploy ddbya Desktop to /Applications.
# Run from the repo root or from desktop/:
#   bash desktop/scripts/build-mac.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "==> ddbya Desktop build script"
echo "    Working in: ${DESKTOP_DIR}"

# ── Prerequisites ─────────────────────────────────────────────────────────────

if ! command -v node &>/dev/null; then
  echo "error: node not found. Install Node.js from https://nodejs.org" >&2; exit 1
fi
if ! command -v npm &>/dev/null; then
  echo "error: npm not found." >&2; exit 1
fi

# ── Notarisation credentials ──────────────────────────────────────────────────

if ! xcrun notarytool history --keychain-profile "ddbya-notarize" &>/dev/null 2>&1; then
  echo ""
  echo "==> Notarisation credentials not found in Keychain."
  echo "    You need an app-specific password from https://appleid.apple.com"
  echo ""
  xcrun notarytool store-credentials "ddbya-notarize" \
    --apple-id "giacecco@giacecco.com" \
    --team-id  "W52V7H5858"
  echo ""
fi

# ── Kill any running instance ─────────────────────────────────────────────────

echo "==> Stopping any running ddbya Desktop instance…"
pkill -x "ddbya Desktop" 2>/dev/null || true
sleep 0.5

# ── Build ─────────────────────────────────────────────────────────────────────

cd "${DESKTOP_DIR}"

echo "==> Installing npm dependencies…"
npm install

echo "==> Generating icons…"
node scripts/generate-icons.js

echo "==> Building and signing (universal binary)…"
npx electron-builder --mac --config electron-builder.yml

# ── Deploy ────────────────────────────────────────────────────────────────────

APP_PATH="$(ls -d "${DESKTOP_DIR}/dist/mac-universal/ddbya Desktop.app" 2>/dev/null \
           || ls -d "${DESKTOP_DIR}/dist/mac/ddbya Desktop.app" 2>/dev/null)"

if [[ -z "${APP_PATH}" ]]; then
  echo "error: could not find built .app in dist/" >&2; exit 1
fi

echo "==> Deploying to /Applications…"
rm -rf "/Applications/ddbya Desktop.app"
cp -R "${APP_PATH}" "/Applications/"

echo "==> Launching ddbya Desktop…"
open "/Applications/ddbya Desktop.app"

echo ""
echo "Done. ddbya Desktop is running in the menu bar."
