// Internal synchronous publication step for a TRUSTED prepared schema-v1
// checkpoint. Call inside asyncLease.writeSync after all helpers emit close.
// This does not authorize/read a target, prepare invocation material, enable
// Windows capture, or prove consistency. No service/HTTP/agent entry calls it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withProjectWriteLock } from './project-write-lock';
import { checkpointBlobHashes } from './checkpoint-retention';
import { containsSecretSentinel } from './secrets';
import { readCapturedCallbackInput } from './callback-input';
const hash = (bytes: any) => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (reason: string) => Object.assign(Error(reason), { code: reason });
const result = (reason: string) => ({ captured: false, checkpointId: '', reason });
const jsonBytes = (value: any) => Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
const id = (value: any) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function publishPreparedCheckpoint(options: any): any {
  const store = options?.store, original = options?.checkpoint;
  if (!store?.captureRoot || !id(original?.projectId) || !id(original?.checkpointId)) return result('checkpoint_material_invalid');
  const projectId = original.projectId;
  const legacy = original.schemaVersion !== 2;
  // v2 was sanitized against host-known literals before publication. Legacy
  // schema-v1 keeps its sentinel checks; don't reject example text in v2.
  const hasSecret = (bytes: any) => legacy && containsSecretSentinel(bytes);
  try {
    return withProjectWriteLock(store.captureRoot, projectId, () => {
      const policy = store.loadPolicy(projectId);
      if (policy.status !== 'enabled') return result('policy_not_enabled');
      let checkpoint: any, materials: Map<string, Buffer>, missing: Map<string, Buffer>;
      try {
        checkpoint = JSON.parse(JSON.stringify(original));
        if (checkpoint.projectId !== projectId || !id(checkpoint.checkpointId)
          || checkpoint.strictEvalEligible !== false || checkpoint.status !== 'staged'
          || typeof checkpoint.targetDir !== 'string' || !path.isAbsolute(checkpoint.targetDir)
          || hasSecret(JSON.stringify(checkpoint))) throw Error();
        const references = new Set(checkpointBlobHashes(checkpoint));
        if (!(options.blobs instanceof Map)) throw Error();
        materials = new Map(); missing = new Map();
        // No extra plans: do not persist bytes outside the manifest's closure.
        for (const [digest, content] of options.blobs) {
          if (!references.has(digest) || !Buffer.isBuffer(content)) throw Error();
          const owned = Buffer.alloc(content.length); content.copy(owned);
          if (hash(owned) !== digest || hasSecret(owned)) throw Error();
          materials.set(digest, owned);
        }
        for (const digest of references) {
          // An existing hit is checked by bytes, not hasBlob/size alone. A
          // same-size corrupt CAS entry may not become a successful reference.
          const existing = store.readBlob(projectId, digest);
          if (existing !== null) {
            if (!Buffer.isBuffer(existing) || hash(existing) !== digest || hasSecret(existing)) throw Error();
            materials.set(digest, existing);
          } else {
            if (!materials.has(digest)) throw Error();
            missing.set(digest, materials.get(digest)!);
          }
        }
        if (Object.hasOwn(checkpoint.replayInput, 'callbackInput')) readCapturedCallbackInput(checkpoint, h => materials.get(h));
        for (const entry of Object.values(checkpoint.files) as any[]) {
          if (entry.type === 'file' && entry.secretExcluded !== true
            && (!Number.isSafeInteger(entry.size) || entry.size < 0 || materials.get(entry.hash)?.length !== entry.size)) throw Error();
        }
      } catch { return result('checkpoint_material_invalid'); }
      // Refuse collisions even when the existing JSON is corrupt/unreadable.
      // Storage ancestors/same-OS-user remain TCB, not an openat2 sandbox.
      const filename = path.join(store.captureRoot, 'projects', projectId, 'checkpoints', `${checkpoint.checkpointId}.json`);
      try { fs.lstatSync(filename); return result('checkpoint_conflict'); }
      catch (error: any) { if (error.code !== 'ENOENT') return result('checkpoint_conflict'); }

      const stagingId = `publish-${crypto.randomUUID()}`;
      let outcome: any, failureReason = 'checkpoint_write_failed';
      const quota = (usage: number, pending: number) => {
        if (!Number.isSafeInteger(usage) || usage < 0 || !Number.isSafeInteger(pending) || pending < 0
          || !Number.isSafeInteger(usage + pending)) throw Error();
        if (usage + pending > policy.stagingQuotaBytes) throw fail('quota_exceeded');
      };
      try {
        const newBlobBytes = [...missing.values()].reduce((sum, bytes) => sum + bytes.length, 0);
        const latestDelta = store.latestPointerJsonSize(projectId, checkpoint.targetDir, checkpoint.checkpointId)
          - store.latestPointerSize(projectId, checkpoint.targetDir);
        const fileHashes = new Set((Object.values(checkpoint.files) as any[])
          .filter(f => f.type === 'file' && f.secretExcluded !== true).map(f => f.hash));
        if (!legacy) {
          fileHashes.add(checkpoint.gitSnapshot.patchBlobHash);
          for (const root of checkpoint.gitSnapshot.projectSkills) for (const file of Object.values(root.files) as any[]) fileHashes.add(file.hash);
        }
        const replay = checkpoint.replayInput, sessionHash = replay.sessionBlobHash;
        const replayHashes = new Set([replay.promptBlobHash, replay.harness.configSnapshotHash,
          replay.callbackInput?.blobHash, ...replay.harness.skillSnapshots.map((s: any) => s.blobHash)].filter(Boolean));
        const blobBytesByKind = { files: 0, session: 0, replay: 0, shared: 0 };
        // Credit each NEW unique payload once. Hashes shared across categories
        // have their own bucket, rather than claiming the bytes for both roles.
        for (const [digest, bytes] of missing) {
          const roles: ('files' | 'session' | 'replay')[] = [];
          if (fileHashes.has(digest)) roles.push('files');
          if (sessionHash === digest) roles.push('session');
          if (replayHashes.has(digest)) roles.push('replay');
          if (!roles.length) throw Error();
          blobBytesByKind[roles.length > 1 ? 'shared' : roles[0]] += bytes.length;
        }
        checkpoint.stats = { ...checkpoint.stats, newBlobBytes, blobBytesByKind,
          sessionBytes: sessionHash ? materials.get(sessionHash)!.length : null, newManifestBytes: 0, totalNewBytes: 0 };
        // Self-reported stats change JSON width. Require an actual fixed point,
        // not a guessed 4KiB reserve, before writing ANY staging bytes.
        let stable = false;
        for (let n = 0; n < 16; n++) {
          const next = jsonBytes(checkpoint) + latestDelta;
          if (next === checkpoint.stats.newManifestBytes && checkpoint.stats.totalNewBytes === newBlobBytes + next) { stable = true; break; }
          checkpoint.stats.newManifestBytes = next;
          checkpoint.stats.totalNewBytes = newBlobBytes + next;
        }
        if (!stable) throw Error();
        // Shrinking latest reduces the final delta, but only AFTER manifest
        // publication. Reserve the peak logical bytes, not the smaller delta.
        const manifestReserve = jsonBytes(checkpoint) + Math.max(0, latestDelta);
        const base = store.computeUsage(projectId).totalBytes;
        quota(base, newBlobBytes + manifestReserve);
        let stagedBytes = 0;
        for (const [digest, bytes] of missing) {
          // Staging is outside computeUsage. Account for it explicitly; do not
          // give every stage a fresh quota budget or count dedup aliases twice.
          quota(store.computeUsage(projectId).totalBytes, newBlobBytes + manifestReserve);
          const staged = store.stageBlob(projectId, stagingId, digest, bytes);
          if (staged.bytes !== bytes.length) throw Error();
          stagedBytes += staged.bytes;
        }
        if (stagedBytes !== newBlobBytes) throw Error();
        store.commitStaging(projectId, stagingId);
        for (const [digest, expected] of materials) {
          const bytes = store.readBlob(projectId, digest);
          if (!Buffer.isBuffer(bytes) || bytes.length !== expected.length || hash(bytes) !== digest || hasSecret(bytes)) throw Error();
        }
        quota(store.computeUsage(projectId).totalBytes, manifestReserve);
        store.saveCheckpoint(projectId, checkpoint);
        // The manifest is the durable GC reference before latest/turn can point
        // at it. If latest fails, retain this staged manifest; never delete blobs
        // to "roll back" a reference that may already have reached disk.
        store.saveLatestCheckpointId(projectId, checkpoint.targetDir, checkpoint.checkpointId);
        outcome = { captured: true, checkpointId: checkpoint.checkpointId, checkpoint, reason: '' };
      } catch (error: any) {
        failureReason = error?.code === 'quota_exceeded' ? 'quota_exceeded' : 'checkpoint_write_failed';
        outcome = result(failureReason);
        try { store.savePolicy({ ...policy, status: 'suspended', suspendReason: failureReason === 'quota_exceeded' ? 'quota_exceeded' : 'write_failed' }); }
        catch { outcome = result('checkpoint_write_failed'); }
      } finally {
        try { store.rollbackStaging(projectId, stagingId); }
        catch {
          outcome = result('checkpoint_cleanup_failed');
          try { store.savePolicy({ ...policy, status: 'suspended', suspendReason: 'write_failed' }); } catch {}
        }
      }
      return outcome;
    });
  } catch (error: any) {
    return result(error?.code === 'capture_writer_busy' ? 'capture_writer_busy' : 'checkpoint_write_failed');
  }
}
