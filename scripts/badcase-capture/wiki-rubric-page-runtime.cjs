// Page -> existing host-only draft generator. Reads only operator-selected
// credentials and registered sealed tasks, never a browser-provided path/prompt.
const { readPageRuntimeConfig } = require('./wiki-page-runtime.cjs');
const { draftWikiRubrics, prepareWikiRubricDraft } = require('./draft-wiki-rubrics.cjs');
const { readProductionScoringTask } = require('./production-scoring-plan.cjs');
async function runPageRubricDraft(input, { configFile } = {}, dependencies = {}) {
  const { store, caseId, expectedRevision, scope } = input;
  // Reject stale/unknown selection before reading runtime config or a key.
  prepareWikiRubricDraft(store, [caseId], expectedRevision);
  const config = readPageRuntimeConfig(configFile);
  const replay = store.read().replayCases.find(r => r.sourceCaseId === caseId);
  const tasks = replay ? { [caseId]: (dependencies.readTask || readProductionScoringTask)(replay, scope) } : {};
  return (dependencies.draft || draftWikiRubrics)({ store, caseIds: [caseId], expectedRevision, tasks,
    credentialDir: config.credentialDir, confirmed: true }, dependencies);
}
module.exports = { runPageRubricDraft };
