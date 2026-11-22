/**
 * Shared frontend UI constants, color palettes, and default layout specs.
 */

export const SETTINGS_KEY = 'agy-context.settings.v2';

export const NON_MODEL_CATS = [
  { key: 'system_prompt', color: 'var(--slate-ink)' },
  { key: 'tool_definitions', color: 'var(--amber)' },
  { key: 'skill_injection', color: 'var(--pink)' },
  { key: 'user_messages', color: 'var(--green)' },
  { key: 'file_reads', color: 'var(--lime)' },
  { key: 'tool_calls', color: 'var(--cyan)' },
  { key: 'injected_content', color: 'var(--blue)' },
];

export const ALL_OVERVIEW_CATS = [
  ...NON_MODEL_CATS,
  { key: 'thinking', color: 'var(--violet)' },
  { key: 'assistant_reply', color: 'var(--rose)' },
];

export const MODEL_COLORS = ['var(--violet)', 'var(--rose)', '#14b8a6', '#f97316'];

export const MODEL_TYPE_COLORS = {
  thinking: 'var(--violet)',
  tool_call: 'var(--amber)',
  reply: 'var(--slate-ink)',
};

export const USER_INPUT_COLORS = {
  text: 'var(--green)',
  image: 'var(--pink)',
  file: 'var(--blue)',
};

export const TIMING_META = [
  { key: 'modelWaitMs', color: 'var(--blue)' },
  { key: 'thinkingMs', color: 'var(--violet)' },
  { key: 'modelGenMs', color: 'var(--rose)' },
  { key: 'toolExecMs', color: 'var(--cyan)' },
  { key: 'otherMs', color: 'var(--green)', optional: true },
];

export const BAR_PALETTE = [
  'var(--blue)',
  'var(--cyan)',
  'var(--green)',
  'var(--amber)',
  'var(--violet)',
  'var(--pink)',
  'var(--rose)',
];

export const DEFAULT_SESSION_CTX_LIMIT = 500_000;

export const DEFAULT_SESSION_ORDER = ['ctx', 'telemetry', 'models', 'tokens', 'timing', 'trend', 'hooks', 'trace'];
export const DEFAULT_OVERVIEW_ORDER = ['top', 'mid', 'models', 'hooks', 'lists', 'sessions'];

export const SESSION_CARD_WEIGHTS = {
  ctx: 690,
  telemetry: 80,
  models: 145,
  tokens: 135,
  timing: 110,
  trend: 210,
  hooks: 115,
  trace: 270,
};

export const CHEVRON_SVG = '<svg class="bd-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5L8 6l-3.5 3.5"/></svg>';

export const TRACE_TAG_DEFS = [
  { key: 'input', labelKey: 'trace.input', color: 'var(--green)' },
  { key: 'system', labelKey: 'trace.injected', color: 'var(--blue)' },
  { key: 'skill', labelKey: 'trace.skill', color: 'var(--pink)' },
  { key: 'mcp', labelKey: 'trace.mcp', color: 'var(--mcp)' },
  { key: 'model', labelKey: 'trace.model', color: 'var(--violet)' },
  { key: 'tool', labelKey: 'trace.tool', color: 'var(--amber)' },
  { key: 'compaction', labelKey: 'trace.compactionTag', color: 'var(--slate-ink)' },
  { key: 'error', labelKey: 'trace.error', color: 'var(--rose)' },
];
