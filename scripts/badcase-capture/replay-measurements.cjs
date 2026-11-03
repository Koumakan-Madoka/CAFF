// Token reports are supplier-reported observations, not ChatGPT quota units or
// remaining credit. Partial/missing evidence must never turn into zero usage.
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];
function tokenUsage(calls, { callsUnavailable = false } = {}) {
  let knownCalls = 0, callsWithoutUsage = 0, knownTokens = null, overflow = false;
  for (const call of calls) {
    if (!call?.usage || !FIELDS.every(k => Number.isSafeInteger(call.usage[k]) && call.usage[k] >= 0)) { callsWithoutUsage++; continue; }
    knownCalls++;
    if (overflow) continue;
    knownTokens ??= Object.fromEntries(FIELDS.map(k => [k, 0]));
    for (const k of FIELDS) {
      const value = knownTokens[k] + call.usage[k];
      if (!Number.isSafeInteger(value)) { overflow = true; knownTokens = null; break; }
      knownTokens[k] = value;
    }
  }
  return { knownCalls, callsWithoutUsage, callsUnavailable, knownTokens,
    complete: calls.length > 0 && callsWithoutUsage === 0 && !callsUnavailable && !overflow, ...(overflow ? { overflow: true } : {}) };
}
module.exports = { tokenUsage };
