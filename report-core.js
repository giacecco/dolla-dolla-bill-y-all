'use strict';

/**
 * Shared reporting core: entry discovery, aggregation, table/CSV formatting, retagging.
 * Used by the ddbya-report CLI and desktop/main.js (CSV export).
 * Zero npm dependencies — Node.js built-ins only.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Constants ─────────────────────────────────────────────────────────────────

const DDBYA_DIR = '.ddbya.d';
const USAGE_GLOB_RE = /^usage-.+\.ddbya$/;
const CLAUDE_DESKTOP_PROJECT = '*Claude Desktop*';

// ── Platform paths ────────────────────────────────────────────────────────────

function claudeDesktopLogDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'ddbya', 'Claude Desktop', DDBYA_DIR);
  }
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA;
    return appdata ? path.join(appdata, 'ddbya', 'Claude Desktop', DDBYA_DIR) : null;
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdg, 'ddbya', 'Claude Desktop', DDBYA_DIR);
}

// ── File discovery ────────────────────────────────────────────────────────────

/**
 * Yield { jsonlPath, projectDir } pairs for all usage files under root.
 * If root directly contains a .ddbya.d/ with usage files, reports on that
 * project only; otherwise scans subdirectories recursively.
 */
function discoverUsagePaths(root) {
  const results = [];

  const directDir = path.join(root, DDBYA_DIR);
  if (fs.existsSync(directDir)) {
    let stat;
    try { stat = fs.statSync(directDir); } catch {}
    if (stat && stat.isDirectory()) {
      const files = fs.readdirSync(directDir).filter(f => USAGE_GLOB_RE.test(f)).sort();
      if (files.length > 0) {
        for (const f of files) results.push({ jsonlPath: path.join(directDir, f), projectDir: root });
        return results;
      }
    }
  }

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === DDBYA_DIR) {
        let files;
        try { files = fs.readdirSync(full); } catch { continue; }
        for (const f of files.filter(f => USAGE_GLOB_RE.test(f)).sort()) {
          results.push({ jsonlPath: path.join(full, f), projectDir: dir });
        }
      } else {
        walk(full);
      }
    }
  }
  walk(root);
  return results;
}

function discoverClaudeDesktopPaths() {
  const cdDir = claudeDesktopLogDir();
  if (!cdDir || !fs.existsSync(cdDir)) return [];
  try {
    return fs.readdirSync(cdDir)
      .filter(f => USAGE_GLOB_RE.test(f))
      .sort()
      .map(f => ({ jsonlPath: path.join(cdDir, f) }));
  } catch { return []; }
}

function isClaudeDesktopPath(jsonlPath) {
  const cdDir = claudeDesktopLogDir();
  if (!cdDir) return false;
  const resolved = path.resolve(jsonlPath);
  const cdResolved = path.resolve(cdDir);
  return resolved.startsWith(cdResolved + path.sep) || resolved === cdResolved;
}

// ── Tag matching ──────────────────────────────────────────────────────────────

function matchTag(pattern, tag) {
  if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2) {
    try { return new RegExp(pattern.slice(1, -1)).test(tag); } catch { return false; }
  }
  return pattern === tag;
}

// ── Entry collection ──────────────────────────────────────────────────────────

function collectFromFile(jsonlPath, project, fromDate, toDate, tagFilters, modelFilters) {
  const entries = [];
  let lines;
  try { lines = fs.readFileSync(jsonlPath, 'utf8').split('\n'); } catch { return entries; }

  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) continue;
    let entry;
    try { entry = JSON.parse(stripped); } catch { continue; }
    let ts;
    try { ts = new Date(entry.timestamp); if (isNaN(ts.getTime())) continue; } catch { continue; }

    if (fromDate && ts < fromDate) continue;
    if (toDate && ts >= toDate) continue;

    let entryTags = Array.isArray(entry.tags) ? [...entry.tags].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())) : [];
    if (tagFilters && tagFilters.length > 0) {
      if (!tagFilters.every(pat => entryTags.some(tag => matchTag(pat, tag)))) continue;
    }
    const entryModel = entry.model || '';
    if (modelFilters && modelFilters.length > 0) {
      if (!modelFilters.some(pat => matchTag(pat, entryModel))) continue;
    }

    entries.push({
      project,
      model: entryModel,
      tags: entryTags,
      input_tokens: entry.input_tokens || 0,
      output_tokens: entry.output_tokens || 0,
      cache_read: entry.cache_read_input_tokens || 0,
      cache_create: entry.cache_creation_input_tokens || 0,
      requests: 1,
    });
  }
  return entries;
}

