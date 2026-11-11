// Actual host Codex transport with owned synthetic auth and injected provider.
// No live network, container, proxy, credential discovery or refresh.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), zlib = require('node:zlib');
const api = () => require('../../scripts/badcase-capture/wiki-precheck-trace-transport.cjs');
const { createPrecheckBudget, precheckApprovalHash } = require('../../scripts/badcase-capture/wiki-precheck-budget.cjs');
const { createCodexTransport, PROFILE } = require('../../scripts/badcase-capture/codex-transport.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function sse(u = { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 7 } }) {
  return Buffer.from('data: ' + JSON.stringify({ type: 'response.created', response: { id: 'synthetic', status: 'in_progress' } }) + '\n\n'
    + 'data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'synthetic', status: 'completed', usage: u, output: [] } }) + '\n\n');
}
function setup(t, { maxRequests = 5, response = sse(), status = 200, send, append } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-trace-budget-')), dir = path.join(root, '.pi-sandbox'); fs.mkdirSync(dir);
  const access = 'test.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url') + '.synthetic';
  const authFile = path.join(dir, 'auth.json'), auth = JSON.stringify({ 'openai-codex': { type: 'oauth', access, expires: Date.now() + 3600000, refresh: 'SYNTHETIC-DO-NOT-USE' } }); fs.writeFileSync(authFile, auth);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [], counters = { sends: 0, closed: 0 }, approval = { planHash: 'a'.repeat(64), stopFile: path.join(root, 'STOP'),
    limits: { maxRequests, maxInputTokens: 10000, maxOutputTokens: 10000, maxTotalTokens: 20000, maxDurationMs: 10000 } };
  const budget = createPrecheckBudget({ ...approval, confirmed: true, approvalHash: precheckApprovalHash(approval) }, { onEvent: e => events.push(e) }); t.after(() => budget.close());
  const transport = api().createBudgetedTraceTransport({ authFile, confirmed: true, timeoutMs: 1000 }, {}, { budget, knownValues: ['synthetic-known-private-value'],
    append: e => { events.push(structuredClone(e)); append?.(e); }, createTransport: (config, guards) => createCodexTransport(config, { ...guards,
      createDispatcher: uri => { assert.equal(uri, PROFILE.proxy); return { destroy: async () => counters.closed++ }; },
      fetch: async (url, options) => { counters.sends++; assert.equal(url, PROFILE.endpoint); assert.equal(options.headers.get('authorization'), 'Bearer ' + access);
        assert.equal(events.at(-1).event, 'trace_request'); return send ? send(options) : new Response(response, { status, headers: { 'content-type': 'text/event-stream' } }); },
    }),
  }); t.after(() => transport.close());
  const q = () => ({ method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ model: 'gpt-6.1-sol', stream: true, store: false, input: [], reasoning: { effort: 'xhigh' } }) });
  transport.inspectAccess(value => assert.equal(value, access));
  return { root, access, auth, authFile, transport, budget, events, counters, q };
}

