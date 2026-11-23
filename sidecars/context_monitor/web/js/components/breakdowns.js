/**
 * Shared renderers used across Session, Project/Global Overview, and Trace views:
 *   - Tool Execution card
 *   - Token Breakdown card
 *   - Time Breakdown card
 *   - Per-Model Usage card
 *   - System / Model trace badges & topbar speed badge
 */

import { ALL_OVERVIEW_CATS, MODEL_COLORS, TIMING_META } from '../constants.js';
import { $, bindSegBarTips, esc, fmtDur, fmtPct, fmtTokens, tipHeadHtml } from '../format.js';
import { hasI18nKey, t } from '../i18n.js';
import { state } from '../state.js';

export function renderToolExecCard(cardEl, metaEl, barEl, statsEl, reasonsEl, { toolsList = [], totalExecMs = 0, hookData = null } = {}) {
  if (!cardEl) return;
  const list = Array.isArray(toolsList) ? toolsList : Object.values(toolsList || {});
  const totalCalls = list.reduce((a, x) => a + (x.count || 0), 0);
  const failedCalls = list.reduce((a, x) => a + (x.errors || 0), 0);
  const succeededCalls = Math.max(0, totalCalls - failedCalls);
  const sumDurMs = list.reduce((a, x) => a + (x.durationMs || 0), 0);
  const durMs = sumDurMs > 0 ? sumDurMs : (totalExecMs || 0);

  cardEl.classList.toggle('hidden', totalCalls === 0);
  if (totalCalls === 0) {
    if (barEl) {
      barEl.innerHTML = '';
      bindSegBarTips(barEl, null);
    }
    return;
  }

  metaEl.textContent = t('hooks.callsCount', { n: totalCalls });

  const okPct = totalCalls > 0 ? succeededCalls / totalCalls : 1;
  const errPct = totalCalls > 0 ? failedCalls / totalCalls : 0;
  const execSegs = [
    { id: 'success', label: t('hooks.success'), color: 'var(--green)', count: succeededCalls, pct: okPct },
    { id: 'failed', label: t('hooks.failed'), color: 'var(--rose)', count: failedCalls, pct: errPct },
  ].filter((s) => s.count > 0);
  if (barEl) {
    barEl.innerHTML = execSegs
      .map((s) => `<div class="ctx-seg" data-seg-id="${s.id}" style="width:${(s.pct * 100).toFixed(2)}%;background:${s.color}"></div>`)
      .join('');
    const segById = new Map(execSegs.map((s) => [s.id, s]));
    bindSegBarTips(barEl, (id) => {
      const s = segById.get(id);
      if (!s) return null;
      return `
        ${tipHeadHtml(s.color, s.label)}
        <div><strong>${s.count}</strong> / ${totalCalls} · ${fmtPct(s.pct, 1)}</div>
      `;
    }, { legendEl: statsEl });
  }

  const avgMs = totalCalls > 0 && durMs > 0 ? Math.round(durMs / totalCalls) : 0;
  const avgText = avgMs > 0
    ? (avgMs < 1000 ? `${avgMs}ms` : `${(avgMs / 1000).toFixed(1)}s`)
    : '—';

  statsEl.innerHTML = `
    <div class="hooks-stat-cell" data-seg-id="success">
      <div class="hooks-stat-label">${esc(t('hooks.success'))}</div>
      <div class="hooks-stat-val ok">${succeededCalls}</div>
      <div class="hooks-stat-sub">${fmtPct(okPct, 1)}</div>
    </div>
    <div class="hooks-stat-cell" data-seg-id="failed">
      <div class="hooks-stat-label">${esc(t('hooks.failed'))}</div>
      <div class="hooks-stat-val${failedCalls > 0 ? ' err' : ''}">${failedCalls}</div>
      <div class="hooks-stat-sub">${fmtPct(errPct, 1)}</div>
    </div>
    <div class="hooks-stat-cell">
      <div class="hooks-stat-label">${esc(t('hooks.toolTime'))}</div>
      <div class="hooks-stat-val">${durMs > 0 ? fmtDur(durMs) : '—'}</div>
      <div class="hooks-stat-sub">${esc(t('hooks.avgCall', { v: avgText }))}</div>
    </div>
  `;

  const reasons = hookData?.turnStats?.reasons || hookData?.reasons || {};
  const abnormalReasons = Object.entries(reasons)
    .filter(([code, cnt]) => code !== 'NO_TOOL_CALL' && cnt > 0)
    .sort((a, b) => b[1] - a[1]);
  reasonsEl.innerHTML = abnormalReasons.map(([code, cnt]) => {
    const i18nKey = `hooks.reason.${code}`;
    const label = hasI18nKey(i18nKey) ? t(i18nKey) : code;
    const cls = code === 'USER_CANCELED' ? 'warn' : code === 'ERROR' ? 'err' : '';
    return `<span class="reason-pill ${cls}">${esc(label)} <strong>${cnt}</strong></span>`;
  }).join('');
}

