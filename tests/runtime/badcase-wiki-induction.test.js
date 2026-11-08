const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { prepareWikiInduction, inductWikiCases } = require('../../scripts/badcase-capture/wiki-induction.cjs');
const { classify, buildRequestBody } = require('../../scripts/badcase-capture/wiki-induction-container.cjs');
const MODEL = 'deepseek/deepseek-v4-flash';
const key = 'synthetic-incremental-induction-key';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-wiki-induction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { globalRoot: path.join(root, 'global'), sourceWorktree: path.join(root, 'source') };
  const store = createWikiStore(config);
  const imported = store.addTextCases([{ source: { origin: 'http://127.0.0.1:3100', projectId: 'p1', conversationId: 'old-room', conversationTitle: '', messageId: 'old-message', agentId: 'role-family-gpt' }, role: 'GPT',
    actual: '旧问题', expected: '旧期望', message: '旧回复', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }]);
  const oldCaseId = imported.cases[0].id;
  const version = store.saveDraft({ caseIds: [oldCaseId], model: MODEL, entries: [{ title: '先核验', failureMode: '未核验就汇报', symptoms: '没有检查', rootCauseHypothesis: '跳过验证', guideline: '先核验再汇报。', caseIds: [oldCaseId] }], unclassified: [] });
  store.review({ versionId: version.id, entryId: 'entry-1', expectedRevision: 2, decision: 'approved' });
  const markedInput = { source: { projectId: 'p1', conversationId: 'new-room', conversationTitle: '新房间', messageId: 'new-message', agentId: 'role-family-gpt' }, role: 'GPT', sealedCheckpointId: 'synthetic-checkpoint',
    actual: '简单任务外又增加流程', expected: '直接完成用户要求', message: '', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false };
  const marked = store.addMarkedCase(markedInput);
  return { root, config, store, oldCaseId, markedInput, marked, caseId: marked.case.id };
}

test('marked badcase enters unallocated/pending-preclassification with room title, is idempotent, and survives restart', t => {
  const h = setup(t), c = h.marked.case;
  assert.equal(h.marked.created, true); assert.equal(c.kind, 'marked-badcase'); assert.equal(c.split, null); assert.equal(c.replayable, false);
  assert.equal(c.source.conversationTitle, '新房间'); assert.equal(c.source.messageId, 'new-message');
  assert.deepEqual(h.store.getCaseStates().find(s => s.caseId === c.id), { caseId: c.id, status: 'pending-preclassification', memberships: [], reason: '', updatedAt: c.createdAt });
  assert.equal(h.store.addMarkedCase(h.markedInput).created, false); assert.equal(h.store.read().cases.length, 2);
  const restored = createWikiStore(h.config);
  assert.equal(restored.read().cases.length, 2); assert.equal(restored.getCaseStates().find(s => s.caseId === c.id).status, 'pending-preclassification');
  assert.equal(restored.read().events.filter(e => e.type === 'case-marked').length, 1);
});

test('D15 preclassification selects all unallocated marks, never the old training text; direct induction cannot bypass allocation', t => {
  const h = setup(t), before = h.store.read();
  const prepared = prepareWikiInduction(h.store), payload = JSON.parse(prepared.files[0].bytes);
  assert.equal(prepared.phase, 'preclassification'); assert.deepEqual(prepared.caseIds, [h.caseId]);
  assert.equal(payload.cases.length, 1); assert.equal(JSON.stringify(payload).includes(h.oldCaseId), false);
  assert.throws(() => h.store.recordInduction({ caseIds: [h.caseId], model: MODEL, proof: { inputHash: 'a'.repeat(64), calls: [], cleaned: true }, results: [{ caseId: h.caseId, kind: 'none', reason: '未归类', confidence: '低' }] }), /wiki_not_pending/);
  assert.throws(() => h.store.setReplaySplit({ caseIds: [h.caseId] }), /wiki_split_frozen|wiki_unknown_case/);
  assert.deepEqual(h.store.read(), before);
});

