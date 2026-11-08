// Windows page induction: no real provider credentials/network/Docker in unit tests.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const key = 'synthetic-wiki-host-only-key';
const load = () => require('../../scripts/badcase-capture/wiki-host-model.cjs');
const input = { phase: 'preclassification', cases: [{ id: 'c1', actual: 'a', expected: 'b' }], approvedEntries: [] };
const result = { caseId: 'c1', kind: 'none', reason: '证据不足', confidence: '低' };
const response = () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results: [result] }) } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
const body = () => Buffer.from(require('../../scripts/badcase-capture/wiki-induction-container.cjs').buildRequestBody(input));

test('same classification code crosses a credential-free mailbox; host pins body, endpoint and proxy', async () => {
  const { createWikiHostExchange, createWikiMailboxFetch } = load(); let sent = 0, destroyed = 0;
  const dispatcher = { destroy: async () => { destroyed++; } };
  const transport = createWikiHostExchange({ key, expectedBody: body() }, {
    createDispatcher: uri => { assert.equal(uri, 'http://127.0.0.1:17890'); return dispatcher; },
    fetch: async (url, options) => {
      sent++; assert.equal(url, 'https://api.deepseek.com/chat/completions'); assert.equal(options.dispatcher, dispatcher);
      assert.equal(options.headers.authorization, 'Bearer ' + key); assert.equal(options.redirect, 'error');
      assert.equal(Buffer.from(options.body).equals(body()), true); return response();
    },
  });
  const fetchImpl = createWikiMailboxFetch({ exchange: bytes => { assert.equal(bytes.includes(key), false); return transport.exchange(bytes); } });
  const out = await require('../../scripts/badcase-capture/wiki-induction-container.cjs').classify(input, { fetchImpl, key: null });
  assert.equal(out.ok, true); assert.deepEqual(out.results, [result]); assert.equal(sent, 1);
  assert.equal(JSON.stringify(out).includes(key), false); await transport.close(); assert.equal(destroyed, 1);
});

test('host rejects altered request before auth/network; HTTP errors are sanitized and never retried', async () => {
  const { createWikiHostExchange } = load(); let calls = 0;
  const deps = { createDispatcher: () => ({ destroy: async () => {} }), fetch: async () => { calls++; return new Response(key, { status: 429 }); } };
  const bad = createWikiHostExchange({ key, expectedBody: body() }, deps);
  await assert.rejects(bad.exchange(Buffer.from('{}')), /wiki_host_request_invalid/); assert.equal(calls, 0); await bad.close();
  const t = createWikiHostExchange({ key, expectedBody: body() }, deps);
  const envelope = JSON.parse(await t.exchange(body())); assert.equal(envelope.status, 429); assert.equal(JSON.stringify(envelope).includes(key), false);
  await assert.rejects(t.exchange(body()), /wiki_host_request_blocked/); assert.equal(calls, 1); await t.close();
  await assert.rejects(t.exchange(body()), /wiki_host_request_blocked/);
});

test('proxy failure, excessive response and reflected key fail closed without a direct fallback', async () => {
  const { createWikiHostExchange } = load();
  for (const fetch of [async () => { throw Error(key); }, async () => new Response('x'.repeat(512 * 1024 + 1)), async () => new Response(key)]) {
    let sent = 0, closed = 0;
    const t = createWikiHostExchange({ key, expectedBody: body() }, { fetch: (...args) => { sent++; return fetch(...args); }, createDispatcher: () => ({ destroy: async () => { closed++; } }) });
    await assert.rejects(t.exchange(body()), e => /^wiki_host_/.test(e.code) && !e.message.includes(key));
    await assert.rejects(t.exchange(body()), /wiki_host_request_blocked/); assert.equal(sent, 1); await t.close(); assert.equal(closed, 1);
  }
});

test('worker rejects destination, headers and second call; never forwards an auth field', async () => {
  const { createWikiMailboxFetch } = load(); let sent = 0;
  const fetch = createWikiMailboxFetch({ exchange: async bytes => { sent++; return Buffer.from(JSON.stringify({ status: 200, body: 'e30=' })); } });
  const q = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body().toString() };
  await assert.rejects(fetch('https://elsewhere.invalid', q), /wiki_host_request_invalid/);
  await assert.rejects(fetch('https://api.deepseek.com/chat/completions', { ...q, headers: { ...q.headers, authorization: key } }), /wiki_host_request_invalid/);
  assert.equal(sent, 0); await fetch('https://api.deepseek.com/chat/completions', q);
  await assert.rejects(fetch('https://api.deepseek.com/chat/completions', q), /wiki_host_request_blocked/); assert.equal(sent, 1);
});

