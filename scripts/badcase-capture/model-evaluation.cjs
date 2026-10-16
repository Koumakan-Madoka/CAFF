// Internal retained-case -> dedicated Docker -> approved model send -> host score.
// No HTTP route or implicit paid authorization. The caller must use the immutable
// reviewed plan and dispatchBoundModelEvaluation; no SDK ever executes on host.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { prepareRetainedInitializationCapsule } = require('../../build/server/domain/runtime/badcase-capture/retained-initialization');
const { planRetainedSdkDiagnostic } = require('../../build/server/domain/runtime/badcase-capture/retained-sdk-diagnostic');
const { planEvaluation } = require('../../build/server/domain/runtime/badcase-capture/evaluation-plan');
const { modelBinding } = require('../../build/server/domain/runtime/badcase-capture/model-binding');
const { readModelEgress } = require('../../build/server/domain/runtime/badcase-capture/model-egress');
const { containsSecretSentinel } = require('../../build/server/domain/runtime/badcase-capture/secrets');
const { stageDiagnostic } = require('./retained-sdk-diagnostic.cjs');
const { manifestFor } = require('./pi-probe-materials.cjs');
const { runProbe } = require('./verify-pi-initialization.cjs');
const { relayDockerTransport } = require('./container-model-relay.cjs');
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const clone = v => JSON.parse(JSON.stringify(v));
const exact = (v, ks) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join('|') === [...ks].sort().join('|');
function prepareModelEvaluation(requestValue, imageValue, sourcesValue, rolesValue, ruleValue, configValue, limitsValue) {
  const request = clone(requestValue), image = clone(imageValue), sources = clone(sourcesValue), roles = clone(rolesValue), rule = clone(ruleValue);
  const binding = modelBinding(configValue), config = binding.config, limits = clone(limitsValue);
  assert.ok(Object.hasOwn(config, 'tools'), 'reviewed_tools_required');
  assert.ok(exact(sources, ['runtimeArchive', 'harnessArchive']) && exact(roles, ['baseline', 'candidate']));
  assert.ok(exact(rule, ['expectedHash', 'badcaseHash']));
  for (const h of Object.values(rule)) assert.match(h, /^[a-f0-9]{64}$/);
  assert.notEqual(rule.expectedHash, rule.badcaseHash);
  for (const role of Object.values(roles)) assert.ok(typeof role === 'string' && role.trim() && !role.includes('\0') && Buffer.byteLength(role) <= 16384
    && Buffer.from(role).toString('utf8') === role && !containsSecretSentinel(role));
  assert.ok(exact(limits, ['repetitions', 'timeoutMs', 'perRunLimitMicroUsd', 'totalLimitMicroUsd']));
  assert.ok(Number.isSafeInteger(limits.timeoutMs) && limits.timeoutMs >= 1 && limits.timeoutMs <= 25000);
  assert.ok(config.endpoint.timeoutMs <= limits.timeoutMs && binding.perRequestReserveMicroUsd <= limits.perRunLimitMicroUsd);
  const prepared = prepareRetainedInitializationCapsule(request);
  const expected = { capsuleHash: prepared.capsuleHash, checkpointChecksum: prepared.provenance.checkpointChecksum };
  const input = planRetainedSdkDiagnostic(prepared.capsule, expected);
  const files = stageDiagnostic(prepared.capsule, expected, image, sources);
  files.find(f => f.path === 'probe.cjs').bytes = fs.readFileSync(path.join(__dirname, 'model-task-container.cjs'));
  files.push({ path: 'container-model-adapter.cjs', bytes: fs.readFileSync(path.join(__dirname, 'container-model-adapter.cjs')) },
    { path: 'model-profile.json', bytes: Buffer.from(JSON.stringify({ settings: config.settings, tools: config.tools, maxRequests: config.maxRequests })) });
  const inventory = manifestFor(files);
  const hostCode = Object.fromEntries(['model-evaluation.cjs', 'container-model-relay.cjs', 'verify-pi-initialization.cjs', 'image-recovery.cjs',
    'model-evaluation-operator.cjs', 'authorized-model-auth.cjs']
    .map(name => [name, hash(fs.readFileSync(path.join(__dirname, name)))]));
  const plan = planEvaluation({ caseId: request.flagId, checkpointHash: expected.checkpointChecksum,
    inputHash: prepared.capsuleHash, environmentHash: hash(JSON.stringify(image)), harnessHash: hash(JSON.stringify({ files: inventory.files, hostCode })),
    roleId: 'bounded-container-role', baselineRoleHash: hash(roles.baseline), candidateRoleHash: hash(roles.candidate),
    model: { provider: config.settings.provider, id: config.settings.model, settingsHash: binding.bindingHash },
    evaluator: { id: 'file-sha256-v1', versionHash: hash(JSON.stringify({ version: 1, codeHash: hostCode['model-evaluation.cjs'], ...rule })) }, ...limits });
  const review = { schemaVersion: 1, planHash: plan.planHash, deliveryMode: input.mode, invocationHash: hash(input.invocation),
    historyHash: hash(JSON.stringify(input.messages)), roles, rule, declaredImage: image, binding,
    artifact: 'evaluation-result.txt', faithfulReplay: false, paidAuthorization: false };
  return { plan: clone(plan), review: clone(review), async execute(root, value, send, dedicatedProbe) {
    const q = clone(value), row = plan.runs.find(r => r.runId === q.runId); assert.ok(row);
    assert.ok(exact(q, [...Object.keys(row), 'planHash', 'timeoutMs', 'perRunLimitMicroUsd', 'approvalId', 'expiresAt']));
    for (const k of Object.keys(row)) assert.deepEqual(q[k], row[k]);
    assert.equal(q.planHash, plan.planHash); assert.equal(q.timeoutMs, limits.timeoutMs); assert.equal(q.perRunLimitMicroUsd, limits.perRunLimitMicroUsd);
    assert.ok(Number.isSafeInteger(q.expiresAt) && Date.now() < q.expiresAt);
    assert.equal(typeof send, 'function'); assert.equal(typeof dedicatedProbe, 'function');
    for (const [name, digest] of Object.entries(hostCode)) assert.equal(hash(fs.readFileSync(path.join(__dirname, name))), digest);
    // The original outer/request ledger must exist before container creation.
    const before = readModelEgress(root, q.runId);
    assert.equal(before.policy.approvalId, q.approvalId); assert.equal(before.policy.planHash, plan.planHash);
    assert.equal(before.policy.settingsHash, binding.settingsHash); assert.equal(before.requests.length, 0);
    const current = prepareRetainedInitializationCapsule({ ...request, replayRunId: q.runId });
    assert.equal(current.capsule, prepared.capsule); assert.equal(current.capsuleHash, expected.capsuleHash);
    const task = { runId: q.runId, role: roles[q.variant], expiresAt: q.expiresAt, capsuleHash: expected.capsuleHash,
      deliveryMode: input.mode, invocationHash: hash(input.invocation), historyHash: hash(JSON.stringify(input.messages)) };
    const stage = files.map(f => ({ path: f.path, bytes: Buffer.from(f.bytes) })); stage.push({ path: 'task.json', bytes: Buffer.from(JSON.stringify(task)) });
    const manifest = manifestFor(stage);
    const r = await dedicatedProbe(clone(image), stage, { timeoutMs: q.timeoutMs,
      probe: (i, f, options) => runProbe(i, f, { ...options, runDocker: relayDockerTransport(options.runDocker, send,
        { maxRequests: config.maxRequests, maxRequestBytes: config.settings.maxRequestBytes, maxResponseBytes: config.settings.maxResponseBytes }) }) });
    assert.ok(r && /^[a-f0-9]{64}$/.test(r.containerId));
    assert.equal(r.manifest?.inputHash, manifest.inputHash); assert.equal(r.manifest?.runtimeHash, manifest.runtimeHash);
    assert.equal(r.termination, undefined); assert.ok(r.result && r.result.code === 0 && !r.result.failure && r.result.stderr === '');
    assert.ok(typeof r.result.stdout === 'string' && Buffer.byteLength(r.result.stdout) <= 16384);
    const receipt = JSON.parse(r.result.stdout), { artifactBase64, modelCalls, toolNames, ...observed } = receipt;
    assert.deepEqual(observed, { kind: 'model-sdk-task-v1', runId: q.runId, roleHash: q.roleHash, capsuleHash: task.capsuleHash,
      inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash, deliveryMode: task.deliveryMode,
      invocationHash: task.invocationHash, historyHash: task.historyHash, networkCalls: 0 });
    const egress = readModelEgress(root, q.runId);
    assert.equal(egress.unknownCostRequests, 0); assert.ok(egress.requests.length > 0); assert.equal(modelCalls, egress.requests.length);
    assert.ok(Array.isArray(toolNames) && toolNames.length <= config.maxRequests && toolNames.every(n => config.tools.some(t => t.function.name === n)));
    assert.ok(typeof artifactBase64 === 'string' && artifactBase64.length <= 5464);
    const bytes = Buffer.from(artifactBase64, 'base64'); assert.ok(bytes.length <= 4096 && bytes.toString('base64') === artifactBase64);
    const outputHash = hash(bytes);
    return { runId: q.runId, status: 'completed', costMicroUsd: egress.knownCostMicroUsd, outputHash,
      score: { expectationMet: outputHash === rule.expectedHash, badcaseReproduced: outputHash === rule.badcaseHash } };
  } };
}
module.exports = { prepareModelEvaluation };
