// Scoped production-shaped full v4 host fixture. Mode 6 #22 training/#23/#24
// holdouts; mode 1 #17/#18 controls. All prechecks, transports and usage fake.
const base = '../../build/server/domain/runtime/badcase-capture/';
const { planWikiHoldoutValidation } = require(base + 'wiki-holdout-validation');
module.exports = function fullBatchFixture(t) {
  const h = require('./wiki-holdout-batch.cjs')(t);
  h.mutate(s => s.versions[0].entries.push({ id: 'entry-2', status: 'approved', caseIds: [], guideline: 'Synthetic uncovered mode' }));
  const usage = n => ({ input: n - 3, output: 1, cacheRead: 1, cacheWrite: 1, totalTokens: n });
  const confirm = id => {
    const view = h.store.getGateControls().find(v => v.caseId === id);
    h.store.confirmGateControl({ caseId: id, proposalHash: view.proposalHash, expectedRevision: h.store.read().revision });
  };
  for (const [i, n] of [[0, 100], [1, 200]]) {
    const id = h.marked[i].id, old = h.records.list().find(r => r.reservation.plan.caseId === id), claim = h.records.reserve(old.reservation.plan);
    h.records.finish(claim.id, { status: 'completed', reason: null, runs: old.result.runs.map(r => ({ ...r, status: 'pass', usage: usage(n) })) }); confirm(id);
  }
  h.config.evaluation = { kind: 'wikiskill-mode-holdout-v1', targetEntryId: 'entry-6', validation: { seed: 'fixed-validation-seed' } };
  const gateIds = h.config.cases.map(c => c.sourceCaseId);
  const item = id => ({ ...structuredClone(h.config.cases.find(c => gateIds.includes(c.sourceCaseId))), sourceCaseId: id, category: 'control', rubricHash: h.store.read().rubrics.find(r => r.caseId === id).hash });
  function select() {
    const input = require('../../scripts/badcase-capture/production-holdout-suite.cjs').readProductionHoldoutValidationEvidence(h.scope, h.store.read(), 'entry-6', h.config.evaluation.validation);
    return planWikiHoldoutValidation(input);
  }
  function sync() {
    const selection = select(), old = h.config.cases;
    h.config.cases = [...old.filter(c => gateIds.includes(c.sourceCaseId)), ...selection.caseIds.map(id => old.find(c => c.sourceCaseId === id) ?? item(id))];
    h.config.experiment.definition.cases = [...gateIds, ...selection.caseIds].map(caseId => ({ caseId, judge: null }));
    return selection;
  }
  sync();
  function run18() {
    const id = h.marked[1].id;
    h.mutate(s => s.controlConfirmations = s.controlConfirmations.filter(c => c.caseId !== id));
    if (!h.config.cases.some(c => c.sourceCaseId === id)) h.config.cases.push(item(id));
    const made = h.makeRunCase(18, { pass: true, usage: usage(200) }); confirm(id); sync(); return made;
  }
  function twoControls() {
    const id = h.marked[1].id;
    h.mutate(s => {
      s.controlConfirmations = s.controlConfirmations.filter(c => c.caseId !== id);
      s.patternLabels.find(c => c.caseId === id).entryId = 'entry-2';
    });
    confirm(id); sync();
  }
  return { ...h, sync, select, run18, confirm, usage, twoControls };
};
