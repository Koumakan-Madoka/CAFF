// Synthetic host catalog for the production-shaped mode-6 holdouts. No model,
// transport, judge credentials, container or filesystem scene is involved.
const fixture = require('./wiki-mode-holdout.cjs');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { wikiValueHash: hash } = require(base + 'wiki-rubric');
module.exports = function planFixture(options) {
  const h = fixture(options);
  const gate = require(base + 'wiki-holdout-gate').planWikiHoldoutGate(h.input());
  const catalog = gate.caseIds.map(id => {
    const c = h.state.cases.find(c => c.id === id), selected = gate.cases.find(c => c.caseId === id);
    const execution = selected.level === 'run' ? { level: 'run', traceBundleHash: c.traceBundle.hash,
      dehydrationHash: h.state.dehydrations.find(d => d.caseId === id).decision.hash, requestHash: hash('synthetic request ' + id) } : undefined;
    return { id, sceneHash: execution ? require(base + 'wiki-experiment-plan').wikiExperimentRunSceneHash(execution) : hash('synthetic bound scene ' + id),
      task: 'Synthetic original task ' + id, actual: c.actual, expected: c.expected, hardAssertions: { kind: 'completion-public-reply-v1' },
      rubric: h.state.rubrics.find(r => r.caseId === id), ...(execution ? { execution } : {}) };
  });
  const definition = { kind: 'wiki-experiment-v3', variants: [{ id: 'original', promptHash: hash('synthetic original prompt') }, { id: 'candidate', promptHash: hash('synthetic candidate prompt') }],
    runner: { model: 'openai-codex/gpt-6.1-sol', settings: { thinking: 'xhigh', fast: false } }, repeats: 10, executionPolicy: 'alternating-valid-v1',
    decision: { kind: 'wikiskill-holdout-gate-v1', alpha: .05, maxExtraAttemptsPerCase: 5 }, cases: gate.caseIds.map(caseId => ({ caseId, judge: null })) };
  return { ...h, catalog, definition, gate, plan() { return require(base + 'wiki-holdout-plan').createWikiHoldoutExperimentPlan(this.definition, this.catalog, this.gate); } };
};
