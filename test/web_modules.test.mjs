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

test('computeTopbarSpeed averages last 5 valid calls and filters pure tool-call & micro-burst spikes', () => {
  const src = readFileSync(join(SIDECAR_DIR, 'web', 'js', 'components', 'breakdowns.js'), 'utf-8');
  const start = src.indexOf('const TOPBAR_SPEED_WINDOW');
  const end = src.indexOf('export function updateTopbarSpeed');
  assert.ok(start >= 0 && end > start, 'expected computeTopbarSpeed block in breakdowns.js');
  const snippet = `${src.slice(start, end).replace(/^export\s+/gm, '')}\ncomputeTopbarSpeed;`;
  const computeTopbarSpeed = vm.runInNewContext(snippet);

  const session = {
    model: 'gemini-4-neon-high',
    timing: { outputTokPerSec: 95 },
    timeline: [
      { model: 'gemini-4-neon-high', outputTokens: 100, streamMs: 2000, ttftMs: 1000, durationMs: 3000, preview: 'old slow call' },
      { model: 'gemini-4-neon-high', outputTokens: 200, streamMs: 2000, ttftMs: 1000, durationMs: 3000, preview: 'call 1' },
      { model: 'gemini-4-neon-high', outputTokens: 300, streamMs: 3000, ttftMs: 1000, durationMs: 4000, preview: 'call 2' },
      { model: 'gemini-4-neon-high', outputTokens: 250, streamMs: 2500, ttftMs: 1000, durationMs: 3500, preview: 'call 3' },
      { model: 'gemini-4-neon-high', outputTokens: 150, streamMs: 1500, ttftMs: 1000, durationMs: 2500, preview: 'call 4' },
      { model: 'gemini-4-neon-high', outputTokens: 100, streamMs: 1000, ttftMs: 1000, durationMs: 2000, preview: 'call 5' },
      // Pure tool-call without thinking (3000 tok/s spike) -> must be excluded
      { model: 'gemini-4-neon-high', outputTokens: 600, streamMs: 200, ttftMs: 2000, durationMs: 2200, toolCount: 1, preview: '', speedExcluded: true },
      // Micro-burst < 200ms (3000 tok/s spike) -> skipped when qualified samples exist
      { model: 'gemini-4-neon-high', outputTokens: 30, streamMs: 10, ttftMs: 2000, durationMs: 2010, preview: 'ok' },
    ],
  };

  const res = computeTopbarSpeed(session);
  // Uses calls 1..5 (1000 tokens / 10s = 100 tok/s), ignoring old slow call, pure tool-call spike, and 10ms micro-burst
  assert.equal(res.speed, 100);
  assert.equal(res.sampleCount, 5);
  assert.equal(res.model, 'gemini-4-neon-high');
});

test('all proportion bars use bindSegBarTips custom tooltips instead of native title on segments', async () => {
  const { bindSegBarTips, tipHeadHtml } = await import('../sidecars/context_monitor/web/js/format.js');

  for (const rel of ['web/js/components/breakdowns.js', 'web/js/views/session.js', 'web/js/views/overview.js']) {
    const src = readFileSync(join(SIDECAR_DIR, rel), 'utf-8');
    assert.ok(src.includes('bindSegBarTips('), `${rel} should bind custom hover tooltips`);
    assert.ok(!/<div class="ctx-seg"[^>]*\btitle=/.test(src), `${rel} should not rely on native title on .ctx-seg`);
  }

  // Minimal DOM harness for bindSegBarTips hover, legend sync, and re-render cleanup
  const listeners = new Map();
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      toggle: (c, force) => (force === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : (force ? set.add(c) : set.delete(c))),
      contains: (c) => set.has(c),
    };
  };
  const tooltipEl = {
    innerHTML: '',
    classList: makeClassList(['hidden']),
    style: {},
    getBoundingClientRect: () => ({ width: 120, height: 40 }),
  };
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = { getElementById: (id) => (id === 'tooltip' ? tooltipEl : null) };
  globalThis.window = { innerWidth: 800, innerHeight: 600 };

  try {
    const segA = { dataset: { segId: 'a' }, closest: (sel) => (sel === '.ctx-seg' ? segA : null) };
    const segB = { dataset: { segId: 'b' }, closest: (sel) => (sel === '.ctx-seg' ? segB : null) };
    const legA = { dataset: { segId: 'a' }, classList: makeClassList() };
    const legB = { dataset: { segId: 'b' }, classList: makeClassList() };
    const legendEl = {
      querySelectorAll: (sel) => {
        if (sel === '[data-seg-id]') return [legA, legB];
        if (sel === '.seg-hover-match') return [legA, legB].filter((n) => n.classList.contains('seg-hover-match'));
        return [];
      },
    };
    const barEl = {
      contains: (el) => el === segA || el === segB,
      addEventListener: (ev, fn) => listeners.set(ev, fn),
    };

    bindSegBarTips(barEl, (id) => (id === 'a' ? `${tipHeadHtml('var(--blue)', 'Alpha')}<div>10k · 60%</div>` : null), { legendEl });
    listeners.get('mouseover')({ target: segA, clientX: 100, clientY: 100 });
    assert.equal(tooltipEl.classList.contains('hidden'), false);
    assert.ok(tooltipEl.innerHTML.includes('Alpha'));
    assert.ok(tooltipEl.innerHTML.includes('var(--blue)'));
    assert.equal(legA.classList.contains('seg-hover-match'), true);
    assert.equal(legB.classList.contains('seg-hover-match'), false);

    // Re-render while hovered, then leave bar: tooltip must still hide cleanly
    bindSegBarTips(barEl, (id) => (id === 'b' ? `${tipHeadHtml('var(--rose)', 'Beta')}<div>20k · 40%</div>` : null), { legendEl });
    listeners.get('mouseleave')({});
    assert.equal(tooltipEl.classList.contains('hidden'), true);
    assert.equal(legA.classList.contains('seg-hover-match'), false);
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }
});
