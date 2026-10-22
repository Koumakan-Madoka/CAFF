const assert = require('node:assert/strict');
const test = require('node:test');

const {
  JEV_MIN_CONFIDENCE,
  buildJevState,
  createJevClassifier,
  jevCacheKey,
  truncateStepOutput,
} = require('../../build/server/domain/runtime/turn-time-breakdown-jev');
const { TypeSafeClientError } = require('../../build/server/domain/integrations/typesafe/typesafe-client');

function step(overrides = {}) {
  return {
    toolName: 'bash',
    args: { command: 'bash scripts/run-all.sh' },
    output: 'some output',
    isError: false,
    durationMs: 1234,
    ...overrides,
  };
}

function fakeClient(handler, calls) {
  return {
    ask: async (input) => {
      calls.push(input);

      return handler(input);
    },
  };
}

function memoryCache() {
  const map = new Map();

  return {
    map,
    get: (key) => map.get(key) || null,
    set: (key, entry) => map.set(key, entry),
  };
}

test('confident JEV answer classifies the step and populates the cache', async () => {
  const calls = [];
  const cache = memoryCache();
  const client = fakeClient(() => ({
    answers: {
      category: { type: 'choice', choice: 'test', confidence: 0.92 },
      run_kind: { type: 'choice', choice: 'full-regression', confidence: 0.9 },
    },
  }), calls);
  const classifier = createJevClassifier({ client, cache });

  const result = await classifier.classifyStep(step());

  assert.equal(result.category, 'test');
  assert.equal(result.runKind, 'full-regression');
  assert.equal(result.classifiedBy, 'jev');
  assert.equal(result.jevStatus, 'ok');
  assert.equal(result.confidence, 0.92);
  assert.equal(calls.length, 1);
  assert.equal(cache.map.size, 1);
});

test('cache hit skips the network and reports jev-cache', async () => {
  const calls = [];
  const cache = memoryCache();
  const client = fakeClient(() => ({
    answers: {
      category: { type: 'choice', choice: 'test', confidence: 0.9 },
      run_kind: { type: 'choice', choice: 'targeted', confidence: 0.9 },
    },
  }), calls);
  const classifier = createJevClassifier({ client, cache });

  await classifier.classifyStep(step());
  const second = await classifier.classifyStep(step({ output: 'some output but longer' }));

  assert.equal(calls.length, 1); // same fingerprint bucket → no second call
  assert.equal(second.category, 'test');
  assert.equal(second.runKind, 'targeted');
  assert.equal(second.classifiedBy, 'jev-cache');
  assert.equal(second.jevStatus, 'ok');
});

test('low confidence degrades to unclassified and is not cached', async () => {
  const calls = [];
  const cache = memoryCache();
  const client = fakeClient(() => ({
    answers: {
      category: { type: 'choice', choice: 'write', confidence: JEV_MIN_CONFIDENCE - 0.01 },
      run_kind: { type: 'choice', choice: 'not-a-test', confidence: 0.9 },
    },
  }), calls);
  const classifier = createJevClassifier({ client, cache });

  const result = await classifier.classifyStep(step());

  assert.equal(result.category, 'unclassified');
  assert.equal(result.jevStatus, 'low-confidence');
  assert.equal(cache.map.size, 0);

  await classifier.classifyStep(step());
  assert.equal(calls.length, 2); // no cache entry → JEV asked again
});

test('JEV answering unclassified stays unclassified with ok status', async () => {
  const client = fakeClient(() => ({
    answers: {
      category: { type: 'choice', choice: 'unclassified', confidence: 0.99 },
      run_kind: { type: 'choice', choice: 'not-a-test', confidence: 0.99 },
    },
  }), []);
  const classifier = createJevClassifier({ client });

  const result = await classifier.classifyStep(step());

  assert.equal(result.category, 'unclassified');
  assert.equal(result.jevStatus, 'ok');
});

