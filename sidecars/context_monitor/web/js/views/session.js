/**
 * Tab 1 (Session) view: context ring gauge, full-window stacked bar, KPI strip,
 * smooth monotone trend chart, and recent trace summary.
 */

import { DEFAULT_SESSION_CTX_LIMIT } from '../constants.js';
import {
  $,
  esc,
  fmtDur,
  fmtPct,
  fmtTokens,
  fmtTraceDur,
  hideTip,
  moveTip,
  resolveSessionContextLimit,
  showTip,
} from '../format.js';
import { t } from '../i18n.js';
import { applySessionLayout } from '../layout.js';
import { activeSessionId, state } from '../state.js';
import {
  formatSystemName,
  isCompactionItem,
  renderModelBadges,
  renderModelsCard,
  renderSystemBadges,
  renderTimingBreakdown,
  renderTokenBreakdown,
  renderToolExecCard,
  updateTopbarSpeed,
} from '../components/breakdowns.js';
import { buildSessionRows, computeSessionSpeedStats, renderBreakdownList } from './session-breakdown.js';

/**
 * Builds a smooth monotone cubic Bezier SVG path (Fritsch-Carlson) that never
 * overshoots below 0 or past steep compaction cliffs.
 */
function smoothMonotonePath(coords) {
  const n = coords.length;
  if (n === 0) return '';
  if (n === 1) return `M${coords[0][0].toFixed(1)},${coords[0][1].toFixed(1)}`;
  if (n === 2) {
    return `M${coords[0][0].toFixed(1)},${coords[0][1].toFixed(1)} L${coords[1][0].toFixed(1)},${coords[1][1].toFixed(1)}`;
  }
  const dx = new Array(n - 1);
  const dy = new Array(n - 1);
  const m = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = coords[i + 1][0] - coords[i][0];
    dy[i] = coords[i + 1][1] - coords[i][1];
    m[i] = dx[i] !== 0 ? dy[i] / dx[i] : 0;
  }
  const tangents = new Array(n);
  tangents[0] = m[0];
  tangents[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) {
      tangents[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      tangents[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i]);
    }
  }
  let d = `M${coords[0][0].toFixed(1)},${coords[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const x0 = coords[i][0];
    const y0 = coords[i][1];
    const x1 = coords[i + 1][0];
    const y1 = coords[i + 1][1];
    const h = (x1 - x0) / 3;
    const cx1 = x0 + h;
    const cy1 = y0 + tangents[i] * h;
    const cx2 = x1 - h;
    const cy2 = y1 - tangents[i + 1] * h;
    d += ` C${cx1.toFixed(1)},${cy1.toFixed(1)} ${cx2.toFixed(1)},${cy2.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

function renderTrendChart(allPoints) {
  const el = $('s-timeline-chart');
  $('s-timeline-meta').textContent = t('trend.calls', { n: allPoints.length });
  if (!allPoints.length) {
    el.innerHTML = `<div class="empty-inline">${esc(t('items.empty'))}</div>`;
    return;
  }

  const points = allPoints;
  const W = 400;
  const H = 112;
  const padL = 36;
  const padR = 10;
  const padT = 10;
  const padB = 20;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const baseY = padT + plotH;

  const maxTok = Math.max(...points.map((p) => p.promptTokens), 1000);
  const yMax = Math.max(maxTok * 1.12, 1000);
  const yOf = (v) => padT + plotH - (Math.min(yMax, Math.max(0, v)) / yMax) * plotH;
  const xOf = (i) => (points.length === 1 ? padL + plotW / 2 : padL + (i / (points.length - 1)) * plotW);

  const yTicks = [0, 0.5, 1].map((f) => ({
    y: padT + plotH * (1 - f),
    label: fmtTokens(yMax * f),
  }));

  const coords = points.map((p, i) => [xOf(i), yOf(p.promptTokens)]);

  const segments = [];
  const breakXs = [];
  let curSeg = [];
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && points[i].compacted && curSeg.length) {
      segments.push(curSeg);
      breakXs.push((coords[i - 1][0] + coords[i][0]) / 2);
      curSeg = [];
    }
    curSeg.push(coords[i]);
  }
  if (curSeg.length) segments.push(curSeg);

  const segmentsSvg = segments.map((seg) => {
    if (seg.length === 1) {
      const [x, y] = seg[0];
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.2" fill="var(--cyan)"/>`;
    }
    const lineD = smoothMonotonePath(seg);
    const areaD = `${lineD} L${seg[seg.length - 1][0].toFixed(1)},${baseY.toFixed(1)} L${seg[0][0].toFixed(1)},${baseY.toFixed(1)} Z`;
    return `
      <path d="${areaD}" fill="url(#trendGrad)"/>
      <path d="${lineD}" fill="none" stroke="var(--cyan)" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round"/>
    `;
  }).join('');

  const breaksSvg = breakXs.map((bx) => `
    <line x1="${bx.toFixed(1)}" y1="${padT}" x2="${bx.toFixed(1)}" y2="${baseY}" stroke="var(--amber)" stroke-opacity="0.45" stroke-width="1" stroke-dasharray="2 2"/>
  `).join('');

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}">
      <defs>
        <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--cyan)" stop-opacity="0.26"/>
          <stop offset="100%" stop-color="var(--cyan)" stop-opacity="0.01"/>
        </linearGradient>
      </defs>
      ${yTicks.map((tk) => `
        <line x1="${padL}" y1="${tk.y.toFixed(1)}" x2="${W - padR}" y2="${tk.y.toFixed(1)}" stroke="var(--border)" stroke-width="1"/>
        <text x="${padL - 4}" y="${(tk.y + 3).toFixed(1)}" text-anchor="end" fill="var(--fg-muted)" font-size="9">${esc(tk.label)}</text>
      `).join('')}
      ${breaksSvg}
      ${segmentsSvg}
      <line id="trend-crosshair" x1="0" y1="${padT}" x2="0" y2="${baseY}" stroke="var(--border-strong)" stroke-width="1" stroke-dasharray="2 2" style="display:none"/>
      <circle id="trend-hover-dot" cx="0" cy="0" r="3.2" fill="var(--cyan)" stroke="var(--card)" stroke-width="1.5" style="display:none"/>
      <rect id="trend-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent" style="cursor:crosshair"/>
      <text x="${padL}" y="${H - 4}" fill="var(--fg-muted)" font-size="9">#${points[0].step}</text>
      <text x="${W - padR}" y="${H - 4}" text-anchor="end" fill="var(--fg-muted)" font-size="9">#${points[points.length - 1].step}</text>
    </svg>
  `;

  const svg = el.querySelector('svg');
  const overlay = el.querySelector('#trend-overlay');
  const guide = el.querySelector('#trend-crosshair');
  const hoverDot = el.querySelector('#trend-hover-dot');
  if (overlay && svg) {
    const onMove = (e) => {
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const svgX = ((e.clientX - rect.left) / rect.width) * W;
      const ratio = points.length === 1 ? 0 : Math.max(0, Math.min(1, (svgX - padL) / plotW));
      const idx = Math.round(ratio * (points.length - 1));
      const p = points[idx];
      const [cx, cy] = coords[idx];
      if (guide) {
        guide.setAttribute('x1', cx.toFixed(1));
        guide.setAttribute('x2', cx.toFixed(1));
        guide.style.display = '';
      }
      if (hoverDot) {
        hoverDot.setAttribute('cx', cx.toFixed(1));
        hoverDot.setAttribute('cy', cy.toFixed(1));
        hoverDot.setAttribute('fill', p.compacted ? 'var(--amber)' : 'var(--cyan)');
        hoverDot.style.display = '';
      }
      const sign = p.delta >= 0 ? '+' : '';
      const cachePct = p.promptTokens > 0 ? fmtPct(p.cacheReadTokens / p.promptTokens, 1) : '0%';
      showTip(e, `
        <div><strong>${esc(t('step.label', { step: p.step }))}</strong> · ${esc(t('step.turn', { turn: p.turn || 1 }))}${p.compacted ? ` · <span style="color:var(--amber)">${esc(t('step.compacted'))}</span>` : ''}</div>
        <div>${esc(t('step.prompt'))}: <strong>${fmtTokens(p.promptTokens)}</strong> (${sign}${fmtTokens(p.delta)})</div>
        <div>${esc(t('session.cached'))}: ${cachePct} · ${esc(t('step.output'))}: ${fmtTokens(p.outputTokens)}${p.tokPerSec ? ` · ${p.tokPerSec} tok/s` : ''}</div>
      `);
    };
    overlay.addEventListener('mousemove', onMove);
    overlay.addEventListener('mouseenter', onMove);
    overlay.addEventListener('mouseleave', () => {
      if (guide) guide.style.display = 'none';
      if (hoverDot) hoverDot.style.display = 'none';
      hideTip();
    });
  }
}

function renderRecentTrace(s) {
  const el = $('s-recent-trace');
  const metaEl = $('s-recent-trace-meta');
  const items = Array.isArray(s.recentTrace) ? s.recentTrace : [];
  const total = s.traceCount || items.length;
  metaEl.textContent = items.length ? t('session.recentCount', { n: items.length, total }) : '';

  if (!items.length) {
    el.innerHTML = `<div class="empty-inline">${esc(t('trace.empty'))}</div>`;
    return;
  }

  const wasNearTop = el.scrollTop <= 24;
  const prevTop = el.scrollTop;
  const newestFirst = [...items].reverse();

  el.innerHTML = newestFirst.map((it) => {
    const isComp = isCompactionItem(it);
    const dotCls = it.hasError ? 'error' : (isComp ? 'compaction' : it.kind);
    let name = '';
    let preview = '';
    let extraBadge = '';
    const durText = fmtTraceDur(it.durationMs);
    const rightMeta = durText ? `${durText} · #${it.step}` : `#${it.step}`;

    if (isComp) {
      name = t('trace.compaction');
      preview = String(it.preview || '').replace(/^Context compacted:\s*/i, '');
    } else if (it.kind === 'input') {
      name = t('trace.input');
      preview = it.preview || '';
    } else if (it.kind === 'system') {
      name = formatSystemName(it);
      extraBadge = renderSystemBadges(it);
      preview = it.preview || '';
    } else if (it.kind === 'skill') {
      name = it.skillName || t('trace.skill');
      extraBadge = `<span class="tr-think-badge" style="color:var(--pink);background:color-mix(in srgb,var(--pink) 12%,transparent)">SKILL</span>`;
      preview = it.resultPreview || '';
    } else if (it.kind === 'mcp') {
      name = it.mcpServer && it.mcpTool ? `${it.mcpServer} / ${it.mcpTool}` : (it.mcpTool || it.toolName || t('trace.mcp'));
      extraBadge = `<span class="tr-think-badge badge-mcp">MCP</span>${it.isMcpSchema ? '<span class="tr-think-badge badge-schema">schema</span>' : ''}`;
      preview = it.argsPreview
        ? (it.resultPreview ? `${it.argsPreview} → ${it.resultPreview}` : it.argsPreview)
        : (it.resultPreview || '');
    } else if (it.kind === 'model') {
      name = it.model || t('trace.model');
      extraBadge = renderModelBadges(it);
      preview = it.preview || '';
    } else {
      name = (it.isCommand && it.commandName) ? it.commandName : (it.toolName || t('trace.tool'));
      if (it.isCommand) extraBadge = '<span class="tr-think-badge badge-cmd">CMD</span>';
      preview = it.argsPreview
        ? (it.resultPreview ? `${it.argsPreview} → ${it.resultPreview}` : it.argsPreview)
        : (it.resultPreview || '');
    }

    const revBadge = it.reverted ? `<span class="tr-think-badge badge-reverted">${esc(t('trace.reverted'))}</span>` : '';
    return `
      <div class="tr-row static${it.reverted ? ' reverted' : ''}">
        <div class="tr-left">
          <span class="tr-dot ${dotCls}"></span>
          <span class="tr-name" title="${esc(name)}">${esc(name)}</span>
          ${revBadge}
          ${extraBadge}
          <span class="tr-preview${(it.kind === 'tool' || it.kind === 'mcp') ? ' mono' : ''}">${esc(preview)}</span>
        </div>
        <div class="tr-right"><span>${esc(rightMeta)}</span></div>
      </div>
    `;
  }).join('');

  if (wasNearTop) {
    el.scrollTop = 0;
  } else {
    el.scrollTop = prevTop;
  }
}

