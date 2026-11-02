// HOST ONLY. Global batch planning derives requests/rubrics from registered
// sealed tasks. Configuration declares all planned source/category slots, never
// replacement text, a project-owned wiki, or caller-provided grading references.
const crypto = require('node:crypto');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { createWikiStore } = require(base + 'wiki-store');
const { resolveGlobalWikiCandidate } = require(base + 'wiki-global-candidate');
const { collectWikiCandidateFiles } = require(base + 'wiki-candidate-files');
const { planReplaySplit } = require(base + 'wiki-split');
const { prepareComparison } = require('./direct-comparison.cjs');
const { DEEPSEEK_PROFILE } = require('./direct-model.cjs');
const fail = code => Object.assign(Error(code), { code });
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function prepareGlobalBatch(config, options = {}) {
  const scope = { globalRoot: config.globalRoot, sourceWorktree: config.sourceWorktree }, state = createWikiStore(scope).read(), split = state.replaySplit;
  if (!split) throw fail('evaluation_batch_split_required');
  const expectedSplit = planReplaySplit(split.caseIds);
  if (Object.keys(expectedSplit).some(k => JSON.stringify(expectedSplit[k]) !== JSON.stringify(split[k]))) throw fail('evaluation_batch_split_invalid');
  const saved = state.candidates.find(c => c.id === config.candidateId && c.kind === 'global-wiki-candidate-v1');
  if (!saved || saved.status !== 'confirmed') throw fail('wiki_candidate_confirmation_required');
  if (saved.target?.kind !== 'global-system-prompt') throw fail('evaluation_target_unsupported');
  const candidate = resolveGlobalWikiCandidate(state, saved.id, saved.targetId, saved.baseHash, collectWikiCandidateFiles(state));
  const version = state.versions.find(v => v.id === candidate.versionId);
  if (version.caseIds.some(id => split.testCaseIds.includes(id))) throw fail('evaluation_batch_holdout_exposed');
  const selected = new Map(), sealedIdentities = new Set();
  for (const item of config.cases) {
    if (!item || Object.keys(item).sort().join(',') !== 'category,sourceCaseId' || selected.has(item.sourceCaseId)
      || !['reproduction', 'probe', 'control'].includes(item.category)) throw fail('evaluation_batch_cases_invalid');
    const source = state.cases.find(c => c.id === item.sourceCaseId);
    if (!source || source.role !== 'GPT' || !split.caseIds.includes(source.id) && !version.caseIds.includes(source.id)) throw fail('evaluation_batch_cases_invalid');
    const splitName = split.testCaseIds.includes(source.id) ? 'test' : 'train';
    if (source.split !== splitName) throw fail('evaluation_batch_split_invalid');
    const replay = state.replayCases.find(c => c.sourceCaseId === source.id);
    if (replay) {
      if (replay.category !== item.category || replay.split !== splitName) throw fail('evaluation_batch_cases_invalid');
      const a = replay.request.association, identity = JSON.stringify([replay.request.captureRoot, a.projectId, a.checkpointId]);
      if (sealedIdentities.has(identity)) throw fail('evaluation_batch_cases_invalid');
      sealedIdentities.add(identity);
    }
    selected.set(source.id, { sourceCaseId: source.id, category: item.category, split: splitName, replay });
  }
  // The approved suite may replace old TRAINING tasks without redrawing the
  // frozen partition. All held-out sources remain mandatory. The exact suite,
  // including missing seals, is bound by the independently confirmed plan hash.
  if (split.testCaseIds.some(id => !selected.has(id))) throw fail('evaluation_batch_cases_invalid');
  let evaluation;
  if (config.evaluation !== undefined) {
    const e = config.evaluation, all = [...selected.keys()];
    if (!e || Object.keys(e).sort().join(',') !== 'gateCaseIds,kind,targetEntryId,testCaseIds' || e.kind !== 'wikiskill-gate-v1'
      || config.repeats !== 10 || candidate.entryIds.length !== 1 || e.targetEntryId !== candidate.entryIds[0]
      || !Array.isArray(e.gateCaseIds) || !e.gateCaseIds.length || !Array.isArray(e.testCaseIds) || !e.testCaseIds.length
      || [...e.gateCaseIds,...e.testCaseIds].length !== all.length || new Set([...e.gateCaseIds,...e.testCaseIds]).size !== all.length
      || all.some(id=>!e.gateCaseIds.includes(id) && !e.testCaseIds.includes(id))
      || e.testCaseIds.length !== split.testCaseIds.length || split.testCaseIds.some(id=>!e.testCaseIds.includes(id))) throw fail('evaluation_gate_config_invalid');
    const entry = version.entries.find(e=>e.id===candidate.entryIds[0]);
    const targetReproductionCaseIds = e.gateCaseIds.filter(id=>selected.get(id).category==='reproduction' && entry.caseIds.includes(id)).sort();
    if (!targetReproductionCaseIds.length || !e.gateCaseIds.some(id=>selected.get(id).category==='control')) throw fail('evaluation_gate_config_invalid');
    evaluation = { ...e, gateCaseIds:[...e.gateCaseIds].sort(),testCaseIds:[...e.testCaseIds].sort(),targetReproductionCaseIds,maxExtraAttemptsPerCase:5 };
  }
  const additionalTrainingCaseIds = [...selected.keys()].filter(id => !split.caseIds.includes(id)).sort();
  const excludedSplitTrainingCaseIds = split.trainCaseIds.filter(id => !selected.has(id));
  const prepared = [...selected.keys()].sort().map(sourceCaseId => {
    const { replay, ...record } = selected.get(sourceCaseId);
    if (evaluation) record.stage = evaluation.gateCaseIds.includes(sourceCaseId) ? 'gate' : 'test';
    if (!replay) return { ...record, supported: false, reason: 'no_sealed_replay' };
    const comparisonConfig = { repoRoot: config.repoRoot, dependencyRoot: config.dependencyRoot, image: config.image,
      request: replay.request, rules: replay.rules, repeats: config.repeats ?? 3,
      ...(evaluation ? { executionPolicy:'alternating-valid-v1' } : {}),
      globalWikiCandidate: { ...scope, candidateId: candidate.id }, modelProfile: DEEPSEEK_PROFILE, keySource: 'caff-deepseek',
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) };
    const plan = prepareComparison(comparisonConfig, options);
    if (plan.supported && plan.summary.checkpointHash !== replay.checkpointHash) throw fail('evaluation_batch_input_changed');
    return { ...record, replayId: replay.id, fixture: replay.fixture, supported: plan.supported,
      ...(plan.supported ? { comparison: plan.summary, comparisonConfig } : { reason: plan.reason }) };
  });
  const supportedCount = prepared.filter(c => c.supported).length;
  const summary = { kind: evaluation ? 'wiki-staged-batch-comparison-v1' : 'wiki-global-batch-comparison-v1', scope: 'global',
    ...(evaluation ? { evaluation } : {}), configHash: hash(config), model: DEEPSEEK_PROFILE,
    candidate: { id: candidate.id, targetId: candidate.targetId, baseHash: candidate.baseHash, candidateHash: candidate.candidateHash,
      versionId: candidate.versionId, entryIds: candidate.entryIds },
    split: expectedSplit, additionalTrainingCaseIds, excludedSplitTrainingCaseIds, repeats: config.repeats ?? 3, wikiTrainingCount: version.caseIds.length, preparedReplayableCount: supportedCount,
    disclosures: ['baseline_screening_selection_bias', 'only_reporting_failures_reproduced',
      ...(evaluation ? ['proxy_model_deepseek','small_sample','not_adoption_evidence'] : []),
      ...(supportedCount < 6 ? ['fewer_than_6_prepared_replays'] : []), ...(version.caseIds.length < 10 ? ['fewer_than_10_wiki_training_cases'] : [])],
    cases: prepared.map(({ comparisonConfig, ...record }) => record) };
  return { summary: { ...summary, planHash: hash(summary) }, prepared };
}
module.exports = { prepareGlobalBatch };
