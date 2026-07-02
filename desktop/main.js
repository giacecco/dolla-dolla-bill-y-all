'use strict';

const {
  app, Tray, Menu, nativeImage, BrowserWindow, dialog, ipcMain, shell, clipboard,
} = require('electron');

// Must be set before app is ready; the setter companion goes inside whenReady().
app.commandLine.appendSwitch('disable-renderer-accessibility');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');

const {
  DDBYA_DIR,
  DEFAULT_UPSTREAM,
  resolveIdentity,
  TokenLogger,
  buildProxy,
} = require(path.join(__dirname, '..', 'proxy-core.js'));

// ── Constants ─────────────────────────────────────────────────────────────────

const USAGE_GLOB_RE = /^usage-.+\.ddbya$/;
const DEFAULT_PORT = 18723;

// ── Settings ──────────────────────────────────────────────────────────────────

function loadSettings() {
  const state = loadState();
  return {
    upstreamBaseUrl: state.upstreamBaseUrl || DEFAULT_UPSTREAM,
    disableBeta: state.disableBeta || state.disableCaching || false,
  };
}

function saveSettings(settings) {
  saveState({
    upstreamBaseUrl: settings.upstreamBaseUrl || DEFAULT_UPSTREAM,
    disableBeta: !!settings.disableBeta,
  });
}

// ── Platform paths ────────────────────────────────────────────────────────────

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const isLinux = !isMac && !isWin;

function appSupportDir() {
  if (isMac) return path.join(os.homedir(), 'Library', 'Application Support', 'ddbya');
  if (isWin) return path.join(process.env.APPDATA || os.homedir(), 'ddbya');
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdg, 'ddbya');
}

const APP_SUPPORT = appSupportDir();
const CD_LOG_DIR = path.join(APP_SUPPORT, 'Claude Desktop', DDBYA_DIR);
const STATE_FILE = path.join(APP_SUPPORT, 'state.json');

// ── State persistence ─────────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(updates) {
  const state = { ...loadState(), ...updates };
  const dir = path.dirname(STATE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
  return state;
}

// ── Port management ───────────────────────────────────────────────────────────

function isPortFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(); resolve(true); });
    srv.listen(port, '127.0.0.1');
  });
}

async function acquirePort() {
  const state = loadState();
  const preferred = state.port || DEFAULT_PORT;
  if (await isPortFree(preferred)) return preferred;

  // Port in use — pick a random free one
  const srv = net.createServer();
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  await new Promise(resolve => srv.close(resolve));
  return port;
}

// ── Past-tags collection ──────────────────────────────────────────────────────

function collectPastTags() {
  const tags = new Set();
  if (!fs.existsSync(CD_LOG_DIR)) return [];
  try {
    for (const f of fs.readdirSync(CD_LOG_DIR)) {
      if (!USAGE_GLOB_RE.test(f)) continue;
      const lines = fs.readFileSync(path.join(CD_LOG_DIR, f), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (Array.isArray(entry.tags)) entry.tags.forEach(t => typeof t === 'string' && tags.add(t));
        } catch {}
      }
    }
  } catch {}
  return [...tags].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

// ── Claude Desktop launch / env ───────────────────────────────────────────────

function findClaudeDesktop() {
  if (isMac) {
    const p = '/Applications/Claude.app/Contents/MacOS/Claude';
    return fs.existsSync(p) ? p : null;
  }
  if (isWin) {
    const candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'AnthropicClaude', 'claude.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Claude', 'claude.exe'),
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
  }
  if (isLinux) {
    const candidates = [
      path.join(os.homedir(), '.local', 'bin', 'claude-desktop'),
      '/usr/bin/claude-desktop',
      '/usr/local/bin/claude-desktop',
      '/opt/claude-desktop/claude-desktop',
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
  }
  return null;
}

function linuxEnvFile() {
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'environment.d', 'ddbya.conf');
}

