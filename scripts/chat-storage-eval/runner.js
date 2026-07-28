'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const { resolveBenchmarkConfig } = require('./config');
const { calculateOperationMetrics, validateCompletedResult } = require('./metrics');
const { RedisChatBackend } = require('./redis-backend');
const { findRedisServer } = require('./redis-process');
const { SqliteChatBackend } = require('./sqlite-backend');
const { createMessage, createSampleIndexes } = require('./workload');

const DURABILITY_VALUES = new Set(['balanced', 'strict', 'both']);

function parseArgs(argv) {
  const result = { profile: 'quick', durability: 'balanced' };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name.startsWith('--') || value === undefined) throw new Error(`Missing value for argument: ${name}`);
    if (name === '--profile') result.profile = value;
    else if (name === '--durability') result.durability = value;
    else if (name === '--output') result.output = value;
    else if (name === '--seed') result.seed = Number(value);
    else if (name === '--message-count') result.messageCount = Number(value);
    else if (name === '--redis-server') result.redisServerPath = value;
    else throw new Error(`Unknown argument: ${name}`);
  }
  if (!DURABILITY_VALUES.has(result.durability)) {
    throw new Error(`Unknown durability mode: ${result.durability}`);
  }
  resolveBenchmarkConfig(result);
  return result;
}

function writeJsonAtomic(outputPath, value) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, resolved);
}

function computeRecovery(acknowledgedIds, recoveredIds, restartRecoveryMs) {
  const recoveredSet = new Set(recoveredIds);
  const lostIds = acknowledgedIds.filter((id) => !recoveredSet.has(id));
  return {
    acknowledged: acknowledgedIds.length,
    recovered: acknowledgedIds.length - lostIds.length,
    lost: lostIds.length,
    lostIds,
    restartRecoveryMs,
    evidenceKind: 'process-crash',
  };
}

function operationSummary(durations, elapsedMs, logicalCount, extra = {}) {
  const measured = calculateOperationMetrics(durations, elapsedMs);
  return {
    ...measured,
    sampleCount: measured.count,
    count: logicalCount,
    throughputPerSecond: Math.round(((logicalCount * 1000) / elapsedMs) * 1_000_000) / 1_000_000,
    ...extra,
  };
}

function directoryStorage(directory) {
  const files = [];
  let bytes = 0;
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const size = fs.statSync(absolute).size;
        bytes += size;
        files.push({ path: path.relative(directory, absolute).replaceAll('\\', '/'), bytes: size });
      }
    }
  }
  visit(directory);
  return { bytes, files: files.sort((left, right) => left.path.localeCompare(right.path)) };
}

async function measureRepeated(count, operation) {
  const durations = [];
  const started = performance.now();
  for (let index = 0; index < count; index += 1) {
    const operationStarted = performance.now();
    await operation(index);
    durations.push(performance.now() - operationStarted);
  }
  return operationSummary(durations, performance.now() - started, count);
}

