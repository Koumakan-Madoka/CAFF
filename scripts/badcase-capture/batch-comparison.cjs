// HOST ONLY. One immutable candidate, one frozen source split, no auto retries.
const crypto = require('node:crypto'), path = require('node:path');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { createWikiStore } = require(base + 'wiki-store');
const { wikiComparisonTotals: totalsFor } = require(base + 'wiki-comparison-store');
const { resolveWikiCandidate } = require(base + 'wiki-candidate');
const { planReplaySplit } = require(base + 'wiki-split');
const { prepareComparison, runComparison } = require('./direct-comparison.cjs');
const { prepareGlobalBatch } = require('./global-batch-plan.cjs');
const { readCaffDeepseekKey, validKey, DEEPSEEK_PROFILE } = require('./direct-model.cjs');
const fail = code => Object.assign(Error(code), { code });
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const variants = ['original', 'candidate'];
function prepareBatch(config, options = {}) {
  const scopeFields = config?.globalRoot === undefined ? ['captureRoot', 'projectId'] : ['globalRoot'];
  if (!config || Object.keys(config).some(k => ![...scopeFields, 'sourceWorktree', 'candidateId', 'repoRoot', 'dependencyRoot', 'image', 'repeats', 'timeoutMs', 'cases'].includes(k))
    || !Array.isArray(config.cases) || !config.cases.length || config.cases.length > 20
    || !path.isAbsolute(config.repoRoot || '') || !path.isAbsolute(config.dependencyRoot || '')
    || !/^sha256:[a-f0-9]{64}$/.test(config.image?.imageId || '')
    || !Number.isSafeInteger(config.repeats ?? 3) || (config.repeats ?? 3) < 1 || (config.repeats ?? 3) > 20
    || config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 300000)) throw fail('evaluation_batch_config_invalid');
  if (config.globalRoot !== undefined) return prepareGlobalBatch(config, options);
  const state = createWikiStore(config).read(), split = state.replaySplit;
  if (!split) throw fail('evaluation_batch_split_required');
  const expectedSplit = planReplaySplit(split.caseIds);
  if (Object.keys(expectedSplit).some(k => JSON.stringify(expectedSplit[k]) !== JSON.stringify(split[k]))) throw fail('evaluation_batch_split_invalid');
  const candidate = state.candidates.find(c => c.id === config.candidateId);
  if (!candidate) throw fail('wiki_candidate_confirmation_required');
  resolveWikiCandidate(state, candidate.id, candidate.anchor.originalRoleHash, []);
  const version = state.versions.find(v => v.id === candidate.versionId);
  if (version.caseIds.some(id => split.testCaseIds.includes(id))) throw fail('evaluation_batch_holdout_exposed');
  const selected = new Map(), sealedIdentities = new Set();
  for (const item of config.cases) {
    if (!item || Object.keys(item).sort().join(',') !== 'request,rules,sourceCaseId'
      || selected.has(item.sourceCaseId)) throw fail('evaluation_batch_cases_invalid');
    const source = state.cases.find(c => c.id === item.sourceCaseId);
    // Screening may need a different task from an already exposed training
    // source. Never redraw the frozen holdout or label a new source as test.
    if (!split.caseIds.includes(item.sourceCaseId)
      && (!source || source.split !== 'train' || !version.caseIds.includes(source.id))) throw fail('evaluation_batch_cases_invalid');
    if (!source || source.role !== 'GPT' || source.split !== (split.testCaseIds.includes(source.id) ? 'test' : 'train')) throw fail('evaluation_batch_split_invalid');
    if (item.request !== null) {
      const a = item.request?.association;
      if (item.request?.captureRoot !== config.captureRoot || a?.projectId !== config.projectId || a?.agentId !== 'role-family-gpt') throw fail('evaluation_batch_cases_invalid');
      const identity = JSON.stringify([a.projectId, a.checkpointId]);
      if (sealedIdentities.has(identity)) throw fail('evaluation_batch_cases_invalid');
      sealedIdentities.add(identity);
    } else if (item.rules !== null) throw fail('evaluation_batch_cases_invalid');
    selected.set(item.sourceCaseId, item);
  }
  // Keep every original slot (explicitly unsupported when necessary) so a
  // screened replacement cannot silently drop difficult held-out cases.
  if (split.caseIds.some(id => !selected.has(id))) throw fail('evaluation_batch_cases_invalid');
  const additionalTrainingCaseIds = [...selected.keys()].filter(id => !split.caseIds.includes(id)).sort();
  const prepared = [...split.caseIds, ...additionalTrainingCaseIds].map(sourceCaseId => {
    const item = selected.get(sourceCaseId), splitName = split.testCaseIds.includes(sourceCaseId) ? 'test' : 'train';
    if (item.request === null) return { sourceCaseId, split: splitName, supported: false, reason: 'no_sealed_replay' };
    const comparisonConfig = { repoRoot: config.repoRoot, dependencyRoot: config.dependencyRoot, image: config.image,
      request: item.request, repeats: config.repeats ?? 3, rules: item.rules,
      wikiCandidate: { sourceWorktree: config.sourceWorktree, candidateId: candidate.id },
      modelProfile: DEEPSEEK_PROFILE, keySource: 'caff-deepseek', ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) };
    // All inputs, approved sources, role hashes and literal leak checks are
    // evaluated before ANY key or model use, including the last test case.
    const plan = prepareComparison(comparisonConfig, options);
    return { sourceCaseId, split: splitName, supported: plan.supported, ...(plan.supported ? { comparison: plan.summary, comparisonConfig } : { reason: plan.reason }) };
  });
  const supportedCount = prepared.filter(c => c.supported).length;
  const summary = { kind: 'wiki-batch-comparison-v1', configHash: hash(config), projectId: config.projectId, model: DEEPSEEK_PROFILE,
    candidate: { id: candidate.id, candidateRoleHash: candidate.candidateRoleHash, versionId: candidate.versionId, entryIds: candidate.entryIds },
    split: expectedSplit, additionalTrainingCaseIds, repeats: config.repeats ?? 3, wikiTrainingCount: version.caseIds.length, preparedReplayableCount: supportedCount,
    disclosures: [...(supportedCount < 6 ? ['fewer_than_6_prepared_replays'] : []), ...(version.caseIds.length < 10 ? ['fewer_than_10_wiki_training_cases'] : [])],
    cases: prepared.map(({ comparisonConfig, ...record }) => record) };
  return { summary: { ...summary, planHash: hash(summary) }, prepared };
}
async function runBatch(config, options = {}) {
  const fixed = structuredClone(config), plan = prepareBatch(fixed, options);
  if (options.confirmed !== true || options.expectedPlanHash !== plan.summary.planHash) throw fail('evaluation_batch_confirmation_required');
  const emit = options.onEvent || (() => {}), results = [], executionId = crypto.randomUUID();
  let key, stopped = false, runtimeHash = null;
  if (plan.prepared.some(c => c.supported)) {
    key = validKey((options.readKey || readCaffDeepseekKey)());
    const serialized = JSON.stringify(plan.summary);
    if (serialized.includes(key) || serialized.includes(JSON.stringify(key).slice(1, -1))) throw fail('evaluation_output_contains_key');
  }
  emit({ event: 'batch_plan', ...plan.summary, executionId });
  for (const item of plan.prepared) {
    let result = { sourceCaseId: item.sourceCaseId, split: item.split,
      ...(item.category ? { category: item.category, replayId: item.replayId || null, fixture: item.fixture || null } : {}), comparison: item.comparison || null,
      status: 'not-run', runs: [], modelCallsKnown: 0, callsUnavailable: false };
    if (!item.supported) result = { ...result, status: 'unsupported', reason: item.reason };
    else if (!stopped) {
      const observedRuns = [], calls = new Map();
      try {
        const fresh = prepareBatch(fixed, options);
        if (fresh.summary.planHash !== plan.summary.planHash) throw fail('evaluation_batch_input_changed');
        const comparison = await runComparison(item.comparisonConfig, { ...options, confirmed: true, readKey: () => key,
          onEvent: event => {
            if (event.event === 'plan') {
              if (runtimeHash !== null && runtimeHash !== event.runtimeHash) throw fail('evaluation_batch_runtime_changed');
              runtimeHash = event.runtimeHash;
            }
            if (event.event === 'model_call') {
              const index = event.variant + ':' + event.iteration;
              if (!calls.has(index)) calls.set(index, []); calls.get(index).push(event);
            }
            if (event.event === 'run') observedRuns.push({ ...event, modelCalls: calls.get(event.variant + ':' + event.iteration) || [] });
            emit({ ...event, sourceCaseId: item.sourceCaseId, split: item.split, ...(item.category ? { category: item.category } : {}) });
          } });
        result = { ...result, status: comparison.supported ? (comparison.completed ? 'completed' : 'error') : 'unsupported',
          ...(comparison.reason ? { reason: comparison.reason } : {}), runs: comparison.runs,
          modelCallsKnown: comparison.modelCallsKnown, callsUnavailable: comparison.callsUnavailable === true };
        if (!comparison.supported || !comparison.completed) stopped = true;
      } catch {
        // Preserve already observed rows/calls. An unrecorded active slot is
        // an infrastructure error with UNKNOWN call completeness, never pass
        // or a fabricated zero-call task. No automatic retry of that slot.
        const next = variants.flatMap(variant => Array.from({ length: plan.summary.repeats }, (_, i) => ({ variant, iteration: i + 1 })))
          .find(slot => !observedRuns.some(r => r.variant === slot.variant && r.iteration === slot.iteration));
        if (next) observedRuns.push({ ...next, status: 'error', reason: 'case_execution_failed', modelCalls: calls.get(next.variant + ':' + next.iteration) || [] });
        result = { ...result, status: 'error', reason: 'case_execution_failed', runs: observedRuns,
          modelCallsKnown: [...calls.values()].reduce((sum, list) => sum + list.length, 0), callsUnavailable: true }; stopped = true;
      }
    } else result.reason = 'prior_case_error';
    result.totals = totalsFor([result], plan.summary.repeats);
    results.push(result); emit({ event: 'case_summary', ...result });
  }
  const result = { ...plan.summary, executionId, completed: results.every(c => c.status === 'completed'), runtimeHash,
    cases: results, totals: totalsFor(results, plan.summary.repeats),
    bySplit: Object.fromEntries(['train', 'test'].map(split => [split, totalsFor(results.filter(c => c.split === split), plan.summary.repeats)])),
    ...(plan.summary.scope === 'global' ? { byCategory: Object.fromEntries(['reproduction', 'probe', 'control'].map(category => [category, totalsFor(results.filter(c => c.category === category), plan.summary.repeats)])) } : {}),
    modelCallsKnown: results.reduce((n, c) => n + c.modelCallsKnown, 0), callsUnavailable: results.some(c => c.callsUnavailable) };
  emit({ event: 'batch_summary', ...result }); return result;
}
function formatBatch(result) {
  const lines = [result.scope === 'global' ? 'WikiSkill 全局提示词批量对照（不保证提分）' : 'GPT WikiSkill 批量对照（不保证提分）', '计划 ' + result.planHash,
    '材料预检支持 ' + result.preparedReplayableCount + '/' + result.cases.length + '；wiki 训练 ' + result.wikiTrainingCount + '；留出来源 ' + result.split.testCaseIds.length + '；补充训练来源 ' + result.additionalTrainingCaseIds.length,
    '已记录模型请求 ' + result.modelCallsKnown + (result.callsUnavailable ? '（存在未知/不完整调用记录）' : ''),
    '用例\t训练/留出及题型\t执行状态\t原 通过/计划(失败/错误/未运行)\t候选 通过/计划(失败/错误/未运行)'];
  for (const c of result.cases) lines.push([c.sourceCaseId, c.split + (c.category ? '/' + c.category : ''), c.status, ...variants.map(v => {
    const t = c.totals[v]; return `${t.passed}/${t.planned}(${t.failed}/${t.errors}/${t.notRun})`;
  })].join('\t'));
  for (const [name, totals] of [['总体', result.totals], ['训练', result.bySplit.train], ['留出', result.bySplit.test],
    ...(result.byCategory ? [['复现', result.byCategory.reproduction], ['探针', result.byCategory.probe], ['控制', result.byCategory.control]] : [])]) {
    for (const v of variants) {
      const t = totals[v]; lines.push(`${name} ${v}: ${t.passed}/${t.planned} 通过，${t.failed} 失败，${t.errors} 错误，${t.notRun} 未运行；可评分通过率 ${t.passRate === null ? 'N/A' : (100 * t.passRate).toFixed(1) + '%'} (${t.scored}次可评分)`);
    }
  }
  if (result.scope === 'global') {
    lines.push(`本轮固定题组 ${result.cases.length} 题；原划分中未选作本轮任务的训练来源 ${result.excludedSplitTrainingCaseIds.length} 条（未重新划分留出）。`);
    lines.push('题组经原基线筛选，存在选择偏差；只复现了汇报难懂一类，探针与控制题不计作该类失败复现。');
  }
  if (result.disclosures.length) lines.push('披露：' + result.disclosures.join(', '));
  if (!result.completed) lines.push('批次未完整执行；无自动重试。');
  return lines.join('\n') + '\n';
}
module.exports = { prepareBatch, runBatch, totalsFor, formatBatch };
