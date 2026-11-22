import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeErrorDetails,
  decodeExecutorMetadata,
  decodeGenMetadata,
  decodePlannerPayloadTiming,
  decodeStepMetadata,
  extractTelemetryFromDb,
  isSqliteSupported,
  mergeIntervalsDurationMs,
  parseTrace,
  parseTranscript,
} from '../sidecars/context_monitor/parser.mjs';
import { fmtTraceDur } from '../sidecars/context_monitor/web/js/format.js';

function encodeVarint(val) {
  let n = BigInt(val);
  const out = [];
  while (n >= 0x80n) {
    out.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}

function pbVarint(field, val) {
  return Buffer.concat([encodeVarint((field << 3) | 0), encodeVarint(val)]);
}

function pbBytes(field, buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf-8');
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(b.length), b]);
}

function pbDur(sec, nanos) {
  const parts = [];
  if (sec) parts.push(pbVarint(1, sec));
  if (nanos) parts.push(pbVarint(2, nanos));
  return Buffer.concat(parts);
}

function makeGenMetaBlob({
  inTok = 0,
  outTok = 0,
  cacheTok = 0,
  thinkTok = null,
  respTok = null,
  ctxWindow = 0,
  ttftSec = 0,
  ttftNanos = 0,
  streamSec = 0,
  streamNanos = 0,
  modelId = 'gemini-4-neon',
  displayName = 'Gemini 4 Neon (High)',
}) {
  const usageParts = [
    pbVarint(2, inTok),
    pbVarint(3, outTok),
    pbVarint(5, cacheTok),
  ];
  if (thinkTok != null) usageParts.push(pbVarint(9, thinkTok));
  if (respTok != null) usageParts.push(pbVarint(10, respTok));
  const f1Parts = [
    pbBytes(4, Buffer.concat(usageParts)),
    pbBytes(11, pbDur(ttftSec, ttftNanos)),
    pbBytes(12, pbDur(streamSec, streamNanos)),
    pbBytes(19, modelId),
    pbBytes(21, displayName),
  ];
  if (ctxWindow > 0) {
    f1Parts.push(pbBytes(9, pbBytes(10, pbVarint(4, ctxWindow))));
  }
  return pbBytes(1, Buffer.concat(f1Parts));
}

function makeStepMetaBlob({ startSec, startNanos = 0, firstSec = 0, firstNanos = 0, streamEndSec = 0, streamEndNanos = 0, endSec = 0, endNanos = 0, genMetaIdx = null, includeRef = false }) {
  const parts = [];
  if (startSec) parts.push(pbBytes(1, pbDur(startSec, startNanos)));
  if (firstSec) parts.push(pbBytes(6, pbDur(firstSec, firstNanos)));
  if (streamEndSec) parts.push(pbBytes(7, pbDur(streamEndSec, streamEndNanos)));
  if (endSec) parts.push(pbBytes(8, pbDur(endSec, endNanos)));
  if (includeRef || genMetaIdx != null) {
    const refParts = [pbBytes(1, 'traj-1')];
    if (genMetaIdx != null && genMetaIdx > 0) refParts.push(pbVarint(3, genMetaIdx));
    parts.push(pbBytes(20, Buffer.concat(refParts)));
  }
  return Buffer.concat(parts);
}

function makePlannerPayloadBlob(thinkingSec, thinkingNanos) {
  return pbBytes(20, pbBytes(11, pbDur(thinkingSec, thinkingNanos)));
}

test('protobuf decoders extract exact TTFT, stream, thinking duration, tokens, and context window', () => {
  const gmBuf = makeGenMetaBlob({
    inTok: 3288,
    outTok: 1146,
    cacheTok: 23615,
    thinkTok: 507,
    respTok: 639,
    ctxWindow: 512000,
    ttftSec: 3,
    ttftNanos: 719_601_166,
    streamSec: 8,
    streamNanos: 85_348_417,
  });
  const gm = decodeGenMetadata(gmBuf);
  assert.equal(gm.ttftMs, 3720);
  assert.equal(gm.streamMs, 8085);
  assert.equal(gm.inputTokens, 3288);
  assert.equal(gm.outputTokens, 1146);
  assert.equal(gm.cacheReadTokens, 23615);
  assert.equal(gm.thinkingTokens, 507);
  assert.equal(gm.responseTokens, 639);
  assert.equal(gm.contextWindow, 512000);
  assert.equal(gm.modelDisplayName, 'Gemini 4 Neon (High)');

  // Proto3 default genMetaIdx = 0 when f3 omitted inside f20
  const sm0 = decodeStepMetadata(makeStepMetaBlob({
    startSec: 1795263133,
    firstSec: 1795263137,
    streamEndSec: 1795263138,
    endSec: 1795263138,
    includeRef: true,
    genMetaIdx: 0,
  }));
  assert.equal(sm0.hasGenRef, true);
  assert.equal(sm0.genMetaIdx, 0);
  assert.equal(Math.round(sm0.firstTokenMs - sm0.startMs), 4000);

  const pt = decodePlannerPayloadTiming(makePlannerPayloadBlob(7, 86_429_000));
  assert.equal(pt.thinkingUntilMs, 7086);
});

