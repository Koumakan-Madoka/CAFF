// Inert subprocess tests: requested WSL/Docker execution is replaced by Node.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process'), crypto = require('node:crypto');
const { createWslDockerRunner, validateWslDockerBackend } = require('../../scripts/badcase-capture/wsl-docker.cjs');
const backend = { kind: 'windows-wsl-v1', distribution: 'Debian' };
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function fixture(t, script, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-docker-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const run = createWslDockerRunner(backend, { platform: 'win32', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    CAFF_BADCASE_MODEL_KEY: 'synthetic-key-never-forwarded', WSLENV: 'CAFF_BADCASE_MODEL_KEY/u', NODE_OPTIONS: '--synthetic-forbidden' },
    spawn: (program, args, options) => { calls.push({ program, args, options });
      return cp.spawn(process.execPath, ['-e', script], { ...options, env: { ...options.env, ...extra } }); } });
  return { root, run, calls };
}
test('WSL selection is explicit and bounded; invalid backend/host cannot spawn', () => {
  assert.deepEqual(validateWslDockerBackend(backend), backend);
  for (const value of [null, {}, { ...backend, kind: 'auto' }, { ...backend, distribution: '-bad' }, { ...backend, distribution: 'Debian;sh' },
    { ...backend, distribution: 'has space' }, { ...backend, distribution: 'a'.repeat(65) }, { ...backend, extra: true }]) {
    assert.throws(() => validateWslDockerBackend(value), /evaluation_wsl_backend_invalid/);
  }
  assert.throws(() => createWslDockerRunner(backend, { platform: 'linux', spawn: () => assert.fail() }), /evaluation_wsl_host_required/);
});
test('binary stdin streams from the Windows host, with no path conversion, shell, user env or account argv', async t => {
  const f = fixture(t, 'const c=require("crypto");let b=[];process.stdin.on("data",v=>b.push(v));process.stdin.on("end",()=>console.log(JSON.stringify({hash:c.createHash("sha256").update(Buffer.concat(b)).digest("hex"),ambient:process.env.CAFF_BADCASE_MODEL_KEY||null})));');
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 17, 0xa5), inputFile = path.join(f.root, 'archive with spaces.tar'); fs.writeFileSync(inputFile, bytes);
  const r = await f.run(['start', '-a', '-i', 'a'.repeat(64)], { inputFile });
  assert.equal(r.code, 0); assert.equal(r.failure, undefined); assert.deepEqual(JSON.parse(r.stdout), { hash: hash(bytes), ambient: null });
  const c = f.calls[0]; assert.equal(c.program, 'wsl.exe');
  assert.deepEqual(c.args.slice(0, 4), ['--distribution', 'Debian', '--exec', '/usr/bin/env']);
  assert.ok(c.args.includes('-i')); assert.deepEqual(c.args.slice(-7), ['docker', '--context', 'default', 'start', '-a', '-i', 'a'.repeat(64)]);
  assert.ok(c.args.includes('DOCKER_CONFIG=/nonexistent/caff-evaluation-docker')); assert.equal(c.options.shell, false);
  for (const name of ['WSLENV', 'NODE_OPTIONS', 'CAFF_BADCASE_MODEL_KEY']) assert.equal(c.options.env[name], undefined);
  assert.equal(JSON.stringify(c.args).includes(inputFile), false); assert.equal(JSON.stringify(c).includes('synthetic-key-never-forwarded'), false);
});
test('account injection is refused before spawn or artifact creation; output files are exclusive', async t => {
  const f = fixture(t, 'console.log("safe")'), outputFile = path.join(f.root, 'artifact');
  await assert.rejects(f.run(['create'], { key: 'synthetic-forbidden', outputFile }), /evaluation_wsl_credentials_forbidden/);
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(outputFile), false);
  fs.writeFileSync(outputFile, 'prior'); await assert.rejects(f.run(['start'], { outputFile }), /EEXIST/);
  assert.equal(fs.readFileSync(outputFile, 'utf8'), 'prior'); assert.equal(f.calls.length, 0);
});
test('bounded stdout/stderr, timeout and failed spawn report only fixed transport reasons', async t => {
  const large = fixture(t, 'process.stdin.resume();process.stdout.write("x".repeat(4096));setInterval(()=>{},1000);');
  const over = await large.run(['inspect'], { maxOutput: 128, timeoutMs: 3000 }); assert.equal(over.failure, 'output_limit');
  const waiting = fixture(t, 'process.stdin.resume();setInterval(()=>{},1000);');
  const late = await waiting.run(['start'], { timeoutMs: 50 }); assert.equal(late.failure, 'timeout');
  const spawn = () => cp.spawn(path.join(waiting.root, 'missing-program'), [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const run = createWslDockerRunner(backend, { platform: 'win32', spawn }); const unavailable = await run(['inspect']);
  assert.equal(unavailable.failure, 'spawn'); assert.equal(unavailable.stderr, '');
});
test('artifact stdout remains raw binary while stderr stays bounded; no 4 MiB archive cap', async t => {
  const f = fixture(t, 'process.stdin.resume();process.stdout.write(Buffer.alloc(5*1024*1024+3,0xa5));'), file = path.join(f.root, 'artifact.tar');
  const r = await f.run(['start'], { outputFile: file, maxOutput: 64 }); assert.equal(r.code, 0); assert.equal(r.stdout, '');
  assert.deepEqual(fs.readFileSync(file), Buffer.alloc(5 * 1024 * 1024 + 3, 0xa5));
});
