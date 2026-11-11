// V4's mode-local immutable plan. This pure layer is intentionally separate
// from v1-v3: it never upgrades historical plans, decisions or result bytes.
// Gate slice only: trusted staged execution/publication is wired separately
// and must reconstruct current evidence before use. This API alone grants no
// execution, validation-coverage or baseline-adoption permission.
import { planWikiHoldoutGate, validateWikiHoldoutGateSelection, decideWikiHoldoutGate, type WikiHoldoutGateSelection } from './wiki-holdout-gate';
import { type WikiExperimentCase, type WikiExperimentCaseResult, type WikiExperimentDefinition, type WikiExperimentExecution } from './wiki-experiment-plan';
import { type WikiJudgeBinding, type WikiJudgeConfiguration } from './wiki-scoring-v2';
import { readWikiEligibleJudges } from './wiki-judge-catalog';
import { bindWikiHoldoutCase, validateWikiHoldoutCaseBinding } from './wiki-holdout-case';
import { wikiExactKeys, wikiRubricText, wikiValueHash, wikiRubricFail as fail } from './wiki-rubric';
import { containsSecretSentinel } from './secrets';
export const WIKI_HOLDOUT_GATE_POLICY = Object.freeze({ kind: 'wikiskill-holdout-gate-v1', alpha: .05, maxExtraAttemptsPerCase: 5 });
export interface WikiHoldoutExperimentDefinition {
  kind: 'wiki-experiment-v3'; variants: WikiExperimentDefinition['variants']; runner: WikiExperimentDefinition['runner'];
  repeats: 10; executionPolicy: 'alternating-valid-v1'; decision: typeof WIKI_HOLDOUT_GATE_POLICY;
  // Membership/stage are evidence-derived, never caller relabeling. Only judge
  // choice is experiment-owned, and it must match the frozen case assertions.
  cases: { caseId: string; judge?: WikiJudgeConfiguration | null }[];
}
export interface WikiHoldoutExperimentPlan {
  kind: 'wiki-experiment-plan-v4'; variants: WikiHoldoutExperimentDefinition['variants']; runner: WikiHoldoutExperimentDefinition['runner'];
  repeats: 10; executionPolicy: 'alternating-valid-v1'; decision: typeof WIKI_HOLDOUT_GATE_POLICY;
  gate: WikiHoldoutGateSelection;
  cases: { caseId: string; stage: 'gate'; originalSplit: 'gate' | 'test'; category: 'reproduction'; targetReproduction: true;
    sceneHash: string; inputHash: string; hardAssertionsHash: string; rubricHash: string; judge: WikiJudgeBinding | null;
    execution: WikiExperimentExecution; traceToolCheck?: 'structured-v1' }[];
  planHash: string;
}
const INVALID = 'wiki_holdout_plan_invalid';
function ensure(value: unknown, code = INVALID): asserts value { if (!value) throw fail(code); }
const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function safeJson(value: unknown, maxBytes: number) {
  wikiValueHash(value);
  const text = JSON.stringify(value); ensure(Buffer.byteLength(text) <= maxBytes && !containsSecretSentinel(text));
}
function checkCommon(value: Pick<WikiHoldoutExperimentDefinition, 'variants' | 'runner' | 'repeats' | 'executionPolicy' | 'decision'>) {
  ensure(value.repeats === 10 && value.executionPolicy === 'alternating-valid-v1' && wikiValueHash(value.decision) === wikiValueHash(WIKI_HOLDOUT_GATE_POLICY));
  ensure(Array.isArray(value.variants) && value.variants.length === 2);
  for (const [i, v] of value.variants.entries()) {
    wikiExactKeys(v, ['id', 'promptHash']); ensure(v.id === (i === 0 ? 'original' : 'candidate') && digest(v.promptHash));
  }
  wikiExactKeys(value.runner, ['model', 'settings']); wikiRubricText(value.runner.model, 256); safeJson(value.runner, 8192);
  ensure(value.runner.settings && typeof value.runner.settings === 'object' && !Array.isArray(value.runner.settings));
  for (const [k, v] of Object.entries(value.runner.settings)) ensure(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(k)
    && !/^(?:key|apiKey|authorization|password|credential|secret)$/i.test(k)
    && (v === null || ['string', 'boolean'].includes(typeof v) || typeof v === 'number' && Number.isFinite(v)));
}
export function validateWikiHoldoutExperimentPlan(plan: WikiHoldoutExperimentPlan): WikiHoldoutExperimentPlan {
  wikiExactKeys(plan, ['kind', 'variants', 'runner', 'repeats', 'executionPolicy', 'decision', 'gate', 'cases', 'planHash']);
  ensure(plan.kind === 'wiki-experiment-plan-v4'); checkCommon(plan);
  const gate = validateWikiHoldoutGateSelection(plan.gate);
  ensure(gate.caseIds.length > 0, 'wiki_holdout_plan_targets_required');
  ensure(Array.isArray(plan.cases) && plan.cases.length === gate.caseIds.length);
  for (const [n, c] of plan.cases.entries()) {
    wikiExactKeys(c, ['caseId', 'stage', 'originalSplit', 'category', 'targetReproduction', 'sceneHash', 'inputHash', 'hardAssertionsHash', 'rubricHash', 'judge', 'execution',
      ...(Object.hasOwn(c, 'traceToolCheck') ? ['traceToolCheck'] : [])]);
    const row = gate.cases.find(r => r.caseId === gate.caseIds[n]);
    ensure(row?.eligible && c.caseId === row.caseId && c.stage === 'gate' && c.category === 'reproduction' && c.targetReproduction === true
      && c.originalSplit === row.originalSplit && c.rubricHash === row.precheck!.rubricHash);
    validateWikiHoldoutCaseBinding(c, { level: row.level, precheck: row.precheck! });
  }
  const { planHash, ...payload } = plan; ensure(digest(planHash) && wikiValueHash(payload) === planHash);
  return structuredClone(plan);
}
// A retained selection is an integrity binding, not an execution authorization.
// Only the trusted host may supply task/scene/request projections in catalog;
// current reconstruction below additionally prevents stale precheck reuse.
export function createWikiHoldoutExperimentPlan(definition: WikiHoldoutExperimentDefinition, catalog: WikiExperimentCase[], selection: WikiHoldoutGateSelection): WikiHoldoutExperimentPlan {
  wikiExactKeys(definition, ['kind', 'variants', 'runner', 'repeats', 'executionPolicy', 'decision', 'cases']);
  ensure(definition.kind === 'wiki-experiment-v3'); checkCommon(definition);
  const gate = validateWikiHoldoutGateSelection(selection);
  ensure(gate.caseIds.length > 0, 'wiki_holdout_plan_targets_required');
  ensure(Array.isArray(catalog) && new Set(catalog.map(c => c?.id)).size === catalog.length);
  ensure(Array.isArray(definition.cases) && definition.cases.length === gate.caseIds.length
    && new Set(definition.cases.map(c => c?.caseId)).size === definition.cases.length);
  for (const c of definition.cases) {
    wikiExactKeys(c, ['caseId', ...(Object.hasOwn(c, 'judge') ? ['judge'] : [])]); ensure(gate.caseIds.includes(c.caseId));
  }
  let eligibleJudges: ReturnType<typeof readWikiEligibleJudges> | undefined;
  const cases = gate.caseIds.map(caseId => {
    const row = gate.cases.find(c => c.caseId === caseId)!, choice = definition.cases.find(c => c.caseId === caseId)!;
    const source = catalog.find(c => c.id === caseId); ensure(source);
    return { caseId, stage: 'gate' as const, originalSplit: row.originalSplit, category: 'reproduction' as const, targetReproduction: true as const,
      ...bindWikiHoldoutCase(source, { level: row.level, precheck: row.precheck! }, choice.judge,
        () => eligibleJudges ??= readWikiEligibleJudges(process.env.CAFF_WIKISKILL_JUDGES_CONFIG)) };
  });
  const payload = { kind: 'wiki-experiment-plan-v4' as const, variants: structuredClone(definition.variants), runner: structuredClone(definition.runner),
    repeats: 10 as const, executionPolicy: 'alternating-valid-v1' as const, decision: { ...WIKI_HOLDOUT_GATE_POLICY }, gate, cases };
  return validateWikiHoldoutExperimentPlan({ ...payload, planHash: wikiValueHash(payload) });
}
export function assertWikiHoldoutExperimentPlan(plan: WikiHoldoutExperimentPlan, definition: WikiHoldoutExperimentDefinition, catalog: WikiExperimentCase[], current: Parameters<typeof planWikiHoldoutGate>[0]): void {
  try {
    validateWikiHoldoutExperimentPlan(plan);
    if (wikiValueHash(plan) === wikiValueHash(createWikiHoldoutExperimentPlan(definition, catalog, planWikiHoldoutGate(current)))) return;
  } catch { /* No integrity failure authorizes a retry, fallback or old proof. */ }
  throw fail('wiki_experiment_changed');
}
export function decideWikiHoldoutExperimentGate(plan: WikiHoldoutExperimentPlan, results: WikiExperimentCaseResult[]) {
  validateWikiHoldoutExperimentPlan(plan);
  const decision = decideWikiHoldoutGate(plan.gate, results);
  for (const row of results) {
    const source = plan.cases.find(c => c.caseId === row.caseId)!;
    ensure(source.execution.level === 'run' || source.traceToolCheck === 'structured-v1' || !row.runs.some(r => r.status === 'invalid'), 'wiki_holdout_gate_result_invalid');
  }
  return decision;
}