test('Windows relay stages only checked inputs/code, no key, and explicitly selects WSL Docker', async () => {
  const { runWikiHostTask } = load(); let closed = false, ran = false;
  const backend = { kind: 'windows-wsl-v1', distribution: 'Debian' }, runner = () => {};
  const files = [{ path: 'wiki-induction-input.json', bytes: Buffer.from(JSON.stringify(input)) }, { path: 'probe.cjs', bytes: Buffer.from('checked-code') }];
  const out = await runWikiHostTask({}, files, { key, dockerBackend: backend }, {
    createRunner: selected => { assert.deepEqual(selected, backend); return runner; },
    createExchange: config => { assert.equal(config.key, key); assert.equal(config.expectedBody.equals(body()), true); return { exchange: () => {}, close: async () => { closed = true; } }; },
    execute: async (_image, staged, options) => {
      ran = true; assert.equal(options.key, undefined); assert.equal(options.network, 'none'); assert.equal(options.runDocker, runner);
      assert.equal(staged.some(f => f.path === 'wiki-host-relay.json'), true);
      assert.equal(staged.some(f => f.path === 'container-model-adapter.cjs'), true);
      assert.equal(staged.some(f => f.bytes.includes(key)), false); assert.equal(options.limits.maxRequests, 1);
      return { cleaned: true, receipt: { ok: true, results: [result], calls: [] } };
    },
  });
  assert.equal(out.cleaned, true); assert.equal(ran, true); assert.equal(closed, true);
});

test('invalid backend and unavailable Windows backend fail before reading auth or changing case state', async t => {
  const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
  const { inductWikiCases } = require('../../scripts/badcase-capture/wiki-induction.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-backend-preflight-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createWikiStore({ globalRoot: path.join(root, 'global'), sourceWorktree: path.join(root, 'source') });
  store.addMarkedCase({ source: { projectId: 'p1', conversationId: 'c1', conversationTitle: 'Synthetic', messageId: 'm1', agentId: 'role-family-gpt' }, role: 'role-family-gpt', actual: 'a', expected: 'b', message: '', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false });
  let reads = 0; const before = store.read(), args = { store, confirmed: true, expectedRevision: before.revision };
  const options = { readKey: () => { reads++; throw Error('must not read'); } };
  await assert.rejects(inductWikiCases({ ...args, dockerBackend: { kind: 'windows-wsl-v1', distribution: 'bad;name' } }, options), /evaluation_wsl_backend_invalid/);
  if (process.platform === 'win32') await assert.rejects(inductWikiCases(args, options), /evaluation_linux_required/);
  else await assert.rejects(inductWikiCases({ ...args, dockerBackend: { kind: 'windows-wsl-v1', distribution: 'Debian' } }, options), /evaluation_wsl_host_required/);
  assert.equal(reads, 0); assert.deepEqual(store.read(), before);
});

test('operator runtime config is explicit, rejects HTTP-like extras, and reads auth only on execution', async t => {
  const { runPageInduction } = require('../../scripts/badcase-capture/wiki-page-runtime.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-page-runtime-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configFile = path.join(root, 'runtime.json'), credentialDir = path.join(root, '.pi-sandbox');
  const config = { image: { imageId: 'sha256:' + 'a'.repeat(64), architecture: 'amd64' }, dockerBackend: { kind: 'windows-wsl-v1', distribution: 'Debian' }, credentialDir };
  fs.writeFileSync(configFile, JSON.stringify(config)); let reads = 0, runs = 0;
  const input = { store: {}, expectedRevision: 7 };
  const deps = { readKey: env => { reads++; assert.equal(env.PI_CODING_AGENT_DIR, credentialDir); return key; },
    induct: async (actual, options) => { runs++; assert.equal(actual.store, input.store); assert.equal(actual.confirmed, true); assert.deepEqual(actual.dockerBackend, config.dockerBackend); assert.deepEqual(actual.image, config.image); assert.equal(reads, 0); assert.equal(options.readKey(), key); return 'saved'; } };
  assert.equal(await runPageInduction(input, { configFile }, deps), 'saved'); assert.equal(reads, 1); assert.equal(runs, 1);
  fs.writeFileSync(configFile, JSON.stringify({ ...config, key }));
  await assert.rejects(runPageInduction(input, { configFile }, deps), /wiki_runtime_config_invalid/); assert.equal(reads, 1); assert.equal(runs, 1);
  await assert.rejects(runPageInduction(input, {}, deps), /wiki_runtime_config_required/);
});

test('server default page runner consumes operator config, not client-selected paths', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../server/app/create-server.ts'), 'utf8');
  assert.match(source, /wiki-page-runtime\.cjs/); assert.match(source, /CAFF_BADCASE_WIKI_RUNTIME_CONFIG/);
});
