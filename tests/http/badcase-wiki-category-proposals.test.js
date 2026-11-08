const test = require('node:test'), assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { setup: fixture, hash } = require('../helpers/wiki-pending-patterns.cjs');
const { createBadcaseWikiController } = require('../../build/server/api/badcase-wiki-controller');
const MODEL = 'deepseek/deepseek-v4-flash', ids = ['new-1', 'new-2', 'new-3', 'new-4'];
const proposal = { name: '调用前检查工具约束', scope: '调用工具前没有核对参数上限或前置条件。',
  members: ids.map(caseId => ({ caseId, reason: 'Synthetic skipped check' })) };
const proof = { inputHash: hash('synthetic-only input'), cleaned: true, calls: [] };
function setup(t) {
  const h = fixture(t), calls = [];
  const options = { ...h.options, projectManager: { listProjects: () => [] }, host: '127.0.0.1', port: 4313, csrfToken: 'synthetic-csrf',
    runCategoryProposals: async input => {
      calls.push(input); assert.equal(input.expectedRevision, input.store.read().revision);
      return input.store.recordCategoryProposals({ caseIds: ids, model: MODEL, proof, proposals: [proposal] }, input.expectedRevision);
    } };
  const controller = createBadcaseWikiController(options);
  async function invoke(route = '', body, override = {}) {
    const req = new PassThrough(); req.method = body === undefined ? 'GET' : 'POST';
    req.socket = { remoteAddress: override.remoteAddress || '127.0.0.1' };
    req.headers = { host: '127.0.0.1:4313', origin: 'http://127.0.0.1:4313', 'content-type': 'application/json', 'x-caff-csrf-token': 'synthetic-csrf', ...override.headers };
    let result;
    const res = { writeHead(status) { this.status = status; }, end(data) { result = { status: this.status, body: JSON.parse(data) }; } };
    const pending = controller({ req, res, pathname: '/api/wikiskill' + route });
    req.end(body === undefined ? undefined : JSON.stringify(body));
    assert.equal(await pending, true, 'the category route must be registered'); return result;
  }
  return { ...h, options, calls, invoke };
}
const guards = [{ remoteAddress: '10.1.1.1' }, { headers: { origin: 'http://evil.test' } }, { headers: { 'x-caff-csrf-token': '' } }];
const rejected = (promise, code, status = 422) => assert.rejects(promise, e => e.statusCode === status && e.issues?.[0]?.code === code);

test('standalone category proposal endpoint guards and validates consent before any model call, then returns a full refreshed state', async t => {
  const h = setup(t), before = h.store.read(), bytes = h.bytes(), body = { confirmed: true, expectedRevision: before.revision };
  for (const guard of guards) await assert.rejects(h.invoke('/category-propose', body, guard));
  await rejected(h.invoke('/category-propose', { ...body, confirmed: false }), 'wiki_confirmation_required');
  for (const extra of [{ caseIds: ids }, { model: MODEL }, { globalRoot: h.root }, { credentialDir: h.root }]) {
    await rejected(h.invoke('/category-propose', { ...body, ...extra }), 'wiki_invalid_input');
  }
  await rejected(h.invoke('/category-propose', { ...body, expectedRevision: 0 }), 'wiki_revision_conflict', 409);
  assert.equal(h.calls.length, 0); assert.deepEqual(h.bytes(), bytes);
  const result = await h.invoke('/category-propose', body);
  assert.equal(h.calls.length, 1); assert.equal(result.status, 200); assert.equal(result.body.revision, before.revision + 1);
  assert.equal(result.body.categoryProposalViews.length, 1); assert.equal(result.body.categoryProposalViews[0].status, 'pending');
  assert.ok(Array.isArray(result.body.casePatterns)); assert.ok(result.body.initialSplitProposal);
  assert.deepEqual(h.store.read().patternLabels, before.patternLabels); assert.deepEqual(h.store.read().cases, before.cases);
});

