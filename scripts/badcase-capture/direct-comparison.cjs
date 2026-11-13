// Trusted CLI orchestration for one explicitly selected portable sealed case.
// No model gateway, auto prompt generation, secret discovery, or self-scoring.
const crypto = require('node:crypto');
const path = require('node:path');
const { isSafeRelativePath } = require('./replay-path.cjs');
const { prepareSealedDirectTurn, prepareSealedOriginalTurn, prepareSealedPromptTarget } = require('./sealed-direct-input.cjs');
const { prepareDirectTurnFiles, runDirectDockerTask, runCodexDockerTask } = require('./direct-docker.cjs');
const { createCodexTransport, createCodexAccess } = require('./codex-transport.cjs');
const { RELAY_ERROR_CODES } = require('./container-model-relay.cjs');
const { createCodexRelayExchange, codexMailboxLimits } = require('./codex-mailbox.cjs');
const { validateWslDockerBackend, createWslDockerRunner } = require('./wsl-docker.cjs');
const { readKnownKeyValues } = require('./known-key-values.cjs');
const { tokenUsage } = require('./replay-measurements.cjs');
const { projectResourcesSummary, projectResourcesReceiptMatches } = require('../../build/server/domain/runtime/badcase-capture/project-resources');
const CODEX_CONFIG = Object.freeze({ api: 'openai-codex-responses', thinking: 'xhigh', fast: false, transport: 'sse', credentialDelivery: 'host-only-mailbox' });
const { prepareReplayGit } = require('./replay-git.cjs');
const { prepareReplayDependencies } = require('./replay-dependencies.cjs');
const { readEvaluationKey, readCaffDeepseekKey, validKey, modelProfile, replaySessionInfo, DEFAULT_PROFILE, DEEPSEEK_PROFILE, CODEX_PROFILE } = require('./direct-model.cjs');
const { manifestFor } = require('./pi-probe-materials.cjs');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { resolveWikiCandidate } = require('../../build/server/domain/runtime/badcase-capture/wiki-candidate');
const { resolveGlobalWikiCandidate } = require('../../build/server/domain/runtime/badcase-capture/wiki-global-candidate');
const { resolveWikiBaseline } = require('../../build/server/domain/runtime/badcase-capture/wiki-baseline');
const { collectWikiCandidateFiles } = require('../../build/server/domain/runtime/badcase-capture/wiki-candidate-files');
const { resolveWikiReplayRequest } = require('../../build/server/domain/runtime/badcase-capture/wiki-replay-location');
const { validateLiteralRules, scoreLiteralFiles } = require('./file-literal-rules.cjs');
const { validatePublicReplyRules, scorePublicReply } = require('./public-reply-literal-rules.cjs');
const { scoreWikiReceipt, validateWikiScoring, wikiScoringSummary, assertWikiScoringJudge } = require('./wiki-receipt-scoring.cjs');
const { isWikiJudgeTechnicalError } = require('../../build/server/domain/runtime/badcase-capture/wiki-scoring-v2');
const { validateEvaluationGoalEvidence, evaluationGoalMarker } = require('../../build/server/domain/runtime/badcase-capture/evaluation-goal-evidence');
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const { hashJson, createKnownValueScanner } = require('./replay-streams.cjs');
const fail = code => Object.assign(Error(code), { code });
function validateRules(rules) {
  if (rules?.kind === 'completion-public-reply-v1' && Object.keys(rules).join(',') === 'kind') return { kind: rules.kind };
  if (rules?.kind === 'file-literals-v1') return validateLiteralRules(rules);
  if (['public-reply-literals-v1', 'public-reply-literals-v2'].includes(rules?.kind)) return validatePublicReplyRules(rules);
  if (!rules || rules.kind !== 'read-only-files-v1'
    || Object.keys(rules).some(k => !['kind', 'readPaths', 'absentPaths', 'requiredReplyFragments'].includes(k))
    || !Array.isArray(rules.absentPaths) || rules.absentPaths.length > 16 || new Set(rules.absentPaths).size !== rules.absentPaths.length
    || rules.absentPaths.some(p => !isSafeRelativePath(p))
    || !Array.isArray(rules.readPaths) || !rules.readPaths.length || rules.readPaths.length > 16
    || rules.readPaths.some(p => !isSafeRelativePath(p))
    || new Set(rules.readPaths).size !== rules.readPaths.length
    || !Array.isArray(rules.requiredReplyFragments) || !rules.requiredReplyFragments.length || rules.requiredReplyFragments.length > 32
    || rules.requiredReplyFragments.some(s => typeof s !== 'string' || !s.trim() || s.length > 256)) throw fail('evaluation_rules_invalid');
  return structuredClone(rules);
}
function expectedTreeHash(input) {
  return hash(JSON.stringify(input.files.map(f => ({ path: f.path, type: 'file', sha256: f.sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}
function scoreReadOnlyFiles(receipt, rules, beforeHash) {
  validateRules(rules);
  const calls = Array.isArray(receipt?.toolCalls) ? receipt.toolCalls : [];
  const normalize = p => typeof p === 'string' ? p.replace(/^\/work\/restored\//, '').replace(/^\.\//, '') : '';
  const checks = {
    completed: receipt?.success === true && Array.isArray(receipt.modelCalls) && receipt.modelCalls.length > 0 && receipt.modelCalls.every(c => c.success === true),
    readFiles: rules.readPaths.every(p => calls.some(c => c.name === 'read' && c.isError === false && normalize(c.args?.path) === p)),
    unchanged: receipt?.beforeHash === beforeHash && receipt?.afterHash === beforeHash && !calls.some(c => ['write', 'edit'].includes(c.name)),
    // Deliberately literal, user-confirmable MVP rubric, not semantic judging.
    // The fragments should include the file facts and the missing-file claim.
    reply: receipt?.replySource === 'public' && typeof receipt.finalText === 'string' && rules.requiredReplyFragments.every(s => receipt.finalText.includes(s)),
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}
function validateCodexSource(config) {
  if (config.keySource !== 'caff-codex-access') throw fail('evaluation_codex_auth_source_required');
  // Pure path validation, never opens an auth source.
  try { createCodexAccess(config.codexAuthFile).close(); } catch { throw fail('evaluation_codex_auth_source_required'); }
}
function comparisonKnownValues(config, options) {
  // Only trusted host callers/tests can supply an inventory directly. Config
  // JSON cannot supply secret values or silently select an empty inventory.
  if (Object.hasOwn(options, 'knownValues')) {
    if (!Array.isArray(options.knownValues) || options.knownValues.some(v => typeof v !== 'string')) throw fail('evaluation_config_invalid');
    return options.knownValues;
  }
  if (config?.knownKeySources !== undefined) {
    if (config.modelProfile === CODEX_PROFILE && path.resolve(config.knownKeySources?.sandboxRoot || '') !== path.dirname(path.resolve(config.codexAuthFile || ''))) throw fail('evaluation_known_sources_mismatch');
    return readKnownKeyValues(config.knownKeySources).values;
  }
  if (config?.repository !== undefined) throw fail('evaluation_known_sources_required');
  return [];
}
function validateNativeMaxRequests(config) {
  if (config?.nativeMaxRequests !== undefined) {
    if (config.modelProfile !== CODEX_PROFILE) throw fail('evaluation_config_invalid');
    codexMailboxLimits(config.nativeMaxRequests);
  }
}
function prepareComparison(config, options = {}) {
  validateNativeMaxRequests(config);
  if (Number.isSafeInteger(config?.timeoutMs) && config.timeoutMs > 45 * 60 * 1000) throw fail('evaluation_timeout_limit');
  const variants = config?.variants === undefined ? ['original', 'candidate'] : config.variants;
  const originalOnly = Array.isArray(variants) && variants.length === 1 && variants[0] === 'original';
  if (!config || !Array.isArray(variants) || !(originalOnly || variants.length === 2 && variants[0] === 'original' && variants[1] === 'candidate') || !Number.isSafeInteger(config.repeats) || config.repeats < 1 || config.repeats > 20
    || Object.keys(config).some(k => !['request', 'repoRoot', 'dependencyRoot', 'image', 'repeats', 'candidateRole', 'wikiCandidate', 'globalWikiCandidate', 'rules', 'timeoutMs', 'modelProfile', 'keySource', 'executionPolicy', 'repository', 'dependencies', 'codexAuthFile', 'knownKeySources', 'variants', 'dockerBackend', 'scoring', 'nativeMaxRequests'].includes(k))
    || config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 45 * 60 * 1000)
    || config.executionPolicy !== undefined && (config.executionPolicy !== 'alternating-valid-v1' || !config.globalWikiCandidate || config.repeats !== 10)
    || [config.candidateRole, config.wikiCandidate, config.globalWikiCandidate].filter(v => v !== undefined).length !== (originalOnly ? 0 : 1)
    || config.candidateRole !== undefined && (typeof config.candidateRole !== 'string' || !config.candidateRole.trim())
    || !path.isAbsolute(config.repoRoot || '') || !path.isAbsolute(config.dependencyRoot || '')
    || !/^sha256:[a-f0-9]{64}$/.test(config.image?.imageId || '')) throw fail('evaluation_config_invalid');
  const profile = config.modelProfile ?? DEFAULT_PROFILE;
  modelProfile(profile);
  const dockerBackend = config.dockerBackend === undefined ? null : validateWslDockerBackend(config.dockerBackend);
  if (profile === CODEX_PROFILE) validateCodexSource(config);
  else if (dockerBackend || config.codexAuthFile !== undefined || config.keySource !== undefined && !['evaluation-env', 'caff-deepseek'].includes(config.keySource)
    || config.keySource === 'caff-deepseek' && profile !== DEEPSEEK_PROFILE) throw fail('evaluation_config_invalid');
  const scoring = config.scoring === undefined ? null : validateWikiScoring(config.scoring);
  const rules = validateRules(config.rules ?? (scoring ? { kind: 'completion-public-reply-v1' } : undefined));
  if (!scoring && rules.kind === 'completion-public-reply-v1') throw fail('wiki_scoring_config_required');
  const knownValues = comparisonKnownValues(config, options);
  // Host-only literal inventory is not a config JSON secret channel. Legacy
  // preparation ignores it; v2 needs it when materializing uncaptured HEAD blobs.
  const replayOptions = config.knownKeySources !== undefined || Object.hasOwn(options, 'knownValues') ? { knownKeyValues: knownValues } : {};
  let prepare = options.prepare || ((request, candidate) => originalOnly ? prepareSealedOriginalTurn(request, replayOptions)
    : prepareSealedDirectTurn(request, candidate, replayOptions)), globalWikiCandidate = null, globalState, globalSaved, globalFiles, baseline;
  if (config.globalWikiCandidate !== undefined) {
    const selection = require('../../build/server/domain/runtime/badcase-capture/wiki-data-directory').resolveWikiStorageOptions(config.globalWikiCandidate);
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)
      || Object.keys(selection).sort().join(',') !== 'candidateId,globalRoot,sourceWorktree'
      || !path.isAbsolute(selection.globalRoot || '') || !path.isAbsolute(selection.sourceWorktree || '')
      || typeof selection.candidateId !== 'string') throw fail('evaluation_config_invalid');
    globalState = createWikiStore({ globalRoot: selection.globalRoot, sourceWorktree: selection.sourceWorktree }).read();
    globalSaved = globalState.candidates.find(c => c.id === selection.candidateId && c.kind === 'global-wiki-candidate-v1');
    if (!globalSaved || !(globalSaved.status === 'confirmed' || options.allowDraftCandidate === true && globalSaved.status === 'draft')) throw fail('wiki_candidate_confirmation_required');
    if (globalSaved.target?.kind !== 'global-system-prompt') throw fail('evaluation_target_unsupported');
    globalFiles = collectWikiCandidateFiles(globalState, selection);
    resolveGlobalWikiCandidate(globalState, globalSaved.id, globalSaved.targetId, globalSaved.baseHash, globalFiles, { allowDraft: options.allowDraftCandidate === true });
    baseline = resolveWikiBaseline(globalState, globalSaved.targetId);
    const prepareTarget = options.prepareTarget || prepareSealedPromptTarget;
    // Old seals and newly sealed, manually merged fragments share one baseline.
    // Only the candidate adds a new change; neither arm silently drops history.
    prepare = (request, replacement = null) => prepareTarget(resolveWikiReplayRequest(selection, request), globalSaved.targetId,
      replacement === null && baseline.fragments.length > 1 ? baseline.target.baseText : replacement, baseline.fragments, replayOptions);
  }
  const original = prepare(config.request);
  if (original.supported !== true) return { supported: false, reason: /^replay_[a-z_]+$/.test(original.reason || '') ? original.reason : 'replay_materials_invalid' };
  if (original.input.recordedModelConfig !== undefined && original.input.recordedModelConfig.thinking !== (modelProfile(profile).thinking || 'off')) {
    return { supported: false, reason: 'replay_thinking_profile_mismatch' };
  }
  let candidateRole = config.candidateRole, wikiCandidate = null;
  if (globalSaved) {
    if (!baseline.fragments.some(f => f.baseHash === original.provenance.originalTargetHash)) throw fail('wiki_candidate_target_mismatch');
    const selected = resolveGlobalWikiCandidate(globalState, globalSaved.id, original.provenance.targetId,
      globalSaved.baseHash, original.input.files, { allowDraft: options.allowDraftCandidate === true });
    candidateRole = selected.candidateText;
    globalWikiCandidate = { id: selected.id, versionId: selected.versionId, entryIds: selected.entryIds,
      targetId: selected.targetId, baseHash: selected.baseHash, candidateHash: selected.candidateHash,
      ...(selected.experienceHash ? { experienceHash: selected.experienceHash } : {}) };
  }
  if (config.wikiCandidate !== undefined) {
    const selection = config.wikiCandidate;
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)
      || Object.keys(selection).sort().join(',') !== 'candidateId,sourceWorktree'
      || !path.isAbsolute(selection.sourceWorktree || '') || typeof selection.candidateId !== 'string'
      || config.request?.association?.agentId !== 'role-family-gpt') throw fail('evaluation_config_invalid');
    const state = createWikiStore({ captureRoot: config.request.captureRoot, projectId: config.request.association.projectId,
      sourceWorktree: selection.sourceWorktree }).read();
    const selected = resolveWikiCandidate(state, selection.candidateId, original.provenance.originalRoleHash, original.input.files);
    candidateRole = selected.candidateRole;
    wikiCandidate = { id: selected.id, versionId: selected.versionId, entryIds: selected.entryIds, candidateRoleHash: selected.candidateRoleHash };
  }
  const candidate = originalOnly ? null : prepare(config.request, candidateRole);
  if (!originalOnly && candidate.supported !== true) return { supported: false, reason: /^replay_[a-z_]+$/.test(candidate.reason || '') ? candidate.reason : 'replay_materials_invalid' };
  if (!originalOnly && (original.provenance.checkpointHash !== candidate.provenance.checkpointHash
    || original.provenance.commonInputHash !== candidate.provenance.commonInputHash)) throw fail('evaluation_start_mismatch');
  if (rules.kind === 'read-only-files-v1') {
    for (const p of rules.readPaths) if (!original.input.files.some(f => f.path === p)) throw fail('evaluation_rules_invalid');
    for (const p of rules.absentPaths) if (original.input.files.some(f => f.path === p) || !original.input.deletions?.includes(p)) throw fail('evaluation_rules_invalid');
  }
  // Only requested paths, never literal reference values, enter worker inputs.
  const evidenceConfig = rules.kind === 'file-literals-v1' ? { fileEvidencePaths: rules.files.map(f => f.path) } : {};
  let repository;
  if (config.repository !== undefined) {
    // The operator supplies an independently recorded commit, never an implicit
    // current HEAD. Ordinary source-file bytes are not substituted for capture.
    if (original.input.bindings?.sourceRoot && path.resolve(config.repository?.sourceRoot || '') !== path.resolve(original.input.bindings.sourceRoot)) throw fail('evaluation_repository_source_mismatch');
    if (original.provenance.sourceSnapshot && config.repository?.head !== original.provenance.sourceSnapshot.head) throw fail('evaluation_repository_head_mismatch');
    repository = prepareReplayGit(config.repository, original.input, { knownValues });
  }
  if (rules.kind === 'public-reply-literals-v2' && repository?.report.sourceHead !== rules.snapshotHead) throw fail('evaluation_snapshot_head_mismatch');
  const repositoryConfig = repository ? { repository: repository.report, gitFiles: repository.gitFiles } : {};
  let dependencyConfig = {};
  if (config.dependencies !== undefined) {
    if (!config.dependencies || Object.keys(config.dependencies).sort().join(',') !== 'cacheRoot,kind'
      || config.dependencies.kind !== 'npm-ci-linux-v1' || !path.isAbsolute(config.dependencies.cacheRoot || '')) throw fail('evaluation_config_invalid');
    dependencyConfig = prepareReplayDependencies({ ...original.input, ...repositoryConfig }, config.image, config.dependencies.cacheRoot);
  }
  const inputs = { original: { ...original.input, ...evidenceConfig, ...repositoryConfig, ...dependencyConfig },
    ...(candidate ? { candidate: { ...candidate.input, ...evidenceConfig, ...repositoryConfig, ...dependencyConfig } } : {}) };
  const summary = { kind: originalOnly ? (scoring ? 'sealed-original-replay-v2' : 'sealed-original-replay-v1') : (scoring ? 'sealed-prompt-comparison-v2' : 'sealed-prompt-comparison-v1'),
    ...(scoring ? { scoring: wikiScoringSummary(scoring) } : {}),
    ...(config.variants === undefined ? {} : { variants: [...variants] }), caseId: original.provenance.caseId,
    checkpointId: original.provenance.checkpointId, checkpointHash: original.provenance.checkpointHash,
    commonInputHash: repository || config.dependencies || rules.kind === 'file-literals-v1' ? hash(JSON.stringify({ sealedCommonInputHash: original.provenance.commonInputHash, ...evidenceConfig,
      ...(repository ? { repository: repository.report, gitFileHashes: repository.gitFiles.map(f => ({ path: f.path, sha256: f.sha256 })) } : {}),
      ...(dependencyConfig.dependencies ? { dependencies: dependencyConfig.dependencies } : {}) })) : original.provenance.commonInputHash,
    model: profile, ...(profile === CODEX_PROFILE ? { modelConfig: { ...CODEX_CONFIG } } : {}), ...(dockerBackend ? { dockerBackend } : {}),
    ...(original.provenance.sourceSnapshot ? { sourceSnapshot: { ...original.provenance.sourceSnapshot } } : {}),
    ...(original.provenance.captureDisclosures ? { captureDisclosures: structuredClone(original.provenance.captureDisclosures) } : {}),
    ...(original.input.recordedModelConfig ? { recordedModelConfig: { ...original.input.recordedModelConfig } } : {}),
    ...(original.input.projectResources ? { projectResources: projectResourcesSummary(original.input.projectResources) } : {}),
    ...(original.input.sessionText ? { replaySession: replaySessionInfo(original.input.sessionText) } : {}), repeats: config.repeats, ...(config.executionPolicy ? {executionPolicy:config.executionPolicy,maxExtraAttemptsPerCase:5} : {}),
    imageId: config.image.imageId, timeoutMs: config.timeoutMs ?? 120000,
    ...(config.nativeMaxRequests === undefined ? {} : { nativeMaxRequests: config.nativeMaxRequests }), rules, rulesHash: hash(JSON.stringify(rules)),
    inputHashes: Object.fromEntries(Object.entries(inputs).map(([v, i]) => [v, hashJson(i)])),
    strictEvalEligible: false, ...(baseline?.fragments.length > 1 ? { promptBaseline: { kind: 'adopted-wiki-baseline-v1', baseHash: baseline.target.baseHash,
      archivedTargetHash: original.provenance.originalTargetHash, alreadyMerged: original.provenance.originalTargetHash === baseline.target.baseHash, appliedToBothVariants: true } } : {}),
    ...(repository ? { repository: repository.report } : {}),
    ...(dependencyConfig.dependencies ? { dependencies: dependencyConfig.dependencies } : {}), ...(wikiCandidate ? { wikiCandidate } : {}),
    ...(globalSaved?.status === 'draft' ? { candidateConfirmationRequired: true } : {}),
    ...(globalWikiCandidate ? { targetId: globalWikiCandidate.targetId, globalWikiCandidate } : {}) };
  return { supported: true, inputs, summary, beforeHash: expectedTreeHash(original.input),
    ...(repository ? { checkRepositoryKnownValues: repository.checkKnownValues } : {}) };
}
async function runComparison(config, options = {}) {
  // Confirmation precedes any safety-inventory read. A separate --plan may
  // read explicitly configured known-value sources, never authenticate/send.
  if (options.confirmed !== true) throw fail('evaluation_confirmation_required');
  const fixed = structuredClone(config);
  validateNativeMaxRequests(fixed);
  // Select the explicit host transport BEFORE safety/auth sources can open.
  // Windows never passes access to a Linux process or silently falls back.
  let wslDocker;
  if (fixed?.modelProfile === CODEX_PROFILE) {
    validateCodexSource(fixed);
    if (fixed.dockerBackend !== undefined) {
      validateWslDockerBackend(fixed.dockerBackend);
      if (!options.executeCodex) wslDocker = createWslDockerRunner(fixed.dockerBackend);
    } else if (!options.executeCodex && process.platform !== 'linux') throw fail('evaluation_linux_required');
  }
  const effectiveOptions = { ...options, knownValues: comparisonKnownValues(fixed, options) };
  // A draft-preview option can never cross into paid execution.
  effectiveOptions.allowDraftCandidate = false;
  const plan = prepareComparison(fixed, effectiveOptions);
  if (!plan.supported) return { ...plan, runs: [], modelCallsKnown: 0 };
  if (fixed.scoring) assertWikiScoringJudge(fixed.scoring, options.judge);
  const native = plan.summary.model === CODEX_PROFILE;
  const stage = options.stage || prepareDirectTurnFiles, execute = native ? options.executeCodex
    || (wslDocker ? (image, files, opts) => runCodexDockerTask(image, files, { ...opts, runDocker: wslDocker }) : runCodexDockerTask) : options.execute || runDirectDockerTask;
  const emit = options.onEvent || (() => {}), keyReader = options.readKey || (fixed.keySource === 'caff-deepseek' ? readCaffDeepseekKey : readEvaluationKey);
  const variants = plan.summary.variants || ['original', 'candidate'], files = {}, manifests = {};
  for (const variant of variants) {
    files[variant] = stage(fixed.repoRoot, fixed.dependencyRoot, fixed.image, plan.inputs[variant], fixed.modelProfile, fixed.nativeMaxRequests);
    manifests[variant] = manifestFor(files[variant], { replayWorkspace: true });
  }
  if (variants.length === 2 && manifests.original.runtimeHash !== manifests.candidate.runtimeHash) throw fail('evaluation_runtime_mismatch');
  let transport, sendNativeRequest, key;
  try {
  if (native) {
    transport = (options.createCodexTransport || createCodexTransport)({ authFile: fixed.codexAuthFile, confirmed: true, timeoutMs: fixed.timeoutMs ?? 120000 },
      { containsKnownValue: bytes => effectiveOptions.knownValues.some(v => v && (bytes.includes(v) || bytes.includes(JSON.stringify(v).slice(1, -1)))) });
    transport.inspectAccess(access => { key = access; });
    sendNativeRequest = createCodexRelayExchange({ fetch: transport.fetch });
  } else key = validKey(keyReader()); // No persistence or argv/env-file creation.
  const values = [...new Set([key, ...effectiveOptions.knownValues])].filter(v => typeof v === 'string' && v);
  const scanner = createKnownValueScanner(values), leaksKey = scanner.value, leaksBytes = scanner.bytes;
  const leaksFile = file => file.sourceFile ? scanner.file(file.sourceFile) : leaksBytes(file.bytes);
  const checkInputs = prepared => {
    // Compressed Git must be checked as plaintext; file bodies are base64 in
    // host preparation, so check decoded bytes as well as structured fields.
    prepared.checkRepositoryKnownValues?.(values);
    if (fixed.scoring && leaksKey(fixed.scoring)) throw fail('evaluation_input_contains_key');
    if (leaksKey(prepared.summary)) throw fail('evaluation_output_contains_key');
    for (const input of Object.values(prepared.inputs)) {
      if (leaksKey(input) || [...input.files, ...(input.gitFiles || [])].some(f => scanner.base64(f.base64))
        || input.dependencyArchive && (input.dependencyArchive.sourceFile ? scanner.file(input.dependencyArchive.sourceFile) : scanner.base64(input.dependencyArchive.base64))) throw fail('evaluation_input_contains_key');
    }
  };
  checkInputs(plan);
  if (Object.values(files).some(list => list.some(leaksFile))) throw fail('evaluation_input_contains_key');
  emit({ event: 'plan', ...plan.summary, runtimeHash: manifests.original.runtimeHash });
  const runs = []; let stopped = false, modelCallsKnown = 0, callsUnavailable = false;
  const alternating = fixed.executionPolicy === 'alternating-valid-v1';
  const validCount = v => runs.filter(r=>r.variant===v && r.status!=='error' && r.status!=='invalid').length;
  // Judge retries use the exact saved reply. Once exhausted, that slot is an
  // error; it cannot buy a different (possibly more favorable) worker answer.
  const slotCount = v => runs.filter(r=>r.variant===v && (r.status!=='error' && r.status!=='invalid' || isWikiJudgeTechnicalError(r.assessment))).length;
  const legacySlots = variants.flatMap(variant=>Array.from({length:fixed.repeats},(_,i)=>({variant,iteration:i+1})));
  let cursor=0, nextVariant=0, fatal=false;
  while (!stopped) {
      let variant, iteration;
      if (alternating) {
        if (runs.length>=2*fixed.repeats+5 || variants.every(v=>slotCount(v)===fixed.repeats)) break;
        if (slotCount(variants[nextVariant])===fixed.repeats) nextVariant=1-nextVariant;
        variant=variants[nextVariant]; nextVariant=1-nextVariant;
        iteration=runs.filter(r=>r.variant===variant).length+1;
      } else { const slot=legacySlots[cursor++]; if(!slot) break; ({variant,iteration}=slot); }
      // Recheck seal AND current static distribution; no live-source or fresh
      // fallback if bytes changed after the planned starting point.
      if (fixed.scoring) assertWikiScoringJudge(fixed.scoring, options.judge);
      const fresh = prepareComparison(fixed, effectiveOptions);
      if (!fresh.supported || JSON.stringify(fresh.summary) !== JSON.stringify(plan.summary)
        || manifestFor(stage(fixed.repoRoot, fixed.dependencyRoot, fixed.image, fresh.inputs[variant], fixed.modelProfile, fixed.nativeMaxRequests), { replayWorkspace: true }).inputHash !== manifests[variant].inputHash) {
        throw fail('evaluation_input_changed');
      }
      checkInputs(fresh);
      let task;
      emit({ event: 'run_start', variant, iteration });
      const started = performance.now(), hostBefore = transport?.state().requests;
      let checkingAccess = true;
      const onDiagnostic = value => {
        // Diagnostic events cannot substitute for receipt/isolation evidence.
        if (!['access', 'inspect', 'read', 'request', 'send', 'write', 'cleanup'].includes(value?.phase)) return;
        const cleanup = value.phase === 'cleanup';
        if (cleanup ? !['none', 'cleanup_failed'].includes(value.errorCode)
          || typeof value.cleanup?.attempted !== 'boolean' || typeof value.cleanup?.completed !== 'boolean'
          : !RELAY_ERROR_CODES.includes(value.errorCode)) return;
        emit({ event: 'launcher_diagnostic', variant, iteration, phase: value.phase, errorCode: value.errorCode,
          ...(cleanup ? { cleanup: { attempted: value.cleanup.attempted, completed: value.cleanup.completed } } : {}) });
      };
      try {
        transport?.beginAttempt();
        transport?.inspectAccess(() => {}); // Expiry stops BEFORE another container.
        checkingAccess = false;
        task = await execute(fixed.image, files[variant], { onDiagnostic, ...(native
          ? { sendNativeRequest, network: 'none', timeoutMs: fixed.timeoutMs ?? 120000, expectedInputHash: manifests[variant].inputHash,
            ...(fixed.nativeMaxRequests === undefined ? {} : { maxRequests: fixed.nativeMaxRequests }),
            ...(options.signal ? { signal: options.signal } : {}) }
          : { key, network: 'bridge', timeoutMs: fixed.timeoutMs ?? 120000, expectedInputHash: manifests[variant].inputHash }) });
      } catch (e) {
        if (native && checkingAccess && RELAY_ERROR_CODES.includes(e?.code)) onDiagnostic({ phase: 'access', errorCode: e.code });
        task = { failed: true, reason: 'evaluation_failed' };
      }
      const durationMs = performance.now() - started, environmentReason = transport?.state().reason;
      const hostRequestAttempts = native ? transport.state().requests - hostBefore : undefined;
      const encodedLeak = Array.isArray(task?.receipt?.fileEvidence) && task.receipt.fileEvidence.some(f =>
        typeof f?.base64 === 'string' && scanner.base64(f.base64));
      if (leaksKey(task) || encodedLeak) task = { failed: true, reason: 'evaluation_output_contains_key' };
      const receipt = task?.receipt, row = { variant, iteration, status: 'error', checks: null, finalText: '', replySource: 'unknown', modelCalls: [],
        containerId: task?.containerId || null, cleaned: task?.cleaned === true, isolation: task?.isolation || null,
        inputHash: manifests[variant].inputHash, durationMs, ...(native ? { hostRequestAttempts } : {}) };
      // Missing run evidence can be environmental; explicit conflicting hashes
      // are integrity drift and must never be hidden by a replacement attempt.
      const evidenceChanged = [[receipt?.inputHash, manifests[variant].inputHash],
        [receipt?.runtimeHash, manifests[variant].runtimeHash], [receipt?.beforeHash, plan.beforeHash],
        [task?.inputHash, manifests[variant].inputHash], [task?.runtimeHash, manifests[variant].runtimeHash],
        ...(plan.summary.dependencies ? ['archiveHash', 'cacheKey', 'lockHash', 'nodeVersion']
          .map(field => [receipt?.dependencies?.[field], plan.summary.dependencies[field]]) : []),
        ...(plan.summary.repository ? ['sourceHead', 'restoredHead', 'historyIncluded', 'headIdenticalToSource', 'historyCommitCount']
          .map(field => [receipt?.repository?.[field], plan.summary.repository[field]]) : [])]
        .some(([actual, expected]) => actual !== undefined && actual !== expected);
      const verifiedLauncher = native && task?.cleaned === true && /^[a-f0-9]{64}$/.test(task.containerId || '')
        && task.isolation?.network === 'none' && task.inputHash === manifests[variant].inputHash
        && task.runtimeHash === manifests[variant].runtimeHash;
      const recoverableProxy = verifiedLauncher && environmentReason === 'evaluation_codex_proxy_failed'
        && task?.failed === true && task.reason === environmentReason;
      const modelConfigChanged = native && !recoverableProxy && Object.keys(CODEX_CONFIG).some(k => receipt?.modelConfig?.[k] !== CODEX_CONFIG[k]);
      const recordedConfigChanged = plan.summary.recordedModelConfig && receipt?.kind === 'direct-caff-turn-v1' && Object.keys(plan.summary.recordedModelConfig)
        .some(k => receipt?.recordedModelConfig?.[k] !== plan.summary.recordedModelConfig[k]);
      const sessionChanged = plan.summary.replaySession && receipt?.kind === 'direct-caff-turn-v1' && Object.keys(plan.summary.replaySession)
        .some(k => receipt?.replaySession?.[k] !== plan.summary.replaySession[k]);
      const resourcesChanged = plan.summary.projectResources && receipt?.kind === 'direct-caff-turn-v1'
        && !projectResourcesReceiptMatches(plan.summary.projectResources, receipt.projectResources);
      const valid = !evidenceChanged && !modelConfigChanged && !recordedConfigChanged && !sessionChanged && !resourcesChanged && !task?.failed && task?.code === 0 && task?.cleaned === true && receipt?.kind === 'direct-caff-turn-v1'
        && receipt.inputHash === manifests[variant].inputHash && receipt.runtimeHash === manifests[variant].runtimeHash
        && receipt.beforeHash === plan.beforeHash
        && (!plan.summary.repository || receipt.repository?.gitAvailable === true && receipt.repository?.historyCommitCount === plan.summary.repository.historyCommitCount
          && receipt.repository?.historyIncluded === plan.summary.repository.historyIncluded && receipt.repository?.headIdenticalToSource === plan.summary.repository.headIdenticalToSource
          && receipt.repository?.sourceHead === plan.summary.repository.sourceHead && receipt.repository?.restoredHead === plan.summary.repository.restoredHead)
        && (!plan.summary.dependencies || receipt.dependencies?.installed === true
          && receipt.dependencies?.archiveHash === plan.summary.dependencies.archiveHash && receipt.dependencies?.cacheKey === plan.summary.dependencies.cacheKey
          && receipt.dependencies?.lockHash === plan.summary.dependencies.lockHash && receipt.dependencies?.nodeVersion === plan.summary.dependencies.nodeVersion)
        && Array.isArray(receipt.modelCalls) && receipt.modelCalls.length > 0
        && receipt.modelCalls.every(c => c.model === plan.summary.model && typeof c.success === 'boolean' && Number.isFinite(c.durationMs) && c.durationMs >= 0);
      if (valid) {
        if (receipt.goalEvidence !== undefined) {
          row.goalEvidence = validateEvaluationGoalEvidence(receipt.goalEvidence);
          Object.assign(row, evaluationGoalMarker(row.goalEvidence));
        }
        // Opt-in trusted retention hook. Legacy results/events stay byte-identical;
        // prechecks retain the verified native arguments, not parsed shell text.
        options.onReceipt?.(structuredClone(receipt));
        if (plan.summary.replaySession) row.replaySession = { ...plan.summary.replaySession };
        if (plan.summary.projectResources) row.projectResources = { ...plan.summary.projectResources, verified: true,
          loadedContextFiles: receipt.projectResources.loadedContextFiles, loadedSkills: receipt.projectResources.loadedSkills };
        if (plan.summary.repository) row.repository = { ...plan.summary.repository, gitAvailable: true, historyCommitCount: receipt.repository.historyCommitCount };
        if (plan.summary.dependencies) row.dependencies = receipt.dependencies;
        row.modelCalls = receipt.modelCalls;
        row.finalText = receipt.finalText;
        row.replySource = ['public', 'internal', 'none'].includes(receipt.replySource) ? receipt.replySource : 'unknown';
        modelCallsKnown += row.modelCalls.length;
        for (const [i, call] of row.modelCalls.entries()) emit({ event: 'model_call', variant, iteration, request: i + 1, ...call });
        if (receipt.success === true && receipt.modelCalls.every(c => c.success)) {
          const literal = plan.summary.rules.kind === 'file-literals-v1', publicReply = ['public-reply-literals-v1', 'public-reply-literals-v2'].includes(plan.summary.rules.kind);
          if (fixed.scoring && environmentReason) {
            row.reason = environmentReason; stopped = true;
          } else if (fixed.scoring) {
            const assessment = await scoreWikiReceipt({ receipt, rules: plan.summary.rules, scoring: fixed.scoring, beforeHash: plan.beforeHash }, options.judge);
            if (leaksKey(assessment)) throw fail('evaluation_output_contains_key');
            row.status = assessment.status; row.assessment = assessment;
            row.checks = Object.fromEntries(assessment.hardAssertions.map(c => [c.id, c.status === 'pass']));
            if (assessment.reason) row.reason = assessment.reason;
            if (literal) { row.fileEvidence = receipt.fileEvidence; row.fileChecks = assessment.referenceDetails; }
            if (publicReply) row.replyChecks = assessment.referenceDetails;
            // Technical judge failures are already retried on this receipt.
            // Keep the error and continue other slots; evidence failures still
            // stop for investigation, as do configuration/integrity exceptions.
            if (assessment.status === 'error' && !isWikiJudgeTechnicalError(assessment)) { stopped = true; fatal = true; }
          } else {
            const score = literal ? scoreLiteralFiles(receipt, plan.summary.rules) : publicReply ? scorePublicReply(receipt, plan.summary.rules)
              : scoreReadOnlyFiles(receipt, plan.summary.rules, plan.beforeHash);
            if (score.available === false) { row.reason = publicReply ? 'reply_evidence_unavailable' : 'file_evidence_unavailable'; stopped = true; }
            else {
              row.status = score.pass ? 'pass' : 'fail'; row.checks = score.checks;
              if (literal) { row.fileEvidence = receipt.fileEvidence; row.fileChecks = score.details; }
              if (publicReply) row.replyChecks = score.details;
            }
          }
        } else {
          row.reason = 'model_turn_failed';
          // Successful HTTP/tool cycles stopped by the model/request ceiling or
          // HTTP-200 truncation are model failures. Provider/network failures
          // remain environmental errors. Legacy single/role runs still stop.
          if ((alternating || fixed.scoring) && receipt.modelCalls.every(c=>c.success || c.httpStatus===200)) row.status='fail';
          else stopped=true;
        }
      } else {
        row.reason = 'run_evidence_unavailable'; stopped = true; callsUnavailable = true;
        // Inner `timeout` exited 124 after a started, isolated task, with hashes
        // and cleanup verified by the launcher. Docker control timeouts/OOM or
        // unknown cleanup are NOT proof of a model timeout.
        if (alternating && task?.failed && task.reason==='model_timeout' && task.code===124 && task.cleaned===true && task.isolation
          && task.inputHash===manifests[variant].inputHash && task.runtimeHash===manifests[variant].runtimeHash) {
          row.status='fail'; row.reason='model_timeout'; stopped=false;
        }
      }
      if (alternating) {
        fatal = ['file_evidence_unavailable', 'reply_evidence_unavailable'].includes(row.reason) || evidenceChanged
          || row.assessment?.status === 'error' && !isWikiJudgeTechnicalError(row.assessment) || modelConfigChanged || recordedConfigChanged || sessionChanged || resourcesChanged || task?.reason==='evaluation_output_contains_key' || task?.cleaned !== true;
        // Only environmental errors may consume the five replacement attempts.
        // Evidence/integrity stops propagate to the remaining cases and stages.
        stopped = fatal;
      }
      // Unlike a thrown proxy failure, an HTTP gateway error travels back to
      // the worker. Require its normal verified receipt as well as launcher
      // cleanup; never waive model/config evidence for an HTTP error.
      const recoverableGateway = verifiedLauncher && environmentReason === 'evaluation_codex_gateway_unavailable'
        && valid && receipt.success === false
        && receipt.modelCalls.some(c => c.success === false && [502, 503, 504].includes(c.httpStatus));
      // Auth/quota, all other HTTP statuses and integrity errors still stop.
      // Send/read and gateway errors share the unchanged five replacements;
      // missing worker usage stays explicitly unknown.
      if (environmentReason) {
        row.status = 'error'; row.checks = null; row.reason = environmentReason;
        if (transport.state().diagnostic) row.environmentDiagnostic = transport.state().diagnostic;
        stopped = !alternating || !(recoverableProxy || recoverableGateway) || fatal; fatal = stopped;
      }
      // Trace tool checks add non-scoring invalid attempts. Share the existing
      // five replacements with environment errors, never buy extra valid slots.
      if (alternating && fixed.scoring?.rubric.toolCheck && [...runs, row]
        .filter(r => r.status === 'invalid' || r.status === 'error' && !isWikiJudgeTechnicalError(r.assessment)).length >= 5) {
        stopped = true; row.stopReason = 'replacements_exhausted';
      }
      if (native && alternating && row.status === 'error' && !isWikiJudgeTechnicalError(row.assessment)
        && runs.filter(r => r.status === 'error' && !isWikiJudgeTechnicalError(r.assessment)).length >= 5) {
        stopped = true; fatal = true; row.stopReason = 'environment_replacements_exhausted';
      }
      row.tokenUsage = tokenUsage(row.modelCalls, { callsUnavailable: !valid });
      runs.push(row); const { modelCalls: omitted, ...eventRow } = row; emit({ event: 'run', ...eventRow });
  }
  const totals = Object.fromEntries(variants.map(v => {
    const rows = runs.filter(r => r.variant === v);
    return [v, { planned: fixed.repeats, attempted: rows.length, passed: rows.filter(r => r.status === 'pass').length,
      failed: rows.filter(r => r.status === 'fail').length, errors: rows.filter(r => r.status === 'error').length,
      ...(fixed.scoring?.rubric.toolCheck ? { invalid: rows.filter(r => r.status === 'invalid').length } : {}),
      notRun: fixed.repeats - (alternating ? rows.filter(r=>r.status!=='error' && r.status!=='invalid').length : rows.length) }];
  }));
  const measurements = { tokenUsage: tokenUsage(runs.flatMap(r => r.modelCalls), { callsUnavailable }),
    totalExecutorDurationMs: runs.reduce((sum, r) => sum + r.durationMs, 0),
    ...(native ? { hostRequestAttempts: transport.state().requests, remainingQuota: null, quotaBasis: 'reported-tokens-only' } : {}) };
  const result = { ...plan.summary, supported: true, measurements, completed: alternating ? variants.every(v=>validCount(v)===fixed.repeats) : !stopped && !runs.some(r=>r.status==='invalid' || isWikiJudgeTechnicalError(r.assessment)), runs, totals, modelCallsKnown, callsUnavailable,
    ...(alternating ? {fatal} : {}) };
  emit({ event: 'summary', completed: result.completed, totals, modelCallsKnown, callsUnavailable, measurements });
  return result;
  } finally { key = undefined; await transport?.close(); }
}
function formatComparison(result) {
  if (!result.supported) return '不可回放：' + (/^replay_[a-z_]+$/.test(result.reason || '') ? result.reason : 'replay_materials_invalid') + '。\n';
  const lines = [...(['sealed-original-replay-v1', 'sealed-original-replay-v2'].includes(result.kind) ? ['原版单边回放：没有候选，不产生采纳结论。'] : []), '模型：' + result.model,
    result.scoring ? result.scoring.binding === null ? '评分：硬断言＋代码工具检查；不调用AI裁判。' : '评分：硬断言＋AI细则裁判；字面指标只作参考。' : '评分：字面规则（旧版）。'];
  if (result.scoring) lines.push(result.scoring.binding === null ? '裁判：未调用；仅代码工具检查。' : '裁判：' + result.scoring.binding.model + ' / ' + result.scoring.binding.backend + '；每条细则3次取多数。',
    '细则：v' + result.scoring.rubricVersion + ' / ' + result.scoring.rubricHash + '；判分配置：' + result.scoring.configHash + '。');
  if (result.runs?.some(r => r.goalState === 'approximate-minimal-v1')) lines.push('Goal 状态近似：独立最小种子，不还原历史 Goal；仅 Goal 工具返回可见，不写入冻结输入。');
  if (result.dockerBackend) lines.push('Docker：Windows宿主 → WSL(' + result.dockerBackend.distribution + ')；凭据和供应方连接仅在Windows，材料经stdin，容器断网。');
  if (result.modelConfig) lines.push('配置：' + result.modelConfig.api + ' / thinking ' + result.modelConfig.thinking + ' / ' + result.modelConfig.transport + ' / Fast关闭；凭据仅在宿主。');
  if (Number.isSafeInteger(result.timeoutMs)) lines.push('容器时限：' + result.timeoutMs / 1000 + '秒（配置上限，不是已用时）。');
  if (result.recordedModelConfig) lines.push('封存配置：' + result.recordedModelConfig.provider + '/' + result.recordedModelConfig.model + ' / thinking ' + result.recordedModelConfig.thinking + '；计划保留该thinking，实际以有效回执为准。');
  if (result.replaySession) lines.push('封存会话：resume；前缀' + result.replaySession.lineCount + '行，SHA-256=' + result.replaySession.prefixHash + '；只重绑已声明的上下文/回调，不重放中途消息。',
    '历史工具（含bash/未知工具及结果）仅作上下文，不执行；当前轮次是否依赖历史外部路径未核验，按用户裁决先放行，不承诺外部状态已恢复。');
  if (result.captureDisclosures) {
    const { roomRecord, uncaptured, portableGaps = [] } = result.captureDisclosures;
    if (!roomRecord.available) lines.push('披露：房间记录不可用；仅创建明确标记的隔离回调占位，不还原原房间历史。');
    else if (roomRecord.omissions) lines.push('披露：房间公开记录按尽力而为保存；省略计数=' + JSON.stringify(roomRecord.omissions));
    for (const gap of portableGaps) lines.push('可移植缺口：' + JSON.stringify(gap.path) + '；原因=' + JSON.stringify(gap.reason));
    for (const gap of uncaptured) lines.push('跳过文件：' + JSON.stringify(gap.path) + '；原因=' + JSON.stringify(gap.reason) + (gap.scope ? '；范围=' + JSON.stringify(gap.scope) : ''));
    if (!roomRecord.available || uncaptured.length) lines.push('该现场有已披露缺口，不代表完整还原。');
  }
  if (result.projectResources) lines.push('项目资源：封存文件' + result.projectResources.fileCount + '个，SHA-256=' + result.projectResources.manifestHash + '；原生SDK发现，缺失/漂移拒绝，未用当前源文件补齐。');
  if (result.repository) {
    lines.push(result.repository.historyIncluded ? 'Git：保留记录HEAD的完整可达历史，HEAD与源记录相同；共' + result.repository.historyCommitCount + '个提交。'
      : 'Git：历史命中本机已知key，脱敏后重建，HEAD不同于源仓库；只有1个基线提交，无历史提交。',
    '源HEAD：' + result.repository.sourceHead, '恢复HEAD：' + result.repository.restoredHead,
    '限制：git历史只排除本机已知key，不做模式脱敏。');
  }
  if (result.dependencies) {
    lines.push('依赖：Linux npm ci 缓存；lock=' + result.dependencies.lockHash + '，Node=' + result.dependencies.nodeVersion + '。');
    if (result.dependencies.resolvedWithoutIntegrity) lines.push('限制：lock中' + result.dependencies.resolvedWithoutIntegrity + '条下载记录没有integrity；保留原lock，安装产物另以SHA-256固定。');
  }
  lines.push('变体\t轮次\t结果\t模型请求\t回复来源\t原因\t耗时ms\t已知tokens');
  for (const r of result.runs || []) {
    lines.push([r.variant, r.iteration, r.status, r.reason === 'run_evidence_unavailable' ? 'unknown' : r.modelCalls.length, r.replySource ?? 'unknown', r.reason ?? '', Number.isFinite(r.durationMs) ? Math.round(r.durationMs) : '未知', r.tokenUsage?.knownTokens?.totalTokens ?? '未知'].join('\t'));
    for (const [i, c] of r.modelCalls.entries()) lines.push('  #' + (i + 1) + ' ' + c.model + ' ' + Math.round(c.durationMs) + 'ms ' + (c.success ? 'success' : 'failed') + ' usage=' + JSON.stringify(c.usage ?? null));
  }
  for (const v of ['original', 'candidate']) {
    const t = result.totals?.[v]; if (t) lines.push(v + ': ' + t.passed + '/' + t.planned + ' 通过，' + t.errors + ' 错误，' + t.notRun + ' 未运行');
  }
  if (result.measurements) {
    const usage = result.measurements.tokenUsage;
    lines.push('已知token合计：' + (usage.knownTokens ? usage.knownTokens.totalTokens : '未知') + '；用量记录 ' + usage.knownCalls + ' 次，缺用量 ' + usage.callsWithoutUsage + ' 次' + (usage.callsUnavailable ? '，存在未知调用' : '') + (usage.complete ? '（完整）' : '（不完整）') + '。');
    if (result.modelConfig) lines.push('宿主请求尝试：' + result.measurements.hostRequestAttempts + '；剩余额度未知，不把token换算为ChatGPT配额。');
  }
  if (result.completed === false) lines.push('运行未完成；已停止，未自动重试。');
  return lines.join('\n') + '\n';
}
module.exports = { prepareComparison, runComparison, scoreReadOnlyFiles, formatComparison, expectedTreeHash, validateRules, CODEX_CONFIG };
