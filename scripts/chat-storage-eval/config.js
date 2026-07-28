'use strict';

const RESERVED_REDIS_PORTS = new Set([6398, 6399]);

const PROFILES = Object.freeze({
  quick: Object.freeze({
    messageCount: 2_000,
    hotThreadMessageCount: 1_000,
    ordinaryThreadCount: 50,
    operationSamples: 100,
    recoveryMessageCount: 200,
    appendBatchSize: 50,
  }),
  standard: Object.freeze({
    messageCount: 50_000,
    hotThreadMessageCount: 25_000,
    ordinaryThreadCount: 100,
    operationSamples: 500,
    recoveryMessageCount: 2_000,
    appendBatchSize: 100,
  }),
  stress: Object.freeze({
    messageCount: 1_000_000,
    hotThreadMessageCount: 500_000,
    ordinaryThreadCount: 1_000,
    operationSamples: 2_000,
    recoveryMessageCount: 10_000,
    appendBatchSize: 250,
  }),
});

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function nonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return parsed;
}

function resolveBenchmarkConfig(input = {}) {
  const profile = String(input.profile || 'quick').trim().toLowerCase();
  const defaults = PROFILES[profile];
  if (!defaults) {
    throw new Error(`Unknown benchmark profile: ${profile}`);
  }

  const messageCount = positiveInteger(input.messageCount ?? defaults.messageCount, 'messageCount');
  const hotThreadMessageCount = Math.min(
    messageCount,
    positiveInteger(input.hotThreadMessageCount ?? defaults.hotThreadMessageCount, 'hotThreadMessageCount')
  );
  const ordinaryThreadCount = positiveInteger(
    input.ordinaryThreadCount ?? defaults.ordinaryThreadCount,
    'ordinaryThreadCount'
  );
  const ordinaryMessageCount = Math.max(0, messageCount - hotThreadMessageCount);

  return Object.freeze({
    profile,
    seed: nonNegativeInteger(input.seed ?? 20260728, 'seed'),
    messageCount,
    hotThreadMessageCount,
    ordinaryThreadCount,
    ordinaryThreadMessageCount: Math.ceil(ordinaryMessageCount / ordinaryThreadCount),
    operationSamples: positiveInteger(input.operationSamples ?? defaults.operationSamples, 'operationSamples'),
    recoveryMessageCount: positiveInteger(
      input.recoveryMessageCount ?? defaults.recoveryMessageCount,
      'recoveryMessageCount'
    ),
    appendBatchSize: positiveInteger(input.appendBatchSize ?? defaults.appendBatchSize, 'appendBatchSize'),
  });
}

function assertSafeRedisPort(port) {
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('Redis benchmark requires a valid TCP port');
  }
  if (RESERVED_REDIS_PORTS.has(parsed)) {
    throw new Error(`Redis port ${parsed} is reserved and cannot be used by the benchmark`);
  }
  return parsed;
}

module.exports = {
  PROFILES,
  RESERVED_REDIS_PORTS,
  assertSafeRedisPort,
  resolveBenchmarkConfig,
};
