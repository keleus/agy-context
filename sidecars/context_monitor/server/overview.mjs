/**
 * Cross-session Project & Global overview aggregation.
 */

import { CATEGORIES, DEFAULT_MODEL_SPECS, emptyBuckets } from '../parser.mjs';
import { getParsedSession, listAllConversations } from './discovery.mjs';
import { normalizeWsUri, workspaceNameFromUri } from './metadata.mjs';
import { buildUsageSeries, mergeUsageInto, resolveDateBounds, toLocalDateKey } from './series.mjs';

export function matchesWorkspace(session, targetWs, targetWsUri) {
  if (!targetWs && !targetWsUri) return true;
  const normTargetUri = normalizeWsUri(targetWsUri).toLowerCase();
  const normSessUri = normalizeWsUri(session.workspaceUri).toLowerCase();
  if (normTargetUri && normSessUri && normTargetUri === normSessUri) return true;
  const targetName = (targetWs || workspaceNameFromUri(targetWsUri)).toLowerCase();
  const sessName = String(session.workspace || '').toLowerCase();
  return Boolean(targetName && sessName && targetName === sessName);
}

export function buildOverview({ range = '30d', date = '', start = '', end = '', workspace = '', workspaceUri = '', etag = '' } = {}) {
  const bounds = resolveDateBounds(range, date, start, end);
  const allEntries = listAllConversations();

  const parsedAll = [];
  for (const { appData, convId } of allEntries) {
    const res = getParsedSession(appData, convId);
    if (!res || res.parsed.modelCalls === 0) continue;
    parsedAll.push(res.parsed);
  }

  const scopedList = (workspace || workspaceUri)
    ? parsedAll.filter((s) => matchesWorkspace(s, workspace, workspaceUri))
    : parsedAll;

  const etagParts = [bounds.range, bounds.startKey, bounds.endKey, workspace, workspaceUri];
  for (const s of scopedList) {
    etagParts.push(`${s.conversationId}:${s.steps}:${s.totals.totalTokens}:${s.workspace}`);
  }
  etagParts.sort();
  const nextEtag = etagParts.join('|');
  if (etag && etag === nextEtag) {
    return { unchanged: true, etag: nextEtag };
  }

  // Heatmap covers all dates within the active scope (Project or Global)
  const heatmap = {};
  const heatmapSessionSets = {};
  let hmMinDate = '';
  let hmMaxDate = '';
  for (const s of scopedList) {
    const dates = Object.keys(s.byDate);
    if (!dates.length && s.dateKey) dates.push(s.dateKey);
    for (const dk of dates) {
      if (!hmMinDate || dk < hmMinDate) hmMinDate = dk;
      if (!hmMaxDate || dk > hmMaxDate) hmMaxDate = dk;
      if (!heatmap[dk]) {
        heatmap[dk] = { sessions: 0, tokens: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
        heatmapSessionSets[dk] = new Set();
      }
      heatmapSessionSets[dk].add(s.conversationId);
      const bd = s.byDate[dk];
      if (bd) {
        heatmap[dk].tokens += bd.tokens;
        heatmap[dk].inputTokens += bd.inputTokens;
        heatmap[dk].cacheReadTokens += bd.cacheReadTokens;
        heatmap[dk].outputTokens += bd.outputTokens;
      }
    }
  }
  for (const dk of Object.keys(heatmap)) {
    heatmap[dk].sessions = heatmapSessionSets[dk].size;
  }

  const inRange = (s) => {
    if (!bounds.startKey && !bounds.endKey) return true;
    const dates = Object.keys(s.byDate);
    if (!dates.length && s.dateKey) dates.push(s.dateKey);
    return dates.some((dk) => (!bounds.startKey || dk >= bounds.startKey) && (!bounds.endKey || dk <= bounds.endKey));
  };

  const filtered = scopedList.filter(inRange);

  const cumulativeComposition = emptyBuckets();
  const modelsUsed = {};
  const skillsAgg = {};
  const toolsAgg = {};
  const commandsAgg = {};
  const workspaces = {};
  const dailyMap = {};
  const hourlyMap = {};

  let totalTurns = 0;
  let totalModelCalls = 0;
  let totalToolCalls = 0;
  let totalInput = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let cachedSessionsCount = 0;

  let activeMs = 0;
  let modelWaitMs = 0;
  let thinkingMs = 0;
  let modelGenMs = 0;
  let toolExecMs = 0;
  let otherMs = 0;

  let minDateKey = '';
  let maxDateKey = '';

  let hookCompletedTurns = 0;
  let hookTotalTurnMs = 0;
  let hookMaxTurnMs = 0;
  let hookTotalInvs = 0;
  let hookToolCalls = 0;
  let hookToolErrors = 0;
  const hookReasons = {};

  let hasModernTimedStats = false;
  for (const s of filtered) {
    totalTurns += s.turns;
    totalModelCalls += s.modelCalls;
    totalToolCalls += s.toolCallsCount;
    totalInput += s.totals.inputTokens;
    totalCacheRead += s.totals.cacheReadTokens;
    totalOutput += s.totals.outputTokens;
    if (s.totals.cacheReadTokens > 0) cachedSessionsCount++;

    activeMs += s.timing.activeMs;
    modelWaitMs += s.timing.modelWaitMs;
    thinkingMs += s.timing.thinkingMs;
    modelGenMs += s.timing.modelGenMs || 0;
    toolExecMs += s.timing.toolExecMs;
    otherMs += s.timing.otherMs;

    const ht = s.hookTelemetry;
    if (ht && ht.hasData) {
      hookCompletedTurns += ht.turnStats?.completedTurns || 0;
      hookTotalTurnMs += ht.turnStats?.totalTurnMs || 0;
      if ((ht.turnStats?.maxTurnMs || 0) > hookMaxTurnMs) hookMaxTurnMs = ht.turnStats.maxTurnMs;
      hookTotalInvs += ht.turnStats?.totalInvocations || 0;
      hookToolCalls += ht.toolStats?.calls || 0;
      hookToolErrors += ht.toolStats?.errors || 0;
      for (const [rk, rv] of Object.entries(ht.turnStats?.reasons || {})) {
        hookReasons[rk] = (hookReasons[rk] || 0) + rv;
      }
    }

    for (const k of CATEGORIES) {
      cumulativeComposition[k] += s.cumulativeComposition[k] || 0;
    }

    for (const [m, mv] of Object.entries(s.modelsUsed)) {
      if (!modelsUsed[m]) {
        modelsUsed[m] = {
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          calls: 0,
          sessions: 0,
          durationMs: 0,
          timedOutputTokens: 0,
          timedDurationMs: 0,
        };
      }
      modelsUsed[m].inputTokens += mv.inputTokens;
      modelsUsed[m].cacheReadTokens += mv.cacheReadTokens;
      modelsUsed[m].outputTokens += mv.outputTokens;
      modelsUsed[m].calls += mv.calls;
      modelsUsed[m].sessions += 1;
      modelsUsed[m].durationMs += mv.durationMs || 0;
      if (mv.timedDurationMs !== undefined) hasModernTimedStats = true;
      modelsUsed[m].timedOutputTokens += mv.timedOutputTokens ?? mv.outputTokens;
      modelsUsed[m].timedDurationMs += mv.timedDurationMs ?? mv.durationMs ?? 0;
    }

    for (const [name, sv] of Object.entries(s.skills)) {
      if (!skillsAgg[name]) skillsAgg[name] = { name, count: 0, lastAt: 0, tokens: 0, durationMs: 0 };
      skillsAgg[name].count += sv.count;
      skillsAgg[name].tokens += sv.tokens || 0;
      skillsAgg[name].durationMs += sv.durationMs || 0;
      if (sv.lastAt > skillsAgg[name].lastAt) skillsAgg[name].lastAt = sv.lastAt;
    }

    for (const [name, tv] of Object.entries(s.tools)) {
      if (!toolsAgg[name]) {
        toolsAgg[name] = {
          name,
          count: 0,
          lastAt: 0,
          tokens: 0,
          durationMs: 0,
          errors: 0,
          kind: tv.kind || 'tool',
          ...(tv.mcpServer ? { mcpServer: tv.mcpServer, mcpTool: tv.mcpTool || '', isMcpSchema: Boolean(tv.isMcpSchema) } : {}),
        };
      }
      toolsAgg[name].count += tv.count;
      toolsAgg[name].tokens += tv.tokens || 0;
      toolsAgg[name].durationMs += tv.durationMs || 0;
      toolsAgg[name].errors += tv.errors || 0;
      if (tv.lastAt > toolsAgg[name].lastAt) toolsAgg[name].lastAt = tv.lastAt;
    }

    for (const [name, cv] of Object.entries(s.commands)) {
      if (!commandsAgg[name]) commandsAgg[name] = { name, count: 0, lastAt: 0, tokens: 0, durationMs: 0 };
      commandsAgg[name].count += cv.count;
      commandsAgg[name].tokens += cv.tokens || 0;
      commandsAgg[name].durationMs += cv.durationMs || 0;
      if (cv.lastAt > commandsAgg[name].lastAt) commandsAgg[name].lastAt = cv.lastAt;
    }

    const ws = s.workspace || 'default-workspace';
    workspaces[ws] = (workspaces[ws] || 0) + 1;

    for (const [dk, bd] of Object.entries(s.byDate)) {
      if (bounds.startKey && dk < bounds.startKey) continue;
      if (bounds.endKey && dk > bounds.endKey) continue;
      if (!minDateKey || dk < minDateKey) minDateKey = dk;
      if (!maxDateKey || dk > maxDateKey) maxDateKey = dk;
      if (!dailyMap[dk]) {
        dailyMap[dk] = { tokens: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, models: {} };
      }
      mergeUsageInto(dailyMap[dk], bd);
    }

    for (const [hk, bh] of Object.entries(s.byHour || {})) {
      const dk = hk.slice(0, 10);
      if (bounds.startKey && dk < bounds.startKey) continue;
      if (bounds.endKey && dk > bounds.endKey) continue;
      if (!hourlyMap[hk]) {
        hourlyMap[hk] = { tokens: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, models: {} };
      }
      mergeUsageInto(hourlyMap[hk], bh);
    }
  }

  const usageSeries = buildUsageSeries({
    range: bounds.range,
    startKey: bounds.startKey,
    endKey: bounds.endKey,
    dailyMap,
    hourlyMap,
    minDateKey,
    maxDateKey,
  });

  const totalPrompt = totalInput + totalCacheRead;
  const totalTokens = totalPrompt + totalOutput;
  const cacheHitRate = totalPrompt > 0 ? totalCacheRead / totalPrompt : 0;
  let totalTimedOut = 0;
  let totalTimedMs = 0;
  for (const mv of Object.values(modelsUsed)) {
    totalTimedOut += mv.timedOutputTokens || 0;
    totalTimedMs += mv.timedDurationMs || 0;
  }
  const totalGenMs = thinkingMs + modelGenMs;
  const outputTokPerSec = totalTimedMs > 0
    ? Math.round((totalTimedOut / (totalTimedMs / 1000)) * 10) / 10
    : (!hasModernTimedStats && totalGenMs > 0 ? Math.round((totalOutput / (totalGenMs / 1000)) * 10) / 10 : 0);

  const modelsBreakdown = Object.entries(modelsUsed)
    .map(([m, mv]) => {
      const promptAll = mv.inputTokens + mv.cacheReadTokens;
      const total = promptAll + mv.outputTokens;
      const tMs = mv.timedDurationMs || 0;
      const tOut = mv.timedOutputTokens || 0;
      return {
        model: m,
        inputTokens: mv.inputTokens,
        cacheReadTokens: mv.cacheReadTokens,
        outputTokens: mv.outputTokens,
        totalTokens: total,
        calls: mv.calls,
        sessions: mv.sessions,
        durationMs: mv.durationMs,
        cacheHitRate: promptAll > 0 ? mv.cacheReadTokens / promptAll : 0,
        tokPerSec: tMs > 0 ? Math.round((tOut / (tMs / 1000)) * 10) / 10 : 0,
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const sessions = filtered
    .map((s) => ({
      conversationId: s.conversationId,
      title: s.title,
      workspace: s.workspace,
      workspaceUri: s.workspaceUri,
      model: s.model,
      contextWindow: s.contextWindow || 0,
      modelsUsed: s.modelsUsed,
      turns: s.turns,
      steps: s.steps,
      modelCalls: s.modelCalls,
      toolCallsCount: s.toolCallsCount,
      lastAt: s.lastAt,
      lastMs: s.lastMs,
      dateKey: s.dateKey,
      lastUserMessage: s.lastUserMessage,
      currentContext: s.currentContext,
      lastPromptTokens: s.lastPromptTokens,
      peakContext: s.peakContext,
      totals: s.totals,
      composition: s.composition,
      compactionsCount: s.compactions.length,
      firstCompactionFrom: s.compactions[0]?.from || 0,
    }))
    .sort((a, b) => b.lastMs - a.lastMs);

  return {
    etag: nextEtag,
    scope: (workspace || workspaceUri) ? 'project' : 'global',
    workspace: workspace || workspaceNameFromUri(workspaceUri) || '',
    range: bounds.range,
    startDate: bounds.startKey || hmMinDate || minDateKey || toLocalDateKey(new Date()),
    endDate: bounds.endKey || hmMaxDate || maxDateKey || toLocalDateKey(new Date()),
    dataMinDate: hmMinDate || minDateKey || '',
    dataMaxDate: hmMaxDate || maxDateKey || '',
    defaultModelSpecs: DEFAULT_MODEL_SPECS,
    kpi: {
      totalSessions: filtered.length,
      allSessionsCount: scopedList.length,
      totalTurns,
      totalModelCalls,
      totalToolCalls,
      totalTokens,
      totalInput,
      totalCacheRead,
      totalOutput,
      cacheHitRate,
      cachedSessionsCount,
      activeMs,
      toolExecMs,
    },
    modelsUsed,
    modelsBreakdown,
    cumulativeComposition,
    timing: {
      activeMs,
      modelWaitMs,
      thinkingMs,
      modelGenMs,
      toolExecMs,
      otherMs,
      outputTokPerSec,
      modelCalls: totalModelCalls,
      toolCalls: totalToolCalls,
    },
    usageSeries,
    heatmap,
    heatmapSpan: { minDate: hmMinDate, maxDate: hmMaxDate },
    skills: Object.values(skillsAgg).sort((a, b) => b.count - a.count),
    tools: Object.values(toolsAgg).sort((a, b) => b.count - a.count),
    commands: Object.values(commandsAgg).sort((a, b) => b.count - a.count),
    hookOverview: {
      hasData: hookCompletedTurns > 0 || hookToolCalls > 0,
      completedTurns: hookCompletedTurns,
      avgTurnMs: hookCompletedTurns > 0 ? Math.round(hookTotalTurnMs / hookCompletedTurns) : 0,
      maxTurnMs: hookMaxTurnMs,
      avgInvocations: hookCompletedTurns > 0 ? Math.round((hookTotalInvs / hookCompletedTurns) * 10) / 10 : 0,
      reasons: hookReasons,
      toolCalls: hookToolCalls,
      toolErrors: hookToolErrors,
    },
    workspaces,
    sessions,
  };
}
