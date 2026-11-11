// Synthetic production-shaped v4 results, using the real planner/scorer/store.
// No provider, credential, tool execution or container is used.
const base = '../../build/server/domain/runtime/badcase-capture/';
module.exports = async function fixture(t, { scenario = 'partial' } = {}) {
  const h = require('./wiki-holdout-full-batch.cjs')(t);
  h.mutate(s => {
    for (const v of s.versions) {
      for (const n of [3, 4, 5]) v.entries.push({ id: 'entry-' + n, status: 'approved', caseIds: [], guideline: '合成未覆盖模式' });
      v.entries.sort((a, b) => Number(a.id.slice(6)) - Number(b.id.slice(6)));
      v.createdAt = '2026-11-11T00:00:00.000Z'; v.unclassified = [];
      for (const e of v.entries) Object.assign(e, { title: e.id === 'entry-6' ? '模式6：调用前核对参数' : e.id === 'entry-1' ? '模式1：稳定对照' : `模式${e.id.slice(6)}：其他任务`,
        failureMode: '未核对约束', symptoms: '参数超限', rootCauseHypothesis: '忽略前置条件' });
    }
  });
  if (scenario === 'degraded') {
    h.twoControls();
    h.sync();
  }
  if (scenario === 'uncovered') { h.mutate(s => s.controlConfirmations = []); h.sync(); }
  if (scenario === 'budget') h.config.evaluation.validation.policy = { maxEstimatedTokens: 1 };
  const f = require('./wiki-holdout-full-execution.cjs')(h, { gateCandidatePasses: scenario === 'rejected' ? 0 : 6, validationLoss: ['degraded', 'degraded-last'].includes(scenario) ? 2 : 0 });
  const result = require(base + 'wiki-comparison-store').createWikiComparisonStore(h.config).save(await f.run());
  function data() {
    const s = h.store.read();
    s.casePatterns = require(base + 'wiki-initial-split').projectWikiPatternLabels(s);
    s.pipelineStates = require(base + 'wiki-pipeline').projectWikiPipelineStates({ state: s, originalPrechecks: h.records.list(),
      replayChecks: require(base + 'wiki-pipeline-prechecks').readWikiPipelineInputs(s, h.cache) });
    s.caseStates = h.store.getCaseStates();
    s.targets = require(base + 'wiki-targets').listWikiTargets(); s.inductionRuns = []; s.events ??= []; s.suggestions ??= [];
    s.comparisons = [result]; s.executions = []; s.runReplays = [];
    s.cases = require(base + 'wiki-suite').wikiDisplayCases(s.cases);
    return s;
  }
  return { ...h, f, result, data };
};
