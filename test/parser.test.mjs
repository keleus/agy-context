import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CATEGORIES,
  extractCommands,
  extractMcpSchemaInfo,
  extractMcpToolInfo,
  extractPrimaryCommand,
  extractSkillName,
  parseTrace,
  parseTranscript,
  splitUserInput,
  summarizeHookTelemetry,
} from '../sidecars/context_monitor/parser.mjs';
import { buildUsageSeries } from '../sidecars/context_monitor/main.mjs';

// 1. splitUserInput separates <USER_REQUEST> from metadata blocks
{
  const raw = '<USER_REQUEST>\n帮我看下上下文\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime: 2026\n</ADDITIONAL_METADATA>';
  const { userText, injectedText } = splitUserInput(raw);
  assert.equal(userText, '帮我看下上下文');
  assert.ok(injectedText.includes('ADDITIONAL_METADATA'));
}

// 2. extractSkillName detects SKILL.md reads (including double-quoted compact args)
{
  assert.equal(extractSkillName('/Users/a/.gemini/antigravity/builtin/skills/plugin/SKILL.md'), 'plugin');
  assert.equal(extractSkillName('"/Users/a/.gemini/config/skills/code-review/SKILL.md"'), 'code-review');
  assert.equal(extractSkillName('/Users/a/project/README.md'), null);
}

// 3. extractCommands parses pipelines, chains, env prefixes, wrappers, paths, and ignores multiline quoted scripts
{
  const cmds = extractCommands('FOO=1 /usr/bin/git status && sudo npm test | grep pass; env -i node index.mjs');
  assert.deepEqual(cmds, ['git', 'npm', 'grep', 'node']);

  const multiline = `/usr/bin/python3 -c '\nimport json\nfake-cmd foo\n' && jq '.a | .b'`;
  assert.deepEqual(extractCommands(multiline), ['python3', 'jq']);
}

