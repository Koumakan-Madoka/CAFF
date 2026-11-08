const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { PassThrough } = require('node:stream');
const { createBadcaseWikiController } = require('../../build/server/api/badcase-wiki-controller');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-wiki-api-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const captureRoot = path.join(root, 'capture'), sourceWorktree = path.join(root, 'source');
  const config = { globalRoot: captureRoot, sourceWorktree }, store = createWikiStore(config);
  const options = { globalRoot: captureRoot, sourceWorktree, projectManager: { listProjects: () => [] }, host: '127.0.0.1', port: 4313, csrfToken: 'synthetic-csrf' };
  const controller = createBadcaseWikiController(options);
  const seed = () => {
    const r = store.addTextCases([{ source: { origin: 'http://127.0.0.1:3100', projectId: 'p1', conversationId: 'c1', messageId: 'm1', agentId: 'role-family-gpt' }, role: 'GPT',
      actual: 'claim without evidence', expected: 'verify before reporting', message: 'done', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }]);
    return store.saveDraft({ caseIds: r.cases.map(c => c.id), model: 'deepseek/deepseek-v4-flash', entries: [{ title: 'Evidence', failureMode: 'unsupported claim', symptoms: 'no checks', rootCauseHypothesis: 'skipped verification', guideline: '先核验再结论。', caseIds: r.cases.map(c => c.id) }], unclassified: [] });
  };
  async function invoke(body, overrides = {}) {
    const req = new PassThrough(); req.method = body === undefined ? 'GET' : 'POST'; req.socket = { remoteAddress: overrides.remoteAddress || '127.0.0.1' };
    req.headers = { host: '127.0.0.1:4313', origin: 'http://127.0.0.1:4313', 'content-type': 'application/json', 'x-caff-csrf-token': 'synthetic-csrf', ...overrides.headers };
    let result;
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(bytes) { result = { status: this.status, headers: this.headers, body: overrides.text ? String(bytes) : JSON.parse(bytes) }; } };
    const pending = controller({ req, res, pathname: overrides.pathname || '/api/wikiskill' + (body === undefined ? '' : '/review') });
    req.end(body === undefined ? undefined : JSON.stringify(body)); assert.equal(await pending, true); return result;
  }
  return { root, config, options, store, seed, invoke };
}
const rejects = (promise, code, status = 422) => assert.rejects(promise, e => e.statusCode === status && e.issues?.[0]?.code === code);

test('pipeline statuses are a read-only addition to Wiki GET and do not start any configured model runner', async t => {
  const h = setup(t); h.seed(); const before = h.store.read();
  let calls = 0; h.options.runInduction = h.options.runDehydration = h.options.runRubricDraft = () => { calls++; throw Error('must not run'); };
  const result = await h.invoke();
  assert.equal(result.body.pipelineStates.length, before.cases.length);
  for (const row of result.body.pipelineStates) { assert.equal(row.assertion.status, 'missing'); assert.equal(row.original.valid, 0); assert.equal(row.inLibrary, false); }
  assert.equal(calls, 0); assert.deepEqual(h.store.read(), before);
});

test('GET never prepares/materializes sealed inputs, starts git, creates scratch directories or computes cache misses', async t => {
  const h = setup(t); h.seed();
  const state = h.store.read(), c = state.cases[0]; c.sealedCheckpointId = 'synthetic-v2-checkpoint';
  state.replayCases = [{ id: 'replay-synthetic-v2', sourceCaseId: c.id, checkpointHash: 'a'.repeat(64), request: { association: { checkpointId: c.sealedCheckpointId } } }];
  const file = path.join(h.config.globalRoot, 'snapshots', String(state.revision).padStart(12, '0') + '.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, checksum: crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex'), record: state }));
  const sealed = require('../../scripts/badcase-capture/sealed-direct-input.cjs'), child = require('node:child_process');
  const materializer = require('../../build/server/domain/runtime/badcase-capture/git-snapshot-materialization');
  const originalMaterialize = materializer.materializeGitSnapshot;
  const originalPrepare = sealed.prepareSealedOriginalTurn, originalExec = child.execFileSync, originalTemp = fs.mkdtempSync;
  let inspections = 0, preparations = 0, materializations = 0, execs = 0, temps = 0;
  h.options.inspectReplay = ({ replay }) => {
    inspections++;
    return require('../../scripts/badcase-capture/wiki-page-runtime.cjs').inspectPageReplay({ replay, scope: h.config }, { resolve: () => ({ synthetic: true }) });
  };
  sealed.prepareSealedOriginalTurn = () => { preparations++; return { supported: true, provenance: { checkpointHash: 'a'.repeat(64) } }; };
  child.execFileSync = () => { execs++; throw Error('GET must not start git'); };
  fs.mkdtempSync = () => { temps++; throw Error('GET must not create scratch'); };
  materializer.materializeGitSnapshot = () => { materializations++; throw Error('GET must not materialize'); };
  let result;
  try { result = await h.invoke(); await h.invoke(); }
  finally { sealed.prepareSealedOriginalTurn = originalPrepare; materializer.materializeGitSnapshot = originalMaterialize; child.execFileSync = originalExec; fs.mkdtempSync = originalTemp; }
  assert.deepEqual({ inspections, preparations, materializations, execs, temps }, { inspections: 0, preparations: 0, materializations: 0, execs: 0, temps: 0 });
  assert.equal(result.body.pipelineStates[0].replay.status, 'pending');
  assert.deepEqual(h.store.read(), state);
  assert.equal(fs.existsSync(path.join(h.config.globalRoot, 'pipeline-prechecks')), false, 'GET cannot create even a cache directory');
});

