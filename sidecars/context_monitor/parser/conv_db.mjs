/**
 * Zero-dependency reader for Antigravity per-conversation SQLite databases
 * (`~/.gemini/antigravity/conversations/<conversationId>.db`) and summary status
 * (`~/.gemini/antigravity/conversation_summaries.db`).
 *
 * Extracts exact, non-estimated telemetry directly from Antigravity's stored
 * Protobuf blobs without requiring any lifecycle hooks:
 *   - Real TTFT (`gen_metadata.1.11`, fallback `steps.metadata` f6 - f1)
 *   - Real stream/generation duration (`gen_metadata.1.12`, fallback f7 - f6)
 *   - Real thinking completion duration (`step_payload.20.11` -> thinking stream = f11 - TTFT)
 *   - Real per-tool execution duration (`steps.metadata` f8 - f6)
 *   - Exact API thinking vs non-thinking output tokens (`gen_metadata.1.4.9` / `1.4.10`)
 *   - Exact model context window ceiling (`gen_metadata.1.9.10.4`)
 *   - Authoritative live in-flight status (`steps.status = 2` + `conversation_summaries.status`)
 *   - Host-level tool error details (`steps.status = 7` + `steps.error_details`)
 *   - Per-turn invocation counts (`executor_metadata`)
 */

let DatabaseSyncCtor = null;
try {
  const mod = await import('node:sqlite');
  if (typeof mod?.DatabaseSync === 'function') {
    DatabaseSyncCtor = mod.DatabaseSync;
  }
} catch {
  // Older Node.js without built-in node:sqlite; caller degrades gracefully.
  DatabaseSyncCtor = null;
}

const PLANNER_STEP_TYPE = 15;
const STEP_STATUS_RUNNING = 2;
const STEP_STATUS_ERROR = 7;
const UTF8_DECODER = new TextDecoder('utf-8');

export function isSqliteSupported() {
  return DatabaseSyncCtor !== null;
}

/**
 * Walks a raw Protobuf wire-format buffer and invokes `onField(fieldNum, wireType, value)`.
 */
export function walkPb(buf, onField) {
  if (!buf || !buf.length) return;
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const len = bytes.length;
  let pos = 0;

  const readVarint = () => {
    let result = 0n;
    let shift = 0n;
    while (pos < len) {
      const b = bytes[pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return Number(result);
      shift += 7n;
      if (shift > 63n) return NaN;
    }
    return NaN;
  };

  while (pos < len) {
    const tag = readVarint();
    if (!Number.isFinite(tag) || tag <= 0) break;
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) {
      const val = readVarint();
      if (!Number.isFinite(val)) break;
      onField(field, 0, val);
    } else if (wire === 1) {
      if (pos + 8 > len) break;
      onField(field, 1, bytes.subarray(pos, pos + 8));
      pos += 8;
    } else if (wire === 2) {
      const subLen = readVarint();
      if (!Number.isFinite(subLen) || subLen < 0 || pos + subLen > len) break;
      onField(field, 2, bytes.subarray(pos, pos + subLen));
      pos += subLen;
    } else if (wire === 5) {
      if (pos + 4 > len) break;
      onField(field, 5, bytes.subarray(pos, pos + 4));
      pos += 4;
    } else {
      break;
    }
  }
}

/**
 * Decodes `google.protobuf.Duration` or `google.protobuf.Timestamp` to milliseconds.
 */
export function readPbTimeMs(buf) {
  let sec = 0;
  let nanos = 0;
  walkPb(buf, (field, wire, val) => {
    if (wire !== 0) return;
    if (field === 1) sec = val;
    else if (field === 2) nanos = val;
  });
  if (sec === 0 && nanos === 0) return 0;
  return sec * 1000 + nanos / 1e6;
}

/**
 * Decodes a single `gen_metadata.data` Protobuf blob.
 */
