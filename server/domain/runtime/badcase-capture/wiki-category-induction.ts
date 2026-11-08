// Category identity and learned content have distinct trust boundaries. These
// selectors contain no model prose and are shared by planning/store validation.
const fail = (code: string) => Object.assign(Error(code), { code });
export function wikiUnlinkedCategoryCaseIds(state: any): Set<string> {
  const linked = new Set((state.pendingPatternLinks || []).map((r: any) => r.pendingPatternId));
  return new Set((state.patternLabels || []).filter((r: any) => r.pendingPatternId && !linked.has(r.pendingPatternId)).map((r: any) => r.caseId));
}
export function wikiCategoryTrainingCases(state: any, pendingPatternId: any) {
  if (typeof pendingPatternId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(pendingPatternId)) throw fail('wiki_invalid_identifier');
  const pending = state.pendingPatterns?.find((p: any) => p.id === pendingPatternId);
  if (!pending) throw fail('wiki_pending_pattern_not_found');
  if (state.pendingPatternLinks?.some((r: any) => r.pendingPatternId === pendingPatternId)) throw fail('wiki_pending_pattern_link_frozen');
  const members = (state.patternLabels || []).filter((r: any) => r.pendingPatternId === pendingPatternId)
    .map((r: any) => state.cases.find((c: any) => c.id === r.caseId));
  if (!members.length || members.some((c: any) => !c || c.role !== 'GPT' || c.source?.agentId !== 'role-family-gpt' || !['train', 'gate', 'test'].includes(c.split))) throw fail('wiki_category_not_ready');
  const cases = members.filter((c: any) => c.split === 'train').sort((a: any, b: any) => a.id.localeCompare(b.id));
  if (!cases.length) throw fail('wiki_category_not_ready');
  if (cases.length > 20) throw fail('wiki_collection_too_large');
  return { pending, cases };
}
export function assertWikiCategoryDraftAvailable(state: any, pendingPatternId: string) {
  if (state.versions.at(-1)?.entries.some((e: any) => e.sourcePendingPatternId === pendingPatternId && e.categoryReviewRequired === true && e.status === 'draft')) throw fail('wiki_category_draft_pending');
}
