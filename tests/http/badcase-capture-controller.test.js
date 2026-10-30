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

test('compact configure authorizes directory and instance sessions, checks estimate, then enables; disable does not read source', async t => {
  const h = setup(t), sessions = path.join(h.root, 'sessions');
  fs.mkdirSync(path.join(h.target, '.git'));
  h.service.authorizeProject = () => h.service.loadPolicy('project-test');
  const scans = fakeEstimates(h);
  const controller = createBadcaseCaptureController({ ...h.options, sessionInputDir: sessions });
  const enabled = await invoke(controller, 'configure', { confirmed: true, targetDir: h.target, enabled: true });
  assert.equal(enabled.body.policy.status, 'enabled');
  assert.deepEqual(enabled.body.policy.authorizedDirs, [h.target]);
  assert.deepEqual(enabled.body.policy.authorizedInputDirs, [sessions]);
  assert.equal(enabled.body.policy.callbackInputAuthorized, true);
  assert.equal(enabled.body.policy.excludedPatterns.includes('.git'), false);
  assert.deepEqual(enabled.body.policy.windowsExternalGit, []);
  assert.equal(scans.length, 1);
  const disabled = await invoke(controller, 'configure', { confirmed: true, enabled: false });
  assert.equal(disabled.body.policy.status, 'disabled'); assert.equal(scans.length, 1);
});
test('compact configure rejects unconfirmed/external Git and failed estimates leave capture off', async t => {
  const h = setup(t), controller = createBadcaseCaptureController({ ...h.options, sessionInputDir: path.join(h.root, 'sessions') });
  const body = { confirmed: true, enabled: true, targetDir: h.target };
  await rejects(() => invoke(controller, 'configure', { ...body, confirmed: false }), 'badcase_capture_confirmation_required');
  fs.writeFileSync(path.join(h.target, '.git'), 'gitdir: elsewhere');
  await rejects(() => invoke(controller, 'configure', body), 'badcase_capture_layout_unsupported');
  fs.unlinkSync(path.join(h.target, '.git')); fs.mkdirSync(path.join(h.target, '.git'));
  h.service.authorizeProject = () => h.service.loadPolicy('project-test');
  h.service.estimateDirectoryAsync = () => ({ ok: false, reason: 'git_metadata_unsupported' });
  await rejects(() => invoke(controller, 'configure', body), 'git_metadata_unsupported', 409);
  assert.equal(h.service.loadPolicy('project-test').status, 'disabled');
});

test('external selection is authorization-only closed schema, rejects invalid roots before saving or pinning', async t => {
  const h = setup(t); let pins = 0; h.service.authorizeProject = () => { pins++; };
  const before = h.service.loadPolicy('project-test');
  for (const selection of [null, {}, [{ worktree: h.target }], Array(33).fill({})]) {
    await rejects(() => invoke(h.controller, 'authorize', { ...authorization(h.target), windowsExternalGit: selection }), 'capture_external_git_selection_invalid');
    assert.deepEqual(h.service.loadPolicy('project-test'), before); assert.equal(pins, 0);
  }
  await rejects(() => invoke(h.controller, 'settings', { windowsExternalGit: [] }), 'badcase_capture_unknown_field');
});

test('Windows HTTP explicit per-worktree selection persists across restart but does not enable or issue receipt', { skip: process.platform !== 'win32' }, async t => {
  const h = setup(t), meta = path.join(h.root, 'meta'), common = path.join(h.root, 'common'); fs.mkdirSync(meta); fs.mkdirSync(common);
  const windowsExternalGit = [{ worktree: h.target, metadataRoot: meta, commonRoot: common }];
  const body = { ...authorization(h.target), authorizedInputDirs: [meta, common], windowsExternalGit };
  for (const authorizedInputDirs of [[], [common]]) {
    await rejects(() => invoke(h.controller, 'authorize', { ...body, authorizedInputDirs }), 'capture_external_git_selection_invalid');
  }
  const response = await invoke(h.controller, 'authorize', body); assert.equal(response.body.policy.status, 'disabled');
  assert.deepEqual(response.body.policy.windowsExternalGit, windowsExternalGit);
  assert.equal(Object.keys(response.body.policy.authorizedInputPins).length, 2);
  const restarted = createBadcaseCaptureService({ captureRoot: h.captureRoot }); assert.deepEqual(restarted.loadPolicy('project-test'), response.body.policy);
  const estimated = await invoke(h.controller, 'estimate', {}); assert.equal(estimated.body.captureAvailable, false); assert.equal(estimated.body.estimateId, null);
  await rejects(() => invoke(h.controller, 'enable', { confirmed: true, estimateId: 'forged' }), 'badcase_capture_estimate_required', 409);
  const reset = await invoke(h.controller, 'authorize', authorization(h.target)); assert.deepEqual(reset.body.policy.windowsExternalGit, []);
  assert.equal(reset.body.policy.status, 'disabled');
});

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