export function renderTokenBreakdown(barEl, legendEl, metaEl, cum, totalTokens = 0) {
  if (!barEl || !legendEl) return;
  const src = cum || {};
  const tokSegs = ALL_OVERVIEW_CATS.map((c) => ({ ...c, label: t(`cat.${c.key}`), value: src[c.key] || 0 }));
  const segSum = tokSegs.reduce((a, x) => a + x.value, 0);
  const tokTotal = segSum || 1;
  if (metaEl) metaEl.textContent = fmtTokens(totalTokens || segSum || 0);
  const visibleTokSegs = tokSegs.filter((x) => x.value > 0);
  barEl.innerHTML = visibleTokSegs
    .map((x) => `<div class="ctx-seg" data-seg-id="${esc(x.key)}" style="width:${((x.value / tokTotal) * 100).toFixed(2)}%;background:${x.color}"></div>`)
    .join('');
  const tokByKey = new Map(visibleTokSegs.map((x) => [x.key, x]));
  bindSegBarTips(barEl, (id) => {
    const x = tokByKey.get(id);
    if (!x) return null;
    return `
      ${tipHeadHtml(x.color, x.label)}
      <div><strong>${fmtTokens(x.value)}</strong> · ${fmtPct(x.value / tokTotal, 1)}</div>
    `;
  }, { legendEl });
  legendEl.innerHTML = tokSegs.map((x) => `
    <div class="comp-item" data-seg-id="${esc(x.key)}" title="${esc(x.label)}: ${fmtTokens(x.value)} (${fmtPct(x.value / tokTotal, 1)})">
      <div class="comp-left">
        <span class="comp-dot" style="background:${x.color}"></span>
        <span class="comp-name">${esc(x.label)}</span>
      </div>
      <div class="comp-right">
        <span class="comp-sub">${fmtTokens(x.value)}</span>
        <span class="comp-pct">${fmtPct(x.value / tokTotal, 1)}</span>
      </div>
    </div>
  `).join('');
}

export function renderTimingBreakdown(barEl, legendEl, speedEl, tm) {
  if (!barEl || !legendEl) return;
  const timing = tm || {};
  if (speedEl) speedEl.textContent = t('ov.speed', { v: timing.outputTokPerSec || 0 });
  const tmSegs = TIMING_META
    .map((x) => ({ ...x, label: t(`time.${x.key}`), value: timing[x.key] || 0 }))
    .filter((x) => !x.optional || x.value > 0);
  const tmTotal = tmSegs.reduce((a, x) => a + x.value, 0) || 1;
  const visibleTmSegs = tmSegs.filter((x) => x.value > 0);
  barEl.innerHTML = visibleTmSegs
    .map((x) => `<div class="ctx-seg" data-seg-id="${esc(x.key)}" style="width:${((x.value / tmTotal) * 100).toFixed(2)}%;background:${x.color}"></div>`)
    .join('');
  const tmByKey = new Map(visibleTmSegs.map((x) => [x.key, x]));
  bindSegBarTips(barEl, (id) => {
    const x = tmByKey.get(id);
    if (!x) return null;
    const durText = x.value > 0 && x.value < 1000 ? `${Math.round(x.value)}ms` : fmtDur(x.value);
    return `
      ${tipHeadHtml(x.color, x.label)}
      <div><strong>${durText}</strong> · ${fmtPct(x.value / tmTotal, 1)}</div>
    `;
  }, { legendEl });
  legendEl.innerHTML = tmSegs.map((x) => `
    <div class="comp-item" data-seg-id="${esc(x.key)}" title="${esc(x.label)}: ${fmtDur(x.value)} (${fmtPct(x.value / tmTotal, 1)})">
      <div class="comp-left">
        <span class="comp-dot" style="background:${x.color}"></span>
        <span class="comp-name">${esc(x.label)}</span>
      </div>
      <div class="comp-right">
        <span class="comp-sub">${fmtDur(x.value)}</span>
        <span class="comp-pct">${fmtPct(x.value / tmTotal, 1)}</span>
      </div>
    </div>
  `).join('');
}