test('timeout, error, and not-configured map to honest jevStatus', async () => {
  const timeout = createJevClassifier({
    client: fakeClient(() => {
      throw new TypeSafeClientError('typesafe_timeout', 'timed out');
    }, []),
  });

  assert.equal((await timeout.classifyStep(step())).jevStatus, 'timeout');

  const network = createJevClassifier({
    client: fakeClient(() => {
      throw new TypeSafeClientError('typesafe_network_error', 'boom');
    }, []),
  });

  assert.equal((await network.classifyStep(step())).jevStatus, 'error');

  const notConfigured = createJevClassifier({
    client: fakeClient(() => {
      throw new TypeSafeClientError('typesafe_not_configured', 'no key');
    }, []),
  });

  assert.equal((await notConfigured.classifyStep(step())).jevStatus, 'disabled');
});

test('disabled classifier never calls the client', async () => {
  const calls = [];
  const client = fakeClient(() => ({
    answers: { category: { type: 'choice', choice: 'test', confidence: 1 } },
  }), calls);

  for (const classifier of [
    createJevClassifier({ client, enabled: false }),
    createJevClassifier({ client: null }),
  ]) {
    const result = await classifier.classifyStep(step());

    assert.equal(result.category, 'unclassified');
    assert.equal(result.jevStatus, 'disabled');
  }

  assert.equal(calls.length, 0);
});

test('runKind is only taken from a test category answer', async () => {
  const client = fakeClient(() => ({
    answers: {
      category: { type: 'choice', choice: 'write', confidence: 0.95 },
      run_kind: { type: 'choice', choice: 'full-regression', confidence: 0.95 },
    },
  }), []);
  const classifier = createJevClassifier({ client });

  const result = await classifier.classifyStep(step());

  assert.equal(result.category, 'write');
  assert.equal(result.runKind, null);
});

test('output truncation keeps head 2000 + tail 2000 with a marker', () => {
  const long = 'h'.repeat(2100) + 'M'.repeat(2000) + 't'.repeat(2100);
  const truncated = truncateStepOutput(long);

  assert.ok(truncated.length < long.length);
  assert.ok(truncated.startsWith('h'.repeat(2000)));
  assert.ok(truncated.endsWith('t'.repeat(2000)));
  assert.ok(/truncated 2200 chars/.test(truncated));

  assert.equal(truncateStepOutput('short'), 'short');
  assert.equal(truncateStepOutput(null), '');
});

test('buildJevState truncates output and extracts the command', () => {
  const state = buildJevState(step({ output: 'x'.repeat(9000) }));

  assert.equal(state.toolName, 'bash');
  assert.equal(state.command, 'bash scripts/run-all.sh');
  assert.ok(state.output.length < 5000);
  assert.equal(state.isError, false);
  assert.equal(state.durationMs, 1234);
});

test('cache key is stable across output churn but separates commands and failures', () => {
  const base = jevCacheKey(step());

  assert.equal(jevCacheKey(step({ output: 'some output with extra lines appended' })), base);
  assert.notEqual(jevCacheKey(step({ args: { command: 'bash scripts/other.sh' } })), base);
  assert.notEqual(jevCacheKey(step({ isError: true })), base);
  assert.notEqual(jevCacheKey(step({ output: '3 failing' })), base);
});

test('opaque bodies (heredoc / inline / multi-line) key on the whole script', () => {
  const readScript = "node - <<'NODE'\nconst fs = require('fs');\nconsole.log(fs.readFileSync('a.txt', 'utf8'));\nNODE";
  const writeScript = "node - <<'NODE'\nconst fs = require('fs');\nfs.writeFileSync('a.txt', 'x');\nNODE";

  // A read-only heredoc and a writing heredoc must never share an entry.
  assert.notEqual(jevCacheKey(step({ args: { command: readScript } })), jevCacheKey(step({ args: { command: writeScript } })));
  // Identical re-runs still hit the cache.
  assert.equal(jevCacheKey(step({ args: { command: readScript } })), jevCacheKey(step({ args: { command: readScript } })));

  // Same first line, different follow-up body → different keys.
  const multiA = 'cd /repo && npm test\necho done-a';
  const multiB = 'cd /repo && npm test\necho done-b';

  assert.notEqual(jevCacheKey(step({ args: { command: multiA } })), jevCacheKey(step({ args: { command: multiB } })));

  // Inline-exec payloads: `bash -c 'npm test'` vs `bash -c 'npm run build'`.
  assert.notEqual(
    jevCacheKey(step({ args: { command: "bash -c 'npm test'" } })),
    jevCacheKey(step({ args: { command: "bash -c 'npm run build'" } })),
  );

  // Single-line transparent commands keep argv-level identity (no body digest):
  // two greps of the same pattern in different files share one entry.
  assert.equal(
    jevCacheKey(step({ args: { command: 'grep -n foo a.js' } })),
    jevCacheKey(step({ args: { command: 'grep -n foo b.js' } })),
  );
});

