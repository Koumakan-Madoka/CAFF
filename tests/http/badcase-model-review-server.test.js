const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawnSync, spawn } = require('node:child_process');
const { startModelReviewServer, readRegistry } = require('../../scripts/badcase-capture/model-review-server.cjs');
const { entry, confirm } = require('../helpers/badcase-model-review.cjs');
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-review-http-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true })); return { temp, root: path.join(temp, 'store'), e: entry() };
}
async function request(url, suffix, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url + suffix, { method, headers }, res => {
      const parts = []; res.on('data', b => parts.push(b)); res.on('end', () => {
        const text = Buffer.concat(parts).toString(); let json; try { json = JSON.parse(text); } catch { /* static asset */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    }); req.on('error', reject); req.end(body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
}
test('real loopback review HTTP: CSRF/origin/host, dual confirmation, query after server restart, no launch routes', async t => {
  const f = fixture(t); let server = await startModelReviewServer({ root: f.root, entries: [f.e] });
  t.after(() => server.close());
  const bootstrap = await request(server.url, '/api/bootstrap');
  const headers = { Origin: server.url, 'Content-Type': 'application/json', 'X-CAFF-CSRF-Token': bootstrap.json.localAdmin.modelProviders.csrfToken };
  const base = '/api/model-review/' + f.e.projectId;
  for (const bad of [{ ...headers, Origin: 'http://external.example' }, { ...headers, 'X-CAFF-CSRF-Token': 'wrong' }, { ...headers, Host: 'external.example' }]) {
    assert.equal((await request(server.url, base + '/preview', { method: 'POST', body: { entryId: f.e.id }, headers: bad })).status, 403);
  }
  assert.equal((await request(server.url, base + '/preview', { method: 'POST', body: {}, headers: { ...headers, 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request(server.url, base + '/preview', { method: 'POST', body: 'x'.repeat(2049), headers })).status, 413);
  assert.equal((await request(server.url, base + '/preview', { method: 'POST', body: '{', headers })).status, 400);
  assert.equal((await request(server.url, base + '/preview', { method: 'POST', body: Buffer.from([0xff]), headers })).status, 400);
  assert.equal((await request(server.url, '/', { headers: { Host: 'external.example' } })).status, 403);
  assert.equal((await request(server.url, base + '/entries')).json.entries[0].id, f.e.id);
  const p = (await request(server.url, base + '/preview', { method: 'POST', body: { entryId: f.e.id }, headers })).json;
  assert.equal(fs.existsSync(f.root), false);
  const b = confirm(p);
  assert.equal((await request(server.url, base + '/approve', { method: 'POST', body: { ...b, confirmed: false }, headers })).status, 422);
  const approved = await request(server.url, base + '/approve', { method: 'POST', body: b, headers });
  assert.equal(approved.status, 200); assert.equal(approved.json.report.consumed, false); assert.equal(approved.json.launchAvailable, false);
  assert.deepEqual((await request(server.url, base + '/approve', { method: 'POST', body: b, headers })).json, approved.json);
  for (const suffix of ['/start', '/dispatch', '/credentials']) assert.equal((await request(server.url, base + suffix, { method: 'POST', body: b, headers })).status, 404);
  assert.equal((await request(server.url, '/api/projects/' + f.e.projectId + '/badcase-evaluations/approve', { method: 'POST', body: b, headers })).status, 404);
  const page = await request(server.url, '/'); assert.match(page.headers['content-security-policy'], /default-src 'none'/); assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal((await request(server.url, '/shared/model-review.js')).status, 200); assert.equal((await request(server.url, '/package.json')).status, 404);
  await server.close(); server = await startModelReviewServer({ root: f.root, entries: [] });
  assert.deepEqual((await request(server.url, base + '/records/' + p.approvalId)).json, approved.json);
  const fresh = (await request(server.url, '/api/bootstrap')).json.localAdmin.modelProviders.csrfToken;
  assert.equal((await request(server.url, base + '/approve', { method: 'POST', body: b,
    headers: { ...headers, Origin: server.url, 'X-CAFF-CSRF-Token': fresh } })).status, 409);
  assert.equal((await request(server.url, '/api/model-review/other/records/' + p.approvalId)).status, 409);
});
test('real operator CLI listens only loopback, has no start, stops owned child without writing preview storage', { timeout: 10000 }, async t => {
  const f = fixture(t), file = path.join(f.temp, 'registry.json'); fs.writeFileSync(file, JSON.stringify([f.e]));
  const child = spawn(process.execPath, ['scripts/badcase-capture/model-review-server.cjs', '--root', f.root, '--registry', file],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
  const ready = await new Promise((resolve, reject) => {
    let text = ''; child.once('error', reject);
    child.stdout.on('data', bytes => { text += bytes.toString(); if (text.length > 4096) return reject(Error('oversize')); if (text.includes('\n')) { try { resolve(JSON.parse(text.trim())); } catch (e) { reject(e); } } });
    child.once('exit', () => reject(Error('early_exit')));
  });
  assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+$/); assert.equal(ready.launchAvailable, false);
  assert.equal((await request(ready.url, '/api/model-review/' + f.e.projectId + '/entries')).status, 200);
  assert.equal((await request(ready.url, '/api/model-review/' + f.e.projectId + '/start', { method: 'POST' })).status, 404);
  assert.equal(fs.existsSync(f.root), false); child.kill('SIGTERM'); await exited;
});

test('operator registry bounded strict read; invalid registry fails before listen/storage; CLI invalid arguments do not serve', async t => {
  const f = fixture(t), file = path.join(f.temp, 'registry.json'); fs.writeFileSync(file, JSON.stringify([f.e]));
  assert.deepEqual(readRegistry(file), [f.e]); assert.throws(() => readRegistry('relative'));
  fs.writeFileSync(file, '[]'.padEnd(262144, ' ')); assert.deepEqual(readRegistry(file), []);
  for (const bytes of [Buffer.from('[]'.padEnd(262145, ' ')), Buffer.from([0x22, 0xff, 0x22]), Buffer.from('{')]) { fs.writeFileSync(file, bytes); assert.throws(() => readRegistry(file)); }
  await assert.rejects(startModelReviewServer({ root: f.root, entries: [{ ...f.e, unknown: true }] })); assert.equal(fs.existsSync(f.root), false);
  const child = spawnSync(process.execPath, ['scripts/badcase-capture/model-review-server.cjs', '--unexpected'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 1); assert.equal(child.stdout, ''); assert.equal(child.stderr.trim(), 'model_review_start_failed');
});
