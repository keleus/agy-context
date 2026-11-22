/**
 * Token/media estimation, proportional normalization, timestamp, and preview utilities.
 */

import { CATEGORIES, emptyBuckets } from './constants.mjs';

const CJK_RE = /[\u3000-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

export function unwrapArg(val) {
  if (typeof val !== 'string') return val == null ? '' : String(val);
  const trimmed = val.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Keep original string if not valid JSON.
    }
  }
  return val;
}

export function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  const cjkMatches = text.match(CJK_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const otherCount = Math.max(0, text.length - cjkCount);
  return Math.max(1, Math.round(cjkCount * 0.72 + otherCount / 3.8));
}

export function estimateMediaTokens(media) {
  if (!Array.isArray(media) || !media.length) return 0;
  let total = 0;
  for (const m of media) {
    const mime = String(m?.mime_type || '').toLowerCase();
    if (mime.startsWith('image/')) total += 258;
    else if (mime.includes('pdf')) total += 800;
    else total += 512;
  }
  return total;
}

export function splitMediaByType(media) {
  let imageW = 0;
  let imageCount = 0;
  let fileW = 0;
  let fileCount = 0;
  if (Array.isArray(media)) {
    for (const m of media) {
      const mime = String(m?.mime_type || '').toLowerCase();
      if (mime.startsWith('image/')) {
        imageW += 258;
        imageCount += 1;
      } else {
        fileW += mime.includes('pdf') ? 800 : 512;
        fileCount += 1;
      }
    }
  }
  return { imageW, imageCount, fileW, fileCount };
}

export function toLocalDateKey(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function toLocalHourKey(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}`;
}

export function parseMs(iso) {
  if (!iso || typeof iso !== 'string') return NaN;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : NaN;
}

export function parseJsonlSteps(text) {
  const steps = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') steps.push(obj);
    } catch {
      // Torn trailing line while actively writing; safely ignored.
    }
  }
  return steps;
}

export function normalizeDistribute(weights, targetTotal) {
  const out = emptyBuckets();
  if (targetTotal <= 0) return out;
  let sumW = 0;
  for (const k of CATEGORIES) sumW += Math.max(0, weights[k] || 0);
  if (sumW <= 0) {
    out.tool_calls = targetTotal;
    return out;
  }
  let assigned = 0;
  let maxKey = CATEGORIES[0];
  let maxVal = -1;
  for (const k of CATEGORIES) {
    const w = Math.max(0, weights[k] || 0);
    if (w > maxVal) { maxVal = w; maxKey = k; }
    const val = Math.floor((w / sumW) * targetTotal);
    out[k] = val;
    assigned += val;
  }
  out[maxKey] += targetTotal - assigned;
  return out;
}

export function distributeProportional(entries, targetTotal) {
  if (!entries.length) return [];
  const rawSum = entries.reduce((a, x) => a + Math.max(0, x.rawTokens || 0), 0);
  const target = targetTotal > 0 ? targetTotal : rawSum;
  if (target <= 0 || rawSum <= 0) {
    return entries.map(() => 0);
  }
  const exact = entries.map((x) => (Math.max(0, x.rawTokens || 0) / rawSum) * target);
  const floors = exact.map((v) => Math.floor(v));
  let remainder = target - floors.reduce((a, v) => a + v, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - floors[i], raw: entries[i].rawTokens || 0 }))
    .sort((a, b) => b.frac - a.frac || b.raw - a.raw);
  for (let k = 0; k < order.length && remainder > 0; k++) {
    floors[order[k].i] += 1;
    remainder -= 1;
  }
  return floors;
}

export function shortenPath(p) {
  const s = unwrapArg(p);
  if (!s) return '';
  const parts = s.split('/').filter(Boolean);
  if (parts.length <= 2) return s;
  return parts.slice(-2).join('/');
}

export function commandFailedFromOutput(step) {
  if (!step) return false;
  if (step.status === 'ERROR') return true;
  const content = String(step.content || '');
  const m = content.match(/Command exited with code (\d+)/);
  if (m && Number(m[1]) !== 0) return true;
  return false;
}

export function parseResultDurationMs(content) {
  if (!content || typeof content !== 'string') return 0;
  const head = content.slice(0, 260);
  const cMatch = head.match(/^Created At:\s*(.+)$/m);
  const eMatch = head.match(/^Completed At:\s*(.+)$/m);
  if (!cMatch || !eMatch) return 0;
  const s = Date.parse(cMatch[1].trim());
  const e = Date.parse(eMatch[1].trim());
  if (Number.isFinite(s) && Number.isFinite(e) && e >= s) {
    return Math.min(300_000, e - s);
  }
  return 0;
}

export function cleanArgsObject(rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(rawArgs)) {
    out[k] = typeof v === 'string' ? unwrapArg(v) : v;
  }
  return out;
}

export function compactArgsPreview(argsObj) {
  try {
    const str = JSON.stringify(argsObj);
    return str.length > 140 ? `${str.slice(0, 140)}…` : str;
  } catch {
    return '';
  }
}

export function compactResultPreview(text) {
  const clean = String(text || '')
    .replace(/^Created At:.*\n?/gm, '')
    .replace(/^Completed At:.*\n?/gm, '')
    .replace(/^Command exited with code \d+\s*/m, (m) => `[${m.trim()}] `)
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean;
}