export function decodeGenMetadata(buf) {
  const out = {
    ttftMs: 0,
    streamMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: null,
    responseTokens: null,
    contextWindow: 0,
    modelId: '',
    modelDisplayName: '',
  };

  walkPb(buf, (topField, topWire, topVal) => {
    if (topField !== 1 || topWire !== 2) return;
    walkPb(topVal, (f, w, v) => {
      if (w !== 2) return;
      if (f === 4) {
        walkPb(v, (uf, uw, uv) => {
          if (uw !== 0) return;
          if (uf === 2) out.inputTokens = uv;
          else if (uf === 3) out.outputTokens = uv;
          else if (uf === 5) out.cacheReadTokens = uv;
          else if (uf === 9) out.thinkingTokens = uv;
          else if (uf === 10) out.responseTokens = uv;
        });
      } else if (f === 9) {
        walkPb(v, (nf, nw, nv) => {
          if (nf !== 10 || nw !== 2) return;
          walkPb(nv, (cf, cw, cv) => {
            if (cf === 4 && cw === 0 && cv > 0) out.contextWindow = cv;
          });
        });
      } else if (f === 11) {
        out.ttftMs = Math.max(0, Math.round(readPbTimeMs(v)));
      } else if (f === 12) {
        out.streamMs = Math.max(0, Math.round(readPbTimeMs(v)));
      } else if (f === 19) {
        out.modelId = UTF8_DECODER.decode(v);
      } else if (f === 21) {
        out.modelDisplayName = UTF8_DECODER.decode(v);
      }
    });
  });

  return out;
}

/**
 * Decodes a single `steps.metadata` Protobuf blob.
 */
export function decodeStepMetadata(buf) {
  const out = {
    startMs: 0,
    firstTokenMs: 0,
    streamEndMs: 0,
    endMs: 0,
    runningStartMs: 0,
    transitions: [],
    hasGenRef: false,
    genMetaIdx: null,
  };

  walkPb(buf, (f, w, v) => {
    if (w !== 2) return;
    if (f === 1) out.startMs = readPbTimeMs(v);
    else if (f === 6) out.firstTokenMs = readPbTimeMs(v);
    else if (f === 7) out.streamEndMs = readPbTimeMs(v);
    else if (f === 8) out.endMs = readPbTimeMs(v);
    else if (f === 32) out.runningStartMs = readPbTimeMs(v);
    else if (f === 26) {
      // Status transition log: repeated { f1: status_enum, f2: Timestamp }
      walkPb(v, (sf, sw, sv) => {
        if (sf !== 1 || sw !== 2) return;
        let status = 0;
        let tsMs = 0;
        walkPb(sv, (tf, tw, tv) => {
          if (tf === 1 && tw === 0) status = tv;
          else if (tf === 2 && tw === 2) tsMs = readPbTimeMs(tv);
        });
        if (status > 0 && tsMs > 0) {
          out.transitions.push({ status, tsMs });
        }
      });
    } else if (f === 20) {
      out.hasGenRef = true;
      let refIdx = 0; // proto3 omits default 0
      walkPb(v, (sf, sw, sv) => {
        if (sf === 3 && sw === 0) refIdx = sv;
      });
      out.genMetaIdx = refIdx;
    }
  });

  return out;
}

/**
 * Merges overlapping `[startMs, endMs]` intervals and returns total covered ms.
 */
