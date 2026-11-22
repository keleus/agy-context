/**
 * Full-pane Settings view and drag-and-drop Context Modules & Order editor.
 */

import { $, apiGet, esc } from '../format.js';
import { applyStaticI18n, t } from '../i18n.js';
import { applyContextLayout } from '../layout.js';
import { IS_TRACE_PANE, actions, saveSettings, settings, state } from '../state.js';
import { renderUpdatePill, startPluginUpdate } from './updater.js';

function getActiveLayoutConfig() {
  return state.layoutEditorScope === 'overview' ? settings.overviewLayout : settings.sessionLayout;
}

export function renderLayoutEditor() {
  const listEl = $('settings-layout-list');
  if (!listEl) return;
  const isOv = state.layoutEditorScope === 'overview';
  const cfg = getActiveLayoutConfig();
  const hiddenSet = new Set(cfg.hidden || []);
  const prefix = isOv ? 'layout.ov.' : 'layout.s.';

  document.querySelectorAll('.layout-tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.layoutScope === state.layoutEditorScope);
  });

  listEl.innerHTML = cfg.order.map((id, idx) => {
    const visible = !hiddenSet.has(id);
    return `
      <div class="layout-item${visible ? '' : ' is-hidden'}" data-layout-id="${esc(id)}" draggable="true">
        <div class="layout-item-left">
          <span class="layout-drag-handle" aria-hidden="true">⋮⋮</span>
          <span class="layout-item-name">${esc(t(`${prefix}${id}`))}</span>
        </div>
        <div class="layout-item-controls">
          <button type="button" class="layout-move-btn" data-move="up" ${idx === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button type="button" class="layout-move-btn" data-move="down" ${idx === cfg.order.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
          <label class="layout-switch">
            <input type="checkbox" data-layout-toggle="${esc(id)}" ${visible ? 'checked' : ''}>
            <span class="layout-switch-track"></span>
          </label>
        </div>
      </div>
    `;
  }).join('');

  const commitLayout = () => {
    saveSettings(settings);
    applyContextLayout(true);
    renderLayoutEditor();
  };

  const moveItem = (fromIdx, toIdx) => {
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx || toIdx >= cfg.order.length) return;
    const [item] = cfg.order.splice(fromIdx, 1);
    cfg.order.splice(toIdx, 0, item);
    commitLayout();
  };

  listEl.querySelectorAll('.layout-move-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.layout-item');
      const idx = cfg.order.indexOf(row?.dataset.layoutId);
      moveItem(idx, btn.dataset.move === 'up' ? idx - 1 : idx + 1);
    });
  });

  listEl.querySelectorAll('[data-layout-toggle]').forEach((inp) => {
    inp.addEventListener('change', () => {
      const id = inp.dataset.layoutToggle;
      const set = new Set(cfg.hidden || []);
      if (inp.checked) set.delete(id);
      else set.add(id);
      cfg.hidden = [...set];
      commitLayout();
    });
  });

  let dragId = '';
  listEl.querySelectorAll('.layout-item').forEach((row) => {
    row.addEventListener('dragstart', (e) => {
      dragId = row.dataset.layoutId || '';
      row.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragId);
      }
    });
    row.addEventListener('dragend', () => {
      dragId = '';
      listEl.querySelectorAll('.layout-item').forEach((r) => r.classList.remove('dragging', 'drag-over'));
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragId || row.dataset.layoutId === dragId) return;
      listEl.querySelectorAll('.layout-item.drag-over').forEach((r) => r.classList.remove('drag-over'));
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => {
      row.classList.remove('drag-over');
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const srcId = dragId || e.dataTransfer?.getData('text/plain') || '';
      const dstId = row.dataset.layoutId || '';
      row.classList.remove('drag-over');
      if (!srcId || !dstId || srcId === dstId) return;
      moveItem(cfg.order.indexOf(srcId), cfg.order.indexOf(dstId));
    });
  });
}

export async function populateSettingsView() {
  $('set-lang').value = settings.lang;
  $('set-poll').value = String(settings.pollMs);
  $('set-default-tab').value = settings.defaultTab;
  renderLayoutEditor();
  try {
    const ver = await apiGet('/api/version');
    $('set-version-label').textContent = `agy-context v${ver.currentVersion}`;
  } catch { /* ignore */ }
}

export function closeSettings() {
  if (state.tab !== 'settings') return;
  actions.selectTab(state.tabBeforeSettings || (IS_TRACE_PANE ? 'trace' : 'session'));
}

export function openSettings() {
  if (state.tab === 'settings') {
    closeSettings();
    return;
  }
  $('set-update-status').classList.add('hidden');
  actions.selectTab('settings');
}

export async function checkUpdates() {
  const statusEl = $('set-update-status');
  statusEl.classList.remove('hidden');
  statusEl.textContent = t('update.checking');
  try {
    const res = await apiGet('/api/version?check=1&force=1');
    $('set-version-label').textContent = `agy-context v${res.currentVersion}`;
    if (res.error === 'no_repository') {
      statusEl.textContent = t('update.noRepo');
    } else if (res.error) {
      statusEl.textContent = t('update.error');
    } else if (res.hasUpdate) {
      state.updateInfo = res;
      renderUpdatePill();
      statusEl.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <span>${esc(t('update.available', { latest: res.latestVersion }))}</span>
          <button type="button" class="primary-btn xs" data-run-update>${esc(t('update.now'))}</button>
        </div>
      `;
      statusEl.querySelector('[data-run-update]')?.addEventListener('click', startPluginUpdate);
    } else {
      state.updateInfo = res;
      renderUpdatePill();
      statusEl.textContent = t('update.upToDate', { ver: res.currentVersion });
    }
  } catch {
    statusEl.textContent = t('update.error');
  }
}

export function applySettings() {
  settings.lang = $('set-lang').value === 'zh' ? 'zh' : 'en';
  settings.pollMs = Math.max(1000, Number($('set-poll').value) || 1500);
  settings.defaultTab = $('set-default-tab').value;
  saveSettings(settings);
  applyStaticI18n();
  renderUpdatePill();
  actions.renderAllViews();
  renderLayoutEditor();
  actions.schedulePoll();
}
