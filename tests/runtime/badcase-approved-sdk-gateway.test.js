// HTTP + real approval/request coordinators, synthetic HTTPS; no host SDK/agent.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const http = require('node:http'), https = require('node:https');
const initialHttpsRequest = https.request;
const { EventEmitter } = require('node:events'); const { PassThrough } = require('node:stream');
const { approvedSdkGatewayHarness, dispatchApprovedSdkGateway: dispatchNativeGateway } = require('../../scripts/badcase-capture/approved-sdk-model-gateway.cjs');
const { modelBinding, recordBoundModelApproval, readBoundModelApproval } = require('../../build/server/domain/runtime/badcase-capture/model-binding');
const { planEvaluation } = require('../../build/server/domain/runtime/badcase-capture/evaluation-plan');
const { readModelEgress } = require('../../build/server/domain/runtime/badcase-capture/model-egress');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const launchHash = hash('synthetic-launcher-and-staged-inputs');
const dispatchApprovedSdkGateway = (root, id, credential, drive) => dispatchNativeGateway(root, id, launchHash, credential, drive);
function fixture(t, { wrongHarness = false, timeoutMs = 3000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-approved-sdk-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { settings: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', contextWindowTokens: 1000, maxOutputTokens: 100,
    temperature: 0, inputMicroUsdPerMillionTokens: 1000000, outputMicroUsdPerMillionTokens: 2000000, maxRequestBytes: 8192, maxResponseBytes: 8192,
    compatibilityProfile: 'opencode-go-deepseek-nonthinking-cached-index0-v1' },
    tools: [{ type: 'function', function: { name: 'read', description: 'Read', parameters: { type: 'object' } } }], maxRequests: 1,
    endpoint: { hostname: 'opencode.ai', address: '93.184.216.34', path: '/zen/go/v1/chat/completions', clientProfile: 'opencode-go-v1',
      maxRequestBytes: 8192, maxResponseBytes: 8192, timeoutMs: Math.min(1000, timeoutMs) } };
  const binding = modelBinding(config), harness = approvedSdkGatewayHarness(launchHash);
  const plan = planEvaluation({ caseId: 'synthetic-sdk-supervisor', checkpointHash: hash('synthetic-cp'), inputHash: hash('synthetic-input'),
    environmentHash: hash('synthetic-env'), harnessHash: wrongHarness ? hash('wrong') : harness.harnessHash,
    roleId: 'synthetic-role', baselineRoleHash: hash('base'), candidateRoleHash: hash('candidate'),
    model: { provider: config.settings.provider, id: config.settings.model, settingsHash: binding.bindingHash },
    evaluator: { id: 'synthetic-not-acceptance', versionHash: hash('scorer') }, repetitions: 1, timeoutMs,
    perRunLimitMicroUsd: binding.perRequestReserveMicroUsd, totalLimitMicroUsd: 2 * binding.perRequestReserveMicroUsd });
  const approval = { approvalId: 'synthetic-sdk-approval', planHash: plan.planHash, confirmed: true, expiresAt: Date.now() + 60000 };
  recordBoundModelApproval(root, plan.spec, config, approval);
  return { root, config, plan, approval, harness };
}
function syntheticNetwork(t, f, invalid = false) {
  t.after(() => { https.request = initialHttpsRequest; }); let calls = 0;
  https.request = options => {
    const req = new EventEmitter(), socket = new EventEmitter(), res = new PassThrough();
    Object.assign(socket, { encrypted: true, authorized: true, remoteAddress: options.hostname });
    Object.assign(res, { headers: { 'content-type': 'application/json' }, statusCode: 200, complete: true });
    req.destroy = () => res.destroy();
    req.end = () => {
      calls++; const outer = readBoundModelApproval(f.root, f.approval.approvalId).report;
      assert.equal(outer.ledger.state, 'reserved'); assert.equal(readModelEgress(f.root, outer.ledger.runs.at(-1).runId).requests[0].status, 'reserved');
      queueMicrotask(() => { req.emit('response', res); res.end(invalid ? 'PRIVATE-INVALID' : JSON.stringify({ id: 'synthetic', object: 'chat.completion', created: 1,
        model: f.config.settings.model, choices: [{ index: 0, message: { role: 'assistant', content: 'synthetic SDK reply' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })); });
    };
    queueMicrotask(() => { req.emit('socket', socket); socket.emit('secureConnect'); }); return req;
  }; return () => calls;
}
function request(routing) {
  const p = routing.models.providers['opencode-go'], body = JSON.stringify({ model: p.models[0].id, stream: true, stream_options: { include_usage: true },
    max_completion_tokens: 100, thinking: { type: 'disabled' }, tools: [{ type: 'function', function: { name: 'read', description: 'Read', parameters: { type: 'object' } } }],
    messages: [{ role: 'user', content: 'synthetic' }] });
  return new Promise((resolve, reject) => {
    const req = http.request(p.baseUrl + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json',
      authorization: 'Bearer ' + routing.environment.CAFF_SDK_MODEL_GATEWAY_KEY } }, res => {
      const parts = []; res.on('data', b => parts.push(b)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString() }));
    }); req.on('error', reject); req.end(body);
  });
}
const lease = () => ({ value: 'synthetic-supplier-key', expiresAt: Date.now() + 10000 });
const outcome = () => ({ outputHash: hash('synthetic-launcher-observation'), score: { expectationMet: false, badcaseReproduced: false } });

