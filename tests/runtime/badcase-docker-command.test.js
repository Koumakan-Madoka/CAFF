// Exercise the real spawn/env/stdin/limit path against a local executable shim.
// No daemon/container/agent/model is used. Linux matches the supported launcher.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runDockerCommand } = require('../../build/server/domain/runtime/badcase-capture/docker-sandbox');
const linux = { skip: process.platform !== 'linux' };
function shim(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-docker-cli-'));
  const keys = ['PATH', 'CAFF_SHIM_PROBE', 'PI_SHIM_PROBE', 'DOCKER_HOST', 'NODE_OPTIONS'];
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  t.after(() => { for (const k of keys) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; } fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'docker'), '#!' + process.execPath + '\n' + source, { mode: 0o700 });
  process.env.PATH = root; // Never resolve a real docker if the shim fails.
  process.env.CAFF_SHIM_PROBE = 'synthetic'; process.env.PI_SHIM_PROBE = 'synthetic';
  process.env.DOCKER_HOST = 'tcp://must-not-be-used:2375'; process.env.NODE_OPTIONS = '--require /nonexistent-shim-hook';
  return root;
}
test('real CLI transport filters environment and closes stdin with fixed context and literal args', linux, async t => {
  shim(t, `let b='';process.stdin.on('data',x=>b+=x);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(2),input:b,keys:Object.keys(process.env)}));process.stderr.write('diagnostic');});`);
  const r = await runDockerCommand(['inspect', 'literal;not-a-shell'], { input: 'synthetic payload\n', timeoutMs: 5000 });
  assert.equal(r.code, 0); assert.equal(r.failure, undefined); assert.equal(r.stderr, 'diagnostic');
  const out = JSON.parse(r.stdout); assert.equal(out.input, 'synthetic payload\n');
  assert.deepEqual(out.args, ['--context', 'default', 'inspect', 'literal;not-a-shell']);
  assert.equal(out.keys.some(k => /^(CAFF_|PI_|DOCKER_|NODE_OPTIONS)/.test(k)), false);
});
test('explicit recovery socket replaces default context without inheriting DOCKER_HOST', linux, async t => {
  shim(t, `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(2),keys:Object.keys(process.env)})));`);
  const r = await runDockerCommand(['info'], { dockerHost: 'unix:///var/tmp/caff-image-recovery-test/docker.sock' });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.args, ['--host', 'unix:///var/tmp/caff-image-recovery-test/docker.sock', 'info']);
  assert.equal(out.keys.some(k => /^(CAFF_|PI_|DOCKER_|NODE_OPTIONS)/.test(k)), false);
});
test('explicit null, remote or malformed recovery endpoints are rejected', async () => {
  for (const dockerHost of [null, undefined, '', 'tcp://localhost:2375', 'unix:///tmp/a\n.sock']) {
    await assert.rejects(runDockerCommand(['info'], { dockerHost }), { code: 'offline_host_unsupported' });
  }
});
test('real CLI transport kills on combined stdout/stderr overflow with bounded returned bytes', linux, async t => {
  shim(t, `process.stdout.write('a'.repeat(800000));process.stderr.write('b'.repeat(800000));setInterval(()=>{},1000);`);
  const r = await runDockerCommand(['start'], { timeoutMs: 5000 });
  assert.equal(r.failure, 'output_limit'); assert.ok(Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr) <= 1024 * 1024);
});
test('real CLI timeout triggers termination and waits for close, not a wall-clock upper-bound claim', linux, async t => {
  shim(t, `process.stdout.write('ready');setInterval(()=>{},1000);`);
  const r = await runDockerCommand(['start'], { timeoutMs: 1000 });
  assert.equal(r.failure, 'timeout'); assert.equal(r.stdout, 'ready'); assert.equal(r.code, null);
});
test('missing executable produces spawn failure without shell fallback', linux, async t => {
  const root = shim(t, ''); fs.unlinkSync(path.join(root, 'docker'));
  const r = await runDockerCommand(['version'], { timeoutMs: 5000 });
  assert.equal(r.failure, 'spawn'); assert.equal(r.stdout, '');
});
