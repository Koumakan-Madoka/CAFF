// Experiment-owned choices and immutable bindings, separate from case storage
// and execution. D7 delegates to the existing gate formula, never a new metric.
import { decideWikiGate } from './wiki-gate-policy';
import { containsSecretSentinel } from './secrets';
import { bindWikiJudge, isWikiJudgeTechnicalError, type WikiJudgeBinding, type WikiJudgeConfiguration, type WikiScoreStatus } from './wiki-scoring-v2';
import { validateWikiRubric, wikiExactKeys, wikiRubricFail as fail, wikiRubricSourceHash, wikiRubricText, wikiValueHash, type WikiRubric } from './wiki-rubric';
const POLICY = Object.freeze({ kind: 'wikiskill-gate-v1', alpha: .05, noHarmFraction: .05, minimumAllowedLoss: 1, maxExtraAttemptsPerCase: 5 });
interface WikiExperimentSelection { caseId: string; stage: 'gate' | 'test'; category: 'reproduction' | 'control' | 'probe'; targetReproduction: boolean; judge?: WikiJudgeConfiguration }
export interface WikiExperimentCase {
  id: string; sceneHash: string; task: string; actual: string; expected: string; hardAssertions: unknown; rubric: WikiRubric;
}
export interface WikiExperimentDefinition {
  kind: 'wiki-experiment-v1' | 'wiki-experiment-v2'; variants: { id: 'original' | 'candidate'; promptHash: string }[];
  runner: { model: string; settings: Record<string, string | number | boolean | null> };
  repeats: 10; executionPolicy: 'alternating-valid-v1'; decision: typeof POLICY;
  judge?: WikiJudgeConfiguration; cases: WikiExperimentSelection[];
}
export interface WikiExperimentPlan {
  kind: 'wiki-experiment-plan-v1' | 'wiki-experiment-plan-v2'; variants: WikiExperimentDefinition['variants']; runner: WikiExperimentDefinition['runner'];
  repeats: 10; executionPolicy: 'alternating-valid-v1'; decision: typeof POLICY;
  cases: (Omit<WikiExperimentSelection, 'judge'> & { sceneHash: string; inputHash: string; hardAssertionsHash: string; rubricHash: string; judge: WikiJudgeBinding })[];
  planHash: string;
}
export interface WikiExperimentCaseResult {
  caseId: string; status: 'completed' | 'error' | 'not-run' | 'unsupported';
  runs: { variant: 'original' | 'candidate'; iteration: number; status: WikiScoreStatus; judgeError?: true }[];
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
  const cases = definition.cases.map(selection => {
    wikiExactKeys(selection, ['caseId', 'stage', 'category', 'targetReproduction', ...(perCase ? ['judge'] : [])]); identifier(selection.caseId);
    ensure(['gate', 'test'].includes(selection.stage) && ['reproduction', 'control', 'probe'].includes(selection.category)
      && typeof selection.targetReproduction === 'boolean' && (!selection.targetReproduction || selection.category === 'reproduction'));
    const source = catalog.find(c => c.id === selection.caseId); ensure(source);
    wikiExactKeys(source, ['id', 'sceneHash', 'task', 'actual', 'expected', 'hardAssertions', 'rubric']);
    ensure(typeof source.sceneHash === 'string' && /^[a-f0-9]{64}$/.test(source.sceneHash));
    wikiRubricText(source.task, 32768); wikiRubricText(source.expected, 8192); safeJson(source.hardAssertions, 32768);
    const rubric = validateWikiRubric(source.rubric, true);
    ensure(rubric.caseId === source.id && rubric.sourceHash === wikiRubricSourceHash(source.actual, source.expected));
    if (perCase) ensure(rubric.kind === 'wiki-rubric-v2');
    const { judge: selectedJudge, ...partition } = selection;
    return { ...structuredClone(partition), sceneHash: source.sceneHash, inputHash: wikiValueHash({ task: source.task, expected: source.expected }),
      hardAssertionsHash: wikiValueHash(source.hardAssertions), rubricHash: rubric.hash, judge: bindWikiJudge((perCase ? selectedJudge : definition.judge)!, rubric) };
  });
  ensure(cases.some(c => c.stage === 'gate' && c.targetReproduction) && cases.some(c => c.stage === 'gate' && c.category === 'control')
    && cases.some(c => c.stage === 'test' && c.targetReproduction));
  const payload = { kind: (perCase ? 'wiki-experiment-plan-v2' : 'wiki-experiment-plan-v1') as WikiExperimentPlan['kind'], variants: structuredClone(definition.variants), runner: structuredClone(definition.runner),
    repeats: 10 as const, executionPolicy: 'alternating-valid-v1' as const, decision: { ...POLICY }, cases };
  return { ...payload, planHash: wikiValueHash(payload) };
}
function checkPlanHash(plan: WikiExperimentPlan) {
  wikiExactKeys(plan, ['kind', 'variants', 'runner', 'repeats', 'executionPolicy', 'decision', 'cases', 'planHash']);
  const { planHash, ...payload } = plan;
  ensure(['wiki-experiment-plan-v1', 'wiki-experiment-plan-v2'].includes(plan.kind) && plan.repeats === 10 && plan.executionPolicy === 'alternating-valid-v1'
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
    wikiExactKeys(c, ['caseId', 'stage', 'category', 'targetReproduction', 'sceneHash', 'inputHash', 'hardAssertionsHash', 'rubricHash', 'judge']); identifier(c.caseId);
    ensure(['gate', 'test'].includes(c.stage) && ['reproduction', 'control', 'probe'].includes(c.category) && typeof c.targetReproduction === 'boolean'
      && (!c.targetReproduction || c.category === 'reproduction'));
    for (const key of ['sceneHash', 'inputHash', 'hardAssertionsHash', 'rubricHash'] as const) ensure(/^[a-f0-9]{64}$/.test(c[key]));
    wikiExactKeys(c.judge, ['kind', 'backend', 'model', 'modelHash', 'promptHash', 'rubricHash', 'passes']);
    ensure(c.judge.kind === 'wiki-judge-binding-v1' && ['deepseek', 'jev'].includes(c.judge.backend) && c.judge.passes === 3
      && c.judge.rubricHash === c.rubricHash && /^[a-f0-9]{64}$/.test(c.judge.modelHash) && /^[a-f0-9]{64}$/.test(c.judge.promptHash));
    wikiRubricText(c.judge.model, 256);
    ensure(c.judge.backend !== 'deepseek' || c.judge.model === 'deepseek/deepseek-v4-flash');
  }
  ensure(plan.cases.some(c => c.stage === 'gate' && c.targetReproduction) && plan.cases.some(c => c.stage === 'gate' && c.category === 'control')
    && plan.cases.some(c => c.stage === 'test' && c.targetReproduction));
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
    wikiExactKeys(result, ['caseId', 'status', 'runs']); ensure(plan.cases.some(c => c.caseId === result.caseId));
    ensure(['completed', 'error', 'not-run', 'unsupported'].includes(result.status) && Array.isArray(result.runs) && result.runs.length <= 25);
    ensure(!['not-run', 'unsupported'].includes(result.status) || !result.runs.length);
    const attempts = { original: 0, candidate: 0 }, scored = { original: 0, candidate: 0 }, slots = { original: 0, candidate: 0 };
    let next: 'original' | 'candidate' = 'original', environmentErrors = 0;
    for (const row of result.runs) {
      wikiExactKeys(row, ['variant', 'iteration', 'status', ...(Object.hasOwn(row, 'judgeError') ? ['judgeError'] : [])]);
      ensure(!Object.hasOwn(row, 'judgeError') || row.judgeError === true && row.status === 'error');
      if (slots[next] === 10) next = next === 'original' ? 'candidate' : 'original';
      ensure(row.variant === next && Number.isSafeInteger(row.iteration) && row.iteration === ++attempts[next]
        && slots[next] < 10 && ['pass', 'fail', 'error'].includes(row.status));
      if (row.status === 'error') { if (!row.judgeError) environmentErrors++; }
      else scored[next]++;
      if (row.status !== 'error' || row.judgeError) slots[next]++;
      next = next === 'original' ? 'candidate' : 'original';
    }
    ensure(environmentErrors <= 5 && (result.status !== 'completed' || scored.original === 10 && scored.candidate === 10));
  }
  const rows = plan.cases.map(c => ({ sourceCaseId: c.caseId, stage: c.stage, category: c.category,
    ...(results.find(r => r.caseId === c.caseId) || { status: 'not-run', runs: [] }) }));
  return decideWikiGate(rows, plan.cases.filter(c => c.stage === 'gate' && c.targetReproduction).map(c => c.caseId), plan.repeats);
}
export function assertWikiExperimentStage(plan: WikiExperimentPlan, results: WikiExperimentCaseResult[], stage: 'gate' | 'test') {
  checkPlanHash(plan); ensure(['gate', 'test'].includes(stage));
  if (stage === 'test' && decideWikiExperimentGate(plan, results).outcome !== 'accepted') throw fail('wiki_experiment_gate_not_accepted');
}
