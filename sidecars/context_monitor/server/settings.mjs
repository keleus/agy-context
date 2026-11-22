/**
 * Persistent user settings stored atomically in plugin_data/agy-context/settings.json.
 * Survives sidecar disable/enable, port reassignment, restarts, and plugin updates.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { findAppDataDirs } from './discovery.mjs';

export function resolveSettingsPath() {
  if (process.env.PLUGIN_DATA) {
    return join(process.env.PLUGIN_DATA, 'settings.json');
  }
  const appDirs = findAppDataDirs();
  const baseAppData = appDirs[0] || join(homedir(), '.gemini', 'antigravity');
  return join(baseAppData, 'plugin_data', 'agy-context', 'settings.json');
}

export function handleGetSettings() {
  const filePath = resolveSettingsPath();
  if (!existsSync(filePath)) {
    return { found: false, path: filePath, settings: null };
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (raw && typeof raw === 'object') {
      return { found: true, path: filePath, settings: raw };
    }
  } catch { /* ignore corrupted file */ }
  return { found: false, path: filePath, settings: null };
}

export function handleSaveSettings(data) {
  const filePath = resolveSettingsPath();
  let obj = data;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { obj = null; }
  }
  const payload = obj && typeof obj === 'object' && obj.settings && typeof obj.settings === 'object'
    ? obj.settings
    : (obj && typeof obj === 'object' ? obj : null);
  if (!payload) {
    return { ok: false, error: 'invalid_settings' };
  }
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    renameSync(tmpPath, filePath);
    return { ok: true, path: filePath, settings: payload };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
