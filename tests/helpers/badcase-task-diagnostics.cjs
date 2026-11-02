// Synthetic VM only. Never imports the SDK, starts Docker, calls a model or reads
// the real host FS from the evaluated task. This verifies diagnostics, not replay.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
module.exports = async function taskDiagnostic(fault) {
  const source = fs.readFileSync(path.join(__dirname, '../../scripts/badcase-capture/model-task-container.cjs'), 'utf8');
  const importText = "await import('./runtime/dist/bundle/index.js')";
  assert.equal(source.split(importText).length, 2);
  const poison = new Proxy({}, { get() { throw Error('must not inspect exception'); } });
  const fail = phase => { if (fault === phase || (fault === 'at_limit_artifact' && phase === 'artifact')) throw poison; };
  const plan = { materialized: { capsuleHash: hash('capsule') }, mode: 'fresh', invocation: 'input', messages: [] };
  const task = { runId: 'a'.repeat(64), role: 'role', expiresAt: Date.now() + 60000, capsuleHash: plan.materialized.capsuleHash,
    deliveryMode: 'fresh', invocationHash: hash(plan.invocation), historyHash: hash(JSON.stringify(plan.messages)) };
  const profile = { settings: { provider: 'synthetic', model: 'fixture', contextWindowTokens: 1000, maxOutputTokens: 100 }, maxRequests: 2 };
  const material = {
    'probe.cjs': '', 'task.json': JSON.stringify(task), 'model-profile.json': JSON.stringify(profile), 'container-model-adapter.cjs': '',
    'capsule.json': 'capsule', 'expected.json': '{}', 'environment.json': JSON.stringify({ nodeVersion: 'v24.21.0', pythonVersion: 'Python 3.11.2', architecture: 'amd64' }),
    'runtime/package.json': JSON.stringify({ version: '0.85.1' }), 'runtime/bundled-pi-ai/package.json': JSON.stringify({ version: '0.85.1' }),
  };
  const files = Object.keys(material).map(name => ({ path: name }));
  material['manifest.json'] = JSON.stringify({ schemaVersion: 1, files, inputHash: hash(JSON.stringify(files)),
    runtimeHash: hash(JSON.stringify(files.filter(f => f.path.startsWith('runtime/')))) });
  const artifact = Buffer.from('done\n');
  const mockFs = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 1 }, existsSync: () => true,
    readFileSync(file, encoding) { if (file.endsWith('/manifest.json')) fail('materials'); const value = material[file.slice('/work/'.length)]; assert.notEqual(value, undefined); return encoding ? value : Buffer.from(value); },
    lstatSync(file) { if (file.endsWith('/evaluation-result.txt')) { fail('artifact'); return { isFile: () => true, size: BigInt(artifact.length), ino: 1n, dev: 2n }; }
      return { isFile: () => true, isSymbolicLink: () => false, size: Buffer.byteLength(material[file.slice('/work/'.length)]) }; },
    openSync: () => 7, fstatSync: () => ({ size: BigInt(artifact.length), ino: 1n, dev: 2n }),
    readSync(fd, buffer) { artifact.copy(buffer); return artifact.length; }, closeSync() {},
  };
  let modelRuntime, received = 0, stdout = '', stderr = '', disposed = 0;
  const adapter = {
    createMailbox() { return async () => { assert.ok(++received <= profile.maxRequests); return Buffer.from('{}'); }; },
    modelStream(p, exchange) { return () => ({ result: () => exchange(Buffer.from('{}')) }); },
  };
  const manager = { getCwd: () => '/work/restored/snapshot' };
  const session = {
    messages: [], subscribe() {},
    async prompt() {
      fail('prompt');
      if (fault === 'request_limit' || fault === 'request_limit_swallowed') {
        try { for (let i = 0; i < 3; i++) await modelRuntime.streamSimple().result(); }
        catch (e) { if (fault === 'request_limit') throw e; }
      } else {
        const calls = fault === 'at_limit' || fault === 'at_limit_artifact' ? 2 : 1;
        for (let i = 0; i < calls; i++) await modelRuntime.streamSimple().result();
      }
      this.messages.push({ role: 'assistant', stopReason: fault === 'final' || fault === 'request_limit_swallowed' ? 'error' : 'stop' });
    },
    dispose() { disposed++; fail('dispose'); },
  };
  const sdk = {
    VERSION: '0.85.1', ModelRuntime: { async create() { fail('runtime'); modelRuntime = { registerProvider() {}, getModel: () => ({}) }; return modelRuntime; } },
    SessionManager: { create: () => manager }, SettingsManager: { inMemory: x => x },
    async createAgentSession() { fail('session'); return { session, modelFallbackMessage: undefined }; },
  };
  const process = { platform: fault === 'bootstrap' ? 'other' : 'linux', getuid: () => 65534, cwd: () => '/work', version: 'v24.21.0', arch: 'x64', env: {},
    stderr: { write: s => { stderr += s; } } };
  const modules = {
    'node:fs': mockFs, 'node:crypto': crypto, 'node:assert/strict': assert,
    'node:child_process': { execFileSync: () => 'Python 3.11.2\n' }, './pi-probe-guards.cjs': { verifyMaterialBytes() {} },
    './retained-sdk-diagnostic.js': { planRetainedSdkDiagnostic() { fail('input'); return plan; } },
    './capsule-materialization.js': { materializeInitializationCapsule: () => plan.materialized },
    './secrets.js': { containsSecretSentinel: () => false }, './container-model-adapter.cjs': adapter,
  };
  await vm.runInNewContext(source.replace(importText, 'await Promise.resolve(globalThis.__sdk)'), {
    require(name) { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; },
    process, Buffer, performance: { now: () => 0 }, __sdk: sdk,
    console: { log(s) { fail('receipt'); stdout += s; } },
  }, { timeout: 1000 });
  return { stdout, stderr, exitCode: process.exitCode, received, disposed };
};