export function mergeIntervalsDurationMs(intervals) {
  if (!Array.isArray(intervals) || !intervals.length) return 0;
  const valid = intervals
    .filter((iv) => Array.isArray(iv) && iv[0] > 0 && iv[1] > iv[0])
    .sort((a, b) => a[0] - b[0]);
  if (!valid.length) return 0;
  let total = 0;
  let [curStart, curEnd] = valid[0];
  for (let i = 1; i < valid.length; i++) {
    const [s, e] = valid[i];
    if (s <= curEnd) {
      if (e > curEnd) curEnd = e;
    } else {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  total += curEnd - curStart;
  return Math.round(total);
}

/**
 * Computes actual active execution intervals (`status === RUNNING (2)`) for a
 * tool step, excluding `PENDING (1)` queue waits and `WAITING_FOR_USER (9)`
 * approval waits.
 */
function computeToolRunningIntervals(meta) {
  if (!meta) return { runningIntervals: [], activeMs: 0 };
  const tr = meta.transitions;
  if (Array.isArray(tr) && tr.length > 0) {
    const sorted = tr.slice().sort((a, b) => a.tsMs - b.tsMs);
    const intervals = [];
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].status !== STEP_STATUS_RUNNING) continue;
      const start = sorted[i].tsMs;
      const nextTs = i + 1 < sorted.length ? sorted[i + 1].tsMs : meta.endMs;
      if (nextTs > start) {
        intervals.push([Math.round(start), Math.round(nextTs)]);
      }
    }
    if (intervals.length > 0) {
      return {
        runningIntervals: intervals,
        activeMs: mergeIntervalsDurationMs(intervals),
      };
    }
  }

  // Fallback when transition log is absent: prefer meta.32 (running start), then meta.6, then meta.1
  let start = 0;
  if (meta.runningStartMs > 0 && meta.endMs >= meta.runningStartMs) {
    start = meta.runningStartMs;
  } else if (meta.firstTokenMs > 0 && meta.endMs >= meta.firstTokenMs) {
    start = meta.firstTokenMs;
  } else if (meta.startMs > 0 && meta.endMs >= meta.startMs) {
    start = meta.startMs;
  }
  if (start > 0 && meta.endMs > start) {
    const iv = [Math.round(start), Math.round(meta.endMs)];
    return { runningIntervals: [iv], activeMs: iv[1] - iv[0] };
  }
  return { runningIntervals: [], activeMs: 0 };
}

/**
 * Decodes `thinkingUntilMs` (elapsed ms from request start to end of thinking)
 * from a `PLANNER_RESPONSE` `steps.step_payload` Protobuf blob (`payload.20.11`).
 */
export function decodePlannerPayloadTiming(buf) {
  let thinkingUntilMs = 0;
  walkPb(buf, (f, w, v) => {
    if (f !== 20 || w !== 2) return;
    walkPb(v, (sf, sw, sv) => {
      if (sf === 11 && sw === 2) {
        thinkingUntilMs = Math.max(0, Math.round(readPbTimeMs(sv)));
      }
    });
  });
  return { thinkingUntilMs };
}

/**
 * Decodes host-level error text from `steps.error_details` Protobuf blob.
 */
export function decodeErrorDetails(buf) {
  if (!buf || !buf.length) return '';
  let msg = '';
  let fallback = '';
  walkPb(buf, (f, w, v) => {
    if (w !== 2) return;
    if (f === 2 && !msg) msg = UTF8_DECODER.decode(v).trim();
    else if (f === 3 && !fallback) fallback = UTF8_DECODER.decode(v).trim();
  });
  return (msg || fallback).slice(0, 240);
}

/**
 * Decodes turn-level execution stats from `executor_metadata.data` Protobuf blob.
 */
export function decodeExecutorMetadata(buf) {
  const out = { terminationCode: 0, invocations: 0, lastStepIdx: -1 };
  walkPb(buf, (f, w, v) => {
    if (w !== 0) return;
    if (f === 1) out.terminationCode = v;
    else if (f === 2) out.invocations = v;
    else if (f === 3) out.lastStepIdx = v;
  });
  return out;
}

/**
 * Reads exact per-step timing, token, context-window, error, and live status
 * telemetry from an already-open `node:sqlite` DatabaseSync handle.
 */
