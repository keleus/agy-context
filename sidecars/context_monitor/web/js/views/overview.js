/**
 * Project & Global Overview dashboard: adaptive usage bar chart, activity heatmap,
 * ranked Skills/Tools/Commands lists, searchable session cards, and workspace resolver.
 */

import { ALL_OVERVIEW_CATS, BAR_PALETTE } from '../constants.js';
import {
  $,
  apiGet,
  bindSegBarTips,
  esc,
  fmtDur,
  fmtPct,
  fmtTokens,
  hideTip,
  moveTip,
  resolveSessionContextLimit,
  showTip,
  tipHeadHtml,
} from '../format.js';
import { fmtRelative, t } from '../i18n.js';
import { actions, hostConvId, settings, state } from '../state.js';
import {
  renderModelsCard,
  renderTimingBreakdown,
  renderTokenBreakdown,
  renderToolExecCard,
} from '../components/breakdowns.js';

export async function resolveCurrentProject() {
  try {
    if (typeof window.sidecar?.getWorkspaceUris === 'function') {
      const uris = await window.sidecar.getWorkspaceUris();
      if (Array.isArray(uris) && uris[0]) {
        const clean = String(uris[0]).replace(/\/+$/, '');
        const name = clean.replace(/^file:\/\//, '').split('/').filter(Boolean).pop() || clean;
        state.currentProject = { workspace: name, workspaceUri: clean };
        return state.currentProject;
      }
    }
  } catch {
    // Fall back to current conversation's metadata
  }

  if (state.sessionData && !state.inspectedConvId && (state.sessionData.workspace || state.sessionData.workspaceUri)) {
    state.currentProject = {
      workspace: state.sessionData.workspace || '',
      workspaceUri: state.sessionData.workspaceUri || '',
    };
    return state.currentProject;
  }

  const hostId = hostConvId();
  if (hostId) {
    try {
      const res = await apiGet(`/api/session?conversationId=${encodeURIComponent(hostId)}`);
      if (res.found && res.session) {
        state.currentProject = {
          workspace: res.session.workspace || '',
          workspaceUri: res.session.workspaceUri || '',
        };
        return state.currentProject;
      }
    } catch {
      // ignore
    }
  }

  if (!state.currentProject.workspace && state.overviewData?.sessions?.[0]) {
    const s0 = state.overviewData.sessions[0];
    state.currentProject = { workspace: s0.workspace || '', workspaceUri: s0.workspaceUri || '' };
  }
  return state.currentProject;
}

function usageTitleFor(granularity, range, selectedDate) {
  if (selectedDate) return t('usage.dateHour', { date: selectedDate });
  if (range === 'today') return t('usage.hour');
  if (range === '7d') return t('usage.7d');
  if (range === '30d') return t('usage.30d');
  if (granularity === 'hour') {
    const sd = state.overviewData?.startDate || state.customStart;
    return sd ? t('usage.dateHour', { date: sd }) : t('usage.hour');
  }
  if (granularity === 'week') return t('usage.week');
  if (granularity === 'month') return t('usage.month');
  if (granularity === 'year') return t('usage.year');
  return t('usage.day');
}

function pickVisibleTickIndices(n, maxTicks = 7) {
  const set = new Set();
  if (n <= 0) return set;
  if (n <= maxTicks) {
    for (let i = 0; i < n; i++) set.add(i);
    return set;
  }
  set.add(0);
  set.add(n - 1);
  const step = (n - 1) / (maxTicks - 1);
  for (let k = 1; k < maxTicks - 1; k++) {
    set.add(Math.round(k * step));
  }
  return set;
}

function renderUsageChart(series, range, selectedDate) {
  const el = $('ov-daily-chart');
  const gran = series?.granularity || 'day';
  const pts = Array.isArray(series?.points) ? series.points : [];
  $('ov-usage-title').textContent = usageTitleFor(gran, range, selectedDate);

  if (!pts.length) {
    el.innerHTML = `<div class="empty-inline">${esc(t('items.empty'))}</div>`;
    return;
  }

  const W = 440;
  const H = 132;
  const padL = 40;
  const padR = 12;
  const padT = 14;
  const padB = 20;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxTok = Math.max(...pts.map((d) => d.tokens || 0), 1000);
  const n = pts.length;
  const stepW = plotW / n;
  const barW = Math.min(20, Math.max(3, stepW * 0.68));
  const yTicks = [0, 0.5, 1];
  const visibleTicks = pickVisibleTickIndices(n, 7);

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}">
      ${yTicks.map((f) => {
        const y = padT + plotH * (1 - f);
        return `
          <line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="1"/>
          <text x="${padL - 5}" y="${(y + 3).toFixed(1)}" text-anchor="end" fill="var(--fg-muted)" font-size="8.5">${f === 0 ? '0' : esc(fmtTokens(maxTok * f))}</text>
        `;
      }).join('')}
      ${pts.map((d, i) => {
        const cx = padL + stepW * i + stepW / 2;
        const x = cx - barW / 2;
        const tot = d.tokens || 0;
        const cached = Math.min(tot, d.cacheReadTokens || 0);
        const uncached = Math.max(0, tot - cached);
        const hTot = tot > 0 ? Math.max(2, (tot / maxTok) * plotH) : 0;
        const hCached = tot > 0 ? (cached / tot) * hTot : 0;
        const hUncached = Math.max(0, hTot - hCached);
        const yBase = padT + plotH;
        const yCached = yBase - hCached;
        const yTop = yBase - hTot;
        const showLbl = visibleTicks.has(i);
        const lblText = gran === 'hour' ? d.label.slice(0, 2) : d.label;
        return `
          <g class="day-bar-group" data-idx="${i}" style="cursor:${d.dateKey ? 'pointer' : 'default'}">
            <rect x="${(padL + stepW * i).toFixed(1)}" y="${padT}" width="${stepW.toFixed(1)}" height="${plotH}" fill="transparent"/>
            ${hCached > 0 ? `<rect x="${x.toFixed(1)}" y="${yCached.toFixed(1)}" width="${barW.toFixed(2)}" height="${hCached.toFixed(1)}" rx="1.2" fill="var(--blue)"/>` : ''}
            ${hUncached > 0 ? `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(2)}" height="${Math.max(1.2, hUncached).toFixed(1)}" rx="1.2" fill="var(--cyan)"/>` : ''}
            ${showLbl ? `<text x="${cx.toFixed(1)}" y="${H - 5}" text-anchor="middle" fill="var(--fg-muted)" font-size="8.5">${esc(lblText)}</text>` : ''}
          </g>
        `;
      }).join('')}
    </svg>
  `;

  el.querySelectorAll('.day-bar-group').forEach((g) => {
    const d = pts[Number(g.dataset.idx)];
    g.addEventListener('mouseenter', (e) => {
      showTip(e, `
        <div><strong>${esc(d.fullLabel || d.label)}</strong></div>
        <div>${esc(t('ov.tokens'))}: <strong>${fmtTokens(d.tokens)}</strong></div>
        <div style="opacity:.85">${esc(t('tip.newIn'))} ${fmtTokens(d.inputTokens)} · ${esc(t('tip.cacheRead'))} ${fmtTokens(d.cacheReadTokens)} · ${esc(t('tip.out'))} ${fmtTokens(d.outputTokens)}</div>
        ${d.dateKey ? `<div style="opacity:.7">${esc(t('usage.clickDay'))}</div>` : ''}
      `);
    });
    g.addEventListener('mousemove', moveTip);
    g.addEventListener('mouseleave', hideTip);
    if (d.dateKey) {
      g.addEventListener('click', () => actions.toggleDateFilter(d.dateKey));
    }
  });
}

export function renderHeatmap(heatmap, { range = '30d', startDate = '', endDate = '', heatmapSpan = null } = {}) {
  const el = $('ov-heatmap');
  if (!el) return;
  const cell = 12;
  const gap = 3;
  const padL = 28;
  const padT = 14;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayDow = (today.getDay() + 6) % 7;

  let weeks = 12;
  if (range === 'all' && heatmapSpan?.minDate) {
    const [y, m, d] = heatmapSpan.minDate.split('-').map(Number);
    const minDt = new Date(y, (m || 1) - 1, d || 1);
    const diffDays = Math.max(0, Math.round((today.getTime() - minDt.getTime()) / 86_400_000));
    weeks = Math.min(52, Math.max(12, Math.ceil((diffDays + todayDow + 1) / 7)));
  }
  const hmMeta = $('ov-heatmap-meta');
  if (hmMeta) hmMeta.textContent = t('hm.weeks', { n: weeks });

  const start = new Date(today);
  start.setDate(today.getDate() - (weeks - 1) * 7 - todayDow);

  const cells = [];
  let maxVal = 0;
  const monthLabels = new Map();
  const monthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const highlightRange = range !== 'all' && !state.selectedDate && startDate && endDate;

  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const dt = new Date(start);
      dt.setDate(start.getDate() + w * 7 + d);
      if (dt > today) continue;
      const dk = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      const entry = heatmap[dk] || { sessions: 0, tokens: 0 };
      const val = state.hmMode === 'sessions' ? entry.sessions : entry.tokens;
      if (val > maxVal) maxVal = val;
      if (dt.getDate() <= 7 && !monthLabels.has(w)) {
        const mLabel = settings.lang === 'zh' ? `${dt.getMonth() + 1}月` : monthsEn[dt.getMonth()];
        if (monthLabels.get(w - 1) !== mLabel) monthLabels.set(w, mLabel);
      }
      const outOfRange = highlightRange ? (dk < startDate || dk > endDate) : false;
      cells.push({ w, d, dk, val, entry, outOfRange });
    }
  }

  const levelOf = (v) => {
    if (!v || maxVal <= 0) return 0;
    const r = v / maxVal;
    if (r <= 0.25) return 1;
    if (r <= 0.5) return 2;
    if (r <= 0.75) return 3;
    return 4;
  };

  const W = padL + weeks * (cell + gap) + 4;
  const H = padT + 7 * (cell + gap) + 4;
  const dayLabels = [[0, t('hm.mon')], [2, t('hm.wed')], [4, t('hm.fri')]];

  el.innerHTML = `
    <svg class="heatmap-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
      ${[...monthLabels.entries()].map(([w, lbl]) => `
        <text x="${padL + w * (cell + gap)}" y="10" fill="var(--fg-muted)" font-size="8.5">${esc(lbl)}</text>
      `).join('')}
      ${dayLabels.map(([d, lbl]) => `
        <text x="${padL - 4}" y="${padT + d * (cell + gap) + 9}" text-anchor="end" fill="var(--fg-muted)" font-size="8.5">${esc(lbl)}</text>
      `).join('')}
      ${cells.map((c, idx) => {
        const x = padL + c.w * (cell + gap);
        const y = padT + c.d * (cell + gap);
        const lv = levelOf(c.val);
        const sel = state.selectedDate === c.dk ? ' selected' : '';
        const dim = c.outOfRange ? ' out-of-range' : '';
        return `<rect class="hm-rect${sel}${dim}" data-idx="${idx}" x="${x}" y="${y}" width="${cell}" height="${cell}" fill="var(--hm-${lv})"/>`;
      }).join('')}
    </svg>
  `;

  el.scrollLeft = el.scrollWidth;

  el.querySelectorAll('.hm-rect').forEach((r) => {
    const c = cells[Number(r.dataset.idx)];
    r.addEventListener('mouseenter', (e) => {
      showTip(e, `
        <div><strong>${esc(c.dk)}</strong></div>
        <div>${esc(t('hm.tip', { s: c.entry.sessions, t: fmtTokens(c.entry.tokens) }))}</div>
        <div style="opacity:.7">${esc(t('hm.tipAction'))}</div>
      `);
    });
    r.addEventListener('mousemove', moveTip);
    r.addEventListener('mouseleave', hideTip);
    r.addEventListener('click', () => actions.toggleDateFilter(c.dk));
  });
}

