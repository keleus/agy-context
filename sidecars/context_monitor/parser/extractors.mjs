/**
 * Extractors for user prompts, injected blocks, skills, MCP tools, shell commands,
 * tool identities, and workspace inference.
 */

import { cleanArgsObject, compactArgsPreview, shortenPath, unwrapArg } from './estimators.mjs';

const SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'until',
  'case', 'esac', 'select', 'function', 'time', 'coproc', '{', '}', '!', '[[', ']]', '[', ']',
  'true', 'false', 'export', 'unset', 'local', 'declare', 'typeset', 'readonly', 'return', 'exit',
  'cd', 'echo', 'printf', 'set', 'shift', 'source', '.', 'eval', 'exec', 'test',
]);

const SHELL_WRAPPERS = new Set([
  'sudo', 'env', 'nohup', 'command', 'builtin', 'nice', 'ionice', 'timeout', 'xargs', 'caffeinate',
]);

export function splitUserInput(raw) {
  const text = String(raw || '');
  const reqMatches = [...text.matchAll(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/gi)];
  if (reqMatches.length) {
    const userText = reqMatches.map((m) => m[1].trim()).filter(Boolean).join('\n');
    const remainder = text.replace(/<USER_REQUEST>[\s\S]*?<\/USER_REQUEST>/gi, '').trim();
    return { userText, injectedText: remainder };
  }
  return { userText: text.trim(), injectedText: '' };
}