test('only structured writer contention is mapped; message lookalikes and other errors propagate', async t => {
  const h = setup(t);
  for (const error of [Error('capture_writer_busy'), Object.assign(Error('capture_writer_busy'), { code: 'EIO' }),
    Object.assign(Error('disk failed'), { code: 'EIO' })]) {
    h.service.savePolicy = () => { throw error; };
    await assert.rejects(() => invoke(h.controller, 'disable', {}), caught => caught === error);
  }
  h.service.savePolicy = () => { throw Object.assign(Error('private diagnostic must not escape'), { code: 'capture_writer_busy' }); };
  await assert.rejects(() => invoke(h.controller, 'disable', {}), error => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.message, 'Badcase capture request was rejected');
    assert.deepEqual(error.issues, [{ code: 'capture_writer_busy', path: 'body' }]);
    assert.doesNotMatch(JSON.stringify(error), /private diagnostic/);
    return true;
  });
});

test('Git dependency suggestions are local-admin, explicitly confirmed, generation-bound and never mutate policy', async t => {
  const h = setup(t); let calls = 0, finish;
  h.service.discoverGitDependenciesAsync = async (id, dir) => {
    calls++; assert.equal(id, 'project-test'); assert.equal(dir, h.target);
    return { ok: true, ready: false, targetDir: dir, next: { kind: 'metadata', path: 'C:/candidate' }, selection: null };
  };
  const body = { confirmed: true, targetDir: h.target };
  await rejects(() => invoke(h.controller, 'discover-git', body, { headers: { 'x-caff-csrf-token': '' } }), 'badcase_capture_csrf_invalid', 403);
  await rejects(() => invoke(h.controller, 'discover-git', { targetDir: h.target }), 'badcase_capture_confirmation_required');
  await rejects(() => invoke(h.controller, 'discover-git', { ...body, authorized: true }), 'badcase_capture_unknown_field');
  assert.equal(calls, 0);
  const before = h.service.loadPolicy('project-test');
  const result = await invoke(h.controller, 'discover-git', body);
  assert.equal(result.body.next.path, 'C:/candidate'); assert.equal(calls, 1);
  assert.deepEqual(h.service.loadPolicy('project-test'), before);
  h.service.discoverGitDependenciesAsync = () => new Promise(resolve => { finish = resolve; });
  const pending = invoke(h.controller, 'discover-git', body);
  await new Promise(resolve => setImmediate(resolve));
  await invoke(h.controller, 'disable', {});
  finish({ ok: true, ready: true, targetDir: h.target, next: null, selection: null });
  await rejects(() => pending, 'badcase_capture_operation_stale', 409);
});

