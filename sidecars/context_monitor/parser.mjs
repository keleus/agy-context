/**
 * Transcript parser & context composition analyzer for Antigravity.
 *
 * Reads Antigravity's per-conversation JSONL transcripts:
 *   <appData>/brain/<convId>/.system_generated/logs/transcript_full.jsonl
 *   (or transcript.jsonl as fallback)
 *
 * Every PLANNER_RESPONSE step records exact model token accounting:
 *   - input_tokens: uncached new prompt tokens
 *   - cache_read_tokens: cached prefix tokens
 *   - output_tokens: generated output tokens
 *
 * Current prompt context at invocation k is exact:
 *   ctx_k = input_tokens + cache_read_tokens
 *
 * Category and per-model breakdowns are proportionally normalized to exact real
 * token deltas so displayed totals always sum cleanly to measured context tokens.
 */

export const CATEGORIES = [
  'system_prompt',
  'tool_definitions',
  'user_messages',
  'injected_content',
  'skill_injection',
  'tool_calls',
  'thinking',
  'assistant_reply',
];

export function emptyBuckets() {
  return {
    system_prompt: 0,
    tool_definitions: 0,
    user_messages: 0,
    injected_content: 0,
    skill_injection: 0,
    tool_calls: 0,
    thinking: 0,
    assistant_reply: 0,
  };
}

// Default effective context windows (tokens; aligned to Antigravity's ~500k compaction default for Gemini).
export const DEFAULT_MODEL_SPECS = {
  'gemini-4': { contextWindow: 500_000, inputPerM: 2.0, cacheReadPerM: 0.2, outputPerM: 12.0 },
  'gemini-3': { contextWindow: 500_000, inputPerM: 2.0, cacheReadPerM: 0.2, outputPerM: 12.0 },
  'gemini-2.5-pro': { contextWindow: 500_000, inputPerM: 1.25, cacheReadPerM: 0.125, outputPerM: 10.0 },
  'gemini-2.5-flash': { contextWindow: 500_000, inputPerM: 0.3, cacheReadPerM: 0.03, outputPerM: 2.5 },
  'gemini-flash': { contextWindow: 500_000, inputPerM: 0.3, cacheReadPerM: 0.03, outputPerM: 2.5 },
  'claude-opus': { contextWindow: 200_000, inputPerM: 15.0, cacheReadPerM: 1.5, outputPerM: 75.0 },
  'claude-sonnet': { contextWindow: 200_000, inputPerM: 3.0, cacheReadPerM: 0.3, outputPerM: 15.0 },
  'claude-haiku': { contextWindow: 200_000, inputPerM: 0.8, cacheReadPerM: 0.08, outputPerM: 4.0 },
  'gpt-5': { contextWindow: 400_000, inputPerM: 2.5, cacheReadPerM: 0.25, outputPerM: 10.0 },
  'gpt-4': { contextWindow: 128_000, inputPerM: 2.5, cacheReadPerM: 1.25, outputPerM: 10.0 },
  default: { contextWindow: 500_000, inputPerM: 2.0, cacheReadPerM: 0.2, outputPerM: 12.0 },
};

const SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'until',
  'case', 'esac', 'select', 'function', 'time', 'coproc', '{', '}', '!', '[[', ']]', '[', ']',
  'true', 'false', 'export', 'unset', 'local', 'declare', 'typeset', 'readonly', 'return', 'exit',
  'cd', 'echo', 'printf', 'set', 'shift', 'source', '.', 'eval', 'exec', 'test',
]);

const SHELL_WRAPPERS = new Set([
  'sudo', 'env', 'nohup', 'command', 'builtin', 'nice', 'ionice', 'timeout', 'xargs', 'caffeinate',
]);

const CJK_RE = /[\u3000-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

export function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  const cjkMatches = text.match(CJK_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const otherCount = Math.max(0, text.length - cjkCount);
  return Math.max(1, Math.round(cjkCount * 0.72 + otherCount / 3.8));
}

export function estimateMediaTokens(media) {
  if (!Array.isArray(media) || !media.length) return 0;
  let total = 0;
  for (const m of media) {
    const mime = String(m?.mime_type || '').toLowerCase();
    if (mime.startsWith('image/')) total += 258;
    else if (mime.includes('pdf')) total += 800;
    else total += 512;
  }
  return total;
}

function splitMediaByType(media) {
  let imageW = 0;
  let imageCount = 0;
  let fileW = 0;
  let fileCount = 0;
  if (Array.isArray(media)) {
    for (const m of media) {
      const mime = String(m?.mime_type || '').toLowerCase();
      if (mime.startsWith('image/')) {
        imageW += 258;
        imageCount += 1;
      } else {
        fileW += mime.includes('pdf') ? 800 : 512;
        fileCount += 1;
      }
    }
  }
  return { imageW, imageCount, fileW, fileCount };
}

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

function splitInjectedSubparts(injectedText) {
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

export function unwrapArg(val) {
  if (typeof val !== 'string') return val == null ? '' : String(val);
  const trimmed = val.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Keep original string if not valid JSON.
    }
  }
  return val;
}

export function extractSkillName(pathStr) {
  const p = unwrapArg(pathStr);
  if (!p) return null;
  const m = p.match(/[/\\]skills[/\\]([^/\\]+)[/\\]SKILL\.md$/i);
  return m ? m[1] : null;
}

