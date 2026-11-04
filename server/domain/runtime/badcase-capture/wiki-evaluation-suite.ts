// D15 production suite projection. Frozen groups are data, never caller labels.
// Classification approval is separate from learning: no held-out trace/prose is
// added to a wiki version, and non-GPT sources cannot affect GPT conclusions.
import { wikiRoundStage } from './wiki-suite';
const fail = (code: string) => Object.assign(Error(code), { code });
export function wikiSourceFamily(source: any): string | null {
  const agent = source?.source?.agentId;
  if (agent === 'role-family-gpt') return 'GPT';
  if (typeof agent === 'string' && agent.startsWith('role-family-')) return agent.slice('role-family-'.length);
  return source?.kind !== 'marked-badcase' && source?.role === 'GPT' ? 'GPT' : null;
}
export function wikiConfirmedClassification(state: any, source: any): any {
  const saved = (state.classifications || []).find((c: any) => c.caseId === source.id);
  if (!saved || !['manual', 'model-confirmed'].includes(saved.source)
    || typeof saved.confirmedAt !== 'string' || !Number.isFinite(Date.parse(saved.confirmedAt))) throw fail('wiki_classification_confirmation_required');
  if (saved.entryId !== null && !state.versions.at(-1)?.entries.some((e: any) => e.id === saved.entryId && e.status === 'approved')) throw fail('wiki_classification_confirmation_required');
  return saved;
}
export function planWikiEvaluationSuite(state: any, selections: any[], targetEntryId: string): any {
  if (!Array.isArray(selections) || !selections.length || selections.length > 20
    || !state.versions.at(-1)?.entries.some((e: any) => e.id === targetEntryId && e.status === 'approved')) throw fail('evaluation_gate_config_invalid');
  const seen = new Set();
  const cases = selections.map(item => {
    if (!item || typeof item !== 'object' || !['reproduction', 'probe', 'control'].includes(item.category)
      || seen.has(item.sourceCaseId)) throw fail('evaluation_batch_cases_invalid');
    seen.add(item.sourceCaseId);
    const source = state.cases.find((c: any) => c.id === item.sourceCaseId);
    if (!source) throw fail('evaluation_batch_cases_invalid');
    const marked = source.kind === 'marked-badcase';
    const stage = marked ? source.split : wikiRoundStage(source.id);
    if (!['gate', 'test'].includes(stage) || marked && !source.preclassification) throw fail('evaluation_batch_split_invalid');
    let classification = null;
    if (marked && item.category === 'reproduction') classification = wikiConfirmedClassification(state, source);
    const legacyEntry = state.versions.at(-1)?.entries.find((e: any) => e.id === targetEntryId && e.status === 'approved');
    const target = item.category === 'reproduction' && (marked ? classification?.entryId === targetEntryId : legacyEntry?.caseIds.includes(source.id));
    const family = wikiSourceFamily(source), reportOnly = family !== 'GPT';
    return { sourceCaseId: source.id, category: item.category, split: source.split, stage, family, reportOnly,
      targetReproduction: target && !reportOnly,
      ...(classification ? { classification: { entryId: classification.entryId, source: classification.source, confirmedAt: classification.confirmedAt } } : {}) };
  });
  const ordered = cases.sort((a: any, b: any) => a.sourceCaseId.localeCompare(b.sourceCaseId));
  const select = (stage: string) => ordered.filter((c: any) => c.stage === stage).map((c: any) => c.sourceCaseId);
  const targets = (stage: string) => ordered.filter((c: any) => c.stage === stage && c.targetReproduction).map((c: any) => c.sourceCaseId);
  return { cases: ordered, gateCaseIds: select('gate'), testCaseIds: select('test'),
    targetReproductionCaseIds: targets('gate'), targetTestReproductionCaseIds: targets('test'),
    reportOnlyCaseIds: ordered.filter((c: any) => c.reportOnly).map((c: any) => c.sourceCaseId) };
}