test('latest capture metrics persist, stay within currently authorized roots and expose unknown legacy counters without reading blobs', async t => {
  const h = setup(t);
  h.service.savePolicy('project-test', { authorizedDirs: [h.target], authorizedInputDirs: [] });
  const cp = { checkpointId: 'metrics-cp', projectId: 'project-test', targetDir: h.target, createdAt: '2026-10-20T00:00:00.000Z',
    integrity: { platform: 'win32' }, stats: { totalNewBytes: 50, newBlobBytes: 30, newManifestBytes: 20, durationMs: 12.5,
      sessionBytes: 10, blobBytesByKind: { files: 10, session: 10, replay: 5, shared: 5 } }, files: { private: 'MUST_NOT_BE_EXPOSED' } };
  h.service.store.saveCheckpoint('project-test', cp); h.service.store.saveLatestCheckpointId('project-test', h.target, cp.checkpointId);
  const other = { ...cp, checkpointId: 'other', targetDir: path.join(h.root, 'not-authorized'), createdAt: '2026-10-21T00:00:00.000Z' };
  h.service.store.saveCheckpoint('project-test', other); h.service.store.saveLatestCheckpointId('project-test', other.targetDir, other.checkpointId);
  const result = (await invoke(h.controller)).body;
  assert.equal(result.lastCapture.checkpointId, cp.checkpointId); assert.equal(result.lastCapture.totalNewBytes, 50);
  assert.equal(result.lastCapture.preparationDurationMs, 12.5); assert.equal(result.lastCapture.sessionBytes, 10);
  assert.deepEqual(result.lastCapture.blobBytesByKind, cp.stats.blobBytesByKind); assert.equal(result.lastCaptureError, null);
  assert.doesNotMatch(JSON.stringify(result), /MUST_NOT_BE_EXPOSED/);
  const restarted = createBadcaseCaptureService({ captureRoot: h.captureRoot });
  restarted.store.readBlob = () => { assert.fail('metrics must use stored counters, never read file/session contents'); };
  assert.deepEqual(restarted.latestCaptureMetrics('project-test'), result.lastCapture);
  delete cp.stats.blobBytesByKind; delete cp.stats.sessionBytes;
  h.service.store.saveCheckpoint('project-test', cp);
  const legacy = (await invoke(h.controller)).body.lastCapture;
  assert.equal(legacy.totalNewBytes, 50); assert.equal(legacy.blobBytesByKind, null); assert.equal(legacy.sessionBytes, null);
});

test('capture metric read failure remains unknown without leaking errors or hiding a successful settings save', async t => {
  const h = setup(t); h.service.latestCaptureMetrics = () => { throw Error('PRIVATE_METRICS_PATH'); };
  const result = await invoke(h.controller, 'settings', { stagingRetentionDays: 2 });
  assert.equal(result.status, 200); assert.equal(result.body.policy.stagingRetentionDays, 2);
  assert.equal(result.body.lastCapture, null); assert.equal(result.body.lastCaptureError, 'capture_metrics_unavailable');
  assert.equal(result.body.usage.totalBytes, 0); assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_METRICS_PATH/);
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

test('server default capture service receives trusted private roots; Windows native preview retains them after caller mutation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-capture-server-scope-'));
  let app;
  t.after(async () => {
    if (app) await new Promise(resolve => app.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const target = path.join(root, 'worktree'), hidden = path.join(target, 'operator-private');
  fs.mkdirSync(hidden, { recursive: true }); fs.writeFileSync(path.join(hidden, 'data'), 'PRIVATE_SENTINEL');
  fs.writeFileSync(path.join(target, 'hello.txt'), 'hello');
  const agentDir = path.join(root, 'agent'), captureRoot = path.join(root, 'capture');
  const privateDirs = [hidden];
  let service, received;
  const filename = require.resolve('../../build/server/app/create-server');
  const local = require('node:module').createRequire(filename), api = {};
  require('node:vm').runInNewContext(fs.readFileSync(filename, 'utf8'), {
    exports: api, process, Buffer, console, setInterval, clearInterval, setTimeout, clearTimeout,
    require: id => id === '../domain/runtime/badcase-capture' ? {
      createBadcaseCaptureService(options) {
        received = options;
        // Test storage isolation only; keep the app's default composition and
        // real service/native reader. No replacement collector or fake result.
        service = createBadcaseCaptureService({ ...options, captureRoot }); return service;
      },
    } : local(id),
  }, { filename });
  const { isolateExternalIntegrations } = require('../helpers/external-integrations');
  const { withClearedRecoveryRuntimeEnvironment } = require('../helpers/recovery-runtime-env');
  isolateExternalIntegrations();
  app = withClearedRecoveryRuntimeEnvironment(() => api.createServerApp({ host: '127.0.0.1', port: 0,
    agentDir, sqlitePath: path.join(agentDir, 'chat.sqlite'), uploadsDir: path.join(root, 'uploads'), projectDir: target,
    badcaseCapturePrivateDirs: privateDirs }));
  assert.deepEqual(received.privateDirs, privateDirs, 'default app must not discard operator-owned private roots');
  assert.equal(received.agentDir, agentDir); assert.equal(received.chatStore, app.store);
  privateDirs.length = 0;
  const policy = service.savePolicy('scope', { authorizedDirs: [target], authorizedInputDirs: [] });
  assert.equal(policy.status, 'disabled'); assert.equal(service.computeUsage('scope').totalBytes, 0);
  if (process.platform === 'win32') {
    service.authorizeProject('scope');
    for (const result of [service.estimateDirectory('scope', target), await service.estimateDirectoryAsync('scope', target)]) {
      assert.equal(result.ok, true, result.reason); assert.equal(result.totalBytes, 5); assert.equal(result.fileCount, 1);
      assert.equal(result.captureAvailable, false); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL|operator-private/);
    }
    assert.equal(service.store.listCheckpoints('scope').length, 0);
  }
});

