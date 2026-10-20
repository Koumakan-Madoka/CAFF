// Trusted operator launcher for a NEW fresh validation instance, NOT captured-case
// replay. Full CAFF factory/SDK execute only in Docker. No implicit approval,
// credential discovery, network grant, host-agent fallback or production routing.
const { captureHostCode } = require('./model-host-code.cjs');
const snapshot = captureHostCode();
const path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { prepareCaffRuntimeFiles } = require('./caff-runtime-wiring.cjs');
const { readTrustedDistributionFile } = require('./evaluation-bridge-launcher.cjs');
const { manifestFor } = require('./pi-probe-materials.cjs');
const { runProbe } = require('./verify-pi-initialization.cjs');
const { relayDockerTransport } = require('./container-model-relay.cjs');
const { approvedSdkGatewayHarness } = require('./approved-sdk-model-gateway.cjs');
const { modelBinding, readBoundModelApproval, dispatchBoundModelEvaluation } = require('../../build/server/domain/runtime/badcase-capture/model-binding');
const { planEvaluation } = require('../../build/server/domain/runtime/badcase-capture/evaluation-plan');
const { readModelEgress } = require('../../build/server/domain/runtime/badcase-capture/model-egress');
const { toolChatCompletionsSettings } = require('../../build/server/domain/runtime/badcase-capture/chat-completions-protocol');
const { containsSecretSentinel } = require('../../build/server/domain/runtime/badcase-capture/secrets');
const copy = v => JSON.parse(JSON.stringify(v));
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
function text(s, max) { assert.ok(typeof s === 'string' && s.trim() && !s.includes('\0') && Buffer.byteLength(s) <= max
  && Buffer.from(s).toString('utf8') === s && !containsSecretSentinel(s), 'sdk_validation_input_invalid'); }
// Staging has a JSON inventory and embedded container source; it is deliberately
// NOT fed into the generic CommonJS-only scanner. This closed extra source list
// is independently read/verified and committed by launchHash, not omitted.
const sourceNames = ['sdk-docker-validation.cjs', 'sdk-validation-operator.cjs', 'caff-runtime-wiring.cjs', 'evaluation-bridge-launcher.cjs', 'evaluation-bridge-files.json'];
const sourceRoot = path.resolve(__dirname, '../..');
const sources = () => sourceNames.map(n => ({ path: 'scripts/badcase-capture/' + n,
  sha256: hash(readTrustedDistributionFile(sourceRoot, 'scripts/badcase-capture/' + n, 1048576)) }));
