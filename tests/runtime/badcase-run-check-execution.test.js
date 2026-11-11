// Single-call host kernel, production-shaped marked cases, inert model/judge fakes.
// Authorized real command strings are recorded as DATA, never executed.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { createWikiStore } = require(base + 'wiki-store');
const { createWikiRunStore } = require(base + 'wiki-run-store');
const { buildWikiRunRequest, wikiRunHash } = require(base + 'wiki-run-replay');
const { prepareWikiRunChecks, finishWikiRunChecks } = require(base + 'wiki-run-checks');
const { bindWikiJudge, isWikiJudgeTechnicalError } = require(base + 'wiki-scoring-v2');
const { buildWikiRunWireRequest } = require(base + 'wiki-run-wire');
const { runSingleCallComparison } = require('../../scripts/badcase-capture/single-call-comparison.cjs');
const fixtures = require('../fixtures/wikiskill-run-tool-call-command-shapes.json').items;
const model = 'deepseek/deepseek-v4-flash';
const questions = [{ id: 'reply', question: 'The reply gives a clear result.', evidence: 'reply' }];
const toolCheck = (patch = {}) => ({ method: 'code', target: { kind: 'caff-chat', name: 'suggest-goal' }, mode: 'on-call', rules: [{ parameter: 'reason', kind: 'max-chars', max: 1000 }], ...patch });
const message = content => ({ role: 'assistant', stopReason: content.some(b => b.type === 'toolCall') ? 'toolUse' : 'stop', content });
const real = (caseNumber, step) => fixtures.find(f => f.case === caseNumber && f.step === step).toolCalls.map((call, i) => ({ type: 'toolCall', id: 'real-' + i, ...call }));
const send = () => ({ type: 'toolCall', name: 'bash', id: 'public', arguments: { command: 'node "$CAFF_CHAT_TOOLS_PATH" send-public --content "Clear result."' } });
function setup(t, { kind = 'tool', check = toolCheck(), content = real(22, 30), fault } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-run-check-execution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = { globalRoot: path.join(root, 'wiki'), sourceWorktree: path.join(root, 'source') }, store = createWikiStore(scope);
  const c = store.addMarkedCase({ source: { projectId: null, conversationId: 'synthetic', conversationTitle: 'Synthetic run', messageId: 'mark', agentId: 'role-family-gpt' },
    role: 'role-family-gpt', actual: 'bad reason', expected: 'valid reason and clear result', message: 'historical reply', traceState: 'missing', traceExcerpt: '', traceTruncated: false, messageTruncated: false }).case;
  const target = require('../../build/lib/agent-prompt-targets').getGlobalPromptTarget('global-harness-behavior-v1');
  const bundle = { schemaVersion: 1, kind: 'wikiskill-trace-bundle', source: c.source, origin: 'mark', frozenAt: '2026-11-09T00:00:00Z', complete: false, missingReasons: [], redaction: { policy: 'known_values_only' }, markedStep: 1,
    markedMessage: c.message, actual: c.actual, expected: c.expected, context: { systemPrompt: 'prefix\n\nRoom work context:\nfrozen\n\nRules:\n' + target.baseText + '\n- Unchanged rule\n\nRouting instructions:\nfrozen tail', systemPromptSource: 'historical_display', priorSessionEntries: [], trigger: { type: 'message', message: { role: 'user', content: 'Report result.' } } },
    steps: [{ step: 1, output: message([{ type: 'text', text: 'historical reply' }]), toolResults: [] }] };
  store.freezeCaseTrace(c.id, bundle);
  const item = () => store.read().cases.find(r => r.id === c.id);
  const built = require(base + 'wiki-dehydration').buildDehydrationRequest({ caseRecord: item(), bundle, cause: { source: 'trigger', text: 'Report result.' } });
  const rec = store.saveDehydrationRecommendation({ built, response: { model, attempts: [{ finishReason: 'stop', content: JSON.stringify({ kind: '单步型', cutStep: 1, reason: 'reply', evidence: 'historical reply' }) }] }, expectedRevision: store.read().revision });
  const decision = store.confirmDehydration({ caseId: c.id, traceHash: item().traceBundle.hash, recommendationHash: rec.hash, kind: 'single', cutStep: 1, expectedRevision: store.read().revision });
  const draft = store.saveRubricDraft({ caseId: c.id, model, questions: kind === 'tool' ? [] : questions, scoringModel: kind === 'tool' ? null : { backend: 'deepseek', model }, ...(kind === 'reply' ? {} : { toolCheck: check }) }, store.read().revision);
  const rubric = store.confirmRubric({ rubricId: draft.id, hash: draft.hash, confirmationRecord: 'Synthetic user approval' }, store.read().revision);
  const toolset = { codingAgentVersion: '0.85.1', capabilitiesSha: 'a'.repeat(40), capabilitiesFileHash: 'b'.repeat(64), definitions: [{ name: 'bash', description: 'inert schema only', parameters: { type: 'object' } }, { name: 'write', description: 'inert schema only', parameters: { type: 'object' } }] };
  const candidate = { id: 'synthetic-candidate', targetId: target.id, baseText: target.baseText, baseHash: target.baseHash, replacement: 'Synthetic approved replacement' };
  const request = buildWikiRunRequest({ item: item(), bundle, decision, toolset });
  const configuration = { backend: 'deepseek', model, settings: {}, promptHash: 'c'.repeat(64) };
  const scoring = { kind: 'wiki-score-v2', rubric, binding: kind === 'tool' ? null : bindWikiJudge(configuration, rubric), task: 'Report result.', expected: c.expected };
  const config = { ...scope, kind: 'wikiskill-run-comparison-v1', modelProfile: 'openai-codex/gpt-6.1-sol', caseId: c.id, toolset, candidate, scoring,
    originalRequestHash: wikiRunHash(request), candidateRequestHash: wikiRunHash(buildWikiRunRequest({ item: item(), bundle, decision, toolset, candidate })) };
  const requests = [], events = [], outputs = []; let judged = 0, closed = 0;
  const judge = { configuration, async evaluate(input) {
    judged++; assert.deepEqual(Object.keys(input).sort(), ['expected', 'publicReply', 'questions', 'task']); assert.equal(input.publicReply, 'Clear result.');
    if (fault === 'backend') throw Error('DO NOT LEAK UPSTREAM');
    if (fault === 'parse') return 'not JSON';
    return { judgments: input.questions.map(q => ({ criterionId: q.id, verdict: fault === 'fail' ? 'not-satisfied' : 'satisfied', reason: 'Synthetic judgment', evidence: [{ source: 'reply', text: 'Clear result.' }] })) };
  } };
  const options = { confirmed: true, knownValues: [], experimentPlanHash: 'd'.repeat(64), executionId: '1b947e3a-88c8-4a52-a9e1-c32dcd8c99df',
    ...(kind === 'tool' ? {} : { judge }), onEvent: e => events.push(e), createRunClient: async () => ({ state: () => ({ reason: null }), close: async () => { closed++; }, async complete(q) {
      requests.push(structuredClone(q)); const m = message(typeof content === 'function' ? content(q) : content); outputs.push(structuredClone(m));
      return { networkRequests: 1, durationMs: 1, wireRequest: buildWikiRunWireRequest(q), message: m };
    } }) };
  return { root, store, c, item, rubric, request, config, options, requests, outputs, events, judge, judged: () => judged, closed: () => closed, packets: createWikiRunStore(scope), run: () => runSingleCallComparison(config, options) };
}
for (const [caseNumber, step, status] of [[22, 29, 'fail'], [22, 30, 'pass'], [23, 44, 'fail'], [23, 45, 'invalid'], [24, 42, 'fail'], [24, 43, 'pass']]) {
  test(`real #${caseNumber}/${step} tool-only execution is ${status}, one model call per claim and zero judge/tool calls`, async t => {
    const h = setup(t, { content: real(caseNumber, step) }), before = h.store.read(), r = await h.run();
    assert.equal(r.completed, status !== 'invalid'); assert.equal(r.fatal, false);
    const n = status === 'invalid' ? 5 : 20; assert.equal(r.runs.length, n); assert.equal(h.requests.length, n); assert.equal(h.closed(), n); assert.equal(h.judged(), 0);
    assert.ok(r.runs.every(row => row.status === status && row.assessment === undefined && row.toolExecutions === 0));
    for (const [i, row] of r.runs.entries()) {
      const packet = h.packets.read(row.runReplayId), prepared = prepareWikiRunChecks(packet.result.message, h.rubric);
      assert.deepEqual(packet.result.message, h.outputs[i]); assert.deepEqual(packet.result.checks, { rubricHash: h.rubric.hash, prepared });
      assert.equal(packet.result.outcome.status, status); assert.deepEqual(finishWikiRunChecks(prepared), { status: row.checks.status, reason: row.checks.reason });
      assert.deepEqual(packet.reservation.request, h.requests[i]); assert.equal(packet.result.toolExecutions, 0);
      assert.equal(row.checks.rubricHash, h.rubric.hash); assert.equal(row.checks.tool.status, prepared.tool.status);
    }
    assert.ok(h.packets.list().every(row => row.baselineStatus === (status === 'invalid' ? 'no_valid_output' : 'valid_output')));
    assert.deepEqual(h.store.read(), before); assert.doesNotMatch(JSON.stringify(h.requests), /rubricHash|toolCheck|scoringModel/);
    await assert.rejects(h.run(), { code: 'wiki_run_already_reserved' }); assert.equal(h.requests.length, n);
  });
}
for (const [shape, status, votes] of [['tool-fail', 'fail', 0], ['both-pass', 'pass', 60], ['reply-fail', 'fail', 60], ['target-only', 'pass', 0], ['reply-only', 'pass', 60], ['other-only', 'invalid', 0]]) {
  test(`dual execution ${shape}: tool first, independent reachability, judge votes=${votes}`, async t => {
    const content = shape === 'tool-fail' ? [send(), ...real(22, 29)] : ['both-pass', 'reply-fail'].includes(shape) ? [send(), ...real(22, 30)]
      : shape === 'target-only' ? real(22, 30) : shape === 'reply-only' ? [send()] : [{ type: 'toolCall', id: 'write', name: 'write', arguments: { path: 'MUST-NOT-EXIST', content: 'not written' } }];
    const h = setup(t, { kind: 'both', content, fault: shape === 'reply-fail' ? 'fail' : undefined }), r = await h.run();
    assert.equal(h.judged(), votes); assert.ok(r.runs.every(row => row.status === status));
    assert.equal(h.requests.length, status === 'invalid' ? 5 : 20);
    assert.ok(r.runs.every(row => (row.assessment !== undefined) === (votes > 0)));
    assert.ok(r.runs.every(row => row.toolExecutions === 0)); assert.equal(fs.existsSync(path.join(h.root, 'MUST-NOT-EXIST')), false);
    if (shape === 'tool-fail') assert.ok(r.runs.every(row => row.checks.reason === 'tool_rule_failed'));
    if (shape === 'reply-fail') assert.ok(r.runs.every(row => row.checks.reason === 'reply_check_failed'));
  });
}
for (const [position, args] of [['trailing', '--content "Clear result." --no-finalize'], ['middle', '--no-finalize --content "Clear result."']]) {
  for (const mode of ['on-call', 'forbid']) test(`${position} send-public switch reaches the real scoring path in ${mode} mode without executing tools`, async t => {
    const check = toolCheck({ target: { kind: 'caff-chat', name: 'send-public' }, mode, rules: [
      { parameter: 'content', kind: 'max-chars', max: 1000 }, { parameter: 'no-finalize', kind: 'max-chars', max: 4 },
    ] });
    const content = [{ type: 'toolCall', id: 'public', name: 'bash', arguments: { command: 'node "$CAFF_CHAT_TOOLS_PATH" send-public ' + args } }];
    const h = setup(t, { kind: 'both', check, content }), r = await h.run();
    assert.equal(r.completed, true); assert.equal(h.requests.length, 20); assert.equal(h.judged(), 60);
    assert.ok(r.runs.every(row => row.status === 'pass' && row.checks.tool.status === 'pass' && row.assessment && row.toolExecutions === 0));
    const packet = h.packets.read(r.runs[0].runReplayId);
    assert.equal(packet.result.checks.prepared.reply, 'Clear result.'); assert.equal(packet.result.checks.prepared.needsReplyJudge, true);
    assert.equal(packet.result.outcome.status, 'reached', 'raw reply still awaits scoring rather than being declared passed');
  });
}
for (const fault of ['backend', 'parse']) test(`dual reply judge ${fault} remains error, occupies existing slot and never becomes invalid/replacement`, async t => {
  const h = setup(t, { kind: 'both', content: [send(), ...real(22, 30)], fault }), r = await h.run();
  assert.equal(r.fatal, false); assert.equal(r.completed, false); assert.equal(r.runs.length, 20); assert.equal(h.requests.length, 20); assert.equal(h.judged(), 40);
  assert.ok(r.runs.every(row => row.status === 'error' && row.reason === (fault === 'backend' ? 'judge_backend_failed' : 'judge_output_invalid') && isWikiJudgeTechnicalError(row.assessment)));
  assert.ok(r.runs.every(row => row.checks.status === 'error' && row.checks.reason === row.reason));
  assert.equal(r.runs.filter(row => row.status === 'invalid').length, 0);
});
test('forbid execution accepts ordinary continuation without tools being executed', async t => {
  const h = setup(t, { check: toolCheck({ mode: 'forbid', rules: [{ parameter: 'action', kind: 'forbidden-values', values: ['pause'] }] }), content: [{ type: 'toolCall', id: 'bash', name: 'bash', arguments: { command: 'cd x && npm test\ngit status --short' } }] });
  const r = await h.run(); assert.equal(r.completed, true); assert.equal(h.judged(), 0); assert.equal(h.requests.length, 20);
  assert.ok(r.runs.every(row => row.status === 'pass' && row.toolExecutions === 0));
});
test('legacy reply-only path keeps original raw packet/outcome/row shape and model request unchanged', async t => {
  const h = setup(t, { kind: 'reply', content: [{ type: 'text', text: 'Clear result.' }] }), r = await h.run();
  assert.equal(r.completed, true); assert.equal(h.judged(), 60); assert.equal(h.requests.length, 20);
  assert.ok(r.runs.every(row => row.status === 'pass' && !Object.hasOwn(row, 'checks')));
  const packet = h.packets.read(r.runs[0].runReplayId);
  assert.ok(!Object.hasOwn(packet.result, 'checks')); assert.deepEqual(packet.result.outcome, { status: 'reached', reason: null, reply: 'Clear result.' });
  assert.deepEqual(packet.reservation.request, h.request); assert.deepEqual(h.requests[0], h.request);
});
test('explicit null tool check retains legacy mixed-tool invalidity and packet shape', async t => {
  const h = setup(t, { kind: 'both', check: null, content: [send(), ...real(22, 30)] }), r = await h.run();
  assert.equal(h.judged(), 0); assert.equal(h.requests.length, 5); assert.ok(r.runs.every(row => row.status === 'invalid' && row.reason === 'other_tool_requested' && !Object.hasOwn(row, 'checks')));
  assert.ok(!Object.hasOwn(h.packets.read(r.runs[0].runReplayId).result, 'checks'));
});
test('unparseable target arguments suppress the reply judge, even with a separate public reply', async t => {
  const h = setup(t, { kind: 'both', content: [send(), ...real(23, 45)] }), r = await h.run();
  assert.equal(h.judged(), 0); assert.equal(h.requests.length, 5); assert.ok(r.runs.every(row => row.status === 'invalid' && row.checks.reason === 'arguments_unparseable'));
});
test('native structured multiple calls are checked without ever dispatching them', async t => {
  const check = toolCheck({ target: { kind: 'native', name: 'write' }, rules: [{ parameter: 'path', kind: 'allowed-values', values: ['allowed'] }] });
  const content = ['allowed', 'forbidden'].map((p, i) => ({ type: 'toolCall', id: 'write-' + i, name: 'write', arguments: { path: p, content: 'inert' } }));
  const h = setup(t, { check, content }), r = await h.run();
  assert.equal(h.requests.length, 20); assert.equal(h.judged(), 0); assert.ok(r.runs.every(row => row.status === 'fail' && row.toolExecutions === 0));
});
for (const status of ['pass', 'fail', 'reached']) test(`formal run Markdown preserves the Chinese ${status} classification and immutable evidence`, async t => {
  const h = setup(t, status === 'reached' ? { kind: 'reply', content: [{ type: 'text', text: 'Clear result.' }] }
    : { content: real(22, status === 'pass' ? 30 : 29) });
  assert.equal(h.c.kind, 'marked-badcase'); assert.equal(h.c.role, 'role-family-gpt'); assert.ok(!h.item().sealedCheckpointId);
  if (status !== 'reached') { assert.deepEqual(h.rubric.questions, []); assert.ok(h.rubric.toolCheck); }
  const r = await h.run(), row = r.runs.find(r => r.variant === 'original');
  const packet = { accounting: h.packets.list().find(r => r.id === row.runReplayId), ...h.packets.read(row.runReplayId) };
  assert.equal(packet.accounting.status, status); assert.ok(!packet.accounting.reportOnly);
  const before = JSON.stringify(packet), md = require(base + 'wiki-run-export').wikiRunMarkdown(packet);
  const title = md.split('\n').find(line => line.startsWith('当前分类：'));
  if (status === 'reached') {
    assert.match(title, /^当前分类：有效输出（(?:待判分|未判分)）。$/); assert.doesNotMatch(title, /通过|失败/);
  } else assert.equal(title, `当前分类：已判${status === 'pass' ? '通过' : '失败'}（代码判断）。`);
  assert.doesNotMatch(md, /未知分类|只出报告，不作采纳依据/);
  assert.equal(JSON.stringify(packet), before); assert.deepEqual(h.packets.read(row.runReplayId).result, packet.result);
  assert.equal(packet.accounting.resultHash, wikiRunHash(packet.result));
});
test('tool-only binding must be explicitly null, and stale frozen rubric rejects before client creation', async t => {
  const h = setup(t); h.config.scoring.binding = {};
  await assert.rejects(h.run()); assert.equal(h.requests.length, 0);
  h.config.scoring.binding = null; h.config.scoring.rubric.hash = 'f'.repeat(64);
  await assert.rejects(h.run()); assert.equal(h.requests.length, 0);
});
