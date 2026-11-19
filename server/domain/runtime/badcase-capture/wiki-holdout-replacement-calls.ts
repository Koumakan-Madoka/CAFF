// V4 completion exception only: unknown worker calls must be attributable to
// verified recoverable error attempts, never successful outputs or lost rows.
// A retained completed case carries every row's boolean flag so a missing flag
// cannot silently move an unavailable call to a favorable output. No token
// count is inferred, and the existing schedule still validates five replacements.
import { isWikiJudgeTechnicalError } from './wiki-scoring-v2';
export function wikiHoldoutReplacementCallFlags(rows: any[]): boolean[] | null {
  if (!Array.isArray(rows) || !rows.length) return null;
  const flags: boolean[] = [];
  let unavailable = 0, replacements = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || row.callsUnavailable !== undefined && typeof row.callsUnavailable !== 'boolean') return null;
    const flag = row.callsUnavailable ?? row.tokenUsage?.callsUnavailable;
    if (typeof flag !== 'boolean') return null;
    if (row.tokenUsage !== undefined && (!row.tokenUsage || typeof row.tokenUsage.callsUnavailable !== 'boolean'
      || row.tokenUsage.callsUnavailable !== flag || flag && row.tokenUsage.complete !== false)) return null;
    if (row.status === 'invalid' || row.status === 'error' && !isWikiJudgeTechnicalError(row.assessment)) replacements++;
    if (flag) {
      if (row.status !== 'error' || row.cleaned !== true || isWikiJudgeTechnicalError(row.assessment)
        || !['evaluation_codex_proxy_failed', 'evaluation_codex_gateway_unavailable', 'evaluation_codex_server_overloaded'].includes(row.reason)) return null;
      unavailable++;
    }
    flags.push(flag);
  }
  return unavailable > 0 && replacements <= 5 ? flags : null;
}
