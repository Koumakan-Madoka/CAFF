// Verification-only legacy schema-v1 project. Real management HTTP, native
// collector, SQLite, flag/sealing workers; simulated turn (no host SDK/tools/model).
// Not imported by the operator CLI or production composition. Cleans only its own
// temporary root; new production turns use the async Git snapshot collector.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const load = name => require('../../build/' + name);
module.exports = async function capturedFixture(t, mode, options = {}) {
  assert.equal(process.platform, 'linux'); assert.ok(['fresh', 'resume'].includes(mode));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-captured-workbench-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  // Optional shared disposable CAS lets the real operator CLI select both modes
  // from its single captureRoot. Each synthetic DB/message stays independent.
  const root = options.captureRoot || path.join(base, 'capture'), messageId = options.messageId || 'msg1';
  const target = path.join(base, 'target'), inputs = path.join(base, 'inputs');
  fs.mkdirSync(target); fs.mkdirSync(inputs); fs.writeFileSync(path.join(target, 'source.txt'), 'retained bytes');
  const session = [
    { type: 'session', version: 3, id: 'synthetic-session', timestamp: '2026-01-01T00:00:00.000Z', cwd: target },
    { type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:00.001Z', message: { role: 'user', content: 'synthetic retained history', timestamp: 1 } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n';
  const sessionPath = path.join(inputs, 'session.jsonl'); fs.writeFileSync(sessionPath, session);
  const dbOptions = { agentDir: base, sqlitePath: path.join(base, 'synthetic.sqlite') };
  let chat = load('lib/chat-app-store').createChatAppStore(dbOptions), server, authority;
  const { createLegacyNativeCaptureService } = require('../../tests/helpers/legacy-native-capture');
  const service = createLegacyNativeCaptureService({ captureRoot: root, chatStore: chat }, { readCallbackSource: true });
  const common = { host: '127.0.0.1', getAuthority: () => authority, csrfToken: 'synthetic-captured-workbench', projectManager: { listProjects: () => [{ id: 'p1' }] } };
  const capture = load('server/api/badcase-capture-controller').createBadcaseCaptureController({ ...common, service });
  let flagsController;
  function rebuildFlags() {
    const flags = load('server/domain/runtime/badcase-capture/badcase-flags').createBadcaseFlagService({ captureRoot: root, captureStore: service.store, chatStore: chat });
    flagsController = load('server/api/badcase-flags-controller').createBadcaseFlagsController({ ...common, service: flags,
      sealingService: load('server/domain/runtime/badcase-capture/sealing-service').createBadcaseSealingService({ flags, captureStore: service.store, databasePath: dbOptions.sqlitePath }) });
  }
  rebuildFlags();
  try {
    server = http.createServer(async (req, res) => {
      try {
        const context = { req, res, pathname: new URL(req.url, 'http://local').pathname };
        if (await capture(context) || await flagsController(context)) return;
        res.writeHead(404); res.end('{}');
      } catch (e) { res.writeHead(e.statusCode || 503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ issues: e.issues || [] })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); authority = `127.0.0.1:${server.address().port}`;
    async function api(url, body, expectedStatus = 200) {
      const response = await fetch('http://' + authority + url, { method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', Origin: 'http://' + authority, 'X-CAFF-CSRF-Token': common.csrfToken },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
      const value = await response.json(); assert.equal(response.status, expectedStatus); return value;
    }
    const route = '/api/projects/p1/badcase-capture';
    await api(route + '/authorize', { confirmed: true, authorizedDirs: [target], authorizedInputDirs: [inputs],
      includedIgnoredPatterns: [], excludedPatterns: service.loadPolicy('p1').excludedPatterns, callbackInputAuthorized: true });
    const estimate = await api(route + '/estimate', {}); assert.equal(estimate.complete, true);
    await api(route + '/enable', { confirmed: true, estimateId: estimate.estimateId });
    // The service now archives independently authorized pre-turn public state:
    // create the real queued-message shape before collecting, not after it.
    chat.saveCustomRoleConfig({ id: 'a1', name: 'Synthetic', personaPrompt: 'not executed' });
    chat.createConversation({ id: 'c1', title: 'Synthetic', participants: ['a1'], projectScopeId: 'p1' });
    const user = chat.createMessage({ id: 'user1', conversationId: 'c1', role: 'user', status: 'completed',
      turnId: 'accepted-turn', content: 'synthetic retained invocation', createdAt: '2026-01-01T00:00:00.000Z' });
    chat.createMessage({ id: messageId, conversationId: 'c1', role: 'assistant', status: 'queued', agentId: 'a1', turnId: 't1',
      content: 'Thinking...', createdAt: '2026-01-01T00:00:00.001Z' });
    const cpResult = service.captureTurnCheckpoint({ projectId: 'p1', conversationId: 'c1', turnId: 't1', agentId: 'a1',
      userMessageId: user.id, assistantMessageId: messageId, callbackUserMessage: user,
      targetDir: target, deliveryMode: mode, prompt: 'synthetic retained invocation', ...(mode === 'resume' ? { sessionPath } : {}), controlledValues: {},
      runConfig: { provider: 'anthropic', model: 'claude-sonnet-4-5', promptVersion: 'v1', skillIds: [], conversationSkillIds: [] },
      harness: { serverVersion: 'synthetic-captured-workbench', configSnapshot: { piVersion: 'pi:0.85.1', agentPromptVersion: 'v1',
        toolBridgeEnabled: false, deliveryMode: mode, agentName: 'synthetic' }, skillSnapshots: [] } });
    assert.equal(cpResult.captured, true); const cp = cpResult.checkpoint, r = cp.replayInput;
    assert.equal(r.complete, true, JSON.stringify(r.incompleteReasons));
    const callback = load('server/domain/runtime/badcase-capture/callback-input').readCapturedCallbackInput(cp, h => service.store.readBlob('p1', h));
    assert.equal(callback.association.assistantMessageId, messageId);
    assert.equal(JSON.parse(callback.trace).publicMessages[0].content, user.content);
    // Simulate mutation AFTER the checkpoint, not a real agent execution.
    fs.writeFileSync(path.join(target, 'source.txt'), 'after simulated turn'); fs.appendFileSync(sessionPath, 'POST-START\n');
    chat.updateMessage(messageId, { status: 'completed', taskId: 'task1', runId: 1,
      content: 'not archived', metadata: { badcaseCheckpointId: cp.checkpointId } });
    load('lib/sqlite-store').createSqliteRunStore({ agentDir: base, db: chat.db });
    chat.db.prepare(`INSERT INTO runs (id, agent_dir, cwd, prompt, prompt_length, status, started_at, task_id, assistant_errors_json)
      VALUES (1, '/not-read', '/not-read', 'not-read', 8, 'succeeded', '2026-01-01', 'task1', '[]')`).run();
    chat.db.prepare(`INSERT INTO a2a_tasks (id, run_id, kind, status, metadata_json, output_text, created_at, updated_at)
      VALUES ('task1', 1, 'conversation_agent_reply', 'succeeded', ?, 'RAW-NOT-ARCHIVED', '2026-01-01', '2026-01-01')`)
      .run(JSON.stringify({ conversationId: 'c1', turnId: 't1', agentId: 'a1' }));
    const flagRoute = '/api/projects/p1/conversations/c1/messages/' + messageId + '/badcase-flag';
    const body = { confirmed: true, actual: 'Synthetic incorrect draft', expected: 'Synthetic done output' };
    const marked = await api(flagRoute, body, 201); assert.equal(marked.seal.state, 'saved_incomplete');
    assert.equal(marked.seal.trajectory.reason, 'trajectory_provenance_unverified');
    assert.equal(marked.seal.trajectory.archived, false);
    const usage = service.computeUsage('p1'); assert.deepEqual((await api(flagRoute, body)).seal, marked.seal);
    assert.deepEqual(service.computeUsage('p1'), usage);
    chat.close(); chat = load('lib/chat-app-store').createChatAppStore(dbOptions); rebuildFlags();
    assert.deepEqual((await api(flagRoute)).seal, marked.seal);
    await api(route + '/disable', {}); assert.equal(service.loadPolicy('p1').status, 'disabled');
    const blobPath = h => path.join(root, 'projects/p1/blobs', h.slice(0, 2), h);
    assert.equal(fs.readFileSync(blobPath(cp.files['source.txt'].hash), 'utf8'), 'retained bytes');
    if (mode === 'resume') assert.equal(fs.readFileSync(blobPath(r.sessionBlobHash), 'utf8'), session);
    const caseText = fs.readFileSync(path.join(root, 'projects/p1/cases', require('node:crypto').createHash('sha256').update(messageId).digest('hex') + '.json'), 'utf8');
    assert.doesNotMatch(caseText, /RAW-NOT-ARCHIVED/);
    return { root, store: service.store, cp, r, blobPath, runDir: path.join(root, 'projects/p1/runReferences'),
      selection: { id: mode, projectId: 'p1', conversationId: 'c1', messageId },
      evidence: { collector: true, managementHttp: true, sqlite: true, flagHttp: true, rebuiltQuery: true,
        simulatedTurn: true, trajectoryArchived: false, usageBytes: usage.totalBytes } };
  } finally {
    if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    chat.close();
  }
};
