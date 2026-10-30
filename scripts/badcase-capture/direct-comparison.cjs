// Trusted CLI orchestration for one explicitly selected portable sealed case.
// No model gateway, auto prompt generation, secret discovery, or self-scoring.
const crypto = require('node:crypto');
const path = require('node:path');
const { prepareSealedDirectTurn } = require('./sealed-direct-input.cjs');
const { prepareDirectTurnFiles, runDirectDockerTask } = require('./direct-docker.cjs');
const { readEvaluationKey, readCaffDeepseekKey, validKey, modelProfile, DEFAULT_PROFILE, DEEPSEEK_PROFILE } = require('./direct-model.cjs');
const { manifestFor } = require('./pi-probe-materials.cjs');
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const fail = code => Object.assign(Error(code), { code });
function validateRules(rules) {
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
    reply: typeof receipt?.finalText === 'string' && rules.requiredReplyFragments.every(s => receipt.finalText.includes(s)),
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}
function prepareComparison(config, options = {}) {
  if (!config || !Number.isSafeInteger(config.repeats) || config.repeats < 1 || config.repeats > 20
    || Object.keys(config).some(k => !['request', 'repoRoot', 'dependencyRoot', 'image', 'repeats', 'candidateRole', 'rules', 'timeoutMs', 'modelProfile', 'keySource'].includes(k))
    || config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 300000)
    || typeof config.candidateRole !== 'string' || !config.candidateRole.trim()
    || !path.isAbsolute(config.repoRoot || '') || !path.isAbsolute(config.dependencyRoot || '')
    || !/^sha256:[a-f0-9]{64}$/.test(config.image?.imageId || '')) throw fail('evaluation_config_invalid');
  const profile = config.modelProfile ?? DEFAULT_PROFILE;
  modelProfile(profile);
  if (config.keySource !== undefined && !['evaluation-env', 'caff-deepseek'].includes(config.keySource)
    || config.keySource === 'caff-deepseek' && profile !== DEEPSEEK_PROFILE) throw fail('evaluation_config_invalid');
  const rules = validateRules(config.rules), prepare = options.prepare || prepareSealedDirectTurn;
  const original = prepare(config.request), candidate = prepare(config.request, config.candidateRole);
  if (original.supported !== true || candidate.supported !== true) return { supported: false, reason: 'unsupported_or_missing_replay_materials' };
  if (original.provenance.checkpointHash !== candidate.provenance.checkpointHash
    || original.provenance.commonInputHash !== candidate.provenance.commonInputHash) throw fail('evaluation_start_mismatch');
  for (const p of rules.readPaths) if (!original.input.files.some(f => f.path === p)) throw fail('evaluation_rules_invalid');
  for (const p of rules.absentPaths) if (original.input.files.some(f => f.path === p) || !original.input.deletions?.includes(p)) throw fail('evaluation_rules_invalid');
  const inputs = { original: original.input, candidate: candidate.input };
  const summary = { kind: 'sealed-prompt-comparison-v1', caseId: original.provenance.caseId,
    checkpointId: original.provenance.checkpointId, checkpointHash: original.provenance.checkpointHash,
    commonInputHash: original.provenance.commonInputHash, model: profile, repeats: config.repeats,
    imageId: config.image.imageId, rules, rulesHash: hash(JSON.stringify(rules)),
    inputHashes: Object.fromEntries(Object.entries(inputs).map(([v, i]) => [v, hash(JSON.stringify(i))])),
    strictEvalEligible: false };
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
  for (const variant of ['original', 'candidate']) {
    for (let iteration = 1; iteration <= fixed.repeats && !stopped; iteration++) {
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
      if (leaksKey(task)) task = { failed: true, reason: 'evaluation_output_contains_key' };
      const receipt = task?.receipt, row = { variant, iteration, status: 'error', checks: null, finalText: '', modelCalls: [],
        containerId: task?.containerId || null, cleaned: task?.cleaned === true, isolation: task?.isolation || null,
        inputHash: manifests[variant].inputHash };
      const valid = !task?.failed && task?.code === 0 && task?.cleaned === true && receipt?.kind === 'direct-caff-turn-v1'
        && receipt.inputHash === manifests[variant].inputHash && receipt.runtimeHash === manifests[variant].runtimeHash
        && receipt.beforeHash === plan.beforeHash && Array.isArray(receipt.modelCalls) && receipt.modelCalls.length > 0
        && receipt.modelCalls.every(c => c.model === plan.summary.model && typeof c.success === 'boolean' && Number.isFinite(c.durationMs) && c.durationMs >= 0);
      if (valid) {
        row.modelCalls = receipt.modelCalls;
        row.finalText = receipt.finalText;
        modelCallsKnown += row.modelCalls.length;
        for (const [i, call] of row.modelCalls.entries()) emit({ event: 'model_call', variant, iteration, request: i + 1, ...call });
        if (receipt.success === true && receipt.modelCalls.every(c => c.success)) {
          const score = scoreReadOnlyFiles(receipt, plan.summary.rules, plan.beforeHash);
          row.status = score.pass ? 'pass' : 'fail'; row.checks = score.checks;
        } else { row.reason = 'model_turn_failed'; stopped = true; }
      } else { row.reason = 'run_evidence_unavailable'; stopped = true; callsUnavailable = true; }
      // Only accept worker output after verified removal. On an infrastructure
      // failure no score/zero-call claim is fabricated and no variant retries.
      runs.push(row); const { modelCalls: omitted, ...eventRow } = row; emit({ event: 'run', ...eventRow });
    }
  }
  const totals = Object.fromEntries(['original', 'candidate'].map(v => {
    const rows = runs.filter(r => r.variant === v);
    return [v, { planned: fixed.repeats, attempted: rows.length, passed: rows.filter(r => r.status === 'pass').length,
      failed: rows.filter(r => r.status === 'fail').length, errors: rows.filter(r => r.status === 'error').length,
      notRun: fixed.repeats - rows.length }];
  }));
  const result = { ...plan.summary, supported: true, completed: !stopped, runs, totals, modelCallsKnown, callsUnavailable };
  emit({ event: 'summary', completed: result.completed, totals, modelCallsKnown, callsUnavailable });
  return result;
}
function formatComparison(result) {
  if (!result.supported) return '不可回放：缺材料或超出当前支持范围。\n';
  const lines = ['模型：' + result.model, '变体\t轮次\t结果\t模型请求'];
  for (const r of result.runs || []) {
    lines.push([r.variant, r.iteration, r.status, r.reason === 'run_evidence_unavailable' ? 'unknown' : r.modelCalls.length].join('\t'));
    for (const [i, c] of r.modelCalls.entries()) lines.push('  #' + (i + 1) + ' ' + c.model + ' ' + Math.round(c.durationMs) + 'ms ' + (c.success ? 'success' : 'failed') + ' usage=' + JSON.stringify(c.usage ?? null));
  }
  for (const v of ['original', 'candidate']) {
    const t = result.totals?.[v]; if (t) lines.push(v + ': ' + t.passed + '/' + t.planned + ' 通过，' + t.errors + ' 错误，' + t.notRun + ' 未运行');
  }
  if (result.completed === false) lines.push('运行未完成；已停止，未自动重试。');
  return lines.join('\n') + '\n';
}
module.exports = { prepareComparison, runComparison, scoreReadOnlyFiles, formatComparison, expectedTreeHash };