// 4. Synthetic multi-turn transcript with skill load, tool calls, and compaction
{
  const lines = [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-20T10:00:00Z',
      content: '<USER_REQUEST>\nFix CSS bug\n</USER_REQUEST>\n<ADDITIONAL_METADATA>meta</ADDITIONAL_METADATA>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-20T10:00:02Z',
      model: 'gemini-4-neon-high',
      input_tokens: 10000,
      cache_read_tokens: 0,
      output_tokens: 400,
      thinking: 'Let me read the skill and check git status.',
      tool_calls: [
        { name: 'read_file', args: { Path: '/Users/dev/.gemini/antigravity/builtin/skills/plugin/SKILL.md' } },
        { name: 'run_command', args: { CommandLine: 'git status && ls -la /Users/dev/git/my-app' } },
      ],
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-20T10:00:03Z',
      content: 'x'.repeat(8000), // Skill content
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-20T10:00:04Z',
      content: 'y'.repeat(4000), // Command output
    },
    {
      step_index: 4,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-20T10:00:08Z',
      model: 'gemini-4-neon-high',
      input_tokens: 4000,
      cache_read_tokens: 10000,
      output_tokens: 600,
      thinking: 'Found it.',
      content: 'All fixed!',
    },
    // Compaction event on next call (prompt drops from 14000 to 6000)
    {
      step_index: 5,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-20T10:01:00Z',
      content: '<USER_REQUEST>\nContinue\n</USER_REQUEST>',
    },
    {
      step_index: 6,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-20T10:01:05Z',
      model: 'gemini-4-neon-high',
      input_tokens: 6000,
      cache_read_tokens: 0,
      output_tokens: 200,
      content: 'Continuing after compaction.',
    },
  ];
  const jsonl = `${lines.map((l) => JSON.stringify(l)).join('\n')}\n{"torn_line`;
  const parsed = parseTranscript(jsonl, { conversationId: '11111111-2222-3333-4444-555555555555' });

  assert.equal(parsed.turns, 2);
  assert.equal(parsed.modelCalls, 3);
  assert.equal(parsed.toolCallsCount, 2);
  assert.equal(parsed.workspace, 'my-app');
  assert.equal(parsed.title, 'Fix CSS bug');
  assert.equal(parsed.lastUserMessage, 'Continue');
  assert.equal(parsed.compactions.length, 1);
  assert.equal(parsed.compactions[0].from, 14000);
  assert.equal(parsed.compactions[0].to, 6000);
  assert.equal(parsed.skills.plugin.count, 1);
  assert.equal(parsed.commands.git.count, 1);
  assert.equal(parsed.commands.ls.count, 1);

  // Composition sum must match exact currentContext (6000 + 200)
  const compSum = CATEGORIES.reduce((a, k) => a + parsed.composition[k], 0);
  assert.equal(compSum, parsed.currentContext);
  assert.equal(parsed.currentContext, 6200);

  // Cumulative composition sum must match exact totalTokens
  const cumSum = CATEGORIES.reduce((a, k) => a + parsed.cumulativeComposition[k], 0);
  assert.equal(cumSum, parsed.totals.totalTokens);
  assert.equal(parsed.totals.totalTokens, 10000 + 400 + 14000 + 600 + 6000 + 200);

  // Per-model breakdown, expandable category items, command log, and timeline buckets
  assert.equal(parsed.modelComposition.length, 1);
  assert.equal(parsed.modelComposition[0].model, 'gemini-4-neon-high');
  assert.equal(parsed.modelComposition[0].total, parsed.composition.thinking + parsed.composition.assistant_reply);
  assert.ok(Array.isArray(parsed.modelComposition[0].typeBreakdown));
  const tbSum = parsed.modelComposition[0].typeBreakdown.reduce((a, x) => a + x.tokens, 0);
  assert.equal(tbSum, parsed.modelComposition[0].total);
  assert.ok(!parsed.modelComposition[0].typeBreakdown.some((x) => x.type === 'cache_read' || x.type === 'text_input' || x.type === 'image_input' || x.type === 'tool_call'));
  assert.ok(parsed.modelComposition[0].typeBreakdown.some((x) => x.type === 'thinking' || x.type === 'reply'));
  assert.equal(parsed.categoryItems.user_messages.length, 1);
  assert.equal(parsed.categoryItems.user_messages[0].group, 'text');
  assert.equal(parsed.categoryItems.user_messages[0].count, 1);
  assert.equal(parsed.categoryItems.user_messages[0].step, 0);
  assert.equal(parsed.categoryItems.system_prompt.length, 0);
  assert.equal(parsed.categoryItems.tool_definitions.length, 0);
  assert.equal(parsed.categoryItems.skill_injection.length, 1);
  assert.equal(parsed.categoryItems.skill_injection[0].label, 'plugin');
  assert.equal(parsed.categoryItems.skill_injection[0].tool, 'skill');
  assert.equal(parsed.categoryItems.skill_injection[0].count, 1);
  assert.equal(parsed.categoryItems.tool_calls.length, 1);
  assert.equal(parsed.categoryItems.tool_calls[0].isCommandGroup, true);
  assert.equal(parsed.categoryItems.tool_calls[0].count, 1);
  assert.equal(parsed.categoryItems.tool_calls[0].children.length, 1);
  assert.equal(parsed.categoryItems.tool_calls[0].children[0].label, 'git');
  assert.equal(parsed.categoryItems.tool_calls[0].children[0].isCommand, true);
  assert.equal(parsed.commandLog.length, 1);
  assert.equal(parsed.commandLog[0].failed, false);
  assert.ok(parsed.timeline[0].buckets);
  assert.ok(Object.keys(parsed.byHour).length >= 1);

  // Full chronological trace parsing (input + injected + compaction + skill + model + tool)
  const trace = parseTrace(jsonl);
  assert.equal(trace.counts.input, 2);
  assert.equal(trace.counts.system, 2); // ADDITIONAL_METADATA + COMPACTION
  assert.equal(trace.counts.skill, 1);  // SKILL.md read separated as skill
  assert.equal(trace.counts.model, 3);
  assert.equal(trace.counts.tool, 1);   // run_command
  assert.equal(trace.items.length, 9);
  const inj = trace.details.find((d) => d.kind === 'system' && d.systemType === 'ADDITIONAL_METADATA');
  assert.equal(inj.content, 'meta');
  const compEv = trace.details.find((d) => d.kind === 'system' && d.systemType === 'COMPACTION');
  assert.ok(compEv);
  const firstSkill = trace.details.find((d) => d.kind === 'skill');
  assert.equal(firstSkill.skillName, 'plugin');
  assert.equal(firstSkill.result.length, 8000);
}