function sortRankedItems(items, sortBy) {
  return [...items].sort((a, b) => {
    if (sortBy === 'time') return (b.durationMs || 0) - (a.durationMs || 0) || (b.count || 0) - (a.count || 0);
    if (sortBy === 'tokens') return (b.tokens || 0) - (a.tokens || 0) || (b.count || 0) - (a.count || 0);
    return (b.count || 0) - (a.count || 0) || (b.tokens || 0) - (a.tokens || 0);
  });
}

function renderBarList(el, rows, { empty = '', sortBy = 'count' } = {}) {
  if (!rows.length) {
    el.innerHTML = `<div class="empty-inline">${esc(empty)}</div>`;
    return;
  }
  const valOf = (r) => (sortBy === 'time' ? (r.durationMs || 0) : sortBy === 'tokens' ? (r.tokens || 0) : (r.count || 0));
  const maxVal = Math.max(...rows.map(valOf), 1);
  el.innerHTML = rows.map((r, i) => {
    const color = BAR_PALETTE[i % BAR_PALETTE.length];
    const v = valOf(r);
    const pct = v > 0 ? Math.max(4, (v / maxVal) * 100) : 2;
    let primary = `×${r.count || 0}`;
    let secondary = r.tokens ? fmtTokens(r.tokens) : '';
    if (sortBy === 'time') {
      primary = r.durationMs ? fmtDur(r.durationMs) : '0s';
      secondary = `×${r.count || 0}`;
    } else if (sortBy === 'tokens') {
      primary = fmtTokens(r.tokens || 0);
      secondary = `×${r.count || 0}`;
    }
    const kindBadge = r.kind === 'mcp'
      ? '<span class="bar-badge mcp">MCP</span>'
      : (r.kind === 'command' ? '<span class="bar-badge cmd">CMD</span>' : '');
    const tip = `${r.name}: ×${r.count || 0} · ${fmtDur(r.durationMs || 0)} · ${fmtTokens(r.tokens || 0)}`;
    return `
      <div class="bar-row" title="${esc(tip)}">
        <div class="bar-row-top">
          <div class="bar-label-wrap">
            <span class="bar-dot" style="background:${color}"></span>
            ${kindBadge}
            <span class="bar-label">${esc(r.name)}</span>
          </div>
          <div class="bar-right">
            <span class="bar-val">${esc(primary)}</span>
            ${secondary ? `<span class="bar-time">${esc(secondary)}</span>` : ''}
          </div>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></div></div>
      </div>
    `;
  }).join('');
}

