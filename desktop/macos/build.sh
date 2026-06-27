#!/usr/bin/env bash
# Build, sign, notarize, and deploy ddbya Desktop to /Applications.
# Run from anywhere inside the repo:
#   bash desktop/macos/build.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
IDENTITY="Developer ID Application: Gianfranco Cecconi (W52V7H5858)"

echo "==> ddbya Desktop — macOS build"
echo "    Desktop root: ${DESKTOP_DIR}"

# ── Prerequisites ─────────────────────────────────────────────────────────────

if ! command -v node &>/dev/null; then
  echo "error: node not found. Install from https://nodejs.org" >&2; exit 1
fi
if ! command -v magick &>/dev/null && ! command -v convert &>/dev/null; then
  echo "error: ImageMagick not found. Run: brew install imagemagick" >&2; exit 1
fi

# ── Notarisation credentials ──────────────────────────────────────────────────

if ! xcrun notarytool history --keychain-profile "ddbya-notarize" &>/dev/null 2>&1; then
  echo ""
  echo "==> Notarisation credentials not yet stored."
  echo "    You need an app-specific password from https://appleid.apple.com"
  echo ""
  xcrun notarytool store-credentials "ddbya-notarize" \
    --apple-id "giacecco@giacecco.com" \
    --team-id  "W52V7H5858"
  echo ""
fi

# ── Kill any running instance ─────────────────────────────────────────────────

echo "==> Stopping any running ddbya Desktop instance…"
pkill -x "ddbya Desktop" 2>/dev/null && sleep 0.5 || true

# ── Install + generate icons ──────────────────────────────────────────────────

cd "${DESKTOP_DIR}"
echo "==> Installing npm dependencies…"
npm install

echo "==> Generating icons…"
node macos/generate-icons.js

# ── Package (electron-builder, no signing — we sign manually below) ───────────

echo "==> Packaging universal binary…"
npx electron-builder --mac --config macos/electron-builder.yml

APP_PATH="${DESKTOP_DIR}/macos/dist/mac-universal/ddbya Desktop.app"
if [[ ! -d "${APP_PATH}" ]]; then
  echo "error: .app not found at ${APP_PATH}" >&2; exit 1
fi

# ── Sign ──────────────────────────────────────────────────────────────────────
# We use a custom signing script because macOS re-adds com.apple.FinderInfo to
# .app directories almost immediately after xattr -d, which blocks codesign.
# sign.js strips the xattr immediately before each individual codesign call.

echo "==> Signing…"
node macos/sign.js "${APP_PATH}" "${IDENTITY}" macos/entitlements.plist

echo "==> Verifying signature…"
codesign --verify --deep --verbose=1 "${APP_PATH}" 2>&1

# ── Notarize ──────────────────────────────────────────────────────────────────

echo "==> Creating ZIP for notarisation…"
ZIP_PATH="${DESKTOP_DIR}/macos/dist/ddbya-Desktop.zip"
ditto -c -k --keepParent "${APP_PATH}" "${ZIP_PATH}"

echo "==> Submitting for notarisation (this can take a few minutes)…"
xcrun notarytool submit "${ZIP_PATH}" \
  --keychain-profile "ddbya-notarize" \
  --wait

echo "==> Stapling notarisation ticket…"
xcrun stapler staple "${APP_PATH}"
rm -f "${ZIP_PATH}"

# ── Deploy ────────────────────────────────────────────────────────────────────

echo "==> Deploying to /Applications…"
rm -rf "/Applications/ddbya Desktop.app"
cp -R "${APP_PATH}" "/Applications/"

echo "==> Launching ddbya Desktop…"
open "/Applications/ddbya Desktop.app"

echo ""
echo "Done. ddbya Desktop is running in the menu bar."
