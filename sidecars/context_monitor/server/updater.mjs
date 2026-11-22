/**
 * Plugin manifest reading, GitHub release version checking, and in-place self-updater.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..', '..', '..');
const VERSION_CACHE_MS = 10 * 60 * 1000;

const MANAGED_DIRS = ['sidecars', 'assets'];
const MANAGED_FILES = ['plugin.json', 'README.md', 'LICENSE', 'install.sh'];

let versionCache = { ts: 0, result: null };

let updateState = {
  status: 'idle', // idle | checking | downloading | installing | reloading | error
  pct: 0,
  bytesLoaded: 0,
  bytesTotal: 0,
  speedBps: 0,
  version: '',
  error: '',
};

export function readPluginManifest(rootDir = PLUGIN_ROOT) {
  try {
    const raw = readFileSync(join(rootDir, 'plugin.json'), 'utf-8');
    const json = JSON.parse(raw);
    const repo = typeof json.repository === 'string'
      ? json.repository
      : (typeof json.repository?.url === 'string' ? json.repository.url : '');
    return {
      name: String(json.name || 'agy-context'),
      version: String(json.version || '1.0.4'),
      repository: repo.replace(/^git\+/, '').replace(/\.git$/, '').trim(),
    };
  } catch {
    return { name: 'agy-context', version: '1.0.4', repository: '' };
  }
}

export function parseGithubSlug(repoUrl) {
  const m = String(repoUrl || '').match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  return m ? `${m[1]}/${m[2].replace(/\.git$/, '')}` : '';
}

export function isTrustedDownloadUrl(url) {
  const s = String(url || '').trim();
  return (
    /^https:\/\/codeload\.github\.com\/[^/\s]+\/[^/\s]+\/tar\.gz\/[^\s?#]+$/i.test(s)
    || /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/releases\/download\/[^/\s]+\/agy-context(?:-[^/\s]+)?\.tar\.gz$/i.test(s)
  );
}

export function selectReleaseDownloadUrl(rel, slug) {
  const tagName = String(rel?.tag_name || '').trim();
  const assets = Array.isArray(rel?.assets) ? rel.assets : [];
  const prefix = `https://github.com/${slug}/releases/download/`;

  const preferred = assets.find((a) => (
    a?.name === 'agy-context.tar.gz'
    && typeof a.browser_download_url === 'string'
    && a.browser_download_url.startsWith(prefix)
    && isTrustedDownloadUrl(a.browser_download_url)
  )) || assets.find((a) => (
    /^agy-context(?:-[^/\s]+)?\.tar\.gz$/i.test(String(a?.name || ''))
    && typeof a.browser_download_url === 'string'
    && a.browser_download_url.startsWith(prefix)
    && isTrustedDownloadUrl(a.browser_download_url)
  ));

  if (preferred) return preferred.browser_download_url;
  return tagName ? `https://codeload.github.com/${slug}/tar.gz/refs/tags/${encodeURIComponent(tagName)}` : '';
}

export function compareSemver(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function replaceDirectorySafely(srcDir, destDir) {
  const suffix = `${process.pid}.${Date.now()}`;
  const stagedDir = `${destDir}.upd-new.${suffix}`;
  const backupDir = `${destDir}.upd-old.${suffix}`;

  try { rmSync(stagedDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* ignore */ }

  cpSync(srcDir, stagedDir, { recursive: true, force: true });

  const hadDest = existsSync(destDir);
  if (hadDest) {
    renameSync(destDir, backupDir);
  }
  try {
    renameSync(stagedDir, destDir);
  } catch (err) {
    if (hadDest && existsSync(backupDir) && !existsSync(destDir)) {
      try { renameSync(backupDir, destDir); } catch { /* ignore */ }
    }
    try { rmSync(stagedDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }

  if (hadDest) {
    try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function replaceFileSafely(srcFile, destFile) {
  const tmpFile = `${destFile}.upd-tmp.${process.pid}.${Date.now()}`;
  cpSync(srcFile, tmpFile, { force: true });
  try {
    renameSync(tmpFile, destFile);
  } catch (err) {
    try { rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Installs an extracted plugin release directory into `targetRoot`.
 *
 * Uses staged swaps for directories so renamed/deleted modules (including
 * pre-refactor monolithic `app.js` / `styles.css` or legacy `skills/`) never
 * remain behind as stale files, while preserving `.git/`, `test/`, and data
 * stored outside the plugin directory.
 */
export function applyPluginUpdate(srcRoot, targetRoot = PLUGIN_ROOT) {
  if (!existsSync(join(srcRoot, 'plugin.json')) || !existsSync(join(srcRoot, 'sidecars', 'context_monitor', 'main.mjs'))) {
    throw new Error('Invalid plugin archive');
  }

  for (const dirName of MANAGED_DIRS) {
    const from = join(srcRoot, dirName);
    if (existsSync(from) && statSync(from).isDirectory()) {
      replaceDirectorySafely(from, join(targetRoot, dirName));
    }
  }

  for (const fileName of MANAGED_FILES) {
    const from = join(srcRoot, fileName);
    if (existsSync(from) && statSync(from).isFile()) {
      replaceFileSafely(from, join(targetRoot, fileName));
    }
  }

  // Restore executable permissions for scripts where supported
  for (const rel of ['install.sh']) {
    const p = join(targetRoot, rel);
    if (existsSync(p)) {
      try { chmodSync(p, 0o755); } catch { /* ignore */ }
    }
  }

  // Clean up deprecated paths from older plugin releases
  try { rmSync(join(targetRoot, 'skills'), { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(join(targetRoot, 'hooks'), { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(join(targetRoot, 'hooks.json'), { force: true }); } catch { /* ignore */ }
  if (existsSync(join(targetRoot, 'sidecars', 'context_monitor', 'web'))) {
    for (const legacy of ['app.js', 'styles.css']) {
      try { rmSync(join(targetRoot, 'sidecars', 'context_monitor', legacy), { force: true }); } catch { /* ignore */ }
    }
  }
}

export async function handleVersion(data) {
  const manifest = readPluginManifest();
  const slug = parseGithubSlug(manifest.repository);
  const base = {
    currentVersion: manifest.version,
    repository: manifest.repository,
    githubSlug: slug,
    checked: false,
    hasUpdate: false,
    latestVersion: '',
    releaseUrl: manifest.repository,
    downloadUrl: '',
    error: '',
  };
  if (data.check !== '1') return base;
  if (!slug) {
    return { ...base, checked: true, error: 'no_repository' };
  }
  if (data.force !== '1' && versionCache.result && Date.now() - versionCache.ts < VERSION_CACHE_MS) {
    const cached = versionCache.result;
    return {
      ...cached,
      currentVersion: manifest.version,
      hasUpdate: cached.latestVersion ? compareSemver(cached.latestVersion, manifest.version) > 0 : false,
    };
  }

  try {
    const relRes = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agy-context' },
      signal: AbortSignal.timeout(6000),
    });
    if (relRes.ok) {
      const rel = await relRes.json();
      const tagName = String(rel.tag_name || '').trim();
      const latest = tagName.replace(/^v/i, '');
      if (latest) {
        const out = {
          ...base,
          checked: true,
          latestVersion: latest,
          hasUpdate: compareSemver(latest, manifest.version) > 0,
          releaseUrl: rel.html_url || manifest.repository,
          downloadUrl: selectReleaseDownloadUrl(rel, slug),
        };
        versionCache = { ts: Date.now(), result: out };
        return out;
      }
    }
    const rawRes = await fetch(`https://raw.githubusercontent.com/${slug}/main/plugin.json`, {
      signal: AbortSignal.timeout(6000),
    });
    if (rawRes.ok) {
      const remoteManifest = await rawRes.json();
      const latest = String(remoteManifest.version || '').replace(/^v/i, '');
      if (latest) {
        const out = {
          ...base,
          checked: true,
          latestVersion: latest,
          hasUpdate: compareSemver(latest, manifest.version) > 0,
          releaseUrl: manifest.repository,
          downloadUrl: `https://codeload.github.com/${slug}/tar.gz/refs/heads/main`,
        };
        versionCache = { ts: Date.now(), result: out };
        return out;
      }
    }
    return { ...base, checked: true, error: 'fetch_failed' };
  } catch {
    return { ...base, checked: true, error: 'network_error' };
  }
}

export function getUpdateStatus() {
  return { ...updateState, currentVersion: readPluginManifest().version };
}

export function handleStartUpdate() {
  if (
    updateState.status === 'checking'
    || updateState.status === 'downloading'
    || updateState.status === 'installing'
    || updateState.status === 'reloading'
  ) {
    return getUpdateStatus();
  }
  updateState = {
    status: 'checking',
    pct: 0,
    bytesLoaded: 0,
    bytesTotal: 0,
    speedBps: 0,
    version: '',
    error: '',
  };
  runSelfUpdate().catch((err) => {
    updateState = {
      ...updateState,
      status: 'error',
      error: String(err?.message || err || 'Update failed'),
    };
  });
  return getUpdateStatus();
}

async function runSelfUpdate() {
  const ver = await handleVersion({ check: '1', force: '1' });
  if (ver.error || !ver.downloadUrl) {
    throw new Error(ver.error || 'No download source available');
  }
  if (!isTrustedDownloadUrl(ver.downloadUrl)) {
    throw new Error('Untrusted download URL');
  }

  updateState = {
    status: 'downloading',
    pct: 0,
    bytesLoaded: 0,
    bytesTotal: 0,
    speedBps: 0,
    version: ver.latestVersion || '',
    error: '',
  };

  const workDir = join(tmpdir(), `agy-context-upd-${Date.now()}`);
  const tarPath = join(workDir, 'release.tar.gz');
  const extractDir = join(workDir, 'extract');
  mkdirSync(extractDir, { recursive: true });

  try {
    const res = await fetch(ver.downloadUrl, {
      headers: { 'User-Agent': 'agy-context' },
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`);
    }

    const totalHeader = Number(res.headers.get('content-length')) || 0;
    updateState.bytesTotal = totalHeader;

    const reader = res.body.getReader();
    const ws = createWriteStream(tarPath);
    const startedAt = Date.now();
    let loaded = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
        loaded += value.byteLength;
        ws.write(Buffer.from(value));
        const elapsedSec = Math.max(0.05, (Date.now() - startedAt) / 1000);
        updateState.bytesLoaded = loaded;
        updateState.speedBps = Math.round(loaded / elapsedSec);
        if (totalHeader > 0) {
          updateState.pct = Math.min(99, Math.round((loaded / totalHeader) * 100));
        }
      }
    }
    await new Promise((resClose, rejClose) => {
      ws.end(() => resClose());
      ws.on('error', rejClose);
    });

    updateState.status = 'installing';
    updateState.pct = 100;

    execFileSync('tar', ['-xzf', tarPath, '-C', extractDir], { timeout: 15_000 });
    const entries = readdirSync(extractDir).filter((n) => !n.startsWith('.'));
    const srcRoot = entries.length === 1 ? join(extractDir, entries[0]) : extractDir;
    applyPluginUpdate(srcRoot, PLUGIN_ROOT);

    versionCache = { ts: 0, result: null };
    updateState.status = 'reloading';
    setTimeout(() => { process.exit(0); }, 700);
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
