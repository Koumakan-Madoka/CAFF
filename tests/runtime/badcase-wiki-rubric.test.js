const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
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
  return { root, store, options, c, draft };
}
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
test('rubrics validate 2–4 questions, distinct identifiers, known cases/model, revision, content and hash', t => {
  const h = setup(t), before = h.store.read();
  for (const q of [[], [questions[0]], [...questions, ...questions, questions[0]], [questions[0], questions[0]],
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