export function extractTelemetryFromDb(db, { summaryStatus = null, nowMs = Date.now() } = {}) {
  const genMeta = new Map();
  let contextWindow = 0;
  let latestModel = '';

  try {
    const gmStmt = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx');
    for (const row of gmStmt.iterate()) {
      if (!row?.data) continue;
      const decoded = decodeGenMetadata(row.data);
      genMeta.set(Number(row.idx), decoded);
      if (decoded.contextWindow > 0) contextWindow = decoded.contextWindow;
      if (decoded.modelDisplayName || decoded.modelId) {
        latestModel = decoded.modelDisplayName || decoded.modelId;
      }
    }
  } catch {
    // Table may be absent in partial/corrupt DBs; continue with steps.
  }

  const steps = new Map();
  let runningStep = null;
  let lastEndMs = 0;
  let toolCallsCount = 0;
  let toolErrorsCount = 0;

  try {
    const stepStmt = db.prepare(
      `SELECT idx, step_type, status, metadata, error_details,
              CASE WHEN step_type = ${PLANNER_STEP_TYPE} THEN step_payload ELSE NULL END AS step_payload
         FROM steps
        ORDER BY idx`,
    );
    for (const row of stepStmt.iterate()) {
      const idx = Number(row.idx);
      const stepType = Number(row.step_type);
      const status = Number(row.status);
      const meta = row.metadata ? decodeStepMetadata(row.metadata) : null;
      const hostError = row.error_details ? decodeErrorDetails(row.error_details) : '';
      const hasError = status === STEP_STATUS_ERROR || Boolean(hostError);

      if (meta?.endMs && meta.endMs > lastEndMs) {
        lastEndMs = Math.round(meta.endMs);
      }

      if (status === STEP_STATUS_RUNNING) {
        runningStep = {
          idx,
          stepType,
          startMs: meta?.startMs ? Math.round(meta.startMs) : 0,
          firstTokenMs: meta?.firstTokenMs ? Math.round(meta.firstTokenMs) : 0,
        };
      }

      if (stepType === PLANNER_STEP_TYPE) {
        const gm = meta?.hasGenRef && meta.genMetaIdx != null ? genMeta.get(meta.genMetaIdx) : null;

        let ttftMs = gm?.ttftMs || 0;
        if (!ttftMs && meta && meta.startMs > 0 && meta.firstTokenMs >= meta.startMs) {
          ttftMs = Math.round(meta.firstTokenMs - meta.startMs);
        }

        let streamMs = gm?.streamMs || 0;
        if (!streamMs && meta && meta.firstTokenMs > 0 && meta.streamEndMs >= meta.firstTokenMs) {
          streamMs = Math.round(meta.streamEndMs - meta.firstTokenMs);
        }

        let totalMs = ttftMs + streamMs;
        if (!totalMs && meta && meta.startMs > 0 && meta.endMs >= meta.startMs) {
          totalMs = Math.round(meta.endMs - meta.startMs);
        }

        const { thinkingUntilMs } = row.step_payload
          ? decodePlannerPayloadTiming(row.step_payload)
          : { thinkingUntilMs: 0 };

        let thinkingMs = 0;
        if (thinkingUntilMs > 0 && streamMs > 0) {
          if (ttftMs > 0 && thinkingUntilMs > ttftMs) {
            thinkingMs = Math.min(streamMs, Math.round(thinkingUntilMs - ttftMs));
          } else if (ttftMs === 0) {
            thinkingMs = Math.min(streamMs, thinkingUntilMs);
          }
        }
        const outputGenMs = Math.max(0, streamMs - thinkingMs);

        steps.set(idx, {
          isPlanner: true,
          status,
          hasError,
          hostError,
          startMs: meta?.startMs ? Math.round(meta.startMs) : 0,
          endMs: meta?.endMs ? Math.round(meta.endMs) : 0,
          ttftMs,
          streamMs,
          totalMs,
          thinkingMs,
          outputGenMs,
          thinkingTokens: gm?.thinkingTokens ?? null,
          responseTokens: gm?.responseTokens ?? null,
          contextWindow: gm?.contextWindow || 0,
        });
      } else if (meta) {
        const { runningIntervals, activeMs: toolExecMs } = computeToolRunningIntervals(meta);
        if (stepType !== 0 && stepType !== 1) {
          toolCallsCount += 1;
          if (hasError) toolErrorsCount += 1;
        }
        steps.set(idx, {
          isPlanner: false,
          status,
          hasError,
          hostError,
          startMs: meta.startMs ? Math.round(meta.startMs) : 0,
          endMs: meta.endMs ? Math.round(meta.endMs) : 0,
          toolExecMs,
          runningIntervals,
        });
      }
    }
  } catch {
    // Steps table unreadable; return partial telemetry if any.
  }

  // Turn execution stats from executor_metadata
  let completedTurns = 0;
  let totalInvocations = 0;
  const reasons = {};
  try {
    const emStmt = db.prepare('SELECT idx, data FROM executor_metadata ORDER BY idx');
    for (const row of emStmt.iterate()) {
      if (!row?.data) continue;
      const em = decodeExecutorMetadata(row.data);
      completedTurns += 1;
      totalInvocations += em.invocations;
      const lastStep = em.lastStepIdx >= 0 ? steps.get(em.lastStepIdx) : null;
      if (lastStep?.hasError) {
        reasons.ERROR = (reasons.ERROR || 0) + 1;
      } else if (em.terminationCode === 4) {
        reasons.NO_TOOL_CALL = (reasons.NO_TOOL_CALL || 0) + 1;
      }
    }
  } catch {
    // executor_metadata optional
  }

  // Authoritative live in-flight status from steps.status = 2 + conversation_summaries.db
  const MAX_INFLIGHT_MS = 10 * 60 * 1000;
  let liveState = { active: false, phase: 'idle', sinceMs: 0, inv: 0, model: '', lastTool: '' };
  if (runningStep) {
    const isGen = runningStep.stepType === PLANNER_STEP_TYPE;
    const sinceMs = isGen
      ? (runningStep.startMs || nowMs)
      : (runningStep.firstTokenMs || runningStep.startMs || nowMs);
    if (nowMs - sinceMs <= MAX_INFLIGHT_MS) {
      liveState = {
        active: true,
        phase: isGen ? 'generating' : 'tools',
        sinceMs,
        inv: 0,
        model: latestModel,
        lastTool: '',
      };
    }
  } else if (summaryStatus?.running) {
    const sinceMs = lastEndMs || nowMs;
    if (nowMs - sinceMs <= MAX_INFLIGHT_MS) {
      liveState = {
        active: true,
        phase: 'generating',
        sinceMs,
        inv: 0,
        model: latestModel,
        lastTool: '',
      };
    }
  }

  const telemetry = {
    hasData: completedTurns > 0 || toolCallsCount > 0 || liveState.active,
    liveState,
    turnStats: {
      completedTurns,
      totalTurnMs: 0,
      avgTurnMs: 0,
      maxTurnMs: 0,
      totalInvocations,
      avgInvocations: completedTurns > 0 ? Math.round((totalInvocations / completedTurns) * 10) / 10 : 0,
      reasons,
    },
    toolStats: {
      calls: toolCallsCount,
      errors: toolErrorsCount,
      errorRate: toolCallsCount > 0 ? toolErrorsCount / toolCallsCount : 0,
    },
  };

  return {
    source: 'db',
    contextWindow,
    latestModel,
    steps,
    telemetry,
  };
}

