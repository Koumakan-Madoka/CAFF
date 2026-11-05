// Pure proposal only. No group is active until a separately authorized confirmation.
// These two strata use the existing 2:1:1 quota (trace) and its 2:1 train/gate
// projection (run). A fixed seed ranks IDs, never model quality or candidate results.
import crypto from 'node:crypto';
import { assignPatternQuotaSplit } from './wiki-split';
import { wikiDisplayCases, wikiGoalCaseNumber } from './wiki-suite';
import { wikiSourceFamily } from './wiki-evaluation-suite';
export const WIKI_REGROUP_SEED = 'wikiskill-trace-run-stratified-v1';
const hash = (v: any) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function planWikiRegroup(state: any, accounting: any[]) {
  const rows = wikiDisplayCases(state.cases).map(c => {
    const d = (state.dehydrations || []).find((v: any) => v.caseId === c.id && v.traceHash === c.traceBundle?.hash)?.decision;
    const originals = accounting.filter(r => r.caseId === c.id && r.traceHash === c.traceBundle?.hash && r.decisionHash === d?.hash
      && r.variant?.kind === 'original' && !r.excludedReason).sort((a, b) => a.id.localeCompare(b.id));
    const valid = originals.some(r => r.baselineStatus === 'valid_output' && r.caseEligibleForGateAndScreen === true);
    const reason = wikiSourceFamily(c) !== 'GPT' ? 'non_gpt_report_only'
      : [4, 10, 14].includes(wikiGoalCaseNumber(c.id)!) ? 'legacy_test_source'
      : d?.level === 'reference' ? 'reference_only'
      : !c.sealedCheckpointId && d?.level !== 'run' ? 'dehydration_not_confirmed'
      : !c.sealedCheckpointId && !valid ? originals.some(r => r.baselineStatus === 'no_valid_output') ? 'baseline_no_valid_output' : 'baseline_pending'
      : null;
    return { caseId: c.id, caseNumber: c.displayNumber, previousSplit: c.split, level: c.sealedCheckpointId ? 'trace' : 'run',
      traceHash: c.traceBundle?.hash || null, checkpointId: c.sealedCheckpointId || null, decisionHash: d?.hash || null,
      originalEvidence: originals.map(r => ({ id: r.id, resultHash: r.resultHash, baselineStatus: r.baselineStatus })),
      proposedSplit: null as 'train' | 'gate' | 'test' | null, reason };
  });
  const counts = { trace: { train: 0, gate: 0, test: 0 }, run: { train: 0, gate: 0, test: 0 } };
  for (const level of ['trace', 'run'] as const) {
    const ranked = rows.filter(r => !r.reason && r.level === level).map(r => ({ r, rank: hash([WIKI_REGROUP_SEED, level, r.caseId]) }))
      .sort((a, b) => a.rank.localeCompare(b.rank) || a.r.caseId.localeCompare(b.r.caseId));
    for (const { r } of ranked) {
      let split: 'train' | 'gate' | 'test';
      if (level === 'trace') split = assignPatternQuotaSplit(counts.trace);
      else {
        const n = counts.run.train + counts.run.gate;
        split = counts.run.gate < counts.trace.gate && (n + 1 - 3 * counts.run.gate) > (2 * (n + 1) - 3 * counts.run.train) ? 'gate' : 'train';
      }
      r.proposedSplit = split; counts[level][split]++;
    }
  }
  const archived = (state.deletedCases || []).map((v: any) => ({ caseId: v.case.id, caseNumber: v.caseNumber, previousSplit: v.case.split,
    proposedSplit: null, level: null, reason: 'deleted_missing_system_prompt', deletionHash: v.hash }));
  const allRows = [...rows, ...archived].sort((a, b) => a.caseId.localeCompare(b.caseId));
  const warnings = ['historical_exposure_not_blind_holdout', ...(counts.trace.test ? [] : ['no_new_trace_test'])];
  const inputHash = hash(allRows.map(({ proposedSplit, ...evidence }) => evidence));
  const content = { schemaVersion: 1, policy: 'trace-run-stratified-v1', seed: WIKI_REGROUP_SEED, inputHash, rows: allRows, counts, warnings };
  return { ...content, hash: hash(content) };
}
