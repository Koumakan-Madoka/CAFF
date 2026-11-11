// Read-only historical WHOLE-output costs from the current confirmed control's
// exact trusted original-precheck result. Ordinary comparison summaries strip
// usage; usageComplete alone, raw operator JSONL and native-call counts are not
// cost evidence. Legacy/missing counts remain unknown without rewriting bytes.
import { projectWikiGateControls } from './wiki-gate-control';
import { wikiSourceFamily } from './wiki-evaluation-suite';
import { wikiExactKeys, wikiValueHash, wikiRubricFail as fail } from './wiki-rubric';
import type { WikiOriginalPrecheckAttempt } from './wiki-original-precheck';
import type { WikiHoldoutUsageHistory } from './wiki-holdout-validation';
const INVALID = 'wiki_holdout_usage_invalid';
function ensure(v: unknown): asserts v { if (!v) throw fail(INVALID); }
export function projectWikiHoldoutUsageHistory(input: { state: any; records: any[]; replayChecks: any[] }): WikiHoldoutUsageHistory[] {
  wikiExactKeys(input, ['state', 'records', 'replayChecks']);
  const { state, records, replayChecks } = input;
  ensure(Array.isArray(state?.cases) && new Set(state.cases.map((c: any) => c.id)).size === state.cases.length && Array.isArray(records) && Array.isArray(replayChecks));
  // This projection validates all immutable packets and current exact consent.
  const controls = projectWikiGateControls(state, records, replayChecks), history: WikiHoldoutUsageHistory[] = [];
  for (const view of controls) {
    if (!view.confirmed) continue;
    const b = view.binding, source = state.cases.find((c: any) => c.id === view.caseId);
    if (wikiSourceFamily(source) !== 'GPT') continue;
    const record = records.find(r => r.reservation.id === b.precheckId);
    ensure(record?.result && record.reservation.plan.planHash === b.precheckPlanHash && wikiValueHash(record.result) === b.precheckResultHash);
    const runs: WikiOriginalPrecheckAttempt[] = record.result.runs;
    // Do not average a favorable subset, fall back to older evidence or turn
    // unknown historical counters into free validation. Full sample required.
    if (record.result.status !== 'completed' || !runs.length || runs.some(r => !r.usageComplete || !r.usage || !['pass', 'fail'].includes(r.status))) continue;
    const totalTokens = runs.reduce((n, r) => n + r.usage!.totalTokens, 0); ensure(Number.isSafeInteger(totalTokens) && totalTokens >= 0);
    history.push({ caseId: source.id, caseHash: b.caseHash, level: source.sealedCheckpointId ? 'trace' : 'run', totalTokens, executions: runs.length,
      evidenceHash: wikiValueHash({ kind: 'wiki-holdout-precheck-usage-v1', precheckId: b.precheckId, planHash: b.precheckPlanHash, resultHash: b.precheckResultHash }) });
  }
  ensure(history.length <= 1000);
  return history.sort((a, b) => a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0);
}
