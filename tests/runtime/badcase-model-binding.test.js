const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { modelBinding, recordBoundModelApproval, readBoundModelApproval, dispatchBoundModelEvaluation } = require('../../build/server/domain/runtime/badcase-capture/model-binding.js');
const { planEvaluation } = require('../../build/server/domain/runtime/badcase-capture/evaluation-plan.js');
const { readEvaluationRecord } = require('../../build/server/domain/runtime/badcase-capture/evaluation-record.js');
const { readModelEgress } = require('../../build/server/domain/runtime/badcase-capture/model-egress.js');
const { encodeChatCompletionsRequest } = require('../../build/server/domain/runtime/badcase-capture/chat-completions-protocol.js');
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const config = () => ({ settings: { provider: 'synthetic', model: 'fixed-model', contextWindowTokens: 1000, maxOutputTokens: 100,
  temperature: 0, inputMicroUsdPerMillionTokens: 1000000, outputMicroUsdPerMillionTokens: 2000000, maxRequestBytes: 4096, maxResponseBytes: 4096 },
  endpoint: { hostname: 'api.caff-test.example', address: '93.184.216.34', path: '/v1/chat/completions', maxRequestBytes: 4096, maxResponseBytes: 4096, timeoutMs: 1000 }, maxRequests: 2 });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-binding-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const c = config(), binding = modelBinding(c);
  const spec = { caseId: 'synthetic-case', checkpointHash: hash('checkpoint'), inputHash: hash('input'), environmentHash: hash('env'), harnessHash: hash('harness'),
    roleId: 'role', baselineRoleHash: hash('base'), candidateRoleHash: hash('candidate'), model: { provider: 'synthetic', id: 'fixed-model', settingsHash: binding.bindingHash },
    evaluator: { id: 'synthetic-score', versionHash: hash('scorer') }, repetitions: 1, timeoutMs: 5000, perRunLimitMicroUsd: 2400, totalLimitMicroUsd: 4800 };
  const plan = planEvaluation(spec), approval = { confirmed: true, approvalId: 'synthetic-approval', planHash: plan.planHash, expiresAt: Date.now() + 60000 };
  return { root, c, spec, plan, approval, archive: path.join(root, 'model-bindings', hash(approval.approvalId) + '.json'),
    evaluation: path.join(root, 'evaluations', hash(approval.approvalId)) };
}
const rejected = e => /^model_binding_/.test(e.code) && e.message === e.code;
function approve(f) { return recordBoundModelApproval(f.root, f.spec, f.c, f.approval); }
function mutate(file, change) { const v = JSON.parse(fs.readFileSync(file)); change(v); fs.writeFileSync(file, JSON.stringify(v)); }
function fakeNetwork(t, reply) {
  const original = https.request, calls = []; t.after(() => { https.request = original; });
  https.request = options => {
    const req = new EventEmitter(), socket = new EventEmitter(), res = new PassThrough();
    Object.assign(socket, { encrypted: true, authorized: true, remoteAddress: options.hostname });
    Object.assign(res, { headers: { 'content-type': 'application/json' }, statusCode: 200, complete: true });
    req.destroy = () => res.destroy();
    req.end = body => { calls.push({ options, body }); queueMicrotask(() => { req.emit('response', res); res.end(JSON.stringify(reply || {
      id: 'synthetic', object: 'chat.completion', created: 1, model: 'fixed-model', choices: [{ index: 0, message: { role: 'assistant', content: 'synthetic-reply' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })); }); };
    queueMicrotask(() => { req.emit('socket', socket); socket.emit('secureConnect'); }); return req;
  }; return calls;
}
const body = f => encodeChatCompletionsRequest(f.c.settings, [{ role: 'user', content: 'synthetic-question' }]);
const result = (run, costMicroUsd = 40) => ({ runId: run.runId, status: 'completed', costMicroUsd, outputHash: hash('synthetic-output'), score: { expectationMet: true, badcaseReproduced: false } });
const lease = () => ({ value: 'synthetic-lease', expiresAt: Date.now() + 60000 });

test('binding hash commits all endpoint/settings/rate/cap fields, stable order, no implicit defaults', () => {
  const c = config(), b = modelBinding(c);
  assert.equal(modelBinding({ maxRequests: 2, endpoint: { ...c.endpoint }, settings: Object.fromEntries(Object.entries(c.settings).reverse()) }).bindingHash, b.bindingHash);
  for (const [section, key, value] of [['endpoint', 'address', '8.8.8.8'], ['endpoint', 'path', '/different'], ['endpoint', 'timeoutMs', 999],
    ['settings', 'temperature', 1], ['settings', 'inputMicroUsdPerMillionTokens', 1000001], ['settings', 'maxOutputTokens', 99]]) {
    const other = structuredClone(c); other[section][key] = value; assert.notEqual(modelBinding(other).bindingHash, b.bindingHash);
  }
  assert.notEqual(modelBinding({ ...c, maxRequests: 1 }).bindingHash, b.bindingHash);
  for (const other of [{ ...c, extra: 1 }, { ...c, maxRequests: 0 }, { ...c, maxRequests: 1001 }, { ...c, endpoint: { ...c.endpoint, maxRequestBytes: 4095 } }]) assert.throws(() => modelBinding(other), rejected);
});

test('archive precedes approval, immutable exact retry and read after reconstruction', t => {
  const f = fixture(t), original = fs.openSync; let observed = false;
  fs.openSync = function(file, flags, ...rest) {
    if (String(file).endsWith('approval.json') && flags === 'wx') { observed = true; assert.equal(readArchive().bindingHash, modelBinding(f.c).bindingHash); }
    return original.call(this, file, flags, ...rest);
  };
  t.after(() => { fs.openSync = original; });
  function readArchive() { return JSON.parse(fs.readFileSync(f.archive)).binding; }
  const saved = approve(f); assert.equal(observed, true); assert.deepEqual(approve(f), saved);
  assert.deepEqual(readBoundModelApproval(f.root, f.approval.approvalId), saved);
  assert.equal(saved.paidAuthorization, false); assert.equal(saved.binding.config.settings.inputMicroUsdPerMillionTokens, 1000000);
  const before = fs.readFileSync(f.archive); assert.throws(() => recordBoundModelApproval(f.root, f.spec, f.c, { ...f.approval, expiresAt: f.approval.expiresAt + 1 }), rejected);
  assert.deepEqual(fs.readFileSync(f.archive), before);
});

test('invalid model/hash/budget/timeout/confirmation and secrets produce zero files', t => {
  const f = fixture(t);
  for (const change of [s => { s.model.settingsHash = hash('protocol-only'); }, s => { s.model.id = 'other'; }, s => { s.perRunLimitMicroUsd = 1199; }, s => { s.timeoutMs = 999; }, s => { s.caseId = 'sk-' + 'a'.repeat(30); }]) {
    const spec = structuredClone(f.spec); change(spec); const approval = { ...f.approval, planHash: planEvaluation(spec).planHash };
    assert.throws(() => recordBoundModelApproval(f.root, spec, f.c, approval), rejected); assert.deepEqual(fs.readdirSync(f.root), []);
  }
  assert.throws(() => recordBoundModelApproval(f.root, f.spec, f.c, { ...f.approval, confirmed: false }), rejected); assert.deepEqual(fs.readdirSync(f.root), []);
  assert.throws(() => recordBoundModelApproval(f.root, f.spec, f.c, { ...f.approval, approvalId: 'sk-' + 'a'.repeat(30) }), rejected); assert.deepEqual(fs.readdirSync(f.root), []);
});

test('archive write/fsync failures leave no approval, partial record is not repaired', t => {
  const f = fixture(t), original = fs.fsyncSync; fs.fsyncSync = () => { throw Error('PRIVATE-DISK'); };
  try { assert.throws(() => approve(f), rejected); } finally { fs.fsyncSync = original; }
  assert.equal(fs.existsSync(f.evaluation), false); assert.equal(fs.existsSync(f.archive), true);
  fs.writeFileSync(f.archive, '{'); assert.throws(() => approve(f), rejected); assert.equal(fs.readFileSync(f.archive, 'utf8'), '{');
});

test('read rejects corrupt/oversize/UTF8/extra keys and binding or approval replacements without repair', t => {
  const f = fixture(t); approve(f); const bytes = fs.readFileSync(f.archive);
  for (const change of [v => { v.binding.config.endpoint.address = '8.8.8.8'; }, v => { v.approval.expiresAt++; }, v => { v.extra = true; }, v => { v.binding.bindingHash = hash('other'); }]) {
    fs.writeFileSync(f.archive, bytes); mutate(f.archive, change); assert.throws(() => readBoundModelApproval(f.root, f.approval.approvalId), rejected);
  }
  for (const bad of [Buffer.alloc(16385), Buffer.from([0xff, 0xfe]), Buffer.from('{')]) {
    fs.writeFileSync(f.archive, bad); assert.throws(() => readBoundModelApproval(f.root, f.approval.approvalId), rejected); assert.deepEqual(fs.readFileSync(f.archive), bad);
  }
});

test('archive file and owned directory links are rejected (no decoy writes)', t => {
  const f = fixture(t); approve(f); const target = f.archive + '.original'; fs.renameSync(f.archive, target);
  try { fs.symlinkSync(target, f.archive); } catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('symlink permission'); return; } throw e; }
  assert.throws(() => readBoundModelApproval(f.root, f.approval.approvalId), rejected); fs.unlinkSync(f.archive); fs.renameSync(target, f.archive);
  const dir = path.dirname(f.archive); fs.renameSync(dir, dir + '.original'); fs.symlinkSync(dir + '.original', dir, 'dir');
  assert.throws(() => readBoundModelApproval(f.root, f.approval.approvalId), rejected); assert.throws(() => approve(f), rejected);
});

test('evaluation dispatch -> reserved run -> reserved request -> credential -> HTTPS -> persisted costs; duplicate forbidden', async t => {
  const f = fixture(t); approve(f); const calls = fakeNetwork(t); let issued = 0;
  const final = await dispatchBoundModelEvaluation(f.root, f.approval.approvalId, async (run, send) => {
    assert.equal(JSON.parse(await send(body(f))).choices[0].message.content, 'synthetic-reply'); return result(run);
  }, scope => {
    issued++; assert.equal(scope, modelBinding(f.c).endpointHash);
    const outer = readEvaluationRecord(f.root, f.approval.approvalId), run = outer.ledger.runs.at(-1);
    assert.equal(run.status, 'reserved'); assert.equal(readModelEgress(f.root, run.runId).requests.at(-1).status, 'reserved'); return lease();
  });
  assert.equal(final.ledger.state, 'complete'); assert.equal(final.ledger.knownCostMicroUsd, 80); assert.equal(calls.length, 2); assert.equal(issued, 2);
  assert.equal(final.ledger.executionVerified, false); assert.deepEqual(readBoundModelApproval(f.root, f.approval.approvalId).report, final);
  await assert.rejects(dispatchBoundModelEvaluation(f.root, f.approval.approvalId, () => {}, lease)); assert.equal(calls.length, 2);
  for (const run of final.ledger.runs) {
    const disk = fs.readdirSync(path.join(f.root, 'model-egress', run.runId)).map(n => fs.readFileSync(path.join(f.root, 'model-egress', run.runId, n), 'utf8')).join('');
    for (const text of ['synthetic-lease', 'synthetic-question', 'synthetic-reply']) assert.ok(!disk.includes(text));
  }
});

test('missing archive/expired approval reject before claim or credential', async t => {
  const f = fixture(t); approve(f); const original = Date.now, bytes = fs.readFileSync(f.archive); let issued = 0;
  const invoke = () => dispatchBoundModelEvaluation(f.root, f.approval.approvalId, () => {}, () => { issued++; return lease(); });
  fs.unlinkSync(f.archive); await assert.rejects(invoke(), rejected); fs.writeFileSync(f.archive, bytes);
  Date.now = () => f.approval.expiresAt; try { await assert.rejects(invoke(), rejected); } finally { Date.now = original; }
  assert.equal(fs.existsSync(path.join(f.evaluation, 'claim.json')), false); assert.equal(issued, 0);
});

test('archive tamper after run reservation stops before credentials, keeps unknown request and run reserves', async t => {
  const f = fixture(t); approve(f); const calls = fakeNetwork(t); let issued = 0;
  const final = await dispatchBoundModelEvaluation(f.root, f.approval.approvalId, async (run, send) => {
    mutate(f.archive, v => { v.binding.config.settings.temperature = 1; });
    await assert.rejects(send(body(f))); await assert.rejects(send(body(f))); return result(run, 0);
  }, () => { issued++; return lease(); });
  assert.equal(issued, 0); assert.equal(calls.length, 0); assert.equal(final.dispatchState, 'unresolved'); assert.equal(final.ledger.runs.length, 1);
  assert.equal(final.ledger.runs[0].status, 'reserved'); assert.equal(readModelEgress(f.root, f.plan.runs[0].runId).unknownCostRequests, 1);
});

test('archive changed AFTER last request but before score cannot settle the reserved run', async t => {
  const f = fixture(t); approve(f); const calls = fakeNetwork(t);
  const final = await dispatchBoundModelEvaluation(f.root, f.approval.approvalId, async (run, send) => {
    await send(body(f)); mutate(f.archive, v => { v.binding.config.settings.temperature = 1; }); return result(run);
  }, lease);
  assert.equal(calls.length, 1); assert.equal(final.dispatchState, 'unresolved');
  assert.equal(final.ledger.runs.length, 1); assert.equal(final.ledger.runs[0].status, 'reserved');
  const egress = readModelEgress(f.root, f.plan.runs[0].runId);
  assert.equal(egress.reason, 'completed'); assert.equal(egress.knownCostMicroUsd, 40);
});

test('driver detached from send cannot settle even when request succeeds and score cost matches', { timeout: 5000 }, async t => {
  const f = fixture(t); approve(f); const calls = fakeNetwork(t);
  const final = await dispatchBoundModelEvaluation(f.root, f.approval.approvalId, async (run, send) => {
    void send(body(f)); return result(run);
  }, lease);
  assert.equal(calls.length, 1); assert.equal(final.dispatchState, 'unresolved');
  assert.equal(final.ledger.runs.length, 1); assert.equal(final.ledger.runs[0].status, 'reserved');
  const egress = readModelEgress(f.root, f.plan.runs[0].runId);
  assert.equal(egress.reason, 'driver_detached'); assert.equal(egress.knownCostMicroUsd, 40);
});

test('credential callback changing durable reservation is rejected after callback and before network', async t => {
  const f = fixture(t); approve(f); const calls = fakeNetwork(t);
  await assert.rejects(dispatchBoundModelEvaluation(f.root, f.approval.approvalId, async (run, send) => {
    await assert.rejects(send(body(f))); return result(run, 0);
  }, () => { fs.unlinkSync(path.join(f.evaluation, '0001.json')); return lease(); }));
  assert.equal(calls.length, 0); // corrupted outer journal cannot reconstruct success
});

test('executor cannot underreport/overreport known cost or score unknown-cost transport', async t => {
  for (const cost of [0, 41]) await t.test(String(cost), async t => {
    const f = fixture(t); approve(f); const calls = fakeNetwork(t);
    const final = await dispatchBoundModelEvaluation(f.root, f.approval.approvalId, async (run, send) => { await send(body(f)); return result(run, cost); }, lease);
    assert.equal(final.dispatchState, 'unresolved'); assert.equal(final.ledger.runs.length, 1); assert.equal(final.ledger.runs[0].status, 'reserved'); assert.equal(calls.length, 1);
  });
});

test('expiry inside credential callback prevents dial; outer reservation remains unresolved', async t => {
  const f = fixture(t); approve(f); const calls = fakeNetwork(t), now = Date.now;
  t.after(() => { Date.now = now; });
  const final = await dispatchBoundModelEvaluation(f.root, f.approval.approvalId, async (run, send) => {
    await assert.rejects(send(body(f))); return result(run, 0);
  }, () => { const v = lease(); Date.now = () => f.approval.expiresAt; return v; });
  assert.equal(calls.length, 0); assert.equal(final.dispatchState, 'unresolved'); assert.equal(final.ledger.runs[0].status, 'reserved');
});

test('driver no calls or caught failed protocol cannot produce a scored completed run', async t => {
  for (const mode of ['none', 'bad-request']) await t.test(mode, async t => {
    const f = fixture(t); approve(f); const calls = fakeNetwork(t);
    const final = await dispatchBoundModelEvaluation(f.root, f.approval.approvalId, async (run, send) => {
      if (mode === 'bad-request') await assert.rejects(send(Buffer.from('{}'))); return result(run, 0);
    }, lease);
    assert.equal(final.dispatchState, 'unresolved'); assert.equal(final.ledger.runs.length, 1); assert.equal(calls.length, 0);
  });
});

test('archive inode changed between lstat and open is rejected', t => {
  const f = fixture(t); approve(f); const original = fs.openSync; let swapped = false;
  fs.openSync = function(file, ...args) {
    if (String(file) === f.archive && !swapped) { swapped = true; fs.renameSync(f.archive, f.archive + '.old'); fs.copyFileSync(f.archive + '.old', f.archive); }
    return original.call(this, file, ...args);
  };
  try { assert.throws(() => readBoundModelApproval(f.root, f.approval.approvalId), rejected); } finally { fs.openSync = original; }
  assert.equal(swapped, true);
});

test('child exit23 after outer reservation and egress claim remains unresolved; no recovery dispatch', async t => {
  const f = fixture(t); approve(f);
  const modulePath = require.resolve('../../build/server/domain/runtime/badcase-capture/model-binding.js');
  const child = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(modulePath)}).dispatchBoundModelEvaluation(${JSON.stringify(f.root)}, ${JSON.stringify(f.approval.approvalId)}, async () => process.exit(23), () => { throw Error('must not issue'); })`], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 23); const r = readBoundModelApproval(f.root, f.approval.approvalId);
  assert.equal(r.report.dispatchState, 'unresolved'); assert.equal(r.report.ledger.runs[0].status, 'reserved');
  assert.equal(readModelEgress(f.root, f.plan.runs[0].runId).state, 'unresolved');
  await assert.rejects(dispatchBoundModelEvaluation(f.root, f.approval.approvalId, () => { assert.fail('retry'); }, lease));
});

test('local synthetic TLS composes durable binding, outer ledger and request ledger without real model', { timeout: 15000 }, async t => {
  if (spawnSync('openssl', ['version']).status !== 0) { t.skip('openssl unavailable'); return; }
  const f = fixture(t); approve(f);
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-bound-tls-')); t.after(() => fs.rmSync(certDir, { recursive: true, force: true }));
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'cert.pem', '-days', '1',
    '-subj', '/CN=api.caff-test.example', '-addext', 'subjectAltName=DNS:api.caff-test.example'], { cwd: certDir, timeout: 10000 });
  assert.equal(made.status, 0);
  const cert = fs.readFileSync(path.join(certDir, 'cert.pem')), key = fs.readFileSync(path.join(certDir, 'key.pem')); let count = 0;
  const server = https.createServer({ key, cert }, (req, res) => {
    count++; assert.equal(req.headers.authorization, 'Bearer synthetic-lease');
    req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({
      id: 'synthetic', object: 'chat.completion', created: 1, model: 'fixed-model', choices: [{ index: 0, message: { role: 'assistant', content: 'synthetic-reply' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const original = https.request; t.after(() => { https.request = original; });
  // Test-only route/CA/peer observation substitution. No supplier or public dial.
  https.request = options => {
    const req = original({ ...options, hostname: '127.0.0.1', port: server.address().port, ca: cert });
    req.on('socket', socket => Object.defineProperty(socket, 'remoteAddress', { value: options.hostname })); return req;
  };
  const final = await dispatchBoundModelEvaluation(f.root, f.approval.approvalId, async (run, send) => {
    await send(body(f)); return result(run);
  }, () => { assert.equal(readEvaluationRecord(f.root, f.approval.approvalId).ledger.state, 'reserved'); return lease(); });
  assert.equal(final.ledger.state, 'complete'); assert.equal(final.ledger.knownCostMicroUsd, 80); assert.equal(count, 2);
  const rebuilt = readBoundModelApproval(f.root, f.approval.approvalId); assert.deepEqual(rebuilt.report, final); assert.equal(rebuilt.paidAuthorization, false);
});

test('concurrent dispatches consume approval once; no second driver or credential', async t => {
  const f = fixture(t); approve(f); const calls = fakeNetwork(t); let resume; const gate = new Promise(r => { resume = r; }); let entered;
  const ready = new Promise(r => { entered = r; });
  const first = dispatchBoundModelEvaluation(f.root, f.approval.approvalId, async (run, send) => { entered(); await gate; await send(body(f)); return result(run); }, lease);
  await ready; await assert.rejects(dispatchBoundModelEvaluation(f.root, f.approval.approvalId, () => { assert.fail('second driver'); }, lease));
  resume(); assert.equal((await first).ledger.state, 'complete'); assert.equal(calls.length, 2);
});
