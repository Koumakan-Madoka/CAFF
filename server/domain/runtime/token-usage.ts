function normalizeTokenCount(value: any) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const count = Number(value);

  if (!Number.isFinite(count) || count < 0) {
    return null;
  }

  return Math.round(count);
}

function normalizeCostAmount(value: any) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const amount = Number(value);

  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }

  return amount;
}

function pickTokenCount(usage: any, keys: string[]) {
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(usage, key)) {
      const count = normalizeTokenCount(usage[key]);

      if (count !== null) {
        return count;
      }
    }
  }

  return null;
}

function pickCostAmount(cost: any, keys: string[]) {
  if (!cost || typeof cost !== 'object') {
    return null;
  }

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(cost, key)) {
      const amount = normalizeCostAmount(cost[key]);

      if (amount !== null) {
        return amount;
      }
    }
  }

  return null;
}

export function summarizeTokenUsage(usage: any) {
  const rawUsage = usage && typeof usage === 'object' && !Array.isArray(usage) ? usage : null;

  if (!rawUsage) {
    return null;
  }

  const uncachedInputTokens = pickTokenCount(rawUsage, [
    'uncachedInputTokens',
    'uncached_input_tokens',
    'inputTokens',
    'input_tokens',
    'promptTokens',
    'prompt_tokens',
    'prompt',
    'input',
  ]);
  const outputTokens = pickTokenCount(rawUsage, [
    'outputTokens',
    'output_tokens',
    'completionTokens',
    'completion_tokens',
    'completion',
    'output',
  ]);
  const cacheReadTokens = pickTokenCount(rawUsage, ['cacheReadTokens', 'cache_read_tokens', 'cacheRead', 'cache_read', 'cachedTokens', 'cached_tokens']);
  const cacheWriteTokens = pickTokenCount(rawUsage, [
    'cacheWriteTokens',
    'cache_write_tokens',
    'cacheWrite',
    'cache_write',
    'cacheCreationTokens',
    'cache_creation_tokens',
    'cache_creation_input_tokens',
  ]);
  const inputTokens = uncachedInputTokens !== null
    ? uncachedInputTokens + (cacheReadTokens || 0) + (cacheWriteTokens || 0)
    : null;
  const explicitTotalTokens = pickTokenCount(rawUsage, ['totalTokens', 'total_tokens', 'total']);
  const totalTokens = explicitTotalTokens !== null
    ? explicitTotalTokens
    : inputTokens !== null || outputTokens !== null
      ? (inputTokens || 0) + (outputTokens || 0)
      : null;
  const rawCost = rawUsage.cost && typeof rawUsage.cost === 'object' && !Array.isArray(rawUsage.cost) ? rawUsage.cost : null;
  const inputCostUsd = pickCostAmount(rawCost, ['inputUsd', 'inputUSD', 'inputCostUsd', 'input_cost_usd', 'inputCost', 'input_cost', 'input']);
  const outputCostUsd = pickCostAmount(rawCost, ['outputUsd', 'outputUSD', 'outputCostUsd', 'output_cost_usd', 'outputCost', 'output_cost', 'output']);
  const cacheReadCostUsd = pickCostAmount(rawCost, ['cacheReadUsd', 'cacheReadUSD', 'cacheReadCostUsd', 'cache_read_cost_usd', 'cacheReadCost', 'cache_read_cost', 'cacheRead', 'cache_read']);
  const cacheWriteCostUsd = pickCostAmount(rawCost, ['cacheWriteUsd', 'cacheWriteUSD', 'cacheWriteCostUsd', 'cache_write_cost_usd', 'cacheWriteCost', 'cache_write_cost', 'cacheWrite', 'cache_write']);
  const explicitTotalCostUsd = pickCostAmount(rawCost, ['totalUsd', 'totalUSD', 'totalCostUsd', 'total_cost_usd', 'totalCost', 'total_cost', 'total']);
  const totalCostUsd = explicitTotalCostUsd !== null
    ? explicitTotalCostUsd
    : inputCostUsd !== null || outputCostUsd !== null || cacheReadCostUsd !== null || cacheWriteCostUsd !== null
      ? (inputCostUsd || 0) + (outputCostUsd || 0) + (cacheReadCostUsd || 0) + (cacheWriteCostUsd || 0)
      : null;

  if (inputTokens === null && outputTokens === null && totalTokens === null && cacheReadTokens === null && cacheWriteTokens === null && totalCostUsd === null) {
    return null;
  }

  return {
    inputTokens,
    uncachedInputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
    inputCostUsd,
    outputCostUsd,
    cacheReadCostUsd,
    cacheWriteCostUsd,
    totalCostUsd,
  };
}

export function summarizeModelUsageCalls(calls: any) {
  const sourceCalls = Array.isArray(calls) ? calls : [];
  const normalizedCalls: any[] = [];

  for (const sourceCall of sourceCalls) {
    const rawUsage = sourceCall && sourceCall.usage && typeof sourceCall.usage === 'object' && !Array.isArray(sourceCall.usage)
      ? sourceCall.usage
      : sourceCall && typeof sourceCall === 'object' && !Array.isArray(sourceCall)
        ? sourceCall
        : null;
    const tokenUsage = summarizeTokenUsage(rawUsage);

    if (!tokenUsage) {
      continue;
    }

    const index: number = normalizedCalls.length;
    // Cold start is defined by normalized call order: skipped calls with no
    // usage are not observable in this summary.
    const coldStart = index === 0;
    const providerMiss = !coldStart && tokenUsage.cacheReadTokens === 0 && (tokenUsage.uncachedInputTokens || 0) > 0;

    normalizedCalls.push({
      index,
      sequence: index + 1,
      key: String(sourceCall && sourceCall.key ? sourceCall.key : '').trim(),
      responseId: String(sourceCall && sourceCall.responseId ? sourceCall.responseId : '').trim(),
      stopReason: String(sourceCall && sourceCall.stopReason ? sourceCall.stopReason : '').trim(),
      timestamp: sourceCall && sourceCall.timestamp !== undefined ? sourceCall.timestamp : null,
      // Keep coldStart as a legacy alias; isColdStart is the canonical field.
      coldStart,
      isColdStart: coldStart,
      providerMiss,
      tokenUsage,
    });
  }

  if (normalizedCalls.length === 0) {
    return null;
  }

  const coldStartModelCallCount = normalizedCalls.filter((call) => call.coldStart).length;
  const postColdModelCallCount = normalizedCalls.filter((call) => !call.coldStart).length;
  const providerMissCount = normalizedCalls.filter((call) => call.providerMiss).length;

  return {
    modelCallCount: normalizedCalls.length,
    coldStartModelCallCount,
    postColdModelCallCount,
    providerMissCount,
    calls: normalizedCalls,
  };
}
