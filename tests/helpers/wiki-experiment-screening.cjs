// Synthetic, explicitly scored screening evidence for owned fixtures only.
// Never execute a worker/judge or skip a production admission check.
module.exports = function screening(store, scope, cases, definition) {
  const base = '../../build/server/domain/runtime/badcase-capture/';
  const { wikiValueHash: hash } = require(base + 'wiki-rubric');
  const { createWikiPipelinePrecheckStore, readWikiPipelineInputs } = require(base + 'wiki-pipeline-prechecks');
  const records = require(base + 'wiki-original-precheck-store').createWikiOriginalPrecheckStore(scope), cache = createWikiPipelinePrecheckStore(scope);
  return function screen(ids = cases.map(c => c.sourceCaseId), { confirm = true, statuses, reserve = false } = {}) {
    for (const id of ids) {
      const state = store.read(), source = state.cases.find(c => c.id === id), rubric = state.rubrics.filter(r => r.caseId === id && r.status === 'frozen').sort((a, b) => b.version - a.version)[0];
      const replay = state.replayCases.find(r => r.sourceCaseId === id), decision = (state.dehydrations || []).findLast(r => r.caseId === id && r.traceHash === source.traceBundle?.hash)?.decision;
      const key = source.sealedCheckpointId ? { level: 'trace', replayId: replay.id, checkpointHash: replay.checkpointHash } : { level: 'run', traceHash: source.traceBundle.hash, decisionHash: decision.hash };
      cache.getOrCompute(key, () => ({ status: 'supported' }));
      const configuration = definition.kind === 'wiki-experiment-v2' ? definition.cases.find(c => c.caseId === id).judge : definition.judge;
      const judge = rubric.questions.length ? require(base + 'wiki-judge-catalog').readWikiEligibleJudges(process.env.CAFF_WIKISKILL_JUDGES_CONFIG).find(j => j.configurationHash === hash(configuration)) : null;
      const plan = require(base + 'wiki-original-precheck').createWikiOriginalPrecheckPlan({ state, caseId: id, rubricHash: rubric.hash, replayChecks: readWikiPipelineInputs(state, cache), inputHash: hash({ kind: 'synthetic-original-input', key, rubricHash: rubric.hash }), judge });
      const control = cases.find(c => c.sourceCaseId === id).category === 'control', claim = records.reserve(plan);
      if (!reserve) records.finish(claim.id, { status: 'completed', reason: null, runs: Array.from({ length: plan.policy.repeats }, (_, i) => ({ iteration: i + 1, variant: 'original', status: statuses?.[i] ?? (control ? 'pass' : 'fail'), artifactId: 'synthetic-' + i, artifactHash: hash({ kind: 'synthetic-scored-output', id, i }), usageComplete: true })) });
      if (confirm && control && !store.read().controlConfirmations?.some(c => c.caseId === id)) {
        const view = store.getGateControls().find(c => c.caseId === id);
        store.confirmGateControl({ caseId: id, proposalHash: view.proposalHash, expectedRevision: store.read().revision });
      }
    }
    return records;
  };
};
