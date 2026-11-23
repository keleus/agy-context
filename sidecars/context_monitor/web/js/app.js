/**
 * AGY Context Monitor frontend entrypoint.
 *
 * Coordinates tab navigation, live polling, DOM event wiring, disk settings
 * hydration, and initial pane bootstrap across modular ES view files.
 */

import {
  DEFAULT_OVERVIEW_ORDER,
  DEFAULT_SESSION_CTX_LIMIT,
  DEFAULT_SESSION_ORDER,
  SETTINGS_KEY,
} from './constants.js';
import { $, apiGet, hideTip, initThemeSync, resolveSessionContextLimit } from './format.js';
import { applyStaticI18n } from './i18n.js';
import { applyContextLayout } from './layout.js';
import {
  IS_TRACE_PANE,
  actions,
  activeSessionId,
  hostConvId,
  normalizeSettingsObj,
  normalizeTabParam,
  params,
  saveSettings,
  setLiveState,
  settings,
  state,
  updateGeneratingTicker,
} from './state.js';
import { updateTopbarSpeed } from './components/breakdowns.js';
import {
  buildSessionRows,
  collectExpandableSubIds,
  isBreakdownRowExpandable,
  renderBreakdownList,
} from './views/session-breakdown.js';
import { renderSession } from './views/session.js';
import {
  renderOverview,
  renderOverviewCommands,
  renderOverviewSkills,
  renderOverviewTools,
  renderSessionsList,
  resolveCurrentProject,
} from './views/overview.js';
import {
  isNearTraceBottom,
  loadEarlierTrace,
  renderTrace,
  scrollTraceToBottom,
  updateTraceJumpBtn,
} from './views/trace.js';
import { closeTraceDetail } from './views/trace-detail.js';
import {
  applySettings,
  checkUpdates,
  closeSettings,
  openSettings,
  populateSettingsView,
  renderLayoutEditor,
} from './views/settings.js';
import { checkUpdateOnOpen, renderUpdatePill, startPluginUpdate } from './views/updater.js';

initThemeSync();