export function renderModelsCard(listEl, barEl, metaEl, modelsList, { showSessions = false } = {}) {
  const items = Array.isArray(modelsList) ? modelsList : [];
  metaEl.textContent = items.length ? t('models.count', { n: items.length }) : '';
  if (!items.length) {
    barEl.classList.add('hidden');
    barEl.innerHTML = '';
    bindSegBarTips(barEl, null);
    listEl.innerHTML = `<div class="empty-inline">${esc(t('models.noModels'))}</div>`;
    return;
  }

  const totalAll = items.reduce((a, m) => a + (m.totalTokens || 0), 0) || 1;
  const callTextOf = (m) => (showSessions && m.sessions
    ? t('models.sessionsCalls', { s: m.sessions, c: m.calls })
    : t('models.callsOnly', { c: m.calls }));

  barEl.classList.toggle('hidden', items.length <= 1);
  if (items.length > 1) {
    barEl.innerHTML = items.map((m, idx) => {
      const w = Math.max(1, ((m.totalTokens || 0) / totalAll) * 100);
      const color = MODEL_COLORS[idx % MODEL_COLORS.length];
      return `<div class="ctx-seg" data-seg-id="${idx}" style="width:${w.toFixed(2)}%;background:${color}"></div>`;
    }).join('');
    bindSegBarTips(barEl, (id) => {
      const idx = Number(id);
      const m = items[idx];
      if (!m) return null;
      const color = MODEL_COLORS[idx % MODEL_COLORS.length];
      const share = (m.totalTokens || 0) / totalAll;
      return `
        ${tipHeadHtml(color, m.model, { mono: true })}
        <div><strong>${fmtTokens(m.totalTokens)}</strong> · ${fmtPct(share, 1)} · ${esc(callTextOf(m))}</div>
        <div class="tip-sub">${esc(t('tip.newIn'))} ${fmtTokens(m.inputTokens)} · ${esc(t('tip.cacheRead'))} ${fmtTokens(m.cacheReadTokens)} · ${esc(t('tip.out'))} ${fmtTokens(m.outputTokens)}</div>
      `;
    }, { legendEl: listEl });
  } else {
    barEl.innerHTML = '';
    bindSegBarTips(barEl, null);
  }

  listEl.innerHTML = items.map((m, idx) => {
    const color = MODEL_COLORS[idx % MODEL_COLORS.length];
    const callText = callTextOf(m);
    const tipText = `In ${fmtTokens(m.inputTokens)} · Cache ${fmtTokens(m.cacheReadTokens)} · Out ${fmtTokens(m.outputTokens)}`;
    return `
      <div class="model-stat-row" data-seg-id="${idx}" title="${esc(tipText)}">
        <div class="ms-left">
          <span class="bd-dot" style="background:${color}"></span>
          <span class="ms-name">${esc(m.model)}</span>
          <span class="ms-calls">${esc(callText)}</span>
        </div>
        <div class="ms-metrics">
          <strong>${fmtTokens(m.totalTokens)}</strong>
          <span>${fmtPct(m.cacheHitRate, 0)}</span>
          <span>${m.tokPerSec || 0} tok/s</span>
        </div>
      </div>
    `;
  }).join('');
}

