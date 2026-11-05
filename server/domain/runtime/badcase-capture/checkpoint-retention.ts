import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { containsSecretSentinel } from './secrets';
import { readCapturedCallbackInput, validateCallbackInputReference } from './callback-input';

// Internal retention primitive, NOT a SealedCase or a GC transaction. Only a
// trusted caller may provide the server-derived association. No HTTP/agent tool
// exposes this API. It freezes a manifest and enumerates its schema-v1 CAS
// closure. Production sealing invokes this in a file worker under the shared
// writer lock with capacity checks. Direct callers must supply those guards;
// trajectory archival, running references and a writer/GC transaction remain
// unimplemented. This primitive does not authorize automatic GC.
const fail = (code: string) => Object.assign(new Error(code), { code });
const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const associationKeys = ['projectId', 'checkpointId', 'conversationId', 'turnId', 'agentId'] as const;
const inputKeys = [...associationKeys, 'referenceId'];
const object = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
function id(value: any): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw fail('retention_invalid_input');
  return value;
}
function scope(input: any) {
  if (!object(input) || Object.keys(input).some(key => !inputKeys.includes(key as any))) throw fail('retention_invalid_input');
  return Object.fromEntries(inputKeys.map(key => [key, id(input[key])]));
}

// A future schema carrying new reference types must extend this reader before
// it can be retained. Missing input material is preserved as missing, not
// synthesized and not silently changed from resume to fresh.
export function checkpointBlobHashes(checkpoint: any): string[] {
  const invalid = () => { throw fail('retention_manifest_invalid'); };
  if (!object(checkpoint) || ![1, 2].includes(checkpoint.schemaVersion) || !object(checkpoint.files)
    || !object(checkpoint.replayInput)) invalid();
  const hashes = new Set<string>();
  const add = (value: any, optional = false) => {
    if (optional && (value === undefined || value === '')) return;
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid();
    hashes.add(value);
  };
  for (const entry of Object.values(checkpoint.files) as any[]) {
    if (!object(entry) || !['file', 'symlink'].includes(entry.type)) invalid();
    if (entry.type === 'file' && entry.secretExcluded !== true) add(entry.hash);
    else if (entry.hash !== undefined && entry.hash !== '') invalid();
  }
  if (checkpoint.schemaVersion === 2) {
    const git = checkpoint.gitSnapshot;
    if (!object(git) || git.kind !== 'git-snapshot-v1' || typeof git.head !== 'string' || !/^[a-f0-9]{40,64}$/.test(git.head)
      || typeof git.sourceRepository !== 'string' || !Array.isArray(git.projectSkills)) invalid();
    add(git.patchBlobHash);
    for (const root of git.projectSkills) {
      if (!object(root) || typeof root.originalPath !== 'string' || !object(root.files)) invalid();
      for (const file of Object.values(root.files) as any[]) {
        if (!object(file) || file.type !== 'file') invalid();
        add(file.hash);
      }
    }
  }
  const replay = checkpoint.replayInput;
  if (!['fresh', 'resume'].includes(replay.deliveryMode) || typeof replay.complete !== 'boolean'
    || !Array.isArray(replay.incompleteReasons) || !replay.incompleteReasons.every((reason: any) => typeof reason === 'string')
    || !object(replay.harness) || !Array.isArray(replay.harness.skillSnapshots)) invalid();
  add(replay.promptBlobHash, true);
  add(replay.sessionBlobHash, true);
  add(replay.harness.configSnapshotHash, true);
  if (Object.hasOwn(replay, 'callbackInput')) {
    try { add(validateCallbackInputReference(replay.callbackInput, checkpoint).blobHash); }
    catch { invalid(); }
  }
  for (const skill of replay.harness.skillSnapshots) {
    if (!object(skill) || skill.sha256 !== skill.blobHash) invalid();
    add(skill.blobHash);
  }
  return [...hashes].sort();
}

