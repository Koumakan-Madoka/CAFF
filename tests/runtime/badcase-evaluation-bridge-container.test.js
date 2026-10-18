// Host synthetic CLI traffic under an emulated container gate. NOT Docker evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const filename = path.resolve(__dirname, '../../scripts/badcase-capture/evaluation-bridge-container.cjs');
const callback = require('../../build/server/domain/runtime/badcase-capture/evaluation-callback');
const store = require('../../build/lib/chat-app-store');
function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-container-bridge-test-'));
  const services = [], calls = [];
  t.after(async () => { for (const s of services) await s.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const module = { exports: {} };
  let stopped = 0;
  const mockRequire = n => {
    if (n === '/work/build/server/domain/runtime/badcase-capture/evaluation-callback') return {
      startEvaluationCallback: async input => {
        if (options.failSecondStart && services.length === 1) throw Error('private startup detail');
        const s = await callback.startEvaluationCallback({ ...input, directory: path.join(root, path.basename(input.directory)) });
        services.push(s);
        let closed = false;
        return { ...s, stop: async () => { if (!closed) { stopped++; closed = true; } await s.stop();
          if (options.failStop) throw Error('private cleanup detail'); } };
      },
    };
    if (n === '/work/build/lib/chat-app-store') return store;
    if (n === 'node:child_process') return { spawn: (exe, args, cfg) => {
      calls.push({ exe, args, cfg });
      const script = options.failChild ? ['-e', 'process.stderr.write("private diagnostic text");process.exit(7)']
        : options.badJson ? ['-e', 'process.stdout.write("not-json")']
        : options.stderrOnly && calls.length === 1 ? ['-e', 'process.stdout.write(JSON.stringify({latestUserMessage:{id:"eval-user",content:"Synthetic container bridge context."}}));process.stderr.write("private child detail")']
        : options.largeOutput && calls.length === 1 ? ['-e', 'process.stdout.write(JSON.stringify({latestUserMessage:{id:"eval-user",content:"Synthetic container bridge context."},padding:"x".repeat(70000)}))']
        : options.timeoutChild ? ['-e', 'setInterval(()=>{},1000)']
        : [path.resolve(__dirname, '../../build/lib/agent-chat-tools.js'), ...args.slice(1)];
      return spawn(exe, script, { ...cfg, cwd: root });
    } };
    if (n === 'node:fs') return { ...fs, existsSync: p => p === '/.dockerenv' ? options.containerMarker !== false : fs.existsSync(p) };
    return require(n);
  };
  const proc = { platform: 'linux', getuid: () => 65534, cwd: () => '/work', execPath: process.execPath, env: {}, ...options.process };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: mockRequire, module, process: proc,
    Buffer, URL, fetch: options.ambiguousClose ? (u, cfg) => new URL(u).pathname === '/' ? Promise.reject(Error('timeout')) : fetch(u, cfg) : fetch,
    AbortSignal, setTimeout, clearTimeout, console: { log: () => assert.fail('no raw output in imported entry') } }, { filename });
  return { run: module.exports.runContainerBridgeDiagnostic, calls, services, root, stopped: () => stopped };
}
test('entry exists and non-container execution fails before callback import or directory writes', () => {
  assert.equal(fs.existsSync(filename), true);
  const r = spawnSync(process.execPath, [filename], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr, 'evaluation_bridge_diagnostic_failed\n');
});
test('emulated namespace uses existing CLI/HTTP/SQLite, fresh credentials, isolated DBs and always closes callbacks', async t => {
  const h = harness(t), r = await h.run();
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { kind: 'container-evaluation-bridge-diagnostic-v1',
    instances: 2, cliCalls: 5, crossAuthDenied: true, contextVerified: true, participantsVerified: true,
    publicMessagePersisted: true, callbackClosed: true, modelCalls: 0, piExecuted: false, runnable: false,
    reproduced: false, evaluable: false, strictEvalEligible: false });
  assert.equal(h.stopped(), 2); assert.equal(h.calls.length, 5);
  for (const c of h.calls) {
    assert.equal(c.exe, process.execPath); assert.equal(c.args[0], '/work/build/lib/agent-chat-tools.js');
    assert.equal(c.cfg.shell, false); assert.equal(c.cfg.cwd, '/work');
    assert.deepEqual(Object.keys(c.cfg.env).sort(), ['CAFF_CHAT_API_URL', 'CAFF_CHAT_CALLBACK_TOKEN', 'CAFF_CHAT_INVOCATION_ID', 'HOME', 'PATH', 'TMPDIR']);
    assert.equal(c.args.some(a => a.includes(h.services[0].credentials.callbackToken)), false);
  }
  assert.notEqual(h.services[0].databasePath, h.services[1].databasePath);
  assert.notDeepEqual(h.services[0].credentials, h.services[1].credentials);
  for (const s of h.services) await assert.rejects(fetch(s.apiUrl));
  const bytes = JSON.stringify(r); for (const s of h.services) assert.equal(bytes.includes(s.credentials.callbackToken), false);
});
test('child failure joins it and stops both callbacks without exporting stderr or credentials', async t => {
  const h = harness(t, { failChild: true });
  await assert.rejects(h.run(), e => { assert.equal(e.message, 'evaluation_bridge_diagnostic_failed'); return true; });
  assert.equal(h.calls.length, 1); assert.equal(h.stopped(), 2);
  for (const s of h.services) await assert.rejects(fetch(s.apiUrl));
});
test('partial startup, malformed/oversized output, child timeout, ambiguous close and cleanup failure never return success', async t => {
  for (const options of [{ failSecondStart: true }, { badJson: true }, { stderrOnly: true }, { largeOutput: true }, { timeoutChild: true },
    { ambiguousClose: true }, { failStop: true }]) {
    const h = harness(t, options);
    await assert.rejects(h.run(), e => { assert.equal(e.message, 'evaluation_bridge_diagnostic_failed'); return true; });
    assert.equal(h.stopped(), options.failSecondStart ? 1 : 2, JSON.stringify(options));
    for (const s of h.services) await assert.rejects(fetch(s.apiUrl));
  }
});
test('missing container marker refuses before callback/child even with matching uid/cwd', async t => {
  const h = harness(t, { containerMarker: false });
  await assert.rejects(h.run(), /evaluation_bridge_diagnostic_failed/);
  assert.equal(h.calls.length, 0); assert.equal(h.services.length, 0);
});
test('container gate refuses unsupported platform, uid, cwd and ambient auth/hooks before any callback or child', async t => {
  for (const change of [{ platform: 'win32' }, { getuid: () => 0 }, { cwd: () => '/elsewhere' },
    { env: { CAFF_CHAT_API_URL: 'http://production.invalid' } }, { env: { NODE_OPTIONS: '--inspect' } }]) {
    const h = harness(t, { process: change });
    await assert.rejects(h.run(), /evaluation_bridge_diagnostic_failed/);
    assert.equal(h.calls.length, 0); assert.equal(h.services.length, 0);
  }
});