export function renderSession() {
  const s = state.sessionData;
  const inspecting = !!state.inspectedConvId;

  $('inspect-banner').classList.toggle('hidden', !inspecting);
  if (inspecting && s) {
    $('inspect-title').textContent = s.title || s.conversationId;
    $('btn-open-inspected').classList.toggle('hidden', !window.sidecar?.ui?.toggleConversation);
  }

  if (!s || !s.modelCalls) {
    updateTopbarSpeed(null);
    $('session-content').classList.add('hidden');
    $('session-empty').classList.remove('hidden');
    const hasConv = !!activeSessionId();
    const inHost = Boolean(window.sidecar);
    $('session-empty-title').textContent = t(hasConv || inHost ? 'empty.noDataTitle' : 'empty.noConvTitle');
    $('session-empty-desc').textContent = t(hasConv || inHost ? 'empty.noDataDesc' : 'empty.noConvDesc');
    return;
  }

  $('session-empty').classList.add('hidden');
  $('session-content').classList.remove('hidden');

  const baseRows = buildSessionRows(s, DEFAULT_SESSION_CTX_LIMIT);
  const ctxMeta = resolveSessionContextLimit(s, baseRows.usedSum);
  const ctxLimit = ctxMeta.limit;
  const rows = baseRows.rows;
  const usedSum = baseRows.usedSum;
  const freeTokens = Math.max(0, ctxLimit - usedSum);
  const used = usedSum || s.currentContext || s.lastPromptTokens || 0;
  const ratio = Math.min(1, used / ctxLimit);
  updateTopbarSpeed(s);

  const compList = s.compactions || [];
  const compCount = compList.length;
  const compChip = $('s-compactions');
  compChip.classList.toggle('hidden', compCount === 0);
  if (compCount > 0) {
    compChip.textContent = t('session.compacted', { n: compCount });
    compChip.title = compList
      .map((c) => `#${c.step}: ${fmtTokens(c.from)} → ${fmtTokens(c.to)}`)
      .join('\n');
  } else {
    compChip.title = '';
  }

  $('s-ctx-used').textContent = fmtTokens(used);
  const limitEl = $('s-ctx-limit');
  limitEl.textContent = fmtTokens(ctxLimit);
  limitEl.title = ctxMeta.source === 'model'
    ? t('session.limitModel', { v: fmtTokens(ctxMeta.modelWindow) })
    : ctxMeta.source === 'compaction'
      ? t('session.limitCompacted', { v: fmtTokens(ctxMeta.firstCompact) })
      : ctxMeta.source === 'extended'
        ? t('session.limitExtended', { v: fmtTokens(ctxMeta.observedPeak) })
        : t('session.limitDefault');
  $('s-ctx-pct').textContent = fmtPct(ratio, 1);
  const ringWrap = $('s-ctx-ring-wrap');
  const ringArc = $('s-ctx-ring-arc');
  if (ringWrap && ringArc) {
    const RING_CIRC = 2 * Math.PI * 9.2;
    ringArc.style.strokeDasharray = RING_CIRC.toFixed(2);
    ringArc.style.strokeDashoffset = (RING_CIRC * (1 - Math.max(0, Math.min(1, ratio)))).toFixed(2);
    ringWrap.classList.toggle('level-crit', ratio >= 0.9);
    ringWrap.classList.toggle('level-warn', ratio >= 0.8 && ratio < 0.9);
  }

  const lastPoint = s.timeline?.[s.timeline.length - 1];
  const cacheRatio = lastPoint && lastPoint.promptTokens > 0
    ? lastPoint.cacheReadTokens / lastPoint.promptTokens
    : (s.totals?.cacheHitRate || 0);
  $('s-ctx-remain').textContent = fmtTokens(freeTokens);
  $('s-cache-rate').textContent = fmtPct(cacheRatio, 1);
  $('s-turns-steps').textContent = t('session.turnsSteps', { turns: s.turns, steps: s.steps });

  const barEl = $('s-stack-bar');
  const segHtml = rows
    .filter((r) => r.value > 0)
    .map((r) => {
      const winFrac = (r.value / ctxLimit) * 100;
      return `<div class="ctx-seg" data-id="${esc(r.id)}" style="width:${Math.max(0.4, winFrac).toFixed(3)}%;background:${r.color}"></div>`;
    })
    .join('');
  const freeHtml = freeTokens > 0 ? '<div class="ctx-seg free" data-id="free"></div>' : '';
  barEl.innerHTML = segHtml + freeHtml;

  barEl.querySelectorAll('.ctx-seg').forEach((seg) => {
    const id = seg.dataset.id;
    const row = rows.find((r) => r.id === id);
    seg.addEventListener('mouseenter', (e) => {
      if (id === 'free') {
        showTip(e, `<strong>${esc(t('cat.free_space'))}</strong><br>${fmtTokens(freeTokens)} (${fmtPct(freeTokens / ctxLimit, 1)})`);
      } else if (row) {
        showTip(e, `
          <div><strong>${esc(row.label)}</strong> · ${fmtTokens(row.value)}</div>
          <div>${esc(t('tip.windowShare', { pct: fmtPct(row.value / ctxLimit, 2) }))}</div>
          <div style="opacity:.75">${esc(t('tip.usedShare', { pct: fmtPct(row.value / Math.max(1, used), 1) }))}</div>
        `);
      }
    });
    seg.addEventListener('mousemove', moveTip);
    seg.addEventListener('mouseleave', hideTip);
    if (row) {
      seg.addEventListener('click', () => {
        if (state.expandedKeys.has(row.id)) state.expandedKeys.delete(row.id);
        else state.expandedKeys.add(row.id);
        renderBreakdownList(rows, freeTokens, ctxLimit);
      });
    }
  });

  renderBreakdownList(rows, freeTokens, ctxLimit);

  const tot = s.totals || {};
  $('s-total-tokens').textContent = fmtTokens(tot.totalTokens || 0);
  $('s-total-io').textContent = t('kpi.ioSub', {
    in: fmtTokens((tot.inputTokens || 0) + (tot.cacheReadTokens || 0)),
    out: fmtTokens(tot.outputTokens || 0),
  });
  $('s-cache-read').textContent = fmtTokens(tot.cacheReadTokens || 0);
  $('s-cache-sub').textContent = t('kpi.hitSub', { pct: fmtPct(tot.cacheHitRate || 0, 1) });
  $('s-output-tokens').textContent = fmtTokens(tot.outputTokens || 0);
  $('s-calls').textContent = t('kpi.callsSub', { calls: s.modelCalls, tools: s.toolCallsCount });
  $('s-duration').textContent = fmtDur(s.timing?.activeMs || 0);
  const spStats = computeSessionSpeedStats(s);
  const speedLine = spStats.avgSpeed > 0
    ? (spStats.maxSpeed > 0 ? `avg ${spStats.avgSpeed} · max ${spStats.maxSpeed} tok/s` : `avg ${spStats.avgSpeed} tok/s`)
    : '0 tok/s';
  $('s-speed').textContent = speedLine;
  $('s-speed').title = speedLine;

  const sessModels = Array.isArray(s.modelsBreakdown) && s.modelsBreakdown.length
    ? s.modelsBreakdown
    : Object.entries(s.modelsUsed || {}).map(([m, mv]) => {
        const p = (mv.inputTokens || 0) + (mv.cacheReadTokens || 0);
        const tMs = mv.timedDurationMs ?? mv.durationMs ?? 0;
        const tOut = mv.timedOutputTokens ?? mv.outputTokens ?? 0;
        return {
          model: m,
          ...mv,
          totalTokens: p + (mv.outputTokens || 0),
          cacheHitRate: p > 0 ? (mv.cacheReadTokens || 0) / p : 0,
          tokPerSec: tMs > 0 ? Math.round((tOut / (tMs / 1000)) * 10) / 10 : 0,
        };
      }).sort((a, b) => b.totalTokens - a.totalTokens);
  renderModelsCard($('s-models-list'), $('s-models-bar'), $('s-models-meta'), sessModels, { showSessions: false });
  renderTokenBreakdown($('s-token-bar'), $('s-token-legend'), $('s-token-total-meta'), s.cumulativeComposition, tot.totalTokens || 0);
  renderTimingBreakdown($('s-timing-bar'), $('s-timing-legend'), $('s-timing-speed'), s.timing);
  renderToolExecCard($('s-hooks-card'), $('s-hooks-meta'), $('s-hooks-bar'), $('s-hooks-stats'), $('s-hooks-reasons'), {
    toolsList: s.tools,
    totalExecMs: s.timing?.toolExecMs || 0,
    hookData: s.hookTelemetry,
  });
  renderTrendChart(s.timeline || []);
  renderRecentTrace(s);
  applySessionLayout();
}
