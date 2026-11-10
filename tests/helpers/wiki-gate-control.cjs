// Owned production-shaped gate case with synthetic already-scored prechecks.
// No model/provider/scene execution. The gate assignment is historical fixture
// data, NOT an API for selecting a favorable split.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const base = '../../build/server/domain/runtime/badcase-capture/';
module.exports = function fixture(t, { statuses = ['pass', 'pass', 'pass'], policy, split = 'gate', label = true } = {}) {
  const h = require('./wiki-scene-run.cjs')(t), store = h.store;
  if (label) {
    const view = require(base + 'wiki-initial-split').projectWikiPatternLabels(store.read())[0];
    store.confirmPatternLabel({ caseId: h.c.id, entryId: null, labelHash: view.labelHash, expectedRevision: store.read().revision });
  }
  const state = store.read(); state.cases[0].split = split;
  const replay = { id: 'synthetic-replay', sourceCaseId: h.c.id, checkpointHash: 'c'.repeat(64), request: { association: { checkpointId: h.c.sealedCheckpointId } } }; state.replayCases = [replay];
  const file = path.join(h.scope.globalRoot, 'snapshots', String(state.revision).padStart(12, '0') + '.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, checksum: crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex'), record: state }));
  const { createWikiPipelinePrecheckStore, readWikiPipelineInputs } = require(base + 'wiki-pipeline-prechecks'), cache = createWikiPipelinePrecheckStore(h.scope);
  cache.getOrCompute({ level: 'trace', replayId: replay.id, checkpointHash: replay.checkpointHash }, () => ({ status: 'supported' }));
  const records = require(base + 'wiki-original-precheck-store').createWikiOriginalPrecheckStore(h.scope);
  function save(values = statuses, selected = policy) {
    const current = store.read(), plan = require(base + 'wiki-original-precheck').createWikiOriginalPrecheckPlan({ state: current, caseId: h.c.id, rubricHash: h.rubric.hash, inputHash: 'd'.repeat(64), replayChecks: readWikiPipelineInputs(current, cache), ...(selected ? { policy: selected } : {}) });
    const r = records.reserve(plan); records.finish(r.id, { status: 'completed', reason: null, runs: values.map((status, i) => ({ iteration: i + 1, variant: 'original', status, artifactId: 'synthetic-' + i, artifactHash: 'e'.repeat(64), usageComplete: true })) }); return r;
  }
  const reservation = save();
  const view = () => store.getGateControls().find(r => r.caseId === h.c.id);
  const confirm = (patch = {}) => store.confirmGateControl({ caseId: h.c.id, proposalHash: view().proposalHash, expectedRevision: store.read().revision, ...patch });
  return { ...h, records, cache, replay, file, reservation, save, view, confirm };
};
