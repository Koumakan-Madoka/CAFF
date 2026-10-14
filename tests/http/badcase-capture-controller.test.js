const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const http = require('node:http');
const { createBadcaseCaptureController } = require('../../build/server/api/badcase-capture-controller');
const { createBadcaseCaptureService } = require('../../build/server/domain/runtime/badcase-capture');

const headers = { host: '127.0.0.1:4313', 'content-type': 'application/json', origin: 'http://127.0.0.1:4313', 'x-caff-csrf-token': 'test-csrf' };
async function invoke(controller, action = '', body, overrides = {}) {
  const req = new PassThrough();
  req.method = body === undefined ? 'GET' : 'POST';
  Object.assign(req, overrides);
  req.headers = { ...headers, ...overrides.headers };
  req.socket = { remoteAddress: overrides.remoteAddress || '127.0.0.1' };
  const pathname = overrides.pathname || `/api/projects/project-test/badcase-capture${action ? '/' + action : ''}`;
  let result;
  const res = { writeHead(status) { this.status = status; }, end(bytes) { result = { status: this.status, body: JSON.parse(bytes) }; } };
  const pending = controller({ req, res, pathname, requestUrl: new URL('http://127.0.0.1:4313' + pathname) });
  req.end(body === undefined ? undefined : JSON.stringify(body));
  assert.equal(await pending, true);
  return result;
}
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-capture-api-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'hello.txt'), 'hello');
  const captureRoot = path.join(root, 'cas');
  const service = createBadcaseCaptureService({ captureRoot });
  let now = 1000;
  const options = { service, projectManager: { listProjects: () => [{ id: 'project-test' }] }, host: '127.0.0.1', port: 4313, csrfToken: 'test-csrf', now: () => now };
  return { root, target, captureRoot, service, options, controller: createBadcaseCaptureController(options), advance: () => { now += 11 * 60 * 1000; } };
}
const rejects = (fn, code, status = 422) => assert.rejects(fn, e => e.statusCode === status && e.issues?.[0]?.code === code);
const authorization = target => ({ confirmed: true, authorizedDirs: [target], authorizedInputDirs: [], includedIgnoredPatterns: [], excludedPatterns: ['.git', 'node_modules'] });

// Policy/CAS persistence is real; only positive estimates are synthetic here.
// Real constrained enumeration is independently exercised by the Linux collector suites.
function fakeEstimates(h) {
  const calls = [];
  h.service.estimateDirectoryAsync = (id, dir) => {
    calls.push({ id, dir });
    return { ok: true, complete: true, includesIgnored: true, totalBytes: 5, fileCount: 1, durationMs: 0, uncaptured: [] };
  };
  return calls;
}