function setProxyEnv(port) {
  const url = `http://127.0.0.1:${port}`;
  if (isMac) {
    try { execSync(`launchctl setenv ANTHROPIC_BASE_URL "${url}"`); } catch {}
  } else if (isWin) {
    try {
      execSync(
        `reg add "HKCU\\Environment" /v ANTHROPIC_BASE_URL /t REG_SZ /d "${url}" /f`,
        { shell: true },
      );
    } catch {}
  } else if (isLinux) {
    try {
      const f = linuxEnvFile();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, `ANTHROPIC_BASE_URL=${url}\n`);
    } catch {}
  }
}

function unsetProxyEnv() {
  if (isMac) {
    try { execSync('launchctl unsetenv ANTHROPIC_BASE_URL'); } catch {}
  } else if (isWin) {
    try {
      execSync('reg delete "HKCU\\Environment" /v ANTHROPIC_BASE_URL /f', { shell: true });
    } catch {}
  } else if (isLinux) {
    try { fs.unlinkSync(linuxEnvFile()); } catch {}
  }
}

function isClaudeDesktopRunning() {
  try {
    if (isMac) {
      const out = execSync('pgrep -x Claude', { timeout: 3000 }).toString().trim();
      return out.length > 0;
    }
    if (isWin) {
      const out = execSync('tasklist /FI "IMAGENAME eq claude.exe" /NH', { timeout: 3000 }).toString();
      return out.toLowerCase().includes('claude.exe');
    }
    if (isLinux) {
      const out = execSync('pgrep -x claude-desktop', { timeout: 3000 }).toString().trim();
      return out.length > 0;
    }
  } catch {}
  return false;
}

async function killClaudeDesktop() {
  try {
    if (isMac) execSync('pkill -x Claude', { timeout: 3000 });
    if (isLinux) execSync('pkill -x claude-desktop', { timeout: 3000 });
    if (isWin) {
      // Graceful: send WM_CLOSE first, wait up to 3 s, then force
      try { execSync('taskkill /IM claude.exe', { shell: true, timeout: 3000 }); } catch {}
      await new Promise(r => setTimeout(r, 3000));
      if (isClaudeDesktopRunning()) {
        try { execSync('taskkill /IM claude.exe /F', { shell: true, timeout: 3000 }); } catch {}
      }
    }
  } catch {}
}

