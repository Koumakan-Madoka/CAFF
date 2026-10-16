const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const Module = require('node:module');
const { createModelReviewService } = require('../../build/server/domain/runtime/badcase-capture/model-review');
const { modelBinding } = require('../../build/server/domain/runtime/badcase-capture/model-binding');
const { planEvaluation } = require('../../build/server/domain/runtime/badcase-capture/evaluation-plan');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
function fixture(t, exerciseAuth = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-model-operator-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { settings: { provider: 'synthetic', model: 'fixture', contextWindowTokens: 1000, maxOutputTokens: 100, temperature: 0,
    inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 1, maxRequestBytes: 4096, maxResponseBytes: 4096 },
    endpoint: { hostname: 'api.example.com', address: '93.184.216.34', path: '/v1/chat/completions', timeoutMs: 1000, maxRequestBytes: 4096, maxResponseBytes: 4096 }, maxRequests: 2,
    tools: [{ type: 'function', function: { name: 'read', description: 'synthetic', parameters: { type: 'object' } } }] };
  const binding = modelBinding(config);
  const plan = planEvaluation({ caseId: 'case', checkpointHash: hash('cp'), inputHash: hash('input'), environmentHash: hash('env'), harnessHash: hash('harness'),
    roleId: 'role', baselineRoleHash: hash('baseline'), candidateRoleHash: hash('candidate'), model: { provider: 'synthetic', id: 'fixture', settingsHash: binding.bindingHash },
    evaluator: { id: 'file-sha256-v1', versionHash: hash('scorer') }, repetitions: 1, timeoutMs: 5000, perRunLimitMicroUsd: 10, totalLimitMicroUsd: 20 });
  const service = createModelReviewService({ root, entries: [{ projectId: 'p1', id: 'one', spec: plan.spec, config }] });
  const ticket = service.preview('p1', { entryId: 'one' });
  service.approve('p1', { confirmed: true, approvalId: ticket.approvalId, planHash: plan.planHash, bindingHash: binding.bindingHash });
  const c = { root, selection: { projectId: 'p1', id: 'one' } }, calls = [];
  const file = require.resolve('../../scripts/badcase-capture/model-evaluation-operator.cjs');
  const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file)); const native = m.require.bind(m);
  const prepared = { plan, review: { binding }, execute: () => assert.fail('not a container test') };
  m.require = name => {
    if (name === './sealed-workbench.cjs') return { selectSealedMaterials: () => [{ request: {} }] };
    if (name === './model-evaluation.cjs') return { prepareModelEvaluation: () => prepared };
    if (name === './image-recovery.cjs') return { restoreImageArchive: async () => {
      calls.push('restore'); assert.equal(fs.existsSync(path.join(root, hash('p1'), 'launch-' + hash(ticket.approvalId) + '.json')), true);
      return { runProbe: () => assert.fail('not a container test') };
    } };
    if (name.endsWith('/model-binding')) return { ...native(name), dispatchBoundModelEvaluation: async (scope, id, _drive, credential) => {
      calls.push('dispatch'); assert.equal(scope, path.join(root, hash('p1'))); assert.equal(id, ticket.approvalId);
      if (exerciseAuth) {
        assert.equal(Object.hasOwn(process.env, 'CAFF_EVALUATION_MODEL_KEY'), false);
        assert.equal(credential(binding.endpointHash).value, 'synthetic-inert'); calls.push('lease');
      }
      return 'dispatched';
    } };
    return native(name);
  };
  m._compile(fs.readFileSync(file, 'utf8'), file);
  return { c, calls, prepared, ticket, config, root, operator: m.exports };
}
test('explicit run requires separate confirmation, exact rebuilt plan, and records intent before restore/dispatch', async t => {
  const f = fixture(t); let credentials = 0; const credential = () => { credentials++; };
  await assert.rejects(f.operator.runOperator(f.c, f.ticket.approvalId, false, credential)); assert.deepEqual(f.calls, []);
  const original = f.prepared.plan.planHash; f.prepared.plan.planHash = hash('changed');
  await assert.rejects(f.operator.runOperator(f.c, f.ticket.approvalId, true, credential)); assert.deepEqual(f.calls, []);
  f.prepared.plan.planHash = original;
  assert.equal(await f.operator.runOperator(f.c, f.ticket.approvalId, true, credential), 'dispatched');
  assert.deepEqual(f.calls, ['restore', 'dispatch']); assert.equal(credentials, 0);
  await assert.rejects(f.operator.runOperator(f.c, f.ticket.approvalId, true, credential)); // immutable one-shot launch intent
  assert.deepEqual(f.calls, ['restore', 'dispatch']);
});
test('operator history query does not need current material or a running daemon', t => {
  const f = fixture(t); f.prepared.plan.planHash = hash('now unavailable');
  const report = f.operator.readOperatorReport(f.c, f.ticket.approvalId);
  assert.equal(report.report.ledger.planHash, f.ticket.plan.planHash); assert.deepEqual(f.calls, []);
});
test('CLI rejects absent explicit confirmation without reading generic provider credentials or emitting them', () => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, ['scripts/badcase-capture/model-evaluation-operator.cjs', '--run', 'anything'],
    { encoding: 'utf8', env: { PATH: process.env.PATH, OPENAI_API_KEY: 'SYNTHETIC-DO-NOT-PRINT' } });
  assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr, 'model_evaluation_operator_failed\n');
});
function cliFixture(t) {
  const f = fixture(t, true);
  const c = { root: f.root, captureRoot: f.root, selection: { id: 'one', projectId: 'p1', conversationId: 'c1', messageId: 'm1' },
    image: {}, imageArchive: {}, sources: {}, roles: {}, rule: {}, model: f.config, limits: {}, target: {}, productionResourcesExcluded: true };
  const file = path.join(f.root, 'operator.json'); fs.writeFileSync(file, JSON.stringify(c));
  const source = path.join(f.root, 'models.json'); fs.writeFileSync(source, JSON.stringify({ providers: { synthetic: {
    api: 'openai-completions', baseUrl: 'https://api.example.com/v1', apiKey: 'synthetic-inert', models: [{ id: 'fixture' }] } } }));
  const original = process.env.CAFF_EVALUATION_MODEL_KEY;
  t.after(() => { if (original === undefined) delete process.env.CAFF_EVALUATION_MODEL_KEY; else process.env.CAFF_EVALUATION_MODEL_KEY = original; });
  const log = console.log, output = []; console.log = line => output.push(String(line)); t.after(() => { console.log = log; });
  return { ...f, file, source, output };
}
test('reuse CLI keeps original paid confirmation, deletes inherited dedicated key and records only public source declaration', async t => {
  const f = cliFixture(t); process.env.CAFF_EVALUATION_MODEL_KEY = 'MUST-NOT-BE-INHERITED';
  const base = ['--config', f.file, '--run', f.ticket.approvalId, '--confirm-paid'];
  for (const args of [[...base, '--reuse-models', f.source], [...base, '--reuse-models', f.source, '--wrong'],
    ['--config', f.file, '--run', f.ticket.approvalId, '--reuse-models', f.source, '--confirm-nonproduction']])
    await assert.rejects(f.operator.main(args));
  assert.deepEqual(f.calls, []);
  await f.operator.main([...base, '--reuse-models', f.source, '--confirm-nonproduction']);
  assert.deepEqual(f.calls, ['restore', 'dispatch', 'lease']); assert.deepEqual(f.output, ['"dispatched"']);
  const text = fs.readFileSync(path.join(f.root, hash('p1'), 'launch-' + hash(f.ticket.approvalId) + '.json'), 'utf8');
  const intent = JSON.parse(text); assert.equal(intent.credentialSource.confirmedNonProduction, true);
  assert.equal(intent.credentialSource.provider, 'synthetic'); assert.equal(text.includes('synthetic-inert'), false);
  assert.equal(text.includes(f.source), false); assert.equal(text.includes('MUST-NOT-BE-INHERITED'), false);
});
test('dedicated key mode also deletes its environment entry before dispatch', async t => {
  const f = cliFixture(t); process.env.CAFF_EVALUATION_MODEL_KEY = 'synthetic-inert';
  await f.operator.main(['--config', f.file, '--run', f.ticket.approvalId, '--confirm-paid']);
  assert.deepEqual(f.calls, ['restore', 'dispatch', 'lease']);
});
test('source declaration must match approved provider/model/endpoint before launch or daemon access', async t => {
  const f = cliFixture(t), { createAuthorizedModelCredential } = require('../../scripts/badcase-capture/authorized-model-auth.cjs');
  const source = createAuthorizedModelCredential({ file: f.source, provider: 'synthetic', model: 'fixture', endpoint: f.config.endpoint, confirmedNonProduction: true });
  for (const patch of [{ provider: 'other' }, { model: 'other' }, { endpointHash: hash('other') }, { confirmedNonProduction: false }, { extra: 'synthetic-inert' }])
    await assert.rejects(f.operator.runOperator(f.c, f.ticket.approvalId, true, source.credential, { ...source.declaration, ...patch }));
  assert.deepEqual(f.calls, []);
});