test('extractTelemetryFromDb + parseTranscript/parseTrace use real DB timings with zero estimation', async () => {
  if (!isSqliteSupported()) return;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER DEFAULT 0);
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, error_details BLOB, step_payload BLOB);
    CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);
  `);

  const insGm = db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)');
  const gm0 = makeGenMetaBlob({
    inTok: 10000,
    outTok: 200,
    cacheTok: 0,
    thinkTok: 120,
    respTok: 80,
    ctxWindow: 512000,
    ttftSec: 4,
    ttftNanos: 0,
    streamSec: 1,
    streamNanos: 0,
  });
  const gm1 = makeGenMetaBlob({
    inTok: 2000,
    outTok: 1000,
    cacheTok: 10000,
    thinkTok: 400,
    respTok: 600,
    ctxWindow: 512000,
    ttftSec: 3,
    ttftNanos: 500_000_000,
    streamSec: 5,
    streamNanos: 0,
  });
  insGm.run(0, gm0, gm0.length);
  insGm.run(1, gm1, gm1.length);

  const insStep = db.prepare('INSERT INTO steps (idx, step_type, status, metadata, error_details, step_payload) VALUES (?, ?, ?, ?, ?, ?)');
  // Step 1: PLANNER_RESPONSE (gm0, ttft=4s, thinkingUntil=4.6s -> thinking=0.6s, outputGen=0.4s)
  insStep.run(
    1,
    15,
    3,
    makeStepMetaBlob({ startSec: 1700000001, firstSec: 1700000005, streamEndSec: 1700000006, endSec: 1700000006, includeRef: true, genMetaIdx: 0 }),
    null,
    makePlannerPayloadBlob(4, 600_000_000),
  );
  // Step 2: Tool step (exec: 1700000006.100 -> 1700000008.600 = 2500ms)
  insStep.run(
    2,
    132,
    3,
    makeStepMetaBlob({ startSec: 1700000006, firstSec: 1700000006, firstNanos: 100_000_000, endSec: 1700000008, endNanos: 600_000_000 }),
    null,
    null,
  );
  // Step 3: Final PLANNER_RESPONSE without tool calls (gm1, ttft=3.5s, thinkingUntil=6.5s -> thinking=3.0s, outputGen=2.0s)
  insStep.run(
    3,
    15,
    3,
    makeStepMetaBlob({ startSec: 1700000009, firstSec: 1700000012, firstNanos: 500_000_000, streamEndSec: 1700000017, streamEndNanos: 500_000_000, endSec: 1700000017, endNanos: 500_000_000, genMetaIdx: 1 }),
    null,
    makePlannerPayloadBlob(6, 500_000_000),
  );
  db.prepare('INSERT INTO executor_metadata (idx, data) VALUES (?, ?)').run(
    0,
    Buffer.concat([pbVarint(1, 4), pbVarint(2, 2), pbVarint(3, 3)]),
  );

  const dbTelemetry = extractTelemetryFromDb(db);
  db.close();

  assert.equal(dbTelemetry.contextWindow, 512000);
  assert.equal(dbTelemetry.steps.get(1).ttftMs, 4000);
  assert.equal(dbTelemetry.steps.get(1).thinkingMs, 600);
  assert.equal(dbTelemetry.steps.get(1).outputGenMs, 400);
  assert.equal(dbTelemetry.steps.get(2).toolExecMs, 2500);
  assert.equal(dbTelemetry.steps.get(3).ttftMs, 3500);
  assert.equal(dbTelemetry.steps.get(3).thinkingMs, 3000);
  assert.equal(dbTelemetry.steps.get(3).outputGenMs, 2000);

  const jsonl = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-21T10:00:00Z', content: '<USER_REQUEST>\nHello\n</USER_REQUEST>' },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-21T10:00:01Z',
      model: 'gemini-4-neon-high',
      input_tokens: 10000,
      cache_read_tokens: 0,
      output_tokens: 200,
      thinking: 'short summary',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls' } }],
    },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-21T10:00:06Z', content: 'ok' },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-21T10:00:09Z',
      model: 'gemini-4-neon-high',
      input_tokens: 2000,
      cache_read_tokens: 10000,
      output_tokens: 1000,
      thinking: 'summary',
      content: 'Final reply text',
    },
  ].map((x) => JSON.stringify(x)).join('\n');

  const parsed = parseTranscript(jsonl, { conversationId: 'db-test', dbTelemetry });
  assert.equal(parsed.contextWindow, 512000);
  assert.equal(parsed.timing.source, 'db');
  assert.equal(parsed.timing.modelWaitMs, 7500); // 4000 + 3500 exact TTFT
  assert.equal(parsed.timing.thinkingMs, 3600);  // 600 + 3000 exact thinking
  assert.equal(parsed.timing.modelGenMs, 2400);  // 400 + 2000 exact non-thinking stream
  assert.equal(parsed.timing.toolExecMs, 2500);  // exact DB tool duration
  assert.equal(parsed.timing.otherMs, 0);        // never fabricated 1.5%
  assert.equal(parsed.timing.activeMs, 16000);
  // End-to-end throughput: (200 + 1000) / ((5000 + 8500) / 1000) = 88.9 tok/s
  assert.equal(parsed.timing.outputTokPerSec, 88.9);
  // Exact API thinking tokens from gen_metadata.1.4.9
  assert.equal(parsed.modelsUsed['gemini-4-neon-high'].outThinkingTokens, 520); // 120 + 400
  assert.equal(parsed.modelsUsed['gemini-4-neon-high'].outReplyTokens, 600);
  assert.equal(parsed.modelsUsed['gemini-4-neon-high'].outToolCallTokens, 80);

  // Trace gets exact DB TTFT, thinkingMs, streamMs, durationMs even for final reply without tools
  const tr = parseTrace(jsonl, { dbTelemetry });
  const models = tr.items.filter((x) => x.kind === 'model');
  assert.equal(models.length, 2);
  assert.equal(models[0].timingSource, 'db');
  assert.equal(models[0].ttftMs, 4000);
  assert.equal(models[0].thinkingMs, 600);
  assert.equal(models[0].outputGenMs, 400);
  assert.equal(models[0].thinkingTokens, 120);
  assert.equal(models[0].streamMs, 1000);
  assert.equal(models[0].durationMs, 5000);
  assert.equal(models[0].tokPerSec, 40);
  assert.equal(models[1].timingSource, 'db');
  assert.equal(models[1].timingUnavailable, false);
  assert.equal(models[1].ttftMs, 3500);
  assert.equal(models[1].thinkingMs, 3000);
  assert.equal(models[1].outputGenMs, 2000);
  assert.equal(models[1].thinkingTokens, 400);
  assert.equal(models[1].streamMs, 5000);
  assert.equal(models[1].durationMs, 8500);
  assert.equal(models[1].tokPerSec, 117.6);
  const toolItem = tr.items.find((x) => x.kind === 'tool');
  assert.equal(toolItem.durationMs, 2500);

  // DB telemetry replaces hook turnStats cleanly
  assert.equal(parsed.hookTelemetry.hasData, true);
  assert.equal(parsed.hookTelemetry.turnStats.completedTurns, 1);
  assert.equal(parsed.hookTelemetry.turnStats.avgInvocations, 2);
  assert.equal(parsed.hookTelemetry.turnStats.reasons.NO_TOOL_CALL, 1);

  // Without DB telemetry: NO 28% TTFT estimation, NO 90 tok/s fabrication, NO 1.5% overhead
  const parsedNoDb = parseTranscript(jsonl, { conversationId: 'no-db-test' });
  assert.equal(parsedNoDb.contextWindow, 0);
  assert.equal(parsedNoDb.timing.modelWaitMs, 0);
  assert.equal(parsedNoDb.timing.thinkingMs, 0);
  assert.equal(parsedNoDb.timing.modelGenMs, 5000); // only measured step 1 (10:00:01 -> 10:00:06); step 3 unmeasured = 0
  assert.equal(parsedNoDb.timing.otherMs, 0);
});

test('DB extracts host tool errors and live in-flight status without lifecycle hooks', async () => {
  if (!isSqliteSupported()) return;
  const { DatabaseSync } = await import('node:sqlite');
  const nowSec = 1795271000;
  const nowMs = nowSec * 1000 + 5000;

  assert.equal(decodeErrorDetails(pbBytes(2, 'file does not exist')), 'file does not exist');
  assert.deepEqual(
    decodeExecutorMetadata(Buffer.concat([pbVarint(1, 4), pbVarint(2, 5), pbVarint(3, 12)])),
    { terminationCode: 4, invocations: 5, lastStepIdx: 12 },
  );

  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER DEFAULT 0);
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, error_details BLOB, step_payload BLOB);
    CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);
  `);
  const gm0 = makeGenMetaBlob({ inTok: 1000, outTok: 100, ttftSec: 1, streamSec: 1 });
  db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, gm0, gm0.length);

  const insStep = db.prepare('INSERT INTO steps (idx, step_type, status, metadata, error_details, step_payload) VALUES (?, ?, ?, ?, ?, ?)');
  insStep.run(1, 15, 3, makeStepMetaBlob({ startSec: nowSec - 10, firstSec: nowSec - 9, streamEndSec: nowSec - 8, endSec: nowSec - 8, includeRef: true, genMetaIdx: 0 }), null, null);
  // Step 2: Failed tool with host error_details
  insStep.run(2, 132, 7, makeStepMetaBlob({ startSec: nowSec - 8, firstSec: nowSec - 8, endSec: nowSec - 7 }), pbBytes(2, 'Error: Access denied'), null);
  // Step 3: Completed planner step after failed tool
  insStep.run(3, 15, 3, makeStepMetaBlob({ startSec: nowSec - 6, firstSec: nowSec - 5, streamEndSec: nowSec - 4, endSec: nowSec - 4, includeRef: true, genMetaIdx: 0 }), null, null);
  // Step 4: Currently RUNNING planner step (status = 2)
  insStep.run(4, 15, 2, makeStepMetaBlob({ startSec: nowSec }), null, null);

  const dbTelemetry = extractTelemetryFromDb(db, { summaryStatus: { running: true, status: 'CASCADE_RUN_STATUS_RUNNING' }, nowMs });
  db.close();

  assert.equal(dbTelemetry.telemetry.liveState.active, true);
  assert.equal(dbTelemetry.telemetry.liveState.phase, 'generating');
  assert.equal(dbTelemetry.telemetry.liveState.sinceMs, nowSec * 1000);
  assert.equal(dbTelemetry.telemetry.liveState.model, 'Gemini 4 Neon (High)');

  const jsonl = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-21T10:00:00Z', content: '<USER_REQUEST>\nRead secret\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-21T10:00:01Z', model: 'gemini-4-neon-high', input_tokens: 1000, cache_read_tokens: 0, output_tokens: 100, tool_calls: [{ name: 'read_file', args: { Path: '/etc/shadow' } }] },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-21T10:00:03Z', content: 'denied' },
    { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-21T10:00:05Z', model: 'gemini-4-neon-high', input_tokens: 200, cache_read_tokens: 1200, output_tokens: 80, content: 'Access was denied.' },
  ].map((x) => JSON.stringify(x)).join('\n');

  const tr = parseTrace(jsonl, { dbTelemetry, nowMs });
  assert.equal(tr.liveState.active, true);
  assert.equal(tr.liveState.phase, 'generating');
  const toolDetail = tr.details.find((x) => x.kind === 'tool' && x.step === 2);
  assert.equal(toolDetail.hasError, true);
  assert.equal(toolDetail.hookError, 'Error: Access denied');

  const parsed = parseTranscript(jsonl, { conversationId: 'err-live-test', dbTelemetry, nowMs });
  assert.equal(parsed.hookTelemetry.liveState.phase, 'generating');
  assert.equal(parsed.tools.read_file.errors, 1);
  assert.equal(parsed.categoryItems.tool_calls[0].failed, true);
});

