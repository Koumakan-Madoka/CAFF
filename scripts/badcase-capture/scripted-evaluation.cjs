// Internal OFFLINE integration adapter. Scripted model, not a paid launcher or
// faithful replay. Caller must supply the dedicated restored daemon's runProbe.
// No SDK/model/scorer code from a case is ever executed on the host.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { prepareRetainedInitializationCapsule } = require('../../build/server/domain/runtime/badcase-capture/retained-initialization');
const { planRetainedSdkDiagnostic } = require('../../build/server/domain/runtime/badcase-capture/retained-sdk-diagnostic');
const { planEvaluation } = require('../../build/server/domain/runtime/badcase-capture/evaluation-plan');
const { containsSecretSentinel } = require('../../build/server/domain/runtime/badcase-capture/secrets');
const { stageDiagnostic } = require('./retained-sdk-diagnostic.cjs');
const { manifestFor } = require('./pi-probe-materials.cjs');
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const clone = v => JSON.parse(JSON.stringify(v));
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
function gate(expiresAt) { assert.ok(Number.isSafeInteger(expiresAt) && Date.now() < expiresAt, 'scripted_evaluation_expired'); }
function prepareScriptedEvaluation(requestValue, imageValue, sourcesValue, rolesValue, ruleValue, repetitions = 1) {
  const request = clone(requestValue), image = clone(imageValue), sources = clone(sourcesValue), roles = clone(rolesValue), rule = clone(ruleValue);
  assert.ok(exact(sources, ['runtimeArchive', 'harnessArchive']));
  assert.ok(exact(roles, ['baseline', 'candidate']));
  for (const role of Object.values(roles)) assert.ok(typeof role === 'string' && role.trim() && !role.includes('\0')
    && Buffer.byteLength(role) <= 16384 && Buffer.from(role).toString('utf8') === role && !containsSecretSentinel(role), 'scripted_role_invalid');
  assert.ok(exact(rule, ['expectedHash', 'badcaseHash']));
  for (const h of Object.values(rule)) assert.match(h, /^[a-f0-9]{64}$/);
  assert.notEqual(rule.expectedHash, rule.badcaseHash);
  const prepared = prepareRetainedInitializationCapsule(request);
  const expected = { capsuleHash: prepared.capsuleHash, checkpointChecksum: prepared.provenance.checkpointChecksum };
  const input = planRetainedSdkDiagnostic(prepared.capsule, expected);
  const files = stageDiagnostic(prepared.capsule, expected, image, sources);
  // The new task harness is the current trusted source, copied once and pinned in
  // this plan. Old archived diagnostic probe is replaced explicitly, not reused as
  // a task launcher. There is no claim of long-term task-harness archival here.
  files.find(f => f.path === 'probe.cjs').bytes = fs.readFileSync(path.join(__dirname, 'scripted-task-container.cjs'));
  const inventory = manifestFor(files);
  const plan = planEvaluation({ caseId: request.flagId, checkpointHash: expected.checkpointChecksum,
    inputHash: prepared.capsuleHash, environmentHash: hash(JSON.stringify(image)),
    harnessHash: hash(JSON.stringify(inventory.files)), roleId: 'offline-diagnostic-role',
    baselineRoleHash: hash(roles.baseline), candidateRoleHash: hash(roles.candidate),
    model: { provider: 'caff-offline-scripted', id: 'tool-loop-v1', settingsHash: hash('fixed-write-read-edit-bash-v1;thinking-off;no-network') },
    evaluator: { id: 'file-sha256-v1', versionHash: hash(JSON.stringify({ version: 1, ...rule })) },
    repetitions, timeoutMs: 25000, perRunLimitMicroUsd: 1, totalLimitMicroUsd: repetitions * 2 });
  return { plan: clone(plan), async execute(value, runProbe) {
    const q = clone(value);
    assert.ok(exact(q, ['runId', 'planHash', 'variant', 'repetition', 'commonHash', 'roleHash', 'timeoutMs', 'perRunLimitMicroUsd', 'approvalId', 'expiresAt']));
    const row = plan.runs.find(r => r.runId === q.runId); assert.ok(row);
    for (const k of Object.keys(row)) assert.deepEqual(q[k], row[k]);
    assert.equal(q.planHash, plan.planHash); assert.equal(q.timeoutMs, plan.spec.timeoutMs); assert.equal(q.perRunLimitMicroUsd, 1);
    assert.ok(typeof q.approvalId === 'string' && q.approvalId.length > 0); gate(q.expiresAt);
    assert.equal(typeof runProbe, 'function', 'dedicated_transport_required');
    // Revalidate and protect EACH run, under the existing writer lock. Never trust
    // the old plan as permission, read live sources, silently fresh, or release pins.
    const current = prepareRetainedInitializationCapsule({ ...request, replayRunId: q.runId });
    assert.equal(current.capsuleHash, expected.capsuleHash); assert.equal(current.capsule, prepared.capsule);
    const task = { runId: q.runId, role: roles[q.variant], expiresAt: q.expiresAt,
      capsuleHash: expected.capsuleHash, deliveryMode: input.mode,
      invocationHash: hash(input.invocation), historyHash: hash(JSON.stringify(input.messages)) };
    const stage = files.map(f => ({ path: f.path, bytes: Buffer.from(f.bytes) }));
    stage.push({ path: 'task.json', bytes: Buffer.from(JSON.stringify(task)) });
    const manifest = manifestFor(stage); gate(q.expiresAt);
    const r = await runProbe(clone(image), stage);
    assert.ok(r && /^[a-f0-9]{64}$/.test(r.containerId));
    assert.equal(r.manifest?.inputHash, manifest.inputHash); assert.equal(r.manifest?.runtimeHash, manifest.runtimeHash);
    assert.ok(r.result && r.result.code === 0 && !r.result.failure && r.result.stderr === '');
    assert.ok(typeof r.result.stdout === 'string' && Buffer.byteLength(r.result.stdout) <= 16384);
    const receipt = JSON.parse(r.result.stdout);
    const { artifactBase64, ...observed } = receipt;
    assert.deepEqual(observed, { kind: 'scripted-sdk-task-v1', runId: q.runId, roleHash: q.roleHash,
      capsuleHash: task.capsuleHash, inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash,
      deliveryMode: task.deliveryMode, invocationHash: task.invocationHash, historyHash: task.historyHash,
      scriptCalls: 5, networkCalls: 0, toolNames: ['write', 'read', 'edit', 'bash'] });
    assert.ok(typeof artifactBase64 === 'string' && artifactBase64.length <= 5464);
    const bytes = Buffer.from(artifactBase64, 'base64');
    assert.ok(bytes.length <= 4096 && bytes.toString('base64') === artifactBase64);
    // Fixed non-executable host scorer. No rubric/expected bytes/previous outputs
    // enter the tested container. Raw artifact/receipt is not persisted or echoed.
    const outputHash = hash(bytes);
    return { runId: q.runId, status: 'completed', costMicroUsd: 0, outputHash,
      score: { expectationMet: outputHash === rule.expectedHash, badcaseReproduced: outputHash === rule.badcaseHash } };
  } };
}
module.exports = { prepareScriptedEvaluation };
