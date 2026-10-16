const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { dispatchModelEgress, readModelEgress } = require('../../build/server/domain/runtime/badcase-capture/model-egress.js');
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
function fixture(t, changes = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-egress-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const policy = { approvalId: 'test-approval', planHash: hash('plan'), runId: hash('run'),
    provider: 'test-offline', model: 'test-model', settingsHash: hash('settings'), expiresAt: Date.now() + 60000,
    maxRequests: 3, maxRequestBytes: 1024, maxResponseBytes: 1024, timeoutMs: 1000,
    perRequestReserveMicroUsd: 10, runLimitMicroUsd: 20, ...changes };
  const dir = path.join(root, 'model-egress', policy.runId);
  return { root, policy, dir };
}
const reply = () => ({ body: Buffer.from('synthetic reply'), costMicroUsd: 2 });
const code = value => error => error.code === value && error.message === value;

test('reserves durably before transport, writes hash-only results, never refunds reservations', async t => {
  const { root, policy, dir } = fixture(t); let calls = 0;
  const report = await dispatchModelEgress(root, policy, async send => {
    for (let n = 0; n < 2; n++) assert.equal((await send(Buffer.from('request-' + n))).toString(), 'synthetic reply');
    await assert.rejects(send(Buffer.from('third')), code('model_egress_budget_exhausted'));
  }, async request => {
    calls++;
    const state = readModelEgress(root, policy.runId);
    assert.equal(state.requests.length, calls); assert.equal(state.requests.at(-1).status, 'reserved');
    assert.equal(state.committedMicroUsd, calls * 10);
    assert.deepEqual(Object.keys(request).sort(), ['body', 'model', 'provider', 'requestId', 'settingsHash', 'signal']);
    assert.equal(request.provider, policy.provider); assert.equal(request.model, policy.model);
    assert.equal(request.settingsHash, policy.settingsHash); assert.ok(request.signal instanceof AbortSignal);
    return reply();
  });
  assert.equal(calls, 2); assert.equal(report.reason, 'budget_exhausted');
  assert.equal(report.committedMicroUsd, 20); assert.equal(report.knownCostMicroUsd, 4);
  assert.equal(report.paidAuthorization, false);
  assert.deepEqual(readModelEgress(root, policy.runId), report);
  const persisted = fs.readdirSync(dir).map(n => fs.readFileSync(path.join(dir, n), 'utf8')).join('');
  assert.ok(!persisted.includes('synthetic reply') && !persisted.includes('request-0'));
  assert.equal(report.requests[0].requestHash, hash('request-0'));
  assert.equal(report.requests[0].responseHash, hash('synthetic reply'));
  await assert.rejects(dispatchModelEgress(root, policy, async () => assert.fail(), async () => assert.fail()), code('model_egress_already_claimed'));
});

test('request limits, invalid bodies and secret sentinels never reach transport', async t => {
  const { root, policy } = fixture(t, { maxRequests: 1 }); let calls = 0;
  const report = await dispatchModelEgress(root, policy, async send => {
    for (const b of [null, 'text', Buffer.alloc(0), Buffer.alloc(1025), Buffer.from('sk-' + 'a'.repeat(48))])
      await assert.rejects(send(b), code('model_egress_request_invalid'));
    await send(Buffer.from('ok'));
    await assert.rejects(send(Buffer.from('again')), code('model_egress_request_limit'));
  }, async () => { calls++; return reply(); });
  assert.equal(calls, 1); assert.equal(report.reason, 'request_limit');
});

