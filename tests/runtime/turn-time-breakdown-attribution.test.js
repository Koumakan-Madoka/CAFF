const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ATTRIBUTION_PRIORITY,
  computeTurnAttribution,
} = require('../../build/server/domain/runtime/turn-time-breakdown-attribution');

function step(overrides = {}) {
  return {
    category: 'read',
    startedAtMs: 1000,
    endedAtMs: 2000,
    ...overrides,
  };
}

test('priority order matches contract §3', () => {
  assert.deepEqual(ATTRIBUTION_PRIORITY, [
    'test',
    'write',
    'build-check',
    'read',
    'process-report',
    'exception-retry',
    'unclassified',
  ]);
});

test('parallel same-category steps merge by interval union, never double-counted', () => {
  const { categoryMs } = computeTurnAttribution({
    steps: [
      step({ startedAtMs: 1000, endedAtMs: 5000 }),
      step({ startedAtMs: 2000, endedAtMs: 6000 }),
      step({ startedAtMs: 3000, endedAtMs: 4000 }),
    ],
    turnStartedAtMs: 1000,
    turnEndedAtMs: 6000,
  });

  assert.equal(categoryMs.read, 5000); // union [1000,6000], not 4000+4000+1000
  assert.equal(categoryMs.thinking, 0);
});

test('cross-category overlap slices to the higher-priority category', () => {
  const { categoryMs } = computeTurnAttribution({
    steps: [
      step({ category: 'read', startedAtMs: 0, endedAtMs: 10_000 }),
      step({ category: 'test', startedAtMs: 4000, endedAtMs: 6000 }),
    ],
    turnStartedAtMs: 0,
    turnEndedAtMs: 10_000,
  });

  assert.equal(categoryMs.test, 2000);
  assert.equal(categoryMs.read, 8000); // loses the [4000,6000] slice to test
  assert.equal(categoryMs.thinking, 0);
});

test('gaps between tool intervals become thinking time', () => {
  const { categoryMs } = computeTurnAttribution({
    steps: [
      step({ category: 'write', startedAtMs: 1000, endedAtMs: 2000 }),
      step({ category: 'test', startedAtMs: 8000, endedAtMs: 10_000 }),
    ],
    turnStartedAtMs: 0,
    turnEndedAtMs: 12_000,
  });

  assert.equal(categoryMs.write, 1000);
  assert.equal(categoryMs.test, 2000);
  assert.equal(categoryMs.thinking, 9000); // [0,1000) + (2000,8000) + (10000,12000]
});

test('model error intervals land in exception-retry, disjoint from tool time', () => {
  const { categoryMs } = computeTurnAttribution({
    steps: [step({ category: 'read', startedAtMs: 1000, endedAtMs: 2000 })],
    errorEvents: [{ timestampMs: 5000 }],
    turnStartedAtMs: 1000,
    turnEndedAtMs: 6000,
  });

  assert.equal(categoryMs.read, 1000);
  assert.equal(categoryMs['exception-retry'], 3000); // prev event end (2000) → error ts (5000)
  assert.equal(categoryMs.thinking, 1000); // (5000,6000]
});

test('tool-side exception-retry steps combine with model error intervals', () => {
  const { categoryMs } = computeTurnAttribution({
    steps: [step({ category: 'exception-retry', startedAtMs: 1000, endedAtMs: 1500 })],
    errorEvents: [{ timestampMs: 3000 }],
    turnStartedAtMs: 1000,
    turnEndedAtMs: 4000,
  });

  // 500ms tool-side failure + [1500,3000] model error interval.
  assert.equal(categoryMs['exception-retry'], 2000);
  assert.equal(categoryMs.thinking, 1000); // (3000,4000]
});

test('open intervals (no end) contribute nothing to the union', () => {
  const { categoryMs } = computeTurnAttribution({
    steps: [
      step({ category: 'write', startedAtMs: 1000, endedAtMs: null }),
      step({ category: 'read', startedAtMs: 2000, endedAtMs: 3000 }),
    ],
    turnStartedAtMs: 1000,
    turnEndedAtMs: 4000,
  });

  assert.equal(categoryMs.write, undefined);
  assert.equal(categoryMs.read, 1000);
});

test('metrics: firstWriteMs, fullRunCount sums per-segment counts, failures counted', () => {
  const { metrics } = computeTurnAttribution({
    steps: [
      step({ category: 'read', startedAtMs: 0, endedAtMs: 1000 }),
      step({ category: 'write', startedAtMs: 5000, endedAtMs: 6000 }),
      // `npm test; npm test` in one command: two full runs, one step.
      step({ category: 'test', startedAtMs: 7000, endedAtMs: 9000, testRunCounts: { full: 2, targeted: 0 }, runFailed: true }),
      step({ category: 'test', startedAtMs: 10_000, endedAtMs: 11_000, runKind: 'targeted' }),
    ],
    turnStartedAtMs: 0,
    turnEndedAtMs: 12_000,
  });

  assert.equal(metrics.firstWriteMs, 5000);
  assert.equal(metrics.fullRunCount, 2);
  assert.equal(metrics.fullRunFailCount, 1);
});

test('metrics: no write step → firstWriteMs null; runKind fallback when counts absent', () => {
  const { metrics } = computeTurnAttribution({
    steps: [step({ category: 'test', runKind: 'full-regression', runFailed: false })],
    turnStartedAtMs: 0,
    turnEndedAtMs: 5000,
  });

  assert.equal(metrics.firstWriteMs, null);
  assert.equal(metrics.fullRunCount, 1);
  assert.equal(metrics.fullRunFailCount, 0);
});

test('metrics: firstWriteMs ignores sandbox/temp scratch writes (repo only)', () => {
  // W6 re-review blocking 1: writing a probe script into the agent sandbox
  // is not "首次改仓库文件"; unknown scope is conservatively repo.
  const { metrics } = computeTurnAttribution({
    steps: [
      step({ category: 'write', writeScope: 'sandbox', startedAtMs: 1000, endedAtMs: 2000 }),
      step({ category: 'write', writeScope: 'temp', startedAtMs: 2500, endedAtMs: 3000 }),
      step({ category: 'write', writeScope: 'repo', startedAtMs: 5000, endedAtMs: 6000 }),
    ],
    turnStartedAtMs: 0,
    turnEndedAtMs: 9000,
  });

  assert.equal(metrics.firstWriteMs, 5000);

  const scratchOnly = computeTurnAttribution({
    steps: [step({ category: 'write', writeScope: 'sandbox', startedAtMs: 1000, endedAtMs: 2000 })],
    turnStartedAtMs: 0,
    turnEndedAtMs: 9000,
  });

  assert.equal(scratchOnly.metrics.firstWriteMs, null);

  const unknownCounts = computeTurnAttribution({
    steps: [step({ category: 'write', startedAtMs: 3000, endedAtMs: 4000 })],
    turnStartedAtMs: 0,
    turnEndedAtMs: 9000,
  });

  assert.equal(unknownCounts.metrics.firstWriteMs, 3000);
});
