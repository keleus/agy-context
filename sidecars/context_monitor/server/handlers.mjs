/**
 * API route handlers for session, overview, trace, and trace-detail endpoints.
 */

import { DEFAULT_MODEL_SPECS } from '../parser.mjs';
import { ID_RE, getParsedSession, getParsedTrace, locateConversation } from './discovery.mjs';
import { buildOverview } from './overview.mjs';

export function resolveRequestConvId(data, defaultConvId) {
  const raw = data && Object.prototype.hasOwnProperty.call(data, 'conversationId')
    ? data.conversationId
    : defaultConvId;
  return String(raw || '').trim();
}

export function handleSession(data, defaultConvId) {
  const convId = resolveRequestConvId(data, defaultConvId);
  if (!convId || !ID_RE.test(convId)) {
    return { conversationId: convId || null, found: false, defaultModelSpecs: DEFAULT_MODEL_SPECS };
  }
  const appData = locateConversation(convId);
  if (!appData) {
    return { conversationId: convId, found: false, defaultModelSpecs: DEFAULT_MODEL_SPECS };
  }
  const res = getParsedSession(appData, convId);
  if (!res) {
    return { conversationId: convId, found: false, defaultModelSpecs: DEFAULT_MODEL_SPECS };
  }
  const etag = res.key;
  if (data.etag && data.etag === etag) {
    return { conversationId: convId, found: true, unchanged: true, etag };
  }
  const trace = getParsedTrace(appData, convId);
  const recentTrace = trace
    ? trace.details.slice(-14).map((d) => ({
        idx: d.idx,
        kind: d.kind,
        turn: d.turn,
        step: d.step,
        at: d.at,
        durationMs: d.durationMs,
        hasError: d.hasError,
        reverted: Boolean(d.reverted),
        hasThinking: d.hasThinking,
        hasReply: d.hasReply,
        toolName: d.toolName,
        skillName: d.skillName,
        mcpServer: d.mcpServer || '',
        mcpTool: d.mcpTool || '',
        isMcpSchema: Boolean(d.isMcpSchema),
        isCommand: Boolean(d.isCommand),
        commandName: d.commandName || '',
        model: d.model,
        systemType: d.systemType,
        systemBadge: d.systemBadge,
        systemBadges: d.systemBadges,
        outputTokens: d.outputTokens,
        toolCount: d.toolCount,
        preview: d.preview,
        argsPreview: d.argsPreview,
        resultPreview: d.resultPreview,
        detailText: (d.kind === 'tool' || d.kind === 'skill' || d.kind === 'mcp')
          ? `${JSON.stringify(d.args || {}, null, 2)}${d.result ? `\n\n--- Result ---\n${d.result.slice(0, 1200)}` : ''}`
          : d.kind === 'model'
            ? [d.thinking ? `[Thinking]\n${d.thinking.slice(0, 1200)}` : '', d.content ? `[Reply]\n${d.content.slice(0, 1200)}` : ''].filter(Boolean).join('\n\n')
            : (d.content || d.userText || '').slice(0, 1200),
      }))
    : [];

  const enrichedSession = {
    ...res.parsed,
    recentTrace,
    traceCount: trace?.counts?.total || 0,
  };
  return {
    conversationId: convId,
    found: true,
    etag,
    defaultModelSpecs: DEFAULT_MODEL_SPECS,
    session: enrichedSession,
  };
}

export function handleOverview(data) {
  return buildOverview({
    range: String(data.range || '30d'),
    date: String(data.date || ''),
    start: String(data.start || ''),
    end: String(data.end || ''),
    workspace: String(data.workspace || ''),
    workspaceUri: String(data.workspaceUri || ''),
    etag: String(data.etag || ''),
  });
}

export function handleTrace(data, defaultConvId) {
  const convId = resolveRequestConvId(data, defaultConvId);
  if (!convId || !ID_RE.test(convId)) return { conversationId: convId || null, found: false };
  const appData = locateConversation(convId);
  if (!appData) return { conversationId: convId, found: false };
  const entry = getParsedTrace(appData, convId);
  if (!entry) return { conversationId: convId, found: false };
  if (data.etag && data.etag === entry.key) {
    return { conversationId: convId, found: true, unchanged: true, etag: entry.key };
  }
  return {
    conversationId: convId,
    found: true,
    etag: entry.key,
    counts: entry.counts,
    items: entry.items,
    liveState: entry.liveState,
  };
}

export function handleTraceDetail(data, defaultConvId) {
  const convId = resolveRequestConvId(data, defaultConvId);
  const idx = Number(data.idx);
  if (!convId || !ID_RE.test(convId) || !Number.isInteger(idx) || idx < 0) {
    return { found: false };
  }
  const appData = locateConversation(convId);
  if (!appData) return { found: false };
  const entry = getParsedTrace(appData, convId);
  if (!entry || idx >= entry.details.length) return { found: false };
  return { found: true, item: entry.details[idx] };
}