test('concurrent requests reject and input/response buffers are copied', { timeout: 5000 }, async t => {
  const { root, policy } = fixture(t); let release; const wait = new Promise(r => release = r);
  const body = Buffer.from('before'), response = reply(); let calls = 0;
  const report = await dispatchModelEgress(root, policy, async send => {
    const pending = send(body); body.fill(120);
    await assert.rejects(send(Buffer.from('concurrent')), code('model_egress_busy'));
    release(); const received = await pending; received.fill(120);
  }, async request => { calls++; assert.equal(request.body.toString(), 'before'); await wait; return response; });
  assert.equal(calls, 1); assert.equal(report.reason, 'completed');
  assert.equal(response.body.toString(), 'synthetic reply');
  assert.equal(report.requests[0].requestHash, hash('before'));
});

test('unknown, over-cap, oversized, malformed and thrown outcomes stop even when driver catches', async t => {
  const cases = [
    [() => ({ ...reply(), costMicroUsd: null }), 'cost_unknown'],
    [() => ({ ...reply(), costMicroUsd: 11 }), 'cost_limit_exceeded'],
    [() => ({ ...reply(), body: Buffer.alloc(1025) }), 'invalid_response'],
    [() => ({ ...reply(), extra: true }), 'invalid_response'],
    [() => ({ ...reply(), costMicroUsd: -1 }), 'invalid_response'],
    [() => { throw Error('PRIVATE-ERROR-BODY'); }, 'transport_failed'],
  ];
  for (const [result, reason] of cases) {
    const { root, policy, dir } = fixture(t); let calls = 0;
    const report = await dispatchModelEgress(root, policy, async send => {
      await assert.rejects(send(Buffer.from('ok')));
      await assert.rejects(send(Buffer.from('retry')), code('model_egress_stopped'));
    }, async () => { calls++; return result(); });
    assert.equal(calls, 1); assert.equal(report.reason, reason);
    assert.equal(report.committedMicroUsd, 10); assert.equal(report.requests[0].responseHash, null);
    assert.ok(!JSON.stringify(report).includes('PRIVATE-ERROR-BODY'));
    assert.ok(!fs.readdirSync(dir).some(n => fs.readFileSync(path.join(dir, n), 'utf8').includes('PRIVATE-ERROR-BODY')));
  }
});

test('timeout abort is sticky, waits for transport settlement and suppresses late success', { timeout: 5000 }, async t => {
  const { root, policy } = fixture(t, { timeoutMs: 15 }); let aborted = false, settled = false;
  const report = await dispatchModelEgress(root, policy, async send => {
    await assert.rejects(send(Buffer.from('ok')), code('model_egress_timeout')); assert.equal(settled, true);
  }, async request => {
    await new Promise(resolve => {
      const fallback = setTimeout(resolve, 150); // missing abort produces an assertion failure, not a hung suite
      request.signal.addEventListener('abort', () => { aborted = true; clearTimeout(fallback); setTimeout(resolve, 15); }, { once: true });
    });
    settled = true; return reply();
  });
  assert.equal(aborted, true); assert.equal(report.reason, 'timeout');
  assert.equal(report.unknownCostRequests, 1); assert.equal(report.requests[0].responseHash, null);
});

test('elapsed check catches event-loop-blocked late results without timer firing', async t => {
  const { root, policy } = fixture(t, { timeoutMs: 5 });
  const report = await dispatchModelEgress(root, policy, async send => { await assert.rejects(send(Buffer.from('ok')), code('model_egress_timeout')); }, async () => {
    const until = performance.now() + 20; while (performance.now() < until) {} return reply();
  });
  assert.equal(report.reason, 'timeout');
});

test('clock rollback and expiry rechecked after durable reserve, before transport', async t => {
  for (const change of [-1, 60000]) {
    const { root, policy } = fixture(t); const original = Date.now, write = fs.fsyncSync; let calls = 0;
    const at = Date.now(); Date.now = () => at;
    fs.fsyncSync = function (...args) { const result = write.apply(this, args); if (++calls === 2) Date.now = () => at + change; return result; };
    try {
      const report = await dispatchModelEgress(root, policy, async send => {
        await assert.rejects(send(Buffer.from('ok')));
      }, async () => assert.fail('must not dispatch'));
      assert.equal(report.requests.length, 1); assert.equal(report.requests[0].status, 'reserved');
      assert.equal(report.reason, change < 0 ? 'clock_invalid' : 'approval_expired');
    } finally { Date.now = original; fs.fsyncSync = write; }
  }
});

