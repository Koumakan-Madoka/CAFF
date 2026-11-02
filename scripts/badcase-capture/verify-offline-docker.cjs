// Explicit opt-in real Docker evidence. No model, SDK, production DB or host mounts.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { runOfflineDockerTask } = require('../../build/server/domain/runtime/badcase-capture/docker-sandbox.js');
const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf('--' + name); if (i < 0 || !args[i + 1]) throw Error('Missing --' + name); return args[i + 1]; }
const image = { imageId: arg('image-id'), repositoryDigest: arg('repository-digest'), architecture: arg('architecture'), nodeVersion: arg('node-version'), pythonVersion: arg('python-version') };
// Synthetic sentinel, not an actual credential. Must never reach the container environment.
process.env.CAFF_OFFLINE_SENTINEL = 'synthetic-host-only';
process.env.NODE_OPTIONS = '--require /nonexistent-host-hook';
function file(path, content) { const b = Buffer.from(content); return { path, base64: b.toString('base64'), sha256: crypto.createHash('sha256').update(b).digest('hex') }; }
function task(source, extra = {}) { return { image, entrypoint: 'task.cjs', files: [file('task.cjs', source), file('input/data.txt', 'same immutable start\n')], timeoutMs: 15000, ...extra }; }
const probe = `
const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net'),assert=require('node:assert/strict');
(async()=>{
 assert.equal(process.getuid(),65534);
 assert.equal(fs.readFileSync('input/data.txt','utf8'),'same immutable start\\n');
 assert.equal(fs.existsSync('prior-output.txt'),false);
 assert.equal(fs.existsSync('/var/run/docker.sock'),false);
 assert.equal(fs.existsSync('/host'),false);
 assert.equal(fs.existsSync('/mnt/e/pythonproject/caff/package.json'),false);
 assert.equal(Object.keys(process.env).some(k=>/^(CAFF_|PI_|OPENAI_|ANTHROPIC_|AWS_|NODE_OPTIONS)/.test(k)),false);
 assert.throws(()=>fs.writeFileSync('/etc/caff-offline-test','no'));
 fs.symlinkSync('/etc','outside');assert.throws(()=>fs.writeFileSync('outside/caff-offline-test','no'));
 fs.writeFileSync('prior-output.txt','isolated output');
 assert.equal(cp.execFileSync('/bin/sh',['-c','printf container-shell'],{encoding:'utf8'}),'container-shell');
 for(const host of ['127.0.0.1','1.1.1.1']) await new Promise((resolve,reject)=>{const s=net.connect({host,port:3100});s.setTimeout(500);s.on('connect',()=>{s.destroy();reject(Error('unexpected connection'))});s.on('error',()=>resolve());s.on('timeout',()=>{s.destroy();resolve()})});
 console.log(JSON.stringify({node:process.version,python:cp.execFileSync('/usr/bin/python3',['--version'],{encoding:'utf8'}).trim(),uid:process.getuid(),files:'verified',shell:'container',network:'denied'}));
})().catch(()=>process.exit(1));
`;
(async () => {
  const first = await runOfflineDockerTask(task(probe));
  assert.equal(first.state, 'completed'); assert.equal(first.cleaned, true);
  const second = await runOfflineDockerTask(task(probe));
  assert.equal(second.state, 'completed'); assert.equal(second.cleaned, true);
  assert.equal(first.inputHash, second.inputHash); assert.notEqual(first.containerId, second.containerId);
  const timeout = await runOfflineDockerTask(task('console.log("TIMEOUT-READY");setInterval(()=>{},1000)', { timeoutMs: 3000 }));
  assert.match(timeout.stdout, /TIMEOUT-READY/);
  assert.equal(timeout.state, 'killed'); assert.equal(timeout.reason, 'timeout'); assert.equal(timeout.cleaned, true);
  const output = await runOfflineDockerTask(task('process.stdout.write("x".repeat(2*1024*1024));setInterval(()=>{},1000)'));
  assert.equal(output.state, 'killed'); assert.equal(output.reason, 'output_limit'); assert.equal(output.cleaned, true);
  const memory = await runOfflineDockerTask(task('const held=[];setInterval(()=>held.push(Buffer.alloc(16*1024*1024,1)),10)'));
  assert.equal(memory.state, 'failed'); assert.equal(memory.cleaned, true); assert.ok(memory.reason === 'oom' || memory.exitCode === 80);
  const mismatch = await runOfflineDockerTask(task('console.log("MUST-NOT-RUN")', { image: { ...image, nodeVersion: 'v0.0.0' } }));
  assert.equal(mismatch.state, 'failed'); assert.equal(mismatch.exitCode, 78); assert.equal(mismatch.stdout, ''); assert.equal(mismatch.cleaned, true);
  await assert.rejects(runOfflineDockerTask(task(probe, { image: { ...image, imageId: 'sha256:' + '0'.repeat(64) } })), /offline_image_invalid/);
  console.log(JSON.stringify({ ok: true, image, inputHash: first.inputHash, isolation: first.isolation, runtimeProbe: JSON.parse(first.stdout), independentCopies: 2, timeout: timeout.reason, output: output.reason, memoryLimit: { reason: memory.reason, exitCode: memory.exitCode }, versionMismatch: mismatch.exitCode, missingImage: 'blocked', cleanedContainerIds: [first, second, timeout, output, memory, mismatch].map(r => r.containerId), modelInvocations: 0, piExecuted: false, replayAcceptance: false }, null, 2));
})().catch(e => { console.error(JSON.stringify({ ok: false, code: e.code || e.message, containerId: e.containerId || null, containerName: e.containerName || null })); process.exitCode = 1; });