const sourceInventory = sources();
function verifyCode() { snapshot.verify(); assert.deepEqual(sources(), sourceInventory, 'sdk_validation_source_changed'); }
function inputValue(value) {
  const q = copy(value); assert.ok(exact(q, ['prompt', 'files']) && Array.isArray(q.files) && q.files.length <= 128);
  text(q.prompt, 16384); const files = [];
  for (const f of q.files) {
    assert.ok(exact(f, ['path', 'content']) && typeof f.path === 'string' && /^[A-Za-z0-9_.@/-]+$/.test(f.path)
      && f.path.split('/').every(p => p && p !== '.' && p !== '..' && !/^\.(?:git|env)(?:$|\.)/i.test(p)));
    text(f.content, 65536); files.push({ path: f.path, bytes: Buffer.from(f.content) });
  }
  manifestFor(files); assert.ok(Buffer.byteLength(JSON.stringify(q)) <= 1048576); return q;
}
function stage(repoRoot, dependencyRoot, image, input, profile) {
  const files = prepareCaffRuntimeFiles(repoRoot, dependencyRoot, image, 'fresh');
  files.find(f => f.path === 'probe.cjs').path = 'caff-runtime-bootstrap.cjs';
  for (const [source, destination] of [
    ['scripts/badcase-capture/sdk-validation-container.cjs', 'probe.cjs'],
    ['scripts/badcase-capture/container-model-adapter.cjs', 'container-model-adapter.cjs'],
    ['scripts/badcase-capture/sdk-model-gateway.cjs', 'scripts/badcase-capture/sdk-model-gateway.cjs'],
    ...['chat-completions-protocol', 'model-egress', 'model-identifier'].map(n => {
      const p = 'build/server/domain/runtime/badcase-capture/' + n + '.js'; return [p, p];
    })]) files.push({ path: destination, bytes: readTrustedDistributionFile(path.resolve(repoRoot), source,
      16 * 1024 * 1024 - files.reduce((n, f) => n + f.bytes.length, 0)) });
  files.push({ path: 'validation-input.json', bytes: Buffer.from(JSON.stringify(input)) },
    { path: 'model-profile.json', bytes: Buffer.from(JSON.stringify(profile)) });
  manifestFor(files); return files;
}
async function launch(image, base, task, timeoutMs, dedicatedProbe, send, profile) {
  assert.equal(typeof dedicatedProbe, 'function', 'dedicated_docker_transport_required');
  verifyCode();
  const files = base.map(f => ({ path: f.path, bytes: Buffer.from(f.bytes) }));
  files.push({ path: 'validation-task.json', bytes: Buffer.from(JSON.stringify(task)) });
  const manifest = manifestFor(files);
  const r = await dedicatedProbe(copy(image), files, { timeoutMs, probe: (i, f, options) => {
    assert.equal(typeof options?.runDocker, 'function', 'dedicated_docker_transport_required');
    return runProbe(i, f, { ...options, executableWork: true, runDocker: send ? relayDockerTransport(options.runDocker, send,
      { maxRequests: profile.maxRequests, maxRequestBytes: profile.settings.maxRequestBytes, maxResponseBytes: profile.settings.maxResponseBytes }) : options.runDocker });
  } });
  verifyCode();
  assert.ok(r && /^[a-f0-9]{64}$/.test(r.containerId)); assert.deepEqual(r.manifest, manifest);
  assert.equal(r.termination, undefined); assert.ok(r.result?.code === 0 && !r.result.failure && r.result.stderr === '');
  assert.ok(typeof r.result.stdout === 'string' && Buffer.byteLength(r.result.stdout) <= 131072);
  const receipt = JSON.parse(r.result.stdout);
  assert.equal(receipt.kind, 'fresh-caff-sdk-validation-v1'); assert.equal(receipt.inputHash, manifest.inputHash);
  assert.equal(receipt.runtimeHash, manifest.runtimeHash); assert.equal(receipt.runId, task.runId); assert.equal(receipt.roleHash, hash(task.role));
  assert.equal(receipt.preflight, task.preflight); assert.equal(receipt.externalFetches, 0);
  return receipt;
}
// Zero-model preflight obtains the complete actual default+extension tool schema
// for human review/new immutable approval. It cannot acquire supplier authority.
async function inspectSdkValidationTools(repoRoot, dependencyRoot, image, input, settings, role, dedicatedProbe) {
  input = inputValue(input); text(role, 16384);
  const profile = { settings: copy(settings), maxRequests: 2, tools: [{ type: 'function', function: {
    name: 'read', description: 'Zero-model preflight declaration only', parameters: { type: 'object' } } }] };
  toolChatCompletionsSettings({ settings: profile.settings, tools: profile.tools });
  const task = { preflight: true, runId: 'zero-model-preflight', role, expiresAt: Date.now() + 25000 };
  const r = await launch(image, stage(repoRoot, dependencyRoot, image, input, profile), task, 25000, dedicatedProbe);
  assert.deepEqual(Object.keys(r).sort(), ['kind', 'inputHash', 'runtimeHash', 'runId', 'roleHash', 'preflight', 'externalFetches', 'modelCalls', 'tools'].sort());
  assert.equal(r.modelCalls, 0); assert.ok(Array.isArray(r.tools) && r.tools.length >= 10);
  toolChatCompletionsSettings({ settings: profile.settings, tools: r.tools }); return copy(r.tools);
}
function prepareSdkDockerValidation(repoRoot, dependencyRoot, imageValue, value) {
  verifyCode(); const q = copy(value), image = copy(imageValue);
  assert.ok(exact(q, ['caseId', 'input', 'roles', 'rule', 'config', 'limits']));
  const input = inputValue(q.input), binding = modelBinding(q.config), config = binding.config;
  assert.ok(!input.files.some(f => f.path === 'validation-result.txt'));
  assert.ok(exact(q.limits, ['repetitions', 'timeoutMs', 'perRunLimitMicroUsd', 'totalLimitMicroUsd']) && q.limits.repetitions === 1);
  assert.ok(Object.hasOwn(config, 'tools') && config.maxRequests <= 2 && q.limits.timeoutMs <= 25000
    && config.endpoint.timeoutMs <= q.limits.timeoutMs && binding.perRequestReserveMicroUsd * config.maxRequests <= q.limits.perRunLimitMicroUsd);
  assert.ok(config.settings.provider === 'opencode-go' && config.settings.model === 'deepseek-v4.1-flash' && config.settings.compatibilityProfile);
  assert.ok(exact(q.roles, ['baseline', 'candidate']) && exact(q.rule, ['expectedHash', 'badcaseHash']));
  for (const role of Object.values(q.roles)) text(role, 16384);
  for (const h of Object.values(q.rule)) assert.match(h, /^[a-f0-9]{64}$/); assert.notEqual(q.rule.expectedHash, q.rule.badcaseHash);
  const profile = { settings: config.settings, tools: config.tools, maxRequests: config.maxRequests };
  const files = stage(repoRoot, dependencyRoot, image, input, profile), inventory = manifestFor(files);
  const launchHash = hash(JSON.stringify({ kind: 'fresh-caff-sdk-validation-v1', image, files: inventory.files, sources: sourceInventory }));
  const harness = approvedSdkGatewayHarness(launchHash);
  const plan = planEvaluation({ caseId: q.caseId, checkpointHash: hash(JSON.stringify(input)), inputHash: hash(JSON.stringify(input)),
    environmentHash: hash(JSON.stringify(image)), harnessHash: harness.harnessHash, roleId: 'fresh-validation-role',
    baselineRoleHash: hash(q.roles.baseline), candidateRoleHash: hash(q.roles.candidate),
    model: { provider: config.settings.provider, id: config.settings.model, settingsHash: binding.bindingHash },
    evaluator: { id: 'validation-file-sha256-v1', versionHash: hash(JSON.stringify({ code: snapshot.files, sources: sourceInventory, rule: q.rule })) }, ...q.limits });
  return { plan: copy(plan), review: { launchHash, realCapture: false, faithfulReplay: false, artifact: 'validation-result.txt',
    inputHash: plan.spec.inputHash, toolsHash: hash(JSON.stringify(config.tools)), limits: copy(q.limits) },
  async dispatch(root, approvalId, credential, dedicatedProbe) {
    verifyCode(); assert.equal(typeof credential, 'function'); assert.equal(typeof dedicatedProbe, 'function');
    const approved = readBoundModelApproval(root, approvalId);
    assert.deepEqual(approved.report.ledger.spec, plan.spec); assert.deepEqual(approved.binding.config, config);
    return dispatchBoundModelEvaluation(root, approvalId, async (run, authorizedSend) => {
      verifyCode(); assert.equal(run.planHash, plan.planHash);
      const row = plan.runs.find(r => r.runId === run.runId); assert.ok(row);
      for (const k of Object.keys(row)) assert.deepEqual(run[k], row[k]);
      const before = readModelEgress(root, run.runId); assert.equal(before.requests.length, 0);
      assert.equal(before.policy.approvalId, approvalId); assert.equal(before.policy.planHash, plan.planHash);
      const send = async body => { verifyCode(); const response = await authorizedSend(body); verifyCode(); return response; };
      const task = { preflight: false, runId: run.runId, role: q.roles[run.variant], expiresAt: Math.min(run.expiresAt, Date.now() + run.timeoutMs) };
      const r = await launch(image, files, task, run.timeoutMs, dedicatedProbe, send, profile);
      assert.deepEqual(Object.keys(r).sort(), ['kind', 'inputHash', 'runtimeHash', 'runId', 'roleHash', 'preflight', 'externalFetches', 'modelCalls', 'artifactBase64', 'toolNames'].sort());
      const egress = readModelEgress(root, run.runId);
      assert.equal(egress.unknownCostRequests, 0); assert.ok(egress.requests.length > 0 && egress.requests.every(r => r.status === 'completed'));
      assert.equal(r.modelCalls, egress.requests.length);
      assert.ok(Array.isArray(r.toolNames) && r.toolNames.length <= config.maxRequests && r.toolNames.every(n => config.tools.some(t => t.function.name === n)));
      assert.ok(typeof r.artifactBase64 === 'string' && r.artifactBase64.length <= 5464);
      const artifact = Buffer.from(r.artifactBase64, 'base64'); assert.ok(artifact.length <= 4096 && artifact.toString('base64') === r.artifactBase64);
      const outputHash = hash(artifact);
      return { runId: run.runId, status: 'completed', outputHash, costMicroUsd: egress.knownCostMicroUsd,
        score: { expectationMet: outputHash === q.rule.expectedHash, badcaseReproduced: outputHash === q.rule.badcaseHash } };
    }, scope => { verifyCode(); return credential(scope); });
  } };
}
module.exports = { prepareSdkDockerValidation, inspectSdkValidationTools };
