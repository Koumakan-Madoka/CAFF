// Pure planning for a deliberately narrower SDK INITIALIZATION DIAGNOSTIC.
// Not replay permission: invocation is never submitted, system prompt is diagnostic.
// Caller must prepare/protect under the writer lock; consumer revalidates all bytes.
import crypto from 'node:crypto';
import { decodeInitializationCapsule } from './capsule-materialization';
const hash = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const fail = () => Object.assign(Error('sdk_diagnostic_unsupported'), { code: 'sdk_diagnostic_unsupported' });
const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: any, keys: string[]) => object(v) && Object.keys(v).sort().join('|') === keys.sort().join('|');
const empty = (v: any) => Array.isArray(v) && v.length === 0;
const text = (v: any) => typeof v === 'string' && v.trim().length > 0;
export function planRetainedSdkDiagnostic(capsule: string, expected: any) {
  const decoded = decodeInitializationCapsule(capsule, expected);
  const cp = JSON.parse(decoded.files.find(f => f.path === 'materials/checkpoint.json')!.bytes.toString());
  const r = cp.replayInput, config = r.runConfig;
  const read = (h: string) => {
    const b = decoded.files.find(f => f.path === 'materials/blobs/' + h)?.bytes;
    if (!b) throw fail();
    const s = b.toString('utf8');
    if (s.includes('\0') || !Buffer.from(s).equals(b)) throw fail();
    return s;
  };
  if (!object(config) || !['provider', 'model', 'promptVersion'].every(k => text(config[k]))
    || !empty(config.skillIds) || !empty(config.conversationSkillIds) || !empty(r.harness.skillSnapshots)
    || !empty(r.controlledReplacements) || !empty(r.unverifiedDimensions) || r.invocationImageCount !== 0
    || (r.secretExcludedPaths !== undefined && !empty(r.secretExcludedPaths))) throw fail();
  let harness: any;
  try { harness = JSON.parse(read(r.harness.configSnapshotHash)); } catch { throw fail(); }
  if (!exact(harness, ['piVersion', 'agentPromptVersion', 'toolBridgeEnabled', 'deliveryMode', 'agentName'])
    || !['0.85.1', 'pi:0.85.1'].includes(harness.piVersion) || harness.agentPromptVersion !== config.promptVersion
    || harness.deliveryMode !== r.deliveryMode || harness.toolBridgeEnabled !== false || !text(harness.agentName)) throw fail();
  const invocation = read(r.promptBlobHash);
  // No replacement/path semantics implemented. Even undeclared placeholders fail.
  if (/\{\{[^{}]+\}\}/.test(invocation)) throw fail();
  let sessionText: string | null = null, sessionId: string | null = null;
  const messages: any[] = [];
  let hasThinkingOff = false, leafId: string | null = null;
  if (r.deliveryMode === 'resume') {
    sessionText = read(r.sessionBlobHash);
    if (!sessionText.endsWith('\n')) throw fail();
    let entries: any[];
    try { entries = sessionText.split('\n').filter(s => s.trim()).map(s => JSON.parse(s)); } catch { throw fail(); }
    const header = entries[0];
    if (!exact(header, ['type', 'version', 'id', 'timestamp', 'cwd']) || header.type !== 'session' || header.version !== 3
      || !text(header.id) || !text(header.timestamp) || !text(header.cwd)) throw fail();
    sessionId = header.id;
    const ids = new Set([header.id]); let parent: string | null = null;
    for (const e of entries.slice(1)) {
      if (!object(e) || !text(e.id) || ids.has(e.id) || e.parentId !== parent || !text(e.timestamp)) throw fail();
      if (e.type === 'thinking_level_change') {
        if (!exact(e, ['type', 'id', 'parentId', 'timestamp', 'thinkingLevel']) || e.thinkingLevel !== 'off') throw fail();
        hasThinkingOff = true;
      } else if (e.type === 'message') {
        if (!exact(e, ['type', 'id', 'parentId', 'timestamp', 'message'])
          || !exact(e.message, ['role', 'content', 'timestamp']) || e.message.role !== 'user'
          || typeof e.message.content !== 'string' || !Number.isFinite(e.message.timestamp)) throw fail();
        messages.push(e.message);
      } else throw fail(); // no branch, compaction, tools, model changes or private extension state
      ids.add(e.id); parent = e.id;
    }
    if (/\{\{[^{}]+\}\}/.test(sessionText)) throw fail();
    leafId = parent;
  }
  return { mode: r.deliveryMode, invocation, sessionText, sessionId, messages, hasThinkingOff, leafId,
    provider: config.provider, model: config.model, materialized: decoded.receipt };
}
// The SDK may append its explicit thinking setting to a WORKING session copy.
// Original archive bytes must remain untouched; permit exactly this known append.
export function verifyDiagnosticSessionCopy(plan: ReturnType<typeof planRetainedSdkDiagnostic>, actual: string) {
  if (plan.mode !== 'resume' || plan.sessionText === null) throw fail();
  if (plan.hasThinkingOff) { if (actual !== plan.sessionText) throw fail(); return; }
  if (!actual.startsWith(plan.sessionText)) throw fail();
  let extra: any;
  try { extra = JSON.parse(actual.slice(plan.sessionText.length)); } catch { throw fail(); }
  if (!exact(extra, ['type', 'id', 'parentId', 'timestamp', 'thinkingLevel'])
    || extra.type !== 'thinking_level_change' || extra.thinkingLevel !== 'off' || extra.parentId !== plan.leafId
    || !text(extra.id) || !text(extra.timestamp)) throw fail();
}
// Expected receipt only; NOT proof that an SDK was run. Host validates transport
// against this expectation; container MUST use observedDiagnosticReceipt instead.
export function diagnosticReceipt(plan: ReturnType<typeof planRetainedSdkDiagnostic>) {
  return receipt(plan, plan.mode === 'resume' ? true : null,
    plan.mode === 'resume' ? !plan.hasThinkingOff : false, true);
}
// Observations are raw readings from the container after SDK initialization, NOT
// booleans copied from the plan. This is validation, not independent attestation:
// the archived container harness and host scheduler remain trusted code.
export function observedDiagnosticReceipt(plan: ReturnType<typeof planRetainedSdkDiagnostic>, observations: any) {
  if (!exact(observations, ['archivedSessionBytes', 'workingSessionBytes', 'missingSessionId', 'missingEntries', 'missingMessages'])
    || !text(observations.missingSessionId) || !empty(observations.missingEntries) || !empty(observations.missingMessages)) throw fail();
  let archivedUnchanged: boolean | null = null, appendedOff = false;
  if (plan.mode === 'resume') {
    if (!Buffer.isBuffer(observations.archivedSessionBytes) || !Buffer.isBuffer(observations.workingSessionBytes)
      || plan.sessionText === null) throw fail();
    archivedUnchanged = observations.archivedSessionBytes.equals(Buffer.from(plan.sessionText));
    if (!archivedUnchanged) throw fail();
    const workingText = observations.workingSessionBytes.toString('utf8');
    if (!Buffer.from(workingText).equals(observations.workingSessionBytes)) throw fail();
    verifyDiagnosticSessionCopy(plan, workingText);
    // Preceding archive/copy checks already determine this value. The observation
    // makes the derivation explicit; it is NOT an independent integrity guarantee.
    appendedOff = !observations.workingSessionBytes.equals(observations.archivedSessionBytes);
  } else if (observations.archivedSessionBytes !== null || observations.workingSessionBytes !== null) throw fail();
  return receipt(plan, archivedUnchanged, appendedOff,
    observations.missingEntries.length === 0 && observations.missingMessages.length === 0 && text(observations.missingSessionId));
}
function receipt(plan: ReturnType<typeof planRetainedSdkDiagnostic>, archivedUnchanged: boolean | null,
  appendedOff: boolean, missingOpenEmpty: boolean) {
  return { kind: 'retained-sdk-initialization-diagnostic', sessionObservationVersion: 1, deliveryMode: plan.mode,
    capsuleHash: plan.materialized.capsuleHash, checkpointChecksum: plan.materialized.checkpointChecksum,
    materializedHash: plan.materialized.materializedHash, invocationHash: hash(plan.invocation),
    historyHash: hash(JSON.stringify(plan.messages)), historyMessages: plan.messages.length,
    archivedSessionBytesUnchanged: archivedUnchanged,
    workingSessionAppendedThinkingOff: appendedOff,
    provider: plan.provider, model: plan.model,
    sdkInitialized: true, diagnosticSystemPrompt: true, missingOpenCreatesEmptySession: missingOpenEmpty,
    invocationSubmitted: false, modelCalls: 0, networkCalls: 0,
    runnable: false, reproduced: false, evaluable: false, strictEvalEligible: false };
}
