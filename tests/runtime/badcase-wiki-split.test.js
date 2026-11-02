const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { planReplaySplit, WIKI_SPLIT_SEED, assignMarkedCaseSplit, WIKI_MARKED_SPLIT_SALT } = require('../../build/server/domain/runtime/badcase-capture/wiki-split');
const { generateWiki, prepareWikiGeneration } = require('../../scripts/badcase-capture/generate-wiki.cjs');
const { main } = require('../../scripts/badcase-capture/assign-wiki-split.cjs');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-split-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { captureRoot: path.join(root, 'capture'), sourceWorktree: path.join(root, 'source'), projectId: 'p1' }, store = createWikiStore(config);
  const values = Array.from({ length: 12 }, (_, i) => ({ source: { origin: 'http://127.0.0.1:3100', projectId: 'p1', conversationId: 'c1', messageId: 'm' + i, agentId: 'role-family-gpt' },
    role: 'GPT', actual: 'incorrect action ' + i, expected: 'confirmed expected action ' + i, message: 'done', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }));
  const cases = store.addTextCases(values).cases;
  const draft = ids => ({ caseIds: ids, model: 'deepseek/deepseek-v4-flash', entries: [], unclassified: ids.map(caseId => ({ caseId, reason: 'need context' })) });
  return { config, store, values, cases, draft };
}
test('fixed-seed holdout is independent of input order and has a golden 6-case result; small sets disclose no holdout', () => {
  const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'], a = planReplaySplit(ids), b = planReplaySplit([...ids].reverse());
  assert.deepEqual(a, b); assert.equal(a.seed, WIKI_SPLIT_SEED); assert.deepEqual(a.testCaseIds, ['c3', 'c4']);
  assert.equal(a.trainCaseIds.length, 4); assert.equal(a.insufficientSamples, false);
  for (const count of [1, 5, 6, 7, 10, 20]) {
    const split = planReplaySplit(Array.from({ length: count }, (_, i) => 'case-' + i));
    assert.equal(split.testCaseIds.length, count < 6 ? 0 : Math.round(count / 3));
    assert.equal(split.trainCaseIds.length + split.testCaseIds.length, count); assert.equal(split.insufficientSamples, count < 6);
  }
  for (const bad of [[], ['duplicate', 'duplicate'], ['../unsafe'], Array.from({ length: 21 }, (_, i) => 'c' + i)]) assert.throws(() => planReplaySplit(bad), /invalid_case_ids/);
});
test('historical per-ID hash remains reproducible for old evidence but is no longer used for new marks', () => {
  assert.equal(WIKI_MARKED_SPLIT_SALT, 'wikiskill-marked-split-v1');
  const ids = ['marked-3c73ae7aa9a7de040ff21ae02dc758a47ea5ec828c49a736aead2889730e671b'];
  assert.equal(assignMarkedCaseSplit(ids[0]), 'train');
  const counts = { train: 0, gate: 0, test: 0 }, crypto = require('node:crypto');
  for (let i = 0; i < 10000; i++) {
    const id = 'marked-' + i, digest = crypto.createHash('sha256').update('wikiskill-marked-split-v1\0' + id).digest();
    const bucket = digest.readUInt32BE(0), expected = bucket < 0x80000000 ? 'train' : bucket < 0xc0000000 ? 'gate' : 'test';
    assert.equal(assignMarkedCaseSplit(id), expected); counts[expected]++;
  }
  assert.ok(counts.train > 4800 && counts.train < 5200);
  for (const split of ['gate', 'test']) assert.ok(counts[split] > 2300 && counts[split] < 2700);
  for (const bad of ['', '../outside', null]) assert.throws(() => assignMarkedCaseSplit(bad), /invalid_case_ids/);
});
test('freeze once before generation, persist and keep unrelated text cases in training; imports never reset holdout', t => {
  const h = setup(t), selected = h.cases.slice(0, 6).map(c => c.id), p = h.store.setReplaySplit({ caseIds: selected });
  assert.equal(h.store.read().revision, 2); assert.equal(p.testCaseIds.length, 2);
  const restored = createWikiStore(h.config).read(); assert.deepEqual(restored.replaySplit, p);
  assert.equal(restored.cases.filter(c => c.split === 'train').length, 10);
  assert.equal(restored.cases.every(c => c.kind === 'text-only' && c.replayable === false), true, 'split is not evidence of replayability');
  assert.equal(h.store.addTextCases(h.values).created, 0); assert.equal(h.store.read().revision, 2);
  assert.deepEqual(h.store.setReplaySplit({ caseIds: [...selected].reverse() }), p); assert.equal(h.store.read().revision, 2);
  assert.throws(() => h.store.setReplaySplit({ caseIds: h.cases.slice(0, 7).map(c => c.id) }), /split_frozen/);
});
test('holdout is refused by generation before Key/container access and cannot be hidden in draft storage', async t => {
  const h = setup(t), p = h.store.setReplaySplit({ caseIds: h.cases.slice(0, 6).map(c => c.id) });
  let calls = 0;
  await assert.rejects(generateWiki({ store: h.store, caseIds: [p.testCaseIds[0]], confirmed: true }, {
    readKey: () => { calls++; }, execute: () => { calls++; } }), /unknown_training_case/);
  assert.equal(calls, 0); assert.throws(() => h.store.saveDraft(h.draft([p.testCaseIds[0]])), /unknown_training_case/);
  const trainingIds = h.store.read().cases.filter(c => c.split === 'train').map(c => c.id), prepared = prepareWikiGeneration(h.store, trainingIds);
  const text = prepared.files[0].bytes.toString();
  for (const id of p.testCaseIds) assert.equal(text.includes(id), false);
  assert.equal(prepared.caseIds.length, 10); h.store.saveDraft(h.draft(trainingIds));
});
test('cases already seen by any wiki model output cannot later be described as untouched holdout', t => {
  const h = setup(t), ids = h.cases.slice(0, 6).map(c => c.id), planned = planReplaySplit(ids);
  h.store.saveDraft(h.draft([planned.testCaseIds[0]]));
  assert.throws(() => h.store.setReplaySplit({ caseIds: ids }), /split_training_conflict/);
  assert.equal(h.store.read().replaySplit, null); assert.equal(h.store.read().cases.every(c => c.split === 'train'), true);
});
test('unknown cases, extra seed/options and unconfirmed CLI requests have no side effects', t => {
  const h = setup(t);
  assert.throws(() => h.store.setReplaySplit({ caseIds: ['missing'] }), /unknown_case/);
  assert.throws(() => h.store.setReplaySplit({ caseIds: [h.cases[0].id], seed: 'peeked-results' }), /invalid_input/);
  assert.throws(() => main(['--config', path.join(h.config.captureRoot, 'not-read.json')]), /split_usage/);
  assert.equal(h.store.read().revision, 1); assert.equal(h.store.read().replaySplit, null);
});
