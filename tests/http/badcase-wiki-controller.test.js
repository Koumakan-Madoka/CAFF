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
    const res = { writeHead(status) { this.status = status; }, end(bytes) { result = { status: this.status, body: JSON.parse(bytes) }; } };
    const pending = controller({ req, res, pathname: overrides.pathname || '/api/wikiskill' + (body === undefined ? '' : '/review') });
    req.end(body === undefined ? undefined : JSON.stringify(body)); assert.equal(await pending, true); return result;
  }
  return { root, config, options, store, seed, invoke };
}
const rejects = (promise, code, status = 422) => assert.rejects(promise, e => e.statusCode === status && e.issues?.[0]?.code === code);

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
  assert.equal(calls, 1); assert.equal(induction.body.caseStates.find(s => s.caseId === marked.case.id).status, 'suggested');
  const suggestion = induction.body.suggestions[0];
  await rejects(h.invoke({ confirmed: true, expectedRevision: 5, model: 'other' }, { pathname: '/api/wikiskill/induct' }), 'wiki_invalid_input');
  assert.equal(calls, 1);
  const accepted = await h.invoke({ confirmed: true, suggestionId: suggestion.id, decision: 'accepted', expectedRevision: 5 }, { pathname: '/api/wikiskill/suggestion' });
  assert.equal(accepted.body.caseStates.find(s => s.caseId === marked.case.id).memberships[0].source, 'model-confirmed');
  await h.invoke({ confirmed: true, caseId: marked.case.id, entryId: null, expectedRevision: 6 }, { pathname: '/api/wikiskill/membership' });
  const manual = await h.invoke({ confirmed: true, caseId: marked.case.id, entryId: 'entry-1', expectedRevision: 7 }, { pathname: '/api/wikiskill/membership' });
  assert.equal(manual.body.caseStates.find(s => s.caseId === marked.case.id).memberships[0].source, 'manual');
  assert.equal(createWikiStore(h.config).getCaseStates().find(s => s.caseId === marked.case.id).memberships[0].source, 'manual');
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
