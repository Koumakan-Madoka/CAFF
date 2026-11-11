// Pure receipt validation/projection. No DB, model, shell or historical input.
import crypto from 'node:crypto';
const fail = () => Object.assign(Error('evaluation_goal_evidence_invalid'), { code: 'evaluation_goal_evidence_invalid' });
const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
const hash = (v: any) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const uuid = (v: any) => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export function validateEvaluationGoalEvidence(v: any): any {
  if (!object(v) || v.kind !== 'evaluation-goal-evidence-v1' || !uuid(v.executionId)
    || !['approximate-minimal-v1', 'unseeded'].includes(v.goalState) || v.seedHash !== hash(v.seed)
    || (v.goalState === 'unseeded' ? v.seed !== null : !object(v.seed) || v.seed.status !== 'active' || v.seed.revision !== 1
      || typeof v.seed.goalId !== 'string' || !v.seed.goalId.startsWith('goal_') || !v.seed.owner?.agentId
      || v.seed.acceptanceCriteria?.length !== 1 || v.seed.acceptanceCriteria[0].status !== 'pending'
      || v.seed.workItems?.length !== 1 || v.seed.workItems[0].status !== 'todo' || v.seed.evidence?.length !== 0)
    || !Array.isArray(v.calls) || v.calls.length > 128) throw fail();
  for (const [i, c] of v.calls.entries()) {
    if (!object(c) || c.executionId !== v.executionId || c.sequence !== i + 1
      || !['context', 'participants', 'post-message', 'goal/suggest', 'goal/update'].includes(c.endpoint)
      || (c.redacted === true ? c.parameters !== null : !object(c.parameters))
      || !Number.isInteger(c.statusCode) || c.statusCode < 200 || c.statusCode > 599 || !object(c.response)
      || c.errorCode !== (c.statusCode >= 400 ? c.response.code ?? null : null)
      || c.parameters && (Object.hasOwn(c.parameters, 'invocationId') || Object.hasOwn(c.parameters, 'callbackToken'))) throw fail();
  }
  return structuredClone(v);
}
export function projectEvaluationGoalMarker(v: any): any {
  if (v.goalState === undefined && v.goalSeedHash === undefined && v.goalExecutionId === undefined) return {};
  if (!['approximate-minimal-v1', 'unseeded'].includes(v.goalState) || !uuid(v.goalExecutionId)
    || typeof v.goalSeedHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.goalSeedHash)) throw fail();
  return { goalState: v.goalState, goalSeedHash: v.goalSeedHash, goalExecutionId: v.goalExecutionId };
}
export function evaluationGoalMarker(evidence: any): any {
  const v = validateEvaluationGoalEvidence(evidence);
  return { goalState: v.goalState, goalSeedHash: v.seedHash, goalExecutionId: v.executionId };
}
