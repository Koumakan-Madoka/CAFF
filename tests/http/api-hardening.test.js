const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const test = require('node:test');
const { createTestServerApp } = require('../helpers/server-app');
const { createInMemoryPlannerCredential } = require('../../build/server/domain/security/planner-credential');
const { isolateExternalIntegrations } = require('../helpers/external-integrations');
isolateExternalIntegrations();
process.env.FEISHU_VERIFICATION_TOKEN = 'synthetic-webhook-test';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-hardening-http-'));
  const token = randomBytes(32).toString('base64url');
  const app = createTestServerApp({ host: '127.0.0.1', port: 0, agentDir: root, sqlitePath: path.join(root, 'chat.sqlite'),
    projectDir: root, uploadsDir: path.join(root, 'uploads'), plannerCredential: createInMemoryPlannerCredential({ token }),
    modelCatalog: { getOptions: () => [{ provider: 'openai', model: 'gpt-5', input: ['text'], runtimeResolvable: true, supportedThinkingLevels: ['off'] }], invalidate() {} },
    executeConversationAgent: async () => ({ stopTurn: true }), validateProvider: async () => ({ ok: true, status: 'reachable' }) });
  t.after(async () => { await new Promise(resolve => app.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise(resolve => app.start(resolve));
  const port = app.server.address().port, base = `http://127.0.0.1:${port}`;
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  assert.ok(bootstrap.apiSecurity.csrfToken);
  assert.equal(bootstrap.apiSecurity.csrfToken, bootstrap.localAdmin.modelProviders.csrfToken);
  const agent = app.store.saveCustomRoleConfig({ id: 'author', name: 'Author', personaPrompt: 'Synthetic', provider: 'openai', model: 'gpt-5' });
  const room = app.store.createConversation({ title: 'Unchanged', participants: [{ agentId: agent.id }] });
  function call(pathname, options = {}) {
    const headers = options.native ? {} : { Origin: base, 'X-CAFF-CSRF-Token': bootstrap.apiSecurity.csrfToken };
    Object.assign(headers, { 'Content-Type': 'application/json' }, options.headers);
    for (const name of options.omit || []) delete headers[name];
    return new Promise((resolve, reject) => {
      const req = http.request(base + pathname, { method: options.method || 'PUT', headers }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text || '{}') }));
      });
      req.on('error', reject);
      const method = options.method || 'PUT';
      req.end(['GET', 'HEAD'].includes(method) ? undefined : options.rawBody !== undefined ? options.rawBody : JSON.stringify(options.body || { title: 'Updated' }));
    });
  }
  return { app, root, port, base, room, agent, token, bootstrap, call };
}

test('HTTP write hardening rejects each invalid browser guard without persistence, before JSON parsing', async (t) => {
  const f = await fixture(t), route = '/api/conversations/' + f.room.id;
  for (const [options, status, code] of [
    [{ headers: { Host: 'evil.example' } }, 403, 'api_host_mismatch'],
    [{ headers: { Origin: 'http://evil.example' } }, 403, 'api_origin_mismatch'],
    [{ omit: ['Origin'] }, 403, 'api_origin_mismatch'],
    [{ omit: ['X-CAFF-CSRF-Token'] }, 403, 'api_csrf_invalid'],
    [{ headers: { 'X-CAFF-CSRF-Token': 'wrong' } }, 403, 'api_csrf_invalid'],
    [{ headers: { 'Content-Type': 'text/plain' } }, 415, 'api_json_required'],
  ]) {
    const response = await f.call(route, { ...options, rawBody: '{not-json' });
    assert.equal(response.status, status); assert.equal(response.body.code, code);
    assert.equal(f.app.store.getConversationWithoutMessages(f.room.id).title, 'Unchanged');
  }
  assert.equal((await f.call(route)).status, 200);
});

test('HTTP loopback Host aliases work for browser writes and existing local administration', async (t) => {
  const f = await fixture(t);
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.equal((await f.call('/api/conversations/' + f.room.id, { headers: { Host: host + ':' + f.port, Origin: `http://${host}:${f.port}` } })).status, 200);
    assert.equal((await f.call('/api/model-providers', { method: 'GET', headers: { Host: host + ':' + f.port } })).status, 200);
  }
  assert.equal((await f.call('/api/conversations/' + f.room.id, { headers: { Host: 'localhost:' + f.port } })).status, 403);
  // P1 deliberately leaves ordinary read-side Host validation unchanged.
  assert.equal((await f.call('/api/bootstrap', { method: 'GET', headers: { Host: 'evil.example' } })).status, 200);
});

