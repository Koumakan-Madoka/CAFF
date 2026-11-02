const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-wiki-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { captureRoot: path.join(root, 'capture'), sourceWorktree: path.join(root, 'source'), projectId: 'project-a' };
  const store = createWikiStore(options);
  const input = (id = 'message-a') => ({ source: { origin: 'http://127.0.0.1:3100', projectId: 'project-a', conversationId: 'room-a', messageId: id, agentId: 'role-family-gpt' },
    role: 'GPT', actual: 'claimed success without reading', expected: 'read the selected files before claiming success', message: 'done', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false });
  const add = () => store.addTextCases([input(), input('message-b')]);
  const draft = (caseIds = store.read().cases.map(c => c.id)) => ({ caseIds, model: 'deepseek/deepseek-v4-flash',
    entries: [{ title: 'Evidence before claims', failureMode: 'unsupported success', symptoms: 'no file reads', rootCauseHypothesis: 'skipped verification', guideline: '核验所需证据后再下结论。', caseIds: [caseIds[0]] }],
    unclassified: caseIds.slice(1).map(caseId => ({ caseId, reason: 'insufficient context' })) });
  return { root, options, store, input, add, draft };
}
const code = expected => e => e.code === expected;

test('text-only cases are immutable, non-replayable, idempotent, and persist after restart', t => {
  const h = setup(t);
  assert.equal(fs.existsSync(h.options.captureRoot), false, 'constructor is read-only');
  const first = h.add();
  assert.equal(first.created, 2); assert.equal(first.revision, 1);
  for (const c of first.cases) { assert.equal(c.kind, 'text-only'); assert.equal(c.replayable, false); assert.equal(c.split, 'train'); }
  assert.deepEqual(createWikiStore(h.options).read(), h.store.read());
  assert.equal(h.add().created, 0); assert.equal(h.store.read().revision, 1);
  assert.throws(() => h.store.addTextCases([{ ...h.input(), expected: 'changed expectation' }]), code('wiki_case_conflict'));
  assert.equal(h.store.read().revision, 1);
});

test('batch import validates everything before publishing and rejects secrets or false replay claims', t => {
  const h = setup(t);
  for (const bad of [{ ...h.input('b'), message: 'sk-FAKE_SENTINEL_123456' }, { ...h.input('b'), replayable: true }, { ...h.input('b'), role: 'Kimi' }]) {
    assert.throws(() => h.store.addTextCases([h.input(), bad]));
    assert.equal(h.store.read().cases.length, 0);
  }
  assert.throws(() => h.store.addTextCases([h.input(), { ...h.input(), actual: 'conflict' }]), code('wiki_case_conflict'));
  assert.equal(h.store.read().revision, 0);
});

test('wiki versions always start draft, preserve reviewed versions, and account for every selected case', t => {
  const h = setup(t); h.add();
  const v1 = h.store.saveDraft(h.draft());
  assert.equal(v1.entries[0].status, 'draft');
  const reviewed = h.store.review({ versionId: v1.id, entryId: v1.entries[0].id, expectedRevision: 2, decision: 'approved' });
  assert.equal(reviewed.status, 'approved');
  const v2 = h.store.saveDraft(h.draft());
  assert.notEqual(v1.id, v2.id); assert.equal(v2.entries[0].status, 'draft');
  const restored = createWikiStore(h.options).read();
  assert.equal(restored.versions[0].entries[0].status, 'approved');
  assert.equal(restored.versions.length, 2); assert.equal(restored.revision, 4);
});

test('draft editing resets no approval implicitly; reviewed entries cannot be overwritten', t => {
  const h = setup(t); h.add(); const v = h.store.saveDraft(h.draft()); const e = v.entries[0];
  const edited = h.store.review({ versionId: v.id, entryId: e.id, expectedRevision: 2, patch: { guideline: '逐项核验后再报告。' } });
  assert.equal(edited.status, 'draft'); assert.equal(edited.guideline, '逐项核验后再报告。');
  assert.throws(() => h.store.review({ versionId: v.id, entryId: e.id, expectedRevision: 2, decision: 'approved' }), code('wiki_revision_conflict'));
  h.store.review({ versionId: v.id, entryId: e.id, expectedRevision: 3, decision: 'rejected' });
  assert.throws(() => h.store.review({ versionId: v.id, entryId: e.id, expectedRevision: 4, patch: { title: 'overwrite' } }), code('wiki_entry_reviewed'));
  assert.equal(h.store.read().revision, 4);
});

