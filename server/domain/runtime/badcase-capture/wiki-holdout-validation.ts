// V4 other-mode controls only. Pure selection/decision, never execution or
// baseline adoption permission. Historical v1-v3 plans/results are untouched.
import { projectWikiGateControls } from './wiki-gate-control';
import { wikiSourceFamily } from './wiki-evaluation-suite';
import { wikiValueHash } from './wiki-rubric';
import type { WikiExperimentCaseResult } from './wiki-experiment-plan';
const SELECTION = 'wiki_holdout_validation_selection_invalid', RESULT = 'wiki_holdout_validation_result_invalid';
const fail = (code: string) => Object.assign(Error(code), { code });
function ensure(v: unknown, code = SELECTION): asserts v { if (!v) throw fail(code); }
function exact(v: any, fields: string[], code = SELECTION) {
  ensure(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...fields].sort().join(','), code);
}
const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const ordered = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export interface WikiHoldoutValidationPolicy {
  kind: 'wikiskill-holdout-validation-v1'; repeats: number; degradationThreshold: number;
  maxEstimatedTokens: number; maxExtraAttemptsPerCase: 5;
}
export const WIKI_HOLDOUT_VALIDATION_POLICY: Readonly<WikiHoldoutValidationPolicy> = Object.freeze({
  kind: 'wikiskill-holdout-validation-v1', repeats: 5, degradationThreshold: 2, maxEstimatedTokens: 20000000, maxExtraAttemptsPerCase: 5,
});
// Trusted host normalizes COMPLETE retained whole-output usage (not native
// request counts) into one aggregate per case. Identity and evidence are bound;
// missing/stale data remains unknown, never an invented zero-cost fallback.
export interface WikiHoldoutUsageHistory {
  caseId: string; caseHash: string; level: 'trace' | 'run'; totalTokens: number; executions: number; evidenceHash: string;
}
interface ValidationCase {
  caseId: string; entryId: string; caseHash: string; level: 'trace' | 'run'; controlHash: string;
  precheck: { id: string; planHash: string; resultHash: string; rubricHash: string };
  usage: { totalTokens: number; executions: number; evidenceHash: string } | null;
  tokensPerExecution: number | null; estimatedTokens: number | null; skipped: boolean;
}
export interface WikiHoldoutValidationSelection {
  kind: 'wiki-holdout-validation-selection-v1'; targetEntryId: string; seed: string; policy: WikiHoldoutValidationPolicy;
  otherEntryIds: string[]; cases: ValidationCase[]; caseIds: string[];
  uncovered: { entryId: string; reason: 'no-confirmed-control' | 'operator-skipped' }[];
  estimatedTokens: number | null; budgetStatus: 'ready' | 'over-limit' | 'usage-unknown'; hash: string;
}
function validatePolicy(p: WikiHoldoutValidationPolicy) {
  exact(p, ['kind', 'repeats', 'degradationThreshold', 'maxEstimatedTokens', 'maxExtraAttemptsPerCase']);
  ensure(p.kind === WIKI_HOLDOUT_VALIDATION_POLICY.kind && count(p.repeats) && p.repeats >= 1 && p.repeats <= 20
    && count(p.degradationThreshold) && p.degradationThreshold >= 1 && p.degradationThreshold <= p.repeats
    && count(p.maxEstimatedTokens) && p.maxExtraAttemptsPerCase === 5);
}
function coverage(otherEntryIds: string[], cases: ValidationCase[]) {
  return otherEntryIds.flatMap<WikiHoldoutValidationSelection['uncovered'][number]>(entryId => {
    const c = cases.find(c => c.entryId === entryId);
    return !c ? [{ entryId, reason: 'no-confirmed-control' as const }] : c.skipped ? [{ entryId, reason: 'operator-skipped' as const }] : [];
  });
}
function budget(cases: ValidationCase[], policy: WikiHoldoutValidationPolicy) {
  const active = cases.filter(c => !c.skipped);
  const estimatedTokens = active.some(c => c.estimatedTokens === null) ? null : active.reduce((sum, c) => sum + c.estimatedTokens!, 0);
  ensure(estimatedTokens === null || count(estimatedTokens));
  return { estimatedTokens, budgetStatus: estimatedTokens === null ? 'usage-unknown' as const
    : estimatedTokens > policy.maxEstimatedTokens ? 'over-limit' as const : 'ready' as const };
}
export function validateWikiHoldoutValidationSelection(s: WikiHoldoutValidationSelection): WikiHoldoutValidationSelection {
  exact(s, ['kind', 'targetEntryId', 'seed', 'policy', 'otherEntryIds', 'cases', 'caseIds', 'uncovered', 'estimatedTokens', 'budgetStatus', 'hash']);
  ensure(s.kind === 'wiki-holdout-validation-selection-v1' && id(s.targetEntryId) && typeof s.seed === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(s.seed) && digest(s.hash)); validatePolicy(s.policy);
  ensure(Array.isArray(s.otherEntryIds) && s.otherEntryIds.length <= 1000 && s.otherEntryIds.every(id)
    && !s.otherEntryIds.includes(s.targetEntryId) && new Set(s.otherEntryIds).size === s.otherEntryIds.length
    && JSON.stringify(s.otherEntryIds) === JSON.stringify([...s.otherEntryIds].sort(ordered)));
  ensure(Array.isArray(s.cases) && s.cases.length <= s.otherEntryIds.length && Array.isArray(s.caseIds) && Array.isArray(s.uncovered));
  for (const c of s.cases) {
    exact(c, ['caseId', 'entryId', 'caseHash', 'level', 'controlHash', 'precheck', 'usage', 'tokensPerExecution', 'estimatedTokens', 'skipped']);
    ensure(id(c.caseId) && s.otherEntryIds.includes(c.entryId) && digest(c.caseHash) && digest(c.controlHash)
      && ['trace', 'run'].includes(c.level) && typeof c.skipped === 'boolean');
    exact(c.precheck, ['id', 'planHash', 'resultHash', 'rubricHash']);
    ensure(typeof c.precheck.id === 'string' && /^precheck-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(c.precheck.id)
      && [c.precheck.planHash, c.precheck.resultHash, c.precheck.rubricHash].every(digest));
    if (c.usage === null) ensure(c.tokensPerExecution === null && c.estimatedTokens === null);
    else {
      exact(c.usage, ['totalTokens', 'executions', 'evidenceHash']);
      ensure(count(c.usage.totalTokens) && count(c.usage.executions) && c.usage.executions > 0 && digest(c.usage.evidenceHash)
        && c.tokensPerExecution === Math.ceil(c.usage.totalTokens / c.usage.executions)
        && c.estimatedTokens === c.tokensPerExecution * (2 * s.policy.repeats + s.policy.maxExtraAttemptsPerCase) && count(c.estimatedTokens));
    }
  }
  ensure(new Set(s.cases.map(c => c.caseId)).size === s.cases.length && new Set(s.cases.map(c => c.entryId)).size === s.cases.length
    && JSON.stringify(s.cases.map(c => c.entryId)) === JSON.stringify(s.cases.map(c => c.entryId).sort(ordered))
    && JSON.stringify(s.caseIds) === JSON.stringify(s.cases.filter(c => !c.skipped).map(c => c.caseId))
    && wikiValueHash(s.uncovered) === wikiValueHash(coverage(s.otherEntryIds, s.cases)));
  const b = budget(s.cases, s.policy); ensure(s.estimatedTokens === b.estimatedTokens && s.budgetStatus === b.budgetStatus);
  const { hash, ...payload } = s; ensure(hash === wikiValueHash(payload)); return structuredClone(s);
}
export function planWikiHoldoutValidation(input: {
  state: any; records: any[]; replayChecks: any[]; targetEntryId: string; seed: string; history: WikiHoldoutUsageHistory[];
  policy?: Partial<Pick<WikiHoldoutValidationPolicy, 'repeats' | 'degradationThreshold' | 'maxEstimatedTokens'>>; skippedCaseIds?: string[];
}): WikiHoldoutValidationSelection {
  exact(input, ['state', 'records', 'replayChecks', 'targetEntryId', 'seed', 'history',
    ...(Object.hasOwn(input, 'policy') ? ['policy'] : []), ...(Object.hasOwn(input, 'skippedCaseIds') ? ['skippedCaseIds'] : [])]);
  ensure(!Object.hasOwn(input, 'policy') || input.policy && typeof input.policy === 'object' && !Array.isArray(input.policy));
  ensure(!Object.hasOwn(input, 'skippedCaseIds') || Array.isArray(input.skippedCaseIds));
  const { state, targetEntryId, seed, history } = input, patch = input.policy ?? {};
  exact(patch, Object.keys(patch).filter(k => ['repeats', 'degradationThreshold', 'maxEstimatedTokens'].includes(k)));
  const policy = { ...WIKI_HOLDOUT_VALIDATION_POLICY, ...patch }; validatePolicy(policy);
  ensure(id(targetEntryId) && typeof seed === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(seed) && Array.isArray(state?.cases)
    && new Set(state.cases.map((c: any) => c.id)).size === state.cases.length && Array.isArray(state.versions?.at(-1)?.entries)
    && Array.isArray(input.records) && Array.isArray(input.replayChecks));
  const entries = state.versions.at(-1).entries;
  ensure(new Set(entries.map((e: any) => e.id)).size === entries.length && entries.some((e: any) => e.id === targetEntryId && e.status === 'approved'));
  const otherEntryIds = entries.filter((e: any) => e.status === 'approved' && e.id !== targetEntryId).map((e: any) => e.id).sort(ordered) as string[];
  ensure(Array.isArray(history) && history.length <= 1000 && new Set(history.map(r => r?.caseId)).size === history.length);
  for (const r of history) {
    exact(r, ['caseId', 'caseHash', 'level', 'totalTokens', 'executions', 'evidenceHash']);
    ensure(id(r.caseId) && digest(r.caseHash) && ['trace', 'run'].includes(r.level) && count(r.totalTokens) && count(r.executions) && r.executions > 0 && digest(r.evidenceHash));
  }
  const controls = projectWikiGateControls(state, input.records, input.replayChecks);
  const candidates: ValidationCase[] = [];
  for (const view of controls) {
    if (!view.confirmed || !otherEntryIds.includes(view.binding?.pattern.entryId)) continue;
    const source = state.cases.find((c: any) => c.id === view.caseId);
    if (wikiSourceFamily(source) !== 'GPT') continue;
    const b = view.binding, level = source.sealedCheckpointId ? 'trace' as const : 'run' as const;
    const measured = history.find(r => r.caseId === source.id && r.caseHash === b.caseHash && r.level === level);
    const usage = measured ? { totalTokens: measured.totalTokens, executions: measured.executions, evidenceHash: measured.evidenceHash } : null;
    const tokensPerExecution = usage ? Math.ceil(usage.totalTokens / usage.executions) : null;
    const estimatedTokens = tokensPerExecution === null ? null : tokensPerExecution * (2 * policy.repeats + policy.maxExtraAttemptsPerCase);
    ensure(estimatedTokens === null || count(estimatedTokens));
    candidates.push({ caseId: source.id, entryId: b.pattern.entryId, caseHash: b.caseHash, level, controlHash: view.confirmation.hash,
      precheck: { id: b.precheckId, planHash: b.precheckPlanHash, resultHash: b.precheckResultHash, rubricHash: b.rubricHash },
      usage, tokensPerExecution, estimatedTokens, skipped: false });
  }
  const rank = (c: ValidationCase) => wikiValueHash({ seed, caseId: c.caseId });
  candidates.sort((a, b) => (a.level === b.level ? 0 : a.level === 'run' ? -1 : 1)
    || orderedCost(a.tokensPerExecution, b.tokensPerExecution) || ordered(rank(a), rank(b)) || ordered(a.caseId, b.caseId));
  const cases = otherEntryIds.flatMap(entryId => candidates.find(c => c.entryId === entryId) ?? []);
  const skipped = input.skippedCaseIds ?? [];
  ensure(Array.isArray(skipped) && new Set(skipped).size === skipped.length && skipped.every(caseId => cases.some(c => c.caseId === caseId)));
  cases.forEach(c => c.skipped = skipped.includes(c.caseId));
  const payload = { kind: 'wiki-holdout-validation-selection-v1' as const, targetEntryId, seed, policy, otherEntryIds, cases,
    caseIds: cases.filter(c => !c.skipped).map(c => c.caseId), uncovered: coverage(otherEntryIds, cases), ...budget(cases, policy) };
  return validateWikiHoldoutValidationSelection({ ...payload, hash: wikiValueHash(payload) });
}
function orderedCost(a: number | null, b: number | null) { return a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1; }
function validateResults(s: WikiHoldoutValidationSelection, results: WikiExperimentCaseResult[]) {
  ensure(Array.isArray(results) && new Set(results.map(r => r?.caseId)).size === results.length, RESULT);
  for (const c of results) {
    exact(c, ['caseId', 'status', 'runs'], RESULT);
    ensure(s.caseIds.includes(c.caseId) && ['completed', 'error', 'not-run', 'unsupported'].includes(c.status) && Array.isArray(c.runs)
      && c.runs.length <= 2 * s.policy.repeats + 5 && (!['not-run', 'unsupported'].includes(c.status) || !c.runs.length), RESULT);
    const attempts = { original: 0, candidate: 0 }, slots = { original: 0, candidate: 0 }, valid = { original: 0, candidate: 0 };
    let next: 'original' | 'candidate' = 'original', replacements = 0;
    for (const r of c.runs) {
      exact(r, ['variant', 'iteration', 'status', ...(Object.hasOwn(r, 'judgeError') ? ['judgeError'] : [])], RESULT);
      ensure(!Object.hasOwn(r, 'judgeError') || r.judgeError === true && r.status === 'error', RESULT);
      if (slots[next] === s.policy.repeats) next = next === 'original' ? 'candidate' : 'original';
      ensure(r.variant === next && r.iteration === ++attempts[next] && slots[next] < s.policy.repeats && ['pass', 'fail', 'invalid', 'error'].includes(r.status), RESULT);
      if (r.status === 'pass' || r.status === 'fail') valid[next]++;
      if (r.status === 'invalid' || r.status === 'error' && !r.judgeError) replacements++; else slots[next]++;
      next = next === 'original' ? 'candidate' : 'original';
    }
    ensure(replacements <= 5 && (c.status !== 'completed' || valid.original === s.policy.repeats && valid.candidate === s.policy.repeats), RESULT);
  }
}
export function decideWikiHoldoutValidation(selection: WikiHoldoutValidationSelection, gateOutcome: 'accepted' | 'rejected' | 'indeterminate', results: WikiExperimentCaseResult[]) {
  const s = validateWikiHoldoutValidationSelection(selection);
  ensure(['accepted', 'rejected', 'indeterminate'].includes(gateOutcome), RESULT); validateResults(s, results);
  ensure(gateOutcome === 'accepted' && s.budgetStatus === 'ready' || results.every(r => r.status === 'not-run' && r.runs.length === 0), RESULT);
  const active = s.cases.filter(c => !c.skipped);
  const totals = (runs: WikiExperimentCaseResult['runs'], variant: 'original' | 'candidate') => {
    const rows = runs.filter(r => r.variant === variant), passed = rows.filter(r => r.status === 'pass').length, failed = rows.filter(r => r.status === 'fail').length;
    return { passed, failed, total: passed + failed, invalid: rows.filter(r => r.status === 'invalid').length, errors: rows.filter(r => r.status === 'error').length };
  };
  const cases = active.map(c => {
    const row = results.find(r => r.caseId === c.caseId) ?? { status: 'not-run', runs: [] };
    const original = totals(row.runs, 'original'), candidate = totals(row.runs, 'candidate'), loss = original.passed - candidate.passed;
    return { caseId: c.caseId, entryId: c.entryId, level: c.level, status: row.status, original, candidate, loss,
      degraded: row.status === 'completed' ? loss >= s.policy.degradationThreshold : null };
  });
  const degraded = cases.some(c => c.degraded === true), complete = cases.every(c => c.status === 'completed');
  const runnable = gateOutcome === 'accepted' && s.budgetStatus === 'ready';
  const outcome = gateOutcome === 'rejected' ? 'gate-rejected' : !runnable ? 'indeterminate' : degraded ? 'validation-degraded'
    : !complete ? 'indeterminate' : !s.uncovered.length ? 'validation-passed' : !active.length ? 'validation-uncovered' : 'validation-partial-coverage';
  return { policy: 'wikiskill-holdout-validation-v1', outcome, adoptionEligible: runnable && complete && !degraded,
    validation: { status: gateOutcome !== 'accepted' ? 'not-run' : s.budgetStatus !== 'ready' ? s.budgetStatus : degraded ? 'degraded' : !complete ? 'incomplete' : 'passed',
      repeats: s.policy.repeats, degradationThreshold: s.policy.degradationThreshold, cases, uncovered: structuredClone(s.uncovered),
      estimatedTokens: s.estimatedTokens, maxEstimatedTokens: s.policy.maxEstimatedTokens,
      byLevel: Object.fromEntries(['trace', 'run'].map(level => {
        const chosen = active.filter(c => c.level === level), runs = results.filter(r => chosen.some(c => c.caseId === r.caseId)).flatMap(r => r.runs);
        return [level, { caseIds: chosen.map(c => c.caseId), original: totals(runs, 'original'), candidate: totals(runs, 'candidate') }];
      })) } };
}
