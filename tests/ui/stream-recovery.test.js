// P1B browser SSE recovery contract tests (jsdom + source contracts).
// Locks the reviewed plan (a9f9eec) browser recovery semantics:
// - only an errored stream's successful reopen triggers an authoritative refresh
// - initial/healthy opens never duplicate bootstrap loading
// - repeated opens while a recovery refresh is in flight never start parallel
//   refreshes (coalesced into the in-flight one)
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

test('P1B recovery: repeated opens during an in-flight recovery never start parallel refreshes', () => {
  const recovery = loadRecoveryModule();

  recovery.markStreamError();
  assert.equal(recovery.shouldRecoverOnOpen(), true, 'first reopen after error triggers the recovery refresh');

  // A second errored episode whose reopen lands while the refresh is in flight
  // must be coalesced into the in-flight refresh (no parallel refreshAll).
  recovery.markStreamError();
  assert.equal(
    recovery.shouldRecoverOnOpen(),
    false,
    'open during an in-flight recovery must be coalesced, not refreshed in parallel'
  );

  recovery.finishRecovery();

  // A genuinely later errored episode (error after the refresh completed)
  // recovers again.
  recovery.markStreamError();
  assert.equal(recovery.shouldRecoverOnOpen(), true, 'a new errored episode after completion recovers again');
  recovery.finishRecovery();
});

test('P1B recovery: an error inside the recovery window is absorbed by the coalesced open', () => {
  const recovery = loadRecoveryModule();

  recovery.markStreamError();
  assert.equal(recovery.shouldRecoverOnOpen(), true);

  // Stream errors again while the recovery refresh is still running, then the
  // stream reopens before the refresh completes: the reopen is coalesced and
  // the pending episode flag is consumed by that coalesced open.
  recovery.markStreamError();
  assert.equal(recovery.shouldRecoverOnOpen(), false);

  recovery.finishRecovery();
  assert.equal(
    recovery.shouldRecoverOnOpen(),
    false,
    'the coalesced open already served the episode; healthy opens stay quiet'
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

test('P1B recovery: app.js open handler coalesces one refreshAll(selectedConversationId)', () => {
  const openBlock = openHandlerBlock();

  assert.match(openBlock, /shouldRecoverOnOpen\(\)/, 'open path must consult stream recovery');
  assert.match(
    openBlock,
    /state\.selectedConversationId/,
    'recovery must capture the selected conversation id at reopen time'
  );
  assert.match(
    openBlock,
    /refreshAll\(preferredConversationId\)/,
    'recovery must run refreshAll with the captured selected conversation id'
  );
  assert.match(
    openBlock,
    /finishRecovery\(\)/,
    'recovery refresh must always release the in-flight latch (finally)'
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
