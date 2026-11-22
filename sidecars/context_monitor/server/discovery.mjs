/**
 * Local appData discovery, brain scanning, conversation DB telemetry loading,
 * and parsed session/trace caching.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  parseTrace,
  parseTranscript,
  readConversationDb,
  readConversationSummaryStatus,
} from '../parser.mjs';
import { getConvMeta } from './metadata.mjs';

export const ID_RE = /^[0-9a-f-]{8,}$/i;
const MAX_FULL_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const SCAN_CACHE_MS = 2500;

const sessionCache = new Map();
const traceCache = new Map();
const dbTelemetryCache = new Map();
let lastScan = { at: 0, entries: [] };

export function safeReaddir(p) {
  try { return readdirSync(p); } catch { return []; }
}

export function statOf(p) {
  try {
    const s = statSync(p);
    return { mtime: s.mtimeMs, size: s.size };
  } catch {
    return { mtime: 0, size: -1 };
  }
}

export function findAppDataDirs() {
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

export function pickTranscriptFile(appData, convId) {
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

export function pickConversationDbFile(appData, convId) {
  if (!appData || !convId || !ID_RE.test(convId)) return null;
  const dbPath = join(appData, 'conversations', `${convId}.db`);
  const st = statOf(dbPath);
  if (st.size <= 0) return null;
  const walSt = statOf(`${dbPath}-wal`);
  const sig = `${st.mtime}:${st.size}:${walSt.mtime}:${walSt.size}`;
  return { path: dbPath, stat: st, sig };
}

export function getDbTelemetry(appData, convId) {
  const picked = pickConversationDbFile(appData, convId);
  if (!picked) return { sig: '', data: null };
  const summaryDbPath = join(appData, 'conversation_summaries.db');
  const summaryStatus = statOf(summaryDbPath).size > 0
    ? readConversationSummaryStatus(summaryDbPath, convId)
    : null;
  const statusTag = summaryStatus?.status || '';
  const fullSig = `${picked.sig}|${statusTag}`;
  const key = `${picked.path}|${fullSig}`;
  const hit = dbTelemetryCache.get(convId);
  if (hit && hit.key === key) return { sig: fullSig, data: hit.data };
  const data = readConversationDb(picked.path, { summaryStatus });
  if (dbTelemetryCache.size > 800) dbTelemetryCache.clear();
  dbTelemetryCache.set(convId, { key, data });
  return { sig: fullSig, data };
}

export function discoverKnownMcpServers(appData) {
  if (!appData) return [];
  return safeReaddir(join(appData, 'mcp')).filter((n) => n && !n.startsWith('.'));
}

export function getParsedTrace(appData, convId) {
  if (!appData || !convId || !ID_RE.test(convId)) return null;
  const picked = pickTranscriptFile(appData, convId);
  if (!picked) return null;

  const dbInfo = getDbTelemetry(appData, convId);
  const key = `${picked.path}|${picked.stat.mtime}|${picked.stat.size}|${dbInfo.sig}`;
  const hit = traceCache.get(convId);
  if (hit && hit.key === key) return hit;

  let text = '';
  try { text = readFileSync(picked.path, 'utf-8'); } catch { return null; }

  const trace = parseTrace(text, {
    dbTelemetry: dbInfo.data,
    knownMcpServers: discoverKnownMcpServers(appData),
  });
  const entry = { key, ...trace };
  if (traceCache.size > 40) traceCache.clear();
  traceCache.set(convId, entry);
  return entry;
}

export function getParsedSession(appData, convId) {
  if (!appData || !convId || !ID_RE.test(convId)) return null;
  const picked = pickTranscriptFile(appData, convId);
  if (!picked) return null;

  const meta = getConvMeta(convId);
  const dbInfo = getDbTelemetry(appData, convId);
  const key = `${picked.path}|${picked.stat.mtime}|${picked.stat.size}|${dbInfo.sig}|${meta.title}|${meta.workspace}|${meta.workspaceUri}`;
  const hit = sessionCache.get(convId);
  if (hit && hit.key === key) return { key, parsed: hit.parsed };

  let text = '';
  try { text = readFileSync(picked.path, 'utf-8'); } catch { return null; }

  const parsed = parseTranscript(text, {
    conversationId: convId,
    title: meta.title,
    workspace: meta.workspace,
    workspaceUri: meta.workspaceUri,
    fileMtime: picked.stat.mtime,
    dbTelemetry: dbInfo.data,
    knownMcpServers: discoverKnownMcpServers(appData),
  });

  if (sessionCache.size > 800) sessionCache.clear();
  sessionCache.set(convId, { key, parsed });
  return { key, parsed };
}

export function listAllConversations() {
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

export function locateConversation(convId) {
  if (!convId || !ID_RE.test(convId)) return null;
  for (const appData of findAppDataDirs()) {
    if (existsSync(join(appData, 'brain', convId))) return appData;
  }
  return null;
}
