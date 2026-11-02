// Synthetic digest declarations only; no case, model or SDK execution.
const hash = v => require('node:crypto').createHash('sha256').update(v).digest('hex');
function spec() { return { caseId: 'case-1', checkpointHash: hash('checkpoint'), inputHash: hash('input'), environmentHash: hash('env'), harnessHash: hash('harness'), roleId: 'offline-diagnostic-role', baselineRoleHash: hash('baseline'), candidateRoleHash: hash('candidate'), model: { provider: 'caff-offline-scripted', id: 'tool-loop-v1', settingsHash: hash('settings') }, evaluator: { id: 'file-sha256-v1', versionHash: hash('rule') }, repetitions: 1, timeoutMs: 25000, perRunLimitMicroUsd: 1, totalLimitMicroUsd: 2 }; }
module.exports = { spec, hash };
