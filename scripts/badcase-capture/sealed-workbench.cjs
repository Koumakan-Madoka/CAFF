// Trusted operator composition: select existing sealed messages, never live files
// or browser-supplied paths. No collection/trajectory authorization or paid model.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { readSealedCase } = require('../../build/server/domain/runtime/badcase-capture/sealed-case');
const { inspectRetainedReplayInputs } = require('../../build/server/domain/runtime/badcase-capture/replay-input-preflight');
const { containsSecretSentinel } = require('../../build/server/domain/runtime/badcase-capture/secrets');
const { startScriptedWorkbenchServer } = require('./workbench-server.cjs');
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const MAX_CASE_BYTES = 64 * 1024;
function invalid() { return Object.assign(Error('sealed_material_invalid'), { code: 'sealed_material_invalid' }); }
function selectSealedMaterials(options) {
  try {
    if (!exact(options, ['captureRoot', 'selections', 'image', 'sources', 'roles', 'rule'])
      || typeof options.captureRoot !== 'string' || !path.isAbsolute(options.captureRoot) || options.captureRoot.includes('\0')
      || !Array.isArray(options.selections) || options.selections.length < 1 || options.selections.length > 64) throw invalid();
    const { captureRoot, selections, image, sources, roles, rule } = JSON.parse(JSON.stringify(options));
    const seen = new Set();
    return selections.map(s => {
      if (!exact(s, ['id', 'projectId', 'conversationId', 'messageId']) || !Object.values(s).every(id)
        || seen.has(s.projectId + ':' + s.id)) throw invalid();
      seen.add(s.projectId + ':' + s.id);
      const dirs = [captureRoot, path.join(captureRoot, 'projects'), path.join(captureRoot, 'projects', s.projectId)];
      dirs.push(path.join(dirs[2], 'cases'));
      for (const dir of dirs) { const st = fs.lstatSync(dir); if (!st.isDirectory() || st.isSymbolicLink()) throw invalid(); }
      const file = path.join(dirs[3], hash(s.messageId) + '.json'), st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_CASE_BYTES) throw invalid();
      const fd = fs.openSync(file, 'r'); let bytes;
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino || opened.size > MAX_CASE_BYTES) throw invalid();
        // Bound allocation/read even if a cooperating writer unexpectedly grows it.
        const buffer = Buffer.alloc(MAX_CASE_BYTES + 1); let length = 0, n;
        while (length < buffer.length && (n = fs.readSync(fd, buffer, length, buffer.length - length, null))) length += n;
        if (length > MAX_CASE_BYTES) throw invalid(); bytes = buffer.subarray(0, length);
      } finally { fs.closeSync(fd); }
      const text = bytes.toString('utf8');
      if (!Buffer.from(text).equals(bytes) || containsSecretSentinel(text)) throw invalid();
      const envelope = JSON.parse(text), record = envelope.record;
      if (!exact(envelope, ['schemaVersion', 'checksum', 'record']) || envelope.schemaVersion !== 1
        || envelope.checksum !== hash(JSON.stringify(record))
        || ['projectId', 'conversationId', 'messageId'].some(k => record?.association?.[k] !== s[k])) throw invalid();
      const request = { captureRoot, association: record.association, flagId: record.flagId };
      // Reuse the existing strict case schema and retained-closure/blob gates. No
      // checkpoint fallback and no protect/write here. Preview and each run still
      // revalidate under the writer lock. Same-user storage/ancestors remain TCB.
      if (JSON.stringify(readSealedCase(request)) !== JSON.stringify(record)) throw invalid();
      inspectRetainedReplayInputs(request);
      return { id: s.id, projectId: s.projectId, request: { ...request, replayRunId: 'selection-' + hash(s.id).slice(0, 32) }, image, sources, roles, rule };
    });
  } catch { throw invalid(); } // No captured text, paths or raw FS errors in responses.
}
async function startSealedWorkbenchServer({ root, runProbe, ...selectionOptions }) {
  const materials = selectSealedMaterials(selectionOptions);
  return startScriptedWorkbenchServer({ root, runProbe, materials });
}
module.exports = { selectSealedMaterials, startSealedWorkbenchServer };
