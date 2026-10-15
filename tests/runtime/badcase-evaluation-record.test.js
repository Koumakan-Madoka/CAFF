const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const modulePath = path.resolve(__dirname, '../../build/server/domain/runtime/badcase-capture/evaluation-record');
const { recordEvaluationApproval, readEvaluationRecord, dispatchRecordedEvaluation } = require(modulePath);
const { planEvaluation } = require('../../build/server/domain/runtime/badcase-capture/evaluation-plan');
const h = n => String(n).repeat(64);
function setup(t, changes = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-evaluation-record-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = { caseId: 'case-1', checkpointHash: h(1), inputHash: h(2), environmentHash: h(3), harnessHash: h(4),
    roleId: 'single-role', baselineRoleHash: h(5), candidateRoleHash: h(6),
    model: { provider: 'test-provider', id: 'test-model', settingsHash: h(7) }, evaluator: { id: 'reviewed-rule', versionHash: h(8) },
    repetitions: 2, timeoutMs: 1000, perRunLimitMicroUsd: 10, totalLimitMicroUsd: 40, ...changes };
  const approval = { confirmed: true, planHash: planEvaluation(spec).planHash, approvalId: 'manual-1', expiresAt: Date.now() + 60000 };
  const dir = path.join(root, 'evaluations', crypto.createHash('sha256').update(approval.approvalId).digest('hex'));
  return { root, spec, approval, dir };
}
const result = r => ({ runId: r.runId, status: 'completed', costMicroUsd: 4, outputHash: h(9),
  score: { expectationMet: r.variant === 'candidate', badcaseReproduced: r.variant === 'baseline' } });
function save(f) { return recordEvaluationApproval(f.root, f.spec, f.approval); }
function read(f) { return readEvaluationRecord(f.root, f.approval.approvalId); }
function run(f, executor) { return dispatchRecordedEvaluation(f.root, f.approval.approvalId, executor); }

