const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const api = () => require('../../build/server/domain/runtime/badcase-capture/wiki-run-replay');
const hash = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-run-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { globalRoot: path.join(root, 'wiki'), sourceWorktree: path.join(root, 'source') }, store = createWikiStore(options);
  const c = store.addMarkedCase({ source: { projectId: null, conversationId: 'room', conversationTitle: 'room', messageId: 'm', agentId: 'role-family-gpt' }, role: 'role-family-gpt', actual: 'wrong', expected: 'right', message: 'reply', traceState: 'missing', traceExcerpt: '', traceTruncated: false, messageTruncated: false }).case;
  const bundle = { schemaVersion: 1, kind: 'wikiskill-trace-bundle', source: c.source, origin: 'mark', frozenAt: '2026-11-05T00:00:00Z', complete: false, missingReasons: [], redaction: { policy: 'known_values_only' }, markedStep: 2,
    markedMessage: 'reply', actual: 'wrong', expected: 'right', context: { systemPrompt: 'historical [REDACTED]', systemPromptSource: 'historical_display', priorSessionEntries: [], trigger: { type: 'message', message: { role: 'user', content: 'solve this' } } },
    steps: [{ step: 1, output: { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'file' } }] }, toolResults: [{ message: { role: 'toolResult', toolCallId: 'call', content: [{ type: 'text', text: 'full result' }] } }] }, { step: 2, output: { role: 'assistant', content: [{ type: 'text', text: 'CUT OUTPUT MUST NOT ENTER' }] }, toolResults: [] }] };
  store.freezeCaseTrace(c.id, bundle);
  const { buildDehydrationRequest } = require('../../build/server/domain/runtime/badcase-capture/wiki-dehydration');
  const item = () => store.read().cases.find(v => v.id === c.id), built = buildDehydrationRequest({ caseRecord: item(), bundle, cause: { source: 'trigger', text: 'solve this' } });
  const rec = store.saveDehydrationRecommendation({ built, response: { model: 'deepseek/deepseek-v4-flash', attempts: [{ finishReason: 'stop', content: JSON.stringify({ kind: '单步型', cutStep: 2, reason: 'reply', evidence: 'CUT OUTPUT' }) }] }, expectedRevision: store.read().revision });
  const decision = store.confirmDehydration({ caseId: c.id, traceHash: item().traceBundle.hash, recommendationHash: rec.hash, kind: 'single', cutStep: 2, expectedRevision: store.read().revision });
  const toolset = { codingAgentVersion: '0.85.1', capabilitiesSha: 'a'.repeat(40), capabilitiesFileHash: 'b'.repeat(64), definitions: [{ name: 'read', description: 'read', parameters: { type: 'object' } }, { name: 'bash', description: 'bash', parameters: { type: 'object' } }] };
  const request = () => api().buildWikiRunRequest({ item: item(), bundle, decision, toolset });
  return { options, root, store, c, item, bundle, decision, toolset, request };
}
const output = (content, stopReason = 'stop') => ({ role: 'assistant', content, stopReason, model: 'gpt-6.1-sol', provider: 'openai-codex' });
test('request binds frozen decision and exact pre-cut history; only schemas, no executors or future evidence', t => {
  const h = setup(t), q = h.request();
  assert.equal(q.model, 'openai-codex/gpt-6.1-sol'); assert.equal(q.thinking, 'xhigh'); assert.equal(q.metadata.decisionHash, h.decision.hash);
  assert.equal(q.context.systemPrompt, 'historical [REDACTED]'); assert.equal(q.context.messages.at(-1).content[0].text, 'full result');
  assert.equal(q.context.tools.length, 2); assert.equal(q.metadata.toolset.codingAgentVersion, '0.85.1'); assert.doesNotMatch(JSON.stringify(q), /CUT OUTPUT|wrong|right/);
  h.toolset.definitions[0].execute = () => { throw Error('MUST NEVER EXECUTE'); };
  assert.throws(h.request, e => e.code === 'wiki_run_tools_invalid');
  h.toolset.definitions[0].execute = undefined; delete h.toolset.definitions[0].execute;
  h.decision.cutStep = 1; assert.throws(h.request, e => e.code === 'wiki_run_decision_invalid');
});
test('one-step classification accepts replies; other tool use and empty output are invalid, never failures', () => {
  const classify = api().classifyWikiRunOutput;
  assert.equal(classify(output([{ type: 'text', text: 'full reply' }])).status, 'reached');
  const send = { type: 'toolCall', id: 's', name: 'bash', arguments: { command: "cat <<'EOF' | node \"$CAFF_CHAT_TOOLS_PATH\" send-public --content-stdin\nfull <script>reply</script>\nEOF" } };
  assert.equal(classify(output([send], 'toolUse')).reply, 'full <script>reply</script>');
  for (const content of [[{ ...send, arguments: { command: "echo 'send-public --content nope'" } }], [send, { type: 'toolCall', name: 'read', arguments: {} }], [{ type: 'text', text: 'I will inspect' }, { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }], []]) {
    const r = classify(output(content, content.length ? 'toolUse' : 'stop')); assert.equal(r.status, 'invalid'); assert.equal(Object.hasOwn(r, 'countAsFailure'), false); assert.equal(r.reply, null);
  }
});
test('durable reservation prevents duplicate sends after success, failure, crash or competing calls; old wiki state stays identical', async t => {
  const h = setup(t), { createWikiRunStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-run-store');
  const runs = createWikiRunStore(h.options), before = h.store.read(), q = h.request(); let calls = 0, release;
  const input = { store: h.store, runs, caseId: h.c.id, toolset: h.toolset, approvedRequestHash: hash(q) };
  const pending = api().replayWikiRun(input, { client: { complete: async request => { calls++; assert.deepEqual(request, q); return new Promise(r => release = r); } } });
  await assert.rejects(api().replayWikiRun(input, { client: { complete() { calls++; } } }), e => e.code === 'wiki_run_already_reserved');
  release({ message: output([{ type: 'text', text: 'FULL output ' + 'x'.repeat(10000) }]), networkRequests: 1, durationMs: 12 });
  const row = await pending; assert.equal(calls, 1); assert.equal(row.outcome.status, 'reached'); assert.equal(row.toolExecutions, 0); assert.equal(row.modelCalls, 1);
  assert.equal(runs.list()[0].resultHash, hash(row)); assert.deepEqual(runs.read(row.id).result, row);
  await assert.rejects(api().replayWikiRun(input, { client: { complete() { calls++; } } }), e => e.code === 'wiki_run_already_reserved');
  assert.deepEqual(h.store.read(), before); assert.deepEqual(h.store.readCaseTrace(h.c.id), h.bundle);
  const file = path.join(h.options.globalRoot, 'run-replays', row.id + '.result.json'); const env = JSON.parse(fs.readFileSync(file)); env.result.message.content = [];
  fs.writeFileSync(file, JSON.stringify(env)); assert.throws(() => runs.read(row.id), e => e.code === 'wiki_run_record_invalid');
});
test('formal attempts reserve identical frozen requests independently without adding attempt identity to model input', async t => {
  const h = setup(t), { createWikiRunStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-run-store');
  const runs = createWikiRunStore(h.options), q = h.request(), requestHash = hash(q), before = h.store.read(); let calls = 0;
  const attempt = { planHash: 'c'.repeat(64), executionId: '1b947e3a-88c8-4a52-a9e1-c32dcd8c99df', iteration: 1 };
  const input = { store: h.store, runs, caseId: h.c.id, toolset: h.toolset, approvedRequestHash: requestHash, attempt };
  const client = { async complete(request) { calls++; assert.deepEqual(request, q); assert.doesNotMatch(JSON.stringify(request), /executionId|iteration|planHash/);
    return { message: output([{ type: 'text', text: 'result' }]), networkRequests: 1, durationMs: 2 }; } };
  const a = await api().replayWikiRun(input, { client });
  const b = await api().replayWikiRun({ ...input, attempt: { ...attempt, iteration: 2 } }, { client });
  assert.equal(calls, 2); assert.notEqual(a.id, b.id); assert.notEqual(a.id, requestHash);
  assert.equal(a.requestHash, requestHash); assert.equal(b.requestHash, requestHash);
  assert.deepEqual(a.attempt, attempt); assert.deepEqual(runs.read(a.id).reservation.attempt, attempt);
  assert.equal(runs.read(a.id).reservation.requestHash, requestHash);
  await assert.rejects(api().replayWikiRun(input, { client }), { code: 'wiki_run_already_reserved' }); assert.equal(calls, 2);
  await assert.rejects(api().replayWikiRun({ ...input, attempt: { iteration: 1, executionId: attempt.executionId, planHash: attempt.planHash } }, { client }), { code: 'wiki_run_already_reserved' });
  assert.equal(calls, 2);
  const drifted = structuredClone(q); drifted.context.systemPrompt += ' changed';
  assert.throws(() => runs.reserve(drifted, attempt), { code: 'wiki_run_already_reserved' }, 'one logical slot cannot acquire another claim by changing its request');
  const c = await api().replayWikiRun({ ...input, attempt: undefined }, { client });
  assert.equal(c.id, requestHash); assert.ok(!Object.hasOwn(c, 'attempt')); assert.equal(calls, 3);
  assert.equal(runs.list().length, 3); assert.deepEqual(h.store.read(), before);
});
test('formal crashed/failed/competing claims cannot send twice, but a distinct batch has its own claims', async t => {
  const h = setup(t), create = () => require('../../build/server/domain/runtime/badcase-capture/wiki-run-store').createWikiRunStore(h.options);
  const q = h.request(), attempt = { planHash: 'c'.repeat(64), executionId: '1b947e3a-88c8-4a52-a9e1-c32dcd8c99df', iteration: 1 };
  const input = { store: h.store, runs: create(), caseId: h.c.id, toolset: h.toolset, approvedRequestHash: hash(q), attempt };
  const claim = input.runs.reserve(q, attempt); assert.equal(create().list()[0].status, 'reserved'); let calls = 0;
  const client = { async complete() { calls++; throw Error('synthetic request error'); } };
  await assert.rejects(api().replayWikiRun({ ...input, runs: create() }, { client }), { code: 'wiki_run_already_reserved' }); assert.equal(calls, 0);
  const next = { ...input, attempt: { ...attempt, executionId: '2b947e3a-88c8-4a52-a9e1-c32dcd8c99df' } };
  const failed = await api().replayWikiRun(next, { client }); assert.equal(failed.outcome.status, 'error'); assert.equal(calls, 1);
  await assert.rejects(api().replayWikiRun(next, { client }), { code: 'wiki_run_already_reserved' }); assert.equal(calls, 1);
  assert.equal(create().read(claim.id).result, null); assert.equal(create().read(failed.id).result.outcome.status, 'error');
});
test('formal attempt shape and immutable attempt/request identity are validated before any network', async t => {
  const h = setup(t), runs = require('../../build/server/domain/runtime/badcase-capture/wiki-run-store').createWikiRunStore(h.options), q = h.request();
  const attempt = { planHash: 'c'.repeat(64), executionId: '1b947e3a-88c8-4a52-a9e1-c32dcd8c99df', iteration: 1 }; let calls = 0;
  for (const patch of [{ iteration: 0 }, { iteration: 16 }, { iteration: 1.5 }, { planHash: 'invalid' }, { executionId: '../file' }, { extra: true }]) {
    await assert.rejects(api().replayWikiRun({ store: h.store, runs, caseId: h.c.id, toolset: h.toolset,
      approvedRequestHash: hash(q), attempt: { ...attempt, ...patch } }, { client: { complete() { calls++; } } }), { code: 'wiki_run_attempt_invalid' });
  }
  assert.equal(calls, 0); assert.equal(runs.list().length, 0);
  const claim = runs.reserve(q, attempt), file = path.join(h.options.globalRoot, 'run-replays', claim.id + '.json');
  const original = JSON.parse(fs.readFileSync(file));
  for (const mutate of [e => e.reservation.attempt.iteration = 2, e => e.reservation.request.context.systemPrompt += ' drift',
    e => e.reservation.requestHash = 'f'.repeat(64)]) {
    const envelope = structuredClone(original); mutate(envelope); envelope.hash = hash(envelope.reservation);
    fs.writeFileSync(file, JSON.stringify(envelope)); assert.throws(() => runs.read(claim.id), { code: 'wiki_run_record_invalid' });
  }
});
test('a failed request is recorded once with a safe code and never retried; output known values are replaced', async t => {
  const { createWikiRunStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-run-store');
  for (const failing of [false, true]) {
    const h = setup(t), runs = createWikiRunStore(h.options); let calls = 0;
    const r = await api().replayWikiRun({ store: h.store, runs, caseId: h.c.id, toolset: h.toolset, approvedRequestHash: hash(h.request()) }, { knownKeyValues: ['synthetic-private-value'], client: { async complete() {
      calls++; if (failing) throw Error('synthetic-private-value');
      return { message: output([{ type: 'text', text: 'synthetic-private-value' }]), networkRequests: 1, durationMs: 1 };
    } } });
    assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(r), /synthetic-private-value/); assert.equal(r.outcome.status, failing ? 'error' : 'reached');
    assert.equal(Object.hasOwn(r.outcome, 'countAsFailure'), false);
    assert.equal(runs.list().length, 1); assert.equal(runs.read(r.id).result.outcome.status, r.outcome.status);
  }
});
test('candidate can replace only one approved global slot; remainder of frozen prefix and tools stay exact', t => {
  const h = setup(t), { getGlobalPromptTarget } = require('../../build/lib/agent-prompt-targets'), target = getGlobalPromptTarget('global-harness-behavior-v1');
  const bundle = structuredClone(h.bundle), item = structuredClone(h.item()), decision = structuredClone(h.decision);
  bundle.context.trigger.message.content = 'input\n\nRoom work context:\noriginal\n\nRules:\n' + target.baseText + '\n- Extra unchanged rule\n\nRouting instructions:\noriginal tail';
  item.traceBundle.hash = hash(bundle); decision.traceHash = item.traceBundle.hash; const { hash: ignored, ...value } = decision; decision.hash = hash(value);
  const input = { item, bundle, decision, toolset: h.toolset }, original = api().buildWikiRunRequest(input);
  const candidate = { id: 'approved', targetId: target.id, baseText: target.baseText, baseHash: target.baseHash, replacement: 'NEW GLOBAL ONLY' };
  const changed = api().buildWikiRunRequest({ ...input, candidate });
  assert.equal(changed.context.systemPrompt, original.context.systemPrompt); assert.deepEqual(changed.context.tools, original.context.tools);
  assert.equal(changed.context.messages[0].content.replace('NEW GLOBAL ONLY', target.baseText), original.context.messages[0].content);
  assert.deepEqual(changed.context.messages.slice(1), original.context.messages.slice(1));
  assert.throws(() => api().buildWikiRunRequest({ ...input, candidate: { ...candidate, baseHash: 'f'.repeat(64) } }), e => e.code === 'wiki_run_candidate_invalid');
});
test('candidate rejects duplicate global declarations even when another prefix segment has one valid slot', t => {
  const h = setup(t), target = require('../../build/lib/agent-prompt-targets').getGlobalPromptTarget('global-harness-behavior-v1');
  const slot = 'prefix\n\nRoom work context:\noriginal\n\nRules:\n' + target.baseText + '\n- Unchanged rule\n\nRouting instructions:\ntail';
  const duplicate = slot + '\n\nRules:\n' + target.baseText + '\n';
  const candidate = { id: 'approved', targetId: target.id, baseText: target.baseText, baseHash: target.baseHash, replacement: 'NEW GLOBAL ONLY' };
  for (const [system, user] of [[duplicate, slot], [slot, duplicate], [slot, slot], ['no target', 'no target']]) {
    const bundle = structuredClone(h.bundle), item = structuredClone(h.item()), decision = structuredClone(h.decision);
    bundle.context.systemPrompt = system; bundle.context.trigger.message.content = user;
    item.traceBundle.hash = hash(bundle); decision.traceHash = item.traceBundle.hash; const { hash: ignored, ...content } = decision; decision.hash = hash(content);
    assert.throws(() => api().buildWikiRunRequest({ item, bundle, decision, toolset: h.toolset, candidate }), { code: 'wiki_run_candidate_invalid' });
  }
});
test('run rubrics reject trace and files on freeze, while reply freezes and historical frozen records stay readable', t => {
  for (const evidence of ['trace', 'files', 'reply']) {
    const h = setup(t), state = h.store.read(), item = h.item(), model = 'deepseek/deepseek-v4-flash';
    const rubric = require('../../build/server/domain/runtime/badcase-capture/wiki-rubric').createWikiRubric({ caseId: item.id, version: 1, actual: item.actual, expected: item.expected,
      model, scoringModel: { backend: 'deepseek', model }, questions: [{ id: 'q1', question: 'The reply states a concrete result.', evidence }] });
    // A historical draft may predate the run decision. Read remains compatible;
    // the new freeze must enforce the execution's actual evidence surface.
    state.rubrics = [rubric]; const file = path.join(h.options.globalRoot, 'snapshots', String(state.revision).padStart(12, '0') + '.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, checksum: hash(state), record: state }));
    const before = h.store.read(), bytes = fs.readFileSync(file), confirm = () => h.store.confirmRubric({ rubricId: rubric.id, hash: rubric.hash, confirmationRecord: 'Synthetic user consent' }, before.revision);
    if (evidence === 'reply') assert.equal(confirm().status, 'frozen');
    else {
      assert.throws(confirm, { code: 'wiki_rubric_run_evidence_invalid' }); assert.deepEqual(h.store.read(), before);
      Object.assign(rubric, { status: 'frozen', confirmedAt: '2026-11-05T00:00:00.000Z', confirmationRecord: 'Historical approval' });
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, checksum: hash(state), record: state }));
      assert.deepEqual(createWikiStore(h.options).getFrozenRubric(item.id, rubric.hash), rubric, 'old versions are readable without migration or re-judging');
    }
    if (evidence === 'reply') assert.deepEqual(fs.readFileSync(file), bytes, 'old snapshot bytes unchanged');
  }
});

