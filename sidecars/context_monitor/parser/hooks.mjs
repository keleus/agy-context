/**
 * Lifecycle hook telemetry processing: invocation interval matching,
 * reverted branch detection, and live turn/tool telemetry summarization.
 */

import { parseMs } from './estimators.mjs';

export function buildHookIntervals(hookTimings) {
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

export function matchHookInterval(intervals, stepIdx, stMs) {
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

export function computeRevertedFlags(steps) {
  const revertedFlags = new Array(steps.length).fill(false);
  let minStepSeen = Infinity;
  for (let i = steps.length - 1; i >= 0; i--) {
    const si = steps[i]?.step_index;
    if (typeof si === 'number' && Number.isFinite(si)) {
      if (si >= minStepSeen) {
        revertedFlags[i] = true;
      } else {
        minStepSeen = si;
      }
    }
  }
  return revertedFlags;
}

/**
 * Summarizes lifecycle hook telemetry (SessionStart, PreInvocation, PostToolUse,
 * PostInvocation, Stop) into live in-flight status, turn-level duration/depth/
 * termination stats, and per-tool completion & error telemetry.
 *
 * When transcript `steps` are provided, reconciles an open `PreInvocation`
 * against active (non-reverted) `PLANNER_RESPONSE` steps so `phase: 'generating'`
 * only stays active while the model itself is generating — NOT while blocked on
 * tool execution or user-interactive tools like `ask_question`.
 */
export function summarizeHookTelemetry(hookTimings, nowMs = Date.now(), { steps = null, revertedFlags = null } = {}) {
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
  const lastEvent = sorted[sorted.length - 1];
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].ev === 'PreInvocation') { lastPre = sorted[i]; break; }
    if (sorted[i].ev === 'Stop') break;
  }
  let liveState = { active: false, phase: 'idle', sinceMs: 0, inv: 0, model: '', lastTool: '' };
  if (lastPre && lastEvent && lastEvent.ev !== 'Stop' && lastEvent.ev !== 'PostInvocation' && lastEvent.ev !== 'SessionStart') {
    const age = nowMs - lastPre.ts;
    if (age >= -5000 && age <= MAX_INFLIGHT_MS) {
      if (lastEvent.ev === 'PostToolUse' || lastEvent.ev === 'PreToolUse') {
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

  // Reconcile against transcript steps: once the model's PLANNER_RESPONSE for
  // this PreInvocation is written as completed, model generation has ended
  // (the turn is either waiting/running tools such as ask_question, or idle).
  if (liveState.active && liveState.phase === 'generating' && lastPre && Array.isArray(steps) && steps.length > 0) {
    const flags = Array.isArray(revertedFlags) && revertedFlags.length === steps.length
      ? revertedFlags
      : computeRevertedFlags(steps);
    const initialSteps = lastPre.steps != null && Number.isFinite(Number(lastPre.steps))
      ? Number(lastPre.steps)
      : null;
    const isStepDone = (st) => {
      const s = String(st?.status || '').toUpperCase();
      return !s || (s !== 'RUNNING' && s !== 'PENDING' && s !== 'IN_PROGRESS' && s !== 'GENERATING');
    };

    let completedPlanner = null;
    if (initialSteps != null) {
      for (let i = steps.length - 1; i >= 0; i--) {
        if (flags[i]) continue;
        const st = steps[i];
        if (st?.type !== 'PLANNER_RESPONSE') continue;
        const si = st.step_index != null ? Number(st.step_index) : i;
        if (Number.isFinite(si) && si >= initialSteps) {
          if (isStepDone(st)) completedPlanner = st;
          break;
        }
        if (Number.isFinite(si) && si < initialSteps) break;
      }
    } else {
      for (let i = steps.length - 1; i >= 0; i--) {
        if (flags[i]) continue;
        const st = steps[i];
        if (st?.type === 'PLANNER_RESPONSE' && isStepDone(st)) {
          const stMs = parseMs(st.created_at);
          if (Number.isFinite(stMs) && stMs >= lastPre.ts - 2000) {
            completedPlanner = st;
          }
        }
        break;
      }
    }

    if (completedPlanner) {
      const stStatus = String(completedPlanner.status || '').toUpperCase();
      const tcs = Array.isArray(completedPlanner.tool_calls) ? completedPlanner.tool_calls : [];
      if (tcs.length > 0 && stStatus !== 'ERROR' && stStatus !== 'CANCELED' && stStatus !== 'CANCELLED') {
        liveState = {
          active: true,
          phase: 'tools',
          sinceMs: lastPre.ts,
          inv: Number(lastPre.inv) || 1,
          model: String(lastPre.model || ''),
          lastTool: String(tcs[0]?.name || ''),
        };
      } else {
        liveState = { active: false, phase: 'idle', sinceMs: 0, inv: 0, model: '', lastTool: '' };
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
