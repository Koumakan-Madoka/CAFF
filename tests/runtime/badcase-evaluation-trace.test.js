// Owned callback input states and real local HTTP/SQLite/CLI only; NO SDK/agent.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const parser = (...args) => require('../../build/server/domain/runtime/badcase-capture/evaluation-trace').prepareEvaluationCallbackTrace(...args);
function fixture(t, family = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-trace-input-')), services = [];
  t.after(async () => { for (const s of services) await s.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  let agent = { id: 'eval-agent', name: 'Archived Agent', description: 'Archived description' };
  if (family) {
    const store = createChatAppStore({ agentDir: root, sqlitePath: path.join(root, 'owned-source.sqlite') });
    try { const a = store.getAgent('role-family-gpt'); agent = { id: a.id, name: a.name, description: a.description }; } finally { store.close(); }
  }
  const message = (id, turnId, role, content, second) => ({ id, turnId, role,
    agentId: role === 'assistant' ? agent.id : null, senderName: role === 'assistant' ? agent.name : 'Original User', content,
    status: 'completed', createdAt: `2026-01-01T00:00:0${second}.000Z`, publicPostedAt: '', publicPostCount: 0, publicPostMode: '', mentions: [] });
  const trace = { schemaVersion: 1, kind: 'caff-evaluation-callback-input-v1',
    association: { projectId: 'project-original', conversationId: 'room-original', turnId: 'turn-original', agentId: agent.id,
      userMessageId: 'user-current', assistantMessageId: 'assistant-current' }, assistantCreatedAt: '2026-01-01T00:00:03.000Z',
    conversation: { title: 'Original title', type: 'standard', metadata: { approvedContextMarker: 'ORIGINAL_ROOM_METADATA' } },
    participants: [agent, { id: 'peer', name: 'Archived Peer', description: 'Peer description' }], publicMessages: [
      message('user-prior', 'turn-prior', 'user', 'Original prior user.', 0),
      { ...message('assistant-prior', 'turn-prior', 'assistant', 'Original prior reply.', 1),
        publicPostedAt: '2026-01-01T00:00:01.000Z', publicPostCount: 2, publicPostMode: 'append', mentions: ['peer'] },
      message('user-current', 'turn-original', 'user', 'Original current request.', 2)], privateMessages: [], pendingDelegations: [] };
  const input = () => { const raw = JSON.stringify(trace); return { directory: path.join(root, 'run'), trace: raw, expectedTraceHash: hash(raw),
    association: { ...trace.association }, lifetimeMs: 10000 }; };
  return { root, trace, services, input };
}
async function start(f, change = {}) { const s = await require('../../build/server/domain/runtime/badcase-capture/evaluation-callback').startEvaluationCallback({ ...f.input(), ...change }); f.services.push(s); return s; }
async function request(s, route, body, credentials = s.credentials) {
  const u = new URL(s.apiUrl + '/api/agent-tools/' + route);
  if (body === undefined) for (const [k, v] of Object.entries(credentials)) u.searchParams.set(k, v);
  const r = await fetch(u, { method: body === undefined ? 'GET' : 'POST', headers: { Connection: 'close', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify({ ...credentials, ...body }) }) });
  return { status: r.status, value: await r.json() };
}
function projection(m) { const { turnId, ...rest } = m; return rest; }

test('versioned input preserves every supported identity/message/time/metadata field and binds raw bytes and full association', t => {
  const f = fixture(t), i = f.input(), before = JSON.stringify(f.trace), p = parser(i.trace, i.expectedTraceHash, i.association);
  assert.deepEqual(p.trace, f.trace); assert.deepEqual(p.receipt.association, i.association);
  assert.equal(p.receipt.traceHash, i.expectedTraceHash); assert.equal(p.receipt.publicMessageCount, 3); assert.equal(p.receipt.participantCount, 2);
  assert.equal(p.receipt.faithfulReplay, false); assert.equal(p.receipt.strictEvalEligible, false);
  p.trace.conversation.title = 'mutated result'; assert.equal(JSON.stringify(f.trace), before);
  assert.throws(() => parser(i.trace + ' ', i.expectedTraceHash, i.association), { code: 'evaluation_trace_hash_mismatch' });
  for (const k of Object.keys(i.association)) assert.throws(() => parser(i.trace, i.expectedTraceHash, { ...i.association, [k]: 'other' }), { code: 'evaluation_trace_association_mismatch' });
});

test('actual HTTP and original CLI read imported full public history/participants, then isolated DB receives output and survives restart', async t => {
  const f = fixture(t), original = structuredClone(f.trace), s = await start(f);
  assert.equal(s.traceReceipt.traceHash, f.input().expectedTraceHash);
  f.trace.publicMessages[0].content = 'caller changed'; f.trace.participants[0].name = 'caller changed';
  const r = await request(s, 'context'); assert.equal(r.status, 200);
  assert.deepEqual(r.value.publicMessages, original.publicMessages.map(projection));
  assert.equal(r.value.latestUserMessage.id, original.association.userMessageId);
  assert.deepEqual(r.value.agent, { id: original.participants[0].id, name: original.participants[0].name });
  assert.equal(r.value.conversation.id, original.association.conversationId);
  assert.equal(r.value.conversation.title, original.conversation.title);
  assert.deepEqual(r.value.conversation.metadata, original.conversation.metadata);
  assert.deepEqual(r.value.privateMessages, []); assert.deepEqual(r.value.pendingDelegations, []);
  const participants = (await request(s, 'participants')).value.participants;
  assert.deepEqual(participants.map(({ id, name, description }) => ({ id, name, description })), original.participants);
  const child = require('node:child_process').spawn(process.execPath, [path.resolve(__dirname, '../../build/lib/agent-chat-tools.js'), 'read-context'], {
    env: { PATH: process.env.PATH, CAFF_CHAT_API_URL: s.apiUrl, CAFF_CHAT_INVOCATION_ID: s.credentials.invocationId, CAFF_CHAT_CALLBACK_TOKEN: s.credentials.callbackToken }, stdio: ['ignore', 'pipe', 'pipe'] });
  const cli = await new Promise((resolve, reject) => { let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); });
  assert.equal(cli.code, 0, cli.stderr); assert.deepEqual(JSON.parse(cli.stdout).publicMessages, original.publicMessages.map(projection));
  assert.equal((await request(s, 'post-message', { visibility: 'public', content: 'New isolated output.', noFinalize: true })).status, 200);
  assert.equal((await request(s, 'context')).value.publicMessages.at(-1).id, original.association.assistantMessageId);
  await s.stop();
  const store = createChatAppStore({ agentDir: path.dirname(s.databasePath), sqlitePath: s.databasePath });
  try {
    for (const m of original.publicMessages) { const actual = store.getMessage(m.id); assert.equal(actual.content, m.content); assert.equal(actual.turnId, m.turnId); assert.equal(actual.createdAt, m.createdAt); }
    assert.equal(store.getMessage(original.association.assistantMessageId).content, 'New isolated output.');
    assert.equal(store.getMessage(original.association.assistantMessageId).createdAt, original.assistantCreatedAt);
  } finally { store.close(); }
  for (const name of fs.readdirSync(path.dirname(s.databasePath))) if (fs.statSync(path.join(path.dirname(s.databasePath), name)).isFile()) {
    const b = fs.readFileSync(path.join(path.dirname(s.databasePath), name)); assert.equal(b.includes(Buffer.from(s.credentials.callbackToken)), false); assert.equal(b.includes(Buffer.from(s.credentials.invocationId)), false);
  }
});