test('HTTP authenticated planners replace Origin/CSRF, including local admin writes, but not Host or JSON', async (t) => {
  const f = await fixture(t);
  const headers = { Authorization: 'Bearer ' + f.token };
  assert.equal((await f.call('/api/conversations/' + f.room.id, { native: true, headers })).status, 200);
  const provider = { name: 'Synthetic OpenAI', apiKeyMode: 'env', apiKey: '', baseUrl: 'https://example.invalid/v1', api: 'openai-completions', models: [{ id: 'gpt-5', name: 'Synthetic' }] };
  assert.equal((await f.call('/api/model-providers/openai', { native: true, headers, body: provider })).status, 200);
  assert.equal((await f.call('/api/conversations/' + f.room.id, { native: true, headers: { ...headers, Host: 'evil.example' } })).status, 403);
  assert.equal((await f.call('/api/conversations/' + f.room.id, { native: true, headers: { ...headers, 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.call('/api/conversations/' + f.room.id, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
});

test('HTTP image upload requires CSRF and same Origin but accepts legitimate multipart', async (t) => {
  const f = await fixture(t), route = `/api/conversations/${f.room.id}/images`;
  const headers = { 'Content-Type': 'multipart/form-data; boundary=----test' };
  assert.equal((await f.call(route, { method: 'POST', headers, omit: ['X-CAFF-CSRF-Token'], rawBody: 'not parsed' })).status, 403);
  assert.equal((await f.call(route, { method: 'POST', headers: { ...headers, Origin: 'http://evil.example' }, rawBody: 'not parsed' })).status, 403);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZfkAAAAASUVORK5CYII=', 'base64');
  const body = Buffer.concat([Buffer.from('------test\r\nContent-Disposition: form-data; name="client_request_id"\r\n\r\nimage-request\r\n------test\r\nContent-Disposition: form-data; name="files"; filename="one.png"\r\nContent-Type: image/png\r\n\r\n'), png, Buffer.from('\r\n------test--\r\n')]);
  const response = await f.call(route, { method: 'POST', headers, rawBody: body });
  assert.equal(response.status, 200); assert.equal(response.body.images.length, 1);
});

test('HTTP callback and Feishu exemptions preserve native authentication, never bearer replacement', async (t) => {
  const f = await fixture(t);
  const message = f.app.store.createMessage({ id: 'callback-output', conversationId: f.room.id, turnId: 'synthetic-turn', role: 'assistant', agentId: f.agent.id, senderName: f.agent.name, content: '', status: 'streaming' });
  const invocation = f.app.agentToolBridge.registerInvocation(f.app.agentToolBridge.createInvocationContext({ conversationId: f.room.id, turnId: message.turnId,
    agentId: f.agent.id, agentName: f.agent.name, assistantMessageId: message.id, conversationAgents: [f.agent], projectDir: f.root, allowHandoffs: false }));
  const headers = { Host: 'native.example', 'Content-Type': 'text/plain' };
  const body = { invocationId: invocation.invocationId, callbackToken: invocation.callbackToken, content: 'Synthetic callback', noFinalize: true };
  assert.equal((await f.call('/api/agent-tools/post-message', { method: 'POST', native: true, headers, body })).status, 200);
  const invalid = await f.call('/api/agent-tools/post-message', { method: 'POST', native: true, headers: { ...headers, Authorization: 'Bearer ' + f.token }, body: { ...body, callbackToken: 'wrong' } });
  assert.ok(invalid.status === 401 || invalid.status === 403);
  const webhook = { type: 'url_verification', token: 'synthetic-webhook-test', challenge: 'synthetic-challenge' };
  const accepted = await f.call('/api/integrations/feishu/webhook', { method: 'POST', native: true, headers, body: webhook });
  assert.equal(accepted.status, 200); assert.equal(accepted.body.challenge, 'synthetic-challenge');
  assert.equal((await f.call('/api/integrations/feishu/webhook', { method: 'POST', native: true, headers: { ...headers, Authorization: 'Bearer ' + f.token }, body: { ...webhook, token: 'wrong' } })).status, 401);
  assert.equal((await f.call('/api/integrations/feishu/webhook', { method: 'POST', native: true, headers: { ...headers, 'X-CAFF-Principal': 'planner' }, body: webhook })).status, 401);
});
