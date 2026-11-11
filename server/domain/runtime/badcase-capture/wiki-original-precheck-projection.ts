// Read-only small-record projection. No frozen trace reads, Git restoration,
// runtime materialization, model calls or writes. Formal results are NOT input.
import { createWikiOriginalPrecheckPlan, validateWikiOriginalPrecheckRecord } from './wiki-original-precheck';
import { projectEvaluationGoalMarker } from './evaluation-goal-evidence';
const fail = () => Object.assign(Error('wiki_original_precheck_record_invalid'), { code: 'wiki_original_precheck_record_invalid' });
export function projectWikiOriginalPrechecks(state: any, records: any[], replayChecks: any[]) {
  let checked: ReturnType<typeof validateWikiOriginalPrecheckRecord>[];
  try {
    if (!Array.isArray(records)) throw fail();
    checked = records.map(r => validateWikiOriginalPrecheckRecord(r.reservation, r.result));
    if (new Set(checked.map(r => r.reservation.id)).size !== checked.length) throw fail();
  } catch { throw fail(); }
  checked.sort((a, b) => b.reservation.createdAt.localeCompare(a.reservation.createdAt) || a.reservation.id.localeCompare(b.reservation.id));
  return state.cases.map((source: any) => {
    const frozen = (state.rubrics || []).filter((r: any) => r.caseId === source.id && r.status === 'frozen')
      .sort((a: any, b: any) => b.version - a.version)[0];
    const history = checked.filter(r => r.reservation.plan.caseId === source.id).map(({ reservation, result }) => {
      const plan = reservation.plan, { kind, ...policy } = plan.policy;
      let current = false;
      if (frozen?.hash === plan.rubricHash && !plan.reportOnly) {
        try {
          // Reconstruct only the pure small identity/policy plan. Includes exact
          // split, current source/rubric, trace/scene or run decision/cut, cached
          // support and optional judge attestation. Never rebuild worker input.
          current = createWikiOriginalPrecheckPlan({ state, caseId: source.id, rubricHash: plan.rubricHash, inputHash: plan.inputHash,
            policy, replayChecks, ...(Object.hasOwn(plan, 'judge') ? { judge: plan.judge } : {}) }).planHash === plan.planHash;
        } catch { /* Valid history, but not the current eligible conditions. */ }
      }
      const goalExecutions = (result?.runs || []).flatMap((r: any) => {
        const marker = projectEvaluationGoalMarker(r);
        return Object.keys(marker).length ? [{ iteration: r.iteration, ...marker }] : [];
      });
      return { id: reservation.id, createdAt: reservation.createdAt, finishedAt: result?.finishedAt ?? null,
        planHash: plan.planHash, rubricHash: plan.rubricHash, rubricVersion: plan.rubricVersion, execution: structuredClone(plan.execution),
        policy: structuredClone(plan.policy), reportOnly: plan.reportOnly, current, status: result?.status ?? 'reserved', reason: result?.reason ?? null,
        summary: result ? structuredClone(result.summary) : null, ...(goalExecutions.length ? { goalExecutions } : {}) };
    });
    // Newest MATCHING execution supplies the whole denominator. A reserved,
    // stopped or error-only latest result never falls back to a favorable older
    // sample. Reports and stale identities remain explicitly separate history.
    const current = history.find(r => r.current) ?? null;
    return { caseId: source.id, status: current?.status ?? 'missing', current, history,
      reproduced: current?.summary?.reproduced === true, controlEligible: current?.summary?.controlEligible === true, notFormalStatistics: true };
  });
}
