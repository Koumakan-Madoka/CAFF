const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createBadcaseCaptureService } = require('../../build/server/domain/runtime/badcase-capture');
const { pinKey, pinAuthorizedDirs } = require('../../build/server/domain/runtime/badcase-capture/capture-policy');
const { invokeWindowsHelper } = require('../../build/server/domain/runtime/badcase-capture/windows-helper');
const native = { skip: process.platform !== 'win32' ? 'real Windows NTFS required' : false };
const { isolateWindowsCaptureEnvironment } = require('../helpers/windows-capture-environment');
function temp(t) {
  isolateWindowsCaptureEnvironment(t);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-winauth-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'worktree'), inputs = path.join(base, 'inputs'), captureRoot = path.join(base, 'storage');
  fs.mkdirSync(root); fs.mkdirSync(inputs);
  const service = createBadcaseCaptureService({ captureRoot });
  service.savePolicy('p', { status: 'disabled', authorizedDirs: [root], authorizedInputDirs: [inputs] });
  return { base, root, inputs, captureRoot, service };
}
function runtime() { return require('../../build/server/domain/runtime/badcase-capture/windows-authorization'); }

test('Windows explicit authorization persists exact native pins across service restart', native, async t => {
  const { root, inputs, captureRoot, service } = temp(t);
  assert.deepEqual(service.loadPolicy('p').authorizedDirPins, {});
  const policy = service.authorizeProject('p');
  const r = runtime().prepareWindowsAuthorization({ captureRoot });
  assert.equal(r.ok, true);
  for (const [dir, pins] of [[root, policy.authorizedDirPins], [inputs, policy.authorizedInputPins]]) {
    const pin = pins[pinKey(dir)];
    assert.equal(pin.realpath, path.resolve(dir));
    const identity = invokeWindowsHelper(r.python, r.helperPath, { version: 1, op: 'identity', root: dir });
    assert.equal(identity.ok, true);
    assert.deepEqual(pin.identity, identity.identity);
    assert.equal(typeof pin.identity.volumeSerial, 'string');
    assert.equal(typeof pin.identity.creationTime, 'string');
    assert.match(pin.identity.fileId, /^[a-f0-9]{32}$/);
  }
  assert.notDeepEqual(policy.authorizedDirPins[pinKey(root)].identity, policy.authorizedInputPins[pinKey(inputs)].identity);
  assert.equal(policy.status, 'disabled');
  const restarted = createBadcaseCaptureService({ captureRoot });
  assert.deepEqual(restarted.loadPolicy('p'), policy);
  assert.deepEqual(fs.readdirSync(root), [], 'authorization never writes into worktree');
  assert.deepEqual(fs.readdirSync(inputs), []);
  const preview = restarted.estimateDirectory('p', root);
  assert.equal(preview.ok, true, 'native metadata preview is now available');
  assert.equal(preview.captureAvailable, false, 'collector remains closed');
  restarted.savePolicy('p', { ...policy, status: 'enabled' });
  const capture = await restarted.captureTurnCheckpoint({ projectId: 'p', targetDir: root, deliveryMode: 'fresh' });
  assert.equal(capture.captured, false); assert.equal(capture.reason, 'git_metadata_unsupported');
  assert.equal(restarted.store.listCheckpoints('p').length, 0, 'unclassified empty directory is not captured');
});

test('Windows replacement and added roots cannot be re-pinned by ordinary save', native, t => {
  const { root, base, captureRoot, service } = temp(t);
  const policy = service.authorizeProject('p'), oldPin = policy.authorizedDirPins[pinKey(root)];
  fs.renameSync(root, path.join(base, 'old')); fs.mkdirSync(root);
  const added = path.join(base, 'other'); fs.mkdirSync(added);
  const saved = service.savePolicy('p', { ...policy, authorizedDirs: [root, added],
    authorizedDirPins: { [pinKey(root)]: { realpath: root, identity: { fileId: 'forged' } } } });
  assert.deepEqual(saved.authorizedDirPins[pinKey(root)], oldPin);
  assert.equal(saved.authorizedDirPins[pinKey(added)], undefined);
  const r = runtime().prepareWindowsAuthorization({ captureRoot });
  assert.equal(r.ok, true);
  assert.equal(invokeWindowsHelper(r.python, r.helperPath, { version: 1, op: 'capture', root,
    expected: oldPin.identity, excluded: [], paths: [] }).reason, 'root_identity_mismatch');
  const restarted = createBadcaseCaptureService({ captureRoot });
  assert.deepEqual(restarted.loadPolicy('p').authorizedDirPins[pinKey(root)], oldPin);
  const renewed = restarted.authorizeProject('p');
  assert.notDeepEqual(renewed.authorizedDirPins[pinKey(root)].identity, oldPin.identity);
  assert.ok(renewed.authorizedDirPins[pinKey(added)].identity);
  const removed = restarted.savePolicy('p', { ...renewed, authorizedDirs: [added], authorizedInputDirs: [] });
  assert.equal(removed.authorizedDirPins[pinKey(root)], undefined);
  assert.deepEqual(removed.authorizedInputPins, {});
});

