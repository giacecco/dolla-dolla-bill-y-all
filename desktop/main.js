'use strict';

const {
  app, Tray, Menu, nativeImage, BrowserWindow, dialog, ipcMain, shell, clipboard,
} = require('electron');

// Must be set before app is ready; the setter companion goes inside whenReady().
app.commandLine.appendSwitch('disable-renderer-accessibility');
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync, spawn } = require('child_process');
const crypto = require('crypto');
const zlib = require('zlib');

// ── Constants ─────────────────────────────────────────────────────────────────

const DDBYA_DIR = '.ddbya.d';
const USAGE_GLOB_RE = /^usage-.+\.ddbya$/;
const DEFAULT_UPSTREAM = 'https://api.anthropic.com';
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

function appSupportDir() {
  if (isMac) return path.join(os.homedir(), 'Library', 'Application Support', 'ddbya');
  if (isWin) return path.join(process.env.APPDATA || os.homedir(), 'ddbya');
  return path.join(os.homedir(), '.ddbya');
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

// ── Identity ──────────────────────────────────────────────────────────────────

function sanitiseIdentity(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'anonymous';
}

function resolveIdentity() {
  try {
    const email = execSync('git config --global user.email', { timeout: 3000 }).toString().trim();
    if (email) return sanitiseIdentity(email);
  } catch {}
  const user = (() => { try { return os.userInfo().username; } catch { return ''; } })();
  if (user) return sanitiseIdentity(user);
  const state = loadState();
  if (state.identity) return state.identity;
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  saveState({ identity: id });
  return id;
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

// ── Token logger ──────────────────────────────────────────────────────────────

class TokenLogger {
  constructor(logPath) {
    this.logPath = logPath;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    this.fd = fs.openSync(logPath, 'a');
    this.closed = false;
  }

  log(entry) {
    if (this.closed) return;
    entry.timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const sorted = Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeSync(this.fd, JSON.stringify(sorted) + '\n');
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { fs.closeSync(this.fd); } catch {}
  }
}

// ── Reverse proxy ─────────────────────────────────────────────────────────────

function stripCacheControl(obj) {
  if (Array.isArray(obj)) return obj.map(stripCacheControl);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'cache_control') continue;
      out[k] = stripCacheControl(v);
    }
    return out;
  }
  return obj;
}

// optsRef is a plain object { disableBeta } that callers may mutate after
// buildProxy returns — each incoming request reads it fresh, so changes take
// effect immediately without restarting the server.
function buildProxy(upstream, logger, tagsGetter, optsRef) {
  const upUrl = new URL(upstream);
  const isUpHttps = upUrl.protocol === 'https:';
  const upBasePath = upUrl.pathname.replace(/\/$/, '');

  function forwardRequest(req, res) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);

      let isStreaming = false;
      try { isStreaming = !!JSON.parse(body).stream; } catch {}

      const upHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const low = k.toLowerCase();
        if (['host', 'connection', 'proxy-connection'].includes(low)) continue;
        upHeaders[k] = v;
      }

      // Strip ?beta query param from forwarded URL regardless of disableBeta
      let forwardUrl = req.url;
      if (optsRef.disableBeta) {
        try {
          const u = new URL(req.url, 'http://localhost');
          u.searchParams.delete('beta');
          forwardUrl = u.pathname + (u.search.length > 1 ? u.search : '');
        } catch {}
      }

      if (optsRef.disableBeta && body.length > 0) {
        try {
          const parsed = JSON.parse(body.toString());
          let obj = stripCacheControl(parsed);
          // Bedrock requires system to be a plain string, not an array of blocks
          if (Array.isArray(obj.system)) {
            obj.system = obj.system
              .filter(b => b && b.type === 'text')
              .map(b => (typeof b.text === 'string' ? b.text : ''))
              .join('\n\n');
          }
          body = Buffer.from(JSON.stringify(obj));
          // Replace content-length (any case) with the new body size
          for (const k of Object.keys(upHeaders)) {
            if (k.toLowerCase() === 'content-length') delete upHeaders[k];
          }
          upHeaders['content-length'] = String(body.length);
        } catch {}
      }

      // Remove anthropic-beta header entirely when beta features are disabled
      if (optsRef.disableBeta) {
        for (const k of Object.keys(upHeaders)) {
          if (k.toLowerCase() === 'anthropic-beta') delete upHeaders[k];
        }
      }

      const opts = {
        hostname: upUrl.hostname,
        port: upUrl.port || (isUpHttps ? 443 : 80),
        path: upBasePath + forwardUrl,
        method: req.method,
        headers: upHeaders,
        timeout: 300000,
      };

      const proto = isUpHttps ? https : http;
      const upReq = proto.request(opts, upRes => {
        const isGzip = (upRes.headers['content-encoding'] || '').toLowerCase() === 'gzip';

        const resHeaders = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          const low = k.toLowerCase();
          if (['transfer-encoding', 'connection', 'keep-alive'].includes(low)) continue;
          if (low === 'content-encoding' && v.toLowerCase() === 'gzip') continue;
          if (low === 'content-length' && (isGzip || isStreaming)) continue;
          resHeaders[k] = v;
        }
        try { res.writeHead(upRes.statusCode, resHeaders); } catch { return; }

        if (isStreaming) {
          relayStream(upRes, res, isGzip, logger, tagsGetter);
        } else {
          const parts = [];
          let stream = upRes;
          if (isGzip) {
            const gz = zlib.createGunzip();
            upRes.pipe(gz);
            stream = gz;
          }
          stream.on('data', c => parts.push(c));
          stream.on('end', () => {
            const respBody = Buffer.concat(parts);
            try { res.end(respBody); } catch {}
            extractUsageNonStream(respBody, logger, tagsGetter);
          });
          stream.on('error', () => { try { res.end(); } catch {} });
        }
      });

      upReq.on('error', err => {
        try { res.writeHead(502); res.end(`Bad Gateway: ${err.message}`); } catch {}
      });
      if (body.length) upReq.write(body);
      upReq.end();
    });
  }

  return http.createServer(forwardRequest);
}