test('fsync failure prevents dispatch and caught errors cannot reopen gate', async t => {
  const { root, policy } = fixture(t); const sync = fs.fsyncSync; let calls = 0, writes = 0;
  fs.fsyncSync = function (...args) { if (++writes === 2) throw Error('disk fail'); return sync.apply(this, args); };
  try {
    await assert.rejects(dispatchModelEgress(root, policy, async send => {
      await assert.rejects(send(Buffer.from('ok')), code('model_egress_write_failed'));
      await assert.rejects(send(Buffer.from('retry')), code('model_egress_stopped'));
    }, async () => { calls++; return reply(); }), code('model_egress_write_failed'));
    assert.equal(calls, 0);
  } finally { fs.fsyncSync = sync; }
  assert.equal(readModelEgress(root, policy.runId).state, 'unresolved');
});

test('write read-back corruption blocks transport even after successful fsync', async t => {
  const { root, policy, dir } = fixture(t); const sync = fs.fsyncSync; let n = 0, calls = 0;
  fs.fsyncSync = function (...args) {
    const result = sync.apply(this, args);
    if (++n === 2) {
      const file = path.join(dir, '0001.reserve.json'), v = JSON.parse(fs.readFileSync(file));
      v.requestHash = hash('changed'); fs.writeFileSync(file, JSON.stringify(v));
    }
    return result;
  };
  try {
    await assert.rejects(dispatchModelEgress(root, policy, async send => { await send(Buffer.from('ok')); }, async () => { calls++; return reply(); }), code('model_egress_write_failed'));
    assert.equal(calls, 0);
  } finally { fs.fsyncSync = sync; }
});

test('detached request is joined before finish and escaped sender is closed', { timeout: 5000 }, async t => {
  const { root, policy } = fixture(t); let sender, pending, settled = false;
  const report = await dispatchModelEgress(root, policy, async send => { sender = send; pending = send(Buffer.from('ok')); }, async () => {
    await new Promise(r => setTimeout(r, 10)); settled = true; return reply();
  });
  assert.equal(settled, true); assert.equal(report.reason, 'driver_detached');
  assert.equal(report.state, 'finished'); assert.equal(report.requests[0].status, 'completed');
  await pending;
  await assert.rejects(sender(Buffer.from('late')), code('model_egress_stopped'));
});

test('cross-process claim rejects duplicates; process exit retains unknown reservation', t => {
  const { root, policy } = fixture(t);
  const modulePath = path.resolve('build/server/domain/runtime/badcase-capture/model-egress.js');
  const script = `const m=require(${JSON.stringify(modulePath)});m.dispatchModelEgress(${JSON.stringify(root)},${JSON.stringify(policy)},async send=>send(Buffer.from('ok')),async()=>process.exit(23));`;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 23);
  const report = readModelEgress(root, policy.runId);
  assert.equal(report.state, 'unresolved'); assert.equal(report.requests[0].status, 'reserved');
  assert.equal(report.committedMicroUsd, 10); assert.equal(report.unknownCostRequests, 1);
  const retry = spawnSync(process.execPath, ['-e', `const m=require(${JSON.stringify(modulePath)});m.dispatchModelEgress(${JSON.stringify(root)},${JSON.stringify(policy)},async()=>{},async()=>{}).catch(e=>{console.log(e.code);process.exit(7)})`], { encoding: 'utf8', timeout: 10000 });
  assert.equal(retry.status, 7); assert.equal(retry.stdout.trim(), 'model_egress_already_claimed');
});