export function splitInjectedSubparts(injectedText) {
  const raw = String(injectedText || '').trim();
  if (!raw) return [];
  const parts = [];

  const timeLines = [];
  const withoutTime = raw.replace(/^\s*The current local time is:[^\n]*$/gim, (m) => {
    timeLines.push(m.trim());
    return '';
  });
  if (timeLines.length) {
    parts.push({ group: 'time', label: 'Time', text: timeLines.join('\n') });
  }

  const imageBlocks = [];
  const withoutImages = withoutTime.replace(
    /The user has uploaded\s+\d+\s+image\(s\):(?:\n\s*-\s*[^\n]+)*/gi,
    (m) => {
      imageBlocks.push(m.trim());
      return '';
    },
  );
  if (imageBlocks.length) {
    parts.push({ group: 'image', label: 'Image', text: imageBlocks.join('\n') });
  }

  const remainder = withoutImages
    .replace(/<([A-Z][A-Z0-9_]+)>\s*<\/\1>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (remainder) {
    const group = /<CONTEXT_SUMMARY>/i.test(remainder) ? 'compaction'
      : /<USER_SETTINGS/i.test(remainder) ? 'settings'
      : 'other';
    const label = group === 'compaction' ? 'Compaction'
      : group === 'settings' ? 'Settings'
      : 'Other injected';
    parts.push({ group, label, text: remainder });
  }
  return parts;
}

/**
 * Extracts XML-tagged injected prompt blocks (e.g. <ADDITIONAL_METADATA>,
 * <USER_SETTINGS_CHANGE>) that Antigravity appends to USER_INPUT steps.
 */
export function extractInjectedBlocks(injectedText) {
  const raw = String(injectedText || '').trim();
  if (!raw) return [];
  const blocks = [];
  const re = /<([A-Z][A-Z0-9_]{1,40})>\s*([\s\S]*?)\s*<\/\1>/g;
  let lastEnd = 0;
  let match;
  while ((match = re.exec(raw)) !== null) {
    const gap = raw.slice(lastEnd, match.index).trim();
    if (gap) blocks.push({ tag: 'INJECTED', text: gap });
    const body = match[2].trim();
    if (body) blocks.push({ tag: match[1], text: body });
    lastEnd = re.lastIndex;
  }
  const tail = raw.slice(lastEnd).trim();
  if (tail) blocks.push({ tag: 'INJECTED', text: tail });
  return blocks;
}

export function detectSystemBadges(tag, text) {
  const badges = [];
  const body = String(text || '');
  const upperTag = String(tag || '').toUpperCase();
  if (/The current local time is:/i.test(body)) badges.push('time');
  if (
    /The user has uploaded\s+\d+\s+image\(s\)/i.test(body)
    || (/uploaded/i.test(body) && /\.(png|jpe?g|webp|gif|bmp)\b/i.test(body))
  ) {
    badges.push('image');
  } else if (
    /The user has uploaded\s+\d+\s+(?:file|document|attachment|audio|video)/i.test(body)
    || /attached\s+\d*\s*file/i.test(body)
  ) {
    badges.push('attachment');
  }
  if (upperTag === 'COMPACTION' || upperTag === 'CONTEXT_SUMMARY' || upperTag === 'CHECKPOINT') {
    badges.push('compaction');
  }
  if (upperTag.includes('SETTINGS')) {
    badges.push('settings');
  }
  return badges;
}

export function extractSkillName(pathStr) {
  const p = unwrapArg(pathStr);
  if (!p) return null;
  const m = p.match(/[/\\]skills[/\\]([^/\\]+)[/\\]SKILL\.md$/i);
  return m ? m[1] : null;
}

export function extractMcpSchemaInfo(pathStr) {
  const p = unwrapArg(pathStr);
  if (!p) return null;
  const m = p.match(/(?:^|[/\\])(?:\.gemini[/\\][^/\\]+|antigravity)[/\\]mcp[/\\]([^/\\]+)[/\\]([^/\\]+)$/i);
  if (!m) return null;
  const server = m[1];
  const fileName = m[2];
  if (!/\.(json|md)$/i.test(fileName)) return null;
  return { server, tool: fileName, isSchema: true, isResource: false, path: p };
}

export function extractMcpToolInfo(tc, knownServers = null) {
  const rawName = String(tc?.name || '');
  const args = tc?.args || {};

  if (rawName === 'call_mcp_tool') {
    const server = unwrapArg(args.ServerName ?? args.serverName ?? args.server_name ?? args.server ?? '').trim();
    const tool = unwrapArg(args.ToolName ?? args.toolName ?? args.tool_name ?? args.tool ?? '').trim();
    return {
      server: server || 'mcp',
      tool: tool || 'call_mcp_tool',
      isSchema: false,
      isResource: false,
    };
  }

  if (rawName === 'list_resources' || rawName === 'read_resource' || rawName === 'list_resource_templates') {
    const server = unwrapArg(args.ServerName ?? args.serverName ?? args.server_name ?? args.server ?? '').trim();
    return {
      server: server || 'mcp',
      tool: rawName,
      isSchema: false,
      isResource: true,
    };
  }

  if (rawName === 'read_file' || rawName === 'view_file') {
    const p = unwrapArg(args.Path || args.AbsolutePath || '');
    if (p && !extractSkillName(p)) {
      return extractMcpSchemaInfo(p);
    }
    return null;
  }

  if (rawName.startsWith('mcp__')) {
    const rest = rawName.slice(5);
    const sep = rest.indexOf('__');
    if (sep > 0 && sep + 2 < rest.length) {
      return {
        server: rest.slice(0, sep),
        tool: rest.slice(sep + 2),
        isSchema: false,
        isResource: false,
      };
    }
  }

  if (rawName.startsWith('mcp_')) {
    const rest = rawName.slice(4);
    if (knownServers && knownServers.size > 0) {
      const sorted = [...knownServers].filter(Boolean).sort((a, b) => b.length - a.length);
      for (const srv of sorted) {
        if (rest.startsWith(`${srv}_`) && rest.length > srv.length + 1) {
          return {
            server: srv,
            tool: rest.slice(srv.length + 1),
            isSchema: false,
            isResource: false,
          };
        }
      }
    }
    const sep = rest.indexOf('_');
    if (sep > 0 && sep + 1 < rest.length) {
      return {
        server: rest.slice(0, sep),
        tool: rest.slice(sep + 1),
        isSchema: false,
        isResource: false,
      };
    }
  }

  return null;
}

export function collectKnownMcpServers(steps, extraServers = null) {
  const servers = new Set();
  if (extraServers) {
    for (const s of extraServers) {
      const clean = String(s || '').trim();
      if (clean) servers.add(clean);
    }
  }
  for (const st of steps) {
    if (!Array.isArray(st?.tool_calls)) continue;
    for (const tc of st.tool_calls) {
      const n = String(tc?.name || '');
      const args = tc?.args || {};
      if (n === 'call_mcp_tool' || n === 'list_resources' || n === 'read_resource' || n === 'list_resource_templates') {
        const srv = unwrapArg(args.ServerName ?? args.serverName ?? args.server_name ?? args.server ?? '').trim();
        if (srv) servers.add(srv);
      } else if (n === 'read_file' || n === 'view_file') {
        const schema = extractMcpSchemaInfo(args.Path || args.AbsolutePath || '');
        if (schema?.server) servers.add(schema.server);
      }
    }
  }
  return servers;
}

function cleanShellSegments(raw) {
  return raw
    .replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?(?:\n\1(?:\s|$)|$)/g, ' ')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .split(/(?:\|\||&&|[|;\n])/);
}

