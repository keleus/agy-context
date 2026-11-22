import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { CSS_FILES, buildCssBundle, buildJsBundle } from '../sidecars/context_monitor/server/static.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIDECAR_DIR = resolve(__dirname, '..', 'sidecars', 'context_monitor');

function listJsFiles(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) listJsFiles(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('buildCssBundle concatenates all modular CSS files in exact cascade order', () => {
  const css = buildCssBundle(SIDECAR_DIR);
  assert.ok(css.length > 50_000);
  for (const rel of CSS_FILES) {
    const part = readFileSync(join(SIDECAR_DIR, rel), 'utf-8');
    assert.ok(css.includes(part.slice(0, 80)), `CSS bundle missing ${rel}`);
  }
});

test('all modular frontend JS files pass ESM syntax check and bundle into valid classic IIFE', () => {
  const jsFiles = listJsFiles(join(SIDECAR_DIR, 'web', 'js'));
  assert.ok(jsFiles.length >= 15, `expected modular frontend JS files, got ${jsFiles.length}`);
  for (const f of jsFiles) {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  }

  const bundle = buildJsBundle(SIDECAR_DIR);
  assert.ok(bundle.startsWith('(() => {'), 'bundle should be wrapped in classic IIFE');
  assert.ok(!/^import\s+/m.test(bundle), 'bundle should contain no leftover top-level import statements');
  assert.ok(!/^export\s+/m.test(bundle), 'bundle should contain no leftover top-level export keywords');
  // Parse as classic browser script (non-module) via V8 vm.Script
  new vm.Script(bundle, { filename: 'app.js' });
});

test('index.html loads /styles.css and classic /app.js for sidecar_sdk compatibility', () => {
  const html = readFileSync(join(SIDECAR_DIR, 'index.html'), 'utf-8');
  assert.ok(html.includes('<link rel="stylesheet" href="/styles.css">'));
  assert.ok(html.includes('<script src="/app.js"></script>'));
  assert.ok(!html.includes('type="module"'));
});
