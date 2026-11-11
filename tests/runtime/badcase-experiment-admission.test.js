// Pure planning over owned production-shaped records. No auth, restoration,
// model calls or fabricated provider replies; the scores are synthetic inputs.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { wikiValueHash: hash } = require(base + 'wiki-rubric');
const plans = require(base + 'wiki-experiment-plan');
const admission = () => require(base + 'wiki-experiment-admission');
function fixture(t, { controlMode = null, confirm = true, controlSplit = 'gate' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-admission-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = { globalRoot: path.join(root, 'wiki'), sourceWorktree: path.join(root, 'source') };
  const store = require(base + 'wiki-store').createWikiStore(scope);
  const train = store.addTextCases(Array.from({ length: 4 }, (_, n) => ({ source: { origin: 'http://127.0.0.1:3100', projectId: 'train', conversationId: 'train', messageId: 'train-' + n, agentId: 'role-family-gpt' }, role: 'GPT', actual: 'unclear ' + n, expected: 'clear ' + n, message: '', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }))).cases;
  store.setReplaySplit({ caseIds: train.map(c => c.id) });
  const version = store.saveDraft({ model: 'deepseek/deepseek-v4-flash', caseIds: train.map(c => c.id), entries: [{ title: 'Short Goal reason', failureMode: 'too long', symptoms: 'over limit', rootCauseHypothesis: 'verbosity', guideline: 'Keep reason within limit.', caseIds: train.map(c => c.id) }], unclassified: [] });
  store.review({ versionId: version.id, entryId: 'entry-1', expectedRevision: store.read().revision, decision: 'approved' });
  const sources = ['repair', 'control', 'held'].map((name, n) => store.addMarkedCase({ source: { projectId: 'synthetic', conversationId: name, conversationTitle: 'Synthetic ' + name, messageId: 'message-' + n, agentId: 'role-family-gpt' }, role: 'role-family-gpt', sealedCheckpointId: 'checkpoint-' + n, actual: 'reason too long', expected: 'reason within limit', message: 'synthetic marked reply', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }).case);
  for (const [n, c] of sources.entries()) {
    const label = require(base + 'wiki-initial-split').projectWikiPatternLabels(store.read()).find(r => r.caseId === c.id);
    store.confirmPatternLabel({ caseId: c.id, entryId: n === 1 ? controlMode : 'entry-1', labelHash: label.labelHash, expectedRevision: store.read().revision });
    const rubric = store.saveRubricDraft({ caseId: c.id, model: 'deepseek/deepseek-v4-flash', questions: [], scoringModel: null, toolCheck: { method: 'code', target: { kind: 'caff-chat', name: 'suggest-goal' }, mode: 'on-call', rules: [{ parameter: 'reason', kind: 'max-chars', max: 1000 }] } }, store.read().revision);
    store.confirmRubric({ rubricId: rubric.id, hash: rubric.hash, confirmationRecord: 'Synthetic user assertion approval' }, store.read().revision);
  }
  // Freeze historical group data only in this fixture; never allocate by score.
  const state = store.read(); sources.forEach((c, n) => state.cases.find(s => s.id === c.id).split = n === 2 ? 'test' : n === 1 ? controlSplit : 'gate');
  state.revision++; const file = path.join(scope.globalRoot, 'snapshots', String(state.revision).padStart(12, '0') + '.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, checksum: crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex'), record: state }));
  for (const [n, c] of sources.entries()) store.addReplayCase({ sourceCaseId: c.id, category: n === 1 ? 'control' : 'reproduction', task: 'Continue the task.', fixture: { commit: 'b'.repeat(40), sourceCommit: 'b'.repeat(40), sourceSubdirectory: 'sample', filesHash: 'd'.repeat(64) }, request: { captureRoot: path.join(root, 'capture-' + n), association: { projectId: 'synthetic', conversationId: c.source.conversationId, messageId: c.source.messageId, agentId: 'role-family-gpt', checkpointId: c.sealedCheckpointId, turnId: 'turn-' + n, taskId: 'task-' + n, runId: 1 }, flagId: 'flag-' + crypto.createHash('sha256').update('synthetic\0' + c.source.messageId).digest('hex') }, checkpointHash: 'c'.repeat(64), rules: { kind: 'completion-public-reply-v1' } });
  const cache = require(base + 'wiki-pipeline-prechecks').createWikiPipelinePrecheckStore(scope);
  for (const r of store.read().replayCases) cache.getOrCompute({ level: 'trace', replayId: r.id, checkpointHash: r.checkpointHash }, () => ({ status: 'supported' }));
  const records = require(base + 'wiki-original-precheck-store').createWikiOriginalPrecheckStore(scope);
  const checks = state => require(base + 'wiki-pipeline-prechecks').readWikiPipelineInputs(state, cache);
  function save(n, statuses = n === 1 ? ['pass', 'pass', 'pass'] : ['fail', 'fail', 'pass'], { status = 'completed', policy, reserve = false } = {}) {
    const state = store.read(), c = sources[n], rubric = state.rubrics.filter(r => r.caseId === c.id && r.status === 'frozen').at(-1);
    const p = require(base + 'wiki-original-precheck').createWikiOriginalPrecheckPlan({ state, caseId: c.id, rubricHash: rubric.hash, inputHash: hash('synthetic prepared original ' + n), replayChecks: checks(state), judge: null, ...(policy ? { policy } : {}) });
    const claim = records.reserve(p); if (!reserve) records.finish(claim.id, { status, reason: status === 'completed' ? null : 'operator_stop', runs: statuses.map((s, i) => ({ iteration: i + 1, variant: 'original', status: s, artifactId: 'synthetic-' + i, artifactHash: hash('retained synthetic output ' + i), usageComplete: true })) });
    return claim;
  }
  sources.forEach((_, n) => save(n));
  if (confirm && controlSplit === 'gate') {
    const view = store.getGateControls().find(r => r.caseId === sources[1].id);
    store.confirmGateControl({ caseId: sources[1].id, proposalHash: view.proposalHash, expectedRevision: store.read().revision });
  }
  const definition = { kind: 'wiki-experiment-v2', variants: [{ id: 'original', promptHash: hash('original') }, { id: 'candidate', promptHash: hash('candidate') }], runner: { model: 'openai-codex/gpt-6.1-sol', settings: { thinking: 'xhigh' } }, repeats: 10, executionPolicy: 'alternating-valid-v1', decision: { kind: 'wikiskill-gate-v1', alpha: .05, noHarmFraction: .05, minimumAllowedLoss: 1, maxExtraAttemptsPerCase: 5 }, cases: sources.map((c, n) => ({ caseId: c.id, stage: n === 2 ? 'test' : 'gate', category: n === 1 ? 'control' : 'reproduction', targetReproduction: n !== 1 })) };
  const catalog = sources.map(c => { const s = store.read(), rubric = s.rubrics.find(r => r.caseId === c.id && r.status === 'frozen'); return { id: c.id, sceneHash: hash('synthetic scene ' + c.id), task: 'Continue the task.', actual: c.actual, expected: c.expected, hardAssertions: { kind: 'completion-public-reply-v1' }, rubric }; });
  const input = () => ({ state: store.read(), records: records.list(), replayChecks: checks(store.read()), targetEntryId: 'entry-1', definition, catalog });
  const proof = (patch = {}) => admission().createWikiExperimentAdmission({ ...input(), ...patch });
  const plan = () => plans.createWikiExperimentPlan(definition, catalog, proof());
  return { store, scope, sources, records, cache, checks, save, definition, catalog, input, proof, plan };
}
const rehash = value => { const { hash: ignored, ...payload } = value; value.hash = hash(payload); return value; };
const replan = p => { const { planHash, ...payload } = p; p.planHash = hash(payload); return p; };
test('new admitted plans bind exact current original prechecks and immutable non-target control consent', t => {
  const h = fixture(t), before = JSON.stringify(h.input()), proof = h.proof(), p = h.plan();
  assert.equal(proof.kind, 'wiki-experiment-admission-v1'); assert.equal(proof.targetEntryId, 'entry-1');
  assert.equal(proof.cases.length, 3); assert.equal(proof.cases[1].controlHash, h.store.read().controlConfirmations[0].hash);
  assert.equal(proof.cases[0].controlHash, null); assert.equal(p.admission.hash, proof.hash);
  assert.deepEqual(plans.validateWikiExperimentPlan(p), p); plans.assertWikiExperimentPlan(p, h.definition, h.catalog, proof);
  assert.equal(JSON.stringify(h.input()), before, 'planning never changes source/evidence data');
  assert.doesNotMatch(JSON.stringify(proof), /reason too long|retained synthetic output|captureRoot|authorization/);
});
test('eligible without panel confirmation is not a control, even if every precheck passed', t => {
  const h = fixture(t, { confirm: false }); assert.throws(h.proof, /wiki_experiment_control_required/);
});
test('control must be a gate member outside candidate target mode', t => {
  const same = fixture(t, { controlMode: 'entry-1' }); assert.throws(same.proof, /wiki_experiment_control_target_mode/);
  for (const split of ['train', 'test']) { const h = fixture(t, { controlSplit: split }); assert.throws(h.proof, /(?:wiki|evaluation)_[a-z_]+/); }
});
test('original failures, invalids and errors cannot replace a confirmed passing control', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  for (const values of [['fail', 'fail', 'fail'], ['pass', 'pass', 'invalid'], ['pass', 'pass', 'error']]) {
    const h = fixture(t); t.mock.timers.setTime(Date.now() + 1000); h.save(1, values); assert.throws(h.proof, /wiki_experiment_control_required/);
  }
});
test('latest reserved or stopped sample blocks favorable fallback for both reproduction and control', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  for (const n of [0, 1, 2]) for (const patch of [{ reserve: true }, { status: 'stopped' }]) {
    const h = fixture(t); t.mock.timers.setTime(Date.now() + 1000); h.save(n, [], patch); assert.throws(h.proof, /wiki_experiment_(?:control|precheck)_required/);
  }
});
test('reproduction requires strict precheck failure majority, not a tie, a formal result or raw marked output', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  for (const values of [['pass', 'pass', 'pass'], ['fail', 'pass']]) {
    const h = fixture(t); t.mock.timers.setTime(Date.now() + 1000); h.save(0, values, { policy: { repeats: values.length } });
    assert.throws(h.proof, /wiki_experiment_precheck_required/);
  }
  const h = fixture(t), i = h.input(); i.records = i.records.filter(r => r.reservation.plan.caseId !== h.sources[0].id);
  i.state.comparisons = [{ originalFailed: 99 }]; assert.throws(() => h.proof(i), /wiki_experiment_precheck_required/);
});
test('new source, frozen rubric, split, replay or offline support drift invalidates admission', t => {
  for (const mutate of [i => i.state.cases.find(c => c.id === i.catalog[0].id).actual += ' changed',
    i => i.state.cases.find(c => c.id === i.catalog[0].id).split = 'test',
    i => i.state.replayCases.find(r => r.sourceCaseId === i.catalog[0].id).checkpointHash = 'f'.repeat(64),
    i => i.replayChecks.splice(0), i => i.catalog[0].rubric = i.catalog[1].rubric]) {
    const h = fixture(t), i = h.input(); mutate(i); assert.throws(() => h.proof(i), /wiki_[a-z_]+/);
  }
});
test('trace evidence never authorizes a different run packet or cut', t => {
  const h = fixture(t); h.catalog[0].execution = { level: 'run', traceBundleHash: 'a'.repeat(64), dehydrationHash: 'b'.repeat(64), requestHash: 'c'.repeat(64) };
  h.catalog[0].sceneHash = plans.wikiExperimentRunSceneHash(h.catalog[0].execution);
  assert.throws(h.proof, /wiki_experiment_precheck_changed/);
});
test('caller cannot relabel target/partition/category or omit the confirmed gate control', t => {
  for (const mutate of [h => h.definition.cases[0].targetReproduction = false, h => h.definition.cases[1].category = 'probe',
    h => h.definition.cases[0].stage = 'test', h => h.definition.cases.splice(1, 1)]) {
    const h = fixture(t); mutate(h); assert.throws(h.proof, /wiki_experiment_[a-z_]+/);
  }
});
test('admission pins evidence changes in the plan hash; old plans/rubrics remain byte-readable without live evidence', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const h = fixture(t), old = plans.createWikiExperimentPlan(h.definition, h.catalog), bytes = JSON.stringify(old), rubrics = JSON.stringify(h.catalog.map(c => c.rubric)), p = h.plan();
  assert.notEqual(old.planHash, p.planHash); assert.equal(Object.hasOwn(old, 'admission'), false);
  assert.throws(() => plans.assertWikiExperimentPlan(old, h.definition, h.catalog, h.proof()), /wiki_experiment_changed/);
  t.mock.timers.setTime(Date.now() + 1000); h.save(0); const next = h.plan(); assert.notEqual(next.planHash, p.planHash);
  assert.throws(() => plans.assertWikiExperimentPlan(p, h.definition, h.catalog, h.proof()), /wiki_experiment_changed/);
  assert.equal(JSON.stringify(plans.validateWikiExperimentPlan(old)), bytes); assert.equal(JSON.stringify(h.catalog.map(c => c.rubric)), rubrics);
  assert.deepEqual(plans.validateWikiExperimentPlan(p), p, 'historical immutable result needs no new precheck lookup');
});
test('precheck references do not enter formal gate/test denominators or alter the accepted gate formula', t => {
  const h = fixture(t), p = h.plan(), plain = plans.createWikiExperimentPlan(h.definition, h.catalog);
  const results = p.cases.filter(c => c.stage === 'gate').map(c => ({ caseId: c.caseId, status: 'completed', runs: Array.from({ length: 10 }, (_, i) => ['original', 'candidate'].map(variant => ({ variant, iteration: i + 1, status: c.category === 'control' || variant === 'candidate' && i < 6 ? 'pass' : 'fail' }))).flat() }));
  const actual = plans.decideWikiExperimentGate(p, results);
  assert.deepEqual(actual, plans.decideWikiExperimentGate(plain, results));
  assert.equal(actual.repair.original.total, 10); assert.equal(actual.noHarm.original.total, 10);
  assert.equal(actual.outcome, 'accepted');
});
test('closed admission schema and case/rubric/control bindings are validated even with freshly recomputed hashes', t => {
  const h = fixture(t), p = h.plan();
  for (const mutate of [a => a.other = true, a => a.hash = 'f'.repeat(64), a => a.cases[0].rubricHash = 'f'.repeat(64),
    a => a.cases[0].caseId = 'other', a => a.cases[1].controlHash = null, a => a.cases[0].controlHash = 'f'.repeat(64),
    a => a.cases[1].precheckId = 'not-a-claim', a => a.cases.push(a.cases[0]), a => a.cases.reverse(), a => a.cases[0].precheckResultHash = [], a => a.targetEntryId = '']) {
    const x = structuredClone(p); mutate(x.admission); if (x.admission.hash !== 'f'.repeat(64)) rehash(x.admission);
    assert.throws(() => plans.validateWikiExperimentPlan(replan(x)), /wiki_[a-z_]+/);
  }
});