test('a throwing cache.get behaves as a miss and never rejects', async () => {
  const calls = [];
  const client = fakeClient(() => ({
    answers: {
      category: { type: 'choice', choice: 'read', confidence: 0.9 },
      run_kind: { type: 'choice', choice: 'not-a-test', confidence: 0.9 },
    },
  }), calls);
  const cache = {
    get: () => {
      throw new Error('SQLITE_BUSY');
    },
    set: () => {},
  };
  const classifier = createJevClassifier({ client, cache });

  const result = await classifier.classifyStep(step());

  assert.equal(result.category, 'read');
  assert.equal(result.jevStatus, 'ok');
  assert.equal(calls.length, 1);
});

test('a throwing cache.set never fails classification', async () => {
  const client = fakeClient(() => ({
    answers: {
      category: { type: 'choice', choice: 'write', confidence: 0.95 },
      run_kind: { type: 'choice', choice: 'not-a-test', confidence: 0.9 },
    },
  }), []);
  const cache = {
    get: () => null,
    set: () => {
      throw new Error('disk full');
    },
  };
  const classifier = createJevClassifier({ client, cache });

  const result = await classifier.classifyStep(step());

  assert.equal(result.category, 'write');
  assert.equal(result.jevStatus, 'ok');
});

test('malformed steps never reject classifyStep', async () => {
  const client = fakeClient(() => ({
    answers: {
      category: { type: 'choice', choice: 'unclassified', confidence: 0.9 },
      run_kind: { type: 'choice', choice: 'not-a-test', confidence: 0.9 },
    },
  }), []);
  const classifier = createJevClassifier({ client });

  for (const weird of [null, undefined, {}, { args: 42 }, { args: '{broken json', output: { bad: true } }, { toolName: 'bash' }]) {
    const result = await classifier.classifyStep(weird);

    assert.equal(typeof result.category, 'string');
    assert.ok(result.jevStatus);
  }
});

test('cache entries carry the full §7 shape (subcategory, runKind, confidence)', async () => {
  const cache = memoryCache();
  const client = fakeClient(() => ({
    answers: {
      category: { type: 'choice', choice: 'test', confidence: 0.9 },
      run_kind: { type: 'choice', choice: 'full-regression', confidence: 0.9 },
    },
  }), []);
  const classifier = createJevClassifier({ client, cache });

  await classifier.classifyStep(step());

  const entry = [...cache.map.values()][0];

  assert.deepEqual(Object.keys(entry).sort(), ['category', 'confidence', 'runKind', 'subcategory']);
  assert.equal(entry.runKind, 'full-regression');
  assert.equal(entry.subcategory, null);

  // …and a cache hit must not lose runKind (AC4 fullRunCount depends on it).
  const second = await classifier.classifyStep(step());

  assert.equal(second.runKind, 'full-regression');
  assert.equal(second.classifiedBy, 'jev-cache');
});

test('buildJevState truncates oversized commands at 8000 head chars', () => {
  const state = buildJevState(step({ args: { command: `node -e "${'x'.repeat(9000)}"` } }));

  assert.ok(state.command.length < 8300);
  assert.ok(/truncated \d+ chars/.test(state.command));
});
