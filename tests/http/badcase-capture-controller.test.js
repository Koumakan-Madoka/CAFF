const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
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
  h.service.estimateDirectory = (id, dir) => {
    calls.push({ id, dir });
    return { ok: true, complete: true, includesIgnored: true, totalBytes: 5, fileCount: 1, durationMs: 0, uncaptured: [] };
  };
  return calls;
}

test('default GET and guard failures never scan or authorize', async t => {
  const h = setup(t);
  let touches = 0;
  h.service.estimateDirectory = h.service.authorizeProject = () => { touches++; throw Error('unexpected target access'); };
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
  h.service.estimateDirectory = () => ({ ok: false, reason: 'authorized_root_replaced' });
  await rejects(() => enable(receipt), 'authorized_root_replaced', 409);
  assert.equal(h.service.loadPolicy('project-test').status, 'disabled');
  const failed = await invoke(h.controller, 'estimate', {});
  assert.equal(failed.body.estimateId, null);
  assert.equal(failed.body.estimates[0].reason, 'authorized_root_replaced');
  h.service.estimateDirectory = () => ({ ok: true, complete: false, uncaptured: [{ reason: 'directory_unreadable' }] });
  assert.equal((await invoke(h.controller, 'estimate', {})).body.estimateId, null);
});
