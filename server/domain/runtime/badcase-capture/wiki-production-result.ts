// Public production result projection. Full trajectories/replies/paths stay in
// the exclusive operator evidence file, never this page summary.
import { decideWikiGate } from './wiki-gate-policy';
import { containsSecretSentinel } from './secrets';
import { projectEvaluationGoalMarker } from './evaluation-goal-evidence';
const invalid = () => Object.assign(Error('wiki_comparison_invalid'), { code: 'wiki_comparison_invalid' });
function check(c: any): asserts c { if (!c) throw invalid(); }
const id = (s: any) => { check(typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s)); return s; };
const digest = (s: any) => { check(typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)); return s; };
const count = (n: any) => { check(Number.isSafeInteger(n) && n >= 0); return n; };
const code = (s: any) => { check(typeof s === 'string' && /^[a-z_]{1,100}$/.test(s)); return s; };
const ids = (a: any): string[] => { check(Array.isArray(a) && a.length <= 1000); const b = a.map(id); check(new Set(b).size === b.length); return b; };
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
export function projectProductionResult(input: any, totals: (cases: any[], repeats: number) => any,
  consumesErrorSlot: (run: any) => boolean = () => false): any {
  check(input?.kind === 'wiki-staged-batch-comparison-v1' && input.scope === 'global' && input.model === 'openai-codex/gpt-6.1-sol' && input.repeats === 10);
  check(typeof input.completed === 'boolean' && typeof input.callsUnavailable === 'boolean');
  const modelConfig = { api: 'openai-codex-responses', thinking: 'xhigh', fast: false, transport: 'sse', credentialDelivery: 'host-only-mailbox' };
  check(same(input.modelConfig, modelConfig));
  const e = input.evaluation;
  check(e?.kind === 'wikiskill-gate-v1' && e.splitPolicy === 'd15-frozen-v1' && e.maxExtraAttemptsPerCase === 5);
  const evaluation = { kind: e.kind, splitPolicy: e.splitPolicy, targetEntryId: id(e.targetEntryId),
    gateCaseIds: ids(e.gateCaseIds), testCaseIds: ids(e.testCaseIds), targetReproductionCaseIds: ids(e.targetReproductionCaseIds),
    targetTestReproductionCaseIds: ids(e.targetTestReproductionCaseIds), reportOnlyCaseIds: ids(e.reportOnlyCaseIds), maxExtraAttemptsPerCase: 5 };
  check(evaluation.targetReproductionCaseIds.length > 0 && evaluation.targetTestReproductionCaseIds.length > 0);
  const suite = [...evaluation.gateCaseIds, ...evaluation.testCaseIds]; check(new Set(suite).size === suite.length && suite.length <= 20);
  const split = { policy: 'd15-frozen-v1', caseIds: ids(input.split?.caseIds), gateCaseIds: ids(input.split?.gateCaseIds), testCaseIds: ids(input.split?.testCaseIds) };
  check(input.split?.policy === split.policy && same(split.gateCaseIds, evaluation.gateCaseIds) && same(split.testCaseIds, evaluation.testCaseIds));
  check(split.caseIds.length === suite.length && suite.every(x => split.caseIds.includes(x)));
  check(Array.isArray(input.cases) && input.cases.length === suite.length);
  const seen = new Set();
  const cases = input.cases.map((c: any) => {
    const sourceCaseId = id(c.sourceCaseId); check(suite.includes(sourceCaseId) && !seen.has(sourceCaseId)); seen.add(sourceCaseId);
    check(['train', 'gate', 'test'].includes(c.split) && ['gate', 'test'].includes(c.stage));
    check((c.stage === 'gate') === evaluation.gateCaseIds.includes(sourceCaseId));
    check(['reproduction', 'probe', 'control'].includes(c.category) && ['completed', 'error', 'unsupported', 'not-run'].includes(c.status));
    check(typeof c.reportOnly === 'boolean' && c.reportOnly === evaluation.reportOnlyCaseIds.includes(sourceCaseId));
    const family = c.family === null ? null : id(c.family); check(c.reportOnly === (family !== 'GPT'));
    const targetReproduction = c.stage === 'gate' ? evaluation.targetReproductionCaseIds.includes(sourceCaseId) : evaluation.targetTestReproductionCaseIds.includes(sourceCaseId);
    check(c.targetReproduction === targetReproduction && (!targetReproduction || c.category === 'reproduction' && !c.reportOnly));
    let classification;
    if (c.classification !== undefined) {
      check(['manual', 'model-confirmed'].includes(c.classification.source));
      const at = c.classification.confirmedAt; check(typeof at === 'string' && Number.isFinite(Date.parse(at)));
      classification = { entryId: c.classification.entryId === null ? null : id(c.classification.entryId), source: c.classification.source, confirmedAt: at };
    }
    let topicExemption;
    if (c.topicExemption !== undefined) {
      const v = c.topicExemption;
      check(v && Object.keys(v).sort().join(',') === 'patterns,reason,taskHash' && c.category === 'reproduction' && !c.reportOnly);
      const patterns = ids(v.patterns); check(patterns.length > 0 && patterns.length <= 3 && patterns.every(p => ['priority-code', 'adr-number', 'acceptance-decision-code'].includes(p)));
      check(typeof v.reason === 'string' && v.reason.trim() && !v.reason.includes('\0') && Buffer.byteLength(v.reason) <= 2048 && !containsSecretSentinel(v.reason));
      topicExemption = { patterns, taskHash: digest(v.taskHash), reason: v.reason };
    }
    check(Array.isArray(c.runs) && c.runs.length <= 25 && typeof c.callsUnavailable === 'boolean');
    const attempts: any = { original: 0, candidate: 0 }, scored: any = { original: 0, candidate: 0 }, slots: any = { original: 0, candidate: 0 }; let next = 'original';
    const runs = c.runs.map((r: any) => {
      check(['original', 'candidate'].includes(r.variant) && ['pass', 'fail', 'error'].includes(r.status));
      if (slots[next] === 10) next = next === 'original' ? 'candidate' : 'original';
      check(r.variant === next); next = next === 'original' ? 'candidate' : 'original';
      check(r.iteration === ++attempts[r.variant] && slots[r.variant] < 10);
      if (r.status !== 'error') scored[r.variant]++;
      // V1 keeps its historical valid-count schedule. Only V2 opts into a
      // terminal judge-error slot, with its assessment validated separately.
      if (r.status !== 'error' || consumesErrorSlot(r)) slots[r.variant]++;
      return { variant: r.variant, iteration: r.iteration, status: r.status, ...(r.reason === undefined ? {} : { reason: code(r.reason) }),
        replySource: ['public', 'internal', 'none'].includes(r.replySource) ? r.replySource : 'unknown', cleaned: r.cleaned === true,
        ...projectEvaluationGoalMarker(r) };
    });
    check(c.status !== 'completed' || scored.original === 10 && scored.candidate === 10);
    check(!['unsupported', 'not-run'].includes(c.status) || runs.length === 0);
    if (c.reportOnly) check(c.status === 'not-run' && c.reason === 'non_gpt_source_report_only' && c.modelCallsKnown === 0 && !c.callsUnavailable);
    const comparison = c.comparison ? Object.fromEntries(['checkpointId', 'checkpointHash', 'rulesHash', 'planHash'].filter(k => c.comparison[k] !== undefined)
      .map(k => [k, k === 'checkpointId' ? id(c.comparison[k]) : digest(c.comparison[k])])) : null;
    const record = { sourceCaseId, split: c.split, stage: c.stage, category: c.category, family, reportOnly: c.reportOnly, targetReproduction,
      ...(classification ? { classification } : {}), ...(topicExemption ? { topicExemption } : {}), status: c.status, replayId: c.replayId ? id(c.replayId) : null, comparison,
      ...(c.reason === undefined ? {} : { reason: code(c.reason) }), runs, modelCallsKnown: count(c.modelCallsKnown), callsUnavailable: c.callsUnavailable };
    return { ...record, totals: totals([record], 10) };
  });
  check(evaluation.targetReproductionCaseIds.every(x => cases.some((c: any) => c.sourceCaseId === x && c.targetReproduction && c.stage === 'gate')));
  check(evaluation.targetTestReproductionCaseIds.every(x => cases.some((c: any) => c.sourceCaseId === x && c.targetReproduction && c.stage === 'test')));
  check(evaluation.reportOnlyCaseIds.every(x => cases.some((c: any) => c.sourceCaseId === x && c.reportOnly)));
  const gateDecision = decideWikiGate(cases, evaluation.targetReproductionCaseIds, 10); check(same(input.gateDecision, gateDecision));
  if (gateDecision.outcome !== 'accepted') check(cases.filter((c: any) => c.stage === 'test' && !c.reportOnly).every((c: any) => c.status === 'not-run' && c.reason === 'gate_' + gateDecision.outcome));
  check(input.completed === (gateDecision.outcome !== 'indeterminate' && cases.filter((c: any) => !c.reportOnly && (c.stage === 'gate' || gateDecision.outcome === 'accepted')).every((c: any) => c.status === 'completed')));
  const modelCallsKnown = cases.reduce((n: number, c: any) => n + c.modelCallsKnown, 0), callsUnavailable = cases.some((c: any) => c.callsUnavailable);
  check(input.modelCallsKnown === modelCallsKnown && input.callsUnavailable === callsUnavailable);
  const candidate = input.candidate; check(candidate?.entryIds?.length === 1 && candidate.entryIds[0] === evaluation.targetEntryId);
  const disclosures = ids(input.disclosures);
  for (const d of ['literal_rules_not_semantic_judgment', 'small_sample', 'model_configuration_bound', 'non_gpt_sources_report_only']) check(disclosures.includes(d));
  const preparedReplayableCount = count(input.preparedReplayableCount); check(preparedReplayableCount <= cases.filter((c: any) => !c.reportOnly).length);
  check(ids(input.additionalTrainingCaseIds).length === 0 && ids(input.excludedSplitTrainingCaseIds).length === 0);
  return { kind: input.kind, scope: 'global', evaluation, executionId: id(input.executionId), planHash: digest(input.planHash), configHash: digest(input.configHash),
    runtimeHash: input.runtimeHash === null ? null : digest(input.runtimeHash), model: input.model, modelConfig,
    candidate: { id: id(candidate.id), targetId: id(candidate.targetId), baseHash: digest(candidate.baseHash), candidateHash: digest(candidate.candidateHash), versionId: id(candidate.versionId), entryIds: ids(candidate.entryIds), ...(candidate.experienceHash === undefined ? {} : { experienceHash: digest(candidate.experienceHash) }) },
    repeats: 10, split, additionalTrainingCaseIds: ids(input.additionalTrainingCaseIds), excludedSplitTrainingCaseIds: ids(input.excludedSplitTrainingCaseIds),
    wikiTrainingCount: count(input.wikiTrainingCount), preparedReplayableCount, disclosures, completed: input.completed, cases, gateDecision,
    byStage: Object.fromEntries(['gate', 'test'].map(s => [s, totals(cases.filter((c: any) => c.stage === s), 10)])), modelCallsKnown, callsUnavailable };
}
