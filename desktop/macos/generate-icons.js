#!/usr/bin/env node
'use strict';

/**
 * Generates icon.png, icon.icns (macOS), and icon.ico (Windows) from icon.svg.
 * Uses qlmanage (macOS built-in) to render SVG, and ImageMagick for resizing.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const assets = path.join(__dirname, '..', 'assets');  // desktop/assets/
const svg = path.join(assets, 'icon.svg');
const png1024 = path.join(assets, 'icon.png');
const icnsPath = path.join(assets, 'icon.icns');
const icoPath = path.join(assets, 'icon.ico');
const iconset = path.join(assets, 'icon.iconset');

function run(cmd, opts = {}) {
  try {
    execSync(cmd, { stdio: 'pipe', ...opts });
  } catch (err) {
    console.error(`Failed: ${cmd}`);
    console.error(err.stderr ? err.stderr.toString() : err.message);
    process.exit(1);
  }
}

function findMagick() {
  for (const c of ['magick', '/opt/homebrew/bin/magick', 'convert', '/opt/homebrew/bin/convert']) {
    try { execSync(`command -v ${c}`, { stdio: 'pipe' }); return c; } catch {}
  }
  return null;
}

// ── Step 1: render SVG → 1024×1024 PNG ───────────────────────────────────────

console.log('Generating icon.png (1024×1024)…');

if (process.platform === 'darwin') {
  // qlmanage is macOS built-in and renders SVG text/fonts correctly
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddbya-icon-'));
  run(`qlmanage -t -s 1024 -o "${tmpDir}" "${svg}" 2>/dev/null`);
  const rendered = path.join(tmpDir, 'icon.svg.png');
  if (!fs.existsSync(rendered)) {
    console.error('qlmanage failed to produce a PNG.'); process.exit(1);
  }
  fs.copyFileSync(rendered, png1024);
  fs.rmSync(tmpDir, { recursive: true, force: true });
} else {
  // Non-macOS: try ImageMagick
  const magick = findMagick();
  if (!magick) {
    console.error('ImageMagick not found. Install it and try again.'); process.exit(1);
  }
  run(`"${magick}" -background none "${svg}" -resize 1024x1024 "${png1024}"`);
}

// ── Step 2: macOS ICNS ────────────────────────────────────────────────────────

if (process.platform === 'darwin') {
  console.log('Generating icon.icns…');
  const magick = findMagick();
  if (!magick) { console.warn('ImageMagick not found — skipping ICNS/ICO generation.'); process.exit(0); }

  fs.mkdirSync(iconset, { recursive: true });
  const pairs = [
    [16, 1], [16, 2], [32, 1], [32, 2],
    [128, 1], [128, 2], [256, 1], [256, 2], [512, 1], [512, 2],
  ];
  for (const [logical, scale] of pairs) {
    const pixels = logical * scale;
    const suffix = scale === 2 ? '@2x' : '';
    const out = path.join(iconset, `icon_${logical}x${logical}${suffix}.png`);
    run(`"${magick}" "${png1024}" -resize ${pixels}x${pixels} "${out}"`);
  }
  run(`iconutil -c icns "${iconset}" -o "${icnsPath}"`);
  fs.rmSync(iconset, { recursive: true, force: true });
  console.log('icon.icns generated.');
}

// ── Step 3: Windows ICO ───────────────────────────────────────────────────────

console.log('Generating icon.ico…');
const magick2 = findMagick();
if (magick2) {
  const icoSizes = [16, 32, 48, 64, 128, 256];
  const tmpPngs = icoSizes.map(s => {
    const p = path.join(assets, `_tmp_${s}.png`);
    run(`"${magick2}" "${png1024}" -resize ${s}x${s} "${p}"`);
    return p;
  });
  try {
    run(`"${magick2}" ${tmpPngs.map(p => `"${p}"`).join(' ')} "${icoPath}"`);
  } catch {
    console.warn('ICO generation failed (non-critical for macOS builds).');
  }
  tmpPngs.forEach(p => { try { fs.unlinkSync(p); } catch {} });
  console.log('icon.ico generated.');
} else {
  console.warn('Skipping ICO — ImageMagick not found.');
}

console.log('Icons done.');
