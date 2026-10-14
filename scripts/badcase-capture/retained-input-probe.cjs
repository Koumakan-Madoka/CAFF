// Trusted offline experiment. Captured content is ONLY capsule.json DATA.
// No SDK, tar, captured executable, prompt invocation or public endpoint.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { prepareRetainedInitializationCapsule } = require('../../build/server/domain/runtime/badcase-capture/retained-initialization');
const { decodeInitializationCapsule } = require('../../build/server/domain/runtime/badcase-capture/capsule-materialization');
const { prepareOfflineTask, runOfflineDockerTask } = require('../../build/server/domain/runtime/badcase-capture/docker-sandbox');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const entry = `
const fs=require('node:fs');
try {
 if(process.platform!=='linux'||process.getuid()!==65534||process.cwd()!=='/work'||!fs.existsSync('/.dockerenv'))throw Error();
 const {materializeInitializationCapsule}=require('./capsule-materialization.js');
 const receipt=materializeInitializationCapsule(fs.readFileSync('capsule.json','utf8'),JSON.parse(fs.readFileSync('expected.json','utf8')),'/work/restored');
 console.log(JSON.stringify(receipt));
} catch { process.stderr.write('capsule_materialization_failed\\n'); process.exitCode=1; }
`;
function file(name, bytes) { bytes = Buffer.from(bytes); return { path: name, base64: bytes.toString('base64'), sha256: hash(bytes) }; }
function taskFor(capsule, expected, image) {
  // Trusted local build is part of the TCB, separate from every captured path/blob.
  const build = path.resolve(__dirname, '../../build/server/domain/runtime/badcase-capture');
  const task = { image, timeoutMs: 15000, entrypoint: 'probe.cjs', files: [
    file('probe.cjs', entry), file('capsule-materialization.js', fs.readFileSync(path.join(build, 'capsule-materialization.js'))),
    file('secrets.js', fs.readFileSync(path.join(build, 'secrets.js'))),
    file('capsule.json', capsule), file('expected.json', JSON.stringify(expected)),
  ] };
  prepareOfflineTask(task); return task;
}
async function runRetainedInputProbe(request, image, options = {}) {
  const p = prepareRetainedInitializationCapsule(request);
  const expected = { capsuleHash: p.capsuleHash, checkpointChecksum: p.provenance.checkpointChecksum };
  const plan = decodeInitializationCapsule(p.capsule, expected);
  const task = taskFor(p.capsule, expected, image), prepared = prepareOfflineTask(task);
  const r = await (options.runTask || runOfflineDockerTask)(task);
  if (r.state !== 'completed' || r.cleaned !== true || r.inputHash !== prepared.inputHash
    || r.stderr !== '' || r.stdout !== JSON.stringify(plan.receipt) + '\n') throw Object.assign(Error('capsule_probe_failed'), { code: 'capsule_probe_failed' });
  // Do not expose untrusted stdout/stderr or archived texts to downstream callers.
  return { ...plan.receipt, containerId: r.containerId, cleaned: true, inputHash: r.inputHash, provenance: p.provenance };
}
module.exports = { runRetainedInputProbe, taskFor };
