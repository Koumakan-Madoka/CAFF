// Pure DATA planner: a complete retained capsule -> explicit callback input.
// No filesystem, live Room, DB, environment, credentials, SDK or launch here.
import { decodeInitializationCapsule } from './capsule-materialization';
import { readCapturedCallbackInput } from './callback-input';
import { prepareEvaluationCallbackTrace } from './evaluation-trace';

export function planRetainedEvaluationCallback(capsule: any, expected: any, association: any) {
  // Complete closed blob set, original checkpoint checksum and ALL supported
  // callback fields are revalidated before returning any start parameters.
  const decoded = decodeInitializationCapsule(capsule, expected);
  const cp = JSON.parse(decoded.files.find(f => f.path === 'materials/checkpoint.json')!.bytes.toString('utf8'));
  const byPath = new Map(decoded.files.map(f => [f.path, f.bytes]));
  const callback = readCapturedCallbackInput(cp, h => byPath.get('materials/blobs/' + h));
  prepareEvaluationCallbackTrace(callback.trace, callback.expectedTraceHash, association); // independent caller association, all six keys
  return { callbackInput: { trace: callback.trace, expectedTraceHash: callback.expectedTraceHash, association: { ...callback.association } },
    receipt: { kind: 'retained-evaluation-callback-input-plan-v1', capsuleHash: expected.capsuleHash,
      checkpointChecksum: expected.checkpointChecksum, callbackInputHash: callback.expectedTraceHash,
      association: { ...callback.association }, deliveryMode: cp.replayInput.deliveryMode,
      publicMessageCount: callback.receipt.publicMessageCount, participantCount: callback.receipt.participantCount,
      launchAuthorized: false, runnable: false, faithfulReplay: false, strictEvalEligible: false } };
}
