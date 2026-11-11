// Full v4 retained projection, independent of live evidence or model calls.
// Recompute both stages; publication/adoption must separately check current
// admission. Gate-only v4 and historical v1-v3 keep their original schemas.
import { validateWikiHoldoutFullExperimentPlan, decideWikiHoldoutFullExperiment } from './wiki-holdout-validation-plan';
import { projectWikiHoldoutResult } from './wiki-holdout-result';
import { projectWikiHoldoutScoredCases } from './wiki-holdout-scored-cases';
import { wikiExperimentRun } from './wiki-experiment-plan';
import { wikiValueHash } from './wiki-rubric';
const invalid = () => Object.assign(Error('wiki_comparison_invalid'), { code: 'wiki_comparison_invalid' });
function check(v: unknown): asserts v { if (!v) throw invalid(); }
const same = (a: any, b: any) => wikiValueHash(a) === wikiValueHash(b);
export function projectWikiHoldoutFullResult(input: any, totals: (cases: any[], repeats: number) => any): any {
  check(input?.kind === 'wiki-mode-holdout-comparison-v2' && typeof input.completed === 'boolean' && typeof input.callsUnavailable === 'boolean');
  const experiment = validateWikiHoldoutFullExperimentPlan(input.experiment), selection = experiment.validation;
  check(Array.isArray(input.cases) && input.cases.length === experiment.cases.length && input.cases.length <= 20);
  // Split is reporting of the frozen source group, NOT an evaluation role.
  // Gate membership is explicit in the plan; control source identity is bound
  // by the retained confirmation/case hash and rechecked at publication.
  const splits = input.cases.map((c: any, n: number) => {
    const selected = experiment.cases[n]; check(['gate', 'test'].includes(c.split));
    if (selected.stage === 'gate') check(c.split === selected.originalSplit);
    return c.split;
  });
  const evaluation = { kind: 'wikiskill-mode-holdout-v1', splitPolicy: 'mode-holdout-frozen-v1', targetEntryId: experiment.gate.targetEntryId,
    gateCaseIds: experiment.gate.caseIds.slice(), validationCaseIds: selection.caseIds.slice(), targetReproductionCaseIds: experiment.gate.caseIds.slice(),
    ignoredCaseIds: experiment.gate.cases.filter(c => !c.eligible).map(c => c.caseId), maxExtraAttemptsPerCase: 5 };
  const split = { policy: 'mode-holdout-frozen-v1', rows: experiment.cases.map((c, n) => ({ sourceCaseId: c.caseId, split: splits[n] })),
    gateCaseIds: experiment.gate.caseIds.slice(), validationCaseIds: selection.caseIds.slice() };
  check(same(input.evaluation, evaluation) && same(input.split, split));
  const stageTotals = (rows: any[], repeats: number) => totals(rows.map(c => c.stage === 'validation' ? { ...c, stage: 'gate' } : c), repeats);
  const cases = projectWikiHoldoutScoredCases(input.cases, experiment, splits, stageTotals);
  check(cases.every(c => c.status !== 'completed' || !c.callsUnavailable));
  const decision = decideWikiHoldoutFullExperiment(experiment, cases.map(c => ({ caseId: c.sourceCaseId, status: c.status, runs: c.runs.map(wikiExperimentRun) })));
  const completed = decision.gate.outcome === 'rejected' || decision.gate.outcome === 'accepted' && selection.budgetStatus === 'ready' && cases.every(c => c.status === 'completed');
  check(same(input.gateDecision, decision.gate) && same(input.validation, decision.validation) && input.outcome === decision.outcome
    && input.adoptionEligible === decision.adoptionEligible && input.completed === completed);
  const modelCallsKnown = cases.reduce((n, c) => n + c.modelCallsKnown, 0), callsUnavailable = cases.some(c => c.callsUnavailable);
  check(Number.isSafeInteger(modelCallsKnown) && input.modelCallsKnown === modelCallsKnown && input.callsUnavailable === callsUnavailable
    && (!input.adoptionEligible || !callsUnavailable));
  // Reuse v4 gate-only's envelope/candidate/config/scoring checks through a
  // private gate projection, never the historical gate/test decision. Its
  // reconstructed hash is not returned, persisted or execution permission.
  const { validation: _validation, cases: _cases, planHash: _hash, ...gateCommon } = experiment;
  const gateCases = cases.filter(c => c.stage === 'gate'), gatePayload = { ...gateCommon, cases: experiment.cases.filter(c => c.stage === 'gate') };
  const { validationCaseIds: _validationIds, ...gateEvaluation } = evaluation;
  const common = projectWikiHoldoutResult({ ...input, kind: 'wiki-mode-holdout-comparison-v1',
    experiment: { ...gatePayload, planHash: wikiValueHash(gatePayload) }, evaluation: { ...gateEvaluation, kind: 'wikiskill-holdout-gate-v1' },
    split: { policy: split.policy, rows: split.rows.slice(0, gateCases.length), gateCaseIds: split.gateCaseIds }, cases: gateCases,
    completed: decision.gate.outcome !== 'indeterminate' && gateCases.every(c => c.status === 'completed'),
    preparedReplayableCount: Math.min(input.preparedReplayableCount, gateCases.length), validation: { status: 'not-planned' }, adoptionEligible: false,
    modelCallsKnown: gateCases.reduce((n, c) => n + c.modelCallsKnown, 0), callsUnavailable: gateCases.some(c => c.callsUnavailable) }, totals);
  check(Number.isSafeInteger(input.preparedReplayableCount) && input.preparedReplayableCount >= 0 && input.preparedReplayableCount <= cases.length);
  return { ...common, kind: input.kind, evaluation, experiment, split, preparedReplayableCount: input.preparedReplayableCount, completed, cases,
    gateDecision: decision.gate, byStage: { gate: stageTotals(gateCases, 10), validation: stageTotals(cases.filter(c => c.stage === 'validation'), selection.policy.repeats) },
    outcome: decision.outcome, validation: decision.validation, adoptionEligible: decision.adoptionEligible, modelCallsKnown, callsUnavailable };
}
