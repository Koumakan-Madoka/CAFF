// Offline tests only: fake exchanges, synthetic usage and an owned STOP path.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const api = () => require('../../scripts/badcase-capture/wiki-precheck-budget.cjs');
const PLAN = 'a'.repeat(64);
const limits = () => ({ maxRequests: 5, maxInputTokens: 100, maxOutputTokens: 20, maxTotalTokens: 120, maxDurationMs: 1000 });
const usage = (input = 10, output = 2) => ({ input, output, cacheRead: 1, cacheWrite: 0, totalTokens: input + output + 1 });
function setup(t, overrides = {}, dependencies = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-precheck-budget-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { planHash: PLAN, limits: limits(), stopFile: path.join(root, 'STOP'), ...overrides };
  const events = new EventEmitter(), timers = new Set(); let now = 0;
  const deps = { events, now: () => now, setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn), ...dependencies };
  config.approvalHash ??= api().precheckApprovalHash(config);
  config.confirmed ??= true;
  const guard = api().createPrecheckBudget(config, deps); t.after(() => guard.close());
  return { guard, config, events, timers, advance(ms) { now += ms; for (const fn of [...timers]) fn(); } };
}
function request(guard, kind = 'worker', u = usage()) {
  return guard.request(kind, async signal => { assert.equal(signal.aborted, false); return { usage: u, syntheticOutput: 'output' }; }, result => result.usage);
}

