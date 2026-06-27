#!/usr/bin/env bash
# Build and package ddbya Desktop for Linux (AppImage).
# Run from anywhere inside the repo:
#   bash desktop/linux/build.sh
#
# Requirements:
#   - Node.js and npm
#   - ImageMagick (for icon generation: apt install imagemagick / dnf install ImageMagick)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(dirname "$SCRIPT_DIR")"

echo "==> ddbya Desktop - Linux build"
echo "    Desktop root: $DESKTOP_DIR"

# Prerequisites
command -v node >/dev/null 2>&1 || { echo "error: node not found. Install from https://nodejs.org"; exit 1; }
command -v convert >/dev/null 2>&1 || { echo "error: ImageMagick not found. Install with: apt install imagemagick / dnf install ImageMagick"; exit 1; }

# Kill any running instance
echo "==> Stopping any running ddbya Desktop instance..."
pkill -x "ddbya Desktop" 2>/dev/null || true
sleep 0.3

cd "$DESKTOP_DIR"

# Install dependencies
echo "==> Installing npm dependencies..."
npm install

# Generate icons (needs icon.svg → icon.png at 512×512 minimum for Linux)
echo "==> Generating icons..."
if [ ! -f assets/icon.png ]; then
  convert -background none assets/icon.svg -resize 512x512 assets/icon.png
fi

# Build AppImage
echo "==> Building Linux AppImage..."
npx electron-builder --linux --config linux/electron-builder.yml

echo ""
echo "Done. AppImages are in: $DESKTOP_DIR/linux/dist"
echo "Note: the build is not signed. AppImages are self-contained and run without installation."
