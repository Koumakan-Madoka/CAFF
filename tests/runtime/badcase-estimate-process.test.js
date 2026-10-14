const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { runEstimateProcess } = require('../../build/server/domain/runtime/badcase-capture/estimate-process');
const { createBadcaseCaptureService } = require('../../build/server/domain/runtime/badcase-capture');

function fixture(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-estimate-process-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workerPath = path.join(root, 'worker.cjs');
  fs.writeFileSync(workerPath, source);
  return { root, workerPath };
}
const linux = { skip: process.platform !== 'linux' && 'process-group cleanup requires Linux' };

test('async estimation is explicit and does not fall back to synchronous scanning', async t => {
  const { root } = fixture(t, '');
  const service = createBadcaseCaptureService({ captureRoot: path.join(root, 'cas') });
  assert.equal(typeof service.estimateDirectoryAsync, 'function');
  service.estimateDirectory = () => { throw Error('sync fallback'); };
  const result = await service.estimateDirectoryAsync('p', path.join(root, 'target'));
  assert.equal(result.ok, false);
  assert.equal(result.reason, process.platform === 'linux' ? 'dir_not_authorized' : `capture_unavailable:safe_read_capability_missing:${process.platform}`);
  assert.equal(service.store.listCheckpoints('p').length, 0);
});

test('a real HTTP health request responds while the estimator child is blocked', linux, async t => {
  const { workerPath } = fixture(t, `process.stdin.resume(); process.stdin.on('end', () => {
    process.stdout.write(' '); // explicit startup barrier
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    process.stdout.write(JSON.stringify({ok:true, complete:true, fileCount:1, totalBytes:7}));
  });`);
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  // The observer only establishes that the actual child is executing; it does
  // not replace spawn, process termination, HTTP, or estimation's Promise.
  let finished = false;
  const running = runEstimateProcess({}, { workerPath, timeoutMs: 5000, onOutput: started })
    .then(result => { finished = true; return result; });
  const server = http.createServer((_req, res) => res.end('healthy'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await ready;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(await response.text(), 'healthy');
  assert.equal(finished, false, 'HTTP completed before the blocked child finished');
  assert.equal((await running).ok, true);
});

test('timeout kills the estimator and its helper group before returning failure', linux, async t => {
  const { root, workerPath } = fixture(t, `const {spawn} = require('node:child_process');
    process.stdin.resume(); process.stdin.on('end', () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'inherit'});
      process.stdout.write(JSON.stringify({worker:process.pid, helper:child.pid})+'\\n');
      setInterval(()=>{},1000);
    });`);
  let ids;
  const result = await runEstimateProcess({}, { workerPath, timeoutMs: 1000,
    onOutput: bytes => { ids = JSON.parse(bytes.toString()); } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'estimate_timeout');
  assert.ok(ids?.worker && ids?.helper);
  // Containers can retain orphan zombies until init reaps; zombies cannot run
  // or retain open fds. Do not confuse that with a live helper leak.
  for (const pid of [ids.worker, ids.helper]) {
    let state = '';
    try { state = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0]; }
    catch (error) { assert.equal(error.code, 'ENOENT'); }
    assert.ok(state === '' || state === 'Z', `pid ${pid} still running (${state})`);
  }
  assert.equal(fs.readdirSync(root).length, 1);
});

test('two active children bound admission and the slot is released after timeout', linux, async t => {
  const { workerPath } = fixture(t, "process.stdout.write(' '); setInterval(()=>{},1000)");
  const barriers = [];
  const running = [0, 1].map(() => {
    let ready;
    barriers.push(new Promise(resolve => { ready = resolve; }));
    return runEstimateProcess({}, { workerPath, timeoutMs: 1000, onOutput: ready });
  });
  await Promise.all(barriers);
  const rejected = await runEstimateProcess({}, { workerPath });
  assert.equal(rejected.reason, 'estimate_busy');
  for (const result of await Promise.all(running)) assert.equal(result.reason, 'estimate_timeout');
  const next = await runEstimateProcess({}, { workerPath, timeoutMs: 100 });
  assert.equal(next.reason, 'estimate_timeout', 'admission slots must be released');
});

test('bounded output, invalid JSON and abnormal exit fail closed', linux, async t => {
  for (const [source, reason] of [
    ["process.stdout.write('x'.repeat(65536)); setInterval(()=>{},1000)", 'estimate_output_limit'],
    ["process.stdout.write('not json')", 'estimate_output_invalid'],
    ["process.stdout.write('{}'); process.exitCode=2", 'estimate_process_failed'],
  ]) {
    const { workerPath } = fixture(t, source);
    const result = await runEstimateProcess({}, { workerPath, timeoutMs: 5000, maxOutputBytes: 1024 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
  }
});

test('authorized async estimator matches real sync collector without policy/checkpoint writes', linux, async t => {
  const { root } = fixture(t, '');
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'a.txt'), 'hello');
  const service = createBadcaseCaptureService({ captureRoot: path.join(root, 'cas') });
  service.savePolicy('p', { status: 'disabled', authorizedDirs: [target] });
  service.authorizeProject('p');
  const before = JSON.stringify(service.loadPolicy('p'));
  const expected = service.estimateDirectory('p', target);
  const actual = await service.estimateDirectoryAsync('p', target);
  assert.equal(expected.ok, true, JSON.stringify(expected));
  assert.deepEqual({ ...actual, durationMs: 0 }, { ...expected, durationMs: 0 });
  assert.equal(JSON.stringify(service.loadPolicy('p')), before);
  assert.equal(service.store.listCheckpoints('p').length, 0);
  for (let attempt = 0; attempt < 5; attempt++) {
    const pair = await Promise.all([service.estimateDirectoryAsync('p', target), service.estimateDirectoryAsync('p', target)]);
    for (const result of pair) assert.equal(result.ok, true, JSON.stringify(result));
  }
  fs.renameSync(target, `${target}-old`);
  fs.mkdirSync(target);
  const replaced = await service.estimateDirectoryAsync('p', target);
  assert.equal(replaced.ok, false);
  assert.equal(replaced.reason, 'authorized_root_replaced');
});