async function runBackendPerformance(backend, directory, config) {
  let opened = false;
  const startupStarted = performance.now();
  await backend.open();
  opened = true;
  const startupMs = performance.now() - startupStarted;
  try {
    const durabilitySettings = backend.getDurabilitySettings();
    const appendDurations = [];
    const appendStarted = performance.now();
    for (let start = 0; start < config.messageCount; start += config.appendBatchSize) {
      const end = Math.min(config.messageCount, start + config.appendBatchSize);
      const messages = [];
      for (let index = start; index < end; index += 1) messages.push(createMessage(index, config));
      const batchStarted = performance.now();
      await backend.appendBatch(messages);
      appendDurations.push(performance.now() - batchStarted);
    }
    const append = operationSummary(appendDurations, performance.now() - appendStarted, config.messageCount, {
      batchSize: config.appendBatchSize,
      latencyUnit: 'transaction-batch',
    });

    const latest = await measureRepeated(config.operationSamples, async () => {
      const messages = await backend.latest('thread-hot', 50);
      assert.equal(messages.length, Math.min(50, config.hotThreadMessageCount));
      assert.ok(messages.every((message, index) => index === 0 || message.sequence > messages[index - 1].sequence));
    });

    const cursorPopulation = Math.max(1, config.hotThreadMessageCount - 49);
    const cursorSamples = createSampleIndexes({
      population: cursorPopulation,
      sampleSize: Math.min(config.operationSamples, cursorPopulation),
      seed: config.seed + 1,
    });
    const after = await measureRepeated(cursorSamples.length, async (sampleIndex) => {
      const cursor = cursorSamples[sampleIndex];
      const messages = await backend.after('thread-hot', cursor, 50);
      assert.ok(messages.every((message) => message.sequence > cursor));
      assert.ok(messages.length <= 50);
    });

    const pointIndexes = createSampleIndexes({
      population: config.messageCount,
      sampleSize: Math.min(config.operationSamples, config.messageCount),
      seed: config.seed + 2,
    });
    const pointRead = await measureRepeated(pointIndexes.length, async (sampleIndex) => {
      const expected = createMessage(pointIndexes[sampleIndex], config);
      const actual = await backend.getById(expected.id);
      assert.equal(actual.id, expected.id);
      assert.equal(actual.content.length, expected.content.length);
    });
    const statusUpdate = await measureRepeated(pointIndexes.length, async (sampleIndex) => {
      const message = createMessage(pointIndexes[sampleIndex], config);
      const updated = await backend.updateStatus(message.id, 'reviewed');
      assert.equal(updated.status, 'reviewed');
    });
    const count = await measureRepeated(config.operationSamples, async () => {
      assert.equal(await backend.count('thread-hot'), config.hotThreadMessageCount);
    });
    const memory = await backend.getMemoryStats();

    await backend.close({ graceful: true });
    opened = false;
    return {
      status: 'completed',
      startupMs,
      durabilitySettings,
      operations: { append, latest, after, pointRead, statusUpdate, count },
      storage: directoryStorage(directory),
      memory,
    };
  } finally {
    if (opened) await backend.close({ graceful: true });
  }
}

function waitForCrashWriter(child, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SQLite crash writer timed out')), timeoutMs);
    const settle = (callback, value) => {
      clearTimeout(timer);
      callback(value);
    };
    child.once('error', (error) => settle(reject, error));
    child.once('exit', (code, signal) => {
      if (code !== null || signal) settle(reject, new Error(`SQLite crash writer exited early: ${code ?? signal}`));
    });
    child.on('message', (message) => {
      if (message.type === 'ready-for-crash') settle(resolve, message.acknowledgedIds);
      if (message.type === 'error') settle(reject, new Error(message.message));
    });
  });
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}

async function recoveredIdsForBackend(backend, acknowledgedIds) {
  const recovered = [];
  for (const id of acknowledgedIds) {
    if (await backend.getById(id)) recovered.push(id);
  }
  return recovered;
}

