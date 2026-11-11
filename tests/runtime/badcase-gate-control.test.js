const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const base = '../../build/server/domain/runtime/badcase-capture/';
const fixture = require('../helpers/wiki-gate-control.cjs');
test('eligible gate controls require exact panel consent and freeze immutable case/rubric/precheck/pattern bindings', t => {
  const h = fixture(t), before = JSON.stringify(h.store.read()), view = h.view();
  assert.equal(view.status, 'eligible'); assert.equal(view.eligible, true); assert.match(view.proposalHash, /^[a-f0-9]{64}$/);
  assert.equal(view.binding.precheckId, h.reservation.id); assert.equal(view.binding.rubricHash, h.rubric.hash); assert.equal(view.binding.pattern.entryId, null);
  assert.equal(JSON.stringify(h.store.read()), before, 'GET does not write consent');
  const result = h.confirm(); assert.equal(result.caseId, h.c.id); assert.equal(result.proposalHash, view.proposalHash); assert.equal(result.source, 'badcase-page');
  assert.equal(h.view().status, 'confirmed'); assert.equal(h.view().confirmation.hash, result.hash);
  const frozen = JSON.stringify(h.store.read().controlConfirmations);
  assert.throws(() => h.confirm(), /wiki_control_case_frozen/);
  assert.equal(JSON.stringify(h.store.read().controlConfirmations), frozen);
  const rows = require(base + 'wiki-pipeline').projectWikiPipelineStates({ state: h.store.read(), replayChecks: require(base + 'wiki-pipeline-prechecks').readWikiPipelineInputs(h.store.read(), h.cache), originalPrechecks: h.records.list() });
  assert.equal(rows[0].precheck.reproduced, false); assert.equal(rows[0].control.status, 'confirmed'); assert.equal(rows[0].inLibrary, true);
});
test('not all passed, missing confirmed label, wrong split or stale consent cannot create a control', t => {
  for (const options of [{ statuses: ['pass', 'pass', 'fail'] }, { statuses: ['pass', 'pass', 'invalid'] }, { statuses: ['pass', 'pass', 'error'] }, { split: 'train' }, { label: false }]) {
    const h = fixture(t, options), before = JSON.stringify(h.store.read()); assert.equal(h.view().eligible, false);
    assert.throws(() => h.confirm(), /wiki_control_case_ineligible/); assert.equal(JSON.stringify(h.store.read()), before);
  }
  const h = fixture(t); assert.throws(() => h.confirm({ proposalHash: 'f'.repeat(64) }), /wiki_control_case_stale/);
  assert.throws(() => h.confirm({ expectedRevision: 0 }), /wiki_revision_conflict/);
  assert.throws(() => h.confirm({ candidateId: 'not-allowed' }), /wiki_invalid_input/);
});
for (const legacy of [false, true]) test(`original test-split ${legacy ? 'historical' : 'new'} prechecks can be confirmed without changing split or prior records`, t => {
  const h = fixture(t, { split: 'test' }), original = h.store.read().cases[0], bytes = fs.readFileSync(h.file);
  const resultFile = path.join(h.scope.globalRoot, 'original-prechecks', h.reservation.id + '.result.json');
  if (legacy) {
    const envelope = JSON.parse(fs.readFileSync(resultFile, 'utf8')); envelope.result.summary.controlEligible = false;
    envelope.hash = require(base + 'wiki-rubric').wikiValueHash(envelope.result); fs.writeFileSync(resultFile, JSON.stringify(envelope));
  }
  const precheckBytes = fs.readFileSync(resultFile);
  assert.equal(h.view().status, 'eligible'); const confirmation = h.confirm();
  assert.equal(h.view().status, 'confirmed'); assert.equal(h.view().confirmation.hash, confirmation.hash);
  assert.deepEqual(h.store.read().cases[0], original); assert.equal(original.split, 'test'); assert.deepEqual(fs.readFileSync(h.file), bytes);
  const rows = require(base + 'wiki-pipeline').projectWikiPipelineStates({ state: h.store.read(), replayChecks: require(base + 'wiki-pipeline-prechecks').readWikiPipelineInputs(h.store.read(), h.cache), originalPrechecks: h.records.list() });
  assert.equal(rows[0].inLibrary, true); assert.equal(rows[0].control.confirmed, true); assert.deepEqual(fs.readFileSync(resultFile), precheckBytes);
});
test('historical gate confirmations keep their exact text and hash and remain confirmed', t => {
  const h = fixture(t), state = h.store.read(), confirmation = require(base + 'wiki-gate-control').createWikiGateControlConfirmation(state, h.c.id, h.view().proposalHash, h.records.list(), require(base + 'wiki-pipeline-prechecks').readWikiPipelineInputs(state, h.cache));
  confirmation.confirmationRecord = '用户在 WikiSkill 面板确认原版预检结果、冻结断言、门槛组及模式身份；冻结为其他模式的防误伤对照，不表示采纳候选或授权执行。';
  const { hash: oldHash, ...payload } = confirmation; confirmation.hash = require(base + 'wiki-rubric').wikiValueHash(payload);
  state.controlConfirmations = [confirmation]; const before = JSON.stringify(state);
  const view = require(base + 'wiki-gate-control').projectWikiGateControls(state, h.records.list(), require(base + 'wiki-pipeline-prechecks').readWikiPipelineInputs(state, h.cache))[0];
  assert.equal(view.status, 'confirmed'); assert.equal(view.confirmation.hash, confirmation.hash); assert.equal(JSON.stringify(state), before);
});
test('a guessed or incomplete classification cannot masquerade as the confirmed control pattern', t => {
  const h = fixture(t, { label: false }), state = h.store.read();
  state.classifications.push({ caseId: h.c.id, entryId: null, source: 'guessed' });
  const checks = require(base + 'wiki-pipeline-prechecks').readWikiPipelineInputs(state, h.cache);
  const view = require(base + 'wiki-gate-control').projectWikiGateControls(state, h.records.list(), checks)[0];
  assert.equal(view.eligible, false); assert.equal(view.reason, 'control_pattern_confirmation_required');
});
test('configured control threshold is frozen with its precheck, not silently reset to the default', t => {
  const h = fixture(t, { statuses: ['pass', 'pass', 'pass', 'fail'], policy: { repeats: 4, controlThreshold: .75 } });
  assert.equal(h.view().eligible, true); const record = h.confirm(); assert.equal(h.view().status, 'confirmed');
  assert.equal(record.binding.precheckPlanHash, h.reservation.plan.planHash);
});
test('changed precheck data invalidates an outstanding proposal even without a Wiki revision change', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const h = fixture(t), old = h.view(), revision = h.store.read().revision;
  t.mock.timers.setTime(Date.now() + 1000); h.save(); assert.equal(h.store.read().revision, revision);
  assert.notEqual(h.view().proposalHash, old.proposalHash);
  assert.throws(() => h.confirm({ proposalHash: old.proposalHash }), /wiki_control_case_stale/);
});
test('confirmation cannot be amended; changed underlying evidence disables use without rewriting confirmation history', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const h = fixture(t), confirmation = h.confirm(), bytes = JSON.stringify(confirmation);
  t.mock.timers.setTime(Date.now() + 1000); h.save(['fail', 'fail', 'pass']);
  assert.equal(h.view().status, 'stale'); assert.equal(h.view().eligible, false); assert.equal(JSON.stringify(h.store.read().controlConfirmations[0]), bytes);
  assert.throws(() => h.confirm(), /wiki_control_case_frozen/);
});
test('frozen control assertions cannot get a new draft or freeze a draft prepared before confirmation', t => {
  const h = fixture(t), draft = h.store.saveRubricDraft({ caseId: h.c.id, model: h.rubric.model, questions: [], scoringModel: null, toolCheck: h.rubric.toolCheck }, h.store.read().revision);
  h.confirm(); const before = JSON.stringify(h.store.read());
  assert.throws(() => h.store.saveRubricDraft({ caseId: h.c.id, model: h.rubric.model, questions: [], scoringModel: null, toolCheck: h.rubric.toolCheck }, h.store.read().revision), /wiki_control_case_frozen/);
  assert.throws(() => h.store.confirmRubric({ rubricId: draft.id, hash: draft.hash, confirmationRecord: 'not permitted' }, h.store.read().revision), /wiki_control_case_frozen/);
  assert.equal(JSON.stringify(h.store.read()), before);
});
test('malformed or amended confirmation bindings cannot survive snapshot integrity validation', t => {
  const h = fixture(t); h.confirm(); const state = h.store.read(), c = state.controlConfirmations[0];
  c.binding.rubricHash = 'f'.repeat(64);
  const file = path.join(h.scope.globalRoot, 'snapshots', String(state.revision).padStart(12, '0') + '.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, checksum: require('node:crypto').createHash('sha256').update(JSON.stringify(state)).digest('hex'), record: state }));
  assert.throws(() => h.store.read(), /wiki_record_invalid/);
});
test('new consent is an optional snapshot extension; old snapshots/precheck files keep bytes and hashes on read', t => {
  const h = fixture(t), state = h.store.read(); assert.equal(Object.hasOwn(state, 'controlConfirmations'), false);
  const snapshot = fs.readFileSync(h.file), directory = path.join(h.scope.globalRoot, 'original-prechecks'), files = new Map(fs.readdirSync(directory).map(f => [f, fs.readFileSync(path.join(directory, f))]));
  h.view(); h.view(); assert.deepEqual(fs.readFileSync(h.file), snapshot); h.confirm();
  assert.deepEqual(fs.readFileSync(h.file), snapshot, 'confirmation appends a new snapshot');
  for (const [file, bytes] of files) assert.deepEqual(fs.readFileSync(path.join(directory, file)), bytes);
  assert.equal(h.store.read().events.at(-1).type, 'gate-control-confirmed');
});
test('HTTP confirmation is local-admin/CSRF/revision/hash guarded and responds with complete fresh state', async t => {
  const h = fixture(t), options = { ...h.scope, projectManager: { listProjects: () => [] }, host: '127.0.0.1', port: 4313, csrfToken: 'synthetic-csrf' };
  const controller = require('../../build/server/api/badcase-wiki-controller').createBadcaseWikiController(options);
  const { PassThrough } = require('node:stream');
  async function invoke(body, patch = {}) {
    const req = new PassThrough(); req.method = body ? 'POST' : 'GET'; req.socket = { remoteAddress: patch.remoteAddress || '127.0.0.1' };
    req.headers = { host: '127.0.0.1:4313', origin: 'http://127.0.0.1:4313', 'x-caff-csrf-token': 'synthetic-csrf', 'content-type': 'application/json', ...patch.headers };
    let result; const res = { writeHead(s) { this.status = s; }, end(b) { result = { status: this.status, body: JSON.parse(b) }; } };
    const pending = controller({ req, res, pathname: patch.pathname || (body ? '/api/wikiskill/control-confirm' : '/api/wikiskill') }); req.end(body ? JSON.stringify(body) : undefined);
    assert.equal(await pending, true); return result;
  }
  const get = await invoke(), view = get.body.pipelineStates[0].control;
  const body = { confirmed: true, caseId: h.c.id, proposalHash: view.proposalHash, expectedRevision: get.body.revision };
  for (const patch of [{ remoteAddress: '10.1.1.1' }, { headers: { origin: 'http://evil.test' } }, { headers: { 'x-caff-csrf-token': '' } }]) await assert.rejects(invoke(body, patch));
  for (const [change, code] of [[{ confirmed: false }, 'wiki_confirmation_required'], [{ expectedRevision: 0 }, 'wiki_revision_conflict'], [{ proposalHash: 'f'.repeat(64) }, 'wiki_control_case_stale'], [{ mode: 'auto' }, 'wiki_invalid_input']]) {
    await assert.rejects(invoke({ ...body, ...change }), e => e.issues?.[0]?.code === code);
  }
  const confirmed = await invoke(body); assert.equal(confirmed.body.revision, get.body.revision + 1); assert.equal(confirmed.body.pipelineStates[0].control.status, 'confirmed');
  assert.deepEqual(confirmed.body, (await invoke()).body); assert.equal(confirmed.body.pipelineStates[0].inLibrary, true);
  let calls = 0; options.runRubricDraft = () => { calls++; };
  await assert.rejects(invoke({ confirmed: true, caseId: h.c.id, expectedRevision: confirmed.body.revision }, { pathname: '/api/wikiskill/draft-rubric' }), e => e.issues?.[0]?.code === 'wiki_control_case_frozen');
  assert.equal(calls, 0, 'frozen controls reject a paid draft before invoking any configured model');
});
