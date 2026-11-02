const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createBadcaseCaptureService } = require('../../build/server/domain/runtime/badcase-capture');
const { createCaptureStore } = require('../../build/server/domain/runtime/badcase-capture/capture-store');
const { restoreCheckpoint } = require('../../build/server/domain/runtime/badcase-capture/restore');
const { readWindowsFileCandidate } = require('../../build/server/domain/runtime/badcase-capture/windows-file-candidate');
const { encodeWindowsHelperRequest: encode, parseWindowsHelperResponse: parse } = require('../../build/server/domain/runtime/badcase-capture/windows-helper');
const native = { skip: process.platform !== 'win32' ? 'real Windows NTFS required' : false };
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const identity = { volumeSerial: '1', fileId: 'a'.repeat(32), creationTime: '2' };
const request = { version: 1, op: 'snapshot', root: 'C:/worktree', expected: identity, excluded: [] };

function wire(entries, files, bodies = []) {
  return Buffer.concat([Buffer.from(JSON.stringify({ version: 1, ok: true, identity, entries, files }) + '\n'), ...bodies]);
}
const content = Buffer.from([0, 255, 10]);
const entry = { path: 'a', type: 'file', size: '3', identity, lastWriteTime: '0', changeTime: '0' };
const file = { path: 'a', size: '3', identity, sha256: hash(content) };

test('Windows snapshot protocol requires pin, returns all files in canonical order, refuses incomplete/extra bodies', () => {
  assert.ok(encode(request));
  for (const changed of [{ paths: [] }, { expected: null }, { op: 'anything' }, { excluded: ['../x'] }]) {
    assert.equal(encode({ ...request, ...changed }), null);
  }
  assert.equal(parse(wire([entry], [file], [content]), request).ok, true);
  for (const bad of [wire([entry], []), wire([], [file], [content]),
    wire([entry], [file], [Buffer.from('bad')]), wire([entry], [file], [content, content]),
    wire([entry], [{ ...file, path: 'A' }], [content]),
    wire([entry], [{ ...file, identity: { ...identity, creationTime: '3' } }], [content]),
    wire([entry], [{ ...file, extra: true }], [content]),
    wire([entry, { ...entry, path: 'b' }], [file], [content])]) {
    assert.equal(parse(bad, request).ok, false);
  }
  assert.equal(parse(Buffer.from('{"version":1,"ok":false,"code":"snapshot_changed"}\n'), request).reason, 'snapshot_changed');
  assert.equal(parse(wire([], []), request).ok, true);
  const many = Array.from({ length: 2049 }, (_, i) => ({ ...entry, path: String(i).padStart(5, '0') }));
  assert.equal(parse(wire(many, many.map(e => ({ ...file, path: e.path })), many.map(() => content)), request).ok, false);
});

function isolated({ scope, helper }) {
  const filename = path.join(__dirname, '../../build/server/domain/runtime/badcase-capture/windows-file-candidate.js');
  const local = require('node:module').createRequire(filename), exports = {};
  require('node:vm').runInNewContext(fs.readFileSync(filename, 'utf8'), {
    exports, module: { exports }, Buffer,
    require: name => name === './windows-estimate' ? { prepareWindowsMetadataScope: scope }
      : name === './windows-helper' ? { invokeWindowsHelper: helper } : local(name),
  }, { filename });
  return exports;
}