/**
 * Queries `<appData>/conversation_summaries.db` for the conversation's live
 * running state (`CASCADE_RUN_STATUS_RUNNING` vs `IDLE`).
 */
export function readConversationSummaryStatus(summaryDbPath, convId) {
  if (!summaryDbPath || !convId || !DatabaseSyncCtor) return null;
  let db = null;
  try {
    db = new DatabaseSyncCtor(summaryDbPath, { readOnly: true });
    const row = db
      .prepare('SELECT status, not_fully_idle FROM conversation_summaries WHERE conversation_id = ?')
      .get(convId);
    if (!row) return null;
    const status = String(row.status || '');
    return {
      status,
      running: status === 'CASCADE_RUN_STATUS_RUNNING',
      notFullyIdle: Boolean(row.not_fully_idle),
    };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

/**
 * Opens `<appData>/conversations/<convId>.db` in read-only mode and extracts
 * exact telemetry. Returns `null` if SQLite is unavailable or the file cannot
 * be read.
 */
export function readConversationDb(dbPath, { summaryStatus = null, nowMs = Date.now() } = {}) {
  if (!dbPath || !DatabaseSyncCtor) return null;
  let db = null;
  try {
    db = new DatabaseSyncCtor(dbPath, { readOnly: true });
    return extractTelemetryFromDb(db, { summaryStatus, nowMs });
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}