test('precheck quota confirmation binds plan, all stop lines and STOP path before any request or listener', t => {
  for (const change of [c => c.confirmed = false, c => c.approvalHash = 'b'.repeat(64), c => c.planHash = 'c'.repeat(64),
    c => c.limits.maxRequests++, c => c.limits.maxInputTokens++, c => c.limits.maxOutputTokens++, c => c.limits.maxTotalTokens++,
    c => c.limits.maxDurationMs++, c => c.stopFile += '-different']) {
    const events = new EventEmitter(), c = { planHash: PLAN, limits: limits(), stopFile: path.resolve('synthetic-STOP'), confirmed: true };
    c.approvalHash = api().precheckApprovalHash(c); change(c);
    assert.throws(() => api().createPrecheckBudget(c, { events }), /wiki_precheck_confirmation_required/);
    assert.equal(events.listenerCount('SIGINT'), 0);
  }
});
test('approval and limits are closed, finite and bounded; candidate or credentials are not a config channel', () => {
  for (const delta of [{ maxRequests: 0 }, { maxRequests: 4097 }, { maxRequests: 1.5 }, { maxInputTokens: Infinity },
    { maxOutputTokens: -1 }, { maxTotalTokens: Number.MAX_SAFE_INTEGER + 1 }, { maxDurationMs: 0 }, { maxDurationMs: 10800001 }, { retries: 1 }]) {
    assert.throws(() => api().precheckApprovalHash({ planHash: PLAN, limits: { ...limits(), ...delta }, stopFile: path.resolve('STOP') }), /wiki_precheck_budget_invalid/);
  }
  for (const extra of [{ candidateId: 'candidate' }, { key: 'synthetic-private' }]) {
    assert.throws(() => api().createPrecheckBudget({ planHash: PLAN, limits: limits(), stopFile: path.resolve('STOP'), confirmed: true, approvalHash: PLAN, ...extra }), /wiki_precheck_budget_invalid/);
  }
});
test('worker and judge consume the same request cap and tokens; returned snapshots cannot mutate counters', async t => {
  const { guard } = setup(t, { limits: { ...limits(), maxRequests: 2 } });
  await request(guard); await request(guard, 'judge');
  const state = guard.snapshot(); assert.equal(state.requests, 2); assert.equal(state.workerRequests, 1); assert.equal(state.judgeRequests, 1);
  assert.equal(state.knownUsage.totalTokens, 26); assert.equal(state.knownUsage.input, 20); assert.equal(state.knownUsage.cacheRead, 2);
  state.knownUsage.input = 0; state.requests = 0;
  let sends = 0;
  await assert.rejects(guard.request('worker', async () => { sends++; }, () => usage()), /wiki_precheck_stopped/);
  assert.equal(sends, 0); assert.equal(guard.snapshot().reason, 'request_limit'); assert.equal(guard.snapshot().requests, 2);
  assert.equal(guard.snapshot().usageComplete, true);
});
test('reaching the request cap does not abort delivery of an already completed last response', async t => {
  const { guard, advance } = setup(t, { limits: { ...limits(), maxRequests: 1 } }); await request(guard);
  assert.equal(guard.signal.aborted, false); advance(100); assert.equal(guard.signal.aborted, false, 'polling must not kill the worker delivering its final response');
  assert.equal(guard.snapshot().usageComplete, true);
  assert.equal(guard.check(), false); assert.equal(guard.snapshot().reason, 'request_limit'); assert.equal(guard.signal.aborted, true);
});
test('each token stop line includes reported cache and stops at equality before another request', async t => {
  for (const [field, u] of [['maxInputTokens', { input: 1, output: 0, cacheRead: 99, cacheWrite: 0, totalTokens: 100 }],
    ['maxOutputTokens', usage(1, 20)], ['maxTotalTokens', usage(117, 2)]]) {
    const { guard } = setup(t, { limits: { ...limits(), ...(field === 'maxTotalTokens' ? { maxInputTokens: 1000 } : {}) } });
    await request(guard, 'worker', u);
    assert.equal(guard.snapshot().reason, { maxInputTokens: 'input_token_limit', maxOutputTokens: 'output_token_limit', maxTotalTokens: 'total_token_limit' }[field]);
    await assert.rejects(request(guard, 'judge'), /wiki_precheck_stopped/);
    assert.equal(guard.snapshot().requests, 1);
  }
});
test('unknown, partial, inconsistent or overflowing usage stops; never substitutes zero or retries', async t => {
  for (const u of [null, {}, { input: 1, output: 2, totalTokens: 3 }, { ...usage(), input: -1 }, { ...usage(), output: NaN },
    { ...usage(), totalTokens: 1 }, { input: Number.MAX_SAFE_INTEGER, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: Number.MAX_SAFE_INTEGER }]) {
    const { guard } = setup(t); await request(guard, 'worker', u);
    assert.equal(guard.snapshot().reason, 'usage_unknown'); assert.equal(guard.snapshot().usageComplete, false);
    assert.equal(guard.snapshot().requests, 1); assert.equal(guard.snapshot().unknownRequests, 1);
    await assert.rejects(request(guard), /wiki_precheck_stopped/);
  }
});
test('throwing or malformed exchanges retain an unknown request and expose no upstream prose', async t => {
  for (const badMeasure of [false, true]) {
    const records = [], { guard } = setup(t, {}, { onEvent: e => records.push(e) }); let sends = 0;
    await assert.rejects(guard.request('worker', async () => { sends++; if (!badMeasure) throw Error('synthetic-private-upstream'); return {}; }, () => { throw Error('synthetic-private-measure'); }), e => {
      assert.equal(e.code, 'wiki_precheck_exchange_failed'); assert.equal(e.message.includes('synthetic-private'), false); return true;
    });
    assert.equal(sends, 1); assert.equal(guard.snapshot().reason, 'usage_unknown'); assert.equal(guard.snapshot().unknownRequests, 1);
    assert.equal(JSON.stringify(guard.snapshot()).includes('synthetic-private'), false);
    assert.equal(records[1]?.event, 'request_finished'); assert.equal(records[1].status, 'unknown'); assert.equal(records[1].usage, null);
  }
});
test('no concurrency or unknown exchange kind can spend another request', async t => {
  const { guard } = setup(t); let resolve, sends = 0;
  const pending = guard.request('worker', async () => { sends++; return await new Promise(r => resolve = r); }, r => r.usage);
  await assert.rejects(request(guard, 'judge'), /wiki_precheck_request_busy/);
  await assert.rejects(request(guard, 'candidate'), /wiki_precheck_budget_invalid/);
  assert.equal(guard.snapshot().requests, 1); resolve({ usage: usage() }); await pending;
  assert.equal(sends, 1);
});
test('pre-existing STOP, mid-request STOP and unreadable STOP checks fail closed', async t => {
  const pre = setup(t); fs.writeFileSync(pre.config.stopFile, 'STOP');
  await assert.rejects(request(pre.guard), /wiki_precheck_stopped/); assert.equal(pre.guard.snapshot().requests, 0);
  const mid = setup(t); let resolve, observed = false;
  const pending = mid.guard.request('worker', signal => new Promise(r => { resolve = r; signal.addEventListener('abort', () => { observed = true; }); }), r => r.usage);
  fs.writeFileSync(mid.config.stopFile, 'STOP'); mid.advance(1); assert.equal(observed, true);
  // Cancellation is not proof that upstream spent zero. Await settlement and
  // preserve the returned usage; never race/publish while still in flight.
  assert.equal(mid.guard.snapshot().inFlight, true); resolve({ usage: usage() }); await pending;
  assert.equal(mid.guard.snapshot().reason, 'operator_stop'); assert.equal(mid.guard.snapshot().usageComplete, true);
  await assert.rejects(request(mid.guard), /wiki_precheck_stopped/);
  const denied = setup(t, {}, { stat: () => { throw Object.assign(Error('private-path'), { code: 'EACCES' }); } });
  await assert.rejects(request(denied.guard), /wiki_precheck_stopped/); assert.equal(denied.guard.snapshot().reason, 'stop_check_failed');
});
test('Ctrl+C aborts pending work, blocks all subsequent sends and removes only its listeners', async t => {
  const { guard, events, timers } = setup(t); const foreign = () => {}; events.on('SIGINT', foreign);
  let seen = false;
  const pending = guard.request('worker', signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => { seen = true; reject(Error('cancelled')); })), r => r.usage);
  events.emit('SIGINT'); assert.equal(seen, true);
  await assert.rejects(pending, /wiki_precheck_exchange_failed/);
  assert.equal(guard.snapshot().reason, 'operator_interrupted'); assert.equal(guard.snapshot().usageComplete, false);
  await assert.rejects(request(guard, 'judge'), /wiki_precheck_stopped/);
  guard.close(); guard.close(); assert.equal(events.listenerCount('SIGINT'), 1); assert.equal(timers.size, 0);
});
test('whole-batch deadline aborts a pending exchange; elapsed checks also run synchronously before sending', async t => {
  const h = setup(t); h.advance(1000);
  await assert.rejects(request(h.guard), /wiki_precheck_stopped/); assert.equal(h.guard.snapshot().reason, 'time_limit');
  const mid = setup(t); let seen = false;
  const pending = mid.guard.request('worker', signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => { seen = true; reject(Error('cancelled')); })), r => r.usage);
  mid.advance(1000); assert.equal(seen, true); await assert.rejects(pending, /wiki_precheck_exchange_failed/);
  assert.equal(mid.guard.snapshot().reason, 'time_limit');
});
test('per-request evidence is emitted before send and after usage, without raw reply or auth', async t => {
  const records = [], h = setup(t, {}, { onEvent: event => { records.push(structuredClone(event)); event.index = 999; } });
  await h.guard.request('worker', async () => {
    assert.equal(records.length, 1); assert.equal(records[0].event, 'request_reserved');
    assert.equal(records[0].approvalHash, h.config.approvalHash);
    return { usage: usage(), syntheticPrivateReply: 'private-output-not-in-budget-events' };
  }, r => r.usage);
  assert.equal(records.length, 2); assert.equal(records[1].event, 'request_finished'); assert.equal(records[1].index, 1);
  assert.equal(records[1].status, 'known'); assert.deepEqual(records[1].usage, usage());
  assert.equal(JSON.stringify(records).includes('private-output'), false);
  assert.equal(h.guard.snapshot().exchanges[0].index, 1);
});
test('evidence write failures stop before sending or before any subsequent send', async t => {
  for (const failedEvent of ['request_reserved', 'request_finished']) {
    let sends = 0;
    const h = setup(t, {}, { onEvent: event => { if (event.event === failedEvent) throw Error('synthetic-private-disk-error'); } });
    await assert.rejects(h.guard.request('worker', async () => { sends++; return { usage: usage() }; }, r => r.usage), /wiki_precheck_exchange_failed/);
    assert.equal(sends, failedEvent === 'request_reserved' ? 0 : 1);
    assert.equal(h.guard.snapshot().reason, 'evidence_write_failed');
    assert.equal(h.guard.snapshot().usageComplete, failedEvent === 'request_finished');
    await assert.rejects(request(h.guard), /wiki_precheck_stopped/);
  }
});
test('STOP raised by the evidence writer cannot slip through to the network send', async t => {
  let h, sends = 0;
  h = setup(t, {}, { onEvent: e => { if (e.event === 'request_reserved') fs.writeFileSync(h.config.stopFile, 'STOP'); } });
  await assert.rejects(h.guard.request('worker', async () => { sends++; return { usage: usage() }; }, r => r.usage), /wiki_precheck_exchange_failed/);
  assert.equal(sends, 0); assert.equal(h.guard.snapshot().reason, 'operator_stop');
});
test('the default timer aborts an exchange without fake scheduling or any real network', { timeout: 3000 }, async t => {
  const config = { planHash: PLAN, limits: { ...limits(), maxDurationMs: 100 }, stopFile: path.resolve('synthetic-absent-STOP-' + require('node:crypto').randomUUID()) };
  const guard = api().createPrecheckBudget({ ...config, confirmed: true, approvalHash: api().precheckApprovalHash(config) });
  t.after(() => guard.close());
  // Keep the test alive; the production poll timer is deliberately unref'd.
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  await assert.rejects(guard.request('worker', signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')))), r => r.usage), /wiki_precheck_exchange_failed/);
  assert.equal(guard.snapshot().reason, 'time_limit'); assert.equal(guard.snapshot().unknownRequests, 1);
});
test('closed controllers never send; invalid callback shapes do not consume a slot', async t => {
  const { guard } = setup(t);
  await assert.rejects(guard.request('worker', null, () => usage()), /wiki_precheck_budget_invalid/);
  assert.equal(guard.snapshot().requests, 0); guard.close();
  await assert.rejects(request(guard), /wiki_precheck_stopped/); assert.equal(guard.snapshot().reason, 'closed');
});
