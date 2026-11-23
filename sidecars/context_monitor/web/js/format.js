/**
 * DOM helpers, API client, formatters, tooltips, and host theme synchronization.
 */

import { DEFAULT_SESSION_CTX_LIMIT } from './constants.js';

export const $ = (id) => document.getElementById(id);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export async function apiGet(path) {
  const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
  const res = await f(path, { method: 'GET' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

export async function apiPost(path, body = {}) {
  const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
  const res = await f(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

/**
 * Adaptive per-session context ceiling:
 *  1. Default 500k per session.
 *  2. Once compaction occurs, lock to the observed compaction ceiling.
 *  3. Whenever context exceeds the current ceiling, adopt that exact peak directly.
 */
export function resolveSessionContextLimit(s, extraObserved = 0) {
  const compList = Array.isArray(s?.compactions) ? s.compactions : [];
  const firstCompact = Number(compList[0]?.from || s?.firstCompactionFrom || 0);
  const maxCompactFrom = compList.reduce((m, c) => Math.max(m, Number(c?.from || 0)), firstCompact);
  const timeline = Array.isArray(s?.timeline) ? s.timeline : [];
  let timelinePeak = 0;
  for (let i = 0; i < timeline.length; i++) {
    const pt = timeline[i];
    const v = (Number(pt?.promptTokens) || 0) + (Number(pt?.outputTokens) || 0);
    if (v > timelinePeak) timelinePeak = v;
  }
  const observedPeak = Math.max(
    Number(s?.currentContext || 0),
    Number(s?.peakContext || 0),
    Number(s?.lastPromptTokens || 0),
    Number(extraObserved || 0),
    timelinePeak,
    maxCompactFrom,
  );
  const modelWindow = Number(s?.contextWindow || 0);
  let limit = modelWindow > 0
    ? modelWindow
    : (firstCompact > 0 ? firstCompact : DEFAULT_SESSION_CTX_LIMIT);
  let source = modelWindow > 0
    ? 'model'
    : (firstCompact > 0 ? 'compaction' : 'default');

  if (observedPeak > limit) {
    limit = observedPeak;
    source = 'extended';
  }
  return { limit, source, observedPeak, firstCompact, modelWindow };
}

export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 1 : 2).replace(/\.00$/, '')}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(Math.round(v));
}

export function fmtPct(ratio, digits = 1) {
  const p = (Number(ratio) || 0) * 100;
  if (p <= 0) return '0%';
  if (p < 0.1) return '<0.1%';
  return `${p.toFixed(digits)}%`;
}

export function fmtDur(ms) {
  const sec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}m${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h${rm}m` : `${h}h`;
}

export function fmtTraceDur(ms) {
  const v = Number(ms) || 0;
  if (v <= 0) return '';
  const totalCs = Math.round(v / 10);
  if (totalCs <= 0) return '0.01s';
  if (totalCs < 6000) return `${(totalCs / 100).toFixed(2)}s`;
  const totalMin = Math.floor(totalCs / 6000);
  const remCs = totalCs % 6000;
  if (totalMin < 60) {
    return remCs === 0 ? `${totalMin}m` : `${totalMin}m${(remCs / 100).toFixed(2)}s`;
  }
  const totalSec = Math.round(v / 1000);
  const h = Math.floor(totalSec / 3600);
  const rm = Math.floor((totalSec % 3600) / 60);
  const rs = totalSec % 60;
  let out = `${h}h`;
  if (rm > 0) out += `${rm}m`;
  if (rs > 0) out += `${rs}s`;
  return out;
}

export function fmtDateShort(dateKey) {
  return dateKey && dateKey.length >= 10 ? dateKey.slice(5) : (dateKey || '');
}

export function fmtIsoLocal(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtBytesShort(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

export function fmtSpeed(bps) {
  const v = Math.max(0, Number(bps) || 0);
  if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB/s`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB/s`;
  return `${v} B/s`;
}

// ---------- Tooltip ----------
let tipEl = null;
let tipLastHtml = '';
const barTipState = new WeakMap();

function getTipEl() {
  if (!tipEl) tipEl = $('tooltip');
  return tipEl;
}

export function showTip(evt, html) {
  const el = getTipEl();
  if (!el) return;
  if (html !== tipLastHtml) {
    el.innerHTML = html;
    tipLastHtml = html;
  }
  el.classList.remove('hidden');
  moveTip(evt);
}

export function moveTip(evt) {
  const el = getTipEl();
  if (!el) return;
  const pad = 10;
  const rect = el.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = Math.max(8, evt.clientX - rect.width - pad);
  if (y + rect.height > window.innerHeight - 8) y = Math.max(8, evt.clientY - rect.height - pad);
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

export function hideTip() {
  tipLastHtml = '';
  getTipEl()?.classList.add('hidden');
}

export function tipHeadHtml(color, label, { free = false, mono = false, suffix = '' } = {}) {
  const dot = free
    ? '<span class="tip-dot free"></span>'
    : `<span class="tip-dot" style="background:${color}"></span>`;
  const cls = mono ? ' class="tip-mono"' : '';
  return `<div class="tip-head">${dot}<strong${cls}>${esc(label)}</strong>${suffix}</div>`;
}

export function bindSegBarTips(barEl, getTipHtml, { legendEl = null, onClick = null } = {}) {
  if (!barEl) return;
  const prev = barTipState.get(barEl);
  const st = prev || { hoveredId: null, tipActive: false, legendEl: null, getTipHtml: null, onClick: null };
  if (st.hoveredId != null && st.legendEl) {
    st.legendEl.querySelectorAll('.seg-hover-match').forEach((n) => n.classList.remove('seg-hover-match'));
  }
  st.hoveredId = null;
  st.getTipHtml = getTipHtml;
  st.legendEl = legendEl;
  st.onClick = onClick;
  barTipState.set(barEl, st);

  if (prev) return;

  const syncLegend = (nextId) => {
    const cur = barTipState.get(barEl);
    if (!cur || cur.hoveredId === nextId) return;
    cur.hoveredId = nextId;
    if (cur.legendEl) {
      cur.legendEl.querySelectorAll('[data-seg-id]').forEach((n) => {
        n.classList.toggle('seg-hover-match', nextId != null && n.dataset.segId === String(nextId));
      });
    }
  };

  const clearHover = () => {
    const cur = barTipState.get(barEl);
    if (!cur) return;
    syncLegend(null);
    if (cur.tipActive) {
      cur.tipActive = false;
      hideTip();
    }
  };

  const updateFromEvent = (e) => {
    const cur = barTipState.get(barEl);
    if (!cur?.getTipHtml) {
      clearHover();
      return;
    }
    const seg = e.target?.closest?.('.ctx-seg');
    if (!seg || !barEl.contains(seg)) {
      clearHover();
      return;
    }
    const id = seg.dataset.segId;
    const html = id != null ? cur.getTipHtml(id, seg) : null;
    if (!html) {
      clearHover();
      return;
    }
    syncLegend(id);
    cur.tipActive = true;
    showTip(e, html);
  };

  barEl.addEventListener('mouseover', updateFromEvent);
  barEl.addEventListener('mousemove', updateFromEvent);
  barEl.addEventListener('mouseleave', clearHover);
  barEl.addEventListener('click', (e) => {
    const cur = barTipState.get(barEl);
    if (!cur?.onClick) return;
    const seg = e.target?.closest?.('.ctx-seg');
    if (!seg || !barEl.contains(seg)) return;
    cur.onClick(seg.dataset.segId, seg, e);
  });
}

// ---------- Theme Sync with Antigravity Host ----------
function syncScheme() {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
  document.documentElement.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  const nums = (c.match(/[\d.]+/g) || []).map(Number);
  if (nums.length < 3) return;
  const scale = c.startsWith('color(') ? 1 : 255;
  const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
}

export function initThemeSync() {
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });
}
