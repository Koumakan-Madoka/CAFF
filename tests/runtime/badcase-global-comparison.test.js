// Global target pipeline uses the existing host/Docker orchestration. These
// tests spend no model calls or credentials; target substitution uses real seals.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const fixture = require('../helpers/badcase-initialization-fixture.cjs');
const { getGlobalPromptTarget } = require('../../build/lib/agent-prompt-targets');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { prepareSealedPromptTarget } = require('../../scripts/badcase-capture/sealed-direct-input.cjs');
const { collectWikiCandidateFiles } = require('../../build/server/domain/runtime/badcase-capture/wiki-candidate-files');
const { prepareComparison, runComparison, expectedTreeHash } = require('../../scripts/badcase-capture/direct-comparison.cjs');
const { prepareBatch, runBatch, formatBatch } = require('../../scripts/badcase-capture/batch-comparison.cjs');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const targetId = 'global-harness-behavior-v1', target = getGlobalPromptTarget(targetId);
function seal(t, { missingTarget = false } = {}) {
  return fixture(t, 'fresh', ({ cp, r, config, put }) => {
    config.toolBridgeEnabled = true; config.portableRuntime = { schemaVersion: 1, kind: 'portable-default-resources-v1', supported: true };
    config.sdkStartConfig = { cwd: cp.targetDir, provider: r.runConfig.provider, model: r.runConfig.model, resume: false, thinking: 'off', fast: false, retireUserScopeSkills: true };
    r.promptBlobHash = r.normalizedPromptHash = put('Identity: custom actor\nYour private persona instructions:\nKeep this exact role.\n\nRoom work context:\n- Fixture\n\nRules:\n' + (missingTarget ? 'Unsupported old rules.' : target.baseText) + '\n- Preserve routing.\n\nRouting instructions:\n- No handoff.\n\nUser: inspect files.');
    const association = { projectId: cp.projectId, conversationId: cp.conversationId, turnId: cp.turnId, agentId: cp.agentId, userMessageId: 'u1', assistantMessageId: 'msg1' };
    const trace = { schemaVersion: 1, kind: 'caff-evaluation-callback-input-v1', association, assistantCreatedAt: '2026-01-01T00:00:01.000Z', conversation: { title: 'Fixture', type: 'standard', metadata: {} }, participants: [{ id: cp.agentId, name: 'Actor', description: 'Test' }], publicMessages: [{ id: 'u1', turnId: 't0', role: 'user', agentId: null, senderName: 'User', content: 'Inspect files.', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z', publicPostedAt: '', publicPostCount: 0, publicPostMode: '', mentions: [] }], privateMessages: [], pendingDelegations: [] };
    r.callbackInput = { schemaVersion: 1, kind: 'caff-evaluation-callback-input-reference-v1', blobHash: put(JSON.stringify(trace)), association };
    r.harness.configSnapshotHash = put(JSON.stringify(config));
  });
}
function setup(t, { confirmed = true, tool = false, missingTarget = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'global-comparison-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = { globalRoot: path.join(root, 'global'), sourceWorktree: path.join(root, 'source') }, store = createWikiStore(scope);
  const sources = store.addTextCases(Array.from({ length: 16 }, (_, n) => ({ source: { origin: 'http://127.0.0.1:3100', projectId: 'history-project-' + n, conversationId: 'history-room', messageId: 'message-' + n, agentId: 'role-family-gpt' }, role: 'GPT', actual: 'Unclear report', expected: 'Unique expected visible outcome number ' + n, message: 'Internal jargon', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }))).cases;
  const split = store.setReplaySplit({ caseIds: sources.slice(0, 8).map(c => c.id) });
  // The approved seven-task suite replaces two old training tasks with an
  // already exposed training source. Keep the original 8-source partition and
  // all three holdouts intact; do not require nine evaluation tasks instead.
  const selected = [...sources.filter(c => split.testCaseIds.includes(c.id)),
    ...sources.filter(c => split.trainCaseIds.includes(c.id)).slice(0, 3), sources[8]];
  const train = store.read().cases.filter(c => c.split === 'train').map(c => c.id), guideline = '先核实，再用读者能理解的语言说明结论。';
  const v = store.saveDraft({ caseIds: train, model: 'deepseek/deepseek-v4-flash', entries: [{ title: 'Clear', failureMode: 'jargon', symptoms: 'unclear', rootCauseHypothesis: 'audience', guideline, caseIds: train }], unclassified: [] });
  store.review({ versionId: v.id, entryId: v.entries[0].id, expectedRevision: store.read().revision, decision: 'approved' });
  const seals = selected.map(() => seal(t, { missingTarget })), categories = ['reproduction', 'reproduction', 'reproduction', 'probe', 'control', 'control', 'control'];
  const rules = { kind: 'file-literals-v1', files: [{ path: 'REPORT.md', contains: ['RESULT'], notContains: ['TODO'] }] };
  for (let i = 0; i < 7; i++) {
    // A missing declared target is still an honestly registered old seal. The
    // global evaluation must mark it unsupported, never fall back to its role.
    const prepared = prepareSealedPromptTarget(seals[i].request, targetId);
    store.addReplayCase({ sourceCaseId: selected[i].id, category: categories[i], task: 'Write the current state to REPORT.md.',
      fixture: { commit: 'a'.repeat(40), sourceCommit: 'b'.repeat(40), sourceSubdirectory: 'R' + (i + 1), filesHash: 'c'.repeat(64) },
      request: seals[i].request, rules, checkpointHash: missingTarget ? sha(JSON.stringify(seals[i].cp)) : prepared.provenance.checkpointHash });
  }
  const files = collectWikiCandidateFiles(store.read()), candidate = store.createGlobalCandidate({ versionId: v.id, entryIds: [v.entries[0].id], targetId: tool ? 'tool-description-list_rooms' : targetId, files });
  if (confirmed) store.confirmGlobalCandidate({ candidateId: candidate.id, candidateHash: candidate.candidateHash, expectedRevision: store.read().revision, files });
  const config = { ...scope, candidateId: candidate.id, repoRoot: root, dependencyRoot: root, image: { imageId: 'sha256:' + '1'.repeat(64) }, cases: selected.map((c, i) => ({ sourceCaseId: c.id, category: categories[i] })) };
  const single = { request: seals[0].request, globalWikiCandidate: { ...scope, candidateId: candidate.id }, repoRoot: root, dependencyRoot: root, image: config.image, repeats: 3, rules, modelProfile: 'deepseek/deepseek-v4-flash', keySource: 'caff-deepseek' };
  const state = { keys: 0, executions: 0, events: [], failAt: 0 }, key = 'synthetic-global-evaluation-key-123456';
  const options = { confirmed: true, readKey: () => { state.keys++; return key; }, onEvent: event => state.events.push(event),
    stage: (_repo, _deps, _image, input) => [{ path: 'probe.cjs', bytes: Buffer.from(JSON.stringify(input)) }, { path: 'runtime/test', bytes: Buffer.from('fixed-runtime') }],
    execute: async (_image, files, opts) => {
      state.executions++; assert.equal(opts.key, key); assert.equal(opts.network, 'bridge');
      const m = manifestFor(files), input = JSON.parse(files[0].bytes), failed = state.executions === state.failAt, text = 'RESULT';
      return { code: 0, cleaned: true, containerId: 'a'.repeat(64), isolation: { privileged: false }, receipt: { kind: 'direct-caff-turn-v1', inputHash: m.inputHash, runtimeHash: m.runtimeHash, success: !failed,
        beforeHash: expectedTreeHash(input), afterHash: expectedTreeHash(input), replySource: 'public', finalText: 'done', toolCalls: [],
        fileEvidence: [{ path: 'REPORT.md', state: 'file', base64: Buffer.from(text).toString('base64'), sha256: sha(text), size: text.length }],
        modelCalls: [{ model: 'deepseek/deepseek-v4-flash', durationMs: 1, success: !failed, usage: null }] } };
    } };
  const plan = () => prepareBatch(config, options), run = () => runBatch(config, { ...options, expectedPlanHash: plan().summary.planHash });
  return { root, store, sources, split, seals, candidate, config, single, state, options, plan, run, guideline };
}
test('confirmed global candidate changes exactly one shared fragment, not the custom role, callback, files or config', async t => {
  const h = setup(t), before = h.store.read(), p = prepareComparison(h.single, h.options);
  assert.equal(p.supported, true); assert.equal(h.state.keys, 0);
  assert.equal(p.inputs.candidate.prompt, p.inputs.original.prompt.replace(target.baseText, h.candidate.candidateText));
  assert.deepEqual({ ...p.inputs.candidate, prompt: '' }, { ...p.inputs.original, prompt: '' });
  assert.match(p.inputs.candidate.prompt, /Keep this exact role/);
  assert.equal(p.summary.globalWikiCandidate.candidateHash, h.candidate.candidateHash); assert.equal(p.summary.targetId, targetId);
  const r = await runComparison(h.single, h.options); assert.equal(r.completed, true); assert.equal(h.state.executions, 6);
  assert.deepEqual(h.store.read(), before);
});
test('global comparison refuses drafts, tool evaluation, bypass role/text/scope and mismatched target before Key/model access', async t => {
  const draft = setup(t, { confirmed: false }); await assert.rejects(runComparison(draft.single, draft.options), /candidate_confirmation_required/);
  const tool = setup(t, { tool: true }); await assert.rejects(runComparison(tool.single, tool.options), /target_unsupported/);
  const h = setup(t);
  for (const patch of [{ candidateRole: 'bypass' }, { wikiCandidate: { sourceWorktree: h.config.sourceWorktree, candidateId: h.candidate.id } },
    { globalWikiCandidate: { ...h.single.globalWikiCandidate, candidateText: 'bypass' } }, { globalWikiCandidate: { ...h.single.globalWikiCandidate, projectId: 'history-project' } }]) assert.throws(() => prepareComparison({ ...h.single, ...patch }, h.options), /config_invalid/);
  const prepareTarget = (req, id, replacement) => { const p = prepareSealedPromptTarget(req, id, replacement); p.provenance.originalTargetHash = 'e'.repeat(64); return p; };
  assert.throws(() => prepareComparison(h.single, { ...h.options, prepareTarget }), /target_mismatch/);
  assert.equal(h.state.keys + draft.state.keys + tool.state.keys, 0); assert.equal(h.state.executions + draft.state.executions + tool.state.executions, 0);
});
test('global batch derives sealed requests/rules from global registrations, preserves 7 slots and frozen holdout without touching projects', async t => {
  const h = setup(t), before = h.store.read(), p = h.plan();
  assert.equal(p.summary.kind, 'wiki-global-batch-comparison-v1'); assert.equal(p.summary.projectId, undefined);
  assert.equal(p.summary.repeats, 3); assert.equal(p.summary.preparedReplayableCount, 7); assert.equal(p.summary.wikiTrainingCount, 13);
  assert.equal(p.summary.split.testCaseIds.length, 3); assert.equal(p.summary.candidate.targetId, targetId);
  assert.deepEqual(p.summary.split.caseIds, h.split.caseIds); assert.equal(p.summary.excludedSplitTrainingCaseIds.length, 2);
  assert.equal(JSON.stringify(p.summary).includes(h.root), false); assert.equal(h.state.keys, 0);
  const r = await h.run(); assert.equal(r.completed, true); assert.equal(h.state.executions, 42); assert.equal(h.state.keys, 1);
  assert.equal(r.totals.original.planned, 21); assert.equal(r.totals.candidate.passed, 21);
  assert.equal(r.byCategory.reproduction.original.planned, 9); assert.equal(r.byCategory.probe.original.planned, 3); assert.equal(r.byCategory.control.original.planned, 9);
  assert.equal(r.bySplit.test.candidate.planned, 9); assert.equal(r.modelCallsKnown, 42);
  assert.match(formatBatch(r), /复现 original: 9\/9/); assert.match(formatBatch(r), /控制 candidate: 9\/9/); assert.match(formatBatch(r), /探针 original: 3\/3/);
  assert.match(formatBatch(r), /只复现了汇报难懂一类/); assert.deepEqual(h.store.read(), before);
});
test('global batch rejects dropped, duplicate or reclassified slots, caller rules/requests and legacy scope fields before side effects', async t => {
  const h = setup(t), original = h.plan().summary.planHash;
  for (const change of [c => { c.cases = c.cases.filter(i => i.sourceCaseId !== h.split.testCaseIds[0]); }, c => c.cases.push(c.cases[0]), c => { c.cases[0].category = 'control'; }, c => { c.cases[0].request = {}; }, c => { c.cases[0].rules = {}; }, c => { c.projectId = 'p1'; }, c => { c.captureRoot = h.root; }]) {
    const config = structuredClone(h.config); change(config); assert.throws(() => prepareBatch(config, h.options));
  }
  await assert.rejects(runBatch({ ...h.config, repeats: 2 }, { ...h.options, expectedPlanHash: original }), /confirmation_required/);
  assert.equal(h.state.keys, 0); assert.equal(h.state.executions, 0);
});
test('missing declared targets keep all 7 denominators, emit unsupported and never spend a Key or substitute a role', async t => {
  const h = setup(t, { missingTarget: true }), r = await h.run();
  assert.equal(r.preparedReplayableCount, 0); assert.equal(r.completed, false); assert.equal(r.cases.length, 7);
  assert.ok(r.cases.every(c => c.status === 'unsupported')); assert.equal(r.totals.original.notRun, 21); assert.equal(r.totals.original.passRate, null);
  assert.equal(h.state.keys, 0); assert.equal(h.state.executions, 0);
});
test('missing registrations remain in the confirmed seven-task suite, including holdout and control denominators', async t => {
  const h = setup(t), directory = path.join(h.config.globalRoot, 'snapshots'), file = path.join(directory, fs.readdirSync(directory).filter(n => n.endsWith('.json')).sort().at(-1));
  const envelope = JSON.parse(fs.readFileSync(file));
  const missing = [h.split.testCaseIds[0], h.config.cases.find(c => c.category === 'control' && !h.split.testCaseIds.includes(c.sourceCaseId)).sourceCaseId];
  envelope.record.replayCases = envelope.record.replayCases.filter(c => !missing.includes(c.sourceCaseId));
  envelope.checksum = sha(JSON.stringify(envelope.record)); fs.writeFileSync(file, JSON.stringify(envelope));
  const r = await h.run(); assert.equal(r.completed, false); assert.equal(r.cases.length, 7); assert.equal(r.preparedReplayableCount, 5);
  assert.equal(h.state.executions, 30); assert.equal(r.totals.original.planned, 21); assert.equal(r.totals.original.passed, 15); assert.equal(r.totals.original.notRun, 6);
  assert.equal(r.bySplit.test.original.notRun, 3); assert.equal(r.byCategory.control.original.notRun, 3);
  assert.equal(r.cases.filter(c => c.status === 'unsupported').length, 2); assert.equal(r.totals.original.passRate, 1); assert.equal(r.totals.original.plannedPassRate, 15 / 21);
});
test('a leaked file in the final global case is caught in whole-batch preflight before any Key/model use', async t => {
  const h = setup(t), last = h.plan().prepared.at(-1).comparisonConfig.request.captureRoot;
  h.options.prepareTarget = (request, id, replacement) => {
    const p = prepareSealedPromptTarget(request, id, replacement);
    if (request.captureRoot === last) p.input.files = [{ path: 'leak.txt', base64: Buffer.from(h.guideline).toString('base64'), sha256: sha(h.guideline) }];
    return p;
  };
  assert.throws(() => h.plan(), /candidate_leak/); assert.equal(h.state.keys, 0); assert.equal(h.state.executions, 0); assert.equal(h.state.events.length, 0);
});
test('the public batch CLI plans the global seven-task suite without reading a Key, running a model or writing results', t => {
  const h = setup(t), configFile = path.join(h.root, 'config.json'); fs.writeFileSync(configFile, JSON.stringify(h.config));
  const cp = require('node:child_process').spawnSync(process.execPath, [path.resolve('scripts/badcase-capture/compare-wiki-batch.cjs'), '--config', configFile, '--plan'],
    { encoding: 'utf8', env: { ...process.env, CAFF_BADCASE_MODEL_KEY: '', CAFF_BADCASE_MODEL_KEY_FILE: path.join(h.root, 'must-not-read') } });
  assert.equal(cp.status, 0, cp.stderr); const planned = JSON.parse(cp.stdout);
  assert.equal(planned.kind, 'wiki-global-batch-comparison-v1'); assert.equal(planned.planHash, h.plan().summary.planHash);
  assert.equal(planned.preparedOnly, true); assert.equal(planned.dockerVerified, false); assert.equal(planned.cases.length, 7);
  assert.equal(h.state.keys, 0); assert.equal(h.state.executions, 0);
});
test('global batch model error stops all remaining slots, retaining per-case/category/holdout error and unexecuted totals', async t => {
  const h = setup(t); h.state.failAt = 1; const r = await h.run();
  assert.equal(r.completed, false); assert.equal(h.state.executions, 1); assert.equal(r.totals.original.errors, 1); assert.equal(r.totals.original.notRun, 20); assert.equal(r.totals.candidate.notRun, 21);
  assert.equal(r.modelCallsKnown, 1); assert.equal(r.callsUnavailable, false);
  assert.equal(r.byCategory.reproduction.original.errors + r.byCategory.probe.original.errors + r.byCategory.control.original.errors, 1);
  assert.equal(r.cases.slice(1).every(c => c.status === 'not-run'), true);
});
