const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { backfillWikiTraces, copyReadOnlyFile, projectBackfillResults } = require('../../scripts/badcase-capture/backfill-wiki-traces.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-backfill-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = path.join(root, 'source', '.pi-sandbox'), file = path.join(agent, 'named-sessions', 'selected.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const session = [{ type: 'session', version: 3, id: 's' },
    { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'request' } },
    { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }], usage: { input: 2, output: 3 } } }];
  fs.writeFileSync(file, session.map(e => JSON.stringify(e)).join('\n'));
  const dbFile = path.join(agent, 'pi-state.sqlite'), db = new Database(dbFile);
  db.exec(`CREATE TABLE chat_messages (id, conversation_id, agent_id, turn_id, task_id, role, content, metadata_json);
    CREATE TABLE chat_message_context_snapshots (message_id, snapshot_json);
    CREATE TABLE chat_message_model_usage_calls (message_id, model_call_count, calls_json);
    CREATE TABLE a2a_tasks (id, session_path, metadata_json);`);
  const metadata = { sessionPath: file, sessionAssistantStartIndex: 0, sessionAssistantEndIndex: 1 };
  db.prepare('INSERT INTO chat_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('message', 'room', 'role-family-gpt', 'turn', 'task', 'assistant', 'reply', JSON.stringify(metadata));
  db.prepare('INSERT INTO chat_message_context_snapshots VALUES (?, ?)').run('message', JSON.stringify({ archiveContext: { sections: [{ sectionKey: 'harness_prompt', content: 'system inert-known-value' }] } }));
  db.prepare('INSERT INTO chat_message_model_usage_calls VALUES (?, ?, ?)').run('message', 1, JSON.stringify([{ durationMs: 4 }]));
  db.close();
  const config = { globalRoot: path.join(root, 'output-wiki'), sourceWorktree: path.join(root, 'worktree'), sourceAgentDir: agent,
    sourceDatabase: dbFile, scratchDir: path.join(root, 'scratch'), selections: [] };
  const store = createWikiStore({ globalRoot: config.globalRoot, sourceWorktree: config.sourceWorktree });
  const source = { projectId: 'project', conversationId: 'room', messageId: 'message', agentId: 'role-family-gpt', origin: 'http://127.0.0.1:3100' };
  const item = store.addTextCases([{ source, role: 'GPT', actual: 'wrong', expected: 'right', message: 'reply', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }]).cases[0];
  config.selections = [{ caseId: item.id, mode: 'live' }];
  return { root, config, store, item, file, dbFile, source };
}
const run = h => backfillWikiTraces({ config: h.config, confirmed: true, knownKeyValues: ['inert-known-value'] });
test('approved keyed read-only backfill copies before parsing, keeps source hashes, redacts and preserves groups', t => {
  const h = fixture(t), before = fs.readFileSync(h.dbFile), old = h.store.read();
  const report = run(h), packet = h.store.readCaseTrace(h.item.id);
  assert.equal(report.results[0].status, 'complete');
  assert.equal(report.results[0].caseNumber, 1);
  assert.equal(report.results[0].caseId, h.item.id);
  assert.equal(packet.origin, 'backfill'); assert.equal(packet.steps.length, 1);
  assert.doesNotMatch(JSON.stringify(packet), /inert-known-value/);
  assert.deepEqual(fs.readFileSync(h.dbFile), before);
  assert.equal(report.audit.files[0].before, report.audit.files[0].after);
  assert.equal(report.audit.files[0].copied, hash(fs.readFileSync(h.file)));
  assert.equal(report.audit.queries.length, 3);
  for (const q of report.audit.queries) {
    assert.match(q.sql, /^SELECT .* WHERE /); assert.equal(q.args[0], 'message');
    assert.ok(fs.existsSync(path.join(h.config.scratchDir, q.copy)));
  }
  assert.equal(h.store.read().cases[0].split, old.cases[0].split);
  assert.deepEqual(h.store.read().replayCases, old.replayCases);
});
test('backfill report numbers come from canonical source IDs, never result order or supplied ordinals', () => {
  const one = 'text-3ff896480224fea1cde010370be091785529db0b1b18d8b5e0648a0a4f15aa89';
  const six = 'text-cd864c2eb09ede39cd520b18e36a0d8e02b244b6a8dde3db2390bba65e48c940';
  const cases = [{ id: six, n: 1 }, { id: one, n: 2 }], before = structuredClone(cases);
  const projected = projectBackfillResults([{ caseId: six, hash: 'six' }, { caseId: one, hash: 'one' }], cases);
  assert.deepEqual(projected.map(r => [r.caseId, r.caseNumber]), [[six, 6], [one, 1]]);
  assert.deepEqual(cases, before);
});
test('backfill reporting reserves deleted slots without rewriting surviving source or report records', () => {
  const legacy = { id: 'text-3ff896480224fea1cde010370be091785529db0b1b18d8b5e0648a0a4f15aa89' };
  const cases = [legacy, ...[17,18,19,20,21,23,24].map(n => ({ id: 'synthetic-' + n }))];
  const results = [{ caseId: 'synthetic-23', hash: 'unchanged' }], before = JSON.stringify({ cases, results });
  const projected = projectBackfillResults(results, cases, [{ case: { id: 'synthetic-22' }, caseNumber: 22 }]);
  assert.equal(projected[0].caseNumber, 23); assert.equal(JSON.stringify({ cases, results }), before);
});
test('task fallback uses real task schema and verifies its stored association', t => {
  const h = fixture(t), db = new Database(h.dbFile);
  db.prepare('UPDATE chat_messages SET metadata_json = ?').run('{}');
  db.prepare('INSERT INTO a2a_tasks VALUES (?, ?, ?)').run('task', h.file, JSON.stringify({ conversationId: 'room', agentId: 'role-family-gpt', turnId: 'turn', sessionAssistantStartIndex: 0 })); db.close();
  const report = run(h); assert.equal(report.results[0].stepCount, 1);
  assert.ok(report.results[0].missingReasons.includes('turn_end_inferred_from_usage'));
});
test('task metadata from another room cannot grant a session path', t => {
  const h = fixture(t), db = new Database(h.dbFile);
  db.prepare('UPDATE chat_messages SET metadata_json = ?').run('{}');
  db.prepare('INSERT INTO a2a_tasks VALUES (?, ?, ?)').run('task', h.file, JSON.stringify({ conversationId: 'other-room', agentId: 'role-family-gpt', turnId: 'turn', sessionAssistantStartIndex: 0 })); db.close();
  assert.throws(() => run(h), e => e.code === 'wiki_trace_association_mismatch');
  assert.equal(h.store.readCaseTrace(h.item.id), null);
});
test('missing historical bounds recover only a unique exact public reply on its parent chain', t => {
  const h = fixture(t), db = new Database(h.dbFile);
  db.prepare('UPDATE chat_messages SET task_id = NULL, metadata_json = ?').run(JSON.stringify({ sessionPath: h.file })); db.close();
  const result = run(h); assert.equal(result.results[0].stepCount, 1);
  assert.ok(result.results[0].missingReasons.includes('turn_bounds_recovered_from_unique_reply'));
});
test('repeated exact replies are ambiguous and do not acquire guessed bounds', t => {
  const h = fixture(t), db = new Database(h.dbFile);
  db.prepare('UPDATE chat_messages SET task_id = NULL, metadata_json = ?').run(JSON.stringify({ sessionPath: h.file })); db.close();
  fs.appendFileSync(h.file, '\n' + JSON.stringify({ type: 'message', id: 'u2', parentId: 'a', message: { role: 'user', content: 'next' } })
    + '\n' + JSON.stringify({ type: 'message', id: 'a2', parentId: 'u2', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } }));
  const result = run(h); assert.equal(result.results[0].stepCount, 0);
  assert.ok(result.results[0].missingReasons.includes('turn_bounds_missing'));
});
test('database size does not impose the session-copy bound or copy the whole database', t => {
  const h = fixture(t); fs.truncateSync(h.dbFile, 129 * 1024 * 1024);
  const report = run(h); assert.equal(report.results[0].status, 'complete');
  assert.ok(report.audit.files.every(f => f.source !== h.dbFile));
});
test('retry reads only the frozen Wiki packet even after source deletion', t => {
  const h = fixture(t), first = run(h); fs.rmSync(h.config.scratchDir, { recursive: true });
  fs.unlinkSync(h.file); fs.unlinkSync(h.dbFile);
  const again = run(h); assert.equal(again.results[0].hash, first.results[0].hash);
  assert.equal(again.results[0].status, 'already_frozen'); assert.equal(again.audit.queries.length, 0);
});
test('no confirmation, duplicate selections and overlapping output fail before any source query', t => {
  const h = fixture(t);
  assert.throws(() => backfillWikiTraces({ config: h.config, knownKeyValues: [] }), e => e.code === 'wiki_confirmation_required');
  h.config.selections.push(h.config.selections[0]); assert.throws(() => run(h), e => e.code === 'wiki_backfill_config_invalid');
  h.config.selections.pop(); h.config.scratchDir = path.join(h.config.sourceAgentDir, 'scratch');
  assert.throws(() => run(h), e => e.code === 'wiki_backfill_config_invalid');
});
test('copy-time source mutation fails without publishing a packet', t => {
  const h = fixture(t), original = fs.copyFileSync;
  try {
    fs.copyFileSync = (a, b, flags) => { original(a, b, flags); fs.appendFileSync(a, '\n'); };
    assert.throws(() => run(h), e => e.code === 'wiki_backfill_source_changed');
  } finally { fs.copyFileSync = original; }
  assert.equal(h.store.readCaseTrace(h.item.id), null);
});
test('missing session and original context are explicit, not a synthetic reconstruction', t => {
  const h = fixture(t), db = new Database(h.dbFile);
  db.exec('DELETE FROM chat_message_context_snapshots'); db.close(); fs.unlinkSync(h.file);
  const report = run(h); assert.equal(report.results[0].status, 'unavailable');
  assert.ok(report.results[0].missingReasons.includes('session_missing'));
  assert.ok(report.results[0].missingReasons.includes('context_archive_missing'));
  assert.ok(report.results[0].missingReasons.includes('system_prompt_missing'));
  assert.ok(!report.results[0].missingReasons.includes('original_context_unavailable'));
});
test('sealed sources retain verified pre-turn material but never invent the marked run', t => {
  const h = fixture(t), captureRoot = path.join(h.root, 'sealed-copy'), pr = path.join(captureRoot, 'projects', 'project');
  fs.mkdirSync(path.join(pr, 'checkpoints'), { recursive: true });
  const item = h.store.addMarkedCase({ source: { projectId: 'project', conversationId: 'room', agentId: 'role-family-gpt', messageId: 'sealed-message', conversationTitle: 'Sealed test' }, role: 'role-family-gpt', actual: 'wrong', expected: 'right', message: 'reply', sealedCheckpointId: 'cp', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }).case;
  const prompt = Buffer.from('sealed prompt inert-known-value'), ph = hash(prompt);
  fs.mkdirSync(path.join(pr, 'blobs', ph.slice(0, 2)), { recursive: true }); fs.writeFileSync(path.join(pr, 'blobs', ph.slice(0, 2), ph), prompt);
  fs.writeFileSync(path.join(pr, 'checkpoints/cp.json'), JSON.stringify({ checkpointId: 'cp', projectId: 'project', conversationId: 'room', agentId: 'role-family-gpt', files: {}, replayInput: { promptBlobHash: ph } }));
  h.config.selections = [{ caseId: item.id, mode: 'sealed', captureRoot }];
  const result = run(h), packet = h.store.readCaseTrace(item.id);
  assert.equal(result.audit.queries.length, 0);
  assert.equal(packet.complete, false); assert.equal(packet.steps.length, 0);
  assert.ok(packet.missingReasons.includes('sealed_marked_turn_not_recorded'));
  assert.equal(packet.context.retained.kind, 'sealed_pre_turn_inputs');
  assert.equal(packet.context.retained.prompt, 'sealed prompt [*]');
});
test('publication recheck rejects source drift after its individual copy check', t => {
  const h = fixture(t), original = fs.readFileSync;
  try {
    let reads = 0;
    fs.readFileSync = (file, ...args) => {
      const value = original(file, ...args);
      if (file === h.file && ++reads === 2) fs.appendFileSync(file, '\n');
      return value;
    };
    assert.throws(() => run(h), e => e.code === 'wiki_backfill_source_changed');
  } finally { fs.readFileSync = original; }
  assert.equal(h.store.readCaseTrace(h.item.id), null);
});
test('copy helper does not replace an existing destination', t => {
  const h = fixture(t), dest = path.join(h.root, 'existing'); fs.writeFileSync(dest, 'sentinel');
  assert.throws(() => copyReadOnlyFile(h.file, dest)); assert.equal(fs.readFileSync(dest, 'utf8'), 'sentinel');
});
