import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractCommands,
  extractMcpSchemaInfo,
  extractMcpToolInfo,
  extractPrimaryCommand,
  extractSkillName,
  isProjectCodeReadPath,
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

test('isProjectCodeReadPath separates project code from internal and system paths', () => {
  assert.equal(isProjectCodeReadPath('/Users/dev/git/my-app/src/index.js'), true);
  assert.equal(isProjectCodeReadPath('"/Users/dev/git/my-app/.github/workflows/ci.yml"'), true);
  assert.equal(isProjectCodeReadPath('src/components/App.tsx'), true);
  assert.equal(isProjectCodeReadPath('D:\\repos\\web\\main.ts'), true);

  assert.equal(isProjectCodeReadPath(''), false);
  assert.equal(isProjectCodeReadPath('/Users/dev/.gemini/antigravity/brain/abc/.system_generated/steps/1/output.txt'), false);
  assert.equal(isProjectCodeReadPath('~/.gemini/config/rules/global.md'), false);
  assert.equal(isProjectCodeReadPath('/tmp/a.txt'), false);
  assert.equal(isProjectCodeReadPath('/private/tmp/out.log'), false);
  assert.equal(isProjectCodeReadPath('/etc/shadow'), false);
  assert.equal(isProjectCodeReadPath('/var/log/system.log'), false);
  assert.equal(isProjectCodeReadPath('/Users/dev/Library/Application Support/foo/bar.json'), false);
  assert.equal(isProjectCodeReadPath('/Users/dev/.cache/pip/http.json'), false);
  assert.equal(isProjectCodeReadPath('C:\\Windows\\System32\\drivers\\etc\\hosts'), false);
});
