import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTrace, parseTranscript } from '../sidecars/context_monitor/parser.mjs';

test('parseTrace emits input, injected, compaction, skill, model, and tool entries', () => {
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
    { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-20T10:00:03Z', content: 'x'.repeat(8000) },
    { step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-20T10:00:04Z', content: 'y'.repeat(4000) },
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
    { step_index: 5, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-20T10:01:00Z', content: '<USER_REQUEST>\nContinue\n</USER_REQUEST>' },
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
  const trace = parseTrace(jsonl);
  assert.equal(trace.counts.input, 2);
  assert.equal(trace.counts.system, 2);
  assert.equal(trace.counts.skill, 1);
  assert.equal(trace.counts.model, 3);
  assert.equal(trace.counts.tool, 1);
  assert.equal(trace.items.length, 9);
  assert.equal(trace.details.find((d) => d.kind === 'system' && d.systemType === 'ADDITIONAL_METADATA').content, 'meta');
  assert.ok(trace.details.find((d) => d.kind === 'system' && d.systemType === 'COMPACTION'));
  const firstSkill = trace.details.find((d) => d.kind === 'skill');
  assert.equal(firstSkill.skillName, 'plugin');
  assert.equal(firstSkill.result.length, 8000);
});

test('parseTrace handles badges, excludes idle gaps, and integrates hook timings', () => {
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
      thinking: 'Checking /tmp/a.txt',
      tool_calls: [{ name: 'read_file', args: { Path: '"/tmp/a.txt"' } }],
    },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-20T14:00:05Z', content: 'ok' },
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
    { step_index: 4, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-20T14:05:06Z', content: '<USER_REQUEST>\nnext question\n</USER_REQUEST>' },
  ];
  const raw = lines.map((x) => JSON.stringify(x)).join('\n');
  const tr = parseTrace(raw);
  const metaItem = tr.items.find((x) => x.kind === 'system' && x.systemType === 'ADDITIONAL_METADATA');
  assert.ok(metaItem);
  assert.equal(metaItem.systemBadge, 'time');
  assert.deepEqual(metaItem.systemBadges, ['time', 'image']);

  const modelItems = tr.items.filter((x) => x.kind === 'model');
  assert.equal(modelItems.length, 2);
  assert.equal(modelItems[0].durationMs, 4000);
  assert.equal(modelItems[0].tokPerSec, 100);
  assert.equal(modelItems[0].timingUnavailable, false);
  assert.equal(modelItems[1].durationMs, 0);
  assert.equal(modelItems[1].tokPerSec, 0);
  assert.equal(modelItems[1].timingUnavailable, true);

  const parsed = parseTranscript(raw, { conversationId: 'test-final-timing' });
  assert.equal(parsed.timing.outputTokPerSec, 100);
  assert.equal(parsed.modelsBreakdown[0].tokPerSec, 100);
  assert.deepEqual(parsed.categoryItems.system_prompt, []);
  assert.deepEqual(parsed.categoryItems.tool_definitions, []);
  assert.deepEqual(parsed.categoryItems.injected_content.map((x) => x.group).sort(), ['image', 'time']);

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
  assert.equal(parsedWithHook.timing.outputTokPerSec, 138.9);
  assert.equal(parsedWithHook.modelsBreakdown[0].tokPerSec, 138.9);
  assert.equal(parsedWithHook.hookTelemetry.hasData, true);
  assert.equal(parsedWithHook.hookTelemetry.turnStats.completedTurns, 1);
  assert.equal(parsedWithHook.hookTelemetry.turnStats.avgTurnMs, 8300);
  assert.equal(parsedWithHook.hookTelemetry.turnStats.avgInvocations, 2);
  assert.equal(parsedWithHook.hookTelemetry.turnStats.reasons.NO_TOOL_CALL, 1);
  assert.equal(parsedWithHook.hookTelemetry.toolStats.calls, 1);
  assert.equal(parsedWithHook.hookTelemetry.toolStats.errors, 1);
  assert.equal(parsedWithHook.categoryItems.tool_calls.length, 1);
  assert.equal(parsedWithHook.categoryItems.tool_calls[0].failed, true);
  assert.equal(parsedWithHook.categoryItems.tool_calls[0].status, 'ERROR');
  assert.equal(parsed.categoryItems.tool_calls[0].failed, false);
  assert.equal(parsed.categoryItems.tool_calls[0].status, 'DONE');
});

test('parseTrace reconciles PreInvocation liveState against transcript steps and reverted branches', () => {
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

  const trGen = parseTrace(userOnlyJsonl, { hookTimings: preOnlyHooks, nowMs: tNow });
  assert.equal(trGen.liveState.active, true);
  assert.equal(trGen.liveState.phase, 'generating');

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

  const revertedGenJsonl = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-21T08:00:00Z', content: '<USER_REQUEST>\nkeep\n</USER_REQUEST>' },
    { step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-21T08:00:05Z', content: '<USER_REQUEST>\nold\n</USER_REQUEST>' },
    { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-21T08:00:06Z', model: 'gemini-4', input_tokens: 100, cache_read_tokens: 0, output_tokens: 20, content: 'old reply' },
    { step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-21T08:00:20Z', content: '<USER_REQUEST>\nnew\n</USER_REQUEST>' },
  ].map((x) => JSON.stringify(x)).join('\n');
  const revHooks = [{ ev: 'PreInvocation', ts: t0 + 21000, inv: 0, steps: 2, model: 'gemini-4-neon-high' }];
  const trRevGen = parseTrace(revertedGenJsonl, { hookTimings: revHooks, nowMs: tNow });
  assert.equal(trRevGen.liveState.active, true);
  assert.equal(trRevGen.liveState.phase, 'generating');

  const legacyHooks = [{ ev: 'PreInvocation', ts: t0 + 1400, inv: 0, model: 'gemini-4-neon-high' }];
  const trLegacyAsk = parseTrace(askJsonl, { hookTimings: legacyHooks, nowMs: tNow });
  assert.equal(trLegacyAsk.liveState.active, true);
  assert.equal(trLegacyAsk.liveState.phase, 'tools');
  assert.equal(trLegacyAsk.liveState.lastTool, 'ask_question');

  const revertLines = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-20T15:00:00Z', content: '<USER_REQUEST>\nkeep me\n</USER_REQUEST>' },
    { step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-20T15:01:00Z', content: '<USER_REQUEST>\nreverted prompt\n</USER_REQUEST>' },
    { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-20T15:01:02Z', model: 'gemini-4', input_tokens: 1000, cache_read_tokens: 0, output_tokens: 50, content: 'old reply' },
    { step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-20T15:02:00Z', content: '<USER_REQUEST>\nnew prompt\n</USER_REQUEST>' },
    { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-20T15:02:02Z', model: 'gemini-4', input_tokens: 1000, cache_read_tokens: 0, output_tokens: 80, content: 'new reply' },
  ];
  const revTrace = parseTrace(revertLines.map((x) => JSON.stringify(x)).join('\n'));
  assert.equal(revTrace.items.length, 5);
  assert.equal(revTrace.items[0].reverted, false);
  assert.equal(revTrace.items[1].reverted, true);
  assert.equal(revTrace.items[2].reverted, true);
  assert.equal(revTrace.items[3].reverted, false);
  assert.equal(revTrace.items[4].reverted, false);
});

test('parseTrace classifies MCP tools/schemas and shell commands', () => {
  const mcpLines = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-21T10:00:00Z', content: '<USER_REQUEST>\nInspect page via MCP and run tests\n</USER_REQUEST>' },
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
  ];
  const rawMcp = mcpLines.map((x) => JSON.stringify(x)).join('\n');
  const trMcp = parseTrace(rawMcp, { knownMcpServers: ['google_docs', 'magpie'] });
  assert.equal(trMcp.counts.mcp, 4);
  assert.equal(trMcp.counts.tool, 3);
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
});