test('supported Windows native HTTP estimate and separate enable reach the real collector; environment drift cannot enable or publish', { skip: process.platform !== 'win32' }, async t => {
  require('../helpers/windows-capture-environment').isolateWindowsCaptureEnvironment(t);
  const h = setup(t), { execFileSync } = require('node:child_process');
  const git = (...args) => execFileSync('git', ['-C', h.target, ...args], { env: process.env, windowsHide: true });
  git('init', '-q'); git('config', 'core.ignorecase', 'true'); git('add', 'hello.txt');
  fs.writeFileSync(path.join(h.target, 'hello.txt'), 'dirty'); fs.writeFileSync(path.join(h.target, '.gitignore'), '*.log\n');
  fs.writeFileSync(path.join(h.target, 'untracked'), 'new'); fs.writeFileSync(path.join(h.target, 'included.log'), 'include');
  fs.writeFileSync(path.join(h.target, 'ignored.log'), 'IGNORE_NOT_AUTHORIZED'); fs.writeFileSync(path.join(h.target, '.env'), 'SECRET_NOT_AUTHORIZED');
  const helper = require('../../build/server/domain/runtime/badcase-capture/windows-helper'), original = helper.invokeWindowsGitHelper;
  const ops = []; helper.invokeWindowsGitHelper = (...args) => { ops.push(args[2].op); return original(...args); };
  t.after(() => { helper.invokeWindowsGitHelper = original; });
  let controller;
  const server = http.createServer(async (req, res) => {
    try { await controller({ req, res, pathname: req.url }); }
    catch (error) { res.writeHead(error.statusCode || 500); res.end(JSON.stringify({ issues: error.issues || [] })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  controller = createBadcaseCaptureController({ ...h.options, port });
  const post = (action, body) => fetch(`${base}/api/projects/project-test/badcase-capture/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-caff-csrf-token': 'test-csrf' }, body: JSON.stringify(body),
  });
  assert.equal((await post('authorize', { ...authorization(h.target), excludedPatterns: ['node_modules'], includedIgnoredPatterns: ['included.log'] })).status, 200);
  const first = await (await post('estimate', {})).json();
  assert.equal(first.captureAvailable, true); assert.equal(first.complete, true); assert.ok(first.estimateId);
  assert.equal(first.totalBytes, 21); assert.equal(first.estimates[0].fileCount, 4);
  assert.equal(first.estimates[0].exclusionPolicy, 'windows-git-classified-v1');
  assert.equal(h.service.loadPolicy('project-test').status, 'disabled');
  process.env.GIT_INDEX_FILE = path.join(h.root, 'another-index');
  assert.equal((await post('enable', { confirmed: true, estimateId: first.estimateId })).status, 409);
  assert.equal(h.service.loadPolicy('project-test').status, 'disabled'); delete process.env.GIT_INDEX_FILE;
  const second = await (await post('estimate', {})).json(); assert.ok(second.estimateId); assert.notEqual(second.estimateId, first.estimateId);
  assert.equal((await post('enable', { confirmed: true, estimateId: second.estimateId })).status, 200);
  assert.equal(h.service.loadPolicy('project-test').status, 'enabled');
  assert.equal(h.service.store.listCheckpoints('project-test').length, 0); assert.equal(h.service.computeUsage('project-test').totalBytes, 0);
  assert.ok(ops.length > 0); assert.ok(ops.every(op => op === 'gitMetadata'), 'authorize/estimate/enable must not read ordinary contents');
  const input = { projectId: 'project-test', conversationId: 'fixture-c', turnId: 'fixture-t', agentId: 'fixture-a', targetDir: h.target,
    deliveryMode: 'fresh', prompt: 'question', runConfig: { provider: 'test', model: 'test', skillIds: [], conversationSkillIds: [] },
    harness: { configSnapshot: { toolBridgeEnabled: true, deliveryMode: 'fresh', piVersion: '0.85.1' }, skillSnapshots: [] } };
  const captured = await h.service.captureTurnCheckpoint(input); assert.equal(captured.captured, true, captured.reason);
  assert.ok(ops.includes('selectedSnapshot')); assert.equal(captured.checkpoint.files['ignored.log'], undefined);
  assert.equal(captured.checkpoint.files['.env'], undefined); assert.equal(captured.checkpoint.files['.git'], undefined);
  assert.equal(captured.checkpoint.replayInput.complete, false); assert.equal(captured.checkpoint.strictEvalEligible, false);
  process.env.GIT_DIR = path.join(h.root, 'another-root');
  const drifted = await h.service.captureTurnCheckpoint({ ...input, turnId: 'fixture-drift' });
  assert.equal(drifted.captured, false); assert.equal(drifted.reason, 'windows_git_environment_unsupported');
  assert.equal(h.service.store.listCheckpoints('project-test').length, 1); delete process.env.GIT_DIR;
  assert.equal((await post('disable', {})).status, 200); assert.equal(h.service.loadPolicy('project-test').status, 'disabled');
});

test('Windows real HTTP native capacity preview protects configured private roots and never issues an enable receipt', { skip: process.platform !== 'win32' }, async t => {
  const h = setup(t);
  const hidden = path.join(h.target, 'custom-private'); fs.mkdirSync(hidden);
  fs.writeFileSync(path.join(hidden, 'data'), 'PRIVATE_SENTINEL');
  const alias = path.join(h.root, 'private-alias'); fs.symlinkSync(hidden, alias, 'junction');
  t.after(() => { if (fs.existsSync(alias)) fs.rmdirSync(alias); });
  const privateDirs = [alias];
  t.diagnostic('self-created NTFS fixture; private scope is constructor-owned');
  h.service = createBadcaseCaptureService({ captureRoot: h.captureRoot, privateDirs });
  h.options.service = h.service;
  privateDirs.length = 0; // caller cannot shrink the constructor's trusted scope
  let controller;
  const server = http.createServer(async (req, res) => {
    try { await controller({ req, res, pathname: req.url }); }
    catch (error) { res.writeHead(error.statusCode || 500); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  controller = createBadcaseCaptureController({ ...h.options, port });
  const base = `http://127.0.0.1:${port}`;
  const post = (action, body) => fetch(`${base}/api/projects/project-test/badcase-capture/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-caff-csrf-token': 'test-csrf' }, body: JSON.stringify(body),
  });
  assert.equal((await post('authorize', authorization(h.target))).status, 200);
  const response = await post('estimate', {});
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.complete, true); assert.equal(result.totalBytes, 5);
  assert.equal(result.estimates[0].fileCount, 1);
  assert.equal(result.estimates[0].exclusionPolicy, 'windows-metadata-v1');
  assert.equal(result.captureAvailable, false); assert.equal(result.estimateId, null);
  assert.equal((await post('enable', { confirmed: true, estimateId: 'forged' })).status, 409);
  assert.equal(createBadcaseCaptureService({ captureRoot: h.captureRoot }).loadPolicy('project-test').status, 'disabled');
  assert.equal(h.service.store.listCheckpoints('project-test').length, 0);
  assert.equal(h.service.computeUsage('project-test').bytesByKind.blobs, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL|private-alias|custom-private/);
  const blockedService = createBadcaseCaptureService({ captureRoot: h.captureRoot, privateDirs: [h.root] });
  controller = createBadcaseCaptureController({ ...h.options, service: blockedService, port });
  const blocked = await (await post('estimate', {})).json();
  assert.equal(blocked.complete, false); assert.equal(blocked.estimateId, null);
  assert.equal(blocked.estimates[0].reason, 'estimate_scope_rejected');
  assert.equal(blockedService.loadPolicy('project-test').status, 'disabled');
});

test('Windows native authorization failures return sanitized errors and stay disabled', { skip: process.platform !== 'win32' }, async t => {
  const h = setup(t);
  const alias = path.join(h.root, 'alias');
  fs.symlinkSync(h.target, alias, 'junction');
  await rejects(() => invoke(h.controller, 'authorize', authorization(alias)), 'windows_authorization_root_rejected', 409);
  assert.equal(h.service.loadPolicy('project-test').status, 'disabled');
  assert.deepEqual(h.service.loadPolicy('project-test').authorizedDirPins, {});
  const auth = require('../../build/server/domain/runtime/badcase-capture/windows-authorization');
  const prepare = auth.prepareWindowsAuthorization;
  auth.prepareWindowsAuthorization = () => ({ ok: false, reason: 'windows_authorization_unavailable' });
  try {
    await rejects(() => invoke(h.controller, 'authorize', authorization(h.target)), 'windows_authorization_unavailable', 409);
    const persisted = createBadcaseCaptureService({ captureRoot: h.captureRoot }).loadPolicy('project-test');
    assert.equal(persisted.status, 'disabled');
    assert.deepEqual(persisted.authorizedDirPins, {});
  } finally { auth.prepareWindowsAuthorization = prepare; }
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
  assert.equal((await restarted.captureTurnCheckpoint({ projectId: 'project-test', targetDir: h.target, deliveryMode: 'fresh' })).reason, 'policy_not_enabled');
  await rejects(() => invoke(h.controller, 'enable', { confirmed: true, estimateId: estimate.body.estimateId }), 'badcase_capture_estimate_required', 409);
});

test('enable rechecks collector availability even if an older estimate issued a receipt', async t => {
  const h = setup(t);
  await invoke(h.controller, 'authorize', authorization(h.target));
  fakeEstimates(h);
  const result = (await invoke(h.controller, 'estimate', {})).body;
  assert.ok(result.estimateId);
  h.service.estimateDirectoryAsync = () => ({ ok: true, complete: true, captureAvailable: false,
    fileCount: 1, totalBytes: 5, reason: '' });
  await rejects(() => invoke(h.controller, 'enable', { confirmed: true, estimateId: result.estimateId }), 'badcase_capture_collector_unavailable', 409);
  assert.equal(h.service.loadPolicy('project-test').status, 'disabled');
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
  } else if (process.platform === 'win32') {
    assert.equal(result.complete, true);
    assert.equal(result.totalBytes, 5);
    assert.equal(result.captureAvailable, false);
    assert.equal(result.estimateId, null);
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

test('public callback source consent is authorization-only, explicit boolean, persistent, default-off and always disables first', async t => {
  const h = setup(t); h.service.authorizeProject = () => h.service.loadPolicy('project-test');
  assert.equal((await invoke(h.controller)).body.policy.callbackInputAuthorized, false);
  await invoke(h.controller, 'authorize', authorization(h.target));
  assert.equal(h.service.loadPolicy('project-test').callbackInputAuthorized, false, 'omitted field cannot grant new consent');
  for (const value of [null, 'true', 1, {}, []]) {
    await rejects(() => invoke(h.controller, 'authorize', { ...authorization(h.target), callbackInputAuthorized: value }), 'badcase_capture_invalid_context_consent');
    assert.equal(h.service.loadPolicy('project-test').callbackInputAuthorized, false);
  }
  await rejects(() => invoke(h.controller, 'settings', { callbackInputAuthorized: true }), 'badcase_capture_unknown_field');
  const result = await invoke(h.controller, 'authorize', { ...authorization(h.target), callbackInputAuthorized: true });
  assert.equal(result.body.policy.callbackInputAuthorized, true); assert.equal(result.body.policy.status, 'disabled');
  assert.equal(createBadcaseCaptureService({ captureRoot: h.captureRoot }).loadPolicy('project-test').callbackInputAuthorized, true);
  await invoke(h.controller, 'settings', { stagingRetentionDays: 8 }); assert.equal(h.service.loadPolicy('project-test').callbackInputAuthorized, true);
  await invoke(h.controller, 'authorize', authorization(h.target));
  assert.equal(h.service.loadPolicy('project-test').callbackInputAuthorized, true, 'omitted field neither grants nor revokes existing independent consent');
  await invoke(h.controller, 'authorize', { ...authorization(h.target), callbackInputAuthorized: false });
  assert.equal(h.service.loadPolicy('project-test').callbackInputAuthorized, false, 'explicit false revokes consent');
  h.service.authorizeProject = () => { throw Error('fixture pin failure'); };
  await assert.rejects(() => invoke(h.controller, 'authorize', { ...authorization(h.target), callbackInputAuthorized: true }), /fixture pin failure/);
  assert.equal(h.service.loadPolicy('project-test').status, 'disabled');
  assert.equal(h.service.store.listCheckpoints('project-test').length, 0);
});
