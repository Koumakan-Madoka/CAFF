// Explicit local operator CLI. The operator, NOT this process, owns a separate
// empty daemon in private mount/network namespaces. Never points at production.
const fs = require('node:fs'), path = require('node:path');
const { selectSealedMaterials } = require('./sealed-workbench.cjs');
const { startScriptedWorkbenchServer } = require('./workbench-server.cjs');
const { restoreImageArchive } = require('./image-recovery.cjs');
const { containsSecretSentinel } = require('../../build/server/domain/runtime/badcase-capture/secrets');
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
function readOperatorConfig(file) {
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error();
    const st = fs.lstatSync(file); if (!st.isFile() || st.isSymbolicLink() || st.size > 262144) throw Error();
    const fd = fs.openSync(file, 'r'); let bytes;
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino || opened.size > 262144) throw Error();
      const buffer = Buffer.alloc(262145); let length = 0, n;
      while (length < buffer.length && (n = fs.readSync(fd, buffer, length, buffer.length - length, null))) length += n;
      if (length > 262144) throw Error(); bytes = buffer.subarray(0, length);
    } finally { fs.closeSync(fd); }
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes) || containsSecretSentinel(text)) throw Error();
    const c = JSON.parse(text);
    if (!exact(c, ['root', 'captureRoot', 'selections', 'sources', 'roles', 'rule', 'imageArchive', 'destination'])
      || ![c.root, c.captureRoot].every(v => typeof v === 'string' && path.isAbsolute(v) && !v.includes('\0'))) throw Error();
    const relative = path.relative(c.captureRoot, c.root), inverse = path.relative(c.root, c.captureRoot);
    const outside = v => path.isAbsolute(v) || v === '..' || v.startsWith('..' + path.sep);
    if (!outside(relative) || !outside(inverse)) throw Error();
    return c;
  } catch { throw Object.assign(Error('sealed_workbench_config_invalid'), { code: 'sealed_workbench_config_invalid' }); }
}
async function serve(config) {
  const { verifyImageArchive } = require('./image-archive.cjs');
  const { image } = verifyImageArchive(config.imageArchive);
  // Invalid/missing selected cases fail before load or opening a listening port.
  const materials = selectSealedMaterials({ captureRoot: config.captureRoot, selections: config.selections,
    image, sources: config.sources, roles: config.roles, rule: config.rule });
  const { createScriptedWorkbench } = require('./scripted-workbench.cjs');
  // Pure registry/image validation before any Docker side effect (no preview/pin).
  createScriptedWorkbench({ root: config.root, materials, runProbe: async () => { throw Error('not_started'); } });
  const restored = await restoreImageArchive(config.imageArchive, config.destination);
  return startScriptedWorkbenchServer({ root: config.root, materials, runProbe: restored.runProbe });
}
async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') throw Error('usage');
  const config = readOperatorConfig(process.argv[3]);
  const server = await serve(config); let closing = false;
  const close = () => {
    if (closing) return; closing = true;
    // Wait for in-flight request/cleanup; not cancellation. Do not remove capture,
    // reports, archive files or daemon. Explicit crash recovery remains separate.
    void server.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
  };
  process.on('SIGINT', close); process.on('SIGTERM', close);
  console.log(JSON.stringify({ url: server.url, mode: 'offline-scripted-workbench', realModel: false, faithfulReplay: false,
    note: 'Select material, preview, approve, start. Keep the dedicated daemon alive until requests and cleanup finish.' }));
}
module.exports = { readOperatorConfig, serve };
if (require.main === module) main().catch(() => { console.error('sealed_workbench_start_failed'); process.exitCode = 1; });