test('unknown case IDs, missing coverage, ambiguous unclassified membership, and model approval are rejected', t => {
  const h = setup(t); h.add(); const d = h.draft();
  for (const bad of [
    { ...d, unclassified: [] },
    { ...d, entries: [{ ...d.entries[0], caseIds: ['invented'] }] },
    { ...d, entries: [{ ...d.entries[0], status: 'approved' }] },
    { ...d, unclassified: [...d.unclassified, { caseId: d.caseIds[0], reason: 'also unclassified' }] },
    { ...d, model: 'other/model' },
    { ...d, caseIds: ['missing'] },
  ]) assert.throws(() => h.store.saveDraft(bad));
  assert.equal(h.store.read().versions.length, 0);
});

test('guidelines are bounded to 300 Unicode characters and validated on edits too', t => {
  const h = setup(t); h.add(); const d = h.draft();
  const v = h.store.saveDraft({ ...d, entries: [{ ...d.entries[0], guideline: '😀'.repeat(300) }] });
  assert.equal([...v.entries[0].guideline].length, 300);
  for (const guideline of ['字'.repeat(301), '', 'a\0b', 'sk-FAKE_SENTINEL_123456']) {
    assert.throws(() => h.store.review({ versionId: v.id, entryId: v.entries[0].id, expectedRevision: 2, patch: { guideline } }));
  }
  assert.equal(h.store.read().revision, 2);
});

test('all selected cases may be explicitly unclassified, with a reason, but never silently omitted', t => {
  const h = setup(t); h.add(); const d = h.draft();
  const v = h.store.saveDraft({ ...d, entries: [], unclassified: d.caseIds.map(caseId => ({ caseId, reason: 'need more context' })) });
  assert.equal(v.entries.length, 0); assert.equal(v.unclassified.length, 2);
});

test('same-project writer lock and no-replace publication preserve prior snapshots after a disk failure', t => {
  const h = setup(t); h.add(); const before = h.store.read();
  const lock = path.join(h.options.captureRoot, 'projects/project-a/.writer-lock'); fs.mkdirSync(lock);
  assert.throws(() => h.store.saveDraft(h.draft()), code('capture_writer_busy'));
  fs.rmdirSync(lock);
  const original = fs.linkSync;
  try {
    fs.linkSync = () => { throw Object.assign(Error('synthetic'), { code: 'ENOSPC' }); };
    assert.throws(() => h.store.saveDraft(h.draft()), code('wiki_write_failed'));
  } finally { fs.linkSync = original; }
  assert.deepEqual(h.store.read(), before);
  const files = fs.readdirSync(path.join(h.options.captureRoot, 'wiki/project-a/snapshots'));
  assert.deepEqual(files, ['000000000001.json']);
  assert.equal(h.store.saveDraft(h.draft()).entries[0].status, 'draft');
});

test('a damaged newest snapshot fails closed instead of falling back to an older approval state', t => {
  const h = setup(t); h.add(); h.store.saveDraft(h.draft());
  const file = path.join(h.options.captureRoot, 'wiki/project-a/snapshots/000000000002.json');
  const data = JSON.parse(fs.readFileSync(file)); data.record.versions[0].entries[0].status = 'approved';
  fs.writeFileSync(file, JSON.stringify(data));
  assert.throws(() => h.store.read(), code('wiki_record_invalid'));
});

test('checkpoint orphan GC remains usable beside wiki storage and cannot delete wiki snapshots', t => {
  const h = setup(t); h.add(); const before = h.store.read();
  const { createCaptureStore, sha256Hex } = require('../../build/server/domain/runtime/badcase-capture/capture-store');
  const { inspectOrphanBlobs, collectOrphanBlobs } = require('../../build/server/domain/runtime/badcase-capture/orphan-gc');
  const capture = createCaptureStore({ captureRoot: h.options.captureRoot }), bytes = Buffer.from('unreferenced test blob');
  capture.writeBlob('project-a', sha256Hex(bytes), bytes);
  const q = { captureRoot: h.options.captureRoot, projectId: 'project-a' }, plan = inspectOrphanBlobs(q);
  assert.equal(plan.candidates.length, 1);
  assert.equal(collectOrphanBlobs(q, { confirmed: true, expected: plan.planHash }).deletedBlobCount, 1);
  assert.deepEqual(h.store.read(), before);
});

test('storage must be outside the source worktree and identifiers cannot escape their project', t => {
  const h = setup(t);
  for (const captureRoot of [h.options.sourceWorktree, path.join(h.options.sourceWorktree, 'wiki')]) {
    assert.throws(() => createWikiStore({ ...h.options, captureRoot }), code('wiki_storage_inside_source'));
  }
  for (const projectId of ['../x', '.', '', 'a/b']) assert.throws(() => createWikiStore({ ...h.options, projectId }));
});