test('category confirmation and rejection endpoints are local-admin/CSRF guarded, closed, revision/hash-bound and never call a model', async t => {
  const h = setup(t);
  const saved = h.store.recordCategoryProposals({ caseIds: ids, model: MODEL, proof, proposals: [proposal] }, h.store.read().revision).proposals[0];
  const get = await h.invoke(), body = { confirmed: true, expectedRevision: get.body.revision, proposalHash: saved.hash,
    name: saved.name, scope: saved.scope, members: saved.members.map(m => ({ caseId: m.caseId,
      labelHash: get.body.casePatterns.find(l => l.caseId === m.caseId).labelHash })) };
  const reject = { confirmed: true, expectedRevision: get.body.revision, proposalHash: saved.hash };
  const before = h.bytes();
  for (const [route, request] of [['/category-confirm', body], ['/category-reject', reject]]) {
    for (const guard of guards) await assert.rejects(h.invoke(route, request, guard));
    await rejected(h.invoke(route, { ...request, confirmed: false }), 'wiki_confirmation_required');
    await rejected(h.invoke(route, { ...request, split: 'train' }), 'wiki_invalid_input');
    await rejected(h.invoke(route, { ...request, expectedRevision: 0 }), 'wiki_revision_conflict', 409);
    await rejected(h.invoke(route, { ...request, proposalHash: hash('different proposal') }), 'wiki_category_proposal_not_found', 404);
  }
  assert.equal(h.calls.length, 0); assert.deepEqual(h.bytes(), before);
  const result = await h.invoke('/category-confirm', body);
  assert.equal(result.body.revision, get.body.revision + 1); assert.equal(result.body.categoryProposalViews[0].status, 'accepted');
  assert.equal(result.body.pendingPatterns.length, 1); assert.equal(h.calls.length, 0);
  assert.ok(ids.every(id => result.body.casePatterns.find(l => l.caseId === id).confirmed));
  assert.ok(ids.every(id => result.body.cases.find(c => c.id === id).split === null));
});

test('combined induct HTTP action uses the fake model twice and publishes the refreshed suggestion state only', async t => {
  const h = setup(t), state = h.store.read(); delete state.cases.find(c => c.id === 'new-4').preclassification;
  state.revision++; h.publish(state); let calls = 0;
  h.options.runInduction = input => require('../../scripts/badcase-capture/wiki-induction.cjs').inductWikiCases({ ...input, confirmed: true }, {
    proposeCategories: true, readKey: () => 'synthetic-only-key', writeDiagnostic: () => {}, execute: async (_image, files) => {
      const plan = JSON.parse(files[0].bytes); calls++;
      return { cleaned: true, receipt: { ok: true, calls: [], ...(plan.phase === 'preclassification'
        ? { results: [{ caseId: 'new-4', kind: 'new', confidence: '高', reason: 'Synthetic' }] }
        : { proposals: [proposal] }) } };
    },
  });
  const before = h.store.read(), bytes = h.bytes(), body = { confirmed: true, expectedRevision: before.revision };
  for (const guard of guards) await assert.rejects(h.invoke('/induct', body, guard));
  await rejected(h.invoke('/induct', { ...body, caseIds: ids }), 'wiki_invalid_input');
  assert.equal(calls, 0); assert.deepEqual(h.bytes(), bytes);
  const response = await h.invoke('/induct', body);
  assert.equal(calls, 2); assert.equal(response.body.revision, before.revision + 1); assert.equal(response.body.categoryProposalViews[0].status, 'pending');
  assert.deepEqual(response.body.patternLabels, before.patternLabels); assert.deepEqual(response.body.versions, before.versions);
});

test('reject endpoint resolves only the proposal; repeated GETs neither run models nor write', async t => {
  const h = setup(t), saved = h.store.recordCategoryProposals({ caseIds: ids, model: MODEL, proof, proposals: [proposal] }, h.store.read().revision).proposals[0];
  const state = h.store.read();
  const result = await h.invoke('/category-reject', { confirmed: true, expectedRevision: state.revision, proposalHash: saved.hash });
  assert.equal(result.body.categoryProposalViews[0].status, 'rejected');
  assert.deepEqual(h.store.read().cases, state.cases); assert.deepEqual(h.store.read().patternLabels, state.patternLabels);
  assert.deepEqual(h.store.read().categoryProposals, state.categoryProposals);
  const bytes = h.bytes(); await h.invoke(); await h.invoke(); assert.deepEqual(h.bytes(), bytes); assert.equal(h.calls.length, 0);
});
