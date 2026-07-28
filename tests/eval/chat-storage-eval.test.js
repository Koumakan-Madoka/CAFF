const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { assertSafeRedisPort, resolveBenchmarkConfig } = require('../../scripts/chat-storage-eval/config');
const { calculateOperationMetrics, validateCompletedResult } = require('../../scripts/chat-storage-eval/metrics');
const { SqliteChatBackend } = require('../../scripts/chat-storage-eval/sqlite-backend');
const { createMessage, createSampleIndexes } = require('../../scripts/chat-storage-eval/workload');

function createTempDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `caff-${name}-`));
}

test('benchmark config exposes bounded deterministic profiles', () => {
  const first = resolveBenchmarkConfig({ profile: 'quick', seed: 41 });
  const second = resolveBenchmarkConfig({ profile: 'quick', seed: 41 });

  assert.deepEqual(first, second);
  assert.equal(first.profile, 'quick');
  assert.equal(first.seed, 41);
  assert.ok(first.messageCount >= 100);
  assert.ok(first.hotThreadMessageCount > first.ordinaryThreadMessageCount);
  assert.ok(first.operationSamples >= 20);
});

test('benchmark config rejects invalid profiles and unsafe counts', () => {
  assert.throws(() => resolveBenchmarkConfig({ profile: 'unknown' }), /Unknown benchmark profile/);
  assert.throws(() => resolveBenchmarkConfig({ profile: 'quick', messageCount: 0 }), /messageCount/);
  assert.throws(() => resolveBenchmarkConfig({ profile: 'quick', seed: -1 }), /seed/);
});

test('Redis benchmark rejects production and shared development ports', () => {
  assert.throws(() => assertSafeRedisPort(6399), /reserved/);
  assert.throws(() => assertSafeRedisPort(6398), /reserved/);
  assert.throws(() => assertSafeRedisPort(0), /valid TCP port/);
  assert.equal(assertSafeRedisPort(6387), 6387);
});

test('synthetic messages are deterministic and exercise payload sizes and mentions', () => {
  const config = resolveBenchmarkConfig({ profile: 'quick', seed: 7 });
  const first = createMessage(17, config);
  const second = createMessage(17, config);
  const different = createMessage(18, config);

  assert.deepEqual(first, second);
  assert.notEqual(first.id, different.id);
  assert.equal(first.sequence, 18);
  assert.match(first.threadId, /^thread-/);
  assert.match(first.userId, /^user-/);
  assert.ok(Buffer.byteLength(first.content, 'utf8') >= 512);
  assert.ok(Array.isArray(first.mentions));
});

test('sample indexes are deterministic, unique, and bounded', () => {
  const first = createSampleIndexes({ population: 1000, sampleSize: 100, seed: 11 });
  const second = createSampleIndexes({ population: 1000, sampleSize: 100, seed: 11 });

  assert.deepEqual(first, second);
  assert.equal(first.length, 100);
  assert.equal(new Set(first).size, 100);
  assert.ok(first.every((index) => index >= 0 && index < 1000));
});

test('operation metrics calculate stable percentiles and throughput', () => {
  const metrics = calculateOperationMetrics([1, 2, 3, 4, 100], 1000);

  assert.equal(metrics.count, 5);
  assert.equal(metrics.p50Ms, 3);
  assert.equal(metrics.p95Ms, 100);
  assert.equal(metrics.p99Ms, 100);
  assert.equal(metrics.minMs, 1);
  assert.equal(metrics.maxMs, 100);
  assert.equal(metrics.throughputPerSecond, 5);
});

test('completed result validation rejects partial or fabricated evidence', () => {
  assert.throws(() => validateCompletedResult({ schemaVersion: 1 }), /environment/);

  const result = {
    schemaVersion: 1,
    environment: { platform: 'test', node: 'test' },
    configuration: { profile: 'quick', durability: 'balanced' },
    backends: {
      sqlite: {
        status: 'completed',
        operations: { append: { count: 1 } },
        storage: { bytes: 1 },
        recovery: { acknowledged: 1, recovered: 1, lost: 0 },
      },
      redis: {
        status: 'completed',
        operations: { append: { count: 1 } },
        storage: { bytes: 1 },
        recovery: { acknowledged: 1, recovered: 1, lost: 0 },
      },
    },
    limitations: ['synthetic workload'],
    verdictInputs: { durableSourceOfTruth: 'pending' },
  };

  assert.equal(validateCompletedResult(result), result);
  assert.throws(
    () => validateCompletedResult({ ...result, backends: { ...result.backends, redis: { status: 'completed' } } }),
    /redis\.operations/
  );
});

test('SQLite backend implements the message contract and survives a graceful restart', async () => {
  const directory = createTempDirectory('sqlite-contract');
  const config = resolveBenchmarkConfig({ profile: 'quick', seed: 23 });
  const messages = Array.from({ length: 5 }, (_, index) => createMessage(index, config));

  try {
    const backend = new SqliteChatBackend({ directory, durability: 'balanced' });
    await backend.open();
    assert.deepEqual(backend.getDurabilitySettings(), {
      journalMode: 'wal',
      synchronous: 'NORMAL',
    });

    await backend.append(messages[0]);
    await backend.appendBatch(messages.slice(1));

    assert.deepEqual(
      (await backend.latest('thread-hot', 3)).map((message) => message.id),
      messages.slice(2).map((message) => message.id)
    );
    assert.deepEqual(
      (await backend.after('thread-hot', messages[1].sequence, 2)).map((message) => message.id),
      messages.slice(2, 4).map((message) => message.id)
    );
    assert.deepEqual(await backend.getById(messages[1].id), messages[1]);
    assert.equal((await backend.updateStatus(messages[1].id, 'failed')).status, 'failed');
    assert.equal(await backend.count('thread-hot'), 5);
    await backend.close({ graceful: true });

    const reopened = new SqliteChatBackend({ directory, durability: 'balanced' });
    await reopened.open();
    assert.equal(await reopened.count('thread-hot'), 5);
    assert.equal((await reopened.getById(messages[1].id)).status, 'failed');
    await reopened.close({ graceful: true });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite strict durability applies FULL synchronous mode', async () => {
  const directory = createTempDirectory('sqlite-strict');
  const backend = new SqliteChatBackend({ directory, durability: 'strict' });

  try {
    await backend.open();
    assert.deepEqual(backend.getDurabilitySettings(), {
      journalMode: 'wal',
      synchronous: 'FULL',
    });
  } finally {
    await backend.close({ graceful: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
