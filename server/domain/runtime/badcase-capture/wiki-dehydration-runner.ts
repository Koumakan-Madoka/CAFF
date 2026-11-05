import { buildDehydrationRequest, DEHYDRATION_MODEL, interpretDehydrationAnswer } from './wiki-dehydration';
import { redactTraceKnownValues } from './wiki-trace';
const fail = (code: string) => Object.assign(Error(code), { code });
// Caller must approve the exact redacted projection before any external send.
// Credentials/client stay injected and in memory; there is no tool executor,
// production DB opener, credential refresh or logging. Only JSON/schema parse
// failure gets one identical retry; network errors and bad evidence do not.
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
  if (typeof options.client?.ask !== 'function') throw fail('wiki_dehydration_model_unavailable');
  active.add(store);
  try {
    const response: any = { model: DEHYDRATION_MODEL, attempts: [] };
    for (let n = 0; n < 2; n++) {
      if (store.read().revision !== expectedRevision) throw fail('wiki_revision_conflict');
      let attempt;
      try { attempt = await options.client.ask(structuredClone(built.request)); }
      catch { throw fail('wiki_dehydration_model_failed'); }
      const safe = redactTraceKnownValues(attempt, options.knownKeyValues || []).value;
      // A JSON answer can escape known bytes (e.g. \\uXXXX). Replace after
      // decoding as well, before any parsed answer can enter Wiki storage.
      if (typeof safe?.content === 'string') {
        let decoded;
        try { decoded = JSON.parse(safe.content); } catch { /* Preserve malformed output for the bounded retry. */ }
        if (decoded !== undefined) {
          const replaced = redactTraceKnownValues(decoded, options.knownKeyValues || []);
          if (replaced.count) safe.content = JSON.stringify(replaced.value);
        }
      }
      response.attempts.push(safe);
      if (store.read().revision !== expectedRevision) throw fail('wiki_revision_conflict');
      try { interpretDehydrationAnswer(built, response); break; }
      catch (e: any) { if (e.code !== 'wiki_dehydration_answer_invalid' || n === 1) throw e; }
    }
    // Revision/trace binding is checked AGAIN inside the writer lock.
    return store.saveDehydrationRecommendation({ built, response, expectedRevision });
  } finally { active.delete(store); }
}
