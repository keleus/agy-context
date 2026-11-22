import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CATEGORIES,
  parseTranscript,
  summarizeHookTelemetry,
} from '../sidecars/context_monitor/parser.mjs';

test('parseTranscript handles multi-turn conversation with skills, commands, and compaction', () => {
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
      content: 'x'.repeat(8000),
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-20T10:00:04Z',
      content: 'y'.repeat(4000),
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

  const compSum = CATEGORIES.reduce((a, k) => a + parsed.composition[k], 0);
  assert.equal(compSum, parsed.currentContext);
  assert.equal(parsed.currentContext, 6200);

  const cumSum = CATEGORIES.reduce((a, k) => a + parsed.cumulativeComposition[k], 0);
  assert.equal(cumSum, parsed.totals.totalTokens);
  assert.equal(parsed.totals.totalTokens, 10000 + 400 + 14000 + 600 + 6000 + 200);

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
});

test('parseTranscript classifies MCP servers, commands, and hook telemetry', () => {
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

  const compSum = CATEGORIES.reduce((a, k) => a + parsedMcp.composition[k], 0);
  assert.equal(compSum, parsedMcp.currentContext);

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

  assert.equal(cmdGroupRow.count, 2);
  assert.equal(cmdGroupRow.failedCount, 1);
  assert.equal(cmdGroupRow.children.length, 2);
  assert.equal(cmdGroupRow.children.reduce((a, c) => a + c.tokens, 0), cmdGroupRow.tokens);
  assert.equal(cmdGroupRow.children.find((c) => c.commandName === 'npm')?.failed, false);
  assert.equal(cmdGroupRow.children.find((c) => c.commandName === 'git')?.failed, true);

  assert.equal(magpieRow.count, 3);
  assert.equal(magpieRow.failedCount, 1);
  assert.equal(magpieRow.children.length, 3);
  assert.equal(magpieRow.children.reduce((a, c) => a + c.tokens, 0), magpieRow.tokens);
  assert.equal(magpieRow.children.find((c) => c.mcpTool === 'run_code.json')?.isMcpSchema, true);
  assert.equal(magpieRow.children.find((c) => c.mcpTool === 'chrome-devtools__click')?.failed, true);

  assert.equal(tcItems.reduce((a, x) => a + x.tokens, 0), parsedMcp.composition.tool_calls);

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

  assert.equal(parsedMcp.fileActivity.length, 1);
  assert.equal(parsedMcp.fileActivity[0].shortPath, 'src/index.js');
});

test('summarizeHookTelemetry tracks live generating and tool phases', () => {
  const baseHooks = [
    { ev: 'SessionStart', ts: Date.parse('2026-11-20T14:00:00.000Z'), model: 'gemini-4-neon-high' },
    { ev: 'PreInvocation', ts: Date.parse('2026-11-20T14:00:01.000Z'), inv: 1, steps: 1, model: 'gemini-4-neon-high' },
    { ev: 'PostToolUse', ts: Date.parse('2026-11-20T14:00:05.750Z'), step: 2, tool: 'read_file', toolId: 't1', err: 'permission denied' },
    { ev: 'PostInvocation', ts: Date.parse('2026-11-20T14:00:05.800Z'), inv: 1, steps: 1 },
    { ev: 'PreInvocation', ts: Date.parse('2026-11-20T14:00:06.100Z'), inv: 2, steps: 3, model: 'gemini-4-neon-high' },
    { ev: 'Stop', ts: Date.parse('2026-11-20T14:00:09.300Z'), reason: 'NO_TOOL_CALL' },
  ];
  const now = Date.parse('2026-11-20T14:00:15.000Z');
  const genLive = summarizeHookTelemetry([
    ...baseHooks,
    { ev: 'PreInvocation', ts: Date.parse('2026-11-20T14:00:11.000Z'), inv: 1, model: 'gemini-4-neon-high' },
  ], now);
  assert.equal(genLive.liveState.active, true);
  assert.equal(genLive.liveState.phase, 'generating');

  const toolLive = summarizeHookTelemetry([
    ...baseHooks,
    { ev: 'PreInvocation', ts: Date.parse('2026-11-20T14:00:11.000Z'), inv: 1, model: 'gemini-4-neon-high' },
    { ev: 'PostToolUse', ts: Date.parse('2026-11-20T14:00:14.000Z'), step: 5, tool: 'run_command' },
  ], now);
  assert.equal(toolLive.liveState.active, true);
  assert.equal(toolLive.liveState.phase, 'tools');
  assert.equal(toolLive.liveState.lastTool, 'run_command');
});

if (process.env.LIVE_TRANSCRIPT) {
  test('live transcript smoke test', () => {
    const raw = readFileSync(process.env.LIVE_TRANSCRIPT, 'utf-8');
    const parsed = parseTranscript(raw, { conversationId: '32b0a4ab-f907-4f64-b60d-1bfe69503f22' });
    const compSum = CATEGORIES.reduce((a, k) => a + parsed.composition[k], 0);
    assert.equal(compSum, parsed.currentContext);
    assert.ok(parsed.modelCalls > 0);
    assert.ok(parsed.skills.plugin?.count >= 1);
  });
}
