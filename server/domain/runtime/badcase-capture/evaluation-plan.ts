// Internal, pure planning/accounting only. NO launcher, credentials, approval UI,
// filesystem, network or SDK. Hash declarations do not verify archived bytes.
// A trusted future coordinator must authenticate manual approval, persist before
// dispatch, and enforce per-request caps/timeouts at the model egress boundary.
import crypto from 'node:crypto';
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const exact = (v: any, keys: string[]) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
const hashValue = (v: any): string => crypto.createHash('sha256').update(canonical(v)).digest('hex');
function canonical(v: any): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
const digest = (v: any) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const identifier = (v: any) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(v);
const integer = (v: any, low: number, high: number) => Number.isSafeInteger(v) && v >= low && v <= high;
function fail(code: string): never { throw Object.assign(Error(code), { code }); }
const moneyMax = 1_000_000_000_000; // bounded integer micro-USD; sums of <=200 runs remain safe
export interface EvaluationSpec {
  caseId: string; checkpointHash: string; inputHash: string; environmentHash: string; harnessHash: string;
  roleId: string; baselineRoleHash: string; candidateRoleHash: string;
  model: { provider: string; id: string; settingsHash: string };
  evaluator: { id: string; versionHash: string };
  repetitions: number; timeoutMs: number; perRunLimitMicroUsd: number; totalLimitMicroUsd: number;
}
export function planEvaluation(value: unknown) {
  const s = value as EvaluationSpec;
  if (!exact(s, ['caseId', 'checkpointHash', 'inputHash', 'environmentHash', 'harnessHash', 'roleId', 'baselineRoleHash',
    'candidateRoleHash', 'model', 'evaluator', 'repetitions', 'timeoutMs', 'perRunLimitMicroUsd', 'totalLimitMicroUsd'])
    || !identifier(s.caseId) || !identifier(s.roleId)
    || ![s.checkpointHash, s.inputHash, s.environmentHash, s.harnessHash, s.baselineRoleHash, s.candidateRoleHash].every(digest)
    || !exact(s.model, ['provider', 'id', 'settingsHash']) || !identifier(s.model.provider) || !identifier(s.model.id) || !digest(s.model.settingsHash)
    || !exact(s.evaluator, ['id', 'versionHash']) || !identifier(s.evaluator.id) || !digest(s.evaluator.versionHash)
    || !integer(s.repetitions, 1, 100) || !integer(s.timeoutMs, 1, 3_600_000)
    || !integer(s.perRunLimitMicroUsd, 1, moneyMax) || !integer(s.totalLimitMicroUsd, s.perRunLimitMicroUsd, moneyMax)) fail('evaluation_plan_invalid');
  const spec = clone(s), planHash = hashValue({ schemaVersion: 1, spec });
  const { baselineRoleHash, candidateRoleHash, repetitions, totalLimitMicroUsd, ...common } = spec;
  const commonHash = hashValue(common);
  const runs = Array.from({ length: repetitions }, (_, i) => (['baseline', 'candidate'] as const).map(variant => ({
    runId: hashValue({ planHash, variant, repetition: i + 1 }), variant, repetition: i + 1, commonHash,
    roleHash: variant === 'baseline' ? baselineRoleHash : candidateRoleHash,
  }))).flat();
  return { schemaVersion: 1 as const, spec, planHash, commonHash, runs };
}
type Plan = ReturnType<typeof planEvaluation>;
interface Approval { confirmed: true; planHash: string; approvalId: string; expiresAt: number }
interface Result {
  runId: string; status: 'completed' | 'failed' | 'timed_out' | 'cancelled'; costMicroUsd: number | null;
  outputHash: string | null; score: { expectationMet: boolean; badcaseReproduced: boolean } | null;
}
type Row = Plan['runs'][number] & { status: 'reserved' | Result['status']; costMicroUsd: number | null;
  outputHash: string | null; score: Result['score'] };