function relayStream(upRes, res, isGzip, logger, tagsGetter) {
  let best = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, model: '' };
  let pending = Buffer.alloc(0);

  function processLine(line) {
    if (!line.startsWith('data: ')) return;
    let ev;
    try { ev = JSON.parse(line.slice(6)); } catch { return; }
    const type = ev.type;
    if (type === 'message_start') {
      const u = (ev.message || {}).usage || {};
      if (u.input_tokens > 0) best.input = u.input_tokens;
      best.cacheRead = u.cache_read_input_tokens || 0;
      best.cacheCreate = u.cache_creation_input_tokens || 0;
      if (ev.message && ev.message.model) best.model = ev.message.model;
    } else if (type === 'message_delta') {
      const u = ev.usage || {};
      if (u.output_tokens > 0) best.output = u.output_tokens;
      if (ev.model) best.model = ev.model;
    } else if (type === 'message_stop') {
      const u = ev.usage || {};
      if (u.input_tokens > 0) best.input = u.input_tokens;
      if (u.output_tokens > 0) best.output = u.output_tokens;
      if (ev.model) best.model = ev.model;
    }
  }

  function handleChunk(chunk) {
    pending = Buffer.concat([pending, chunk]);
    let idx;
    while ((idx = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, idx).toString('utf8').replace(/\r$/, '');
      pending = pending.slice(idx + 1);
      processLine(line);
    }
  }

  let stream = upRes;
  if (isGzip) {
    const gz = zlib.createGunzip();
    upRes.pipe(gz);
    stream = gz;
  }
  stream.on('data', chunk => {
    try { res.write(chunk); } catch {}
    handleChunk(chunk);
  });
  stream.on('end', () => {
    if (pending.length) processLine(pending.toString('utf8').replace(/\r$/, ''));
    try { res.end(); } catch {}
    if (best.input > 0 || best.output > 0) logEntry(best, true, logger, tagsGetter);
  });
  stream.on('error', () => { try { res.end(); } catch {}; });
}

function extractUsageNonStream(body, logger, tagsGetter) {
  let data;
  try { data = JSON.parse(body.toString()); } catch { return; }
  const usage = data.usage;
  if (!usage) return;
  logEntry({
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheCreate: usage.cache_creation_input_tokens || 0,
    model: data.model || '',
  }, false, logger, tagsGetter);
}

