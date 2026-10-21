const assert = require('node:assert/strict');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { createModelCallObservabilityEvent, createObservabilityTimelineState } = require('../../build/lib/observability-timeline');
const { summarizeModelUsageCalls } = require('../../build/server/domain/runtime/token-usage');

const codex = { provider: 'openai-codex', api: 'openai-codex-responses', id: 'gpt-6.1-sol' };
const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../lib/pi-extensions/caff-fast-mode.mjs')).href;
async function observe(options, payload = { model: codex.id }, model = codex) {
  const reports = [];
  let hook;
  const { createFastModeExtension } = await import(moduleUrl);
  createFastModeExtension({ ...options, onRequest: (request) => reports.push(request) })({ on: (_name, fn) => { hook = fn; } });
  const result = await hook({ payload }, { model });
  assert.equal(reports.length, 1);
  return { report: reports[0], result };
}

test('hook reports injection, authoritative rejection, disabled and out-of-scope separately', async () => {
  const accepted = await observe({ enabled: true, resolveSupport: async () => ({ supported: true, source: 'catalog' }) });
  assert.equal(accepted.result.service_tier, 'priority');
  assert.deepEqual(accepted.report, { status: 'requested', supportSource: 'catalog', serviceTierRequested: 'priority' });
  for (const [options, model, status, source] of [
    [{ enabled: false }, codex, 'disabled', null],
    [{ enabled: true }, { ...codex, provider: 'relay' }, 'out_of_scope', 'out_of_scope'],
    [{ enabled: true, resolveSupport: async () => ({ supported: false, source: 'catalog' }) }, codex, 'unsupported', 'catalog'],
    [{ enabled: true, resolveSupport: async () => ({ supported: false, source: 'account_changed' }) }, codex, 'unsupported', 'account_changed'],
  ]) {
    const { report, result } = await observe(options, { model: codex.id }, model);
    assert.equal(result, undefined);
    assert.deepEqual(report, { status, supportSource: source, serviceTierRequested: null });
  }
});

test('resolver/payload exceptions report a safe error, never claim a priority request or leak content', async () => {
  const sensitive = 'private-auth-and-body-sentinel';
  for (const options of [
    { enabled: true, resolveSupport: async () => { throw new Error(sensitive); } },
    { enabled: true, resolveSupport: async () => ({ supported: true, source: sensitive }), payload: null },
  ]) {
    const { report, result } = await observe(options, Object.hasOwn(options, 'payload') ? options.payload : { input: sensitive });
    assert.equal(result, undefined);
    assert.equal(report.status, 'error');
    assert.equal(report.serviceTierRequested, null);
    assert.equal(JSON.stringify(report).includes(sensitive), false);
  }
  let hook;
  const { createFastModeExtension } = await import(moduleUrl);
  createFastModeExtension({ enabled: true, resolveSupport: async () => ({ supported: true, source: 'allowlist' }),
    onRequest: () => { throw new Error(sensitive); },
  })({ on: (_name, fn) => { hook = fn; } });
  assert.equal((await hook({ payload: {} }, { model: codex })).service_tier, 'priority', 'diagnostic callback failure must not undo injection');
});

test('bounded round summary counts hook decisions, never infers execution or copies arbitrary values', () => {
  const telemetry = require('../../build/lib/service-tier');
  const state = telemetry.createServiceTierState(true);
  assert.equal(telemetry.snapshotServiceTier(state).requestCount, 0);
  assert.equal(telemetry.snapshotServiceTier(state).serviceTierRequested, null);
  for (let i = 0; i < 100; i += 1) telemetry.recordServiceTierRequest(state, { status: 'requested', supportSource: 'catalog', serviceTierRequested: 'priority', accountId: 'private' });
  telemetry.recordServiceTierRequest(state, { status: 'unsupported', supportSource: 'catalog', serviceTierRequested: 'priority' });
  telemetry.recordServiceTierRequest(state, { status: 'error', supportSource: 'evil-value', body: 'private', serviceTierObserved: 'priority' });
  assert.equal(telemetry.recordServiceTierRequest(state, { status: 'invalid', payload: 'private' }), null);
  const summary = telemetry.snapshotServiceTier(state);
  assert.equal(summary.configured, true);
  assert.equal(summary.requestCount, 102);
  assert.equal(summary.priorityRequestCount, 100);
  assert.equal(summary.skippedRequestCount, 2);
  assert.equal(summary.errorCount, 1);
  assert.equal(summary.serviceTierRequested, 'priority');
  assert.equal(summary.serviceTierObserved, null);
  assert.equal(summary.executionConfirmed, false);
  assert.deepEqual(summary.supportSources, ['catalog']);
  assert.equal(JSON.stringify(summary).includes('private'), false);
  assert.equal(JSON.stringify(summary).includes('evil-value'), false);
  assert.ok(JSON.stringify(summary).length < 1000);
  summary.supportSources.push('mutation');
  assert.deepEqual(telemetry.snapshotServiceTier(state).supportSources, ['catalog']);
});

test('summary projection rejects invalid counters, strips arbitrary evidence and marks partial requests', () => {
  const { createServiceTierState, recordServiceTierRequest, snapshotServiceTier, normalizeServiceTierSummary } = require('../../build/lib/service-tier');
  const state = createServiceTierState(true);
  recordServiceTierRequest(state, { status: 'requested', serviceTierRequested: 'priority', supportSource: 'allowlist' });
  recordServiceTierRequest(state, { status: 'error' });
  const value = snapshotServiceTier(state);
  assert.match(value.label, /部分请求.*执行未确认/u);
  const projected = normalizeServiceTierSummary({ ...value, label: 'executed-priority-private', serviceTierObserved: 'priority', executionConfirmed: true, payload: 'private', supportSources: ['catalog', 'private'] });
  assert.equal(projected.executionConfirmed, false);
  assert.equal(projected.serviceTierObserved, null);
  assert.deepEqual(projected.supportSources, ['catalog']);
  assert.equal(JSON.stringify(projected).includes('private'), false);
  assert.equal(normalizeServiceTierSummary({ ...value, priorityRequestCount: -1 }), null);
  assert.equal(normalizeServiceTierSummary({ ...value, errorCount: 50 }), null);
  assert.equal(normalizeServiceTierSummary({ ...value, configured: 'true' }), null);
  assert.equal(normalizeServiceTierSummary(null), null);
});

test('model usage and live timeline preserve per-call request evidence without inferring from cost', () => {
  const telemetry = require('../../build/lib/service-tier');
  const serviceTier = { status: 'requested', supportSource: 'allowlist', serviceTierRequested: 'priority' };
  const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { total: 0.4 } };
  const summary = summarizeModelUsageCalls([{ key: 'a', usage, serviceTier }, { key: 'b', usage }]);
  assert.deepEqual(summary.calls[0].serviceTier, telemetry.normalizeServiceTierRequest(serviceTier));
  assert.equal(summary.calls[1].serviceTier, null, 'legacy calls have unknown tier, not Fast off');
  const state = createObservabilityTimelineState();
  const event = createModelCallObservabilityEvent(state, { tokenUsage: summary.calls[0].tokenUsage, serviceTier });
  assert.deepEqual(event.serviceTier, summary.calls[0].serviceTier);
  assert.equal(event.serviceTier.serviceTierObserved, null);
  assert.equal(event.serviceTier.executionConfirmed, false);
});
