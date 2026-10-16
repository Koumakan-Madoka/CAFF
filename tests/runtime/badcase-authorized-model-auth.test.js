const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { chatCompletionsSettings, encodeChatCompletionsRequest, createChatCompletionsTransport } = require('../../build/server/domain/runtime/badcase-capture/chat-completions-protocol');
const { dispatchModelEgress, readModelEgress } = require('../../build/server/domain/runtime/badcase-capture/model-egress');
const { httpsExchangeEndpoint } = require('../../build/server/domain/runtime/badcase-capture/https-exchange');
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const settings = () => ({ provider: 'Huawei-Huoshan', model: 'zhipu/glm-5.3', contextWindowTokens: 1000, maxOutputTokens: 100,
  temperature: 0, inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 1, maxRequestBytes: 4096, maxResponseBytes: 4096 });
const endpoint = () => ({ hostname: 'api.example.com', address: '93.184.216.34', path: '/v1/chat/completions',
  maxRequestBytes: 4096, maxResponseBytes: 4096, timeoutMs: 1000 });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-auth-reuse-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'models.json'), key = 'synthetic-inert-value';
  const provider = { api: 'openai-completions', baseUrl: 'https://api.example.com/v1', apiKey: key,
    models: [{ id: 'zhipu/glm-5.3' }] };
  const write = p => fs.writeFileSync(file, JSON.stringify({ providers: { 'Huawei-Huoshan': p, unrelated: { apiKey: 'DO-NOT-SELECT' } } }));
  write(provider);
  const options = { file, provider: 'Huawei-Huoshan', model: 'zhipu/glm-5.3', endpoint: endpoint(), confirmedNonProduction: true };
  const create = o => require('../../scripts/badcase-capture/authorized-model-auth.cjs').createAuthorizedModelCredential(o || options);
  return { root, file, key, provider, options, write, create, endpointHash: httpsExchangeEndpoint(endpoint()).endpointHash };
}
test('namespaced GLM model is preserved through protocol and durable request ledger', async t => {
  const f = fixture(t), s = chatCompletionsSettings(settings());
  const body = encodeChatCompletionsRequest(settings(), [{ role: 'user', content: 'synthetic' }]);
  assert.equal(JSON.parse(body).model, 'zhipu/glm-5.3');
  const policy = { approvalId: 'test', planHash: hash('plan'), runId: hash('run'), provider: 'Huawei-Huoshan', model: 'zhipu/glm-5.3',
    settingsHash: s.settingsHash, expiresAt: Date.now() + 5000, maxRequests: 1, maxRequestBytes: 4096, maxResponseBytes: 4096,
    timeoutMs: 1000, perRequestReserveMicroUsd: s.perRequestReserveMicroUsd, runLimitMicroUsd: 10 };
  const report = await dispatchModelEgress(f.root, policy, async send => { await send(body); }, async request => {
    assert.equal(request.model, 'zhipu/glm-5.3'); return { body: Buffer.from('ok'), costMicroUsd: 1 };
  });
  assert.equal(report.reason, 'completed'); assert.equal(readModelEgress(f.root, policy.runId).policy.model, 'zhipu/glm-5.3');
});
test('namespace support does not relax provider, approval or unsafe model identifiers', () => {
  for (const model of ['../glm', 'zhipu/../glm', 'zhipu//glm', '/glm', 'zhipu/glm/', 'https://host/model', 'zhipu/glm?key=x', 'zhipu/ glm', 'a/'.repeat(65)])
    assert.throws(() => chatCompletionsSettings({ ...settings(), model }));
  assert.throws(() => chatCompletionsSettings({ ...settings(), provider: 'vendor/provider' }));
});
test('namespaced model responses still require the exact approved wire name', async () => {
  const s = chatCompletionsSettings(settings()), b = encodeChatCompletionsRequest(settings(), [{ role: 'user', content: 'x' }]);
  const request = { requestId: hash('request'), provider: s.settings.provider, model: s.settings.model, settingsHash: s.settingsHash, body: b, signal: new AbortController().signal };
  const response = { id: 'reply', object: 'chat.completion', created: 1, model: s.settings.model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
  const exchange = () => Promise.resolve({ status: 200, chunks: (async function* () { yield Buffer.from(JSON.stringify(response)); })() });
  assert.equal((await createChatCompletionsTransport(settings(), exchange)(request)).costMicroUsd, 2);
  response.model = 'glm-5.3'; await assert.rejects(createChatCompletionsTransport(settings(), exchange)(request));
});
test('explicit nonproduction source is lazy, endpoint-bound and never exposes the key in its declaration', t => {
  const f = fixture(t), source = f.create();
  assert.equal(JSON.stringify(source).includes(f.key), false); assert.equal(Object.hasOwn(source.declaration, 'file'), false);
  assert.equal(source.declaration.provider, 'Huawei-Huoshan'); assert.equal(source.declaration.model, 'zhipu/glm-5.3');
  assert.throws(() => source.credential(hash('wrong-endpoint')), /model_auth_reuse_failed/);
  const lease = source.credential(f.endpointHash); assert.equal(lease.value, f.key); assert.ok(lease.expiresAt > Date.now());
  assert.equal(fs.readFileSync(f.file, 'utf8'), JSON.stringify({ providers: { 'Huawei-Huoshan': f.provider, unrelated: { apiKey: 'DO-NOT-SELECT' } } }));
});
test('reuse is opt-in, never consults default CAFF source or generic environment, and fails with fixed errors', t => {
  const f = fixture(t);
  for (const patch of [{ confirmedNonProduction: false }, { confirmedNonProduction: undefined }, { file: 'relative.json' }, { extra: true }])
    assert.throws(() => f.create({ ...f.options, ...patch }), /^Error: model_auth_reuse_failed$/);
  const source = f.create({ ...f.options, file: path.join(f.root, 'missing') }); // no read on prepare
  assert.throws(() => source.credential(f.endpointHash), /^Error: model_auth_reuse_failed$/);
});
test('reuse rejects wrong model/endpoint/protocol, custom auth and command/env/OAuth modes', t => {
  const f = fixture(t);
  for (const patch of [
    { models: [{ id: 'other' }] }, { baseUrl: 'https://different.example.com/v1' }, { baseUrl: 'https://api.example.com/other' },
    { baseUrl: 'https://api.example.com/v1?key=PRIVATE' }, { baseUrl: 'https://user:PRIVATE@api.example.com/v1' },
    { api: 'anthropic-messages' }, { apiKey: '$MODEL_KEY' }, { apiKey: '!echo PRIVATE' }, { apiKey: { type: 'oauth', access: 'PRIVATE' } },
    { headers: { Authorization: 'PRIVATE' } }, { models: [{ id: 'zhipu/glm-5.3', headers: { 'x-key': 'PRIVATE' } }] },
    { models: [{ id: 'zhipu/glm-5.3' }, { id: 'zhipu/glm-5.3' }] },
  ]) { f.write({ ...f.provider, ...patch }); assert.throws(() => f.create().credential(f.endpointHash), /^Error: model_auth_reuse_failed$/); }
});
test('accepted source is reread per lease and any later byte change fails closed', t => {
  const f = fixture(t), source = f.create(); assert.equal(source.credential(f.endpointHash).value, f.key);
  f.write({ ...f.provider, apiKey: 'synthetic-changed' });
  assert.throws(() => source.credential(f.endpointHash), /^Error: model_auth_reuse_failed$/);
});
test('source file is bounded, strict UTF-8, regular and not a symlink', t => {
  const f = fixture(t);
  for (const bytes of [Buffer.alloc(1048577, 32), Buffer.from([0xff]), Buffer.from('{invalid-json')]) {
    fs.writeFileSync(f.file, bytes); assert.throws(() => f.create().credential(f.endpointHash), /^Error: model_auth_reuse_failed$/);
  }
  f.write(f.provider); const link = path.join(f.root, 'link.json');
  try { fs.symlinkSync(f.file, link); } catch (e) { if (e.code === 'EPERM') { t.diagnostic('symlink denied by Windows permissions'); return; } throw e; }
  assert.throws(() => f.create({ ...f.options, file: link }).credential(f.endpointHash), /^Error: model_auth_reuse_failed$/);
});
