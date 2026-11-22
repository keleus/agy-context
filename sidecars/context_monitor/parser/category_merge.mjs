/**
 * Post-loop category merging and model breakdown builders for parseTranscript().
 */

import { distributeProportional } from './estimators.mjs';

export function mergeSkillItems(rawItems, targetBucket) {
  if (!rawItems.length) return rawItems;
  const grouped = new Map();
  let rawSum = 0;
  for (const it of rawItems) {
    const key = String(it.label || 'skill');
    const tok = Math.max(0, it.tokens || 0);
    rawSum += tok;
    if (!grouped.has(key)) {
      grouped.set(key, { label: key, count: 0, rawTokens: 0, detail: it.detail || '' });
    }
    const rec = grouped.get(key);
    rec.count += 1;
    rec.rawTokens += tok;
    if (it.detail && !rec.detail) rec.detail = it.detail;
  }
  const targetSkill = targetBucket || rawSum;
  const merged = [...grouped.values()].map((rec) => ({
    label: rec.label,
    count: rec.count,
    tokens: rawSum > 0 ? Math.max(1, Math.round((rec.rawTokens / rawSum) * targetSkill)) : 0,
    detail: rec.detail,
    tool: 'skill',
    step: 0,
  }));
  merged.sort((a, b) => b.tokens - a.tokens);
  return merged;
}

/**
 * Merges tool_calls into hierarchical breakdown rows:
 *   - MCP calls & schema reads group into Level-2 MCP Server rows with expandable Level-3 tool rows
 *   - Shell commands (run_command) group into a Level-2 Commands row with expandable Level-3 command rows
 *   - Regular built-in tools group by (tool name, success/error)
 */
