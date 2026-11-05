// Owned SQLite only; no live Room, production DB, SDK, model or capture enable.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const read = (...args) => require(base + 'callback-source').readPreTurnCallbackInput(...args);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-source-callback-'));
  const store = createChatAppStore({ agentDir: root, sqlitePath: path.join(root, 'owned.sqlite') });
  const disposers = [];
  t.after(() => { for (const dispose of disposers) dispose(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = store.getAgent('role-family-gpt');
  store.createConversation({ id: 'c1', title: 'Owned source', type: 'standard', projectScopeId: 'p1', participants: [agent.id], metadata: { marker: 'SOURCE' } });
  for (const [id, turnId, role, content, second, status] of [
    ['old', 'old-turn', 'assistant', 'Earlier reply', 0, 'completed'], ['user', 'accepted-turn', 'user', 'Question', 1, 'completed'],
    ['current', 't1', 'assistant', 'Thinking...', 2, 'queued']]) {
    store.createMessage({ id, conversationId: 'c1', turnId, role, agentId: role === 'assistant' ? agent.id : null,
      senderName: role === 'assistant' ? agent.name : 'You', content, status, metadata: id === 'old'
        ? { mentions: [agent.id], toolBridge: { lastPublicPostedAt: '2026-01-01T00:00:00.000Z', publicPostCount: 1, lastPublicMode: 'replace' } } : {} });
    store.db.prepare('UPDATE chat_messages SET created_at = ? WHERE id = ?').run(`2026-01-01T00:00:0${second}.000Z`, id);
  }
  const input = { projectId: 'p1', conversationId: 'c1', turnId: 't1', agentId: agent.id, userMessageId: 'user', assistantMessageId: 'current',
    callbackUserMessage: { id: 'user', content: 'Question', senderName: 'You', status: 'completed', createdAt: '2026-01-01T00:00:01.000Z', turnId: 'accepted-turn' } };
  const policy = { projectId: 'p1', status: 'enabled', callbackInputAuthorized: true };
  const capture = () => read(store, input, policy);
  return { root, store, input, policy, agent, capture, disposers };
}

test('source consent defaults false and is strict boolean, persisted without extending ordinary settings authorization', t => {
  const { createBadcaseCaptureService } = require(base + 'index');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-source-policy-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createBadcaseCaptureService({ captureRoot: root });
  assert.equal(service.loadPolicy('p1').callbackInputAuthorized, false);
  service.savePolicy('p1', { ...service.loadPolicy('p1'), callbackInputAuthorized: true });
  assert.equal(service.loadPolicy('p1').callbackInputAuthorized, false, 'ordinary save cannot grant source access');
  service.savePolicy('p1', { ...service.loadPolicy('p1'), callbackInputAuthorized: true }, { authorizeCallbackInput: true });
  assert.equal(createBadcaseCaptureService({ captureRoot: root }).loadPolicy('p1').callbackInputAuthorized, true);
  service.savePolicy('p1', { ...service.loadPolicy('p1'), callbackInputAuthorized: false });
  assert.equal(service.loadPolicy('p1').callbackInputAuthorized, true, 'ordinary settings preserve scope');
  service.savePolicy('p1', service.loadPolicy('p1'), { authorizeCallbackInput: false });
  assert.equal(service.loadPolicy('p1').callbackInputAuthorized, false);
});

test('disabled, suspended, unconsented, malformed or cross-project invocation reads zero source queries', () => {
  let touched = 0; const source = { get db() { touched++; throw Error('no source access'); } };
  const input = { projectId: 'p1', conversationId: 'c1', turnId: 't1', agentId: 'a1', userMessageId: 'u1', assistantMessageId: 'm1', callbackUserMessage: { id: 'u1', content: 'question', turnId: 'accepted-turn' } };
  for (const p of [{}, { projectId: 'p1', status: 'disabled', callbackInputAuthorized: true },
    { projectId: 'p1', status: 'suspended', callbackInputAuthorized: true }, { projectId: 'p1', status: 'enabled', callbackInputAuthorized: 'true' },
    { projectId: 'p2', status: 'enabled', callbackInputAuthorized: true }]) assert.equal(read(source, input, p), null);
  assert.equal(read(source, { ...input, conversationId: '../bad' }, { projectId: 'p1', status: 'enabled', callbackInputAuthorized: true }), null);
  assert.equal(read(source, { ...input, callbackUserMessage: { id: 'u1', content: 'question' } },
    { projectId: 'p1', status: 'enabled', callbackInputAuthorized: true }), null);
  assert.equal(touched, 0);
});

test('one read transaction captures exact supported public state and queued identity without mutating source', t => {
  const h = fixture(t), before = JSON.stringify(h.store.getConversation('c1'));
  const packet = h.capture(); assert.ok(packet, 'authorized source should produce a packet');
  const v = JSON.parse(packet.trace); assert.equal(v.publicMessages.length, 2); assert.equal(v.assistantCreatedAt, '2026-01-01T00:00:02.000Z');
  assert.equal(v.association.assistantMessageId, 'current'); assert.equal(v.publicMessages[0].publicPostCount, 1);
  assert.equal(v.publicMessages[0].publicPostMode, 'replace'); assert.deepEqual(v.publicMessages[0].mentions, [h.agent.id]);
  assert.equal(v.participants[0].name, h.agent.name); assert.equal(v.participants[0].description, h.agent.description);
  assert.deepEqual(v.conversation.metadata, h.store.getConversationWithoutMessages('c1').metadata); assert.deepEqual(v.privateMessages, []); assert.deepEqual(v.pendingDelegations, []);
  assert.equal(crypto.createHash('sha256').update(packet.trace).digest('hex'), packet.expectedTraceHash);
  assert.equal(JSON.stringify(h.store.getConversation('c1')), before); assert.equal(h.store.db.inTransaction, false);
  h.store.updateMessage('user', { content: 'Later question' }); assert.equal(h.capture(), null, 'changed prompt snapshot is not invented');
  assert.equal(JSON.parse(packet.trace).publicMessages[1].content, 'Question');
});

test('source scope, active assistant identity/status, prompt snapshot and participant constraints fail closed', t => {
  const h = fixture(t);
  for (const key of ['projectId', 'conversationId', 'turnId', 'agentId', 'userMessageId', 'assistantMessageId']) {
    assert.equal(read(h.store, { ...h.input, [key]: 'other' }, h.policy), null, key);
  }
  for (const value of [{ ...h.input.callbackUserMessage, content: 'Changed' }, { id: 'user' }, { id: 'other', content: 'Question' },
    { ...h.input.callbackUserMessage, createdAt: '2026-01-01T00:00:04.000Z' },
    { ...h.input.callbackUserMessage, turnId: 'different-accepted-turn' }, { ...h.input.callbackUserMessage, turnId: undefined }]) assert.equal(read(h.store, { ...h.input, callbackUserMessage: value }, h.policy), null);
  for (const [sql, undo] of [
    ["UPDATE chat_conversations SET project_scope_id='other' WHERE id='c1'", "UPDATE chat_conversations SET project_scope_id='p1' WHERE id='c1'"],
    ["UPDATE chat_messages SET status='running' WHERE id='current'", "UPDATE chat_messages SET status='queued' WHERE id='current'"],
    ["UPDATE chat_messages SET content='New output' WHERE id='current'", "UPDATE chat_messages SET content='Thinking...' WHERE id='current'"],
    ["UPDATE chat_messages SET status='queued' WHERE id='old'", "UPDATE chat_messages SET status='completed' WHERE id='old'"]]) {
    h.store.db.exec(sql); assert.equal(h.capture(), null, sql); h.store.db.exec(undo); assert.ok(h.capture());
  }
});

test('private or pending-delegation state refuses before selecting any message content; errors reveal no source text', t => {
  const h = fixture(t), original = h.store.db.prepare.bind(h.store.db), selected = [];
  h.store.db.prepare = sql => { selected.push(sql); return original(sql); };
  h.store.createPrivateMessage({ id: 'priv', conversationId: 'c1', turnId: 't1', senderAgentId: h.agent.id, senderName: h.agent.name,
    recipientAgentIds: [h.agent.id], content: 'PRIVATE_SOURCE_CANARY', metadata: {} });
  selected.length = 0; assert.equal(h.capture(), null);
  assert.equal(selected.some(sql => /SELECT[^]*\bcontent\b[^]*FROM chat_messages/i.test(sql) && !/length\(/i.test(sql)), false);
  h.store.db.exec("DELETE FROM chat_private_messages WHERE id='priv'");
  // Use the existing public API to create a pending task with no provider run.
  h.store.createAgentDelegation({ id: 'del1', idempotencyScope: 'scope', idempotencyKey: 'k', kind: 'group', aggregation: 'all',
    requesterConversationId: 'c1', requesterAgentId: h.agent.id, requesterAgentName: h.agent.name, requesterInvocationId: 'inv1',
    requesterTurnId: 't1', recipientConversationId: 'c1', recipientAgentId: h.agent.id, recipientAgentName: h.agent.name,
    request: {}, status: 'queued', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  selected.length = 0; assert.equal(h.capture(), null);
  assert.equal(selected.some(sql => /SELECT[^]*\bcontent\b[^]*FROM chat_messages/i.test(sql) && !/length\(/i.test(sql)), false);
  h.store.db.exec("DELETE FROM chat_agent_delegations WHERE id='del1'"); assert.ok(h.capture());
});

test('privateOnly, images, attachments, secret public text and malformed metadata are never partially projected', t => {
  const h = fixture(t), update = value => h.store.db.prepare('UPDATE chat_messages SET metadata_json=? WHERE id=?').run(value, 'old');
  for (const value of ['{bad', JSON.stringify({ privateOnly: true }), JSON.stringify({ visibility: 'private' }),
    JSON.stringify({ contentBlocks: [{ type: 'image', imageId: 'missing' }] }), JSON.stringify({ attachments: [{ path: '/not-authorized' }] }), JSON.stringify({ delegationId: 'completed-task' }),
    JSON.stringify({ crossConversationDeliveryId: 'incoming-delivery' })]) {
    update(value); assert.equal(h.capture(), null, value);
  }
  update('{}'); assert.ok(h.capture());
  h.store.updateMessage('old', { content: 'api_key=PUBLIC_SECRET_CANARY' }); assert.equal(h.capture(), null);
});

test('no truncation: oversized raw input or more than 2048 public messages is refused without loading content', t => {
  const h = fixture(t), original = h.store.db.prepare.bind(h.store.db); let selectedBodies = 0;
  h.store.db.prepare = sql => { if (sql.includes('SELECT id, turn_id AS turnId')) selectedBodies++; return original(sql); };
  h.store.db.prepare('UPDATE chat_messages SET content=? WHERE id=?').run('x'.repeat(2 * 1024 * 1024 + 1), 'old');
  assert.equal(h.capture(), null); assert.equal(selectedBodies, 0);
  h.store.db.prepare("UPDATE chat_messages SET content='Earlier reply' WHERE id='old'").run();
  const insert = h.store.db.prepare(`INSERT INTO chat_messages (id, conversation_id, turn_id, role, sender_name, content, status, metadata_json, created_at, updated_at)
    VALUES (?, 'c1', 'old-turn', 'user', 'You', 'x', 'completed', '{}', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`);
  h.store.db.transaction(() => { for (let i = 0; i < 2047; i++) insert.run(`extra${String(i).padStart(4, '0')}`); })();
  assert.equal(h.capture(), null); assert.equal(selectedBodies, 0); assert.equal(h.store.db.inTransaction, false);
});


test('Git snapshot facade authorized source → CAS → restart keeps distinct turn IDs and exact callback state (owned fixtures only)',
  { skip: !['win32', 'linux'].includes(process.platform) }, async t => {
  require('../helpers/windows-capture-environment').isolateWindowsCaptureEnvironment(t);
  const h = fixture(t), target = path.join(h.root, 'worktree'), sessions = path.join(h.root, 'sessions'), captureRoot = path.join(h.root, 'capture');
  fs.mkdirSync(target); fs.mkdirSync(sessions);
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(gitEnv, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(h.root, 'absent-global'), GIT_TEMPLATE_DIR: '' });
  const git = (...args) => require('node:child_process').execFileSync('git', ['-C', target, ...args], { windowsHide: true, env: gitEnv });
  git('init', '-q'); git('config', 'core.ignorecase', 'false'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(target, 'tracked'), 'original\n'); git('add', 'tracked');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.local', 'commit', '-qm', 'readable HEAD');
  fs.writeFileSync(path.join(target, 'tracked'), 'dirty\n'); fs.writeFileSync(path.join(target, 'untracked'), 'new');
  fs.writeFileSync(path.join(target, '.gitignore'), '');
  const { createBadcaseCaptureService } = require(base + 'index');
  const { readCapturedCallbackInput } = require(base + 'callback-input');
  const service = createBadcaseCaptureService({ captureRoot, chatStore: h.store });
  service.savePolicy('p1', { authorizedDirs: [target], authorizedInputDirs: [sessions], excludedPatterns: [] }, { authorizeCallbackInput: true });
  const policy = service.authorizeProject('p1'); assert.equal(policy.status, 'disabled');
  const sessionPath = path.join(sessions, 'turn.jsonl');
  fs.writeFileSync(sessionPath, [{ type: 'session', version: 3, id: 'original', cwd: target },
    { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'earlier', timestamp: 1 } }].map(x => JSON.stringify(x)).join('\n') + '\n');
  const value = mode => ({ ...h.input, targetDir: target, deliveryMode: mode, sessionPath: mode === 'resume' ? sessionPath : '', prompt: 'question',
    runConfig: { provider: 'test', model: 'test', promptVersion: 'v1', skillIds: [], conversationSkillIds: [] },
    harness: { serverVersion: 'test', configSnapshot: { toolBridgeEnabled: true, agentName: h.agent.name, agentPromptVersion: 'v1', deliveryMode: mode, piVersion: '0.85.1' }, skillSnapshots: [] },
    callbackInput: { trace: 'UNTRUSTED_PACKET_MUST_NOT_WIN' } });
  assert.equal((await service.captureTurnCheckpoint(value('fresh'))).reason, 'policy_not_enabled');
  // Only the throwaway fixture uses raw enabled. The real management switch
  // and automatic common-dir coverage are tested in badcase-git-configure.
  service.store.savePolicy({ ...policy, status: 'enabled' });
  for (const mode of ['fresh', 'resume']) {
    const result = await service.captureTurnCheckpoint(value(mode)); assert.equal(result.captured, true, result.reason);
    const reopened = createBadcaseCaptureService({ captureRoot }), cp = reopened.store.loadCheckpoint('p1', result.checkpointId);
    assert.ok(cp.replayInput.callbackInput, 'service must archive its constructor-owned authorized source');
    const captured = readCapturedCallbackInput(cp, hash => reopened.store.readBlob('p1', hash));
    assert.equal(captured.trace, h.capture().trace); assert.equal(cp.replayInput.deliveryMode, mode);
    assert.equal(cp.schemaVersion, 2); assert.equal(cp.gitSnapshot.kind, 'git-snapshot-v1');
    assert.equal(cp.strictEvalEligible, false);
    assert.match(reopened.store.readBlob('p1', cp.gitSnapshot.patchBlobHash).toString(), /\+dirty/);
    assert.equal(cp.files.untracked.hash, crypto.createHash('sha256').update('new').digest('hex'));
    assert.equal(captured.association.userMessageId, h.input.userMessageId); assert.equal(captured.association.assistantMessageId, h.input.assistantMessageId);
    if (mode === 'resume') assert.deepEqual(reopened.store.readBlob('p1', cp.replayInput.sessionBlobHash), fs.readFileSync(sessionPath));
    else assert.equal(cp.replayInput.sessionBlobHash, '');
    assert.ok(cp.integrity.knownLimitations.includes('no_atomic_snapshot'));
  }
  // The v2 Git turn collector must sanitize its constructor-owned callback
  // source before CAS publication, not merely its prompt/config metadata.
  const known = 'fixture-host-known-source-value-12345';
  h.store.updateMessage('old', { content: 'Earlier ' + known });
  const rawCallback = h.capture(), expectedTrace = rawCallback.trace.replaceAll(known, '[*]');
  const rawHash = rawCallback.expectedTraceHash, expectedHash = crypto.createHash('sha256').update(expectedTrace).digest('hex');
  const safeService = createBadcaseCaptureService({ captureRoot, chatStore: h.store, getKnownKeyValues: () => [known] });
  for (const mode of ['fresh', 'resume']) {
    const result = await safeService.captureTurnCheckpoint(value(mode)); assert.equal(result.captured, true, result.reason);
    const reopened = createBadcaseCaptureService({ captureRoot }), cp = reopened.store.loadCheckpoint('p1', result.checkpointId);
    assert.equal(cp.replayInput.callbackInput.blobHash, expectedHash);
    const bytes = reopened.store.readBlob('p1', expectedHash);
    assert.equal(bytes.includes(known), false); assert.equal(bytes.toString(), expectedTrace);
    assert.equal(bytes.length, Buffer.byteLength(expectedTrace)); assert.equal(reopened.store.hasBlob('p1', rawHash), false);
    assert.equal(cp.stats.newBlobBytes, mode === 'fresh' ? bytes.length : 0, 'account only redacted bytes, deduplicating the second callback');
    assert.equal(readCapturedCallbackInput(cp, h => reopened.store.readBlob('p1', h)).trace, expectedTrace);
    assert.equal(h.capture().trace, rawCallback.trace, 'source Room state remains unchanged');
  }
  const noSource = createBadcaseCaptureService({ captureRoot });
  const supplied = { ...value('fresh'), callbackInput: h.capture() };
  const noSourceResult = await noSource.captureTurnCheckpoint(supplied);
  assert.equal(noSourceResult.captured, true, noSourceResult.reason);
  const noSourceCp = noSource.store.loadCheckpoint('p1', noSourceResult.checkpointId);
  assert.equal(noSourceCp.replayInput.callbackInput, undefined, 'service without a trusted source never accepts invocation packets');
  assert.ok(noSourceCp.replayInput.incompleteReasons.includes('callback_input_unavailable'));
  assert.equal(noSourceCp.replayInput.complete, false);
  // Independent revocation persists disabled, and an enabled fixture without
  // consent still collects files but records a missing callback dimension.
  service.savePolicy('p1', service.loadPolicy('p1'), { authorizeCallbackInput: false });
  assert.equal(service.loadPolicy('p1').status, 'disabled');
  service.store.savePolicy({ ...service.loadPolicy('p1'), status: 'enabled' });
  const result = await service.captureTurnCheckpoint(value('fresh')); assert.equal(result.captured, true, result.reason);
  const cp = service.store.loadCheckpoint('p1', result.checkpointId); assert.equal(cp.replayInput.callbackInput, undefined);
  assert.ok(cp.replayInput.incompleteReasons.includes('callback_input_unavailable'));
  assert.equal(cp.replayInput.complete, false);
  assert.equal(fs.existsSync(path.join(captureRoot, 'projects/p1/.writer-lock')), false);
});

test('accepted user turn and execution turn remain distinct; either snapshot or assistant association drift is refused', t => {
  const h = fixture(t), packet = h.capture(); assert.ok(packet);
  const trace = JSON.parse(packet.trace);
  assert.equal(trace.association.turnId, 't1');
  assert.equal(trace.publicMessages.find(m => m.id === 'user').turnId, 'accepted-turn');
  h.store.db.prepare("UPDATE chat_messages SET turn_id='later-user-turn' WHERE id='user'").run();
  assert.equal(h.capture(), null, 'user snapshot turn must match its own source row');
  h.store.db.prepare("UPDATE chat_messages SET turn_id='accepted-turn' WHERE id='user'").run();
  h.store.db.prepare("UPDATE chat_messages SET turn_id='accepted-turn' WHERE id='current'").run();
  assert.equal(h.capture(), null, 'assistant must still match the actual execution turn');
  h.store.db.prepare("UPDATE chat_messages SET turn_id='t1' WHERE id IN ('user','current')").run();
  h.input.callbackUserMessage.turnId = 't1'; assert.ok(h.capture(), 'non-queued/direct same-turn source remains valid');
});

test('NULL legacy participant description projects to empty text, never a missing packet', t => {
  const h = fixture(t); h.store.db.prepare('UPDATE chat_agents SET description=NULL WHERE id=?').run(h.agent.id);
  const packet = h.capture(); assert.ok(packet);
  assert.equal(JSON.parse(packet.trace).participants[0].description, '');
});

test('real submit → queued-batch routing → original executor supplies both turn identities before the runtime stub starts', async t => {
  const h = fixture(t);
  h.store.db.exec("DELETE FROM chat_messages WHERE id IN ('user','current')");
  h.store.updateConversation('c1', { title: 'Queue regression' });
  const minimalPi = require('../../build/lib/minimal-pi'), original = minimalPi.startRun;
  const executorPath = require.resolve('../../build/server/domain/conversation/turn/agent-executor');
  const orchestratorPath = require.resolve('../../build/server/domain/conversation/turn-orchestrator');
  delete require.cache[executorPath]; delete require.cache[orchestratorPath];
  const calls = [], packets = [], captures = [], errors = [];
  minimalPi.startRun = () => {
    calls.push('startRun');
    const handle = new (require('node:events').EventEmitter)(); handle.runId = null; handle.sessionPath = '';
    handle.resultPromise = Promise.resolve({ reply: 'Owned stub reply.', runId: handle.runId, sessionPath: '', usage: null, heartbeatCount: 0 });
    return handle;
  };
  t.after(() => { minimalPi.startRun = original; delete require.cache[executorPath]; delete require.cache[orchestratorPath]; });
  const { createTurnOrchestrator } = require(orchestratorPath);
  const orchestrator = createTurnOrchestrator({ store: h.store, agentDir: h.root, sqlitePath: h.store.databasePath,
    resolveRuntimeParticipants: agents => agents.map(a => ({ ...a, runtimeConfig: { provider: 'deepseek', model: 'deepseek-v4-flash', thinking: 'off', skillIds: [] } })),
    skillRegistry: { listSkills: () => [], resolveSkills: () => [] }, modeStore: { get: () => null },
    modelCatalog: { getOptions: () => [{ provider: 'deepseek', model: 'deepseek-v4-flash', runtimeResolvable: true, supportedThinkingLevels: ['off'], input: ['text'] }] },
    host: '127.0.0.1', port: 0, toolBaseUrl: 'http://127.0.0.1:0', agentToolScriptPath: path.join(h.root, 'never-executed.cjs'),
    agentToolBridge: { createInvocationContext: input => input, registerInvocation: input => ({ ...input, invocationId: 'owned-invocation', callbackToken: 'owned-test-value', publicPostCount: 0 }), unregisterInvocation() {} },
    badcaseCapture: { captureTurnCheckpoint(input) { calls.push('capture'); captures.push(input); packets.push(read(h.store, input, h.policy)); return { captured: false, reason: 'source-only-test' }; } },
    broadcastEvent(_name, value) { if (value?.errorMessage) errors.push(value.errorMessage); },
  });
  const accepted = orchestrator.submitConversationMessage('c1', { content: 'Question' });
  assert.equal(accepted.dispatch, 'started');
  const deadline = Date.now() + 5000;
  while (orchestrator.listTurnSummaries({ conversationId: 'c1' }).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(orchestrator.listTurnSummaries({ conversationId: 'c1' }).length, 0, 'owned run settles');
  assert.equal(captures.length, 1, JSON.stringify(errors));
  const input = captures[0];
  assert.equal(input.userMessageId, accepted.acceptedMessage.id);
  assert.equal(input.callbackUserMessage.turnId, accepted.acceptedMessage.turnId);
  assert.notEqual(input.turnId, accepted.acceptedMessage.turnId, 'real queue keeps accepted and execution turns distinct');
  assert.equal(h.store.getMessage(input.assistantMessageId).turnId, input.turnId);
  assert.ok(packets[0], 'production-shaped queued invocation must produce a callback packet');
  const trace = JSON.parse(packets[0].trace);
  assert.equal(trace.association.turnId, input.turnId);
  assert.equal(trace.publicMessages.find(m => m.id === input.userMessageId).turnId, accepted.acceptedMessage.turnId);
  assert.deepEqual(calls, ['capture', 'startRun']);
});

test('read transaction gives one SQLite snapshot while a separate WAL connection changes the source; never borrows an outer transaction', t => {
  const h = fixture(t), Database = require('better-sqlite3'), writer = new Database(h.store.databasePath);
  h.disposers.push(() => writer.close());
  const original = h.store.db.prepare.bind(h.store.db); let changed = false;
  h.store.db.prepare = sql => {
    const statement = original(sql);
    if (!sql.includes('AS titleBytes')) return statement;
    return { get: (...args) => {
      const row = statement.get(...args);
      assert.equal(h.store.db.inTransaction, true);
      if (!changed) { changed = true; writer.prepare("UPDATE chat_messages SET content='Changed concurrently' WHERE id='old'").run(); }
      return row;
    } };
  };
  const packet = h.capture(); assert.ok(packet);
  assert.equal(JSON.parse(packet.trace).publicMessages[0].content, 'Earlier reply');
  assert.equal(h.store.getMessage('old').content, 'Changed concurrently');
  assert.equal(JSON.parse(h.capture().trace).publicMessages[0].content, 'Changed concurrently');
  h.store.db.transaction(() => assert.equal(h.capture(), null))();
});

test('raw header/participant limits, visibility aliases, malformed text blocks and unknown source adapters fail closed', t => {
  const h = fixture(t);
  assert.equal(read({ db: {} }, h.input, h.policy), null);
  for (const metadata of [{ visibility: ' Private ' }, { privateOnly: 'false' }, { contentBlocks: {} }, { contentBlocks: ['bad'] }]) {
    h.store.db.prepare('UPDATE chat_messages SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata), 'old'); assert.equal(h.capture(), null);
  }
  h.store.db.prepare("UPDATE chat_messages SET metadata_json='{}' WHERE id='old'").run();
  h.store.db.prepare('UPDATE chat_conversations SET metadata_json=? WHERE id=?').run(JSON.stringify({ x: 'y'.repeat(65536) }), 'c1');
  assert.equal(h.capture(), null); h.store.db.prepare("UPDATE chat_conversations SET metadata_json='{}' WHERE id='c1'").run();
  h.store.db.prepare('UPDATE chat_agents SET description=? WHERE id=?').run('x'.repeat(32 * (128 + 4096) + 1), h.agent.id);
  assert.equal(h.capture(), null); h.store.db.prepare('UPDATE chat_agents SET description=? WHERE id=?').run(h.agent.description, h.agent.id);
  assert.ok(h.capture());
});