export function renderOverviewSkills(skills) {
  const totalLoads = skills.reduce((a, x) => a + x.count, 0);
  $('ov-skills-sub').textContent = t('ov.skillsSub', { u: skills.length, c: totalLoads });
  const q = state.skillQuery.trim().toLowerCase();
  const filtered = skills.filter((s) => !q || s.name.toLowerCase().includes(q));
  const list = sortRankedItems(filtered, state.skillSort);
  renderBarList($('ov-skills-list'), list.slice(0, 7), {
    empty: q ? t('ov.noMatchSkills') : t('ov.noSkills'),
    sortBy: state.skillSort,
  });
}

export function renderOverviewTools(tools) {
  $('ov-tools-sub').textContent = t('ov.toolsSub', { u: tools.length, c: tools.reduce((a, x) => a + x.count, 0) });
  const list = sortRankedItems(tools, state.toolSort);
  renderBarList($('ov-tools-list'), list.slice(0, 7), { empty: t('ov.noTools'), sortBy: state.toolSort });
}

export function renderOverviewCommands(cmds) {
  $('ov-cmds-sub').textContent = t('ov.cmdsSub', { u: cmds.length, c: cmds.reduce((a, x) => a + x.count, 0) });
  const list = sortRankedItems(cmds, state.cmdSort);
  renderBarList($('ov-cmds-list'), list.slice(0, 7), { empty: t('ov.noCmds'), sortBy: state.cmdSort });
}