test('trace requests use the shared budget, preserve wire bytes and retain content-free auth boundaries', async t => {
  const h = setup(t), q = h.q(), response = await h.transport.fetch(PROFILE.endpoint, q);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), sse()); assert.equal(h.counters.sends, 1);
  assert.deepEqual(h.budget.snapshot().knownUsage, { input: 3, output: 2, cacheRead: 7, cacheWrite: 0, totalTokens: 12 });
  assert.deepEqual(h.events.map(e => e.event), ['request_reserved', 'trace_request', 'trace_response', 'request_finished']);
  const request = h.events.find(e => e.event === 'trace_request'), result = h.events.find(e => e.event === 'trace_response');
  assert.equal(Buffer.from(request.bodyBase64, 'base64').toString(), q.body); assert.equal(request.bodyHash, hash(q.body));
  assert.equal(result.bodyHash, hash(sse())); assert.deepEqual(Buffer.from(result.bodyBase64, 'base64'), sse());
  assert.equal(JSON.stringify(h.events).includes(h.access), false); assert.equal(JSON.stringify(h.events).includes('authorization'), false);
  assert.equal(JSON.stringify(h.events).includes('synthetic-account'), false); assert.equal(fs.readFileSync(h.authFile, 'utf8'), h.auth);
  assert.equal(h.transport.state().requests, 1); h.transport.beginAttempt(); await h.transport.close(); assert.equal(h.counters.closed, 1);
});
test('zstd request bytes are retained unchanged, with a separately parsed payload and no replay execution', async t => {
  const h = setup(t), q = h.q(), plain = Buffer.from(q.body); q.body = zlib.zstdCompressSync(plain); q.headers['content-encoding'] = 'zstd';
  await h.transport.fetch(PROFILE.endpoint, q);
  const saved = h.events.find(e => e.event === 'trace_request');
  assert.deepEqual(Buffer.from(saved.bodyBase64, 'base64'), q.body); assert.deepEqual(saved.payload, JSON.parse(plain)); assert.equal(saved.bodyHash, hash(q.body));
});
test('missing, conflicting, duplicated or invalid terminal usage stops after one provider exchange', async t => {
  const samples = [Buffer.from('data: [DONE]\n\n'), sse(null), Buffer.concat([sse(), sse()]), sse({ input_tokens: 1, output_tokens: 2, total_tokens: 99 }),
    sse({ input_tokens: 3, output_tokens: 2, total_tokens: 5, input_tokens_details: { cached_tokens: 4 } })];
  for (const response of samples) {
    const h = setup(t, { response }); await h.transport.fetch(PROFILE.endpoint, h.q());
    assert.equal(h.budget.snapshot().reason, 'usage_unknown'); assert.equal(h.budget.snapshot().unknownRequests, 1);
    await assert.rejects(h.transport.fetch(PROFILE.endpoint, h.q()), /wiki_precheck_stopped/); assert.equal(h.counters.sends, 1);
    assert.ok(h.events.some(e => e.event === 'trace_response'), 'raw bytes survive even when usage is unknown');
  }
});
test('a request cap allows the last complete response to reach the worker but refuses any next request', async t => {
  const h = setup(t, { maxRequests: 1 }), r = await h.transport.fetch(PROFILE.endpoint, h.q());
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), sse()); assert.equal(h.budget.signal.aborted, false);
  await assert.rejects(h.transport.fetch(PROFILE.endpoint, h.q()), /wiki_precheck_stopped/); assert.equal(h.counters.sends, 1); assert.equal(h.budget.signal.aborted, true);
});
test('request inventory/current access and output access never enter retained trace records', async t => {
  const h = setup(t), q = h.q(); q.body = q.body.replace('"input":[]', '"input":["synthetic-known-private-value"]');
  await assert.rejects(h.transport.fetch(PROFILE.endpoint, q), /wiki_precheck_exchange_failed/); assert.equal(h.counters.sends, 0);
  assert.equal(JSON.stringify(h.events).includes('synthetic-known-private-value'), false);
  const active = setup(t), raw = active.q(); raw.body = raw.body.replace('"input":[]', '"input":[' + JSON.stringify(active.access) + ']');
  await assert.rejects(active.transport.fetch(PROFILE.endpoint, raw), /wiki_precheck_exchange_failed/); assert.equal(active.counters.sends, 0); assert.equal(JSON.stringify(active.events).includes(active.access), false);
  const leaking = setup(t, { send: () => new Response('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: leaking.access }) + '\n\n') });
  await assert.rejects(leaking.transport.fetch(PROFILE.endpoint, leaking.q()), /wiki_precheck_exchange_failed/);
  assert.equal(leaking.counters.sends, 1); assert.equal(JSON.stringify(leaking.events).includes(leaking.access), false);
});
test('retention failure stops before provider or before another exchange, with unknown usage never zeroed', async t => {
  for (const event of ['trace_request', 'trace_response']) {
    const h = setup(t, { append: e => { if (e.event === event) throw Error('PRIVATE-WRITE-ERROR'); } });
    await assert.rejects(h.transport.fetch(PROFILE.endpoint, h.q()), /wiki_precheck_exchange_failed/);
    assert.equal(h.counters.sends, event === 'trace_request' ? 0 : 1); assert.equal(h.budget.snapshot().usageComplete, false);
    await assert.rejects(h.transport.fetch(PROFILE.endpoint, h.q()), /wiki_precheck_stopped/);
  }
});
test('STOP/Ctrl+C cancellation reaches an in-flight actual host transport; no automatic resend', async t => {
  let observed, ready;
  const started = new Promise(resolve => ready = resolve), h = setup(t, { send: options => { observed = options.signal; ready(); return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('PRIVATE-UPSTREAM')))); } });
  const pending = h.transport.fetch(PROFILE.endpoint, h.q()); pending.catch(() => {}); await started;
  process.emit('SIGINT'); assert.equal(observed.aborted, true); await assert.rejects(pending, /wiki_precheck_exchange_failed/);
  assert.equal(h.budget.snapshot().reason, 'operator_interrupted'); assert.equal(h.counters.sends, 1); assert.equal(h.budget.snapshot().usageComplete, false);
  assert.equal(JSON.stringify(h.events).includes('PRIVATE-UPSTREAM'), false);
});