// Real HTTP + real inventory failure (a category is a file, not a directory).
// Only target estimates are synthetic; no real project is enabled.
for (const action of ['', 'authorize', 'settings', 'disable', 'enable']) {
  test(`unavailable inventory preserves HTTP policy observability for ${action || 'GET'}`, async t => {
    const h = setup(t);
    await invoke(h.controller, 'authorize', authorization(h.target));
    fakeEstimates(h);
    const receipt = (await invoke(h.controller, 'estimate', {})).body.estimateId;
    if (action === 'disable') h.service.savePolicy('project-test', { ...h.service.loadPolicy('project-test'), status: 'enabled' });
    const category = path.join(h.captureRoot, 'projects', 'project-test', 'flags');
    fs.writeFileSync(category, 'invalid category');
    assert.throws(() => h.service.computeUsage('project-test'), /capture_usage_unavailable/);
    const before = h.service.loadPolicy('project-test');
    let controller;
    const server = http.createServer(async (req, res) => {
      try { await controller({ req, res, pathname: req.url }); }
      catch (error) { res.writeHead(error.statusCode || 500); res.end(JSON.stringify({ error: error.message })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const port = server.address().port;
    controller = createBadcaseCaptureController({ ...h.options, port });
    // Receipts are per controller; obtain one on the HTTP controller before enable.
    const base = `http://127.0.0.1:${port}`;
    const endpoint = `${base}/api/projects/project-test/badcase-capture`;
    const post = (name, body) => fetch(`${endpoint}/${name}`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-caff-csrf-token': 'test-csrf' }, body: JSON.stringify(body) });
    const estimateId = action === 'enable' ? (await (await post('estimate', {})).json()).estimateId : receipt;
    const body = action === 'authorize' ? authorization(h.target) : action === 'settings' ? { stagingQuotaBytes: 12345 }
      : action === 'enable' ? { confirmed: true, estimateId } : {};
    const response = action ? await post(action, body) : await fetch(endpoint);
    const payload = await response.json();
    // Check persistence even when the old implementation responds 500.
    const persisted = createBadcaseCaptureService({ captureRoot: h.captureRoot }).loadPolicy('project-test');
    assert.equal(persisted.status, action === 'enable' ? 'enabled' : 'disabled');
    if (action === 'settings') assert.equal(persisted.stagingQuotaBytes, 12345);
    if (!action) assert.deepEqual(persisted, before, 'GET must not mutate policy');
    assert.equal(response.status, 200);
    assert.deepEqual(payload.policy, persisted);
    assert.equal(payload.usage, null);
    assert.equal(payload.usageError, 'capture_usage_unavailable');
    assert.equal(payload.trustBoundary, 'same_os_user');
    assert.equal(JSON.stringify(payload).includes(h.captureRoot), false);
    assert.deepEqual(await (await fetch(endpoint)).json(), payload, 're-reading must remain available');
    assert.throws(() => h.service.computeUsage('project-test'), /capture_usage_unavailable/, 'storage failures still fail closed');
    fs.unlinkSync(category);
    const recovered = await (await fetch(endpoint)).json();
    assert.equal(recovered.usage.totalBytes, 0);
    assert.equal(recovered.usageError, null);
    assert.deepEqual(recovered.policy, persisted);
    assert.equal(h.service.store.listCheckpoints('project-test').length, 0);
  });
}

test('inventory degradation does not hide policy, save or unexpected service failures', async t => {
  const h = setup(t);
  h.service.computeUsage = () => { throw Error('capture_usage_unavailable'); };
  h.service.loadPolicy = () => { throw Error('policy read failed'); };
  await assert.rejects(() => invoke(h.controller), /policy read failed/);
  h.service.loadPolicy = createBadcaseCaptureService({ captureRoot: h.captureRoot }).loadPolicy;
  h.service.savePolicy = () => { throw Error('policy save failed'); };
  await assert.rejects(() => invoke(h.controller, 'disable', {}), /policy save failed/);
  h.service.computeUsage = () => { throw Error('unexpected service failure'); };
  await assert.rejects(() => invoke(h.controller), /unexpected service failure/);
});

test('default GET and guard failures never scan or authorize', async t => {
  const h = setup(t);
  let touches = 0;
  h.service.estimateDirectoryAsync = h.service.authorizeProject = () => { touches++; throw Error('unexpected target access'); };
  const state = await invoke(h.controller);
  assert.equal(state.body.policy.status, 'disabled');
  assert.equal(state.body.trustBoundary, 'same_os_user');
  assert.equal(state.body.usage.totalBytes, 0);
  for (const action of ['authorize', 'estimate', 'enable', 'disable', 'settings']) {
    await rejects(() => invoke(h.controller, action, {}, { headers: { 'x-caff-csrf-token': '' } }), 'badcase_capture_csrf_invalid', 403);
    await rejects(() => invoke(h.controller, action, {}, { headers: { origin: 'http://evil.invalid' } }), 'badcase_capture_origin_mismatch', 403);
  }
  await rejects(() => invoke(h.controller, '', undefined, { remoteAddress: '192.0.2.1' }), 'badcase_capture_local_only', 403);
  await rejects(() => invoke(h.controller, '', undefined, { headers: { host: 'evil.invalid' } }), 'badcase_capture_host_mismatch', 403);
  await rejects(() => invoke(h.controller, 'estimate', {}), 'badcase_capture_not_authorized', 409);
  await rejects(() => invoke(h.controller, '', undefined, { pathname: '/api/projects/missing/badcase-capture' }), 'badcase_capture_project_missing', 404);
  assert.equal(touches, 0);
});

test('authorization is explicit, disables collection, and settings cannot expand or re-pin it', async t => {
  const h = setup(t);
  await rejects(() => invoke(h.controller, 'authorize', { ...authorization(h.target), confirmed: false }), 'badcase_capture_confirmation_required');
  for (const dirs of [[''], ['relative'], [h.root], [h.captureRoot], [42]]) {
    await rejects(() => invoke(h.controller, 'authorize', { ...authorization(h.target), authorizedDirs: dirs }), 'badcase_capture_invalid_directories');
  }
  assert.deepEqual(h.service.loadPolicy('project-test').authorizedDirs, []);
  const response = await invoke(h.controller, 'authorize', authorization(h.target));
  assert.equal(response.body.policy.status, 'disabled');
  const pins = response.body.policy.authorizedDirPins;
  assert.ok(Object.keys(pins).length);
  for (const body of [{ authorizedDirs: [h.root] }, { status: 'enabled' }, { authorizedDirPins: {} }, { excludedPatterns: [] }]) {
    await rejects(() => invoke(h.controller, 'settings', body), 'badcase_capture_unknown_field');
  }
  for (const value of [0, -1, 1.5, '20', Number.MAX_SAFE_INTEGER + 1]) {
    await rejects(() => invoke(h.controller, 'settings', { stagingQuotaBytes: value }), 'badcase_capture_invalid_limit');
  }
  const saved = await invoke(h.controller, 'settings', { stagingRetentionDays: 3, stagingQuotaBytes: 2048 });
  assert.deepEqual(saved.body.policy.authorizedDirPins, pins);
  assert.equal(saved.body.policy.status, 'disabled');
  const restarted = createBadcaseCaptureService({ captureRoot: h.captureRoot }).loadPolicy('project-test');
  assert.equal(restarted.stagingRetentionDays, 3);
  assert.equal(restarted.stagingQuotaBytes, 2048);
  assert.deepEqual(restarted.authorizedDirPins, pins);
});

test('estimate receipt gates enable; enable revalidates and disable persists without scanning', async t => {
  const h = setup(t);
  await invoke(h.controller, 'authorize', authorization(h.target));
  const calls = fakeEstimates(h);
  await rejects(() => invoke(h.controller, 'enable', { confirmed: true, estimateId: 'forged' }), 'badcase_capture_estimate_required', 409);
  const estimate = await invoke(h.controller, 'estimate', {});
  assert.equal(calls.length, 1);
  assert.equal(h.service.loadPolicy('project-test').status, 'disabled');
  assert.equal(h.service.store.listCheckpoints('project-test').length, 0);
  assert.ok(estimate.body.estimateId);
  await rejects(() => invoke(h.controller, 'enable', { estimateId: estimate.body.estimateId }), 'badcase_capture_confirmation_required');
  const enabled = await invoke(h.controller, 'enable', { confirmed: true, estimateId: estimate.body.estimateId });
  assert.equal(enabled.body.policy.status, 'enabled');
  assert.equal(calls.length, 2);
  assert.equal(createBadcaseCaptureService({ captureRoot: h.captureRoot }).loadPolicy('project-test').status, 'enabled');
  await invoke(h.controller, 'disable', {});
  assert.equal(calls.length, 2);
  const restarted = createBadcaseCaptureService({ captureRoot: h.captureRoot, onFileRead: () => { throw Error('must not read'); } });
  assert.equal(restarted.loadPolicy('project-test').status, 'disabled');
  assert.equal(restarted.captureTurnCheckpoint({ projectId: 'project-test', targetDir: h.target }).reason, 'policy_not_enabled');
  await rejects(() => invoke(h.controller, 'enable', { confirmed: true, estimateId: estimate.body.estimateId }), 'badcase_capture_estimate_required', 409);
});

test('real collector estimate stays disabled and reports platform capability honestly', async t => {
  const h = setup(t);
  await invoke(h.controller, 'authorize', authorization(h.target));
  const result = (await invoke(h.controller, 'estimate', {})).body;
  assert.equal(h.service.loadPolicy('project-test').status, 'disabled');
  assert.equal(h.service.store.listCheckpoints('project-test').length, 0);
  if (process.platform === 'linux') {
    assert.equal(result.complete, true);
    assert.equal(result.totalBytes, 5);
    assert.equal(result.estimates[0].fileCount, 1);
    assert.ok(result.estimateId);
    fs.renameSync(h.target, h.target + '-original');
    fs.mkdirSync(h.target);
    await rejects(() => invoke(h.controller, 'enable', { confirmed: true, estimateId: result.estimateId }), 'authorized_root_replaced', 409);
  } else {
    assert.equal(result.complete, false);
    assert.equal(result.estimateId, null);
    assert.match(result.estimates[0].reason, /^capture_unavailable:/);
  }
  assert.equal(h.service.loadPolicy('project-test').status, 'disabled');
});

test('real HTTP remains responsive during real constrained walk and disable invalidates its result', {
  skip: process.platform !== 'linux', timeout: 15000,
}, async t => {
  const h = setup(t);
  await invoke(h.controller, 'authorize', authorization(h.target));
  // Delay only the real Python walk; probes/statx and every constrained read
  // still execute the production helper with the inherited root fd 3.
  const bin = path.join(h.root, 'bin');
  fs.mkdirSync(bin);
  const marker = path.join(h.root, 'walk-started');
  fs.writeFileSync(path.join(bin, 'python3'), `#!/usr/bin/python3
import os, sys, subprocess, time
if '--version' in sys.argv:
    os.execv('/usr/bin/python3', ['/usr/bin/python3'] + sys.argv[1:])
data = sys.stdin.buffer.read()
if b'"op":"walk"' in data:
    open(${JSON.stringify(marker)}, 'w').close()
    time.sleep(1.5)
sys.exit(subprocess.run(['/usr/bin/python3'] + sys.argv[1:], input=data, pass_fds=(3,)).returncode)
`, { mode: 0o755 });
  let controller;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') { res.end('healthy'); return; }
    try { await controller({ req, res, pathname: req.url }); }
    catch (error) { res.writeHead(error.statusCode || 500); res.end(JSON.stringify({ code: error.issues?.[0]?.code })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  controller = createBadcaseCaptureController({ ...h.options, port });
  const base = `http://127.0.0.1:${port}`;
  const post = action => fetch(`${base}/api/projects/project-test/badcase-capture/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-caff-csrf-token': 'test-csrf' }, body: '{}',
  });
  const oldPath = process.env.PATH;
  let watcher;
  let deadline;
  const started = new Promise((resolve, reject) => {
    watcher = fs.watch(h.root, () => { if (fs.existsSync(marker)) resolve(); });
    deadline = setTimeout(() => reject(Error('walk did not start')), 8000);
  });
  let pending;
  try {
    process.env.PATH = `${bin}:${oldPath}`;
    let finished = false;
    pending = post('estimate').then(response => { finished = true; return response; });
    await started;
    assert.equal(await (await fetch(`${base}/health`)).text(), 'healthy');
    assert.equal(finished, false, 'health must finish before the real walk completes');
    assert.equal((await post('disable')).status, 200);
    const response = await pending;
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'badcase_capture_operation_stale');
    assert.equal(h.service.loadPolicy('project-test').status, 'disabled');
    assert.equal(h.service.store.listCheckpoints('project-test').length, 0);
  } finally {
    process.env.PATH = oldPath;
    watcher.close(); clearTimeout(deadline);
    if (pending) await pending;
    await new Promise(resolve => server.close(resolve));
  }
});

test('pinning or persistence failure never reports successful enable or changes scope silently', async t => {
  const h = setup(t);
  await invoke(h.controller, 'authorize', authorization(h.target));
  fakeEstimates(h);
  let receipt = (await invoke(h.controller, 'estimate', {})).body.estimateId;
  const originalSave = h.service.savePolicy;
  h.service.savePolicy = () => { throw Error('synthetic disk failure'); };
  await assert.rejects(() => invoke(h.controller, 'enable', { confirmed: true, estimateId: receipt }), /synthetic disk failure/);
  assert.equal(h.service.loadPolicy('project-test').status, 'disabled');
  h.service.savePolicy = originalSave;
  receipt = (await invoke(h.controller, 'estimate', {})).body.estimateId;
  await invoke(h.controller, 'enable', { confirmed: true, estimateId: receipt });
  h.service.authorizeProject = () => { throw Error('synthetic pin failure'); };
  await assert.rejects(() => invoke(h.controller, 'authorize', authorization(h.target)), /synthetic pin failure/);
  assert.equal(h.service.loadPolicy('project-test').status, 'disabled');
});

// Regression for moving enumeration off the server thread: an estimate must
// remain pending until the asynchronous service result arrives, and a local
// management action during that wait must invalidate it even if the serialized
// policy returns to the same value (disable while already disabled / re-pin).
// No wall-clock latency assertion: the scan is held by an explicit test barrier.
for (const phase of ['estimate', 'enable']) {
  for (const mutation of ['disable', 'authorize', 'settings']) {
    test(`pending ${phase} cannot survive concurrent ${mutation}`, async t => {
      const h = setup(t);
      await invoke(h.controller, 'authorize', authorization(h.target));
      fakeEstimates(h);
      const receipt = phase === 'enable'
        ? (await invoke(h.controller, 'estimate', {})).body.estimateId : null;
      let release;
      let markStarted;
      const started = new Promise(resolve => { markStarted = resolve; });
      const scan = new Promise(resolve => { release = resolve; });
      h.service.estimateDirectoryAsync = () => { markStarted(); return scan; };
      let settled = false;
      // Observe both outcomes immediately to avoid unhandled rejections while
      // the test drives a second request through the controller.
      const pending = invoke(h.controller, phase, phase === 'enable'
        ? { confirmed: true, estimateId: receipt } : {}).then(
        value => { settled = true; return { value }; },
        error => { settled = true; return { error }; },
      );
      try {
        await started;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(settled, false, 'request must await the actual enumeration result');
        const body = mutation === 'authorize' ? authorization(h.target)
          : mutation === 'settings' ? { stagingRetentionDays: 2 } : {};
        await invoke(h.controller, mutation, body);
        const afterMutation = h.service.loadPolicy('project-test');
        release({ ok: true, complete: true, totalBytes: 5, fileCount: 1, uncaptured: [] });
        const outcome = await pending;
        assert.equal(outcome.error?.statusCode, 409);
        assert.equal(outcome.error?.issues?.[0]?.code, 'badcase_capture_operation_stale');
        assert.deepEqual(h.service.loadPolicy('project-test'), afterMutation,
          'late completion must not overwrite the newer policy or enable capture');
        assert.equal(afterMutation.status, 'disabled');
        await rejects(() => invoke(h.controller, 'enable', {
          confirmed: true, estimateId: receipt || outcome.value?.body.estimateId,
        }), 'badcase_capture_estimate_required', 409);
        assert.equal(h.service.store.listCheckpoints('project-test').length, 0);
      } finally {
        release({ ok: false, reason: 'test_cleanup' });
        await pending;
      }
    });
  }
}

test('stale, expired, restarted and failed estimates cannot enable; reasons remain machine readable', async t => {
  const h = setup(t);
  await invoke(h.controller, 'authorize', authorization(h.target));
  fakeEstimates(h);
  const enable = id => invoke(h.controller, 'enable', { confirmed: true, estimateId: id });
  let receipt = (await invoke(h.controller, 'estimate', {})).body.estimateId;
  await invoke(h.controller, 'settings', { stagingRetentionDays: 2 });
  await rejects(() => enable(receipt), 'badcase_capture_estimate_required', 409);
  receipt = (await invoke(h.controller, 'estimate', {})).body.estimateId;
  h.advance();
  await rejects(() => enable(receipt), 'badcase_capture_estimate_required', 409);
  receipt = (await invoke(h.controller, 'estimate', {})).body.estimateId;
  await rejects(() => invoke(createBadcaseCaptureController(h.options), 'enable', { confirmed: true, estimateId: receipt }), 'badcase_capture_estimate_required', 409);
  h.service.estimateDirectoryAsync = () => ({ ok: false, reason: 'authorized_root_replaced' });
  await rejects(() => enable(receipt), 'authorized_root_replaced', 409);
  assert.equal(h.service.loadPolicy('project-test').status, 'disabled');
  const failed = await invoke(h.controller, 'estimate', {});
  assert.equal(failed.body.estimateId, null);
  assert.equal(failed.body.estimates[0].reason, 'authorized_root_replaced');
  h.service.estimateDirectoryAsync = () => ({ ok: true, complete: false, uncaptured: [{ reason: 'directory_unreadable' }] });
  assert.equal((await invoke(h.controller, 'estimate', {})).body.estimateId, null);
});
