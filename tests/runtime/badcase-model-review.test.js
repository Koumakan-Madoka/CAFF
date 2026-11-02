const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createModelReviewService } = require('../../build/server/domain/runtime/badcase-capture/model-review');
const { modelBinding } = require('../../build/server/domain/runtime/badcase-capture/model-binding');
const { createEvaluationAdminService } = require('../../build/server/domain/runtime/badcase-capture/evaluation-admin');
const { entry, hash, confirm } = require('../helpers/badcase-model-review.cjs');
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-model-review-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'store'), e = entry(), service = createModelReviewService({ root, entries: [e] });
  return { temp, root, e, service, preview: () => service.preview(e.projectId, { entryId: e.id }) };
}
const rejects = e => /^model_review_/.test(e.code) && e.message === e.code;
test('preview is zero disk writes; registry and returned objects are snapshots; complete binding visible', t => {
  const f = fixture(t), p = f.preview();
  assert.deepEqual(p.binding.config, f.e.config); assert.deepEqual(p.plan.spec, f.e.spec);
  assert.deepEqual(f.service.projects(), [f.e.projectId]); assert.deepEqual(f.service.list(f.e.projectId).entries, [{ id: f.e.id }]);
  assert.equal(p.launchAvailable, false); assert.equal(p.paidAuthorization, false); assert.equal(p.materialVerified, false);
  f.e.config.endpoint.address = '8.8.8.8'; f.e.spec.repetitions = 50; p.binding.config.maxRequests = 99; p.plan.spec.repetitions = 70;
  assert.equal(f.preview().binding.config.maxRequests, 2); assert.equal(f.preview().plan.spec.repetitions, 1);
  assert.equal(f.preview().binding.config.endpoint.address, '93.184.216.34'); assert.equal(fs.existsSync(f.root), false);
});
test('approve only exact ticket/dual hashes/project; confirm then historical read with different registry', t => {
  const f = fixture(t), p = f.preview(), b = confirm(p);
  for (const change of [{ confirmed: false }, { planHash: hash('other') }, { bindingHash: hash('other') }, { approvalId: 'unknown' }, { extra: true }]) {
    assert.throws(() => f.service.approve(f.e.projectId, { ...b, ...change }), rejects); assert.equal(fs.existsSync(f.root), false);
  }
  assert.throws(() => f.service.approve('other-project', b), rejects); assert.equal(fs.existsSync(f.root), false);
  const saved = f.service.approve(f.e.projectId, b); assert.deepEqual(f.service.approve(f.e.projectId, b), saved);
  assert.equal(saved.report.consumed, false); assert.deepEqual(saved.binding, p.binding); assert.deepEqual(saved.report.ledger.spec, p.plan.spec);
  assert.equal(fs.existsSync(path.join(f.root, hash(f.e.projectId), 'model-egress')), false);
  const rebuilt = createModelReviewService({ root: f.root, entries: [] });
  assert.deepEqual(rebuilt.read(f.e.projectId, p.approvalId), saved);
  assert.throws(() => rebuilt.approve(f.e.projectId, b), rejects); assert.throws(() => rebuilt.read('other-project', p.approvalId), rejects);
  assert.throws(() => createEvaluationAdminService({ root: f.root }).read(f.e.projectId, p.approvalId), e => e.code === 'evaluation_record_invalid');
});
test('missing historical read does not create storage; arbitrary paths or payload overrides rejected', t => {
  const f = fixture(t);
  assert.throws(() => f.service.read(f.e.projectId, '00000000-0000-0000-0000-000000000000'), rejects);
  for (const id of ['../x', '', 'sk-' + 'a'.repeat(30)]) assert.throws(() => f.service.list(id), rejects);
  for (const body of [{ entryId: f.e.id, config: f.e.config }, { entryId: f.e.id, spec: f.e.spec }, { entryId: 'missing' }, null]) assert.throws(() => f.service.preview(f.e.projectId, body), rejects);
  assert.equal(fs.existsSync(f.root), false);
});
test('registry invalid binding/duplicate/secrets/limits fail before any writes', t => {
  const f = fixture(t);
  for (const change of [e => { e.spec.model.settingsHash = hash('bad'); }, e => { e.spec.model.provider = 'other'; }, e => { e.spec.model.id = 'other'; },
    e => { e.spec.perRunLimitMicroUsd = 1199; }, e => { e.spec.timeoutMs = 999; }, e => { e.spec.caseId = 'sk-' + 'b'.repeat(30); }, e => { e.extra = true; }]) {
    const e = entry(); change(e); assert.throws(() => createModelReviewService({ root: f.root, entries: [e] }));
  }
  assert.throws(() => createModelReviewService({ root: f.root, entries: [entry(), entry()] }), rejects);
  assert.throws(() => createModelReviewService({ root: f.root, entries: Array.from({ length: 65 }, (_, i) => entry('p', 'e' + i)) }), rejects);
  assert.throws(() => createModelReviewService({ root: 'relative', entries: [] }), rejects);
  assert.equal(fs.existsSync(f.root), false);
});
test('64 ticket limit, expiry boundary, clock rollback, and fresh preview after expiry', t => {
  const f = fixture(t), now = Date.now, start = now(); let at = start;
  Date.now = () => at; t.after(() => { Date.now = now; });
  const p = f.preview(); for (let i = 1; i < 64; i++) f.preview();
  assert.throws(f.preview, e => e.code === 'model_review_busy');
  at--; assert.throws(() => f.service.approve(f.e.projectId, confirm(p)), e => e.code === 'model_review_clock_invalid');
  at = p.expiresAt; assert.throws(() => f.service.approve(f.e.projectId, confirm(p)), e => e.code === 'model_review_stale');
  assert.notEqual(f.preview().approvalId, p.approvalId); assert.equal(fs.existsSync(f.root), false);
});
test('partial archive/fsync failure cannot be approved or silently repaired; persistent corruption rejects', t => {
  const f = fixture(t), p = f.preview(), original = fs.fsyncSync;
  fs.fsyncSync = () => { throw Error('PRIVATE-DISK'); };
  try { assert.throws(() => f.service.approve(f.e.projectId, confirm(p)), rejects); } finally { fs.fsyncSync = original; }
  const scope = path.join(f.root, hash(f.e.projectId)), file = path.join(scope, 'model-bindings', hash(p.approvalId) + '.json');
  assert.equal(fs.existsSync(path.join(scope, 'evaluations')), false);
  fs.writeFileSync(file, '{'); assert.throws(() => f.service.approve(f.e.projectId, confirm(p)), rejects);
  assert.equal(fs.readFileSync(file, 'utf8'), '{'); assert.throws(() => f.service.read(f.e.projectId, p.approvalId), rejects);
});
test('owned scope directory symlinks rejected on approve and read without decoy writes', t => {
  const f = fixture(t), p = f.preview(), target = path.join(f.temp, 'decoy'); fs.mkdirSync(target);
  fs.mkdirSync(f.root); const project = path.join(f.root, hash(f.e.projectId));
  try { fs.symlinkSync(target, project, 'junction'); } catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('link permission'); return; } throw e; }
  assert.throws(() => f.service.approve(f.e.projectId, confirm(p)), rejects);
  assert.throws(() => f.service.read(f.e.projectId, p.approvalId), rejects); assert.deepEqual(fs.readdirSync(target), []);
});
test('changing trusted registry requires new plan; saved config not rebuilt from new registry', t => {
  const f = fixture(t), p = f.preview(), saved = f.service.approve(f.e.projectId, confirm(p)), e = entry();
  e.config.settings.temperature = 1; e.spec.model.settingsHash = modelBinding(e.config).bindingHash;
  const next = createModelReviewService({ root: f.root, entries: [e] }), q = next.preview(e.projectId, { entryId: e.id });
  assert.notEqual(q.plan.planHash, p.plan.planHash); assert.notEqual(q.binding.bindingHash, p.binding.bindingHash);
  assert.deepEqual(next.read(e.projectId, p.approvalId), saved);
});
test('opt-in tool definitions are reviewed, persisted and read without registry; old text plan cannot authorize tools', t => {
  const f = fixture(t), e = entry();
  e.config.tools = [{ type: 'function', function: { name: 'read', description: 'synthetic read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
  assert.throws(() => createModelReviewService({ root: f.root, entries: [e] })); assert.equal(fs.existsSync(f.root), false);
  e.spec.model.settingsHash = modelBinding(e.config).bindingHash;
  const service = createModelReviewService({ root: f.root, entries: [e] }), p = service.preview(e.projectId, { entryId: e.id });
  assert.deepEqual(p.binding.config.tools, modelBinding(e.config).config.tools);
  const saved = service.approve(e.projectId, confirm(p));
  e.config.tools[0].function.description = 'changed after review';
  assert.deepEqual(createModelReviewService({ root: f.root, entries: [] }).read(e.projectId, p.approvalId), saved);
  assert.equal(saved.launchAvailable, false); assert.equal(saved.paidAuthorization, false); assert.equal(saved.report.consumed, false);
});
