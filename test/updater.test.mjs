import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyPluginUpdate } from '../sidecars/context_monitor/server/updater.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

test('applyPluginUpdate migrates legacy monolithic install cleanly and removes stale files', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agy-ctx-upd-test-'));
  try {
    // Simulate an old v1.0.1 monolithic plugin directory
    mkdirSync(join(tmp, 'sidecars', 'context_monitor'), { recursive: true });
    mkdirSync(join(tmp, 'hooks'), { recursive: true });
    mkdirSync(join(tmp, 'skills', 'old-skill'), { recursive: true });
    mkdirSync(join(tmp, '.git'), { recursive: true });
    writeFileSync(join(tmp, 'plugin.json'), '{"name":"agy-context","version":"1.0.0"}');
    writeFileSync(join(tmp, 'hooks.json'), '{"agy-context-timing":{}}');
    writeFileSync(join(tmp, 'hooks', 'record_timing.py'), '# old hook');
    writeFileSync(join(tmp, 'sidecars', 'context_monitor', 'main.mjs'), '// old main');
    writeFileSync(join(tmp, 'sidecars', 'context_monitor', 'app.js'), '// legacy monolith');
    writeFileSync(join(tmp, 'sidecars', 'context_monitor', 'styles.css'), '/* legacy css */');
    writeFileSync(join(tmp, 'skills', 'old-skill', 'SKILL.md'), 'old');
    writeFileSync(join(tmp, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    applyPluginUpdate(REPO_ROOT, tmp);

    // Modular files installed cleanly
    assert.ok(existsSync(join(tmp, 'sidecars', 'context_monitor', 'main.mjs')));
    assert.ok(existsSync(join(tmp, 'sidecars', 'context_monitor', 'parser', 'transcript.mjs')));
    assert.ok(existsSync(join(tmp, 'sidecars', 'context_monitor', 'server', 'static.mjs')));
    assert.ok(existsSync(join(tmp, 'sidecars', 'context_monitor', 'web', 'js', 'app.js')));
    assert.ok(existsSync(join(tmp, 'sidecars', 'context_monitor', 'web', 'css', 'tokens.css')));

    // Legacy monolithic files & deprecated skills/hooks cleaned up
    assert.equal(existsSync(join(tmp, 'sidecars', 'context_monitor', 'app.js')), false);
    assert.equal(existsSync(join(tmp, 'sidecars', 'context_monitor', 'styles.css')), false);
    assert.equal(existsSync(join(tmp, 'skills')), false);
    assert.equal(existsSync(join(tmp, 'hooks')), false);
    assert.equal(existsSync(join(tmp, 'hooks.json')), false);

    // Unmanaged repo files (like .git) untouched
    assert.equal(readFileSync(join(tmp, '.git', 'HEAD'), 'utf-8'), 'ref: refs/heads/main\n');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyPluginUpdate removes deleted modules between modular versions and rejects invalid archives', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agy-ctx-upd-test2-'));
  const badSrc = mkdtempSync(join(tmpdir(), 'agy-ctx-upd-bad-'));
  try {
    applyPluginUpdate(REPO_ROOT, tmp);
    const staleModule = join(tmp, 'sidecars', 'context_monitor', 'web', 'js', 'obsolete_module.js');
    writeFileSync(staleModule, '// removed in next release');
    assert.ok(existsSync(staleModule));

    // Re-applying clean release swaps directory and drops obsolete module
    applyPluginUpdate(REPO_ROOT, tmp);
    assert.equal(existsSync(staleModule), false);

    // Invalid archive without sidecars/context_monitor/main.mjs is rejected cleanly
    writeFileSync(join(badSrc, 'plugin.json'), '{"name":"agy-context"}');
    assert.throws(() => applyPluginUpdate(badSrc, tmp), /Invalid plugin archive/);
    assert.ok(existsSync(join(tmp, 'sidecars', 'context_monitor', 'main.mjs')));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(badSrc, { recursive: true, force: true });
  }
});