async function launchClaudeDesktop(port) {
  const claudePath = findClaudeDesktop();
  if (!claudePath) {
    dialog.showErrorBox(
      'Claude Desktop not found',
      isMac
        ? 'Claude Desktop was not found at /Applications/Claude.app.\n\nPlease install Claude Desktop and try again.'
        : 'Claude Desktop was not found.\n\nPlease install Claude Desktop and try again.',
    );
    return;
  }

  if (isClaudeDesktopRunning()) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Claude Desktop is already running',
      message: 'Claude Desktop is already open and its token consumption will not be recorded by ddbya.\n\nClose the existing session and relaunch it through ddbya Desktop so all usage is logged.',
      buttons: ['Close and Relaunch', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
    await killClaudeDesktop();
    await new Promise(r => setTimeout(r, 800));
  }

  const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` };
  spawn(claudePath, [], { detached: true, stdio: 'ignore', env }).unref();
}

// ── Report core (shared with ddbya-report) ────────────────────────────────────

function reportCore() {
  const corePath = app.isPackaged
    ? path.join(process.resourcesPath, 'report-core.js')
    : path.join(__dirname, '..', 'report-core.js');
  return require(corePath);
}

// ── Report export ─────────────────────────────────────────────────────────────

function exportCsvReport(from, to) {
  let core;
  try { core = reportCore(); } catch (err) {
    return { ok: false, error: `Could not load report-core.js: ${err.message}` };
  }

  const root = path.join(APP_SUPPORT, 'Claude Desktop');
  // Dates from the picker are local calendar days — use local midnight boundaries
  const localMidnight = (ymd, plusDays) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(y, m - 1, d + (plusDays || 0));
  };
  const fromDate = from ? localMidnight(from) : null;
  let toDate = to ? localMidnight(to, 1) : null;
  if (fromDate && !toDate) toDate = new Date();

  try {
    const entries = core.collectEntries(root, fromDate, toDate);
    const rows = core.aggregate(entries);
    let reportPricing = null;
    const savedPricingState = loadState();
    if (savedPricingState.pricingCsvPath && core.loadPricingCsv) reportPricing = core.loadPricingCsv(savedPricingState.pricingCsvPath);
    if (!reportPricing && savedPricingState.pricingCsvContent && core.parsePricingCsvFromText) reportPricing = core.parsePricingCsvFromText(savedPricingState.pricingCsvContent);
    return { ok: true, csv: core.csvReport(rows, reportPricing) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Renderer windows ──────────────────────────────────────────────────────────

let tagsWin = null;
let reportWin = null;
let settingsWin = null;

function openTagsWindow() {
  if (tagsWin && !tagsWin.isDestroyed()) { tagsWin.focus(); return; }
  tagsWin = new BrowserWindow({
    width: 440,
    height: 340,
    title: 'Change Tags — ddbya Desktop',
    resizable: false,
    fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  tagsWin.loadFile(path.join(__dirname, 'renderer', 'tags.html'));
  tagsWin.on('closed', () => { tagsWin = null; });
}

function openReportWindow() {
  if (reportWin && !reportWin.isDestroyed()) { reportWin.focus(); return; }
  reportWin = new BrowserWindow({
    width: 480,
    height: 320,
    title: 'Export Report — ddbya Desktop',
    resizable: false,
    fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  reportWin.loadFile(path.join(__dirname, 'renderer', 'report.html'));
  reportWin.on('closed', () => { reportWin = null; });
}

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 600,
    title: 'Settings — ddbya Desktop',
    resizable: false,
    fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ── Pricing ───────────────────────────────────────────────────────────────────

let pricingData = null; // Map<lowerModelName, {inputPerMtok, outputPerMtok, cacheReadPerMtok, cacheWritePerMtok}>

function parsePricingCsvFromText(text) {
  try { return reportCore().parsePricingCsvFromText(text); } catch { return null; }
}

function loadPricingCsv(csvPath) {
  try { return parsePricingCsvFromText(fs.readFileSync(csvPath, 'utf8')); } catch { return null; }
}

function computeCost(info) {
  let p = null;
  try { p = reportCore().lookupPricingFromMap(info.model, pricingData); } catch {}
  if (!p) return null;
  return (info.input * p.inputPerMtok + info.output * p.outputPerMtok +
          info.cacheRead * p.cacheReadPerMtok + info.cacheCreate * p.cacheWritePerMtok) / 1_000_000;
}

// ── Tray token counter ────────────────────────────────────────────────────────

let sessionTokenTotal = 0;   // true cumulative total (updated on each API response)
let displayedTokens = 0;     // what's currently shown (animated toward sessionTokenTotal)
let sessionCostTotal = 0;    // cumulative estimated cost when pricing CSV is active
let displayedCost = 0;
let lastCallUnpriced = false; // true if the most recent API call used an unrecognised model
let tokenAnimInterval = null;

function formatTokens(n) {
  if (n <= 0) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(cost) {
  if (cost <= 0) return '';
  if (cost >= 1_000_000) return `$${(cost / 1_000_000).toFixed(1)}M`;
  if (cost >= 1_000) return `$${(cost / 1_000).toFixed(1)}K`;
  return `$${cost.toFixed(2)}`;
}

// ── Tray icon label (Windows/Linux) ───────────────────────────────────────────
// tray.setTitle() is macOS-only; on Windows/Linux the counter is drawn into the
// icon bitmap itself. 3×5 pixel font, white with a 1px black outline so it is
// legible on both light and dark taskbars. Regeneration is throttled to 1/s.

const TRAY_FONT = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '011', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '.': ['0', '0', '0', '0', '1'],
  '!': ['1', '1', '1', '0', '1'],
  'K': ['101', '110', '100', '110', '101'],
  'M': ['101', '111', '111', '101', '101'],
};

function renderLabelIcon(label) {
  const glyphs = [...label].map(c => TRAY_FONT[c]);
  if (!glyphs.length || glyphs.some(g => !g)) return null;
  const textW = glyphs.reduce((s, g) => s + g[0].length, 0) + glyphs.length - 1;
  if (textW > 16) return null;

  const grid = Array.from({ length: 16 }, () => new Array(16).fill(false));
  let x = Math.floor((16 - textW) / 2);
  const y0 = 5;
  for (const g of glyphs) {
    const w = g[0].length;
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < w; c++) if (g[r][c] === '1') grid[y0 + r][x + c] = true;
    }
    x += w + 1;
  }

  const isText = (gx, gy) => gx >= 0 && gy >= 0 && gx < 16 && gy < 16 && grid[gy][gx];
  const isOutline = (gx, gy) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) if (isText(gx + dx, gy + dy)) return true;
    }
    return false;
  };

  const img = nativeImage.createEmpty();
  for (const scale of [1, 2]) {
    const size = 16 * scale;
    const buf = Buffer.alloc(size * size * 4); // transparent
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const gx = Math.floor(px / scale), gy = Math.floor(py / scale);
        let v = null; // greyscale, so BGRA/RGBA order is irrelevant
        if (isText(gx, gy)) v = 255;
        else if (isOutline(gx, gy)) v = 0;
        if (v !== null) {
          const i = (py * size + px) * 4;
          buf[i] = buf[i + 1] = buf[i + 2] = v;
          buf[i + 3] = 255;
        }
      }
    }
    img.addRepresentation({ scaleFactor: scale, width: size, height: size, buffer: buf });
  }
  return img;
}

// Short labels that fit 16px: at most 4 glyphs (plus a leading narrow '!').
function shortScaled(n, div, suffix) {
  let s = (n / div).toFixed(1);
  if (s.length > 3) s = String(Math.round(n / div));
  return s + suffix;
}

function formatTokensShort(n) {
  if (n <= 0) return '';
  if (n < 1000) return String(n);
  if (n < 999500) return shortScaled(n, 1000, 'K');
  if (n < 999500000) return shortScaled(n, 1_000_000, 'M');
  return '999M';
}

function formatCostShort(c) {
  if (c < 9.995) return c.toFixed(2);
  if (c < 99.95) return c.toFixed(1);
  if (c < 999.5) return String(Math.round(c));
  return formatTokensShort(Math.round(c));
}

let baseTrayIcon = null;
let trayLabelLast = null;
let trayLabelTimer = null;
let trayLabelLastAt = 0;

function applyTrayIconLabel() {
  if (!tray) return;
  const useCost = pricingData !== null;
  const label = useCost
    ? (lastCallUnpriced ? '!' : '') + formatCostShort(sessionCostTotal)
    : formatTokensShort(Math.round(sessionTokenTotal));
  if (label === trayLabelLast) return;
  const img = label ? renderLabelIcon(label) : null;
  tray.setImage(img || baseTrayIcon || nativeImage.createEmpty());
  trayLabelLast = label;
}

function scheduleTrayIconLabel() {
  const since = Date.now() - trayLabelLastAt;
  if (since >= 1000) {
    trayLabelLastAt = Date.now();
    applyTrayIconLabel();
    return;
  }
  if (trayLabelTimer) return;
  trayLabelTimer = setTimeout(() => {
    trayLabelTimer = null;
    trayLabelLastAt = Date.now();
    applyTrayIconLabel();
  }, 1000 - since);
}

function applyTrayTitle() {
  if (!tray) return;
  const useCost = pricingData !== null;
  let label;
  if (useCost) {
    const costStr = sessionCostTotal > 0 ? formatCost(displayedCost) : '$0.00';
    label = lastCallUnpriced ? `⚠ ${costStr}` : costStr;
  } else {
    label = formatTokens(Math.round(displayedTokens));
  }
  if (isMac) tray.setTitle(label ? ` ${label}` : '', { fontType: 'monospacedDigit' });
  else scheduleTrayIconLabel();
  let tip = `ddbya Desktop — port ${currentPort}`;
  if (useCost) {
    const tokStr = formatTokens(Math.round(sessionTokenTotal));
    tip += `\n${sessionCostTotal > 0 ? formatCost(sessionCostTotal) : '$0.00'} estimated cost this session`;
    if (tokStr) tip += ` (${tokStr} tokens)`;
    if (lastCallUnpriced) tip += '\n⚠ last API call used an unrecognised model';
  } else if (label) {
    tip += `\n${label} tokens this session`;
  }
  tray.setToolTip(tip);
}

function addSessionTokens(info) {
  const n = typeof info === 'number' ? info : info.total;
  if (n <= 0) return;
  sessionTokenTotal += n;
  if (pricingData && typeof info === 'object') {
    const cost = computeCost(info);
    if (cost !== null) { sessionCostTotal += cost; lastCallUnpriced = false; }
    else lastCallUnpriced = true;
  }
  if (tokenAnimInterval) return; // already animating
  tokenAnimInterval = setInterval(() => {
    const tokLeft = sessionTokenTotal - displayedTokens;
    if (tokLeft > 0) displayedTokens += Math.max(1, Math.ceil(tokLeft / 10));
    else displayedTokens = sessionTokenTotal;
    const costLeft = sessionCostTotal - displayedCost;
    if (costLeft > 1e-9) displayedCost += costLeft / 10;
    else displayedCost = sessionCostTotal;
    applyTrayTitle();
    if (displayedTokens >= sessionTokenTotal && displayedCost >= sessionCostTotal - 1e-9) {
      displayedTokens = sessionTokenTotal;
      displayedCost = sessionCostTotal;
      clearInterval(tokenAnimInterval);
      tokenAnimInterval = null;
    }
  }, 50); // 20 fps
}

// ── Tray ──────────────────────────────────────────────────────────────────────

let tray = null;
let currentTags = [];
let currentPort = null;

function buildMenu() {
  const tagLabel = currentTags.length
    ? `Tags: ${currentTags.join(', ')}`
    : 'No tags set';
  return Menu.buildFromTemplate([
    { label: tagLabel, enabled: false },
    { type: 'separator' },
    { label: 'Settings…', click: openSettingsWindow },
    { label: 'Change Tags…', click: openTagsWindow },
    { label: 'Export Report (CSV)…', click: openReportWindow },
    { label: 'Open Session Log', click: () => { if (currentLogPath) shell.openPath(currentLogPath); } },
    { label: 'Open Logs Folder', click: () => shell.openPath(CD_LOG_DIR) },
    { type: 'separator' },
    { label: 'Launch Claude Desktop', click: () => launchClaudeDesktop(currentPort) },
    { type: 'separator' },
    {
      label: 'Quit',
      click: async () => {
        if (isClaudeDesktopRunning()) {
          const { response } = await dialog.showMessageBox({
            type: 'question',
            title: 'Quit ddbya Desktop',
            message: 'Claude Desktop is still running.\n\nWithout ddbya Desktop, its token usage will not be recorded.',
            buttons: ['Quit Both', 'Quit ddbya Only', 'Cancel'],
            defaultId: 0,
            cancelId: 2,
          });
          if (response === 2) return;
          if (response === 0) killClaudeDesktop();
        }
        unsetProxyEnv();
        app.quit();
      },
    },
  ]);
}

function rebuildTrayMenu() {
  if (tray) tray.setContextMenu(buildMenu());
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('get-tags', () => currentTags);

ipcMain.handle('get-past-tags', () => collectPastTags());

ipcMain.handle('save-tags', (_event, tags) => {
  currentTags = Array.isArray(tags) ? tags.filter(t => typeof t === 'string' && t.trim()) : [];
  saveState({ tags: currentTags });
  rebuildTrayMenu();
});

ipcMain.handle('get-settings', () => ({
  ...loadSettings(),
  proxyUrl: currentPort ? `http://127.0.0.1:${currentPort}` : null,
}));

