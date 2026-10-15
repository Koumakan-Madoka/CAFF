// Trusted synchronous worker preparation, NOT a launcher or public API.
// Carries captured bytes as DATA in one JSON string, never as archive paths/code.
// No host SDK/session discovery, Docker, model invocation, release or GC here.
import crypto from 'node:crypto';
import { createCaptureStore } from './capture-store';
import { createCheckpointRetentionStore } from './checkpoint-retention';
import { createReplayRunReferenceStore } from './run-references';
import { inspectRetainedReplayInputs } from './replay-input-preflight';
import { readSealedCase, validateSealRequest } from './sealed-case';
import { containsSecretSentinel } from './secrets';
import { withProjectWriteLock } from './project-write-lock';
const fail = (code: string) => Object.assign(Error(code), { code });
const hash = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const LIMIT = 4 * 1024 * 1024; // Encoded capsule budget; reserve space for separately trusted SDK files.
function relative(v: any): boolean {
  return typeof v === 'string' && v.length <= 1000 && /^[A-Za-z0-9_.\-/]+$/.test(v)
    && v.split('/').every((p: string) => p && p !== '.' && p !== '..' && p.length <= 255);
}
export function prepareRetainedInitializationCapsule(input: any) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join('|') !== 'association|captureRoot|flagId|replayRunId'
    || typeof input.replayRunId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.replayRunId)) throw fail('initialization_input_invalid');
  const request = validateSealRequest(input);
  const { captureRoot, association, flagId } = request;
  const replayRunId = input.replayRunId;
  const store = createCaptureStore({ captureRoot });
  return withProjectWriteLock(captureRoot, association.projectId, () => {
    // Never accept a caller's earlier inspection summary as permission. Every
    // invocation (including retries) repeats preflight while holding this lock.
    const inspected = inspectRetainedReplayInputs({ captureRoot, association, flagId });
    const sealed = readSealedCase({ captureRoot, association, flagId });
    if (!sealed) throw fail('replay_case_missing');
    const scope = { projectId: association.projectId, checkpointId: association.checkpointId,
      conversationId: association.conversationId, turnId: association.turnId, agentId: association.agentId,
      referenceId: sealed.referenceId };
    const retained = createCheckpointRetentionStore({ captureStore: store }).get(scope);
    if (!retained) throw fail('replay_source_missing');
    const cp = retained.checkpoint;
    // Defensive recheck of the independent preflight read while under the same lock.
    // Consumer enforces the same blob ceiling; fail here before publishing a reference.
    if (retained.blobHashes.length > 8192) throw fail('initialization_capsule_limit');
    if (hash(JSON.stringify(cp)) !== inspected.checkpointChecksum) throw fail('initialization_source_changed');
    let total = 0;
    const bytesByHash = new Map<string, Buffer>();
    const blobs = retained.blobHashes.map((sha256: string) => {
      const bytes = store.readBlob(scope.projectId, sha256);
      if (!Buffer.isBuffer(bytes) || hash(bytes) !== sha256) throw fail('initialization_blob_changed');
      total += bytes.length;
      // Early raw-byte bound; the encoded capsule limit below is stricter overall.
      if (total > LIMIT) throw fail('initialization_capsule_limit');
      if (containsSecretSentinel(bytes)) throw fail('replay_contains_secret');
      bytesByHash.set(sha256, bytes);
      return { sha256, base64: bytes.toString('base64') };
    });
    const names = Object.keys(cp.files), nameSet = new Set(names);
    if (names.length > 4094 || !Array.isArray(cp.deletions) || cp.deletions.length > 4096) throw fail('initialization_files_invalid');
    for (const name of names) {
      const entry = cp.files[name], bytes = bytesByHash.get(entry.hash);
      if (!relative(name) || containsSecretSentinel(name) || entry.type !== 'file' || entry.secretExcluded
        || !Number.isSafeInteger(entry.size) || !bytes || bytes.length !== entry.size) throw fail('initialization_files_invalid');
      const parts = name.split('/'); parts.pop();
      while (parts.length) { if (nameSet.has(parts.join('/'))) throw fail('initialization_files_invalid'); parts.pop(); }
    }
    if (new Set(cp.deletions).size !== cp.deletions.length || cp.deletions.some((d: string) => !relative(d)
      || containsSecretSentinel(d) || names.some(n => n === d || n.startsWith(d + '/') || d.startsWith(n + '/')))) throw fail('initialization_files_invalid');
    // JSON string detaches both metadata and byte values; there are no mutable
    // Buffer/record references for later storage writes to alter after unlock.
    const capsule = JSON.stringify({ schemaVersion: 1, kind: 'retained-initialization-inputs', checkpoint: cp, blobs });
    const capsuleBytes = Buffer.byteLength(capsule);
    if (capsuleBytes > LIMIT) throw fail('initialization_capsule_limit');
    // Internal protect return-value check is defense in depth, not remote attestation.
    const protectedRun = createReplayRunReferenceStore({ captureStore: store }).protect({ ...scope, replayRunId });
    if (protectedRun.reference.checkpointChecksum !== inspected.checkpointChecksum
      || JSON.stringify(protectedRun.reference.blobHashes) !== JSON.stringify(retained.blobHashes)) throw fail('initialization_source_changed');
    // No unpin on success/failure. Protection is not evidence of a started run.
    return { capsule, capsuleHash: hash(capsule), capsuleBytes,
      provenance: { caseId: sealed.caseId, referenceId: sealed.referenceId, replayRunId,
        checkpointChecksum: inspected.checkpointChecksum, deliveryMode: inspected.deliveryMode,
        launchAuthorized: false, runnable: false, reproduced: false, evaluable: false, strictEvalEligible: false } };
  });
}
