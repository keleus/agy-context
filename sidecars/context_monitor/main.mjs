/**
 * AGY Context Monitor sidecar backend entrypoint.
 *
 * Runs natively inside Antigravity via `sidecar_sdk`, and falls back to a
 * lightweight `node:http` server when launched standalone for development.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAppDataDirs } from './server/discovery.mjs';
import { handleOverview, handleSession, handleTrace, handleTraceDetail } from './server/handlers.mjs';
import { buildUsageSeries } from './server/series.mjs';
import { handleGetSettings, handleSaveSettings } from './server/settings.mjs';
import { buildCssBundle, buildJsBundle } from './server/static.mjs';
import { getUpdateStatus, handleStartUpdate, handleVersion, readPluginManifest } from './server/updater.mjs';

// Preserve backwards-compatible export for tests and external callers.
export { buildUsageSeries };

const __dirname = dirname(fileURLToPath(import.meta.url));

let isEntrypoint = false;
if (process.argv[1]) {
  try {
    isEntrypoint = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    isEntrypoint = fileURLToPath(import.meta.url) === process.argv[1];
  }
}

if (isEntrypoint) {
  let sdk = null;
  try { sdk = await import('sidecar_sdk'); } catch { sdk = null; }

  if (sdk?.SidecarApp) {
    const { SidecarApp, Response } = sdk;
    const app = new SidecarApp();

    const serveIndex = () => readFileSync(join(__dirname, 'index.html'), 'utf-8');
    app.page('/', serveIndex);
    app.page('/trace', serveIndex);

    app.api('/styles.css', () => new Response(buildCssBundle(__dirname), { contentType: 'text/css; charset=utf-8' }), 'GET');
    app.api('/app.js', () => new Response(buildJsBundle(__dirname), { contentType: 'application/javascript; charset=utf-8' }), 'GET');

    app.api('/api/health', () => ({ ok: true, version: readPluginManifest().version, appDataDirs: findAppDataDirs() }), 'GET');
    app.api('/api/session', (data) => handleSession(data, app.config?.conversationId), 'GET');
    app.api('/api/trace', (data) => handleTrace(data, app.config?.conversationId), 'GET');
    app.api('/api/trace-detail', (data) => handleTraceDetail(data, app.config?.conversationId), 'GET');
    app.api('/api/overview', (data) => handleOverview(data), 'GET');
    app.api('/api/version', async (data) => handleVersion(data), 'GET');
    app.api('/api/settings', () => handleGetSettings(), 'GET');
    app.api('/api/settings/save', (data) => handleSaveSettings(data), 'POST');
    app.api('/api/update/start', () => handleStartUpdate(), 'POST');
    app.api('/api/update/status', () => getUpdateStatus(), 'GET');

    console.log(`[agy-context] starting via sidecar_sdk; appDataDirs=${findAppDataDirs().join(', ')}`);
    app.run();
  } else {
    const port = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || 3737);
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const pathname = url.pathname;
      const data = Object.fromEntries(url.searchParams.entries());
      const sendJson = (payload) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      };

      try {
        if (pathname === '/' || pathname === '/index.html' || pathname === '/trace') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(readFileSync(join(__dirname, 'index.html'), 'utf-8'));
          return;
        }
        if (pathname === '/preload.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
          res.end('window.sidecar = window.sidecar || null;');
          return;
        }
        if (pathname === '/styles.css') {
          res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
          res.end(buildCssBundle(__dirname));
          return;
        }
        if (pathname === '/app.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
          res.end(buildJsBundle(__dirname));
          return;
        }
        if (pathname === '/api/health') {
          sendJson({ ok: true, standalone: true, version: readPluginManifest().version, appDataDirs: findAppDataDirs() });
          return;
        }
        if (pathname === '/api/session') {
          sendJson(handleSession(data, process.env.ANTIGRAVITY_CONVERSATION_ID || ''));
          return;
        }
        if (pathname === '/api/trace') {
          sendJson(handleTrace(data, process.env.ANTIGRAVITY_CONVERSATION_ID || ''));
          return;
        }
        if (pathname === '/api/trace-detail') {
          sendJson(handleTraceDetail(data, process.env.ANTIGRAVITY_CONVERSATION_ID || ''));
          return;
        }
        if (pathname === '/api/overview') {
          sendJson(handleOverview(data));
          return;
        }
        if (pathname === '/api/version') {
          sendJson(await handleVersion(data));
          return;
        }
        if (pathname === '/api/settings' && req.method === 'GET') {
          sendJson(handleGetSettings());
          return;
        }
        if (pathname === '/api/settings/save' && req.method === 'POST') {
          const chunks = [];
          for await (const ch of req) chunks.push(ch);
          let parsedBody = null;
          try { parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'); } catch { parsedBody = null; }
          sendJson(handleSaveSettings(parsedBody));
          return;
        }
        if (pathname === '/api/update/start' && req.method === 'POST') {
          sendJson(handleStartUpdate());
          return;
        }
        if (pathname === '/api/update/status') {
          sendJson(getUpdateStatus());
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err?.message || err) }));
      }
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`[agy-context] standalone server listening on http://127.0.0.1:${port}`);
    });
  }
}
