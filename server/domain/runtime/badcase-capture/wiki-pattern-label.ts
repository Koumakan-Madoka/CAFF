// Resolve manual pending-pattern consent without rewriting its frozen label.
// A link changes grouping/evaluation identity, never training membership.
export function resolveWikiPatternLabel(state: any, label: any) {
  if (!label.pendingPatternId) return { entryId: label.entryId, patternKey: label.entryId ?? 'unclassified' };
  const pending = state.pendingPatterns?.find((p: any) => p.id === label.pendingPatternId);
  if (!pending) throw Object.assign(Error('wiki_record_invalid'), { code: 'wiki_record_invalid' });
  const link = state.pendingPatternLinks?.find((r: any) => r.pendingPatternId === pending.id);
  return { entryId: link?.entryId ?? null, patternKey: link?.entryId ?? pending.id,
    pendingPatternId: pending.id, pendingPatternName: pending.name };
}
export function wikiPendingPatternOptions(state: any) {
  return (state.pendingPatterns || []).map((p: any) => ({ id: p.id, name: p.name,
    entryId: state.pendingPatternLinks?.find((r: any) => r.pendingPatternId === p.id)?.entryId ?? null }))
    .sort((a: any, b: any) => a.id.localeCompare(b.id));
}
