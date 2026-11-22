/**
 * Trace side pane view: duration-proportional 3-track timeline strip with
 * independent horizontal lazy loading, exclusive type filter tags,
 * progressive history loading, live generating row, and scroll follow behavior.
 */

import { TRACE_TAG_DEFS } from '../constants.js';
import { $, esc, fmtTraceDur } from '../format.js';
import { t } from '../i18n.js';
import { activeSessionId, isLiveGenerating, state, updateGeneratingTicker } from '../state.js';
import {
  formatSystemName,
  getSystemBadges,
  isCompactionItem,
  renderModelBadges,
  renderSystemBadges,
} from '../components/breakdowns.js';
import { closeTraceDetail, renderTraceDetailPanel, toggleTraceDetail } from './trace-detail.js';

const STRIP_PAGE_SIZE = 40;
const STRIP_UNIT_MS = 5000;
const STRIP_UNIT_PX = 10;
const STRIP_COMPACTION_W = 8;
const STRIP_MAX_DUR_W = STRIP_UNIT_PX * 12; // cap at 60s (12 units)

function calcStripCellWidth(it) {
  if (isCompactionItem(it)) return STRIP_COMPACTION_W;
  if (it.kind === 'input' || it.kind === 'system') return STRIP_UNIT_PX;
  const durMs = Math.max(0, Number(it.durationMs) || 0);
  if (durMs <= STRIP_UNIT_MS) return STRIP_UNIT_PX;
  return Math.round(Math.min(STRIP_MAX_DUR_W, (durMs / STRIP_UNIT_MS) * STRIP_UNIT_PX));
}

function calcModelThinkingRatio(it) {
  const thinkMs = Math.max(0, Number(it.thinkingMs) || 0);
  const streamMs = Math.max(0, Number(it.streamMs) || 0);
  const outGenMs = Math.max(0, Number(it.outputGenMs) || 0);
  if (thinkMs > 0) {
    const denom = Math.max(thinkMs + outGenMs, streamMs, 1);
    return Math.max(0, Math.min(1, thinkMs / denom));
  }
  const thinkTok = Number(it.thinkingTokens);
  const outTok = Number(it.outputTokens) || 0;
  if (Number.isFinite(thinkTok) && thinkTok > 0 && outTok > 0) {
    return Math.max(0, Math.min(0.95, thinkTok / outTok));
  }
  if (it.hasThinking && !it.hasReply && !(it.toolCount > 0)) return 1;
  return 0;
}

export function isNearTraceBottom() {
  const el = $('trace-list');
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 40;
}

export function updateTraceJumpBtn() {
  const btn = $('btn-trace-latest');
  if (!btn) return;
  const listEl = $('trace-list');
  const scrollable = listEl && listEl.scrollHeight > listEl.clientHeight + 24;
  btn.classList.toggle('hidden', !scrollable || state.traceStick);
}

export function scrollTraceToBottom(smooth = false) {
  const el = $('trace-list');
  if (el) {
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
  }
  const stripScroll = $('trace-strip-scroll');
  if (stripScroll) {
    if (smooth) stripScroll.scrollTo({ left: stripScroll.scrollWidth, behavior: 'smooth' });
    else stripScroll.scrollLeft = stripScroll.scrollWidth;
  }
  state.traceStick = true;
  updateTraceJumpBtn();
}

function traceEventMatchesTags(it) {
  if (it.hasError) return state.traceEnabled.has('error');
  if (isCompactionItem(it)) return state.traceEnabled.has('compaction');
  return state.traceEnabled.has(it.kind);
}

