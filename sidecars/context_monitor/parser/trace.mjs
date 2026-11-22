/**
 * Full chronological interaction trace parser for the Trace side pane.
 */

import {
  cleanArgsObject,
  commandFailedFromOutput,
  compactArgsPreview,
  compactResultPreview,
  parseJsonlSteps,
  parseMs,
  shortenPath,
} from './estimators.mjs';
import {
  collectKnownMcpServers,
  detectSystemBadges,
  extractInjectedBlocks,
  resolveToolIdentity,
  splitUserInput,
} from './extractors.mjs';
import { buildHookIntervals, computeRevertedFlags, matchHookInterval, summarizeHookTelemetry } from './hooks.mjs';

function buildToolArgsPreview(toolName, cleanArgs, id) {
  if (id.skillName) return id.skillName;
  if (id.isMcp) {
    if (id.isMcpSchema) {
      return shortenPath(cleanArgs.Path || cleanArgs.AbsolutePath || id.mcpTool);
    }
    if (toolName === 'call_mcp_tool') {
      const innerArgs = cleanArgs.Arguments ?? cleanArgs.arguments;
      if (typeof innerArgs === 'string') {
        const trimmed = innerArgs.trim();
        return trimmed.length > 140 ? `${trimmed.slice(0, 140)}…` : trimmed;
      }
      if (innerArgs != null && (typeof innerArgs !== 'object' || Object.keys(innerArgs).length > 0)) {
        return compactArgsPreview(innerArgs);
      }
      return '';
    }
    if (toolName === 'read_resource') {
      return String(cleanArgs.Uri || cleanArgs.uri || '').slice(0, 140);
    }
    if (toolName === 'list_resources' || toolName === 'list_resource_templates') {
      return '';
    }
    return compactArgsPreview(cleanArgs);
  }
  if (id.isCommand) {
    return String(cleanArgs.CommandLine || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  }
  return compactArgsPreview(cleanArgs);
}

/**
 * Parses a transcript JSONL string into a full chronological interaction trace:
 *   - summary items (lightweight list for fast rendering even on 2000+ step sessions)
 *   - detail records (full args, thinking, reply, tool output, timestamps)
 */
export function parseTrace(text, { hookTimings = null, dbTelemetry = null, knownMcpServers = null, nowMs = Date.now() } = {}) {
  const hookIntervals = buildHookIntervals(hookTimings);
  const postToolsByStep = new Map();
  if (Array.isArray(hookTimings)) {
    for (const e of hookTimings) {
      if (e && e.ev === 'PostToolUse' && Number.isFinite(Number(e.step))) {
        const sIdx = Number(e.step);
        if (!postToolsByStep.has(sIdx)) postToolsByStep.set(sIdx, []);
        postToolsByStep.get(sIdx).push(e);
      }
    }
  }

  const steps = parseJsonlSteps(text);
  const knownServers = collectKnownMcpServers(steps, knownMcpServers);
  const revertedFlags = computeRevertedFlags(steps);
  const hookSummary = summarizeHookTelemetry(hookTimings, nowMs, { steps, revertedFlags });
  const resolvedLiveState = hookSummary.hasData
    ? hookSummary.liveState
    : (dbTelemetry?.telemetry?.liveState || hookSummary.liveState);
  const getDbStep = (rawIdx, stepObj) => (
    !revertedFlags[rawIdx] && dbTelemetry?.steps
      ? (dbTelemetry.steps.get(stepObj?.step_index ?? rawIdx) || null)
      : null
  );

  const items = [];
  const details = [];
  const counts = { total: 0, input: 0, system: 0, skill: 0, mcp: 0, model: 0, tool: 0, error: 0 };
  const MAX_DETAIL_CHARS = 64 * 1024;
  let turn = 0;
  let prevPromptTokens = 0;

  const pushEntry = (summary, detail) => {
    const idx = items.length;
    items.push({ idx, ...summary });
    details.push({ idx, ...summary, ...detail });
    counts.total++;
    if (summary.kind === 'input') counts.input++;
    else if (summary.kind === 'system') counts.system++;
    else if (summary.kind === 'skill') counts.skill++;
    else if (summary.kind === 'mcp') counts.mcp++;
    else if (summary.kind === 'model') counts.model++;
    else if (summary.kind === 'tool') counts.tool++;
    if (summary.hasError) counts.error++;
    return idx;
  };

  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    const stMs = parseMs(st.created_at);
    const isReverted = Boolean(revertedFlags[i]);

    if (st.type === 'USER_INPUT') {
      if (st.source === 'USER_EXPLICIT' || !st.source) turn++;
      const { userText, injectedText } = splitUserInput(st.content);
      const preview = userText.replace(/\s+/g, ' ').trim();
      pushEntry(
        {
          kind: 'input',
          turn: Math.max(1, turn),
          step: st.step_index ?? i,
          at: st.created_at || '',
          ms: Number.isFinite(stMs) ? stMs : 0,
          durationMs: 0,
          status: st.status || 'DONE',
          hasError: st.status === 'ERROR',
          reverted: isReverted,
          preview: preview.slice(0, 160),
          mediaCount: Array.isArray(st.media) ? st.media.length : 0,
        },
        {
          userText: userText.slice(0, MAX_DETAIL_CHARS),
          injectedText: injectedText.slice(0, MAX_DETAIL_CHARS),
          rawContent: String(st.content || '').slice(0, MAX_DETAIL_CHARS),
          media: Array.isArray(st.media) ? st.media : [],
        },
      );

      for (const blk of extractInjectedBlocks(injectedText)) {
        const flat = blk.text.replace(/\s+/g, ' ').trim();
        const sysBadges = detectSystemBadges(blk.tag, blk.text);
        pushEntry(
          {
            kind: 'system',
            turn: Math.max(1, turn),
            step: st.step_index ?? i,
            at: st.created_at || '',
            ms: Number.isFinite(stMs) ? stMs : 0,
            durationMs: 0,
            status: 'INJECTED',
            hasError: false,
            reverted: isReverted,
            systemType: blk.tag,
            systemBadge: sysBadges[0] || '',
            systemBadges: sysBadges,
            preview: flat.slice(0, 160),
          },
          {
            content: blk.text.slice(0, MAX_DETAIL_CHARS),
            source: 'USER_INPUT_INJECTED',
          },
        );
      }
      continue;
    }

    if (st.type === 'PLANNER_RESPONSE') {
      if (turn === 0) turn = 1;
      const tcs = Array.isArray(st.tool_calls) ? st.tool_calls : [];
      const inTok = Math.max(0, Number(st.input_tokens) || 0);
      const cacheTok = Math.max(0, Number(st.cache_read_tokens) || 0);
      const outTok = Math.max(0, Number(st.output_tokens) || 0);
      const promptTok = inTok + cacheTok;

      if (!isReverted && prevPromptTokens > 0 && promptTok < prevPromptTokens - 1000) {
        const saved = prevPromptTokens - promptTok;
        pushEntry(
          {
            kind: 'system',
            turn,
            step: st.step_index ?? i,
            at: st.created_at || '',
            ms: Number.isFinite(stMs) ? stMs : 0,
            durationMs: 0,
            status: 'COMPACTED',
            hasError: false,
            reverted: false,
            systemType: 'COMPACTION',
            systemBadge: 'compaction',
            systemBadges: ['compaction'],
            preview: `Context compacted: ${prevPromptTokens.toLocaleString()} → ${promptTok.toLocaleString()} (-${saved.toLocaleString()} tokens)`,
          },
          {
            content: `Context compaction detected before step #${st.step_index ?? i}\nPrevious context: ${prevPromptTokens.toLocaleString()} tokens\nNew context: ${promptTok.toLocaleString()} tokens\nSaved: ${saved.toLocaleString()} tokens`,
            source: 'CONTEXT_COMPACTION',
          },
        );
      }
      if (!isReverted) prevPromptTokens = promptTok;

      const childGenerics = [];
      let scan = i + 1;
      while (scan < steps.length && steps[scan].type === 'GENERIC') {
        childGenerics.push({ stepObj: steps[scan], rawIdx: scan });
        scan++;
      }

      const nextStep = i + 1 < steps.length ? steps[i + 1] : null;
      let nextMs = childGenerics.length
        ? parseMs(childGenerics[childGenerics.length - 1].stepObj.created_at)
        : (nextStep && nextStep.type !== 'USER_INPUT' ? parseMs(nextStep.created_at) : NaN);
      let modelDurMs = 0;
      let ttftMs = 0;
      let streamMs = 0;
      let thinkingMs = 0;
      let outputGenMs = 0;
      let thinkingTokens = null;
      let timingSource = '';

      const dbStep = getDbStep(i, st);
      if (dbStep?.isPlanner && dbStep.totalMs > 0) {
        modelDurMs = Math.min(600_000, dbStep.totalMs);
        ttftMs = Math.min(modelDurMs, Math.max(0, dbStep.ttftMs || 0));
        streamMs = Math.max(0, Math.min(modelDurMs - ttftMs, dbStep.streamMs || 0));
        thinkingMs = Math.min(streamMs, Math.max(0, dbStep.thinkingMs || 0));
        outputGenMs = Math.max(0, streamMs - thinkingMs);
        thinkingTokens = dbStep.thinkingTokens ?? null;
        if (dbStep.endMs > 0) nextMs = dbStep.endMs;
        timingSource = 'db';
      } else if (Number.isFinite(stMs) && Number.isFinite(nextMs) && nextMs >= stMs) {
        modelDurMs = Math.min(120_000, nextMs - stMs);
        if (modelDurMs > 0) timingSource = 'transcript';
      } else if (tcs.length === 0) {
        const hookIv = matchHookInterval(hookIntervals, st.step_index ?? i, stMs);
        if (hookIv) {
          modelDurMs = Math.min(300_000, hookIv.durationMs);
          nextMs = hookIv.endMs;
          timingSource = 'hook';
        }
      }
      const tokPerSec = modelDurMs > 0 ? Math.round((outTok / (modelDurMs / 1000)) * 10) / 10 : 0;

      const replyText = String(st.content || '');
      const thinkingText = String(st.thinking || '');
      const previewSource = replyText.trim() || thinkingText.trim();
      const preview = previewSource.replace(/\s+/g, ' ').slice(0, 160);

      const modelIdx = pushEntry(
        {
          kind: 'model',
          turn,
          step: st.step_index ?? i,
          at: st.created_at || '',
          endAt: modelDurMs > 0 && Number.isFinite(nextMs) ? new Date(nextMs).toISOString() : '',
          ms: Number.isFinite(stMs) ? stMs : 0,
          durationMs: modelDurMs,
          ttftMs,
          streamMs,
          thinkingMs,
          outputGenMs,
          thinkingTokens,
          timingSource,
          timingUnavailable: modelDurMs === 0,
          status: st.status || 'DONE',
          hasError: st.status === 'ERROR' || Boolean(dbStep?.hasError),
          reverted: isReverted,
          model: String(st.model || 'default'),
          inputTokens: inTok,
          cacheReadTokens: cacheTok,
          outputTokens: outTok,
          promptTokens: promptTok,
          tokPerSec,
          toolCount: tcs.length,
          hasReply: Boolean(replyText.trim()),
          hasThinking: Boolean(thinkingText.trim()),
          preview,
        },
        {
          thinking: thinkingText.slice(0, MAX_DETAIL_CHARS),
          content: replyText.slice(0, MAX_DETAIL_CHARS),
          toolCalls: tcs.map((tc) => {
            const cleanArgs = cleanArgsObject(tc?.args);
            const tcName = tc?.name || 'tool';
            const id = resolveToolIdentity(tc, knownServers);
            const displayName = id.skillName
              || (id.isMcp ? `${id.mcpServer} / ${id.mcpTool}` : (id.isCommand ? id.commandName : tcName));
            return {
              name: displayName,
              rawToolName: tcName,
              isSkill: Boolean(id.skillName),
              isMcp: id.isMcp,
              mcpServer: id.mcpServer,
              mcpTool: id.mcpTool,
              isMcpSchema: id.isMcpSchema,
              isCommand: id.isCommand,
              commandName: id.commandName,
              args: cleanArgs,
            };
          }),
          childToolIdxs: [],
        },
      );

      const afterBatchMs = scan < steps.length ? parseMs(steps[scan].created_at) : NaN;

      for (let j = 0; j < tcs.length; j++) {
        const tc = tcs[j];
        const resWrap = childGenerics[j] || null;
        const resStep = resWrap?.stepObj || null;
        const cleanArgs = cleanArgsObject(tc?.args);
        const toolName = String(tc?.name || 'tool');
        const id = resolveToolIdentity(tc, knownServers);
        const skillName = id.skillName;
        const resStartMs = resStep ? parseMs(resStep.created_at) : NaN;
        let resNextMs = j + 1 < childGenerics.length
          ? parseMs(childGenerics[j + 1].stepObj.created_at)
          : afterBatchMs;
        let toolDurMs = 0;
        const dbToolStep = resWrap ? getDbStep(resWrap.rawIdx, resStep) : null;
        if (dbToolStep && !dbToolStep.isPlanner && dbToolStep.toolExecMs > 0) {
          toolDurMs = Math.min(300_000, dbToolStep.toolExecMs);
          if (dbToolStep.endMs > 0) resNextMs = dbToolStep.endMs;
        } else if (Number.isFinite(resStartMs) && Number.isFinite(resNextMs) && resNextMs >= resStartMs) {
          toolDurMs = Math.min(120_000, resNextMs - resStartMs);
        }
        const resStepIdx = resStep?.step_index;
        let hookError = dbToolStep?.hostError || '';
        if (Number.isFinite(resStepIdx) && postToolsByStep.has(resStepIdx)) {
          const candidates = postToolsByStep.get(resStepIdx);
          const matchedHook = candidates.find((c) => !c._used && (!c.tool || c.tool === toolName))
            || candidates.find((c) => !c._used);
          if (matchedHook) {
            matchedHook._used = true;
            if (matchedHook.err && !hookError) hookError = String(matchedHook.err);
            if (!dbToolStep?.toolExecMs && Number.isFinite(resStartMs) && matchedHook.ts >= resStartMs && matchedHook.ts - resStartMs <= 300_000) {
              toolDurMs = Math.max(1, matchedHook.ts - resStartMs);
              resNextMs = matchedHook.ts;
            }
          }
        }
        const rawOut = String(resStep?.content || '');
        const failed = Boolean(hookError) || Boolean(dbToolStep?.hasError) || commandFailedFromOutput(resStep);
        const argsPreview = buildToolArgsPreview(toolName, cleanArgs, id);

        const childIdx = pushEntry(
          {
            kind: skillName ? 'skill' : (id.isMcp ? 'mcp' : 'tool'),
            turn,
            step: resStep?.step_index ?? (st.step_index ?? i),
            callStep: st.step_index ?? i,
            at: resStep?.created_at || st.created_at || '',
            endAt: Number.isFinite(resNextMs) ? new Date(resNextMs).toISOString() : '',
            ms: Number.isFinite(resStartMs) ? resStartMs : (Number.isFinite(stMs) ? stMs : 0),
            durationMs: toolDurMs,
            status: failed ? 'ERROR' : (resStep?.status || 'DONE'),
            hasError: failed,
            reverted: Boolean(revertedFlags[resWrap?.rawIdx ?? i]) || isReverted,
            toolName,
            skillName: skillName || '',
            mcpServer: id.mcpServer || '',
            mcpTool: id.mcpTool || '',
            isMcpSchema: Boolean(id.isMcpSchema),
            isCommand: Boolean(id.isCommand),
            commandName: id.commandName || '',
            argsPreview,
            resultPreview: hookError ? `[ERROR] ${hookError}` : compactResultPreview(rawOut),
          },
          {
            args: cleanArgs,
            result: rawOut.slice(0, MAX_DETAIL_CHARS),
            hookError,
            truncated: rawOut.length > MAX_DETAIL_CHARS,
            media: Array.isArray(resStep?.media) ? resStep.media : [],
          },
        );
        details[modelIdx].childToolIdxs.push(childIdx);
      }

      i = scan - 1;
      continue;
    }

    if (st.type !== 'GENERIC') {
      const contentText = String(st.content || '');
      const preview = contentText.replace(/\s+/g, ' ').trim();
      if (preview || st.type) {
        const sysType = String(st.type || st.source || 'SYSTEM');
        const sysBadges = detectSystemBadges(sysType, contentText);
        pushEntry(
          {
            kind: 'system',
            turn: Math.max(1, turn),
            step: st.step_index ?? i,
            at: st.created_at || '',
            ms: Number.isFinite(stMs) ? stMs : 0,
            durationMs: 0,
            status: st.status || 'DONE',
            hasError: st.status === 'ERROR',
            reverted: isReverted,
            systemType: sysType,
            systemBadge: sysBadges[0] || '',
            systemBadges: sysBadges,
            preview: preview.slice(0, 160),
          },
          {
            content: contentText.slice(0, MAX_DETAIL_CHARS),
            source: String(st.source || ''),
          },
        );
      }
    }
  }

  return { counts, items, details, liveState: resolvedLiveState };
}