test('archived model-family identity is preserved, never rewritten as a custom role or silently renamed', async t => {
  const f = fixture(t, true), s = await start(f), r = await request(s, 'context');
  assert.equal(r.value.agent.id, 'role-family-gpt'); assert.equal(r.value.agent.name, f.trace.participants[0].name);
  await s.stop(); const store = createChatAppStore({ agentDir: path.dirname(s.databasePath), sqlitePath: s.databasePath });
  try { assert.equal(store.getAgent('role-family-gpt').roleKind, 'model_family'); } finally { store.close(); }
  for (const change of [v => { v.participants[0].name = 'Forged identity'; }, v => { v.participants[0].description = 'Different identity'; },
    v => { v.participants[0].id = v.association.agentId = v.publicMessages[1].agentId = 'role-family-unknown'; }]) {
    const g = fixture(t, true); change(g.trace);
    await assert.rejects(start(g), /evaluation_callback_(storage_failed|identity_mismatch)|evaluation_trace_association_mismatch/);
  }
});

test('binary timestamp/id ordering and context windows match the existing bridge instead of reordering or collapsing to a seed', async t => {
  const f = fixture(t), template = f.trace.publicMessages[0];
  f.trace.publicMessages = Array.from({ length: 25 }, (_, n) => ({ ...template, id: 'message-' + String(n).padStart(2, '0'),
    content: 'Retained message ' + n, createdAt: template.createdAt }));
  f.trace.publicMessages[24] = { ...f.trace.publicMessages[24], id: 'user-current', turnId: f.trace.association.turnId };
  const s = await start(f), response = await request(s, 'context');
  assert.deepEqual(response.value.publicMessages, f.trace.publicMessages.slice(-24).map(projection));
  const url = new URL(s.apiUrl + '/api/agent-tools/context'); for (const [k, v] of Object.entries(s.credentials)) url.searchParams.set(k, v);
  url.searchParams.set('publicLimit', '1');
  const limited = await (await fetch(url, { headers: { Connection: 'close' } })).json();
  assert.deepEqual(limited.publicMessages, [projection(f.trace.publicMessages.at(-1))]);
  await s.stop(); const store = createChatAppStore({ agentDir: path.dirname(s.databasePath), sqlitePath: s.databasePath });
  try { assert.equal(store.listMessages(f.trace.association.conversationId).length, 26); } finally { store.close(); }
});

