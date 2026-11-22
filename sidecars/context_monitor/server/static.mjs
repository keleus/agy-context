/**
 * Zero-build runtime bundler for modular frontend CSS and JS assets.
 *
 * Source files live cleanly split under `web/css/*.css` and `web/js/**\/*.js`
 * (using standard ES module imports/exports). At runtime, this module assembles
 * them into `/styles.css` and classic IIFE `/app.js` with mtime-based caching so
 * Antigravity's `sidecar_sdk` webview loads them with zero CORS/module-origin
 * issues and only 2 HTTP requests.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export const CSS_FILES = [
  'web/css/tokens.css',
  'web/css/layout.css',
  'web/css/session.css',
  'web/css/components.css',
  'web/css/trace.css',
  'web/css/overview.css',
  'web/css/settings.css',
];

const IMPORT_RE = /^import\s+\{[\s\S]*?\}\s+from\s+['"](\.[^'"]+)['"];?\s*$/gm;
const EXPORT_DECL_RE = /^export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm;

const cssCache = new Map();
const jsCache = new Map();

function fileSig(absPath) {
  try {
    const s = statSync(absPath);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return 'missing';
  }
}

export function buildCssBundle(baseDir) {
  const firstModular = join(baseDir, CSS_FILES[0]);
  if (!existsSync(firstModular)) {
    const legacy = join(baseDir, 'styles.css');
    return existsSync(legacy) ? readFileSync(legacy, 'utf-8') : '';
  }

  const absFiles = CSS_FILES.map((rel) => join(baseDir, rel));
  const sig = absFiles.map(fileSig).join('|');
  const hit = cssCache.get(baseDir);
  if (hit && hit.sig === sig) return hit.content;

  const content = absFiles
    .map((absPath) => readFileSync(absPath, 'utf-8'))
    .join('');
  cssCache.set(baseDir, { sig, content });
  return content;
}

function collectJsGraph(entryAbs) {
  const visited = new Set();
  const ordered = [];

  const visit = (absPath) => {
    const norm = resolve(absPath);
    if (visited.has(norm)) return;
    visited.add(norm);
    const raw = readFileSync(norm, 'utf-8');
    const deps = [];
    for (const m of raw.matchAll(IMPORT_RE)) {
      deps.push(resolve(dirname(norm), m[1]));
    }
    for (const dep of deps) {
      visit(dep);
    }
    ordered.push({ absPath: norm, raw });
  };

  visit(entryAbs);
  return ordered;
}

export function buildJsBundle(baseDir) {
  const entryAbs = resolve(baseDir, 'web/js/app.js');
  if (!existsSync(entryAbs)) {
    const legacy = join(baseDir, 'app.js');
    return existsSync(legacy) ? readFileSync(legacy, 'utf-8') : '';
  }

  const hit = jsCache.get(baseDir);
  if (hit) {
    const sig = hit.files.map(fileSig).join('|');
    if (sig === hit.sig) return hit.content;
  }

  const modules = collectJsGraph(entryAbs);
  const files = modules.map((m) => m.absPath);
  const sig = files.map(fileSig).join('|');

  const chunks = modules.map(({ absPath, raw }) => {
    const rel = relative(baseDir, absPath).replace(/\\/g, '/');
    const stripped = raw
      .replace(IMPORT_RE, '')
      .replace(EXPORT_DECL_RE, '')
      .trim();
    return `// --- ${rel} ---\n${stripped}`;
  });

  const content = `(() => {\n'use strict';\n\n${chunks.join('\n\n')}\n})();\n`;
  jsCache.set(baseDir, { sig, files, content });
  return content;
}
