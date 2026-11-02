import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCaptureStore } from './capture-store';
import { createCheckpointRetentionStore } from './checkpoint-retention';
import { withProjectWriteLock } from './project-write-lock';
import { validateTrajectoryRequest, trajectoryFailureCodes } from './trajectory';
const fail = (code: string) => Object.assign(Error(code), { code });
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const MAX_BYTES = 64 * 1024;
export const sealFailureCodes = ['seal_quota_exceeded', 'seal_record_invalid', 'seal_conflict', 'seal_write_failed',
  'capture_usage_unavailable', 'capture_writer_busy', 'retention_blob_missing', 'retention_blob_corrupt', 'retention_blob_unreadable',
  'retention_contains_secret', 'retention_checkpoint_unavailable', 'retention_checkpoint_mismatch', 'retention_manifest_invalid',
  'retention_record_invalid', 'retention_conflict', 'retention_write_failed', 'retention_record_too_large', 'seal_reference_missing'];
export function validateSealRequest(request: any) {
  if (!request || typeof request.captureRoot !== 'string' || !path.isAbsolute(request.captureRoot) || request.captureRoot.includes('\0')) throw fail('seal_record_invalid');
  const association = validateTrajectoryRequest(request).association;
  const flagId = `flag-${hash(`${association.projectId}\0${association.messageId}`)}`;
  if (request.flagId !== flagId) throw fail('seal_conflict');
  return { captureRoot: request.captureRoot, association, flagId };
}
function location(root: string, association: any) {
  return path.join(root, 'projects', association.projectId, 'cases', `${hash(association.messageId)}.json`);
}
function validateRecord(record: any, association: any, flagId: string) {
  if (!record || record.schemaVersion !== 1 || record.kind !== 'badcase-sealed-case' || record.caseId !== `case-${flagId.slice(5)}`
    || record.flagId !== flagId || record.referenceId !== flagId || !record.association
    || Object.keys(record.association).length !== 8 || Object.entries(association).some(([k, v]) => record.association[k] !== v)
    || record.state !== 'saved_incomplete' || record.checkpointSaved !== true || record.complete !== false
    || ['captured', 'runnable', 'reproduced', 'evaluable', 'strictEvalEligible'].some(k => record[k] !== false)
    || typeof record.savedAt !== 'string' || !Number.isFinite(Date.parse(record.savedAt))
    || JSON.stringify(record.missingEvidence) !== JSON.stringify(missingEvidence)
    || Object.keys(record).some(k => !['schemaVersion', 'kind', 'caseId', 'flagId', 'referenceId', 'association', 'state', 'checkpointSaved', 'complete', 'captured', 'runnable', 'reproduced', 'evaluable', 'strictEvalEligible', 'savedAt', 'missingEvidence', 'trajectory'].includes(k))) throw fail('seal_record_invalid');
  if (JSON.stringify(trajectorySummary(record.trajectory)) !== JSON.stringify(record.trajectory)) throw fail('seal_record_invalid');
  return record;
}
const missingEvidence = ['trajectory_content_not_archived', 'checkpoint_input_completeness_not_certified', 'environment_not_pinned', 'no_independent_consistency_evidence'];
// Only fixed codes and counts survive. No output, error text, event payload,
// path, prompt, or private ancestry is copied. A successful reader is not proof
// that arbitrary tool text has authorized provenance.
export function trajectorySummary(value: any) {
  if (value?.reason === 'trajectory_provenance_unverified') {
    if (![value.totalTaskEventCount, value.selectedEventCount].every(n => Number.isSafeInteger(n) && n >= 0)
      || value.selectedEventCount > value.totalTaskEventCount) throw fail('seal_record_invalid');
    return { archived: false, reason: 'trajectory_provenance_unverified', totalTaskEventCount: value.totalTaskEventCount, selectedEventCount: value.selectedEventCount };
  }
  const reason = trajectoryFailureCodes.includes(value?.reason) ? value.reason : 'trajectory_unavailable';
  return { archived: false, reason };
}
export function readSealedCase(request: any): any {
  const { captureRoot, association, flagId } = validateSealRequest(request);
  const target = location(captureRoot, association);
  let fd: number;
  try {
    if (!fs.lstatSync(target).isFile()) throw fail('seal_record_invalid');
    fd = fs.openSync(target, 'r');
  } catch (e: any) { if (e.code === 'ENOENT') return null; throw fail('seal_record_invalid'); }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw Error();
    const bytes = fs.readFileSync(fd);
    if (bytes.length > MAX_BYTES) throw Error();
    const envelope = JSON.parse(bytes.toString('utf8'));
    if (envelope.schemaVersion !== 1 || envelope.checksum !== hash(JSON.stringify(envelope.record))) throw Error();
    return validateRecord(envelope.record, association, flagId);
  } catch { throw fail('seal_record_invalid'); }
  finally { fs.closeSync(fd); }
}
export function saveSealedCase(request: any) {
  const { captureRoot, association, flagId } = validateSealRequest(request);
  return withProjectWriteLock(captureRoot, association.projectId, () => {
    const store = createCaptureStore({ captureRoot });
    const retentionInput = { projectId: association.projectId, checkpointId: association.checkpointId,
      conversationId: association.conversationId, turnId: association.turnId, agentId: association.agentId, referenceId: flagId };
    const existing = readSealedCase(request);
    if (existing) {
      const retention = createCheckpointRetentionStore({ captureStore: store });
      if (!retention.get(retentionInput)) throw fail('seal_reference_missing');
      retention.retain(retentionInput); // Revalidate every blob on an explicit retry.
      return existing;
    }
    const record = { schemaVersion: 1, kind: 'badcase-sealed-case', caseId: `case-${flagId.slice(5)}`, flagId,
      referenceId: flagId, association, state: 'saved_incomplete', checkpointSaved: true, complete: false,
      captured: false, runnable: false, reproduced: false, evaluable: false, strictEvalEligible: false,
      savedAt: new Date().toISOString(), missingEvidence, trajectory: trajectorySummary(request.trajectory) };
    const serialized = JSON.stringify(record);
    const bytes = `${JSON.stringify({ schemaVersion: 1, checksum: hash(serialized), record })}\n`;
    const size = Buffer.byteLength(bytes);
    if (size > MAX_BYTES) throw fail('seal_record_invalid');
    const capacity = (additional: number) => {
      const quota = store.loadPolicy(association.projectId).stagingQuotaBytes;
      const usage = store.computeUsage(association.projectId).totalBytes;
      if (!Number.isSafeInteger(quota) || !Number.isSafeInteger(usage + additional + size) || usage + additional + size > quota) throw fail('seal_quota_exceeded');
    };
    // Reserve final record + exact retention bytes under the shared synchronous
    // writer lock. Physical disk exhaustion still fails explicitly at write.
    capacity(0);
    createCheckpointRetentionStore({ captureStore: store, beforePublish: capacity }).retain(retentionInput);
    capacity(0);
    const target = location(captureRoot, association), temp = `${target}.tmp-${crypto.randomUUID()}`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.linkSync(temp, target);
    } catch { throw fail('seal_write_failed'); }
    finally { try { fs.unlinkSync(temp); } catch {} }
    return readSealedCase(request);
  });
}
