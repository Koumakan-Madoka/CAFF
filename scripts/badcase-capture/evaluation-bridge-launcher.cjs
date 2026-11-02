// Trusted synthetic Docker diagnostic ONLY. No captured code, SDK or model.
// Fixed file inventory, explicit dependency source; never resolve imports, walk,
// npm-install, compile addons, or execute imported source on the host.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const inventory = require('./evaluation-bridge-files.json');
const { manifestFor } = require('./pi-probe-materials.cjs');
const { prepareOfflineTask } = require('../../build/server/domain/runtime/badcase-capture/docker-sandbox');
const { runProbe, verifyProbeImage } = require('./verify-pi-initialization.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const fail = code => Object.assign(Error(code), { code });
const NATIVE = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';
const dependencyHash = m => hash(JSON.stringify(m.files.filter(f => f.path.startsWith('node_modules/'))));
function bridgeReceipt(m, image) {
  return { kind: 'container-evaluation-bridge-diagnostic-v1', instances: 2, cliCalls: 5, crossAuthDenied: true,
    contextVerified: true, participantsVerified: true, publicMessagePersisted: true, callbackClosed: true,
    modelCalls: 0, piExecuted: false, runnable: false, reproduced: false, evaluable: false, strictEvalEligible: false,
    nativeSqliteVerified: true, nodeVersion: image.nodeVersion, architecture: image.architecture,
    inputHash: m.inputHash, dependencyHash: dependencyHash(m) };
}
// Fixed entry checks staged bytes BEFORE loading native addon or any CAFF module.
// Native SQLite is actually loaded/opened/queried inside the container, not host.
const entry = `
const fs=require('node:fs'),crypto=require('node:crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{
 if(process.platform!=='linux'||process.getuid?.()!==65534||process.cwd()!=='/work'||!fs.existsSync('/.dockerenv')
   ||Object.keys(process.env).some(k=>/^(CAFF_|PI_|OPENAI_|ANTHROPIC_|AWS_|NODE_OPTIONS$|NODE_PATH$|LD_PRELOAD$|LD_LIBRARY_PATH$)/.test(k)))throw Error();
 const m=JSON.parse(fs.readFileSync('manifest.json')),image=JSON.parse(fs.readFileSync('environment.json'));
 if(m.schemaVersion!==1||!Array.isArray(m.files)||m.files.length>4096||hash(JSON.stringify(m.files))!==m.inputHash
   ||process.version!==image.nodeVersion||process.arch!==(image.architecture==='amd64'?'x64':'arm64'))throw Error();
 let total=0;const names=new Set();
 for(const f of m.files){
  if(typeof f.path!=='string'||!/^[A-Za-z0-9_.@/-]+$/.test(f.path)||f.path.split('/').some(p=>!p||p==='.'||p==='..')||names.has(f.path))throw Error();
  names.add(f.path);const st=fs.lstatSync('/work/'+f.path);total+=st.size;
  if(total>16777216||!st.isFile()||st.isSymbolicLink()||st.size!==f.size||hash(fs.readFileSync('/work/'+f.path))!==f.sha256)throw Error();
 }
 const Database=require('/work/node_modules/better-sqlite3');const db=new Database(':memory:');
 try{if(!/^\\d+\\.\\d+\\.\\d+$/.test(db.prepare('select sqlite_version() as version').get().version))throw Error();}finally{db.close();}
 const {runContainerBridgeDiagnostic}=require('/work/evaluation-bridge-container.cjs');
 const r=await runContainerBridgeDiagnostic();
 console.log(JSON.stringify({...r,nativeSqliteVerified:true,nodeVersion:image.nodeVersion,architecture:image.architecture,
  inputHash:m.inputHash,dependencyHash:hash(JSON.stringify(m.files.filter(f=>f.path.startsWith('node_modules/'))))}));
})().catch(()=>{process.stderr.write('evaluation_bridge_container_failed\\n');process.exitCode=1;});
`;
function rootPath(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw Error();
  const resolved = path.resolve(root), st = fs.lstatSync(resolved);
  if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) throw Error();
  return resolved;
}
function readFixed(root, relative, remaining = 16 * 1024 * 1024) {
  const parts = relative.split('/');
  // All path segments come from the tracked fixed inventory, never source metadata.
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part); const st = fs.lstatSync(current);
    if (!st.isDirectory() || st.isSymbolicLink()) throw Error();
  }
  const name = path.join(current, parts.at(-1)), before = fs.lstatSync(name);
  if (!before.isFile() || before.isSymbolicLink() || before.size > Math.min(8 * 1024 * 1024, remaining)) throw Error();
  let fd;
  try {
    fd = fs.openSync(name, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino || st.size !== before.size) throw Error();
    const bytes = Buffer.alloc(st.size + 1); let offset = 0;
    while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) break; offset += n; }
    const after = fs.fstatSync(fd);
    if (offset !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs) throw Error();
    return bytes.subarray(0, offset);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function prepareBridgeFiles(repoRoot, dependencyRoot, image) {
  try {
    // Reuse the image-schema validator without expanding offlineTask's file-path grammar.
    prepareOfflineTask({ image, entrypoint: 'x.cjs', timeoutMs: 25000,
      files: [{ path: 'x.cjs', base64: '', sha256: hash('') }] });
    const repo = rootPath(repoRoot), deps = rootPath(dependencyRoot);
    const files = []; let total = 0;
    const copy = (root, source, destination = source) => {
      const bytes = readFixed(root, source, 16 * 1024 * 1024 - total); total += bytes.length;
      files.push({ path: destination, bytes });
    };
    for (const name of inventory.build) copy(repo, name);
    for (const name of inventory.dependencies) copy(deps, name);
    for (const [name, expected] of Object.entries(inventory.packages)) {
      const p = JSON.parse(files.find(f => f.path === name).bytes);
      if (p.name !== expected.name || p.version !== expected.version) throw Error();
    }
    const elf = files.find(f => f.path === NATIVE).bytes;
    if (elf.length < 64 || !elf.subarray(0, 7).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]))
      || elf.readUInt16LE(16) !== 3 || elf.readUInt16LE(18) !== (image.architecture === 'amd64' ? 62 : 183)) throw Error();
    copy(repo, 'scripts/badcase-capture/evaluation-bridge-container.cjs', 'evaluation-bridge-container.cjs');
    files.push({ path: 'probe.cjs', bytes: Buffer.from(entry) }, { path: 'environment.json', bytes: Buffer.from(JSON.stringify(image)) });
    manifestFor(files); return files;
  } catch { throw fail('evaluation_bridge_stage_failed'); }
}
async function runBridgeDiagnostic(repoRoot, dependencyRoot, image, options = {}) {
  image = structuredClone(image);
  const files = prepareBridgeFiles(repoRoot, dependencyRoot, image), m = manifestFor(files);
  const expected = bridgeReceipt(m, image);
  // Injected transport is tests-only. Real path retains strict default image/daemon
  // verification and runProbe's owned lifecycle/watchdog/process-tree cleanup.
  const transport = options.runProbe || (async (i, f) => { await verifyProbeImage(i); return runProbe(i, f, { executableWork: true }); });
  const r = await transport(image, files);
  if (!r || !r.result || r.result.code !== 0 || r.result.failure || r.result.stderr !== ''
    || r.result.stdout !== JSON.stringify(expected) + '\n' || !/^[a-f0-9]{64}$/.test(r.containerId)
    || JSON.stringify(r.manifest) !== JSON.stringify(m)) throw fail('evaluation_bridge_launch_failed');
  return { ...expected, containerId: r.containerId, cleaned: true };
}
// Internal trusted-distribution primitive reused by the runtime wiring stage.
// Caller supplies only tracked literal names after prepareBridgeFiles validated roots.
module.exports = { prepareBridgeFiles, runBridgeDiagnostic, bridgeReceipt, readTrustedDistributionFile: readFixed };
