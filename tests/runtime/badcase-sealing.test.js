const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCaptureStore, sha256Hex } = require('../../build/server/domain/runtime/badcase-capture/capture-store');
const { createBadcaseFlagService } = require('../../build/server/domain/runtime/badcase-capture/badcase-flags');
function setup(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-sealing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createCaptureStore({ captureRoot: root });
  const association = { projectId: 'p1', conversationId: 'c1', messageId: 'm1', turnId: 't1', agentId: 'a1', taskId: 'task1', checkpointId: 'cp1', runId: 1 };
  const message = { id: 'm1', conversationId: 'c1', role: 'assistant', status: 'completed', turnId: 't1', agentId: 'a1', taskId: 'task1', runId: 1, metadata: { badcaseCheckpointId: 'cp1' } };
  const bytes = Buffer.from('synthetic file'); const hash = sha256Hex(bytes); store.writeBlob('p1', hash, bytes);
  store.saveCheckpoint('p1', { schemaVersion: 1, projectId: 'p1', conversationId: 'c1', checkpointId: 'cp1', turnId: 't1', agentId: 'a1', files: { 'file.txt': { type: 'file', hash, size: bytes.length } }, deletions: ['deleted.txt'], replayInput: { deliveryMode: 'resume', complete: false, incompleteReasons: ['session_missing'], harness: { skillSnapshots: [] } }, strictEvalEligible: false });
  const flags = createBadcaseFlagService({ captureRoot: root, captureStore: store, chatStore: { getConversationWithoutMessages: () => ({ projectScopeId: 'p1' }), getMessage: () => message } });
  const input = { projectId: 'p1', conversationId: 'c1', messageId: 'm1', actual: 'bad', expected: 'good' };
  let reads = 0;
  const options = { flags, captureStore: store, databasePath: path.join(root, 'unused.sqlite'), readTrajectory: async () => { reads++; return { association, totalTaskEventCount: 3, archivedEventCount: 2, task: { output: 'UNVERIFIED-TEXT-DO-NOT-ARCHIVE' }, events: [] }; }, ...overrides };
  const create = () => require('../../build/server/domain/runtime/badcase-capture/sealing-service').createBadcaseSealingService(options);
  return { root, store, flags, message, input, hash, options, create, reads: () => reads };
}
test('mark directly seals an immutable checkpoint; raw trajectory is omitted and incompleteness is explicit', async t => {
  const h = setup(t), service = h.create();
  const result = await service.mark(h.input);
  assert.equal(result.created, true); assert.equal(result.flag.sealState, 'pending');
  assert.equal(result.seal.state, 'saved_incomplete'); assert.equal(result.seal.checkpointSaved, true);
  assert.equal(result.seal.complete, false); assert.equal(result.seal.runnable, false);
  assert.ok(result.seal.missingEvidence.includes('trajectory_content_not_archived'));
  assert.equal(h.reads(), 1);
  const files = fs.readdirSync(path.join(h.root, 'projects/p1/cases'));
  assert.equal(files.length, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(h.root, 'projects/p1/cases', files[0]), 'utf8'), /UNVERIFIED-TEXT/);
});
test('same mark retries and service reconstruction reuse the exact case; GET does not read trajectory or write', async t => {
  const h = setup(t), first = await h.create().mark(h.input), before = h.store.computeUsage('p1');
  const second = await h.create().mark(h.input);
  assert.equal(second.created, false); assert.deepEqual(second.seal, first.seal);
  assert.deepEqual(h.create().get(h.input).seal, first.seal);
  assert.equal(h.reads(), 1); assert.deepEqual(h.store.computeUsage('p1'), before);
  assert.ok(before.bytesByKind.cases > 0);
});
test('insufficient capacity refuses seal but keeps the marker, and retry can recover', async t => {
  const h = setup(t); h.store.savePolicy({ ...h.store.loadPolicy('p1'), stagingQuotaBytes: 1 });
  const failed = await h.create().mark(h.input);
  assert.equal(failed.seal.state, 'failed'); assert.equal(failed.seal.reason, 'seal_quota_exceeded');
  assert.ok(h.flags.get(h.input)); assert.equal(fs.existsSync(path.join(h.root, 'projects/p1/retention')), false);
  h.store.savePolicy({ ...h.store.loadPolicy('p1'), stagingQuotaBytes: 10 * 1024 * 1024 });
  assert.equal((await h.create().mark(h.input)).seal.state, 'saved_incomplete');
});
test('missing frozen identity and later-invalid source never silently rebind or read trajectory', async t => {
  const h = setup(t); delete h.message.taskId;
  const result = await h.create().mark(h.input);
  assert.equal(result.seal.state, 'unavailable'); assert.equal(result.seal.reason, 'flag_seal_association_incomplete');
  assert.equal(h.reads(), 0); assert.equal(h.create().get(h.input).seal.state, 'unavailable');
  const other = setup(t); other.flags.mark(other.input); delete other.message.taskId;
  assert.equal((await other.create().mark(other.input)).seal.reason, 'flag_seal_association_mismatch');
  assert.equal(other.reads(), 0);
});
test('sensitive trajectory rejection preserves checkpoint only; errors never expose raw dependency text', async t => {
  const h = setup(t, { readTrajectory: async () => { throw Object.assign(Error('PRIVATE-ERROR'), { code: 'trajectory_private_content' }); } });
  const result = await h.create().mark(h.input);
  assert.equal(result.seal.state, 'saved_incomplete');
  assert.equal(result.seal.trajectory.reason, 'trajectory_private_content');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-ERROR/);
});
test('worker failure leaves a retryable marker; reconstruction never infers a successful seal', async t => {
  const h = setup(t, { sealCheckpoint: async () => { throw Error('PRIVATE-PATH'); } });
  assert.equal((await h.create().mark(h.input)).seal.state, 'failed');
  assert.equal(h.create().get(h.input).seal.state, 'not_saved');
  assert.ok(h.flags.get(h.input));
  delete h.options.sealCheckpoint;
  assert.equal((await h.create().mark(h.input)).seal.state, 'saved_incomplete');
});
test('missing or corrupt referenced blob cannot publish a case; existing saved case is revalidated on retry', async t => {
  const h = setup(t); const first = await h.create().mark(h.input);
  assert.equal(first.seal.state, 'saved_incomplete');
  fs.writeFileSync(path.join(h.root, 'projects/p1/blobs', h.hash.slice(0, 2), h.hash), 'corrupt');
  const retry = await h.create().mark(h.input);
  assert.equal(retry.seal.state, 'failed'); assert.equal(retry.seal.reason, 'retention_blob_corrupt');
});
test('simultaneous identical requests converge and unrelated annotations cannot replace the first mark', async t => {
  const h = setup(t), service = h.create();
  const results = await Promise.all([service.mark(h.input), service.mark(h.input)]);
  assert.deepEqual(results[0].seal, results[1].seal); assert.equal(h.reads(), 1);
  await assert.rejects(service.mark({ ...h.input, actual: 'different' }), e => e.code === 'flag_already_exists');
});