export function renderSessionsList(sessions, workspaces) {
  const isProject = state.tab === 'project';
  const wsEntries = Object.entries(workspaces).sort((a, b) => b[1] - a[1]);
  const chipsEl = $('ov-ws-chips');
  chipsEl.classList.toggle('hidden', isProject);
  if (isProject) {
    state.sessionWorkspace = '';
  } else {
    chipsEl.innerHTML = [
      `<button type="button" class="ws-chip${!state.sessionWorkspace ? ' active' : ''}" data-ws="">${esc(t('range.all'))} ${sessions.length}</button>`,
      ...wsEntries.map(([ws, count]) =>
        `<button type="button" class="ws-chip${state.sessionWorkspace === ws ? ' active' : ''}" data-ws="${esc(ws)}">${esc(ws)} ${count}</button>`),
    ].join('');

    chipsEl.querySelectorAll('.ws-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.sessionWorkspace = btn.dataset.ws || '';
        renderSessionsList(sessions, workspaces);
      });
    });
  }

  const q = state.sessionQuery.trim().toLowerCase();
  let list = sessions.filter((s) => {
    if (state.sessionWorkspace && s.workspace !== state.sessionWorkspace) return false;
    if (!q) return true;
    return (s.title || '').toLowerCase().includes(q)
      || (s.workspace || '').toLowerCase().includes(q)
      || (s.lastUserMessage || '').toLowerCase().includes(q);
  });

  list = [...list].sort((a, b) => {
    if (state.sessionSort === 'tokens') return (b.totals?.totalTokens || 0) - (a.totals?.totalTokens || 0);
    if (state.sessionSort === 'context') return (b.currentContext || 0) - (a.currentContext || 0);
    return (b.lastMs || 0) - (a.lastMs || 0);
  });

  $('ov-sessions-count').textContent = String(list.length);
  const grid = $('ov-sessions-grid');

  if (!list.length) {
    grid.innerHTML = `<div class="empty-inline">${esc(t('ov.noSessions'))}</div>`;
    bindSegBarTips(grid, null);
    return;
  }

  const currentHost = hostConvId();
  const canJump = !!window.sidecar?.ui?.toggleConversation;
  const cardSegMap = new Map();

  grid.innerHTML = list.map((s) => {
    const limit = resolveSessionContextLimit(s).limit;
    const used = s.currentContext || s.lastPromptTokens || 0;
    const ratio = Math.min(1, used / limit);
    const isCurrent = currentHost && s.conversationId === currentHost;

    const comp = s.composition || {};
    const segs = ALL_OVERVIEW_CATS
      .map((c) => ({ key: c.key, label: t(`cat.${c.key}`), color: c.color, value: comp[c.key] || 0 }))
      .filter((x) => x.value > 0)
      .sort((a, b) => b.value - a.value);
    const segSum = segs.reduce((a, x) => a + x.value, 0) || 1;
    const barSegs = segs.map((x) => {
      const share = x.value / segSum;
      const pct = share * 100;
      const segId = `${s.conversationId}::${x.key}`;
      cardSegMap.set(segId, { label: x.label, color: x.color, value: x.value, share });
      return `<div class="ctx-seg" data-seg-id="${esc(segId)}" style="width:${pct.toFixed(2)}%;background:${x.color}"></div>`;
    }).join('');

    const rawLast = String(s.lastUserMessage || '').trim();
    const shortLast = rawLast.length > 52 ? `${rawLast.slice(0, 52)}…` : (rawLast || '—');

    return `
      <article class="card session-card${isCurrent ? ' is-current' : ''}" data-conv="${esc(s.conversationId)}">
        <div class="sc-head">
          <div class="sc-title" title="${esc(s.title)}">${esc(s.title)}</div>
          <div class="sc-time">${esc(fmtRelative(s.lastMs))}</div>
        </div>
        <div class="sc-tags">
          <span class="badge-ws">${esc(s.workspace || 'default-workspace')}</span>
          <div style="display:flex;align-items:center;gap:4px">
            ${isCurrent ? `<span class="badge-cur">${esc(t('ov.current'))}</span>` : ''}
            ${canJump && !isCurrent ? `<button type="button" class="sc-open-btn" data-jump="${esc(s.conversationId)}">${esc(t('ov.open'))}</button>` : ''}
          </div>
        </div>
        <div class="sc-ctx-line">
          <span>${fmtTokens(used)} / ${fmtTokens(limit)}</span>
          <strong>${fmtPct(ratio, 1)}</strong>
        </div>
        <div class="ctx-bar thin" style="margin-bottom:2px">${barSegs}</div>
        <div class="sc-metrics-inline">
          <span><strong>${s.turns}</strong>t · <strong>${s.steps}</strong>s</span>
          <span>${esc(t('ov.tokens'))} <strong>${fmtTokens(s.totals?.totalTokens || 0)}</strong></span>
          <span>${esc(t('session.cached'))} <strong>${fmtPct(s.totals?.cacheHitRate || 0, 0)}</strong></span>
        </div>
        <div class="sc-foot" title="${esc(rawLast)}">${esc(t('ov.lastMsg'))}: ${esc(shortLast)}</div>
      </article>
    `;
  }).join('');

  bindSegBarTips(grid, (id) => {
    const seg = cardSegMap.get(id);
    if (!seg) return null;
    return `
      ${tipHeadHtml(seg.color, seg.label)}
      <div><strong>${fmtTokens(seg.value)}</strong> · ${fmtPct(seg.share, 1)}</div>
    `;
  });

  grid.querySelectorAll('.session-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      hideTip();
      const jumpBtn = e.target.closest('[data-jump]');
      if (jumpBtn) {
        e.stopPropagation();
        window.sidecar?.ui?.toggleConversation?.(jumpBtn.dataset.jump);
        return;
      }
      const convId = card.dataset.conv;
      if (!convId) return;
      state.inspectedConvId = convId === hostConvId() ? null : convId;
      state.sessionEtag = '';
      state.traceEtag = '';
      state.traceSelectedIdx = null;
      state.traceDetailCache.clear();
      actions.selectTab('session');
    });
  });
}