test('two copies of identical trace have new callback identities/databases; no cross-auth, output or source mutation', async t => {
  const f = fixture(t), before = f.input().trace, a = await start(f), b = await start(f, { directory: path.join(f.root, 'run-b') });
  assert.notEqual(a.databasePath, b.databasePath); assert.notEqual(a.apiUrl, b.apiUrl); assert.notDeepEqual(a.credentials, b.credentials);
  assert.deepEqual(a.traceReceipt, b.traceReceipt);
  assert.equal((await request(b, 'context', undefined, a.credentials)).status, 401);
  assert.equal((await request(a, 'post-message', { visibility: 'public', content: 'Only A.', noFinalize: true })).status, 200);
  assert.equal(JSON.stringify((await request(b, 'context')).value).includes('Only A.'), false); assert.equal(f.input().trace, before);
});

test('missing, mixed seed, corrupt, forged association or unsupported private/delegation/image input never creates a directory', async t => {
  const f = fixture(t), good = f.input(), changes = [
    { trace: undefined }, { trace: '' }, { trace: '{' }, { expectedTraceHash: '0'.repeat(64) },
    { association: { ...good.association, turnId: 'other' } }, { seed: {} }, { sqlitePath: '/production' }, { lifetimeMs: 0 },
  ];
  for (const change of changes) { await assert.rejects(start(f, change)); assert.equal(fs.existsSync(good.directory), false); }
  for (const change of [v => v.privateMessages.push({ content: 'private' }), v => v.pendingDelegations.push({ id: 'pending' }),
    v => { v.publicMessages[0].images = []; }, v => { v.association.assistantMessageId = v.publicMessages[0].id; },
    v => { v.publicMessages[0].role = 'private'; }, v => { v.publicMessages[1].agentId = 'unknown'; },
    v => { v.publicMessages[0].id = v.publicMessages[1].id; }, v => { v.publicMessages[0].createdAt = '2027-01-01T00:00:00.000Z'; },
    v => { v.publicMessages[2].turnId = 'wrong'; }, v => { v.publicMessages[0].publicPostCount = -1; },
    v => { v.publicMessages[0].createdAt = '2026-02-31T00:00:00.000Z'; }, v => { v.participants.push(v.participants[0]); },
    v => { v.publicMessages[0].content = '\ud800'; }, v => { v.publicMessages[0].senderName = ' padded '; }, v => { v.participants[0].name = ' padded '; },
    v => { v.participants[0].description = ' padded '; }, v => { delete v.assistantCreatedAt; },
    v => { v.assistantCreatedAt = v.publicMessages[0].createdAt; }, v => { v.publicMessages[0].createdAt = v.publicMessages[1].createdAt; }]) {
    const v = structuredClone(f.trace); change(v); const trace = JSON.stringify(v);
    await assert.rejects(start(f, { trace, expectedTraceHash: hash(trace) })); assert.equal(fs.existsSync(good.directory), false);
  }
});

