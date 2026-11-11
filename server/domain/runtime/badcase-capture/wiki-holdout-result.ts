// V4 gate-only result projection. Retained data is allowlisted and checked
// without current prechecks/judge catalogs or any model calls. Publication must
// independently recheck current admission. A gate alone cannot enable adoption.
import { validateWikiHoldoutExperimentPlan, decideWikiHoldoutExperimentGate } from './wiki-holdout-plan';
import { wikiExperimentRun } from './wiki-experiment-plan';
import { projectWikiScoredCases } from './wiki-production-result-v2';
import { wikiValueHash } from './wiki-rubric';
import { projectEvaluationGoalMarker } from './evaluation-goal-evidence';
const invalid = () => Object.assign(Error('wiki_comparison_invalid'), { code: 'wiki_comparison_invalid' });
function check(v: unknown): asserts v { if (!v) throw invalid(); }
const same = (a: any, b: any) => wikiValueHash(a) === wikiValueHash(b);
const id = (v: any) => { check(typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)); return v; };
const digest = (v: any) => { check(typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)); return v; };
const count = (v: any) => { check(Number.isSafeInteger(v) && v >= 0); return v; };
const code = (v: any) => { check(typeof v === 'string' && /^[a-z_]{1,100}$/.test(v)); return v; };
const ids = (v: any): string[] => { check(Array.isArray(v) && v.length <= 1000); const a = v.map(id); check(new Set(a).size === a.length); return a; };
export function projectWikiHoldoutResult(input: any, totals: (cases: any[], repeats: number) => any): any {
  check(input?.kind === 'wiki-mode-holdout-comparison-v1' && input.scope === 'global' && input.model === 'openai-codex/gpt-6.1-sol' && input.repeats === 10);
  check(typeof input.completed === 'boolean' && typeof input.callsUnavailable === 'boolean' && input.adoptionEligible === false && same(input.validation, { status: 'not-planned' }));
  const experiment = validateWikiHoldoutExperimentPlan(input.experiment), targetEntryId = experiment.gate.targetEntryId;
  const modelConfig = { api: 'openai-codex-responses', thinking: 'xhigh', fast: false, transport: 'sse', credentialDelivery: 'host-only-mailbox' };
  check(same(input.modelConfig, modelConfig) && same(experiment.runner, { model: input.model, settings: modelConfig }));
  const evaluation = { kind: 'wikiskill-holdout-gate-v1', splitPolicy: 'mode-holdout-frozen-v1', targetEntryId,
    gateCaseIds: experiment.gate.caseIds.slice(), targetReproductionCaseIds: experiment.gate.caseIds.slice(),
    ignoredCaseIds: experiment.gate.cases.filter(c => !c.eligible).map(c => c.caseId), maxExtraAttemptsPerCase: 5 };
  check(same(input.evaluation, evaluation));
  const split = { policy: 'mode-holdout-frozen-v1', rows: experiment.cases.map(c => ({ sourceCaseId: c.caseId, split: c.originalSplit })), gateCaseIds: experiment.gate.caseIds.slice() };
  check(same(input.split, split) && Array.isArray(input.cases) && input.cases.length === experiment.cases.length && input.cases.length <= 20);
  const cases = input.cases.map((raw: any, n: number) => {
    const selection = experiment.cases[n];
    check(raw.sourceCaseId === selection.caseId && raw.stage === 'gate' && raw.split === selection.originalSplit && raw.category === 'reproduction'
      && raw.family === 'GPT' && raw.reportOnly === false && raw.targetReproduction === true
      && ['completed', 'error', 'unsupported', 'not-run'].includes(raw.status) && typeof raw.callsUnavailable === 'boolean');
    check(Array.isArray(raw.runs) && raw.runs.length <= 25 && (!['unsupported', 'not-run'].includes(raw.status) || raw.runs.length === 0));
    let classification;
    if (raw.classification !== undefined) {
      check(['manual', 'model-confirmed'].includes(raw.classification.source) && typeof raw.classification.confirmedAt === 'string' && Number.isFinite(Date.parse(raw.classification.confirmedAt)));
      classification = { entryId: raw.classification.entryId === null ? null : id(raw.classification.entryId), source: raw.classification.source, confirmedAt: raw.classification.confirmedAt };
    }
    check(!classification || classification.entryId === targetEntryId);
    const runs = raw.runs.map((r: any) => {
      check(['original', 'candidate'].includes(r.variant) && ['pass', 'fail', 'invalid', 'error'].includes(r.status));
      check(count(r.iteration) > 0);
      return { variant: r.variant, iteration: r.iteration, status: r.status, ...(r.reason === undefined ? {} : { reason: code(r.reason) }),
        replySource: ['public', 'internal', 'none'].includes(r.replySource) ? r.replySource : 'unknown', cleaned: r.cleaned === true, ...projectEvaluationGoalMarker(r) };
    });
    const run = selection.execution.level === 'run';
    check(run ? raw.replayId === null && same(raw.execution, selection.execution) : raw.execution === undefined && (typeof raw.replayId === 'string' || raw.replayId === null && ['unsupported', 'not-run'].includes(raw.status)));
    const comparison = raw.comparison ? Object.fromEntries(['checkpointId', 'checkpointHash', 'rulesHash', 'planHash'].filter(k => raw.comparison[k] !== undefined)
      .map(k => [k, k === 'checkpointId' ? id(raw.comparison[k]) : digest(raw.comparison[k])])) : null;
    const base = { sourceCaseId: selection.caseId, split: raw.split, stage: 'gate', category: 'reproduction', family: 'GPT', reportOnly: false, targetReproduction: true,
      ...(classification ? { classification } : {}), status: raw.status, replayId: raw.replayId === null ? null : id(raw.replayId), comparison,
      ...(raw.reason === undefined ? {} : { reason: code(raw.reason) }), runs, modelCallsKnown: count(raw.modelCallsKnown), callsUnavailable: raw.callsUnavailable };
    if (raw.rubric === undefined) {
      check(!runs.length && ['not-run', 'unsupported'].includes(raw.status) && raw.comparison === null && raw.hardAssertionIds === undefined);
      return { ...base, ...(run ? { execution: structuredClone(selection.execution) } : {}), totals: totals([base], 10) };
    }
    const scored = projectWikiScoredCases([base], [raw], experiment, totals)[0];
    return { ...scored, totals: totals([scored], 10) };
  });
  const gateDecision = decideWikiHoldoutExperimentGate(experiment, cases.map((c: any) => ({ caseId: c.sourceCaseId, status: c.status, runs: c.runs.map(wikiExperimentRun) })));
  check(same(input.gateDecision, gateDecision) && input.completed === (gateDecision.outcome !== 'indeterminate' && cases.every((c: any) => c.status === 'completed')));
  const candidate = input.candidate;
  check(candidate?.entryIds?.length === 1 && candidate.entryIds[0] === targetEntryId && same(experiment.variants,
    [{ id: 'original', promptHash: candidate.baseHash }, { id: 'candidate', promptHash: candidate.candidateHash }]));
  const disclosures = ids(input.disclosures);
  for (const d of ['literal_metrics_reference_only', 'small_sample', 'model_configuration_bound', 'non_gpt_sources_report_only']) check(disclosures.includes(d));
  check(!disclosures.includes('literal_rules_not_semantic_judgment'));
  const preparedReplayableCount = count(input.preparedReplayableCount); check(preparedReplayableCount <= cases.length);
  check(ids(input.additionalTrainingCaseIds).length === 0 && ids(input.excludedSplitTrainingCaseIds).length === 0);
  const modelCallsKnown = cases.reduce((n: number, c: any) => n + c.modelCallsKnown, 0), callsUnavailable = cases.some((c: any) => c.callsUnavailable);
  check(input.modelCallsKnown === modelCallsKnown && input.callsUnavailable === callsUnavailable);
  return { kind: input.kind, scope: 'global', evaluation, experiment, executionId: id(input.executionId), planHash: digest(input.planHash), configHash: digest(input.configHash),
    runtimeHash: input.runtimeHash === null ? null : digest(input.runtimeHash), model: input.model, modelConfig,
    candidate: { id: id(candidate.id), targetId: id(candidate.targetId), baseHash: digest(candidate.baseHash), candidateHash: digest(candidate.candidateHash), versionId: id(candidate.versionId), entryIds: ids(candidate.entryIds),
      ...(candidate.experienceHash === undefined ? {} : { experienceHash: digest(candidate.experienceHash) }) },
    repeats: 10, split, additionalTrainingCaseIds: [], excludedSplitTrainingCaseIds: [], wikiTrainingCount: count(input.wikiTrainingCount), preparedReplayableCount, disclosures,
    completed: input.completed, cases, gateDecision, byStage: { gate: totals(cases, 10) }, validation: { status: 'not-planned' }, adoptionEligible: false, modelCallsKnown, callsUnavailable };
}