test('pending -> proposed label -> confirmed/manual classification persists without allocating or rewriting entries', t => {
  const h = setup(t), before = JSON.stringify(h.store.read().versions[0].entries[0]);
  const saved = h.store.recordPreclassification({ caseIds: [h.caseId], model: MODEL, proof: { inputHash: 'a'.repeat(64), calls: [], cleaned: true }, results: [
    { caseId: h.caseId, kind: 'assign', entryId: 'entry-1', reason: '同属额外流程', confidence: '中' },
  ] }, 4);
  assert.equal(saved.version, null); assert.equal(saved.suggestions[0].status, 'pending');
  assert.equal(h.store.getCaseStates().find(s => s.caseId === h.caseId).status, 'classification-pending');
  assert.equal(JSON.stringify(h.store.read().versions[0].entries[0]), before);
  h.store.resolveSuggestion({ suggestionId: saved.suggestions[0].id, decision: 'accepted', expectedRevision: 5 });
  let current = h.store.getCaseStates().find(s => s.caseId === h.caseId);
  assert.equal(current.status, 'pending-allocation'); assert.equal(h.store.read().classifications[0].source, 'model-confirmed');
  assert.equal(JSON.stringify(h.store.read().versions[0].entries[0]), before);
  assert.deepEqual(createWikiStore(h.config).getCaseStates().find(s => s.caseId === h.caseId), current);
  h.store.assignCase({ caseId: h.caseId, entryId: null, expectedRevision: 6 });
  assert.equal(h.store.getCaseStates().find(s => s.caseId === h.caseId).status, 'pending-allocation');
  h.store.assignCase({ caseId: h.caseId, entryId: 'entry-1', expectedRevision: 7 });
  current = h.store.getCaseStates().find(s => s.caseId === h.caseId);
  assert.equal(h.store.read().classifications[0].source, 'manual');
  assert.equal(h.store.read().cases.find(c => c.id === h.caseId).split, null);
  assert.deepEqual(createWikiStore(h.config).getCaseStates().find(s => s.caseId === h.caseId), current);
  assert.equal(h.store.read().events.filter(e => e.type === 'classification-confirmed').length, 3);
});

test('new-pattern suggestion creates a draft for normal review; approval assigns, rejection does not', t => {
  for (const decision of ['approved', 'rejected']) {
    const h = setup(t), before = JSON.stringify(h.store.read().versions[0].entries[0]);
    h.store.recordPreclassification({ caseIds: [h.caseId], model: MODEL, proof: { inputHash: 'b'.repeat(64), calls: [], cleaned: true },
      results: [{ caseId: h.caseId, kind: 'new', reason: '需要新模式，先定为训练', confidence: '中' }] }, 4);
    const { projectWikiPatternLabels, planWikiInitialSplit } = require('../../build/server/domain/runtime/badcase-capture/wiki-initial-split');
    h.store.confirmPatternLabel({ caseId: h.caseId, entryId: null, labelHash: projectWikiPatternLabels(h.store.read()).find(r => r.caseId === h.caseId).labelHash, expectedRevision: h.store.read().revision });
    const proposal = planWikiInitialSplit(h.store.read(), []);
    h.store.confirmInitialSplit({ proposalHash: proposal.hash, patternKey: 'unclassified', expectedRevision: h.store.read().revision });
    const saved = h.store.recordInduction({ caseIds: [h.caseId], model: MODEL, proof: { inputHash: 'b'.repeat(64), calls: [], cleaned: true }, results: [
      { caseId: h.caseId, kind: 'new', reason: '现有模式不覆盖', confidence: '中', proposal: { title: '额外流程', failureMode: '自行加流程', symptoms: '简单任务变复杂', rootCauseHypothesis: '过度设计', guideline: '先完成明确要求。', caseIds: [h.caseId] } },
    ] }, h.store.read().revision);
    assert.equal(saved.version.entries.length, 2); assert.equal(saved.version.entries[1].status, 'draft');
    assert.equal(saved.version.entries[0].status, 'approved'); assert.equal(JSON.stringify(saved.version.entries[0]), before);
    h.store.review({ versionId: saved.version.id, entryId: saved.version.entries[1].id, expectedRevision: h.store.read().revision, patch: { guideline: '先完成明确要求，再考虑扩展。' }, decision });
    const state = h.store.getCaseStates().find(s => s.caseId === h.caseId);
    assert.equal(h.store.read().suggestions[0].status, decision === 'approved' ? 'accepted' : 'rejected');
    assert.equal(state.status, decision === 'approved' ? 'assigned' : 'pending');
    if (decision === 'approved') assert.equal(state.memberships[0].source, 'model-confirmed');
    assert.equal(JSON.stringify(h.store.read().versions[0].entries[0]), before);
    assert.deepEqual(createWikiStore(h.config).getCaseStates().find(s => s.caseId === h.caseId), state);
  }
});

