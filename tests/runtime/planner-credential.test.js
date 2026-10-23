const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHash } = require('node:crypto');
const {
  resolvePlannerCredentialPath, buildWindowsAclInvocation, validateWindowsAclSnapshot,
  createPlannerCredential, createInMemoryPlannerCredential, validateWindowsAncestors, runWindowsAcl,
} = require('../../build/server/domain/security/planner-credential');

const sid = 'S-1-5-21-100-200-300-1001';
function snapshot(directory = false) {
  return { ownerSid: sid, protected: true, reparse: false, daclPresent: true,
    rules: [{ sid, rights: 2032127, type: 0, inherited: false, inheritance: directory ? 3 : 0, propagation: 0 }] };
}

test('planner credential path uses user state, deterministic instance names and absolute overrides', () => {
  const hash = createHash('sha256').update('::1').digest('hex');
  const env = { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' };
  assert.equal(resolvePlannerCredentialPath({ platform: 'win32', env, host: ' [::1] ', port: 34567 }),
    path.win32.join(env.LOCALAPPDATA, 'CAFF', 'planner', `planner-${hash}-34567.json`));
  assert.equal(resolvePlannerCredentialPath({ platform: 'linux', env: { HOME: '/home/test' }, host: 'localhost', port: 9 }),
    `/home/test/.local/state/caff/planner/planner-${createHash('sha256').update('localhost').digest('hex')}-9.json`);
  assert.match(resolvePlannerCredentialPath({ platform: 'linux', env: { XDG_STATE_HOME: '/tmp/state' }, host: 'localhost', port: 10 }), /^\/tmp\/state\/caff\/planner\//);
  assert.equal(resolvePlannerCredentialPath({ platform: 'linux', env: { CAFF_PLANNER_CREDENTIAL_FILE: '/tmp/private/custom.json' }, host: '', port: 1 }), '/tmp/private/custom.json');
  assert.throws(() => resolvePlannerCredentialPath({ platform: 'linux', env: { CAFF_PLANNER_CREDENTIAL_FILE: 'relative.json' }, host: 'x', port: 1 }));
  assert.throws(() => resolvePlannerCredentialPath({ platform: 'win32', env: {}, host: 'x', port: 1 }));
  assert.throws(() => resolvePlannerCredentialPath({ platform: 'linux', env: { HOME: '/home/test' }, host: 'x', port: 0 }));
});

test('Windows ACL command construction is SID-only, language-independent and does not interpolate paths', () => {
  const input = { operation: 'prepare', directory: 'C:\\test path\\中文\";echo danger', temporaryPath: 'C:\\test path\\临时.json' };
  const invocation = buildWindowsAclInvocation(input, { SystemRoot: 'C:\\Windows' });
  assert.equal(invocation.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(JSON.parse(invocation.options.input), input);
  assert.ok(!invocation.args.join(' ').includes(input.directory));
  const script = Buffer.from(invocation.args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(script, /SecurityIdentifier/);
  assert.match(script, /S-1-5-18/);
  assert.doesNotMatch(script, /icacls|whoami|NTAccount/);
});

test('Windows ACE validator accepts only protected owner/SYSTEM exact grants, never inherited or unresolved groups', () => {
  for (const directory of [false, true]) {
    assert.doesNotThrow(() => validateWindowsAclSnapshot(snapshot(directory), sid, directory));
    const system = snapshot(directory);
    system.rules.push({ ...system.rules[0], sid: 'S-1-5-18' });
    assert.doesNotThrow(() => validateWindowsAclSnapshot(system, sid, directory));
    const mutations = [
      x => { x.protected = false; }, x => { x.daclPresent = false; }, x => { x.reparse = true; },
      x => { x.ownerSid = 'S-1-5-21-foreign'; }, x => { x.rules = []; },
      x => { x.rules[0].inherited = true; }, x => { x.rules[0].type = 1; },
      x => { x.rules[0].rights = 1179785; }, x => { x.rules[0].propagation = 2; },
      x => { x.rules[0].inheritance = directory ? 0 : 3; },
      x => { x.rules.push({ ...x.rules[0], sid: 'S-1-5-21-100-200-300-99999' }); },
      x => { x.rules = [{ ...x.rules[0], sid: 'S-1-5-18' }]; },
      x => { x.rules[0].rights = '2032127'; },
      x => { x.rules.push({ ...x.rules[0] }); },
    ];
    for (const mutate of mutations) { const bad = snapshot(directory); mutate(bad); assert.throws(() => validateWindowsAclSnapshot(bad, sid, directory)); }
  }
  assert.throws(() => validateWindowsAclSnapshot(null, sid, false));
});

test('in-memory credentials are explicitly injected, never write state, and can be disabled', () => {
  const token = 'a'.repeat(43);
  const credential = createInMemoryPlannerCredential({ token, plannerName: 'Test Planner' });
  assert.equal(credential.path, null);
  assert.equal(credential.authenticate(token), null);
  credential.initialize();
  assert.equal(credential.authenticate(token).plannerName, 'Test Planner');
  assert.equal(credential.authenticate('b'.repeat(43)), null);
  assert.equal(credential.authenticate(token + '\n'), null);
  credential.disable();
  assert.equal(credential.authenticate(token), null);
  assert.throws(() => createInMemoryPlannerCredential({ token: 'invalid' }));
  assert.throws(() => createInMemoryPlannerCredential({ token: token + '\n' }));
});

test('Windows ancestors allow read/traverse and privileged owners but reject path replacement and reparse points', () => {
  const descriptor = { ...snapshot(true), protected: false };
  descriptor.rules.push({ sid: 'S-1-5-32-545', rights: 1179817, type: 0, inherited: true, inheritance: 3, propagation: 0 });
  const item = { path: 'C:\\Users\\test', descriptor };
  assert.doesNotThrow(() => validateWindowsAncestors([item], sid));
  const genericRead = structuredClone(item);
  genericRead.descriptor.rules[1].rights = -1610612736; // GENERIC_READ | GENERIC_EXECUTE, signed Int32
  assert.doesNotThrow(() => validateWindowsAncestors([genericRead], sid));
  for (const rights of [65536, 262144, 524288, 64, 0x10000000, 0x40000000]) {
    const unsafe = structuredClone(item); unsafe.descriptor.rules[1].rights = rights;
    assert.throws(() => validateWindowsAncestors([unsafe], sid), error => error.diagnostic.aceSid === 'S-1-5-32-545');
    unsafe.descriptor.rules[1].propagation = 2; // inherit-only ACE doesn't apply here
    assert.doesNotThrow(() => validateWindowsAncestors([unsafe], sid));
  }
  for (const mutate of [x => { x.reparse = true; }, x => { x.ownerSid = 'S-1-5-21-999'; }, x => { x.daclPresent = false; }]) {
    const unsafe = structuredClone(item); mutate(unsafe.descriptor);
    assert.throws(() => validateWindowsAncestors([unsafe], sid));
  }
  assert.throws(() => validateWindowsAncestors(null, sid));
});

test('Windows helper fails closed on exit failure and malformed output, with only structured diagnostics', () => {
  const input = { operation: 'inspect', directory: 'C:\\private', targetPath: 'C:\\private\\credential.json' };
  const env = { SystemRoot: 'C:\\Windows' };
  for (const result of [
    { status: 0, stdout: '{truncated' },
    { status: 0, stdout: '{}' },
    { status: 1, stdout: 'localized text with sensitive content', stderr: 'not public' },
    { status: null, error: { code: 'ENOENT', message: 'not public' }, stdout: '' },
  ]) {
    assert.throws(() => runWindowsAcl(input, env, () => result), error => {
      assert.ok(!JSON.stringify(error.diagnostic).includes('sensitive'));
      assert.ok(!JSON.stringify(error.diagnostic).includes('not public'));
      return true;
    });
  }
  assert.throws(() => runWindowsAcl(input, env, () => ({ status: 1, stdout: JSON.stringify({ failed: true, reason: 'unsafe_ancestor_access', stage: 'verify_acl', aceSid: 'S-1-5-32-545', rights: 64, osCode: -1 }) })),
    error => error.diagnostic.reason === 'unsafe_ancestor_access' && error.diagnostic.aceSid === 'S-1-5-32-545');
});

// File-backed publication logic is tested with in-memory I/O. Only the opt-in
// Windows check writes a real Windows credential file, in the approved location.
function memoryFiles() {
  const files = new Map();
  const io = {
    lstatSync(file) { if (!files.has(file)) throw Object.assign(Error('missing'), { code: 'ENOENT' }); return { isSymbolicLink: () => false }; },
    openSync(file) { assert.ok(files.has(file)); return file; },
    writeFileSync(file, content) { files.set(file, String(content)); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
    unlinkSync(file) { files.delete(file); }, closeSync() {}, fsyncSync() {}, mkdirSync() {},
  };
  return { files, io };
}

test('credential rotation and fail-closed ACL errors do not leak tokens or downgrade identity', () => {
  const { files, io } = memoryFiles();
  const credentialFile = path.join(path.parse(process.cwd()).root, 'virtual-planner', 'credential.json');
  const calls = [], logs = [];
  const acl = (input) => {
    calls.push(input);
    if (input.operation === 'prepare') files.set(input.temporaryPath, '');
    return { currentSid: sid, directory: snapshot(true), file: snapshot(), existingFile: files.has(input.targetPath) ? snapshot() : null };
  };
  const options = { platform: 'win32', fileSystem: io, env: { CAFF_PLANNER_CREDENTIAL_FILE: credentialFile },
    host: '127.0.0.1', getPort: () => 43210, windowsAcl: acl, log: x => logs.push(x) };
  const first = createPlannerCredential(options);
  assert.equal(first.authenticate('anything'), null);
  first.initialize();
  const token = JSON.parse(files.get(credentialFile)).token;
  assert.deepEqual(first.authenticate(token), { kind: 'planner', plannerId: 'local-planner', plannerName: 'External Planner' });
  assert.equal(first.authenticate('wrong'), null);
  assert.ok(!JSON.stringify(calls).includes(token));
  assert.ok(!JSON.stringify(logs).includes(token));
  const second = createPlannerCredential({ ...options, env: { ...options.env, CAFF_PLANNER_NAME: 'Claude Code' } });
  second.initialize();
  assert.equal(second.authenticate(token), null);
  assert.equal(JSON.parse(files.get(credentialFile)).plannerName, 'Claude Code');
  const disabled = createPlannerCredential({ ...options, windowsAcl: () => { throw Error('untrusted localized output'); } });
  disabled.initialize();
  assert.equal(disabled.authenticate(token), null);
  assert.match(JSON.stringify(logs), /planner_credentials_disabled/);
  assert.ok(!JSON.stringify(logs).includes('untrusted localized output'));
});

test('unsafe existing/final ACL snapshots disable authentication without leaving a newly published credential', () => {
  const { files, io } = memoryFiles();
  const file = path.join(path.parse(process.cwd()).root, 'virtual-planner', 'credential.json');
  const logs = [];
  const options = { platform: 'win32', fileSystem: io, env: { CAFF_PLANNER_CREDENTIAL_FILE: file }, host: 'localhost', getPort: () => 12345, log: entry => logs.push(entry) };
  let inspectedToken;
  const credential = createPlannerCredential({ ...options, windowsAcl(input) {
    if (input.operation === 'prepare') files.set(input.temporaryPath, '');
    else { inspectedToken = JSON.parse(files.get(input.targetPath)).token; }
    const descriptor = snapshot();
    if (input.operation === 'inspect') descriptor.protected = false;
    return { currentSid: sid, directory: snapshot(true), file: descriptor };
  } });
  credential.initialize();
  assert.equal(credential.authenticate(inspectedToken), null);
  assert.equal(files.has(file), false);
  assert.ok(!JSON.stringify(logs).includes(inspectedToken));
  files.set(file, 'existing-unsafe-file-must-not-be-read-or-replaced');
  const before = files.get(file);
  const existing = createPlannerCredential({ ...options, windowsAcl(input) {
    if (input.operation === 'prepare') files.set(input.temporaryPath, '');
    const bad = snapshot(); bad.rules.push({ ...bad.rules[0], sid: 'S-1-5-32-545' });
    return { currentSid: sid, directory: snapshot(true), file: snapshot(), existingFile: bad };
  } });
  existing.initialize();
  assert.equal(files.get(file), before);
  assert.equal([...files.keys()].filter(name => name.endsWith('.tmp')).length, 0);
});

test('POSIX credential publication uses private modes and rejects symlinks and unsafe ancestors', { skip: process.platform === 'win32' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-planner-posix-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'private', 'credential.json');
  const options = { env: { CAFF_PLANNER_CREDENTIAL_FILE: file }, host: 'localhost', getPort: () => 34567, log() {} };
  const credential = createPlannerCredential(options); credential.initialize();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(credential.authenticate(JSON.parse(fs.readFileSync(file)).token).kind, 'planner');
  fs.unlinkSync(file); fs.symlinkSync(path.join(root, 'other'), file);
  const bad = createPlannerCredential(options); bad.initialize();
  assert.equal(bad.authenticate('x'), null);
  fs.unlinkSync(file); fs.chmodSync(path.dirname(file), 0o777);
  const unsafe = createPlannerCredential({ ...options, env: { CAFF_PLANNER_CREDENTIAL_FILE: path.join(path.dirname(file), 'nested', 'credential.json') } }); unsafe.initialize();
  assert.equal(fs.existsSync(path.join(path.dirname(file), 'nested', 'credential.json')), false);
});
