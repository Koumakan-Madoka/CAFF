// Read-only, trusted offline inspection. NOT a launcher, lease or authorization.
// Recheck retained input bytes rather than trusting historical complete=true.
// No SDK import, session-path traversal, Docker, model call, pin or write here.
import crypto from 'node:crypto';
import { createCaptureStore } from './capture-store';
import { createCheckpointRetentionStore } from './checkpoint-retention';
import { readSealedCase, validateSealRequest } from './sealed-case';
import { containsSecretSentinel, listControlledReplayVariables } from './secrets';
import { PI_VERSION_PIN, validateSessionV2 } from './session-validator';
import { readCapturedCallbackInput } from './callback-input';
const fail = (code: string) => Object.assign(Error(code), { code });
const hash = (v: string | Buffer) => crypto.createHash('sha256').update(v).digest('hex');
const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: any) => typeof v === 'string' && v.trim().length > 0;
const empty = (v: any) => Array.isArray(v) && v.length === 0;
const digest = (v: any) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const LIMIT = 16 * 1024 * 1024;

export function inspectRetainedReplayInputs(input: any) {
  if (!object(input) || Object.keys(input).sort().join('|') !== 'association|captureRoot|flagId') throw fail('replay_input_invalid');
  const { captureRoot, association, flagId } = validateSealRequest(input);
  const sealed = readSealedCase({ captureRoot, association, flagId });
  if (!sealed) throw fail('replay_case_missing');
  const store = createCaptureStore({ captureRoot });
  const retained = createCheckpointRetentionStore({ captureStore: store }).get({
    projectId: association.projectId, checkpointId: association.checkpointId, conversationId: association.conversationId,
    turnId: association.turnId, agentId: association.agentId, referenceId: sealed.referenceId,
  });
  if (!retained) throw fail('replay_source_missing');
  const cp = retained.checkpoint, r = cp.replayInput;
  // get verifies the schema/closure/checksum, not current bytes or secrecy.
  if (containsSecretSentinel(JSON.stringify(cp))) throw fail('replay_contains_secret');
  if (!object(r) || !['fresh', 'resume'].includes(r.deliveryMode)) throw fail('replay_mode_invalid');
  if (r.complete !== true || !empty(r.incompleteReasons) || !empty(r.unverifiedDimensions)
    || !Array.isArray(r.verifiedDimensions) || !r.verifiedDimensions.every((v: any) => typeof v === 'string')
    || r.invocationImageCount !== 0 || (cp.uncaptured !== undefined && !empty(cp.uncaptured))
    || (r.secretExcludedPaths !== undefined && !empty(r.secretExcludedPaths))
    || Object.values(cp.files).some((f: any) => f.secretExcluded === true || f.type !== 'file')) throw fail('replay_inputs_incomplete');
  if (!digest(r.promptBlobHash)) throw fail('replay_prompt_missing');
  if (r.normalizedPromptHash !== r.promptBlobHash) throw fail('replay_prompt_invalid');
  if (r.deliveryMode === 'resume' && !digest(r.sessionBlobHash)) throw fail('replay_session_missing');
  if (r.deliveryMode === 'fresh' && r.sessionBlobHash !== '') throw fail('replay_mode_conflict');
  const config = r.runConfig, harness = r.harness;
  if (!object(config) || !['provider', 'model', 'promptVersion'].every(k => text(config[k]))) throw fail('replay_config_invalid');
  if (!object(harness) || !text(harness.serverVersion) || !digest(harness.configSnapshotHash)) throw fail('replay_harness_missing');

  // Only this call's in-memory byte set is verified. GC is currently disabled;
  // a future launcher must re-read/verify AND protect under its writer lock.
  // A digest-only result is deliberately not a launchable bundle or permit.
  const blobs = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const h of retained.blobHashes) {
    let b: Buffer | null;
    try { b = store.readBlob(association.projectId, h); } catch { throw fail('replay_blob_unreadable'); }
    if (!Buffer.isBuffer(b)) throw fail('replay_blob_missing');
    totalBytes += b.length;
    if (totalBytes > LIMIT) throw fail('replay_size_limit');
    if (hash(b) !== h) throw fail('replay_blob_corrupt');
    if (containsSecretSentinel(b)) throw fail('replay_contains_secret');
    blobs.set(h, b);
  }
  function utf8(h: string) {
    const b = blobs.get(h);
    if (!b) throw fail('replay_blob_missing');
    const s = b.toString('utf8');
    if (s.includes('\0') || !Buffer.from(s).equals(b)) throw fail('replay_text_invalid');
    return s;
  }
  let callbackInputHash = '';
  if (Object.hasOwn(r, 'callbackInput')) {
    const callback = readCapturedCallbackInput(cp, h => blobs.get(h));
    if (callback.association.assistantMessageId !== association.messageId) throw fail('callback_input_association_mismatch');
    callbackInputHash = callback.expectedTraceHash;
  }
  const prompt = utf8(r.promptBlobHash);
  let snapshot: any;
  try { snapshot = JSON.parse(utf8(harness.configSnapshotHash)); }
  catch (e: any) { if (e.code === 'replay_text_invalid') throw e; throw fail('replay_harness_invalid'); }
  if (!object(snapshot) || !text(snapshot.piVersion) || snapshot.piVersion.replace(/^pi:/, '') !== PI_VERSION_PIN
    || snapshot.deliveryMode !== r.deliveryMode || snapshot.agentPromptVersion !== config.promptVersion
    || typeof snapshot.toolBridgeEnabled !== 'boolean' || typeof snapshot.agentName !== 'string') throw fail('replay_harness_invalid');
  const declared = new Set<string>();
  for (const ids of [config.skillIds, config.conversationSkillIds]) {
    if (!Array.isArray(ids) || !ids.every(text)) throw fail('replay_skills_invalid');
    for (const id of ids) declared.add(id);
  }
  if (!Array.isArray(harness.skillSnapshots)) throw fail('replay_skills_invalid');
  const archived = new Set<string>();
  for (const s of harness.skillSnapshots) {
    if (!object(s) || !text(s.id) || !text(s.source) || archived.has(s.id) || !declared.has(s.id)
      || !digest(s.blobHash) || s.sha256 !== s.blobHash) throw fail('replay_skills_invalid');
    utf8(s.blobHash); // Empty skill content is valid, but must be present/hash-verified.
    archived.add(s.id);
  }
  if (archived.size !== declared.size) throw fail('replay_skills_invalid');
  let session = '', sessionDimensions: string[] = [];
  if (r.deliveryMode === 'resume') {
    session = utf8(r.sessionBlobHash);
    // Do not interpret historical host paths using this inspector's OS, nor
    // pretend a path remapping exists. Until that contract is implemented,
    // even known file-tool dependencies are conservatively unverified.
    const checked = validateSessionV2(session, { authorizedRoot: '', historyContext: true });
    if (!checked.ok) throw fail('replay_session_invalid');
    if (checked.unverifiedDimensions.length) throw fail('replay_session_dependencies_unverified');
    sessionDimensions = checked.verifiedDimensions;
  }
  const allowed = listControlledReplayVariables(), replacements = new Map<string, number>();
  if (!Array.isArray(r.controlledReplacements)) throw fail('replay_replacements_invalid');
  for (const item of r.controlledReplacements) {
    if (!object(item) || Object.keys(item).sort().join('|') !== 'count|name' || !allowed.includes(item.name)
      || !Number.isSafeInteger(item.count) || item.count < 1) throw fail('replay_replacements_invalid');
    const count = (replacements.get(item.name) || 0) + item.count;
    if (!Number.isSafeInteger(count)) throw fail('replay_replacements_invalid');
    replacements.set(item.name, count);
  }
  for (const name of allowed) {
    const marker = '{{' + name + '}}';
    const actual = prompt.split(marker).length - 1 + session.split(marker).length - 1;
    if (actual !== (replacements.get(name) || 0)) throw fail('replay_replacements_invalid');
  }
  return { schemaVersion: 1, kind: 'retained-replay-input-inspection',
    checkpointChecksum: hash(JSON.stringify(cp)), deliveryMode: r.deliveryMode,
    promptBlobHash: r.promptBlobHash, sessionBlobHash: r.sessionBlobHash, configSnapshotHash: harness.configSnapshotHash,
    runConfigHash: hash(JSON.stringify(config)), skillInventoryHash: hash(JSON.stringify(harness.skillSnapshots)),
    ...(callbackInputHash ? { callbackInputHash } : {}),
    piVersion: PI_VERSION_PIN, blobCount: blobs.size, totalBlobBytes: totalBytes, sessionDimensions,
    requiredReplacements: [...replacements].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, count]) => ({ name, count })),
    inputMaterialsVerified: true, launchAuthorized: false, runnable: false, reproduced: false, evaluable: false, strictEvalEligible: false };
}