ipcMain.handle('save-settings', async (_event, settings) => {
  if (settings.upstreamBaseUrl !== undefined) {
    let parsed;
    try { parsed = new URL(settings.upstreamBaseUrl); } catch {
      throw new Error('Invalid upstream URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Upstream URL must use http or https');
    }
    if (!parsed.hostname) {
      throw new Error('Upstream URL must have a hostname');
    }
  }

  const prev = loadSettings();
  saveSettings(settings);
  const next = loadSettings();

  // disableBeta takes effect immediately — mutate the live opts object
  proxyOpts.disableBeta = next.disableBeta;

  // Upstream URL change requires a new server instance; force-close all sockets
  if (next.upstreamBaseUrl !== prev.upstreamBaseUrl && proxyServer) {
    for (const s of proxySockets) s.destroy();
    proxySockets.clear();
    await new Promise(resolve => proxyServer.close(resolve));
    proxyOpts = { disableBeta: next.disableBeta };
    proxyServer = buildProxy(next.upstreamBaseUrl, tokenLogger, () => currentTags, proxyOpts, info => addSessionTokens(info));
    proxyServer.on('connection', s => { proxySockets.add(s); s.on('close', () => proxySockets.delete(s)); });
    await new Promise((resolve, reject) => {
      proxyServer.once('error', reject);
      proxyServer.listen(currentPort, '127.0.0.1', resolve);
    });
  }
});

