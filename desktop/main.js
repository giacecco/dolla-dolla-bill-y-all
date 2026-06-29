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

// ── Report export ─────────────────────────────────────────────────────────────

function exportCsvReport(from, to) {
  const corePath = app.isPackaged
    ? path.join(process.resourcesPath, 'report-core.js')
    : path.join(__dirname, '..', 'report-core.js');

  let core;
  try { core = require(corePath); } catch (err) {
    return { ok: false, error: `Could not load report-core.js: ${err.message}` };
  }

  const root = path.join(APP_SUPPORT, 'Claude Desktop');
  const fromDate = from ? new Date(from + 'T00:00:00Z') : null;
  let toDate = to ? new Date(new Date(to + 'T00:00:00Z').getTime() + 86400000) : null;
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

function parseCSVLine(line) {
  const cols = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { cols.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cols.push(cur);
  return cols;
}

function parsePricingCsvFromText(text) {
  try {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return null;
    const header = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
    const ci = name => header.indexOf(name.toLowerCase());
    const iName = ci('name');
    const iIn   = ci('input price per 1m tokens');
    const iOut  = ci('output price per 1m tokens');
    const iCR   = ci('cache read per 1m tokens');
    const iCW   = ci('cache write per 1m tokens');
    if (iName === -1 || iIn === -1 || iOut === -1) return null;
    const parseNum = (cols, i) => { if (i === -1) return 0; const v = (cols[i] || '').trim().replace(/[$,\s]/g, ''); return (v === '-' || !v || v === 'n/a') ? 0 : (parseFloat(v) || 0); };
    const map = new Map();
    for (const line of lines.slice(1)) {
      const cols = parseCSVLine(line);
      const name = (cols[iName] || '').trim().toLowerCase();
      if (!name) continue;
      map.set(name, { inputPerMtok: parseNum(cols, iIn), outputPerMtok: parseNum(cols, iOut), cacheReadPerMtok: parseNum(cols, iCR), cacheWritePerMtok: parseNum(cols, iCW) });
    }
    return map.size ? map : null;
  } catch { return null; }
}

function loadPricingCsv(csvPath) {
  try { return parsePricingCsvFromText(fs.readFileSync(csvPath, 'utf8')); } catch { return null; }
}

function lookupPricing(model) {
  if (!pricingData || !model) return null;
  const m = model.toLowerCase();
  // 1. Exact match
  if (pricingData.has(m)) return pricingData.get(m);
  // 2. Strip provider prefix from model (e.g. "anthropic.claude-..." → "claude-...")
  const dot = m.indexOf('.');
  if (dot !== -1 && pricingData.has(m.slice(dot + 1))) return pricingData.get(m.slice(dot + 1));
  // 3. Strip provider prefix from CSV key, then check if one is a prefix of the other.
  //    Handles e.g. "claude-haiku-4-5-20251001" matching "anthropic.claude-haiku-4-5-20251001-v1:0"
  for (const [key, val] of pricingData) {
    const base = key.includes('.') ? key.slice(key.indexOf('.') + 1) : key;
    if (base.startsWith(m) || m.startsWith(base)) return val;
  }
  return null;
}

function computeCost(info) {
  const p = lookupPricing(info.model);
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

  tray = new Tray(icon);
  tray.setToolTip(`ddbya Desktop — port ${currentPort}`);
  tray.setContextMenu(buildMenu());
  if (isMac) tray.on('click', () => tray.popUpContextMenu());
});

app.on('second-instance', () => {
  // A second launch was attempted — just bring the existing instance to front
  if (tagsWin && !tagsWin.isDestroyed()) tagsWin.focus();
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