test('approved native SDK supervisor gives each reserved run new local routing, accounts first and closes it before settlement', async t => {
  const f = fixture(t), calls = syntheticNetwork(t, f), routes = [];
  assert.ok(f.harness.files['scripts/badcase-capture/approved-sdk-model-gateway.cjs']);
  assert.ok(f.harness.files['scripts/badcase-capture/sdk-model-gateway.cjs']);
  const report = await dispatchApprovedSdkGateway(f.root, f.approval.approvalId, lease, async input => {
    assert.deepEqual(Object.keys(input).sort(), ['models', 'environment', 'run', 'signal'].sort());
    assert.ok(input.signal instanceof AbortSignal); routes.push(input);
    assert.ok(!JSON.stringify(input).includes('synthetic-supplier-key'));
    const response = await request(input); assert.equal(response.status, 200); assert.ok(response.text.includes('[DONE]'));
    const row = readModelEgress(f.root, input.run.runId).requests[0]; assert.equal(row.status, 'completed');
    return outcome();
  });
  assert.equal(calls(), 2); assert.equal(report.dispatchState, 'finished'); assert.equal(report.ledger.knownCostMicroUsd, 80);
  assert.notEqual(routes[0].environment.CAFF_SDK_MODEL_GATEWAY_KEY, routes[1].environment.CAFF_SDK_MODEL_GATEWAY_KEY);
  for (const route of routes) { assert.equal(route.signal.aborted, true); await assert.rejects(request(route)); }
  await assert.rejects(dispatchApprovedSdkGateway(f.root, f.approval.approvalId, lease, async () => assert.fail()));
  assert.equal(calls(), 2);
});

test('missing approval or wrong source-inventory harness cannot launch or access a supplier lease', async t => {
  const f = fixture(t, { wrongHarness: true }); let touched = 0;
  const credential = () => { touched++; return lease(); }, drive = async () => { touched++; return outcome(); };
  await assert.rejects(dispatchApprovedSdkGateway(f.root, f.approval.approvalId, credential, drive));
  await assert.rejects(dispatchApprovedSdkGateway(f.root, 'missing', credential, drive));
  assert.equal(touched, 0); assert.equal(readBoundModelApproval(f.root, f.approval.approvalId).report.consumed, false);
  const valid = fixture(t);
  await assert.rejects(dispatchNativeGateway(valid.root, valid.approval.approvalId, hash('different-launch-materials'), credential, drive));
  assert.equal(touched, 0); assert.equal(readBoundModelApproval(valid.root, valid.approval.approvalId).report.consumed, false);
});

test('launcher failure or zero model calls cannot become a completed/zero-cost run; loopback identity is closed', async t => {
  for (const make of [async () => { throw Error('PRIVATE-LAUNCHER'); }, async () => outcome()]) {
    const f = fixture(t), calls = syntheticNetwork(t, f); let route;
    const report = await dispatchApprovedSdkGateway(f.root, f.approval.approvalId, lease, async input => { route = input; return make(); });
    assert.equal(report.dispatchState, 'unresolved'); assert.equal(report.ledger.runs.length, 1); assert.equal(report.ledger.runs[0].score, null);
    assert.equal(calls(), 0); assert.equal(route.signal.aborted, true); await assert.rejects(request(route));
    assert.ok(!JSON.stringify(report).includes('PRIVATE'));
  }
});

test('a provider protocol failure is sticky even if the launcher tries again or returns a success assertion', async t => {
  const f = fixture(t), calls = syntheticNetwork(t, f, true);
  const report = await dispatchApprovedSdkGateway(f.root, f.approval.approvalId, lease, async input => {
    assert.equal((await request(input)).status, 502); assert.equal((await request(input)).status, 503); return outcome();
  });
  assert.equal(calls(), 1); assert.equal(report.dispatchState, 'unresolved'); assert.equal(report.ledger.runs.length, 1);
  const egress = readModelEgress(f.root, report.ledger.runs[0].runId);
  assert.equal(egress.unknownCostRequests, 1); assert.equal(egress.requests[0].failureStage, 'protocol_decode');
  assert.equal(report.ledger.runs[0].score, null);
});

test('gateway-level refusal cannot be hidden by a launcher success after an earlier completed request', async t => {
  const f = fixture(t), calls = syntheticNetwork(t, f);
  const report = await dispatchApprovedSdkGateway(f.root, f.approval.approvalId, lease, async input => {
    assert.equal((await request(input)).status, 200);
    assert.equal((await request(input)).status, 503); // SDK tried beyond this run's approved one-request cap
    return outcome(); // a launcher must not turn that failed SDK request into success
  });
  assert.equal(calls(), 1); assert.equal(report.dispatchState, 'unresolved');
  assert.equal(report.ledger.runs.length, 1); assert.equal(report.ledger.runs[0].score, null);
});

test('run deadline signals the trusted launcher, closes loopback access, and does not accept its late outcome', async t => {
  const f = fixture(t, { timeoutMs: 500 }), calls = syntheticNetwork(t, f); let route;
  const report = await dispatchApprovedSdkGateway(f.root, f.approval.approvalId, lease, async input => {
    route = input; await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true })); return outcome();
  });
  assert.equal(route.signal.aborted, true); assert.equal(calls(), 0); await assert.rejects(request(route));
  assert.equal(report.dispatchState, 'unresolved'); assert.equal(report.ledger.runs.length, 1);
});
