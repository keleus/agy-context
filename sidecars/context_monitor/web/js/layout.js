/**
 * Responsive 2-column / 1-column card layout and visibility engine for
 * Session and Overview (Project & Global) views.
 */

import { DEFAULT_OVERVIEW_ORDER, DEFAULT_SESSION_ORDER, SESSION_CARD_WEIGHTS } from './constants.js';
import { $ } from './format.js';
import { settings, state } from './state.js';

export function applySessionLayout(force = false) {
  const container = $('session-content');
  const colLeft = $('session-col-left');
  const colRight = $('session-col-right');
  if (!container || !colLeft || !colRight) return;

  const layout = settings.sessionLayout || { order: DEFAULT_SESSION_ORDER, hidden: [] };
  const hiddenSet = new Set(layout.hidden || []);
  const cardMap = {};
  container.querySelectorAll('[data-card-id]').forEach((el) => {
    cardMap[el.dataset.cardId] = el;
  });

  const leftIds = [];
  const rightIds = [];
  const parkedIds = [];
  let leftW = 0;
  let rightW = 0;

  layout.order.forEach((id, idx) => {
    const el = cardMap[id];
    if (!el) return;
    const userHidden = hiddenSet.has(id);
    el.classList.toggle('layout-hidden', userHidden);
    el.style.order = String(idx + 1);
    const dataHidden = el.classList.contains('hidden');
    if (userHidden || dataHidden) {
      parkedIds.push(id);
      return;
    }
    const w = SESSION_CARD_WEIGHTS[id] || 150;
    if (leftW <= rightW) {
      leftIds.push(id);
      leftW += w;
    } else {
      rightIds.push(id);
      rightW += w;
    }
  });

  const sig = `${leftIds.join(',')}|${rightIds.join(',')}|${parkedIds.join(',')}|${layout.order.join(',')}`;
  if (!force && sig === state.lastSessionLayoutSig) return;
  state.lastSessionLayoutSig = sig;

  leftIds.forEach((id) => {
    if (cardMap[id]) colLeft.appendChild(cardMap[id]);
  });
  rightIds.forEach((id) => {
    if (cardMap[id]) colRight.appendChild(cardMap[id]);
  });
  parkedIds.forEach((id) => {
    if (cardMap[id]) colRight.appendChild(cardMap[id]);
  });

  const leftEmpty = leftIds.length === 0;
  const rightEmpty = rightIds.length === 0;
  colLeft.classList.toggle('col-empty', leftEmpty);
  colRight.classList.toggle('col-empty', rightEmpty);
  container.classList.toggle('single-col', leftEmpty || rightEmpty);
}

export function applyOverviewLayout() {
  const wrap = $('ov-sections');
  if (!wrap) return;
  const layout = settings.overviewLayout || { order: DEFAULT_OVERVIEW_ORDER, hidden: [] };
  const hiddenSet = new Set(layout.hidden || []);
  const map = {};
  wrap.querySelectorAll('[data-ov-card]').forEach((el) => {
    map[el.dataset.ovCard] = el;
  });
  layout.order.forEach((id) => {
    const el = map[id];
    if (!el) return;
    el.classList.toggle('layout-hidden', hiddenSet.has(id));
    wrap.appendChild(el);
  });
}

export function applyContextLayout(force = false) {
  applySessionLayout(force);
  applyOverviewLayout();
}
