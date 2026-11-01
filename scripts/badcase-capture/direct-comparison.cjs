// Trusted CLI orchestration for one explicitly selected portable sealed case.
// No model gateway, auto prompt generation, secret discovery, or self-scoring.
const crypto = require('node:crypto');
const path = require('node:path');
const { prepareSealedDirectTurn, prepareSealedPromptTarget } = require('./sealed-direct-input.cjs');
const { prepareDirectTurnFiles, runDirectDockerTask } = require('./direct-docker.cjs');
const { readEvaluationKey, readCaffDeepseekKey, validKey, modelProfile, DEFAULT_PROFILE, DEEPSEEK_PROFILE } = require('./direct-model.cjs');
const { manifestFor } = require('./pi-probe-materials.cjs');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { resolveWikiCandidate } = require('../../build/server/domain/runtime/badcase-capture/wiki-candidate');
const { resolveGlobalWikiCandidate } = require('../../build/server/domain/runtime/badcase-capture/wiki-global-candidate');
const { collectWikiCandidateFiles } = require('../../build/server/domain/runtime/badcase-capture/wiki-candidate-files');
const { validateLiteralRules, scoreLiteralFiles } = require('./file-literal-rules.cjs');
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const fail = code => Object.assign(Error(code), { code });
function validateRules(rules) {
  if (rules?.kind === 'file-literals-v1') return validateLiteralRules(rules);
  if (!rules || rules.kind !== 'read-only-files-v1'
    || Object.keys(rules).some(k => !['kind', 'readPaths', 'absentPaths', 'requiredReplyFragments'].includes(k))
    || !Array.isArray(rules.absentPaths) || rules.absentPaths.length > 16 || new Set(rules.absentPaths).size !== rules.absentPaths.length
    || rules.absentPaths.some(p => typeof p !== 'string' || !/^[A-Za-z0-9_.@/-]+$/.test(p) || p.split('/').some(s => !s || s === '.' || s === '..'))
    || !Array.isArray(rules.readPaths) || !rules.readPaths.length || rules.readPaths.length > 16
    || rules.readPaths.some(p => typeof p !== 'string' || !/^[A-Za-z0-9_.@/-]+$/.test(p) || p.split('/').some(s => !s || s === '.' || s === '..'))
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
function prepareComparison(config, options = {}) {
  if (!config || !Number.isSafeInteger(config.repeats) || config.repeats < 1 || config.repeats > 20
    || Object.keys(config).some(k => !['request', 'repoRoot', 'dependencyRoot', 'image', 'repeats', 'candidateRole', 'wikiCandidate', 'globalWikiCandidate', 'rules', 'timeoutMs', 'modelProfile', 'keySource', 'executionPolicy'].includes(k))
    || config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 300000)
    || config.executionPolicy !== undefined && (config.executionPolicy !== 'alternating-valid-v1' || !config.globalWikiCandidate || config.repeats !== 10)
    || [config.candidateRole, config.wikiCandidate, config.globalWikiCandidate].filter(v => v !== undefined).length !== 1
    || config.candidateRole !== undefined && (typeof config.candidateRole !== 'string' || !config.candidateRole.trim())
    || !path.isAbsolute(config.repoRoot || '') || !path.isAbsolute(config.dependencyRoot || '')
    || !/^sha256:[a-f0-9]{64}$/.test(config.image?.imageId || '')) throw fail('evaluation_config_invalid');
  const profile = config.modelProfile ?? DEFAULT_PROFILE;
  modelProfile(profile);
  if (config.keySource !== undefined && !['evaluation-env', 'caff-deepseek'].includes(config.keySource)
    || config.keySource === 'caff-deepseek' && profile !== DEEPSEEK_PROFILE) throw fail('evaluation_config_invalid');
  const rules = validateRules(config.rules);
  let prepare = options.prepare || prepareSealedDirectTurn, globalWikiCandidate = null, globalState, globalSaved, globalFiles;
  if (config.globalWikiCandidate !== undefined) {
    const selection = config.globalWikiCandidate;
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)
      || Object.keys(selection).sort().join(',') !== 'candidateId,globalRoot,sourceWorktree'
      || !path.isAbsolute(selection.globalRoot || '') || !path.isAbsolute(selection.sourceWorktree || '')
      || typeof selection.candidateId !== 'string') throw fail('evaluation_config_invalid');
    globalState = createWikiStore({ globalRoot: selection.globalRoot, sourceWorktree: selection.sourceWorktree }).read();
    globalSaved = globalState.candidates.find(c => c.id === selection.candidateId && c.kind === 'global-wiki-candidate-v1');
    if (!globalSaved || globalSaved.status !== 'confirmed') throw fail('wiki_candidate_confirmation_required');
    if (globalSaved.target?.kind !== 'global-system-prompt') throw fail('evaluation_target_unsupported');
    globalFiles = collectWikiCandidateFiles(globalState);
    resolveGlobalWikiCandidate(globalState, globalSaved.id, globalSaved.targetId, globalSaved.baseHash, globalFiles);
    const prepareTarget = options.prepareTarget || prepareSealedPromptTarget;
    prepare = (request, replacement = null) => prepareTarget(request, globalSaved.targetId, replacement);
  }
  const original = prepare(config.request);
  if (original.supported !== true) return { supported: false, reason: config.globalWikiCandidate ? 'unsupported_or_missing_declared_prompt_target' : 'unsupported_or_missing_replay_materials' };
  let candidateRole = config.candidateRole, wikiCandidate = null;
  if (globalSaved) {
    const selected = resolveGlobalWikiCandidate(globalState, globalSaved.id, original.provenance.targetId,
      original.provenance.originalTargetHash, original.input.files);
    candidateRole = selected.candidateText;
    globalWikiCandidate = { id: selected.id, versionId: selected.versionId, entryIds: selected.entryIds,
      targetId: selected.targetId, baseHash: selected.baseHash, candidateHash: selected.candidateHash };
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
  const candidate = prepare(config.request, candidateRole);
  if (candidate.supported !== true) return { supported: false, reason: config.globalWikiCandidate ? 'unsupported_or_missing_declared_prompt_target' : 'unsupported_or_missing_replay_materials' };
  if (original.provenance.checkpointHash !== candidate.provenance.checkpointHash
    || original.provenance.commonInputHash !== candidate.provenance.commonInputHash) throw fail('evaluation_start_mismatch');
  if (rules.kind === 'read-only-files-v1') {
    for (const p of rules.readPaths) if (!original.input.files.some(f => f.path === p)) throw fail('evaluation_rules_invalid');
    for (const p of rules.absentPaths) if (original.input.files.some(f => f.path === p) || !original.input.deletions?.includes(p)) throw fail('evaluation_rules_invalid');
  }
  // Only requested paths, never literal reference values, enter worker inputs.
  const evidenceConfig = rules.kind === 'file-literals-v1' ? { fileEvidencePaths: rules.files.map(f => f.path) } : {};
  const inputs = { original: { ...original.input, ...evidenceConfig }, candidate: { ...candidate.input, ...evidenceConfig } };
  const summary = { kind: 'sealed-prompt-comparison-v1', caseId: original.provenance.caseId,
    checkpointId: original.provenance.checkpointId, checkpointHash: original.provenance.checkpointHash,
    commonInputHash: rules.kind === 'file-literals-v1' ? hash(JSON.stringify({ sealedCommonInputHash: original.provenance.commonInputHash, ...evidenceConfig })) : original.provenance.commonInputHash,
    model: profile, repeats: config.repeats, ...(config.executionPolicy ? {executionPolicy:config.executionPolicy,maxExtraAttemptsPerCase:5} : {}),
    imageId: config.image.imageId, rules, rulesHash: hash(JSON.stringify(rules)),
    inputHashes: Object.fromEntries(Object.entries(inputs).map(([v, i]) => [v, hash(JSON.stringify(i))])),
    strictEvalEligible: false, ...(wikiCandidate ? { wikiCandidate } : {}),
    ...(globalWikiCandidate ? { targetId: globalWikiCandidate.targetId, globalWikiCandidate } : {}) };
  return { supported: true, inputs, summary, beforeHash: expectedTreeHash(original.input) };
}
async function runComparison(config, options = {}) {
  // A planning call never reads a key or contacts Docker/model services.
  const fixed = structuredClone(config), plan = prepareComparison(fixed, options);
  if (!plan.supported) return { ...plan, runs: [], modelCallsKnown: 0 };
  if (options.confirmed !== true) throw fail('evaluation_confirmation_required');
  const stage = options.stage || prepareDirectTurnFiles, execute = options.execute || runDirectDockerTask;
  const emit = options.onEvent || (() => {}), keyReader = options.readKey || (fixed.keySource === 'caff-deepseek' ? readCaffDeepseekKey : readEvaluationKey);
  const files = {}, manifests = {};
  for (const variant of ['original', 'candidate']) {
    files[variant] = stage(fixed.repoRoot, fixed.dependencyRoot, fixed.image, plan.inputs[variant], fixed.modelProfile);
    manifests[variant] = manifestFor(files[variant]);
  }
  if (manifests.original.runtimeHash !== manifests.candidate.runtimeHash) throw fail('evaluation_runtime_mismatch');
  const key = validKey(keyReader()); // No persistence or argv/env-file creation.
  const leaksKey = value => { const s = JSON.stringify(value) || ''; return s.includes(key) || s.includes(JSON.stringify(key).slice(1, -1)); };
  if (leaksKey(plan.summary)) throw fail('evaluation_output_contains_key');
  emit({ event: 'plan', ...plan.summary, runtimeHash: manifests.original.runtimeHash });
  const runs = []; let stopped = false, modelCallsKnown = 0, callsUnavailable = false;
  const alternating = fixed.executionPolicy === 'alternating-valid-v1';
  const variants = ['original','candidate'], validCount = v => runs.filter(r=>r.variant===v && r.status!=='error').length;
  const legacySlots = variants.flatMap(variant=>Array.from({length:fixed.repeats},(_,i)=>({variant,iteration:i+1})));
  let cursor=0, nextVariant=0, fatal=false;
  while (!stopped) {
      let variant, iteration;
      if (alternating) {
        if (runs.length>=2*fixed.repeats+5 || variants.every(v=>validCount(v)===fixed.repeats)) break;
        if (validCount(variants[nextVariant])===fixed.repeats) nextVariant=1-nextVariant;
        variant=variants[nextVariant]; nextVariant=1-nextVariant;
        iteration=runs.filter(r=>r.variant===variant).length+1;
      } else { const slot=legacySlots[cursor++]; if(!slot) break; ({variant,iteration}=slot); }
      // Recheck seal AND current static distribution; no live-source or fresh
      // fallback if bytes changed after the planned starting point.
      const fresh = prepareComparison(fixed, options);
      if (!fresh.supported || JSON.stringify(fresh.summary) !== JSON.stringify(plan.summary)
        || manifestFor(stage(fixed.repoRoot, fixed.dependencyRoot, fixed.image, fresh.inputs[variant], fixed.modelProfile)).inputHash !== manifests[variant].inputHash) {
        throw fail('evaluation_input_changed');
      }
      let task;
      try { task = await execute(fixed.image, files[variant], { key, network: 'bridge', timeoutMs: fixed.timeoutMs ?? 120000 }); }
      catch { task = { failed: true, reason: 'evaluation_failed' }; }
      const encodedLeak = Array.isArray(task?.receipt?.fileEvidence) && task.receipt.fileEvidence.some(f =>
        typeof f?.base64 === 'string' && Buffer.from(f.base64, 'base64').includes(key));
      if (leaksKey(task) || encodedLeak) task = { failed: true, reason: 'evaluation_output_contains_key' };
      const receipt = task?.receipt, row = { variant, iteration, status: 'error', checks: null, finalText: '', replySource: 'unknown', modelCalls: [],
        containerId: task?.containerId || null, cleaned: task?.cleaned === true, isolation: task?.isolation || null,
        inputHash: manifests[variant].inputHash };
      const valid = !task?.failed && task?.code === 0 && task?.cleaned === true && receipt?.kind === 'direct-caff-turn-v1'
        && receipt.inputHash === manifests[variant].inputHash && receipt.runtimeHash === manifests[variant].runtimeHash
        && receipt.beforeHash === plan.beforeHash && Array.isArray(receipt.modelCalls) && receipt.modelCalls.length > 0
        && receipt.modelCalls.every(c => c.model === plan.summary.model && typeof c.success === 'boolean' && Number.isFinite(c.durationMs) && c.durationMs >= 0);
      if (valid) {
        row.modelCalls = receipt.modelCalls;
        row.finalText = receipt.finalText;
        row.replySource = ['public', 'internal', 'none'].includes(receipt.replySource) ? receipt.replySource : 'unknown';
        modelCallsKnown += row.modelCalls.length;
        for (const [i, call] of row.modelCalls.entries()) emit({ event: 'model_call', variant, iteration, request: i + 1, ...call });
        if (receipt.success === true && receipt.modelCalls.every(c => c.success)) {
          const literal = plan.summary.rules.kind === 'file-literals-v1';
          const score = literal ? scoreLiteralFiles(receipt, plan.summary.rules) : scoreReadOnlyFiles(receipt, plan.summary.rules, plan.beforeHash);
          if (score.available === false) { row.reason = 'file_evidence_unavailable'; stopped = true; }
          else {
            row.status = score.pass ? 'pass' : 'fail'; row.checks = score.checks;
            if (literal) { row.fileEvidence = receipt.fileEvidence; row.fileChecks = score.details; }
          }
        } else {
          row.reason = 'model_turn_failed';
          // Successful HTTP/tool cycles stopped by the model/request ceiling or
          // HTTP-200 truncation are model failures. Provider/network failures
          // remain environmental errors. Legacy single/role runs still stop.
          if (alternating && receipt.modelCalls.every(c=>c.success || c.httpStatus===200)) row.status='fail';
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
        fatal = task?.reason==='evaluation_output_contains_key' || task?.cleaned !== true;
        if (!fatal) stopped=false; // bounded by 20 valid slots + 5 extra attempts
        else stopped=true;
      }
      runs.push(row); const { modelCalls: omitted, ...eventRow } = row; emit({ event: 'run', ...eventRow });
  }
  const totals = Object.fromEntries(['original', 'candidate'].map(v => {
    const rows = runs.filter(r => r.variant === v);
    return [v, { planned: fixed.repeats, attempted: rows.length, passed: rows.filter(r => r.status === 'pass').length,
      failed: rows.filter(r => r.status === 'fail').length, errors: rows.filter(r => r.status === 'error').length,
      notRun: fixed.repeats - (alternating ? rows.filter(r=>r.status!=='error').length : rows.length) }];
  }));
  const result = { ...plan.summary, supported: true, completed: alternating ? variants.every(v=>validCount(v)===fixed.repeats) : !stopped, runs, totals, modelCallsKnown, callsUnavailable,
    ...(alternating ? {fatal} : {}) };
  emit({ event: 'summary', completed: result.completed, totals, modelCallsKnown, callsUnavailable });
  return result;
}
function formatComparison(result) {
  if (!result.supported) return '不可回放：缺材料或超出当前支持范围。\n';
  const lines = ['模型：' + result.model, '变体\t轮次\t结果\t模型请求\t回复来源'];
  for (const r of result.runs || []) {
    lines.push([r.variant, r.iteration, r.status, r.reason === 'run_evidence_unavailable' ? 'unknown' : r.modelCalls.length, r.replySource ?? 'unknown'].join('\t'));
    for (const [i, c] of r.modelCalls.entries()) lines.push('  #' + (i + 1) + ' ' + c.model + ' ' + Math.round(c.durationMs) + 'ms ' + (c.success ? 'success' : 'failed') + ' usage=' + JSON.stringify(c.usage ?? null));
  }
  for (const v of ['original', 'candidate']) {
    const t = result.totals?.[v]; if (t) lines.push(v + ': ' + t.passed + '/' + t.planned + ' 通过，' + t.errors + ' 错误，' + t.notRun + ' 未运行');
  }
  if (result.completed === false) lines.push('运行未完成；已停止，未自动重试。');
  return lines.join('\n') + '\n';
}
module.exports = { prepareComparison, runComparison, scoreReadOnlyFiles, formatComparison, expectedTreeHash, validateRules };
