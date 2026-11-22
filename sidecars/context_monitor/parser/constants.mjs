/**
 * Shared category constants and default model specifications for transcript analysis.
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