test('GET and confirmation refresh only read offline prechecks; cache failures are pending, not computed or silently supported', async t => {
  const h = setup(t); h.seed();
  const state = h.store.read(), c = state.cases[0]; c.sealedCheckpointId = 'cp-cached';
  state.replayCases = [{ id: 'replay-cached', sourceCaseId: c.id, checkpointHash: 'b'.repeat(64), request: { association: { checkpointId: 'cp-cached' } } }];
  const snapshot = path.join(h.config.globalRoot, 'snapshots', String(state.revision).padStart(12, '0') + '.json');
  fs.writeFileSync(snapshot, JSON.stringify({ schemaVersion: 1, checksum: crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex'), record: state }));
  const { createWikiPipelinePrecheckStore, cacheWikiPipelineInputs } = require('../../build/server/domain/runtime/badcase-capture/wiki-pipeline-prechecks');
  let checks = 0;
  const cache = createWikiPipelinePrecheckStore(h.config), readers = { cache, inspectReplay: replay => { checks++; return { supported: true, checkpointHash: replay.checkpointHash }; } };
  cacheWikiPipelineInputs(state, readers); cacheWikiPipelineInputs(state, readers); assert.equal(checks, 1);
  h.options.inspectReplay = () => { throw Error('not an HTTP dependency'); };
  const directory = path.join(h.config.globalRoot, 'pipeline-prechecks'), files = fs.readdirSync(directory), bytes = files.map(f => fs.readFileSync(path.join(directory, f)));
  const first = await h.invoke(); assert.equal(first.body.pipelineStates[0].replay.status, 'supported');
  const label = first.body.casePatterns[0];
  const confirmed = await h.invoke({ confirmed: true, expectedRevision: state.revision, caseId: c.id, entryId: null, labelHash: label.labelHash }, { pathname: '/api/wikiskill/pattern-label-confirm' });
  assert.equal(confirmed.body.pipelineStates[0].replay.status, 'supported');
  assert.equal((await h.invoke()).body.pipelineStates[0].replay.status, 'supported');
  assert.equal(checks, 1); assert.deepEqual(fs.readdirSync(directory), files);
  for (let i = 0; i < files.length; i++) assert.deepEqual(fs.readFileSync(path.join(directory, files[i])), bytes[i]);
  fs.writeFileSync(path.join(directory, files[0]), 'corrupt');
  assert.equal((await h.invoke()).body.pipelineStates[0].replay.status, 'pending'); assert.equal(checks, 1);
});

test('pattern label and initial split confirmations are local-admin/CSRF guarded, closed and hash/revision bound without model calls', async t => {
  const h = setup(t), v = h.seed(); h.store.review({ versionId: v.id, entryId: v.entries[0].id, decision: 'approved', expectedRevision: h.store.read().revision });
  let calls = 0; h.options.runInduction = h.options.runDehydration = h.options.runRubricDraft = async () => { calls++; };
  const c = h.store.addMarkedCase({ source: { projectId: null, conversationId: 'synthetic', conversationTitle: 'synthetic', messageId: 'new', agentId: 'role-family-gpt' }, role: 'role-family-gpt', actual: 'new issue', expected: 'expected', message: '', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false, sealedCheckpointId: 'cp-new' }).case;
  const before = h.store.read(), get = await h.invoke();
  assert.equal(h.store.read().revision, before.revision, 'GET only projects a proposal');
  const label = get.body.casePatterns.find(r => r.caseId === c.id);
  const labelBody = { confirmed: true, caseId: c.id, entryId: v.entries[0].id, labelHash: label.labelHash, expectedRevision: before.revision }, labelRoute = { pathname: '/api/wikiskill/pattern-label-confirm' };
  for (const override of [{ remoteAddress: '10.1.1.1' }, { headers: { origin: 'http://evil.test' } }, { headers: { 'x-caff-csrf-token': '' } }]) await assert.rejects(h.invoke(labelBody, { ...labelRoute, ...override }));
  await rejects(h.invoke({ ...labelBody, confirmed: false }, labelRoute), 'wiki_confirmation_required');
  await rejects(h.invoke({ ...labelBody, split: 'gate' }, labelRoute), 'wiki_invalid_input');
  await rejects(h.invoke({ ...labelBody, expectedRevision: 0 }, labelRoute), 'wiki_revision_conflict', 409);
  await rejects(h.invoke({ ...labelBody, labelHash: 'f'.repeat(64) }, labelRoute), 'wiki_pattern_label_stale', 409);
  const labelled = await h.invoke(labelBody, labelRoute);
  assert.equal(labelled.body.cases.find(v => v.id === c.id).split, null);
  assert.deepEqual(labelled.body.versions, before.versions);
  const p = labelled.body.initialSplitProposal;
  const body = { confirmed: true, proposalHash: p.hash, patternKey: v.entries[0].id, expectedRevision: labelled.body.revision }, route = { pathname: '/api/wikiskill/initial-split-confirm' };
  for (const override of [{ remoteAddress: '10.1.1.1' }, { headers: { origin: 'http://evil.test' } }, { headers: { 'x-caff-csrf-token': '' } }]) await assert.rejects(h.invoke(body, { ...route, ...override }));
  await rejects(h.invoke({ ...body, confirmed: false }, route), 'wiki_confirmation_required');
  for (const extra of [{ assignments: [] }, { seed: 'caller-picked' }, { eligible: true }]) await rejects(h.invoke({ ...body, ...extra }, route), 'wiki_invalid_input');
  await rejects(h.invoke({ ...body, expectedRevision: 0 }, route), 'wiki_revision_conflict', 409);
  await rejects(h.invoke({ ...body, proposalHash: 'f'.repeat(64) }, route), 'wiki_initial_split_stale', 409);
  const done = await h.invoke(body, route), revision = done.body.revision;
  assert.equal(done.body.cases.find(v => v.id === c.id).split, 'train');
  assert.equal(done.body.initialSplitConfirmations.length, 1);
  assert.equal((await h.invoke(body, route)).body.revision, revision, 'exact network retry is idempotent');
  assert.equal(calls, 0); assert.deepEqual(h.store.read().versions, before.versions);
});

test('pending label and link endpoints enforce local-admin/CSRF, closed consent and revision with no model calls', async t => {
  const h = setup(t), v = h.seed(); h.store.review({ versionId: v.id, entryId: v.entries[0].id, decision: 'approved', expectedRevision: h.store.read().revision });
  let calls = 0; h.options.runInduction = h.options.runDehydration = h.options.runRubricDraft = () => { calls++; throw Error('no model calls'); };
  const add = messageId => h.store.addMarkedCase({ source: { projectId: null, conversationId: 'synthetic', conversationTitle: 'synthetic', messageId, agentId: 'role-family-gpt' },
    role: 'role-family-gpt', actual: 'Synthetic new pattern', expected: 'Check first', message: '', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false, sealedCheckpointId: 'cp-' + messageId }).case;
  const c = add('pending-create'), other = add('pending-join');
  const before = h.store.read(), get = await h.invoke(), label = get.body.casePatterns.find(r => r.caseId === c.id);
  const route = { pathname: '/api/wikiskill/pattern-label-confirm' };
  const body = { confirmed: true, caseId: c.id, pendingPattern: { name: 'Check constraints', scope: 'Synthetic tool constraint scope' }, labelHash: label.labelHash, expectedRevision: get.body.revision };
  const guards = [{ remoteAddress: '10.1.1.1' }, { headers: { origin: 'http://evil.test' } }, { headers: { 'x-caff-csrf-token': '' } }];
  for (const override of guards) await assert.rejects(h.invoke(body, { ...route, ...override }));
  for (const patch of [{ confirmed: false }, { pendingPattern: { name: 'A', extra: true } }, { entryId: null }, { split: 'gate' }]) await assert.rejects(h.invoke({ ...body, ...patch }, route));
  await rejects(h.invoke({ ...body, expectedRevision: 0 }, route), 'wiki_revision_conflict', 409);
  await rejects(h.invoke({ ...body, labelHash: 'f'.repeat(64) }, route), 'wiki_pattern_label_stale', 409);
  await rejects(h.invoke({ ...body, pendingPattern: { name: '' } }, route), 'wiki_pending_pattern_name_invalid');
  const created = await h.invoke(body, route), pending = created.body.pendingPatterns[0];
  assert.equal(created.body.revision, get.body.revision + 1);
  assert.equal(created.body.casePatterns.find(r => r.caseId === c.id).pendingPatternId, pending.id);
  assert.equal(created.body.cases.find(r => r.id === c.id).split, null);
  assert.ok(created.body.casePatterns.find(r => r.caseId === other.id).pendingOptions.some(p => p.id === pending.id));
  assert.equal((await h.invoke(body, route)).body.revision, created.body.revision);
  const otherLabel = created.body.casePatterns.find(r => r.caseId === other.id);
  const join = { confirmed: true, caseId: other.id, pendingPattern: { id: pending.id }, labelHash: otherLabel.labelHash, expectedRevision: created.body.revision };
  await rejects(h.invoke({ ...join, pendingPattern: { name: pending.name, scope: pending.scope } }, route), 'wiki_pending_pattern_name_conflict', 409);
  const joined = await h.invoke(join, route); assert.equal(joined.body.pendingPatterns.length, 1);
  const linkRoute = { pathname: '/api/wikiskill/pending-pattern-link' };
  const link = { confirmed: true, pendingPatternId: pending.id, entryId: v.entries[0].id, expectedRevision: joined.body.revision };
  for (const override of guards) await assert.rejects(h.invoke(link, { ...linkRoute, ...override }));
  for (const extra of [{ confirmed: false }, { automatic: true }, { memberships: [] }]) await assert.rejects(h.invoke({ ...link, ...extra }, linkRoute));
  await rejects(h.invoke({ ...link, expectedRevision: 0 }, linkRoute), 'wiki_revision_conflict', 409);
  await rejects(h.invoke({ ...link, entryId: 'missing' }, linkRoute), 'wiki_entry_not_found', 404);
  await rejects(h.invoke({ ...link, pendingPatternId: 'missing' }, linkRoute), 'wiki_pending_pattern_not_found', 404);
  const done = await h.invoke(link, linkRoute);
  assert.equal(done.body.pendingPatternLinks.length, 1);
  assert.equal(done.body.casePatterns.find(r => r.caseId === other.id).entryId, v.entries[0].id);
  assert.equal((await h.invoke(link, linkRoute)).body.revision, done.body.revision);
  await rejects(h.invoke({ ...link, entryId: 'different', expectedRevision: done.body.revision }, linkRoute), 'wiki_pending_pattern_link_frozen', 409);
  assert.deepEqual(h.store.read().cases, before.cases);
  assert.equal(calls, 0);
});

test('page-labelled holdouts project confirmed status and both legacy HTTP writers return frozen without writes', async t => {
  const { fixture, hash } = require('../helpers/wiki-pending-patterns.cjs');
  const { projectWikiPatternLabels, planWikiInitialSplit } = require('../../build/server/domain/runtime/badcase-capture/wiki-initial-split');
  for (const kind of ['approved', 'pending']) {
    const h = setup(t), state = fixture();
    for (const c of state.cases.filter(c => c.id.startsWith('new-'))) state.suggestions.push({
      id: 'suggestion-' + c.id, caseId: c.id, kind: 'assign', entryId: 'entry-2', status: 'pending', createdAt: c.createdAt });
    const directory = path.join(h.config.globalRoot, 'snapshots'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, String(state.revision).padStart(12, '0') + '.json'), JSON.stringify({ schemaVersion: 1, checksum: hash(state), record: state }));
    let pendingPatternId;
    for (const c of state.cases.filter(c => c.id.startsWith('new-'))) {
      const current = h.store.read(), label = projectWikiPatternLabels(current).find(r => r.caseId === c.id);
      const choice = kind === 'approved' ? { entryId: 'entry-1' } : { pendingPattern: pendingPatternId ? { id: pendingPatternId } : { name: '先核验工具约束', scope: 'Synthetic tool constraint scope' } };
      const saved = h.store.confirmPatternLabel({ caseId: c.id, labelHash: label.labelHash, expectedRevision: current.revision, ...choice });
      pendingPatternId = saved.pendingPatternId;
    }
    const current = h.store.read(), proposal = planWikiInitialSplit(current, []);
    h.store.confirmInitialSplit({ proposalHash: proposal.hash, patternKey: pendingPatternId || 'entry-1', expectedRevision: current.revision });
    const before = h.store.read(), files = () => Object.fromEntries(fs.readdirSync(directory).map(f => [f, fs.readFileSync(path.join(directory, f), 'utf8')])), bytes = files();
    const view = (await h.invoke()).body.caseStates;
    for (const c of before.cases.filter(c => c.id.startsWith('new-') && c.split !== 'train')) {
      assert.equal(view.find(v => v.caseId === c.id).status, 'classification-confirmed');
      await rejects(h.invoke({ confirmed: true, caseId: c.id, entryId: 'entry-2', expectedRevision: before.revision }, { pathname: '/api/wikiskill/membership' }), 'wiki_pattern_label_frozen', 409);
      await rejects(h.invoke({ confirmed: true, suggestionId: 'suggestion-' + c.id, decision: 'accepted', expectedRevision: before.revision }, { pathname: '/api/wikiskill/suggestion' }), 'wiki_pattern_label_frozen', 409);
      assert.deepEqual(h.store.read(), before); assert.deepEqual(files(), bytes);
    }
  }
});

test('assigned GPT label gaps block the first-split HTTP endpoint with a distinct error until labels are confirmed', async t => {
  const h = setup(t), v = h.seed(); h.store.review({ versionId: v.id, entryId: v.entries[0].id, decision: 'approved', expectedRevision: h.store.read().revision });
  const gap = h.store.addTextCases([{ source: { origin: 'http://127.0.0.1:3100', projectId: 'p1', conversationId: 'c1', messageId: 'assigned-unlabelled', agentId: 'role-family-gpt' }, role: 'GPT', actual: 'synthetic assigned but unlabelled', expected: 'synthetic expectation', message: '', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }]).cases[0];
  const c = h.store.addMarkedCase({ source: { projectId: null, conversationId: 'synthetic', conversationTitle: 'synthetic', messageId: 'new-label-gap', agentId: 'role-family-gpt' }, role: 'role-family-gpt', actual: 'new issue', expected: 'expected', message: '', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false, sealedCheckpointId: 'cp-new' }).case;
  let get = await h.invoke(); const own = get.body.casePatterns.find(r => r.caseId === c.id);
  await h.invoke({ confirmed: true, caseId: c.id, entryId: 'entry-1', labelHash: own.labelHash, expectedRevision: get.body.revision }, { pathname: '/api/wikiskill/pattern-label-confirm' });
  const before = h.store.read(); get = await h.invoke(); const p = get.body.initialSplitProposal;
  await rejects(h.invoke({ confirmed: true, proposalHash: p.hash, patternKey: 'entry-1', expectedRevision: before.revision }, { pathname: '/api/wikiskill/initial-split-confirm' }), 'wiki_initial_split_labels_required', 409);
  assert.deepEqual(h.store.read(), before); assert.equal(p.blockers[0].caseId, gap.id);
  const label = get.body.casePatterns.find(r => r.caseId === gap.id);
  const labelled = await h.invoke({ confirmed: true, caseId: gap.id, entryId: 'entry-1', labelHash: label.labelHash, expectedRevision: before.revision }, { pathname: '/api/wikiskill/pattern-label-confirm' });
  const done = await h.invoke({ confirmed: true, proposalHash: labelled.body.initialSplitProposal.hash, patternKey: 'entry-1', expectedRevision: labelled.body.revision }, { pathname: '/api/wikiskill/initial-split-confirm' });
  assert.equal(done.body.cases.find(v => v.id === c.id).split, 'train');
});

test('legacy gate/test labels confirm independently of induction and never move their frozen groups', async t => {
  const h = setup(t), v = h.seed(); h.store.review({ versionId: v.id, entryId: v.entries[0].id, decision: 'approved', expectedRevision: h.store.read().revision });
  h.store.addTextCases(Array.from({ length: 5 }, (_, i) => ({ source: { origin: 'http://127.0.0.1:3100', projectId: 'p1', conversationId: 'c1', messageId: 'extra-' + i, agentId: 'role-family-gpt' }, role: 'GPT', actual: 'synthetic holdout', expected: 'synthetic expectation', message: '', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false })));
  h.store.setReplaySplit({ caseIds: h.store.read().cases.map(c => c.id) });
  const before = h.store.read(), c = before.cases.find(c => c.split === 'test'), response = await h.invoke(), label = response.body.casePatterns.find(r => r.caseId === c.id);
  assert.equal(label.confirmed, false);
  const body = { confirmed: true, caseId: c.id, entryId: v.entries[0].id, labelHash: label.labelHash, expectedRevision: before.revision };
  const done = await h.invoke(body, { pathname: '/api/wikiskill/pattern-label-confirm' });
  for (const key of ['cases', 'caseStates', 'versions', 'replaySplit']) assert.deepEqual(h.store.read()[key], before[key]);
  assert.equal(done.body.patternLabels.length, 1);
});

test('rubric APIs append versions and freeze exact eligible model/hash without touching older versions', async t => {
  const h = setup(t); h.seed(); const { configFile, frozen } = require('../helpers/wiki-judge-catalog.cjs')(h.root);
  h.options.judgeCatalogFile = configFile;
  const caseId = h.store.read().cases[0].id, questions = [{ id: 'q1', question: '回复给出已验证的结论。', evidence: 'reply' }];
  const route = { pathname: '/api/wikiskill/rubric' }, confirmRoute = { pathname: '/api/wikiskill/confirm-rubric' };
  const body = { confirmed: true, expectedRevision: 2, caseId, questions, scoringModel: { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash' } };
  const get = await h.invoke(); assert.equal(get.body.eligibleJudges.length, 1); assert.equal(get.body.eligibleJudges[0].freezeHash, frozen.hash);
  for (const extra of [{ eligible: true }, { configurationHash: frozen.configurationHash }, { globalRoot: h.root }]) await rejects(h.invoke({ ...body, ...extra }, route), 'wiki_invalid_input');
  await rejects(h.invoke({ ...body, scoringModel: { backend: 'jev', model: 'jev-latest' } }, route), 'wiki_judge_not_eligible', 409);
  await rejects(h.invoke({ ...body, expectedRevision: 0 }, route), 'wiki_revision_conflict', 409);
  const saved = await h.invoke(body, route), rubric = saved.body.rubrics[0]; assert.equal(rubric.status, 'draft'); assert.equal(rubric.scoringModel.backend, 'deepseek');
  const confirm = { confirmed: true, expectedRevision: 3, rubricId: rubric.id, hash: rubric.hash };
  await rejects(h.invoke({ ...confirm, hash: 'a'.repeat(64) }, confirmRoute), 'wiki_rubric_hash_changed', 409);
  const result = await h.invoke(confirm, confirmRoute); assert.equal(result.body.rubrics[0].status, 'frozen');
  const old = clone(result.body.rubrics[0]);
  const revised = await h.invoke({ ...body, expectedRevision: 4, questions: [{ ...questions[0], question: '回复先给已验证的结论。' }] }, route);
  assert.deepEqual(revised.body.rubrics[0], old); assert.equal(revised.body.rubrics[1].version, old.version + 1);
  assert.equal(revised.body.rubrics[1].status, 'draft'); assert.notEqual(revised.body.rubrics[1].hash, old.hash);
  assert.deepEqual(h.store.read().versions, get.body.versions);
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
});
test('rubric mutation guards and closed schemas reject before paid draft calls; GET never invokes them', async t => {
  const h = setup(t); h.seed(); let calls = 0;
  h.options.runRubricDraft = async ({ store, caseId, expectedRevision, scope }) => {
    calls++; assert.equal(scope.globalRoot, h.config.globalRoot);
    store.saveRubricDraft({ caseId, model: 'deepseek/deepseek-v4-flash', questions: [{ id: 'q1', question: '回复提供依据。', evidence: 'reply' }] }, expectedRevision);
  };
  const body = { confirmed: true, expectedRevision: 2, caseId: h.store.read().cases[0].id }, route = { pathname: '/api/wikiskill/draft-rubric' };
  await h.invoke(); assert.equal(calls, 0);
  for (const extra of [{ tasks: {} }, { model: 'gpt' }, { credentialDir: h.root }, { confirmed: false }, { expectedRevision: 0 }, { caseId: 'missing' }]) await assert.rejects(h.invoke({ ...body, ...extra }, route));
  for (const override of [{ remoteAddress: '10.1.1.1' }, { headers: { origin: 'http://evil.test' } }, { headers: { 'x-caff-csrf-token': '' } }]) await assert.rejects(h.invoke(body, { ...route, ...override }));
  assert.equal(calls, 0); assert.equal(h.store.read().revision, 2);
  const out = await h.invoke(body, route); assert.equal(calls, 1); assert.equal(out.body.rubrics[0].status, 'draft'); assert.equal(out.body.rubrics[0].scoringModel, null);
});
test('without an operator eligibility catalog manual drafting works but model selection/freeze fail closed', async t => {
  const h = setup(t); h.seed(); const caseId = h.store.read().cases[0].id;
  assert.deepEqual((await h.invoke()).body.eligibleJudges, []);
  const body = { confirmed: true, expectedRevision: 2, caseId, questions: [{ id: 'q1', question: '回复提供依据。', evidence: 'reply' }], scoringModel: null };
  const out = await h.invoke(body, { pathname: '/api/wikiskill/rubric' }), rubric = out.body.rubrics[0];
  await rejects(h.invoke({ confirmed: true, expectedRevision: 3, rubricId: rubric.id, hash: rubric.hash }, { pathname: '/api/wikiskill/confirm-rubric' }), 'wiki_judge_not_eligible', 409);
  assert.equal(h.store.read().revision, 3);
});

test('manual and AI draft APIs return an explicit 422 for unsupported file evidence without a mutation', async t => {
  const h = setup(t); h.seed(); const before = h.store.read(), caseId = before.cases[0].id;
  const questions = [{ id: 'q1', question: '文件说明核验结果。', evidence: 'files' }];
  await rejects(h.invoke({ confirmed: true, expectedRevision: before.revision, caseId, questions, scoringModel: null },
    { pathname: '/api/wikiskill/rubric' }), 'wiki_rubric_files_unavailable');
  h.options.runRubricDraft = async ({ store, caseId, expectedRevision }) => store.saveRubricDraft({ caseId, questions, model: 'deepseek/deepseek-v4-flash' }, expectedRevision);
  await rejects(h.invoke({ confirmed: true, expectedRevision: before.revision, caseId }, { pathname: '/api/wikiskill/draft-rubric' }), 'wiki_rubric_files_unavailable');
  assert.deepEqual(h.store.read(), before);
});
test('freeze API rechecks file evidence on a pre-fix draft and preserves its snapshot', async t => {
  const h = setup(t); h.seed(); h.options.judgeCatalogFile = require('../helpers/wiki-judge-catalog.cjs')(h.root).configFile;
  const before = h.store.read(), source = before.cases[0];
  const rubric = require('../../build/server/domain/runtime/badcase-capture/wiki-rubric').createWikiRubric({ caseId: source.id, version: 1,
    model: 'deepseek/deepseek-v4-flash', scoringModel: { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash' }, actual: source.actual, expected: source.expected,
    questions: [{ id: 'q1', question: '文件说明核验结果。', evidence: 'files' }] });
  const file = path.join(h.config.globalRoot, 'snapshots', String(before.revision).padStart(12, '0') + '.json');
  before.rubrics = [rubric];
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, checksum: crypto.createHash('sha256').update(JSON.stringify(before)).digest('hex'), record: before }));
  const bytes = fs.readFileSync(file);
  await rejects(h.invoke({ confirmed: true, expectedRevision: before.revision, rubricId: rubric.id, hash: rubric.hash },
    { pathname: '/api/wikiskill/confirm-rubric' }), 'wiki_rubric_files_unavailable');
  assert.deepEqual(h.store.read(), before); assert.deepEqual(fs.readFileSync(file), bytes);
});
test('archived cases retain frozen rubrics and remain readable without changing old snapshots', async t => {
  const h = setup(t); h.seed();
  const deletedId = 'text-6d9cbd07278d02cc72a12b5a358aad639d802a632679a43de0752e5eff7a3a92';
  const state = h.store.read(), previousId = state.cases[0].id;
  const seeded = JSON.parse(JSON.stringify(state).split(previousId).join(deletedId));
  const snapshot = path.join(h.config.globalRoot, 'snapshots', String(state.revision).padStart(12, '0') + '.json');
  fs.writeFileSync(snapshot, JSON.stringify({ schemaVersion: 1, checksum: crypto.createHash('sha256').update(JSON.stringify(seeded)).digest('hex'), record: seeded }));
  const rubric = h.store.saveRubricDraft({ caseId: deletedId, model: 'deepseek/deepseek-v4-flash', scoringModel: { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash' },
    questions: [{ id: 'q1', question: '回复提供核验依据。', evidence: 'reply' }] }, state.revision);
  h.store.confirmRubric({ rubricId: rubric.id, hash: rubric.hash, confirmationRecord: 'synthetic explicit confirmation' }, h.store.read().revision);
  const before = h.store.read(), oldBytes = fs.readFileSync(snapshot);
  h.store.deleteCases({ caseIds: [deletedId], reason: 'user-approved missing historical prompt', expectedRevision: before.revision }, { source: 'user-via-planner', reference: 'synthetic-deletion' });
  const after = (await h.invoke()).body;
  assert.equal(after.cases.some(c => c.id === deletedId), false);
  assert.deepEqual(after.deletedCases[0].case, before.cases[0]);
  assert.deepEqual(after.rubrics, before.rubrics);
  assert.deepEqual(fs.readFileSync(snapshot), oldBytes);
});
test('case trace GET reads Wiki-owned frozen evidence without source rooms and cannot mutate or select paths', async t => {
  const h = setup(t); h.seed();
  const item = h.store.read().cases[0];
  const { buildWikiTraceBundle } = require('../../build/server/domain/runtime/badcase-capture/wiki-trace');
  const packet = buildWikiTraceBundle({ source: item.source, frozenAt: '2026-11-05T00:00:00Z', origin: 'backfill', message: { content: item.message } });
  const route = { pathname: '/api/wikiskill/cases/' + item.id + '/trace' };
  assert.deepEqual((await h.invoke(undefined, route)).body, { traceBundle: null });
  h.store.freezeCaseTrace(item.id, packet);
  const revision = h.store.read().revision;
  assert.deepEqual((await h.invoke(undefined, route)).body, { traceBundle: packet });
  assert.equal(h.store.read().revision, revision);
  await assert.rejects(h.invoke(undefined, { ...route, remoteAddress: '10.0.0.1' }), e => [403, 404].includes(e.statusCode));
  await rejects(h.invoke(undefined, { pathname: '/api/wikiskill/cases/unknown/trace' }), 'wiki_unknown_case', 422);
  const controller = createBadcaseWikiController(h.options);
  assert.equal(await controller({ req: { method: 'POST' }, res: {}, pathname: route.pathname }), false);
});
test('run replay results are guarded read-only packets; GET/list cannot launch or execute tools', async t => {
  const h = setup(t); h.seed(); const c = h.store.read().cases[0];
  const runs = require('../../build/server/domain/runtime/badcase-capture/wiki-run-store').createWikiRunStore(h.config);
  const request = { schemaVersion: 1, kind: 'wikiskill-run-request', model: 'openai-codex/gpt-6.1-sol', thinking: 'xhigh', variant: { kind: 'original' }, context: { tools: [] }, metadata: { caseId: c.id, traceHash: 'a'.repeat(64), decisionHash: 'b'.repeat(64) } };
  const r = runs.reserve(request); runs.finish(r.id, { message: { content: [{ type: 'text', text: 'FULL OUTPUT' }] }, outcome: { status: 'unreached', countAsFailure: true }, modelCalls: 1, toolExecutions: 0 });
  const summary = (await h.invoke()).body.runReplays[0]; assert.equal(summary.status, 'invalid'); assert.equal(summary.eligibleForScoring, false);
  assert.equal(summary.baselineStatus, 'no_valid_output'); assert.equal(summary.caseEligibleForGateAndScreen, false); assert.equal(Object.hasOwn(summary, 'countAsFailure'), false);
  const route = { pathname: '/api/wikiskill/cases/' + c.id + '/run-replays/' + r.id };
  const revision = h.store.read().revision;
  const packet = (await h.invoke(undefined, route)).body;
  assert.equal(packet.result.message.content[0].text, 'FULL OUTPUT'); assert.equal(packet.result.outcome.status, 'unreached');
  assert.equal(packet.accounting.status, 'invalid'); assert.equal(packet.accounting.resultHash, summary.resultHash);
  assert.equal(h.store.read().revision, revision);
  await assert.rejects(h.invoke(undefined, { ...route, remoteAddress: '10.0.0.1' }), e => [403, 404].includes(e.statusCode));
  await rejects(h.invoke(undefined, { pathname: '/api/wikiskill/cases/unknown/run-replays/' + r.id }), 'wiki_unknown_case', 422);
  assert.equal(await createBadcaseWikiController(h.options)({ req: { method: 'POST' }, res: {}, pathname: route.pathname }), false);
});
test('run JSON and Markdown exports share current accounting, retain original hashes and are guarded read-only', async t => {
  const h = setup(t); h.seed(); const c = h.store.read().cases[0];
  const runs = require('../../build/server/domain/runtime/badcase-capture/wiki-run-store').createWikiRunStore(h.config);
  const r = runs.reserve({ schemaVersion: 1, kind: 'wikiskill-run-request', variant: { kind: 'original' }, metadata: { caseId: c.id, traceHash: 'trace', decisionHash: 'decision' } });
  const result = runs.finish(r.id, { message: { content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'DO NOT EXECUTE ```json' } }] }, outcome: { status: 'unreached', countAsFailure: true }, modelCalls: 1, toolExecutions: 0 });
  const base = '/api/wikiskill/cases/' + c.id + '/run-replays/' + r.id, before = h.store.read();
  const detail = (await h.invoke(undefined, { pathname: base })).body;
  const json = await h.invoke(undefined, { pathname: base + '/export.json' });
  const md = await h.invoke(undefined, { pathname: base + '/export.md', text: true });
  assert.deepEqual(json.body, detail); assert.equal(json.body.accounting.status, 'invalid'); assert.equal(json.body.accounting.caseEligibleForGateAndScreen, false);
  assert.deepEqual(json.body.result, result); assert.equal(json.headers['Cache-Control'], 'no-store'); assert.match(json.headers['Content-Disposition'], /attachment/);
  assert.match(md.body, /无效，不算通过也不算不通过/); assert.match(md.body, /原版无有效输出.*不进门槛和初筛/);
  const block = md.body.match(/(`{4,})json\n([\s\S]*)\n\1/); assert.ok(block); assert.deepEqual(JSON.parse(block[2]), detail);
  for (const ext of ['json', 'md']) {
    await assert.rejects(h.invoke(undefined, { pathname: base + '/export.' + ext, remoteAddress: '10.0.0.1' }), e => [403, 404].includes(e.statusCode));
    assert.equal(await createBadcaseWikiController(h.options)({ req: { method: 'POST' }, res: {}, pathname: base + '/export.' + ext }), false);
  }
  assert.deepEqual(h.store.read(), before); assert.deepEqual(runs.read(r.id).result, result);
});
test('dehydration confirmation is explicit, guarded, revision/hash bound and never calls a model', async t => {
  const h = setup(t); h.seed(); const c = h.store.read().cases[0];
  const packet = { schemaVersion: 1, kind: 'wikiskill-trace-bundle', origin: 'backfill', source: c.source, frozenAt: '2026-11-05T00:00:00Z', complete: false, missingReasons: [], redaction: { policy: 'known_values_only' },
    markedStep: 1, markedMessage: 'done', actual: c.actual, expected: c.expected, context: { systemPrompt: 'historical', priorSessionEntries: [], trigger: { message: { role: 'user', content: 'verify first' } } },
    steps: [{ step: 1, output: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, toolResults: [] }] };
  h.store.freezeCaseTrace(c.id, packet);
  const { buildDehydrationRequest } = require('../../build/server/domain/runtime/badcase-capture/wiki-dehydration');
  const item = h.store.read().cases[0], built = buildDehydrationRequest({ caseRecord: item, bundle: packet, cause: { source: 'trigger', text: 'verify first' } });
  const r = h.store.saveDehydrationRecommendation({ built, expectedRevision: h.store.read().revision, response: { model: 'deepseek/deepseek-v4-flash', attempts: [{ content: JSON.stringify({ kind: '单步型', cutStep: 1, reason: '本步决定', evidence: 'done' }), finishReason: 'stop' }] } });
  const route = { pathname: '/api/wikiskill/dehydration-confirm' }, body = { confirmed: true, caseId: c.id, traceHash: item.traceBundle.hash, recommendationHash: r.hash, kind: 'single', cutStep: 1, expectedRevision: h.store.read().revision };
  assert.equal((await h.invoke()).body.dehydrations[0].decision, undefined);
  await rejects(h.invoke({ ...body, confirmed: false }, route), 'wiki_confirmation_required');
  for (const extra of [{ response: {} }, { globalRoot: h.root }, { candidate: {} }]) await rejects(h.invoke({ ...body, ...extra }, route), 'wiki_invalid_input');
  for (const override of [{ remoteAddress: '10.0.0.1' }, { headers: { origin: 'http://evil.test' } }, { headers: { 'x-caff-csrf-token': '' } }]) await assert.rejects(h.invoke(body, { ...route, ...override }));
  await rejects(h.invoke({ ...body, traceHash: 'f'.repeat(64) }, route), 'wiki_dehydration_stale', 409);
  const done = await h.invoke(body, route); assert.equal(done.body.dehydrations[0].decision.kind, 'single');
  await rejects(h.invoke({ ...body, expectedRevision: done.body.revision, kind: 'throughout', cutStep: null }, route), 'wiki_dehydration_frozen', 409);
  assert.deepEqual(h.store.readCaseTrace(c.id), packet);
  const decision = done.body.dehydrations[0].decision, runs = require('../../build/server/domain/runtime/badcase-capture/wiki-run-store').createWikiRunStore(h.config);
  const run = runs.reserve({ schemaVersion: 1, kind: 'wikiskill-run-request', variant: { kind: 'original' }, metadata: { caseId: c.id, traceHash: item.traceBundle.hash, decisionHash: decision.hash } });
  runs.finish(run.id, { outcome: { status: 'unreached', countAsFailure: true }, modelCalls: 1, toolExecutions: 0 });
  const raw = runs.read(run.id);
  const withdrawn = h.store.withdrawDehydrationToReference({ caseId: c.id, traceHash: item.traceBundle.hash, recommendationHash: r.hash,
    previousDecisionHash: decision.hash, reason: '贯穿型且无现场，只作参考', expectedRevision: h.store.read().revision }, { source: 'user-via-planner', reference: 'withdrawal-message' });
  const after = (await h.invoke()).body;
  assert.equal(after.dehydrations[0].decision.level, 'reference'); assert.deepEqual(after.dehydrations[0].decisionHistory, [decision]);
  assert.equal(after.runReplays[0].excludedReason, 'user_reclassified_reference'); assert.equal(after.runReplays[0].supersededByDecisionHash, withdrawn.hash);
  assert.equal(after.runReplays[0].status, 'invalid'); assert.equal(after.runReplays[0].eligibleForScoring, false);
  const detail = (await h.invoke(undefined, { pathname: '/api/wikiskill/cases/' + c.id + '/run-replays/' + run.id })).body;
  assert.deepEqual({ reservation: detail.reservation, result: detail.result }, raw); assert.equal(detail.accounting.excludedReason, 'user_reclassified_reference');
  await rejects(h.invoke({ ...body, expectedRevision: after.revision }, route), 'wiki_dehydration_frozen', 409);
  const controller = createBadcaseWikiController(h.options);
  assert.equal(await controller({ req: { method: 'POST' }, res: {}, pathname: '/api/wikiskill/dehydration-withdraw' }), false);
});
test('comparison review is explicit, locally guarded and cannot supply results, rules or adoption', async t => {
  const h = setup(t), route = { pathname: '/api/wikiskill/comparison-review' };
  const body = { confirmed: true, comparisonId: 'comparison-' + 'a'.repeat(64), candidateHash: 'b'.repeat(64), expectedRevision: 0, decision: 'not-adopted', reason: 'test_not_passed', interpretation: '门槛接受、测试未通过、未采纳。' };
  await rejects(h.invoke({ ...body, confirmed: false }, route), 'wiki_confirmation_required');
  for (const extra of [{ result: {} }, { rules: {} }, { globalRoot: h.root }]) await rejects(h.invoke({ ...body, ...extra }, route), 'wiki_invalid_input');
  for (const override of [{ remoteAddress: '10.1.1.1' }, { headers: { origin: 'http://evil.test' } }, { headers: { 'x-caff-csrf-token': '' } }]) await assert.rejects(h.invoke(body, { ...route, ...override }), e => [403, 404].includes(e.statusCode));
  await rejects(h.invoke(body, route), 'wiki_comparison_not_found', 404);
  assert.equal(h.store.read().revision, 0); assert.equal(fs.existsSync(path.join(h.config.globalRoot, 'snapshots')), false);
  assert.equal(fs.existsSync(path.join(h.config.globalRoot, 'comparisons')), false);
});
test('experience review is guarded, revision-bound, freezes reviewed text and creates a separate revision draft', async t => {
 const h=setup(t);h.seed();const s=h.store.read();s.revision++;s.experiences.push({id:'experience-fixture',rootId:'root-fixture',version:1,parentId:null,entryId:'entry-1',status:'draft',methods:'有效：先给结论。',positiveExamples:'示意：结论是……。',createdAt:'2026-11-04T00:00:00Z'});fs.writeFileSync(path.join(h.config.globalRoot,'snapshots',String(s.revision).padStart(12,'0')+'.json'),JSON.stringify({schemaVersion:1,checksum:crypto.createHash('sha256').update(JSON.stringify(s)).digest('hex'),record:s}));
 const route={pathname:'/api/wikiskill/experience'},body={confirmed:true,experienceId:'experience-fixture',expectedRevision:s.revision,decision:'approved'};
 await rejects(h.invoke({...body,confirmed:false},route),'wiki_confirmation_required');for(const extra of [{observations:[]},{comparisonId:'invented'},{globalRoot:h.root}])await rejects(h.invoke({...body,...extra},route),'wiki_invalid_input');
 for(const override of [{remoteAddress:'10.0.0.1'},{headers:{origin:'http://evil.test'}},{headers:{'x-caff-csrf-token':''}}])await assert.rejects(h.invoke(body,{...route,...override}),e=>[403,404].includes(e.statusCode));
 await rejects(h.invoke({...body,expectedRevision:s.revision-1},route),'wiki_revision_conflict',409);await rejects(h.invoke({...body,patch:{methods:'sk-FAKE_SENTINEL_123456'}},route),'wiki_contains_secret');assert.deepEqual(h.store.read(),s);
 const approved=await h.invoke(body,route);assert.equal(approved.body.experiences[0].status,'approved');const frozen=clone(approved.body.experiences[0]);await rejects(h.invoke({...body,expectedRevision:approved.body.revision,patch:{methods:'overwrite'}},route),'wiki_experience_reviewed',409);
 const next=await h.invoke({...body,expectedRevision:approved.body.revision,decision:'revise'},route);assert.deepEqual(next.body.experiences[0],frozen);assert.equal(next.body.experiences[1].status,'draft');assert.equal(next.body.experiences[1].parentId,frozen.id);assert.deepEqual(next.body.versions,approved.body.versions);
 function clone(v){return JSON.parse(JSON.stringify(v));}
});
test('execution progress endpoint is read-only, guarded and cannot launch evaluations', async t => {
  const h = setup(t), result = await h.invoke(undefined, { pathname: '/api/wikiskill/executions' });
  assert.deepEqual(result.body, { executions: [], comparisons: [] }); assert.equal(fs.existsSync(h.config.globalRoot), false);
  await assert.rejects(h.invoke(undefined, { pathname: '/api/wikiskill/executions', remoteAddress: '10.0.0.1' }), e => e.statusCode === 403 || e.statusCode === 404);
  const store = require('../../build/server/domain/runtime/badcase-capture/wiki-execution-store').createWikiExecutionStore(h.config);
  const record = store.start({ kind: 'sealed-original-replay-v1', variants: ['original'], model: 'deepseek/deepseek-v4-flash', repeats: 1, caseId: 'c1', checkpointHash: 'a'.repeat(64), rulesHash: 'b'.repeat(64) });
  const progress = await h.invoke(undefined, { pathname: '/api/wikiskill/executions' }); assert.equal(progress.body.executions[0].id, record.id);
  assert.equal((await h.invoke()).body.executions.length, 1); assert.equal(h.store.read().revision, 0);
  const controller = createBadcaseWikiController(h.options);
  assert.equal(await controller({ req: { method: 'POST' }, res: {}, pathname: '/api/wikiskill/executions' }), false);
});
test('page runtime configuration errors are safe actionable codes, never host paths or raw diagnostics', async t => {
  const h = setup(t);
  for (const code of ['wiki_runtime_config_required', 'wiki_runtime_config_invalid', 'evaluation_wsl_host_required', 'evaluation_wsl_backend_invalid']) {
    h.options.runInduction = async () => { throw Object.assign(Error(h.root), { code }); };
    await rejects(h.invoke({ confirmed: true, expectedRevision: 0 }, { pathname: '/api/wikiskill/induct' }), code, 503);
  }
  assert.equal(h.store.read().revision, 0);
});
test('GET is read-only and returns the local external collection without filesystem paths', async t => {
  const h = setup(t), result = await h.invoke();
  assert.equal(result.status, 200); assert.equal(result.body.revision, 0); assert.deepEqual(result.body.cases, []);
  assert.equal(fs.existsSync(h.config.globalRoot), false); assert.equal(fs.existsSync(h.config.sourceWorktree), false);
  assert.equal(JSON.stringify(result).includes(h.root), false);
});
test('legacy project wiki URLs are not routed; the global endpoint cannot select a root or owning project', async t => {
  const h = setup(t), controller = createBadcaseWikiController(h.options);
  assert.equal(await controller({ req: {}, res: {}, pathname: '/api/projects/p1/badcase-wiki' }), false);
  for (const extra of [{ projectId: 'foreign' }, { globalRoot: h.root }]) {
    await rejects(h.invoke({ confirmed: true, ...extra }), 'wiki_invalid_input');
  }
  assert.equal(fs.existsSync(h.config.globalRoot), false);
});
test('draft prose editing and approval persist; stale/reviewed writes cannot overwrite them', async t => {
  const h = setup(t), v = h.seed();
  const body = { confirmed: true, versionId: v.id, entryId: v.entries[0].id, expectedRevision: 2, patch: { guideline: '逐项核验后再报告。' } };
  const edit = await h.invoke(body); assert.equal(edit.body.revision, 3); assert.equal(edit.body.versions[0].entries[0].status, 'draft');
  await rejects(h.invoke({ ...body, decision: 'approved' }), 'wiki_revision_conflict', 409);
  const approve = await h.invoke({ ...body, expectedRevision: 3, decision: 'approved' }); assert.equal(approve.body.versions[0].entries[0].status, 'approved');
  assert.equal(createWikiStore(h.config).read().versions[0].entries[0].guideline, '逐项核验后再报告。');
  await rejects(h.invoke({ ...body, expectedRevision: 4 }), 'wiki_entry_reviewed', 409);
});
test('Host/remote/Origin/CSRF gates reject requests before any storage mutation', async t => {
  const h = setup(t);
  const body = { confirmed: true };
  for (const override of [{ remoteAddress: '10.1.1.1' }, { headers: { host: 'evil.test:4313' } },
    { headers: { origin: 'http://evil.test' } }, { headers: { 'x-caff-csrf-token': '' } }]) {
    await assert.rejects(h.invoke(body, override), e => [403, 404].includes(e.statusCode));
    assert.equal(fs.existsSync(h.config.globalRoot), false);
  }
});
test('confirmation/closed schema and membership edits fail without changing the global version', async t => {
  const h = setup(t), v = h.seed();
  const body = { confirmed: true, versionId: v.id, entryId: v.entries[0].id, expectedRevision: 2, decision: 'rejected' };
  for (const confirmed of [false, 'true', 1]) await rejects(h.invoke({ ...body, confirmed }), 'wiki_confirmation_required');
  await rejects(h.invoke({ ...body, captureRoot: 'foreign' }), 'wiki_invalid_input');
  await rejects(h.invoke({ ...body, patch: { caseIds: [] } }), 'wiki_membership_edit_unsupported');
  assert.equal((await h.invoke()).body.scope, 'global');
  assert.equal((await h.invoke()).body.projectId, undefined);
  assert.equal(h.store.read().revision, 2);
  const reject = await h.invoke(body); assert.equal(reject.body.versions[0].entries[0].status, 'rejected');
});
test('candidate confirmation requires exact hash, revision and explicit user action; GET never confirms', async t => {
  const h = setup(t), v = h.seed();
  h.store.review({ versionId: v.id, entryId: v.entries[0].id, expectedRevision: 2, decision: 'approved' });
  const baseRole = 'Keep the original GPT identity.';
  const candidate = h.store.createCandidate({ versionId: v.id, entryIds: [v.entries[0].id], baseRole, files: [], anchor: {
    caseId: 'case1', checkpointId: 'cp1', originalRoleHash: crypto.createHash('sha256').update('Your private persona instructions:\n' + baseRole).digest('hex') } });
  const route = { pathname: '/api/wikiskill/confirm-candidate' };
  const body = { confirmed: true, candidateId: candidate.id, candidateRoleHash: candidate.candidateRoleHash, expectedRevision: 4 };
  assert.equal((await h.invoke()).body.candidates[0].status, 'draft');
  for (const confirmed of [false, 'true', 1]) await rejects(h.invoke({ ...body, confirmed }, route), 'wiki_confirmation_required');
  await rejects(h.invoke({ ...body, candidateRoleHash: 'a'.repeat(64) }, route), 'wiki_candidate_not_found', 404);
  await rejects(h.invoke({ ...body, expectedRevision: 3 }, route), 'wiki_revision_conflict', 409);
  await rejects(h.invoke({ ...body, candidateRole: 'replacement' }, route), 'wiki_invalid_input');
  for (const headers of [{ origin: 'http://evil.test' }, { 'x-caff-csrf-token': '' }]) {
    await assert.rejects(h.invoke(body, { ...route, headers }), e => e.statusCode === 403);
    assert.equal(h.store.read().candidates[0].status, 'draft');
  }
  const result = await h.invoke(body, route); assert.equal(result.body.candidates[0].status, 'confirmed');
  assert.equal(createWikiStore(h.config).read().candidates[0].status, 'confirmed');
  assert.equal((await h.invoke()).body.revision, 5);
});

test('global candidate HTTP flow exposes real targets and only accepts approved sources, exact revision/hash and confirmation', async t => {
  for (const targetId of ['global-harness-behavior-v1', 'tool-description-list_rooms', 'tool-description-send-public']) {
    const h = setup(t), v = h.seed(), route = { pathname: '/api/wikiskill/candidate' };
    const catalog = (await h.invoke()).body.targets;
    assert.equal(catalog.length, 10); assert.ok(catalog.find(t => t.id === targetId));
    assert.equal(catalog.some(t => t.execute || t.parameters), false);
    const body = { confirmed: true, expectedRevision: 2, versionId: v.id, entryIds: [v.entries[0].id], targetId };
    await rejects(h.invoke(body, route), 'wiki_candidate_approved_required', 409);
    h.store.review({ versionId: v.id, entryId: v.entries[0].id, expectedRevision: 2, decision: 'approved' });
    await rejects(h.invoke(body, route), 'wiki_revision_conflict', 409);
    body.expectedRevision = 3;
    for (const extra of [{ files: [] }, { globalRoot: h.root }, { candidateText: 'injected' }]) await rejects(h.invoke({ ...body, ...extra }, route), 'wiki_invalid_input');
    for (const confirmed of [false, 'true', 1]) await rejects(h.invoke({ ...body, confirmed }, route), 'wiki_confirmation_required');
    for (const override of [{ remoteAddress: '10.1.1.1' }, { headers: { origin: 'http://evil.test' } }, { headers: { 'x-caff-csrf-token': '' } }]) {
      await assert.rejects(h.invoke(body, { ...route, ...override }), e => [403, 404].includes(e.statusCode));
    }
    const generated = await h.invoke(body, route), c = generated.body.candidates[0];
    assert.equal(c.kind, 'global-wiki-candidate-v1'); assert.equal(c.targetId, targetId); assert.equal(c.status, 'draft');
    assert.match(c.diff, /WikiSkill 已审核准则/); assert.equal(h.store.read().revision, 4);
    const confirmRoute = { pathname: '/api/wikiskill/confirm-global-candidate' }, confirmBody = { confirmed: true, candidateId: c.id, candidateHash: c.candidateHash, expectedRevision: 4 };
    for (const confirmed of [false, 'true', 1]) await rejects(h.invoke({ ...confirmBody, confirmed }, confirmRoute), 'wiki_confirmation_required');
    await rejects(h.invoke({ ...confirmBody, files: [] }, confirmRoute), 'wiki_invalid_input');
    await rejects(h.invoke({ ...confirmBody, candidateHash: 'f'.repeat(64) }, confirmRoute), 'wiki_candidate_not_found', 404);
    await rejects(h.invoke({ ...confirmBody, expectedRevision: 3 }, confirmRoute), 'wiki_revision_conflict', 409);
    assert.equal((await h.invoke()).body.candidates[0].status, 'draft');
    const saved = await h.invoke(confirmBody, confirmRoute); assert.equal(saved.body.candidates[0].status, 'confirmed');
    assert.equal(createWikiStore(h.config).read().candidates[0].status, 'confirmed');
  }
});
test('deprecated draft remains in GET but hash-bound HTTP confirmation cannot revive it', async t => {
  const h = setup(t), v = h.seed(); h.store.review({ versionId: v.id, entryId: v.entries[0].id, expectedRevision: 2, decision: 'approved' });
  const c = h.store.createGlobalCandidate({ versionId: v.id, entryIds: [v.entries[0].id], targetId: 'tool-description-list_rooms', files: [] });
  h.store.deprecateGlobalCandidate({ candidateId: c.id, candidateHash: c.candidateHash, expectedRevision: 4, reason: 'wrong_tool_target' });
  assert.equal((await h.invoke()).body.candidates[0].status, 'deprecated');
  await rejects(h.invoke({ confirmed: true, candidateId: c.id, candidateHash: c.candidateHash, expectedRevision: 5 }, { pathname: '/api/wikiskill/confirm-global-candidate' }), 'wiki_candidate_deprecated', 409);
  assert.equal(h.store.read().revision, 5);
});
test('candidate HTTP errors disclose no sealed paths and cannot bypass missing registered materials', async t => {
  const h = setup(t), v = h.seed(); h.store.review({ versionId: v.id, entryId: v.entries[0].id, expectedRevision: 2, decision: 'approved' });
  await rejects(h.invoke({ confirmed: true, expectedRevision: 3, versionId: v.id, entryIds: [v.entries[0].id], targetId: 'arbitrary' }, { pathname: '/api/wikiskill/candidate' }), 'wiki_target_unknown');
  // Unknown lower-level storage errors are deliberately not reflected to HTTP.
  const file = path.join(h.config.globalRoot, 'snapshots/000000000003.json');
  const envelope = JSON.parse(fs.readFileSync(file)); envelope.record.replayCases = [{ id: 'r', request: { captureRoot: h.root }, checkpointHash: 'a'.repeat(64) }];
  envelope.checksum = crypto.createHash('sha256').update(JSON.stringify(envelope.record)).digest('hex'); fs.writeFileSync(file, JSON.stringify(envelope));
  await rejects(h.invoke({ confirmed: true, expectedRevision: 3, versionId: v.id, entryIds: [v.entries[0].id], targetId: 'global-harness-behavior-v1' }, { pathname: '/api/wikiskill/candidate' }), 'wiki_candidate_anchor_unsupported', 409);
  assert.equal(h.store.read().candidates.length, 0);
});
test('HTTP generation and confirmation scan real retained files rather than accepting client file evidence', async t => {
  const f = require('../helpers/badcase-initialization-fixture.cjs')(t, 'fresh', ({ cp }) => { cp.agentId = 'role-family-gpt'; });
  for (const atConfirmation of [false, true]) {
    const h = setup(t), v = h.seed();
    h.store.review({ versionId: v.id, entryId: v.entries[0].id, expectedRevision: 2, patch: { guideline: 'Never copy retained bytes.' }, decision: 'approved' });
    const generationRoute = { pathname: '/api/wikiskill/candidate' };
    let candidate;
    if (atConfirmation) candidate = (await h.invoke({ confirmed: true, versionId: v.id, entryIds: [v.entries[0].id], targetId: 'global-harness-behavior-v1', expectedRevision: 3 }, generationRoute)).body.candidates[0];
    h.store.setReplaySplit({ caseIds: v.caseIds });
    h.store.addReplayCase({ sourceCaseId: v.caseIds[0], category: 'control', task: 'Inspect source.txt.', fixture: { commit: 'a'.repeat(40), sourceCommit: 'b'.repeat(40), sourceSubdirectory: 'R1', filesHash: 'c'.repeat(64) }, request: f.request,
      rules: { kind: 'file-literals-v1', files: [{ path: 'source.txt', contains: ['retained bytes'], notContains: [] }] }, checkpointHash: crypto.createHash('sha256').update(JSON.stringify(f.cp)).digest('hex') });
    const revision = h.store.read().revision;
    if (atConfirmation) {
      await rejects(h.invoke({ confirmed: true, candidateId: candidate.id, candidateHash: candidate.candidateHash, expectedRevision: revision }, { pathname: '/api/wikiskill/confirm-global-candidate' }), 'wiki_candidate_leak');
      assert.equal(h.store.read().candidates[0].status, 'draft');
    } else {
      await rejects(h.invoke({ confirmed: true, versionId: v.id, entryIds: [v.entries[0].id], targetId: 'global-harness-behavior-v1', expectedRevision: revision }, generationRoute), 'wiki_candidate_leak');
      assert.equal(h.store.read().candidates.length, 0);
    }
    assert.equal(h.store.read().revision, revision);
  }
});
test('incremental induction and membership endpoints persist suggestions and provenance without client-selected model input', async t => {
  const h = setup(t), version = h.seed();
  h.store.review({ versionId: version.id, entryId: 'entry-1', expectedRevision: 2, decision: 'approved' });
  const marked = h.store.addMarkedCase({ source: { projectId: 'p1', conversationId: 'local-room', conversationTitle: '本地标记房间', messageId: 'local-message', agentId: 'role-family-kimi' }, role: 'Kimi',
    actual: '额外增加流程', expected: '直接完成明确要求', message: '', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false });
  let calls = 0;
  h.options.runInduction = async ({ store, expectedRevision }) => {
    calls++; assert.equal(expectedRevision, 4);
    return store.recordPreclassification({ caseIds: [marked.case.id], model: 'deepseek/deepseek-v4-flash', proof: { inputHash: 'a'.repeat(64), calls: [], cleaned: true },
      results: [{ caseId: marked.case.id, kind: 'assign', entryId: 'entry-1', reason: '症状一致', confidence: '高' }] }, expectedRevision);
  };
  const induction = await h.invoke({ confirmed: true, expectedRevision: 4 }, { pathname: '/api/wikiskill/induct' });
  assert.equal(calls, 1); assert.equal(induction.body.caseStates.find(s => s.caseId === marked.case.id).status, 'classification-pending');
  assert.equal(induction.body.cases.find(c => c.id === marked.case.id).split, null);
  const suggestion = induction.body.suggestions[0];
  await rejects(h.invoke({ confirmed: true, expectedRevision: 5, model: 'other' }, { pathname: '/api/wikiskill/induct' }), 'wiki_invalid_input');
  assert.equal(calls, 1);
  const accepted = await h.invoke({ confirmed: true, suggestionId: suggestion.id, decision: 'accepted', expectedRevision: 5 }, { pathname: '/api/wikiskill/suggestion' });
  assert.equal(accepted.body.classifications.find(s => s.caseId === marked.case.id).source, 'model-confirmed');
  assert.equal(accepted.body.caseStates.find(s => s.caseId === marked.case.id).status, 'pending-allocation');
  await h.invoke({ confirmed: true, caseId: marked.case.id, entryId: null, expectedRevision: 6 }, { pathname: '/api/wikiskill/membership' });
  const manual = await h.invoke({ confirmed: true, caseId: marked.case.id, entryId: 'entry-1', expectedRevision: 7 }, { pathname: '/api/wikiskill/membership' });
  assert.equal(manual.body.classifications.find(s => s.caseId === marked.case.id).source, 'manual');
  assert.equal(createWikiStore(h.config).read().classifications.find(s => s.caseId === marked.case.id).source, 'manual');
  assert.equal(manual.body.cases.find(c => c.id === marked.case.id).split, null, 'non-GPT mark remains report-only');
  assert.equal(manual.body.events.some(e => e.type === 'preclassification-run'), true);
});

test('corrupt storage and unknown exceptions are sanitized, never returning raw paths', async t => {
  const h = setup(t); h.seed();
  const file = path.join(h.config.globalRoot, 'snapshots/000000000002.json'); fs.writeFileSync(file, 'broken');
  await rejects(h.invoke(), 'wiki_record_invalid', 409);
  const bad = createBadcaseWikiController({ ...h.options, globalRoot: 'not-absolute' });
  const req = { method: 'GET', headers: { host: '127.0.0.1:4313' }, socket: { remoteAddress: '127.0.0.1' } };
  await rejects(bad({ req, res: {}, pathname: '/api/wikiskill' }), 'wiki_unavailable', 503);
});
