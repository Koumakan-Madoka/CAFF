import { buildDehydrationRequest, buildDehydrationPrefix, DEHYDRATION_MODEL, interpretDehydrationAnswer, pageDehydrationCause } from './wiki-dehydration';
import { wikiGoalCaseNumber } from './wiki-suite';
import { redactTraceKnownValues } from './wiki-trace';
const fail = (code: string) => Object.assign(Error(code), { code });
// Caller must approve the exact redacted projection before any external send.
// Credentials/client stay injected and in memory; there is no tool executor,
// production DB opener, credential refresh or logging. Offline JSON/schema parse
// failure gets one identical retry; the page uses manual policy and one call.
// One manual retry is allowed only for a new page parse failure. Old rows stay immutable.
export function pageRecommendationAvailability(item: any, previous: any) {
  const eligible = !!item?.traceBundle && item?.source?.agentId === 'role-family-gpt'
    && ![4, 10, 14].includes(wikiGoalCaseNumber(item?.id)!) && !previous?.decision
    && (!previous || previous.recommendation?.retryPolicy === 'manual' && previous.recommendation?.fallbackReason === 'parse_failed' && !previous.retryOf);
  return { eligible };
}
export function preparePageDehydration(input: any) {
  const { store, caseId, traceHash, expectedRevision, retryOf } = input, state = store.read();
  if (!Number.isSafeInteger(expectedRevision) || state.revision !== expectedRevision) throw fail('wiki_revision_conflict');
  if ((state.deletedCases || []).some((r: any) => r.case.id === caseId)) throw fail('wiki_case_deleted');
  const item = state.cases.find((c: any) => c.id === caseId);
  if (!item) throw fail('wiki_unknown_case');
  const previous = store.getDehydration(caseId);
  if (previous?.decision) throw fail('wiki_dehydration_frozen');
  if (!pageRecommendationAvailability(item, null).eligible) throw fail('wiki_dehydration_ineligible');
  if (typeof traceHash !== 'string' || !/^[a-f0-9]{64}$/.test(traceHash) || item.traceBundle.hash !== traceHash) throw fail('wiki_dehydration_stale');
  if (retryOf !== undefined && (!previous || previous.hash !== retryOf)) throw fail('wiki_dehydration_stale');
  if (previous && (!retryOf || !pageRecommendationAvailability(item, previous).eligible)) throw fail('wiki_dehydration_recommendation_exists');
  const bundle = store.readCaseTrace(caseId), cause = pageDehydrationCause(bundle);
  const built = buildDehydrationRequest({ caseRecord: item, bundle, cause });
  // Check the same prefix constraints as the writer BEFORE reading auth or sending.
  buildDehydrationPrefix(item, bundle, built.markedStep);
  return { ...input, cause, approvedRequestHash: built.requestHash };
}
const active = new WeakSet<object>();
export async function recommendDehydration(input: any, options: any) {
  const { store, caseId, expectedRevision, approvedRequestHash, cause, retryOf } = input;
  const state = store.read();
  if (!Number.isSafeInteger(expectedRevision) || state.revision !== expectedRevision) throw fail('wiki_revision_conflict');
  const item = state.cases.find((c: any) => c.id === caseId);
  if (!item) throw fail('wiki_unknown_case');
  const built = buildDehydrationRequest({ caseRecord: item, bundle: store.readCaseTrace(caseId), cause, knownKeyValues: options.knownKeyValues || [] });
  if (built.requestHash !== approvedRequestHash) throw fail('wiki_dehydration_stale');
  const previous = store.getDehydration(caseId);
  if (previous) {
    if (retryOf !== undefined) {
      if (previous.hash !== retryOf || !pageRecommendationAvailability(item, previous).eligible || previous.requestHash !== built.requestHash) throw fail('wiki_dehydration_recommendation_exists');
    } else {
      if (previous.requestHash !== built.requestHash) throw fail('wiki_dehydration_recommendation_exists');
      return previous;
    }
  }
  if (active.has(store)) throw fail('wiki_dehydration_busy');
  if (typeof options.client?.ask !== 'function') throw fail('wiki_dehydration_model_unavailable');
  active.add(store);
  try {
    const manual = options.retryPolicy === 'manual', limit = manual ? 1 : 2;
    const response: any = { model: DEHYDRATION_MODEL, ...(manual ? { retryPolicy: 'manual' } : {}), attempts: [] };
    for (let n = 0; n < limit; n++) {
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
    return store.saveDehydrationRecommendation({ built, response, expectedRevision, ...(retryOf === undefined ? {} : { retryOf }) });
  } finally { active.delete(store); }
}