async function runSqliteRecoveryProbe(config, durability) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-sqlite-recovery-'));
  const writerPath = path.join(__dirname, 'sqlite-crash-writer.js');
  const child = fork(
    writerPath,
    [JSON.stringify({ directory, durability, config })],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true }
  );
  let backend;
  try {
    const acknowledgedIds = await waitForCrashWriter(child);
    child.kill('SIGKILL');
    await waitForChildExit(child);

    backend = new SqliteChatBackend({ directory, durability });
    const restartStarted = performance.now();
    await backend.open();
    const restartRecoveryMs = performance.now() - restartStarted;
    const recoveredIds = await recoveredIdsForBackend(backend, acknowledgedIds);
    await backend.close({ graceful: true });
    backend = null;
    return computeRecovery(acknowledgedIds, recoveredIds, restartRecoveryMs);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForChildExit(child);
    }
    if (backend) await backend.close({ graceful: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function runRedisRecoveryProbe(config, durability, redisServerPath) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-redis-recovery-'));
  const backend = new RedisChatBackend({ directory, durability, redisServerPath });
  try {
    await backend.open();
    const acknowledgedIds = [];
    for (let start = 0; start < config.recoveryMessageCount; start += config.appendBatchSize) {
      const end = Math.min(config.recoveryMessageCount, start + config.appendBatchSize);
      const messages = [];
      for (let index = start; index < end; index += 1) messages.push(createMessage(index, config));
      await backend.appendBatch(messages);
      acknowledgedIds.push(...messages.map((message) => message.id));
    }
    await backend.crash();
    const restartStarted = performance.now();
    await backend.open();
    const restartRecoveryMs = performance.now() - restartStarted;
    const recoveredIds = await recoveredIdsForBackend(backend, acknowledgedIds);
    await backend.close({ graceful: true });
    return computeRecovery(acknowledgedIds, recoveredIds, restartRecoveryMs);
  } finally {
    await backend.close({ graceful: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function runNamedBackend(name, config, durability, redisServerPath) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `caff-${name}-performance-`));
  const backend =
    name === 'sqlite'
      ? new SqliteChatBackend({ directory, durability })
      : new RedisChatBackend({ directory, durability, redisServerPath });
  try {
    const performanceResult = await runBackendPerformance(backend, directory, config);
    const recovery =
      name === 'sqlite'
        ? await runSqliteRecoveryProbe(config, durability)
        : await runRedisRecoveryProbe(config, durability, redisServerPath);
    return { ...performanceResult, recovery };
  } finally {
    await backend.close({ graceful: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function collectEnvironment(redisServerPath) {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  const redis = redisServerPath
    ? spawnSync(redisServerPath, ['--version'], { encoding: 'utf8', windowsHide: true })
    : null;
  const cpus = os.cpus();
  return {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    node: process.version,
    cpuModel: cpus[0] ? cpus[0].model : 'unknown',
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    betterSqlite3: require('better-sqlite3/package.json').version,
    redisServer: redis && redis.status === 0 ? `${redis.stdout}${redis.stderr}`.trim() : 'unavailable',
    sourceCommit: git.status === 0 ? git.stdout.trim() : 'unknown',
  };
}

const LIMITATIONS = [
  'One local Windows machine; results are not a distributed deployment benchmark.',
  'Synthetic deterministic message content does not reproduce every production access pattern.',
  'Process termination does not simulate host power loss or storage-device failure.',
  'SQLite RSS is measured inside the shared Node harness process and is not directly comparable to Redis process RSS.',
  'Performance runs use alternating backend order by durability, but OS cache and background activity can still affect results.',
];

async function runDurability(config, durability, redisServerPath, environment) {
  const backends = {};
  const order = durability === 'balanced' ? ['sqlite', 'redis'] : ['redis', 'sqlite'];
  for (const name of order) {
    if (name === 'redis' && !redisServerPath) {
      backends.redis = { status: 'skipped', reason: 'redis-server is unavailable' };
      continue;
    }
    console.log(`[${durability}] running ${name}...`);
    backends[name] = await runNamedBackend(name, config, durability, redisServerPath);
  }
  const run = {
    schemaVersion: 1,
    environment,
    configuration: { ...config, durability },
    backends,
    limitations: LIMITATIONS,
    verdictInputs: {
      complete: backends.sqlite?.status === 'completed' && backends.redis?.status === 'completed',
      acknowledgedLoss: {
        sqlite: backends.sqlite?.recovery?.lost ?? null,
        redis: backends.redis?.recovery?.lost ?? null,
      },
    },
  };
  if (run.verdictInputs.complete) validateCompletedResult(run);
  return run;
}

async function runSuite(options) {
  const config = resolveBenchmarkConfig(options);
  const redisServerPath = findRedisServer(options.redisServerPath);
  const environment = collectEnvironment(redisServerPath);
  const durabilities = options.durability === 'both' ? ['balanced', 'strict'] : [options.durability];
  const runs = [];
  for (const durability of durabilities) {
    runs.push(await runDurability(config, durability, redisServerPath, environment));
  }
  const complete = runs.every((run) => run.verdictInputs.complete);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment,
    configuration: { ...config, durabilityProfiles: durabilities },
    runs,
    limitations: LIMITATIONS,
    verdictStatus: complete ? 'complete' : 'incomplete',
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const output = path.resolve(
    options.output || path.join(os.tmpdir(), `caff-chat-storage-${options.profile}-${options.durability}.json`)
  );
  const suite = await runSuite(options);
  writeJsonAtomic(output, suite);
  console.log(`Wrote ${output}`);
  if (suite.verdictStatus !== 'complete') console.warn('Redis unavailable: evidence is incomplete and not verdict-ready.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { computeRecovery, parseArgs, runSuite, writeJsonAtomic };