export function extractCommands(cmdLine) {
  const raw = unwrapArg(cmdLine);
  if (!raw) return [];
  const cleaned = raw
    .replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?(?:\n\1(?:\s|$)|$)/g, ' ')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  const segments = cleaned.split(/(?:\|\||&&|[|;\n])/);
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

function toLocalDateKey(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toLocalHourKey(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}`;
}

function parseMs(iso) {
  if (!iso || typeof iso !== 'string') return NaN;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : NaN;
}

function normalizeDistribute(weights, targetTotal) {
  const out = emptyBuckets();
  if (targetTotal <= 0) return out;
  let sumW = 0;
  for (const k of CATEGORIES) sumW += Math.max(0, weights[k] || 0);
  if (sumW <= 0) {
    out.tool_calls = targetTotal;
    return out;
  }
  let assigned = 0;
  let maxKey = CATEGORIES[0];
  let maxVal = -1;
  for (const k of CATEGORIES) {
    const w = Math.max(0, weights[k] || 0);
    if (w > maxVal) { maxVal = w; maxKey = k; }
    const val = Math.floor((w / sumW) * targetTotal);
    out[k] = val;
    assigned += val;
  }
  out[maxKey] += targetTotal - assigned;
  return out;
}

function shortenPath(p) {
  const s = unwrapArg(p);
  if (!s) return '';
  const parts = s.split('/').filter(Boolean);
  if (parts.length <= 2) return s;
  return parts.slice(-2).join('/');
}

function describeToolItem(tc) {
  const name = tc?.name || 'tool';
  const args = tc?.args || {};
  if (name === 'read_file' || name === 'view_file') {
    const path = unwrapArg(args.Path || args.AbsolutePath || '');
    const skill = extractSkillName(path);
    if (skill) return { label: skill, detail: path, category: 'skill_injection', tool: 'skill', path };
    return { label: shortenPath(path) || 'file', detail: path, category: 'tool_calls', tool: name, path };
  }
  if (name === 'run_command') {
    const summary = unwrapArg(args.toolSummary || '');
    const cmd = unwrapArg(args.CommandLine || '').replace(/\s+/g, ' ').trim();
    return { label: summary || cmd.slice(0, 60) || 'command', detail: cmd.slice(0, 220), category: 'tool_calls', tool: name, cmd };
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

function commandFailedFromOutput(step) {
  if (!step) return false;
  if (step.status === 'ERROR') return true;
  const content = String(step.content || '');
  const m = content.match(/Command exited with code (\d+)/);
  if (m && Number(m[1]) !== 0) return true;
  return false;
}

function parseResultDurationMs(content) {
  if (!content || typeof content !== 'string') return 0;
  const head = content.slice(0, 260);
  const cMatch = head.match(/^Created At:\s*(.+)$/m);
  const eMatch = head.match(/^Completed At:\s*(.+)$/m);
  if (!cMatch || !eMatch) return 0;
  const s = Date.parse(cMatch[1].trim());
  const e = Date.parse(eMatch[1].trim());
  if (Number.isFinite(s) && Number.isFinite(e) && e >= s) {
    return Math.min(300_000, e - s);
  }
  return 0;
}

function buildHookIntervals(hookTimings) {
  if (!Array.isArray(hookTimings) || !hookTimings.length) return [];
  const sorted = hookTimings
    .filter((e) => e && typeof e.ts === 'number' && Number.isFinite(e.ts))
    .slice()
    .sort((a, b) => a.ts - b.ts);
  const intervals = [];
  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev.ev !== 'PreInvocation') continue;
    let endEv = null;
    for (let j = i + 1; j < sorted.length; j++) {
      const next = sorted[j];
      if (next.ev === 'PreInvocation') break;
      if (next.ev === 'PostInvocation' || next.ev === 'Stop') {
        if (next.ts >= ev.ts) {
          endEv = next;
          break;
        }
      }
    }
    if (endEv) {
      const dur = endEv.ts - ev.ts;
      if (dur > 0 && dur <= 300_000) {
        intervals.push({
          startMs: ev.ts,
          endMs: endEv.ts,
          durationMs: dur,
          inv: ev.inv ?? null,
          initialSteps: Number.isFinite(Number(ev.steps)) ? Number(ev.steps) : null,
          endedBy: endEv.ev,
          used: false,
        });
      }
    }
  }
  return intervals;
}

function matchHookInterval(intervals, stepIdx, stMs) {
  if (!intervals.length || !Number.isFinite(stMs)) return null;
  let best = null;
  let bestScore = Infinity;
  for (const iv of intervals) {
    if (iv.used) continue;
    const startDiff = Math.abs(iv.startMs - stMs);
    if (startDiff > 15_000) continue;
    if (iv.initialSteps != null && Number.isFinite(stepIdx)) {
      const stepDelta = stepIdx - iv.initialSteps;
      if (stepDelta < -1 || stepDelta > 5) continue;
    }
    if (startDiff < bestScore) {
      bestScore = startDiff;
      best = iv;
    }
  }
  if (best) best.used = true;
  return best;
}

/**
 * Summarizes lifecycle hook telemetry (SessionStart, PreInvocation, PostToolUse,
 * PostInvocation, Stop) into live in-flight status, turn-level duration/depth/
 * termination stats, and per-tool completion & error telemetry.
 */
export function summarizeHookTelemetry(hookTimings, nowMs = Date.now()) {
  const empty = {
    hasData: false,
    liveState: { active: false, phase: 'idle', sinceMs: 0, inv: 0, model: '', lastTool: '' },
    turnStats: {
      completedTurns: 0,
      totalTurnMs: 0,
      avgTurnMs: 0,
      maxTurnMs: 0,
      totalInvocations: 0,
      avgInvocations: 0,
      reasons: {},
    },
    toolStats: { calls: 0, errors: 0, errorRate: 0 },
  };
  if (!Array.isArray(hookTimings) || !hookTimings.length) return empty;

  const sorted = hookTimings
    .filter((e) => e && typeof e.ts === 'number' && Number.isFinite(e.ts))
    .slice()
    .sort((a, b) => a.ts - b.ts);
  if (!sorted.length) return empty;

  // 1. Live in-flight state (stale if > 10 min without completion)
  const MAX_INFLIGHT_MS = 10 * 60 * 1000;
  let lastPre = null;
  let lastEvent = sorted[sorted.length - 1];
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].ev === 'PreInvocation') { lastPre = sorted[i]; break; }
    if (sorted[i].ev === 'Stop') break;
  }
  let liveState = { active: false, phase: 'idle', sinceMs: 0, inv: 0, model: '', lastTool: '' };
  if (lastPre && lastEvent && lastEvent.ev !== 'Stop' && lastEvent.ev !== 'PostInvocation' && lastEvent.ev !== 'SessionStart') {
    const age = nowMs - lastPre.ts;
    if (age >= -5000 && age <= MAX_INFLIGHT_MS) {
      if (lastEvent.ev === 'PostToolUse') {
        liveState = {
          active: true,
          phase: 'tools',
          sinceMs: lastPre.ts,
          inv: Number(lastPre.inv) || 1,
          model: String(lastPre.model || ''),
          lastTool: String(lastEvent.tool || ''),
        };
      } else if (lastEvent.ev === 'PreInvocation') {
        liveState = {
          active: true,
          phase: 'generating',
          sinceMs: lastPre.ts,
          inv: Number(lastPre.inv) || 1,
          model: String(lastPre.model || ''),
          lastTool: '',
        };
      }
    }
  }

  // 2. Turn-level wall-clock duration, invocation depth, and termination reasons
  let curTurnStart = 0;
  let curTurnInvs = 0;
  let completedTurns = 0;
  let totalTurnMs = 0;
  let maxTurnMs = 0;
  let totalInvocations = 0;
  const reasons = {};

  // 3. Per-tool error/call totals from PostToolUse
  let toolCalls = 0;
  let toolErrors = 0;

  for (const e of sorted) {
    if (e.ev === 'PreInvocation') {
      if (curTurnStart === 0 || Number(e.inv) === 1) {
        curTurnStart = e.ts;
        curTurnInvs = 1;
      } else {
        curTurnInvs += 1;
      }
    } else if (e.ev === 'PostToolUse') {
      toolCalls += 1;
      if (e.err) toolErrors += 1;
    } else if (e.ev === 'Stop') {
      const reason = String(e.reason || 'NO_TOOL_CALL');
      reasons[reason] = (reasons[reason] || 0) + 1;
      completedTurns += 1;
      if (curTurnStart > 0 && e.ts >= curTurnStart) {
        const dur = Math.min(30 * 60 * 1000, e.ts - curTurnStart);
        totalTurnMs += dur;
        if (dur > maxTurnMs) maxTurnMs = dur;
      }
      totalInvocations += Math.max(1, curTurnInvs);
      curTurnStart = 0;
      curTurnInvs = 0;
    }
  }

  return {
    hasData: true,
    liveState,
    turnStats: {
      completedTurns,
      totalTurnMs,
      avgTurnMs: completedTurns > 0 ? Math.round(totalTurnMs / completedTurns) : 0,
      maxTurnMs,
      totalInvocations,
      avgInvocations: completedTurns > 0 ? Math.round((totalInvocations / completedTurns) * 10) / 10 : 0,
      reasons,
    },
    toolStats: {
      calls: toolCalls,
      errors: toolErrors,
      errorRate: toolCalls > 0 ? toolErrors / toolCalls : 0,
    },
  };
}

/**
 * Parses a transcript JSONL string into a rich, structured session summary.
 */
export function parseTranscript(text, { conversationId = '', title = '', workspace = '', workspaceUri = '', fileMtime = 0, hookTimings = null } = {}) {
  const hookIntervals = buildHookIntervals(hookTimings);
  const hookTelemetry = summarizeHookTelemetry(hookTimings);
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
  const steps = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') steps.push(obj);
    } catch {
      // Torn trailing line while actively writing; safely ignored.
    }
  }

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

  // Composition & cumulative accumulators
  const currentBuckets = emptyBuckets();
  const cumulativeBuckets = emptyBuckets();
  const modelsUsed = {}; // model -> { inputTokens, cacheReadTokens, outputTokens, calls, durationMs }
  const modelContext = {}; // model -> { total, thinking, reply, calls, items: [] }
  const skills = {}; // name -> { count, lastAt, tokens }
  const tools = {}; // name -> { count, lastAt, tokens, errors }
  const commands = {}; // cmd -> { count, lastAt }
  const byDate = {}; // YYYY-MM-DD -> { tokens, inputTokens, cacheReadTokens, outputTokens, modelCalls, toolCalls, models }
  const byHour = {}; // YYYY-MM-DD HH -> { tokens, inputTokens, cacheReadTokens, outputTokens, models }
  const timeline = [];
  const compactions = [];
  const itemContributions = [];
  const fileActivityMap = new Map(); // path -> { path, shortPath, reads, edits, writes, tokens, lastStep, lastAt, lastMs }
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
  let replyMs = 0;
  let toolArgsMs = 0;
  let toolExecMs = 0;
  let otherMs = 0;
  let totalTimedOutput = 0;
  let totalTimedModelMs = 0;
  let maxTokPerSec = 0;
  let maxTokPerSecAny = 0;
  const MAX_ACTIVE_GAP_MS = 120_000;

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

    const tcs = Array.isArray(pStep.tool_calls) ? pStep.tool_calls : [];
    const outWThink = pStep.thinking ? estimateTokens(pStep.thinking) : 0;
    const outWReply = pStep.content ? estimateTokens(pStep.content) : 0;
    const outWTool = tcs.length ? estimateTokens(JSON.stringify(tcs)) : 0;
    const outWSum = outWThink + outWReply + outWTool;
    let stepOutThink = 0;
    let stepOutTool = 0;
    let stepOutReply = 0;
    if (outTok > 0) {
      if (outWSum > 0) {
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
    for (let j = pIdx + 1; j < nextPIdx; j++) {
      if (steps[j].type === 'GENERIC') childGenerics.push(steps[j]);
    }

    for (let tcIdx = 0; tcIdx < tcs.length; tcIdx++) {
      const tc = tcs[tcIdx];
      const tName = String(tc?.name || 'unknown');
      const matchedResult = childGenerics[tcIdx] || null;
      const resultMs = matchedResult ? parseMs(matchedResult.created_at) : NaN;
      let tcDurMs = parseResultDurationMs(matchedResult?.content);
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

      if (!tools[tName]) tools[tName] = { count: 0, lastAt: 0, tokens: 0, durationMs: 0, errors: 0 };
      tools[tName].count += 1;
      tools[tName].durationMs += tcDurMs;
      if (safePMs > tools[tName].lastAt) tools[tName].lastAt = safePMs;

      const args = tc?.args || {};
      const skillName = (tName === 'read_file' || tName === 'view_file') ? extractSkillName(args.Path || args.AbsolutePath) : null;
      if (skillName) {
        if (!skills[skillName]) skills[skillName] = { count: 0, lastAt: 0, tokens: 0, durationMs: 0 };
        skills[skillName].count += 1;
        skills[skillName].durationMs += tcDurMs;
        if (safePMs > skills[skillName].lastAt) skills[skillName].lastAt = safePMs;
      }

      if (tName === 'read_file' || tName === 'view_file') {
        const p = args.Path || args.AbsolutePath;
        if (p && !skillName) recordFileTouch(p, 'read', 0, pStep.step_index ?? pIdx, pStep.created_at || '', safePMs);
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
        if (st.type === 'USER_INPUT') {
          const { userText, injectedText } = splitUserInput(st.content);
          const textW = estimateTokens(userText);
          const { imageW, imageCount, fileW, fileCount } = splitMediaByType(st.media);
          const uW = textW + imageW + fileW;
          const iW = estimateTokens(injectedText);
          userEst += uW;
          injectedEst += iW;
          if (textW > 0) {
            initUserItems.push({
              group: 'text',
              label: 'Text input',
              weight: textW,
              itemCount: 1,
              step: st.step_index ?? j,
              at: st.created_at || '',
              ms: Number.isFinite(stMs) ? stMs : safePMs,
            });
          }
          if (imageW > 0) {
            initUserItems.push({
              group: 'image',
              label: 'Image input',
              weight: imageW,
              itemCount: imageCount,
              step: st.step_index ?? j,
              at: st.created_at || '',
              ms: Number.isFinite(stMs) ? stMs : safePMs,
            });
          }
          if (fileW > 0) {
            initUserItems.push({
              group: 'file',
              label: 'File / Media',
              weight: fileW,
              itemCount: fileCount,
              step: st.step_index ?? j,
              at: st.created_at || '',
              ms: Number.isFinite(stMs) ? stMs : safePMs,
            });
          }
          if (iW > 0) {
            const subparts = splitInjectedSubparts(injectedText);
            if (subparts.length) {
              for (const sp of subparts) {
                const sw = estimateTokens(sp.text);
                if (sw <= 0) continue;
                initInjItems.push({
                  group: sp.group,
                  label: sp.label,
                  detail: sp.text.slice(0, 200),
                  weight: sw,
                  step: st.step_index ?? j,
                  at: st.created_at || '',
                  ms: Number.isFinite(stMs) ? stMs : safePMs,
                });
              }
            } else {
              initInjItems.push({
                group: 'other',
                label: 'Other injected',
                detail: injectedText.slice(0, 200),
                weight: iW,
                step: st.step_index ?? j,
                at: st.created_at || '',
                ms: Number.isFinite(stMs) ? stMs : safePMs,
              });
            }
          }
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
              ms: Number.isFinite(stMs) ? stMs : safePMs,
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
          const { userText, injectedText } = splitUserInput(st.content);
          const textW = estimateTokens(userText);
          const { imageW, imageCount, fileW, fileCount } = splitMediaByType(st.media);
          const uW = textW + imageW + fileW;
          const injW = estimateTokens(injectedText);
          weights.user_messages += uW;
          weights.injected_content += injW;
          if (textW > 0) {
            stepItems.push({
              group: 'text',
              label: 'Text input',
              category: 'user_messages',
              tool: 'user',
              weight: textW,
              itemCount: 1,
              step: st.step_index ?? j,
              at: st.created_at || '',
              ms: safeStMs,
            });
          }
          if (imageW > 0) {
            stepItems.push({
              group: 'image',
              label: 'Image input',
              category: 'user_messages',
              tool: 'user',
              weight: imageW,
              itemCount: imageCount,
              step: st.step_index ?? j,
              at: st.created_at || '',
              ms: safeStMs,
            });
          }
          if (fileW > 0) {
            stepItems.push({
              group: 'file',
              label: 'File / Media',
              category: 'user_messages',
              tool: 'user',
              weight: fileW,
              itemCount: fileCount,
              step: st.step_index ?? j,
              at: st.created_at || '',
              ms: safeStMs,
            });
          }
          if (injW > 0) {
            const subparts = splitInjectedSubparts(injectedText);
            if (subparts.length) {
              for (const sp of subparts) {
                const sw = estimateTokens(sp.text);
                if (sw <= 0) continue;
                stepItems.push({
                  group: sp.group,
                  label: sp.label,
                  detail: sp.text.slice(0, 180),
                  category: 'injected_content',
                  tool: 'system',
                  weight: sw,
                  step: st.step_index ?? j,
                  at: st.created_at || '',
                  ms: safeStMs,
                });
              }
            } else {
              stepItems.push({
                group: 'other',
                label: 'Other injected',
                detail: injectedText.slice(0, 180),
                category: 'injected_content',
                tool: 'system',
                weight: injW,
                step: st.step_index ?? j,
                at: st.created_at || '',
                ms: safeStMs,
              });
            }
          }
        } else if (st.type === 'GENERIC') {
          const matchedTc = prevCalls[genericIdx] || null;
          genericIdx++;
          const w = estimateTokens(st.content || '') + estimateMediaTokens(st.media);
          const desc = matchedTc
            ? describeToolItem(matchedTc)
            : { label: 'Tool output', detail: '', category: 'tool_calls', tool: 'tool' };
          weights[desc.category] += w;
          const tName = matchedTc?.name || null;
          const isFailed = commandFailedFromOutput(st)
            || (Number.isFinite(st.step_index) && hookErrorSteps.has(st.step_index));
          if (isFailed && tName && tools[tName]) {
            tools[tName].errors += 1;
          }
          stepItems.push({
            ...desc,
            skillName: matchedTc ? extractSkillName(matchedTc?.args?.Path || matchedTc?.args?.AbsolutePath) : null,
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

      // Attribute previous planner's thinking & assistant_reply into its modelContext entry
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
      const outWeights = emptyBuckets();
      if (pStep.thinking) outWeights.thinking = estimateTokens(pStep.thinking);
      if (pStep.content) outWeights.assistant_reply = estimateTokens(pStep.content);
      if (tcs.length) outWeights.tool_calls = estimateTokens(JSON.stringify(tcs));
      if (outWeights.thinking + outWeights.assistant_reply + outWeights.tool_calls === 0) {
        outWeights.assistant_reply = 1;
      }
      const outDist = normalizeDistribute(outWeights, outTok);
      for (const k of CATEGORIES) cumulativeBuckets[k] += outDist[k];
    }

    // --- Timing estimation ---
    // Antigravity streams parallel tool calls incrementally, setting each GENERIC
    // step's created_at when the model finishes emitting that tool call. So the
    // model's true generation end time is the LAST child GENERIC's created_at
    // (not the first, which would prematurely cut off multi-tool streams).
    const firstChildIdx = pIdx + 1 < nextPIdx ? pIdx + 1 : -1;
    const lastChildIdx = nextPIdx - 1 > pIdx ? nextPIdx - 1 : -1;
    const lastGenericStep = childGenerics.length ? childGenerics[childGenerics.length - 1] : null;
    const hasMeasuredEnd = Boolean(lastGenericStep)
      || (firstChildIdx >= 0 && steps[firstChildIdx].type !== 'USER_INPUT');

    let callModelMs = 0;
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

    const breakdownModelMs = callModelMs > 0
      ? callModelMs
      : (outTok > 0 ? Math.round((outTok / 90) * 1000) : 0);

    const waitPart = Math.round(breakdownModelMs * 0.28);
    const genPart = Math.max(0, breakdownModelMs - waitPart);
    const thW = pStep.thinking ? estimateTokens(pStep.thinking) : 0;
    const rpW = pStep.content ? estimateTokens(pStep.content) : 0;
    const taW = tcs.length ? estimateTokens(JSON.stringify(tcs)) : 0;
    const genW = thW + rpW + taW;
    modelWaitMs += waitPart;
    if (genW > 0) {
      const thPart = Math.round((thW / genW) * genPart);
      const rpPart = Math.round((rpW / genW) * genPart);
      thinkingMs += thPart;
      replyMs += rpPart;
      toolArgsMs += Math.max(0, genPart - thPart - rpPart);
    } else {
      replyMs += genPart;
    }

    if (firstChildIdx >= 0 && tcs.length > 0 && nextPIdx < steps.length) {
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
    const lastP = steps[plannerIndices[plannerIndices.length - 1]];
    const lastModel = String(lastP.model || latestModel || 'default');
    const outW = emptyBuckets();
    if (lastP.thinking) outW.thinking = estimateTokens(lastP.thinking);
    if (lastP.content) outW.assistant_reply = estimateTokens(lastP.content);
    if (Array.isArray(lastP.tool_calls) && lastP.tool_calls.length) {
      outW.tool_calls = estimateTokens(JSON.stringify(lastP.tool_calls));
    }
    if (outW.thinking + outW.assistant_reply + outW.tool_calls === 0) outW.assistant_reply = 1;
    const lastOutDist = normalizeDistribute(outW, lastOutputTokens);
    for (const k of CATEGORIES) currentBuckets[k] += lastOutDist[k];
    currentContext += lastOutputTokens;

    const lastMc = ensureModelContext(lastModel);
    lastMc.thinking += lastOutDist.thinking;
    lastMc.reply += lastOutDist.assistant_reply;
    lastMc.total += lastOutDist.thinking + lastOutDist.assistant_reply;
    if (lastOutDist.thinking + lastOutDist.assistant_reply > 0) {
      const lpMs = parseMs(lastP.created_at);
      lastMc.items.push({
        step: lastP.step_index ?? plannerIndices[plannerIndices.length - 1],
        at: lastP.created_at || '',
        ms: Number.isFinite(lpMs) ? lpMs : lastMs,
        thinkingTokens: lastOutDist.thinking,
        replyTokens: lastOutDist.assistant_reply,
        tokens: lastOutDist.thinking + lastOutDist.assistant_reply,
        preview: (lastP.content || lastP.thinking || '').replace(/\s+/g, ' ').trim().slice(0, 90),
        toolCount: Array.isArray(lastP.tool_calls) ? lastP.tool_calls.length : 0,
      });
    }
  }

  // Merge skill_injection by skill name (normalized to currentBuckets.skill_injection)
  if (categoryItems.skill_injection.length > 0) {
    const grouped = new Map();
    let rawSum = 0;
    for (const it of categoryItems.skill_injection) {
      const key = String(it.label || 'skill');
      const tok = Math.max(0, it.tokens || 0);
      rawSum += tok;
      if (!grouped.has(key)) {
        grouped.set(key, { label: key, count: 0, rawTokens: 0, detail: it.detail || '' });
      }
      const rec = grouped.get(key);
      rec.count += 1;
      rec.rawTokens += tok;
      if (it.detail && !rec.detail) rec.detail = it.detail;
    }
    const targetSkill = currentBuckets.skill_injection || rawSum;
    const merged = [...grouped.values()].map((rec) => ({
      label: rec.label,
      count: rec.count,
      tokens: rawSum > 0 ? Math.max(1, Math.round((rec.rawTokens / rawSum) * targetSkill)) : 0,
      detail: rec.detail,
      tool: 'skill',
      step: 0,
    }));
    merged.sort((a, b) => b.tokens - a.tokens);
    categoryItems.skill_injection = merged;
  }

  // Merge tool_calls by (tool name, success/error) so failed calls are tallied on their own row
  if (categoryItems.tool_calls.length > 0) {
    const grouped = new Map();
    let rawSum = 0;
    for (const it of categoryItems.tool_calls) {
      const toolName = String(it.tool || it.label || 'tool');
      const isErr = it.status === 'ERROR';
      const key = `${toolName}:${isErr ? 'err' : 'ok'}`;
      const tok = Math.max(0, it.tokens || 0);
      rawSum += tok;
      if (!grouped.has(key)) {
        grouped.set(key, { label: toolName, tool: toolName, failed: isErr, count: 0, rawTokens: 0, samples: [] });
      }
      const rec = grouped.get(key);
      rec.count += 1;
      rec.rawTokens += tok;
      if (it.label) rec.samples.push({ label: it.label, tokens: tok, step: it.step || 0 });
    }
    const targetTools = currentBuckets.tool_calls || rawSum;
    const merged = [...grouped.values()].map((rec) => {
      const topSamples = rec.samples
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 6)
        .map((s) => `${s.step ? `#${s.step} ` : ''}${s.label}`)
        .join('\n');
      return {
        label: rec.label,
        tool: rec.tool,
        count: rec.count,
        failed: rec.failed,
        status: rec.failed ? 'ERROR' : 'DONE',
        tokens: rawSum > 0 ? Math.max(1, Math.round((rec.rawTokens / rawSum) * targetTools)) : 0,
        detail: topSamples,
        step: 0,
      };
    });
    merged.sort((a, b) => b.tokens - a.tokens);
    categoryItems.tool_calls = merged;
  }

  // Merge user_messages by input type (text, image, file) normalized to currentBuckets.user_messages
  if (categoryItems.user_messages.length > 0) {
    const grouped = new Map();
    let rawSum = 0;
    for (const it of categoryItems.user_messages) {
      const g = it.group || 'text';
      const tok = Math.max(0, it.tokens || 0);
      rawSum += tok;
      if (!grouped.has(g)) {
        grouped.set(g, { group: g, label: it.label || g, count: 0, rawTokens: 0 });
      }
      const rec = grouped.get(g);
      rec.count += Math.max(1, Number(it.itemCount) || 1);
      rec.rawTokens += tok;
    }
    const targetUser = currentBuckets.user_messages || rawSum;
    const merged = [...grouped.values()].map((rec) => ({
      group: rec.group,
      label: rec.label,
      count: rec.count,
      tokens: rawSum > 0 ? Math.max(1, Math.round((rec.rawTokens / rawSum) * targetUser)) : 0,
      tool: 'user',
      step: 0,
    }));
    merged.sort((a, b) => b.tokens - a.tokens);
    categoryItems.user_messages = merged;
  }

  // Merge injected_content into clean grouped buckets (time, image, compaction, settings, other)
  // normalized proportionally to currentBuckets.injected_content so sums stay aligned after compaction.
  if (categoryItems.injected_content.length > 0) {
    const grouped = new Map();
    let rawSum = 0;
    for (const it of categoryItems.injected_content) {
      const g = it.group || 'other';
      rawSum += Math.max(0, it.tokens || 0);
      if (!grouped.has(g)) {
        grouped.set(g, { group: g, label: it.label || g, count: 0, rawTokens: 0, lastDetail: '' });
      }
      const rec = grouped.get(g);
      rec.count += 1;
      rec.rawTokens += Math.max(0, it.tokens || 0);
      if (it.detail) rec.lastDetail = it.detail;
    }
    const targetInj = currentBuckets.injected_content || rawSum;
    const merged = [...grouped.values()].map((rec) => ({
      group: rec.group,
      label: rec.label,
      count: rec.count,
      tokens: rawSum > 0 ? Math.max(1, Math.round((rec.rawTokens / rawSum) * targetInj)) : 0,
      detail: rec.lastDetail,
      tool: 'system',
      step: 0,
    }));
    merged.sort((a, b) => b.tokens - a.tokens);
    categoryItems.injected_content = merged;
  }

  // Enrich modelsUsed & modelContext with aggregate speed/token stats
  const modelsBreakdown = Object.entries(modelsUsed)
    .map(([m, mu]) => {
      const promptAll = mu.inputTokens + mu.cacheReadTokens;
      const total = promptAll + mu.outputTokens;
      const tMs = mu.timedDurationMs || 0;
      const tOut = mu.timedOutputTokens || 0;
      return {
        model: m,
        inputTokens: mu.inputTokens,
        cacheReadTokens: mu.cacheReadTokens,
        outputTokens: mu.outputTokens,
        totalTokens: total,
        calls: mu.calls,
        durationMs: mu.durationMs,
        cacheHitRate: promptAll > 0 ? mu.cacheReadTokens / promptAll : 0,
        tokPerSec: tMs > 0 ? Math.round((tOut / (tMs / 1000)) * 10) / 10 : 0,
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const modelComposition = Object.values(modelContext).map((mc) => {
    const mu = modelsUsed[mc.model] || {
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
    const totalIn = mu.inputTokens + mu.cacheReadTokens;
    const totalAll = totalIn + mu.outputTokens;
    const tMs = mu.timedDurationMs || 0;
    const tOut = mu.timedOutputTokens || 0;
    // Strictly current-window breakdown matching mc.total (mc.thinking + mc.reply)
    const typeBreakdown = [
      { type: 'thinking', tokens: mc.thinking },
      { type: 'reply', tokens: mc.reply },
    ].filter((x) => x.tokens > 0);
    const avgTokPerSec = tMs > 0 ? Math.round((tOut / (tMs / 1000)) * 10) / 10 : 0;
    const postCompactTokPerSec = mc.postCompactTimedMs > 0
      ? Math.round((mc.postCompactTimedOut / (mc.postCompactTimedMs / 1000)) * 10) / 10
      : avgTokPerSec;
    return {
      ...mc,
      inputTokens: mu.inputTokens,
      cacheReadTokens: mu.cacheReadTokens,
      outputTokens: mu.outputTokens,
      totalTokens: totalAll,
      cacheHitRate: totalIn > 0 ? mu.cacheReadTokens / totalIn : 0,
      durationMs: mu.durationMs,
      tokPerSec: avgTokPerSec,
      postCompactTokPerSec,
      typeBreakdown,
    };
  }).sort((a, b) => b.total - a.total);

  const activeCoreMs = modelWaitMs + thinkingMs + replyMs + toolArgsMs + toolExecMs;
  if (activeCoreMs > 0 && otherMs === 0) {
    otherMs = Math.round(activeCoreMs * 0.015);
  }
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
      replyMs,
      toolArgsMs,
      toolExecMs,
      otherMs,
      outputTokPerSec,
      maxTokPerSec: resolvedMaxTokPerSec,
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

function cleanArgsObject(rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(rawArgs)) {
    out[k] = typeof v === 'string' ? unwrapArg(v) : v;
  }
  return out;
}

function compactArgsPreview(argsObj) {
  try {
    const str = JSON.stringify(argsObj);
    return str.length > 140 ? `${str.slice(0, 140)}…` : str;
  } catch {
    return '';
  }
}

function compactResultPreview(text) {
  const clean = String(text || '')
    .replace(/^Created At:.*\n?/gm, '')
    .replace(/^Completed At:.*\n?/gm, '')
    .replace(/^Command exited with code \d+\s*/m, (m) => `[${m.trim()}] `)
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean;
}

/**
 * Extracts XML-tagged injected prompt blocks (e.g. <ADDITIONAL_METADATA>,
 * <USER_SETTINGS_CHANGE>) that Antigravity appends to USER_INPUT steps.
 */
function extractInjectedBlocks(injectedText) {
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

function detectSystemBadges(tag, text) {
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

/**
 * Parses a transcript JSONL string into a full chronological interaction trace:
 *   - summary items (lightweight list for fast rendering even on 2000+ step sessions)
 *   - detail records (full args, thinking, reply, tool output, timestamps)
 */
export function parseTrace(text, { hookTimings = null } = {}) {
  const hookIntervals = buildHookIntervals(hookTimings);
  const hookSummary = summarizeHookTelemetry(hookTimings);
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
  const steps = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') steps.push(obj);
    } catch {
      // Ignore torn trailing line
    }
  }

  const items = [];
  const details = [];
  const counts = { total: 0, input: 0, system: 0, skill: 0, model: 0, tool: 0, error: 0 };
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
    else if (summary.kind === 'model') counts.model++;
    else if (summary.kind === 'tool') counts.tool++;
    if (summary.hasError) counts.error++;
    return idx;
  };

  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    const stMs = parseMs(st.created_at);

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

      // Emit each injected metadata / settings block as its own visible trace entry
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

      // Detect context compaction drops as their own Injected/System trace marker
      if (prevPromptTokens > 0 && promptTok < prevPromptTokens - 1000) {
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
      prevPromptTokens = promptTok;

      // Collect following GENERIC tool result steps up to next non-GENERIC step
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
      let timingSource = '';
      if (Number.isFinite(stMs) && Number.isFinite(nextMs) && nextMs >= stMs) {
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
          timingSource,
          timingUnavailable: modelDurMs === 0,
          status: st.status || 'DONE',
          hasError: st.status === 'ERROR',
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
            const sk = (tcName === 'read_file' || tcName === 'view_file')
              ? extractSkillName(cleanArgs.Path || cleanArgs.AbsolutePath)
              : null;
            return { name: sk || tcName, rawToolName: tcName, isSkill: Boolean(sk), args: cleanArgs };
          }),
          childToolIdxs: [],
        },
      );

      // Next boundary timestamp after tool batch
      const afterBatchMs = scan < steps.length ? parseMs(steps[scan].created_at) : NaN;

      for (let j = 0; j < tcs.length; j++) {
        const tc = tcs[j];
        const resWrap = childGenerics[j] || null;
        const resStep = resWrap?.stepObj || null;
        const cleanArgs = cleanArgsObject(tc?.args);
        const toolName = String(tc?.name || 'tool');
        const skillName = (toolName === 'read_file' || toolName === 'view_file')
          ? extractSkillName(cleanArgs.Path || cleanArgs.AbsolutePath)
          : null;
        const resStartMs = resStep ? parseMs(resStep.created_at) : NaN;
        let resNextMs = j + 1 < childGenerics.length
          ? parseMs(childGenerics[j + 1].stepObj.created_at)
          : afterBatchMs;
        let toolDurMs = 0;
        if (Number.isFinite(resStartMs) && Number.isFinite(resNextMs) && resNextMs >= resStartMs) {
          toolDurMs = Math.min(120_000, resNextMs - resStartMs);
        }
        // Enrich with exact PostToolUse completion timestamp & host error when captured by hook
        const resStepIdx = resStep?.step_index;
        let hookError = '';
        if (Number.isFinite(resStepIdx) && postToolsByStep.has(resStepIdx)) {
          const candidates = postToolsByStep.get(resStepIdx);
          const matchedHook = candidates.find((c) => !c._used && (!c.tool || c.tool === toolName))
            || candidates.find((c) => !c._used);
          if (matchedHook) {
            matchedHook._used = true;
            if (matchedHook.err) hookError = String(matchedHook.err);
            if (Number.isFinite(resStartMs) && matchedHook.ts >= resStartMs && matchedHook.ts - resStartMs <= 300_000) {
              toolDurMs = Math.max(1, matchedHook.ts - resStartMs);
              resNextMs = matchedHook.ts;
            }
          }
        }
        const rawOut = String(resStep?.content || '');
        const failed = Boolean(hookError) || commandFailedFromOutput(resStep);
        const childIdx = pushEntry(
          {
            kind: skillName ? 'skill' : 'tool',
            turn,
            step: resStep?.step_index ?? (st.step_index ?? i),
            callStep: st.step_index ?? i,
            at: resStep?.created_at || st.created_at || '',
            endAt: Number.isFinite(resNextMs) ? new Date(resNextMs).toISOString() : '',
            ms: Number.isFinite(resStartMs) ? resStartMs : (Number.isFinite(stMs) ? stMs : 0),
            durationMs: toolDurMs,
            status: failed ? 'ERROR' : (resStep?.status || 'DONE'),
            hasError: failed,
            toolName,
            skillName: skillName || '',
            argsPreview: skillName ? skillName : compactArgsPreview(cleanArgs),
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

      // Skip past consumed GENERIC children
      i = scan - 1;
      continue;
    }

    // Capture any recorded SYSTEM / hook-injected / checkpoint steps
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

  return { counts, items, details, liveState: hookSummary.liveState };
}
