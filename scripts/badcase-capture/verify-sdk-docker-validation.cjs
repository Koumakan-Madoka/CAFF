// Explicit synthetic-HTTPS + REAL Docker/SDK/approval/dual-ledger integration.
// No supplier call, auth discovery or user capture. At most three containers:
// zero-model full-tool preflight, one baseline, one candidate; stop on failure.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict'), https = require('node:https');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const { inspectSdkValidationTools, prepareSdkDockerValidation } = require('./sdk-docker-validation.cjs');
const { recordBoundModelApproval, readBoundModelApproval, modelBinding } = require('../../build/server/domain/runtime/badcase-capture/model-binding');
const { readModelEgress } = require('../../build/server/domain/runtime/badcase-capture/model-egress');
const { verifyProbeImage, runProbe } = require('./verify-pi-initialization.cjs');
const { runDockerCommand } = require('../../build/server/domain/runtime/badcase-capture/docker-sandbox');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
async function verifySdkDockerValidation(repo, dependencyRoot, image, dedicatedProbe) {
  const ids = [], stages = [];
  const transport = async (i, f, options) => {
    stages.push(f); const r = await dedicatedProbe(i, f, options); ids.push(r.containerId); return r;
  };
  const settings = { provider: 'opencode-go', model: 'deepseek-v4.1-flash', contextWindowTokens: 131072, maxOutputTokens: 256,
    temperature: 0, inputMicroUsdPerMillionTokens: 1000000, outputMicroUsdPerMillionTokens: 2000000,
    maxRequestBytes: 262144, maxResponseBytes: 65536, compatibilityProfile: 'opencode-go-deepseek-nonthinking-cached-index0-v1' };
  const input = { prompt: 'Write validation-result.txt containing the requested validation output, then finish.', files: [
    { path: 'AGENTS.md', content: '# New validation context\nVALIDATION_PROJECT_CONTEXT\n' },
    { path: '.agents/skills/validation-skill/SKILL.md', content: '---\nname: validation-skill\ndescription: VALIDATION_PROJECT_SKILL\n---\nExplicit new validation project instructions.\n' }] };
  const roles = { baseline: 'VALIDATION_BASELINE_ROLE', candidate: 'VALIDATION_CANDIDATE_ROLE' };
  const tools = await inspectSdkValidationTools(repo, dependencyRoot, image, input, settings, roles.baseline, transport);
  assert.equal(tools.length, 10);
  const config = { settings, tools, maxRequests: 2, endpoint: { hostname: 'opencode.ai', address: '93.184.216.34',
    path: '/zen/go/v1/chat/completions', clientProfile: 'opencode-go-v1', maxRequestBytes: settings.maxRequestBytes,
    maxResponseBytes: settings.maxResponseBytes, timeoutMs: 15000 } };
  const reserve = modelBinding(config).perRequestReserveMicroUsd * config.maxRequests;
  const output = 'native approved SDK validation complete\n';
  const prepared = prepareSdkDockerValidation(repo, dependencyRoot, image, { caseId: 'new-sdk-validation-not-badcase', input, roles,
    rule: { expectedHash: hash(output), badcaseHash: hash('synthetic undesired output') }, config,
    limits: { repetitions: 1, timeoutMs: 25000, perRunLimitMicroUsd: reserve, totalLimitMicroUsd: reserve * 2 } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-sdk-validation-ledger-'));
  const approval = { approvalId: 'synthetic-sdk-docker-approval', confirmed: true, planHash: prepared.plan.planHash, expiresAt: Date.now() + 180000 };
  const initialRequest = https.request; let calls = 0;
  try {
    recordBoundModelApproval(root, prepared.plan.spec, config, approval);
    https.request = options => {
      const req = new EventEmitter(), socket = new EventEmitter(), res = new PassThrough();
      Object.assign(socket, { encrypted: true, authorized: true, remoteAddress: options.hostname });
      Object.assign(res, { headers: { 'content-type': 'application/json' }, statusCode: 200, complete: true });
      req.destroy = () => res.destroy();
      req.end = bytes => {
        const outer = readBoundModelApproval(root, approval.approvalId).report;
        assert.equal(outer.ledger.state, 'reserved');
        const run = outer.ledger.runs.at(-1), egress = readModelEgress(root, run.runId);
        assert.equal(egress.requests.at(-1).status, 'reserved');
        const body = JSON.parse(bytes); assert.equal(body.stream, false); assert.equal(body.model, settings.model);
        assert.deepEqual(body.tools, tools); assert.ok(body.messages[0].content.includes(roles[run.variant]));
        for (const marker of ['VALIDATION_PROJECT_CONTEXT', 'VALIDATION_PROJECT_SKILL']) assert.ok(body.messages[0].content.includes(marker));
        const calling = egress.requests.length === 1; calls++; assert.ok(calls <= 4);
        queueMicrotask(() => { req.emit('response', res); res.end(JSON.stringify({ id: 'synthetic-' + calls, object: 'chat.completion', created: 1,
          model: settings.model, choices: [{ index: 0, message: { role: 'assistant', content: calling ? null : 'Validation finished.', reasoning_content: '',
            ...(calling ? { tool_calls: [{ index: 0, id: 'validation-write', type: 'function', function: {
              name: 'write', arguments: JSON.stringify({ path: 'validation-result.txt', content: output }) } }] } : {}) },
            finish_reason: calling ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })); });
      };
      queueMicrotask(() => { req.emit('socket', socket); socket.emit('secureConnect'); }); return req;
    };
    const report = await prepared.dispatch(root, approval.approvalId,
      () => ({ value: 'synthetic-supplier-not-real', expiresAt: Date.now() + 30000 }), transport);
    assert.equal(report.dispatchState, 'finished'); assert.equal(report.ledger.runs.length, 2); assert.equal(calls, 4);
    assert.ok(report.ledger.runs.every(r => r.status === 'completed' && r.score.expectationMet && !r.score.badcaseReproduced));
    assert.equal(new Set(ids).size, 3); assert.equal(stages.length, 3);
    const a = stages[1].filter(f => f.path !== 'validation-task.json'), b = stages[2].filter(f => f.path !== 'validation-task.json');
    assert.deepEqual(a, b); // actual complete distribution/profile/input, not caller assertions
    for (const f of stages.flat()) {
      assert.ok(!f.bytes.includes(Buffer.from('synthetic-supplier-not-real')));
      assert.ok(!f.bytes.includes(Buffer.from(hash(output)))); // host-only scoring/reference hash
    }
    const egress = report.ledger.runs.map(r => readModelEgress(root, r.runId));
    assert.ok(egress.every(r => r.requests.length === 2 && r.requests.every(q => q.status === 'completed')));
    return { kind: 'synthetic-approved-sdk-docker-validation-v1', supplierRequests: 0, syntheticRequests: calls,
      containers: ids, removed: true, completeTools: tools.length, inputHash: prepared.plan.spec.inputHash,
      launchHash: prepared.review.launchHash, ledger: report.ledger, requestLedgers: egress, acceptance: false, realCapture: false, faithfulReplay: false };
  } finally { https.request = initialRequest; fs.rmSync(root, { recursive: true, force: true }); }
}
if (require.main === module) Promise.resolve().then(async () => {
  const args = process.argv.slice(2), arg = name => { const i = args.indexOf('--' + name); if (i < 0 || !args[i + 1]) throw Error(); return args[i + 1]; };
  const image = { imageId: arg('image-id'), repositoryDigest: arg('repository-digest'), architecture: arg('architecture'), nodeVersion: arg('node-version'), pythonVersion: arg('python-version') };
  await verifyProbeImage(image);
  const dedicated = (i, f, options) => options.probe(i, f, { timeoutMs: options.timeoutMs, runDocker: runDockerCommand });
  console.log(JSON.stringify(await verifySdkDockerValidation(process.cwd(), process.cwd(), image, dedicated)));
}).catch(() => { process.stderr.write('sdk_docker_validation_failed\n'); process.exitCode = 1; });
module.exports = { verifySdkDockerValidation };
