/**
 * AGY Context Monitor sidecar backend.
 *
 * Read-only local server that parses Antigravity conversation transcripts under
 * <appData>/brain/<conversationId>/.system_generated/logs/ and serves:
 *   - GET /api/session   : Live context occupancy, per-model & expandable item
 *                          composition, growth timeline, file/command activity.
 *   - GET /api/overview  : Aggregated Project or Global insights (KPIs, dynamic
 *                          hourly/daily/weekly/monthly/yearly usage series,
 *                          token/duration breakdowns, heatmap, rankings, sessions).
 *
 * Runs natively inside Antigravity via `sidecar_sdk`, and falls back to a
 * lightweight `node:http` server when launched standalone for development.
 */

import { execFile, execFileSync } from 'node:child_process';
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, DEFAULT_MODEL_SPECS, emptyBuckets, estimateTokens, parseTrace, parseTranscript } from './parser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f-]{8,}$/i;
const MAX_FULL_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const SCAN_CACHE_MS = 2500;

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

// ---------------------------------------------------------------------------
// App data directory discovery
// ---------------------------------------------------------------------------

function safeReaddir(p) {
  try { return readdirSync(p); } catch { return []; }
}

function statOf(p) {
  try {
    const s = statSync(p);
    return { mtime: s.mtimeMs, size: s.size };
  } catch {
    return { mtime: 0, size: -1 };
  }
}

function findAppDataDirs() {
  const override = process.env.AGY_CONTEXT_APP_DATA_DIR;
  if (override && existsSync(join(override, 'brain'))) return [override];

  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      return existsSync(join(appData, 'brain')) ? [appData] : [];
    }
    return [];
  }

  const root = join(homedir(), '.gemini');
  const dirs = safeReaddir(root).sort().map((name) => join(root, name));
  return dirs.filter((c) => existsSync(join(c, 'brain')));
}

function pickTranscriptFile(appData, convId) {
  const logsDir = join(appData, 'brain', convId, '.system_generated', 'logs');
  const fullPath = join(logsDir, 'transcript_full.jsonl');
  const compactPath = join(logsDir, 'transcript.jsonl');

  const fullStat = statOf(fullPath);
  if (fullStat.size > 0 && fullStat.size <= MAX_FULL_TRANSCRIPT_BYTES) {
    return { path: fullPath, stat: fullStat };
  }
  const compactStat = statOf(compactPath);
  if (compactStat.size > 0) return { path: compactPath, stat: compactStat };
  if (fullStat.size > 0) return { path: fullPath, stat: fullStat };
  return null;
}

// ---------------------------------------------------------------------------
// Conversation metadata (title + authoritative workspaceUri) via agentapi
// ---------------------------------------------------------------------------

const metaCache = new Map(); // convId -> { title, workspace, workspaceUri, fetchedAt } | 'pending'
const metaQueue = [];
let activeMetaFetches = 0;
const MAX_CONCURRENT_META = 3;

function normalizeWsUri(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\/+$/, '');
}

function workspaceNameFromUri(uri) {
  if (!uri) return '';
  const clean = uri.replace(/^file:\/\//, '').replace(/\/+$/, '');
  return basename(clean) || clean;
}

function extractMetaFields(md) {
  const cm = md?.response?.conversationMetadata || md?.conversationMetadata || md || {};
  const inner = cm?.metadata || md?.metadata || {};

  const title = cm?.title || cm?.summary || md?.title || md?.summary || md?.name || inner?.title || '';

  const wsCandidate =
    (Array.isArray(inner?.workspaceUris) && inner.workspaceUris[0])
    || (Array.isArray(inner?.workspaces) && inner.workspaces[0]?.workspaceFolderAbsoluteUri)
    || (Array.isArray(md?.workspaceUris) && md.workspaceUris[0])
    || (Array.isArray(md?.workspacePaths) && md.workspacePaths[0])
    || md?.workspace
    || md?.projectName
    || '';

  const workspaceUri = normalizeWsUri(wsCandidate);
  const workspace = workspaceNameFromUri(workspaceUri);
  return {
    title: String(title || '').trim(),
    workspace: String(workspace || '').trim(),
    workspaceUri,
  };
}

function pumpMetaQueue() {
  while (activeMetaFetches < MAX_CONCURRENT_META && metaQueue.length > 0) {
    const convId = metaQueue.shift();
    activeMetaFetches++;
    const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
    const file = exe || 'agentapi';
    const args = [...(exe ? ['agentapi'] : []), 'get-conversation-metadata', convId];
    execFile(file, args, { encoding: 'utf-8', timeout: 4000 }, (err, stdout) => {
      activeMetaFetches--;
      if (err) {
        metaCache.set(convId, { title: '', workspace: '', workspaceUri: '', fetchedAt: Date.now() });
      } else {
        try {
          const parsed = JSON.parse(stdout || '{}');
          metaCache.set(convId, { ...extractMetaFields(parsed), fetchedAt: Date.now() });
        } catch {
          metaCache.set(convId, { title: '', workspace: '', workspaceUri: '', fetchedAt: Date.now() });
        }
      }
      pumpMetaQueue();
    });
  }
}

function getConvMeta(convId) {
  if (!convId || !ID_RE.test(convId)) return { title: '', workspace: '', workspaceUri: '' };
  const hit = metaCache.get(convId);
  if (hit && hit !== 'pending') return hit;
  if (!hit && process.env.ANTIGRAVITY_AGENTAPI_EXE) {
    metaCache.set(convId, 'pending');
    metaQueue.push(convId);
    pumpMetaQueue();
  }
  return { title: '', workspace: '', workspaceUri: '' };
}

// ---------------------------------------------------------------------------
// Lifecycle hook timing loader (written by hooks/record_timing.py)
// ---------------------------------------------------------------------------

function pickHookTimingFile(appData, convId) {
  if (!convId || !ID_RE.test(convId)) return null;
  const candidates = [];
  if (process.env.PLUGIN_DATA) {
    candidates.push(join(process.env.PLUGIN_DATA, 'timings', `${convId}.jsonl`));
  }
  if (appData) {
    candidates.push(join(appData, 'plugin_data', 'agy-context', 'timings', `${convId}.jsonl`));
  }
  candidates.push(join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'agy-context', 'timings', `${convId}.jsonl`));

  const seen = new Set();
  for (const p of candidates) {
    if (seen.has(p)) continue;
    seen.add(p);
    const st = statOf(p);
    if (st.size > 0) return { path: p, stat: st };
  }
  return null;
}

