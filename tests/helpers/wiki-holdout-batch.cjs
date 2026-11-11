// Owned production-shaped synthetic snapshot. All prechecks are explicitly
// fake scored evidence; the host comparison preflight is replaced, never the
// selection/admission checks. No auth, container, network or real model.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { wikiValueHash: hash } = require(base + 'wiki-rubric');
module.exports = function batchFixture(t) {
  const h = require('./wiki-mode-holdout.cjs')({ run24: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-holdout-batch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = { globalRoot: path.join(root, 'global'), sourceWorktree: path.join(root, 'source') };
  const state = { schemaVersion: 1, scope: 'global', ...h.state, candidates: [], replaySplit: null };
  state.versions[0].caseIds = [h.marked[5].id];
  state.versions[0].entries[0].guideline = '调用前核对参数长度，再说明下一步。';
  state.versions[0].entries[1].guideline = '先说明结果。';
  for (const replay of state.replayCases) {
    const c = state.cases.find(c => c.id === replay.sourceCaseId);
    Object.assign(replay, { split: c.split, category: 'reproduction', task: 'Synthetic operator label, not user input',
      fixture: { commit: 'b'.repeat(40), sourceCommit: 'b'.repeat(40), sourceSubdirectory: 'synthetic', filesHash: hash('synthetic files') },
      request: { captureRoot: path.join(root, 'capture-' + c.id), association: { ...c.source, checkpointId: c.sealedCheckpointId, turnId: 'synthetic-turn', taskId: 'synthetic-task', runId: 1 }, flagId: 'flag-' + hash(c.id) },
      rules: { kind: 'completion-public-reply-v1' } });
  }
  function snapshot(value) {
    const file = path.join(scope.globalRoot, 'snapshots', String(value.revision).padStart(12, '0') + '.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, checksum: crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'), record: value }) + '\n', { flag: 'wx' });
  }
  snapshot(state);
  const store = require(base + 'wiki-store').createWikiStore(scope);
  const candidate = store.createGlobalCandidate({ versionId: 'version-1', entryIds: ['entry-6'], targetId: 'global-harness-behavior-v1', files: [] });
  store.confirmGlobalCandidate({ candidateId: candidate.id, candidateHash: candidate.candidateHash, expectedRevision: store.read().revision, files: [] });
  const records = require(base + 'wiki-original-precheck-store').createWikiOriginalPrecheckStore(scope);
  const cache = require(base + 'wiki-pipeline-prechecks').createWikiPipelinePrecheckStore(scope);
  for (const record of h.records) {
    const claim = records.reserve(record.reservation.plan);
    records.finish(claim.id, { status: record.result.status, reason: record.result.reason, runs: record.result.runs });
    const e = record.reservation.plan.execution;
    cache.getOrCompute({ level: 'trace', replayId: e.replayId, checkpointHash: e.checkpointHash }, () => ({ status: 'supported' }));
  }
  const definition = { kind: 'wiki-experiment-v3', variants: [{ id: 'original', promptHash: candidate.baseHash }, { id: 'candidate', promptHash: candidate.candidateHash }],
    runner: { model: 'openai-codex/gpt-6.1-sol', settings: { ...require('../../scripts/badcase-capture/direct-comparison.cjs').CODEX_CONFIG } },
    repeats: 10, executionPolicy: 'alternating-valid-v1', decision: { kind: 'wikiskill-holdout-gate-v1', alpha: .05, maxExtraAttemptsPerCase: 5 },
    cases: [h.marked[6], h.marked[7]].map(c => ({ caseId: c.id, judge: null })).sort((a, b) => a.caseId.localeCompare(b.caseId)) };
  const config = { ...scope, repoRoot: root, dependencyRoot: root, image: { imageId: 'sha256:' + '1'.repeat(64) }, candidateId: candidate.id,
    modelProfile: definition.runner.model, keySource: 'caff-codex-access', codexAuthFile: path.join(root, 'never-created-auth.json'), repeats: 10,
    evaluation: { kind: 'wikiskill-holdout-gate-v1', targetEntryId: 'entry-6' }, experiment: { definition },
    cases: definition.cases.map(c => ({ sourceCaseId: c.caseId, category: 'reproduction', rubricHash: store.read().rubrics.find(r => r.caseId === c.caseId).hash,
      repository: { sourceRoot: root, head: 'b'.repeat(40) }, dependencies: { kind: 'npm-ci-linux-v1', cacheRoot: path.join(root, 'cache') } })) };
  const calls = [];
  const options = { collectProductionCandidateFiles: () => [], prepareProductionTask: () => 'Synthetic original triggering user task',
    prepareProductionComparison(c) { calls.push(c); return { supported: true, summary: { checkpointId: c.request.association.checkpointId,
      checkpointHash: store.read().replayCases.find(r => r.sourceCaseId === c.scoring.rubric.caseId).checkpointHash,
      rulesHash: hash(c.rules), commonInputHash: hash('synthetic common input'), scoring: require('../../scripts/badcase-capture/wiki-receipt-scoring.cjs').wikiScoringSummary(c.scoring) } }; } };
  function makeRunCase(number = 24, { pass = false, usage } = {}) {
    const id = h.marked[number - 17].id, s = store.read(), source = s.cases.find(c => c.id === id);
    delete source.sealedCheckpointId; delete source.traceBundle; s.replayCases = s.replayCases.filter(r => r.sourceCaseId !== id); s.revision++; snapshot(s);
    const target = require('../../build/lib/agent-prompt-targets').getGlobalPromptTarget('global-harness-behavior-v1'), task = 'Synthetic run triggering task';
    const bundle = { schemaVersion: 1, kind: 'wikiskill-trace-bundle', source: source.source, origin: 'mark', frozenAt: '2026-11-11T00:00:00Z', complete: false,
      missingReasons: [], redaction: { policy: 'known_values_only' }, markedStep: 42, markedMessage: source.message, actual: source.actual, expected: source.expected,
      context: { systemPrompt: 'prefix\n\nRoom work context:\nfrozen\n\nRules:\n' + target.baseText + '\n- Extra unchanged rule\n\nRouting instructions:\nfrozen tail',
        systemPromptSource: 'historical_display', priorSessionEntries: [], trigger: { type: 'message', message: { role: 'user', content: task } } },
      steps: Array.from({ length: 42 }, (_, i) => ({ step: i + 1, output: { role: 'assistant', content: [{ type: 'text', text: i === 41 ? source.message : 'synthetic history ' + i }] }, toolResults: [] })) };
    store.freezeCaseTrace(id, bundle);
    const item = () => store.read().cases.find(c => c.id === id);
    const built = require(base + 'wiki-dehydration').buildDehydrationRequest({ caseRecord: item(), bundle, cause: { source: 'trigger', text: task } });
    const rec = store.saveDehydrationRecommendation({ built, response: { model: 'deepseek/deepseek-v4-flash', attempts: [{ finishReason: 'stop', content: JSON.stringify({ kind: '单步型', cutStep: 42, reason: 'synthetic decision', evidence: source.message }) }] }, expectedRevision: store.read().revision });
    const decision = store.confirmDehydration({ caseId: id, traceHash: item().traceBundle.hash, recommendationHash: rec.hash, kind: 'single', cutStep: 42, expectedRevision: store.read().revision });
    cache.getOrCompute({ level: 'run', traceHash: item().traceBundle.hash, decisionHash: decision.hash }, () => ({ status: 'supported' }));
    const state = store.read(), rubric = state.rubrics.find(r => r.caseId === id);
    const plan = require(base + 'wiki-original-precheck').createWikiOriginalPrecheckPlan({ state, caseId: id, rubricHash: rubric.hash, inputHash: hash('synthetic run precheck input'),
      replayChecks: require(base + 'wiki-pipeline-prechecks').readWikiPipelineInputs(state, cache), judge: null });
    const claim = records.reserve(plan); records.finish(claim.id, { status: 'completed', reason: null, runs: Array.from({ length: plan.policy.repeats }, (_, i) => ({ iteration: i + 1, variant: 'original', status: pass ? 'pass' : 'fail',
      artifactId: 'synthetic-run-' + i, artifactHash: hash('synthetic run output ' + i), usageComplete: true, ...(usage ? { usage } : {}) })) });
    const selection = config.cases.find(c => c.sourceCaseId === id); delete selection.repository; delete selection.dependencies;
    options.runToolset = { codingAgentVersion: '0.85.1', capabilitiesSha: 'a'.repeat(40), capabilitiesFileHash: 'b'.repeat(64), definitions: [{ name: 'bash', description: 'synthetic inert schema', parameters: { type: 'object' } }] };
    return { id, task, decision, item, bundle };
  }
  return { ...h, root, scope, store, records, cache, config, options, calls, snapshot, makeRunCase, makeRun24: () => makeRunCase(24), plan: () => require('../../scripts/badcase-capture/batch-comparison.cjs').prepareBatch(config, options),
    mutate(change) { const s = store.read(); change(s); s.revision++; snapshot(s); return s; } };
};