export function extractCommands(cmdLine) {
  const raw = unwrapArg(cmdLine);
  if (!raw) return [];
  const segments = cleanShellSegments(raw);
  const out = [];
  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    let idx = 0;
    while (idx < tokens.length) {
      const tok = tokens[idx].replace(/^['"`(]+|['"`)]+$/g, '');
      if (!tok) { idx++; continue; }
      if (tok.startsWith('#') || tok.startsWith('-')) break;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) { idx++; continue; }
      if (/^(?:\d?>|>>|<|2>&1)/.test(tok)) { idx += 2; continue; }
      const base = tok.includes('/') ? tok.split('/').pop() : tok;
      if (!base || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(base)) break;
      if (SHELL_WRAPPERS.has(base)) {
        idx++;
        while (idx < tokens.length && (/^-/.test(tokens[idx]) || /^\d+[smh]?$/.test(tokens[idx]))) idx++;
        continue;
      }
      if (SHELL_KEYWORDS.has(base)) break;
      out.push(base);
      break;
    }
  }
  return out;
}

export function extractPrimaryCommand(cmdLine) {
  const cmds = extractCommands(cmdLine);
  if (cmds.length) return cmds[0];
  const raw = unwrapArg(cmdLine);
  if (!raw) return 'shell';
  const segments = cleanShellSegments(raw);
  let fallback = '';
  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    let idx = 0;
    while (idx < tokens.length) {
      const tok = tokens[idx].replace(/^['"`(]+|['"`)]+$/g, '');
      if (!tok) { idx++; continue; }
      if (tok.startsWith('#') || tok.startsWith('-')) break;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) { idx++; continue; }
      if (/^(?:\d?>|>>|<|2>&1)/.test(tok)) { idx += 2; continue; }
      const base = tok.includes('/') ? tok.split('/').pop() : tok;
      if (!base || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(base)) break;
      if (SHELL_WRAPPERS.has(base)) {
        idx++;
        while (idx < tokens.length && (/^-/.test(tokens[idx]) || /^\d+[smh]?$/.test(tokens[idx]))) idx++;
        continue;
      }
      if (base !== 'cd') return base;
      if (!fallback) fallback = base;
      break;
    }
  }
  return fallback || 'shell';
}

export function resolveToolIdentity(tc, knownServers = null) {
  const rawName = String(tc?.name || 'unknown');
  const args = tc?.args || {};
  const skillName = (rawName === 'read_file' || rawName === 'view_file')
    ? extractSkillName(args.Path || args.AbsolutePath)
    : null;
  if (skillName) {
    return {
      rawName,
      key: rawName,
      kind: 'skill',
      skillName,
      isMcp: false,
      mcpServer: '',
      mcpTool: '',
      isMcpSchema: false,
      isCommand: false,
      commandName: '',
    };
  }
  const mcp = extractMcpToolInfo(tc, knownServers);
  if (mcp) {
    return {
      rawName,
      key: `${mcp.server}/${mcp.tool}`,
      kind: 'mcp',
      skillName: null,
      isMcp: true,
      mcpServer: mcp.server,
      mcpTool: mcp.tool,
      isMcpSchema: Boolean(mcp.isSchema),
      isCommand: false,
      commandName: '',
      path: mcp.path || '',
    };
  }
  if (rawName === 'run_command') {
    const primaryCmd = extractPrimaryCommand(args.CommandLine);
    return {
      rawName,
      key: primaryCmd,
      kind: 'command',
      skillName: null,
      isMcp: false,
      mcpServer: '',
      mcpTool: '',
      isMcpSchema: false,
      isCommand: true,
      commandName: primaryCmd,
    };
  }
  return {
    rawName,
    key: rawName,
    kind: 'tool',
    skillName: null,
    isMcp: false,
    mcpServer: '',
    mcpTool: '',
    isMcpSchema: false,
    isCommand: false,
    commandName: '',
  };
}

