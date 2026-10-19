// Credential-free callback INPUT archive channel. Trusted memory inputs only:
// no DB/Inspector discovery, authorization, source path reads or callback launch.
// Supplying a hash is integrity, NOT consent or proof of pre-turn provenance.
import { prepareEvaluationCallbackTrace } from './evaluation-trace';
const fail = (code: string) => Object.assign(Error(code), { code });
const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: any, keys: string[]) => object(v) && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
const associationKeys = ['projectId', 'conversationId', 'turnId', 'agentId', 'userMessageId', 'assistantMessageId'];
const scopeKeys = associationKeys.slice(0, 4);
const id = (v: any) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);

/** Caller must independently authorize the whole supplied public-text state.
 * No controlled replacement/sanitization: unsupported/secret state is refused
 * wholesale. Never archive a partial projection and call it the original input.
 */
export function prepareCapturedCallbackInput(input: any) {
  const packet = input?.callbackInput;
  if (!exact(packet, ['trace', 'expectedTraceHash'])) throw fail('callback_input_unavailable');
  // The expected association comes from the trusted invocation, NOT the trace.
  const association = Object.fromEntries(associationKeys.map(k => [k, input[k]]));
  const prepared = prepareEvaluationCallbackTrace(packet.trace, packet.expectedTraceHash, association);
  const content = Buffer.alloc(Buffer.byteLength(packet.trace));
  content.write(packet.trace, 'utf8'); // exact independent non-pooled backing
  return { reference: { schemaVersion: 1, kind: 'caff-evaluation-callback-input-reference-v1',
    blobHash: prepared.receipt.traceHash, association: { ...association } }, content };
}

// Validate metadata only. Shared by CAS closure enumeration and byte readers so
// malformed/unknown references cannot disappear from retention or publication.
export function validateCallbackInputReference(reference: any, checkpoint: any) {
  if (!exact(reference, ['schemaVersion', 'kind', 'blobHash', 'association']) || reference.schemaVersion !== 1
    || reference.kind !== 'caff-evaluation-callback-input-reference-v1'
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
  return { trace, expectedTraceHash: ref.blobHash, association: { ...ref.association }, receipt: prepared.receipt };
}