test('read rejects gaps, altered policy binding, extra files and forged completion', async t => {
  for (const mutate of [
    dir => fs.renameSync(path.join(dir, '0001.reserve.json'), path.join(dir, '0002.reserve.json')),
    dir => { const p = path.join(dir, 'policy.json'), v = JSON.parse(fs.readFileSync(p)); v.policy.runId = hash('other'); fs.writeFileSync(p, JSON.stringify(v)); },
    dir => fs.writeFileSync(path.join(dir, 'unknown.json'), '{}'),
    dir => { const p = path.join(dir, '0001.reserve.json'), v = JSON.parse(fs.readFileSync(p)); v.requestId = hash('other-request'); fs.writeFileSync(p, JSON.stringify(v)); },
    dir => { const p = path.join(dir, '0001.result.json'), v = JSON.parse(fs.readFileSync(p)); v.costMicroUsd = 11; fs.writeFileSync(p, JSON.stringify(v)); },
    dir => fs.unlinkSync(path.join(dir, '0001.result.json')),
    dir => {
      const file = path.join(dir, '0001.result.json'), v = JSON.parse(fs.readFileSync(file));
      v.at = JSON.parse(fs.readFileSync(path.join(dir, 'policy.json'))).policy.expiresAt;
      fs.writeFileSync(file, JSON.stringify(v));
      fs.writeFileSync(path.join(dir, 'finish.json'), JSON.stringify({ reason: 'completed', at: v.at }));
    },
  ]) {
    const { root, policy, dir } = fixture(t);
    await dispatchModelEgress(root, policy, async send => { await send(Buffer.from('ok')); }, async () => reply());
    mutate(dir); assert.throws(() => readModelEgress(root, policy.runId), code('model_egress_record_invalid'));
  }
});

test('policy and root validation happen before driver or transport, read never creates', async t => {
  const { root, policy } = fixture(t);
  for (const patch of [{ extra: true }, { maxRequests: 0 }, { timeoutMs: 0 }, { expiresAt: 0 },
    { maxRequestBytes: 4194305 }, { perRequestReserveMicroUsd: 21 }, { provider: 'https://host' },
    { provider: 'sk-' + 'a'.repeat(32) }]) {
    await assert.rejects(dispatchModelEgress(root, { ...policy, ...patch }, async () => assert.fail(), async () => assert.fail()));
    assert.deepEqual(fs.readdirSync(root), []);
  }
  await assert.rejects(dispatchModelEgress('relative', policy, async () => assert.fail(), async () => assert.fail()));
  assert.throws(() => readModelEgress(root, policy.runId), code('model_egress_record_invalid'));
  assert.deepEqual(fs.readdirSync(root), []);
});

test('throwing response accessors fail closed rather than allowing another dispatch', async t => {
  const { root, policy } = fixture(t); let calls = 0;
  const report = await dispatchModelEgress(root, policy, async send => {
    await assert.rejects(send(Buffer.from('ok')), code('model_egress_invalid_response'));
    await assert.rejects(send(Buffer.from('retry')), code('model_egress_stopped'));
  }, async () => { calls++; return { get body() { throw Error('PRIVATE-ACCESSOR'); }, costMicroUsd: 2 }; });
  assert.equal(calls, 1); assert.equal(report.reason, 'invalid_response');
});

test('policy, result and finish sync failures never release unrecorded response or reset claim', async t => {
  for (const failAt of [1, 3, 4]) {
    const { root, policy } = fixture(t); const sync = fs.fsyncSync; let n = 0, calls = 0, released = false;
    fs.fsyncSync = function (...args) { if (++n === failAt) throw Error('PRIVATE-DISK'); return sync.apply(this, args); };
    try {
      await assert.rejects(dispatchModelEgress(root, policy, async send => {
        try { await send(Buffer.from('ok')); released = true; } catch { /* prove catching cannot reopen */ }
      }, async () => { calls++; return reply(); }), code('model_egress_write_failed'));
      assert.equal(calls, failAt === 1 ? 0 : 1); assert.equal(released, failAt === 4);
    } finally { fs.fsyncSync = sync; }
    await assert.rejects(dispatchModelEgress(root, policy, async () => assert.fail(), async () => assert.fail()), code('model_egress_already_claimed'));
  }
});