function selectTab(tab) {
  hideTip();
  const prev = state.tab;
  const next = normalizeTabParam(tab) || (IS_TRACE_PANE ? 'trace' : 'session');
  if (next === 'settings' && prev !== 'settings') {
    state.tabBeforeSettings = prev;
  }
  state.tab = next;
  if (prev !== state.tab && (state.tab === 'project' || state.tab === 'global')) {
    state.overviewEtag = '';
    state.sessionWorkspace = '';
  }
  document.querySelectorAll('.seg-tab').forEach((btn) => {
    const active = btn.dataset.tab === state.tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  $('btn-settings')?.classList.toggle('active', state.tab === 'settings');
  $('btn-settings')?.setAttribute('aria-pressed', String(state.tab === 'settings'));
  if (IS_TRACE_PANE) {
    $('btn-trace-follow')?.classList.toggle('hidden', state.tab !== 'trace');
  }
  $('view-session').classList.toggle('active', state.tab === 'session');
  $('view-trace').classList.toggle('active', state.tab === 'trace');
  $('view-overview').classList.toggle('active', state.tab === 'project' || state.tab === 'global');
  $('view-settings').classList.toggle('active', state.tab === 'settings');
  updateTopbarSpeed(state.sessionData);
  updateGeneratingTicker();
  if (state.tab === 'settings') {
    populateSettingsView();
  } else {
    pollNow();
  }
}

function toggleDateFilter(dateKey) {
  if (!dateKey) return;
  state.selectedDate = state.selectedDate === dateKey ? '' : dateKey;
  state.overviewEtag = '';
  pollNow();
}

function setLanguage(lang) {
  settings.lang = lang === 'zh' ? 'zh' : 'en';
  saveSettings(settings);
  if ($('set-lang')) $('set-lang').value = settings.lang;
  applyStaticI18n();
  renderUpdatePill();
  renderAllViews();
  renderLayoutEditor();
}

function renderAllViews() {
  renderSession();
  renderTrace();
  renderOverview();
}

async function pollOnce() {
  if (state.inFlight || state.tab === 'settings') return;
  state.inFlight = true;
  try {
    const currentHost = hostConvId();
    if (currentHost !== state.lastHostConvId) {
      state.lastHostConvId = currentHost;
      state.inspectedConvId = null;
      state.sessionEtag = '';
      state.sessionData = null;
      state.traceEtag = '';
      state.traceData = null;
      state.traceSelectedIdx = null;
      state.traceFirstScroll = true;
      state.traceStick = true;
      state.traceLimit = 250;
      state.traceStripLimit = 40;
      state.traceDetailCache.clear();
    }

    if (state.tab === 'session') {
      const targetId = activeSessionId();
      if (targetId) {
        const qs = new URLSearchParams({ conversationId: targetId });
        if (state.sessionEtag) qs.set('etag', state.sessionEtag);
        const res = await apiGet(`/api/session?${qs}`);
        if (!res.unchanged) {
          state.sessionEtag = res.etag || '';
          state.sessionData = res.found ? res.session : null;
          if (state.sessionData && !state.inspectedConvId) {
            state.currentProject = {
              workspace: state.sessionData.workspace || state.currentProject.workspace,
              workspaceUri: state.sessionData.workspaceUri || state.currentProject.workspaceUri,
            };
          }
          setLiveState(state.inspectedConvId ? null : (state.sessionData?.hookTelemetry?.liveState || null));
          renderSession();
        }
      } else {
        state.sessionEtag = '';
        state.sessionData = null;
        setLiveState(null);
        renderSession();
      }
    } else if (state.tab === 'trace') {
      const targetId = activeSessionId();
      if (targetId) {
        const qs = new URLSearchParams({ conversationId: targetId });
        if (state.traceEtag) qs.set('etag', state.traceEtag);
        const res = await apiGet(`/api/trace?${qs}`);
        if (!res.unchanged) {
          state.traceEtag = res.etag || '';
          state.traceData = res.found ? res : null;
          setLiveState(state.inspectedConvId ? null : (res.liveState || null));
          renderTrace();
        }
      } else {
        state.traceEtag = '';
        state.traceData = null;
        state.traceSelectedIdx = null;
        state.traceDetailCache.clear();
        setLiveState(null);
        renderTrace();
      }
    } else {
      const qs = new URLSearchParams({ range: state.range });
      if (state.selectedDate) {
        qs.set('date', state.selectedDate);
      } else if (state.range === 'custom' || state.customStart || state.customEnd) {
        qs.set('range', 'custom');
        if (state.customStart) qs.set('start', state.customStart);
        if (state.customEnd) qs.set('end', state.customEnd);
      }
      if (state.tab === 'project') {
        const proj = await resolveCurrentProject();
        if (proj.workspace) qs.set('workspace', proj.workspace);
        if (proj.workspaceUri) qs.set('workspaceUri', proj.workspaceUri);
      }
      if (state.overviewEtag) qs.set('etag', state.overviewEtag);
      const res = await apiGet(`/api/overview?${qs}`);
      if (!res.unchanged) {
        state.overviewEtag = res.etag || '';
        state.overviewData = res;
        renderOverview();
      }
    }
  } catch {
    // Transient polling error; next interval will retry
  } finally {
    state.inFlight = false;
  }
}

function schedulePoll() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(pollOnce, settings.pollMs || 1500);
}

function pollNow() {
  pollOnce();
  schedulePoll();
}

// Register coordinator actions for decoupled view modules
actions.selectTab = selectTab;
actions.pollNow = pollNow;
actions.schedulePoll = schedulePoll;
actions.toggleDateFilter = toggleDateFilter;
actions.renderAllViews = renderAllViews;
actions.closeSettings = closeSettings;

// ---------- Event Wiring ----------
document.querySelectorAll('.seg-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.userSwitchedTab = true;
    selectTab(btn.dataset.tab);
  });
});

$('btn-lang').addEventListener('click', () => {
  setLanguage(settings.lang === 'en' ? 'zh' : 'en');
});