export function renderOverview() {
  const d = state.overviewData;
  if (!d) return;

  const isProject = state.tab === 'project';
  const projRow = $('ov-project-row');
  const projPill = $('ov-project-pill');
  const projName = d.workspace || state.currentProject.workspace || '';
  const showProj = isProject && !!projName;
  if (projRow) projRow.classList.toggle('hidden', !showProj);
  if (projPill) {
    projPill.classList.toggle('hidden', !showProj);
    if (showProj) {
      projPill.textContent = projName;
      projPill.title = projName;
    }
  }

  const startInput = $('ov-date-start');
  const endInput = $('ov-date-end');
  const picker = $('ov-date-picker');
  const startVal = state.selectedDate || d.startDate || '';
  const endVal = state.selectedDate || d.endDate || '';
  if (startInput && document.activeElement !== startInput) startInput.value = startVal;
  if (endInput && document.activeElement !== endInput) endInput.value = endVal;
  if (picker) picker.classList.toggle('custom-active', state.range === 'custom' || !!state.selectedDate);

  const kpi = d.kpi || {};
  $('ov-kpi-sessions').textContent = String(kpi.totalSessions || 0);
  $('ov-kpi-sessions-sub').textContent = t('ov.allTotal', { n: kpi.allSessionsCount || 0 });
  $('ov-kpi-tokens').textContent = fmtTokens(kpi.totalTokens || 0);
  $('ov-kpi-tokens-sub').textContent = t('ov.turns', { n: kpi.totalTurns || 0 });
  $('ov-kpi-output').textContent = fmtTokens(kpi.totalOutput || 0);
  $('ov-kpi-output-sub').textContent = t('ov.speed', { v: d.timing?.outputTokPerSec || 0 });
  $('ov-kpi-cache').textContent = fmtPct(kpi.cacheHitRate || 0, 1);
  $('ov-kpi-cache-sub').textContent = t('ov.cachedSessions', { n: kpi.cachedSessionsCount || 0 });
  $('ov-kpi-tools').textContent = String(kpi.totalToolCalls || 0);
  $('ov-kpi-tools-sub').textContent = t('ov.toolExec', { dur: fmtDur(kpi.toolExecMs || 0) });
  $('ov-kpi-duration').textContent = fmtDur(kpi.activeMs || 0);
  $('ov-kpi-duration-sub').textContent = t('ov.modelCalls', { n: kpi.totalModelCalls || 0 });

  renderUsageChart(d.usageSeries, d.range, state.selectedDate);
  renderTokenBreakdown($('ov-token-bar'), $('ov-token-legend'), $('ov-token-total-meta'), d.cumulativeComposition, kpi.totalTokens || 0);
  renderTimingBreakdown($('ov-timing-bar'), $('ov-timing-legend'), $('ov-output-speed'), d.timing);

  const ovModels = Array.isArray(d.modelsBreakdown) && d.modelsBreakdown.length
    ? d.modelsBreakdown
    : Object.entries(d.modelsUsed || {}).map(([m, mv]) => {
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
  renderModelsCard($('ov-models-list'), $('ov-models-bar'), $('ov-models-meta'), ovModels, { showSessions: true });

  renderOverviewSkills(d.skills || []);
  renderOverviewTools(d.tools || []);
  renderOverviewCommands(d.commands || []);

  renderToolExecCard($('ov-hooks-card'), $('ov-hooks-meta'), $('ov-hooks-bar'), $('ov-hooks-stats'), $('ov-hooks-reasons'), {
    toolsList: d.tools,
    totalExecMs: d.kpi?.toolExecMs || d.timing?.toolExecMs || 0,
    hookData: d.hookOverview,
  });

  renderSessionsList(d.sessions || [], d.workspaces || {});
}
