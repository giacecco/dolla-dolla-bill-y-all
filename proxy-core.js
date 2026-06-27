'use strict';

/**
 * Shared reverse-proxy and token-logging core.
 * Used by the ddbya CLI wrapper and (eventually) desktop/main.js.
 * Zero npm dependencies — Node.js built-ins only.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { execSync } = require('child_process');

// ── Constants ─────────────────────────────────────────────────────────────────

const DDBYA_DIR = '.ddbya.d';
const USAGE_FILENAME_PREFIX = 'usage-';
const DEFAULT_UPSTREAM = 'https://api.anthropic.com';

// ── Identity ──────────────────────────────────────────────────────────────────

function sanitiseIdentity(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'anonymous';
}

/**
 * Resolve a per-user identity string for log filenames.
 *
 * Resolution order: git config --global user.email → os.userInfo().username →
 * UUID stored via opts.getStored/opts.setStored (default: ~/.config/ddbya/id).
 *
 * opts.getStored() → string|null
 * opts.setStored(id: string) → void
 */
function resolveIdentity(opts) {
  opts = opts || {};
  const defaultFile = path.join(os.homedir(), '.config', 'ddbya', 'id');
  const getStored = opts.getStored || (() => {
    try { return fs.readFileSync(defaultFile, 'utf8').trim() || null; } catch { return null; }
  });
  const setStored = opts.setStored || ((id) => {
    try {
      fs.mkdirSync(path.dirname(defaultFile), { recursive: true });
      fs.writeFileSync(defaultFile, id + '\n');
    } catch {}
  });

  try {
    const email = execSync('git config --global user.email', { timeout: 3000 }).toString().trim();
    if (email) return sanitiseIdentity(email);
  } catch {}

  try {
    const user = os.userInfo().username;
    if (user) return sanitiseIdentity(user);
  } catch {}

  const stored = getStored();
  if (stored) return sanitiseIdentity(stored);
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  setStored(id);
  return id;
}

// ── Token logger ──────────────────────────────────────────────────────────────

class TokenLogger {
  constructor(logPath) {
    this.logPath = logPath;
    this._entries = [];
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    this.fd = fs.openSync(logPath, 'a');
    this.closed = false;
  }

  log(entry) {
    if (this.closed) return;
    entry = { ...entry, timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
    const sorted = Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeSync(this.fd, JSON.stringify(sorted) + '\n');
    this._entries.push(entry);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { fs.closeSync(this.fd); } catch {}
  }

  summary() {
    return {
      input: this._entries.reduce((s, e) => s + (e.input_tokens || 0), 0),
      output: this._entries.reduce((s, e) => s + (e.output_tokens || 0), 0),
      cacheRead: this._entries.reduce((s, e) => s + (e.cache_read_input_tokens || 0), 0),
      cacheCreate: this._entries.reduce((s, e) => s + (e.cache_creation_input_tokens || 0), 0),
      count: this._entries.length,
    };
  }
}

// ── Proxy internals ───────────────────────────────────────────────────────────

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

function logEntry(best, stream, logger, tagsGetter, onTokens) {
  const entry = { stream, input_tokens: best.input, output_tokens: best.output };
  if (best.model) entry.model = best.model;
  const tags = tagsGetter ? tagsGetter() : [];
  if (tags.length) entry.tags = [...tags];
  if (best.cacheRead) entry.cache_read_input_tokens = best.cacheRead;
  if (best.cacheCreate) entry.cache_creation_input_tokens = best.cacheCreate;
  logger.log(entry);
  if (onTokens) onTokens(best.input + best.output + best.cacheRead + best.cacheCreate);
}

function processLine(line, best) {
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

function relayStream(upRes, res, isGzip, logger, tagsGetter, onTokens) {
  const best = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, model: '' };
  let pending = Buffer.alloc(0);

  function handleChunk(chunk) {
    pending = Buffer.concat([pending, chunk]);
    let idx;
    while ((idx = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, idx).toString('utf8').replace(/\r$/, '');
      pending = pending.slice(idx + 1);
      processLine(line, best);
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
    if (pending.length) processLine(pending.toString('utf8').replace(/\r$/, ''), best);
    try { res.end(); } catch {}
    if (best.input > 0 || best.output > 0) logEntry(best, true, logger, tagsGetter, onTokens);
  });
  stream.on('error', () => { try { res.end(); } catch {} });
}

function extractUsageNonStream(body, logger, tagsGetter, onTokens) {
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
  }, false, logger, tagsGetter, onTokens);
}

// ── Reverse proxy ─────────────────────────────────────────────────────────────

/**
 * Build an http.Server that proxies all requests to upstream, logging token usage.
 *
 * optsRef: { disableBeta: bool } — read fresh per request; may be mutated after build.
 * onTokens: optional (totalTokens: number) => void called after each logged entry.
 *
 * Returns an http.Server (not yet listening — caller must call server.listen()).
 */
function buildProxy(upstream, logger, tagsGetter, optsRef, onTokens) {
  optsRef = optsRef || {};
  const upUrl = new URL(upstream);
  const isUpHttps = upUrl.protocol === 'https:';
  const upBasePath = upUrl.pathname.replace(/\/$/, '');

  function forwardRequest(req, res) {
    const chunks = [];
    req.on('error', () => res.destroy());
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
          let obj = stripCacheControl(JSON.parse(body.toString()));
          if (Array.isArray(obj.system)) {
            obj.system = obj.system
              .filter(b => b && b.type === 'text')
              .map(b => (typeof b.text === 'string' ? b.text : ''))
              .join('\n\n');
          }
          body = Buffer.from(JSON.stringify(obj));
          for (const k of Object.keys(upHeaders)) {
            if (k.toLowerCase() === 'content-length') delete upHeaders[k];
          }
          upHeaders['content-length'] = String(body.length);
        } catch {}
      }

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
          relayStream(upRes, res, isGzip, logger, tagsGetter, onTokens);
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
            extractUsageNonStream(respBody, logger, tagsGetter, onTokens);
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

module.exports = {
  DDBYA_DIR,
  USAGE_FILENAME_PREFIX,
  DEFAULT_UPSTREAM,
  sanitiseIdentity,
  resolveIdentity,
  TokenLogger,
  buildProxy,
};