$('btn-update-pill').addEventListener('click', startPluginUpdate);
$('btn-settings').addEventListener('click', openSettings);
$('btn-settings-back').addEventListener('click', closeSettings);
$('btn-check-update').addEventListener('click', checkUpdates);
['set-lang', 'set-poll', 'set-default-tab'].forEach((id) => {
  $(id)?.addEventListener('change', applySettings);
});

document.querySelectorAll('.layout-tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.layoutEditorScope = btn.dataset.layoutScope === 'overview' ? 'overview' : 'session';
    renderLayoutEditor();
  });
});

$('btn-reset-layout')?.addEventListener('click', () => {
  if (state.layoutEditorScope === 'overview') {
    settings.overviewLayout = { order: [...DEFAULT_OVERVIEW_ORDER], hidden: [] };
  } else {
    settings.sessionLayout = { order: [...DEFAULT_SESSION_ORDER], hidden: [] };
  }
  saveSettings(settings);
  applyContextLayout(true);
  renderLayoutEditor();
});

$('btn-goto-overview').addEventListener('click', () => selectTab('global'));
$('btn-back-current').addEventListener('click', () => {
  state.inspectedConvId = null;
  state.sessionEtag = '';
  state.sessionData = null;
  state.traceEtag = '';
  state.traceData = null;
  state.traceSelectedIdx = null;
  state.traceDetailCache.clear();
  pollNow();
});

// Trace controls
$('trace-search').addEventListener('input', (e) => {
  state.traceQuery = e.target.value;
  renderTrace();
});

$('btn-close-detail').addEventListener('click', closeTraceDetail);

$('btn-trace-follow').addEventListener('click', () => {
  state.traceFollow = !state.traceFollow;
  const btn = $('btn-trace-follow');
  btn.classList.toggle('active', state.traceFollow);
  btn.setAttribute('aria-pressed', String(state.traceFollow));
  if (state.traceFollow) scrollTraceToBottom(true);
});

$('btn-trace-latest').addEventListener('click', () => {
  state.traceFollow = true;
  $('btn-trace-follow').classList.add('active');
  $('btn-trace-follow').setAttribute('aria-pressed', 'true');
  scrollTraceToBottom(true);
});

$('trace-list').addEventListener('scroll', () => {
  const el = $('trace-list');
  state.traceStick = isNearTraceBottom();
  updateTraceJumpBtn();
  if (!state.traceFirstScroll && state.traceHiddenEarlier > 0 && el.scrollTop <= 48) {
    loadEarlierTrace();
  }
}, { passive: true });

$('btn-open-inspected').addEventListener('click', () => {
  if (state.inspectedConvId) window.sidecar?.ui?.toggleConversation?.(state.inspectedConvId);
});

$('btn-toggle-all').addEventListener('click', () => {
  if (!state.sessionData) return;
  const base = buildSessionRows(state.sessionData, DEFAULT_SESSION_CTX_LIMIT);
  const limit = resolveSessionContextLimit(state.sessionData, base.usedSum).limit;
  const freeTokens = Math.max(0, limit - base.usedSum);
  const rows = base.rows;
  const ids = rows.filter(isBreakdownRowExpandable).map((r) => r.id);
  const subIds = collectExpandableSubIds(rows);
  const allOpen = ids.every((id) => state.expandedKeys.has(id))
    && subIds.every((id) => state.expandedItems.has(id));
  if (allOpen) {
    state.expandedKeys.clear();
    state.expandedItems.clear();
  } else {
    ids.forEach((id) => state.expandedKeys.add(id));
    subIds.forEach((id) => state.expandedItems.add(id));
  }
  renderBreakdownList(rows, freeTokens, limit);
});

// Overview controls
document.querySelectorAll('.range-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.range = btn.dataset.range;
    state.selectedDate = '';
    state.customStart = '';
    state.customEnd = '';
    state.overviewEtag = '';
    document.querySelectorAll('.range-pill').forEach((b) => b.classList.toggle('active', b === btn));
    pollNow();
  });
});

