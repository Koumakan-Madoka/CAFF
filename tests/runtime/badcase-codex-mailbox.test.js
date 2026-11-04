// No model, OAuth, Docker or account source in these protocol tests.
const test = require('node:test'), assert = require('node:assert/strict');
const load = () => require('../../scripts/badcase-capture/codex-mailbox.cjs');
const direct = () => require('../../scripts/badcase-capture/direct-model.cjs');
const endpoint = 'https://chatgpt.com/backend-api/codex/responses';
const request = () => ({ method: 'POST', headers: { authorization: 'Bearer inert-only', 'chatgpt-account-id': 'inert', 'content-type': 'application/json', accept: 'text/event-stream' }, body: Buffer.from('native request bytes') });
test('Codex routing keeps the built-in native model and never substitutes chat-completions compatibility settings', () => {
  const d = direct(), selected = d.modelProfile(d.CODEX_PROFILE); assert.equal(d.CODEX_PROFILE, 'openai-codex/gpt-6.1-sol');
  assert.equal(selected.api, 'openai-codex-responses'); assert.equal(selected.thinking, 'xhigh');
  const provider = d.directModelRouting(undefined, d.CODEX_PROFILE).providers['openai-codex'];
  assert.equal(provider.baseUrl, 'https://chatgpt.com/backend-api'); assert.equal(provider.apiKey, '$' + d.KEY_ENV);
  assert.equal(provider.models, undefined); assert.equal(provider.compat, undefined);
  assert.throws(() => d.directModelRouting('http://127.0.0.1:1234/v1', d.CODEX_PROFILE), /endpoint_invalid/);
  const claims = JSON.parse(Buffer.from(d.CODEX_INERT_KEY.split('.')[1], 'base64url'));
  assert.equal(claims['https://api.openai.com/auth'].chatgpt_account_id, 'caff-replay-inert');
  assert.equal(claims.exp, 1, 'placeholder is expired and cannot authenticate');
});
test('native fetch traverses a credential-free binary mailbox and host exchange without modifying body/SSE', async () => {
  const { createCodexMailboxFetch, createCodexRelayExchange } = load(); let requests = 0;
  const send = createCodexRelayExchange({ fetch: async (url, options) => {
    requests++; assert.equal(url, endpoint); assert.equal(options.method, 'POST');
    assert.equal(options.headers.authorization, undefined); assert.equal(options.headers['chatgpt-account-id'], undefined);
    assert.equal(Buffer.from(options.body).toString(), 'native request bytes');
    return new Response('data: native SSE bytes\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  const fetch = createCodexMailboxFetch({ exchange: send }), q = request();
  const response = await fetch(endpoint, q); assert.equal(response.status, 200);
  assert.equal(await response.text(), 'data: native SSE bytes\n\n'); assert.equal(requests, 1);
  assert.equal(q.headers.authorization, 'Bearer inert-only');
});
test('only exact model destination or the separately declared local callback may be fetched', async () => {
  const { createCodexMailboxFetch } = load(); let model = 0, callback = 0;
  const fetch = createCodexMailboxFetch({ exchange: async () => { model++; throw Error('unused'); }, callbackUrl: 'http://127.0.0.1:45678', callbackFetch: async () => { callback++; return new Response('callback'); } });
  await assert.rejects(fetch('http://127.0.0.1:3100/api/bootstrap', request()), /codex_mailbox_request_invalid/);
  await assert.rejects(fetch(endpoint + '?x=1', request()), /codex_mailbox_request_invalid/);
  await assert.rejects(fetch(endpoint, { ...request(), method: 'GET' }), /codex_mailbox_request_invalid/);
  assert.equal(await (await fetch('http://127.0.0.1:45678/context')).text(), 'callback');
  assert.equal(model, 0); assert.equal(callback, 1);
});
test('model observer uses the native Codex endpoint, latches failures, and counts actual requests only', async () => {
  const d = direct(); assert.equal(d.CODEX_PROFILE, 'openai-codex/gpt-6.1-sol');
  const observer = d.observeDirectFetch(async () => new Response('native'), { profile: d.CODEX_PROFILE });
  await assert.rejects(observer.fetch('https://chatgpt.com/backend-api/chat/completions'), /request_blocked/);
  await observer.fetch(endpoint); observer.complete({ stopReason: 'stop', usage: { input: 7, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: 12 } });
  assert.equal(observer.calls[0].model, d.CODEX_PROFILE); assert.equal(observer.calls[0].usage.totalTokens, 12); assert.equal(observer.calls[0].success, true);
  await observer.fetch(endpoint); observer.complete({ stopReason: 'error' });
  await assert.rejects(observer.fetch(endpoint), /request_blocked/); assert.equal(observer.calls.length, 2);
});
test('corrupt envelopes, encoded credentials and oversize messages fail before host fetch', async () => {
  const { createCodexRelayExchange, MAILBOX_LIMITS } = load(); let sent = 0;
  const exchange = createCodexRelayExchange({ fetch: () => { sent++; throw Error('unexpected'); } });
  const q = { headers: { 'content-type': 'application/json' }, body: Buffer.from('native').toString('base64') };
  for (const value of [{ ...q, url: 'https://elsewhere.invalid' }, { ...q, body: q.body + '\n' },
    { ...q, headers: { authorization: 'never accept credentials in mailbox' } }]) {
    await assert.rejects(exchange(Buffer.from(JSON.stringify(value))), /codex_mailbox_request_invalid/);
  }
  await assert.rejects(exchange(Buffer.alloc(MAILBOX_LIMITS.maxRequestBytes + 1)), /codex_mailbox_request_invalid/); assert.equal(sent, 0);
  const bad = load().createCodexMailboxFetch({ exchange: async () => Buffer.from('{"status":200,"body":"bad base64"}') });
  await assert.rejects(bad(endpoint, request()), /codex_mailbox_response_invalid/);
});
