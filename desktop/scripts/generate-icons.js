#!/usr/bin/env node
'use strict';

/**
 * Generates icon.png, icon.icns (macOS), and icon.ico (Windows) from icon.svg.
 * Requires ImageMagick's `convert` command.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const assets = path.join(__dirname, '..', 'assets');
const svg = path.join(assets, 'icon.svg');
const png1024 = path.join(assets, 'icon.png');
const icnsPath = path.join(assets, 'icon.icns');
const icoPath = path.join(assets, 'icon.ico');
const iconset = path.join(assets, 'icon.iconset');

function run(cmd) {
  try {
    execSync(cmd, { stdio: 'pipe' });
  } catch (err) {
    console.error(`Failed: ${cmd}`);
    console.error(err.stderr ? err.stderr.toString() : err.message);
    process.exit(1);
  }
}

function findConvert() {
  for (const c of ['/opt/homebrew/bin/convert', '/usr/local/bin/convert', 'convert']) {
    try { execSync(`which ${c}`, { stdio: 'pipe' }); return c; } catch {}
  }
  return null;
}

const convert = findConvert();
if (!convert) {
  console.error('ImageMagick `convert` not found. Install with: brew install imagemagick');
  process.exit(1);
}

console.log('Generating icon.png (1024×1024)…');
run(`"${convert}" -background none "${svg}" -resize 1024x1024 "${png1024}"`);

// macOS ICNS ─────────────────────────────────────────────────────────────────
if (process.platform === 'darwin') {
  console.log('Generating icon.icns…');
  fs.mkdirSync(iconset, { recursive: true });

  const pairs = [
    [16, 1], [16, 2], [32, 1], [32, 2],
    [128, 1], [128, 2], [256, 1], [256, 2], [512, 1], [512, 2],
  ];
  for (const [logical, scale] of pairs) {
    const pixels = logical * scale;
    const suffix = scale === 2 ? '@2x' : '';
    const out = path.join(iconset, `icon_${logical}x${logical}${suffix}.png`);
    run(`"${convert}" "${png1024}" -resize ${pixels}x${pixels} "${out}"`);
  }
  run(`iconutil -c icns "${iconset}" -o "${icnsPath}"`);
  fs.rmSync(iconset, { recursive: true, force: true });
  console.log('icon.icns generated.');
}

// Windows ICO ─────────────────────────────────────────────────────────────────
console.log('Generating icon.ico…');
const icoSizes = [16, 32, 48, 64, 128, 256];
const tmpPngs = icoSizes.map(s => {
  const p = path.join(assets, `icon_tmp_${s}.png`);
  run(`"${convert}" "${png1024}" -resize ${s}x${s} "${p}"`);
  return p;
});
try {
  run(`"${convert}" ${tmpPngs.map(p => `"${p}"`).join(' ')} "${icoPath}"`);
} catch {
  // ImageMagick may not support ICO on all installs — warn but don't fail
  console.warn('ICO generation failed (non-critical for macOS builds).');
}
tmpPngs.forEach(p => { try { fs.unlinkSync(p); } catch {} });

console.log('Icons done.');
