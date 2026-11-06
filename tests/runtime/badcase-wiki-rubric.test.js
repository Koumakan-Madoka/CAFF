const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const MODEL = 'deepseek/deepseek-v4-flash';
const questions = [
  { id: 'q1', question: 'The reply states the result clearly.', evidence: 'reply' },
  { id: 'q2', question: 'The reply explains the next step.', evidence: 'reply' },
];
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-rubric-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { globalRoot: path.join(root, 'global'), sourceWorktree: path.join(root, 'source') };
  const store = createWikiStore(options);
  const c = store.addTextCases([{ source: { origin: 'http://127.0.0.1:3100', projectId: 'p', conversationId: 'c', messageId: 'm', agentId: 'role-family-gpt' },
    role: 'GPT', actual: 'Unclear result', expected: 'State the result and next step', message: 'Historical bad reply', traceExcerpt: '',
    traceState: 'missing', messageTruncated: false, traceTruncated: false }]).cases[0];
  const draft = (q = questions, revision = store.read().revision) => store.saveRubricDraft({ caseId: c.id, model: MODEL, scoringModel: { backend: 'deepseek', model: MODEL }, questions: q }, revision);
  const register = rules => {
    store.setReplaySplit({ caseIds: [c.id] });
    return store.addReplayCase({ sourceCaseId: c.id, category: 'control', task: 'Report the result.',
      fixture: { commit: 'a'.repeat(40), sourceCommit: 'b'.repeat(40), sourceSubdirectory: 'R1', filesHash: 'c'.repeat(64) },
      request: { captureRoot: path.join(root, 'capture'), flagId: 'flag-' + crypto.createHash('sha256').update('p\0m').digest('hex'),
        association: { projectId: 'p', conversationId: 'c', messageId: 'm', turnId: 't', agentId: 'role-family-gpt', taskId: 'task', checkpointId: 'cp', runId: 1 } },
      rules, checkpointHash: 'd'.repeat(64) });
  };
  return { root, store, options, c, draft, register };
}
function seedHistoricalRubric(h, status) {
  // Simulate an otherwise valid pre-fix snapshot, not a current write API.
  const state = h.store.read(), file = path.join(h.options.globalRoot, 'snapshots', String(state.revision).padStart(12, '0') + '.json');
  const rubric = require('../../build/server/domain/runtime/badcase-capture/wiki-rubric').createWikiRubric({ caseId: h.c.id, version: 1,
    model: MODEL, scoringModel: { backend: 'deepseek', model: MODEL }, actual: h.c.actual, expected: h.c.expected,
    questions: [{ ...questions[0], evidence: 'files' }] });
  if (status === 'frozen') Object.assign(rubric, { status, confirmedAt: '2026-11-05T00:00:00.000Z', confirmationRecord: 'Historical user approval' });
  state.rubrics = [rubric];
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, checksum: crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex'), record: state }));
  return { rubric, file, bytes: fs.readFileSync(file) };
}
test('file assertions are rejected atomically unless this case registers file-literals-v1 collection', t => {
  for (const rules of [null, { kind: 'completion-public-reply-v1' },
    { kind: 'read-only-files-v1', readPaths: ['a.txt'], absentPaths: [], requiredReplyFragments: ['Ready'] },
    { kind: 'public-reply-literals-v1', leadChars: 20, conclusionMarkers: ['Ready'], forbiddenTerms: [], forbiddenPatterns: [] }]) {
    const h = setup(t); if (rules) h.register(rules);
    const before = h.store.read();
    assert.throws(() => h.draft([{ ...questions[0], evidence: 'files' }]), { code: 'wiki_rubric_files_unavailable' });
    assert.deepEqual(h.store.read(), before);
    const draft = h.draft([{ ...questions[0], evidence: 'trace' }, questions[1]]);
    assert.equal(h.store.confirmRubric({ rubricId: draft.id, hash: draft.hash, confirmationRecord: 'Trace and reply remain supported' }, h.store.read().revision).status, 'frozen');
  }
});
test('file-literals cases can save and freeze mixed file/trace/reply assertions unchanged', t => {
  const h = setup(t); h.register({ kind: 'file-literals-v1', files: [{ path: 'a.txt', contains: ['Ready'], notContains: [] }] });
  const q = [{ ...questions[0], evidence: 'files' }, { ...questions[1], evidence: 'trace' }, { ...questions[0], id: 'q3' }], draft = h.draft(q);
  const frozen = h.store.confirmRubric({ rubricId: draft.id, hash: draft.hash, confirmationRecord: 'User confirmed file-backed assertions' }, h.store.read().revision);
  assert.equal(frozen.hash, draft.hash); assert.deepEqual(frozen.questions, q);
  assert.deepEqual(createWikiStore(h.options).getFrozenRubric(h.c.id, frozen.hash), frozen);
});
test('confirmation rechecks file capability for historical drafts without rewriting them', t => {
  const h = setup(t), { rubric, file, bytes } = seedHistoricalRubric(h, 'draft'), before = h.store.read();
  assert.throws(() => h.store.confirmRubric({ rubricId: rubric.id, hash: rubric.hash, confirmationRecord: 'New confirmation' }, before.revision), { code: 'wiki_rubric_files_unavailable' });
  assert.deepEqual(h.store.read(), before); assert.deepEqual(fs.readFileSync(file), bytes);
});
test('historical frozen file assertions remain readable with their original hash and bytes, without migration', t => {
  const h = setup(t), { rubric, file, bytes } = seedHistoricalRubric(h, 'frozen');
  assert.deepEqual(createWikiStore(h.options).getFrozenRubric(h.c.id, rubric.hash), rubric);
  assert.deepEqual(fs.readFileSync(file), bytes);
});
test('rubric draft is versioned, requires explicit human confirmation and preserves old snapshot bytes', t => {
  const h = setup(t), v1 = h.draft();
  assert.equal(v1.version, 1); assert.equal(v1.status, 'draft'); assert.match(v1.hash, /^[a-f0-9]{64}$/);
  const filename = path.join(h.options.globalRoot, 'snapshots', '000000000002.json'), before = fs.readFileSync(filename);
  assert.throws(() => h.store.getFrozenRubric(h.c.id, v1.hash), /wiki_rubric_confirmation_required/);
  assert.throws(() => h.store.confirmRubric({ rubricId: v1.id, hash: v1.hash, confirmationRecord: '' }, h.store.read().revision));
  const confirmed = h.store.confirmRubric({ rubricId: v1.id, hash: v1.hash, confirmationRecord: 'Synthetic user approval, message-test' }, h.store.read().revision);
  assert.equal(confirmed.status, 'frozen'); assert.equal(confirmed.hash, v1.hash); assert.deepEqual(confirmed.questions, questions);
  assert.deepEqual(fs.readFileSync(filename), before);
  assert.deepEqual(createWikiStore(h.options).getFrozenRubric(h.c.id, v1.hash), confirmed);
});
test('editing produces a new draft; old frozen content/hash and replay definitions never change', t => {
  const h = setup(t), v1 = h.draft();
  const first = h.store.confirmRubric({ rubricId: v1.id, hash: v1.hash, confirmationRecord: 'User confirmed v1' }, h.store.read().revision);
  const before = h.store.read(), v2 = h.draft([{ ...questions[0], question: 'The opening states the result.' }, questions[1]]);
  assert.equal(v2.version, 2); assert.notEqual(v2.hash, first.hash);
  assert.deepEqual(h.store.getFrozenRubric(h.c.id, first.hash), first);
  assert.deepEqual(h.store.read().replayCases, before.replayCases); assert.deepEqual(h.store.read().cases, before.cases);
  assert.throws(() => h.store.confirmRubric({ rubricId: first.id, hash: first.hash, confirmationRecord: 'Overwrite' }, h.store.read().revision), /wiki_rubric_frozen/);
});
test('one or four distinct assertions save and freeze without padding or changing previous snapshots', t => {
  const h = setup(t), one = [questions[0]], draft = h.draft(one);
  const filename = path.join(h.options.globalRoot, 'snapshots', '000000000002.json'), before = fs.readFileSync(filename);
  const frozen = h.store.confirmRubric({ rubricId: draft.id, hash: draft.hash, confirmationRecord: 'User confirmed one nonduplicate assertion' }, h.store.read().revision);
  assert.deepEqual(frozen.questions, one); assert.equal(frozen.hash, draft.hash);
  assert.deepEqual(fs.readFileSync(filename), before);
  assert.deepEqual(createWikiStore(h.options).getFrozenRubric(h.c.id, draft.hash), frozen);
  const four = Array.from({ length: 4 }, (_, i) => ({ ...questions[0], id: 'q' + (i + 1), question: 'Distinct observable requirement ' + (i + 1) + '.' }));
  const next = h.draft(four);
  assert.equal(next.version, 2); assert.deepEqual(next.questions, four);
  h.store.confirmRubric({ rubricId: next.id, hash: next.hash, confirmationRecord: 'User confirmed four requirements' }, h.store.read().revision);
  assert.deepEqual(h.store.getFrozenRubric(h.c.id, draft.hash), frozen);
});
test('rubrics validate 1–4 assertions, distinct identifiers, known cases/model, revision, content and hash', t => {
  const h = setup(t), before = h.store.read();
  for (const q of [[], Array.from({ length: 5 }, (_, i) => ({ ...questions[0], id: 'q' + i })), [questions[0], questions[0]],
    [{ ...questions[0], evidence: 'unknown' }, questions[1]], [{ ...questions[0], question: '' }, questions[1]],
    [{ ...questions[0], question: 'sk-FAKE_SENTINEL_123456' }, questions[1]], [{ ...questions[0], hidden: true }, questions[1]]]) assert.throws(() => h.draft(q));
  for (const patch of [{ model: 'other/model' }, { caseId: 'missing' }, { status: 'frozen' }]) {
    assert.throws(() => h.store.saveRubricDraft({ caseId: h.c.id, model: MODEL, questions, ...patch }, before.revision));
  }
  assert.throws(() => h.draft(questions, 0), /wiki_revision_conflict/); assert.deepEqual(h.store.read(), before);
  const v = h.draft();
  assert.throws(() => h.store.confirmRubric({ rubricId: v.id, hash: 'f'.repeat(64), confirmationRecord: 'User confirmed' }, h.store.read().revision), /wiki_rubric_hash_changed/);
  assert.throws(() => h.store.getFrozenRubric('missing', v.hash));
});
module.exports = { questions };
