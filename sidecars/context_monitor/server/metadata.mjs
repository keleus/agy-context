/**
 * Conversation metadata fetching (via agentapi) and workspace/global rule discovery.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { estimateTokens } from '../parser.mjs';

const ID_RE = /^[0-9a-f-]{8,}$/i;
const MAX_CONCURRENT_META = 3;

const metaCache = new Map(); // convId -> { title, workspace, workspaceUri, fetchedAt } | 'pending'
const metaQueue = [];
let activeMetaFetches = 0;

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

export function normalizeWsUri(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\/+$/, '');
}

export function workspaceNameFromUri(uri) {
  if (!uri) return '';
  const clean = uri.replace(/^file:\/\//, '').replace(/\/+$/, '');
  return basename(clean) || clean;
}

export function extractMetaFields(md) {
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

export function getConvMeta(convId) {
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

export function discoverSystemPromptItems(workspaceUri, totalSysTokens) {
  const items = [];
  const seen = new Set();

  const tryAdd = (filePath, label, source) => {
    if (!filePath || seen.has(filePath)) return;
    if (!existsSync(filePath)) return;
    seen.add(filePath);
    const item = readRulePreview(filePath, label, source);
    if (item) items.push(item);
  };

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

  const cfgRoot = join(homedir(), '.gemini', 'config');
  tryAdd(join(cfgRoot, 'AGENTS.md'), '~/.gemini/config/AGENTS.md', 'global');
  tryAdd(join(cfgRoot, 'GEMINI.md'), '~/.gemini/config/GEMINI.md', 'global');
  for (const f of safeReaddir(join(cfgRoot, 'rules'))) {
    if (f.endsWith('.md')) tryAdd(join(cfgRoot, 'rules', f), `rules/${f}`, 'global');
  }

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