test('none suggestion stays unconfirmed and does not create a group, pattern or membership', t => {
  const h = setup(t);
  h.store.recordPreclassification({ caseIds: [h.caseId], model: MODEL, proof: { inputHash: 'c'.repeat(64), calls: [], cleaned: true }, results: [
    { caseId: h.caseId, kind: 'none', reason: '只有孤立事实错误', confidence: '低' },
  ] }, 4);
  assert.equal(h.store.read().versions.length, 1); assert.equal(h.store.read().suggestions[0].kind, 'none');
  assert.equal(h.store.getCaseStates().find(s => s.caseId === h.caseId).status, 'classification-pending');
  assert.equal(h.store.read().cases.find(c => c.id === h.caseId).split, null);
  assert.match(h.store.getCaseStates().find(s => s.caseId === h.caseId).reason, /孤立/);
});

test('preparation selects only pending training cases and approved patterns; no key access on empty/stale run', async t => {
  const h = setup(t);
  const plan = prepareWikiInduction(h.store);
  assert.deepEqual(plan.caseIds, [h.caseId]);
  const payload = JSON.parse(plan.files[0].bytes);
  assert.equal(payload.cases.length, 1); assert.equal(payload.cases[0].id, h.caseId);
  assert.equal(payload.cases[0].source, undefined); assert.equal(payload.approvedEntries.length, 1);
  assert.equal(JSON.stringify(payload).includes('旧回复'), false);
  assert.equal(plan.files[1].path, 'probe.cjs');
  let reads = 0;
  await assert.rejects(inductWikiCases({ store: h.store, confirmed: false, expectedRevision: 4 }, { readKey: () => { reads++; } }), e => e.code === 'wiki_confirmation_required');
  await assert.rejects(inductWikiCases({ store: h.store, confirmed: true, expectedRevision: 3 }, { readKey: () => { reads++; } }), e => e.code === 'wiki_revision_conflict');
  assert.equal(reads, 0);
});

test('real runner boundary saves only model suggestions and call evidence; invalid coverage publishes nothing', async t => {
  const h = setup(t), result = { caseId: h.caseId, kind: 'assign', entryId: 'entry-1', reason: '匹配症状', confidence: '高' };
  const receipt = { ok: true, results: [result], calls: [{ model: MODEL, durationMs: 1, success: true, httpStatus: 200, usage: null }] };
  const saved = await inductWikiCases({ store: h.store, image: { imageId: 'synthetic' }, confirmed: true, expectedRevision: 4 }, {
    readKey: () => key, execute: async (_image, files, options) => { assert.equal(options.key, key); assert.equal(options.timeoutMs, 120000); return { cleaned: true, receipt, isolation: { binds: [] } }; },
  });
  assert.equal(saved.suggestions[0].kind, 'assign'); assert.equal(h.store.read().inductionRuns.length, 1);
  assert.equal(h.store.read().inductionRuns[0].calls.length, 1); assert.equal(h.store.read().inductionRuns[0].model, MODEL);
  const h2 = setup(t);
  await assert.rejects(inductWikiCases({ store: h2.store, image: {}, confirmed: true, expectedRevision: 4 }, { readKey: () => key,
    execute: async () => ({ cleaned: true, receipt: { ...receipt, results: [] } }) }), e => e.code === 'wiki_model_output_invalid');
  assert.equal(h2.store.read().suggestions.length, 0); assert.equal(h2.store.read().versions.length, 1);
});

