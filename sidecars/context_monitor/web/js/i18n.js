/**
 * Translation helpers and static DOM i18n applicator.
 */

import { $ } from './format.js';
import { I18N } from './i18n-data.js';
import { settings } from './state.js';

export function hasI18nKey(key) {
  return Boolean(I18N[settings.lang]?.[key] || I18N.en[key]);
}

export function t(key, vars = null) {
  const dict = I18N[settings.lang] || I18N.en;
  let str = dict[key] ?? I18N.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replaceAll(`{${k}}`, String(v));
    }
  }
  return str;
}

export function fmtRelative(ms) {
  if (!ms) return '';
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return t('rel.now');
  const m = Math.floor(s / 60);
  if (m < 60) return t('rel.m', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('rel.h', { n: h });
  const d = Math.floor(h / 24);
  if (d < 30) return t('rel.d', { n: d });
  return t('rel.mo', { n: Math.floor(d / 30) });
}

export function applyStaticI18n() {
  document.documentElement.lang = settings.lang === 'zh' ? 'zh-CN' : 'en';
  const langBtn = $('btn-lang');
  if (langBtn) langBtn.textContent = settings.lang === 'zh' ? '简' : 'EN';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
}