test('live owner blocks cross-process dispatch, even with a changed declaration', async t => {
  const { root, policy } = fixture(t);
  const modulePath = path.resolve('build/server/domain/runtime/badcase-capture/model-egress.js');
  await dispatchModelEgress(root, policy, async send => { await send(Buffer.from('ok')); }, async () => {
    const child = spawnSync(process.execPath, ['-e', `const m=require(${JSON.stringify(modulePath)});m.dispatchModelEgress(${JSON.stringify(root)},${JSON.stringify({ ...policy, model: 'different' })},async()=>process.exit(99),async()=>process.exit(99)).catch(e=>{console.log(e.code);process.exit(7)})`], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 7); assert.equal(child.stdout.trim(), 'model_egress_already_claimed');
    return reply();
  });
});

test('reader bounds UTF8 and metadata size and rejects lstat/open identity replacement', async t => {
  for (const mode of ['utf8', 'size', 'inode']) {
    const { root, policy, dir } = fixture(t);
    await dispatchModelEgress(root, policy, async send => { await send(Buffer.from('ok')); }, async () => reply());
    const file = path.join(dir, 'policy.json'), bytes = fs.readFileSync(file);
    if (mode === 'size') fs.writeFileSync(file, Buffer.alloc(4097, 32));
    if (mode === 'utf8') {
      // Valid JSON with an invalid UTF8 byte inside a free-form JSON key.
      fs.writeFileSync(file, Buffer.concat([bytes.subarray(0, bytes.length - 1), Buffer.from(',"'), Buffer.from([255]), Buffer.from('\":0}') ]));
    }
    const open = fs.openSync; let swapped = false;
    if (mode === 'inode') fs.openSync = function (p, flags, ...rest) {
      if (p === file && flags === 'r' && !swapped) { swapped = true; fs.renameSync(file, path.join(root, 'old-policy')); fs.writeFileSync(file, bytes); }
      return open.call(this, p, flags, ...rest);
    };
    try { assert.throws(() => readModelEgress(root, policy.runId), code('model_egress_record_invalid')); }
    finally { fs.openSync = open; }
    if (mode === 'inode') assert.equal(swapped, true);
  }
});

test('policy copied before asynchronous driver and post-transport clock rollback stays unresolved', async t => {
  const { root, policy } = fixture(t); const initial = structuredClone(policy), clock = Date.now, at = Date.now();
  Date.now = () => at;
  try {
    const report = await dispatchModelEgress(root, policy, async send => {
      policy.maxRequests = 999; policy.model = 'changed';
      await assert.rejects(send(Buffer.from('ok')), code('model_egress_clock_invalid'));
      await assert.rejects(send(Buffer.from('retry')), code('model_egress_stopped'));
    }, async request => { assert.equal(request.model, initial.model); Date.now = () => at - 1; return reply(); });
    assert.deepEqual(report.policy, initial); assert.equal(report.reason, 'clock_invalid');
    assert.equal(report.state, 'unresolved'); assert.equal(report.requests[0].status, 'reserved');
  } finally { Date.now = clock; }
});

