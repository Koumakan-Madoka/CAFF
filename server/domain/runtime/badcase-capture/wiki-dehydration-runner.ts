import { buildDehydrationRequest } from './wiki-dehydration';
import { redactTraceKnownValues } from './wiki-trace';
const fail = (code: string) => Object.assign(Error(code), { code });
// Caller must approve the exact redacted projection before any external send.
// Credentials/client stay injected and in memory; there is no tool executor,
// production DB opener, credential refresh, automatic retry or logging here.
const active = new WeakSet<object>();
export async function recommendDehydration(input: any, options: any) {
  const { store, caseId, expectedRevision, approvedRequestHash, cause } = input;
  const state = store.read();
  if (!Number.isSafeInteger(expectedRevision) || state.revision !== expectedRevision) throw fail('wiki_revision_conflict');
  const item = state.cases.find((c: any) => c.id === caseId);
  if (!item) throw fail('wiki_unknown_case');
  const built = buildDehydrationRequest({ caseRecord: item, bundle: store.readCaseTrace(caseId), cause, knownKeyValues: options.knownKeyValues || [] });
  if (built.requestHash !== approvedRequestHash) throw fail('wiki_dehydration_stale');
  const previous = store.getDehydration(caseId);
  if (previous) {
    if (previous.requestHash !== built.requestHash) throw fail('wiki_dehydration_recommendation_exists');
    return previous;
  }
  if (active.has(store)) throw fail('wiki_dehydration_busy');
  if (typeof options.client?.ask !== 'function') throw fail('wiki_dehydration_jev_unavailable');
  active.add(store);
  try {
    let response;
    try { response = await options.client.ask(built.request); }
    catch { throw fail('wiki_dehydration_jev_failed'); }
    // Revision/trace binding is checked AGAIN after the network boundary.
    return store.saveDehydrationRecommendation({ built, response: redactTraceKnownValues(response, options.knownKeyValues || []).value, expectedRevision });
  } finally { active.delete(store); }
}