test('approval persists, exact retries are idempotent and changed approval cannot replace it', t => {
  const f = setup(t), first = save(f);
  assert.deepEqual(save(f), first); assert.deepEqual(read(f), first);
  assert.equal(first.dispatchState, 'approved'); assert.equal(first.consumed, false);
  assert.throws(() => recordEvaluationApproval(f.root, f.spec, { ...f.approval, expiresAt: f.approval.expiresAt + 1 }), /evaluation_approval_conflict/);
  assert.deepEqual(read(f), first);
});
test('reservation is on disk before each dispatch, variants and results survive a separate reader process', async t => {
  const f = setup(t); save(f); const seen = [];
  const report = await run(f, async request => {
    const persisted = read(f); seen.push(request.runId);
    assert.equal(persisted.consumed, true);
    assert.equal(persisted.ledger.runs.at(-1).status, 'reserved');
    assert.equal(persisted.ledger.runs.at(-1).runId, request.runId);
    assert.equal(request.planHash, f.approval.planHash);
    assert.equal(request.roleHash, request.variant === 'baseline' ? f.spec.baselineRoleHash : f.spec.candidateRoleHash);
    assert.equal(request.perRunLimitMicroUsd, 10);
    assert.equal(request.approvalId, f.approval.approvalId); assert.equal(request.expiresAt, f.approval.expiresAt);
    return result(request);
  });
  assert.equal(seen.length, 4); assert.equal(new Set(seen).size, 4);
  assert.equal(report.dispatchState, 'finished'); assert.equal(report.ledger.state, 'complete');
  assert.equal(report.ledger.knownCostMicroUsd, 16);
  assert.equal(report.ledger.summary.baseline.reproduced, 2); assert.equal(report.ledger.summary.candidate.expectationMet, 2);
  assert.equal(report.ledger.executionVerified, false); assert.equal(report.ledger.strictEvalEligible, false);
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).readEvaluationRecord(process.argv[2],process.argv[3])))', modulePath, f.root, f.approval.approvalId], { encoding: 'utf8' });
  assert.equal(child.status, 0); assert.deepEqual(JSON.parse(child.stdout), report);
  await assert.rejects(run(f, () => assert.fail('must not dispatch twice')), /evaluation_already_consumed/);
});
test('two independent callers cannot consume the same approval concurrently', async t => {
  const f = setup(t); save(f); let release; let calls = 0;
  const first = run(f, request => { calls++; return new Promise(resolve => { release = () => resolve({ ...result(request), status: 'failed', score: null }); }); });
  await assert.rejects(run(f, () => assert.fail('duplicate dispatch')), /evaluation_already_consumed/);
  assert.equal(calls, 1); release(); await first;
});
test('exclusive claim wins even when another caller claims after the initial read', async t => {
  const f = setup(t); save(f); const open = fs.openSync; let injected = false, winner, release;
  t.after(() => { fs.openSync = open; });
  fs.openSync = (file, ...args) => {
    if (!injected && file === path.join(f.dir, 'claim.json')) {
      injected = true;
      winner = run(f, r => new Promise(resolve => { release = () => resolve({ ...result(r), status: 'failed', score: null }); }));
    }
    return open(file, ...args);
  };
  await assert.rejects(run(f, () => assert.fail('lost atomic claim')), /evaluation_already_consumed/);
  fs.openSync = open; release(); await winner;
  assert.equal(read(f).ledger.runs.length, 1);
});
test('separate process cannot consume while first process owns the durable claim', async t => {
  const f = setup(t); save(f);
  const child = spawn(process.execPath, ['-e', `require(process.argv[1]).dispatchRecordedEvaluation(process.argv[2],process.argv[3],async r=>{
    process.send('reserved'); await new Promise(resolve=>process.once('message',resolve));
    return {runId:r.runId,status:'failed',costMicroUsd:0,outputHash:null,score:null};
  }).then(()=>process.disconnect()).catch(()=>process.exit(9))`, modulePath, f.root, f.approval.approvalId], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const closed = once(child, 'close');
  assert.deepEqual(await once(child, 'message'), ['reserved', undefined]);
  const duplicate = spawnSync(process.execPath, ['-e', `require(process.argv[1]).dispatchRecordedEvaluation(process.argv[2],process.argv[3],()=>process.exit(71)).then(()=>process.exit(72)).catch(e=>process.exit(e.code==='evaluation_already_consumed'?0:73))`, modulePath, f.root, f.approval.approvalId]);
  assert.equal(duplicate.status, 0); child.send('release'); assert.equal((await closed)[0], 0);
  assert.equal(read(f).ledger.runs.length, 1);
});
test('dispatch rechecks wall clock after durable reservation; expiry never invokes executor', async t => {
  const f = setup(t); save(f); const original = Date.now;
  t.after(() => { Date.now = original; }); Date.now = () => f.approval.expiresAt;
  const report = await run(f, () => assert.fail('expired'));
  assert.equal(report.reason, 'approval_expired'); assert.equal(report.ledger.runs.length, 0);
  assert.equal(report.consumed, true);
});
test('expiry during reservation fsync prevents dispatch and retains unresolved reservation', async t => {
  const f = setup(t); save(f); const sync = fs.fsyncSync, clock = Date.now; let expired = false;
  t.after(() => { fs.fsyncSync = sync; Date.now = clock; });
  Date.now = () => expired ? f.approval.expiresAt : clock();
  fs.fsyncSync = fd => { sync(fd); if (fs.existsSync(path.join(f.dir, '0001.json'))) expired = true; };
  const report = await run(f, () => assert.fail('expired during disk write'));
  assert.equal(report.reason, 'approval_expired'); assert.equal(report.dispatchState, 'unresolved');
  assert.equal(report.ledger.committedMicroUsd, 10);
});
test('unknown cost, overspend, failure and budget exhaustion stop later dispatches durably', async t => {
  for (const kind of ['unknown', 'overspend', 'failed', 'budget']) {
    const f = setup(t, kind === 'budget' ? { totalLimitMicroUsd: 13 } : {}); save(f); let calls = 0;
    const report = await run(f, async r => { calls++; return { ...result(r),
      ...(kind === 'unknown' ? { costMicroUsd: null } : kind === 'overspend' ? { costMicroUsd: 99 } : kind === 'failed' ? { status: 'failed', score: null } : {}) }; });
    assert.equal(calls, 1); assert.deepEqual(read(f), report);
    assert.equal(report.ledger.stopReason, { unknown: 'cost_unknown', overspend: 'cost_limit_exceeded', failed: 'run_failed', budget: 'budget_exhausted' }[kind]);
    assert.equal(report.ledger.committedMicroUsd, kind === 'unknown' ? 10 : kind === 'overspend' ? 99 : 4);
  }
});
test('throwing or malformed executor retains reservation, redacts error and never replays', async t => {
  for (const invalid of [false, true]) {
    const f = setup(t); save(f);
    const report = await run(f, async r => { if (invalid) return { ...result(r), stdout: 'private-sentinel' }; throw Error('private-sentinel'); });
    assert.equal(report.dispatchState, 'unresolved'); assert.equal(report.ledger.state, 'reserved');
    assert.equal(report.reason, invalid ? 'invalid_result' : 'dispatch_failed');
    assert.equal(report.ledger.committedMicroUsd, 10); assert.equal(report.ledger.summary.baseline.attempted, 0);
    assert.equal(fs.readdirSync(f.dir).map(n => fs.readFileSync(path.join(f.dir, n), 'utf8')).join('').includes('private-sentinel'), false);
    await assert.rejects(run(f, () => assert.fail()), /evaluation_already_consumed/);
  }
});
test('child exit after dispatch preserves unknown reservation and prevents restart replay', t => {
  const f = setup(t); save(f);
  const child = spawnSync(process.execPath, ['-e', 'require(process.argv[1]).dispatchRecordedEvaluation(process.argv[2],process.argv[3],async()=>process.exit(23))', modulePath, f.root, f.approval.approvalId]);
  assert.equal(child.status, 23);
  const report = read(f); assert.equal(report.dispatchState, 'unresolved'); assert.equal(report.reason, 'unfinished');
  assert.equal(report.ledger.committedMicroUsd, 10); assert.equal(report.ledger.runs[0].status, 'reserved');
  const duplicate = spawnSync(process.execPath, ['-e', `require(process.argv[1]).dispatchRecordedEvaluation(process.argv[2],process.argv[3],()=>process.exit(71)).catch(e=>process.exit(e.code==='evaluation_already_consumed'?0:73))`, modulePath, f.root, f.approval.approvalId]);
  assert.equal(duplicate.status, 0);
});
test('disk failure before reserve acknowledgement means zero dispatch and no retry', async t => {
  const f = setup(t); save(f); const original = fs.fsyncSync; let count = 0;
  t.after(() => { fs.fsyncSync = original; });
  fs.fsyncSync = fd => { if (++count === 2) throw Error('disk-private-sentinel'); original(fd); };
  await assert.rejects(run(f, () => assert.fail('dispatch before fsync')), /evaluation_record_write_failed/);
  fs.fsyncSync = original;
  assert.equal(read(f).consumed, true);
  await assert.rejects(run(f, () => assert.fail()), /evaluation_already_consumed/);
});
test('result write failure never dispatches the next run or resets the claim', async t => {
  const f = setup(t); save(f); const original = fs.writeFileSync; let calls = 0;
  t.after(() => { fs.writeFileSync = original; });
  fs.writeFileSync = (fd, data, ...rest) => {
    if (typeof data === 'string' && JSON.parse(data).kind === 'result') throw Error('private-io-failure');
    return original(fd, data, ...rest);
  };
  await assert.rejects(run(f, async r => { calls++; return result(r); }), /evaluation_record_write_failed/);
  assert.equal(calls, 1); fs.writeFileSync = original;
  assert.equal(fs.existsSync(path.join(f.dir, 'claim.json')), true);
  assert.throws(() => read(f), /evaluation_record_invalid/);
  await assert.rejects(run(f, () => assert.fail()), /evaluation_record_invalid/);
});
test('wrong plan, unknown approval keys and unconfirmed declarations are not published', t => {
  for (const change of [{ planHash: h(0) }, { confirmed: false }, { apiKey: 'private-sentinel' }, { expiresAt: 0 }]) {
    const f = setup(t);
    assert.throws(() => recordEvaluationApproval(f.root, f.spec, { ...f.approval, ...change }), /evaluation_approval_invalid/);
    assert.equal(fs.existsSync(f.dir), false);
  }
});
test('static symlink records are rejected', t => {
  const f = setup(t); save(f); const file = path.join(f.dir, 'approval.json'), outside = path.join(f.root, 'outside.json');
  fs.renameSync(file, outside);
  try { fs.symlinkSync(outside, file); } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('symlink permission'); return; } throw error; }
  assert.throws(() => read(f), /evaluation_record_invalid/);
});
test('partial, malformed, oversized and out-of-order files fail closed rather than reset', async t => {
  for (const kind of ['partial', 'oversized', 'extra', 'gap', 'bad-claim']) {
    const f = setup(t); save(f);
    if (kind === 'partial') fs.writeFileSync(path.join(f.dir, 'approval.json'), '{');
    if (kind === 'oversized') fs.writeFileSync(path.join(f.dir, 'approval.json'), 'x'.repeat(65537));
    if (kind === 'extra') fs.writeFileSync(path.join(f.dir, 'unexpected'), 'x');
    if (kind === 'gap') fs.writeFileSync(path.join(f.dir, '0002.json'), '{}');
    if (kind === 'bad-claim') fs.writeFileSync(path.join(f.dir, 'claim.json'), '{}');
    assert.throws(() => read(f), /evaluation_record_invalid/);
    await assert.rejects(run(f, () => assert.fail()), /evaluation_record_invalid/);
  }
});
test('valid event after a numbering gap and forged complete finish are rejected independently', t => {
  for (const kind of ['gap', 'finish']) {
    const f = setup(t), saved = save(f), at = saved.recordedAt;
    fs.writeFileSync(path.join(f.dir, 'claim.json'), JSON.stringify({ planHash: f.approval.planHash, at }));
    fs.writeFileSync(path.join(f.dir, '0001.json'), JSON.stringify({ kind: 'reserve', at }));
    fs.writeFileSync(path.join(f.dir, kind === 'gap' ? '0003.json' : '0002.json'), JSON.stringify(kind === 'gap'
      ? { kind: 'result', at, result: result(planEvaluation(f.spec).runs[0]) }
      : { kind: 'finish', at, reason: 'complete' }));
    assert.throws(() => read(f), /evaluation_record_invalid/);
  }
});
test('same approval ID rejects changed spec with unchanged or newly matching approval', t => {
  const f = setup(t); save(f);
  const spec = { ...f.spec, candidateRoleHash: h(7) }, approval = { ...f.approval, planHash: planEvaluation(spec).planHash };
  // First request keeps approval identical: only the spec comparison can reject
  // this existing-record retry. Second request has a newly matching valid hash.
  assert.throws(() => recordEvaluationApproval(f.root, spec, f.approval), /evaluation_approval_conflict/);
  assert.throws(() => recordEvaluationApproval(f.root, spec, approval), /evaluation_approval_conflict/);
});
test('clock rollback after approval is refused without invoking executor', async t => {
  const f = setup(t), saved = save(f); const clock = Date.now;
  t.after(() => { Date.now = clock; }); Date.now = () => saved.recordedAt - 1;
  await assert.rejects(run(f, () => assert.fail()), /evaluation_clock_invalid/);
});