export function isCompactionItem(it) {
  return Boolean(it && (it.kind === 'compaction' || it.systemType === 'COMPACTION' || it.status === 'COMPACTED'));
}

export function getSystemBadges(it) {
  if (!it || it.kind !== 'system') return [];
  const set = new Set();
  if (Array.isArray(it.systemBadges)) {
    for (const b of it.systemBadges) if (b) set.add(b);
  } else if (it.systemBadge) {
    set.add(it.systemBadge === 'time_context' ? 'time' : it.systemBadge);
  }
  const body = String(it.preview || it.content || '');
  const upperTag = String(it.systemType || '').toUpperCase();
  if (/The current local time is:/i.test(body)) set.add('time');
  if (
    /The user has uploaded\s+\d+\s+image\(s\)/i.test(body)
    || (/uploaded/i.test(body) && /\.(png|jpe?g|webp|gif|bmp)\b/i.test(body))
  ) {
    set.add('image');
  } else if (/The user has uploaded\s+\d+\s+(?:file|document|attachment|audio|video)/i.test(body)) {
    set.add('attachment');
  }
  if (upperTag === 'COMPACTION' || upperTag === 'CONTEXT_SUMMARY' || upperTag === 'CHECKPOINT') {
    set.add('compaction');
  }
  if (upperTag.includes('SETTINGS')) set.add('settings');
  return [...set];
}

export function formatSystemName(it) {
  const raw = String(it?.systemType || '').trim();
  const upper = raw.toUpperCase();
  if (!raw || upper === 'ADDITIONAL_METADATA' || upper === 'INJECTED') {
    return 'context injected';
  }
  return raw.toLowerCase().replace(/_/g, ' ');
}

export function renderSystemBadges(it) {
  return getSystemBadges(it)
    .map((b) => `<span class="tr-think-badge badge-${esc(b)}">${esc(t(`inj.${b}`))}</span>`)
    .join('');
}

export function renderModelBadges(it) {
  const badges = [];
  if (it.hasThinking) {
    badges.push(`<span class="tr-think-badge">${esc(t('td.thinking'))}</span>`);
  }
  if ((it.toolCount || 0) > 0) {
    badges.push(`<span class="tr-think-badge badge-toolcall">${esc(t('td.toolCall'))}</span>`);
  }
  const hasOut = it.hasReply !== undefined
    ? Boolean(it.hasReply)
    : Boolean(!it.hasThinking && it.preview && it.preview !== t('trace.toolOnly'));
  if (hasOut) {
    badges.push(`<span class="tr-think-badge badge-output">${esc(t('td.output'))}</span>`);
  }
  return badges.join('');
}

export function updateTopbarSpeed(s) {
  const el = $('topbar-speed');
  if (!el) return;
  if (!s || state.tab !== 'session') {
    el.classList.add('hidden');
    return;
  }
  const tl = Array.isArray(s.timeline) ? s.timeline : [];
  let latestCall = null;
  for (let i = tl.length - 1; i >= 0; i--) {
    const pt = tl[i];
    const outTok = Number(pt?.outputTokens || 0);
    const streamMs = Number(pt?.streamMs || 0);
    const ttftMs = Number(pt?.ttftMs || 0);
    const durMs = Number(pt?.durationMs || 0);
    const speedMs = streamMs > 0 ? streamMs : (ttftMs > 0 ? 0 : durMs);
    if (pt && speedMs > 0 && outTok > 0) {
      latestCall = { ...pt, outTok, speedMs };
      break;
    }
  }
  const spd = latestCall
    ? (latestCall.tokPerSec || Math.round((latestCall.outTok / (latestCall.speedMs / 1000)) * 10) / 10)
    : (s.timing?.outputTokPerSec || 0);
  if (!spd) {
    el.classList.add('hidden');
    return;
  }
  const curModel = latestCall?.model || s.model || '';
  const stepTag = latestCall?.step != null ? ` #${latestCall.step}` : '';
  el.textContent = `${spd} tok/s`;
  el.title = curModel ? `${curModel}${stepTag} · ${spd} tok/s` : `${spd} tok/s`;
  el.classList.remove('hidden');
}
