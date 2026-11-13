// Trusted supervisor relay over Docker exec, NOT a container network service.
// Use only around runProbe's already identity-verified lifecycle on a dedicated
// daemon. Container data is never a host path, executable, URL or credential.
const assert = require('node:assert/strict');
const good = r => r && r.code === 0 && !r.failure && r.stderr === '';
// Exact host-produced codes only. Prefix matches would admit arbitrary data.
const RELAY_ERROR_CODES = Object.freeze(['relay_failed', 'evaluation_codex_auth_unavailable', 'evaluation_codex_access_invalid',
  'evaluation_codex_access_expired', 'evaluation_codex_access_changed', 'evaluation_codex_input_contains_known_key',
  'evaluation_codex_input_contains_access', 'evaluation_codex_request_invalid', 'evaluation_codex_mailbox_request_invalid',
  'wiki_precheck_trace_input_contains_key', 'wiki_precheck_trace_request_invalid', 'evaluation_codex_proxy_failed']);
const ENV = ['/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', '/usr/local/bin/node', '-e'];
const READ = `const fs=require('node:fs');try{const p='/work/model-relay/request.json',s=fs.lstatSync(p,{bigint:true});if(!s.isFile()||s.size>8388736n)throw Error();const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const t=fs.fstatSync(fd,{bigint:true});if(t.ino!==s.ino||t.dev!==s.dev||t.size!==s.size)throw Error();const b=Buffer.alloc(Number(s.size)+1);let n=0,k;while(n<b.length&&(k=fs.readSync(fd,b,n,b.length-n,n)))n+=k;if(n!==Number(s.size))throw Error();process.stdout.write(b.subarray(0,n));}finally{fs.closeSync(fd)}}catch(e){if(e.code!=='ENOENT')process.exitCode=70}`;
const WRITE = `const fs=require('node:fs');let n=0,a=[];process.stdin.on('data',b=>{n+=b.length;if(n>8388736)process.exit(70);a.push(b)});process.stdin.on('end',()=>{try{fs.writeFileSync('/work/model-relay/response.tmp',Buffer.concat(a),{flag:'wx',mode:0o600});fs.renameSync('/work/model-relay/response.tmp','/work/model-relay/response.json')}catch{process.exitCode=70}})`;
function relayDockerTransport(runDocker, send, limits, signal, onDiagnostic = () => {}) {
  assert.equal(typeof runDocker, 'function'); assert.equal(typeof send, 'function'); assert.equal(typeof onDiagnostic, 'function');
  for (const k of ['maxRequests', 'maxRequestBytes', 'maxResponseBytes']) assert.ok(Number.isSafeInteger(limits[k]) && limits[k] > 0);
  assert.ok(limits.maxRequests <= 1000 && limits.maxRequestBytes <= 4194304 && limits.maxResponseBytes <= 4194304);
  const cap = { ...limits }; let used = false;
  return async (args, options = {}) => {
    if (args[0] !== 'start') return runDocker(args, options);
    // Cleanup/inspect calls above remain available after cancellation. Never
    // attach a new worker, and never propagate an arbitrary abort reason.
    if (signal?.aborted) throw Error('container_model_relay_failed');
    assert.equal(used, false); used = true;
    assert.deepEqual(args.slice(0, 3), ['start', '-a', '-i']); assert.equal(args.length, 4);
    const id = args[3]; assert.match(id, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 1);
    let ended = false, sequence = 0, previous = '', failure, phase = 'inspect', failurePhase;
    const started = performance.now();
    const execution = Promise.resolve().then(() => runDocker(args, options)).finally(() => { ended = true; });
    void execution.catch(() => {});
    const inspect = async () => {
      const r = await runDocker(['inspect', id]); assert.ok(good(r));
      const c = JSON.parse(r.stdout); assert.equal(c.length, 1); assert.equal(c[0].Id, id);
      assert.equal(typeof c[0].State.Running, 'boolean'); return c[0];
    };
    try {
      while (!ended) {
        if (signal?.aborted) throw Error('container_model_relay_failed');
        assert.ok(performance.now() - started < options.timeoutMs, 'relay_deadline');
        phase = 'inspect';
        const c = await inspect(); if (ended) break;
        if (!c.State.Running) { await new Promise(r => setTimeout(r, 20)); continue; }
        phase = 'read';
        const read = await runDocker(['exec', id, ...ENV, READ], { timeoutMs: 2000, maxOutput: cap.maxRequestBytes * 2 + 128 });
        if (ended) break;
        if (signal?.aborted) throw Error('container_model_relay_failed');
        if (!good(read)) {
          // The worker may stop after inspect but before exec, while its attach
          // process is still closing (notably across WSL). Recheck this exact
          // container and join its real exit; never swallow a live exec error.
          const after = await inspect();
          if (!after.State.Running) { await execution; break; }
          assert.ok(good(read));
        }
        if (read.stdout) {
          phase = 'request';
          assert.ok(Buffer.byteLength(read.stdout) <= cap.maxRequestBytes * 2 + 128);
          const q = JSON.parse(read.stdout);
          assert.deepEqual(Object.keys(q).sort(), ['body', 'sequence']);
          assert.ok(Number.isSafeInteger(q.sequence) && typeof q.body === 'string');
          if (q.sequence === sequence) assert.equal(q.body, previous, 'relay_duplicate_changed');
          else {
            assert.equal(q.sequence, sequence + 1); assert.ok(q.sequence <= cap.maxRequests);
            const body = Buffer.from(q.body, 'base64');
            assert.ok(body.length > 0 && body.length <= cap.maxRequestBytes && body.toString('base64') === q.body);
            sequence = q.sequence; previous = q.body;
            // send belongs to the original durable approval/request coordinator.
            // No egress bypass, automatic retry, or container-selected destination.
            phase = 'send';
            const response = await send(body);
            if (signal?.aborted) throw Error('container_model_relay_failed');
            assert.ok(!ended && performance.now() - started < options.timeoutMs, 'relay_late_response');
            assert.ok(Buffer.isBuffer(response) && response.length > 0 && response.length <= cap.maxResponseBytes);
            phase = 'write';
            const written = await runDocker(['exec', '-i', id, ...ENV, WRITE], { timeoutMs: 2000,
              input: JSON.stringify({ sequence, body: response.toString('base64') }), maxOutput: 1024 });
            assert.ok(good(written));
          }
        }
        if (!ended) await new Promise(r => setTimeout(r, 20));
      }
    } catch (e) {
      failure = e; failurePhase = phase;
      // Docker IDs are immutable on the pinned daemon. The caller already verified
      // owner/image/isolation before start and performs full cleanup afterwards.
      const c = await inspect();
      if (c.State.Running) assert.ok(good(await runDocker(['kill', id])), 'relay_stop_failed');
    } finally {
      // Never leave an attach or model send running after returning to the ledger.
      await execution;
    }
    if (failure) {
      // Fixed host enums only: no assertion message, Docker output or cause.
      onDiagnostic({ phase: failurePhase, errorCode: failurePhase === 'send' && RELAY_ERROR_CODES.includes(failure.code) ? failure.code : 'relay_failed' });
      if (failure.code === 'evaluation_codex_proxy_failed') throw Object.assign(Error(failure.code), { code: failure.code });
      throw Error('container_model_relay_failed');
    }
    return execution;
  };
}
module.exports = { relayDockerTransport, RELAY_ERROR_CODES };