test('Windows root junction and junction ancestor never acquire authorization pins', native, t => {
  const { service, root, base } = temp(t);
  fs.mkdirSync(path.join(root, 'sub'));
  const alias = path.join(base, 'alias');
  fs.symlinkSync(root, alias, 'junction');
  t.after(() => { if (fs.existsSync(alias)) fs.rmdirSync(alias); });
  service.savePolicy('p', { status: 'disabled', authorizedDirs: [alias, path.join(alias, 'sub')], authorizedInputDirs: [] });
  assert.throws(() => service.authorizeProject('p'), e => e.code === 'windows_authorization_root_rejected');
  const pinned = service.loadPolicy('p');
  assert.deepEqual(pinned.authorizedDirPins, {});
  assert.deepEqual(pinned.authorizedInputPins, {});
  assert.equal(pinned.status, 'disabled');
  service.savePolicy('p', { ...pinned, authorizedDirs: [root], authorizedInputDirs: [alias] });
  assert.throws(() => service.authorizeProject('p'), e => e.code === 'windows_authorization_root_rejected');
  const partial = service.loadPolicy('p');
  assert.ok(partial.authorizedDirPins[pinKey(root)].identity, 'successful root identity retained, but no partial success report');
  assert.deepEqual(partial.authorizedInputPins, {});
  assert.equal(partial.status, 'disabled');
});

test('Windows helper installation is content-addressed, idempotent and refuses tampering', native, t => {
  const { captureRoot } = temp(t);
  const api = runtime();
  const one = api.prepareWindowsAuthorization({ captureRoot });
  assert.equal(one.ok, true);
  const bytes = fs.readFileSync(one.helperPath), mtime = fs.statSync(one.helperPath).mtimeMs;
  const two = api.prepareWindowsAuthorization({ captureRoot });
  assert.deepEqual(two, one);
  assert.deepEqual(fs.readFileSync(two.helperPath), bytes);
  assert.equal(fs.statSync(two.helperPath).mtimeMs, mtime);
  assert.deepEqual(fs.readdirSync(path.dirname(one.helperPath)), [path.basename(one.helperPath)], 'own probes cleaned');
  fs.appendFileSync(one.helperPath, '\n# tampered\n');
  assert.deepEqual(api.prepareWindowsAuthorization({ captureRoot }), { ok: false, reason: 'windows_authorization_unavailable' });
  assert.notDeepEqual(fs.readFileSync(one.helperPath), bytes, 'do not hide integrity failure by repairing');
  assert.deepEqual(api.prepareWindowsAuthorization({ captureRoot: one.helperPath }), { ok: false, reason: 'windows_authorization_unavailable' });
});

test('Windows native pin provider is queried on literal path, never realpath aliases', () => {
  const missing = path.resolve(os.tmpdir(), 'caff-nonexistent-native-root');
  const seen = [];
  const identity = { volumeSerial: '9007199254740993', fileId: 'b'.repeat(32), creationTime: '123' };
  const policy = pinAuthorizedDirs({ authorizedDirs: [missing], authorizedInputDirs: [] }, {
    nativeIdentityFn(dir) { seen.push(dir); return identity; },
    statxFn() { assert.fail('native provider must not fall back to statx'); },
  });
  assert.deepEqual(seen, [missing]);
  assert.deepEqual(policy.authorizedDirPins[pinKey(missing)], { realpath: missing, identity });
  assert.deepEqual(pinAuthorizedDirs({ authorizedDirs: [missing] }, {
    nativeIdentityFn() { return null; }, statxFn() { assert.fail('no fallback'); },
  }).authorizedDirPins, {});
});

function isolatedRuntime({ platform = 'win32', helper, child, disk } = {}) {
  const file = path.join(__dirname, '../../build/server/domain/runtime/badcase-capture/windows-authorization.js');
  const local = require('node:module').createRequire(file), exports = {};
  require('node:vm').runInNewContext(fs.readFileSync(file, 'utf8'), {
    exports, module: { exports }, Buffer, process: { platform },
    require: name => name === './windows-helper' && helper ? helper
      : name === 'node:child_process' && child ? child : name === 'node:fs' && disk ? disk : local(name),
  }, { filename: file });
  return exports;
}