export function createCheckpointRetentionStore(options: any) {
  const store = options?.captureStore;
  if (!store || typeof store.captureRoot !== 'string' || !store.captureRoot.trim()) throw fail('retention_invalid_input');
  const root = path.resolve(store.captureRoot);
  const directory = (projectId: string) => path.join(root, 'projects', id(projectId), 'retention');
  const filename = (referenceId: string) => `${hash(id(referenceId))}.json`;
  const filePath = (input: any) => path.join(directory(input.projectId), filename(input.referenceId));
  function match(record: any, input: any) {
    if (inputKeys.some(key => record[key] !== input[key])) throw fail('retention_conflict');
  }
  function validate(record: any, projectId: string, name: string) {
    if (!object(record) || record.schemaVersion !== 1 || record.kind !== 'checkpoint-retention'
      || Object.keys(record).some(key => ![...inputKeys, 'schemaVersion', 'kind', 'createdAt', 'checkpoint', 'blobHashes'].includes(key))
      || record.projectId !== projectId || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) throw fail('retention_record_invalid');
    for (const key of inputKeys) id(record[key]);
    if (filename(record.referenceId) !== name || associationKeys.some(key => record.checkpoint?.[key] !== record[key])
      || JSON.stringify(checkpointBlobHashes(record.checkpoint)) !== JSON.stringify(record.blobHashes)) throw fail('retention_record_invalid');
    return record;
  }
  function read(projectId: string, name: string): { record: any; bytes: number } | null {
    let fd: number;
    const target = path.join(directory(projectId), name);
    try {
      // Storage is same-user trusted TCB, as with flags. Reject static links and
      // special files but do not claim an openat2 boundary against path swaps.
      if (!fs.lstatSync(target).isFile()) throw fail('retention_record_invalid');
      fd = fs.openSync(target, 'r');
    } catch (error: any) {
      if (error.code === 'ENOENT') return null;
      throw fail('retention_record_invalid');
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw fail('retention_record_invalid');
      const bytes = fs.readFileSync(fd);
      if (bytes.length > MAX_RECORD_BYTES) throw fail('retention_record_invalid');
      const envelope = JSON.parse(bytes.toString('utf8'));
      if (envelope.schemaVersion !== 1 || envelope.checksum !== hash(JSON.stringify(envelope.record))) throw fail('retention_record_invalid');
      return { record: validate(envelope.record, projectId, name), bytes: bytes.length };
    } catch { throw fail('retention_record_invalid'); }
    finally { fs.closeSync(fd); }
  }
  function existing(input: any) {
    const found = read(input.projectId, filename(input.referenceId));
    if (found) match(found.record, input);
    return found?.record || null;
  }
  function verifyBlobs(projectId: string, blobHashes: string[], checkpoint: any) {
    if (!object(checkpoint?.replayInput)) throw fail('retention_manifest_invalid');
    const callbackHash = checkpoint.replayInput.callbackInput?.blobHash;
    let callbackBytes: Buffer | undefined;
    for (const blobHash of blobHashes) {
      let content: Buffer | null;
      try { content = store.readBlob(projectId, blobHash); }
      catch { throw fail('retention_blob_unreadable'); }
      if (!Buffer.isBuffer(content)) throw fail('retention_blob_missing');
      if (hash(content) !== blobHash) throw fail('retention_blob_corrupt');
      if (checkpoint.schemaVersion === 1 && containsSecretSentinel(content)) throw fail('retention_contains_secret');
      if (blobHash === callbackHash) callbackBytes = content;
    }
    if (Object.hasOwn(checkpoint.replayInput, 'callbackInput')) {
      try { readCapturedCallbackInput(checkpoint, h => h === callbackHash ? callbackBytes : undefined); }
      catch { throw fail('retention_manifest_invalid'); }
    }
  }
  return {
    get(input: any) { return existing(scope(input)); },
    retain(input: any) {
      input = scope(input);
      const previous = existing(input);
      if (previous) {
        verifyBlobs(input.projectId, previous.blobHashes, previous.checkpoint);
        return { created: false, reference: previous };
      }
      let checkpoint: any;
      try { checkpoint = store.loadCheckpoint(input.projectId, input.checkpointId); }
      catch { throw fail('retention_checkpoint_unavailable'); }
      if (!checkpoint) throw fail('retention_checkpoint_unavailable');
      // Detach before validating/archiving; source manifest mutations never
      // alter the retained copy, including deletion state and incomplete reasons.
      checkpoint = JSON.parse(JSON.stringify(checkpoint));
      if (associationKeys.some(key => checkpoint[key] !== input[key])) throw fail('retention_checkpoint_mismatch');
      const blobHashes = checkpointBlobHashes(checkpoint);
      const record = { schemaVersion: 1, kind: 'checkpoint-retention', ...input,
        createdAt: new Date().toISOString(), checkpoint, blobHashes };
      const serialized = JSON.stringify(record);
      if (checkpoint.schemaVersion === 1 && containsSecretSentinel(serialized)) throw fail('retention_contains_secret');
      const bytes = `${JSON.stringify({ schemaVersion: 1, checksum: hash(serialized), record })}\n`;
      if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES) throw fail('retention_record_too_large');
      // Verify every distinct referenced blob, not just existence or size. A
      // corrupt CAS hit must never become a successful new retained reference.
      verifyBlobs(input.projectId, blobHashes, checkpoint);
      // Internal sealing writer holds the project lock and reserves both this
      // reference and its final case record before either is published.
      options.beforePublish?.(Buffer.byteLength(bytes));
      const target = filePath(input), temp = `${target}.tmp-${crypto.randomUUID()}`;
      let created = false;
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const fd = fs.openSync(temp, 'wx', 0o600);
        try { fs.writeFileSync(fd, bytes, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        try { fs.linkSync(temp, target); created = true; }
        catch (error: any) { if (error.code !== 'EEXIST') throw error; }
      } catch { throw fail('retention_write_failed'); }
      finally { try { fs.unlinkSync(temp); } catch {} }
      const persisted = existing(input);
      if (!persisted) throw fail('retention_write_failed');
      // A concurrent same-association writer might have retained a different
      // live manifest. Verify the winner's closure, not only our losing plan.
      verifyBlobs(input.projectId, persisted.blobHashes, persisted.checkpoint);
      return { created, reference: persisted };
    },
    // Conservative inventory only, not a deletion authorization. Callers must
    // implement a shared writer/GC transaction first. Never skip damaged refs.
    protectedObjects(projectId: string) {
      const dir = directory(projectId);
      let names: string[];
      try { names = fs.readdirSync(dir); }
      catch (error: any) {
        if (error.code === 'ENOENT') names = [];
        else throw fail('retention_inventory_unavailable');
      }
      const checkpointIds = new Set<string>(), blobHashes = new Set<string>();
      let metadataBytes = 0;
      for (const name of names) {
        if (/^[a-f0-9]{64}\.json\.tmp-/.test(name)) throw fail('retention_inventory_busy');
        if (!/^[a-f0-9]{64}\.json$/.test(name)) throw fail('retention_record_invalid');
        const entry = read(projectId, name);
        if (!entry) throw fail('retention_record_invalid');
        checkpointIds.add(entry.record.checkpointId);
        for (const value of entry.record.blobHashes) blobHashes.add(value);
        metadataBytes += entry.bytes;
      }
      return { checkpointIds: [...checkpointIds].sort(), blobHashes: [...blobHashes].sort(), referenceCount: names.length, metadataBytes };
    },
  };
}
