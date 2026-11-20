import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CATEGORIES,
  extractCommands,
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
  assert.equal(tbSum, parsed.modelComposition[0].totalTokens);
  assert.ok(parsed.modelComposition[0].typeBreakdown.some((x) => x.type === 'cache_read'));
  assert.ok(parsed.modelComposition[0].typeBreakdown.some((x) => x.type === 'text_input'));
  assert.ok(parsed.modelComposition[0].typeBreakdown.some((x) => x.type === 'thinking'));
  assert.ok(parsed.modelComposition[0].typeBreakdown.some((x) => x.type === 'tool_call'));
  assert.equal(parsed.categoryItems.system_prompt.length, 0);
  assert.equal(parsed.categoryItems.tool_definitions.length, 0);
  assert.equal(parsed.categoryItems.skill_injection.length, 1);
  assert.equal(parsed.categoryItems.skill_injection[0].label, 'plugin');
  assert.equal(parsed.categoryItems.skill_injection[0].tool, 'skill');
  assert.equal(parsed.categoryItems.skill_injection[0].count, 1);
  assert.equal(parsed.categoryItems.tool_calls.length, 1);
  assert.equal(parsed.categoryItems.tool_calls[0].label, 'run_command');
  assert.equal(parsed.categoryItems.tool_calls[0].count, 1);
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