export function mergeToolCallItems(rawItems, targetBucket) {
  if (!rawItems.length) return rawItems;
  const regularGrouped = new Map();
  const mcpServers = new Map();
  let cmdGroup = null;
  let rawSum = 0;

  for (const it of rawItems) {
    const tok = Math.max(0, it.tokens || 0);
    rawSum += tok;
    const isErr = it.status === 'ERROR';

    if (it.isMcp) {
      const srv = String(it.mcpServer || 'mcp');
      const mTool = String(it.mcpTool || it.label || 'tool');
      if (!mcpServers.has(srv)) {
        mcpServers.set(srv, {
          server: srv,
          count: 0,
          failedCount: 0,
          rawTokens: 0,
          tools: new Map(),
        });
      }
      const srvRec = mcpServers.get(srv);
      srvRec.count += 1;
      if (isErr) srvRec.failedCount += 1;
      srvRec.rawTokens += tok;

      const childKey = `${mTool}:${it.isMcpSchema ? 'schema' : 'call'}:${isErr ? 'err' : 'ok'}`;
      if (!srvRec.tools.has(childKey)) {
        srvRec.tools.set(childKey, {
          label: mTool,
          tool: `${srv}/${mTool}`,
          mcpServer: srv,
          mcpTool: mTool,
          isMcp: true,
          isMcpSchema: Boolean(it.isMcpSchema),
          failed: isErr,
          count: 0,
          rawTokens: 0,
          samples: [],
        });
      }
      const ch = srvRec.tools.get(childKey);
      ch.count += 1;
      ch.rawTokens += tok;
      if (it.detail || it.label) ch.samples.push({ label: it.detail || it.label, tokens: tok, step: it.step || 0 });
    } else if (it.isCommand) {
      const cmdName = String(it.commandName || it.tool || 'shell');
      if (!cmdGroup) {
        cmdGroup = {
          count: 0,
          failedCount: 0,
          rawTokens: 0,
          commands: new Map(),
        };
      }
      cmdGroup.count += 1;
      if (isErr) cmdGroup.failedCount += 1;
      cmdGroup.rawTokens += tok;

      const childKey = `${cmdName}:${isErr ? 'err' : 'ok'}`;
      if (!cmdGroup.commands.has(childKey)) {
        cmdGroup.commands.set(childKey, {
          label: cmdName,
          tool: cmdName,
          commandName: cmdName,
          isCommand: true,
          failed: isErr,
          count: 0,
          rawTokens: 0,
          samples: [],
        });
      }
      const ch = cmdGroup.commands.get(childKey);
      ch.count += 1;
      ch.rawTokens += tok;
      if (it.detail || it.label) ch.samples.push({ label: it.detail || it.label, tokens: tok, step: it.step || 0 });
    } else {
      const toolName = String(it.tool || it.label || 'tool');
      const key = `tool:${toolName}:${isErr ? 'err' : 'ok'}`;
      if (!regularGrouped.has(key)) {
        regularGrouped.set(key, {
          label: toolName,
          tool: toolName,
          failed: isErr,
          count: 0,
          rawTokens: 0,
          samples: [],
        });
      }
      const rec = regularGrouped.get(key);
      rec.count += 1;
      rec.rawTokens += tok;
      if (it.label) rec.samples.push({ label: it.label, tokens: tok, step: it.step || 0 });
    }
  }

  const level2Entries = [
    ...[...mcpServers.values()].map((srv) => ({ kind: 'mcp', rec: srv, rawTokens: srv.rawTokens })),
    ...(cmdGroup ? [{ kind: 'cmd', rec: cmdGroup, rawTokens: cmdGroup.rawTokens }] : []),
    ...[...regularGrouped.values()].map((rec) => ({ kind: 'regular', rec, rawTokens: rec.rawTokens })),
  ];
  const targetTools = targetBucket || rawSum;
  const allocL2 = distributeProportional(level2Entries, targetTools);

  const formatTopSamples = (samples) => samples
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 6)
    .map((s) => `${s.step ? `#${s.step} ` : ''}${s.label}`)
    .join('\n');

  const merged = level2Entries.map((entry, idx) => {
    const tokens = allocL2[idx] || 0;
    if (entry.kind === 'mcp') {
      const srv = entry.rec;
      const childList = [...srv.tools.values()];
      const allocL3 = distributeProportional(childList, tokens);
      const children = childList.map((ch, cIdx) => ({
        label: ch.label,
        tool: ch.tool,
        isMcp: true,
        mcpServer: ch.mcpServer,
        mcpTool: ch.mcpTool,
        isMcpSchema: ch.isMcpSchema,
        count: ch.count,
        failed: ch.failed,
        status: ch.failed ? 'ERROR' : 'DONE',
        tokens: allocL3[cIdx] || 0,
        detail: formatTopSamples(ch.samples),
        step: 0,
      })).sort((a, b) => b.tokens - a.tokens || b.count - a.count);

      const allFailed = srv.failedCount > 0 && srv.failedCount === srv.count;
      return {
        label: srv.server,
        tool: srv.server,
        isMcp: true,
        mcpServer: srv.server,
        count: srv.count,
        toolCount: children.length,
        failedCount: srv.failedCount,
        failed: allFailed,
        status: allFailed ? 'ERROR' : 'DONE',
        tokens,
        children,
        detail: '',
        step: 0,
      };
    }

    if (entry.kind === 'cmd') {
      const grp = entry.rec;
      const childList = [...grp.commands.values()];
      const allocL3 = distributeProportional(childList, tokens);
      const children = childList.map((ch, cIdx) => ({
        label: ch.label,
        tool: ch.tool,
        isCommand: true,
        commandName: ch.commandName,
        count: ch.count,
        failed: ch.failed,
        status: ch.failed ? 'ERROR' : 'DONE',
        tokens: allocL3[cIdx] || 0,
        detail: formatTopSamples(ch.samples),
        step: 0,
      })).sort((a, b) => b.tokens - a.tokens || b.count - a.count);

      const allFailed = grp.failedCount > 0 && grp.failedCount === grp.count;
      return {
        label: 'Commands',
        tool: 'commands',
        isCommand: true,
        isCommandGroup: true,
        count: grp.count,
        toolCount: children.length,
        failedCount: grp.failedCount,
        failed: allFailed,
        status: allFailed ? 'ERROR' : 'DONE',
        tokens,
        children,
        detail: '',
        step: 0,
      };
    }

    const rec = entry.rec;
    return {
      label: rec.label,
      tool: rec.tool,
      count: rec.count,
      failed: rec.failed,
      status: rec.failed ? 'ERROR' : 'DONE',
      tokens,
      detail: formatTopSamples(rec.samples),
      step: 0,
    };
  });
  merged.sort((a, b) => b.tokens - a.tokens || b.count - a.count);
  return merged;
}

