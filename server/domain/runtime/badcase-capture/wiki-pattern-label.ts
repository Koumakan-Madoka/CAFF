// Resolve manual pending-pattern consent without rewriting its frozen label.
// A link changes grouping/evaluation identity, never training membership.
import crypto from 'node:crypto';
// Shared by explicit manual linking and initial category-draft approval. Caller
// validates consent/target inside the same store transaction before appending.
export function appendWikiPendingPatternLink(state: any, pendingPatternId: string, entryId: string) {
  if (state.pendingPatternLinks?.some((r: any) => r.pendingPatternId === pendingPatternId)) throw Object.assign(Error('wiki_pending_pattern_link_frozen'), { code: 'wiki_pending_pattern_link_frozen' });
  const content = { pendingPatternId, entryId, source: 'badcase-page', confirmedRevision: state.revision, confirmedAt: new Date().toISOString() };
  const saved = { ...content, hash: crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex') };
  (state.pendingPatternLinks || (state.pendingPatternLinks = [])).push(saved);
  return saved;
}
export function resolveWikiPatternLabel(state: any, label: any) {
  if (!label.pendingPatternId) return { entryId: label.entryId, patternKey: label.entryId ?? 'unclassified' };
  const pending = state.pendingPatterns?.find((p: any) => p.id === label.pendingPatternId);
  if (!pending) throw Object.assign(Error('wiki_record_invalid'), { code: 'wiki_record_invalid' });
  const link = state.pendingPatternLinks?.find((r: any) => r.pendingPatternId === pending.id);
  return { entryId: link?.entryId ?? null, patternKey: link?.entryId ?? pending.id,
    pendingPatternId: pending.id, pendingPatternName: pending.name };
}
export function wikiPendingPatternText(value: any, field: 'name' | 'scope'): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || [...text].length > (field === 'name' ? 40 : 120) || text.includes('\0')) {
    throw Object.assign(Error('wiki_pending_pattern_' + field + '_invalid'), { code: 'wiki_pending_pattern_' + field + '_invalid' });
  }
  return text;
}
export function wikiPendingPatternOptions(state: any) {
  return (state.pendingPatterns || []).map((p: any) => ({ id: p.id, name: p.name,
    // Omit on legacy records so their old hash inputs remain byte-identical.
    ...(p.scope === undefined ? {} : { scope: p.scope, caseIds: (state.patternLabels || []).filter((l: any) => l.pendingPatternId === p.id).map((l: any) => l.caseId).sort() }),
    entryId: state.pendingPatternLinks?.find((r: any) => r.pendingPatternId === p.id)?.entryId ?? null }))
    .sort((a: any, b: any) => a.id.localeCompare(b.id));
}
