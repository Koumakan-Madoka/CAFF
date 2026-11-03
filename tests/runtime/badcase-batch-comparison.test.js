const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { prepareBatch, runBatch, formatBatch } = require('../../scripts/badcase-capture/batch-comparison.cjs');
const { argumentsFor, main } = require('../../scripts/badcase-capture/compare-wiki-batch.cjs');
const { expectedTreeHash } = require('../../scripts/badcase-capture/direct-comparison.cjs');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function setup(t, { confirmed = true, repeats } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-batch-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = { captureRoot: path.join(root, 'capture'), sourceWorktree: path.join(root, 'source'), projectId: 'p1' }, store = createWikiStore(scope);
  const cases = store.addTextCases(Array.from({ length: 12 }, (_, i) => ({ source: { origin: 'http://127.0.0.1:3100', projectId: 'p1', conversationId: 'c1', messageId: 'm' + i, agentId: 'role-family-gpt' },
    role: 'GPT', actual: 'problem ' + i, expected: 'Expected visible behavior task ' + i, message: 'done', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }))).cases;
  const split = store.setReplaySplit({ caseIds: cases.slice(0, 6).map(c => c.id) });
  const train = store.read().cases.filter(c => c.split === 'train').map(c => c.id), guideline = '核验必要证据后再结论。';
  const version = store.saveDraft({ caseIds: train, model: 'deepseek/deepseek-v4-flash', entries: [{ title: 'Evidence', failureMode: 'claim', symptoms: 'no checks', rootCauseHypothesis: 'skipped verification', guideline, caseIds: train }], unclassified: [] });
  store.review({ versionId: version.id, entryId: version.entries[0].id, expectedRevision: store.read().revision, decision: 'approved' });
  const baseRole = 'Preserve GPT original instructions.', originalRoleHash = sha('Your private persona instructions:\n' + baseRole);
  const candidate = store.createCandidate({ versionId: version.id, entryIds: ['entry-1'], baseRole, files: [], anchor: { caseId: 'sealed-0', checkpointId: 'cp0', originalRoleHash } });
  if (confirmed) store.confirmCandidate({ candidateId: candidate.id, candidateRoleHash: candidate.candidateRoleHash, expectedRevision: store.read().revision });
  const config = { ...scope, candidateId: candidate.id, repoRoot: root, dependencyRoot: root, image: { imageId: 'sha256:' + '1'.repeat(64) },
    ...(repeats === undefined ? {} : { repeats }), cases: cases.slice(0, 6).map((c, i) => ({ sourceCaseId: c.id,
      request: { captureRoot: scope.captureRoot, association: { projectId: 'p1', agentId: 'role-family-gpt', checkpointId: 'cp' + i } },
      rules: { kind: 'file-literals-v1', files: [{ path: 'output.txt', contains: ['RESULT'], notContains: ['TODO'] }] } })) };
  const state = { keys: 0, executions: 0, events: [], modelErrorCp: '', driftRuntime: false, allPass: false }, key = 'synthetic-batch-model-key-123456';
  const options = { confirmed: true, onEvent: e => state.events.push(e), readKey: () => { state.keys++; return key; },
    prepare: (request, role) => {
      const cp = request.association.checkpointId;
      return { supported: true, originalRole: baseRole,
        input: { kind: 'prepared-caff-turn-v1', prompt: (role || 'original') + '|' + cp, sessionText: null, files: [{ path: 'input.txt', base64: Buffer.from(cp).toString('base64'), sha256: sha(cp) }], deletions: [] },
        provenance: { originalRoleHash, caseId: 'sealed-' + cp, checkpointId: cp, checkpointHash: sha(cp), commonInputHash: sha('common-' + cp) } };
    },
    stage: (_repo, _deps, _image, input) => [{ path: 'probe.cjs', bytes: Buffer.from(JSON.stringify(input)) }, { path: 'runtime/test', bytes: Buffer.from(state.driftRuntime && state.executions >= 6 ? 'changed-runtime' : 'fixed-runtime') }],
    execute: async (_image, files, opts) => {
      state.executions++; assert.equal(opts.key, key); assert.equal(opts.network, 'bridge');
      const m = manifestFor(files), input = JSON.parse(files[0].bytes.toString()), cp = input.prompt.split('|').at(-1), modelError = cp === state.modelErrorCp;
      const text = state.allPass || input.prompt.startsWith('original|') || state.executions % 3 ? 'RESULT' : 'WRONG';
      return { code: 0, cleaned: true, containerId: 'a'.repeat(64), isolation: { privileged: false }, receipt: {
        kind: 'direct-caff-turn-v1', inputHash: m.inputHash, runtimeHash: m.runtimeHash, success: !modelError,
        beforeHash: expectedTreeHash(input), afterHash: expectedTreeHash(input), replySource: 'public', finalText: 'done', toolCalls: [],
        fileEvidence: [{ path: 'output.txt', state: 'file', base64: Buffer.from(text).toString('base64'), sha256: sha(text), size: Buffer.byteLength(text) }],
        modelCalls: [{ model: 'deepseek/deepseek-v4-flash', durationMs: 1, success: !modelError, usage: null }] } };
    } };
  const plan = () => prepareBatch(config, options), run = async () => runBatch(config, { ...options, expectedPlanHash: plan().summary.planHash });
  return { root, store, config, split, candidate, guideline, state, options, plan, run };
}

