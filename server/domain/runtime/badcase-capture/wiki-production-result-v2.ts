// V2 only: preserve immutable rubric snapshots and checked judgments. The v1
// structural/gate validator remains unchanged for historical comparison hashes.
import { projectProductionResult } from './wiki-production-result';
import { validateWikiExperimentPlan, decideWikiExperimentGate } from './wiki-experiment-plan';
import { validateWikiRubric, wikiValueHash } from './wiki-rubric';
import { projectWikiAssessment, projectWikiScoringSummary } from './wiki-comparison-scoring';
const invalid = () => Object.assign(Error('wiki_comparison_invalid'), { code: 'wiki_comparison_invalid' });
function check(v: unknown): asserts v { if (!v) throw invalid(); }
const same = (a: unknown, b: unknown) => wikiValueHash(a) === wikiValueHash(b);
export function projectProductionResultV2(input: any, totals: (cases: any[], repeats: number) => any): any {
  check(input?.kind === 'wiki-staged-batch-comparison-v2' && Array.isArray(input.disclosures)
    && input.disclosures.includes('literal_metrics_reference_only') && !input.disclosures.includes('literal_rules_not_semantic_judgment'));
  // Reuse only v1's non-scoring structure checks/formula, never its literal
  // experience generation or pass/fail logic. Nothing here calls a judge.
  const base = projectProductionResult({ ...input, kind: 'wiki-staged-batch-comparison-v1',
    disclosures: [...input.disclosures.filter((s: string) => s !== 'literal_metrics_reference_only'), 'literal_rules_not_semantic_judgment'] }, totals);
  const experiment = validateWikiExperimentPlan(input.experiment);
  check(same(experiment.runner, { model: base.model, settings: base.modelConfig }) && same(experiment.variants,
    [{ id: 'original', promptHash: base.candidate.baseHash }, { id: 'candidate', promptHash: base.candidate.candidateHash }]));
  check(experiment.cases.length === base.cases.filter((c: any) => !c.reportOnly).length);
  const cases = base.cases.map((c: any, i: number) => {
    const raw = input.cases[i]; check(raw.topicExemption === undefined);
    if (c.reportOnly) { check(raw.rubric === undefined && raw.runs.length === 0); return c; }
    const selection = experiment.cases.find(p => p.caseId === c.sourceCaseId);
    check(selection && ['stage', 'category', 'targetReproduction'].every(k => (selection as any)[k] === c[k]));
    const hardAssertionIds = raw.hardAssertionIds;
    check(Array.isArray(hardAssertionIds) && hardAssertionIds.length <= 128 && new Set(hardAssertionIds).size === hardAssertionIds.length
      && hardAssertionIds.every((id: any) => typeof id === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) && !['completed', 'publicReply'].includes(id)));
    const rubric = validateWikiRubric(raw.rubric, true); check(rubric.caseId === c.sourceCaseId && rubric.hash === selection.rubricHash);
    check(raw.comparison && c.comparison);
    const scoring = projectWikiScoringSummary(raw.comparison.scoring, rubric, selection.judge); check(scoring.inputHash === selection.inputHash);
    const comparison = { ...c.comparison, ...(raw.comparison.commonInputHash === undefined ? {} : { commonInputHash: raw.comparison.commonInputHash }), scoring };
    if (comparison.commonInputHash !== undefined) check(typeof comparison.commonInputHash === 'string' && /^[a-f0-9]{64}$/.test(comparison.commonInputHash));
    const runs = c.runs.map((row: any, n: number) => {
      const assessment = raw.runs[n].assessment;
      if (assessment === undefined) {
        check(row.status === 'error' || row.status === 'fail' && ['model_timeout', 'model_turn_failed'].includes(row.reason));
        return row;
      }
      const projected = projectWikiAssessment(assessment, rubric, selection.judge, hardAssertionIds);
      check(row.cleaned && row.status === projected.status && (row.reason ?? null) === projected.reason);
      return { ...row, assessment: projected };
    });
    return { ...c, comparison, runs, rubric, hardAssertionIds: [...hardAssertionIds] };
  });
  const gate = decideWikiExperimentGate(experiment, cases.filter((c: any) => !c.reportOnly).map((c: any) => ({ caseId: c.sourceCaseId, status: c.status,
    runs: c.runs.map((r: any) => ({ variant: r.variant, iteration: r.iteration, status: r.status })) })));
  check(same(gate, base.gateDecision));
  return { ...base, kind: input.kind, disclosures: structuredClone(input.disclosures), experiment, cases };
}