test('wiki dependency failures preserve the saved annotation and seal with an explicit wikiCase error', async t => {
  for (const mode of ['missing-message', 'add-failure']) {
    const h = setup(t); let writes = 0;
    h.options.wikiStore = { addMarkedCase() { writes++; throw Error('PRIVATE-WIKI-PATH'); } };
    h.options.chatStore = { getMessage: () => mode === 'missing-message' ? null : { ...h.message, content: 'source body' },
      getConversationWithoutMessages: () => ({ title: '标记房间' }) };
    const result = await h.create().mark(h.input);
    assert.equal(result.seal.state, 'saved_incomplete');
    assert.deepEqual(result.wikiCase, { error: 'wiki_case_unavailable' });
    assert.ok(h.flags.get(h.input)); assert.equal(writes, mode === 'missing-message' ? 0 : 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-WIKI-PATH/);
  }
});
test('marked wiki case keeps a UTF-8-safe source message excerpt and truncation flag across restart', async t => {
  const h = setup(t); h.message.content = '前' + '字'.repeat(20000) + '后';
  const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
  const config = { globalRoot: path.join(h.root, 'global-wiki'), sourceWorktree: path.join(h.root, 'source') };
  h.options.wikiStore = createWikiStore(config);
  h.options.chatStore = { getMessage: () => h.message, getConversationWithoutMessages: () => ({ title: '标记房间' }) };
  const result = await h.create().mark(h.input), saved = result.wikiCase.case;
  assert.equal(saved.messageTruncated, true); assert.ok(saved.message.startsWith('前'));
  assert.ok(Buffer.byteLength(saved.message) <= 32768); assert.doesNotMatch(saved.message, /\uFFFD/);
  assert.equal(saved.message.includes('后'), false); assert.equal(saved.traceState, 'missing');
  assert.deepEqual(createWikiStore(config).read().cases.find(c => c.id === saved.id), saved);
});
test('unreadable inventory is not treated as empty and leaves no retention or case', async t => {
  const h = setup(t); fs.writeFileSync(path.join(h.root, 'projects/p1/latest'), 'invalid category');
  const result = await h.create().mark(h.input);
  assert.equal(result.seal.state, 'failed'); assert.equal(result.seal.reason, 'capture_usage_unavailable');
  assert.ok(h.flags.get(h.input)); assert.equal(fs.existsSync(path.join(h.root, 'projects/p1/retention')), false);
});
test('case publication failure leaves a protected reference and retry publishes exactly once', t => {
  const h = setup(t), flag = h.flags.mark(h.input).flag;
  const { saveSealedCase, readSealedCase } = require('../../build/server/domain/runtime/badcase-capture/sealed-case');
  const req = { captureRoot: h.root, flagId: flag.flagId, association: flag.sealAssociation, trajectory: { reason: 'trajectory_unavailable' } };
  const original = fs.linkSync;
  try {
    fs.linkSync = (source, target) => { if (String(target).includes(`${path.sep}cases${path.sep}`)) throw Object.assign(Error('PRIVATE-PATH'), { code: 'ENOSPC' }); return original(source, target); };
    assert.throws(() => saveSealedCase(req), e => e.code === 'seal_write_failed');
  } finally { fs.linkSync = original; }
  assert.equal(readSealedCase(req), null);
  assert.equal(fs.readdirSync(path.join(h.root, 'projects/p1/retention')).length, 1);
  const saved = saveSealedCase(req);
  assert.deepEqual(saveSealedCase(req), saved);
  assert.equal(fs.readdirSync(path.join(h.root, 'projects/p1/cases')).length, 1);
  assert.equal(fs.existsSync(path.join(h.root, 'projects/p1/.writer-lock')), false);
});
test('association is revalidated after async read; missing fields cannot publish under frozen old keys', async t => {
  const h = setup(t);
  h.options.readTrajectory = async () => { delete h.message.taskId; return { totalTaskEventCount: 0, archivedEventCount: 0 }; };
  assert.equal((await h.create().mark(h.input)).seal.reason, 'flag_seal_association_mismatch');
  assert.equal(fs.existsSync(path.join(h.root, 'projects/p1/retention')), false);
});
test('project lock blocks collector, policy and marker writers across processes; never reclaims a crash lock', async t => {
  const h = setup(t); const flag = h.flags.mark(h.input).flag;
  const lock = path.join(h.root, 'projects/p1/.writer-lock'); fs.mkdirSync(lock);
  assert.throws(() => h.store.savePolicy(h.store.loadPolicy('p1')), e => e.code === 'capture_writer_busy');
  assert.equal(h.flags.mark(h.input).created, false, 'immutable retry needs no writer lock');
  h.message.id = 'm2';
  assert.throws(() => h.flags.mark({ ...h.input, messageId: 'm2' }), e => e.code === 'capture_writer_busy');
  const collector = require('../../build/server/domain/runtime/badcase-capture/collector').createCollector({ store: h.store });
  assert.equal(collector.captureTurnCheckpoint({ projectId: 'p1' }).reason, 'capture_writer_busy');
  await assert.rejects(require('../../build/server/domain/runtime/badcase-capture/sealing-process').sealCheckpointAsync({ captureRoot: h.root, flagId: flag.flagId, association: flag.sealAssociation }), e => e.code === 'capture_writer_busy');
  assert.ok(fs.existsSync(lock)); fs.rmdirSync(lock); // test-owned lock only
});
test('damaged case cannot be overwritten or read as successful, including unexpected fields', async t => {
  const h = setup(t); await h.create().mark(h.input);
  const dir = path.join(h.root, 'projects/p1/cases'), file = path.join(dir, fs.readdirSync(dir)[0]);
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  envelope.record.extra = 'not permitted'; envelope.checksum = sha256Hex(JSON.stringify(envelope.record));
  fs.writeFileSync(file, JSON.stringify(envelope)); const before = fs.readFileSync(file);
  assert.equal(h.create().get(h.input).seal.reason, 'seal_record_invalid');
  assert.equal((await h.create().mark(h.input)).seal.reason, 'seal_record_invalid');
  assert.deepEqual(fs.readFileSync(file), before);
});
test('missing blobs prevent first publication, and exact retention plus case bytes are reserved together', async t => {
  const broken = setup(t);
  fs.unlinkSync(path.join(broken.root, 'projects/p1/blobs', broken.hash.slice(0, 2), broken.hash));
  assert.equal((await broken.create().mark(broken.input)).seal.reason, 'retention_blob_missing');
  assert.equal(fs.existsSync(path.join(broken.root, 'projects/p1/cases')), false);
  const sample = setup(t); await sample.create().mark(sample.input);
  const cost = sample.store.computeUsage('p1').bytesByKind;
  const h = setup(t); h.flags.mark(h.input);
  const before = h.store.computeUsage('p1');
  h.store.savePolicy({ ...h.store.loadPolicy('p1'), stagingQuotaBytes: before.totalBytes + cost.cases + cost.retention - 1 });
  assert.equal((await h.create().mark(h.input)).seal.reason, 'seal_quota_exceeded');
  assert.deepEqual(h.store.computeUsage('p1'), before);
  assert.equal(fs.existsSync(path.join(h.root, 'projects/p1/retention')), false);
});
test('file worker strips Node preload hooks and never receives arbitrary trajectory text', async t => {
  const h = setup(t); const prior = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--require /must-not-exist/caff-seal-preload.cjs';
  try { assert.equal((await h.create().mark(h.input)).seal.state, 'saved_incomplete'); }
  finally { if (prior === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = prior; }
});
test('a new Node process reads the published case without writes after the live checkpoint disappears', async t => {
  const h = setup(t), first = await h.create().mark(h.input);
  const { spawnSync } = require('node:child_process');
  const modulePath = path.resolve(__dirname, '../../build/server/domain/runtime/badcase-capture/sealed-case');
  const request = { captureRoot: h.root, flagId: first.flag.flagId, association: first.flag.sealAssociation };
  fs.rmSync(path.join(h.root, 'projects/p1/checkpoints'), { recursive: true });
  const before = h.store.computeUsage('p1');
  const script = `const fs=require('node:fs'); const api=require(process.argv[1]); process.stdout.write(JSON.stringify(api.readSealedCase(JSON.parse(fs.readFileSync(0,'utf8')))));`;
  const child = spawnSync(process.execPath, ['-e', script, modulePath], { input: JSON.stringify(request), encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), first.seal);
  assert.deepEqual(h.store.computeUsage('p1'), before);
  assert.deepEqual((await h.create().mark(h.input)).seal, first.seal, 'retry uses retained copy, not a mutable live checkpoint');
  assert.deepEqual(h.store.computeUsage('p1'), before);
});
test('static case symlink is rejected on GET and retry without replacing the target', async t => {
  const h = setup(t); await h.create().mark(h.input);
  const dir = path.join(h.root, 'projects/p1/cases'), file = path.join(dir, fs.readdirSync(dir)[0]);
  const outside = path.join(h.root, 'original-case.json'); fs.renameSync(file, outside);
  try { fs.symlinkSync(outside, file); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('symlink privilege unavailable'); return; } throw error; }
  const before = fs.readFileSync(outside);
  assert.equal(h.create().get(h.input).seal.reason, 'seal_record_invalid');
  assert.equal((await h.create().mark(h.input)).seal.reason, 'seal_record_invalid');
  assert.deepEqual(fs.readFileSync(outside), before);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
});
test('real HTTP POST invokes readonly SQLite reader and file worker; restart GET is read-only', async t => {
  const h = setup(t);
  const { createChatAppStore } = require('../../build/lib/chat-app-store');
  const { createBadcaseFlagsController } = require('../../build/server/api/badcase-flags-controller');
  const http = require('node:http');
  const databasePath = path.join(h.root, 'chat.sqlite');
  let chat = createChatAppStore({ agentDir: h.root, sqlitePath: databasePath });
  let server;
  try {
    chat.saveCustomRoleConfig({ id: 'a1', name: 'Synthetic', personaPrompt: 'test' });
    chat.createConversation({ id: 'c1', title: 'Synthetic', participants: ['a1'], projectScopeId: 'p1' });
    chat.createMessage({ ...h.message, content: 'MESSAGE-BODY-NOT-ARCHIVED' });
    require('../../build/lib/sqlite-store').createSqliteRunStore({ agentDir: h.root, db: chat.db });
    chat.db.prepare(`INSERT INTO runs (id, agent_dir, cwd, prompt, prompt_length, status, started_at, task_id, assistant_errors_json) VALUES (1, '/not-read', '/not-read', 'not archived', 12, 'succeeded', '2026-01-01', 'task1', '[]')`).run();
    chat.db.prepare(`INSERT INTO a2a_tasks (id, run_id, kind, status, metadata_json, output_text, created_at, updated_at) VALUES ('task1', 1, 'conversation_agent_reply', 'succeeded', ?, 'RAW-OUTPUT-NOT-ARCHIVED', '2026-01-01', '2026-01-01')`).run(JSON.stringify({ conversationId: 'c1', turnId: 't1', agentId: 'a1' }));
    chat.db.prepare(`INSERT INTO a2a_task_events (task_id, event_type, event_json, created_at) VALUES ('task1', 'agent_tool_call', ?, '2026-01-01')`).run(JSON.stringify({ tool: 'read', result: 'RAW-TOOL-NOT-ARCHIVED' }));
    const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
    const wikiStore = createWikiStore({ globalRoot: path.join(h.root, 'global-wiki'), sourceWorktree: path.join(h.root, 'source') });
    h.options.wikiStore = wikiStore;
    const rebuild = () => {
      h.options.flags = createBadcaseFlagService({ captureRoot: h.root, captureStore: h.store, chatStore: chat });
      h.options.chatStore = chat;
      h.options.databasePath = databasePath; delete h.options.readTrajectory;
      return createBadcaseFlagsController({ service: h.options.flags, sealingService: h.create(), projectManager: { listProjects: () => [{ id: 'p1' }] }, host: '127.0.0.1', csrfToken: 'synthetic-csrf', getAuthority: () => `127.0.0.1:${server.address().port}` });
    };
    let controller = rebuild();
    server = http.createServer((req, res) => { controller({ req, res, pathname: req.url }).catch(() => { res.writeHead(500); res.end('{}'); }); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = `${base}/api/projects/p1/conversations/c1/messages/m1/badcase-flag`;
    const post = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-CAFF-CSRF-Token': 'synthetic-csrf' }, body: JSON.stringify({ confirmed: true, actual: 'bad', expected: 'good' }) });
    const response = await post(); assert.equal(response.status, 201); const first = await response.json();
    assert.equal(first.seal.state, 'saved_incomplete'); assert.equal(first.seal.trajectory.selectedEventCount, 1);
    assert.equal(first.wikiCase.created, true); assert.equal(first.wikiCase.case.split, 'train');
    assert.equal(first.wikiCase.case.source.conversationTitle, 'Synthetic');
    assert.equal(first.wikiCase.case.actual, 'bad'); assert.equal(first.wikiCase.case.expected, 'good');
    assert.equal(first.wikiCase.case.source.messageId, 'm1'); assert.equal(first.wikiCase.case.source.conversationId, 'c1');
    assert.equal(first.wikiCase.case.message, 'MESSAGE-BODY-NOT-ARCHIVED'); assert.equal(first.wikiCase.case.messageTruncated, false);
    const before = h.store.computeUsage('p1');
    chat.close(); chat = createChatAppStore({ agentDir: h.root, sqlitePath: databasePath }); controller = rebuild();
    assert.equal(createWikiStore({ globalRoot: path.join(h.root, 'global-wiki'), sourceWorktree: path.join(h.root, 'source') }).getCaseStates()[0].status, 'pending');
    assert.deepEqual((await (await fetch(url)).json()).seal, first.seal);
    const retry = await post(); assert.equal(retry.status, 200); assert.deepEqual((await retry.json()).seal, first.seal);
    assert.equal(first.wikiCase.case.kind, 'marked-badcase');
    assert.deepEqual(h.store.computeUsage('p1'), before);
    const dir = path.join(h.root, 'projects/p1/cases'); const text = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8');
    assert.doesNotMatch(text, /RAW-OUTPUT|RAW-TOOL|MESSAGE-BODY/);
  } finally { if (server) await new Promise(resolve => server.close(resolve)); chat.close(); }
});
