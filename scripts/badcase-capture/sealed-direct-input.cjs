// Trusted host preparation for the deliberately small portable MVP subset.
// Never executes archived code, reads old source paths, fabricates a session,
// or rewrites a sealed archive. Historical strict-eval certificates are NOT
// required by this MVP; missing runtime/role/input material still fails closed.
const crypto = require('node:crypto');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { createCaptureStore } = require(base + 'capture-store');
const { createCheckpointRetentionStore } = require(base + 'checkpoint-retention');
const { readSealedCase, validateSealRequest } = require(base + 'sealed-case');
const { readCapturedCallbackInput } = require(base + 'callback-input');
const { containsSecretSentinel } = require(base + 'secrets');
const { validateDirectBindings } = require('./direct-model.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const ensure = value => { if (!value) throw Error('unsupported'); };
const empty = v => Array.isArray(v) && v.length === 0;
function prepareSealedDirectTurn(request, candidateRole = null) {
  try {
    const { captureRoot, association, flagId } = validateSealRequest(structuredClone(request));
    const sealed = readSealedCase({ captureRoot, association, flagId }); ensure(sealed);
    const store = createCaptureStore({ captureRoot });
    const scope = Object.fromEntries(['projectId', 'checkpointId', 'conversationId', 'turnId', 'agentId'].map(k => [k, association[k]]));
    const retained = createCheckpointRetentionStore({ captureStore: store }).get({ ...scope, referenceId: sealed.referenceId });
    ensure(retained);
    const cp = retained.checkpoint, r = cp.replayInput;
    ensure(r && r.deliveryMode === 'fresh' && r.sessionBlobHash === '' && r.invocationImageCount === 0);
    ensure(empty(r.unverifiedDimensions) && (cp.uncaptured === undefined || empty(cp.uncaptured))
      && (r.secretExcludedPaths === undefined || empty(r.secretExcludedPaths)));
    // Windows' blanket subset marker includes non-goals (ACLs/concurrency/etc).
    // Only the explicitly declared portable/default-resource subset is allowed;
    // this does NOT set old complete/strict flags to true or repair old cases.
    ensure(r.complete === true && empty(r.incompleteReasons) || r.complete === false
      && r.incompleteReasons?.length === 1 && r.incompleteReasons[0] === 'windows_capture_subset_unverified');
    let bytes = 0; const blobs = new Map();
    ensure(retained.blobHashes.length <= 8192);
    for (const digest of retained.blobHashes) {
      const b = store.readBlob(association.projectId, digest); ensure(Buffer.isBuffer(b) && hash(b) === digest && !containsSecretSentinel(b));
      bytes += b.length; ensure(bytes <= 4 * 1024 * 1024); blobs.set(digest, b);
    }
    const utf8 = digest => { const b = blobs.get(digest); ensure(b); const s = b.toString('utf8'); ensure(Buffer.from(s).equals(b) && !s.includes('\0')); return s; };
    const snapshot = JSON.parse(utf8(r.harness.configSnapshotHash)), config = snapshot.sdkStartConfig;
    ensure(snapshot.portableRuntime?.kind === 'portable-default-resources-v1' && snapshot.portableRuntime.schemaVersion === 1 && snapshot.portableRuntime.supported === true);
    ensure(['0.85.1', 'pi:0.85.1'].includes(snapshot.piVersion) && snapshot.deliveryMode === 'fresh'
      && snapshot.agentPromptVersion === r.runConfig.promptVersion && snapshot.toolBridgeEnabled === true);
    ensure(config && config.resume === false && config.thinking === 'off' && config.fast !== true && config.retireUserScopeSkills === true
      && config.cwd === cp.targetDir && config.provider === r.runConfig.provider && config.model === r.runConfig.model);
    ensure(empty(r.runConfig.skillIds) && empty(r.runConfig.conversationSkillIds) && empty(r.harness.skillSnapshots));
    let prompt = utf8(r.promptBlobHash); ensure(r.normalizedPromptHash === r.promptBlobHash);
    const span = r.roleSpan;
    ensure(span && Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) && span.start >= 0 && span.end > span.start && span.end <= prompt.length);
    const originalRole = prompt.slice(span.start, span.end);
    ensure(hash(originalRole) === span.sha256 && originalRole.startsWith('Your private persona instructions:\n')
      && !originalRole.includes('{{') && prompt.indexOf(originalRole) === span.start && prompt.indexOf(originalRole, span.start + 1) === -1);
    const commonPrompt = prompt.slice(0, span.start) + '{{ROLE_VARIANT}}' + prompt.slice(span.end);
    if (candidateRole !== null) {
      ensure(typeof candidateRole === 'string' && candidateRole.trim() && Buffer.byteLength(candidateRole) <= 65536
        && !candidateRole.includes('{{') && !containsSecretSentinel(candidateRole));
      prompt = prompt.slice(0, span.start) + 'Your private persona instructions:\n' + candidateRole + prompt.slice(span.end);
    }
    ensure(Buffer.byteLength(prompt) <= 131072);
    const names = Object.keys(cp.files); ensure(names.length <= 1024);
    const files = names.sort().map(name => {
      const f = cp.files[name], b = blobs.get(f.hash);
      ensure(/^[A-Za-z0-9_.@/-]+$/.test(name) && name.split('/').every(p => p && p !== '.' && p !== '..' && p !== '.git')
        && f.type === 'file' && !f.secretExcluded && b && b.length === f.size);
      return { path: name, base64: b.toString('base64'), sha256: f.hash };
    });
    ensure(Array.isArray(cp.deletions) && cp.deletions.every(d => !names.some(n => n === d || n.startsWith(d + '/') || d.startsWith(n + '/'))));
    const capturedCallback = readCapturedCallbackInput(cp, digest => blobs.get(digest));
    ensure(capturedCallback.association.assistantMessageId === association.messageId);
    const callback = Object.fromEntries(['trace', 'expectedTraceHash', 'association'].map(k => [k, capturedCallback[k]]));
    const input = { kind: 'prepared-caff-turn-v1', prompt, files, deletions: [...cp.deletions], sessionText: null, systemPrompt: null, settings: null, callback,
      bindings: { sourceRoot: cp.targetDir, controlledReplacements: r.controlledReplacements } };
    validateDirectBindings(input.prompt, input.bindings);
    return { supported: true, input, originalRole: originalRole.slice('Your private persona instructions:\n'.length),
      provenance: { caseId: sealed.caseId, checkpointId: cp.checkpointId,
      checkpointHash: hash(JSON.stringify(cp)), originalRoleHash: span.sha256,
      commonInputHash: hash(JSON.stringify({ ...input, prompt: commonPrompt })),
      variant: candidateRole === null ? 'original' : 'candidate', strictEvalEligible: false } };
  } catch { return { supported: false, reason: 'unsupported_or_missing_replay_materials' }; }
}
module.exports = { prepareSealedDirectTurn };
