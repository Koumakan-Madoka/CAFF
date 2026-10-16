import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCaptureStore } from './capture-store';
import { checkpointBlobHashes, createCheckpointRetentionStore } from './checkpoint-retention';
import { createReplayRunReferenceStore } from './run-references';
import { readSealedCase } from './sealed-case';
import { validateTrajectoryRequest } from './trajectory';
import { acquireProjectWriteLease } from './project-write-lock';

// Trusted offline API only. No background/HTTP/agent caller. Collects ONLY CAS
// objects unreachable from every live checkpoint and permanent pin. Never expires
// manifests, releases run pins or cleans staging/unknown crash artifacts. Storage
// ancestors and cooperating same-user writers remain TCB, not an openat2 sandbox.
const fail = (code: string, progress?: any) => Object.assign(Error(code), { code, ...progress });
const digest = (v: string | Buffer) => crypto.createHash('sha256').update(v).digest('hex');
const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: any, keys: string[]) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const id = (v: any) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const hex = (v: any) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const MAX_FILE = 16 * 1024 * 1024, MAX_METADATA = 64 * 1024 * 1024, MAX_ENTRIES = 10000;
const categories = ['checkpoints', 'latest', 'flags', 'retention', 'cases', 'runReferences'];
function request(q: any) {
  if (!exact(q, ['captureRoot', 'projectId']) || typeof q.captureRoot !== 'string' || !path.isAbsolute(q.captureRoot)
    || q.captureRoot.includes('\0') || !id(q.projectId)) throw fail('orphan_gc_invalid');
  const root = path.resolve(q.captureRoot), project = path.join(root, 'projects', q.projectId);
  try {
    for (const dir of [root, path.join(root, 'projects'), project]) if (!fs.lstatSync(dir).isDirectory()) throw Error();
  } catch { throw fail('orphan_gc_inventory_invalid'); }
  return { captureRoot: root, projectId: q.projectId as string, project };
}
function identity(stat: fs.Stats) {
  if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) throw Error();
  return [stat.dev, stat.ino, stat.size, stat.birthtimeMs, stat.mtimeMs, stat.ctimeMs];
}
function scan(q: ReturnType<typeof request>) {
  try {
    let entries = 0, metadataBytes = 0;
    const snapshot: any[] = [], required = new Set<string>(), conservative = new Set<string>(), checkpointIds = new Set<string>();
    const blobs = new Map<string, { hash: string; bytes: number; identity: number[] }>();
    function names(dir: string) {
      if (!fs.lstatSync(dir).isDirectory()) throw Error();
      const found = fs.readdirSync(dir).sort(); entries += found.length;
      if (entries > MAX_ENTRIES) throw Error();
      snapshot.push([path.relative(q.project, dir), found]);
      return found;
    }
    function read(file: string) {
      const before = fs.lstatSync(file), stamp = identity(before);
      if (before.size > MAX_FILE || (metadataBytes += before.size) > MAX_METADATA) throw Error();
      const fd = fs.openSync(file, 'r');
      try {
        if (JSON.stringify(identity(fs.fstatSync(fd))) !== JSON.stringify(stamp)) throw Error();
        const bytes = Buffer.alloc(before.size + 1); let offset = 0;
        while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) break; offset += n; }
        if (offset !== before.size || JSON.stringify(identity(fs.fstatSync(fd))) !== JSON.stringify(stamp)) throw Error();
        const value = bytes.subarray(0, offset), text = value.toString('utf8');
        if (!Buffer.from(text).equals(value)) throw Error();
        snapshot.push([path.relative(q.project, file), stamp, digest(value)]);
        return JSON.parse(text);
      } finally { fs.closeSync(fd); }
    }
    // Unknown hash-valued fields overprotect existing CAS objects. They do not
    // certify new schema support; explicit schema versions still fail closed.
    function hashLiterals(value: any, depth = 0) {
      if (depth > 64) throw Error();
      if (hex(value)) conservative.add(value);
      else if (value && typeof value === 'object') for (const child of Object.values(value)) hashLiterals(child, depth + 1);
    }
    const projectStat = fs.lstatSync(q.project);
    snapshot.push(['project', projectStat.dev, projectStat.ino, projectStat.birthtimeMs]);
    const top = names(q.project);
    // The lease's owner is transient, not part of a stable preview. Nothing
    // else may be silently ignored, especially stale recovery/staging trees.
    snapshot.pop();
    snapshot.push(['directories', top.filter(n => n !== '.writer-lock')]);
    for (const name of top) {
      if (!['blobs', 'policy.json', 'staging', '.writer-lock', ...categories].includes(name)) throw Error();
      if (name === 'policy.json') read(path.join(q.project, name));
      if (name === 'staging' && names(path.join(q.project, name)).length) throw Error();
    }
    const parsed: Record<string, { name: string; value: any }[]> = {};
    for (const kind of categories) {
      parsed[kind] = [];
      if (!top.includes(kind)) continue;
      const dir = path.join(q.project, kind);
      for (const name of names(dir)) {
        const pattern = kind === 'checkpoints' ? /^[A-Za-z0-9_-]{1,128}\.json$/ : kind === 'latest' ? /^[a-f0-9]{16}\.json$/ : /^[a-f0-9]{64}\.json$/;
        if (!pattern.test(name)) throw Error(); // Includes unpublished temp files.
        const value = read(path.join(dir, name));
        if (!object(value)) throw Error();
        parsed[kind].push({ name, value }); hashLiterals(value);
      }
    }
    for (const { name, value } of parsed.checkpoints) {
      if (value.projectId !== q.projectId || !id(value.checkpointId) || name !== `${value.checkpointId}.json`
        || !['conversationId', 'turnId', 'agentId'].every(k => id(value[k]))) throw Error();
      for (const hash of checkpointBlobHashes(value)) required.add(hash);
      checkpointIds.add(value.checkpointId);
    }
    const store = createCaptureStore({ captureRoot: q.captureRoot });
    const retention = createCheckpointRetentionStore({ captureStore: store });
    const retained = retention.protectedObjects(q.projectId);
    const runs = createReplayRunReferenceStore({ captureStore: store }).protectedObjects(q.projectId);
    for (const hash of [...retained.blobHashes, ...runs.blobHashes]) required.add(hash);
    for (const cp of [...retained.checkpointIds, ...runs.checkpointIds]) checkpointIds.add(cp);
    for (const { name, value } of parsed.flags) {
      const r = value.record;
      if (!exact(value, ['schemaVersion', 'checksum', 'record']) || value.schemaVersion !== 1 || !object(r) || r.schemaVersion !== 1
        || value.checksum !== digest(JSON.stringify(r)) || r.projectId !== q.projectId || !id(r.messageId) || !id(r.conversationId)
        || name !== `${digest(r.messageId)}.json` || r.flagId !== `flag-${digest(`${q.projectId}\0${r.messageId}`)}`
        || (r.checkpointId !== null && (!id(r.checkpointId) || !checkpointIds.has(r.checkpointId)))) throw Error();
      if (r.sealAssociation !== undefined && r.sealAssociation !== null) {
        const a = validateTrajectoryRequest({ association: r.sealAssociation }).association;
        if (['projectId', 'conversationId', 'messageId', 'checkpointId', 'runId'].some(k => a[k] !== r[k])) throw Error();
      }
    }
    for (const { value } of parsed.latest) {
      if (!exact(value, ['checkpointId', 'targetDir', 'updatedAt']) || !id(value.checkpointId) || !checkpointIds.has(value.checkpointId)
        || typeof value.targetDir !== 'string' || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw Error();
    }
    for (const { name, value } of parsed.cases) {
      const record = value.record, a = record?.association;
      if (!a || name !== `${digest(a.messageId)}.json`) throw Error();
      const sealed = readSealedCase({ captureRoot: q.captureRoot, association: a, flagId: record.flagId });
      if (!sealed || a.projectId !== q.projectId || !retention.get({ projectId: q.projectId, referenceId: record.referenceId,
        checkpointId: a.checkpointId, conversationId: a.conversationId, turnId: a.turnId, agentId: a.agentId })) throw Error();
    }
    if (top.includes('blobs')) {
      const dir = path.join(q.project, 'blobs');
      for (const prefix of names(dir)) {
        if (!/^[a-f0-9]{2}$/.test(prefix)) throw Error();
        for (const hash of names(path.join(dir, prefix))) {
          if (!hex(hash) || !hash.startsWith(prefix)) throw Error();
          const stamp = identity(fs.lstatSync(path.join(dir, prefix, hash)));
          const blob = { hash, bytes: stamp[2], identity: stamp }; blobs.set(hash, blob);
          snapshot.push(['blob', blob]);
        }
      }
    }
    // Missing referenced data is an incomplete inventory, not permission to
    // recover space from an already broken project. No content is repaired.
    for (const hash of required) if (!blobs.has(hash)) throw Error();
    const candidates = [...blobs.values()].filter(b => !required.has(b.hash) && !conservative.has(b.hash)).sort((a, b) => a.hash.localeCompare(b.hash));
    const candidateBytes = candidates.reduce((n, b) => n + b.bytes, 0);
    if (!Number.isSafeInteger(candidateBytes)) throw Error();
    return { candidates, plan: { schemaVersion: 1, projectId: q.projectId,
      planHash: digest(JSON.stringify({ root: q.captureRoot, projectId: q.projectId, snapshot })),
      candidates: candidates.map(({ hash, bytes }) => ({ hash, bytes })), candidateBytes,
      protectedBlobCount: blobs.size - candidates.length, deletionAuthorized: false } };
  } catch { throw fail('orphan_gc_inventory_invalid'); }
}
export function inspectOrphanBlobs(value: any) {
  const q = request(value), lease = acquireProjectWriteLease(q.captureRoot, q.projectId);
  try { return scan(q).plan; } finally { lease.release(); }
}
export function collectOrphanBlobs(value: any, options: any) {
  if (!exact(options, ['confirmed', 'expected']) || options.confirmed !== true || !hex(options.expected)) throw fail('orphan_gc_invalid');
  const q = request(value), lease = acquireProjectWriteLease(q.captureRoot, q.projectId);
  let deletedBlobCount = 0, reclaimedBytes = 0;
  try {
    const current = scan(q);
    if (current.plan.planHash !== options.expected) throw fail('orphan_gc_plan_changed');
    try {
      for (const blob of current.candidates) {
        const file = path.join(q.project, 'blobs', blob.hash.slice(0, 2), blob.hash);
        if (JSON.stringify(identity(fs.lstatSync(file))) !== JSON.stringify(blob.identity)) throw Error();
        fs.unlinkSync(file); deletedBlobCount++; reclaimedBytes += blob.bytes;
      }
    } catch { throw fail('orphan_gc_delete_failed', { deletedBlobCount, reclaimedBytes }); }
    // Logical bytes only; hardlinks/open fds/filesystem allocation may retain
    // physical storage. No atomic batch or crash receipt is claimed.
    return { planHash: current.plan.planHash, deletedBlobCount, reclaimedBytes };
  } finally {
    try { lease.release(); }
    catch { throw fail('orphan_gc_lock_release_failed', { deletedBlobCount, reclaimedBytes }); }
  }
}
