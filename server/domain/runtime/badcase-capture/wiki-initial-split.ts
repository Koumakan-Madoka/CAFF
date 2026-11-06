// Initial assignment is a pure, revision-bound proposal. Unlike the legacy
// regroup policy, quotas are independent per confirmed pattern and existing
// splits never move. No candidate or scoring outcomes enter these ranks.
import crypto from 'node:crypto';
import { WIKI_REGROUP_SEED } from './wiki-regroup';
import { assignPatternQuotaSplit } from './wiki-split';
import { wikiSourceFamily } from './wiki-evaluation-suite';
import { wikiGoalCaseNumber, wikiDisplayCases } from './wiki-suite';
const hash = (v: any) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const emptyCounts = () => ({ trace: { train: 0, gate: 0, test: 0 }, run: { train: 0, gate: 0, test: 0 } });
export function projectWikiPatternLabels(state: any) {
  const entries = (state.versions.at(-1)?.entries || []).filter((e: any) => e.status === 'approved');
  return state.cases.map((c: any) => {
    const explicit = state.patternLabels?.find((r: any) => r.caseId === c.id);
    const classification = state.classifications?.find((r: any) => r.caseId === c.id);
    // Reviewed training membership is already confirmed. A holdout's version
    // links or preclassification suggestion are not confirmation of a label.
    const override = state.caseStates?.find((r: any) => r.caseId === c.id);
    const memberships = c.split === 'train' ? (override ? override.memberships.map((m: any) => m.entryId)
      : entries.filter((e: any) => e.caseIds.includes(c.id)).map((e: any) => e.id)) : [];
    const ids = [...new Set(memberships)] as string[];
    const confirmed = Boolean(explicit || classification || ids.length === 1);
    const entryId = explicit ? explicit.entryId : classification ? classification.entryId : ids.length === 1 ? ids[0] : null;
    const options = entries.map((e: any) => ({ entryId: e.id, title: e.title })).sort((a: any, b: any) => a.entryId.localeCompare(b.entryId));
    return { caseId: c.id, confirmed, entryId, patternKey: confirmed ? entryId ?? 'unclassified' : null,
      source: explicit ? 'badcase-page' : classification ? classification.source : ids.length === 1 ? 'approved-membership' : null,
      labelHash: hash({ case: c, options }), options };
  }).sort((a: any, b: any) => a.caseId.localeCompare(b.caseId));
}
export function planWikiInitialSplit(state: any, accounting: any[]) {
  const labels = new Map(projectWikiPatternLabels(state).map((r: any) => [r.caseId, r]));
  // Unknown labels on existing groups hide quota occupancy. Do not allocate
  // any pattern until those labels are known, or a later label confirmation
  // could silently take its run gate count above the frozen trace capacity.
  const displayNumbers = new Map<string, number>(wikiDisplayCases(state.cases).map(c => [c.id, c.displayNumber]));
  const blockers = (state.cases as any[]).filter(c => ['train', 'gate', 'test'].includes(c.split) && wikiSourceFamily(c) === 'GPT'
    && ![4, 10, 14].includes(wikiGoalCaseNumber(c.id)!) && !(labels.get(c.id) as any).confirmed)
    .map(c => ({ caseId: c.id, caseNumber: displayNumbers.get(c.id)!, reason: 'pattern_label_unconfirmed' }))
    .sort((a, b) => a.caseNumber - b.caseNumber || a.caseId.localeCompare(b.caseId));
  const rows = (state.cases as any[]).map((c: any) => {
    const label: any = labels.get(c.id);
    const decision = (state.dehydrations || []).findLast((r: any) => r.caseId === c.id && r.traceHash === c.traceBundle?.hash)?.decision;
    const originals = accounting.filter(r => r.caseId === c.id && r.traceHash === c.traceBundle?.hash && r.decisionHash === decision?.hash
      && r.variant?.kind === 'original' && !r.excludedReason).sort((a, b) => a.id.localeCompare(b.id));
    const valid = originals.some(r => r.baselineStatus === 'valid_output' && r.caseEligibleForGateAndScreen === true);
    const level = c.sealedCheckpointId ? 'trace' : decision?.level === 'reference' ? 'reference' : 'run';
    const reason = wikiSourceFamily(c) !== 'GPT' ? 'non_gpt_report_only'
      : [4, 10, 14].includes(wikiGoalCaseNumber(c.id)!) ? 'legacy_test_source'
      : !label.confirmed ? 'pattern_label_unconfirmed'
      : level === 'reference' ? 'reference_only'
      : !c.sealedCheckpointId && (decision?.level !== 'run' || decision?.kind !== 'single' || !c.traceBundle?.hash) ? 'dehydration_not_confirmed'
      : !c.sealedCheckpointId && !valid ? originals.some(r => r.baselineStatus === 'no_valid_output') ? 'baseline_no_valid_output' : 'baseline_pending'
      : null;
    // Nonhistorical public numbers depend on presentation/import order. Bind
    // identity, not that display number, so ranks and hashes are reproducible.
    return { caseId: c.id, caseNumber: wikiGoalCaseNumber(c.id), patternKey: label.patternKey, previousSplit: c.split, level, reason,
      traceHash: c.traceBundle?.hash || null, checkpointId: c.sealedCheckpointId || null, decisionHash: decision?.hash || null,
      originalEvidence: originals.map(r => ({ id: r.id, resultHash: r.resultHash, baselineStatus: r.baselineStatus })),
      proposedSplit: null as 'train' | 'gate' | 'test' | null };
  }).sort((a, b) => a.caseId.localeCompare(b.caseId));
  const patterns = [...new Set(rows.map(r => r.patternKey).filter(Boolean))].sort().map(patternKey => {
    const members = rows.filter(r => r.patternKey === patternKey), counts = emptyCounts();
    for (const r of members.filter(r => !r.reason && ['train', 'gate', 'test'].includes(r.previousSplit))) {
      if (r.level === 'trace' || r.level === 'run') counts[r.level][r.previousSplit as 'train' | 'gate' | 'test']++;
    }
    const existingCounts = structuredClone(counts);
    for (const level of ['trace', 'run'] as const) {
      if (blockers.length) continue;
      const ranked = members.filter(r => !r.reason && r.previousSplit === null && r.level === level)
        .map(r => ({ r, rank: hash([WIKI_REGROUP_SEED, level, r.caseId]) }))
        .sort((a, b) => a.rank.localeCompare(b.rank) || a.r.caseId.localeCompare(b.r.caseId));
      for (const { r } of ranked) {
        const n = counts.run.train + counts.run.gate;
        const split = level === 'trace' ? assignPatternQuotaSplit(counts.trace)
          : counts.run.gate < counts.trace.gate && (n + 1 - 3 * counts.run.gate) > (2 * (n + 1) - 3 * counts.run.train) ? 'gate' : 'train';
        r.proposedSplit = split; counts[level][split]++;
      }
    }
    return { patternKey, existingCounts, counts, rows: members };
  });
  const inputHash = hash(rows.map(({ proposedSplit, ...evidence }) => evidence));
  const content = { schemaVersion: 1, policy: 'initial-per-pattern-trace-run-v1', seed: WIKI_REGROUP_SEED, inputHash, rows, patterns,
    blockingReason: blockers.length ? 'assigned_pattern_labels_unconfirmed' : null,
    blockingMessage: blockers.length ? `先确认 ${blockers.map(r => '#' + r.caseNumber).join('、')} 的模式标签` : null, blockers };
  return { ...content, hash: hash(content) };
}
