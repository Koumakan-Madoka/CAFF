// V2 only: preserve immutable rubric snapshots and checked judgments. Default
// v1 validation/projection behavior stays unchanged for historical hashes.
import { projectProductionResult } from './wiki-production-result';
import { validateWikiExperimentPlan, decideWikiExperimentGate, wikiExperimentRun, wikiExperimentRunSceneHash } from './wiki-experiment-plan';
import { validateWikiRubric, wikiValueHash, wikiExactKeys } from './wiki-rubric';
import { projectWikiAssessment, projectWikiTraceAssessment, projectWikiScoringSummary } from './wiki-comparison-scoring';
import { isWikiJudgeTechnicalError } from './wiki-scoring-v2';
import { projectWikiRunCheckAssessment } from './wiki-run-check-projection';
const invalid = () => Object.assign(Error('wiki_comparison_invalid'), { code: 'wiki_comparison_invalid' });
function check(v: unknown): asserts v { if (!v) throw invalid(); }
const same = (a: unknown, b: unknown) => wikiValueHash(a) === wikiValueHash(b);
const digest = (v: any) => { check(typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)); return v; };
function projectRunUsage(v: any) {
  wikiExactKeys(v, ['knownCalls', 'callsWithoutUsage', 'callsUnavailable', 'knownTokens', 'complete', ...(v.overflow === undefined ? [] : ['overflow'])]);
  check([v.knownCalls, v.callsWithoutUsage].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1) && v.knownCalls + v.callsWithoutUsage <= 1);
  check(typeof v.callsUnavailable === 'boolean' && typeof v.complete === 'boolean' && (v.overflow === undefined || v.overflow === true));
  if (v.knownTokens !== null) {
    wikiExactKeys(v.knownTokens, ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']);
    check(Object.values(v.knownTokens).every(n => Number.isSafeInteger(n) && (n as number) >= 0));
  }
  check(!v.complete || v.knownCalls === 1 && v.callsWithoutUsage === 0 && !v.callsUnavailable && v.knownTokens !== null);
  return structuredClone(v);
}
export function projectProductionResultV2(input: any, totals: (cases: any[], repeats: number) => any): any {
  check(input?.kind === 'wiki-staged-batch-comparison-v2' && Array.isArray(input.disclosures)
    && input.disclosures.includes('literal_metrics_reference_only') && !input.disclosures.includes('literal_rules_not_semantic_judgment'));
  // Reuse only v1's non-scoring structure checks/formula, never its literal
  // experience generation or pass/fail logic. Nothing here calls a judge.
  const experiment = validateWikiExperimentPlan(input.experiment), mixed = experiment.kind === 'wiki-experiment-plan-v3';
  // Adapt invalid attempts to non-scoring errors ONLY for legacy structural
  // validation. Restore and validate the real run statuses below. No stored
  // result or original plan is rewritten, and the gate formula is unchanged.
  const structured = experiment.cases.some(c => c.traceToolCheck === 'structured-v1');
  const { byLevel: _report, ...pooledGate } = input.gateDecision;
  const base = projectProductionResult({ ...input, kind: 'wiki-staged-batch-comparison-v1',
    ...(mixed ? { gateDecision: pooledGate } : {}),
    ...(mixed || structured ? { cases: input.cases.map((c: any) => ({ ...c,
      runs: c.runs.map((r: any) => {
        const selection = experiment.cases.find(p => p.caseId === c.sourceCaseId);
        return r.status === 'invalid' && (selection?.execution?.level === 'run' || selection?.traceToolCheck === 'structured-v1')
          ? { ...r, status: 'error' } : r;
      }) })) } : {}),
    disclosures: [...input.disclosures.filter((s: string) => s !== 'literal_metrics_reference_only'), 'literal_rules_not_semantic_judgment'] }, totals,
    row => row.status === 'error' && isWikiJudgeTechnicalError(row.assessment));
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
    const run = selection.execution?.level === 'run', traceTool = selection.traceToolCheck === 'structured-v1';
    check(!traceTool || !run && rubric.toolCheck);
    if (run) {
      check(same(raw.execution, selection.execution) && c.replayId === null && hardAssertionIds.length === 0
        && rubric.questions.every(q => q.evidence === 'reply')
        && selection.hardAssertionsHash === wikiValueHash({ kind: 'completion-public-reply-v1' })
        && selection.sceneHash === wikiExperimentRunSceneHash(selection.execution as any));
      wikiExactKeys(raw.comparison, ['kind', 'execution', 'originalRequestHash', 'candidateRequestHash', 'commonInputHash', 'scoring']);
      check(raw.comparison.kind === 'wikiskill-run-comparison-v1' && same(raw.comparison.execution, selection.execution)
        && raw.comparison.originalRequestHash === (selection.execution as any).requestHash);
      digest(raw.comparison.candidateRequestHash);
      check(raw.comparison.commonInputHash === wikiValueHash({ originalRequestHash: raw.comparison.originalRequestHash, candidateRequestHash: raw.comparison.candidateRequestHash }));
    } else check(raw.execution === undefined && (rubric.questions.length > 0 || traceTool));
    check(raw.comparison && c.comparison);
    const scoring = projectWikiScoringSummary(raw.comparison.scoring, rubric, selection.judge); check(scoring.inputHash === selection.inputHash);
    const comparison = { ...(run ? { kind: raw.comparison.kind, execution: structuredClone(raw.execution),
      originalRequestHash: raw.comparison.originalRequestHash, candidateRequestHash: raw.comparison.candidateRequestHash } : c.comparison),
      ...(raw.comparison.commonInputHash === undefined ? {} : { commonInputHash: raw.comparison.commonInputHash }), scoring };
    if (comparison.commonInputHash !== undefined) check(typeof comparison.commonInputHash === 'string' && /^[a-f0-9]{64}$/.test(comparison.commonInputHash));
    const runs = c.runs.map((baseRow: any, n: number) => {
      const original = raw.runs[n], assessment = original.assessment;
      const row = run ? { ...baseRow, status: original.status, runReplayId: digest(original.runReplayId), requestHash: digest(original.requestHash),
        toolExecutions: 0, durationMs: original.durationMs, tokenUsage: projectRunUsage(original.tokenUsage) }
        : traceTool ? { ...baseRow, status: original.status } : baseRow;
      if (run) {
        check(original.toolExecutions === 0 && Number.isSafeInteger(row.durationMs) && row.durationMs >= 0
          && row.requestHash === comparison[row.variant + 'RequestHash']);
        if (rubric.toolCheck) {
          if (original.checks === undefined) { check(row.status === 'error' && assessment === undefined); return row; }
          check(row.cleaned && (rubric.questions.length > 0 || assessment === undefined));
          const projected = assessment === undefined ? undefined : projectWikiAssessment(assessment, rubric, selection.judge!, hardAssertionIds);
          const checks = projectWikiRunCheckAssessment(original.checks, rubric, projected);
          check(row.status === checks.status && (row.reason ?? null) === checks.reason);
          return { ...row, checks, ...(projected ? { assessment: projected } : {}) };
        }
        if (row.status === 'invalid') {
          check(assessment === undefined && row.replySource === 'none' && ['empty_reply', 'other_tool_requested'].includes(row.reason));
          return row;
        }
      }
      if (assessment === undefined) {
        check(row.status === 'error' || !run && row.status === 'fail' && ['model_timeout', 'model_turn_failed'].includes(row.reason));
        return row;
      }
      const projected = traceTool ? projectWikiTraceAssessment(assessment, rubric, selection.judge, hardAssertionIds)
        : projectWikiAssessment(assessment, rubric, selection.judge!, hardAssertionIds);
      check(row.cleaned && row.status === projected.status && (row.reason ?? null) === projected.reason);
      return { ...row, assessment: projected };
    });
    const result = { ...c, ...(run ? { execution: structuredClone(raw.execution) } : {}), comparison, runs, rubric, hardAssertionIds: [...hardAssertionIds] };
    return run || traceTool ? { ...result, totals: totals([result], 10) } : result;
  });
  const gate = decideWikiExperimentGate(experiment, cases.filter((c: any) => !c.reportOnly).map((c: any) => ({ caseId: c.sourceCaseId, status: c.status,
    runs: c.runs.map(wikiExperimentRun) })));
  check(same(gate, mixed ? input.gateDecision : base.gateDecision));
  return { ...base, kind: input.kind, disclosures: structuredClone(input.disclosures), experiment, cases,
    ...(mixed || structured ? { gateDecision: gate, byStage: Object.fromEntries(['gate', 'test'].map(s => [s, totals(cases.filter((c: any) => c.stage === s), 10)])) } : {}) };
}
