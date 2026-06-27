'use strict';
/**
 * Custom signing script for the universal Electron app bundle.
 * Problem: Spotlight/Finder immediately re-adds com.apple.FinderInfo to
 * .app directories after xattr -d, causing codesign to fail. Solution: strip
 * xattrs from all ancestor bundle directories immediately before each codesign call.
 *
 * Usage: node macos/sign.js <app-path> <identity> <entitlements-plist>
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ATTRS_TO_STRIP = ['com.apple.FinderInfo', 'com.apple.fileprovider.fpfs#P'];

function stripDirXattrs(dir) {
  for (const attr of ATTRS_TO_STRIP) {
    try { execFileSync('xattr', ['-d', attr, dir], { stdio: 'ignore' }); } catch {}
  }
}

// Strip xattrs from filePath itself (if dir) AND all ancestor dirs up to rootApp
function stripAncestors(filePath, rootApp) {
  // Strip the item itself if it's a directory (bundle)
  try { if (fs.statSync(filePath).isDirectory()) stripDirXattrs(filePath); } catch {}
  // Strip all parent dirs up to and including rootApp
  let dir = path.dirname(filePath);
  while (dir.startsWith(rootApp)) {
    stripDirXattrs(dir);
    if (dir === rootApp) break;
    dir = path.dirname(dir);
  }
  stripDirXattrs(rootApp);
}

function isBinary(filePath) {
  try {
    const buf = Buffer.alloc(4);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    const magic = buf.readUInt32BE(0);
    return (magic === 0xCAFEBABE || magic === 0xFEEDFACF || magic === 0xFEEDFACE ||
            magic === 0xCFFAEDFE || magic === 0xCEFAEDFE || magic === 0xBEBAFECA);
  } catch { return false; }
}

function collect(dir) {
  const items = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return items; }
  // Recurse into subdirectories FIRST (so nested binaries are signed before their parent frameworks)
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    items.push(...collect(full));
    const ext = path.extname(full);
    if (ext === '.app' || ext === '.framework') items.push({ type: 'bundle', path: full });
  }
  // Then collect binary files in this directory
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = path.join(dir, e.name);
    if (isBinary(full)) items.push({ type: 'binary', path: full });
  }
  return items;
}

function codesign(filePath, identity, entitlements, rootApp) {
  const args = [
    '--sign', identity, '--force', '--timestamp', '--options', 'runtime',
    '--entitlements', entitlements, filePath,
  ];
  // Retry up to 5 times: FinderInfo is re-added by Spotlight between strip and sign
  for (let attempt = 0; attempt < 5; attempt++) {
    stripAncestors(filePath, rootApp);
    try {
      execFileSync('codesign', args, { stdio: 'pipe' });
      return;
    } catch (e) {
      const msg = (e.stderr || e.stdout || '').toString();
      if (!msg.includes('FinderInfo') && !msg.includes('resource fork') && !msg.includes('detritus')) throw e;
      if (attempt === 4) throw e;
      // FinderInfo race — strip again and retry
    }
  }
}

const [, , appPath, identity, entitlements] = process.argv;
if (!appPath || !identity || !entitlements) {
  console.error('Usage: node sign.js <app-path> <identity> <entitlements-plist>');
  process.exit(1);
}

const contentsDir = path.join(appPath, 'Contents');
const items = collect(contentsDir);
items.push({ type: 'bundle', path: appPath });

console.log(`Signing ${items.length} items in ${appPath}…`);
let n = 0;
for (const item of items) {
  try {
    codesign(item.path, identity, entitlements, appPath);
    n++;
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || '').toString();
    console.error(`Failed [${n + 1}/${items.length}]: ${item.path}\n${msg}`);
    process.exit(1);
  }
}

console.log(`Signed ${n} items OK.`);
