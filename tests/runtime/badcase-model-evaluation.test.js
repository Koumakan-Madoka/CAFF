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
function setup(t) {
  const h = fixture(t), repo = path.resolve(__dirname, '../..');
  const sources = { runtimeArchive: archiveRuntime(repo, path.join(h.root, 'runtime')), harnessArchive: archiveHarness(repo, path.join(h.root, 'harness')) };
  const config = { settings: { provider: 'synthetic', model: 'fixture', contextWindowTokens: 1000, maxOutputTokens: 100, temperature: 0,
    inputMicroUsdPerMillionTokens: 1000000, outputMicroUsdPerMillionTokens: 1000000, maxRequestBytes: 4096, maxResponseBytes: 4096 },
    endpoint: { hostname: 'api.example.com', address: '93.184.216.34', path: '/v1/chat/completions', timeoutMs: 1000, maxRequestBytes: 4096, maxResponseBytes: 4096 }, maxRequests: 2,
    tools: [{ type: 'function', function: { name: 'read', description: 'synthetic', parameters: { type: 'object' } } }] };
  const roles = { baseline: 'base', candidate: 'candidate' }, rule = { expectedHash: hash('done\n'), badcaseHash: hash('draft\n') };
  const limits = { repetitions: 1, timeoutMs: 25000, perRunLimitMicroUsd: 2200, totalLimitMicroUsd: 4400 };
  const prepared = prepareModelEvaluation(h.request, image, sources, roles, rule, config, limits);
  const approval = { confirmed: true, planHash: prepared.plan.planHash, approvalId: 'test', expiresAt: Date.now() + 60000 };
  recordBoundModelApproval(h.root, prepared.plan.spec, config, approval);
  return { ...h, config, prepared, approval, sources, roles, rule, limits };
}
function network(t) {
  const original = https.request; t.after(() => { https.request = original; }); let count = 0;
  https.request = opts => {
    const req = new EventEmitter(), socket = new EventEmitter(), res = new PassThrough();
    Object.assign(socket, { encrypted: true, authorized: true, remoteAddress: opts.hostname });
    Object.assign(res, { headers: { 'content-type': 'application/json' }, statusCode: 200, complete: true });
    req.destroy = () => res.destroy();
    req.end = () => { count++; queueMicrotask(() => { req.emit('response', res); res.end(JSON.stringify({ id: 'reply', object: 'chat.completion', created: 1, model: 'fixture',
      choices: [{ index: 0, message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })); }); };
    queueMicrotask(() => { req.emit('socket', socket); socket.emit('secureConnect'); }); return req;
  }; return () => count;
}
async function execute(h, mutate = () => {}, before = () => {}, resultPatch = {}) {
  return dispatchBoundModelEvaluation(h.root, h.approval.approvalId, (run, send) => h.prepared.execute(h.root, run, send, async (i, files, options) => {
    before(files); assert.deepEqual(i, image); assert.equal(options.timeoutMs, 25000); assert.equal(typeof options.probe, 'function');
    assert.equal(files.some(f => f.bytes.includes(h.rule.expectedHash)), false);
    const profile = JSON.parse(files.find(f => f.path === 'model-profile.json').bytes);
    assert.equal(Object.hasOwn(profile, 'endpoint'), false); assert.equal(Object.hasOwn(profile, 'credential'), false);
    await send(encodeToolChatCompletionsRequest({ settings: h.config.settings, tools: h.config.tools }, [{ role: 'user', content: 'synthetic' }]));
    const manifest = manifestFor(files), q = JSON.parse(files.find(f => f.path === 'task.json').bytes);
    const receipt = { kind: 'model-sdk-task-v1', runId: run.runId, roleHash: run.roleHash, capsuleHash: q.capsuleHash,
      inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash, deliveryMode: q.deliveryMode, invocationHash: q.invocationHash, historyHash: q.historyHash,
      networkCalls: 0, modelCalls: 1, toolNames: [], artifactBase64: Buffer.from('done\n').toString('base64') };
    mutate(receipt);
    return { containerId: 'a'.repeat(64), manifest, result: { code: 0, stdout: JSON.stringify(receipt), stderr: '', ...resultPatch } };
  }), () => ({ value: 'synthetic-inert', expiresAt: Date.now() + 5000 }));
}
test('retained model preparer binds approval and actual request costs, excludes endpoint/credential/rubric from stage', async t => {
  const h = setup(t), count = network(t); const report = await execute(h);
  assert.equal(report.ledger.state, 'complete'); assert.equal(count(), 2); assert.equal(report.ledger.knownCostMicroUsd, 60);
  assert.equal(report.ledger.summary.baseline.expectationMet, 1); assert.equal(report.ledger.summary.candidate.expectationMet, 1);
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