ipcMain.handle('copy-to-clipboard', (_event, text) => {
  clipboard.writeText(text);
});

ipcMain.handle('close-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

ipcMain.handle('export-csv', async (_event, { from, to }) => {
  return exportCsvReport(from || null, to || null);
});

ipcMain.handle('get-pricing-path', () => loadState().pricingCsvPath || null);

ipcMain.handle('open-pricing-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Select Pricing CSV',
    filters: [{ name: 'CSV files', extensions: ['csv'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { ok: false };
  const csvPath = filePaths[0];
  let rawText;
  try { rawText = fs.readFileSync(csvPath, 'utf8'); } catch { return { ok: false, error: 'Could not read the selected file.' }; }
  const data = parsePricingCsvFromText(rawText);
  if (!data) return { ok: false, error: 'Could not parse pricing data — check the file has Name, Input Price per 1M tokens, and Output Price per 1M tokens columns.' };
  pricingData = data;
  saveState({ pricingCsvPath: csvPath, pricingCsvContent: rawText });

  // Recompute session cost from all entries logged so far this session
  sessionCostTotal = 0;
  if (tokenLogger) {
    for (const entry of tokenLogger._entries) {
      const cost = computeCost({
        model: entry.model || '',
        input: entry.input_tokens || 0,
        output: entry.output_tokens || 0,
        cacheRead: entry.cache_read_input_tokens || 0,
        cacheCreate: entry.cache_creation_input_tokens || 0,
      });
      if (cost !== null) sessionCostTotal += cost;
      lastCallUnpriced = cost === null;
    }
  }
  displayedCost = sessionCostTotal;
  applyTrayTitle();

  return { ok: true, path: csvPath, modelCount: data.size };
});

ipcMain.handle('clear-pricing', () => {
  pricingData = null;
  lastCallUnpriced = false;
  saveState({ pricingCsvPath: null, pricingCsvContent: null });
  applyTrayTitle();
});

ipcMain.handle('save-csv', async (_event, { csv: csvContent, defaultName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: defaultName || 'claude-desktop-report.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, csvContent, 'utf8');
  shell.showItemInFolder(filePath);
  return { ok: true, filePath };
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

let proxyServer = null;
let proxyOpts = { disableBeta: false };
const proxySockets = new Set();
let tokenLogger = null;
let currentLogPath = null;

app.whenReady().then(async () => {
  // Disable accessibility support (setter must be called after ready)
  app.accessibilitySupportEnabled = false;

  // Single-instance enforcement
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  // Hide from macOS Dock — we live only in the menu bar
  if (app.dock) app.dock.hide();

  // Set up token log
  fs.mkdirSync(CD_LOG_DIR, { recursive: true });
  const identity = resolveIdentity({
    getStored: () => loadState().identity || null,
    setStored: id => saveState({ identity: id }),
  });
  const sessionId = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  currentLogPath = path.join(CD_LOG_DIR, `usage-${identity}-${sessionId}.ddbya`);
  tokenLogger = new TokenLogger(currentLogPath);

  // Acquire port (persistent across restarts unless in use)
  currentPort = await acquirePort();
  const prevPort = loadState().port;
  if (prevPort && prevPort !== currentPort) {
    dialog.showMessageBox({
      type: 'warning',
      title: 'ddbya Desktop — Proxy Port Changed',
      message: `Port ${prevPort} was already in use.\n\nThe proxy is now listening on port ${currentPort}.\n\nPlease restart Claude Desktop so it picks up the new address.`,
      buttons: ['OK'],
    });
  }
  saveState({ port: currentPort });

  // Load saved tags
  currentTags = loadState().tags || [];

  // Load pricing CSV if previously configured; fall back to stored content if original file is gone
  const savedState = loadState();
  if (savedState.pricingCsvPath) pricingData = loadPricingCsv(savedState.pricingCsvPath);
  if (!pricingData && savedState.pricingCsvContent) pricingData = parsePricingCsvFromText(savedState.pricingCsvContent);

  // Start proxy — use saved upstream base URL, not env var
  const { upstreamBaseUrl: upstream, disableBeta } = loadSettings();
  proxyOpts = { disableBeta };
  proxyServer = buildProxy(upstream, tokenLogger, () => currentTags, proxyOpts, info => addSessionTokens(info));
  proxyServer.on('connection', s => { proxySockets.add(s); s.on('close', () => proxySockets.delete(s)); });
  try {
    await new Promise((resolve, reject) => {
      proxyServer.once('error', reject);
      proxyServer.listen(currentPort, '127.0.0.1', resolve);
    });
  } catch (err) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Could not start proxy',
      message: `Port ${currentPort} is already in use.\n\n${err.message}`,
    });
    app.quit();
    return;
  }

  // Register proxy URL with launchd (macOS) / registry (Windows) so Claude
  // Desktop picks it up on next launch — even if started from Finder/Spotlight.
  setProxyEnv(currentPort);

  // Warn if Claude Desktop is already running without the proxy
  if (isClaudeDesktopRunning()) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Claude Desktop is already running',
      message: 'Claude Desktop is open and its token consumption is not being recorded.\n\nClose the existing session and relaunch it through ddbya Desktop (via the menu bar icon) so all usage is logged.',
      buttons: ['Close and Relaunch Now', 'I\'ll Do It Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      await killClaudeDesktop();
      await new Promise(r => setTimeout(r, 800));
      const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${currentPort}` };
      const claudePath = findClaudeDesktop();
      if (claudePath) spawn(claudePath, [], { detached: true, stdio: 'ignore', env }).unref();
    }
  }

  // Create tray icon — use macOS template images (auto-adapt to dark/light menu bar)
  const trayIconPath = path.join(__dirname, 'assets', 'TrayIconTemplate.png');
  let icon = nativeImage.createFromPath(trayIconPath);
  if (icon.isEmpty()) icon = nativeImage.createEmpty();
  baseTrayIcon = icon;

  tray = new Tray(icon);
  tray.setToolTip(`ddbya Desktop — port ${currentPort}`);
  tray.setContextMenu(buildMenu());
  if (isMac) tray.on('click', () => tray.popUpContextMenu());
});

app.on('second-instance', () => {
  // A second launch was attempted — bring whichever window is open to front
  for (const win of [settingsWin, tagsWin, reportWin]) {
    if (win && !win.isDestroyed()) { win.focus(); return; }
  }
});

// Don't quit when all renderer windows close — we're a tray-only app.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  unsetProxyEnv();
  if (proxyServer) {
    for (const s of proxySockets) s.destroy();
    proxySockets.clear();
    proxyServer.close();
  }
  if (tokenLogger) tokenLogger.close();
});
