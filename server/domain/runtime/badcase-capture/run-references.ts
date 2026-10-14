import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCheckpointRetentionStore } from './checkpoint-retention';
import { withProjectWriteLock } from './project-write-lock';
import { containsSecretSentinel } from './secrets';
// Durable, conservative run protection only. Not a launcher, process lease or
// deletion authorization. No TTL/PID-based release and no completion/unpin API.
// Call from a trusted file worker, before launch; never accept HTTP associations.
const fail = (code: string) => Object.assign(Error(code), { code });
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const fields = ['projectId', 'replayRunId', 'referenceId', 'checkpointId', 'conversationId', 'turnId', 'agentId'];
const MAX_BYTES = 16 * 1024 * 1024;
const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
function id(v: any): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v)) throw fail('run_reference_invalid_input');
  return v;
}
function scope(v: any) {
  if (!object(v) || Object.keys(v).some(k => !fields.includes(k))) throw fail('run_reference_invalid_input');
  const result = Object.fromEntries(fields.map(k => [k, id(v[k])]));
  if (containsSecretSentinel(JSON.stringify(result))) throw fail('run_reference_contains_secret');
  return result;
}
export function createReplayRunReferenceStore(options: any) {
  const store = options?.captureStore;
  if (!store || typeof store.captureRoot !== 'string' || !path.isAbsolute(store.captureRoot)) throw fail('run_reference_invalid_input');
  const retention = createCheckpointRetentionStore({ captureStore: store });
  const directory = (projectId: string) => path.join(store.captureRoot, 'projects', id(projectId), 'runReferences');
  const filename = (runId: string) => `${hash(id(runId))}.json`;
  function checkDirectory(projectId: string) {
    try { if (!fs.lstatSync(directory(projectId)).isDirectory()) throw Error(); }
    catch (e: any) { if (e.code === 'ENOENT') return false; throw fail('run_reference_record_invalid'); }
    return true;
  }
  function source(input: any) {
    const { replayRunId, ...retainedScope } = scope(input);
    const record = retention.get(retainedScope);
    if (!record) throw fail('run_reference_source_missing');
    return { record, retainedScope };
  }
  function validate(record: any, projectId: string, name: string) {
    if (!object(record) || Object.keys(record).some(k => ![...fields, 'schemaVersion', 'kind', 'createdAt', 'checkpointChecksum', 'blobHashes'].includes(k))
      || record.schemaVersion !== 1 || record.kind !== 'replay-run-reference' || record.projectId !== projectId
      || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) throw fail('run_reference_record_invalid');
    const input = Object.fromEntries(fields.map(k => [k, record[k]]));
    scope(input);
    if (filename(record.replayRunId) !== name) throw fail('run_reference_record_invalid');
    const retained = source(input).record;
    if (record.checkpointChecksum !== hash(JSON.stringify(retained.checkpoint))
      || JSON.stringify(record.blobHashes) !== JSON.stringify(retained.blobHashes)) throw fail('run_reference_record_invalid');
    return record;
  }
  function read(projectId: string, name: string): any {
    if (!checkDirectory(projectId)) return null;
    const target = path.join(directory(projectId), name);
    let fd: number;
    try {
      if (!fs.lstatSync(target).isFile()) throw Error();
      fd = fs.openSync(target, 'r');
    } catch (e: any) { if (e.code === 'ENOENT') return null; throw fail('run_reference_record_invalid'); }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw Error();
      const bytes = fs.readFileSync(fd);
      if (bytes.length > MAX_BYTES) throw Error();
      const envelope = JSON.parse(bytes.toString('utf8'));
      if (!object(envelope) || Object.keys(envelope).length !== 3 || envelope.schemaVersion !== 1
        || envelope.checksum !== hash(JSON.stringify(envelope.record))) throw Error();
      return validate(envelope.record, projectId, name);
    } catch { throw fail('run_reference_record_invalid'); }
    finally { fs.closeSync(fd); }
  }
  function existing(input: any) {
    const record = read(input.projectId, filename(input.replayRunId));
    if (record && fields.some(k => record[k] !== input[k])) throw fail('run_reference_conflict');
    return record;
  }
  return {
    // Read-only historical protection, not a current blob integrity certificate.
    get(input: any) { return existing(scope(input)); },
    protect(input: any) {
      input = scope(input);
      return withProjectWriteLock(store.captureRoot, input.projectId, () => {
        const previous = existing(input);
        const retained = source(input);
        // Never create a missing source from the mutable live checkpoint. Retry
        // validates the original retained closure, including every CAS blob.
        retention.retain(retained.retainedScope);
        if (previous) return { created: false, reference: previous };
        const record = { schemaVersion: 1, kind: 'replay-run-reference', ...input,
          createdAt: new Date().toISOString(), checkpointChecksum: hash(JSON.stringify(retained.record.checkpoint)),
          blobHashes: retained.record.blobHashes };
        const bytes = `${JSON.stringify({ schemaVersion: 1, checksum: hash(JSON.stringify(record)), record })}\n`;
        const size = Buffer.byteLength(bytes);
        if (size > MAX_BYTES) throw fail('run_reference_record_too_large');
        const usage = store.computeUsage(input.projectId).totalBytes;
        const quota = store.loadPolicy(input.projectId).stagingQuotaBytes;
        if (!Number.isSafeInteger(quota) || !Number.isSafeInteger(usage + size) || usage + size > quota) throw fail('run_reference_quota_exceeded');
        const target = path.join(directory(input.projectId), filename(input.replayRunId));
        const temp = `${target}.tmp-${crypto.randomUUID()}`;
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          checkDirectory(input.projectId);
          const fd = fs.openSync(temp, 'wx', 0o600);
          try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          fs.linkSync(temp, target); // Cooperation is serialized; unexpected EEXIST fails closed.
        } catch { throw fail('run_reference_write_failed'); }
        finally { try { fs.unlinkSync(temp); } catch {} }
        const persisted = existing(input);
        if (!persisted) throw fail('run_reference_write_failed');
        return { created: true, reference: persisted };
      });
    },
    // Inventory is deliberately NOT safe to feed a deletion loop: later
    // publications can race a read. Future GC must own the shared writer lock.
    protectedObjects(projectId: string) {
      id(projectId);
      const checkpointIds = new Set<string>(), blobHashes = new Set<string>();
      let names: string[] = [];
      if (checkDirectory(projectId)) {
        try { names = fs.readdirSync(directory(projectId)); }
        catch { throw fail('run_reference_inventory_unavailable'); }
      }
      for (const name of names) {
        if (/^[a-f0-9]{64}\.json\.tmp-/.test(name)) throw fail('run_reference_inventory_busy');
        if (!/^[a-f0-9]{64}\.json$/.test(name)) throw fail('run_reference_record_invalid');
        const record = read(projectId, name);
        if (!record) throw fail('run_reference_record_invalid');
        checkpointIds.add(record.checkpointId);
        for (const blob of record.blobHashes) blobHashes.add(blob);
      }
      return { checkpointIds: [...checkpointIds].sort(), blobHashes: [...blobHashes].sort(), referenceCount: names.length, deletionAuthorized: false };
    },
  };
}
