// Deterministic regression for Windows inode Number rounding. Real NTFS pairs
// reproduced this; this fixture models the same collision portably on Linux too.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { entry, hash } = require('../helpers/badcase-model-review.cjs');
const { planEvaluation } = require('../../build/server/domain/runtime/badcase-capture/evaluation-plan');
const { recordBoundModelApproval, readBoundModelApproval } = require('../../build/server/domain/runtime/badcase-capture/model-binding');
const { readEvaluationRecord } = require('../../build/server/domain/runtime/badcase-capture/evaluation-record');
const { dispatchModelEgress, readModelEgress } = require('../../build/server/domain/runtime/badcase-capture/model-egress');
const { acquireProjectWriteLease, inspectProjectWriteLock, recoverProjectWriteLock } = require('../../build/server/domain/runtime/badcase-capture/project-write-lock');
const { readRegistry } = require('../../scripts/badcase-capture/model-review-server.cjs');
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-exact-identity-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function collision(file, action) {
  const left = 9007199254740992n, right = left + 1n; assert.equal(Number(left), Number(right));
  const originals = { lstatSync: fs.lstatSync, fstatSync: fs.fstatSync, openSync: fs.openSync, closeSync: fs.closeSync }; let opened;
  const inode = (stat, value) => new Proxy(stat, { get(target, key) { return key === 'ino' ? (typeof target.ino === 'bigint' ? value : Number(value)) : Reflect.get(target, key); } });
  fs.lstatSync = (p, ...args) => { const st = originals.lstatSync(p, ...args); return String(p) === file ? inode(st, left) : st; };
  fs.openSync = (p, ...args) => { const fd = originals.openSync(p, ...args); if (String(p) === file) opened = fd; return fd; };
  fs.fstatSync = (fd, ...args) => { const st = originals.fstatSync(fd, ...args); return fd === opened ? inode(st, right) : st; };
  fs.closeSync = fd => { if (fd === opened) opened = undefined; return originals.closeSync(fd); };
  try { action(); } finally { Object.assign(fs, originals); }
}
test('lock inspect/recover reject distinct large inode identities even when their Number values collide', t => {
  const root = fixture(t), p = 'p1'; acquireProjectWriteLease(root, p);
  const expected = inspectProjectWriteLock(root, p), owner = path.join(root, 'projects', p, '.writer-lock', 'owner');
  assert.equal(fs.existsSync(owner), true);
  for (const action of [() => inspectProjectWriteLock(root, p), () => recoverProjectWriteLock(root, p, { writersStopped: true, expected })])
    collision(owner, () => assert.throws(action, e => e.code === 'capture_lock_invalid'));
});
test('binding archive and original approval reader use exact large inode identity', t => {
  const root = fixture(t), e = entry(), approvalId = 'exact-approval';
  recordBoundModelApproval(root, e.spec, e.config, { confirmed: true, approvalId, planHash: planEvaluation(e.spec).planHash, expiresAt: Date.now() + 60000 });
  collision(path.join(root, 'model-bindings', hash(approvalId) + '.json'), () => assert.throws(() => readBoundModelApproval(root, approvalId), e => e.code === 'model_binding_record_invalid'));
});
test('evaluation approval reader uses exact large inode identity', t => {
  const root = fixture(t), e = entry(), approvalId = 'exact-approval';
  recordBoundModelApproval(root, e.spec, e.config, { confirmed: true, approvalId, planHash: planEvaluation(e.spec).planHash, expiresAt: Date.now() + 60000 });
  collision(path.join(root, 'evaluations', hash(approvalId), 'approval.json'), () => assert.throws(() => readEvaluationRecord(root, approvalId), e => e.code === 'evaluation_record_invalid'));
});
test('request ledger reader uses exact large inode identity', async t => {
  const root = fixture(t), runId = hash('run');
  const policy = { approvalId: 'exact-approval', planHash: hash('plan'), runId, provider: 'synthetic', model: 'fixed-model', settingsHash: hash('settings'),
    expiresAt: Date.now() + 60000, maxRequests: 1, maxRequestBytes: 1024, maxResponseBytes: 1024, timeoutMs: 1000, perRequestReserveMicroUsd: 10, runLimitMicroUsd: 20 };
  await dispatchModelEgress(root, policy, async () => {}, async () => { assert.fail('no transport'); });
  collision(path.join(root, 'model-egress', runId, 'policy.json'), () => assert.throws(() => readModelEgress(root, runId), e => e.code === 'model_egress_record_invalid'));
});
test('operator registry reader uses exact large inode identity', t => {
  const root = fixture(t), file = path.join(root, 'registry.json'); fs.writeFileSync(file, '[]');
  collision(file, () => assert.throws(() => readRegistry(file)));
});