test('planning defaults to 3 repeats, resolves all sealed cases and a frozen holdout without Key/Docker/model access', t => {
  const h = setup(t), p = h.plan();
  assert.equal(p.summary.repeats, 3); assert.equal(p.summary.preparedReplayableCount, 6); assert.equal(p.summary.wikiTrainingCount, 10);
  assert.equal(p.summary.split.testCaseIds.length, 2); assert.deepEqual(p.summary.disclosures, []);
  assert.equal(h.state.keys, 0); assert.equal(h.state.executions, 0); assert.equal(h.state.events.length, 0);
  assert.equal(p.summary.cases.every(c => c.comparison.wikiCandidate.candidateRoleHash === h.candidate.candidateRoleHash), true);
  assert.equal(JSON.stringify(p.summary).includes(h.root), false);
});
test('batch plans accept the 45-minute turn ceiling and bind it to every prepared case before execution', t => {
  const h = setup(t); h.config.timeoutMs = 2700000;
  assert.ok(h.plan().summary.cases.every(c => c.comparison.timeoutMs === 2700000));
  assert.equal(h.state.keys, 0); assert.equal(h.state.executions, 0);
});
test('batch confirmation binds exact plan hash; a draft candidate or changed rubric fails before Key/model use', async t => {
  const h = setup(t), hash = h.plan().summary.planHash;
  for (const options of [{ confirmed: false, expectedPlanHash: hash }, { confirmed: true }, { confirmed: true, expectedPlanHash: 'a'.repeat(64) }]) {
    await assert.rejects(runBatch(h.config, { ...h.options, ...options }), /confirmation_required/);
  }
  h.config.cases[0].rules.files[0].contains = ['different confirmed reference'];
  await assert.rejects(runBatch(h.config, { ...h.options, expectedPlanHash: hash }), /confirmation_required/);
  const draft = setup(t, { confirmed: false }); assert.throws(() => draft.plan(), /candidate_confirmation_required/);
  assert.equal(h.state.keys + draft.state.keys, 0); assert.equal(h.state.executions + draft.state.executions, 0);
});
test('all 6 cases run original/candidate 3 times with per-case, overall and separate holdout pass/fail denominators', async t => {
  const h = setup(t), r = await h.run();
  assert.equal(r.completed, true); assert.equal(h.state.keys, 1); assert.equal(h.state.executions, 36);
  assert.equal(r.totals.original.passed, 18); assert.equal(r.totals.candidate.passed, 12); assert.equal(r.totals.candidate.failed, 6);
  assert.equal(r.totals.candidate.passRate, 2 / 3); assert.equal(r.bySplit.test.candidate.planned, 6); assert.equal(r.bySplit.test.candidate.passed, 4);
  assert.equal(r.bySplit.train.candidate.planned, 12); assert.equal(r.bySplit.train.candidate.passed, 8);
  assert.equal(r.cases.every(c => c.runs.length === 6 && c.totals.candidate.failed === 1 && c.comparison.checkpointId && c.comparison.rulesHash), true);
  assert.equal(r.modelCallsKnown, 36); assert.equal(r.callsUnavailable, false);
  assert.equal(h.state.events.filter(e => e.event === 'model_call').length, 36);
  assert.equal(h.state.events.filter(e => e.event === 'case_summary').length, 6);
  assert.match(formatBatch(r), /总体 candidate: 12\/18 通过，6 失败，0 错误，0 未运行/);
  assert.match(formatBatch(r), /留出 candidate: 4\/6/);
});
test('unsupported source remains explicit and keeps its planned denominator; other supported cases still run', async t => {
  const h = setup(t), missing = h.config.cases.find(c => c.sourceCaseId === h.split.testCaseIds[0]); missing.request = null; missing.rules = null; h.state.allPass = true;
  const r = await h.run();
  assert.equal(r.completed, false); assert.equal(r.preparedReplayableCount, 5); assert.equal(h.state.executions, 30);
  assert.equal(r.totals.original.planned, 18); assert.equal(r.totals.original.passed, 15); assert.equal(r.totals.original.notRun, 3);
  assert.equal(r.bySplit.test.original.planned, 6); assert.equal(r.bySplit.test.original.notRun, 3);
  assert.equal(r.cases.find(c => c.sourceCaseId === missing.sourceCaseId).status, 'unsupported');
  assert.ok(r.disclosures.includes('fewer_than_6_prepared_replays'));
  assert.equal(r.totals.original.passRate, 1); assert.equal(r.totals.original.plannedPassRate, 15 / 18);
});
test('model error stops entire remaining batch without retries and retains known calls plus error/not-run counts', async t => {
  const h = setup(t), first = h.config.cases.find(c => c.sourceCaseId === h.split.caseIds[0]); h.state.modelErrorCp = first.request.association.checkpointId;
  const r = await h.run();
  assert.equal(h.state.executions, 1); assert.equal(r.completed, false); assert.equal(r.modelCallsKnown, 1); assert.equal(r.callsUnavailable, false);
  assert.equal(r.totals.original.errors, 1); assert.equal(r.totals.original.notRun, 17); assert.equal(r.totals.candidate.notRun, 18);
  assert.equal(r.cases.slice(1).every(c => c.status === 'not-run' && c.reason === 'prior_case_error'), true);
  assert.equal(r.totals.original.passRate, null); assert.match(formatBatch(r), /N\/A/);
});
test('a leak or role mismatch in the last case fails whole preflight before any earlier case spends Key/model work', async t => {
  for (const kind of ['leak', 'role']) {
    const h = setup(t), last = h.config.cases.find(c => c.sourceCaseId === h.split.caseIds.at(-1)), prepare = h.options.prepare;
    h.options.prepare = (...args) => {
      const p = prepare(...args);
      if (args[0].association.checkpointId === last.request.association.checkpointId) {
        if (kind === 'role') p.provenance.originalRoleHash = 'a'.repeat(64);
        else p.input.files = [{ path: 'leak.txt', base64: Buffer.from(h.guideline).toString('base64'), sha256: sha(h.guideline) }];
      }
      return p;
    };
    await assert.rejects(h.run(), new RegExp(kind === 'role' ? 'role_mismatch' : 'candidate_leak'));
    assert.equal(h.state.keys, 0); assert.equal(h.state.executions, 0); assert.equal(h.state.events.length, 0);
  }
});
test('screening replacement may add already-exposed training sources without changing the frozen holdout or omitting its slots', async t => {
  const h = setup(t), before = h.store.read(), originalHash = h.plan().summary.planHash;
  const source = before.cases.find(c => !h.split.caseIds.includes(c.id) && c.split === 'train');
  const extra = structuredClone(h.config.cases[0]); extra.sourceCaseId = source.id; extra.request.association.checkpointId = 'cp-extra';
  h.config.cases.push(extra); h.state.allPass = true;
  const p = h.plan();
  assert.equal(p.summary.cases.length, 7); assert.equal(p.summary.preparedReplayableCount, 7);
  const { createdAt, ...frozenPartition } = h.split;
  assert.deepEqual(p.summary.split, frozenPartition);
  assert.deepEqual(p.summary.additionalTrainingCaseIds, [source.id]);
  assert.equal(p.summary.cases.find(c => c.sourceCaseId === source.id).split, 'train');
  assert.notEqual(p.summary.planHash, originalHash); assert.deepEqual(h.store.read(), before);
  await assert.rejects(runBatch(h.config, { ...h.options, expectedPlanHash: originalHash }), /confirmation_required/);
  assert.equal(h.state.keys, 0); assert.equal(h.state.executions, 0);
  const r = await h.run();
  assert.equal(r.completed, true); assert.equal(h.state.executions, 42);
  assert.equal(r.totals.original.planned, 21); assert.equal(r.bySplit.train.original.planned, 15); assert.equal(r.bySplit.test.original.planned, 6);
  assert.deepEqual(h.store.read(), before); assert.match(formatBatch(r), /补充训练来源 1/);
});
test('an added training replay still undergoes leak preflight before any original or candidate execution', async t => {
  const h = setup(t), source = h.store.read().cases.find(c => !h.split.caseIds.includes(c.id));
  const extra = structuredClone(h.config.cases[0]); extra.sourceCaseId = source.id; extra.request.association.checkpointId = 'cp-extra';
  h.config.cases.push(extra);
  const prepare = h.options.prepare;
  h.options.prepare = (...args) => {
    const p = prepare(...args);
    if (args[0].association.checkpointId === 'cp-extra') p.input.files = [{ path: 'leak.txt', base64: Buffer.from(h.guideline).toString('base64'), sha256: sha(h.guideline) }];
    return p;
  };
  await assert.rejects(h.run(), /candidate_leak/);
  assert.equal(h.state.keys, 0); assert.equal(h.state.executions, 0); assert.equal(h.state.events.length, 0);
});
test('new unexposed sources cannot be silently added or replace frozen test slots', t => {
  const h = setup(t), fresh = h.store.addTextCases([{ source: { origin: 'http://127.0.0.1:3100', projectId: 'p1', conversationId: 'c1', messageId: 'new-after-generation', agentId: 'role-family-gpt' },
    role: 'GPT', actual: 'new problem', expected: 'New expected behavior', message: 'done', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }]).cases[0];
  const extra = structuredClone(h.config.cases[0]); extra.sourceCaseId = fresh.id; extra.request.association.checkpointId = 'cp-extra';
  assert.throws(() => prepareBatch({ ...h.config, cases: [...h.config.cases, extra] }, h.options), /batch_cases_invalid/);
  const known = h.store.read().cases.find(c => !h.split.caseIds.includes(c.id) && c.id !== fresh.id);
  extra.sourceCaseId = known.id;
  assert.throws(() => prepareBatch({ ...h.config, cases: [...h.config.cases.filter(c => c.sourceCaseId !== h.split.testCaseIds[0]), extra] }, h.options), /batch_cases_invalid/);
  assert.equal(h.state.keys, 0); assert.equal(h.state.executions, 0);
});
test('all frozen source slots are required, with distinct GPT checkpoints and no unsupported scope options', t => {
  const h = setup(t), copy = () => structuredClone(h.config);
  for (const change of [c => c.cases.pop(), c => c.cases.push(c.cases[0]), c => { c.cases[0].sourceCaseId = 'unknown'; },
    c => { c.cases[0].request.association.agentId = 'Kimi'; }, c => { c.cases[1].request = c.cases[0].request; }, c => { c.candidateRole = 'bypass'; },
    c => { c.repeats = 0; }, c => { c.timeoutMs = 2700001; }]) {
    const config = copy(); change(config); assert.throws(() => prepareBatch(config, h.options));
  }
  assert.equal(h.state.keys, 0); assert.equal(h.state.executions, 0);
});
test('all unavailable cases disclose no runs, N/A pass rates and zero new calls without even reading a Key', async t => {
  const h = setup(t); for (const c of h.config.cases) { c.request = null; c.rules = null; }
  const r = await h.run(); assert.equal(h.state.keys, 0); assert.equal(h.state.executions, 0);
  assert.equal(r.totals.original.notRun, 18); assert.equal(r.totals.candidate.notRun, 18); assert.equal(r.totals.original.passRate, null);
  assert.equal(r.cases.every(c => c.status === 'unsupported'), true); assert.equal(r.modelCallsKnown, 0); assert.equal(r.callsUnavailable, false);
});
test('runtime drift between cases cannot silently change harness; partial known rows survive and remaining cases stop', async t => {
  const h = setup(t); h.state.driftRuntime = true; h.state.allPass = true;
  const r = await h.run(); assert.equal(h.state.executions, 6); assert.equal(r.cases[0].status, 'completed'); assert.equal(r.cases[1].status, 'error');
  assert.equal(r.modelCallsKnown, 6); assert.equal(r.callsUnavailable, true); assert.equal(r.totals.original.passed, 3);
  assert.equal(r.totals.original.errors, 1); assert.equal(r.totals.original.notRun, 14); assert.equal(r.totals.candidate.notRun, 15);
  assert.equal(r.cases.slice(2).every(c => c.status === 'not-run'), true);
});
test('selected Key in any batch rubric is refused before emitting a plan or any execution', async t => {
  const h = setup(t); h.config.cases[0].rules.files[0].contains = ['synthetic-batch-model-key-123456'];
  await assert.rejects(h.run(), /output_contains_key/); assert.equal(h.state.keys, 1);
  assert.equal(h.state.events.length, 0); assert.equal(h.state.executions, 0);
});

test('CLI requires new absolute output, explicit confirmation and exact plan hash; plan never accepts run-only switches', async t => {
  const h = setup(t), file = path.join(h.root, 'batch.json'), output = path.join(h.root, 'output.jsonl'), hash = h.plan().summary.planHash;
  assert.equal(argumentsFor(['--config', file, '--plan'])['--plan'], true);
  assert.equal(argumentsFor(['--config', file, '--run', '--confirmed', '--expected-plan', hash, '--output', output])['--expected-plan'], hash);
  for (const args of [['--config', file, '--run', '--confirmed', '--output', output], ['--config', file, '--plan', '--confirmed'],
    ['--config', file, '--plan', '--output', output], ['--config', file, '--run', '--expected-plan', hash, '--output', output],
    ['--config', 'relative', '--plan'], ['--config', file, '--plan', '--expected-plan', hash]]) assert.throws(() => argumentsFor(args), /cli_invalid/);
  await assert.rejects(main(['--config', file, '--run']), /cli_invalid/); assert.equal(fs.existsSync(output), false);
});