// 4b. Dynamic usage series bucketing (hour / day / week / month / year)
{
  const hourlyMap = {
    '2026-11-20 09': { tokens: 5000, inputTokens: 4000, cacheReadTokens: 800, outputTokens: 200, models: {} },
    '2026-11-20 21': { tokens: 12000, inputTokens: 2000, cacheReadTokens: 9500, outputTokens: 500, models: {} },
  };
  const sToday = buildUsageSeries({ range: 'today', startKey: '2026-11-20', endKey: '2026-11-20', dailyMap: {}, hourlyMap });
  assert.equal(sToday.granularity, 'hour');
  assert.equal(sToday.points.length, 24);
  assert.equal(sToday.points[9].tokens, 5000);
  assert.equal(sToday.points[21].tokens, 12000);

  const s7d = buildUsageSeries({ range: '7d', startKey: '2026-11-14', endKey: '2026-11-20', dailyMap: {}, hourlyMap: {} });
  assert.equal(s7d.granularity, 'day');
  assert.equal(s7d.points.length, 7);

  const s30d = buildUsageSeries({ range: '30d', startKey: '2026-10-22', endKey: '2026-11-20', dailyMap: {}, hourlyMap: {} });
  assert.equal(s30d.granularity, 'day');
  assert.equal(s30d.points.length, 30);

  const sAllWeek = buildUsageSeries({
    range: 'all',
    dailyMap: { '2026-08-01': { tokens: 100, models: {} }, '2026-11-20': { tokens: 200, models: {} } },
    hourlyMap: {},
    minDateKey: '2026-08-01',
    maxDateKey: '2026-11-20',
  });
  assert.equal(sAllWeek.granularity, 'week');
  assert.ok(sAllWeek.points.length >= 15 && sAllWeek.points.length <= 20);

  const sAllMonth = buildUsageSeries({
    range: 'all',
    dailyMap: { '2025-11-01': { tokens: 100, models: {} }, '2026-11-20': { tokens: 200, models: {} } },
    hourlyMap: {},
    minDateKey: '2025-11-01',
    maxDateKey: '2026-11-20',
  });
  assert.equal(sAllMonth.granularity, 'month');
  assert.equal(sAllMonth.points.length, 13);

  const sAllYear = buildUsageSeries({
    range: 'all',
    dailyMap: { '2023-01-10': { tokens: 100, models: {} }, '2026-11-20': { tokens: 200, models: {} } },
    hourlyMap: {},
    minDateKey: '2023-01-10',
    maxDateKey: '2026-11-20',
  });
  assert.equal(sAllYear.granularity, 'year');
  assert.equal(sAllYear.points.length, 4);
}

