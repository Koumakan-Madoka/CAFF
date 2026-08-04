'use strict';

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(sortedValues, quantile) {
  if (sortedValues.length === 0) return null;
  const index = Math.max(0, Math.ceil(quantile * sortedValues.length) - 1);
  return sortedValues[index];
}

function calculateOperationMetrics(durationsMs, elapsedMs) {
  if (!Array.isArray(durationsMs) || durationsMs.length === 0) {
    throw new Error('durationsMs must contain at least one measurement');
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    throw new Error('elapsedMs must be positive');
  }
  const sorted = durationsMs.map(Number).sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    elapsedMs: round(elapsedMs),
    throughputPerSecond: round((sorted.length * 1000) / elapsedMs),
    minMs: round(sorted[0]),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    maxMs: round(sorted[sorted.length - 1]),
    meanMs: round(total / sorted.length),
  };
}

function requireObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Completed result is missing ${path}`);
  }
}

function validateCompletedResult(result) {
  requireObject(result, 'root');
  if (result.schemaVersion !== 1) throw new Error('Completed result requires schemaVersion=1');
  requireObject(result.environment, 'environment');
  requireObject(result.configuration, 'configuration');
  requireObject(result.backends, 'backends');
  for (const backendName of ['sqlite', 'redis']) {
    const backend = result.backends[backendName];
    requireObject(backend, backendName);
    if (backend.status !== 'completed') {
      throw new Error(`Completed result requires ${backendName}.status=completed`);
    }
    requireObject(backend.operations, `${backendName}.operations`);
    requireObject(backend.storage, `${backendName}.storage`);
    requireObject(backend.recovery, `${backendName}.recovery`);
  }
  if (!Array.isArray(result.limitations)) throw new Error('Completed result requires limitations');
  requireObject(result.verdictInputs, 'verdictInputs');
  return result;
}

module.exports = {
  calculateOperationMetrics,
  percentile,
  validateCompletedResult,
};
