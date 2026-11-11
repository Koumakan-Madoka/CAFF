// Full v4 gate/validation plan. Pure immutable planning/decision only: the
// trusted host must reconstruct current evidence, enforce budget and execute
// gate before validation. This module alone never publishes/adopts a baseline.
// Gate-only v4 and v1-v3 remain on their strict, byte-preserving readers.
import { planWikiHoldoutGate, type WikiHoldoutGateSelection } from './wiki-holdout-gate';
import { createWikiHoldoutExperimentPlan, validateWikiHoldoutExperimentPlan, decideWikiHoldoutExperimentGate,
  type WikiHoldoutExperimentDefinition, type WikiHoldoutExperimentPlan } from './wiki-holdout-plan';
import { planWikiHoldoutValidation, validateWikiHoldoutValidationSelection, decideWikiHoldoutValidation,
  type WikiHoldoutValidationSelection } from './wiki-holdout-validation';
import { bindWikiHoldoutCase, validateWikiHoldoutCaseBinding, type WikiHoldoutCaseBinding } from './wiki-holdout-case';
import { readWikiEligibleJudges } from './wiki-judge-catalog';
import { wikiExactKeys, wikiValueHash, wikiRubricFail as fail } from './wiki-rubric';
import type { WikiExperimentCase, WikiExperimentCaseResult } from './wiki-experiment-plan';
type ControlCase = WikiHoldoutCaseBinding & { caseId: string; stage: 'validation'; category: 'control'; targetReproduction: false; entryId: string };
export interface WikiHoldoutFullExperimentPlan extends Omit<WikiHoldoutExperimentPlan, 'cases'> {
  validation: WikiHoldoutValidationSelection;
  cases: (WikiHoldoutExperimentPlan['cases'][number] | ControlCase)[];
}
const INVALID = 'wiki_holdout_plan_invalid', RESULT = 'wiki_holdout_validation_result_invalid';
function ensure(v: unknown, code = INVALID): asserts v { if (!v) throw fail(code); }
function hashPlan<T extends object>(payload: T) { return { ...payload, planHash: wikiValueHash(payload) }; }
// The original gate validator checks common config and every gate binding.
// Rehashing this internal projection does not authorize execution; the caller's
// full hash and both retained selections are validated independently below.
function gatePart(plan: WikiHoldoutFullExperimentPlan): WikiHoldoutExperimentPlan {
  const { validation, cases, planHash, ...common } = plan;
  return validateWikiHoldoutExperimentPlan(hashPlan({ ...common, cases: cases.filter(c => c?.stage === 'gate') }));
}
export function validateWikiHoldoutFullExperimentPlan(plan: WikiHoldoutFullExperimentPlan): WikiHoldoutFullExperimentPlan {
  wikiExactKeys(plan, ['kind', 'variants', 'runner', 'repeats', 'executionPolicy', 'decision', 'gate', 'cases', 'validation', 'planHash']);
  ensure(Array.isArray(plan.cases)); const gate = gatePart(plan), validation = validateWikiHoldoutValidationSelection(plan.validation);
  ensure(gate.gate.targetEntryId === validation.targetEntryId && !validation.cases.some(c => gate.gate.cases.some(g => g.caseId === c.caseId)));
  ensure(plan.cases.length === gate.cases.length + validation.caseIds.length
    && wikiValueHash(plan.cases.map(c => c.caseId)) === wikiValueHash([...gate.gate.caseIds, ...validation.caseIds]));
  for (const [n, c] of plan.cases.slice(gate.cases.length).entries()) {
    wikiExactKeys(c, ['caseId', 'stage', 'category', 'targetReproduction', 'entryId', 'sceneHash', 'inputHash', 'hardAssertionsHash', 'rubricHash', 'judge', 'execution',
      ...(Object.hasOwn(c, 'traceToolCheck') ? ['traceToolCheck'] : [])]);
    const row = validation.cases.find(r => r.caseId === validation.caseIds[n])!;
    ensure(c.stage === 'validation' && c.category === 'control' && c.targetReproduction === false && c.entryId === row.entryId);
    validateWikiHoldoutCaseBinding(c, row);
  }
  const { planHash, ...payload } = plan; ensure(typeof planHash === 'string' && /^[a-f0-9]{64}$/.test(planHash) && wikiValueHash(payload) === planHash);
  return structuredClone(plan);
}
export function createWikiHoldoutFullExperimentPlan(definition: WikiHoldoutExperimentDefinition, catalog: WikiExperimentCase[], gateSelection: WikiHoldoutGateSelection,
  validationSelection: WikiHoldoutValidationSelection): WikiHoldoutFullExperimentPlan {
  wikiExactKeys(definition, ['kind', 'variants', 'runner', 'repeats', 'executionPolicy', 'decision', 'cases']);
  const validation = validateWikiHoldoutValidationSelection(validationSelection);
  ensure(Array.isArray(definition.cases));
  const selectedIds = [...gateSelection.caseIds, ...validation.caseIds];
  ensure(new Set(selectedIds).size === selectedIds.length && definition.cases.length === selectedIds.length
    && new Set(definition.cases.map(c => c?.caseId)).size === definition.cases.length);
  for (const c of definition.cases) {
    wikiExactKeys(c, ['caseId', ...(Object.hasOwn(c, 'judge') ? ['judge'] : [])]); ensure(selectedIds.includes(c.caseId));
  }
  const gate = createWikiHoldoutExperimentPlan({ ...definition, cases: definition.cases.filter(c => gateSelection.caseIds.includes(c.caseId)) }, catalog, gateSelection);
  let eligibleJudges: ReturnType<typeof readWikiEligibleJudges> | undefined;
  const controls = validation.caseIds.map(caseId => {
    const row = validation.cases.find(c => c.caseId === caseId)!, choice = definition.cases.find(c => c.caseId === caseId)!;
    const source = catalog.find(c => c.id === caseId); ensure(source);
    return { caseId, stage: 'validation' as const, category: 'control' as const, targetReproduction: false as const, entryId: row.entryId,
      ...bindWikiHoldoutCase(source, row, choice.judge, () => eligibleJudges ??= readWikiEligibleJudges(process.env.CAFF_WIKISKILL_JUDGES_CONFIG)) };
  });
  const { planHash, ...payload } = gate;
  return validateWikiHoldoutFullExperimentPlan(hashPlan({ ...payload, validation, cases: [...gate.cases, ...controls] }));
}
export function assertWikiHoldoutFullExperimentPlan(plan: WikiHoldoutFullExperimentPlan, definition: WikiHoldoutExperimentDefinition, catalog: WikiExperimentCase[],
  current: Parameters<typeof planWikiHoldoutValidation>[0]): void {
  try {
    validateWikiHoldoutFullExperimentPlan(plan);
    const { state, records, replayChecks, targetEntryId } = current;
    const gate = planWikiHoldoutGate({ state, records, replayChecks, targetEntryId }), validation = planWikiHoldoutValidation(current);
    if (wikiValueHash(plan) === wikiValueHash(createWikiHoldoutFullExperimentPlan(definition, catalog, gate, validation))) return;
  } catch { /* Drift never authorizes stale evidence, fallback or automatic retry. */ }
  throw fail('wiki_experiment_changed');
}
export function decideWikiHoldoutFullExperiment(plan: WikiHoldoutFullExperimentPlan, results: WikiExperimentCaseResult[]) {
  validateWikiHoldoutFullExperimentPlan(plan);
  ensure(Array.isArray(results) && new Set(results.map(r => r?.caseId)).size === results.length
    && results.every(r => plan.cases.some(c => c.caseId === r?.caseId)), RESULT);
  const gatePlan = gatePart(plan), gate = decideWikiHoldoutExperimentGate(gatePlan, results.filter(r => plan.gate.caseIds.includes(r.caseId)));
  const validationRows = results.filter(r => plan.validation.caseIds.includes(r.caseId));
  const decision = decideWikiHoldoutValidation(plan.validation, gate.outcome as 'accepted' | 'rejected' | 'indeterminate', validationRows);
  for (const r of validationRows) {
    const c = plan.cases.find(c => c.caseId === r.caseId)!;
    ensure(c.execution.level === 'run' || c.traceToolCheck === 'structured-v1' || !r.runs.some(r => r.status === 'invalid'), RESULT);
  }
  return { ...decision, gate };
}
