const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { readEvaluationKey, readCaffDeepseekKey, modelProfile, directModelRouting, observeDirectFetch, validateDirectBindings, bindDirectPrompt, ENDPOINT, MODEL, KEY_ENV } = require('../../scripts/badcase-capture/direct-model.cjs');
const key = 'test-only-direct-evaluation-key-123456';
test('explicit env/file key; one terminal newline allowed; descriptor contains reference only', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-key-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'input.key'); fs.writeFileSync(file, key + '\r\n');
  assert.equal(readEvaluationKey({ CAFF_BADCASE_MODEL_KEY_FILE: file, [KEY_ENV]: 'ignored-ambient' }), key);
  assert.equal(readEvaluationKey({ [KEY_ENV]: key }), key);
  assert.throws(() => readEvaluationKey({}), /^Error: evaluation_key_missing$/);
  const routing = directModelRouting(); assert.equal(routing.providers['opencode-go'].baseUrl, ENDPOINT);
  assert.equal(routing.providers['opencode-go'].apiKey, '$' + KEY_ENV);
  assert.equal(routing.providers['opencode-go'].models[0].id, MODEL);
  assert.equal(JSON.stringify(routing).includes(key), false);
  assert.throws(() => directModelRouting('https://other.example/v1'), /endpoint_invalid/);
});
test('explicit CAFF DeepSeek source reads only the matching official provider, never executes commands or falls back', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-caff-key-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'models.json');
  const config = { providers: { deepseek: { baseUrl: 'https://api.deepseek.com', api: 'openai-completions', apiKey: key, models: [{ id: 'deepseek-v4-flash' }] }, other: { apiKey: 'unrelated-private-value' } } };
  const save = () => fs.writeFileSync(file, JSON.stringify(config)); save(); const before = fs.readFileSync(file);
  assert.equal(readCaffDeepseekKey({ PI_CODING_AGENT_DIR: root }), key); assert.deepEqual(fs.readFileSync(file), before);
  config.providers.deepseek.apiKey = '$DEEPSEEK_TEST_KEY'; save();
  assert.equal(readCaffDeepseekKey({ PI_CODING_AGENT_DIR: root, DEEPSEEK_TEST_KEY: key }), key);
  for (const patch of [{ apiKey: '!echo private' }, { baseUrl: 'https://other.example' }, { models: [] }, { api: 'other-api' }]) {
    const saved = { ...config.providers.deepseek }; Object.assign(config.providers.deepseek, patch); save();
    assert.throws(() => readCaffDeepseekKey({ PI_CODING_AGENT_DIR: root, [KEY_ENV]: key }), /^Error: evaluation_caff_auth_unavailable_or_invalid$/);
    config.providers.deepseek = saved;
  }
  assert.throws(() => readCaffDeepseekKey({ [KEY_ENV]: key }), /caff_auth_unavailable_or_invalid/);
});
test('DeepSeek model, endpoint and observed call labels are selected together, never relabelled OpenCode', async () => {
  const selected = 'deepseek/deepseek-v4-flash', p = modelProfile(selected);
  assert.deepEqual(p, { provider: 'deepseek', model: 'deepseek-v4-flash', endpoint: 'https://api.deepseek.com' });
  const routing = directModelRouting(undefined, selected).providers.deepseek;
  assert.equal(routing.baseUrl, p.endpoint); assert.equal(routing.models[0].id, p.model); assert.equal(routing.apiKey, '$' + KEY_ENV);
  assert.throws(() => directModelRouting(ENDPOINT, selected), /endpoint_invalid/);
  assert.throws(() => modelProfile('deepseek/unknown'), /profile_invalid/);
  const observer = observeDirectFetch(async () => new Response('ok'), { profile: selected });
  await assert.rejects(observer.fetch(ENDPOINT + '/chat/completions'), /request_blocked/);
  await observer.fetch(p.endpoint + '/chat/completions'); observer.complete({ stopReason: 'stop' });
  assert.equal(observer.calls[0].model, selected); assert.equal(observer.calls[0].success, true);
});
test('invalid explicit file has no ambient fallback and no content/path in errors', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-key-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'private-path.key');
  for (const contents of [key + '\nextra', key + '\n\n', '', 'short', key + ' ', key + '\0', 'x'.repeat(4099)]) {
    fs.writeFileSync(file, contents);
    assert.throws(() => readEvaluationKey({ CAFF_BADCASE_MODEL_KEY_FILE: file, [KEY_ENV]: key }), e => {
      assert.equal(e.message, 'evaluation_key_file_unavailable_or_invalid'); assert.equal(e.message.includes(file), false); return true;
    });
  }
  assert.throws(() => readEvaluationKey({ CAFF_BADCASE_MODEL_KEY_FILE: path.join(root, 'missing'), [KEY_ENV]: key }), /file_unavailable_or_invalid/);
  assert.throws(() => readEvaluationKey({ CAFF_BADCASE_MODEL_KEY_FILE: root, [KEY_ENV]: key }), /file_unavailable_or_invalid/);
});
test('portable prompt binds only the recorded callback/path variables, never ambient values or an invented session', () => {
  const names = ['CAFF_CHAT_API_URL', 'CAFF_CHAT_INVOCATION_ID', 'CAFF_CHAT_CALLBACK_TOKEN', 'CAFF_CHAT_CONVERSATION_ID', 'CAFF_CHAT_TURN_ID',
    'CAFF_CHAT_TOOLS_PATH', 'CAFF_CHAT_TOOLS_RELATIVE_PATH', 'PI_AGENT_SANDBOX_DIR', 'PI_AGENT_PRIVATE_DIR'];
  const values = Object.fromEntries(names.map(n => [n, 'isolated-' + n]));
  for (const sourceRoot of ['/old/root', 'C:' + String.fromCharCode(92) + 'source']) {
    const prompt = sourceRoot + '\n' + names.map(n => '{{' + n + '}}').join('\n');
    const bindings = { sourceRoot, controlledReplacements: names.map(name => ({ name, count: 1 })) };
    validateDirectBindings(prompt, bindings);
    const result = bindDirectPrompt(prompt, bindings, values); assert.ok(result.startsWith('/work/restored\n'));
    assert.equal(result.includes('{{'), false); assert.equal(result.includes(sourceRoot), false);
    assert.throws(() => bindDirectPrompt(prompt + '{{UNKNOWN}}', bindings, values), /bindings_unsupported/);
    assert.throws(() => bindDirectPrompt(prompt, { ...bindings, controlledReplacements: [] }, values), /bindings_unsupported/);
    assert.throws(() => bindDirectPrompt(prompt, bindings, {}), /bindings_unsupported/);
  }
});
test('observer sends exact native body/auth and returns exact SSE Response; one record per attempt', async () => {
  const body = JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hello' }], stream: true });
  const response = new Response('data: native-sse-bytes\n\n', { status: 200 }); const options = { method: 'POST', body, headers: { authorization: 'Bearer ' + key } };
  let sent = 0;
  const observer = observeDirectFetch(async (url, opts) => { sent++; assert.equal(url, ENDPOINT + '/chat/completions'); assert.equal(opts, options); return response; });
  assert.equal(await observer.fetch(ENDPOINT + '/chat/completions', options), response);
  observer.complete({ stopReason: 'toolUse', usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 15 } });
  assert.equal(sent, 1); assert.equal(observer.calls.length, 1); assert.equal(observer.calls[0].success, true);
  assert.equal(observer.calls[0].httpStatus, 200); assert.equal(observer.calls[0].usage.totalTokens, 15);
  assert.ok(observer.calls[0].durationMs >= 0); assert.equal(JSON.stringify(observer.calls).includes(key), false);
});
test('HTTP/model/transport failure closes subsequent attempts; no vendor error/body saved', async () => {
  for (const scenario of ['http', 'model', 'transport']) {
    let sent = 0;
    const observer = observeDirectFetch(async () => { sent++; if (scenario === 'transport') throw Error(key); return new Response(key, { status: scenario === 'http' ? 401 : 200 }); });
    if (scenario === 'transport') await assert.rejects(observer.fetch(ENDPOINT + '/chat/completions'), /^Error: evaluation_request_failed$/);
    else { await observer.fetch(ENDPOINT + '/chat/completions'); observer.complete({ stopReason: 'error', errorMessage: key }); }
    await assert.rejects(observer.fetch(ENDPOINT + '/chat/completions'), /request_blocked/);
    assert.equal(sent, 1); assert.equal(observer.calls.length, 1); assert.equal(observer.calls[0].success, false);
    assert.equal(JSON.stringify(observer.calls).includes(key), false);
  }
});
test('observer permits only exact provider endpoint and explicitly supplied callback origin', async () => {
  let sent = 0; const observer = observeDirectFetch(async () => { sent++; return new Response('ok'); }, { callbackUrl: 'http://127.0.0.1:4567', maxRequests: 1 });
  await assert.rejects(observer.fetch('http://127.0.0.1:3100/api/bootstrap'), /request_blocked/);
  await assert.rejects(observer.fetch(ENDPOINT + '/chat/completions?other=1'), /request_blocked/);
  await observer.fetch('http://127.0.0.1:4567/api/agent-tools/context'); assert.equal(observer.calls.length, 0);
  await observer.fetch(ENDPOINT + '/chat/completions'); observer.complete({ stopReason: 'stop' });
  await assert.rejects(observer.fetch(ENDPOINT + '/chat/completions'), /request_blocked/); assert.equal(sent, 2);
});