export function mergeUserMessageItems(rawItems, targetBucket) {
  if (!rawItems.length) return rawItems;
  const grouped = new Map();
  let rawSum = 0;
  for (const it of rawItems) {
    const g = it.group || 'text';
    const tok = Math.max(0, it.tokens || 0);
    rawSum += tok;
    if (!grouped.has(g)) {
      grouped.set(g, { group: g, label: it.label || g, count: 0, rawTokens: 0 });
    }
    const rec = grouped.get(g);
    rec.count += Math.max(1, Number(it.itemCount) || 1);
    rec.rawTokens += tok;
  }
  const targetUser = targetBucket || rawSum;
  const merged = [...grouped.values()].map((rec) => ({
    group: rec.group,
    label: rec.label,
    count: rec.count,
    tokens: rawSum > 0 ? Math.max(1, Math.round((rec.rawTokens / rawSum) * targetUser)) : 0,
    tool: 'user',
    step: 0,
  }));
  merged.sort((a, b) => b.tokens - a.tokens);
  return merged;
}

export function mergeInjectedItems(rawItems, targetBucket) {
  if (!rawItems.length) return rawItems;
  const grouped = new Map();
  let rawSum = 0;
  for (const it of rawItems) {
    const g = it.group || 'other';
    rawSum += Math.max(0, it.tokens || 0);
    if (!grouped.has(g)) {
      grouped.set(g, { group: g, label: it.label || g, count: 0, rawTokens: 0, lastDetail: '' });
    }
    const rec = grouped.get(g);
    rec.count += 1;
    rec.rawTokens += Math.max(0, it.tokens || 0);
    if (it.detail) rec.lastDetail = it.detail;
  }
  const targetInj = targetBucket || rawSum;
  const merged = [...grouped.values()].map((rec) => ({
    group: rec.group,
    label: rec.label,
    count: rec.count,
    tokens: rawSum > 0 ? Math.max(1, Math.round((rec.rawTokens / rawSum) * targetInj)) : 0,
    detail: rec.lastDetail,
    tool: 'system',
    step: 0,
  }));
  merged.sort((a, b) => b.tokens - a.tokens);
  return merged;
}

export function buildModelsBreakdown(modelsUsed) {
  return Object.entries(modelsUsed)
    .map(([m, mu]) => {
      const promptAll = mu.inputTokens + mu.cacheReadTokens;
      const total = promptAll + mu.outputTokens;
      const tMs = mu.timedDurationMs || 0;
      const tOut = mu.timedOutputTokens || 0;
      return {
        model: m,
        inputTokens: mu.inputTokens,
        cacheReadTokens: mu.cacheReadTokens,
        outputTokens: mu.outputTokens,
        totalTokens: total,
        calls: mu.calls,
        durationMs: mu.durationMs,
        cacheHitRate: promptAll > 0 ? mu.cacheReadTokens / promptAll : 0,
        tokPerSec: tMs > 0 ? Math.round((tOut / (tMs / 1000)) * 10) / 10 : 0,
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

export function buildModelComposition(modelContext, modelsUsed) {
  return Object.values(modelContext).map((mc) => {
    const mu = modelsUsed[mc.model] || {
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      textInputTokens: 0,
      imageInputTokens: 0,
      imageCount: 0,
      outThinkingTokens: 0,
      outReplyTokens: 0,
      outToolCallTokens: 0,
      toolCallCount: 0,
      calls: 0,
      durationMs: 0,
      timedOutputTokens: 0,
      timedDurationMs: 0,
    };
    const totalIn = mu.inputTokens + mu.cacheReadTokens;
    const totalAll = totalIn + mu.outputTokens;
    const tMs = mu.timedDurationMs || 0;
    const tOut = mu.timedOutputTokens || 0;
    const typeBreakdown = [
      { type: 'thinking', tokens: mc.thinking },
      { type: 'reply', tokens: mc.reply },
    ].filter((x) => x.tokens > 0);
    const avgTokPerSec = tMs > 0 ? Math.round((tOut / (tMs / 1000)) * 10) / 10 : 0;
    const postCompactTokPerSec = mc.postCompactTimedMs > 0
      ? Math.round((mc.postCompactTimedOut / (mc.postCompactTimedMs / 1000)) * 10) / 10
      : avgTokPerSec;
    return {
      ...mc,
      inputTokens: mu.inputTokens,
      cacheReadTokens: mu.cacheReadTokens,
      outputTokens: mu.outputTokens,
      totalTokens: totalAll,
      cacheHitRate: totalIn > 0 ? mu.cacheReadTokens / totalIn : 0,
      durationMs: mu.durationMs,
      tokPerSec: avgTokPerSec,
      postCompactTokPerSec,
      typeBreakdown,
    };
  }).sort((a, b) => b.total - a.total);
}
