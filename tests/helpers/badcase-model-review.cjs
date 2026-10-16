// Synthetic declarations only, never a supplier configuration or paid permission.
const crypto = require('node:crypto');
const { modelBinding } = require('../../build/server/domain/runtime/badcase-capture/model-binding');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
function entry(projectId = 'synthetic-project', id = 'synthetic-entry') {
  const config = { settings: { provider: 'synthetic', model: 'fixed-model', contextWindowTokens: 1000, maxOutputTokens: 100,
    temperature: 0, inputMicroUsdPerMillionTokens: 1000000, outputMicroUsdPerMillionTokens: 2000000, maxRequestBytes: 4096, maxResponseBytes: 4096 },
    endpoint: { hostname: 'api.caff-test.example', address: '93.184.216.34', path: '/v1/chat/completions', maxRequestBytes: 4096, maxResponseBytes: 4096, timeoutMs: 1000 }, maxRequests: 2 };
  const spec = { caseId: 'synthetic-case', checkpointHash: hash('checkpoint'), inputHash: hash('input'), environmentHash: hash('environment'), harnessHash: hash('harness'),
    roleId: 'synthetic-role', baselineRoleHash: hash('baseline'), candidateRoleHash: hash('candidate'),
    model: { provider: 'synthetic', id: 'fixed-model', settingsHash: modelBinding(config).bindingHash },
    evaluator: { id: 'synthetic-score', versionHash: hash('score') }, repetitions: 1, timeoutMs: 5000, perRunLimitMicroUsd: 2400, totalLimitMicroUsd: 4800 };
  return { projectId, id, spec, config };
}
const confirm = p => ({ confirmed: true, approvalId: p.approvalId, planHash: p.plan.planHash, bindingHash: p.binding.bindingHash });
module.exports = { entry, hash, confirm };