test('Windows candidate gates scope before transport and excludes all sentinel bytes/hash before any CAS plan', () => {
  let calls = 0;
  const safe = Buffer.from('safe'), secret = Buffer.from('sk-SENTINELabcdef12345');
  const sharedWire = Buffer.concat([safe, secret]);
  const api = isolated({ scope: options => options.ok ? { ok: true, helperPath: 'fixed.py', request } : { ok: false, reason: 'unpinned' },
    helper(python, helperPath, req) {
      calls++;
      assert.equal(python, 'python'); assert.equal(helperPath, 'fixed.py'); assert.equal(req.op, 'snapshot');
      assert.equal(Object.hasOwn(req, 'paths'), false);
      return { ok: true, files: [
        { path: '__proto__', size: '4', sha256: hash(safe), content: sharedWire.subarray(0, 4) },
        { path: 'duplicate', size: '4', sha256: hash(safe), content: safe },
        { path: 'private-data', size: String(secret.length), sha256: hash(secret), content: secret },
      ] };
    } });
  assert.equal(api.readWindowsFileCandidate({}).reason, 'unpinned'); assert.equal(calls, 0);
  const result = api.readWindowsFileCandidate({ ok: true });
  assert.equal(calls, 1); assert.equal(result.ok, true);
  assert.equal(result.files.__proto__.hash, hash(safe));
  assert.equal(result.blobs.size, 1); assert.deepEqual(result.blobs.get(hash(safe)), safe);
  const retained = result.blobs.get(hash(safe));
  assert.equal(retained.buffer.byteLength, safe.length, 'owned unpooled allocation cannot retain the response backing secret');
  assert.equal(Buffer.from(retained.buffer).includes(secret), false);
  assert.equal(result.files['private-data'].secretExcluded, true);
  assert.equal(Object.hasOwn(result.files['private-data'], 'hash'), false);
  assert.equal(result.blobs.has(hash(secret)), false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${secret.toString()}|${hash(secret)}`));
  for (const name of ['complete', 'strictEvalEligible', 'captureAvailable']) assert.equal(result[name], false);
  const failed = isolated({ scope: () => ({ ok: true, request }), helper: () => ({ ok: false, reason: 'snapshot_changed' }) });
  assert.equal(failed.readWindowsFileCandidate({}).reason, 'snapshot_changed');
  assert.equal(Object.hasOwn(failed.readWindowsFileCandidate({}), 'files'), false);
});

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-wincandidate-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'worktree'), captureRoot = path.join(base, 'storage');
  fs.mkdirSync(root); fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'binary'), content);
  fs.writeFileSync(path.join(root, 'empty'), '');
  fs.writeFileSync(path.join(root, 'nested', '中文😀'), 'hello');
  fs.writeFileSync(path.join(root, 'duplicate'), content);
  const service = createBadcaseCaptureService({ captureRoot });
  service.savePolicy('p', { status: 'disabled', authorizedDirs: [root], authorizedInputDirs: [], excludedPatterns: [] });
  service.authorizeProject('p');
  const options = () => ({ policy: service.loadPolicy('p'), targetDir: root, captureRoot });
  return { base, root, captureRoot, service, options };
}

test('Windows native bounded candidate to real CAS and two restores; incremental hashes/deletions are fixture-only', native, t => {
  const { base, root, captureRoot, service, options } = setup(t);
  fs.writeFileSync(path.join(root, 'hidden-secret'), 'sk-SENTINELabcdef12345');
  fs.writeFileSync(path.join(root, '.env'), 'sk-NEVERREADabcdefgh');
  const before = service.loadPolicy('p'), started = performance.now();
  const result = readWindowsFileCandidate(options());
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.blobs.size, 3, 'binary/duplicate dedup, empty, Unicode');
  assert.equal(result.files['hidden-secret'].secretExcluded, true);
  assert.equal(Object.hasOwn(result.files, '.env'), false);
  assert.equal(Object.hasOwn(result.files['hidden-secret'], 'hash'), false);
  assert.equal(result.strictEvalEligible, false); assert.equal(result.complete, false);
  assert.equal(service.store.listCheckpoints('p').length, 0, 'reader is NOT a turn collector');
  assert.deepEqual(service.loadPolicy('p'), before, 'never enables or re-pins');
  // Test-only writer: existing CAS/checkpoint/restore code, NOT production
  // collector wiring or evidence of an actual turn execution-before checkpoint.
  const store = createCaptureStore({ captureRoot });
  for (const [digest, bytes] of result.blobs) store.stageBlob('p', 'fixture', digest, bytes);
  store.commitStaging('p', 'fixture');
  const checkpoint = { checkpointId: 'fixture', targetDir: root, files: result.files, deletions: [],
    strictEvalEligible: false, replayInput: { complete: false }, limitations: result.limitations };
  store.saveCheckpoint('p', checkpoint);
  const restored = [];
  for (const n of [1, 2]) {
    const targetDir = path.join(base, `restored-${n}`);
    const value = restoreCheckpoint({ store, projectId: 'p', checkpointId: 'fixture', targetDir });
    assert.equal(value.ok, true, value.reason); assert.equal(value.strictEvalEligible, false);
    assert.equal(value.replayInputComplete, false); assert.deepEqual(value.missingSecrets, ['hidden-secret']);
    assert.deepEqual(fs.readFileSync(path.join(targetDir, 'binary')), content);
    assert.equal(fs.readFileSync(path.join(targetDir, 'nested', '中文😀'), 'utf8'), 'hello');
    assert.equal(fs.existsSync(path.join(targetDir, 'hidden-secret')), false);
    restored.push(value.restoredFiles);
  }
  assert.deepEqual(restored[0], restored[1]);
  const byteCount = store.computeUsage('p').bytesByKind.blobs;
  for (const [digest, bytes] of result.blobs) store.stageBlob('p', 'fixture-repeat', digest, bytes);
  store.commitStaging('p', 'fixture-repeat');
  assert.equal(store.computeUsage('p').bytesByKind.blobs, byteCount);
  assert.equal(byteCount, 8);
  const storageBytes = [];
  function checkStorage(dir) {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, name.name);
      if (name.isDirectory()) checkStorage(child); else storageBytes.push(fs.readFileSync(child));
    }
  }
  checkStorage(path.join(captureRoot, 'projects'));
  assert.equal(Buffer.concat(storageBytes).includes(Buffer.from('sk-SENTINELabcdef12345')), false);
  assert.equal(Buffer.concat(storageBytes).includes(Buffer.from(hash('sk-SENTINELabcdef12345'))), false);
  fs.unlinkSync(path.join(root, 'duplicate')); fs.writeFileSync(path.join(root, 'binary'), 'dirty');
  fs.writeFileSync(path.join(root, 'new-untracked'), 'new');
  const after = readWindowsFileCandidate(options());
  assert.equal(after.ok, true, after.reason);
  const deletions = Object.keys(result.files).filter(name => !Object.hasOwn(after.files, name));
  assert.deepEqual(deletions, ['duplicate']);
  assert.notEqual(result.files.binary.hash, after.files.binary.hash);
  assert.ok(after.files['new-untracked'].hash);
  t.diagnostic(JSON.stringify({ fixtureOnly: true, files: Object.keys(result.files).length,
    blobBytes: byteCount, durationMs: Math.round(performance.now() - started),
    strictEvalEligible: false, notTurnCapture: true }));
});

test('Windows native candidate rejects unpinned/switch root, replacement, junction and tampered installed helper', native, t => {
  const { base, root, captureRoot, service, options } = setup(t);
  assert.equal(readWindowsFileCandidate({ ...options(), targetDir: path.join(root, 'nested') }).ok, false);
  assert.equal(readWindowsFileCandidate({ ...options(), policy: { ...service.loadPolicy('p'), authorizedDirPins: {} } }).ok, false);
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'x'), 'OUTSIDE_SENTINEL');
  const link = path.join(root, 'alias'); fs.symlinkSync(outside, link, 'junction');
  try { assert.equal(readWindowsFileCandidate(options()).ok, false); }
  finally { fs.rmdirSync(link); }
  fs.renameSync(root, path.join(base, 'old')); fs.mkdirSync(root);
  assert.equal(readWindowsFileCandidate(options()).reason, 'root_identity_mismatch');
  service.authorizeProject('p');
  const helperDir = path.join(captureRoot, 'windows-authorization-helper');
  const helper = path.join(helperDir, fs.readdirSync(helperDir).find(n => n.endsWith('.py')));
  fs.writeFileSync(helper, '# altered same path');
  assert.equal(readWindowsFileCandidate(options()).reason, 'helper_integrity_failed');
  assert.equal(service.store.listCheckpoints('p').length, 0);
});