// 5. parseTrace: time_context badge & final reply does not count USER_INPUT idle gap
{
  const lines = [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-20T14:00:00Z',
      content: '<USER_REQUEST>\nhello\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-20T22:00:00+08:00.\n\nThe user has uploaded 2 image(s):\n- /tmp/a.png\n</ADDITIONAL_METADATA>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-20T14:00:01Z',
      model: 'gemini-4-neon-high',
      input_tokens: 1000,
      cache_read_tokens: 0,
      output_tokens: 400,
      tool_calls: [{ name: 'read_file', args: { Path: '"/tmp/a.txt"' } }],
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-20T14:00:05Z',
      content: 'ok',
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-20T14:00:06Z',
      model: 'gemini-4-neon-high',
      input_tokens: 200,
      cache_read_tokens: 1400,
      output_tokens: 600,
      content: 'Final answer here',
    },
    {
      step_index: 4,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-20T14:05:06Z',
      content: '<USER_REQUEST>\nnext question\n</USER_REQUEST>',
    },
  ];
  const raw = lines.map((x) => JSON.stringify(x)).join('\n');
  const tr = parseTrace(raw);
  const metaItem = tr.items.find((x) => x.kind === 'system' && x.systemType === 'ADDITIONAL_METADATA');
  assert.ok(metaItem);
  assert.equal(metaItem.systemBadge, 'time');
  assert.deepEqual(metaItem.systemBadges, ['time', 'image']);

  const modelItems = tr.items.filter((x) => x.kind === 'model');
  assert.equal(modelItems.length, 2);
  // Tool-calling planner step has exact 4s duration & 100 tok/s
  assert.equal(modelItems[0].durationMs, 4000);
  assert.equal(modelItems[0].tokPerSec, 100);
  assert.equal(modelItems[0].timingUnavailable, false);
  // Final reply followed by USER_INPUT 5 min later must NOT count idle gap!
  assert.equal(modelItems[1].durationMs, 0);
  assert.equal(modelItems[1].tokPerSec, 0);
  assert.equal(modelItems[1].timingUnavailable, true);

  // Session aggregate speed must only average measured calls (100 tok/s)
  const parsed = parseTranscript(raw, { conversationId: 'test-final-timing' });
  assert.equal(parsed.timing.outputTokPerSec, 100);
  assert.equal(parsed.modelsBreakdown[0].tokPerSec, 100);
  // System prompt & tool definitions have no fabricated details
  assert.deepEqual(parsed.categoryItems.system_prompt, []);
  assert.deepEqual(parsed.categoryItems.tool_definitions, []);
  // Combined ADDITIONAL_METADATA (time + image) splits & merges into separate injected_content groups
  const injGroups = parsed.categoryItems.injected_content.map((x) => x.group).sort();
  assert.deepEqual(injGroups, ['image', 'time']);

  // When lifecycle hook timings are present, final reply gets exact ms duration & throughput,
  // and PostToolUse enriches tool timing & host error.
  const hookTimings = [
    { ev: 'SessionStart', ts: Date.parse('2026-11-20T14:00:00.000Z'), model: 'gemini-4-neon-high' },
    { ev: 'PreInvocation', ts: Date.parse('2026-11-20T14:00:01.000Z'), inv: 1, steps: 1, model: 'gemini-4-neon-high' },
    { ev: 'PostToolUse', ts: Date.parse('2026-11-20T14:00:05.750Z'), step: 2, tool: 'read_file', toolId: 't1', err: 'permission denied' },
    { ev: 'PostInvocation', ts: Date.parse('2026-11-20T14:00:05.800Z'), inv: 1, steps: 1 },
    { ev: 'PreInvocation', ts: Date.parse('2026-11-20T14:00:06.100Z'), inv: 2, steps: 3, model: 'gemini-4-neon-high' },
    { ev: 'Stop', ts: Date.parse('2026-11-20T14:00:09.300Z'), reason: 'NO_TOOL_CALL' },
  ];
  const trWithHook = parseTrace(raw, { hookTimings });
  const hookedModels = trWithHook.items.filter((x) => x.kind === 'model');
  assert.equal(hookedModels[1].durationMs, 3200);
  assert.equal(hookedModels[1].tokPerSec, 187.5);
  assert.equal(hookedModels[1].timingSource, 'hook');
  assert.equal(hookedModels[1].timingUnavailable, false);

  const hookedTool = trWithHook.details.find((x) => x.kind === 'tool' && x.step === 2);
  assert.ok(hookedTool);
  assert.equal(hookedTool.durationMs, 750);
  assert.equal(hookedTool.hasError, true);
  assert.equal(hookedTool.hookError, 'permission denied');

  const parsedWithHook = parseTranscript(raw, { conversationId: 'test-final-timing', hookTimings });
  // Total timed output = 400 + 600 = 1000, total timed duration = 4.0s + 3.2s = 7.2s -> 138.9 tok/s
  assert.equal(parsedWithHook.timing.outputTokPerSec, 138.9);
  assert.equal(parsedWithHook.modelsBreakdown[0].tokPerSec, 138.9);
  assert.equal(parsedWithHook.hookTelemetry.hasData, true);
  assert.equal(parsedWithHook.hookTelemetry.turnStats.completedTurns, 1);
  assert.equal(parsedWithHook.hookTelemetry.turnStats.avgTurnMs, 8300);
  assert.equal(parsedWithHook.hookTelemetry.turnStats.avgInvocations, 2);
  assert.equal(parsedWithHook.hookTelemetry.turnStats.reasons.NO_TOOL_CALL, 1);
  assert.equal(parsedWithHook.hookTelemetry.toolStats.calls, 1);
  assert.equal(parsedWithHook.hookTelemetry.toolStats.errors, 1);
  // Hook-flagged failed tool call is separated into a failed row in tool_calls
  assert.equal(parsedWithHook.categoryItems.tool_calls.length, 1);
  assert.equal(parsedWithHook.categoryItems.tool_calls[0].failed, true);
  assert.equal(parsedWithHook.categoryItems.tool_calls[0].status, 'ERROR');
  // Without hook error, the same read_file call is a succeeded row
  assert.equal(parsed.categoryItems.tool_calls[0].failed, false);
  assert.equal(parsed.categoryItems.tool_calls[0].status, 'DONE');

  // Live in-flight state detection (generating & tools)
  const now = Date.parse('2026-11-20T14:00:15.000Z');
  const genLive = summarizeHookTelemetry([
    ...hookTimings,
    { ev: 'PreInvocation', ts: Date.parse('2026-11-20T14:00:11.000Z'), inv: 1, model: 'gemini-4-neon-high' },
  ], now);
  assert.equal(genLive.liveState.active, true);
  assert.equal(genLive.liveState.phase, 'generating');

  const toolLive = summarizeHookTelemetry([
    ...hookTimings,
    { ev: 'PreInvocation', ts: Date.parse('2026-11-20T14:00:11.000Z'), inv: 1, model: 'gemini-4-neon-high' },
    { ev: 'PostToolUse', ts: Date.parse('2026-11-20T14:00:14.000Z'), step: 5, tool: 'run_command' },
  ], now);
  assert.equal(toolLive.liveState.active, true);
  assert.equal(toolLive.liveState.phase, 'tools');
  assert.equal(toolLive.liveState.lastTool, 'run_command');

  // Reconciling PreInvocation against transcript steps:
  // Only show 'generating' while the model call itself is in flight; once
  // PLANNER_RESPONSE is written (e.g. blocked on ask_question), exit 'generating'.
  {
    const t0 = Date.parse('2026-11-21T08:00:00.000Z');
    const tNow = Date.parse('2026-11-21T08:00:25.000Z');
    const preOnlyHooks = [
      { ev: 'PreInvocation', ts: t0 + 1000, inv: 0, steps: 1, model: 'gemini-4-neon-high' },
    ];
    const userOnlyJsonl = JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-21T08:00:00Z',
      content: '<USER_REQUEST>\nHelp me decide\n</USER_REQUEST>',
    });

    // 1) Model still generating (no PLANNER_RESPONSE at step >= 1 yet)
    const trGen = parseTrace(userOnlyJsonl, { hookTimings: preOnlyHooks, nowMs: tNow });
    assert.equal(trGen.liveState.active, true);
    assert.equal(trGen.liveState.phase, 'generating');

    // 2) Model finished and called blocking tool ask_question (PostToolUse has not fired yet)
    const askJsonl = [
      userOnlyJsonl,
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T08:00:01Z',
        model: 'gemini-4-neon-high',
        input_tokens: 1000,
        cache_read_tokens: 0,
        output_tokens: 120,
        tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Proceed?' }] } }],
      }),
    ].join('\n');
    const trAsk = parseTrace(askJsonl, { hookTimings: preOnlyHooks, nowMs: tNow });
    assert.equal(trAsk.liveState.active, true);
    assert.equal(trAsk.liveState.phase, 'tools');
    assert.equal(trAsk.liveState.lastTool, 'ask_question');
    const parsedAsk = parseTranscript(askJsonl, { conversationId: 'test-ask-live', hookTimings: preOnlyHooks, nowMs: tNow });
    assert.equal(parsedAsk.hookTelemetry.liveState.phase, 'tools');

    // 3) Model finished a final reply (no tool calls) even before Stop hook lands
    const replyJsonl = [
      userOnlyJsonl,
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-21T08:00:01Z',
        model: 'gemini-4-neon-high',
        input_tokens: 1000,
        cache_read_tokens: 0,
        output_tokens: 80,
        content: 'All done!',
      }),
    ].join('\n');
    const trReply = parseTrace(replyJsonl, { hookTimings: preOnlyHooks, nowMs: tNow });
    assert.equal(trReply.liveState.active, false);
    assert.equal(trReply.liveState.phase, 'idle');

    // 4) Next invocation after tool finishes resumes 'generating'
    const afterAskJsonl = [
      askJsonl,
      JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-21T08:00:18Z',
        content: 'User answered: Yes',
      }),
    ].join('\n');
    const nextInvHooks = [
      ...preOnlyHooks,
      { ev: 'PostToolUse', ts: t0 + 18500, step: 2, tool: 'ask_question' },
      { ev: 'PostInvocation', ts: t0 + 18600, inv: 0, steps: 1 },
      { ev: 'PreInvocation', ts: t0 + 19000, inv: 1, steps: 3, model: 'gemini-4-neon-high' },
    ];
    const trNextGen = parseTrace(afterAskJsonl, { hookTimings: nextInvHooks, nowMs: tNow });
    assert.equal(trNextGen.liveState.active, true);
    assert.equal(trNextGen.liveState.phase, 'generating');

    // 5) Reverted branch: superseded PLANNER_RESPONSE at step 2 must not suppress 'generating'
    const revertedGenJsonl = [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-21T08:00:00Z', content: '<USER_REQUEST>\nkeep\n</USER_REQUEST>' },
      { step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-21T08:00:05Z', content: '<USER_REQUEST>\nold\n</USER_REQUEST>' },
      { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-21T08:00:06Z', model: 'gemini-4', input_tokens: 100, cache_read_tokens: 0, output_tokens: 20, content: 'old reply' },
      { step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-21T08:00:20Z', content: '<USER_REQUEST>\nnew\n</USER_REQUEST>' },
    ].map((x) => JSON.stringify(x)).join('\n');
    const revHooks = [
      { ev: 'PreInvocation', ts: t0 + 21000, inv: 0, steps: 2, model: 'gemini-4-neon-high' },
    ];
    const trRevGen = parseTrace(revertedGenJsonl, { hookTimings: revHooks, nowMs: tNow });
    assert.equal(trRevGen.liveState.active, true);
    assert.equal(trRevGen.liveState.phase, 'generating');

    // 6) Legacy PreInvocation without steps field falls back safely to latest active PLANNER_RESPONSE
    const legacyHooks = [
      { ev: 'PreInvocation', ts: t0 + 1400, inv: 0, model: 'gemini-4-neon-high' },
    ];
    const trLegacyAsk = parseTrace(askJsonl, { hookTimings: legacyHooks, nowMs: tNow });
    assert.equal(trLegacyAsk.liveState.active, true);
    assert.equal(trLegacyAsk.liveState.phase, 'tools');
    assert.equal(trLegacyAsk.liveState.lastTool, 'ask_question');
  }

  // Reverted branch detection: append-only log reusing step_index marks superseded lines reverted
  const revertLines = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-20T15:00:00Z', content: '<USER_REQUEST>\nkeep me\n</USER_REQUEST>' },
    { step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-20T15:01:00Z', content: '<USER_REQUEST>\nreverted prompt\n</USER_REQUEST>' },
    { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-20T15:01:02Z', model: 'gemini-4', input_tokens: 1000, cache_read_tokens: 0, output_tokens: 50, content: 'old reply' },
    { step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-20T15:02:00Z', content: '<USER_REQUEST>\nnew prompt\n</USER_REQUEST>' },
    { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-20T15:02:02Z', model: 'gemini-4', input_tokens: 1000, cache_read_tokens: 0, output_tokens: 80, content: 'new reply' },
  ];
  const revTrace = parseTrace(revertLines.map((x) => JSON.stringify(x)).join('\n'));
  assert.equal(revTrace.items.length, 5);
  assert.equal(revTrace.items[0].reverted, false); // step 0 kept
  assert.equal(revTrace.items[1].reverted, true);  // old step 1 reverted
  assert.equal(revTrace.items[2].reverted, true);  // old step 2 reverted
  assert.equal(revTrace.items[3].reverted, false); // new step 1 active
  assert.equal(revTrace.items[4].reverted, false); // new step 2 active
}

// 5b. MCP & direct command classification in tool_calls, tools, and parseTrace
{
  // Unit helpers
  assert.deepEqual(
    extractMcpSchemaInfo('/Users/dev/.gemini/antigravity/mcp/magpie/chrome-devtools__click.json'),
    {
      server: 'magpie',
      tool: 'chrome-devtools__click.json',
      isSchema: true,
      isResource: false,
      path: '/Users/dev/.gemini/antigravity/mcp/magpie/chrome-devtools__click.json',
    },
  );
  assert.equal(extractMcpSchemaInfo('"/Users/dev/.gemini/antigravity/mcp/magpie/instructions.md"')?.tool, 'instructions.md');
  assert.equal(extractMcpSchemaInfo('/Users/dev/git/my-app/mcp/server/config.json'), null);

  assert.deepEqual(
    extractMcpToolInfo({
      name: 'call_mcp_tool',
      args: { ServerName: '"magpie"', ToolName: '"run_code"', Arguments: { code: '1+1' } },
    }),
    { server: 'magpie', tool: 'run_code', isSchema: false, isResource: false },
  );
  assert.deepEqual(
    extractMcpToolInfo(
      { name: 'mcp_google_docs_read_doc', args: {} },
      new Set(['google_docs', 'magpie']),
    ),
    { server: 'google_docs', tool: 'read_doc', isSchema: false, isResource: false },
  );
  assert.deepEqual(
    extractMcpToolInfo({ name: 'mcp__figma__get_design', args: {} }),
    { server: 'figma', tool: 'get_design', isSchema: false, isResource: false },
  );
  assert.deepEqual(
    extractMcpToolInfo({ name: 'read_resource', args: { ServerName: 'notion', Uri: 'notion://page/1' } }),
    { server: 'notion', tool: 'read_resource', isSchema: false, isResource: true },
  );

  assert.equal(extractPrimaryCommand('cd /tmp && npm test'), 'npm');
  assert.equal(extractPrimaryCommand('FOO=1 sudo env -i python3 app.py'), 'python3');
  assert.equal(extractPrimaryCommand('cd /tmp && echo hello'), 'echo');
  assert.equal(extractPrimaryCommand('cd /tmp'), 'cd');

  const mcpLines = [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-21T10:00:00Z',
      content: '<USER_REQUEST>\nInspect page via MCP and run tests\n</USER_REQUEST>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-21T10:00:01Z',
      model: 'gemini-4-neon-high',
      input_tokens: 5000,
      cache_read_tokens: 0,
      output_tokens: 300,
      tool_calls: [
        { name: 'read_file', args: { Path: '/Users/dev/.gemini/antigravity/mcp/magpie/run_code.json' } },
        { name: 'call_mcp_tool', args: { ServerName: 'magpie', ToolName: 'run_code', Arguments: { code: 'return 42' } } },
        { name: 'call_mcp_tool', args: { ServerName: 'magpie', ToolName: 'chrome-devtools__click', Arguments: { uid: '1_2' } } },
        { name: 'mcp_google_docs_read_doc', args: { id: 'doc-1' } },
        { name: 'run_command', args: { CommandLine: 'npm test', toolSummary: 'Run tests' } },
        { name: 'run_command', args: { CommandLine: 'git status', toolSummary: 'Git status' } },
        { name: 'read_file', args: { Path: '/Users/dev/git/my-app/src/index.js' } },
      ],
    },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-21T10:00:02Z', content: 's'.repeat(1200) },
    { step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-21T10:00:03Z', content: 'r'.repeat(4000) },
    { step_index: 4, source: 'MODEL', type: 'GENERIC', status: 'ERROR', created_at: '2026-11-21T10:00:04Z', content: 'element not found' },
    { step_index: 5, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-21T10:00:05Z', content: 'd'.repeat(2400) },
    { step_index: 6, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-21T10:00:06Z', content: 't'.repeat(2000) },
    { step_index: 7, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-21T10:00:07Z', content: 'Command exited with code 1\nfatal: not a git repo' },
    { step_index: 8, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-21T10:00:08Z', content: 'f'.repeat(1600) },
    {
      step_index: 9,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-21T10:00:10Z',
      model: 'gemini-4-neon-high',
      input_tokens: 4000,
      cache_read_tokens: 5000,
      output_tokens: 200,
      content: 'Done!',
    },
  ];
  const rawMcp = mcpLines.map((x) => JSON.stringify(x)).join('\n');
  const parsedMcp = parseTranscript(rawMcp, {
    conversationId: 'test-mcp-breakdown',
    knownMcpServers: ['google_docs', 'magpie'],
  });

  // Exact composition sum
  const compSum = CATEGORIES.reduce((a, k) => a + parsedMcp.composition[k], 0);
  assert.equal(compSum, parsedMcp.currentContext);

  // tool_calls has Level-2 MCP servers (magpie, google_docs), Level-2 Commands group, and read_file
  const tcItems = parsedMcp.categoryItems.tool_calls;
  const magpieRow = tcItems.find((x) => x.isMcp && x.mcpServer === 'magpie');
  const gdocsRow = tcItems.find((x) => x.isMcp && x.mcpServer === 'google_docs');
  const cmdGroupRow = tcItems.find((x) => x.isCommandGroup);
  const readRow = tcItems.find((x) => !x.isMcp && !x.isCommand && x.label === 'read_file');
  assert.ok(magpieRow);
  assert.ok(gdocsRow);
  assert.ok(cmdGroupRow);
  assert.ok(readRow);
  assert.ok(!tcItems.some((x) => x.label === 'run_command' || x.label === 'call_mcp_tool'));

  // Level-3 children under Commands include npm (ok) and git (failed), summing to cmdGroupRow.tokens
  assert.equal(cmdGroupRow.count, 2);
  assert.equal(cmdGroupRow.failedCount, 1);
  assert.equal(cmdGroupRow.children.length, 2);
  assert.equal(cmdGroupRow.children.reduce((a, c) => a + c.tokens, 0), cmdGroupRow.tokens);
  const npmChild = cmdGroupRow.children.find((c) => c.commandName === 'npm');
  const gitChild = cmdGroupRow.children.find((c) => c.commandName === 'git');
  assert.equal(npmChild?.failed, false);
  assert.equal(gitChild?.failed, true);

  // Level-3 children under magpie include run_code, run_code.json (schema), and failed chrome-devtools__click
  assert.equal(magpieRow.count, 3);
  assert.equal(magpieRow.failedCount, 1);
  assert.equal(magpieRow.children.length, 3);
  assert.equal(magpieRow.children.reduce((a, c) => a + c.tokens, 0), magpieRow.tokens);
  const schemaChild = magpieRow.children.find((c) => c.mcpTool === 'run_code.json');
  const failedChild = magpieRow.children.find((c) => c.mcpTool === 'chrome-devtools__click');
  assert.equal(schemaChild?.isMcpSchema, true);
  assert.equal(failedChild?.failed, true);

  // Level-2 sum equals tool_calls bucket
  assert.equal(tcItems.reduce((a, x) => a + x.tokens, 0), parsedMcp.composition.tool_calls);

  // tools map uses server/tool for MCP and concrete command for run_command, preserving exact total count
  assert.ok(parsedMcp.tools['magpie/run_code']);
  assert.equal(parsedMcp.tools['magpie/run_code'].kind, 'mcp');
  assert.equal(parsedMcp.tools['magpie/chrome-devtools__click'].errors, 1);
  assert.ok(parsedMcp.tools['magpie/run_code.json']?.isMcpSchema);
  assert.ok(parsedMcp.tools['google_docs/read_doc']);
  assert.equal(parsedMcp.tools.npm.kind, 'command');
  assert.equal(parsedMcp.tools.git.kind, 'command');
  assert.equal(parsedMcp.tools.git.errors, 1);
  assert.equal(parsedMcp.tools.run_command, undefined);
  assert.equal(parsedMcp.tools.call_mcp_tool, undefined);
  const toolsCountSum = Object.values(parsedMcp.tools).reduce((a, x) => a + x.count, 0);
  assert.equal(toolsCountSum, parsedMcp.toolCallsCount);

  // MCP schema read is excluded from workspace fileActivity
  assert.equal(parsedMcp.fileActivity.length, 1);
  assert.equal(parsedMcp.fileActivity[0].shortPath, 'src/index.js');

  // parseTrace separates MCP items with server/tool & marks run_command with commandName
  const trMcp = parseTrace(rawMcp, { knownMcpServers: ['google_docs', 'magpie'] });
  assert.equal(trMcp.counts.mcp, 4);
  assert.equal(trMcp.counts.tool, 3); // npm + git + read_file
  const mcpTraceCall = trMcp.items.find((x) => x.kind === 'mcp' && x.mcpTool === 'run_code');
  assert.equal(mcpTraceCall.mcpServer, 'magpie');
  assert.equal(mcpTraceCall.argsPreview, '{"code":"return 42"}');
  const mcpTraceSchema = trMcp.items.find((x) => x.kind === 'mcp' && x.isMcpSchema);
  assert.equal(mcpTraceSchema.mcpServer, 'magpie');
  assert.equal(mcpTraceSchema.mcpTool, 'run_code.json');
  const cmdTrace = trMcp.items.find((x) => x.kind === 'tool' && x.isCommand && x.commandName === 'npm');
  assert.equal(cmdTrace.argsPreview, 'npm test');
  const modelDetail = trMcp.details.find((x) => x.kind === 'model' && x.step === 1);
  assert.equal(modelDetail.toolCalls[1].name, 'magpie / run_code');
  assert.equal(modelDetail.toolCalls[4].name, 'npm');
  assert.equal(modelDetail.toolCalls[5].name, 'git');
}

// 6. Real live transcript smoke test (if path passed via env)
if (process.env.LIVE_TRANSCRIPT) {
  const raw = readFileSync(process.env.LIVE_TRANSCRIPT, 'utf-8');
  const parsed = parseTranscript(raw, { conversationId: '32b0a4ab-f907-4f64-b60d-1bfe69503f22' });
  const compSum = CATEGORIES.reduce((a, k) => a + parsed.composition[k], 0);
  assert.equal(compSum, parsed.currentContext);
  assert.ok(parsed.modelCalls > 0);
  assert.ok(parsed.skills.plugin?.count >= 1);
  console.log('Live transcript check OK:', {
    title: parsed.title.slice(0, 40),
    workspace: parsed.workspace,
    model: parsed.model,
    currentContext: parsed.currentContext,
    totalTokens: parsed.totals.totalTokens,
    cacheHitRate: `${(parsed.totals.cacheHitRate * 100).toFixed(2)}%`,
    skills: Object.keys(parsed.skills),
    topTools: Object.entries(parsed.tools).sort((a, b) => b[1].count - a[1].count).slice(0, 5).map(([k, v]) => `${k}×${v.count}`),
    composition: parsed.composition,
  });
}

console.log('All parser tests passed!');