const onCustomDateChange = () => {
  let sVal = $('ov-date-start')?.value || '';
  let eVal = $('ov-date-end')?.value || '';
  if (!sVal && !eVal) return;
  if (sVal && eVal && sVal > eVal) {
    const tmp = sVal;
    sVal = eVal;
    eVal = tmp;
    if ($('ov-date-start')) $('ov-date-start').value = sVal;
    if ($('ov-date-end')) $('ov-date-end').value = eVal;
  }
  state.range = 'custom';
  state.selectedDate = '';
  state.customStart = sVal;
  state.customEnd = eVal;
  state.overviewEtag = '';
  document.querySelectorAll('.range-pill').forEach((b) => b.classList.remove('active'));
  pollNow();
};
$('ov-date-start')?.addEventListener('change', onCustomDateChange);
$('ov-date-end')?.addEventListener('change', onCustomDateChange);

document.querySelectorAll('[data-skill-sort]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.skillSort = btn.dataset.skillSort;
    document.querySelectorAll('[data-skill-sort]').forEach((b) => b.classList.toggle('active', b === btn));
    if (state.overviewData) renderOverviewSkills(state.overviewData.skills || []);
  });
});

document.querySelectorAll('[data-tool-sort]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.toolSort = btn.dataset.toolSort;
    document.querySelectorAll('[data-tool-sort]').forEach((b) => b.classList.toggle('active', b === btn));
    if (state.overviewData) renderOverviewTools(state.overviewData.tools || []);
  });
});

document.querySelectorAll('[data-cmd-sort]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.cmdSort = btn.dataset.cmdSort;
    document.querySelectorAll('[data-cmd-sort]').forEach((b) => b.classList.toggle('active', b === btn));
    if (state.overviewData) renderOverviewCommands(state.overviewData.commands || []);
  });
});

$('ov-skill-search').addEventListener('input', (e) => {
  state.skillQuery = e.target.value;
  if (state.overviewData) renderOverviewSkills(state.overviewData.skills || []);
});

$('ov-session-search').addEventListener('input', (e) => {
  state.sessionQuery = e.target.value;
  if (state.overviewData) renderSessionsList(state.overviewData.sessions || [], state.overviewData.workspaces || {});
});

document.querySelectorAll('.sort-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.sessionSort = btn.dataset.sort;
    document.querySelectorAll('.sort-pill').forEach((b) => b.classList.toggle('active', b === btn));
    if (state.overviewData) renderSessionsList(state.overviewData.sessions || [], state.overviewData.workspaces || {});
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.tab === 'settings') closeSettings();
});

async function hydrateSettingsFromDisk() {
  try {
    const res = await apiGet('/api/settings');
    if (res?.found && res.settings) {
      const merged = normalizeSettingsObj(res.settings);
      Object.assign(settings, merged);
      saveSettings(settings, { syncDisk: false });
      if ($('set-lang')) $('set-lang').value = settings.lang;
      if ($('set-poll')) $('set-poll').value = String(settings.pollMs);
      if ($('set-default-tab')) $('set-default-tab').value = settings.defaultTab;
      applyStaticI18n();
      applyContextLayout(true);
      renderUpdatePill();
      renderLayoutEditor();
      if (!state.userSwitchedTab && !IS_TRACE_PANE && !params.get('tab') && !params.get('view') && state.tab !== 'settings') {
        const desired = normalizeTabParam(settings.defaultTab) || 'session';
        if (desired !== state.tab) selectTab(desired);
      }
      renderAllViews();
      schedulePoll();
    } else {
      let hasLocal = false;
      try { hasLocal = !!localStorage.getItem(SETTINGS_KEY); } catch { /* ignore */ }
      if (hasLocal) saveSettings(settings, { syncDisk: true });
    }
  } catch {
    // Older sidecar before restart — keep localStorage settings gracefully
  }
}

// Boot: configure standalone Trace pane vs Context pane
if (IS_TRACE_PANE) {
  document.title = 'Trace';
  $('ctx-tabs').classList.add('hidden');
  $('trace-pane-head').classList.remove('hidden');
  $('btn-trace-follow').classList.remove('hidden');
}
applyStaticI18n();
applyContextLayout(true);
selectTab(state.tab);
hydrateSettingsFromDisk();
checkUpdateOnOpen();
