const test = require('node:test'), assert = require('node:assert/strict');
const { createDehydrationClient, dehydrationRequestBody } = require('../../build/server/domain/runtime/badcase-capture/wiki-dehydration-client');
const key = 'synthetic-dehydration-test-key';
const request = { state: { cause: 'synthetic cause' }, questions: { kind: 'kind?', cut: 'cut?' } };
const completion = (content, extra = {}) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content, reasoning_content: 'NOT_FOR_STORAGE' } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, ...extra }));
test('DeepSeek transport is pinned to preclassification settings, explicit auth/fetch, two requests maximum, no tools or reasoning in saved output', async () => {
  let calls = 0; const client = createDehydrationClient({ key, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://api.deepseek.com/chat/completions'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer ' + key);
    const b = JSON.parse(options.body); assert.equal(b.model, 'deepseek-v4-flash'); assert.equal(b.max_tokens, 32768); assert.equal(b.temperature, 0);
    assert.equal(b.stream, false); assert.equal(b.response_format.type, 'json_object'); assert.equal(b.tools, undefined);
    assert.deepEqual(JSON.parse(b.messages.at(-1).content), request); assert.ok(b.messages.at(-1).content.indexOf('questions') > b.messages.at(-1).content.indexOf('state'));
    return completion('{"kind":"单步型","cutStep":1,"reason":"reason","evidence":"evidence"}');
  } });
  const a = await client.ask(request); assert.equal(a.usage.totalTokens, 30); assert.equal(a.httpStatus, 200); assert.equal(a.finishReason, 'stop');
  assert.doesNotMatch(JSON.stringify(a), /NOT_FOR_STORAGE|synthetic-dehydration-test-key/);
  await client.ask(request); await assert.rejects(client.ask(request), e => e.code === 'wiki_dehydration_budget_exhausted'); assert.equal(calls, 2);
  assert.doesNotMatch(dehydrationRequestBody(request), /Authorization|Bearer/);
});
test('page transport has a hard single-send budget even if its caller asks again', async () => {
  let calls = 0; const client = createDehydrationClient({ key, maxRequests: 1, fetchImpl: async () => { calls++; return completion('invalid JSON'); } });
  assert.equal((await client.ask(request)).content, 'invalid JSON');
  await assert.rejects(client.ask(request), e => e.code === 'wiki_dehydration_budget_exhausted'); assert.equal(calls, 1);
});
test('HTTP/network failures never echo upstream bodies or retry; malformed envelopes remain parse failures; request/key echoes are blocked', async () => {
  for (const [fetchImpl, code] of [[async () => new Response(key, { status: 403 }), 'wiki_dehydration_http_failed'],
    [async () => { throw Error(key); }, 'wiki_dehydration_network_failed'], [async () => completion(key), 'wiki_dehydration_response_invalid'],
    [async () => completion(JSON.stringify({ evidence: key }).replace(key, key.split('').map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join(''))), 'wiki_dehydration_response_invalid']]) {
    const c = createDehydrationClient({ key, fetchImpl });
    await assert.rejects(c.ask(request), e => e.code === code && !e.message.includes(key));
  }
  const c = createDehydrationClient({ key, fetchImpl: async () => new Response('invalid-json') });
  assert.equal((await c.ask(request)).content, null);
  const d = createDehydrationClient({ key, fetchImpl: async () => { throw Error('must not send'); } });
  await assert.rejects(d.ask({ state: key }), e => e.code === 'wiki_dehydration_request_invalid');
});