function readHookTimings(picked) {
  if (!picked) return null;
  try {
    const raw = readFileSync(picked.path, 'utf-8');
    const out = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        if (obj && typeof obj.ts === 'number') out.push(obj);
      } catch {
        // Ignore torn trailing line
      }
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transcript parsing cache keyed by (path, mtime, size, hookTimingStat, meta)
// ---------------------------------------------------------------------------

const sessionCache = new Map();
const traceCache = new Map();

function getParsedTrace(appData, convId) {
  if (!appData || !convId || !ID_RE.test(convId)) return null;
  const picked = pickTranscriptFile(appData, convId);
  if (!picked) return null;

  const timingFile = pickHookTimingFile(appData, convId);
  const timingSig = timingFile ? `${timingFile.stat.mtime}:${timingFile.stat.size}` : '';
  const key = `${picked.path}|${picked.stat.mtime}|${picked.stat.size}|${timingSig}`;
  const hit = traceCache.get(convId);
  if (hit && hit.key === key) return hit;

  let text = '';
  try { text = readFileSync(picked.path, 'utf-8'); } catch { return null; }

  const hookTimings = readHookTimings(timingFile);
  const trace = parseTrace(text, { hookTimings });
  const entry = { key, ...trace };
  if (traceCache.size > 40) traceCache.clear();
  traceCache.set(convId, entry);
  return entry;
}

function getParsedSession(appData, convId) {
  if (!appData || !convId || !ID_RE.test(convId)) return null;
  const picked = pickTranscriptFile(appData, convId);
  if (!picked) return null;

  const meta = getConvMeta(convId);
  const timingFile = pickHookTimingFile(appData, convId);
  const timingSig = timingFile ? `${timingFile.stat.mtime}:${timingFile.stat.size}` : '';
  const key = `${picked.path}|${picked.stat.mtime}|${picked.stat.size}|${timingSig}|${meta.title}|${meta.workspace}|${meta.workspaceUri}`;
  const hit = sessionCache.get(convId);
  if (hit && hit.key === key) return { key, parsed: hit.parsed };

  let text = '';
  try { text = readFileSync(picked.path, 'utf-8'); } catch { return null; }

  const hookTimings = readHookTimings(timingFile);
  const parsed = parseTranscript(text, {
    conversationId: convId,
    title: meta.title,
    workspace: meta.workspace,
    workspaceUri: meta.workspaceUri,
    fileMtime: picked.stat.mtime,
    hookTimings,
  });

  if (sessionCache.size > 800) sessionCache.clear();
  sessionCache.set(convId, { key, parsed });
  return { key, parsed };
}

// ---------------------------------------------------------------------------
// Active system prompt sources (workspace & global rules, read-only)
// ---------------------------------------------------------------------------

function readRulePreview(filePath, label, source) {
  const s = statOf(filePath);
  if (s.size <= 0 || s.size > 512 * 1024) return null;
  try {
    const content = readFileSync(filePath, 'utf-8');
    const tokens = estimateTokens(content);
    const preview = content.length > 4000 ? `${content.slice(0, 4000)}\n… (truncated)` : content;
    return {
      label,
      tool: source,
      detail: filePath,
      preview,
      tokens,
      step: 0,
    };
  } catch {
    return null;
  }
}

function discoverSystemPromptItems(workspaceUri, totalSysTokens) {
  const items = [];
  const seen = new Set();

  const tryAdd = (filePath, label, source) => {
    if (!filePath || seen.has(filePath)) return;
    if (!existsSync(filePath)) return;
    seen.add(filePath);
    const item = readRulePreview(filePath, label, source);
    if (item) items.push(item);
  };

  // Workspace rules (AGENTS.md, GEMINI.md, .agents/rules/*.md)
  const wsPath = workspaceUri ? workspaceUri.replace(/^file:\/\//, '') : '';
  if (wsPath && existsSync(wsPath)) {
    tryAdd(join(wsPath, 'AGENTS.md'), 'AGENTS.md', 'workspace');
    tryAdd(join(wsPath, 'GEMINI.md'), 'GEMINI.md', 'workspace');
    for (const dirName of ['.agents', '.agent']) {
      const rulesDir = join(wsPath, dirName, 'rules');
      for (const f of safeReaddir(rulesDir)) {
        if (f.endsWith('.md')) tryAdd(join(rulesDir, f), `${dirName}/rules/${f}`, 'workspace');
      }
    }
  }

  // Global user rules (~/.gemini/config/GEMINI.md, AGENTS.md, rules/*.md)
  const cfgRoot = join(homedir(), '.gemini', 'config');
  tryAdd(join(cfgRoot, 'AGENTS.md'), '~/.gemini/config/AGENTS.md', 'global');
  tryAdd(join(cfgRoot, 'GEMINI.md'), '~/.gemini/config/GEMINI.md', 'global');
  for (const f of safeReaddir(join(cfgRoot, 'rules'))) {
    if (f.endsWith('.md')) tryAdd(join(cfgRoot, 'rules', f), `rules/${f}`, 'global');
  }

  // Enabled plugin rules (~/.gemini/config/plugins/*/rules/*.md)
  const pluginsRoot = join(cfgRoot, 'plugins');
  for (const pName of safeReaddir(pluginsRoot)) {
    const pRules = join(pluginsRoot, pName, 'rules');
    for (const f of safeReaddir(pRules)) {
      if (f.endsWith('.md')) tryAdd(join(pRules, f), `${pName}/rules/${f}`, 'plugin');
    }
  }

  const rulesTokens = items.reduce((a, x) => a + x.tokens, 0);
  const coreTokens = Math.max(0, totalSysTokens - rulesTokens);
  if (coreTokens > 0 || items.length === 0) {
    items.push({
      label: 'Antigravity core prompt & skills index',
      tool: 'built-in',
      detail: 'Built-in system instructions (internal to Language Server)',
      preview:
        'Antigravity does not write its built-in core system prompt text to transcript.jsonl.\n'
        + `This value (~${coreTokens.toLocaleString()} tokens) is derived from Step 1 prompt tokens minus Step 0 user input, tool definitions, and detected local rule files.`,
      tokens: coreTokens > 0 ? coreTokens : totalSysTokens,
      step: 1,
    });
  }

  return items.sort((a, b) => b.tokens - a.tokens);
}

// ---------------------------------------------------------------------------
// Brain directory scanner
// ---------------------------------------------------------------------------

let lastScan = { at: 0, entries: [] };

function listAllConversations() {
  const now = Date.now();
  if (now - lastScan.at < SCAN_CACHE_MS) return lastScan.entries;
  const entries = [];
  const seen = new Set();
  for (const appData of findAppDataDirs()) {
    const brainDir = join(appData, 'brain');
    for (const name of safeReaddir(brainDir)) {
      if (!ID_RE.test(name) || seen.has(name)) continue;
      seen.add(name);
      entries.push({ appData, convId: name });
    }
  }
  lastScan = { at: now, entries };
  return entries;
}

function locateConversation(convId) {
  if (!convId || !ID_RE.test(convId)) return null;
  for (const appData of findAppDataDirs()) {
    if (existsSync(join(appData, 'brain', convId))) return appData;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Date utilities & dynamic time-series bucketing (hour / day / week / month / year)
// ---------------------------------------------------------------------------

function toLocalDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDateKey(dk) {
  const [y, m, d] = dk.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function addDays(dateObj, n) {
  const d = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate() + n);
  return d;
}

function diffDays(startDk, endDk) {
  if (!startDk || !endDk) return 0;
  const a = parseDateKey(startDk).getTime();
  const b = parseDateKey(endDk).getTime();
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

function mondayOf(dateObj) {
  const dow = (dateObj.getDay() + 6) % 7; // Mon=0..Sun=6
  return addDays(dateObj, -dow);
}

function mergeUsageInto(target, src) {
  target.tokens += src.tokens || 0;
  target.inputTokens += src.inputTokens || 0;
  target.cacheReadTokens += src.cacheReadTokens || 0;
  target.outputTokens += src.outputTokens || 0;
  for (const [m, mv] of Object.entries(src.models || {})) {
    if (!target.models[m]) target.models[m] = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
    target.models[m].inputTokens += mv.inputTokens || 0;
    target.models[m].cacheReadTokens += mv.cacheReadTokens || 0;
    target.models[m].outputTokens += mv.outputTokens || 0;
  }
}

function emptyUsagePoint(key, label, fullLabel, dateKey = '') {
  return {
    key,
    label,
    fullLabel,
    dateKey,
    tokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    models: {},
  };
}

function buildHourlySeries(targetDate, hourlyMap) {
  const points = [];
  for (let h = 0; h < 24; h++) {
    const hh = String(h).padStart(2, '0');
    const key = `${targetDate} ${hh}`;
    const pt = emptyUsagePoint(key, `${hh}:00`, `${targetDate} ${hh}:00–${hh}:59`, '');
    if (hourlyMap[key]) mergeUsageInto(pt, hourlyMap[key]);
    points.push(pt);
  }
  return { granularity: 'hour', points };
}

function buildDailySeries(startDateKey, endDateKey, dailyMap) {
  const points = [];
  let cur = parseDateKey(startDateKey);
  const end = parseDateKey(endDateKey);
  let guard = 0;
  while (cur <= end && guard < 400) {
    const dk = toLocalDateKey(cur);
    const pt = emptyUsagePoint(dk, dk.slice(5), dk, dk);
    if (dailyMap[dk]) mergeUsageInto(pt, dailyMap[dk]);
    points.push(pt);
    cur = addDays(cur, 1);
    guard++;
  }
  return { granularity: 'day', points };
}

function buildWeeklySeries(startDateKey, endDateKey, dailyMap) {
  const buckets = new Map();
  let cur = mondayOf(parseDateKey(startDateKey));
  const endMonday = mondayOf(parseDateKey(endDateKey));
  let guard = 0;
  while (cur <= endMonday && guard < 120) {
    const wkStart = toLocalDateKey(cur);
    const wkEnd = toLocalDateKey(addDays(cur, 6));
    buckets.set(wkStart, emptyUsagePoint(wkStart, wkStart.slice(5), `${wkStart} ~ ${wkEnd}`, ''));
    cur = addDays(cur, 7);
    guard++;
  }
  for (const [dk, entry] of Object.entries(dailyMap)) {
    const wkStart = toLocalDateKey(mondayOf(parseDateKey(dk)));
    if (!buckets.has(wkStart)) {
      const wkEnd = toLocalDateKey(addDays(parseDateKey(wkStart), 6));
      buckets.set(wkStart, emptyUsagePoint(wkStart, wkStart.slice(5), `${wkStart} ~ ${wkEnd}`, ''));
    }
    mergeUsageInto(buckets.get(wkStart), entry);
  }
  return { granularity: 'week', points: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

function buildMonthlySeries(startDateKey, endDateKey, dailyMap) {
  const buckets = new Map();
  const s = parseDateKey(startDateKey);
  const e = parseDateKey(endDateKey);
  let y = s.getFullYear();
  let m = s.getMonth();
  const endY = e.getFullYear();
  const endM = e.getMonth();
  let guard = 0;
  while ((y < endY || (y === endY && m <= endM)) && guard < 120) {
    const mk = `${y}-${String(m + 1).padStart(2, '0')}`;
    buckets.set(mk, emptyUsagePoint(mk, mk, mk, ''));
    m++;
    if (m >= 12) { m = 0; y++; }
    guard++;
  }
  for (const [dk, entry] of Object.entries(dailyMap)) {
    const mk = dk.slice(0, 7);
    if (!buckets.has(mk)) buckets.set(mk, emptyUsagePoint(mk, mk, mk, ''));
    mergeUsageInto(buckets.get(mk), entry);
  }
  return { granularity: 'month', points: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

function buildYearlySeries(startDateKey, endDateKey, dailyMap) {
  const buckets = new Map();
  const sY = parseDateKey(startDateKey).getFullYear();
  const eY = parseDateKey(endDateKey).getFullYear();
  for (let y = sY; y <= eY; y++) {
    const yk = String(y);
    buckets.set(yk, emptyUsagePoint(yk, yk, yk, ''));
  }
  for (const [dk, entry] of Object.entries(dailyMap)) {
    const yk = dk.slice(0, 4);
    if (!buckets.has(yk)) buckets.set(yk, emptyUsagePoint(yk, yk, yk, ''));
    mergeUsageInto(buckets.get(yk), entry);
  }
  return { granularity: 'year', points: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

/**
 * Selects optimal time-series granularity for the active range:
 *   - today / single date -> 24 hourly buckets
 *   - 7d -> 7 daily buckets
 *   - 30d -> 30 daily buckets
 *   - all -> adaptive by actual data span:
 *       <= 1d: hour | <= 35d: day | <= 180d: week | <= 730d: month | > 730d: year
 */
export function buildUsageSeries({ range, startKey, endKey, dailyMap, hourlyMap, minDateKey, maxDateKey }) {
  const todayKey = toLocalDateKey(new Date());

  if (range === 'today' || range === 'date') {
    return buildHourlySeries(startKey || todayKey, hourlyMap);
  }
  if (range === '7d' || range === '30d') {
    const days = range === '7d' ? 6 : 29;
    const s = startKey || toLocalDateKey(addDays(new Date(), -days));
    const e = endKey || todayKey;
    return buildDailySeries(s, e, dailyMap);
  }

  // range === 'all' or 'custom': adaptive bucketing by actual active span
  const sKey = (range === 'custom' ? startKey : '') || minDateKey || todayKey;
  const eKey = (range === 'custom' ? endKey : '') || maxDateKey || sKey;
  const span = diffDays(sKey, eKey);
  if (span <= 1 && sKey === eKey) {
    return buildHourlySeries(sKey, hourlyMap);
  }
  if (span <= 35) {
    return buildDailySeries(sKey, eKey, dailyMap);
  }
  if (span <= 180) {
    return buildWeeklySeries(sKey, eKey, dailyMap);
  }
  if (span <= 730) {
    return buildMonthlySeries(sKey, eKey, dailyMap);
  }
  return buildYearlySeries(sKey, eKey, dailyMap);
}

function resolveDateBounds(range, exactDate, customStart = '', customEnd = '') {
  const now = new Date();
  const todayKey = toLocalDateKey(now);
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (exactDate && DATE_RE.test(exactDate)) {
    return { startKey: exactDate, endKey: exactDate, range: 'date' };
  }
  const hasStart = DATE_RE.test(customStart);
  const hasEnd = DATE_RE.test(customEnd);
  if (range === 'custom' || hasStart || hasEnd) {
    if (hasStart && hasEnd) {
      const sKey = customStart <= customEnd ? customStart : customEnd;
      const eKey = customStart <= customEnd ? customEnd : customStart;
      return { startKey: sKey, endKey: eKey, range: 'custom' };
    }
    return {
      startKey: hasStart ? customStart : '',
      endKey: hasEnd ? customEnd : '',
      range: 'custom',
    };
  }
  if (range === 'today') {
    return { startKey: todayKey, endKey: todayKey, range: 'today' };
  }
  if (range === '7d') {
    return { startKey: toLocalDateKey(addDays(now, -6)), endKey: todayKey, range: '7d' };
  }
  if (range === '30d') {
    return { startKey: toLocalDateKey(addDays(now, -29)), endKey: todayKey, range: '30d' };
  }
  return { startKey: '', endKey: '', range: 'all' };
}

function matchesWorkspace(session, targetWs, targetWsUri) {
  if (!targetWs && !targetWsUri) return true;
  const normTargetUri = normalizeWsUri(targetWsUri).toLowerCase();
  const normSessUri = normalizeWsUri(session.workspaceUri).toLowerCase();
  if (normTargetUri && normSessUri && normTargetUri === normSessUri) return true;
  const targetName = (targetWs || workspaceNameFromUri(targetWsUri)).toLowerCase();
  const sessName = String(session.workspace || '').toLowerCase();
  return Boolean(targetName && sessName && targetName === sessName);
}

function buildOverview({ range = '30d', date = '', start = '', end = '', workspace = '', workspaceUri = '', etag = '' } = {}) {
  const bounds = resolveDateBounds(range, date, start, end);
  const allEntries = listAllConversations();

  const parsedAll = [];
  for (const { appData, convId } of allEntries) {
    const res = getParsedSession(appData, convId);
    if (!res || res.parsed.modelCalls === 0) continue;
    parsedAll.push(res.parsed);
  }

  // Scope by workspace when viewing Project tab
  const scopedList = (workspace || workspaceUri)
    ? parsedAll.filter((s) => matchesWorkspace(s, workspace, workspaceUri))
    : parsedAll;

  const etagParts = [bounds.range, bounds.startKey, bounds.endKey, workspace, workspaceUri];
  for (const s of scopedList) {
    etagParts.push(`${s.conversationId}:${s.steps}:${s.totals.totalTokens}:${s.workspace}`);
  }
  etagParts.sort();
  const nextEtag = etagParts.join('|');
  if (etag && etag === nextEtag) {
    return { unchanged: true, etag: nextEtag };
  }

  // Heatmap covers all dates within the active scope (Project or Global)
  const heatmap = {};
  const heatmapSessionSets = {};
  let hmMinDate = '';
  let hmMaxDate = '';
  for (const s of scopedList) {
    const dates = Object.keys(s.byDate);
    if (!dates.length && s.dateKey) dates.push(s.dateKey);
    for (const dk of dates) {
      if (!hmMinDate || dk < hmMinDate) hmMinDate = dk;
      if (!hmMaxDate || dk > hmMaxDate) hmMaxDate = dk;
      if (!heatmap[dk]) {
        heatmap[dk] = { sessions: 0, tokens: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
        heatmapSessionSets[dk] = new Set();
      }
      heatmapSessionSets[dk].add(s.conversationId);
      const bd = s.byDate[dk];
      if (bd) {
        heatmap[dk].tokens += bd.tokens;
        heatmap[dk].inputTokens += bd.inputTokens;
        heatmap[dk].cacheReadTokens += bd.cacheReadTokens;
        heatmap[dk].outputTokens += bd.outputTokens;
      }
    }
  }
  for (const dk of Object.keys(heatmap)) {
    heatmap[dk].sessions = heatmapSessionSets[dk].size;
  }

  // Filter scoped sessions by date bounds
  const inRange = (s) => {
    if (!bounds.startKey && !bounds.endKey) return true;
    const dates = Object.keys(s.byDate);
    if (!dates.length && s.dateKey) dates.push(s.dateKey);
    return dates.some((dk) => (!bounds.startKey || dk >= bounds.startKey) && (!bounds.endKey || dk <= bounds.endKey));
  };

  const filtered = scopedList.filter(inRange);

  const cumulativeComposition = emptyBuckets();
  const modelsUsed = {};
  const skillsAgg = {};
  const toolsAgg = {};
  const commandsAgg = {};
  const workspaces = {};
  const dailyMap = {};
  const hourlyMap = {};

  let totalTurns = 0;
  let totalModelCalls = 0;
  let totalToolCalls = 0;
  let totalInput = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let cachedSessionsCount = 0;

  let activeMs = 0;
  let modelWaitMs = 0;
  let thinkingMs = 0;
  let replyMs = 0;
  let toolArgsMs = 0;
  let toolExecMs = 0;
  let otherMs = 0;

  let minDateKey = '';
  let maxDateKey = '';

  let hookCompletedTurns = 0;
  let hookTotalTurnMs = 0;
  let hookMaxTurnMs = 0;
  let hookTotalInvs = 0;
  let hookToolCalls = 0;
  let hookToolErrors = 0;
  const hookReasons = {};

  for (const s of filtered) {
    totalTurns += s.turns;
    totalModelCalls += s.modelCalls;
    totalToolCalls += s.toolCallsCount;
    totalInput += s.totals.inputTokens;
    totalCacheRead += s.totals.cacheReadTokens;
    totalOutput += s.totals.outputTokens;
    if (s.totals.cacheReadTokens > 0) cachedSessionsCount++;

    activeMs += s.timing.activeMs;
    modelWaitMs += s.timing.modelWaitMs;
    thinkingMs += s.timing.thinkingMs;
    replyMs += s.timing.replyMs;
    toolArgsMs += s.timing.toolArgsMs;
    toolExecMs += s.timing.toolExecMs;
    otherMs += s.timing.otherMs;

    const ht = s.hookTelemetry;
    if (ht && ht.hasData) {
      hookCompletedTurns += ht.turnStats?.completedTurns || 0;
      hookTotalTurnMs += ht.turnStats?.totalTurnMs || 0;
      if ((ht.turnStats?.maxTurnMs || 0) > hookMaxTurnMs) hookMaxTurnMs = ht.turnStats.maxTurnMs;
      hookTotalInvs += ht.turnStats?.totalInvocations || 0;
      hookToolCalls += ht.toolStats?.calls || 0;
      hookToolErrors += ht.toolStats?.errors || 0;
      for (const [rk, rv] of Object.entries(ht.turnStats?.reasons || {})) {
        hookReasons[rk] = (hookReasons[rk] || 0) + rv;
      }
    }

    for (const k of CATEGORIES) {
      cumulativeComposition[k] += s.cumulativeComposition[k] || 0;
    }

    for (const [m, mv] of Object.entries(s.modelsUsed)) {
      if (!modelsUsed[m]) {
        modelsUsed[m] = {
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          calls: 0,
          sessions: 0,
          durationMs: 0,
          timedOutputTokens: 0,
          timedDurationMs: 0,
        };
      }
      modelsUsed[m].inputTokens += mv.inputTokens;
      modelsUsed[m].cacheReadTokens += mv.cacheReadTokens;
      modelsUsed[m].outputTokens += mv.outputTokens;
      modelsUsed[m].calls += mv.calls;
      modelsUsed[m].sessions += 1;
      modelsUsed[m].durationMs += mv.durationMs || 0;
      modelsUsed[m].timedOutputTokens += mv.timedOutputTokens ?? mv.outputTokens;
      modelsUsed[m].timedDurationMs += mv.timedDurationMs ?? mv.durationMs ?? 0;
    }

    for (const [name, sv] of Object.entries(s.skills)) {
      if (!skillsAgg[name]) skillsAgg[name] = { name, count: 0, lastAt: 0, tokens: 0, durationMs: 0 };
      skillsAgg[name].count += sv.count;
      skillsAgg[name].tokens += sv.tokens || 0;
      skillsAgg[name].durationMs += sv.durationMs || 0;
      if (sv.lastAt > skillsAgg[name].lastAt) skillsAgg[name].lastAt = sv.lastAt;
    }

    for (const [name, tv] of Object.entries(s.tools)) {
      if (!toolsAgg[name]) toolsAgg[name] = { name, count: 0, lastAt: 0, tokens: 0, durationMs: 0, errors: 0 };
      toolsAgg[name].count += tv.count;
      toolsAgg[name].tokens += tv.tokens || 0;
      toolsAgg[name].durationMs += tv.durationMs || 0;
      toolsAgg[name].errors += tv.errors || 0;
      if (tv.lastAt > toolsAgg[name].lastAt) toolsAgg[name].lastAt = tv.lastAt;
    }

    for (const [name, cv] of Object.entries(s.commands)) {
      if (!commandsAgg[name]) commandsAgg[name] = { name, count: 0, lastAt: 0, tokens: 0, durationMs: 0 };
      commandsAgg[name].count += cv.count;
      commandsAgg[name].tokens += cv.tokens || 0;
      commandsAgg[name].durationMs += cv.durationMs || 0;
      if (cv.lastAt > commandsAgg[name].lastAt) commandsAgg[name].lastAt = cv.lastAt;
    }

    const ws = s.workspace || 'default-workspace';
    workspaces[ws] = (workspaces[ws] || 0) + 1;

    for (const [dk, bd] of Object.entries(s.byDate)) {
      if (bounds.startKey && dk < bounds.startKey) continue;
      if (bounds.endKey && dk > bounds.endKey) continue;
      if (!minDateKey || dk < minDateKey) minDateKey = dk;
      if (!maxDateKey || dk > maxDateKey) maxDateKey = dk;
      if (!dailyMap[dk]) {
        dailyMap[dk] = { tokens: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, models: {} };
      }
      mergeUsageInto(dailyMap[dk], bd);
    }

    for (const [hk, bh] of Object.entries(s.byHour || {})) {
      const dk = hk.slice(0, 10);
      if (bounds.startKey && dk < bounds.startKey) continue;
      if (bounds.endKey && dk > bounds.endKey) continue;
      if (!hourlyMap[hk]) {
        hourlyMap[hk] = { tokens: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, models: {} };
      }
      mergeUsageInto(hourlyMap[hk], bh);
    }
  }

  const usageSeries = buildUsageSeries({
    range: bounds.range,
    startKey: bounds.startKey,
    endKey: bounds.endKey,
    dailyMap,
    hourlyMap,
    minDateKey,
    maxDateKey,
  });

  const totalPrompt = totalInput + totalCacheRead;
  const totalTokens = totalPrompt + totalOutput;
  const cacheHitRate = totalPrompt > 0 ? totalCacheRead / totalPrompt : 0;
  let totalTimedOut = 0;
  let totalTimedMs = 0;
  for (const mv of Object.values(modelsUsed)) {
    totalTimedOut += mv.timedOutputTokens || 0;
    totalTimedMs += mv.timedDurationMs || 0;
  }
  const totalModelMs = modelWaitMs + thinkingMs + replyMs + toolArgsMs;
  const outputTokPerSec = totalTimedMs > 0
    ? Math.round((totalTimedOut / (totalTimedMs / 1000)) * 10) / 10
    : (totalModelMs > 0 ? Math.round((totalOutput / (totalModelMs / 1000)) * 10) / 10 : 0);

  const modelsBreakdown = Object.entries(modelsUsed)
    .map(([m, mv]) => {
      const promptAll = mv.inputTokens + mv.cacheReadTokens;
      const total = promptAll + mv.outputTokens;
      const tMs = mv.timedDurationMs || 0;
      const tOut = mv.timedOutputTokens || 0;
      return {
        model: m,
        inputTokens: mv.inputTokens,
        cacheReadTokens: mv.cacheReadTokens,
        outputTokens: mv.outputTokens,
        totalTokens: total,
        calls: mv.calls,
        sessions: mv.sessions,
        durationMs: mv.durationMs,
        cacheHitRate: promptAll > 0 ? mv.cacheReadTokens / promptAll : 0,
        tokPerSec: tMs > 0 ? Math.round((tOut / (tMs / 1000)) * 10) / 10 : 0,
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const sessions = filtered
    .map((s) => ({
      conversationId: s.conversationId,
      title: s.title,
      workspace: s.workspace,
      workspaceUri: s.workspaceUri,
      model: s.model,
      modelsUsed: s.modelsUsed,
      turns: s.turns,
      steps: s.steps,
      modelCalls: s.modelCalls,
      toolCallsCount: s.toolCallsCount,
      lastAt: s.lastAt,
      lastMs: s.lastMs,
      dateKey: s.dateKey,
      lastUserMessage: s.lastUserMessage,
      currentContext: s.currentContext,
      lastPromptTokens: s.lastPromptTokens,
      peakContext: s.peakContext,
      totals: s.totals,
      composition: s.composition,
      compactionsCount: s.compactions.length,
      firstCompactionFrom: s.compactions[0]?.from || 0,
    }))
    .sort((a, b) => b.lastMs - a.lastMs);

  return {
    etag: nextEtag,
    scope: (workspace || workspaceUri) ? 'project' : 'global',
    workspace: workspace || workspaceNameFromUri(workspaceUri) || '',
    range: bounds.range,
    startDate: bounds.startKey || hmMinDate || minDateKey || toLocalDateKey(new Date()),
    endDate: bounds.endKey || hmMaxDate || maxDateKey || toLocalDateKey(new Date()),
    dataMinDate: hmMinDate || minDateKey || '',
    dataMaxDate: hmMaxDate || maxDateKey || '',
    defaultModelSpecs: DEFAULT_MODEL_SPECS,
    kpi: {
      totalSessions: filtered.length,
      allSessionsCount: scopedList.length,
      totalTurns,
      totalModelCalls,
      totalToolCalls,
      totalTokens,
      totalInput,
      totalCacheRead,
      totalOutput,
      cacheHitRate,
      cachedSessionsCount,
      activeMs,
      toolExecMs,
    },
    modelsUsed,
    modelsBreakdown,
    cumulativeComposition,
    timing: {
      activeMs,
      modelWaitMs,
      thinkingMs,
      replyMs,
      toolArgsMs,
      toolExecMs,
      otherMs,
      outputTokPerSec,
      modelCalls: totalModelCalls,
      toolCalls: totalToolCalls,
    },
    usageSeries,
    heatmap,
    heatmapSpan: { minDate: hmMinDate, maxDate: hmMaxDate },
    skills: Object.values(skillsAgg).sort((a, b) => b.count - a.count),
    tools: Object.values(toolsAgg).sort((a, b) => b.count - a.count),
    commands: Object.values(commandsAgg).sort((a, b) => b.count - a.count),
    hookOverview: {
      hasData: hookCompletedTurns > 0 || hookToolCalls > 0,
      completedTurns: hookCompletedTurns,
      avgTurnMs: hookCompletedTurns > 0 ? Math.round(hookTotalTurnMs / hookCompletedTurns) : 0,
      maxTurnMs: hookMaxTurnMs,
      avgInvocations: hookCompletedTurns > 0 ? Math.round((hookTotalInvs / hookCompletedTurns) * 10) / 10 : 0,
      reasons: hookReasons,
      toolCalls: hookToolCalls,
      toolErrors: hookToolErrors,
    },
    workspaces,
    sessions,
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleSession(data, defaultConvId) {
  const convId = String(data.conversationId || defaultConvId || '').trim();
  if (!convId || !ID_RE.test(convId)) {
    return { conversationId: convId || null, found: false, defaultModelSpecs: DEFAULT_MODEL_SPECS };
  }
  const appData = locateConversation(convId);
  if (!appData) {
    return { conversationId: convId, found: false, defaultModelSpecs: DEFAULT_MODEL_SPECS };
  }
  const res = getParsedSession(appData, convId);
  if (!res) {
    return { conversationId: convId, found: false, defaultModelSpecs: DEFAULT_MODEL_SPECS };
  }
  const etag = res.key;
  if (data.etag && data.etag === etag) {
    return { conversationId: convId, found: true, unchanged: true, etag };
  }
  const trace = getParsedTrace(appData, convId);
  const recentTrace = trace
    ? trace.details.slice(-14).map((d) => ({
        idx: d.idx,
        kind: d.kind,
        turn: d.turn,
        step: d.step,
        at: d.at,
        durationMs: d.durationMs,
        hasError: d.hasError,
        reverted: Boolean(d.reverted),
        hasThinking: d.hasThinking,
        hasReply: d.hasReply,
        toolName: d.toolName,
        skillName: d.skillName,
        model: d.model,
        systemType: d.systemType,
        systemBadge: d.systemBadge,
        systemBadges: d.systemBadges,
        outputTokens: d.outputTokens,
        toolCount: d.toolCount,
        preview: d.preview,
        argsPreview: d.argsPreview,
        resultPreview: d.resultPreview,
        detailText: (d.kind === 'tool' || d.kind === 'skill')
          ? `${JSON.stringify(d.args || {}, null, 2)}${d.result ? `\n\n--- Result ---\n${d.result.slice(0, 1200)}` : ''}`
          : d.kind === 'model'
            ? [d.thinking ? `[Thinking]\n${d.thinking.slice(0, 1200)}` : '', d.content ? `[Reply]\n${d.content.slice(0, 1200)}` : ''].filter(Boolean).join('\n\n')
            : (d.content || d.userText || '').slice(0, 1200),
      }))
    : [];

  const enrichedSession = {
    ...res.parsed,
    recentTrace,
    traceCount: trace?.counts?.total || 0,
  };
  return {
    conversationId: convId,
    found: true,
    etag,
    defaultModelSpecs: DEFAULT_MODEL_SPECS,
    session: enrichedSession,
  };
}

function handleOverview(data) {
  return buildOverview({
    range: String(data.range || '30d'),
    date: String(data.date || ''),
    start: String(data.start || ''),
    end: String(data.end || ''),
    workspace: String(data.workspace || ''),
    workspaceUri: String(data.workspaceUri || ''),
    etag: String(data.etag || ''),
  });
}

function handleTrace(data, defaultConvId) {
  const convId = String(data.conversationId || defaultConvId || '').trim();
  if (!convId || !ID_RE.test(convId)) return { conversationId: convId || null, found: false };
  const appData = locateConversation(convId);
  if (!appData) return { conversationId: convId, found: false };
  const entry = getParsedTrace(appData, convId);
  if (!entry) return { conversationId: convId, found: false };
  if (data.etag && data.etag === entry.key) {
    return { conversationId: convId, found: true, unchanged: true, etag: entry.key };
  }
  return {
    conversationId: convId,
    found: true,
    etag: entry.key,
    counts: entry.counts,
    items: entry.items,
    liveState: entry.liveState,
  };
}

function handleTraceDetail(data, defaultConvId) {
  const convId = String(data.conversationId || defaultConvId || '').trim();
  const idx = Number(data.idx);
  if (!convId || !ID_RE.test(convId) || !Number.isInteger(idx) || idx < 0) {
    return { found: false };
  }
  const appData = locateConversation(convId);
  if (!appData) return { found: false };
  const entry = getParsedTrace(appData, convId);
  if (!entry || idx >= entry.details.length) return { found: false };
  return { found: true, item: entry.details[idx] };
}

// ---------------------------------------------------------------------------
// Plugin version, GitHub update check & self-update with live progress
// ---------------------------------------------------------------------------

const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const VERSION_CACHE_MS = 10 * 60 * 1000;
let versionCache = { ts: 0, result: null };

let updateState = {
  status: 'idle', // idle | checking | downloading | installing | reloading | error
  pct: 0,
  bytesLoaded: 0,
  bytesTotal: 0,
  speedBps: 0,
  version: '',
  error: '',
};

function readPluginManifest() {
  try {
    const raw = readFileSync(join(PLUGIN_ROOT, 'plugin.json'), 'utf-8');
    const json = JSON.parse(raw);
    const repo = typeof json.repository === 'string'
      ? json.repository
      : (typeof json.repository?.url === 'string' ? json.repository.url : '');
    return {
      name: String(json.name || 'agy-context'),
      version: String(json.version || '1.0.0'),
      repository: repo.replace(/^git\+/, '').replace(/\.git$/, '').trim(),
    };
  } catch {
    return { name: 'agy-context', version: '1.0.0', repository: '' };
  }
}

function parseGithubSlug(repoUrl) {
  const m = String(repoUrl || '').match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  return m ? `${m[1]}/${m[2].replace(/\.git$/, '')}` : '';
}

function compareSemver(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

async function handleVersion(data) {
  const manifest = readPluginManifest();
  const slug = parseGithubSlug(manifest.repository);
  const base = {
    currentVersion: manifest.version,
    repository: manifest.repository,
    githubSlug: slug,
    checked: false,
    hasUpdate: false,
    latestVersion: '',
    releaseUrl: manifest.repository,
    downloadUrl: '',
    error: '',
  };
  if (data.check !== '1') return base;
  if (!slug) {
    return { ...base, checked: true, error: 'no_repository' };
  }
  if (data.force !== '1' && versionCache.result && Date.now() - versionCache.ts < VERSION_CACHE_MS) {
    const cached = versionCache.result;
    return {
      ...cached,
      currentVersion: manifest.version,
      hasUpdate: cached.latestVersion ? compareSemver(cached.latestVersion, manifest.version) > 0 : false,
    };
  }

  try {
    // 1. Check latest GitHub Release first
    const relRes = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agy-context' },
      signal: AbortSignal.timeout(6000),
    });
    if (relRes.ok) {
      const rel = await relRes.json();
      const tagName = String(rel.tag_name || '').trim();
      const latest = tagName.replace(/^v/i, '');
      if (latest) {
        const out = {
          ...base,
          checked: true,
          latestVersion: latest,
          hasUpdate: compareSemver(latest, manifest.version) > 0,
          releaseUrl: rel.html_url || manifest.repository,
          downloadUrl: `https://codeload.github.com/${slug}/tar.gz/refs/tags/${encodeURIComponent(tagName)}`,
        };
        versionCache = { ts: Date.now(), result: out };
        return out;
      }
    }
    // 2. Fallback: read plugin.json on default branch
    const rawRes = await fetch(`https://raw.githubusercontent.com/${slug}/main/plugin.json`, {
      signal: AbortSignal.timeout(6000),
    });
    if (rawRes.ok) {
      const remoteManifest = await rawRes.json();
      const latest = String(remoteManifest.version || '').replace(/^v/i, '');
      if (latest) {
        const out = {
          ...base,
          checked: true,
          latestVersion: latest,
          hasUpdate: compareSemver(latest, manifest.version) > 0,
          releaseUrl: manifest.repository,
          downloadUrl: `https://codeload.github.com/${slug}/tar.gz/refs/heads/main`,
        };
        versionCache = { ts: Date.now(), result: out };
        return out;
      }
    }
    return { ...base, checked: true, error: 'fetch_failed' };
  } catch {
    return { ...base, checked: true, error: 'network_error' };
  }
}

function getUpdateStatus() {
  return { ...updateState, currentVersion: readPluginManifest().version };
}

function handleStartUpdate() {
  if (updateState.status === 'checking' || updateState.status === 'downloading' || updateState.status === 'installing' || updateState.status === 'reloading') {
    return getUpdateStatus();
  }
  updateState = {
    status: 'checking',
    pct: 0,
    bytesLoaded: 0,
    bytesTotal: 0,
    speedBps: 0,
    version: '',
    error: '',
  };
  runSelfUpdate().catch((err) => {
    updateState = {
      ...updateState,
      status: 'error',
      error: String(err?.message || err || 'Update failed'),
    };
  });
  return getUpdateStatus();
}

async function runSelfUpdate() {
  const ver = await handleVersion({ check: '1', force: '1' });
  if (ver.error || !ver.downloadUrl) {
    throw new Error(ver.error || 'No download source available');
  }
  if (!/^https:\/\/codeload\.github\.com\/[^/\s]+\/[^/\s]+\/tar\.gz\//i.test(ver.downloadUrl)) {
    throw new Error('Untrusted download URL');
  }

  updateState = {
    status: 'downloading',
    pct: 0,
    bytesLoaded: 0,
    bytesTotal: 0,
    speedBps: 0,
    version: ver.latestVersion || '',
    error: '',
  };

  const workDir = join(tmpdir(), `agy-context-upd-${Date.now()}`);
  const tarPath = join(workDir, 'release.tar.gz');
  const extractDir = join(workDir, 'extract');
  mkdirSync(extractDir, { recursive: true });

  try {
    const res = await fetch(ver.downloadUrl, {
      headers: { 'User-Agent': 'agy-context' },
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`);
    }

    const totalHeader = Number(res.headers.get('content-length')) || 0;
    updateState.bytesTotal = totalHeader;

    const reader = res.body.getReader();
    const ws = createWriteStream(tarPath);
    const startedAt = Date.now();
    let loaded = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
        loaded += value.byteLength;
        ws.write(Buffer.from(value));
        const elapsedSec = Math.max(0.05, (Date.now() - startedAt) / 1000);
        updateState.bytesLoaded = loaded;
        updateState.speedBps = Math.round(loaded / elapsedSec);
        if (totalHeader > 0) {
          updateState.pct = Math.min(99, Math.round((loaded / totalHeader) * 100));
        }
      }
    }
    await new Promise((resClose, rejClose) => {
      ws.end(() => resClose());
      ws.on('error', rejClose);
    });

    updateState.status = 'installing';
    updateState.pct = 100;

    execFileSync('tar', ['-xzf', tarPath, '-C', extractDir], { timeout: 15_000 });
    const entries = readdirSync(extractDir).filter((n) => !n.startsWith('.'));
    const srcRoot = entries.length === 1 ? join(extractDir, entries[0]) : extractDir;
    if (!existsSync(join(srcRoot, 'plugin.json'))) {
      throw new Error('Invalid plugin archive');
    }

    const COPY_ITEMS = [
      'plugin.json',
      'hooks.json',
      'hooks',
      'sidecars',
      'skills',
      'assets',
      'README.md',
      'LICENSE',
      'install.sh',
    ];
    for (const item of COPY_ITEMS) {
      const from = join(srcRoot, item);
      if (existsSync(from)) {
        cpSync(from, join(PLUGIN_ROOT, item), { recursive: true, force: true });
      }
    }

    versionCache = { ts: 0, result: null };
    updateState.status = 'reloading';
    // Sidecar has restart_policy: "always", so exiting cleanly restarts the
    // backend process on the newly installed code while the UI auto-reloads.
    setTimeout(() => { process.exit(0); }, 700);
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Persistent user settings stored in plugin_data/agy-context/settings.json
// (survives sidecar disable/enable, port reassignment, restarts & updates)
// ---------------------------------------------------------------------------

function resolveSettingsPath() {
  if (process.env.PLUGIN_DATA) {
    return join(process.env.PLUGIN_DATA, 'settings.json');
  }
  const appDirs = findAppDataDirs();
  const baseAppData = appDirs[0] || join(homedir(), '.gemini', 'antigravity');
  return join(baseAppData, 'plugin_data', 'agy-context', 'settings.json');
}

function handleGetSettings() {
  const filePath = resolveSettingsPath();
  if (!existsSync(filePath)) {
    return { found: false, path: filePath, settings: null };
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (raw && typeof raw === 'object') {
      return { found: true, path: filePath, settings: raw };
    }
  } catch { /* ignore corrupted file */ }
  return { found: false, path: filePath, settings: null };
}

function handleSaveSettings(data) {
  const filePath = resolveSettingsPath();
  let obj = data;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { obj = null; }
  }
  const payload = obj && typeof obj === 'object' && obj.settings && typeof obj.settings === 'object'
    ? obj.settings
    : (obj && typeof obj === 'object' ? obj : null);
  if (!payload) {
    return { ok: false, error: 'invalid_settings' };
  }
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    renameSync(tmpPath, filePath);
    return { ok: true, path: filePath, settings: payload };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

// ---------------------------------------------------------------------------
// Server bootstrap (only when executed directly, not when imported by tests)
// ---------------------------------------------------------------------------

let isEntrypoint = false;
if (process.argv[1]) {
  try {
    isEntrypoint = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    isEntrypoint = fileURLToPath(import.meta.url) === process.argv[1];
  }
}

if (isEntrypoint) {
  let sdk = null;
  try { sdk = await import('sidecar_sdk'); } catch { sdk = null; }

  if (sdk?.SidecarApp) {
    const { SidecarApp, Response } = sdk;
    const app = new SidecarApp();

    const serveIndex = () => readFileSync(join(__dirname, 'index.html'), 'utf-8');
    app.page('/', serveIndex);
    app.page('/trace', serveIndex);

    for (const [route, [file, contentType]] of Object.entries(STATIC)) {
      app.api(route, () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType }), 'GET');
    }

    app.api('/api/health', () => ({ ok: true, version: readPluginManifest().version, appDataDirs: findAppDataDirs() }), 'GET');
    app.api('/api/session', (data) => handleSession(data, app.config?.conversationId), 'GET');
    app.api('/api/trace', (data) => handleTrace(data, app.config?.conversationId), 'GET');
    app.api('/api/trace-detail', (data) => handleTraceDetail(data, app.config?.conversationId), 'GET');
    app.api('/api/overview', (data) => handleOverview(data), 'GET');
    app.api('/api/version', async (data) => handleVersion(data), 'GET');
    app.api('/api/settings', () => handleGetSettings(), 'GET');
    app.api('/api/settings/save', (data) => handleSaveSettings(data), 'POST');
    app.api('/api/update/start', () => handleStartUpdate(), 'POST');
    app.api('/api/update/status', () => getUpdateStatus(), 'GET');

    console.log(`[agy-context] starting via sidecar_sdk; appDataDirs=${findAppDataDirs().join(', ')}`);
    app.run();
  } else {
    const port = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || 3737);
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const pathname = url.pathname;
      const data = Object.fromEntries(url.searchParams.entries());

      try {
        if (pathname === '/' || pathname === '/index.html' || pathname === '/trace') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(readFileSync(join(__dirname, 'index.html'), 'utf-8'));
          return;
        }
        if (pathname === '/preload.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
          res.end('window.sidecar = window.sidecar || null;');
          return;
        }
        if (STATIC[pathname]) {
          const [file, contentType] = STATIC[pathname];
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(readFileSync(join(__dirname, file), 'utf-8'));
          return;
        }
        if (pathname === '/api/health') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, standalone: true, version: readPluginManifest().version, appDataDirs: findAppDataDirs() }));
          return;
        }
        if (pathname === '/api/session') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(handleSession(data, process.env.ANTIGRAVITY_CONVERSATION_ID || '')));
          return;
        }
        if (pathname === '/api/trace') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(handleTrace(data, process.env.ANTIGRAVITY_CONVERSATION_ID || '')));
          return;
        }
        if (pathname === '/api/trace-detail') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(handleTraceDetail(data, process.env.ANTIGRAVITY_CONVERSATION_ID || '')));
          return;
        }
        if (pathname === '/api/overview') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(handleOverview(data)));
          return;
        }
        if (pathname === '/api/version') {
          const out = await handleVersion(data);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(out));
          return;
        }
        if (pathname === '/api/settings' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(handleGetSettings()));
          return;
        }
        if (pathname === '/api/settings/save' && req.method === 'POST') {
          const chunks = [];
          for await (const ch of req) chunks.push(ch);
          const bodyStr = Buffer.concat(chunks).toString('utf-8');
          let parsedBody = null;
          try { parsedBody = JSON.parse(bodyStr || '{}'); } catch { parsedBody = null; }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(handleSaveSettings(parsedBody)));
          return;
        }
        if (pathname === '/api/update/start' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(handleStartUpdate()));
          return;
        }
        if (pathname === '/api/update/status') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(getUpdateStatus()));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err?.message || err) }));
      }
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`[agy-context] standalone server listening on http://127.0.0.1:${port}`);
    });
  }
}
