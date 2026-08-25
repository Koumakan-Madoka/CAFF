const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createRuntimeObservability,
} = require('../../build/server/domain/runtime/runtime-observability');

const MIB = 1024 * 1024;

function createFixedMemoryUsage(overrides = {}) {
  return () => ({
    heapUsed: 16 * MIB,
    heapTotal: 32 * MIB,
    rss: 128 * MIB,
    external: 4 * MIB,
    arrayBuffers: 2 * MIB,
    ...overrides,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('snapshot exposes normalized memory fields without any registered provider', () => {
  const observability = createRuntimeObservability({
    memoryUsage: createFixedMemoryUsage(),
  });

  const snapshot = observability.getSnapshot();

  assert.equal(typeof snapshot.timestamp, 'string');
  assert.ok(snapshot.timestamp.length > 0);
  assert.deepEqual(snapshot.memory, {
    timestamp: snapshot.memory.timestamp,
    heapUsedBytes: 16 * MIB,
    heapTotalBytes: 32 * MIB,
    rssBytes: 128 * MIB,
    externalBytes: 4 * MIB,
    arrayBuffersBytes: 2 * MIB,
  });
  assert.deepEqual(snapshot.counters, {});
  assert.deepEqual(snapshot.memoryHistory, []);
});

test('registered counter providers are merged into the snapshot and invoked once per snapshot', () => {
  let providerCalls = 0;
  const observability = createRuntimeObservability({
    memoryUsage: createFixedMemoryUsage(),
  });

  assert.equal(observability.registerCounterProvider('turns', () => {
    providerCalls += 1;
    return { activeTurns: 2, activeQueues: 1 };
  }), true);
  assert.equal(observability.registerCounterProvider('sse', () => ({ activeClients: 3 })), true);

  const snapshot = observability.getSnapshot();

  assert.deepEqual(snapshot.counters, {
    turns: { activeTurns: 2, activeQueues: 1 },
    sse: { activeClients: 3 },
  });
  assert.equal(providerCalls, 1, 'each provider must be invoked exactly once per snapshot');
});

test('registerCounterProvider rejects invalid names and providers', () => {
  const observability = createRuntimeObservability({ memoryUsage: createFixedMemoryUsage() });

  assert.equal(observability.registerCounterProvider('', () => ({})), false);
  assert.equal(observability.registerCounterProvider('   ', () => ({})), false);
  assert.equal(observability.registerCounterProvider('valid', null), false);
  assert.deepEqual(observability.getSnapshot().counters, {});
});

test('unregistering a counter provider removes its counters from later snapshots', () => {
  const observability = createRuntimeObservability({
    memoryUsage: createFixedMemoryUsage(),
  });

  observability.registerCounterProvider('turns', () => ({ activeTurns: 1 }));
  observability.registerCounterProvider('sse', () => ({ activeClients: 1 }));

  assert.equal(observability.unregisterCounterProvider('turns'), true);
  assert.equal(observability.unregisterCounterProvider('turns'), false, 'second unregister is a no-op');

  assert.deepEqual(observability.getSnapshot().counters, {
    sse: { activeClients: 1 },
  });
});

test('a throwing counter provider fails soft without breaking other counters', () => {
  const observability = createRuntimeObservability({
    memoryUsage: createFixedMemoryUsage(),
  });

  observability.registerCounterProvider('broken', () => {
    throw new Error('provider exploded');
  });
  observability.registerCounterProvider('healthy', () => ({ activeInvocations: 0 }));

  const snapshot = observability.getSnapshot();

  assert.deepEqual(snapshot.counters.broken, { unavailable: true });
  assert.deepEqual(snapshot.counters.healthy, { activeInvocations: 0 });
});

test('periodic sampler records bounded memory history and logs one line per sample', async () => {
  const logLines = [];
  const observability = createRuntimeObservability({
    memoryUsage: createFixedMemoryUsage(),
    sampleIntervalMs: 10,
    maxHistoryEntries: 3,
    log: (line) => logLines.push(line),
  });

  assert.equal(observability.start(), true, 'start must take an initial sample and arm the timer');

  await delay(80);

  assert.equal(observability.stop(), true);
  const history = observability.getMemoryHistory();

  assert.equal(history.length, 3, 'history must be bounded by maxHistoryEntries');
  for (const sample of history) {
    assert.equal(sample.heapUsedBytes, 16 * MIB);
    assert.equal(sample.rssBytes, 128 * MIB);
  }
  assert.ok(logLines.length >= 3, 'each recorded sample must log one line');
  for (const line of logLines) {
    assert.ok(line.includes('[runtime-observability]'), 'log lines must be namespaced');
    assert.ok(line.includes('heapUsed='), 'log lines must include heapUsed');
    assert.ok(line.includes('rss='), 'log lines must include rss');
  }

  // The snapshot exposes a copy of the bounded history.
  const snapshot = observability.getSnapshot();
  assert.equal(snapshot.memoryHistory.length, 3);
  snapshot.memoryHistory.push({ injected: true });
  assert.equal(observability.getMemoryHistory().length, 3, 'history must be copied, not shared');
});

test('stopping the sampler halts further samples', async () => {
  const observability = createRuntimeObservability({
    memoryUsage: createFixedMemoryUsage(),
    sampleIntervalMs: 10,
    maxHistoryEntries: 100,
    log: () => {},
  });

  observability.start();
  await delay(40);
  observability.stop();

  const lengthAfterStop = observability.getMemoryHistory().length;
  assert.ok(lengthAfterStop >= 2);

  await delay(50);
  assert.equal(
    observability.getMemoryHistory().length,
    lengthAfterStop,
    'no samples may be recorded after stop()'
  );
  assert.equal(observability.stop(), false, 'stopping twice is a no-op');
});

test('sampler timer is unrefed so it can never hold the process open', () => {
  const originalSetInterval = global.setInterval;
  let unrefCallCount = 0;
  let timer = null;

  global.setInterval = (fn, ms, ...args) => {
    timer = originalSetInterval(fn, ms, ...args);
    timer.unref = () => {
      unrefCallCount += 1;
    };
    return timer;
  };

  const observability = createRuntimeObservability({
    memoryUsage: createFixedMemoryUsage(),
    sampleIntervalMs: 10,
    log: () => {},
  });

  try {
    observability.start();
  } finally {
    global.setInterval = originalSetInterval;
  }

  assert.equal(unrefCallCount, 1, 'the sampler interval must be unrefed exactly once');
  observability.stop();
});

test('start is idempotent and disabled for non-positive intervals', () => {
  const observability = createRuntimeObservability({
    memoryUsage: createFixedMemoryUsage(),
    sampleIntervalMs: 0,
    log: () => {},
  });

  assert.equal(observability.start(), false, 'interval <= 0 must disable the sampler');

  const enabled = createRuntimeObservability({
    memoryUsage: createFixedMemoryUsage(),
    sampleIntervalMs: 60000,
    log: () => {},
  });
  assert.equal(enabled.start(), true);
  assert.equal(enabled.start(), false, 'a second start while armed must be a no-op');
  enabled.stop();
});

test('dispose unregisters all providers, stops sampling, and clears history', async () => {
  const observability = createRuntimeObservability({
    memoryUsage: createFixedMemoryUsage(),
    sampleIntervalMs: 10,
    maxHistoryEntries: 5,
    log: () => {},
  });

  observability.registerCounterProvider('turns', () => ({ activeTurns: 1 }));
  observability.start();
  await delay(30);

  observability.dispose();

  assert.deepEqual(observability.getSnapshot().counters, {}, 'dispose must unregister providers');
  assert.deepEqual(observability.getMemoryHistory(), [], 'dispose must clear history');

  const lengthAfterDispose = observability.getMemoryHistory().length;
  await delay(40);
  assert.equal(observability.getMemoryHistory().length, lengthAfterDispose, 'no samples after dispose');
});
