// Durable HUMAN-REVIEW PROJECTION only, not runtime/environment archival or
// human authentication. Same-OS-user/ancestor paths remain TCB. No GC or repair.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { planEvaluation } = require('../../build/server/domain/runtime/badcase-capture/evaluation-plan');
const { containsSecretSentinel } = require('../../build/server/domain/runtime/badcase-capture/secrets');
const { prepareOfflineTask } = require('../../build/server/domain/runtime/badcase-capture/docker-sandbox');
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const exact = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const LIMIT = 256 * 1024;
function fail(code = 'evaluation_review_invalid') { throw Object.assign(Error(code), { code }); }
function validate(v, projectId, approvalId, plan) {
  assert.ok(exact(v, ['schemaVersion', 'projectId', 'approvalId', 'materialId', 'createdAt', 'expiresAt', 'reviewHash', 'review']));
  assert.equal(v.schemaVersion, 1); assert.equal(v.projectId, projectId); assert.equal(v.approvalId, approvalId);
  assert.ok(id(v.materialId) && Number.isSafeInteger(v.createdAt) && v.createdAt >= 0
    && Number.isSafeInteger(v.expiresAt) && v.expiresAt === v.createdAt + 300000);
  const r = v.review, s = plan.spec;
  assert.ok(exact(r, ['schemaVersion', 'planHash', 'task', 'deliveryMode', 'invocationHash', 'historyHash', 'roles', 'rule', 'declaredImage', 'realModel', 'faithfulReplay']));
  assert.equal(r.schemaVersion, 1); assert.equal(r.planHash, plan.planHash);
  assert.equal(r.task, 'fixed-write-read-edit-bash-v1'); assert.ok(['fresh', 'resume'].includes(r.deliveryMode));
  assert.ok(digest(r.invocationHash) && digest(r.historyHash));
  assert.equal(r.realModel, false); assert.equal(r.faithfulReplay, false);
  assert.ok(exact(r.roles, ['baseline', 'candidate']) && exact(r.rule, ['expectedHash', 'badcaseHash']));
  for (const [variant, role] of Object.entries(r.roles)) {
    assert.ok(typeof role === 'string' && role.trim() && !role.includes('\0') && Buffer.byteLength(role) <= 16384
      && Buffer.from(role).toString('utf8') === role && !containsSecretSentinel(role));
    assert.equal(hash(role), s[variant + 'RoleHash']);
  }
  assert.ok(digest(r.rule.expectedHash) && digest(r.rule.badcaseHash) && r.rule.expectedHash !== r.rule.badcaseHash);
  assert.equal(s.evaluator.versionHash, hash(JSON.stringify({ version: 1, ...r.rule })));
  prepareOfflineTask({ image: r.declaredImage, entrypoint: 'validate.cjs', timeoutMs: 1,
    files: [{ path: 'validate.cjs', base64: '', sha256: hash('') }] });
  assert.equal(s.environmentHash, hash(JSON.stringify(r.declaredImage)));
  assert.equal(v.reviewHash, hash(JSON.stringify(r)));
  const text = JSON.stringify(v);
  assert.ok(Buffer.byteLength(text) <= LIMIT && !containsSecretSentinel(text));
  return v;
}
function location(root, projectId, approvalId, create) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !id(projectId)
    || typeof approvalId !== 'string' || !/^[a-f0-9-]{36}$/.test(approvalId)) fail();
  const scope = path.join(root, hash(projectId)), dir = path.join(scope, 'reviews');
  for (const d of [root, scope, dir]) {
    if (create) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(d).isDirectory()) fail(); // lstat rejects links, including dangling ones
  }
  return path.join(dir, hash(approvalId) + '.json');
}
function read(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size < 2 || stat.size > LIMIT) fail();
  const fd = fs.openSync(file, 'r');
  try {
    const actual = fs.fstatSync(fd);
    if (!actual.isFile() || actual.ino !== stat.ino || actual.dev !== stat.dev || actual.size !== stat.size) fail();
    const bytes = Buffer.alloc(stat.size + 1); let n = 0;
    while (n < bytes.length) { const count = fs.readSync(fd, bytes, n, bytes.length - n, n); if (!count) break; n += count; }
    if (n !== stat.size) fail();
    const data = bytes.subarray(0, n), text = data.toString('utf8');
    if (!Buffer.from(text).equals(data)) fail();
    return JSON.parse(text);
  } finally { fs.closeSync(fd); }
}
function saveReviewArchive(root, value, spec) {
  let v, plan;
  try {
    v = JSON.parse(JSON.stringify(value)); plan = planEvaluation(spec);
    validate(v, v.projectId, v.approvalId, plan);
  } catch { fail(); }
  try {
    const file = location(root, v.projectId, v.approvalId, true);
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const previous = validate(read(file), v.projectId, v.approvalId, plan);
      assert.deepEqual(previous, v); // no replacement, even if both are independently valid
      return previous;
    }
    try { fs.writeFileSync(fd, JSON.stringify(v)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    assert.deepEqual(validate(read(file), v.projectId, v.approvalId, plan), v);
    return v;
  } catch { fail('evaluation_review_write_failed'); }
}
function readReviewArchive(root, projectId, approvalId, report) {
  try {
    const plan = planEvaluation(report.ledger.spec);
    const v = validate(read(location(root, projectId, approvalId, false)), projectId, approvalId, plan);
    assert.equal(report.approval.approvalId, approvalId); assert.equal(report.approval.planHash, plan.planHash);
    assert.equal(report.approval.expiresAt, v.expiresAt);
    assert.ok(report.recordedAt >= v.createdAt && report.recordedAt < v.expiresAt);
    return v;
  } catch { fail(); }
}
module.exports = { saveReviewArchive, readReviewArchive };
