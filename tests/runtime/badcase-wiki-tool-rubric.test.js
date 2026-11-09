const test = require('node:test'), assert = require('node:assert/strict');
const base = '../../build/server/domain/runtime/badcase-capture/';
const r = require(base + 'wiki-rubric');
const { setup } = require('../helpers/wiki-pending-patterns.cjs');
const model = { backend: 'deepseek', model: r.WIKI_RUBRIC_MODEL };
const questions = [{ id: 'reply', question: '回复直接给出结论。', evidence: 'reply' }];
const toolCheck = () => ({ method: 'code', target: { kind: 'caff-chat', name: 'suggest-goal' }, mode: 'on-call',
  rules: [{ parameter: 'reason', kind: 'max-chars', max: 1000 }] });
function input(h, patch = {}) { return { caseId: 'new-1', model: r.WIKI_RUBRIC_MODEL, questions, scoringModel: model, ...patch }; }
function save(h, patch = {}) { return h.store.saveRubricDraft(input(h, patch), h.store.read().revision); }
function freeze(h, draft) { return h.store.confirmRubric({ rubricId: draft.id, hash: draft.hash, confirmationRecord: 'Synthetic user consent to both independent checks' }, h.store.read().revision); }
for (const kind of ['reply', 'tool', 'both']) test(`${kind}-only/both configurations freeze as one immutable rubric`, t => {
  const h = setup(t), patch = kind === 'reply' ? {} : { toolCheck: toolCheck(), ...(kind === 'tool' ? { questions: [], scoringModel: null } : {}) };
  const before = h.bytes(), draft = save(h, patch), frozen = freeze(h, draft);
  assert.equal(frozen.hash, draft.hash); assert.equal(frozen.status, 'frozen');
  assert.deepEqual(frozen.questions, kind === 'tool' ? [] : questions);
  if (kind !== 'reply') assert.deepEqual(frozen.toolCheck, patch.toolCheck);
  assert.deepEqual(h.store.getFrozenRubric('new-1', frozen.hash), frozen);
  for (const [file, bytes] of Object.entries(before)) assert.equal(h.bytes()[file], bytes);
});
test('unconfigured explicit two-slot draft may exist, but cannot freeze or become scoreable', t => {
  const h = setup(t), draft = save(h, { questions: [], toolCheck: null, scoringModel: null }), before = h.store.read();
  assert.deepEqual(draft.questions, []); assert.equal(draft.toolCheck, null);
  assert.throws(() => freeze(h, draft), { code: 'wiki_rubric_checks_required' });
  assert.deepEqual(h.store.read(), before);
});
test('a reply check still requires a judge model even alongside a code check', t => {
  const h = setup(t), draft = save(h, { toolCheck: toolCheck(), scoringModel: null }), before = h.store.read();
  assert.throws(() => freeze(h, draft), { code: 'wiki_rubric_model_required' }); assert.deepEqual(h.store.read(), before);
});
test('editing tool rules or either slot appends a new hash/version, never edits a frozen version', t => {
  const h = setup(t), first = freeze(h, save(h, { toolCheck: toolCheck() })), bytes = h.bytes();
  const changed = toolCheck(); changed.rules[0].max = 999;
  const next = save(h, { toolCheck: changed }), third = save(h, { toolCheck: changed, questions: [] });
  assert.equal(next.version, 2); assert.equal(third.version, 3); assert.notEqual(next.hash, first.hash); assert.notEqual(third.hash, next.hash);
  assert.deepEqual(h.store.getFrozenRubric('new-1', first.hash), first);
  for (const [file, value] of Object.entries(bytes)) assert.equal(h.bytes()[file], value);
  assert.throws(() => freeze(h, first), { code: 'wiki_rubric_frozen' });
  const tampered = structuredClone(first); tampered.toolCheck.rules[0].max = 500;
  assert.throws(() => r.validateWikiRubric(tampered, true), { code: 'wiki_rubric_hash_changed' });
});
test('old v1/v2 record bytes and content hashes are unchanged; the optional field is not synthesized', t => {
  const h = setup(t), source = h.store.read().cases.find(c => c.id === 'new-1');
  for (const kind of ['wiki-rubric-v1', 'wiki-rubric-v2']) {
    const content = { kind, caseId: source.id, version: 1, model: r.WIKI_RUBRIC_MODEL,
      sourceHash: r.wikiRubricSourceHash(source.actual, source.expected), questions,
      ...(kind === 'wiki-rubric-v2' ? { scoringModel: model } : {}) };
    const hash = r.wikiValueHash(content), historical = { ...content, hash, id: 'rubric-' + hash,
      status: 'frozen', confirmedAt: '2026-11-05T00:00:00.000Z', confirmationRecord: 'Historical approval' };
    const bytes = JSON.stringify(historical), validated = r.validateWikiRubric(historical, true);
    assert.equal(JSON.stringify(validated), bytes); assert.equal(validated.hash, hash); assert.equal(Object.hasOwn(validated, 'toolCheck'), false);
    if (kind === 'wiki-rubric-v2') {
      const current = r.createWikiRubric({ ...input(h), actual: source.actual, expected: source.expected, version: 1 });
      assert.equal(current.hash, hash); assert.equal(Object.hasOwn(current, 'toolCheck'), false);
    }
  }
});
test('tool checks are closed, code-only data, not arbitrary scripts or model instructions', () => {
  const validate = require(base + 'wiki-tool-check').validateWikiToolCheck;
  assert.deepEqual(validate(toolCheck()), toolCheck());
  for (const patch of [{ method: 'model' }, { mode: 'either' }, { extra: true }, { target: { kind: 'shell', name: 'bash' } },
    { target: { kind: 'caff-chat', name: 'suggest-goal', script: 'forbidden' } }, { rules: [] },
    { rules: [{ parameter: 'reason', kind: 'script', source: 'return true' }] },
    { rules: [{ parameter: 'reason', kind: 'max-chars', max: -1 }] },
    { rules: [{ parameter: 'action', kind: 'allowed-values', values: [] }] },
    { rules: [{ parameter: 'action', kind: 'forbidden-values', values: ['pause', 'pause'] }] }]) {
    assert.throws(() => validate({ ...toolCheck(), ...patch }), { code: 'wiki_tool_check_invalid' });
  }
});
test('invalid tool rules, stale revisions and mixed invalid batches are rejected atomically', t => {
  const h = setup(t), before = h.store.read();
  assert.throws(() => h.store.saveRubricDraft(input(h, { toolCheck: toolCheck() }), before.revision - 1), { code: 'wiki_revision_conflict' });
  assert.deepEqual(h.store.read(), before);
  const invalid = toolCheck(); invalid.rules[0].max = -1;
  assert.throws(() => h.store.saveRubricDrafts([input(h, { toolCheck: toolCheck() }), input(h, { caseId: 'new-2', toolCheck: invalid })], before.revision));
  assert.deepEqual(h.store.read(), before);
});
