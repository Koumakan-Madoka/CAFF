// Trusted offline/worker adapter, not an HTTP endpoint or agent launcher.
// Reads only an already sealed, retained snapshot. Runs a FIXED file-integrity
// probe in Docker: never executes captured code, prompt, session, or a model.
import { createCaptureStore } from './capture-store';
import { createCheckpointRetentionStore } from './checkpoint-retention';
import { createReplayRunReferenceStore } from './run-references';
import { readSealedCase, validateSealRequest } from './sealed-case';
import { withProjectWriteLock } from './project-write-lock';
import { prepareOfflineTask, runOfflineDockerTask } from './docker-sandbox';
import { containsSecretSentinel } from './secrets';
import crypto from 'node:crypto';
import { isSafeRelativePath } from './replay-path';
const fail = (code: string) => Object.assign(Error(code), { code });
const hash = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
function relative(p: any) {
  return isSafeRelativePath(p) && p.length <= 1000 && p.split('/').every(s => s.length <= 255);
}
function file(path: string, bytes: Buffer | string) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return { path, sha256: hash(b), base64: b.toString('base64') };
}
// Fixed program; captured .cjs/package.json/hooks are data under snapshot/ only.
// Normalize line endings so this embedded program is independent of checkout EOL.
const PROBE = `
const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const bytes=fs.readFileSync('restore-plan.json'),p=JSON.parse(bytes);
assert.equal(fs.existsSync('probe-output'),false);
fs.mkdirSync('snapshot',{recursive:true});
const actual=[];
function walk(dir){for(const name of fs.readdirSync(dir)){const target=dir+'/'+name,s=fs.lstatSync(target);if(s.isDirectory())walk(target);else{assert.ok(s.isFile());actual.push(target.slice(9));}}}
walk('snapshot');assert.deepEqual(actual.sort(),p.files.map(f=>f.path).sort());
for(const f of p.files){const b=fs.readFileSync('snapshot/'+f.path);assert.equal(b.length,f.size);assert.equal(hash(b),f.sha256);}
for(const d of p.deletions)assert.equal(fs.existsSync('snapshot/'+d),false);
// Write only this fresh copy, after verification. A second run must still see the original bytes.
for(const f of p.files)fs.writeFileSync('snapshot/'+f.path,'changed only inside this container');
fs.writeFileSync('probe-output','isolated');
process.stdout.write(JSON.stringify({schemaVersion:1,kind:'retained-file-restore-probe',snapshotHash:hash(bytes),fileCount:p.files.length,deletionCount:p.deletions.length}));
`.replace(/\r\n/g, '\n');

