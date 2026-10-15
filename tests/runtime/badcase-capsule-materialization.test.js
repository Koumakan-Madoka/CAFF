const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fixture = require('../helpers/badcase-initialization-fixture.cjs');
const { prepareRetainedInitializationCapsule } = require('../../build/server/domain/runtime/badcase-capture/retained-initialization');
const { decodeInitializationCapsule, materializeInitializationCapsule } = require('../../build/server/domain/runtime/badcase-capture/capsule-materialization');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const expected = p => ({ capsuleHash: p.capsuleHash, checkpointChecksum: p.provenance.checkpointChecksum });
function encoded(data) { const capsule = JSON.stringify(data); return { capsule, expected: { capsuleHash: hash(capsule), checkpointChecksum: hash(JSON.stringify(data.checkpoint)) } }; }
function bad(t, mutate, code = 'capsule_materials_invalid') {
  const h = fixture(t, 'resume'), p = prepareRetainedInitializationCapsule(h.request), data = JSON.parse(p.capsule);
  mutate(data); const e = encoded(data), root = path.join(h.root, 'must-not-exist');
  assert.throws(() => materializeInitializationCapsule(e.capsule, e.expected, root), { code });
  assert.equal(fs.existsSync(root), false, 'validate entire capsule before any restoration');
  assert.equal(fs.readdirSync(h.runDir).length, 1, 'failure does not unpin');
}
test('fresh and resume restore full retained materials twice with identical manifests; no live reads or SDK', t => {
  for (const mode of ['fresh', 'resume']) {
    const h = fixture(t, mode, ({ cp, put }) => {
      const text = 'throw Error("captured code must stay data")';
      cp.files['.pi/extensions/trap.js'] = { type: 'file', size: Buffer.byteLength(text), hash: put(text) };
    });
    const p = prepareRetainedInitializationCapsule(h.request);
    fs.unlinkSync(path.join(h.root, 'projects/p1/checkpoints/cp1.json'));
    const a = path.join(h.root, 'copy-a'), b = path.join(h.root, 'copy-b');
    const first = materializeInitializationCapsule(p.capsule, expected(p), a);
    assert.deepEqual(materializeInitializationCapsule(p.capsule, expected(p), b), first);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a, 'materials/checkpoint.json'))), h.cp);
    for (const blob of JSON.parse(p.capsule).blobs) assert.equal(hash(fs.readFileSync(path.join(a, 'materials/blobs', blob.sha256))), blob.sha256);
    assert.equal(fs.readFileSync(path.join(a, 'snapshot/source.txt'), 'utf8'), 'retained bytes');
    assert.equal(fs.existsSync(path.join(a, 'snapshot/deleted.txt')), false);
    fs.writeFileSync(path.join(a, 'snapshot/source.txt'), 'copy changed');
    assert.equal(fs.readFileSync(path.join(b, 'snapshot/source.txt'), 'utf8'), 'retained bytes');
    assert.equal(hash(h.store.readBlob('p1', h.cp.files['source.txt'].hash)), h.cp.files['source.txt'].hash);
    assert.deepEqual(Object.keys(first).sort(), ['capsuleHash', 'checkpointChecksum', 'deliveryMode', 'fileCount', 'blobCount', 'materializedHash', 'fileModePreserved', 'piExecuted', 'runnable', 'reproduced', 'evaluable', 'strictEvalEligible'].sort());
    assert.equal(first.deliveryMode, mode); assert.equal(first.fileCount, 2);
    for (const k of ['fileModePreserved', 'piExecuted', 'runnable', 'reproduced', 'evaluable', 'strictEvalEligible']) assert.equal(first[k], false);
    assert.equal(first.capsuleHash, p.capsuleHash); assert.equal(first.checkpointChecksum, p.provenance.checkpointChecksum);
    assert.equal(first.blobCount, JSON.parse(p.capsule).blobs.length);
    const inventory = [];
    function walk(dir, prefix = '') { for (const name of fs.readdirSync(dir)) { const rel = prefix + name, dest = path.join(dir, name), st = fs.lstatSync(dest); if (st.isDirectory()) walk(dest, rel + '/'); else inventory.push({ path: rel, size: st.size, sha256: hash(fs.readFileSync(dest)) }); } }
    walk(b); inventory.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    assert.equal(first.materializedHash, hash(JSON.stringify(inventory)));
  }
});
test('capsule digest, checkpoint digest, malformed JSON and byte limits fail before filesystem writes', t => {
  const h = fixture(t), p = prepareRetainedInitializationCapsule(h.request);
  for (const [text, e] of [[p.capsule + ' ', expected(p)], [p.capsule, { ...expected(p), checkpointChecksum: '0'.repeat(64) }], ['{', { ...expected(p), capsuleHash: hash('{') }], ['x'.repeat(4 * 1024 * 1024 + 1), expected(p)]]) {
    const root = path.join(h.root, 'absent');
    assert.throws(() => materializeInitializationCapsule(text, e, root), { code: 'capsule_materials_invalid' });
    assert.equal(fs.existsSync(root), false);
  }
});
test('canonical base64, per-blob hash, duplicate/missing/extra closure entries reject', t => {
  for (const mutate of [
    d => { d.blobs[0].base64 += '\n'; },
    d => { d.blobs[0].base64 = Buffer.from('changed').toString('base64'); },
    d => { d.blobs.push(d.blobs[0]); },
    d => { d.blobs.pop(); },
    d => { d.blobs.push({ sha256: hash('extra'), base64: Buffer.from('extra').toString('base64') }); },
  ]) bad(t, mutate);
});
test('unsafe paths, file type/size and parent/deletion collisions reject before writes', t => {
  for (const mutate of [
    d => { d.checkpoint.files['../escape'] = d.checkpoint.files['source.txt']; },
    d => { d.checkpoint.files['/absolute'] = d.checkpoint.files['source.txt']; },
    d => { d.checkpoint.files['source.txt'].type = 'symlink'; },
    d => { d.checkpoint.files['source.txt'].size++; },
    d => { d.checkpoint.files['source.txt/child'] = d.checkpoint.files['source.txt']; },
    d => { d.checkpoint.deletions.push('source.txt'); },
    d => { d.checkpoint.deletions.push('deleted.txt'); },
    d => { d.checkpoint.deletions.push('../deleted'); },
  ]) bad(t, mutate);
});
test('unknown capsule/checkpoint schemas and known incompleteness reject before writes', t => {
  for (const change of [d => { d.schemaVersion = 2; }, d => { d.checkpoint.schemaVersion = 2; },
    d => { d.checkpoint.uncaptured = [{ path: 'missing' }]; }, d => { d.checkpoint.replayInput.complete = false; },
    d => { d.checkpoint.replayInput.incompleteReasons.push('missing'); }, d => { d.extra = true; }]) bad(t, change);
});
test('missing resume or mixed fresh session never silently changes mode', t => {
  bad(t, d => { d.checkpoint.replayInput.sessionBlobHash = ''; });
  bad(t, d => { d.checkpoint.replayInput.deliveryMode = 'fresh'; });
  // Keep closure exact so it cannot mask the fresh/session conflict guard.
  bad(t, d => { const r = d.checkpoint.replayInput; d.blobs = d.blobs.filter(b => b.sha256 !== r.sessionBlobHash);
    r.deliveryMode = 'fresh'; r.sessionBlobHash = r.promptBlobHash; });
  bad(t, d => { d.checkpoint.replayInput.deliveryMode = 'other'; });
});
test('direct capsule refuses invalid mode without session, secretExcluded and mismatching prompt digest independently', t => {
  const h = fixture(t), p = prepareRetainedInitializationCapsule(h.request);
  for (const change of [d => { d.checkpoint.replayInput.deliveryMode = 'other'; },
    d => { d.checkpoint.files['source.txt'].secretExcluded = true; },
    d => { d.checkpoint.replayInput.normalizedPromptHash = '0'.repeat(64); }]) {
    const data = JSON.parse(p.capsule); change(data); const e = encoded(data), root = path.join(h.root, 'no-writes');
    assert.throws(() => materializeInitializationCapsule(e.capsule, e.expected, root), { code: 'capsule_materials_invalid' });
    assert.equal(fs.existsSync(root), false);
  }
});
test('direct consumer accepts 4094 files but refuses 4095 with exact blob closure', t => {
  const h = fixture(t), p = prepareRetainedInitializationCapsule(h.request), data = JSON.parse(p.capsule);
  const original = data.checkpoint.files['source.txt']; data.checkpoint.files = {};
  for (let i = 0; i < 4094; i++) data.checkpoint.files['f' + i] = original;
  let e = encoded(data); assert.equal(decodeInitializationCapsule(e.capsule, e.expected).receipt.fileCount, 4094);
  data.checkpoint.files.f4094 = original; e = encoded(data);
  const root = path.join(h.root, 'too-many');
  assert.throws(() => materializeInitializationCapsule(e.capsule, e.expected, root), { code: 'capsule_materials_invalid' });
  assert.equal(fs.existsSync(root), false);
});
test('direct consumer enforces 8192 blobs with otherwise valid exact closure below byte limits', t => {
  const h = fixture(t, 'resume'), p = prepareRetainedInitializationCapsule(h.request), data = JSON.parse(p.capsule);
  const r = data.checkpoint.replayInput;
  data.blobs = data.blobs.filter(b => [r.promptBlobHash, r.harness.configSnapshotHash, r.sessionBlobHash].includes(b.sha256));
  data.checkpoint.files = {}; data.checkpoint.deletions = []; r.harness.skillSnapshots = [];
  function add(text) { const sha256 = hash(text); data.blobs.push({ sha256, base64: Buffer.from(text).toString('base64') }); return sha256; }
  for (let i = 0; i < 4094; i++) { const text = 'file-' + i; data.checkpoint.files['f' + i] = { type: 'file', size: Buffer.byteLength(text), hash: add(text) }; }
  for (let i = 0; i < 4095; i++) { const h = add('skill-' + i); r.harness.skillSnapshots.push({ sha256: h, blobHash: h }); }
  assert.equal(data.blobs.length, 8192);
  let e = encoded(data); assert.ok(Buffer.byteLength(e.capsule) < 4 * 1024 * 1024);
  assert.equal(decodeInitializationCapsule(e.capsule, e.expected).receipt.blobCount, 8192);
  const extra = add('last-skill'); r.harness.skillSnapshots.push({ sha256: extra, blobHash: extra });
  assert.equal(data.blobs.length, 8193); assert.equal(r.harness.skillSnapshots.length, 4096);
  e = encoded(data); assert.ok(Buffer.byteLength(e.capsule) < 4 * 1024 * 1024);
  const root = path.join(h.root, 'too-many-blobs');
  assert.throws(() => materializeInitializationCapsule(e.capsule, e.expected, root), { code: 'capsule_materials_invalid' });
  assert.equal(fs.existsSync(root), false);
});
test('metadata and valid-hash blob secrets reject before restoring; protection survives', t => {
  bad(t, d => { d.checkpoint.targetDir = 'sk-' + 'x'.repeat(20); }, 'capsule_materials_secret');
  bad(t, d => {
    const r = d.checkpoint.replayInput, b = d.blobs.find(b => b.sha256 === r.promptBlobHash);
    const text = 'sk-' + 'y'.repeat(20); b.base64 = Buffer.from(text).toString('base64'); b.sha256 = hash(text);
    r.promptBlobHash = b.sha256; r.normalizedPromptHash = b.sha256;
  }, 'capsule_materials_secret');
});
test('existing destination (including link) is never traversed or overwritten', t => {
  const h = fixture(t), p = prepareRetainedInitializationCapsule(h.request), dest = path.join(h.root, 'occupied');
  fs.mkdirSync(dest); fs.writeFileSync(path.join(dest, 'marker'), 'untouched');
  assert.throws(() => materializeInitializationCapsule(p.capsule, expected(p), dest), { code: 'EEXIST' });
  assert.deepEqual(fs.readdirSync(dest), ['marker']);
  const link = path.join(h.root, 'link');
  try { fs.symlinkSync(dest, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) return; throw e; }
  assert.throws(() => materializeInitializationCapsule(p.capsule, expected(p), link), { code: 'EEXIST' });
  assert.deepEqual(fs.readdirSync(dest), ['marker']);
});
test('disk failure returns no success and leaves only this new partial directory; never unpins', t => {
  const h = fixture(t), p = prepareRetainedInitializationCapsule(h.request), original = fs.writeFileSync;
  const destination = path.join(h.root, 'failed-write');
  fs.writeFileSync = () => { throw Object.assign(Error('synthetic disk failure'), { code: 'ENOSPC' }); };
  try { assert.throws(() => materializeInitializationCapsule(p.capsule, expected(p), destination), { code: 'ENOSPC' }); }
  finally { fs.writeFileSync = original; }
  assert.equal(fs.existsSync(destination), true);
  assert.equal(fs.readdirSync(h.runDir).length, 1);
});
test('offline wrapper protects before Docker, verifies exact receipt and never returns raw output', async t => {
  const { runRetainedInputProbe } = require('../../scripts/badcase-capture/retained-input-probe.cjs');
  const { prepareOfflineTask } = require('../../build/server/domain/runtime/badcase-capture/docker-sandbox');
  const image = { imageId: 'sha256:' + 'a'.repeat(64), repositoryDigest: 'node@sha256:' + 'b'.repeat(64), architecture: 'amd64', nodeVersion: 'v24.21.0', pythonVersion: 'Python 3.11.2' };
  const h = fixture(t, 'resume'); let calls = 0;
  async function runTask(task, change = () => {}) {
    calls++; assert.equal(fs.readdirSync(h.runDir).length, 1);
    const content = name => Buffer.from(task.files.find(f => f.path === name).base64, 'base64').toString();
    assert.deepEqual(task.files.map(f => f.path).sort(), ['probe.cjs', 'capsule-materialization.js', 'secrets.js', 'capsule.json', 'expected.json'].sort());
    const plan = decodeInitializationCapsule(content('capsule.json'), JSON.parse(content('expected.json')));
    const r = { state: 'completed', cleaned: true, inputHash: prepareOfflineTask(task).inputHash, stdout: JSON.stringify(plan.receipt) + '\n', stderr: '', containerId: 'a'.repeat(64) };
    change(r); return r;
  }
  const r = await runRetainedInputProbe(h.request, image, { runTask });
  assert.equal(r.piExecuted, false); assert.equal(r.provenance.launchAuthorized, false);
  assert.equal(Object.hasOwn(r, 'stdout'), false); assert.equal(Object.hasOwn(r, 'stderr'), false);
  for (const change of [r => { r.cleaned = false; }, r => { r.inputHash = 'bad'; }, r => { r.state = 'failed'; }, r => { r.stdout += 'extra'; }, r => { r.stderr = 'unexpected'; }]) {
    await assert.rejects(runRetainedInputProbe(h.request, image, { runTask: task => runTask(task, change) }), { code: 'capsule_probe_failed' });
    assert.equal(fs.readdirSync(h.runDir).length, 1);
  }
  const before = calls; fs.unlinkSync(h.blobPath(h.r.sessionBlobHash));
  await assert.rejects(runRetainedInputProbe(h.request, image, { runTask }), { code: 'replay_blob_missing' });
  assert.equal(calls, before); assert.equal(fs.readdirSync(h.runDir).length, 1);
});
test('decoder preserves harness skills and replacement declarations as data, not implemented execution semantics', t => {
  const h = fixture(t, 'fresh', ({ r, config, put }) => {
    config.toolBridgeEnabled = true; r.harness.configSnapshotHash = put(JSON.stringify(config));
    r.runConfig.skillIds = ['s1']; const blobHash = put('skill text');
    r.harness.skillSnapshots = [{ id: 's1', source: 'synthetic', blobHash, sha256: blobHash }];
  });
  const p = prepareRetainedInitializationCapsule(h.request), plan = decodeInitializationCapsule(p.capsule, expected(p));
  assert.equal(plan.files.find(f => f.path === 'materials/checkpoint.json').bytes.toString(), JSON.stringify(h.cp));
  assert.ok(plan.files.some(f => f.path === 'materials/blobs/' + h.r.harness.skillSnapshots[0].blobHash));
});