function collectEntries(root, fromDate, toDate, tagFilters, modelFilters) {
  const entries = [];
  let cdIncluded = false;

  for (const { jsonlPath, projectDir } of discoverUsagePaths(root)) {
    let project;
    if (isClaudeDesktopPath(jsonlPath)) {
      project = CLAUDE_DESKTOP_PROJECT;
      cdIncluded = true;
    } else if (projectDir === root || path.resolve(projectDir) === path.resolve(root)) {
      project = path.basename(root) || path.basename(path.resolve(root));
    } else {
      const rel = path.relative(root, projectDir);
      project = rel.split(path.sep)[0];
    }
    entries.push(...collectFromFile(jsonlPath, project, fromDate, toDate, tagFilters, modelFilters));
  }

  if (!cdIncluded) {
    for (const { jsonlPath } of discoverClaudeDesktopPaths()) {
      entries.push(...collectFromFile(jsonlPath, CLAUDE_DESKTOP_PROJECT, fromDate, toDate, tagFilters, modelFilters));
    }
  }

  return entries;
}

// ── Retagging ─────────────────────────────────────────────────────────────────

/**
 * Modify tags in .ddbya.d/usage-*.ddbya files in-place.
 * Returns { modifiedEntries, modifiedFiles }.
 */
function retag(root, fromDate, toDate, tagFilters, addTags, removeTags) {
  const paths = discoverUsagePaths(root).map(({ jsonlPath }) => jsonlPath);

  // Include Claude Desktop paths unless already under root
  const rootResolved = path.resolve(root);
  for (const { jsonlPath } of discoverClaudeDesktopPaths()) {
    if (!path.resolve(jsonlPath).startsWith(rootResolved + path.sep)) {
      paths.push(jsonlPath);
    }
  }

  let totalModified = 0;
  let filesModified = 0;

  for (const jsonlPath of paths) {
    let rawLines;
    try { rawLines = fs.readFileSync(jsonlPath, 'utf8').split('\n'); } catch (err) {
      process.stderr.write(`ddbya-report: skipped ${jsonlPath}: ${err.message}\n`);
      continue;
    }

    let fileModified = false;
    const outLines = [];

    for (const raw of rawLines) {
      const stripped = raw.trim();
      if (!stripped) { outLines.push(raw); continue; }

      let entry;
      try { entry = JSON.parse(stripped); } catch { outLines.push(raw); continue; }
      let ts;
      try { ts = new Date(entry.timestamp); if (isNaN(ts.getTime())) throw new Error(); } catch { outLines.push(raw); continue; }

      if (fromDate && ts < fromDate) { outLines.push(raw); continue; }
      if (toDate && ts >= toDate) { outLines.push(raw); continue; }

      let entryTags = Array.isArray(entry.tags) ? [...entry.tags].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())) : [];

      if (tagFilters && tagFilters.length > 0) {
        if (!tagFilters.every(pat => entryTags.some(tag => matchTag(pat, tag)))) { outLines.push(raw); continue; }
      }

      const before = [...entryTags];
      for (const t of addTags) { if (!entryTags.includes(t)) entryTags.push(t); }
      entryTags = entryTags.filter(t => !removeTags.some(pat => matchTag(pat, t)));

      if (JSON.stringify(entryTags) === JSON.stringify(before)) { outLines.push(raw); continue; }

      if (entryTags.length > 0) entry.tags = entryTags;
      else delete entry.tags;

      const sorted = Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)));
      outLines.push(JSON.stringify(sorted) + '\n');
      totalModified++;
      fileModified = true;
    }

    if (fileModified) {
      const tmp = jsonlPath + '.tmp';
      try {
        fs.writeFileSync(tmp, outLines.join('\n'));
        fs.renameSync(tmp, jsonlPath);
        filesModified++;
      } catch (err) {
        process.stderr.write(`ddbya-report: could not write ${jsonlPath}: ${err.message}\n`);
        try { fs.unlinkSync(tmp); } catch {}
      }
    }
  }

  return { modifiedEntries: totalModified, modifiedFiles: filesModified };
}

