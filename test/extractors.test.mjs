import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractCommands,
  extractMcpSchemaInfo,
  extractMcpToolInfo,
  extractPrimaryCommand,
  extractSkillName,
  splitUserInput,
} from '../sidecars/context_monitor/parser.mjs';

test('splitUserInput separates <USER_REQUEST> from metadata blocks', () => {
  const raw = '<USER_REQUEST>\n帮我看下上下文\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime: 2026\n</ADDITIONAL_METADATA>';
  const { userText, injectedText } = splitUserInput(raw);
  assert.equal(userText, '帮我看下上下文');
  assert.ok(injectedText.includes('ADDITIONAL_METADATA'));
});

test('extractSkillName detects SKILL.md reads including double-quoted compact args', () => {
  assert.equal(extractSkillName('/Users/a/.gemini/antigravity/builtin/skills/plugin/SKILL.md'), 'plugin');
  assert.equal(extractSkillName('"/Users/a/.gemini/config/skills/code-review/SKILL.md"'), 'code-review');
  assert.equal(extractSkillName('/Users/a/project/README.md'), null);
});

test('extractCommands parses pipelines, chains, env prefixes, wrappers, paths, and multiline quotes', () => {
  const cmds = extractCommands('FOO=1 /usr/bin/git status && sudo npm test | grep pass; env -i node index.mjs');
  assert.deepEqual(cmds, ['git', 'npm', 'grep', 'node']);

  const multiline = `/usr/bin/python3 -c '\nimport json\nfake-cmd foo\n' && jq '.a | .b'`;
  assert.deepEqual(extractCommands(multiline), ['python3', 'jq']);
});

test('extractPrimaryCommand resolves primary command with sensible fallbacks', () => {
  assert.equal(extractPrimaryCommand('cd /tmp && npm test'), 'npm');
  assert.equal(extractPrimaryCommand('FOO=1 sudo env -i python3 app.py'), 'python3');
  assert.equal(extractPrimaryCommand('cd /tmp && echo hello'), 'echo');
  assert.equal(extractPrimaryCommand('cd /tmp'), 'cd');
});

test('extractMcpSchemaInfo and extractMcpToolInfo classify MCP schemas, calls, and resources', () => {
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
});