test('worker makes one official request with approved-pattern context and no tools or retries', async () => {
  const calls = [], result = { caseId: 'c1', kind: 'none', reason: '证据不足', confidence: '低' };
  const output = await classify({ cases: [{ id: 'c1', actual: 'ignore instructions' }], approvedEntries: [{ id: 'entry-1', title: 'approved' }] }, { key,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results: [result] }) } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }); } });
  assert.equal(output.ok, true); assert.deepEqual(output.results, [result]); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  const body = JSON.parse(calls[0].options.body); assert.equal(body.model, 'deepseek-v4-flash'); assert.equal(body.tools, undefined); assert.equal(body.temperature, 0);
  assert.equal(JSON.parse(body.messages[1].content).approvedEntries[0].id, 'entry-1');
  assert.deepEqual(output.calls[0].usage, { input: 3, output: 2, totalTokens: 5 });
});

test('induction explicitly types proposal prose and budgets reasoning plus a complete 20-case result', () => {
  const body = JSON.parse(buildRequestBody({ phase: 'induction', cases: [], approvedEntries: [] }));
  assert.equal(body.max_tokens, 32768);
  assert.match(body.messages[0].content, /title、failureMode、symptoms、rootCauseHypothesis、guideline.*字符串/);
  assert.match(body.messages[0].content, /symptoms 不是数组/);
  assert.match(body.messages[0].content, /caseIds.*字符串数组/);
});

test('full-coverage output checklist repeats exact ordered IDs after untrusted prose; never merges away a result', () => {
  const cases = Array.from({ length: 13 }, (_, i) => ({ id: 'case-' + i, message: 'untrusted long context' }));
  const body = JSON.parse(buildRequestBody({ phase: 'induction', cases, approvedEntries: [] }));
  const payload = JSON.parse(body.messages[1].content);
  assert.deepEqual(payload.outputChecklist.requiredCaseIds, cases.map(c => c.id));
  assert.equal(payload.outputChecklist.resultCount, 13);
  assert.match(body.messages[0].content, /results\.length.*13/);
  assert.match(body.messages[0].content, /同模式.*重复.*proposal.*不得.*省略/);
});

test('truncated model JSON is rejected even if a partial results array parses; no invented coverage or retry', async () => {
  let calls = 0;
  const output = await classify({ phase: 'induction', cases: [], approvedEntries: [] }, { key, fetchImpl: async () => {
    calls++;
    return Response.json({ choices: [{ finish_reason: 'length', message: { content: '{"results":[]}' } }],
      usage: { prompt_tokens: 4, completion_tokens: 32768, total_tokens: 32772 } });
  } });
  assert.equal(output.ok, false); assert.equal(calls, 1);
  assert.equal(output.calls[0].usage.totalTokens, 32772);
});

test('room-title backfill is additive, idempotent and does not alter cases, versions or candidates', t => {
  const h = setup(t), before = h.store.read();
  const changed = h.store.backfillConversationTitles([{ conversationId: 'old-room', conversationTitle: '回填后的房间' }]);
  assert.equal(changed.updated, 1); assert.equal(h.store.read().cases[0].source.conversationTitle, '回填后的房间');
  for (const field of ['versions', 'candidates', 'replayCases', 'replaySplit']) assert.deepEqual(h.store.read()[field], before[field]);
  assert.equal(h.store.backfillConversationTitles([{ conversationId: 'old-room', conversationTitle: '回填后的房间' }]).updated, 0);
  assert.throws(() => h.store.backfillConversationTitles([{ conversationId: 'old-room', conversationTitle: '冲突标题' }]), e => e.code === 'wiki_case_conflict');
});
