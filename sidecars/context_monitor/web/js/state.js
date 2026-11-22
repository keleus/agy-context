/**
 * Central client state, settings persistence, and live generating ticker helpers.
 */

import { DEFAULT_OVERVIEW_ORDER, DEFAULT_SESSION_ORDER, SETTINGS_KEY } from './constants.js';
import { $, apiPost, fmtTraceDur } from './format.js';

export const params = new URLSearchParams(location.search);

export const IS_TRACE_PANE = location.pathname.replace(/\/+$/, '').endsWith('/trace')
  || params.get('view') === 'trace'
  || params.get('tab') === 'trace';

export function normalizeLayoutConfig(raw, defaults) {
  const valid = new Set(defaults);
  const seen = new Set();
  const order = [];
  if (Array.isArray(raw?.order)) {
    for (const id of raw.order) {
      if (valid.has(id) && !seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
  }
  for (const id of defaults) {
    if (!seen.has(id)) order.push(id);
  }
  const hidden = Array.isArray(raw?.hidden)
    ? [...new Set(raw.hidden.filter((id) => valid.has(id)))]
    : [];
  return { order, hidden };
}

export function normalizeSettingsObj(parsed) {
  const base = {
    lang: 'en',
    pollMs: 1500,
    defaultTab: 'session',
    sessionLayout: { order: [...DEFAULT_SESSION_ORDER], hidden: [] },
    overviewLayout: { order: [...DEFAULT_OVERVIEW_ORDER], hidden: [] },
  };
  if (!parsed || typeof parsed !== 'object') return base;
  return {
    ...base,
    lang: parsed.lang === 'zh' ? 'zh' : 'en',
    pollMs: Math.max(1000, Number(parsed.pollMs) || 1500),
    defaultTab: ['session', 'project', 'global'].includes(parsed.defaultTab) ? parsed.defaultTab : 'session',
    sessionLayout: normalizeLayoutConfig(parsed.sessionLayout, DEFAULT_SESSION_ORDER),
    overviewLayout: normalizeLayoutConfig(parsed.overviewLayout, DEFAULT_OVERVIEW_ORDER),
  };
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return normalizeSettingsObj(null);
    return normalizeSettingsObj(JSON.parse(raw));
  } catch {
    return normalizeSettingsObj(null);
  }
}

export function saveSettings(s, { syncDisk = true } = {}) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
  if (syncDisk) {
    apiPost('/api/settings/save', { settings: s }).catch(() => {});
  }
}

export const settings = loadSettings();

export function normalizeTabParam(raw) {
  if (raw === 'settings') return 'settings';
  if (IS_TRACE_PANE) return 'trace';
  if (raw === 'project' || raw === 'global' || raw === 'session') return raw;
  if (raw === 'overview') return 'global';
  return null;
}

export const state = {
  tab: IS_TRACE_PANE ? 'trace' : (normalizeTabParam(params.get('tab')) || normalizeTabParam(settings.defaultTab) || 'session'),
  tabBeforeSettings: IS_TRACE_PANE ? 'trace' : 'session',
  userSwitchedTab: false,
  inspectedConvId: null,
  lastHostConvId: '',
  currentProject: { workspace: '', workspaceUri: '' },
  sessionEtag: '',
  sessionData: null,
  traceEtag: '',
  traceData: null,
  traceEnabled: new Set(['input', 'system', 'skill', 'mcp', 'model', 'tool', 'compaction', 'error']),
  traceQuery: '',
  traceSelectedIdx: null,
  traceDetailTab: 'overview',
  traceThinkingCollapsed: false,
  traceOverviewExpanded: false,
  traceDetailCache: new Map(),
  traceFollow: true,
  traceStick: true,
  traceFirstScroll: true,
  traceLimit: 250,
  traceHiddenEarlier: 0,
  traceLoadingEarlier: false,
  traceStripLimit: 40,
  traceStripHiddenEarlier: 0,
  traceStripLoadingEarlier: false,
  overviewEtag: '',
  overviewData: null,
  // Session interactive state (preserved across live polls)
  expandedKeys: new Set(),
  expandedItems: new Set(),
  expandedRecent: new Set(),
  trendMode: 'stacked',
  trendSpan: '24',
  // Overview state
  range: '30d',
  selectedDate: '',
  customStart: '',
  customEnd: '',
  layoutEditorScope: 'session',
  lastSessionLayoutSig: '',
  hmMode: 'tokens',
  skillSort: 'count',
  toolSort: 'count',
  cmdSort: 'count',
  skillQuery: '',
  sessionQuery: '',
  sessionWorkspace: '',
  sessionSort: 'recent',
  liveState: null,
  liveTickTimer: null,
  updateInfo: null,
  updateJob: null,
  updatePollTimer: null,
  pollTimer: null,
  inFlight: false,
};

/**
 * Late-bound coordinator actions registered by app.js to avoid circular imports
 * between views and the top-level controller.
 */
export const actions = {
  selectTab: () => {},
  pollNow: () => {},
  schedulePoll: () => {},
  toggleDateFilter: () => {},
  renderAllViews: () => {},
  closeSettings: () => {},
};

export function hostConvId() {
  return window.sidecar?.conversationId || params.get('conversationId') || '';
}

export function activeSessionId() {
  return state.inspectedConvId || hostConvId();
}

export function isLiveGenerating() {
  const ls = state.liveState;
  return Boolean(ls && ls.active && ls.phase === 'generating' && !state.inspectedConvId);
}

export function updateGeneratingTicker() {
  const el = $('trace-gen-elapsed');
  if (isLiveGenerating() && state.tab === 'trace') {
    if (el) {
      const elapsedMs = Math.max(100, Date.now() - (state.liveState.sinceMs || Date.now()));
      el.textContent = fmtTraceDur(elapsedMs);
    }
    if (!state.liveTickTimer) {
      state.liveTickTimer = setInterval(updateGeneratingTicker, 250);
    }
  } else if (state.liveTickTimer) {
    clearInterval(state.liveTickTimer);
    state.liveTickTimer = null;
  }
}

export function setLiveState(ls) {
  state.liveState = ls && ls.active ? ls : null;
  updateGeneratingTicker();
}