test('crashed reservations remain unknown and cannot send again; known values in input block before creating a claim', async t => {
  const h = setup(t), { createWikiRunStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-run-store'), runs = createWikiRunStore(h.options), q = h.request();
  const input = { store: h.store, runs, caseId: h.c.id, toolset: h.toolset, approvedRequestHash: hash(q) }; let calls = 0;
  await assert.rejects(api().replayWikiRun(input, { knownKeyValues: ['historical'], client: { complete() { calls++; } } }), e => e.code === 'wiki_run_input_contains_known_key');
  assert.equal(runs.list().length, 0); runs.reserve(q); assert.equal(runs.list()[0].status, 'reserved');
  await assert.rejects(api().replayWikiRun(input, { client: { complete() { calls++; } } }), e => e.code === 'wiki_run_already_reserved'); assert.equal(calls, 0);
});
test('scene-backed run cannot silently use the single-call no-executor implementation', t => {
  const h = setup(t);
  assert.throws(() => api().buildWikiRunRequest({ item: { ...h.item(), sealedCheckpointId: 'scene' }, bundle: h.bundle, decision: h.decision, toolset: h.toolset }), e => e.code === 'wiki_run_scene_unsupported');
});
test('unconfirmed/stale requests are rejected before reservation or network', async t => {
  const h = setup(t), { createWikiRunStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-run-store'), runs = createWikiRunStore(h.options);
  let calls = 0;
  await assert.rejects(api().replayWikiRun({ store: h.store, runs, caseId: h.c.id, toolset: h.toolset, approvedRequestHash: 'f'.repeat(64) }, { client: { complete() { calls++; } } }), e => e.code === 'wiki_run_stale');
  assert.equal(calls, 0); assert.equal(runs.list().length, 0);
  h.decision.level = 'reference'; const { hash: ignored, ...value } = h.decision; h.decision.hash = hash(value);
  assert.throws(h.request, e => e.code === 'wiki_run_decision_invalid');
});
