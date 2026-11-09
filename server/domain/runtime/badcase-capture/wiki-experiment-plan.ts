// Experiment-owned choices and immutable bindings, separate from case storage
// and execution. D7 delegates to the existing gate formula, never a new metric.
import { decideWikiGate } from './wiki-gate-policy';
import { containsSecretSentinel } from './secrets';
import { assertWikiEligibleConfiguration, readWikiEligibleJudges } from './wiki-judge-catalog';
import { bindWikiJudge, isWikiJudgeTechnicalError, type WikiJudgeBinding, type WikiJudgeConfiguration, type WikiScoreStatus } from './wiki-scoring-v2';
import { validateWikiRubric, wikiExactKeys, wikiRubricFail as fail, wikiRubricSourceHash, wikiRubricText, wikiValueHash, type WikiRubric } from './wiki-rubric';
const POLICY = Object.freeze({ kind: 'wikiskill-gate-v1', alpha: .05, noHarmFraction: .05, minimumAllowedLoss: 1, maxExtraAttemptsPerCase: 5 });
interface WikiExperimentSelection { caseId: string; stage: 'gate' | 'test'; category: 'reproduction' | 'control' | 'probe'; targetReproduction: boolean; judge?: WikiJudgeConfiguration | null }
export type WikiExperimentExecution = { level: 'trace' } | {
  level: 'run'; traceBundleHash: string; dehydrationHash: string; requestHash: string;
};
export interface WikiExperimentCase {
  id: string; sceneHash: string; task: string; actual: string; expected: string; hardAssertions: unknown; rubric: WikiRubric;
  execution?: Exclude<WikiExperimentExecution, { level: 'trace' }>;
}
export interface WikiExperimentDefinition {
  kind: 'wiki-experiment-v1' | 'wiki-experiment-v2'; variants: { id: 'original' | 'candidate'; promptHash: string }[];
  runner: { model: string; settings: Record<string, string | number | boolean | null> };
  repeats: 10; executionPolicy: 'alternating-valid-v1'; decision: typeof POLICY;
  judge?: WikiJudgeConfiguration; cases: WikiExperimentSelection[];
}
export interface WikiExperimentPlan {
  kind: 'wiki-experiment-plan-v1' | 'wiki-experiment-plan-v2' | 'wiki-experiment-plan-v3'; variants: WikiExperimentDefinition['variants']; runner: WikiExperimentDefinition['runner'];
  repeats: 10; executionPolicy: 'alternating-valid-v1'; decision: typeof POLICY;
  cases: (Omit<WikiExperimentSelection, 'judge'> & { sceneHash: string; inputHash: string; hardAssertionsHash: string; rubricHash: string; judge: WikiJudgeBinding | null; execution?: WikiExperimentExecution })[];
  planHash: string;
}
export interface WikiExperimentCaseResult {
  caseId: string; status: 'completed' | 'error' | 'not-run' | 'unsupported';
  runs: { variant: 'original' | 'candidate'; iteration: number; status: WikiScoreStatus | 'invalid'; judgeError?: true }[];
}
// Execution derives this signal from the score; immutable publication first
// validates that score. No reply, candidate label or provider details enter it.
export function wikiExperimentRun(row: any): WikiExperimentCaseResult['runs'][number] {
  return { variant: row.variant, iteration: row.iteration, status: row.status,
    ...(row.status === 'error' && isWikiJudgeTechnicalError(row.assessment) ? { judgeError: true as const } : {}) };
}
function ensure(condition: unknown): asserts condition { if (!condition) throw fail('wiki_experiment_invalid'); }
function identifier(value: unknown) { ensure(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)); }
function safeJson(value: unknown, cap: number) {
  wikiValueHash(value);
  const text = JSON.stringify(value); ensure(Buffer.byteLength(text) <= cap && !containsSecretSentinel(text));
}
// Scene compatibility field for a no-scene run: bind the frozen packet and
// decision, not a fictitious checkpoint. The exact original prefix request is
// bound separately (and includes tool definitions, model and settings).
export function wikiExperimentRunSceneHash(execution: Exclude<WikiExperimentExecution, { level: 'trace' }>): string {
  wikiExactKeys(execution, ['level', 'traceBundleHash', 'dehydrationHash', 'requestHash']);
  ensure(execution.level === 'run');
  for (const key of ['traceBundleHash', 'dehydrationHash', 'requestHash'] as const) ensure(typeof execution[key] === 'string' && /^[a-f0-9]{64}$/.test(execution[key]));
  return wikiValueHash({ kind: 'wikiskill-run-scene-v1', traceBundleHash: execution.traceBundleHash, dehydrationHash: execution.dehydrationHash });
}
function checkExecutionPartitions(cases: WikiExperimentPlan['cases']) {
  if (cases.some(c => c.execution?.level === 'run' && c.stage === 'test')) throw fail('wiki_experiment_run_test_unsupported');
  const gate = cases.filter(c => c.stage === 'gate');
  if (gate.filter(c => c.execution?.level === 'run').length > gate.filter(c => c.execution?.level !== 'run').length) throw fail('wiki_experiment_run_gate_quota');
}
export function createWikiExperimentPlan(definition: WikiExperimentDefinition, catalog: WikiExperimentCase[]): WikiExperimentPlan {
  const perCase = definition?.kind === 'wiki-experiment-v2';
  wikiExactKeys(definition, ['kind', 'variants', 'runner', 'repeats', 'executionPolicy', 'decision', ...(!perCase ? ['judge'] : []), 'cases']);
  ensure(['wiki-experiment-v1', 'wiki-experiment-v2'].includes(definition.kind) && definition.repeats === 10 && definition.executionPolicy === 'alternating-valid-v1'
    && wikiValueHash(definition.decision) === wikiValueHash(POLICY));
  ensure(Array.isArray(definition.variants) && definition.variants.length === 2);
  for (const [i, v] of definition.variants.entries()) {
    wikiExactKeys(v, ['id', 'promptHash']); ensure(v.id === (i === 0 ? 'original' : 'candidate') && /^[a-f0-9]{64}$/.test(v.promptHash));
  }
  wikiExactKeys(definition.runner, ['model', 'settings']); wikiRubricText(definition.runner.model, 256); safeJson(definition.runner, 8192);
  ensure(definition.runner.settings && typeof definition.runner.settings === 'object' && !Array.isArray(definition.runner.settings));
  for (const [k, v] of Object.entries(definition.runner.settings)) {
    ensure(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(k) && !/^(?:key|apiKey|authorization|password|credential|secret)$/i.test(k)
      && (v === null || ['string', 'boolean'].includes(typeof v) || typeof v === 'number' && Number.isFinite(v)));
  }
  ensure(Array.isArray(catalog) && new Set(catalog.map(c => c?.id)).size === catalog.length);
  ensure(Array.isArray(definition.cases) && definition.cases.length >= 3 && definition.cases.length <= 20
    && new Set(definition.cases.map(c => c?.caseId)).size === definition.cases.length);
  const eligibleJudges = readWikiEligibleJudges(process.env.CAFF_WIKISKILL_JUDGES_CONFIG);
  const cases = definition.cases.map(selection => {
    wikiExactKeys(selection, ['caseId', 'stage', 'category', 'targetReproduction', ...(perCase && Object.hasOwn(selection, 'judge') ? ['judge'] : [])]); identifier(selection.caseId);
    ensure(['gate', 'test'].includes(selection.stage) && ['reproduction', 'control', 'probe'].includes(selection.category)
      && typeof selection.targetReproduction === 'boolean' && (!selection.targetReproduction || selection.category === 'reproduction'));
    const source = catalog.find(c => c.id === selection.caseId); ensure(source);
    wikiExactKeys(source, ['id', 'sceneHash', 'task', 'actual', 'expected', 'hardAssertions', 'rubric', ...(source.execution === undefined ? [] : ['execution'])]);
    ensure(typeof source.sceneHash === 'string' && /^[a-f0-9]{64}$/.test(source.sceneHash));
    if (source.execution !== undefined) ensure(source.sceneHash === wikiExperimentRunSceneHash(source.execution));
    wikiRubricText(source.task, 32768); wikiRubricText(source.expected, 8192); safeJson(source.hardAssertions, 32768);
    const rubric = validateWikiRubric(source.rubric, true);
    ensure(rubric.caseId === source.id && rubric.sourceHash === wikiRubricSourceHash(source.actual, source.expected));
    if (perCase) ensure(rubric.kind === 'wiki-rubric-v2');
    if (source.execution && rubric.questions.some(q => q.evidence !== 'reply')) throw fail('wiki_rubric_run_evidence_invalid');
    if (rubric.toolCheck && !source.execution) throw fail('wiki_tool_check_run_only');
    const { judge: selectedJudge, ...partition } = selection;
    const codeOnly = !!source.execution && !!rubric.toolCheck && !rubric.questions.length;
    if (codeOnly && perCase) ensure(selectedJudge == null);
    const configuration = (perCase ? selectedJudge : definition.judge)!;
    const judge = codeOnly ? null : bindWikiJudge(configuration, rubric);
    if (!codeOnly) assertWikiEligibleConfiguration(configuration, eligibleJudges);
    return { ...structuredClone(partition), sceneHash: source.sceneHash, inputHash: wikiValueHash({ task: source.task, expected: source.expected }),
      hardAssertionsHash: wikiValueHash(source.hardAssertions), rubricHash: rubric.hash, judge,
      ...(source.execution ? { execution: structuredClone(source.execution) } : {}) };
  });
  ensure(cases.some(c => c.stage === 'gate' && c.targetReproduction) && cases.some(c => c.stage === 'gate' && c.category === 'control')
    && cases.some(c => c.stage === 'test' && c.targetReproduction));
  checkExecutionPartitions(cases);
  const hasRuns = cases.some(c => c.execution?.level === 'run');
  const payload = { kind: (hasRuns ? 'wiki-experiment-plan-v3' : perCase ? 'wiki-experiment-plan-v2' : 'wiki-experiment-plan-v1') as WikiExperimentPlan['kind'], variants: structuredClone(definition.variants), runner: structuredClone(definition.runner),
    repeats: 10 as const, executionPolicy: 'alternating-valid-v1' as const, decision: { ...POLICY },
    cases: hasRuns ? cases.map(c => ({ ...c, execution: c.execution ?? { level: 'trace' as const } })) : cases };
  return { ...payload, planHash: wikiValueHash(payload) };
}
function checkPlanHash(plan: WikiExperimentPlan) {
  wikiExactKeys(plan, ['kind', 'variants', 'runner', 'repeats', 'executionPolicy', 'decision', 'cases', 'planHash']);
  const { planHash, ...payload } = plan;
  ensure(['wiki-experiment-plan-v1', 'wiki-experiment-plan-v2', 'wiki-experiment-plan-v3'].includes(plan.kind) && plan.repeats === 10 && plan.executionPolicy === 'alternating-valid-v1'
    && wikiValueHash(plan.decision) === wikiValueHash(POLICY) && /^[a-f0-9]{64}$/.test(planHash) && wikiValueHash(payload) === planHash);
  ensure(Array.isArray(plan.variants) && plan.variants.length === 2);
  for (const [i, v] of plan.variants.entries()) {
    wikiExactKeys(v, ['id', 'promptHash']); ensure(v.id === (i === 0 ? 'original' : 'candidate') && /^[a-f0-9]{64}$/.test(v.promptHash));
  }
  wikiExactKeys(plan.runner, ['model', 'settings']); wikiRubricText(plan.runner.model, 256); safeJson(plan.runner, 8192);
  ensure(plan.runner.settings && typeof plan.runner.settings === 'object' && !Array.isArray(plan.runner.settings));
  for (const [k, v] of Object.entries(plan.runner.settings)) ensure(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(k)
    && !/^(?:key|apiKey|authorization|password|credential|secret)$/i.test(k)
    && (v === null || ['string', 'boolean'].includes(typeof v) || typeof v === 'number' && Number.isFinite(v)));
  ensure(Array.isArray(plan.cases) && plan.cases.length >= 3 && plan.cases.length <= 20 && new Set(plan.cases.map(c => c?.caseId)).size === plan.cases.length);
  for (const c of plan.cases) {
    wikiExactKeys(c, ['caseId', 'stage', 'category', 'targetReproduction', 'sceneHash', 'inputHash', 'hardAssertionsHash', 'rubricHash', 'judge', ...(plan.kind === 'wiki-experiment-plan-v3' ? ['execution'] : [])]); identifier(c.caseId);
    if (plan.kind === 'wiki-experiment-plan-v3') {
      ensure(c.execution);
      if (c.execution.level === 'trace') wikiExactKeys(c.execution, ['level']);
      else ensure(c.sceneHash === wikiExperimentRunSceneHash(c.execution));
    }
    ensure(['gate', 'test'].includes(c.stage) && ['reproduction', 'control', 'probe'].includes(c.category) && typeof c.targetReproduction === 'boolean'
      && (!c.targetReproduction || c.category === 'reproduction'));
    for (const key of ['sceneHash', 'inputHash', 'hardAssertionsHash', 'rubricHash'] as const) ensure(/^[a-f0-9]{64}$/.test(c[key]));
    if (c.judge === null) {
      ensure(plan.kind === 'wiki-experiment-plan-v3' && c.execution?.level === 'run');
      continue; // The rubric is checked by plan reconstruction/publication.
    }
    wikiExactKeys(c.judge, ['kind', 'backend', 'model', 'modelHash', 'promptHash', 'rubricHash', 'passes']);
    ensure(c.judge.kind === 'wiki-judge-binding-v1' && ['deepseek', 'jev'].includes(c.judge.backend) && c.judge.passes === 3
      && c.judge.rubricHash === c.rubricHash && /^[a-f0-9]{64}$/.test(c.judge.modelHash) && /^[a-f0-9]{64}$/.test(c.judge.promptHash));
    wikiRubricText(c.judge.model, 256);
    ensure(c.judge.backend !== 'deepseek' || c.judge.model === 'deepseek/deepseek-v4-flash');
  }
  ensure(plan.cases.some(c => c.stage === 'gate' && c.targetReproduction) && plan.cases.some(c => c.stage === 'gate' && c.category === 'control')
    && plan.cases.some(c => c.stage === 'test' && c.targetReproduction));
  if (plan.kind === 'wiki-experiment-plan-v3') {
    ensure(plan.cases.some(c => c.execution?.level === 'run'));
    checkExecutionPartitions(plan.cases);
  }
  // Historical v1 plans had one shared judge. V2 binds one judge per case,
  // shared by that case's original/candidate runs, not across the experiment.
  if (plan.kind === 'wiki-experiment-plan-v1') {
    const first = plan.cases[0].judge;
    ensure(plan.cases.every(c => ['backend', 'model', 'modelHash', 'promptHash', 'passes'].every(k => (c.judge as any)[k] === (first as any)[k])));
  }
}
export function validateWikiExperimentPlan(plan: WikiExperimentPlan): WikiExperimentPlan { checkPlanHash(plan); return structuredClone(plan); }
export function assertWikiExperimentPlan(plan: WikiExperimentPlan, definition: WikiExperimentDefinition, catalog: WikiExperimentCase[]): void {
  try {
    checkPlanHash(plan);
    if (wikiValueHash(plan) === wikiValueHash(createWikiExperimentPlan(definition, catalog))) return;
  } catch { /* Integrity errors never trigger a model retry. */ }
  throw fail('wiki_experiment_changed');
}
export function decideWikiExperimentGate(plan: WikiExperimentPlan, results: WikiExperimentCaseResult[]) {
  checkPlanHash(plan);
  ensure(Array.isArray(results) && new Set(results.map(r => r?.caseId)).size === results.length);
  for (const result of results) {
    wikiExactKeys(result, ['caseId', 'status', 'runs']);
    const source = plan.cases.find(c => c.caseId === result.caseId); ensure(source);
    ensure(['completed', 'error', 'not-run', 'unsupported'].includes(result.status) && Array.isArray(result.runs) && result.runs.length <= 25);
    ensure(!['not-run', 'unsupported'].includes(result.status) || !result.runs.length);
    const attempts = { original: 0, candidate: 0 }, scored = { original: 0, candidate: 0 }, slots = { original: 0, candidate: 0 };
    let next: 'original' | 'candidate' = 'original', replacements = 0;
    for (const row of result.runs) {
      wikiExactKeys(row, ['variant', 'iteration', 'status', ...(Object.hasOwn(row, 'judgeError') ? ['judgeError'] : [])]);
      ensure(!Object.hasOwn(row, 'judgeError') || row.judgeError === true && row.status === 'error');
      if (slots[next] === 10) next = next === 'original' ? 'candidate' : 'original';
      ensure(row.variant === next && Number.isSafeInteger(row.iteration) && row.iteration === ++attempts[next]
        && slots[next] < 10 && ['pass', 'fail', 'error', ...(source.execution?.level === 'run' ? ['invalid'] : [])].includes(row.status));
      if (row.status === 'invalid' || row.status === 'error' && !row.judgeError) replacements++;
      if (row.status === 'pass' || row.status === 'fail') scored[next]++;
      if (row.status !== 'error' && row.status !== 'invalid' || row.judgeError) slots[next]++;
      next = next === 'original' ? 'candidate' : 'original';
    }
    ensure(replacements <= 5 && (result.status !== 'completed' || scored.original === 10 && scored.candidate === 10));
  }
  const rows = plan.cases.map(c => ({ sourceCaseId: c.caseId, stage: c.stage, category: c.category,
    ...(results.find(r => r.caseId === c.caseId) || { status: 'not-run', runs: [] }) }));
  // The existing formula only knows pass/fail/error. Invalid run outputs are
  // outside its denominator, never a new score and never counted as a fail.
  const decision = decideWikiGate(rows.map(c => ({ ...c, runs: c.runs.filter(r => r.status !== 'invalid') })),
    plan.cases.filter(c => c.stage === 'gate' && c.targetReproduction).map(c => c.caseId), plan.repeats);
  if (plan.kind !== 'wiki-experiment-plan-v3') return decision;
  const byLevel = Object.fromEntries(['trace', 'run'].map(level => {
    const selected = rows.filter(c => c.stage === 'gate' && (plan.cases.find(p => p.caseId === c.sourceCaseId)?.execution?.level ?? 'trace') === level);
    return [level, { caseIds: selected.map(c => c.sourceCaseId), ...Object.fromEntries(['original', 'candidate'].map(variant => {
      const attempts = selected.flatMap(c => c.runs).filter(r => r.variant === variant);
      return [variant, { passed: attempts.filter(r => r.status === 'pass').length,
        total: attempts.filter(r => r.status === 'pass' || r.status === 'fail').length,
        invalid: attempts.filter(r => r.status === 'invalid').length, errors: attempts.filter(r => r.status === 'error').length }];
    })) }];
  }));
  return { ...decision, byLevel };
}
export function assertWikiExperimentStage(plan: WikiExperimentPlan, results: WikiExperimentCaseResult[], stage: 'gate' | 'test') {
  checkPlanHash(plan); ensure(['gate', 'test'].includes(stage));
  if (stage === 'test' && decideWikiExperimentGate(plan, results).outcome !== 'accepted') throw fail('wiki_experiment_gate_not_accepted');
}