export function createEvaluationLedger(value: Plan, approvalValue: unknown, now: number) {
  const plan = planEvaluation(value?.spec);
  if (canonical(value) !== canonical(plan)) fail('evaluation_plan_invalid');
  const a = approvalValue as Approval;
  if (!exact(a, ['confirmed', 'planHash', 'approvalId', 'expiresAt']) || a.confirmed !== true || a.planHash !== plan.planHash
    || !identifier(a.approvalId) || !integer(now, 0, Number.MAX_SAFE_INTEGER) || !integer(a.expiresAt, now + 1, Number.MAX_SAFE_INTEGER)) fail('evaluation_approval_invalid');
  const approval = clone(a), rows: Row[] = [];
  let active: Row | null = null, committed = 0, known = 0, unknown = 0, lastNow = now;
  let stopReason: string | null = null;
  return {
    reserve(at: number) {
      if (!integer(at, lastNow, Number.MAX_SAFE_INTEGER)) fail('evaluation_clock_invalid');
      lastNow = at;
      if (active) fail('evaluation_run_active');
      if (stopReason || rows.length === plan.runs.length) fail('evaluation_stopped');
      if (at >= approval.expiresAt) { stopReason = 'approval_expired'; return null; }
      const cap = plan.spec.perRunLimitMicroUsd;
      if (committed + cap > plan.spec.totalLimitMicroUsd) { stopReason = 'budget_exhausted'; return null; }
      active = { ...plan.runs[rows.length], status: 'reserved', costMicroUsd: null, outputHash: null, score: null };
      committed += cap; rows.push(active);
      // Reservation is NOT execution permission. Only a trusted coordinator with
      // durable approval and isolated launcher/egress may translate it to a run.
      return clone(active);
    },
    settle(value: unknown) {
      const r = value as Result;
      if (!active || !exact(r, ['runId', 'status', 'costMicroUsd', 'outputHash', 'score']) || r.runId !== active.runId
        || !['completed', 'failed', 'timed_out', 'cancelled'].includes(r.status)
        || !(r.costMicroUsd === null || integer(r.costMicroUsd, 0, moneyMax))
        || !(r.outputHash === null || digest(r.outputHash))) fail('evaluation_result_invalid');
      if (r.status === 'completed') {
        if (!digest(r.outputHash) || !exact(r.score, ['expectationMet', 'badcaseReproduced'])
          || typeof r.score?.expectationMet !== 'boolean' || typeof r.score?.badcaseReproduced !== 'boolean') fail('evaluation_result_invalid');
      } else if (r.score !== null) fail('evaluation_result_invalid');
      Object.assign(active, clone(r)); active = null;
      if (r.costMicroUsd === null) { unknown++; stopReason = 'cost_unknown'; }
      else {
        known += r.costMicroUsd;
        committed += r.costMicroUsd - plan.spec.perRunLimitMicroUsd;
        if (r.costMicroUsd > plan.spec.perRunLimitMicroUsd || committed > plan.spec.totalLimitMicroUsd) stopReason = 'cost_limit_exceeded';
      }
      if (!stopReason && r.status !== 'completed') stopReason = 'run_' + r.status;
    },
    report() {
      const summary = { baseline: { attempted: 0, scored: 0, reproduced: 0, expectationMet: 0 },
        candidate: { attempted: 0, scored: 0, reproduced: 0, expectationMet: 0 } };
      for (const r of rows) {
        if (r.status === 'reserved') continue;
        const s = summary[r.variant]; s.attempted++;
        if (r.score) { s.scored++; s.reproduced += Number(r.score.badcaseReproduced); s.expectationMet += Number(r.score.expectationMet); }
      }
      return clone({ schemaVersion: 1, planHash: plan.planHash, approvalId: approval.approvalId, spec: plan.spec,
        state: active ? 'reserved' : stopReason ? 'stopped' : rows.length === plan.runs.length ? 'complete' : 'ready',
        stopReason, plannedRuns: plan.runs.length, runs: rows, summary,
        knownCostMicroUsd: known, unknownCostRuns: unknown, committedMicroUsd: committed,
        // All inputs/results here are caller assertions. No persisted approval,
        // container observation, scorer verification or replay qualification yet.
        executionVerified: false, strictEvalEligible: false });
    },
  };
}
