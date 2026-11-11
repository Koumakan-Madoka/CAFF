// Synthetic scene identity/prefix tests with authorized real command SHAPES.
// These are strings only: no scene restoration, shell execution or real model.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { createWikiStore } = require(base + 'wiki-store');
const { dehydrationAvailability, buildDehydrationPrefix } = require(base + 'wiki-dehydration');
const { pageRecommendationAvailability, preparePageDehydration, recommendDehydration } = require(base + 'wiki-dehydration-runner');
const { planWikiInitialSplit } = require(base + 'wiki-initial-split');
const { planWikiRegroup } = require(base + 'wiki-regroup');
const { projectWikiPipelineStates } = require(base + 'wiki-pipeline');
const shapes = require('../fixtures/wikiskill-run-tool-call-command-shapes.json').items;
function setup(t, caseNumber, cutStep) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-scene-cut-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createWikiStore({ globalRoot: path.join(root, 'wiki'), sourceWorktree: path.join(root, 'source') });
  const c = store.addMarkedCase({ source: { projectId: null, conversationId: 'synthetic-' + caseNumber, conversationTitle: 'Synthetic scene', messageId: 'mark', agentId: 'role-family-gpt' },
    role: 'role-family-gpt', sealedCheckpointId: 'synthetic-scene-' + caseNumber, actual: 'reason exceeds limit', expected: 'reason within limit', message: 'marked reply',
    traceState: 'missing', traceExcerpt: '', traceTruncated: false, messageTruncated: false }).case;
  const calls = shapes.find(r => r.case === caseNumber && r.step === cutStep).toolCalls.map((call, i) => ({ type: 'toolCall', id: 'bad-' + i, ...call }));
  const bundle = { schemaVersion: 1, kind: 'wikiskill-trace-bundle', source: c.source, origin: 'mark', frozenAt: '2026-11-09T00:00:00Z', complete: false,
    missingReasons: [], redaction: { policy: 'known_values_only' }, markedStep: cutStep + 2, markedMessage: 'marked reply', actual: c.actual, expected: c.expected,
    context: { systemPrompt: 'synthetic historical prompt', systemPromptSource: 'historical_display', priorSessionEntries: [], trigger: { type: 'message', message: { role: 'user', content: 'continue the task' } } },
    steps: Array.from({ length: cutStep + 2 }, (_, i) => ({ step: i + 1, output: { role: 'assistant', content: i + 1 === cutStep ? calls : [{ type: 'text', text: i + 1 < cutStep ? 'synthetic history ' + (i + 1) : 'FUTURE-MARKED-REPLY' }] },
      toolResults: i + 1 === cutStep ? calls.map(call => ({ message: { role: 'toolResult', toolCallId: call.id, isError: true, content: [{ type: 'text', text: 'Error: reason exceeds 1000 characters' }] } })) : [] })) };
  store.freezeCaseTrace(c.id, bundle);
  const item = () => store.read().cases.find(r => r.id === c.id);
  return { store, c, bundle, item };
}
function grouping(state, caseId, split) {
  const copy = structuredClone(state);
  copy.cases.find(c => c.id === caseId).split = split;
  copy.versions = [{ id: 'wiki-synthetic', entries: [{ id: 'entry-1', title: 'Reason limit', status: 'approved', caseIds: split === 'train' ? [caseId] : [] }] }];
  copy.classifications = [{ caseId, entryId: 'entry-1', source: 'manual' }];
  return copy;
}
for (const [caseNumber, cutStep] of [[22, 29], [23, 44], [24, 42]]) {
  test(`scene #${caseNumber} can recommend and freeze a cut before marked reply without changing identity, split or grouping hashes`, async t => {
    const h = setup(t, caseNumber, cutStep), before = h.store.read(), bytes = JSON.stringify(h.store.readCaseTrace(h.c.id));
    assert.equal(h.item().kind, 'marked-badcase'); assert.equal(h.item().role, 'role-family-gpt');
    assert.equal(dehydrationAvailability(h.item(), h.bundle).eligible, true);
    assert.equal(pageRecommendationAvailability(h.item(), null, h.bundle).eligible, true);
    const prepared = preparePageDehydration({ store: h.store, caseId: h.c.id, traceHash: h.item().traceBundle.hash, expectedRevision: before.revision });
    let calls = 0;
    const recommendation = await recommendDehydration(prepared, { retryPolicy: 'manual', client: { async ask(request) {
      calls++; assert.equal(request.state.steps[cutStep - 1].step, cutStep);
      return { finishReason: 'stop', content: JSON.stringify({ kind: '单步型', cutStep, reason: 'Fix the tool arguments before calling', evidence: 'Error: reason exceeds 1000 characters' }) };
    } } });
    assert.equal(calls, 1); assert.equal(recommendation.recommendation.cutStepSuggestion, cutStep);
    const input = () => ({ caseId: h.c.id, traceHash: h.item().traceBundle.hash, recommendationHash: recommendation.hash, kind: 'single', cutStep, expectedRevision: h.store.read().revision });
    const decision = h.store.confirmDehydration(input());
    assert.equal(decision.level, 'run'); assert.equal(decision.cutStep, cutStep); assert.ok(cutStep < h.bundle.markedStep);
    assert.equal(pageRecommendationAvailability(h.item(), h.store.getDehydration(h.c.id), h.bundle).eligible, false);
    const revision = h.store.read().revision;
    assert.deepEqual(h.store.confirmDehydration(input()), decision); assert.equal(h.store.read().revision, revision);
    assert.throws(() => h.store.confirmDehydration({ ...input(), cutStep: cutStep + 1 }), { code: 'wiki_dehydration_frozen' });
    const prefix = buildDehydrationPrefix(h.item(), h.bundle, cutStep);
    assert.doesNotMatch(JSON.stringify(prefix), /suggest-goal|FUTURE-MARKED-REPLY/);
    assert.equal(prefix.messages.length, cutStep); assert.equal(prefix.metadata.cutStep, cutStep);
    const after = h.store.read();
    for (const key of ['cases', 'versions', 'replayCases', 'replaySplit', 'classifications', 'patternLabels', 'initialSplitProposals', 'initialSplitConfirmations', 'regroupProposals', 'regroupConfirmations']) assert.deepEqual(after[key], before[key], key);
    assert.equal(JSON.stringify(h.store.readCaseTrace(h.c.id)), bytes);
    const accounting = [{ id: 'synthetic-report', caseId: h.c.id, traceHash: h.item().traceBundle.hash, decisionHash: decision.hash, variant: { kind: 'original' }, status: 'fail', resultHash: 'report-hash', baselineStatus: 'valid_output', caseEligibleForGateAndScreen: true }];
    for (const split of [null, 'train', 'gate', 'test']) {
      const old = grouping(before, h.c.id, split), current = grouping(after, h.c.id, split);
      assert.deepEqual(planWikiInitialSplit(current, accounting), planWikiInitialSplit(old, []), 'run report does not change initial split proposal/hash');
      assert.deepEqual(planWikiRegroup(current, accounting), planWikiRegroup(old, []), 'run report does not change regroup proposal/hash');
      assert.deepEqual(projectWikiPipelineStates({ state: current, runReplays: accounting }), projectWikiPipelineStates({ state: old }), 'run report never enters trace gate counters');
      assert.equal(projectWikiPipelineStates({ state: current })[0].level, 'trace');
    }
  });
}
test('historical scene trace decisions retain existing grouping bytes; run cuts do not erase earlier trace evidence', t => {
  const h = setup(t, 22, 29), state = grouping(h.store.read(), h.c.id, 'gate');
  state.dehydrations = [{ caseId: h.c.id, traceHash: h.item().traceBundle.hash, decision: { kind: 'throughout', level: 'trace', hash: 'old-trace-decision' } }];
  const first = planWikiInitialSplit(state, []), regroup = planWikiRegroup(state, []);
  assert.equal(first.rows[0].decisionHash, 'old-trace-decision'); assert.equal(regroup.rows[0].decisionHash, 'old-trace-decision');
  state.dehydrations.push({ caseId: h.c.id, traceHash: h.item().traceBundle.hash, decision: { kind: 'single', level: 'run', hash: 'new-report-cut' } });
  assert.deepEqual(planWikiInitialSplit(state, []), first); assert.deepEqual(planWikiRegroup(state, []), regroup);
});