test('diagnostic metadata is allowlisted, optional for old records, forbidden on success and never reads thrown getters', async t => {
  const { labelModelFailure } = require('../../build/server/domain/runtime/badcase-capture/model-egress.js');
  for (const mode of ['legacy', 'label', 'envelope-legacy', 'spoof', 'getter', 'proxy', 'invalid-label']) {
    const { root, policy, dir } = fixture(t); let touched = false;
    const report = await dispatchModelEgress(root, policy, async send => {
      await assert.rejects(send(Buffer.from('ok')));
    }, async () => {
      if (mode === 'label') throw labelModelFailure(Error('PRIVATE-ERROR'), 'protocol_response');
      if (mode === 'envelope-legacy') throw labelModelFailure(Error('PRIVATE-ERROR'), 'protocol_response_envelope');
      if (mode === 'invalid-label') throw labelModelFailure(Error('PRIVATE-ERROR'), 'PRIVATE-FAKE-STAGE');
      if (mode === 'proxy') throw new Proxy({}, { get() { touched = true; throw Error('PRIVATE-PROXY'); } });
      if (mode === 'getter') throw { get failureStage() { touched = true; throw Error('PRIVATE-GETTER'); } };
      throw Object.assign(Error('PRIVATE-ERROR'), mode === 'spoof' ? { failureStage: 'protocol_response' } : {});
    });
    assert.equal(touched, false); assert.equal(report.reason, 'transport_failed');
    assert.equal(report.requests[0].failureStage, mode === 'label' ? 'protocol_response'
      : mode === 'envelope-legacy' ? 'protocol_response_envelope' : undefined);
    assert.equal(Object.hasOwn(report.requests[0], 'failureStage'), ['label', 'envelope-legacy'].includes(mode));
    const file = path.join(dir, '0001.result.json'), original = fs.readFileSync(file, 'utf8');
    assert.ok(!original.includes('PRIVATE-'));
    for (const stage of ['PRIVATE-BAD-LABEL', null, 0, {}, ['protocol_response']]) {
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), failureStage: stage }));
      assert.throws(() => readModelEgress(root, policy.runId), code('model_egress_record_invalid'));
    }
    fs.writeFileSync(file, original); assert.deepEqual(readModelEgress(root, policy.runId), report);
  }
  const { root, policy, dir } = fixture(t);
  await dispatchModelEgress(root, policy, async send => { await send(Buffer.from('ok')); }, async () => reply());
  const file = path.join(dir, '0001.result.json'), result = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ ...result, failureStage: 'protocol_response' }));
  assert.throws(() => readModelEgress(root, policy.runId), code('model_egress_record_invalid'));
});

test('timeout remains sticky and does not retain a misleading late failure stage', async t => {
  const { labelModelFailure } = require('../../build/server/domain/runtime/badcase-capture/model-egress.js');
  const { root, policy } = fixture(t, { timeoutMs: 5 });
  const report = await dispatchModelEgress(root, policy, async send => { await assert.rejects(send(Buffer.from('ok'))); }, async () => {
    const until = performance.now() + 20; while (performance.now() < until) {}
    throw labelModelFailure(Error('PRIVATE-LATE'), 'protocol_response');
  });
  assert.equal(report.reason, 'timeout'); assert.equal(Object.hasOwn(report.requests[0], 'failureStage'), false);
});

test('static result-file symlink is refused on read', async t => {
  const { root, policy, dir } = fixture(t);
  await dispatchModelEgress(root, policy, async send => { await send(Buffer.from('ok')); }, async () => reply());
  const file = path.join(dir, '0001.result.json'), other = path.join(root, 'decoy');
  fs.renameSync(file, other);
  try { fs.symlinkSync(other, file, 'file'); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) return t.skip('link permission'); throw e; }
  assert.throws(() => readModelEgress(root, policy.runId), code('model_egress_record_invalid'));
});

test('static own-layer symlinks are refused without decoy writes', async t => {
  const { root, policy } = fixture(t); const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-egress-decoy-'));
  t.after(() => fs.rmSync(decoy, { recursive: true, force: true }));
  try { fs.symlinkSync(decoy, path.join(root, 'model-egress'), 'junction'); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) return t.skip('link permission'); throw e; }
  await assert.rejects(dispatchModelEgress(root, policy, async () => assert.fail(), async () => assert.fail()));
  assert.throws(() => readModelEgress(root, policy.runId)); assert.deepEqual(fs.readdirSync(decoy), []);
});
