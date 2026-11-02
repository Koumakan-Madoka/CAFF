const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCaptureStore, sha256Hex } = require('../../build/server/domain/runtime/badcase-capture/capture-store');
const { createBadcaseFlagService } = require('../../build/server/domain/runtime/badcase-capture/badcase-flags');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createCaptureStore({ captureRoot: root });
  const project = path.join(root, 'projects/p1');
  const put = (name, text) => { const target = path.join(project, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); return target; };
  return { root, store, project, put };
}
const empty = { blobs: 0, checkpoints: 0, latest: 0, flags: 0, retention: 0, cases: 0, runReferences: 0 };
test('run reference metadata is counted while its unpublished temporary is not', t => {
  const h = setup(t); h.put('runReferences/run.json', '12345'); h.put('runReferences/run.json.tmp-inflight', 'temp');
  const usage = h.store.computeUsage('p1');
  assert.equal(usage.totalBytes, 5); assert.equal(usage.bytesByKind.runReferences, 5);
});
test('committed logical bytes include flags and retention without counting shared CAS twice', t => {
  const h = setup(t), body = Buffer.from('文件');
  h.store.writeBlob('p1', sha256Hex(body), body);
  h.store.writeBlob('p1', sha256Hex(body), body);
  h.put('checkpoints/cp.json', '123'); h.put('latest/target.json', '1234');
  h.put('flags/flag.json', '问题'); h.put('retention/ref.json', '12345');
  // Corrupt metadata still occupies bytes; usage is not an integrity report.
  const usage = h.store.computeUsage('p1');
  assert.deepEqual(usage, { blobCount: 1, totalBytes: 24,
    bytesByKind: { blobs: 6, checkpoints: 3, latest: 4, flags: 6, retention: 5, cases: 0, runReferences: 0 } });
  assert.deepEqual(createCaptureStore({ captureRoot: h.root }).computeUsage('p1'), usage);
  assert.deepEqual(h.store.computeUsage('other'), { blobCount: 0, totalBytes: 0, bytesByKind: empty });
});
test('real immutable marker adds exact serialized bytes, retry and reconstruction add none', t => {
  const h = setup(t);
  const options = { captureRoot: h.root, captureStore: h.store, chatStore: {
    getConversationWithoutMessages: () => ({ projectScopeId: 'p1' }),
    getMessage: () => ({ id: 'm1', conversationId: 'c1', role: 'assistant', status: 'completed' }),
  } };
  const input = { projectId: 'p1', conversationId: 'c1', messageId: 'm1', actual: 'observed', expected: 'wanted' };
  const service = createBadcaseFlagService(options);
  assert.equal(service.mark(input).created, true);
  const files = fs.readdirSync(path.join(h.project, 'flags'));
  const size = fs.statSync(path.join(h.project, 'flags', files[0])).size;
  const usage = h.store.computeUsage('p1');
  assert.equal(usage.totalBytes, size); assert.equal(usage.bytesByKind.flags, size);
  assert.equal(createBadcaseFlagService(options).mark(input).created, false);
  assert.deepEqual(h.store.computeUsage('p1'), usage);
});
test('scope excludes policy, staging, unpublished temporaries and unknown directories explicitly', t => {
  const h = setup(t);
  for (const name of ['policy.json', 'staging/attempt/hash', 'flags/abc.json.tmp-inflight',
    'retention/abc.json.tmp-inflight', 'blobs/aa/hash.tmp-inflight', 'images/file', 'seals/future.json']) h.put(name, 'not committed in scope');
  assert.deepEqual(h.store.computeUsage('p1'), { blobCount: 0, totalBytes: 0, bytesByKind: empty });
});
test('inventory errors fail closed and never return a partial or zero total', t => {
  const h = setup(t); h.put('flags/one.json', '123');
  const original = fs.readdirSync;
  fs.readdirSync = function(target, ...args) {
    if (target === path.join(h.project, 'flags')) throw Object.assign(new Error('private path'), { code: 'EACCES' });
    return original.call(this, target, ...args);
  };
  try { assert.throws(() => h.store.computeUsage('p1'), e => e.code === 'capture_usage_unavailable' && e.message === e.code); }
  finally { fs.readdirSync = original; }
  assert.equal(h.store.computeUsage('p1').totalBytes, 3);
});
test('a vanished enumerated entry is not mistaken for an absent category', t => {
  const h = setup(t), target = h.put('retention/ref.json', '123');
  const original = fs.lstatSync;
  fs.lstatSync = function(file, ...args) {
    if (file === target) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    return original.call(this, file, ...args);
  };
  try { assert.throws(() => h.store.computeUsage('p1'), e => e.code === 'capture_usage_unavailable'); }
  finally { fs.lstatSync = original; }
});
test('static category/entry links are rejected without walking their destination', { skip: process.platform === 'win32' }, t => {
  for (const nested of [false, true]) {
    const h = setup(t), outside = path.join(h.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret'), 'outside');
    fs.mkdirSync(h.project, { recursive: true });
    const link = nested ? path.join(h.project, 'flags/link') : path.join(h.project, 'flags');
    if (nested) fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(outside, link);
    const original = fs.readdirSync; let followed = false;
    fs.readdirSync = function(file, ...args) { if (file === link || file === outside) followed = true; return original.call(this, file, ...args); };
    try { assert.throws(() => h.store.computeUsage('p1'), e => e.code === 'capture_usage_unavailable'); assert.equal(followed, false); }
    finally { fs.readdirSync = original; }
  }
});
