// Synthetic callback traffic only. No captured program/SDK/model is executed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const api = () => require('../../build/server/domain/runtime/badcase-capture/evaluation-callback');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-eval-callback-'));
  const services = [];
  t.after(async () => { for (const s of services) await s.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const seed = { conversationId: 'eval-conversation', turnId: 'eval-turn', agent: { id: 'eval-agent', name: 'Evaluation Agent' },
    userMessage: { id: 'eval-user', content: 'Synthetic authorized context.' }, assistantMessageId: 'eval-assistant' };
  return { root, seed, services, directory: path.join(root, 'new-run') };
}
async function start(t, options) {
  const service = await api().startEvaluationCallback({ directory: options.directory, seed: options.seed, lifetimeMs: options.lifetimeMs ?? 10000 });
  options.services.push(service); return service;
}
async function request(service, route, body, auth = service.credentials) {
  const url = new URL(service.apiUrl + '/api/agent-tools/' + route);
  if (body === undefined) for (const [k, v] of Object.entries(auth)) url.searchParams.set(k, v);
  const r = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { Connection: 'close', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify({ ...auth, ...body }) }) });
  return { status: r.status, body: await r.json() };
}
function cli(service, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../../build/lib/agent-chat-tools.js'), ...args], {
      env: { ...process.env, CAFF_CHAT_API_URL: service.apiUrl, CAFF_CHAT_INVOCATION_ID: service.credentials.invocationId,
        CAFF_CHAT_CALLBACK_TOKEN: service.credentials.callbackToken }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('real HTTP and existing CLI use the existing bridge with isolated durable SQLite and no ambient DB selection', async t => {
  const f = fixture(t), poison = path.join(f.root, 'must-not-open.sqlite');
  const previous = process.env.PI_SQLITE_PATH; process.env.PI_SQLITE_PATH = poison;
  let s;
  try { s = await start(t, f); } finally { if (previous === undefined) delete process.env.PI_SQLITE_PATH; else process.env.PI_SQLITE_PATH = previous; }
  assert.equal(new URL(s.apiUrl).hostname, '127.0.0.1'); assert.notEqual(new URL(s.apiUrl).port, '3100');
  assert.equal(s.databasePath, path.join(f.directory, 'callback.sqlite')); assert.equal(fs.existsSync(poison), false);
  const context = await request(s, 'context'); assert.equal(context.status, 200);
  assert.equal(context.body.latestUserMessage.id, f.seed.userMessage.id); assert.equal(context.body.latestUserMessage.content, f.seed.userMessage.content);
  assert.equal(context.body.publicMessages.some(m => m.id === f.seed.assistantMessageId), false, 'streaming placeholder hidden');
  const participants = await request(s, 'participants'); assert.equal(participants.status, 200); assert.equal(participants.body.participants[0].id, f.seed.agent.id);
  assert.equal(s.readPublicReply(), '');
  const sent = await cli(s, ['send-public', '--content', 'Synthetic isolated output.', '--no-finalize']);
  assert.equal(sent.code, 0, sent.stderr); assert.equal(JSON.parse(sent.stdout).message.id, f.seed.assistantMessageId);
  const read = await cli(s, ['read-context']); assert.equal(read.code, 0, read.stderr);
  assert.equal(JSON.parse(read.stdout).publicMessages.find(m => m.id === f.seed.assistantMessageId).content, 'Synthetic isolated output.');
  assert.equal(s.readPublicReply(), 'Synthetic isolated output.');
  await s.stop(); await s.stop();
  assert.throws(() => s.readPublicReply(), { code: 'evaluation_callback_expired' });
  const store = createChatAppStore({ agentDir: f.directory, sqlitePath: s.databasePath });
  try { assert.equal(store.getMessage(f.seed.assistantMessageId).content, 'Synthetic isolated output.'); } finally { store.close(); }
  for (const name of fs.readdirSync(f.directory)) if (fs.statSync(path.join(f.directory, name)).isFile()) {
    assert.equal(fs.readFileSync(path.join(f.directory, name)).includes(Buffer.from(s.credentials.callbackToken)), false, 'credentials never persisted');
    assert.equal(fs.readFileSync(path.join(f.directory, name)).includes(Buffer.from(s.credentials.invocationId)), false);
  }
});

test('callback supports the 45-minute turn ceiling, survives simulated five minutes, and still expires at its deadline', async t => {
  const f = fixture(t), s = await start(t, { ...f, lifetimeMs: 2700000 });
  const { performance } = require('node:perf_hooks'), base = performance.now();
  t.mock.method(performance, 'now', () => base + 301000);
  assert.equal((await request(s, 'context')).status, 200);
  assert.equal((await request(s, 'post-message', { visibility: 'public', content: 'After five simulated minutes.', noFinalize: true })).status, 200);
  assert.equal(s.readPublicReply(), 'After five simulated minutes.');
  t.mock.method(performance, 'now', () => base + 2700001);
  assert.equal((await request(s, 'context')).status, 410);
  assert.throws(() => s.readPublicReply(), { code: 'evaluation_callback_expired' });
  t.mock.restoreAll();
  const directory = path.join(f.root, 'too-long');
  await assert.rejects(api().startEvaluationCallback({ directory, seed: f.seed, lifetimeMs: 2700001 }), { code: 'evaluation_callback_invalid' });
  assert.equal(fs.existsSync(directory), false);
});
test('same seed in two instances cannot cross-authenticate, read outputs, reuse a directory or choose a database', async t => {
  const f = fixture(t), a = await start(t, f), b = await start(t, { ...f, directory: path.join(f.root, 'second') });
  assert.notEqual(a.apiUrl, b.apiUrl); assert.notDeepEqual(a.credentials, b.credentials);
  assert.equal((await request(b, 'context', undefined, a.credentials)).status, 401);
  assert.equal((await request(a, 'post-message', { visibility: 'public', content: 'Only A.', noFinalize: true })).status, 200);
  assert.equal(JSON.stringify((await request(b, 'context')).body).includes('Only A.'), false);
  await assert.rejects(api().startEvaluationCallback({ directory: f.directory, seed: f.seed, lifetimeMs: 10000 }), { code: 'evaluation_callback_directory_unavailable' });
  await assert.rejects(api().startEvaluationCallback({ seed: f.seed, directory: path.join(f.root, 'third'), sqlitePath: a.databasePath, lifetimeMs: 10000 }), { code: 'evaluation_callback_invalid' });
  assert.equal(fs.existsSync(path.join(f.root, 'third')), false);
});

test('directory authorization never follows a symlink/junction parent into another location', async t => {
  const f = fixture(t), actual = path.join(f.root, 'actual'), alias = path.join(f.root, 'alias');
  fs.mkdirSync(actual); fs.symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(api().startEvaluationCallback({ directory: path.join(alias, 'new'), seed: f.seed, lifetimeMs: 10000 }), { code: 'evaluation_callback_directory_unavailable' });
  assert.equal(fs.existsSync(path.join(actual, 'new')), false);
});

test('closed route/method/body/query/auth surface never reaches production, capabilities, private messages or control operations', async t => {
  const f = fixture(t), s = await start(t, f);
  for (const route of ['goal/suggest', 'capabilities/room_workspace_bind', 'conversation-request', 'delegation/create', 'search-memory', '../health', 'context/extra', '%63ontext']) {
    const r = await request(s, route, {}); assert.equal(r.status, 404, route); assert.deepEqual(r.body, { error: 'evaluation_callback_route_unavailable' });
  }
  for (const body of [{ visibility: 'private', content: 'no' }, { visibility: 'public', content: 'no', recipients: ['other'] },
    { visibility: 'public', content: 'no', noFinalize: 'true' }, { visibility: 'public', content: 'x'.repeat(32769) }]) {
    assert.equal((await request(s, 'post-message', body)).status, 400);
  }
  for (const auth of [{ ...s.credentials, callbackToken: 'wrong' }, { ...s.credentials, callbackToken: 'a'.repeat(64) },
    { ...s.credentials, invocationId: 'wrong' }]) {
    assert.equal((await request(s, 'post-message', { visibility: 'public', content: 'no' }, auth)).status, 401);
  }
  const bad = await fetch(s.apiUrl + '/api/agent-tools/context?callbackToken=wrong', { headers: { Origin: 'https://example.invalid', Connection: 'close' } });
  assert.equal(bad.status, 403); assert.equal(await bad.text(), JSON.stringify({ error: 'evaluation_callback_request_forbidden' }));
  const url = new URL(s.apiUrl + '/api/agent-tools/context'); for (const [k, v] of Object.entries(s.credentials)) url.searchParams.set(k, v);
  url.searchParams.set('databasePath', '/production'); assert.equal((await fetch(url, { headers: { Connection: 'close' } })).status, 400);
  url.searchParams.delete('databasePath'); url.searchParams.append('callbackToken', 'duplicate'); assert.equal((await fetch(url, { headers: { Connection: 'close' } })).status, 400);
  const large = await fetch(s.apiUrl + '/api/agent-tools/post-message', { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: ' '.repeat(65537) }); assert.equal(large.status, 413);
  const malformed = await fetch(s.apiUrl + '/api/agent-tools/post-message', { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: '{' }); assert.equal(malformed.status, 400);
  const context = await request(s, 'context'); assert.equal(context.body.publicMessages.length, 1); assert.equal(context.body.privateMessages.length, 0);
});

test('context public/private limits accept only canonical integers 1 through 24, never bridge fallback defaults', async t => {
  const f = fixture(t), s = await start(t, f);
  for (const name of ['publicLimit', 'privateLimit']) {
    for (const value of ['1', '9', '10', '19', '20', '24', '25', '0', '-1', 'abc', '01', '1.0', '1e1', '', ' 1', '24\n']) {
      const url = new URL(s.apiUrl + '/api/agent-tools/context');
      for (const [k, v] of Object.entries(s.credentials)) url.searchParams.set(k, v);
      url.searchParams.set(name, value);
      const r = await fetch(url, { headers: { Connection: 'close' } });
      assert.equal(r.status, ['1', '9', '10', '19', '20', '24'].includes(value) ? 200 : 400, name + '=' + JSON.stringify(value));
      if (r.status !== 200) assert.deepEqual(await r.json(), { error: 'evaluation_callback_query_invalid' });
    }
  }
});

test('append replaces the streaming placeholder rather than consuming its output byte budget', async t => {
  const f = fixture(t), s = await start(t, f);
  const content = 'z'.repeat(32768);
  assert.equal((await request(s, 'post-message', { visibility: 'public', content, mode: 'append', noFinalize: true })).status, 200);
  assert.equal((await request(s, 'context')).body.publicMessages.find(m => m.id === f.seed.assistantMessageId).content, content);
});

test('runtime credentials and secret sentinels cannot be persisted directly or assembled through public append', async t => {
  const f = fixture(t), s = await start(t, f);
  for (const content of [s.credentials.callbackToken, s.credentials.invocationId, 'sk-' + 'x'.repeat(20)]) {
    assert.equal((await request(s, 'post-message', { visibility: 'public', content, noFinalize: true })).status, 400);
    const split = content.startsWith('sk-') ? 3 : Math.floor(content.length / 2);
    assert.equal((await request(s, 'post-message', { visibility: 'public', content: content.slice(0, split), noFinalize: true })).status, 200);
    assert.equal((await request(s, 'post-message', { visibility: 'public', content: content.slice(split), mode: 'append', noFinalize: true })).status, 400);
  }
  assert.equal((await request(s, 'post-message', { visibility: 'public', content: 'z'.repeat(32768), noFinalize: true })).status, 200);
  assert.equal((await request(s, 'post-message', { visibility: 'public', content: 'z', mode: 'append', noFinalize: true })).status, 400);
});

test('request budget and method/Host/content-type restrictions are fixed and never select a production route', async t => {
  const f = fixture(t), s = await start(t, f);
  assert.equal((await fetch(s.apiUrl + '/api/agent-tools/context', { method: 'POST', headers: { Connection: 'close' } })).status, 404);
  const hostStatus = await new Promise((resolve, reject) => {
    const r = http.get(s.apiUrl + '/api/agent-tools/context', { headers: { Host: 'localhost:3100', Connection: 'close' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); r.on('error', reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal((await fetch(s.apiUrl + '/api/agent-tools/post-message', { method: 'POST', headers: { 'Content-Type': 'text/plain', Connection: 'close' }, body: '{}' })).status, 400);
  for (let n = 0; n < 126; n++) assert.equal((await request(s, 'context')).status, 200);
  assert.equal((await request(s, 'context')).status, 429);
  assert.equal((await request(s, 'post-message', { visibility: 'public', content: 'not stored' })).status, 429);
});

test('stop during an incomplete POST closes only owned sockets and prevents a late SQLite mutation', async t => {
  const f = fixture(t), s = await start(t, f);
  let req;
  const settled = new Promise(resolve => {
    req = http.request(s.apiUrl + '/api/agent-tools/post-message', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } });
    req.on('error', () => resolve()); req.on('close', () => resolve()); req.flushHeaders(); req.write('{');
  });
  await new Promise(resolve => setImmediate(resolve)); await s.stop(); await settled; req.destroy();
  const store = createChatAppStore({ agentDir: f.directory, sqlitePath: s.databasePath });
  try { assert.equal(store.getMessage(f.seed.assistantMessageId).content, 'Thinking...'); } finally { store.close(); }
});

test('expiry, finalization and explicit stop revoke the invocation; stop closes sockets and leaves durable result', async t => {
  const f = fixture(t), s = await start(t, f);
  assert.equal((await request(s, 'post-message', { visibility: 'public', content: 'Finished.' })).status, 200);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await request(s, 'context')).status, 409);
  await s.stop(); await assert.rejects(fetch(s.apiUrl + '/api/agent-tools/context'));
  const fast = await start(t, { ...f, directory: path.join(f.root, 'expires'), lifetimeMs: 40 });
  await new Promise(resolve => setTimeout(resolve, 100)); await assert.rejects(fetch(fast.apiUrl + '/api/agent-tools/context'));
  await fast.stop(); assert.equal(fs.existsSync(fast.databasePath), true);
});

test('invalid input/secret seed fails before any directory creation; seed is cloned before asynchronous startup', async t => {
  const f = fixture(t);
  for (const change of [{ seed: null }, { directory: 'relative' }, { lifetimeMs: 0 }, { lifetimeMs: 2700001 }, { seed: { ...f.seed, extra: true } },
    { seed: { ...f.seed, agent: { ...f.seed.agent, id: 'role-family-gpt' } } },
    { seed: { ...f.seed, assistantMessageId: f.seed.userMessage.id } }, { seed: { ...f.seed, userMessage: { ...f.seed.userMessage, content: 'sk-' + 'a'.repeat(80) } } }]) {
    await assert.rejects(api().startEvaluationCallback({ directory: f.directory, seed: f.seed, lifetimeMs: 10000, ...change }), { code: 'evaluation_callback_invalid' }); assert.equal(fs.existsSync(f.directory), false);
  }
  const pending = api().startEvaluationCallback({ directory: f.directory, seed: f.seed, lifetimeMs: 10000 });
  f.seed.userMessage.content = 'Changed after call.'; f.seed.agent.name = 'Changed';
  const s = await pending; f.services.push(s);
  assert.equal((await request(s, 'context')).body.latestUserMessage.content, 'Synthetic authorized context.');
});
