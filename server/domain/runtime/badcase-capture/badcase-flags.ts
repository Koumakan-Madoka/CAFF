import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { containsSecretSentinel } from './secrets';
import { validateTrajectoryRequest } from './trajectory';

// Marker persistence only. This is NOT a sealing implementation: no files,
// prompt, message content or trajectory are copied, and no replay status is
// inferred from a user report or the presence of a checkpoint manifest.
// The eventual seal/GC transaction must protect references before GC is enabled.
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const error = (code: string) => Object.assign(new Error(code), { code });
const MAX_RECORD_BYTES = 64 * 1024;

function identifier(value: any): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw error('flag_invalid_identifier');
  return value;
}
function annotation(value: any): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value, 'utf8') > 8192) {
    throw error('flag_invalid_annotation');
  }
  if (containsSecretSentinel(value)) throw error('flag_contains_secret');
  return value; // Preserve user text, not a lossy display projection.
}

export function createBadcaseFlagService(options: any) {
  if (!options || typeof options.captureRoot !== 'string' || !options.captureRoot.trim()) throw error('flag_root_required');
  const captureRoot = path.resolve(options.captureRoot);
  const chatStore = options.chatStore;
  const captureStore = options.captureStore;
  const ids = (input: any) => ({ projectId: identifier(input?.projectId), conversationId: identifier(input?.conversationId), messageId: identifier(input?.messageId) });
  const filePath = (scope: any) => path.join(captureRoot, 'projects', scope.projectId, 'flags', `${hash(scope.messageId)}.json`);

  function source(scope: any) {
    const conversation = chatStore.getConversationWithoutMessages(scope.conversationId);
    if (!conversation || (conversation.projectScopeId || conversation.projectId) !== scope.projectId) throw error('flag_message_not_found');
    const message = chatStore.getMessage(scope.messageId);
    if (!message || message.id !== scope.messageId || message.conversationId !== scope.conversationId) throw error('flag_message_not_found');
    if (message.role !== 'assistant') throw error('flag_assistant_required');
    if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(message.status)) throw error('flag_message_not_terminal');
    return message;
  }

  // Freeze the complete identity at first mark, never reconstruct missing
  // original keys from a later, mutable message. This is association evidence
  // only: the trajectory reader and retention layer must still verify sources.
  function sealAssociation(scope: any, message: any) {
    try {
      return validateTrajectoryRequest({ association: {
        ...scope, turnId: message.turnId, agentId: message.agentId, taskId: message.taskId,
        checkpointId: message.metadata?.badcaseCheckpointId, runId: message.runId,
      } }).association;
    } catch { return null; }
  }

  function load(scope: any): any {
    let bytes: Buffer;
    try {
      // Read via one descriptor so a rename cannot switch the size/read object.
      const fd = fs.openSync(filePath(scope), 'r');
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw error('flag_record_invalid');
        bytes = fs.readFileSync(fd);
      } finally { fs.closeSync(fd); }
    } catch (failure: any) {
      if (failure.code === 'ENOENT') return null;
      throw error('flag_record_invalid');
    }
    try {
      const envelope = JSON.parse(bytes.toString('utf8'));
      const record = envelope.record;
      if (bytes.length > MAX_RECORD_BYTES || envelope.schemaVersion !== 1 || !record
        || envelope.checksum !== hash(JSON.stringify(record)) || record.schemaVersion !== 1
        || record.projectId !== scope.projectId || record.conversationId !== scope.conversationId || record.messageId !== scope.messageId
        || record.flagId !== `flag-${hash(`${scope.projectId}\0${scope.messageId}`)}`
        || typeof record.actual !== 'string' || typeof record.expected !== 'string'
        || record.sealState !== 'pending' || record.captured !== false || record.runnable !== false
        || record.reproduced !== false || record.evaluable !== false) throw error('flag_record_invalid');
      // Optional schema-v1 extension: legacy records remain readable, but their
      // missing association is never backfilled. Explicit null means the first
      // mark did not have all required keys. A present malformed value is damage.
      if (record.sealAssociation !== undefined && record.sealAssociation !== null) {
        const frozen = validateTrajectoryRequest({ association: record.sealAssociation }).association;
        if (['projectId', 'conversationId', 'messageId', 'checkpointId', 'runId']
          .some(key => frozen[key] !== record[key])) throw error('flag_record_invalid');
      }
      return record;
    } catch { throw error('flag_record_invalid'); }
  }
  function sameAnnotation(existing: any, actual: string, expected: string) {
    if (existing.actual !== actual || existing.expected !== expected) throw error('flag_already_exists');
    return { created: false, flag: existing };
  }

  return {
    get(input: any) {
      const scope = ids(input);
      source(scope);
      return load(scope);
    },
    // Internal read-only gate for future sealing; not an authorization to
    // archive arbitrary tool text. HTTP/agent callers cannot supply identity.
    resolveSealAssociation(input: any) {
      const scope = ids(input);
      const message = source(scope);
      const record = load(scope);
      if (!record) throw error('flag_not_found');
      if (!record.sealAssociation) throw error('flag_seal_association_incomplete');
      const current = sealAssociation(scope, message);
      if (!current || Object.entries(record.sealAssociation).some(([key, value]) => current[key] !== value)) {
        throw error('flag_seal_association_mismatch');
      }
      return { ...record.sealAssociation };
    },
    mark(input: any) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['projectId', 'conversationId', 'messageId', 'actual', 'expected'].includes(key))) {
        throw error('flag_unknown_field');
      }
      const scope = ids(input);
      const actual = annotation(input.actual), expected = annotation(input.expected);
      const message = source(scope);
      const existing = load(scope);
      // Frozen at first mark: retries do not silently change run/checkpoint IDs
      // when messages or manifests subsequently change or become unavailable.
      if (existing) return sameAnnotation(existing, actual, expected);
      const checkpointId = message.metadata?.badcaseCheckpointId ? identifier(message.metadata.badcaseCheckpointId) : null;
      const runId = message.runId ?? null;
      if (runId !== null && (typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId <= 0)) throw error('flag_invalid_run_id');
      let checkpointState = 'not_recorded';
      if (checkpointId) {
        let checkpoint: any = null;
        try { checkpoint = captureStore?.loadCheckpoint(scope.projectId, checkpointId); }
        catch { /* Unreadable evidence must not prevent a user reporting a badcase. */ }
        checkpointState = checkpoint ? 'manifest_present_unverified' : 'missing_or_unreadable';
        if (checkpoint) {
          // Still reject mismatches in every known field; missing legacy turn/
          // agent metadata is not proof of a match and must never permit sealing.
          if (checkpoint.checkpointId !== checkpointId || checkpoint.projectId !== scope.projectId
            || checkpoint.conversationId !== scope.conversationId
            || (message.turnId && checkpoint.turnId !== message.turnId)
            || (message.agentId && checkpoint.agentId !== message.agentId)) throw error('flag_checkpoint_mismatch');
          if (!message.turnId || !message.agentId) checkpointState = 'association_incomplete';
        }
      }
      const record = {
        schemaVersion: 1,
        flagId: `flag-${hash(`${scope.projectId}\0${scope.messageId}`)}`,
        ...scope, runId, checkpointId, checkpointState, actual, expected,
        sealAssociation: sealAssociation(scope, message),
        createdAt: new Date().toISOString(),
        sealState: 'pending', captured: false, runnable: false, reproduced: false, evaluable: false,
        missingEvidence: ['checkpoint_not_sealed', 'trajectory_not_archived', ...(checkpointState === 'manifest_present_unverified' ? [] : ['checkpoint_unavailable'])],
      };
      const serialized = JSON.stringify(record);
      if (containsSecretSentinel(serialized)) throw error('flag_contains_secret');
      const bytes = `${JSON.stringify({ schemaVersion: 1, checksum: hash(serialized), record })}\n`;
      if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES) throw error('flag_record_too_large');
      const target = filePath(scope), temp = `${target}.tmp-${crypto.randomUUID()}`;
      let created = false;
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const fd = fs.openSync(temp, 'wx', 0o600);
        try { fs.writeFileSync(fd, bytes, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        // Atomic no-replace publication. Concurrent identical requests converge
        // on one complete record; a different annotation cannot overwrite it.
        // Filesystems without hardlink support fail explicitly, never fall back
        // to a rename that could overwrite another writer's confirmed record.
        try { fs.linkSync(temp, target); created = true; }
        catch (failure: any) { if (failure.code !== 'EEXIST') throw failure; }
      } catch { throw error('flag_write_failed'); }
      finally { try { fs.unlinkSync(temp); } catch {} }
      const persisted = load(scope);
      if (!persisted) throw error('flag_write_failed');
      if (!created) return sameAnnotation(persisted, actual, expected);
      return { created: true, flag: persisted };
    },
  };
}
