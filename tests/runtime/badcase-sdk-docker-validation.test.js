// Static staging/coordinator tests only. No SDK/agent/native execution on host.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { prepareSdkDockerValidation } = require('../../scripts/badcase-capture/sdk-docker-validation.cjs');
const { recordBoundModelApproval, readBoundModelApproval, modelBinding } = require('../../build/server/domain/runtime/badcase-capture/model-binding');
const { approvedSdkGatewayHarness } = require('../../scripts/badcase-capture/approved-sdk-model-gateway.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex'), repo = path.resolve(__dirname, '../..');
const image = { imageId: 'sha256:' + 'a'.repeat(64), repositoryDigest: 'example.invalid/node@sha256:' + 'b'.repeat(64),
  architecture: 'amd64', nodeVersion: 'v24.21.0', pythonVersion: 'Python 3.11.2' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-sdk-docker-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inv = require('../../scripts/badcase-capture/evaluation-bridge-files.json');
  for (const n of inv.dependencies) {
    const p = path.join(root, n); fs.mkdirSync(path.dirname(p), { recursive: true }); let b = fs.readFileSync(path.join(repo, n));
    if (n.endsWith('better_sqlite3.node')) { b = Buffer.alloc(64); b.set([127, 69, 76, 70, 2, 1, 1]); b.writeUInt16LE(3, 16); b.writeUInt16LE(62, 18); }
    fs.writeFileSync(p, b);
  }
  const config = { settings: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', contextWindowTokens: 131072, maxOutputTokens: 256,
    temperature: 0, inputMicroUsdPerMillionTokens: 1000000, outputMicroUsdPerMillionTokens: 2000000, maxRequestBytes: 262144, maxResponseBytes: 65536,
    compatibilityProfile: 'opencode-go-deepseek-nonthinking-cached-index0-v1' },
    tools: [{ type: 'function', function: { name: 'read', description: 'Static test declaration', parameters: { type: 'object' } } }], maxRequests: 2,
    endpoint: { hostname: 'opencode.ai', address: '93.184.216.34', path: '/zen/go/v1/chat/completions', clientProfile: 'opencode-go-v1',
      maxRequestBytes: 262144, maxResponseBytes: 65536, timeoutMs: 1000 } };
  const reserve = modelBinding(config).perRequestReserveMicroUsd * 2;
  const q = { caseId: 'new-validation-not-badcase', input: { prompt: 'Perform the validation task.', files: [{ path: 'AGENTS.md', content: 'New validation context.' }] },
    roles: { baseline: 'Validation role baseline.', candidate: 'Validation role candidate.' }, rule: { expectedHash: hash('expected'), badcaseHash: hash('bad') }, config,
    limits: { repetitions: 1, timeoutMs: 25000, perRunLimitMicroUsd: reserve, totalLimitMicroUsd: reserve * 2 } };
  const prepare = value => prepareSdkDockerValidation(repo, root, image, value || q);
  return { root, q, prepare };
}
test('fresh validation launcher binds original distribution, tools, materials, role hashes and host-only scorer without runtime credentials', t => {
  const f = fixture(t), a = f.prepare(), b = f.prepare();
  assert.deepEqual(a.plan, b.plan); assert.equal(a.review.realCapture, false); assert.equal(a.review.faithfulReplay, false);
  assert.equal(a.plan.spec.harnessHash, approvedSdkGatewayHarness(a.review.launchHash).harnessHash);
  assert.equal(a.plan.spec.baselineRoleHash, hash(f.q.roles.baseline)); assert.equal(a.plan.spec.inputHash, hash(JSON.stringify(f.q.input)));
  for (const change of [q => { q.input.prompt += ' changed'; }, q => { q.roles.candidate += ' changed'; }, q => { q.rule.expectedHash = hash('new answer'); },
    q => { q.config.tools[0].function.description += ' changed'; }]) {
    const q = structuredClone(f.q); change(q); assert.notEqual(f.prepare(q).plan.planHash, a.plan.planHash);
  }
  assert.ok(!JSON.stringify(a.review).includes('apiKey'));
});
test('unapproved or mismatched plan/materials cannot reach daemon or credential source; no fresh/resume coercion API', async t => {
  const f = fixture(t), a = f.prepare(); let touched = 0;
  const never = () => { touched++; throw Error('unexpected authority'); };
  await assert.rejects(a.dispatch(f.root, 'absent', never, never));
  const approval = { approvalId: 'static-approval', confirmed: true, expiresAt: Date.now() + 60000, planHash: a.plan.planHash };
  recordBoundModelApproval(f.root, a.plan.spec, f.q.config, approval);
  const q = structuredClone(f.q); q.input.prompt += ' changed';
  await assert.rejects(f.prepare(q).dispatch(f.root, approval.approvalId, never, never));
  assert.equal(readBoundModelApproval(f.root, approval.approvalId).report.consumed, false); assert.equal(touched, 0);
  for (const mutate of [q => { q.input.deliveryMode = 'resume'; }, q => { q.input.files[0].path = '../other'; },
    q => { q.input.files.push({ path: 'AGENTS.md', content: 'duplicate' }); }, q => { q.config.maxRequests = 3; }]) {
    const q = structuredClone(f.q); mutate(q); assert.throws(() => f.prepare(q));
  }
});
test('a Docker lifecycle failure stops the first reserved run without inventing completion, score or retry', async t => {
  const f = fixture(t), a = f.prepare();
  const approval = { approvalId: 'failed-docker-approval', confirmed: true, expiresAt: Date.now() + 60000, planHash: a.plan.planHash };
  recordBoundModelApproval(f.root, a.plan.spec, f.q.config, approval);
  let created = 0;
  const report = await a.dispatch(f.root, approval.approvalId,
    () => ({ value: 'synthetic-never-sent', expiresAt: Date.now() + 30000 }), async (image, files, options) => {
      created++; const outer = readBoundModelApproval(f.root, approval.approvalId).report;
      assert.equal(outer.ledger.state, 'reserved'); assert.equal(outer.ledger.runs.length, 1);
      assert.equal(typeof options.probe, 'function');
      const task = JSON.parse(files.find(f => f.path === 'validation-task.json').bytes);
      assert.equal(task.preflight, false); assert.equal(task.role, f.q.roles.baseline);
      assert.ok(!files.some(f => f.bytes.includes(Buffer.from(f.q.rule.expectedHash))));
      assert.ok(!files.some(f => f.bytes.includes(Buffer.from('synthetic-never-sent'))));
      throw Error('PRIVATE-Daemon-failure');
    });
  assert.equal(created, 1); assert.equal(report.dispatchState, 'unresolved'); assert.equal(report.ledger.runs[0].score, null);
  assert.ok(!JSON.stringify(report).includes('PRIVATE'));
  await assert.rejects(a.dispatch(f.root, approval.approvalId, () => assert.fail(), () => assert.fail()));
  assert.equal(created, 1);
});
test('container worker blocks host execution before any SDK or native import', () => {
  const r = spawnSync(process.execPath, [path.join(repo, 'scripts/badcase-capture/sdk-validation-container.cjs')], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr, 'sdk_validation_container_failed\n');
});
