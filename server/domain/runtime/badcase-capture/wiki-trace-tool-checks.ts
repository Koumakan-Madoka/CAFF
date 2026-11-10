// Trace checks consume executed callback records or native session-event args.
// Deliberately independent of the run-level bash parser: an opaque shell command
// is neither evidence of a CAFF call nor evidence that the call did not happen.
import { validateEvaluationGoalEvidence } from './evaluation-goal-evidence';
import { validateWikiToolCheck, type WikiToolCheck } from './wiki-tool-check';
import { evaluateWikiToolObservations, type WikiToolObservation, type WikiToolCheckResult } from './wiki-tool-rule-result';
const endpoints: Record<string, string> = {
  'read-context': 'context', 'list-participants': 'participants', 'send-public': 'post-message',
  'suggest-goal': 'goal/suggest', 'update-goal': 'goal/update',
};
const unavailable = (): WikiToolCheckResult => ({ status: 'invalid', reason: 'tool_evidence_unavailable' });
const object = (v: any) => v && Object.getPrototypeOf(v) === Object.prototype;
function callbackObservation(call: any, endpoint: string): WikiToolObservation {
  if (call.endpoint !== endpoint) return { kind: 'other' };
  if (call.redacted === true) return { kind: 'unknown' };
  const parameters = call.parameters;
  if (endpoint === 'post-message' && parameters.visibility !== 'public') return { kind: 'other' };
  // Only explicit bridge aliases. No shell flags/stdin/file/JavaScript inference.
  // Values are the parsed HTTP values, even for rejected calls. Keep canonical
  // API names too; do not invent flags which never reached the callback.
  const aliases: Record<string, unknown> = {};
  for (const [apiName, flag] of [['publicLimit', 'public-limit'], ['privateLimit', 'private-limit'], ['noFinalize', 'no-finalize']]) {
    if (Object.hasOwn(parameters, apiName)) aliases[flag] = parameters[apiName];
  }
  return { kind: 'target', parameters: { ...parameters, ...aliases } };
}
export function checkWikiTraceTools(receipt: any, configured?: WikiToolCheck | null): WikiToolCheckResult {
  if (!configured) return { status: 'unconfigured', reason: null };
  const check = validateWikiToolCheck(configured);
  let calls: WikiToolObservation[];
  if (check.target.kind === 'caff-chat') {
    if (!Object.hasOwn(endpoints, check.target.name) || receipt?.goalEvidence === undefined) return unavailable();
    // A present but corrupt ledger is an integrity error, never a guessed result
    // or a fallback to command text. The existing validator binds every record
    // to its execution and checks sequence, seed hash and error serialization.
    const evidence = validateEvaluationGoalEvidence(receipt.goalEvidence);
    calls = evidence.calls.map((call: any) => callbackObservation(call, endpoints[check.target.name]));
  } else {
    if (!Array.isArray(receipt?.toolCalls)) return unavailable();
    calls = receipt.toolCalls.map((call: any): WikiToolObservation => {
      if (!call || typeof call.name !== 'string' || typeof call.isError !== 'boolean') return { kind: 'unknown' };
      if (call.name !== check.target.name) return { kind: 'other' };
      return object(call.args) ? { kind: 'target', parameters: call.args } : { kind: 'unknown' };
    });
  }
  return evaluateWikiToolObservations(calls, check);
}
