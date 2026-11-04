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
const { supportsPortableThinking } = require(base + 'portable-inputs');
const { prepareProjectResources } = require(base + 'project-resources');
const { validateSessionV2 } = require(base + 'session-validator');
const { validateDirectBindings } = require('./direct-model.cjs');
const { locateGlobalPromptTarget } = require('../../build/lib/agent-prompt-targets');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const { hashJson } = require('./replay-streams.cjs');
const unsupported = reason => Object.assign(Error(reason), { replayReason: reason });
const ensure = (value, reason = 'replay_materials_invalid') => { if (!value) throw unsupported(reason); };
const checked = (reason, work) => { try { return work(); } catch { throw unsupported(reason); } };
const empty = v => Array.isArray(v) && v.length === 0;
function prepareTurn(request, candidateRole, promptTarget, originalOnly = false) {
  try {
    const { captureRoot, association, flagId } = checked('replay_seal_request_invalid', () => validateSealRequest(structuredClone(request)));
    const sealed = checked('replay_sealed_case_unavailable', () => readSealedCase({ captureRoot, association, flagId }));
    ensure(sealed, 'replay_sealed_case_unavailable');
    const store = checked('replay_checkpoint_unavailable', () => createCaptureStore({ captureRoot }));
    const scope = Object.fromEntries(['projectId', 'checkpointId', 'conversationId', 'turnId', 'agentId'].map(k => [k, association[k]]));
    const retained = checked('replay_checkpoint_unavailable', () => createCheckpointRetentionStore({ captureStore: store }).get({ ...scope, referenceId: sealed.referenceId }));
    ensure(retained, 'replay_checkpoint_unavailable');
    const cp = retained.checkpoint, r = cp.replayInput;
    ensure(r, 'replay_input_unavailable');
    ensure(['fresh', 'resume'].includes(r.deliveryMode), 'replay_delivery_mode_invalid');
    const resume = r.deliveryMode === 'resume';
    ensure(resume ? /^[a-f0-9]{64}$/.test(r.sessionBlobHash || '') : r.sessionBlobHash === '', resume ? 'replay_session_missing' : 'replay_fresh_session_not_empty');
    ensure(r.invocationImageCount === 0, 'replay_invocation_images_not_supported');
    ensure(empty(r.unverifiedDimensions), 'replay_unverified_dimensions');
    ensure(cp.uncaptured === undefined || empty(cp.uncaptured), 'replay_uncaptured_files');
    ensure(r.secretExcludedPaths === undefined || empty(r.secretExcludedPaths), 'replay_secret_excluded_files');
    // Windows' blanket subset marker includes non-goals (ACLs/concurrency/etc).
    // Only the explicitly declared portable/default-resource subset is allowed;
    // this does NOT set old complete/strict flags to true or repair old cases.
    ensure(r.complete === true && empty(r.incompleteReasons) || r.complete === false
      && r.incompleteReasons?.length === 1 && r.incompleteReasons[0] === 'windows_capture_subset_unverified', 'replay_capture_incomplete');
    const retainedHashes = new Set(retained.blobHashes);
    ensure(retained.blobHashes.length <= 8192, 'replay_blob_inventory_limit');
    for (const digest of retained.blobHashes) {
      const b = checked('replay_blob_unavailable_or_invalid', () => store.readBlob(association.projectId, digest));
      ensure(Buffer.isBuffer(b) && hash(b) === digest, 'replay_blob_unavailable_or_invalid');
      ensure(!containsSecretSentinel(b), 'replay_blob_secret_sentinel');
    }
    // Validate the inventory one blob at a time; do not retain a second copy of
    // the entire captured scene alongside its per-file transport representation.
    const blobs = { get(digest) { return retainedHashes.has(digest) ? checked('replay_blob_unavailable_or_invalid', () => store.readBlob(association.projectId, digest)) : undefined; } };
    const utf8 = digest => { const b = blobs.get(digest); ensure(b, 'replay_blob_unavailable_or_invalid'); const s = b.toString('utf8');
      ensure(Buffer.from(s).equals(b) && !s.includes('\0'), 'replay_blob_text_invalid'); return s; };
    const snapshot = checked('replay_runtime_snapshot_invalid', () => JSON.parse(utf8(r.harness?.configSnapshotHash))), config = snapshot.sdkStartConfig;
    const projectResources = snapshot.portableRuntime?.kind === 'portable-project-resources-v1';
    ensure((projectResources || snapshot.portableRuntime?.kind === 'portable-default-resources-v1')
      && snapshot.portableRuntime.schemaVersion === 1 && snapshot.portableRuntime.supported === true, 'replay_portable_runtime_not_supported');
    ensure(['0.85.1', 'pi:0.85.1'].includes(snapshot.piVersion), 'replay_sdk_version_not_supported');
    ensure(snapshot.deliveryMode === r.deliveryMode && snapshot.agentPromptVersion === r.runConfig?.promptVersion && snapshot.toolBridgeEnabled === true, 'replay_runtime_config_mismatch');
    ensure(config && config.resume === resume && config.retireUserScopeSkills === true && config.cwd === cp.targetDir
      && config.provider === r.runConfig.provider && config.model === r.runConfig.model, 'replay_runtime_config_mismatch');
    ensure(supportsPortableThinking(config), 'replay_recorded_thinking_not_supported');
    ensure(config.fast !== true, 'replay_fast_mode_not_supported');
    ensure(empty(r.runConfig.skillIds) && empty(r.runConfig.conversationSkillIds) && empty(r.harness.skillSnapshots), 'replay_skills_not_supported');
    let prompt = utf8(r.promptBlobHash); ensure(r.normalizedPromptHash === r.promptBlobHash, 'replay_prompt_hash_mismatch');
    let commonPrompt, variantInfo, identityInfo;
    if (originalOnly) {
      // No replacement is requested. Role/target anchors are edit permissions,
      // not requirements for faithfully retaining an unchanged archived prompt.
      commonPrompt = prompt; variantInfo = {}; identityInfo = {};
    } else if (promptTarget) {
      // Global harness text is independent of the actor/persona/roleSpan. Only
      // an exact declared fragment from the archive is editable; no current
      // prompt/config is substituted when an old archive lacks this fragment.
      const target = checked('replay_declared_prompt_target_missing_or_invalid', () => locateGlobalPromptTarget(prompt, promptTarget.id, promptTarget.fragments)), replacement = promptTarget.replacement;
      commonPrompt = prompt.slice(0, target.start) + '{{GLOBAL_PROMPT_TARGET}}' + prompt.slice(target.end);
      if (replacement !== null) {
        ensure(typeof replacement === 'string' && replacement.trim() && Buffer.byteLength(replacement) <= 65536
          && !replacement.includes('{{') && !containsSecretSentinel(replacement), 'replay_candidate_prompt_invalid');
        prompt = prompt.slice(0, target.start) + replacement + prompt.slice(target.end);
      }
      variantInfo = { target, baseText: target.baseText };
      identityInfo = { targetId: target.id, originalTargetHash: target.baseHash };
    } else {
      const span = r.roleSpan;
      ensure(span && Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) && span.start >= 0 && span.end > span.start && span.end <= prompt.length, 'replay_role_span_missing_or_invalid');
      const originalRole = prompt.slice(span.start, span.end);
      // Legacy custom personas keep their wrapper. The selected GPT family has
      // no persona, so use only its actually archived Rules section instead.
      const rolePrefix = originalRole.startsWith('Your private persona instructions:\n') ? 'Your private persona instructions:\n'
        : association.agentId === 'role-family-gpt' && originalRole.startsWith('Rules:\n') ? 'Rules:\n' : null;
      ensure(rolePrefix && originalRole.slice(rolePrefix.length).trim() && hash(originalRole) === span.sha256
        && !originalRole.includes('{{') && prompt.indexOf(originalRole) === span.start && prompt.indexOf(originalRole, span.start + 1) === -1, 'replay_role_span_content_invalid');
      commonPrompt = prompt.slice(0, span.start) + '{{ROLE_VARIANT}}' + prompt.slice(span.end);
      if (candidateRole !== null) {
        ensure(typeof candidateRole === 'string' && candidateRole.trim() && Buffer.byteLength(candidateRole) <= 65536
          && !candidateRole.includes('{{') && !containsSecretSentinel(candidateRole), 'replay_candidate_prompt_invalid');
        prompt = prompt.slice(0, span.start) + rolePrefix + candidateRole + prompt.slice(span.end);
      }
      variantInfo = { originalRole: originalRole.slice(rolePrefix.length) };
      identityInfo = { originalRoleHash: span.sha256 };
    }
    ensure(Buffer.byteLength(prompt) <= 256 * 1024, 'replay_prompt_size_limit');
    const names = Object.keys(cp.files); ensure(names.length <= 1024, 'replay_file_inventory_limit');
    const files = names.sort().map(name => {
      const f = cp.files[name], b = blobs.get(f.hash);
      ensure(/^[A-Za-z0-9_.@/-]+$/.test(name) && name.split('/').every(p => p && p !== '.' && p !== '..' && p !== '.git')
        && f.type === 'file' && !f.secretExcluded && b && b.length === f.size, 'replay_file_record_invalid');
      return { path: name, base64: b.toString('base64'), sha256: f.hash, mode: f.mode,
        ...(f.secretRedacted === true ? { secretRedacted: true } : {}) };
    });
    ensure(Array.isArray(cp.deletions) && cp.deletions.every(d => !names.some(n => n === d || n.startsWith(d + '/') || d.startsWith(n + '/'))), 'replay_deletions_invalid');
    const capturedCallback = checked('replay_callback_unavailable_or_invalid', () => readCapturedCallbackInput(cp, digest => blobs.get(digest)));
    ensure(capturedCallback.association.assistantMessageId === association.messageId, 'replay_callback_association_mismatch');
    const callback = Object.fromEntries(['trace', 'expectedTraceHash', 'association'].map(k => [k, capturedCallback[k]]));
    const recordedModelConfig = { provider: config.provider, model: config.model, thinking: config.thinking, fast: false };
    const sessionText = resume ? utf8(r.sessionBlobHash) : null;
    if (resume) {
      ensure(sessionText.endsWith('\n'), 'replay_session_invalid');
      checked('replay_session_invalid', () => sessionText.trim().split('\n').forEach(line => JSON.parse(line)));
      ensure(sessionText.split('\n').length - 1 === r.sessionLineCount, 'replay_session_invalid');
    }
    const resourceConfig = projectResources ? { projectResources: checked('replay_project_resources_invalid', () => prepareProjectResources(snapshot.portableRuntime, files, config)) } : {};
    const input = { kind: 'prepared-caff-turn-v1', capturePlatform: cp.environment?.platform, prompt, files, deletions: [...cp.deletions], sessionText, systemPrompt: null, settings: null, callback, recordedModelConfig, ...resourceConfig,
      bindings: { sourceRoot: cp.targetDir, controlledReplacements: r.controlledReplacements } };
    const mapped = checked('replay_controlled_bindings_invalid', () => validateDirectBindings(input.prompt, input.bindings, sessionText));
    if (resume) {
      const validation = validateSessionV2(mapped.sessionText, { authorizedRoot: '/work/restored', historyContext: true });
      ensure(validation.ok && empty(validation.unverifiedDimensions), 'replay_session_invalid');
    }
    return { supported: true, input, ...variantInfo,
      provenance: { caseId: sealed.caseId, checkpointId: cp.checkpointId,
      checkpointHash: hashJson(cp), ...identityInfo,
      commonInputHash: hashJson({ ...input, prompt: commonPrompt }),
      variant: (promptTarget ? promptTarget.replacement === null : candidateRole === null) ? 'original' : 'candidate', strictEvalEligible: false } };
  } catch (e) { return { supported: false, reason: /^replay_[a-z_]+$/.test(e?.replayReason || '') ? e.replayReason : 'replay_materials_invalid' }; }
}
function prepareSealedDirectTurn(request, candidateRole = null) { return prepareTurn(request, candidateRole, null); }
function prepareSealedOriginalTurn(request) { return prepareTurn(request, null, null, true); }
function prepareSealedPromptTarget(request, targetId, replacement = null, fragments) { return prepareTurn(request, null, { id: targetId, replacement, fragments }); }
module.exports = { prepareSealedDirectTurn, prepareSealedOriginalTurn, prepareSealedPromptTarget };