export function prepareRetainedRestoreProbe(input: any) {
  if (!object(input) || Object.keys(input).sort().join('|') !== ['captureRoot', 'association', 'flagId', 'replayRunId', 'image', 'timeoutMs'].sort().join('|')
    || typeof input.replayRunId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.replayRunId)) throw fail('restore_input_invalid');
  const { captureRoot, association, flagId } = validateSealRequest(input);
  const store = createCaptureStore({ captureRoot });
  return withProjectWriteLock(captureRoot, association.projectId, () => {
    const sealed = readSealedCase({ captureRoot, association, flagId });
    if (!sealed) throw fail('restore_case_missing');
    const scope = { projectId: association.projectId, checkpointId: association.checkpointId, conversationId: association.conversationId,
      turnId: association.turnId, agentId: association.agentId, referenceId: sealed.referenceId };
    const retained = createCheckpointRetentionStore({ captureStore: store }).get(scope);
    if (!retained) throw fail('restore_source_missing'); // Never fall back to live checkpoint or re-seal.
    const cp = retained.checkpoint;
    if (!object(cp.files) || !Array.isArray(cp.deletions) || (cp.uncaptured !== undefined && (!Array.isArray(cp.uncaptured) || cp.uncaptured.length))
      || Object.keys(cp.files).length > 4094 || cp.deletions.length > 4096) throw fail('restore_manifest_unsupported');
    const names = Object.keys(cp.files).sort(), contents: any[] = [], entries: any[] = [];
    let total = 0;
    for (const name of names) {
      const entry = cp.files[name];
      if (!relative(name) || containsSecretSentinel(name) || entry.type !== 'file' || entry.secretExcluded === true
        || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.hash)) throw fail('restore_manifest_unsupported');
      total += entry.size;
      if (total > 16 * 1024 * 1024) throw fail('restore_size_limit');
      // Detached bytes in RAM are the launch input; later live/CAS mutations
      // cannot change them. Same-user storage TCB and synchronous read limits
      // are inherited from retention; do not invoke on the HTTP event loop.
      const b = store.readBlob(scope.projectId, entry.hash);
      if (!Buffer.isBuffer(b)) throw fail('restore_blob_missing');
      if (b.length !== entry.size || hash(b) !== entry.hash) throw fail('restore_blob_corrupt');
      if (containsSecretSentinel(b)) throw fail('restore_contains_secret');
      contents.push(file('snapshot/' + name, b)); entries.push({ path: name, size: b.length, sha256: entry.hash });
    }
    const deletions = [...cp.deletions].sort();
    if (new Set(deletions).size !== deletions.length || deletions.some(d => !relative(d) || containsSecretSentinel(d)
      || names.some(n => n === d || n.startsWith(d + '/') || d.startsWith(n + '/')))) throw fail('restore_manifest_unsupported');
    const plan = JSON.stringify({ files: entries, deletions });
    const snapshotHash = hash(plan);
    const task = { image: input.image, timeoutMs: input.timeoutMs, entrypoint: 'restore-probe.cjs',
      files: [file('restore-probe.cjs', PROBE), file('restore-plan.json', plan), ...contents] };
    const prepared = prepareOfflineTask(task); // Validate whole bundle BEFORE creating protection.
    // Pin all retained inputs, including non-file CAS references. A successful
    // file-only probe is NOT evidence that those inputs are replayable.
    const protectedRun = createReplayRunReferenceStore({ captureStore: store }).protect({ ...scope, replayRunId: input.replayRunId });
    if (protectedRun.reference.checkpointChecksum !== hash(JSON.stringify(cp))) throw fail('restore_source_changed');
    const expectedReceipt = { schemaVersion: 1, kind: 'retained-file-restore-probe', snapshotHash, fileCount: entries.length, deletionCount: deletions.length };
    return { task: { ...task, image: prepared.image }, inputHash: prepared.inputHash, snapshotHash, expectedReceipt,
      provenance: { caseId: sealed.caseId, referenceId: sealed.referenceId, replayRunId: input.replayRunId,
        checkpointChecksum: protectedRun.reference.checkpointChecksum, deliveryMode: cp.replayInput.deliveryMode,
        fileModePreserved: false, replayInputComplete: false, runnable: false, reproduced: false, evaluable: false, strictEvalEligible: false } };
  });
}

export async function runRetainedRestoreProbe(input: any, options: any = {}) {
  const plan = prepareRetainedRestoreProbe(input);
  // The injection seam is for deterministic trusted tests only. No external
  // request can select a runner, program, environment, mount or entrypoint.
  const execution = await runOfflineDockerTask(plan.task, options);
  let verified = false;
  if (execution.state === 'completed') {
    if (execution.inputHash !== plan.inputHash || execution.cleaned !== true || execution.stderr !== ''
      || execution.stdout !== JSON.stringify(plan.expectedReceipt)) throw fail('restore_probe_output_invalid');
    verified = true;
  }
  // No finally/unpin: failures and successful cleanup retain protection until
  // a separately designed lifecycle/GC transaction exists.
  return { kind: 'retained-file-restore-probe', filesVerified: verified, snapshotHash: plan.snapshotHash,
    provenance: plan.provenance, execution };
}
