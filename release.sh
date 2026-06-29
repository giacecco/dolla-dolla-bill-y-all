#!/usr/bin/env bash
# Build, notarise, and publish a GitHub release.
# Usage: bash release.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="0.0.$(date +%y%m%d%H%M)"
APP_PATH="${REPO_DIR}/desktop/macos/dist/mac-universal/ddbya Desktop.app"
DIST_DIR="${REPO_DIR}/desktop/macos/dist"

echo "==> ddbya release ${VERSION}"

# ── Update version in package.json ───────────────────────────────────────────

echo "==> Updating version in desktop/package.json…"
node -e "
  const fs = require('fs');
  const p = '${REPO_DIR}/desktop/package.json';
  const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
  pkg.version = '${VERSION}';
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
"

# ── Build + sign + notarise ───────────────────────────────────────────────────

bash "${REPO_DIR}/desktop/macos/build.sh" --notarise

# ── Package assets ────────────────────────────────────────────────────────────

echo "==> Packaging release assets…"

DESKTOP_ZIP="${DIST_DIR}/ddbya-Desktop-${VERSION}.zip"
ditto -c -k --keepParent "${APP_PATH}" "${DESKTOP_ZIP}"
echo "    Desktop: $(du -h "${DESKTOP_ZIP}" | cut -f1)"

CLI_TAR="${DIST_DIR}/ddbya-cli-${VERSION}.tar.gz"
tar czf "${CLI_TAR}" -C "${REPO_DIR}" \
  ddbya ddbya-report proxy-core.js report-core.js completions/
echo "    CLI:     $(du -h "${CLI_TAR}" | cut -f1)"

# ── Publish GitHub release ────────────────────────────────────────────────────

echo "==> Creating GitHub release v${VERSION}…"
gh release create "v${VERSION}" \
  "${CLI_TAR}#CLI tools (macOS)" \
  "${DESKTOP_ZIP}#ddbya Desktop (macOS, universal)" \
  --title "v${VERSION}" \
  --notes "See [INSTALL.md](https://github.com/giacecco/dolla-dolla-bill-y-all/blob/main/INSTALL.md) for installation instructions." \
  --repo giacecco/dolla-dolla-bill-y-all

echo ""
echo "Done. Release v${VERSION} is live."
