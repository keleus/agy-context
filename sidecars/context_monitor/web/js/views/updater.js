/**
 * Topbar update pill, background release check, and live self-update progress polling.
 */

import { $, apiGet, apiPost, fmtBytesShort, fmtSpeed } from '../format.js';
import { t } from '../i18n.js';
import { actions, state } from '../state.js';

export function renderUpdatePill() {
  const btn = $('btn-update-pill');
  const txt = $('btn-update-text');
  if (!btn || !txt) return;

  const job = state.updateJob;
  const info = state.updateInfo;
  const activeJob = job && job.status && job.status !== 'idle';

  if (!activeJob && !(info && info.hasUpdate)) {
    btn.classList.add('hidden');
    return;
  }

  btn.classList.remove('hidden', 'error');

  if (!activeJob) {
    btn.disabled = false;
    txt.textContent = t('update.btn');
    btn.title = `v${info.currentVersion} → v${info.latestVersion}`;
    return;
  }

  if (job.status === 'checking') {
    btn.disabled = true;
    txt.textContent = t('update.downloading');
    btn.title = '';
  } else if (job.status === 'downloading') {
    btn.disabled = true;
    const speed = job.speedBps > 0 ? ` · ${fmtSpeed(job.speedBps)}` : '';
    const progress = job.bytesTotal > 0
      ? `${job.pct}%`
      : (job.bytesLoaded > 0 ? fmtBytesShort(job.bytesLoaded) : '0%');
    txt.textContent = `${t('update.downloading')} ${progress}${speed}`;
    btn.title = job.version ? `v${job.version}` : '';
  } else if (job.status === 'installing') {
    btn.disabled = true;
    txt.textContent = t('update.installing');
  } else if (job.status === 'reloading') {
    btn.disabled = true;
    txt.textContent = t('update.reloading');
  } else if (job.status === 'error') {
    btn.disabled = false;
    btn.classList.add('error');
    txt.textContent = t('update.failed');
    btn.title = job.error || t('update.error');
  }
}

export function waitForSidecarReload() {
  if (state.updatePollTimer) {
    clearInterval(state.updatePollTimer);
    state.updatePollTimer = null;
  }
  const startedAt = Date.now();
  const attempt = async () => {
    try {
      const h = await apiGet('/api/health');
      if (h && h.ok && Date.now() - startedAt >= 1000) {
        location.reload();
        return;
      }
    } catch {
      // Sidecar is restarting; keep waiting.
    }
    if (Date.now() - startedAt < 25_000) {
      setTimeout(attempt, 450);
    } else {
      location.reload();
    }
  };
  setTimeout(attempt, 900);
}

export async function pollUpdateStatus() {
  try {
    const job = await apiGet('/api/update/status');
    state.updateJob = job;
    renderUpdatePill();
    if (job.status === 'reloading') {
      waitForSidecarReload();
    } else if (job.status === 'error' || job.status === 'idle') {
      if (state.updatePollTimer) {
        clearInterval(state.updatePollTimer);
        state.updatePollTimer = null;
      }
    }
  } catch {
    if (state.updateJob && (state.updateJob.status === 'installing' || state.updateJob.status === 'reloading')) {
      state.updateJob = { ...state.updateJob, status: 'reloading' };
      renderUpdatePill();
      waitForSidecarReload();
    }
  }
}

export async function startPluginUpdate() {
  actions.closeSettings();
  state.updateJob = { status: 'checking', pct: 0, bytesLoaded: 0, bytesTotal: 0, speedBps: 0 };
  renderUpdatePill();
  try {
    const job = await apiPost('/api/update/start');
    state.updateJob = job;
    renderUpdatePill();
    if (state.updatePollTimer) clearInterval(state.updatePollTimer);
    state.updatePollTimer = setInterval(pollUpdateStatus, 200);
  } catch (err) {
    state.updateJob = { status: 'error', error: String(err?.message || err) };
    renderUpdatePill();
  }
}

export async function checkUpdateOnOpen() {
  try {
    const res = await apiGet('/api/version?check=1');
    if (res && res.hasUpdate) {
      state.updateInfo = res;
      renderUpdatePill();
    }
  } catch {
    // Silent background check; never disrupt UI.
  }
}
