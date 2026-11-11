// Mode-local holdout selection and the v4 gate kernel. Deliberately separate
// from wiki-gate-policy: v1-v3 readers keep their original bytes and decisions.
// These pure APIs neither authorize execution nor create/adopt a baseline.
import { wikiConfirmedClassification, wikiSourceFamily } from './wiki-evaluation-suite';
import { projectWikiOriginalPrechecks } from './wiki-original-precheck-projection';
import { fisherImprovement } from './wiki-gate-policy';
import { wikiValueHash } from './wiki-rubric';
import type { WikiExperimentCaseResult } from './wiki-experiment-plan';
const SELECTION = 'wiki_holdout_gate_selection_invalid', RESULT = 'wiki_holdout_gate_result_invalid';
const fail = (code: string) => Object.assign(Error(code), { code });
function ensure(value: unknown, code = SELECTION): asserts value { if (!value) throw fail(code); }
function exact(value: any, keys: string[], code = SELECTION) {
  ensure(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(','), code);
}
const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const reasons = ['non_gpt_report_only', 'precheck_missing', 'precheck_incomplete', 'precheck_not_reproduced'] as const;
interface HoldoutCase {
  caseId: string; caseHash: string; originalSplit: 'gate' | 'test'; level: 'trace' | 'run';
  eligible: boolean; reason: typeof reasons[number] | null;
  precheck: { id: string; planHash: string; resultHash: string; rubricHash: string } | null;
}
export interface WikiHoldoutGateSelection {
  kind: 'wiki-holdout-gate-selection-v1'; targetEntryId: string; cases: HoldoutCase[]; caseIds: string[]; hash: string;
}
// Self-contained integrity validation for retained selections. Trusted planning
// must reconstruct against current state/evidence before an eventual execution;
// a locally rehashed proof is not an attestation against a hostile same user.
export function validateWikiHoldoutGateSelection(value: WikiHoldoutGateSelection): WikiHoldoutGateSelection {
  exact(value, ['kind', 'targetEntryId', 'cases', 'caseIds', 'hash']);
  ensure(value.kind === 'wiki-holdout-gate-selection-v1' && id(value.targetEntryId) && digest(value.hash)
    && Array.isArray(value.cases) && value.cases.length <= 1000 && Array.isArray(value.caseIds));
  for (const row of value.cases) {
    exact(row, ['caseId', 'caseHash', 'originalSplit', 'level', 'eligible', 'reason', 'precheck']);
    ensure(id(row.caseId) && digest(row.caseHash) && ['gate', 'test'].includes(row.originalSplit)
      && ['trace', 'run'].includes(row.level) && typeof row.eligible === 'boolean');
    ensure(row.eligible ? row.reason === null && row.precheck !== null : reasons.includes(row.reason as typeof reasons[number]));
    if (row.precheck !== null) {
      exact(row.precheck, ['id', 'planHash', 'resultHash', 'rubricHash']);
      ensure(typeof row.precheck.id === 'string' && /^precheck-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.precheck.id)
        && [row.precheck.planHash, row.precheck.resultHash, row.precheck.rubricHash].every(digest));
    }
  }
  const ids = value.cases.map(c => c.caseId);
  ensure(new Set(ids).size === ids.length && JSON.stringify(ids) === JSON.stringify([...ids].sort())
    && JSON.stringify(value.caseIds) === JSON.stringify(value.cases.filter(c => c.eligible).map(c => c.caseId)));
  const { hash, ...payload } = value; ensure(hash === wikiValueHash(payload));
  return structuredClone(value);
}
export function planWikiHoldoutGate(input: { state: any; records: any[]; replayChecks: any[]; targetEntryId: string }): WikiHoldoutGateSelection {
  exact(input, ['state', 'records', 'replayChecks', 'targetEntryId']);
  const { state, records, replayChecks, targetEntryId } = input;
  ensure(id(targetEntryId) && Array.isArray(state?.cases) && new Set(state.cases.map((c: any) => c.id)).size === state.cases.length
    && state.versions?.at(-1)?.entries.some((e: any) => e.id === targetEntryId && e.status === 'approved')
    && Array.isArray(records) && Array.isArray(replayChecks));
  const prechecks = projectWikiOriginalPrechecks(state, records, replayChecks);
  const cases: HoldoutCase[] = [];
  for (const source of state.cases) {
    // Preserve the frozen split, including old tests. Training never becomes a
    // holdout merely because a caller asks for it or it has a useful score.
    if (!['gate', 'test'].includes(source.split)) continue;
    let classification;
    try { classification = wikiConfirmedClassification(state, source); }
    catch (error) {
      // Missing confirmation is not target membership. Conflicting/invalid
      // saved consent, on the other hand, must not silently hide a case.
      if (state.patternLabels?.some((r: any) => r.caseId === source.id) || state.classifications?.some((r: any) => r.caseId === source.id)) throw error;
      continue;
    }
    if (classification.entryId !== targetEntryId) continue;
    const view = prechecks.find((p: any) => p.caseId === source.id), current = view?.current;
    const measured = records.find(r => r.reservation.id === current?.id);
    const reason: HoldoutCase['reason'] = wikiSourceFamily(source) !== 'GPT' ? 'non_gpt_report_only'
      : !current ? 'precheck_missing' : current.status !== 'completed' ? 'precheck_incomplete'
      : !view.reproduced ? 'precheck_not_reproduced' : null;
    cases.push({ caseId: source.id, caseHash: wikiValueHash(source), originalSplit: source.split,
      // A scene-backed cut is report-only and cannot masquerade as a run gate.
      level: source.sealedCheckpointId ? 'trace' : 'run', eligible: reason === null, reason,
      precheck: current && measured?.result ? { id: current.id, planHash: current.planHash,
        resultHash: wikiValueHash(measured.result), rubricHash: current.rubricHash } : null });
  }
  cases.sort((a, b) => a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0);
  const payload = { kind: 'wiki-holdout-gate-selection-v1' as const, targetEntryId, cases, caseIds: cases.filter(c => c.eligible).map(c => c.caseId) };
  return validateWikiHoldoutGateSelection({ ...payload, hash: wikiValueHash(payload) });
}
// Same ten valid outputs per arm, alternating execution, and five shared
// environment/invalid replacements. Terminal judge errors consume a slot and
// make the gate indeterminate; they never turn into model failures or passes.
function validateResults(selection: WikiHoldoutGateSelection, results: WikiExperimentCaseResult[]) {
  ensure(Array.isArray(results) && new Set(results.map(r => r?.caseId)).size === results.length, RESULT);
  for (const result of results) {
    exact(result, ['caseId', 'status', 'runs'], RESULT);
    ensure(selection.caseIds.includes(result.caseId) && ['completed', 'error', 'not-run', 'unsupported'].includes(result.status)
      && Array.isArray(result.runs) && result.runs.length <= 25
      && (!['not-run', 'unsupported'].includes(result.status) || !result.runs.length), RESULT);
    const attempts = { original: 0, candidate: 0 }, slots = { original: 0, candidate: 0 }, valid = { original: 0, candidate: 0 };
    let next: 'original' | 'candidate' = 'original', replacements = 0;
    for (const row of result.runs) {
      exact(row, ['variant', 'iteration', 'status', ...(Object.hasOwn(row, 'judgeError') ? ['judgeError'] : [])], RESULT);
      ensure(!Object.hasOwn(row, 'judgeError') || row.judgeError === true && row.status === 'error', RESULT);
      if (slots[next] === 10) next = next === 'original' ? 'candidate' : 'original';
      ensure(row.variant === next && row.iteration === ++attempts[next] && slots[next] < 10
        && ['pass', 'fail', 'invalid', 'error'].includes(row.status), RESULT);
      if (row.status === 'pass' || row.status === 'fail') valid[next]++;
      if (row.status === 'invalid' || row.status === 'error' && !row.judgeError) replacements++;
      else slots[next]++;
      next = next === 'original' ? 'candidate' : 'original';
    }
    ensure(replacements <= 5 && (result.status !== 'completed' || valid.original === 10 && valid.candidate === 10), RESULT);
  }
}
export function decideWikiHoldoutGate(selection: WikiHoldoutGateSelection, results: WikiExperimentCaseResult[]) {
  validateWikiHoldoutGateSelection(selection); validateResults(selection, results);
  const selected = selection.cases.filter(c => c.eligible);
  const rows = selected.map(c => ({ ...c, ...(results.find(r => r.caseId === c.caseId) ?? { status: 'not-run', runs: [] }) }));
  const totals = (cases: typeof rows, variant: 'original' | 'candidate') => {
    const attempts = cases.flatMap(c => c.runs).filter(r => r.variant === variant);
    const passed = attempts.filter(r => r.status === 'pass').length, failed = attempts.filter(r => r.status === 'fail').length;
    return { passed, failed, total: passed + failed, invalid: attempts.filter(r => r.status === 'invalid').length, errors: attempts.filter(r => r.status === 'error').length };
  };
  const original = totals(rows, 'original'), candidate = totals(rows, 'candidate');
  const complete = rows.length > 0 && rows.every(c => c.status === 'completed');
  const pValue = original.total && candidate.total ? fisherImprovement(original.passed, original.total, candidate.passed, candidate.total) : null;
  const passed = complete && pValue !== null && pValue < .05 && candidate.passed > original.passed;
  const byLevel = Object.fromEntries(['trace', 'run'].map(level => {
    const cases = rows.filter(c => c.level === level);
    return [level, { caseIds: cases.map(c => c.caseId), original: totals(cases, 'original'), candidate: totals(cases, 'candidate') }];
  }));
  return { policy: 'wikiskill-holdout-gate-v1', outcome: !complete ? 'indeterminate' : passed ? 'accepted' : 'rejected',
    repair: { caseIds: selection.caseIds.slice(), original: { passed: original.passed, total: original.total },
      candidate: { passed: candidate.passed, total: candidate.total }, pValue, alpha: .05, passed },
    ignoredCaseIds: selection.cases.filter(c => !c.eligible).map(c => c.caseId),
    warnings: selected.length === 1 ? ['只有 1 道门槛题'] : [], byLevel };
}