function getFilteredTraceItems(allItems) {
  const q = state.traceQuery.trim().toLowerCase();
  return allItems.filter((it) => {
    if (!traceEventMatchesTags(it)) return false;
    if (!q) return true;
    return String(it.toolName || '').toLowerCase().includes(q)
      || String(it.skillName || '').toLowerCase().includes(q)
      || String(it.mcpServer || '').toLowerCase().includes(q)
      || String(it.mcpTool || '').toLowerCase().includes(q)
      || String(it.commandName || '').toLowerCase().includes(q)
      || (it.kind === 'mcp' && 'mcp'.includes(q))
      || (it.isCommand && 'cmd'.includes(q))
      || String(it.model || '').toLowerCase().includes(q)
      || String(it.systemType || '').toLowerCase().includes(q)
      || (isCompactionItem(it) && t('trace.compaction').toLowerCase().includes(q))
      || (it.kind === 'system' && formatSystemName(it).includes(q))
      || (it.kind === 'system' && getSystemBadges(it).some((b) => b.includes(q) || t(`inj.${b}`).toLowerCase().includes(q)))
      || String(it.preview || '').toLowerCase().includes(q)
      || String(it.argsPreview || '').toLowerCase().includes(q)
      || String(it.resultPreview || '').toLowerCase().includes(q);
  });
}

function renderTraceTags(counts) {
  const el = $('trace-tags');
  if (!el) return;
  el.innerHTML = TRACE_TAG_DEFS.map((def) => {
    const on = state.traceEnabled.has(def.key);
    const cnt = counts?.[def.key] || 0;
    return `
      <button type="button" class="trace-tag${on ? '' : ' off'}" data-ttag="${def.key}" aria-pressed="${on}">
        <span class="trace-tag-dot" style="background:${def.color}"></span>
        <span>${esc(t(def.labelKey))}</span>
        ${cnt > 0 ? `<span class="trace-tag-cnt">${cnt}</span>` : ''}
      </button>
    `;
  }).join('');
  el.querySelectorAll('.trace-tag').forEach((btn) => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.ttag;
      if (state.traceEnabled.has(k)) state.traceEnabled.delete(k);
      else state.traceEnabled.add(k);
      renderTrace();
    });
  });
}

function buildStripTooltip(it, label, revNote) {
  const durText = fmtTraceDur(it.durationMs);
  const parts = [`#${it.step} ${label}${revNote}`];
  if (durText) parts.push(durText);
  if (it.kind === 'model') {
    const sub = [];
    if ((it.ttftMs || 0) > 0) sub.push(`${t('td.ttft')} ${fmtTraceDur(it.ttftMs)}`);
    if ((it.thinkingMs || 0) > 0) sub.push(`${t('td.thinking')} ${fmtTraceDur(it.thinkingMs)}`);
    if ((it.outputGenMs || 0) > 0) sub.push(`${t('td.output')} ${fmtTraceDur(it.outputGenMs)}`);
    if (sub.length) parts.push(`(${sub.join(' · ')})`);
  }
  return parts.join(' · ');
}