export function describeToolItem(tc, knownServers = null) {
  const name = tc?.name || 'tool';
  const args = tc?.args || {};
  const id = resolveToolIdentity(tc, knownServers);

  if (id.skillName) {
    const path = unwrapArg(args.Path || args.AbsolutePath || '');
    return { label: id.skillName, detail: path, category: 'skill_injection', tool: 'skill', path };
  }
  if (id.isMcp) {
    const rawMcpArgs = args.Arguments ?? args.arguments;
    const mcpArgsPreview = rawMcpArgs == null
      ? ''
      : (typeof rawMcpArgs === 'string'
          ? unwrapArg(rawMcpArgs)
          : compactArgsPreview(cleanArgsObject(rawMcpArgs)));
    const detail = id.isMcpSchema
      ? (id.path || '')
      : (name === 'call_mcp_tool'
          ? mcpArgsPreview
          : name === 'read_resource'
            ? unwrapArg(args.Uri || args.uri || '')
            : '');
    return {
      label: id.mcpTool,
      detail: detail.slice(0, 220),
      category: 'tool_calls',
      tool: id.key,
      isMcp: true,
      mcpServer: id.mcpServer,
      mcpTool: id.mcpTool,
      isMcpSchema: id.isMcpSchema,
      path: id.path || '',
    };
  }
  if (name === 'read_file' || name === 'view_file') {
    const path = unwrapArg(args.Path || args.AbsolutePath || '');
    return { label: shortenPath(path) || 'file', detail: path, category: 'tool_calls', tool: name, path };
  }
  if (name === 'run_command') {
    const summary = unwrapArg(args.toolSummary || '');
    const cmd = unwrapArg(args.CommandLine || '').replace(/\s+/g, ' ').trim();
    return {
      label: summary || cmd.slice(0, 60) || id.commandName,
      detail: cmd.slice(0, 220),
      category: 'tool_calls',
      tool: id.commandName,
      isCommand: true,
      commandName: id.commandName,
      cmd,
    };
  }
  if (name === 'search_web') {
    const q = unwrapArg(args.query || '').trim();
    return { label: q.slice(0, 56) || 'web search', detail: q, category: 'tool_calls', tool: name };
  }
  if (name === 'write_file' || name === 'edit_file') {
    const path = unwrapArg(args.Path || '');
    return { label: shortenPath(path) || name, detail: path, category: 'tool_calls', tool: name, path };
  }
  const argPreview = Object.entries(args)
    .slice(0, 2)
    .map(([k, v]) => `${k}=${String(unwrapArg(v)).slice(0, 32)}`)
    .join(', ');
  return { label: argPreview ? `${name}(${argPreview})` : name, detail: argPreview, category: 'tool_calls', tool: name };
}

export function inferWorkspace(steps) {
  const counts = new Map();
  const ignoreRoots = new Set(['.gemini', '.cache', '.local', '.config', 'tmp', 'Applications', 'Library', 'System', 'usr', 'bin', 'var', 'etc']);

  const recordPath = (rawPath) => {
    const p = unwrapArg(rawPath);
    if (!p || !p.startsWith('/')) return;
    if (p.includes('/.gemini/') || p.startsWith('/tmp/') || p.startsWith('/Applications/')) return;
    const parts = p.split('/').filter(Boolean);
    let candidate = '';
    if ((parts[0] === 'Users' || parts[0] === 'home') && parts.length >= 4) {
      const container = parts[2];
      const next = parts[3];
      if (ignoreRoots.has(container)) return;
      if (['git', 'repos', 'repo', 'projects', 'Projects', 'workspace', 'workspaces', 'code', 'Code', 'dev', 'src', 'work', 'Work', 'Desktop', 'Documents'].includes(container)) {
        candidate = next;
      } else {
        candidate = container;
      }
    } else if (parts.length >= 2 && !ignoreRoots.has(parts[0])) {
      candidate = parts[1];
    }
    if (candidate && !candidate.startsWith('.') && !candidate.includes(' ')) {
      counts.set(candidate, (counts.get(candidate) || 0) + 1);
    }
  };

  for (const s of steps) {
    if (Array.isArray(s.tool_calls)) {
      for (const tc of s.tool_calls) {
        const args = tc?.args || {};
        if (args.Path) recordPath(args.Path);
        if (args.path) recordPath(args.path);
        if (args.Cwd) recordPath(args.Cwd);
        if (args.SearchPath) recordPath(args.SearchPath);
        if (args.CommandLine) {
          const cmd = unwrapArg(args.CommandLine);
          const m = cmd.match(/\/(?:Users|home)\/[^\s"'`]+/g);
          if (m) m.forEach(recordPath);
        }
      }
    }
  }

  let best = '';
  let bestCount = 0;
  for (const [name, c] of counts) {
    if (c > bestCount) {
      best = name;
      bestCount = c;
    }
  }
  return best || 'default-workspace';
}
