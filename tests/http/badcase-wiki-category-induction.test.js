const test = require('node:test'), assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { setup: fixture } = require('../helpers/wiki-category-induction.cjs');
const { createBadcaseWikiController } = require('../../build/server/api/badcase-wiki-controller');
function setup(t, allocated = true) {
  const h = fixture(t, allocated); let calls = 0;
  const options = { ...h.options, projectManager: { listProjects: () => [] }, host: '127.0.0.1', port: 4313, csrfToken: 'synthetic-csrf',
    runCategoryInduction: async input => { calls++; assert.equal(input.pendingPatternId, h.categoryId); return input.store.recordCategoryInduction(h.request(), input.expectedRevision); } };
  const controller = createBadcaseWikiController(options);
  async function invoke(route = '', body, override = {}) {
    const req = new PassThrough(); req.method = body === undefined ? 'GET' : 'POST'; req.socket = { remoteAddress: override.remoteAddress || '127.0.0.1' };
    req.headers = { host: '127.0.0.1:4313', origin: 'http://127.0.0.1:4313', 'content-type': 'application/json', 'x-caff-csrf-token': 'synthetic-csrf', ...override.headers };
    let result; const res = { writeHead(status) { this.status = status; }, end(data) { result = { status: this.status, body: JSON.parse(data) }; } };
    const pending = controller({ req, res, pathname: '/api/wikiskill' + route }); req.end(body === undefined ? undefined : JSON.stringify(body));
    assert.equal(await pending, true); return result;
  }
  return { ...h, invoke, calls: () => calls, options };
}
const guards = [{ remoteAddress: '10.1.1.1' }, { headers: { origin: 'http://evil.test' } }, { headers: { 'x-caff-csrf-token': '' } }];
const rejected = (promise, code, status = 422) => assert.rejects(promise, e => e.statusCode === status && e.issues?.[0]?.code === code);

test('category induction HTTP route is local-admin/CSRF, closed, consent/revision bound, and preflights eligibility before model', async t => {
  const h = setup(t), bytes = h.bytes(), body = { confirmed: true, pendingPatternId: h.categoryId, expectedRevision: h.store.read().revision };
  for (const guard of guards) await assert.rejects(h.invoke('/category-induct', body, guard));
  await rejected(h.invoke('/category-induct', { ...body, confirmed: false }), 'wiki_confirmation_required');
  await rejected(h.invoke('/category-induct', { ...body, expectedRevision: 0 }), 'wiki_revision_conflict', 409);
  await rejected(h.invoke('/category-induct', { ...body, expectedRevision: undefined }), 'wiki_invalid_input');
  for (const extra of [{ caseIds: h.trainIds }, { scope: 'forbidden' }, { model: 'other' }, { credentialDir: h.root }]) await rejected(h.invoke('/category-induct', { ...body, ...extra }), 'wiki_invalid_input');
  assert.equal(h.calls(), 0); assert.deepEqual(h.bytes(), bytes);
  const notReady = setup(t, false); await rejected(notReady.invoke('/category-induct', { ...body, pendingPatternId: notReady.categoryId, expectedRevision: notReady.store.read().revision }), 'wiki_category_not_ready', 409);
  assert.equal(notReady.calls(), 0);
  const result = await h.invoke('/category-induct', body); assert.equal(result.status, 200); assert.equal(h.calls(), 1);
  assert.equal(result.body.revision, body.expectedRevision + 1); assert.equal(result.body.versions.at(-1).entries.at(-1).sourcePendingPatternId, h.categoryId);
  assert.ok(result.body.casePatterns); assert.ok(result.body.caseStates); assert.ok(result.body.initialSplitProposal);
});

test('existing knowledge review HTTP entry also atomically approves category membership and link with modified prose', async t => {
  const h = setup(t), saved = h.draft(), current = h.store.read(), before = h.bytes();
  const body = { confirmed: true, versionId: saved.version.id, entryId: saved.version.entries.at(-1).id, decision: 'approved', expectedRevision: current.revision,
    patch: { title: saved.version.entries.at(-1).title, failureMode: '修改失败模式', symptoms: '修改表现', rootCauseHypothesis: '修改原因推测', guideline: '先检查约束再执行工具调用。' } };
  for (const guard of guards) await assert.rejects(h.invoke('/review', body, guard));
  await rejected(h.invoke('/review', { ...body, confirmed: false }), 'wiki_confirmation_required');
  await rejected(h.invoke('/review', { ...body, expectedRevision: 0 }), 'wiki_revision_conflict', 409);
  await rejected(h.invoke('/review', { ...body, patch: { guideline: '字'.repeat(301) } }), 'wiki_guideline_too_long');
  assert.deepEqual(h.bytes(), before);
  const response = await h.invoke('/review', body); assert.equal(response.body.revision, current.revision + 1);
  assert.equal(response.body.pendingPatternLinks[0].entryId, body.entryId);
  for (const caseId of h.trainIds) assert.ok(response.body.caseStates.find(c => c.caseId === caseId).memberships.some(m => m.entryId === body.entryId));
  assert.ok(response.body.casePatterns.filter(l => l.pendingPatternId === h.categoryId).every(l => l.entryId === body.entryId));
  assert.equal(h.calls(), 0);
});
