const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { createBadcaseEvaluationsController } = require('../../build/server/api/badcase-evaluations-controller');
const { createEvaluationAdminService } = require('../../build/server/domain/runtime/badcase-capture/evaluation-admin');
const { spec } = require('../helpers/badcase-offline-spec.cjs');
async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-offline-http-'));
  let controller, authority;
  const options = { host: '127.0.0.1', getAuthority: () => authority, csrfToken: 'synthetic-only', projectManager: { listProjects: () => [{ id: 'p1' }, { id: 'p2' }] } };
  const rebuild = service => { controller = createBadcaseEvaluationsController({ ...options, service: service || createEvaluationAdminService({ root }) }); };
  const server = http.createServer(async (req, res) => {
    try { if (await controller({ req, res, pathname: new URL(req.url, 'http://test').pathname })) return; res.writeHead(404); res.end('{}'); }
    catch (e) { res.writeHead(e.statusCode || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ issues: e.issues || [] })); }
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); authority = `127.0.0.1:${server.address().port}`; rebuild();
  return { root, rebuild, async request(action, body, extra = {}, project = 'p1') {
    return new Promise((resolve, reject) => {
      const req = http.request(`http://${authority}/api/projects/${project}/badcase-evaluations/${action}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', origin: `http://${authority}`, 'x-caff-csrf-token': 'synthetic-only', ...extra },
      }, res => { let text = ''; res.on('data', b => { text += b; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) })); });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  } };
}
test('real HTTP preview/confirmation/query/rebuild uses durable records and no launch endpoint', async t => {
  const h = await setup(t), p = await h.request('preview', { spec: spec() });
  assert.equal(p.status, 200); assert.deepEqual(fs.readdirSync(h.root), []);
  const input = { confirmed: true, approvalId: p.body.approvalId, planHash: p.body.plan.planHash };
  const r = await h.request('approve', input); assert.equal(r.status, 200);
  assert.equal(r.body.report.dispatchState, 'approved'); assert.equal(r.body.launchAvailable, false);
  assert.deepEqual(await h.request('approve', input), r);
  h.rebuild(); assert.deepEqual(await h.request('records/' + input.approvalId), r);
  assert.equal((await h.request('approve', input)).status, 409);
  assert.equal((await h.request('records/' + input.approvalId, undefined, {}, 'p2')).status, 409);
  assert.equal((await h.request('dispatch', input)).status, 404);
  assert.equal((await h.request('approve')).status, 404);
});
test('CSRF, origin, host, JSON and missing project fail before service access', async t => {
  const h = await setup(t); let calls = 0;
  h.rebuild({ preview() { calls++; }, approve() { calls++; }, read() { calls++; } });
  for (const [headers, code] of [[{ 'x-caff-csrf-token': '' }, 'csrf_invalid'], [{ origin: 'http://other.invalid' }, 'origin_mismatch'], [{ host: 'other.invalid' }, 'host_mismatch']]) {
    const r = await h.request('preview', { spec: spec() }, headers); assert.equal(r.status, 403); assert.equal(r.body.issues[0].code, 'badcase_evaluation_' + code);
  }
  assert.equal((await h.request('preview', {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await h.request('preview', {}, {}, 'missing')).status, 404);
  assert.equal(calls, 0);
});
test('paid provider, forged approval, path injection and body overflow cannot persist', async t => {
  const h = await setup(t);
  for (const s of [{ ...spec(), captureRoot: '/host' }, { ...spec(), model: { ...spec().model, provider: 'paid' } }]) assert.equal((await h.request('preview', { spec: s })).status, 422);
  assert.equal((await h.request('approve', { confirmed: true, approvalId: 'fake', planHash: '0'.repeat(64) })).status, 409);
  assert.equal((await h.request('preview', { data: 'x'.repeat(20000) })).status, 413);
  assert.deepEqual(fs.readdirSync(h.root), []);
});
test('unknown exception text and attacker error codes never leave boundary', async t => {
  const h = await setup(t); h.rebuild({ preview() { throw Object.assign(Error('PRIVATE-SENTINEL'), { code: 'PRIVATE-SENTINEL' }); } });
  const r = await h.request('preview', { spec: spec() }); assert.equal(r.status, 503);
  assert.equal(r.body.issues[0].code, 'badcase_evaluation_unavailable'); assert.doesNotMatch(JSON.stringify(r), /PRIVATE-SENTINEL/);
});
test('production composition wires fixed agentDir storage, guard and controller, no adapter', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../server/app/create-server.ts'), 'utf8');
  assert.match(source, /createEvaluationAdminService\(\{ root: path.join\(agentDir, 'badcase-offline-evaluations'\)/);
  assert.match(source, /createBadcaseEvaluationsController\(\{\s+service: badcaseEvaluations,/);
  assert.doesNotMatch(source, /scripted-evaluation|dispatchRecordedEvaluation/);
});
