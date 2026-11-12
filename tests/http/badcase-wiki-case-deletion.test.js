const test = require('node:test'), assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const fixture = require('../helpers/wiki-case-deletion.cjs');
function setup(t) {
  const h = fixture(t);
  const options = { ...h.scope, host: '127.0.0.1', port: 4313, csrfToken: 'synthetic-csrf' };
  const controller = require('../../build/server/api/badcase-wiki-controller').createBadcaseWikiController(options);
  async function invoke(body, patch = {}) {
    const req = new PassThrough(); req.method = body === undefined ? 'GET' : 'POST'; req.socket = { remoteAddress: patch.remoteAddress || '127.0.0.1' };
    req.headers = { host: '127.0.0.1:4313', origin: 'http://127.0.0.1:4313', 'content-type': 'application/json', 'x-caff-csrf-token': 'synthetic-csrf', ...patch.headers };
    let result; const res = { writeHead(status) { this.status = status; }, end(bytes) { result = { status: this.status, body: patch.text ? String(bytes) : JSON.parse(bytes) }; } };
    const pending = controller({ req, res, pathname: patch.pathname || '/api/wikiskill' + (body === undefined ? '' : '/case-delete') });
    req.end(body === undefined ? undefined : JSON.stringify(body)); assert.equal(await pending, true); return result;
  }
  return { ...h, invoke };
}
const rejects = (promise, code, status = 422) => assert.rejects(promise, e => e.statusCode === status && e.issues?.[0]?.code === code);
const body = { confirmed: true, caseId: 'synthetic-22', reason: '旧工具问题已解决', expectedRevision: 1 };

test('page delete is guarded, single-case, confirmation/reason/revision required, provenance cannot be forged', async t => {
  const h = setup(t), before = h.store.read();
  for (const patch of [{ remoteAddress: '10.1.1.1' }, { headers: { origin: 'http://evil.test' } }, { headers: { 'x-caff-csrf-token': '' } }]) await assert.rejects(h.invoke(body, patch));
  for (const patch of [{ confirmed: false }, { confirmed: undefined }]) await rejects(h.invoke({ ...body, ...patch }), 'wiki_confirmation_required');
  for (const patch of [{ reason: '' }, { reason: '  ' }]) await rejects(h.invoke({ ...body, ...patch }), 'wiki_invalid_text');
  await rejects(h.invoke({ ...body, expectedRevision: undefined }), 'wiki_invalid_input');
  await rejects(h.invoke({ ...body, expectedRevision: 0 }), 'wiki_revision_conflict', 409);
  for (const patch of [{ confirmation: { source: 'user-via-planner', reference: 'forged' } }, { caseIds: ['synthetic-22', 'synthetic-23'] }]) await rejects(h.invoke({ ...body, ...patch }), 'wiki_invalid_input');
  assert.deepEqual(h.store.read(), before);
  const response = await h.invoke(body); assert.equal(response.status, 200);
  assert.equal(response.body.cases.some(c => c.id === body.caseId), false);
  assert.deepEqual(response.body.deletedCases[0].confirmation, { source: 'badcase-page' });
  assert.equal(response.body.deletedCases[0].caseNumber, 22);
  assert.deepEqual(response.body.cases.slice(-2).map(c => c.displayNumber), [23, 24]);
  assert.deepEqual(response.body, (await h.invoke()).body);
});

test('running precheck returns actionable conflict; archived trace and run/report exports remain readable', async t => {
  const h = setup(t), base = '../../build/server/domain/runtime/badcase-capture/';
  const records = require(base + 'wiki-original-precheck-store').createWikiOriginalPrecheckStore(h.scope), r = records.reserve(h.precheck());
  await rejects(h.invoke(body), 'wiki_case_in_use', 409);
  records.finish(r.id, { status: 'failed', reason: 'synthetic_stop', runs: [] });
  const runs = require(base + 'wiki-run-store').createWikiRunStore(h.scope);
  const reservation = runs.reserve({ schemaVersion: 1, kind: 'wikiskill-run-request', variant: { kind: 'original' }, metadata: { caseId: body.caseId, traceHash: h.state.cases.find(c => c.id === body.caseId).traceBundle.hash, decisionHash: 'a'.repeat(64) } });
  runs.finish(reservation.id, { outcome: { status: 'reached' }, modelCalls: 0, toolExecutions: 0 });
  await h.invoke(body);
  const trace = await h.invoke(undefined, { pathname: '/api/wikiskill/cases/synthetic-22/trace' });
  assert.deepEqual(trace.body.traceBundle, h.packets.get(body.caseId));
  for (const suffix of ['', '/export.json', '/export.md']) {
    const result = await h.invoke(undefined, { pathname: '/api/wikiskill/cases/synthetic-22/run-replays/' + reservation.id + suffix, text: suffix.endsWith('.md') });
    assert.equal(result.status, 200); assert.ok(result.body);
  }
  const view = await h.invoke(); assert.equal(view.body.runReplays.length, 1); assert.equal(view.body.dehydrations.length, h.state.dehydrations.length);
  assert.equal(view.body.rubrics.length, h.state.rubrics.length);
  const archive = view.body.archivedPrechecks.find(r => r.caseId === body.caseId);
  assert.equal(archive.current, null); assert.equal(archive.reproduced, false);
  assert.equal(archive.history[0].id, r.id); assert.equal(archive.history[0].current, false);
  assert.equal(archive.history[0].status, 'failed');
  assert.equal(view.body.pipelineStates.some(r => r.caseId === body.caseId), false);
});