test('tool execution excludes PENDING (s1) and WAITING_FOR_USER (s9) approval waits and fmtTraceDur omits zero parts', async () => {
  if (!isSqliteSupported()) return;
  const { DatabaseSync } = await import('node:sqlite');

  const pbTransitions = (entries) => pbBytes(
    26,
    Buffer.concat(entries.map(([st, sec, nanos = 0]) => pbBytes(1, Buffer.concat([pbVarint(1, st), pbBytes(2, pbDur(sec, nanos))])))),
  );

  const base = 1795270000;
  // Step 2 (rm -rf): s1(+2s), s2(+10s -> +12s = 2000ms), s9 WAITING_FOR_USER (+12s -> +7212s = 2h!), s2(+7212s -> +7212.2s = 200ms), s3(+7212.2s)
  const rmMeta = Buffer.concat([
    makeStepMetaBlob({ startSec: base, firstSec: base + 2, endSec: base + 7212, endNanos: 200_000_000 }),
    pbTransitions([
      [1, base + 2],
      [2, base + 10],
      [9, base + 12],
      [2, base + 7212],
      [3, base + 7212, 200_000_000],
    ]),
  ]);
  // Step 3 (queued edit_file): s1(+2s -> +7212.1s), s2(+7212.1s -> +7213.6s = 1500ms), s3(+7213.6s)
  const editMeta = Buffer.concat([
    makeStepMetaBlob({ startSec: base, firstSec: base + 2, endSec: base + 7213, endNanos: 600_000_000 }),
    pbTransitions([
      [1, base + 2],
      [2, base + 7212, 100_000_000],
      [3, base + 7213, 600_000_000],
    ]),
  ]);

  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER DEFAULT 0);
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, error_details BLOB, step_payload BLOB);
    CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);
  `);
  const gm0 = makeGenMetaBlob({ inTok: 1000, outTok: 100, ttftSec: 1, streamSec: 1 });
  db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, gm0, gm0.length);
  const ins = db.prepare('INSERT INTO steps (idx, step_type, status, metadata, error_details, step_payload) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run(1, 15, 3, makeStepMetaBlob({ startSec: base - 2, firstSec: base - 1, streamEndSec: base, endSec: base, includeRef: true, genMetaIdx: 0 }), null, null);
  ins.run(2, 132, 3, rmMeta, null, null);
  ins.run(3, 132, 3, editMeta, null, null);
  const dbTelemetry = extractTelemetryFromDb(db);
  db.close();

  // Exact active execution times: 2200ms (rm) and 1500ms (edit), NOT 5m (300_000ms)!
  assert.equal(dbTelemetry.steps.get(2).toolExecMs, 2200);
  assert.equal(dbTelemetry.steps.get(3).toolExecMs, 1500);
  // Union of [10..12], [7212..7212.2], [7212.1..7213.6] = 2000 + 1600 = 3600ms (overlaps merged, 2h wait excluded!)
  assert.equal(mergeIntervalsDurationMs([
    ...dbTelemetry.steps.get(2).runningIntervals,
    ...dbTelemetry.steps.get(3).runningIntervals,
  ]), 3600);

  const jsonl = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-21T10:00:00Z', content: '<USER_REQUEST>\nDelete hooks\n</USER_REQUEST>' },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-21T10:00:01Z',
      model: 'gemini-4-neon-high',
      input_tokens: 1000,
      cache_read_tokens: 0,
      output_tokens: 100,
      tool_calls: [
        { name: 'run_command', args: { CommandLine: 'rm -rf hooks' } },
        { name: 'edit_file', args: { Path: '/tmp/install.sh' } },
      ],
    },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-21T10:00:03Z', content: 'ok' },
    { step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-21T10:00:03Z', content: 'ok' },
  ].map((x) => JSON.stringify(x)).join('\n');

  const tr = parseTrace(jsonl, { dbTelemetry });
  const tools = tr.items.filter((x) => x.kind === 'tool');
  assert.equal(tools[0].durationMs, 2200);
  assert.equal(tools[1].durationMs, 1500);

  const parsed = parseTranscript(jsonl, { conversationId: 'approval-wait-test', dbTelemetry });
  assert.equal(parsed.timing.toolExecMs, 3600);

  // fmtTraceDur omits zero trailing components cleanly
  assert.equal(fmtTraceDur(0), '');
  assert.equal(fmtTraceDur(192), '0.19s');
  assert.equal(fmtTraceDur(60_000), '1m');
  assert.equal(fmtTraceDur(300_000), '5m');
  assert.equal(fmtTraceDur(119_999), '2m');
  assert.equal(fmtTraceDur(62_500), '1m2.50s');
  assert.equal(fmtTraceDur(3_600_000), '1h');
  assert.equal(fmtTraceDur(3_660_000), '1h1m');
  assert.equal(fmtTraceDur(3_605_000), '1h5s');
  assert.equal(fmtTraceDur(3_665_000), '1h1m5s');
});