test('Windows authorization runtime fails before I/O on other platforms or invalid storage roots', t => {
  // Observe OUTSIDE the production catch. Throwing assertions here used to be
  // swallowed as an ordinary refusal and could not prove 'before I/O' (E98 P3).
  let diskTouches = 0, childTouches = 0;
  const disk = new Proxy({}, { get() { diskTouches++; throw Error('unexpected filesystem access'); } });
  const child = { spawnSync() { childTouches++; throw Error('unexpected process'); } };
  for (const platform of ['linux', 'darwin']) {
    assert.equal(isolatedRuntime({ platform, disk, child }).prepareWindowsAuthorization({ captureRoot: '/absolute' }).ok, false);
  }
  for (const captureRoot of ['', 'relative', null, 42]) {
    assert.equal(isolatedRuntime({ disk, child }).prepareWindowsAuthorization({ captureRoot }).ok, false);
  }
  assert.equal(diskTouches, 0);
  assert.equal(childTouches, 0);
});

test('Windows authorization self-test rejects unstable identity, accepted junctions and failed startup; cleans only own probe', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-winauth-vm-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const stable = { volumeSerial: '1', fileId: 'a'.repeat(32), creationTime: '2' };
  const foreign = path.join(base, 'windows-authorization-helper', 'foreign-probe');
  fs.mkdirSync(foreign, { recursive: true }); fs.writeFileSync(path.join(foreign, 'keep'), 'keep');
  const goodChild = { spawnSync(python, args, options) {
    assert.ok(['python', 'python3'].includes(python));
    assert.deepEqual(Array.from(args.slice(0, 3)), ['-I', '-B', '-c']);
    assert.equal(options.timeout, 10000); assert.equal(options.maxBuffer, 1024);
    return { status: 0, stdout: Buffer.from('caff-windows-auth-v1\r\n'), stderr: Buffer.alloc(0) };
  } };
  for (const bad of ['identity-error', 'identity-drift', 'junction-accepted', 'junction-unknown-error', 'startup']) {
    let calls = 0;
    const api = isolatedRuntime({ child: bad === 'startup' ? { spawnSync() { return {
      status: 0, stdout: Buffer.from('PRIVATE_SENTINEL'), stderr: Buffer.alloc(0) }; } } : goodChild,
    // VM pretends to be Windows. On POSIX symlink(type=junction) is an ordinary
    // symlink and rmdir cannot delete it; emulate Windows junction unlink only
    // for this synthetic cross-platform self-test. Native tests use real rmdir.
    disk: { ...fs, rmdirSync(file) {
      if (process.platform !== 'win32' && fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file);
      else fs.rmdirSync(file);
    } },
    helper: { invokeWindowsHelper(python, helperPath, request) {
      calls++;
      assert.equal(request.op, 'identity', 'management self-test must not enumerate/read');
      assert.ok(request.root.startsWith(base));
      if (bad === 'identity-error') return { ok: false, reason: 'PRIVATE_SENTINEL' };
      if (calls <= 2) return { ok: true, identity: bad === 'identity-drift' && calls === 2 ? { ...stable, fileId: 'b'.repeat(32) } : stable };
      return bad === 'junction-accepted' ? { ok: true, identity: stable } : { ok: false, reason: 'PRIVATE_SENTINEL' };
    } } });
    const result = api.prepareWindowsAuthorization({ captureRoot: base });
    assert.equal(result.ok, false, bad);
    assert.equal(result.reason, 'windows_authorization_unavailable');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
    assert.equal(calls, bad === 'startup' ? 0 : bad === 'identity-error' || bad === 'identity-drift' ? 2 : 3);
    assert.deepEqual(fs.readdirSync(foreign), ['keep']);
    assert.equal(fs.readdirSync(path.dirname(foreign)).filter(name => name.startsWith('probe-')).length, 0);
  }
});

test('Windows failed authorization clears stale pins, disables and never falls back to Linux or target reads', native, t => {
  const { service, root } = temp(t);
  const policy = service.authorizeProject('p');
  assert.ok(policy.authorizedDirPins[pinKey(root)].identity);
  service.savePolicy('p', { ...policy, status: 'enabled' });
  const auth = runtime(), transport = require('../../build/server/domain/runtime/badcase-capture/windows-helper');
  const safe = require('../../build/server/domain/runtime/badcase-capture/safe-read');
  const previous = auth.prepareWindowsAuthorization, invoke = transport.invokeWindowsHelper, detect = safe.detectCaptureCapability;
  auth.prepareWindowsAuthorization = () => ({ ok: false, reason: 'windows_authorization_unavailable' });
  transport.invokeWindowsHelper = safe.detectCaptureCapability = () => assert.fail('must not read/fall back');
  try {
    assert.throws(() => service.authorizeProject('p'), e => e.code === 'windows_authorization_unavailable');
    const saved = service.loadPolicy('p');
    assert.equal(saved.status, 'disabled');
    assert.deepEqual(saved.authorizedDirPins, {});
    assert.deepEqual(saved.authorizedInputPins, {});
  } finally {
    auth.prepareWindowsAuthorization = previous; transport.invokeWindowsHelper = invoke; safe.detectCaptureCapability = detect;
  }
});
