/**
 * Full session transcript analyzer: parses a JSONL transcript into live context
 * composition, per-model stats, timeline, compaction history, tool/skill/command
 * usage, timing breakdowns, and hook telemetry.
 */

import { CATEGORIES, emptyBuckets } from './constants.mjs';
import {
  commandFailedFromOutput,
  estimateMediaTokens,
  estimateTokens,
  normalizeDistribute,
  parseJsonlSteps,
  parseMs,
  parseResultDurationMs,
  shortenPath,
  splitMediaByType,
  toLocalDateKey,
  toLocalHourKey,
  unwrapArg,
} from './estimators.mjs';
import {
  collectKnownMcpServers,
  describeToolItem,
  extractCommands,
  inferWorkspace,
  resolveToolIdentity,
  splitInjectedSubparts,
  splitUserInput,
} from './extractors.mjs';
import { mergeIntervalsDurationMs } from './conv_db.mjs';
import { buildHookIntervals, computeRevertedFlags, matchHookInterval, summarizeHookTelemetry } from './hooks.mjs';
import {
  buildModelComposition,
  buildModelsBreakdown,
  mergeInjectedItems,
  mergeSkillItems,
  mergeToolCallItems,
  mergeUserMessageItems,
} from './category_merge.mjs';

function collectUserInputItems(st, stepIndexFallback, safeMs, detailLimit, withCategories) {
  const { userText, injectedText } = splitUserInput(st.content);
  const textW = estimateTokens(userText);
  const { imageW, imageCount, fileW, fileCount } = splitMediaByType(st.media);
  const userWeight = textW + imageW + fileW;
  const injectedWeight = estimateTokens(injectedText);
  const step = st.step_index ?? stepIndexFallback;
  const at = st.created_at || '';

  const userItems = [];
  const injectedItems = [];
  const baseUser = withCategories ? { category: 'user_messages', tool: 'user' } : {};
  const baseInj = withCategories ? { category: 'injected_content', tool: 'system' } : {};

  if (textW > 0) {
    userItems.push({ group: 'text', label: 'Text input', ...baseUser, weight: textW, itemCount: 1, step, at, ms: safeMs });
  }
  if (imageW > 0) {
    userItems.push({ group: 'image', label: 'Image input', ...baseUser, weight: imageW, itemCount: imageCount, step, at, ms: safeMs });
  }
  if (fileW > 0) {
    userItems.push({ group: 'file', label: 'File / Media', ...baseUser, weight: fileW, itemCount: fileCount, step, at, ms: safeMs });
  }
  if (injectedWeight > 0) {
    const subparts = splitInjectedSubparts(injectedText);
    if (subparts.length) {
      for (const sp of subparts) {
        const sw = estimateTokens(sp.text);
        if (sw <= 0) continue;
        injectedItems.push({
          group: sp.group,
          label: sp.label,
          detail: sp.text.slice(0, detailLimit),
          ...baseInj,
          weight: sw,
          step,
          at,
          ms: safeMs,
        });
      }
    } else {
      injectedItems.push({
        group: 'other',
        label: 'Other injected',
        detail: injectedText.slice(0, detailLimit),
        ...baseInj,
        weight: injectedWeight,
        step,
        at,
        ms: safeMs,
      });
    }
  }
  return { userWeight, injectedWeight, userItems, injectedItems };
}

/**
 * Parses a transcript JSONL string into a rich, structured session summary.
 */
