const assert = require('node:assert/strict');
const test = require('node:test');
const { StreamDiagnostics, DIAGNOSTIC_LIMITS } = require('../../build/lib/stream-diagnostics');

const delta = (type, text) => ({ type: 'message_update', assistantMessageEvent: { type, delta: text } });

test('diagnostics observe phases and distinguish empty, whitespace and sparse output without interpreting progress', () => {
  const d = new StreamDiagnostics(0);
  assert.equal(d.snapshot(0).phase, 'waiting');
  d.observe({ type: 'message_start', message: { role: 'assistant' } }, 1);
  assert.equal(d.snapshot(1).phase, 'unknown');
  d.observe(delta('thinking_delta', ''), 2);
  assert.equal(d.snapshot(2).phase, 'thinking');
  d.observe(delta('thinking_delta', ' \n\t'), 3);
  d.observe(delta('text_delta', ' a😀'), 1200000);
  assert.equal(d.snapshot(1200000).phase, 'output');
  d.observe({ type: 'tool_execution_start' }, 1200001);
  assert.equal(d.snapshot(1200001).phase, 'tool');
  d.observe({ type: 'tool_execution_end' }, 1200002);
  assert.equal(d.snapshot(1200002).phase, 'unknown');
  d.observe({ type: 'auto_retry_start' }, 1200003);
  assert.equal(d.snapshot(1200003).phase, 'waiting');
  const s = d.snapshot(1200003);
  assert.deepEqual(s.delta, { count: 3, empty: 1, whitespaceOnly: 1, codeUnits: 7, scannedCodeUnits: 7, nonWhitespaceCodeUnits: 3, unscannedCodeUnits: 0 });
  assert.equal(s.lastNonWhitespaceAt, 1200000);
  assert.equal(s.maxPiEventGapMs, 1199997);
});

test('all actual watchdog refresh reasons are bounded and timestamped separately from events and heartbeat', () => {
  const d = new StreamDiagnostics(0);
  ['initial', 'pi_event', 'recovery_request', 'recovery_started'].forEach((r, i) => d.refresh(r, i + 1));
  d.heartbeat(99);
  const s = d.snapshot(100);
  assert.deepEqual(s.refreshCounts, { initial: 1, pi_event: 1, recovery_request: 1, recovery_started: 1 });
  assert.equal(s.lastRefreshAt, 4);
  assert.equal(s.lastRefreshReason, 'recovery_started');
  assert.equal(s.lastHeartbeatAt, 99);
  assert.equal(s.recent[3].at, 4);
});

test('sensitive content, tool args, names, IDs, unknown event labels and raw deltas never survive projection', () => {
  const d = new StreamDiagnostics(0);
  const secret = 'SENSITIVE_SENTINEL';
  d.observe({ type: secret, args: { key: secret }, toolName: secret, toolCallId: secret }, 1);
  d.observe({ ...delta(secret, secret), message: { content: secret } }, 2);
  d.observe(delta('toolcall_delta', secret), 3);
  d.observe({ type: 'tool_execution_start', args: secret, toolName: secret }, 4);
  const json = JSON.stringify(d.snapshot(4));
  assert.ok(!json.includes(secret));
  assert.equal(d.snapshot(4).eventCounts.other, 1);
  assert.equal(d.snapshot(4).eventCounts['message_update:other'], 1);
});

test('large deltas and high event cardinality have bounded scan, memory and serialization; snapshots are detached', () => {
  const d = new StreamDiagnostics(0);
  d.observe(delta('toolcall_delta', ' '.repeat(DIAGNOSTIC_LIMITS.scanCodeUnits) + 'secret'), 1);
  const first = d.snapshot(1);
  assert.equal(first.delta.unscannedCodeUnits, 6);
  assert.equal(first.delta.whitespaceOnly, 0, 'unscanned suffix prevents claiming whitespace-only');
  assert.equal(first.delta.nonWhitespaceCodeUnits, 0);
  for (let i = 0; i < 100000; i++) {
    d.observe({ type: `unknown-${i}` }, i + 2);
    d.observe(delta('toolcall_delta', ' x'), i + 2);
    d.refresh('pi_event', i + 2);
  }
  const s = d.snapshot(100002);
  assert.equal(s.recent.length, DIAGNOSTIC_LIMITS.recentEvents);
  assert.equal(s.eventCounts.other, 100000);
  assert.ok(Object.keys(s.eventCounts).length <= DIAGNOSTIC_LIMITS.eventKinds);
  assert.ok(Buffer.byteLength(JSON.stringify(s)) <= DIAGNOSTIC_LIMITS.snapshotBytes);
  assert.equal(first.delta.count, 1);
  assert.equal(first.recent.length, 1);
  s.recent[0].type = 'mutated';
  assert.notEqual(d.snapshot(100003).recent[0].type, 'mutated');
});
