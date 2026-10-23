const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), test = require('node:test');
const { randomBytes } = require('node:crypto');
const { createServerApp } = require('../../build/server/app/create-server');
const { createInMemoryPlannerCredential } = require('../../build/server/domain/security/planner-credential');
const { isolateExternalIntegrations } = require('../helpers/external-integrations');
isolateExternalIntegrations();
const model = { key: 'openai\u001fgpt-5', provider: 'openai', model: 'gpt-5', family: 'gpt', runtimeResolvable: true, input: ['text'], supportedThinkingLevels: ['off'] };
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-planner-room-http-'));
  const options = { host: '127.0.0.1', port: 0, agentDir: root, sqlitePath: path.join(root, 'chat.sqlite'), projectDir: root, uploadsDir: path.join(root, 'uploads'),
    modelCatalog: { getOptions: () => [model], invalidate() {} }, executeConversationAgent: async () => { assert.fail('Room creation must not execute an agent'); } };
  const f = { root, token: '', app: null, base: '', csrf: '' };
  let closed = true;
  f.start = async () => {
    f.token = randomBytes(32).toString('base64url');
    f.app = createServerApp({ ...options, plannerCredential: createInMemoryPlannerCredential({ token: f.token }) }); closed = false;
    await new Promise(resolve => f.app.start(resolve));
    f.base = `http://127.0.0.1:${f.app.server.address().port}`;
    const bootstrap = await (await fetch(f.base + '/api/bootstrap')).json(); f.csrf = bootstrap.apiSecurity.csrfToken;
    return bootstrap;
  };
  f.close = async () => { if (!closed) { closed = true; await new Promise(resolve => f.app.close(resolve)); } };
  t.after(async () => { await f.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const bootstrap = await f.start();
  for (const id of ['author', 'other']) f.app.store.saveCustomRoleConfig({ id, name: id, personaPrompt: 'Synthetic', provider: model.provider, model: model.model });
  const projects = await (await fetch(f.base + '/api/projects')).json();
  f.payload = { title: 'Planner-created Room', projectScopeId: projects.projects[0].id, modeId: bootstrap.modes[0].id, participants: ['author'] };
  f.post = async (body = f.payload, key = 'retry-key', browser = false) => {
    const r = await fetch(f.base + '/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(browser ? { Origin: f.base, 'X-CAFF-CSRF-Token': f.csrf } : { Authorization: 'Bearer ' + f.token }), ...(key === undefined || key === null ? {} : { 'Idempotency-Key': key }) }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json(), replayed: r.headers.get('Idempotency-Replayed') };
  };
  f.count = () => Number(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM chat_conversations').get().n);
  return f;
}
function forbidHydration(store) {
  for (const key of ['getConversation', 'getConversationWithoutMessages', 'listConversations', 'listConversationTree', 'listMessages']) {
    store[key] = () => assert.fail('planner creation hydrated ' + key);
  }
}

for (const key of [null, '', ' '.repeat(3), 'x'.repeat(201)]) {
  test('planner Room creation rejects missing/invalid retry key without persistence: ' + String(key?.length), async t => {
    const f = await fixture(t), before = f.count();
    const r = await f.post(f.payload, key); assert.equal(r.status, 400); assert.equal(r.body.code, 'idempotency_key_required');
    assert.equal(f.count(), before);
  });
}

test('duplicate retry-key headers are rejected, not joined into a different key', async t => {
  const f = await fixture(t), before = f.count();
  const r = await new Promise((resolve, reject) => {
    const req = http.request(f.base + '/api/conversations', { method: 'POST', headers: [
      'Host', new URL(f.base).host, 'Authorization', 'Bearer ' + f.token, 'Content-Type', 'application/json', 'Idempotency-Key', 'first', 'Idempotency-Key', 'second'] }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }); req.on('error', reject); req.end(JSON.stringify(f.payload));
  });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'idempotency_key_required'); assert.equal(f.count(), before);
});

test('planner creation returns only its lean identity without full Room/directory hydration; browser envelope is unchanged', async t => {
  const f = await fixture(t);
  const browser = await f.post(f.payload, null, true); assert.equal(browser.status, 201);
  assert.ok(browser.body.conversation.id); assert.ok(Array.isArray(browser.body.conversations)); assert.ok(browser.body.summary);
  forbidHydration(f.app.store);
  const r = await f.post(); assert.equal(r.status, 201); assert.equal(r.replayed, null);
  assert.deepEqual(Object.keys(r.body).sort(), ['conversationId', 'title', 'titleSource', 'projectScopeId', 'modeId'].sort());
  assert.equal(r.body.titleSource, 'manual'); assert.equal(r.body.title, f.payload.title);
  assert.equal(r.body.projectScopeId, f.payload.projectScopeId); assert.equal(r.body.modeId, f.payload.modeId);
  const replay = await f.post(); assert.equal(replay.status, 201); assert.equal(replay.replayed, 'true'); assert.deepEqual(replay.body, r.body);
});

test('canonical caller intent ignores key order, equivalent participant/profile/skill aliases, omitted defaults and ignored fields', async t => {
  const f = await fixture(t), before = f.count();
  const request = { ...f.payload, title: '  Canonical  ', participants: [{ agentId: 'author', modelProfileId: '', conversationSkillIds: ['s1', 's1', ' s2 '] }] };
  const created = await f.post(request); assert.equal(created.status, 201);
  const same = { participants: [{ ignoredByRoster: true, id: 'author', selectedModelProfileId: null, sessionSkills: [{ id: 's1' }, { skillId: 's2' }] }],
    modeId: request.modeId, projectScopeId: request.projectScopeId, title: 'Canonical' };
  const replay = await f.post(same); assert.equal(replay.status, 201); assert.equal(replay.replayed, 'true'); assert.deepEqual(replay.body, created.body);
  assert.equal(f.count(), before + 1);
  const omitted = { ...f.payload }; delete omitted.title;
  const noTitle = await f.post(omitted, 'default-title'); assert.equal(noTitle.status, 201); assert.equal(noTitle.body.titleSource, 'default');
  assert.deepEqual((await f.post({ ...omitted, title: '  ', participants: [{ agentId: 'author', modelProfileId: null, conversationSkills: [] }] }, 'default-title')).body, noTitle.body);
});

for (const change of ['title', 'project', 'mode', 'profile', 'skills', 'order']) {
  test('different semantic caller intent conflicts before dynamic validation: ' + change, async t => {
    const f = await fixture(t), original = { ...f.payload, participants: ['author', 'other'] };
    assert.equal((await f.post(original)).status, 201); const before = f.count();
    const changed = { ...original,
      ...(change === 'title' ? { title: 'Changed' } : {}), ...(change === 'project' ? { projectScopeId: 'absent-project' } : {}),
      ...(change === 'mode' ? { modeId: 'absent-mode' } : {}), ...(change === 'order' ? { participants: ['other', 'author'] } : {}),
      ...(change === 'profile' ? { participants: [{ agentId: 'author', modelProfileId: 'absent-profile' }, 'other'] } : {}),
      ...(change === 'skills' ? { participants: [{ agentId: 'author', conversationSkillIds: ['new-skill'] }, 'other'] } : {}) };
    const r = await f.post(changed); assert.equal(r.status, 409); assert.equal(r.body.code, 'idempotency_key_conflict'); assert.equal(f.count(), before);
  });
}

test('replay returns the original snapshot without revalidating a retired role or deleted mode', async t => {
  const f = await fixture(t); const created = await f.post(); assert.equal(created.status, 201);
  f.app.store.updateConversationWithoutMessages(created.body.conversationId, { title: 'Renamed after creation' });
  f.app.store.retireRoleConfig('author');
  f.app.store.db.prepare('DELETE FROM modes WHERE id=?').run(f.payload.modeId);
  // The requested IDs remain the original caller intent. A committed replay
  // must not consult current mutable directory/model availability at all.
  f.app.store.listAgents = () => assert.fail('replay revalidated current roles');
  forbidHydration(f.app.store);
  const replay = await f.post(); assert.equal(replay.status, 201); assert.deepEqual(replay.body, created.body); assert.equal(replay.replayed, 'true');
});

test('concurrent HTTP retries create exactly one Room and keep distinct keys independent', async t => {
  const f = await fixture(t), before = f.count();
  const all = await Promise.all(Array.from({ length: 8 }, () => f.post()));
  assert.ok(all.every(r => r.status === 201)); assert.equal(new Set(all.map(r => r.body.conversationId)).size, 1);
  assert.equal(all.filter(r => r.replayed === 'true').length, 7); assert.equal(f.count(), before + 1);
  const another = await f.post(f.payload, 'different-key'); assert.equal(another.status, 201);
  assert.notEqual(another.body.conversationId, all[0].body.conversationId); assert.equal(f.count(), before + 2);
});

test('mapping survives server restart and credential rotation without storing the bearer', async t => {
  const f = await fixture(t), created = await f.post(), oldToken = f.token;
  assert.equal(created.status, 201); await f.close(); await f.start();
  assert.notEqual(f.token, oldToken);
  const replay = await f.post(); assert.equal(replay.status, 201); assert.equal(replay.replayed, 'true'); assert.deepEqual(replay.body, created.body);
  const records = f.app.store.db.prepare('SELECT * FROM chat_planner_room_creations').all();
  const text = JSON.stringify(records); assert.equal(text.includes(oldToken), false); assert.equal(text.includes(f.token), false);
  const invalid = await fetch(f.base + '/api/conversations', { method: 'POST', headers: { Authorization: 'Bearer ' + oldToken, 'Content-Type': 'application/json', 'Idempotency-Key': 'retry-key' }, body: JSON.stringify(f.payload) });
  assert.equal(invalid.status, 401);
});

test('deletion tombstone survives Room ID reuse and restart; changed payload still conflicts', async t => {
  const f = await fixture(t), created = await f.post(); assert.equal(created.status, 201);
  const id = created.body.conversationId;
  f.app.store.deleteConversation(id);
  f.app.store.createConversation({ id, title: 'Reused Room ID', participants: ['author'] });
  await f.close(); await f.start(); const before = f.count();
  const gone = await f.post(); assert.equal(gone.status, 410); assert.equal(gone.body.code, 'conversation_gone');
  assert.equal((await f.post({ ...f.payload, title: 'Different intent' })).body.code, 'idempotency_key_conflict'); assert.equal(f.count(), before);
});

test('mapping insert failure rolls back Room and participants; the same retry key remains available', async t => {
  const f = await fixture(t), before = f.count();
  f.app.store.db.exec("CREATE TRIGGER fail_planner_creation BEFORE INSERT ON chat_planner_room_creations BEGIN SELECT RAISE(ABORT, 'synthetic mapping failure'); END");
  const failed = await f.post(); assert.equal(failed.status, 500); assert.equal(f.count(), before);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM chat_planner_room_creations').get().n, 0);
  f.app.store.db.exec('DROP TRIGGER fail_planner_creation');
  assert.equal((await f.post()).status, 201); assert.equal(f.count(), before + 1);
});

for (const capability of ['replayPlannerRoomCreation', 'createPlannerConversation']) {
  test('missing planner creation capability fails closed, never falls back to ordinary creation: ' + capability, async t => {
    const f = await fixture(t), before = f.count(); f.app.store[capability] = undefined;
    const r = await f.post(); assert.equal(r.status, 501); assert.equal(r.body.code, 'planner_projection_unavailable'); assert.equal(f.count(), before);
  });
}