export function parseTranscript(text, {
  conversationId = '',
  title = '',
  workspace = '',
  workspaceUri = '',
  fileMtime = 0,
  hookTimings = null,
  dbTelemetry = null,
  knownMcpServers = null,
  nowMs = Date.now(),
} = {}) {
  const hookIntervals = buildHookIntervals(hookTimings);
  const hookErrorSteps = new Set();
  const hookPostToolTs = new Map();
  if (Array.isArray(hookTimings)) {
    for (const e of hookTimings) {
      if (e && e.ev === 'PostToolUse' && Number.isFinite(Number(e.step))) {
        const sIdx = Number(e.step);
        if (e.err) hookErrorSteps.add(sIdx);
        if (typeof e.ts === 'number' && !hookPostToolTs.has(sIdx)) hookPostToolTs.set(sIdx, e.ts);
      }
    }
  }

  const steps = parseJsonlSteps(text);
  const revertedFlags = computeRevertedFlags(steps);
  if (dbTelemetry?.steps) {
    for (const [sIdx, dStep] of dbTelemetry.steps.entries()) {
      if (dStep?.hasError) hookErrorSteps.add(sIdx);
    }
  }
  const hookSummary = summarizeHookTelemetry(hookTimings, nowMs, { steps, revertedFlags });
  const hookTelemetry = hookSummary.hasData
    ? hookSummary
    : (dbTelemetry?.telemetry || hookSummary);
  const getDbStep = (rawIdx, stepObj) => (
    !revertedFlags[rawIdx] && dbTelemetry?.steps
      ? (dbTelemetry.steps.get(stepObj?.step_index ?? rawIdx) || null)
      : null
  );

  const plannerIndices = [];
  let turns = 0;
  let firstUserText = '';
  let lastUserMessage = '';
  let firstMs = Infinity;
  let lastMs = 0;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const ms = parseMs(s.created_at);
    if (Number.isFinite(ms)) {
      if (ms < firstMs) firstMs = ms;
      if (ms > lastMs) lastMs = ms;
    }
    if (s.type === 'USER_INPUT') {
      const { userText } = splitUserInput(s.content);
      if (s.source === 'USER_EXPLICIT' || !s.source) turns++;
      if (userText) {
        if (!firstUserText) firstUserText = userText;
        lastUserMessage = userText;
      }
    } else if (s.type === 'PLANNER_RESPONSE') {
      plannerIndices.push(i);
    }
  }

  if (!Number.isFinite(firstMs)) firstMs = fileMtime || Date.now();
  if (!lastMs) lastMs = fileMtime || firstMs;
  if (turns === 0 && plannerIndices.length > 0) turns = 1;

  const resolvedTitle = title
    || (firstUserText ? firstUserText.replace(/\s+/g, ' ').slice(0, 60) : '')
    || `Session ${conversationId.slice(0, 8)}`;
  const resolvedWorkspace = workspace || inferWorkspace(steps);
  const knownServers = collectKnownMcpServers(steps, knownMcpServers);

  // Composition & cumulative accumulators
  const currentBuckets = emptyBuckets();
  const cumulativeBuckets = emptyBuckets();
  const modelsUsed = {};
  const modelContext = {};
  const skills = {};
  const tools = {};
  const commands = {};
  const byDate = {};
  const byHour = {};
  const timeline = [];
  const compactions = [];
  const itemContributions = [];
  const fileActivityMap = new Map();
  const commandLog = [];

  const categoryItems = {
    system_prompt: [],
    tool_definitions: [],
    skill_injection: [],
    user_messages: [],
    tool_calls: [],
    injected_content: [],
  };

  let totalInput = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let totalToolCalls = 0;
  let latestModel = '';
  let lastPromptTokens = 0;
  let lastOutputTokens = 0;
  let peakContext = 0;

  let modelWaitMs = 0;
  let thinkingMs = 0;
  let modelGenMs = 0;
  let toolExecMs = 0;
  let otherMs = 0;
  let totalTimedOutput = 0;
  let totalTimedModelMs = 0;
  let maxTokPerSec = 0;
  let maxTokPerSecAny = 0;
  const MAX_ACTIVE_GAP_MS = 120_000;
  const MAX_DB_CALL_MS = 600_000;

  const ensureDateBucket = (dateKey) => {
    if (!dateKey) return null;
    if (!byDate[dateKey]) {
      byDate[dateKey] = {
        tokens: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        modelCalls: 0,
        toolCalls: 0,
        models: {},
      };
    }
    return byDate[dateKey];
  };

  const ensureHourBucket = (hourKey) => {
    if (!hourKey) return null;
    if (!byHour[hourKey]) {
      byHour[hourKey] = {
        tokens: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        models: {},
      };
    }
    return byHour[hourKey];
  };

  const ensureModelContext = (model) => {
    if (!modelContext[model]) {
      modelContext[model] = {
        model,
        total: 0,
        thinking: 0,
        reply: 0,
        calls: 0,
        postCompactTimedOut: 0,
        postCompactTimedMs: 0,
        items: [],
      };
    }
    return modelContext[model];
  };

  const recordFileTouch = (pathStr, kind, tokens, stepIdx, at, ms) => {
    const p = unwrapArg(pathStr);
    if (!p) return;
    let entry = fileActivityMap.get(p);
    if (!entry) {
      entry = { path: p, shortPath: shortenPath(p), reads: 0, edits: 0, writes: 0, tokens: 0, lastStep: stepIdx, lastAt: at, lastMs: ms };
      fileActivityMap.set(p, entry);
    }
    if (kind === 'read') entry.reads += 1;
    else if (kind === 'edit') entry.edits += 1;
    else if (kind === 'write') entry.writes += 1;
    entry.tokens += Math.max(0, tokens || 0);
    if (stepIdx >= entry.lastStep) {
      entry.lastStep = stepIdx;
      entry.lastAt = at;
      entry.lastMs = ms;
    }
  };

  let prevPromptTokens = 0;
  let prevPlannerIdx = -1;
  let currentTurnIndex = 0;

  for (let pPos = 0; pPos < plannerIndices.length; pPos++) {
    const pIdx = plannerIndices[pPos];
    const pStep = steps[pIdx];
    const pMs = parseMs(pStep.created_at);
    const safePMs = Number.isFinite(pMs) ? pMs : lastMs;
    const dateKey = toLocalDateKey(safePMs);
    const hourKey = toLocalHourKey(safePMs);

    // Count explicit user turns & incoming media (images/attachments) up to this planner step
    let stepMediaEst = 0;
    let stepImageCount = 0;
    for (let j = prevPlannerIdx + 1; j < pIdx; j++) {
      const st = steps[j];
      if (st.type === 'USER_INPUT' && (st.source === 'USER_EXPLICIT' || !st.source)) {
        currentTurnIndex++;
      }
      if (Array.isArray(st.media) && st.media.length) {
        stepMediaEst += estimateMediaTokens(st.media);
        for (const m of st.media) {
          if (String(m?.mime_type || '').toLowerCase().startsWith('image/')) stepImageCount += 1;
        }
      }
    }
    if (currentTurnIndex === 0) currentTurnIndex = 1;

    const model = String(pStep.model || latestModel || 'default');
    latestModel = model;

    const inTok = Math.max(0, Number(pStep.input_tokens) || 0);
    const cacheTok = Math.max(0, Number(pStep.cache_read_tokens) || 0);
    const outTok = Math.max(0, Number(pStep.output_tokens) || 0);
    const promptTok = inTok + cacheTok;

    totalInput += inTok;
    totalCacheRead += cacheTok;
    totalOutput += outTok;
    lastPromptTokens = promptTok;
    lastOutputTokens = outTok;
    if (promptTok + outTok > peakContext) peakContext = promptTok + outTok;

    if (!modelsUsed[model]) {
      modelsUsed[model] = {
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
    }
    modelsUsed[model].inputTokens += inTok;
    modelsUsed[model].cacheReadTokens += cacheTok;
    modelsUsed[model].outputTokens += outTok;
    modelsUsed[model].calls += 1;

    const stepImgTok = Math.min(inTok, stepMediaEst);
    modelsUsed[model].imageInputTokens += stepImgTok;
    modelsUsed[model].imageCount += stepImageCount;
    modelsUsed[model].textInputTokens += Math.max(0, inTok - stepImgTok);

    const dbStep = getDbStep(pIdx, pStep);
    const tcs = Array.isArray(pStep.tool_calls) ? pStep.tool_calls : [];
    const outWThink = pStep.thinking ? estimateTokens(pStep.thinking) : 0;
    const outWReply = pStep.content ? estimateTokens(pStep.content) : 0;
    const outWTool = tcs.length ? estimateTokens(JSON.stringify(tcs)) : 0;
    const outWSum = outWThink + outWReply + outWTool;
    let stepOutThink = 0;
    let stepOutTool = 0;
    let stepOutReply = 0;
    if (outTok > 0) {
      if (dbStep?.isPlanner && dbStep.thinkingTokens != null) {
        stepOutThink = Math.min(outTok, Math.max(0, dbStep.thinkingTokens));
        const remainOut = Math.max(0, outTok - stepOutThink);
        if (tcs.length === 0) {
          stepOutReply = remainOut;
        } else if (!pStep.content) {
          stepOutTool = remainOut;
        } else {
          const nonThinkSum = outWReply + outWTool;
          stepOutTool = nonThinkSum > 0 ? Math.round((outWTool / nonThinkSum) * remainOut) : 0;
          stepOutReply = Math.max(0, remainOut - stepOutTool);
        }
      } else if (outWSum > 0) {
        stepOutThink = Math.round((outWThink / outWSum) * outTok);
        stepOutTool = Math.round((outWTool / outWSum) * outTok);
        if (stepOutThink + stepOutTool > outTok) {
          stepOutTool = Math.max(0, outTok - stepOutThink);
        }
        stepOutReply = Math.max(0, outTok - stepOutThink - stepOutTool);
      } else {
        stepOutReply = outTok;
      }
    }
    modelsUsed[model].outThinkingTokens += stepOutThink;
    modelsUsed[model].outReplyTokens += stepOutReply;
    modelsUsed[model].outToolCallTokens += stepOutTool;
    modelsUsed[model].toolCallCount += tcs.length;

    const mc = ensureModelContext(model);
    mc.calls += 1;

    const db = ensureDateBucket(dateKey);
    if (db) {
      db.inputTokens += inTok;
      db.cacheReadTokens += cacheTok;
      db.outputTokens += outTok;
      db.tokens += inTok + cacheTok + outTok;
      db.modelCalls += 1;
      if (!db.models[model]) {
        db.models[model] = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
      }
      db.models[model].inputTokens += inTok;
      db.models[model].cacheReadTokens += cacheTok;
      db.models[model].outputTokens += outTok;
    }

    const hb = ensureHourBucket(hourKey);
    if (hb) {
      hb.inputTokens += inTok;
      hb.cacheReadTokens += cacheTok;
      hb.outputTokens += outTok;
      hb.tokens += inTok + cacheTok + outTok;
      if (!hb.models[model]) {
        hb.models[model] = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
      }
      hb.models[model].inputTokens += inTok;
      hb.models[model].cacheReadTokens += cacheTok;
      hb.models[model].outputTokens += outTok;
    }

    totalToolCalls += tcs.length;
    if (db) db.toolCalls += tcs.length;

    const nextPIdx = pPos + 1 < plannerIndices.length ? plannerIndices[pPos + 1] : steps.length;
    const childGenerics = [];
    const childGenericIndices = [];
    for (let j = pIdx + 1; j < nextPIdx; j++) {
      if (steps[j].type === 'GENERIC') {
        childGenerics.push(steps[j]);
        childGenericIndices.push(j);
      }
    }

    for (let tcIdx = 0; tcIdx < tcs.length; tcIdx++) {
      const tc = tcs[tcIdx];
      const tName = String(tc?.name || 'unknown');
      const id = resolveToolIdentity(tc, knownServers);
      const toolKey = id.key;
      const matchedResult = childGenerics[tcIdx] || null;
      const matchedResultIdx = childGenericIndices[tcIdx] ?? -1;
      const dbToolStep = matchedResult && matchedResultIdx >= 0
        ? getDbStep(matchedResultIdx, matchedResult)
        : null;
      const resultMs = matchedResult ? parseMs(matchedResult.created_at) : NaN;
      let tcDurMs = dbToolStep?.toolExecMs > 0
        ? Math.min(300_000, dbToolStep.toolExecMs)
        : parseResultDurationMs(matchedResult?.content);
      if (tcDurMs === 0 && matchedResult && Number.isFinite(resultMs)) {
        const hookEnd = Number.isFinite(matchedResult.step_index) ? hookPostToolTs.get(matchedResult.step_index) : undefined;
        if (Number.isFinite(hookEnd) && hookEnd >= resultMs) {
          tcDurMs = Math.min(300_000, hookEnd - resultMs);
        } else {
          const nextStepObj = steps[Math.min(steps.length - 1, (matchedResult.step_index ?? pIdx) + 1)];
          const nextMs = nextStepObj && nextStepObj.type !== 'USER_INPUT' ? parseMs(nextStepObj.created_at) : NaN;
          if (Number.isFinite(nextMs) && nextMs >= resultMs) {
            tcDurMs = Math.min(120_000, nextMs - resultMs);
          }
        }
      }

      if (!tools[toolKey]) {
        tools[toolKey] = {
          count: 0,
          lastAt: 0,
          tokens: 0,
          durationMs: 0,
          errors: 0,
          kind: id.isMcp ? 'mcp' : (id.isCommand ? 'command' : 'tool'),
          ...(id.isMcp ? { mcpServer: id.mcpServer, mcpTool: id.mcpTool, isMcpSchema: id.isMcpSchema } : {}),
        };
      }
      tools[toolKey].count += 1;
      tools[toolKey].durationMs += tcDurMs;
      if (safePMs > tools[toolKey].lastAt) tools[toolKey].lastAt = safePMs;

      const args = tc?.args || {};
      const skillName = id.skillName;
      if (skillName) {
        if (!skills[skillName]) skills[skillName] = { count: 0, lastAt: 0, tokens: 0, durationMs: 0 };
        skills[skillName].count += 1;
        skills[skillName].durationMs += tcDurMs;
        if (safePMs > skills[skillName].lastAt) skills[skillName].lastAt = safePMs;
      }

      if (tName === 'read_file' || tName === 'view_file') {
        const p = args.Path || args.AbsolutePath;
        if (p && !skillName && !id.isMcpSchema) recordFileTouch(p, 'read', 0, pStep.step_index ?? pIdx, pStep.created_at || '', safePMs);
      } else if (tName === 'edit_file') {
        if (args.Path) recordFileTouch(args.Path, 'edit', 0, pStep.step_index ?? pIdx, pStep.created_at || '', safePMs);
      } else if (tName === 'write_file') {
        if (args.Path) recordFileTouch(args.Path, 'write', 0, pStep.step_index ?? pIdx, pStep.created_at || '', safePMs);
      }

      if (tName === 'run_command' && args.CommandLine) {
        const rawCmd = unwrapArg(args.CommandLine);
        const cmds = extractCommands(rawCmd);
        const cmdOutTok = estimateTokens(matchedResult?.content || '') + estimateTokens(rawCmd);
        const perCmdTok = cmds.length ? Math.max(1, Math.round(cmdOutTok / cmds.length)) : 0;
        const perCmdDur = cmds.length ? Math.round(tcDurMs / cmds.length) : 0;
        for (const c of cmds) {
          if (!commands[c]) commands[c] = { count: 0, lastAt: 0, tokens: 0, durationMs: 0 };
          commands[c].count += 1;
          commands[c].tokens += perCmdTok;
          commands[c].durationMs += perCmdDur;
          if (safePMs > commands[c].lastAt) commands[c].lastAt = safePMs;
        }
        commandLog.push({
          step: matchedResult?.step_index ?? (pStep.step_index ?? pIdx),
          at: matchedResult?.created_at || pStep.created_at || '',
          ms: Number.isFinite(resultMs) ? resultMs : safePMs,
          cmd: rawCmd.replace(/\s+/g, ' ').trim().slice(0, 220),
          summary: unwrapArg(args.toolSummary || ''),
          binaries: cmds,
          failed: commandFailedFromOutput(matchedResult),
          durationMs: tcDurMs,
          outputTokens: estimateTokens(matchedResult?.content || ''),
        });
      }
    }

    // --- Context composition attribution for promptTok ---
    let compacted = false;
    const delta = pPos === 0 ? promptTok : (promptTok - prevPromptTokens);

    if (pPos === 0) {
      let userEst = 0;
      let injectedEst = 0;
      const initUserItems = [];
      const initInjItems = [];
      for (let j = 0; j < pIdx; j++) {
        const st = steps[j];
        const stMs = parseMs(st.created_at);
        const safeStMs = Number.isFinite(stMs) ? stMs : safePMs;
        if (st.type === 'USER_INPUT') {
          const parsed = collectUserInputItems(st, j, safeStMs, 200, false);
          userEst += parsed.userWeight;
          injectedEst += parsed.injectedWeight;
          initUserItems.push(...parsed.userItems);
          initInjItems.push(...parsed.injectedItems);
        } else {
          const w = estimateTokens(st.content || '');
          injectedEst += w;
          if (w > 0) {
            const g = st.type === 'CHECKPOINT' ? 'compaction' : 'other';
            initInjItems.push({
              group: g,
              label: st.type || 'System injection',
              detail: String(st.content || '').slice(0, 200),
              weight: w,
              step: st.step_index ?? j,
              at: st.created_at || '',
              ms: safeStMs,
            });
          }
        }
      }
      const nonBaseline = Math.min(promptTok, userEst + injectedEst);
      const baseline = Math.max(0, promptTok - nonBaseline);
      const sysTok = Math.round(baseline * 0.44);
      const toolDefTok = baseline - sysTok;

      currentBuckets.system_prompt += sysTok;
      currentBuckets.tool_definitions += toolDefTok;

      if (nonBaseline > 0) {
        const uShare = Math.round((userEst / Math.max(1, userEst + injectedEst)) * nonBaseline);
        const iShare = nonBaseline - uShare;
        currentBuckets.user_messages += uShare;
        currentBuckets.injected_content += iShare;
        const initInjWTotal = initInjItems.reduce((a, x) => a + x.weight, 0) || 1;
        for (const it of initUserItems) {
          const tok = Math.max(1, Math.round((it.weight / Math.max(1, userEst)) * uShare));
          categoryItems.user_messages.push({ ...it, tokens: tok });
        }
        for (const it of initInjItems) {
          const tok = Math.max(1, Math.round((it.weight / initInjWTotal) * iShare));
          categoryItems.injected_content.push({ ...it, tokens: tok });
        }
      }
    } else if (delta < -1000) {
      compacted = true;
      compactions.push({
        step: pStep.step_index ?? pIdx,
        at: pStep.created_at || '',
        from: prevPromptTokens,
        to: promptTok,
        saved: prevPromptTokens - promptTok,
      });

      const baseline = Math.min(promptTok, currentBuckets.system_prompt + currentBuckets.tool_definitions);
      const scaleBase = currentBuckets.system_prompt + currentBuckets.tool_definitions;
      if (scaleBase > baseline && scaleBase > 0) {
        const r = baseline / scaleBase;
        currentBuckets.system_prompt = Math.round(currentBuckets.system_prompt * r);
        currentBuckets.tool_definitions = baseline - currentBuckets.system_prompt;
      }
      const remaining = Math.max(0, promptTok - (currentBuckets.system_prompt + currentBuckets.tool_definitions));
      const historyWeights = emptyBuckets();
      let prevHistTotal = 0;
      for (const k of CATEGORIES) {
        if (k === 'system_prompt' || k === 'tool_definitions') continue;
        historyWeights[k] = currentBuckets[k];
        prevHistTotal += currentBuckets[k];
      }
      const scaleRatio = prevHistTotal > 0 ? remaining / prevHistTotal : 0;
      const scaledHistory = normalizeDistribute(historyWeights, remaining);
      for (const k of CATEGORIES) {
        if (k === 'system_prompt' || k === 'tool_definitions') continue;
        currentBuckets[k] = scaledHistory[k];
      }
      // Scale modelContext proportionally & reset post-compaction speed window
      for (const mKey of Object.keys(modelContext)) {
        modelContext[mKey].thinking = Math.round(modelContext[mKey].thinking * scaleRatio);
        modelContext[mKey].reply = Math.round(modelContext[mKey].reply * scaleRatio);
        modelContext[mKey].total = modelContext[mKey].thinking + modelContext[mKey].reply;
        modelContext[mKey].postCompactTimedOut = 0;
        modelContext[mKey].postCompactTimedMs = 0;
      }
    } else if (delta > 0) {
      const weights = emptyBuckets();
      const prevP = steps[prevPlannerIdx];
      const prevModel = String(prevP.model || model);
      const prevCalls = Array.isArray(prevP.tool_calls) ? prevP.tool_calls : [];

      if (prevP.thinking) weights.thinking += estimateTokens(prevP.thinking);
      if (prevP.content) weights.assistant_reply += estimateTokens(prevP.content);
      if (prevCalls.length) weights.tool_calls += estimateTokens(JSON.stringify(prevCalls));

      let genericIdx = 0;
      const stepItems = [];
      for (let j = prevPlannerIdx + 1; j < pIdx; j++) {
        const st = steps[j];
        const stMs = parseMs(st.created_at);
        const safeStMs = Number.isFinite(stMs) ? stMs : safePMs;
        if (st.type === 'USER_INPUT') {
          const parsed = collectUserInputItems(st, j, safeStMs, 180, true);
          weights.user_messages += parsed.userWeight;
          weights.injected_content += parsed.injectedWeight;
          stepItems.push(...parsed.userItems, ...parsed.injectedItems);
        } else if (st.type === 'GENERIC') {
          const matchedTc = prevCalls[genericIdx] || null;
          genericIdx++;
          const w = estimateTokens(st.content || '') + estimateMediaTokens(st.media);
          const desc = matchedTc
            ? describeToolItem(matchedTc, knownServers)
            : { label: 'Tool output', detail: '', category: 'tool_calls', tool: 'tool' };
          weights[desc.category] += w;
          const resolvedId = matchedTc ? resolveToolIdentity(matchedTc, knownServers) : null;
          const resolvedToolKey = resolvedId?.key || null;
          const isFailed = commandFailedFromOutput(st)
            || (Number.isFinite(st.step_index) && hookErrorSteps.has(st.step_index));
          if (isFailed && resolvedToolKey && tools[resolvedToolKey]) {
            tools[resolvedToolKey].errors += 1;
          }
          stepItems.push({
            ...desc,
            skillName: resolvedId?.skillName || null,
            weight: w,
            step: st.step_index ?? j,
            at: st.created_at || '',
            ms: safeStMs,
            status: isFailed ? 'ERROR' : (st.status || 'DONE'),
          });
        } else {
          const w = estimateTokens(st.content || '');
          weights.injected_content += w;
          if (w > 0) {
            stepItems.push({
              label: st.type || 'System message',
              detail: String(st.content || '').slice(0, 180),
              category: 'injected_content',
              tool: 'system',
              weight: w,
              step: st.step_index ?? j,
              at: st.created_at || '',
              ms: safeStMs,
            });
          }
        }
      }

      const distributed = normalizeDistribute(weights, delta);
      let totalStepWeight = 0;
      for (const k of CATEGORIES) totalStepWeight += weights[k];
      for (const k of CATEGORIES) currentBuckets[k] += distributed[k];

      const prevMc = ensureModelContext(prevModel);
      prevMc.thinking += distributed.thinking;
      prevMc.reply += distributed.assistant_reply;
      prevMc.total += distributed.thinking + distributed.assistant_reply;
      if (distributed.thinking + distributed.assistant_reply > 0) {
        const prevPMs = parseMs(prevP.created_at);
        prevMc.items.push({
          step: prevP.step_index ?? prevPlannerIdx,
          at: prevP.created_at || '',
          ms: Number.isFinite(prevPMs) ? prevPMs : safePMs,
          thinkingTokens: distributed.thinking,
          replyTokens: distributed.assistant_reply,
          tokens: distributed.thinking + distributed.assistant_reply,
          preview: (prevP.content || prevP.thinking || '').replace(/\s+/g, ' ').trim().slice(0, 90),
          toolCount: prevCalls.length,
        });
      }

      if (totalStepWeight > 0) {
        for (const item of stepItems) {
          const tok = Math.round((item.weight / totalStepWeight) * delta);
          if (tok <= 0) continue;
          if (item.tool && tools[item.tool]) tools[item.tool].tokens += tok;
          if (item.skillName && skills[item.skillName]) skills[item.skillName].tokens += tok;
          if (item.path && fileActivityMap.has(item.path)) {
            fileActivityMap.get(item.path).tokens += tok;
          }
          if (categoryItems[item.category]) {
            categoryItems[item.category].push({
              group: item.group || '',
              label: item.label,
              detail: item.detail,
              tool: item.tool,
              isMcp: Boolean(item.isMcp),
              mcpServer: item.mcpServer || '',
              mcpTool: item.mcpTool || '',
              isMcpSchema: Boolean(item.isMcpSchema),
              isCommand: Boolean(item.isCommand),
              commandName: item.commandName || '',
              tokens: tok,
              itemCount: item.itemCount || 1,
              step: item.step,
              at: item.at,
              ms: item.ms,
              status: item.status,
              mediaCount: item.mediaCount || 0,
            });
          }
          itemContributions.push({
            label: item.label,
            detail: item.detail,
            category: item.category,
            tool: item.tool,
            tokens: tok,
            step: item.step,
          });
        }
      }
    }

    // Cumulative composition
    const promptShare = normalizeDistribute(currentBuckets, promptTok);
    for (const k of CATEGORIES) cumulativeBuckets[k] += promptShare[k];

    if (outTok > 0) {
      cumulativeBuckets.thinking += stepOutThink;
      cumulativeBuckets.assistant_reply += stepOutReply;
      cumulativeBuckets.tool_calls += stepOutTool;
    }

    // --- Real measured timing (DB first, then transcript/hook; never estimated) ---
    const firstChildIdx = pIdx + 1 < nextPIdx ? pIdx + 1 : -1;
    const lastChildIdx = nextPIdx - 1 > pIdx ? nextPIdx - 1 : -1;
    const lastGenericStep = childGenerics.length ? childGenerics[childGenerics.length - 1] : null;
    const hasMeasuredEnd = Boolean(lastGenericStep)
      || (firstChildIdx >= 0 && steps[firstChildIdx].type !== 'USER_INPUT');

    let callModelMs = 0;
    let stepTtftMs = 0;
    let stepStreamMs = 0;
    let stepThinkingMs = 0;
    let stepOutputGenMs = 0;

    if (dbStep?.isPlanner && dbStep.totalMs > 0) {
      callModelMs = Math.min(MAX_DB_CALL_MS, dbStep.totalMs);
      stepTtftMs = Math.min(callModelMs, Math.max(0, dbStep.ttftMs || 0));
      stepStreamMs = Math.max(0, Math.min(callModelMs - stepTtftMs, dbStep.streamMs || 0));
      stepThinkingMs = Math.min(stepStreamMs, Math.max(0, dbStep.thinkingMs || 0));
      stepOutputGenMs = Math.max(0, stepStreamMs - stepThinkingMs);
      modelWaitMs += stepTtftMs;
      thinkingMs += stepThinkingMs;
      modelGenMs += (stepTtftMs + stepStreamMs > 0) ? stepOutputGenMs : callModelMs;
    } else {
      if (hasMeasuredEnd) {
        const endRefStep = lastGenericStep || steps[firstChildIdx];
        const childMs = parseMs(endRefStep.created_at);
        if (Number.isFinite(pMs) && Number.isFinite(childMs) && childMs >= pMs) {
          callModelMs = Math.min(MAX_ACTIVE_GAP_MS, childMs - pMs);
        }
      } else if (tcs.length === 0) {
        const hookIv = matchHookInterval(hookIntervals, pStep.step_index ?? pIdx, pMs);
        if (hookIv) {
          callModelMs = Math.min(MAX_ACTIVE_GAP_MS, hookIv.durationMs);
        }
      }
      if (callModelMs > 0) {
        modelGenMs += callModelMs;
      }
    }

    if (callModelMs > 0) {
      modelsUsed[model].durationMs += callModelMs;
      modelsUsed[model].timedDurationMs += callModelMs;
      modelsUsed[model].timedOutputTokens += outTok;
      mc.postCompactTimedOut += outTok;
      mc.postCompactTimedMs += callModelMs;
      totalTimedModelMs += callModelMs;
      totalTimedOutput += outTok;
      if (outTok > 0) {
        const callRate = Math.round((outTok / (callModelMs / 1000)) * 10) / 10;
        if (callRate > maxTokPerSecAny) maxTokPerSecAny = callRate;
        if (callModelMs >= 200 && outTok >= 10 && callRate > maxTokPerSec) {
          maxTokPerSec = callRate;
        }
      }
    }

    let measuredDbToolPhaseMs = 0;
    if (childGenerics.length > 0 && dbTelemetry?.steps) {
      const batchIntervals = [];
      let sumToolDur = 0;
      for (let g = 0; g < childGenerics.length; g++) {
        const dts = getDbStep(childGenericIndices[g], childGenerics[g]);
        if (!dts || dts.isPlanner) continue;
        if (dts.toolExecMs > 0) sumToolDur += dts.toolExecMs;
        if (Array.isArray(dts.runningIntervals) && dts.runningIntervals.length) {
          batchIntervals.push(...dts.runningIntervals);
        } else if (dts.endMs > 0 && dts.toolExecMs > 0) {
          batchIntervals.push([dts.endMs - dts.toolExecMs, dts.endMs]);
        }
      }
      if (batchIntervals.length > 0) {
        measuredDbToolPhaseMs = Math.min(MAX_DB_CALL_MS, mergeIntervalsDurationMs(batchIntervals));
      } else if (sumToolDur > 0) {
        measuredDbToolPhaseMs = Math.min(MAX_DB_CALL_MS, sumToolDur);
      }
    }

    if (measuredDbToolPhaseMs > 0) {
      toolExecMs += measuredDbToolPhaseMs;
    } else if (firstChildIdx >= 0 && tcs.length > 0 && nextPIdx < steps.length) {
      const startToolMs = parseMs((lastGenericStep || steps[firstChildIdx]).created_at);
      let endToolMs = parseMs(steps[nextPIdx].created_at);
      for (let j = firstChildIdx; j < nextPIdx; j++) {
        if (steps[j].type === 'USER_INPUT') {
          endToolMs = parseMs(steps[Math.max(firstChildIdx, j - 1)].created_at);
          break;
        }
      }
      if (Number.isFinite(startToolMs) && Number.isFinite(endToolMs) && endToolMs >= startToolMs) {
        toolExecMs += Math.min(MAX_ACTIVE_GAP_MS, endToolMs - startToolMs);
      }
    } else if (lastChildIdx > firstChildIdx && firstChildIdx >= 0) {
      const sMs = parseMs(steps[firstChildIdx].created_at);
      const eMs = parseMs(steps[lastChildIdx].created_at);
      if (Number.isFinite(sMs) && Number.isFinite(eMs) && eMs >= sMs) {
        otherMs += Math.min(15_000, eMs - sMs);
      }
    }

    const callTokPerSec = callModelMs > 0 ? Math.round((outTok / (callModelMs / 1000)) * 10) / 10 : 0;

    timeline.push({
      step: pStep.step_index ?? pIdx,
      turn: currentTurnIndex,
      at: pStep.created_at || '',
      ms: safePMs,
      model,
      promptTokens: promptTok,
      inputTokens: inTok,
      cacheReadTokens: cacheTok,
      outputTokens: outTok,
      delta,
      compacted,
      durationMs: callModelMs,
      ttftMs: stepTtftMs,
      streamMs: stepStreamMs,
      thinkingMs: stepThinkingMs,
      tokPerSec: callTokPerSec,
      toolCount: tcs.length,
      tools: tcs.map((t) => t?.name || 'tool'),
      preview: (pStep.content || pStep.thinking || '').replace(/\s+/g, ' ').trim().slice(0, 100),
      buckets: {
        system: currentBuckets.system_prompt + currentBuckets.tool_definitions,
        user: currentBuckets.user_messages + currentBuckets.injected_content,
        skill: currentBuckets.skill_injection,
        tools: currentBuckets.tool_calls,
        model: currentBuckets.thinking + currentBuckets.assistant_reply,
      },
    });

    prevPromptTokens = promptTok;
    prevPlannerIdx = pIdx;
  }

  // Account for final PLANNER_RESPONSE output tokens in live currentContext & modelContext
  let currentContext = lastPromptTokens;
  if (plannerIndices.length > 0 && lastOutputTokens > 0) {
    const lastPIdx = plannerIndices[plannerIndices.length - 1];
    const lastP = steps[lastPIdx];
    const lastDbStep = getDbStep(lastPIdx, lastP);
    const lastModel = String(lastP.model || latestModel || 'default');
    const lastTcs = Array.isArray(lastP.tool_calls) ? lastP.tool_calls : [];
    let lastOutDist;
    if (lastDbStep?.isPlanner && lastDbStep.thinkingTokens != null) {
      lastOutDist = emptyBuckets();
      const thTok = Math.min(lastOutputTokens, Math.max(0, lastDbStep.thinkingTokens));
      const remTok = Math.max(0, lastOutputTokens - thTok);
      lastOutDist.thinking = thTok;
      if (lastTcs.length === 0) {
        lastOutDist.assistant_reply = remTok;
      } else if (!lastP.content) {
        lastOutDist.tool_calls = remTok;
      } else {
        const wRep = estimateTokens(lastP.content);
        const wTc = estimateTokens(JSON.stringify(lastTcs));
        const wSum = wRep + wTc;
        lastOutDist.tool_calls = wSum > 0 ? Math.round((wTc / wSum) * remTok) : 0;
        lastOutDist.assistant_reply = Math.max(0, remTok - lastOutDist.tool_calls);
      }
    } else {
      const outW = emptyBuckets();
      if (lastP.thinking) outW.thinking = estimateTokens(lastP.thinking);
      if (lastP.content) outW.assistant_reply = estimateTokens(lastP.content);
      if (lastTcs.length) {
        outW.tool_calls = estimateTokens(JSON.stringify(lastTcs));
      }
      if (outW.thinking + outW.assistant_reply + outW.tool_calls === 0) outW.assistant_reply = 1;
      lastOutDist = normalizeDistribute(outW, lastOutputTokens);
    }
    for (const k of CATEGORIES) currentBuckets[k] += lastOutDist[k];
    currentContext += lastOutputTokens;

    const lastMc = ensureModelContext(lastModel);
    lastMc.thinking += lastOutDist.thinking;
    lastMc.reply += lastOutDist.assistant_reply;
    lastMc.total += lastOutDist.thinking + lastOutDist.assistant_reply;
    if (lastOutDist.thinking + lastOutDist.assistant_reply > 0) {
      const lpMs = parseMs(lastP.created_at);
      lastMc.items.push({
        step: lastP.step_index ?? lastPIdx,
        at: lastP.created_at || '',
        ms: Number.isFinite(lpMs) ? lpMs : lastMs,
        thinkingTokens: lastOutDist.thinking,
        replyTokens: lastOutDist.assistant_reply,
        tokens: lastOutDist.thinking + lastOutDist.assistant_reply,
        preview: (lastP.content || lastP.thinking || '').replace(/\s+/g, ' ').trim().slice(0, 90),
        toolCount: lastTcs.length,
      });
    }
  }

  categoryItems.skill_injection = mergeSkillItems(categoryItems.skill_injection, currentBuckets.skill_injection);
  categoryItems.tool_calls = mergeToolCallItems(categoryItems.tool_calls, currentBuckets.tool_calls);
  categoryItems.user_messages = mergeUserMessageItems(categoryItems.user_messages, currentBuckets.user_messages);
  categoryItems.injected_content = mergeInjectedItems(categoryItems.injected_content, currentBuckets.injected_content);

  const modelsBreakdown = buildModelsBreakdown(modelsUsed);
  const modelComposition = buildModelComposition(modelContext, modelsUsed);

  const activeCoreMs = modelWaitMs + thinkingMs + modelGenMs + toolExecMs;
  const activeMs = activeCoreMs + otherMs;
  const outputTokPerSec = totalTimedModelMs > 0
    ? Math.round((totalTimedOutput / (totalTimedModelMs / 1000)) * 10) / 10
    : 0;
  const resolvedMaxTokPerSec = Math.max(outputTokPerSec, maxTokPerSec || maxTokPerSecAny || 0);

  const totalPromptAll = totalInput + totalCacheRead;
  const cacheHitRate = totalPromptAll > 0 ? totalCacheRead / totalPromptAll : 0;
  const totalTokens = totalPromptAll + totalOutput;

  const largestItems = itemContributions
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 12);

  const fileActivity = [...fileActivityMap.values()]
    .sort((a, b) => b.lastStep - a.lastStep);

  return {
    conversationId,
    title: resolvedTitle,
    workspace: resolvedWorkspace,
    workspaceUri: workspaceUri || '',
    model: latestModel || 'default',
    contextWindow: dbTelemetry?.contextWindow || 0,
    modelsUsed,
    modelsBreakdown,
    turns,
    steps: steps.length,
    modelCalls: plannerIndices.length,
    toolCallsCount: totalToolCalls,
    firstAt: Number.isFinite(firstMs) ? new Date(firstMs).toISOString() : '',
    lastAt: lastMs ? new Date(lastMs).toISOString() : '',
    firstMs,
    lastMs,
    dateKey: toLocalDateKey(lastMs),
    lastUserMessage: lastUserMessage.replace(/\s+/g, ' ').slice(0, 120),
    currentContext,
    lastPromptTokens,
    lastOutputTokens,
    peakContext,
    totals: {
      inputTokens: totalInput,
      cacheReadTokens: totalCacheRead,
      outputTokens: totalOutput,
      totalTokens,
      cacheHitRate,
    },
    composition: currentBuckets,
    cumulativeComposition: cumulativeBuckets,
    modelComposition,
    categoryItems,
    timing: {
      activeMs,
      modelWaitMs,
      thinkingMs,
      modelGenMs,
      toolExecMs,
      otherMs,
      outputTokPerSec,
      maxTokPerSec: resolvedMaxTokPerSec,
      source: dbTelemetry ? 'db' : 'transcript',
    },
    timeline,
    compactions,
    skills,
    tools,
    commands,
    fileActivity,
    commandLog: commandLog.reverse().slice(0, 80),
    byDate,
    byHour,
    largestItems,
    hookTelemetry,
  };
}