function logEntry(best, stream, logger, tagsGetter) {
  const entry = { stream, input_tokens: best.input, output_tokens: best.output };
  if (best.model) entry.model = best.model;
  const tags = tagsGetter();
  if (tags.length) entry.tags = [...tags];
  if (best.cacheRead) entry.cache_read_input_tokens = best.cacheRead;
  if (best.cacheCreate) entry.cache_creation_input_tokens = best.cacheCreate;
  logger.log(entry);
  addSessionTokens(best.input + best.output + best.cacheRead + best.cacheCreate);
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
  return null;
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
  }
}

function unsetProxyEnv() {
  if (isMac) {
    try { execSync('launchctl unsetenv ANTHROPIC_BASE_URL'); } catch {}
  } else if (isWin) {
    try {
      execSync('reg delete "HKCU\\Environment" /v ANTHROPIC_BASE_URL /f', { shell: true });
    } catch {}
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
  } catch {}
  return false;
}

function killClaudeDesktop() {
  try {
    if (isMac) execSync('pkill -x Claude', { timeout: 3000 });
    if (isWin) execSync('taskkill /IM claude.exe /F', { shell: true, timeout: 3000 });
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
    killClaudeDesktop();
    await new Promise(r => setTimeout(r, 800));
  }

  const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` };
  spawn(claudePath, [], { detached: true, stdio: 'ignore', env }).unref();
}

// ── Report export ─────────────────────────────────────────────────────────────

function exportCsvReport(from, to) {
  // In development __dirname = desktop/, so ../ddbya-report = repo root script.
  // When packaged, electron-builder copies it to Contents/Resources/ddbya-report.
  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'ddbya-report')
    : path.join(__dirname, '..', 'ddbya-report');
  const cdFolder = path.join(APP_SUPPORT, 'Claude Desktop');
  const args = [cdFolder, '--csv'];
  if (from) { args.push('--from', from); }
  if (to) { args.push('--to', to); }

  // Try python3 then python
  for (const py of ['python3', 'python']) {
    try {
      const result = spawnSync(py, [scriptPath, ...args], { encoding: 'utf8', timeout: 30000 });
      if (result.status === 0) return { ok: true, csv: result.stdout };
      return { ok: false, error: result.stderr || `Exit code ${result.status}` };
    } catch (err) {
      if (err.code !== 'ENOENT') return { ok: false, error: err.message };
    }
  }
  return { ok: false, error: 'Python 3 not found. Install Python 3 to export reports.' };
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

// ── Tray token counter ────────────────────────────────────────────────────────

let sessionTokenTotal = 0;   // true cumulative total (updated on each API response)
let displayedTokens = 0;     // what's currently shown (animated toward sessionTokenTotal)
let tokenAnimInterval = null;

function formatTokens(n) {
  if (n <= 0) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function applyTrayTitle() {
  if (!tray) return;
  const label = formatTokens(Math.round(displayedTokens));
  if (isMac) tray.setTitle(label ? ` ${label}` : '', { fontType: 'monospacedDigit' });
  const tip = label
    ? `ddbya Desktop — port ${currentPort}\n${label} tokens this session`
    : `ddbya Desktop — port ${currentPort}`;
  tray.setToolTip(tip);
}

function addSessionTokens(n) {
  if (n <= 0) return;
  sessionTokenTotal += n;
  if (tokenAnimInterval) return; // already animating toward the new target
  tokenAnimInterval = setInterval(() => {
    const remaining = sessionTokenTotal - displayedTokens;
    if (remaining <= 0) {
      displayedTokens = sessionTokenTotal;
      applyTrayTitle();
      clearInterval(tokenAnimInterval);
      tokenAnimInterval = null;
      return;
    }
    // Ease: cover ~10 % of remaining distance per frame, minimum 1 token
    displayedTokens += Math.max(1, Math.ceil(remaining / 10));
    applyTrayTitle();
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
    proxyServer = buildProxy(next.upstreamBaseUrl, tokenLogger, () => currentTags, proxyOpts);
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
  const identity = resolveIdentity();
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

  // Start proxy — use saved upstream base URL, not env var
  const { upstreamBaseUrl: upstream, disableBeta } = loadSettings();
  proxyOpts = { disableBeta };
  proxyServer = buildProxy(upstream, tokenLogger, () => currentTags, proxyOpts);
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
      killClaudeDesktop();
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
