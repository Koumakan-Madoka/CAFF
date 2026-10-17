const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fixture = require('../helpers/badcase-initialization-fixture.cjs');
const { archiveRuntime } = require('../../scripts/badcase-capture/runtime-archive.cjs');
const { archiveHarness } = require('../../scripts/badcase-capture/harness-archive.cjs');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const { prepareModelEvaluation } = require('../../scripts/badcase-capture/model-evaluation.cjs');
const { recordBoundModelApproval, dispatchBoundModelEvaluation } = require('../../build/server/domain/runtime/badcase-capture/model-binding');
const { encodeToolChatCompletionsRequest } = require('../../build/server/domain/runtime/badcase-capture/chat-completions-protocol');
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const image = { imageId: 'sha256:' + '1'.repeat(64), repositoryDigest: 'node@sha256:' + '2'.repeat(64), architecture: 'amd64', nodeVersion: 'v24.21.0', pythonVersion: 'Python 3.11.2' };
function setup(t, prepare = prepareModelEvaluation, captured) {
  const h = captured || fixture(t), repo = path.resolve(__dirname, '../..');
  const sources = { runtimeArchive: archiveRuntime(repo, path.join(h.root, 'runtime')), harnessArchive: archiveHarness(repo, path.join(h.root, 'harness')) };
  const config = { settings: { provider: 'synthetic', model: 'fixture', contextWindowTokens: 1000, maxOutputTokens: 100, temperature: 0,
    inputMicroUsdPerMillionTokens: 1000000, outputMicroUsdPerMillionTokens: 1000000, maxRequestBytes: 4096, maxResponseBytes: 4096 },
    endpoint: { hostname: 'api.example.com', address: '93.184.216.34', path: '/v1/chat/completions', timeoutMs: 1000, maxRequestBytes: 4096, maxResponseBytes: 4096 }, maxRequests: 2,
    tools: [{ type: 'function', function: { name: 'read', description: 'synthetic', parameters: { type: 'object' } } }] };
  const roles = { baseline: 'base', candidate: 'candidate' }, rule = { expectedHash: hash('done\n'), badcaseHash: hash('draft\n') };
  const limits = { repetitions: 1, timeoutMs: 25000, perRunLimitMicroUsd: 2200, totalLimitMicroUsd: 4400 };
  const request = h.request || require('../../scripts/badcase-capture/sealed-workbench.cjs').selectSealedMaterials({
    captureRoot: h.root, selections: [h.selection], image, sources, roles, rule })[0].request;
  const prepared = prepare(request, image, sources, roles, rule, config, limits);
  const approval = { confirmed: true, planHash: prepared.plan.planHash, approvalId: 'test', expiresAt: Date.now() + 60000 };
  recordBoundModelApproval(h.root, prepared.plan.spec, config, approval);
  return { ...h, request, config, prepared, approval, sources, roles, rule, limits };
}
function network(t, onRequest = () => {}) {
  const original = https.request; t.after(() => { https.request = original; }); let count = 0;
  https.request = opts => {
    const req = new EventEmitter(), socket = new EventEmitter(), res = new PassThrough();
    Object.assign(socket, { encrypted: true, authorized: true, remoteAddress: opts.hostname });
    Object.assign(res, { headers: { 'content-type': 'application/json' }, statusCode: 200, complete: true });
    req.destroy = () => res.destroy();
    req.end = () => { count++; onRequest(); queueMicrotask(() => { req.emit('response', res); res.end(JSON.stringify({ id: 'reply', object: 'chat.completion', created: 1, model: 'fixture',
      choices: [{ index: 0, message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })); }); };
    queueMicrotask(() => { req.emit('socket', socket); socket.emit('secureConnect'); }); return req;
  }; return () => count;
}
async function execute(h, mutate = () => {}, before = () => {}, resultPatch = {}, viaRelay = false) {
  return dispatchBoundModelEvaluation(h.root, h.approval.approvalId, (run, send) => h.prepared.execute(h.root, run, send, async (i, files, options) => {
    before(files); assert.deepEqual(i, image); assert.equal(options.timeoutMs, 25000); assert.equal(typeof options.probe, 'function');
    assert.equal(files.some(f => f.bytes.includes(h.rule.expectedHash)), false);
    const profile = JSON.parse(files.find(f => f.path === 'model-profile.json').bytes);
    assert.equal(Object.hasOwn(profile, 'endpoint'), false); assert.equal(Object.hasOwn(profile, 'credential'), false);
    const body = encodeToolChatCompletionsRequest({ settings: h.config.settings, tools: h.config.tools }, [{ role: 'user', content: 'synthetic' }]);
    if (!viaRelay) await send(body);
    const manifest = manifestFor(files), q = JSON.parse(files.find(f => f.path === 'task.json').bytes);
    const receipt = { kind: 'model-sdk-task-v1', runId: run.runId, roleHash: run.roleHash, capsuleHash: q.capsuleHash,
      inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash, deliveryMode: q.deliveryMode, invocationHash: q.invocationHash, historyHash: q.historyHash,
      networkCalls: 0, modelCalls: 1, toolNames: [], artifactBase64: Buffer.from('done\n').toString('base64') };
    if (viaRelay) {
      // Exercise the actual runProbe -> relay -> checkedSend composition, using
      // a deterministic Docker protocol fixture (not a real SDK/container).
      let running = false, finish;
      const fake = require('../helpers/badcase-fake-docker.cjs')(i, { async change(args, result, state) {
        if (args[0] === 'start') {
          running = true;
          Object.assign(result, await new Promise(resolve => { finish = resolve; }));
        } else if (args[0] === 'inspect') {
          const info = state.info(); info.Config.Labels = { 'caff.badcase.pi-initialization': state.owner };
          info.State.Running = running; result.stdout = JSON.stringify([info]);
        } else if (args[0] === 'exec') {
          if (state.options?.input) {
            if (typeof viaRelay === 'object') viaRelay.delivered++;
            mutate(receipt); running = false;
            finish({ code: 0, stdout: JSON.stringify(receipt), stderr: '', ...resultPatch });
          } else result.stdout = JSON.stringify({ sequence: 1, body: body.toString('base64') });
        } else if (args[0] === 'kill') {
          running = false; finish({ code: 0, stdout: '', stderr: 'synthetic failure' });
        }
      } });
      return options.probe(i, files, { runDocker: fake.run });
    }
    mutate(receipt);
    return { containerId: 'a'.repeat(64), manifest, result: { code: 0, stdout: JSON.stringify(receipt), stderr: '', ...resultPatch } };
  }), () => ({ value: 'synthetic-inert', expiresAt: Date.now() + 5000 }));
}
test('retained model preparer binds approval and actual request costs, excludes endpoint/credential/rubric from stage', async t => {
  const h = setup(t), count = network(t); const report = await execute(h);
  assert.equal(report.ledger.state, 'complete'); assert.equal(count(), 2); assert.equal(report.ledger.knownCostMicroUsd, 60);
  assert.equal(report.ledger.summary.baseline.expectationMet, 1); assert.equal(report.ledger.summary.candidate.expectationMet, 1);
});
// Real management HTTP/collector/SQLite/sealing; both SDK/Docker and model
// transport remain synthetic. This proves composition, NOT actual replay.
test('HTTP-captured fresh/resume sealed inputs reach the model coordinator without changing archived mode or bytes', {
  skip: process.platform !== 'linux', timeout: 90000,
}, async t => {
  const capturedFixture = require('../../scripts/badcase-capture/captured-workbench-fixture.cjs');
  const { readBoundModelApproval } = require('../../build/server/domain/runtime/badcase-capture/model-binding');
  const { readModelEgress } = require('../../build/server/domain/runtime/badcase-capture/model-egress');
  const { selectSealedMaterials } = require('../../scripts/badcase-capture/sealed-workbench.cjs');
  const count = network(t);
  for (const mode of ['fresh', 'resume']) {
    const captured = await capturedFixture(t, mode);
    const caseFile = path.join(captured.root, 'projects/p1/cases', hash(captured.selection.messageId) + '.json');
    const savedCase = fs.readFileSync(caseFile);
    const h = setup(t, prepareModelEvaluation, captured), seen = [];
    assert.equal(h.prepared.review.deliveryMode, mode);
    assert.equal(h.prepared.review.invocationHash, h.r.promptBlobHash);
    const report = await execute(h, undefined, files => {
      const capsule = JSON.parse(files.find(f => f.path === 'capsule.json').bytes);
      assert.deepEqual(capsule.checkpoint, h.cp);
      const read = digest => Buffer.from(capsule.blobs.find(b => b.sha256 === digest).base64, 'base64');
      assert.equal(read(h.cp.files['source.txt'].hash).toString(), 'retained bytes');
      assert.equal(read(h.r.promptBlobHash).toString(), 'synthetic retained invocation');
      if (mode === 'resume') {
        assert.deepEqual(read(h.r.sessionBlobHash), h.store.readBlob('p1', h.r.sessionBlobHash));
        assert.doesNotMatch(read(h.r.sessionBlobHash).toString(), /POST-START/);
      } else assert.equal(h.r.sessionBlobHash, '');
      const task = JSON.parse(files.find(f => f.path === 'task.json').bytes);
      assert.equal(task.deliveryMode, mode);
      assert.equal(task.role, h.roles[seen.length === 0 ? 'baseline' : 'candidate']);
      seen.push({ capsuleHash: task.capsuleHash, invocationHash: task.invocationHash, historyHash: task.historyHash });
    }, {}, true);
    assert.equal(seen.length, 2); assert.deepEqual(seen[0], seen[1]);
    assert.equal(report.ledger.state, 'complete'); assert.equal(report.ledger.runs.length, 2);
    assert.equal(report.ledger.summary.baseline.expectationMet, 1); assert.equal(report.ledger.summary.candidate.expectationMet, 1);
    for (const run of report.ledger.runs) {
      const inner = readModelEgress(h.root, run.runId);
      assert.equal(inner.reason, 'completed'); assert.equal(inner.requests.length, 1);
    }
    assert.deepEqual(readBoundModelApproval(h.root, h.approval.approvalId).report, report);
    assert.deepEqual(fs.readFileSync(caseFile), savedCase);
    for (const key of ['runnable', 'reproduced', 'evaluable', 'strictEvalEligible', 'complete']) {
      assert.equal(JSON.parse(savedCase).record[key], false);
    }
    // Loss of a required original input must block selection, not silently
    // reconstruct it from the live target or downgrade resume to fresh.
    const blob = h.blobPath(mode === 'resume' ? h.r.sessionBlobHash : h.r.promptBlobHash), bytes = fs.readFileSync(blob);
    try {
      fs.unlinkSync(blob);
      assert.throws(() => selectSealedMaterials({ captureRoot: h.root, selections: [h.selection], image,
        sources: h.sources, roles: h.roles, rule: h.rule }), /^Error: sealed_material_invalid$/);
      assert.deepEqual(fs.readFileSync(caseFile), savedCase);
    } finally { fs.writeFileSync(blob, bytes); }
  }
  assert.equal(count(), 4); // Four synthetic exchanges, no supplier/SDK execution.
});
test('receipt/count/artifact mismatch never settles an invented score or cost', async t => {
  network(t);
  for (const patch of [{ modelCalls: 0 }, { networkCalls: 1 }, { artifactBase64: '???' }, { toolNames: ['unknown'] }, { roleHash: hash('other') }]) {
    const h = setup(t); const report = await execute(h, r => Object.assign(r, patch));
    assert.equal(report.dispatchState, 'unresolved'); assert.equal(report.ledger.runs[0].score, null); assert.equal(report.ledger.runs[0].costMicroUsd, null);
  }
});
test('task stderr is never scoring authority, even with a valid receipt and zero exit', async t => {
  const count = network(t);
  for (const stderr of ['model_sdk_task_failed:request_limit\n', 'model_sdk_task_failed:dispose\n', 'model_sdk_task_failed\n', 'model_sdk_task_failed:unknown\n']) {
    const h = setup(t), report = await execute(h, undefined, undefined, { stderr });
    assert.equal(report.dispatchState, 'unresolved'); assert.equal(report.ledger.runs.length, 1);
    assert.equal(report.ledger.runs[0].score, null); assert.equal(report.ledger.runs[0].costMicroUsd, null);
  }
  assert.equal(count(), 4); // Baselines only; no candidate or automatic retry.
});
test('corrupt sealed input blocks container creation and model requests', async t => {
  const h = setup(t), count = network(t); fs.writeFileSync(h.blobPath(h.r.promptBlobHash), 'tampered');
  const report = await execute(h, undefined, () => assert.fail('must not launch'));
  assert.equal(report.dispatchState, 'unresolved'); assert.equal(count(), 0);
});
test('legacy text-only profile and out-of-supervisor time limits fail before any model execution', t => {
  const h = setup(t), { tools, ...textOnly } = h.config;
  assert.throws(() => prepareModelEvaluation(h.request, image, h.sources, h.roles, h.rule, textOnly, h.limits));
  assert.throws(() => prepareModelEvaluation(h.request, image, h.sources, h.roles, h.rule, h.config, { ...h.limits, timeoutMs: 25001 }));
});
// Copies contain executable sources only; never copy credentials, user inputs or
// node_modules. Tampering is confined to each test's temporary host-code tree.
function copyHost(t, change = () => {}) {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'caff-host-code-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['scripts/badcase-capture', 'build/server']) fs.cpSync(path.resolve(__dirname, '../..', name), path.join(root, name), { recursive: true });
  change(root);
  return { root, prepare: require(path.join(root, 'scripts/badcase-capture/model-evaluation.cjs')).prepareModelEvaluation };
}
const compiledHostFiles = ['chat-completions-protocol', 'https-exchange', 'model-binding', 'model-egress', 'evaluation-plan', 'secrets']
  .map(name => 'build/server/domain/runtime/badcase-capture/' + name + '.js');
test('compiled host dependencies and transitive helpers change harness/plan identity and invalidate old approval', async t => {
  const count = network(t);
  for (const name of [...compiledHostFiles, 'scripts/badcase-capture/pi-probe-guards.cjs', 'build/server/domain/models/model-provider-config.js']) {
    const h = setup(t), changed = copyHost(t, root => fs.appendFileSync(path.join(root, name), '\n// synthetic code revision\n'));
    const p = changed.prepare(h.request, image, h.sources, h.roles, h.rule, h.config, h.limits);
    assert.notEqual(p.plan.spec.harnessHash, h.prepared.plan.spec.harnessHash, name);
    assert.notEqual(p.plan.planHash, h.prepared.plan.planHash, name);
    assert.equal(p.plan.spec.inputHash, h.prepared.plan.spec.inputHash);
    let launches = 0;
    const report = await execute({ ...h, prepared: p }, undefined, () => { launches++; });
    assert.equal(launches, 0); assert.equal(report.dispatchState, 'unresolved');
  }
  assert.equal(count(), 0);
});
test('loaded preparer refuses on-disk code drift before a new plan is created', t => {
  const host = copyHost(t);
  fs.appendFileSync(path.join(host.root, compiledHostFiles[0]), '\n// synthetic drift before prepare\n');
  assert.throws(() => setup(t, host.prepare), /^Error: model_host_code_invalid$/);
});
test('changed or missing host code after planning blocks launch and model requests', async t => {
  const count = network(t);
  for (const name of [...compiledHostFiles, 'scripts/badcase-capture/pi-probe-guards.cjs']) {
    const host = copyHost(t), h = setup(t, host.prepare);
    fs.appendFileSync(path.join(host.root, name), '\n// synthetic late revision\n');
    let launches = 0;
    const report = await execute(h, undefined, () => { launches++; });
    assert.equal(launches, 0, name); assert.equal(report.dispatchState, 'unresolved'); assert.equal(report.ledger.runs[0].score, null);
  }
  const host = copyHost(t), h = setup(t, host.prepare);
  fs.unlinkSync(path.join(host.root, compiledHostFiles[0]));
  let launches = 0;
  const report = await execute(h, undefined, () => { launches++; });
  assert.equal(launches, 0); assert.equal(report.dispatchState, 'unresolved'); assert.equal(count(), 0);
});
test('host code is reverified at each model send and before accepting a receipt', async t => {
  const count = network(t);
  for (const phase of ['send', 'receipt']) {
    const host = copyHost(t), h = setup(t, host.prepare);
    const tamper = () => fs.appendFileSync(path.join(host.root, compiledHostFiles[0]), '\n// synthetic mid-run revision\n');
    const report = await execute(h, phase === 'receipt' ? tamper : undefined, phase === 'send' ? tamper : undefined, {}, true);
    assert.equal(report.dispatchState, 'unresolved'); assert.equal(report.ledger.runs.length, 1);
    assert.equal(report.ledger.runs[0].score, null); assert.equal(report.ledger.runs[0].costMicroUsd, null);
  }
  assert.equal(count(), 1); // Only the receipt case sends; neither starts a candidate.
});
test('in-flight host drift stops relay delivery even after the request has settled', async t => {
  const host = copyHost(t), h = setup(t, host.prepare), relay = { delivered: 0 };
  const count = network(t, () => fs.appendFileSync(path.join(host.root, compiledHostFiles[0]), '\n// synthetic in-flight drift\n'));
  const report = await execute(h, undefined, undefined, {}, relay);
  assert.equal(count(), 1); assert.equal(relay.delivered, 0);
  assert.equal(report.dispatchState, 'unresolved'); assert.equal(report.ledger.runs.length, 1);
  assert.equal(report.ledger.runs[0].score, null); assert.equal(report.ledger.runs[0].costMicroUsd, null);
});
test('new task harness refuses host execution before SDK import', () => {
  const r = require('node:child_process').spawnSync(process.execPath, ['scripts/badcase-capture/model-task-container.cjs'], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr, 'model_sdk_task_failed:bootstrap\n');
});
test('task failure reports only its fixed active phase, without touching the thrown exception', async () => {
  const diagnostic = require('../helpers/badcase-task-diagnostics.cjs');
  for (const phase of ['bootstrap', 'materials', 'input', 'runtime', 'session', 'prompt', 'final', 'artifact', 'receipt', 'dispose']) {
    const r = await diagnostic(phase);
    assert.equal(r.exitCode, 1, phase); assert.equal(r.stderr, 'model_sdk_task_failed:' + phase + '\n', phase);
    if (phase !== 'dispose') assert.equal(r.stdout, '', phase);
    if (['prompt', 'final', 'artifact', 'receipt', 'dispose'].includes(phase)) assert.equal(r.disposed, 1, phase);
  }
});
test('actual request-limit attempt is latched even if SDK swallows its exception; no extra exchange succeeds', async () => {
  const diagnostic = require('../helpers/badcase-task-diagnostics.cjs');
  for (const fault of ['request_limit', 'request_limit_swallowed']) {
    const r = await diagnostic(fault);
    assert.equal(r.exitCode, 1); assert.equal(r.stderr, 'model_sdk_task_failed:request_limit\n');
    assert.equal(r.received, 3); assert.equal(r.stdout, ''); assert.equal(r.disposed, 1);
  }
  for (const fault of [undefined, 'at_limit']) {
    const success = await diagnostic(fault);
    assert.equal(success.exitCode, undefined); assert.equal(success.stderr, ''); assert.equal(success.received, fault ? 2 : 1); assert.equal(success.disposed, 1);
    assert.equal(JSON.parse(success.stdout).kind, 'model-sdk-task-v1');
  }
  const atLimit = await diagnostic('at_limit_artifact');
  assert.equal(atLimit.exitCode, 1); assert.equal(atLimit.stderr, 'model_sdk_task_failed:artifact\n'); assert.equal(atLimit.received, 2);
});
