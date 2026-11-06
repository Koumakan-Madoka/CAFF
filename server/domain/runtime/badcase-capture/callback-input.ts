// Credential-free callback INPUT archive channel. Trusted memory inputs only:
// no DB/Inspector discovery, authorization, source path reads or callback launch.
// Supplying a hash is integrity, NOT consent or proof of pre-turn provenance.
import crypto from 'node:crypto';
import { SYSTEM_MODEL_FAMILY_ROLES } from '../../roles/system-role-catalog';
import { prepareEvaluationCallbackTrace, validateCallbackOmissions, callbackOmissionCounts } from './evaluation-trace';
const fail = (code: string) => Object.assign(Error(code), { code });
const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: any, keys: string[]) => object(v) && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
const associationKeys = ['projectId', 'conversationId', 'turnId', 'agentId', 'userMessageId', 'assistantMessageId'];
const scopeKeys = associationKeys.slice(0, 4);
const id = (v: any) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);

/** Legacy input remains exact/all-or-nothing. An explicitly knownOnly v2
 * projection carries its own omission counts; never call it complete history.
 * Known-literal replacement and rehashing belong to replay-input-preparation.
 */
export function prepareCapturedCallbackInput(input: any, options: any = {}) {
  const packet = input?.callbackInput;
  if (!exact(packet, ['trace', 'expectedTraceHash'])) throw fail('callback_input_unavailable');
  // The expected association comes from the trusted invocation, NOT the trace.
  const association = Object.fromEntries(associationKeys.map(k => [k, input[k]]));
  const prepared = prepareEvaluationCallbackTrace(packet.trace, packet.expectedTraceHash, association);
  const bestEffort = prepared.trace.schemaVersion === 2;
  if (bestEffort && options.knownOnly !== true) throw fail('callback_input_unavailable');
  const content = Buffer.alloc(Buffer.byteLength(packet.trace));
  content.write(packet.trace, 'utf8'); // exact independent non-pooled backing
  return { reference: { schemaVersion: bestEffort ? 2 : 1, kind: bestEffort ? 'caff-evaluation-callback-input-reference-v2' : 'caff-evaluation-callback-input-reference-v1',
    blobHash: prepared.receipt.traceHash, association: { ...association },
    ...(bestEffort ? { omissions: { ...prepared.trace.omissions } } : {}) }, content };
}

/** Isolated callback plumbing, NOT recovered room history. A conspicuous
 * placeholder lets public output/context tools work even for already-captured
 * v2 scenes with no room record. No live source/DB/identity discovery. */
export function unavailableCallbackInputV2(checkpoint: any, assistantMessageId: string, agentName: string) {
  if (checkpoint?.schemaVersion !== 2) throw fail('callback_input_invalid');
  const family = SYSTEM_MODEL_FAMILY_ROLES.find(p => p.id === checkpoint.agentId);
  if (checkpoint.agentId.startsWith('role-family-') && (!family || family.name !== agentName)) throw fail('callback_input_invalid');
  const association = { ...Object.fromEntries(scopeKeys.map(k => [k, checkpoint[k]])),
    userMessageId: 'replay-unavailable-user', assistantMessageId };
  const omissions = { ...Object.fromEntries(callbackOmissionCounts.map(k => [k, 0])), roomHistoryUnavailable: true };
  const trace = JSON.stringify({ schemaVersion: 2, kind: 'caff-evaluation-callback-input-v2', association,
    assistantCreatedAt: '2000-01-01T00:00:01.000Z', conversation: { title: 'Replay: room record unavailable', type: 'standard', metadata: { replayRoomRecordUnavailable: true } },
    participants: [{ id: checkpoint.agentId, name: agentName, description: family?.description || '' }], publicMessages: [{
      id: association.userMessageId, turnId: checkpoint.turnId, role: 'user', agentId: null, senderName: 'Replay notice',
      content: '[Replay notice: archived room history is unavailable. This is an isolated placeholder, not an original user message. Use the separately archived execution prompt.]',
      status: 'completed', createdAt: '2000-01-01T00:00:00.000Z', publicPostedAt: '', publicPostCount: 0, publicPostMode: '', mentions: [],
    }], privateMessages: [], pendingDelegations: [], omissions });
  const expectedTraceHash = crypto.createHash('sha256').update(trace).digest('hex');
  prepareEvaluationCallbackTrace(trace, expectedTraceHash, association);
  return { trace, expectedTraceHash, association };
}

// Validate metadata only. Shared by CAS closure enumeration and byte readers so
// malformed/unknown references cannot disappear from retention or publication.
export function validateCallbackInputReference(reference: any, checkpoint: any) {
  const bestEffort = checkpoint?.schemaVersion === 2 && reference?.schemaVersion === 2 && reference?.kind === 'caff-evaluation-callback-input-reference-v2';
  if (bestEffort) validateCallbackOmissions(reference.omissions);
  if (!exact(reference, ['schemaVersion', 'kind', 'blobHash', 'association', ...(bestEffort ? ['omissions'] : [])])
    || !bestEffort && (reference.schemaVersion !== 1 || reference.kind !== 'caff-evaluation-callback-input-reference-v1')
    || typeof reference.blobHash !== 'string' || !/^[a-f0-9]{64}$/.test(reference.blobHash)
    || !exact(reference.association, associationKeys) || !associationKeys.every(k => id(reference.association[k]))) throw fail('callback_input_invalid');
  if (!scopeKeys.every(k => checkpoint?.[k] === reference.association[k])) throw fail('callback_input_association_mismatch');
  return reference;
}

/** Revalidate the actual referenced UTF-8 bytes, not a historical complete flag.
 * readBlob is a trusted scoped in-memory/CAS accessor, never a source file path.
 */
export function readCapturedCallbackInput(checkpoint: any, readBlob: (hash: string) => any) {
  if (!object(checkpoint?.replayInput) || !Object.hasOwn(checkpoint.replayInput, 'callbackInput')) throw fail('callback_input_missing');
  const ref = validateCallbackInputReference(checkpoint.replayInput.callbackInput, checkpoint);
  const bytes = readBlob(ref.blobHash);
  if (!Buffer.isBuffer(bytes) || bytes.length > 4 * 1024 * 1024) throw fail('callback_input_invalid');
  const trace = bytes.toString('utf8');
  if (!Buffer.from(trace).equals(bytes)) throw fail('callback_input_invalid');
  const prepared = prepareEvaluationCallbackTrace(trace, ref.blobHash, ref.association);
  if (prepared.trace.schemaVersion !== ref.schemaVersion || ref.schemaVersion === 2
    && ![...callbackOmissionCounts, 'roomHistoryUnavailable'].every(k => ref.omissions[k] === prepared.trace.omissions[k])) throw fail('callback_input_invalid');
  return { trace, expectedTraceHash: ref.blobHash, association: { ...ref.association }, receipt: prepared.receipt };
}