// ── Aggregation ───────────────────────────────────────────────────────────────

function aggregate(entries) {
  const groups = new Map();
  for (const e of entries) {
    const key = JSON.stringify([e.project, e.model, e.tags]);
    if (!groups.has(key)) {
      groups.set(key, { project: e.project, model: e.model, tags: e.tags,
        input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, requests: 0 });
    }
    const g = groups.get(key);
    g.input_tokens += e.input_tokens;
    g.output_tokens += e.output_tokens;
    g.cache_read += e.cache_read;
    g.cache_create += e.cache_create;
    g.requests += e.requests;
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, g]) => g);
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmt(n) {
  if (n === 0) return '-';
  return n.toLocaleString('en-US');
}

function colWidths(rows) {
  const showTags = rows.some(r => r.tags && r.tags.length > 0);
  const showModel = rows.some(r => r.model);
  const joinTags = tags => tags && tags.length ? tags.join(' | ') : '';

  const extraLabels = ['(subtotal)', 'TOTAL'];
  const projects = [...rows.map(r => r.project), ...extraLabels];
  const models = [...rows.map(r => r.model || ''), ''];
  const allTags = [...rows.map(r => joinTags(r.tags)), ''];
  const reqs = rows.map(r => fmt(r.requests));
  const inputs = rows.map(r => fmt(r.input_tokens));
  const reads = rows.map(r => fmt(r.cache_read));
  const creates = rows.map(r => fmt(r.cache_create));
  const totals = rows.map(r => fmt(r.input_tokens + r.cache_read + r.cache_create));
  const outputs = rows.map(r => fmt(r.output_tokens));

  function lw(header, values) { return -(Math.max(header.length, values.length ? Math.max(...values.map(s => s.length)) : 0)); }
  function rw(header, values) { return Math.max(header.length, values.length ? Math.max(...values.map(s => s.length)) : 0); }

  const cols = [['Project', lw('Project', projects)]];
  if (showModel) cols.push(['Model', lw('Model', models)]);
  cols.push(
    ['Reqs', rw('Reqs', reqs)],
    ['Input (base)', rw('Input (base)', inputs)],
    ['Cache Read', rw('Cache Read', reads)],
    ['Cache Create', rw('Cache Create', creates)],
    ['Total Input', rw('Total Input', totals)],
    ['Output Tokens', rw('Output Tokens', outputs)],
  );
  if (showTags) cols.push(['Tags', lw('Tags', allTags)]);

  const byName = Object.fromEntries(cols.map(([label, width]) => [label, width]));
  return { cols, byName, showTags, showModel };
}

function buildRow(values, byName) {
  return values.map(([value, name]) => {
    const width = byName[name];
    const s = String(value);
    return width < 0 ? s.padEnd(-width) : s.padStart(width);
  }).join('  ');
}

// ── Table report ──────────────────────────────────────────────────────────────

function dateStr(d) { return d.toISOString().slice(0, 10); }

/**
 * Print a formatted token-usage table to process.stdout.
 */
