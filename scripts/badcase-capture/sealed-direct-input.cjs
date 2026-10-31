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
const { locateGlobalPromptTarget } = require('../../build/lib/agent-prompt-targets');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const ensure = value => { if (!value) throw Error('unsupported'); };
const empty = v => Array.isArray(v) && v.length === 0;
function prepareTurn(request, candidateRole, promptTarget) {
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
    let commonPrompt, variantInfo, identityInfo;
    if (promptTarget) {
      // Global harness text is independent of the actor/persona/roleSpan. Only
      // an exact declared fragment from the archive is editable; no current
      // prompt/config is substituted when an old archive lacks this fragment.
      const target = locateGlobalPromptTarget(prompt, promptTarget.id), replacement = promptTarget.replacement;
      commonPrompt = prompt.slice(0, target.start) + '{{GLOBAL_PROMPT_TARGET}}' + prompt.slice(target.end);
      if (replacement !== null) {
        ensure(typeof replacement === 'string' && replacement.trim() && Buffer.byteLength(replacement) <= 65536
          && !replacement.includes('{{') && !containsSecretSentinel(replacement));
        prompt = prompt.slice(0, target.start) + replacement + prompt.slice(target.end);
      }
      variantInfo = { target, baseText: target.baseText };
      identityInfo = { targetId: target.id, originalTargetHash: target.baseHash };
    } else {
      const span = r.roleSpan;
      ensure(span && Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) && span.start >= 0 && span.end > span.start && span.end <= prompt.length);
      const originalRole = prompt.slice(span.start, span.end);
      // Legacy custom personas keep their wrapper. The selected GPT family has
      // no persona, so use only its actually archived Rules section instead.
      const rolePrefix = originalRole.startsWith('Your private persona instructions:\n') ? 'Your private persona instructions:\n'
        : association.agentId === 'role-family-gpt' && originalRole.startsWith('Rules:\n') ? 'Rules:\n' : null;
      ensure(rolePrefix && originalRole.slice(rolePrefix.length).trim() && hash(originalRole) === span.sha256
        && !originalRole.includes('{{') && prompt.indexOf(originalRole) === span.start && prompt.indexOf(originalRole, span.start + 1) === -1);
      commonPrompt = prompt.slice(0, span.start) + '{{ROLE_VARIANT}}' + prompt.slice(span.end);
      if (candidateRole !== null) {
        ensure(typeof candidateRole === 'string' && candidateRole.trim() && Buffer.byteLength(candidateRole) <= 65536
          && !candidateRole.includes('{{') && !containsSecretSentinel(candidateRole));
        prompt = prompt.slice(0, span.start) + rolePrefix + candidateRole + prompt.slice(span.end);
      }
      variantInfo = { originalRole: originalRole.slice(rolePrefix.length) };
      identityInfo = { originalRoleHash: span.sha256 };
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
    return { supported: true, input, ...variantInfo,
      provenance: { caseId: sealed.caseId, checkpointId: cp.checkpointId,
      checkpointHash: hash(JSON.stringify(cp)), ...identityInfo,
      commonInputHash: hash(JSON.stringify({ ...input, prompt: commonPrompt })),
      variant: (promptTarget ? promptTarget.replacement === null : candidateRole === null) ? 'original' : 'candidate', strictEvalEligible: false } };
  } catch { return { supported: false, reason: promptTarget ? 'unsupported_or_missing_declared_prompt_target' : 'unsupported_or_missing_replay_materials' }; }
}
function prepareSealedDirectTurn(request, candidateRole = null) { return prepareTurn(request, candidateRole, null); }
function prepareSealedPromptTarget(request, targetId, replacement = null) { return prepareTurn(request, null, { id: targetId, replacement }); }
module.exports = { prepareSealedDirectTurn, prepareSealedPromptTarget };