test('secret sentinels, short credential assignments, nested JSON and private metadata fail before filesystem effects', async t => {
  const f = fixture(t);
  for (const change of [v => { v.publicMessages[0].content = 'sk-' + 'a'.repeat(30); },
    v => { v.publicMessages[0].content = 'api_key=short'; }, v => { v.publicMessages[0].content = 'VENDOR_API_KEY=short'; },
    v => { v.publicMessages[0].content = JSON.stringify({ callbackToken: 'short' }); },
    v => { v.conversation.metadata.credentials = { value: 'short' }; }, v => { v.conversation.metadata.privateOnly = true; },
    v => { v.conversation.metadata.visibility = 'private'; }, v => { v.conversation.metadata.broken = '\ud800'; }]) {
    const v = structuredClone(f.trace); change(v); const trace = JSON.stringify(v);
    await assert.rejects(start(f, { trace, expectedTraceHash: hash(trace) }), { code: 'evaluation_trace_sensitive' }); assert.equal(fs.existsSync(f.input().directory), false);
  }
});

test('fixed Docker distribution includes the new callback input validator; no runtime discovery or install is required', () => {
  const inventory = require('../../scripts/badcase-capture/evaluation-bridge-files.json');
  assert.equal(inventory.build.filter(p => p === 'build/server/domain/runtime/badcase-capture/evaluation-trace.js').length, 1);
  assert.match(fs.readFileSync(path.resolve(__dirname, '../../build/server/domain/runtime/badcase-capture/evaluation-callback.js'), 'utf8'), /require\("\.\/evaluation-trace"\)/);
});

test('count, byte and recursion limits are explicit, never truncation or a synthesized single seed', t => {
  const f = fixture(t), check = v => { const raw = JSON.stringify(v); return parser(raw, hash(raw), v.association); };
  for (const change of [v => { v.publicMessages[0].content = 'a'.repeat(32769); },
    v => { v.participants = Array.from({ length: 33 }, (_, n) => ({ ...v.participants[0], id: 'agent-' + n })); v.association.agentId = v.participants[0].id; v.publicMessages[1].agentId = v.participants[0].id; },
    v => { v.publicMessages = Array.from({ length: 2049 }, (_, n) => ({ ...v.publicMessages[0], id: 'message-' + n })); },
    v => { let x = v.conversation.metadata; for (let i = 0; i < 40; i++) x = x.next = {}; }]) {
    const v = structuredClone(f.trace); change(v); assert.throws(() => check(v), /evaluation_trace_(invalid|limit)/);
  }
  const raw = ' '.repeat(4 * 1024 * 1024 + 1); assert.throws(() => parser(raw, hash(raw), f.trace.association), { code: 'evaluation_trace_limit' });
});
