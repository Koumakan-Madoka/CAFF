const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { PassThrough } = require('node:stream');
const { createBadcaseWikiController } = require('../../build/server/api/badcase-wiki-controller');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-wiki-api-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const captureRoot = path.join(root, 'capture'), sourceWorktree = path.join(root, 'source');
  const config = { captureRoot, sourceWorktree, projectId: 'p1' }, store = createWikiStore(config);
  const options = { captureRoot, projectManager: { listProjects: () => [{ id: 'p1', path: sourceWorktree }] }, host: '127.0.0.1', port: 4313, csrfToken: 'synthetic-csrf' };
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
    const pending = controller({ req, res, pathname: overrides.pathname || '/api/projects/p1/badcase-wiki' + (body === undefined ? '' : '/review') });
    req.end(body === undefined ? undefined : JSON.stringify(body)); assert.equal(await pending, true); return result;
  }
  return { root, config, options, store, seed, invoke };
}
const rejects = (promise, code, status = 422) => assert.rejects(promise, e => e.statusCode === status && e.issues?.[0]?.code === code);

test('GET is read-only and returns the local external collection without filesystem paths', async t => {
  const h = setup(t), result = await h.invoke();
  assert.equal(result.status, 200); assert.equal(result.body.revision, 0); assert.deepEqual(result.body.cases, []);
  assert.equal(fs.existsSync(h.config.captureRoot), false); assert.equal(fs.existsSync(h.config.sourceWorktree), false);
  assert.equal(JSON.stringify(result).includes(h.root), false);
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
    assert.equal(fs.existsSync(h.config.captureRoot), false);
  }
});
test('confirmation/closed schema, unknown scope and membership edits fail without changing the version', async t => {
  const h = setup(t), v = h.seed();
  const body = { confirmed: true, versionId: v.id, entryId: v.entries[0].id, expectedRevision: 2, decision: 'rejected' };
  for (const confirmed of [false, 'true', 1]) await rejects(h.invoke({ ...body, confirmed }), 'wiki_confirmation_required');
  await rejects(h.invoke({ ...body, captureRoot: 'foreign' }), 'wiki_invalid_input');
  await rejects(h.invoke({ ...body, patch: { caseIds: [] } }), 'wiki_membership_edit_unsupported');
  await rejects(h.invoke(undefined, { pathname: '/api/projects/p2/badcase-wiki' }), 'wiki_project_missing', 404);
  assert.equal(h.store.read().revision, 2);
  const reject = await h.invoke(body); assert.equal(reject.body.versions[0].entries[0].status, 'rejected');
});
test('corrupt storage and unknown exceptions are sanitized, never returning raw paths', async t => {
  const h = setup(t); h.seed();
  const file = path.join(h.config.captureRoot, 'wiki/p1/snapshots/000000000002.json'); fs.writeFileSync(file, 'broken');
  await rejects(h.invoke(), 'wiki_record_invalid', 409);
  const bad = createBadcaseWikiController({ ...h.options, captureRoot: 'not-absolute' });
  const req = { method: 'GET', headers: { host: '127.0.0.1:4313' }, socket: { remoteAddress: '127.0.0.1' } };
  await rejects(bad({ req, res: {}, pathname: '/api/projects/p1/badcase-wiki' }), 'wiki_unavailable', 503);
});
