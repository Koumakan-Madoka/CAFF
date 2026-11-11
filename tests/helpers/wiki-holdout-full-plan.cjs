// Synthetic production identities: mode 6 #22 train, #23/#24 holdouts;
// other-mode controls #17/#18 stay in mode 1. No model or live store.
const fixture = require('./wiki-holdout-plan.cjs');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { wikiValueHash: hash } = require(base + 'wiki-rubric');
module.exports = function fullPlanFixture() {
  const h = fixture();
  h.state.versions[0].entries.push({ id: 'entry-2', status: 'approved', caseIds: [] });
  const c = h.marked[1]; c.sealedCheckpointId = null;
  const content = { caseId: c.id, kind: 'single', level: 'run', traceHash: c.traceBundle.hash, cutStep: 42 };
  h.state.dehydrations.push({ caseId: c.id, traceHash: c.traceBundle.hash, decision: { ...content, hash: require(base + 'wiki-run-replay').wikiRunHash(content) } });
  h.replayChecks.splice(h.replayChecks.findIndex(r => r.caseId === c.id), 1, { caseId: c.id, level: 'run', status: 'supported', traceHash: c.traceBundle.hash, decisionHash: h.state.dehydrations.at(-1).decision.hash, cutStep: 42 });
  for (const number of [17, 18]) {
    const source = h.marked[number - 17];
    h.save(number, Array(source.sealedCheckpointId ? 3 : 5).fill('pass'), { createdAt: '2026-11-11T00:00:01.000Z' });
    const api = require(base + 'wiki-gate-control'), view = api.projectWikiGateControls(h.state, h.records, h.replayChecks).find(r => r.caseId === source.id);
    h.state.controlConfirmations.push(api.createWikiGateControlConfirmation(h.state, source.id, view.proposalHash, h.records, h.replayChecks));
  }
  h.history = h.marked.map(c => ({ caseId: c.id, caseHash: hash(c), level: c.sealedCheckpointId ? 'trace' : 'run', totalTokens: c.sealedCheckpointId ? 300 : 600, executions: 3, evidenceHash: hash('synthetic usage ' + c.id) }));
  const gateInput = h.input.bind(h);
  h.current = () => ({ ...gateInput(), seed: 'fixed-validation-seed', history: h.history, ...(h.policy ? { policy: h.policy } : {}), ...(h.skippedCaseIds ? { skippedCaseIds: h.skippedCaseIds } : {}) });
  h.select = () => require(base + 'wiki-holdout-validation').planWikiHoldoutValidation(h.current());
  h.selection = h.select();
  h.addControls = function () {
    this.definition.cases = this.definition.cases.filter(c => this.gate.caseIds.includes(c.caseId));
    this.catalog = this.catalog.filter(c => this.gate.caseIds.includes(c.id));
    for (const id of this.selection.caseIds) {
      const source = this.state.cases.find(c => c.id === id), row = this.selection.cases.find(c => c.caseId === id);
      const execution = row.level === 'run' ? { level: 'run', traceBundleHash: source.traceBundle.hash, dehydrationHash: this.state.dehydrations.find(d => d.caseId === id).decision.hash, requestHash: hash('synthetic request ' + id) } : undefined;
      this.catalog.push({ id, sceneHash: execution ? require(base + 'wiki-experiment-plan').wikiExperimentRunSceneHash(execution) : hash('synthetic bound scene ' + id),
        task: 'Synthetic original task ' + id, actual: source.actual, expected: source.expected, hardAssertions: { kind: 'completion-public-reply-v1' },
        rubric: this.state.rubrics.filter(r => r.caseId === id).at(-1), ...(execution ? { execution } : {}) });
      this.definition.cases.push({ caseId: id, judge: null });
    }
  };
  h.addControls();
  h.fullPlan = function () { return require(base + 'wiki-holdout-validation-plan').createWikiHoldoutFullExperimentPlan(this.definition, this.catalog, this.gate, this.selection); };
  return h;
};
