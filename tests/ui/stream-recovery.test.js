// P1B browser SSE recovery contract tests (jsdom + source contracts).
// Locks the reviewed plan (a9f9eec) browser recovery semantics:
// - only an errored stream's successful reopen triggers an authoritative refresh
// - initial/healthy opens never duplicate bootstrap loading
// - repeated opens while a recovery refresh is in flight never start parallel
//   refreshes; the coalesced episode surfaces as exactly one serialized
//   trailing refresh when the in-flight one settles
// - finishing a recovery re-arms future errored episodes
// - no Last-Event-ID / replay / at-least-once semantics are claimed anywhere

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');

function readPublic(rel) {
  return fs.readFileSync(path.join(ROOT, 'public', rel), 'utf8');
}

const APP_JS = readPublic('app.js');
const INDEX_HTML = readPublic('index.html');

function loadRecoveryModule() {
  const dom = new JSDOM('', { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  window.eval(readPublic('chat/stream-recovery.js'));
  const factory = window.CaffChat && window.CaffChat.createStreamRecovery;
  assert.equal(typeof factory, 'function', 'stream-recovery.js must register CaffChat.createStreamRecovery');
  return factory();
}

function openHandlerBlock() {
  const openStart = APP_JS.indexOf("source.addEventListener('open'");
  assert.notEqual(openStart, -1, 'EventSource open listener missing');
  const errorStart = APP_JS.indexOf("source.addEventListener('error'", openStart);
  assert.notEqual(errorStart, -1, 'EventSource error listener missing');
  return APP_JS.slice(openStart, errorStart);
}

function errorHandlerBlock() {
  const errorStart = APP_JS.indexOf("source.addEventListener('error'");
  assert.notEqual(errorStart, -1, 'EventSource error listener missing');
  return APP_JS.slice(errorStart, APP_JS.indexOf('});', errorStart) + 3);
}

test('P1B recovery: module registers on CaffChat and initial opens never refresh', () => {
  const recovery = loadRecoveryModule();

  assert.equal(
    recovery.shouldRecoverOnOpen(),
    false,
    'first (initial) open must not trigger an authoritative refresh'
  );
  assert.equal(
    recovery.shouldRecoverOnOpen(),
    false,
    'subsequent healthy opens must not refresh either'
  );
});

test('P1B recovery: errored stream reopen triggers exactly one coalesced recovery', () => {
  const recovery = loadRecoveryModule();

  recovery.markStreamError();
  assert.equal(recovery.shouldRecoverOnOpen(), true, 'reopen after an error must trigger one recovery');
  assert.equal(
    recovery.shouldRecoverOnOpen(),
    false,
    'no second refresh until finishRecovery() reports completion'
  );

  recovery.finishRecovery();
  assert.equal(
    recovery.shouldRecoverOnOpen(),
    false,
    'healthy opens after a completed recovery must stay quiet'
  );
});

test('P1B recovery: repeated opens during an in-flight recovery coalesce into one trailing refresh', () => {
  const recovery = loadRecoveryModule();

  recovery.markStreamError();
  assert.equal(recovery.shouldRecoverOnOpen(), true, 'first reopen after error triggers the recovery refresh');

  // A second errored episode whose reopen lands while the refresh is in
  // flight must not start a parallel refreshAll...
  recovery.markStreamError();
  assert.equal(
    recovery.shouldRecoverOnOpen(),
    false,
    'open during an in-flight recovery must never start a parallel refresh'
  );

  // ...but the episode's authoritative state change still needs a refresh of
  // its own: when the in-flight refresh settles, the caller must run exactly
  // one serialized trailing refresh (state may have changed after the first
  // refresh already read it).
  assert.equal(
    recovery.finishRecovery(),
    true,
    'a coalesced trailing episode must be reported when the in-flight refresh settles'
  );

  // The trailing refresh runs; when it settles there is nothing left pending.
  assert.equal(recovery.finishRecovery(), false, 'the trailing refresh consumed the pending episode');
  assert.equal(recovery.shouldRecoverOnOpen(), false, 'healthy opens stay quiet after trailing recovery');

  // A genuinely later errored episode (error after all refreshes completed)
  // recovers again.
  recovery.markStreamError();
  assert.equal(recovery.shouldRecoverOnOpen(), true, 'a new errored episode after completion recovers again');
  recovery.finishRecovery();
});

test('P1B recovery: a failing first refresh does not lose the coalesced trailing episode', () => {
  const recovery = loadRecoveryModule();

  recovery.markStreamError();
  assert.equal(recovery.shouldRecoverOnOpen(), true);

  // Second errored episode reopens while the first refresh is in flight.
  recovery.markStreamError();
  assert.equal(recovery.shouldRecoverOnOpen(), false);

  // Even when the first refresh failed (its promise rejected and the caller
  // only releases the latch in finally), the trailing episode must still be
  // reported so authoritative state is eventually refreshed.
  assert.equal(
    recovery.finishRecovery(),
    true,
    'a rejected first refresh must still surface the pending trailing episode'
  );
  assert.equal(recovery.finishRecovery(), false);
});

test('P1B recovery: an error inside the recovery window re-arms through the trailing refresh', () => {
  const recovery = loadRecoveryModule();

  recovery.markStreamError();
  assert.equal(recovery.shouldRecoverOnOpen(), true);

  // Stream errors again while the recovery refresh is still running, then the
  // stream reopens before the refresh completes: the reopen must not start a
  // parallel refresh, but the episode is coalesced as trailing work.
  recovery.markStreamError();
  assert.equal(recovery.shouldRecoverOnOpen(), false);

  assert.equal(
    recovery.finishRecovery(),
    true,
    'the in-window episode must surface as a trailing refresh when the first settles'
  );
  assert.equal(recovery.finishRecovery(), false);
  assert.equal(
    recovery.shouldRecoverOnOpen(),
    false,
    'the trailing refresh already served the episode; healthy opens stay quiet'
  );
});

test('P1B recovery: app.js error handler arms stream recovery before scheduling reconnect', () => {
  const errorBlock = errorHandlerBlock();
  assert.match(
    errorBlock,
    /markStreamError\(\)/,
    'SSE error path must mark the stream errored for recovery bookkeeping'
  );
});

test('P1B recovery: app.js open handler coalesces one refreshAll and serializes trailing refreshes', () => {
  const openBlock = openHandlerBlock();

  assert.match(openBlock, /shouldRecoverOnOpen\(\)/, 'open path must consult stream recovery');
  assert.match(
    openBlock,
    /state\.selectedConversationId/,
    'recovery must capture the selected conversation id at reopen time'
  );
  assert.match(
    openBlock,
    /refreshAll\(conversationId\)/,
    'recovery refreshes must go through refreshAll with the selected conversation id'
  );
  assert.match(
    openBlock,
    /if \(streamRecovery\.finishRecovery\(\)\)/,
    'the refresh settle path must check for a coalesced trailing episode and run it serialized'
  );
  assert.match(
    openBlock,
    /runRecoveryRefresh\(state\.selectedConversationId\)/,
    'a trailing refresh must re-read the current selection instead of reusing the stale captured id'
  );
});

test('P1B recovery: index.html loads the stream-recovery module', () => {
  assert.match(
    INDEX_HTML,
    /chat\/stream-recovery\.js/,
    'index.html must include the stream-recovery module script'
  );
});

test('P1B recovery: no Last-Event-ID / replay / at-least-once claims in client or SSE server', () => {
  // Consumption vectors: the browser-side lastEventId property and the
  // server-side last-event-id header read. Plain prose mentions are fine.
  for (const [rel, source] of [
    ['app.js', APP_JS],
    ['chat/stream-recovery.js', readPublic('chat/stream-recovery.js')],
    ['server/http/sse-bus.ts', fs.readFileSync(path.join(ROOT, 'server', 'http', 'sse-bus.ts'), 'utf8')],
  ]) {
    assert.doesNotMatch(source, /lastEventId/i, `${rel} must not read EventSource.lastEventId`);
    assert.doesNotMatch(source, /["']last-event-id["']/i, `${rel} must not read the last-event-id header`);
  }
});