function renderTraceStrip(filtered) {
  const stripEl = $('trace-strip');
  const listEl = $('trace-list');
  if (!stripEl) return;

  const hiddenStrip = Math.max(0, filtered.length - state.traceStripLimit);
  state.traceStripHiddenEarlier = hiddenStrip;
  const stripItems = hiddenStrip > 0 ? filtered.slice(-state.traceStripLimit) : filtered;

  if (!stripItems.length) {
    stripEl.classList.add('hidden');
    return;
  }

  stripEl.classList.remove('hidden');
  const widths = stripItems.map(calcStripCellWidth);
  const lanes = [
    { key: 'input', labelKey: 'trace.input', match: (it) => !isCompactionItem(it) && (it.kind === 'input' || it.kind === 'system') },
    { key: 'model', labelKey: 'trace.model', match: (it) => !isCompactionItem(it) && it.kind === 'model' },
    { key: 'tool', labelKey: 'trace.tool', match: (it) => !isCompactionItem(it) && (it.kind === 'tool' || it.kind === 'skill' || it.kind === 'mcp') },
  ];

  const moreBtnHtml = hiddenStrip > 0
    ? `<button type="button" class="ts-more" title="${esc(t('trace.loadMore', { step: Math.min(STRIP_PAGE_SIZE, hiddenStrip), n: hiddenStrip }))}">…</button>`
    : '';

  const renderLaneCells = (lane, laneIdx) => `
    <div class="ts-cells">
      ${hiddenStrip > 0 ? (laneIdx === 1 ? moreBtnHtml : '<div class="ts-more-spacer"></div>') : ''}
      ${stripItems.map((it, idxInStrip) => {
        const w = widths[idxInStrip];
        const sel = state.traceSelectedIdx === it.idx ? ' selected' : '';
        const revCls = it.reverted ? ' reverted' : '';
        const revNote = it.reverted ? ` (${t('trace.reverted')})` : '';
        if (isCompactionItem(it)) {
          const tip = `#${it.step} ${t('trace.compaction')}${it.preview ? ` · ${String(it.preview).replace(/^Context compacted:\s*/i, '')}` : ''}`;
          return `<div class="ts-cell hit on-compaction${sel}${revCls}" style="width:${w}px" data-tidx="${it.idx}" title="${esc(tip)}"></div>`;
        }
        if (!lane.match(it)) return `<div class="ts-cell" style="width:${w}px"></div>`;

        const label = it.skillName
          || (it.kind === 'mcp' && it.mcpServer && it.mcpTool ? `${it.mcpServer} / ${it.mcpTool}` : '')
          || (it.isCommand && it.commandName ? it.commandName : '')
          || it.toolName
          || it.model
          || it.systemType
          || t(`trace.${it.kind}`);
        const tip = buildStripTooltip(it, label, revNote);

        if (it.kind === 'model' && !it.hasError) {
          const thinkRatio = calcModelThinkingRatio(it);
          const thinkPct = Math.round(thinkRatio * 1000) / 10;
          const outPct = Math.max(0, Math.round((100 - thinkPct) * 10) / 10);
          return `<div class="ts-cell hit on-model-split${sel}${revCls}" style="width:${w}px" data-tidx="${it.idx}" title="${esc(tip)}">${
            thinkPct > 0 ? `<span class="ts-part-think" style="width:${thinkPct}%"></span>` : ''
          }${
            outPct > 0 ? `<span class="ts-part-out" style="width:${outPct}%"></span>` : ''
          }</div>`;
        }

        const cls = it.hasError ? 'on-error' : `on-${it.kind}`;
        return `<div class="ts-cell hit ${cls}${sel}${revCls}" style="width:${w}px" data-tidx="${it.idx}" title="${esc(tip)}"></div>`;
      }).join('')}
    </div>
  `;

  stripEl.innerHTML = `
    <div class="ts-labels">
      ${lanes.map((l) => `<span class="ts-lane-label">${esc(t(l.labelKey))}</span>`).join('')}
    </div>
    <div id="trace-strip-scroll" class="ts-scroll${hiddenStrip > 0 ? ' has-earlier' : ''}">
      ${lanes.map(renderLaneCells).join('')}
    </div>
  `;

  stripEl.querySelector('.ts-more')?.addEventListener('click', loadEarlierStrip);
  stripEl.querySelectorAll('.ts-cell.hit').forEach((cell) => {
    cell.addEventListener('click', () => {
      const idx = Number(cell.dataset.tidx);
      const posInFiltered = filtered.findIndex((x) => x.idx === idx);
      if (posInFiltered >= 0) {
        const neededLimit = filtered.length - posInFiltered;
        if (neededLimit > state.traceLimit) {
          state.traceLimit = neededLimit + 20;
          state.traceStick = false;
          renderTrace({ skipScrollRestore: true });
        }
      }
      const opened = toggleTraceDetail(idx);
      if (opened && listEl) {
        const row = listEl.querySelector(`.tr-row[data-tidx="${idx}"]`);
        if (row) row.scrollIntoView({ block: 'nearest' });
      }
    });
  });

  const stripScrollEl = $('trace-strip-scroll');
  if (stripScrollEl) {
    stripScrollEl.addEventListener('scroll', () => {
      if (!state.traceFirstScroll && state.traceStripHiddenEarlier > 0 && stripScrollEl.scrollLeft <= 24) {
        loadEarlierStrip();
      }
    }, { passive: true });

    stripScrollEl.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && stripScrollEl.scrollWidth > stripScrollEl.clientWidth) {
        e.preventDefault();
        stripScrollEl.scrollLeft += e.deltaY;
      }
    }, { passive: false });
  }
}

export function loadEarlierStrip() {
  if (!state.traceStripHiddenEarlier || state.traceStripLoadingEarlier) return;
  const allItems = Array.isArray(state.traceData?.items) ? state.traceData.items : [];
  if (!allItems.length) return;

  state.traceStripLoadingEarlier = true;
  const oldStrip = $('trace-strip-scroll');
  const prevStripW = oldStrip ? oldStrip.scrollWidth : 0;
  const prevStripLeft = oldStrip ? oldStrip.scrollLeft : 0;

  state.traceStripLimit += STRIP_PAGE_SIZE;
  const filtered = getFilteredTraceItems(allItems);
  renderTraceStrip(filtered);

  const newStrip = $('trace-strip-scroll');
  if (newStrip && prevStripW > 0) {
    const addedW = newStrip.scrollWidth - prevStripW;
    newStrip.scrollLeft = Math.max(0, prevStripLeft + addedW);
  }
  requestAnimationFrame(() => { state.traceStripLoadingEarlier = false; });
}

export function loadEarlierTrace() {
  if (!state.traceHiddenEarlier || state.traceLoadingEarlier) return;
  state.traceLoadingEarlier = true;
  const listEl = $('trace-list');
  const prevH = listEl ? listEl.scrollHeight : 0;
  const prevTop = listEl ? listEl.scrollTop : 0;

  state.traceLimit += 250;
  state.traceStick = false;
  renderTrace({ skipScrollRestore: true, skipStripRender: true });

  if (listEl) {
    const addedH = listEl.scrollHeight - prevH;
    if (addedH > 0) listEl.scrollTop = prevTop + addedH;
  }
  updateTraceJumpBtn();
  requestAnimationFrame(() => { state.traceLoadingEarlier = false; });
}

export function renderTrace(opts = {}) {
  const data = state.traceData;
  const listEl = $('trace-list');
  const stripEl = $('trace-strip');
  const allItems = Array.isArray(data?.items) ? data.items : [];
  const prevScrollTop = listEl.scrollTop;
  const prevStripScroll = $('trace-strip-scroll')?.scrollLeft || 0;
  const shouldStick = state.traceFirstScroll || (state.traceFollow && state.traceStick);

  if ($('trace-total-count')) $('trace-total-count').textContent = String(allItems.length);
  const exclusiveCounts = { input: 0, system: 0, skill: 0, mcp: 0, model: 0, tool: 0, compaction: 0, error: 0 };
  for (const it of allItems) {
    const bucket = it.hasError ? 'error' : (isCompactionItem(it) ? 'compaction' : it.kind);
    if (bucket in exclusiveCounts) exclusiveCounts[bucket]++;
  }
  renderTraceTags(exclusiveCounts);

  if (!allItems.length) {
    stripEl.classList.add('hidden');
    listEl.innerHTML = `<div class="empty-inline">${esc(t('trace.empty'))}</div>`;
    $('btn-trace-latest').classList.add('hidden');
    closeTraceDetail();
    return;
  }

  const q = state.traceQuery.trim().toLowerCase();
  const filtered = getFilteredTraceItems(allItems);

  const hiddenEarlier = Math.max(0, filtered.length - state.traceLimit);
  state.traceHiddenEarlier = hiddenEarlier;
  const visible = hiddenEarlier > 0 ? filtered.slice(-state.traceLimit) : filtered;

  if (!opts.skipStripRender) {
    renderTraceStrip(filtered);
  }

  if (!filtered.length) {
    listEl.innerHTML = `<div class="empty-inline">${esc(t('trace.empty'))}</div>`;
    $('btn-trace-latest').classList.add('hidden');
    return;
  }

  const loadMoreHtml = hiddenEarlier > 0
    ? `<button type="button" id="btn-trace-load-earlier" class="trace-load-more">↑ ${esc(t('trace.loadMore', { step: Math.min(250, hiddenEarlier), n: hiddenEarlier }))}</button>`
    : '';
  const rowsHtml = visible.map((it) => {
    const sel = state.traceSelectedIdx === it.idx ? ' selected' : '';
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
      preview = it.preview || (it.mediaCount ? `[${it.mediaCount} media]` : '');
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
        ? (it.resultPreview ? `${it.argsPreview}  →  ${it.resultPreview}` : it.argsPreview)
        : it.resultPreview;
    } else if (it.kind === 'model') {
      name = it.model || t('trace.model');
      extraBadge = renderModelBadges(it);
      preview = it.preview || '';
    } else {
      name = (it.isCommand && it.commandName) ? it.commandName : (it.toolName || t('trace.tool'));
      if (it.isCommand) extraBadge = '<span class="tr-think-badge badge-cmd">CMD</span>';
      preview = it.argsPreview
        ? (it.resultPreview ? `${it.argsPreview}  →  ${it.resultPreview}` : it.argsPreview)
        : it.resultPreview;
    }

    const revBadge = it.reverted ? `<span class="tr-think-badge badge-reverted">${esc(t('trace.reverted'))}</span>` : '';
    return `
      <button type="button" class="tr-row${sel}${it.reverted ? ' reverted' : ''}" data-tidx="${it.idx}">
        <div class="tr-left">
          <span class="tr-dot ${dotCls}"></span>
          <span class="tr-name" title="${esc(name)}">${esc(name)}</span>
          ${revBadge}
          ${extraBadge}
          <span class="tr-preview${(it.kind === 'tool' || it.kind === 'mcp') ? ' mono' : ''}">${esc(preview)}</span>
        </div>
        <div class="tr-right"><span>${esc(rightMeta)}</span></div>
      </button>
    `;
  }).join('');

  let liveGenHtml = '';
  if (isLiveGenerating() && state.traceEnabled.has('model') && !q) {
    let modelLabel = state.liveState?.model || '';
    if (!modelLabel || modelLabel.toLowerCase() === 'auto') {
      const lastModelItem = [...allItems].reverse().find((x) => x.kind === 'model' && x.model);
      modelLabel = lastModelItem?.model || state.sessionData?.model || t('trace.model');
    }
    const elapsedMs = Math.max(100, Date.now() - (state.liveState.sinceMs || Date.now()));
    const elapsedText = fmtTraceDur(elapsedMs);
    liveGenHtml = `
      <div class="tr-row generating">
        <div class="tr-left">
          <span class="tr-dot model"></span>
          <span class="tr-name">${esc(modelLabel)}</span>
          <span class="tr-think-badge badge-generating">${esc(t('live.generating'))}</span>
        </div>
        <div class="tr-right"><span id="trace-gen-elapsed">${esc(elapsedText)}</span></div>
      </div>
    `;
  }

  listEl.innerHTML = loadMoreHtml + rowsHtml + liveGenHtml;

  $('btn-trace-load-earlier')?.addEventListener('click', loadEarlierTrace);
  listEl.querySelectorAll('.tr-row[data-tidx]').forEach((btn) => {
    btn.addEventListener('click', () => toggleTraceDetail(Number(btn.dataset.tidx)));
  });
  updateGeneratingTicker();

  const stripScroll = $('trace-strip-scroll');
  if (!opts.skipScrollRestore) {
    if (shouldStick) {
      state.traceFirstScroll = false;
      requestAnimationFrame(() => scrollTraceToBottom(false));
    } else {
      listEl.scrollTop = prevScrollTop;
      if (stripScroll && !opts.skipStripRender) stripScroll.scrollLeft = prevStripScroll;
      updateTraceJumpBtn();
    }
  }

  if (state.traceSelectedIdx != null) {
    const cached = state.traceDetailCache.get(`${activeSessionId()}:${state.traceSelectedIdx}`);
    if (cached) renderTraceDetailPanel(cached);
  }
}