function report(rows, fromDate, toDate) {
  let header;
  if (!fromDate) {
    header = 'Token Usage Report — all data';
  } else {
    const toDisplay = new Date(toDate.getTime() - 86400000);
    const diffDays = (toDisplay - fromDate) / 86400000;
    if (diffDays < 1) {
      header = `Token Usage Report — ${dateStr(fromDate)}`;
    } else {
      header = `Token Usage Report — ${dateStr(fromDate)} to ${dateStr(toDisplay)}`;
    }
  }
  process.stdout.write(header + '\n\n');

  if (!rows.length) { process.stdout.write('No usage data found.\n'); return; }

  const { cols, byName, showTags, showModel } = colWidths(rows);
  const joinTags = tags => tags && tags.length ? tags.join(' | ') : '';

  const headerLine = cols.map(([label, width]) => width < 0 ? label.padEnd(-width) : label.padStart(width)).join('  ');
  const separator = cols.map(([, width]) => '─'.repeat(Math.abs(width))).join('  ');
  process.stdout.write(headerLine + '\n' + separator + '\n');

  let lastProject = null;
  let projInput = 0, projOutput = 0, projRead = 0, projCreate = 0, projReqs = 0;
  let totInput = 0, totOutput = 0, totRead = 0, totCreate = 0, totReqs = 0;

  function flushProject() {
    if (lastProject !== null && projReqs > 0 && lastProject !== CLAUDE_DESKTOP_PROJECT) {
      const vals = [['(subtotal)', 'Project']];
      if (showModel) vals.push(['', 'Model']);
      vals.push(
        [fmt(projReqs), 'Reqs'], [fmt(projInput), 'Input (base)'],
        [fmt(projRead), 'Cache Read'], [fmt(projCreate), 'Cache Create'],
        [fmt(projInput + projRead + projCreate), 'Total Input'], [fmt(projOutput), 'Output Tokens'],
      );
      process.stdout.write(buildRow(vals, byName) + '\n\n');
    }
    projInput = projOutput = projRead = projCreate = projReqs = 0;
  }

  for (const r of rows) {
    if (r.project !== lastProject) { flushProject(); lastProject = r.project; }

    const vals = [[r.project, 'Project']];
    if (showModel) vals.push([r.model || '', 'Model']);
    vals.push(
      [fmt(r.requests), 'Reqs'], [fmt(r.input_tokens), 'Input (base)'],
      [fmt(r.cache_read), 'Cache Read'], [fmt(r.cache_create), 'Cache Create'],
      [fmt(r.input_tokens + r.cache_read + r.cache_create), 'Total Input'], [fmt(r.output_tokens), 'Output Tokens'],
    );
    if (showTags) vals.push([joinTags(r.tags), 'Tags']);
    process.stdout.write(buildRow(vals, byName) + '\n');

    projInput += r.input_tokens; projOutput += r.output_tokens;
    projRead += r.cache_read; projCreate += r.cache_create; projReqs += r.requests;
    totInput += r.input_tokens; totOutput += r.output_tokens;
    totRead += r.cache_read; totCreate += r.cache_create; totReqs += r.requests;
  }
  flushProject();

  const totVals = [['TOTAL', 'Project']];
  if (showModel) totVals.push(['', 'Model']);
  totVals.push(
    [fmt(totReqs), 'Reqs'], [fmt(totInput), 'Input (base)'],
    [fmt(totRead), 'Cache Read'], [fmt(totCreate), 'Cache Create'],
    [fmt(totInput + totRead + totCreate), 'Total Input'], [fmt(totOutput), 'Output Tokens'],
  );
  process.stdout.write(buildRow(totVals, byName) + '\n');
}

// ── CSV report ────────────────────────────────────────────────────────────────

function csvEscape(value) {
  const s = String(value == null ? '' : value);
  return (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}

function csvLine(fields) { return fields.map(csvEscape).join(',') + '\n'; }

/**
 * Return a CSV string for the given aggregated rows.
 */
function csvReport(rows) {
  if (!rows.length) return '';
  const showTags = rows.some(r => r.tags && r.tags.length > 0);
  const showModel = rows.some(r => r.model);
  const headers = ['Project'];
  if (showModel) headers.push('Model');
  headers.push('Reqs', 'Input (base)', 'Cache Read', 'Cache Create', 'Total Input', 'Output Tokens');
  if (showTags) headers.push('Tags');

  let out = csvLine(headers);
  for (const r of rows) {
    const totalInput = r.input_tokens + r.cache_read + r.cache_create;
    const row = [r.project];
    if (showModel) row.push(r.model || '');
    row.push(r.requests, r.input_tokens, r.cache_read, r.cache_create, totalInput, r.output_tokens);
    if (showTags) row.push(r.tags && r.tags.length ? r.tags.join(' | ') : '');
    out += csvLine(row);
  }
  return out;
}

module.exports = {
  CLAUDE_DESKTOP_PROJECT,
  claudeDesktopLogDir,
  collectEntries,
  retag,
  aggregate,
  fmt,
  report,
  csvReport,
};
