// Pure host orchestration fakes: no Docker/SDK/supplier or credentials are used.
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), crypto = require('node:crypto');
const { prepareComparison, runComparison, scoreReadOnlyFiles, formatComparison, expectedTreeHash } = require('../../scripts/badcase-capture/direct-comparison.cjs');
const { argumentsFor } = require('../../scripts/badcase-capture/compare-sealed.cjs');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const key = 'fake-unit-test-model-key-123456789', model = 'opencode-go/deepseek-v4.1-flash';
function config() {
  return { repoRoot: path.resolve('.'), dependencyRoot: path.resolve('.'), request: {}, image: { imageId: 'sha256:' + '1'.repeat(64) },
    repeats: 2, candidateRole: 'Check every file.', rules: { kind: 'read-only-files-v1', readPaths: ['tracked.txt'], absentPaths: ['deleted.txt'], requiredReplyFragments: ['stable file', 'deleted.txt 不存在'] } };
}
function fakes({ badReply = false, modelError = false, workerError = false, badBefore = false, leaked = false } = {}) {
  const state = { executions: 0, keys: 0, events: [] };
  const input = { kind: 'prepared-caff-turn-v1', files: [{ path: 'tracked.txt', base64: Buffer.from('stable file').toString('base64'),
    sha256: crypto.createHash('sha256').update('stable file').digest('hex') }], prompt: 'original', sessionText: null, deletions: ['deleted.txt'] };
  const prepare = (_request, candidate) => ({ supported: true, input: { ...input, prompt: candidate || 'original' },
    provenance: { caseId: 'case1', checkpointId: 'cp1', checkpointHash: 'c', commonInputHash: 'common' } });
  const stage = (_repo, _deps, _image, input) => [{ path: 'probe.cjs', bytes: Buffer.from(JSON.stringify(input)) }, { path: 'runtime/test', bytes: Buffer.from('same runtime') }];
  const execute = async (_image, files, options) => {
    state.executions++; assert.equal(options.key, key); assert.equal(options.network, 'bridge');
    if (workerError) throw Error('not returned to logs ' + key);
    const m = manifestFor(files), candidate = JSON.parse(files[0].bytes).prompt !== 'original';
    return { code: 0, cleaned: true, containerId: 'a'.repeat(64), isolation: { privileged: false }, receipt: {
      kind: 'direct-caff-turn-v1', inputHash: m.inputHash, runtimeHash: m.runtimeHash, success: !modelError,
      beforeHash: badBefore ? 'wrong' : expectedTreeHash(input), afterHash: expectedTreeHash(input),
      toolCalls: [{ name: 'read', isError: false, args: { path: 'tracked.txt' } }],
      finalText: leaked ? key : badReply && candidate ? 'wrong facts' : 'stable file; deleted.txt 不存在',
      modelCalls: [{ model, durationMs: 10, success: !modelError, httpStatus: modelError ? 401 : 200, usage: null }] } };
  };
  return { state, input, options: { prepare, stage, execute, confirmed: true, readKey: () => { state.keys++; return key; }, onEvent: e => state.events.push(e) } };
}
test('planning is credential/Docker-free; unsupported and unconfirmed inputs cannot run', async () => {
  const f = fakes(); const p = prepareComparison(config(), f.options); assert.equal(p.supported, true); assert.equal(f.state.keys, 0); assert.equal(f.state.executions, 0);
  await assert.rejects(runComparison(config(), { ...f.options, confirmed: false }), /confirmation_required/);
  const no = await runComparison(config(), { ...f.options, prepare: () => ({ supported: false }) });
  assert.equal(no.supported, false); assert.equal(f.state.executions, 0); assert.equal(f.state.keys, 0);
});
test('N real-driver slots per variant, per-call rows, host scoring only after cleanup, exact pass totals', async () => {
  const f = fakes({ badReply: true }), r = await runComparison(config(), f.options);
  assert.equal(r.completed, true); assert.equal(f.state.executions, 4); assert.equal(f.state.keys, 1);
  assert.equal(r.totals.original.passed, 2); assert.equal(r.totals.candidate.passed, 0); assert.equal(r.totals.candidate.failed, 2);
  assert.equal(r.modelCallsKnown, 4); assert.equal(f.state.events.filter(e => e.event === 'model_call').length, 4);
  assert.equal(f.state.events.filter(e => e.event === 'run').length, 4); assert.equal(JSON.stringify(r).includes(key), false);
  assert.match(formatComparison(r), /original: 2\/2/); assert.match(formatComparison(r), /candidate: 0\/2/);
  assert.match(formatComparison(r), /usage=null/);
});
test('model failure stops immediately without retry/candidate; request row retained and not-run denominator explicit', async () => {
  const f = fakes({ modelError: true }), r = await runComparison(config(), f.options);
  assert.equal(f.state.executions, 1); assert.equal(r.completed, false); assert.equal(r.runs[0].status, 'error');
  assert.equal(r.modelCallsKnown, 1); assert.equal(r.callsUnavailable, false); assert.equal(r.totals.original.notRun, 1); assert.equal(r.totals.candidate.notRun, 2);
  assert.equal(f.state.events.find(e => e.event === 'model_call').httpStatus, 401);
});
test('missing worker/cleanup/before-state or leaked output cannot score; raw errors and selected key never logged', async () => {
  for (const setup of [{ workerError: true }, { badBefore: true }, { leaked: true }]) {
    const f = fakes(setup), r = await runComparison(config(), f.options);
    assert.equal(f.state.executions, 1); assert.equal(r.runs[0].status, 'error'); assert.equal(r.callsUnavailable, true);
    assert.equal(r.totals.original.passed, 0); assert.equal(r.modelCallsKnown, 0);
    assert.equal(JSON.stringify(f.state.events).includes(key), false); assert.equal(JSON.stringify(r).includes(key), false);
    assert.match(formatComparison(r), /unknown/);
  }
  const f = fakes(), execute = f.options.execute;
  f.options.execute = async (...args) => ({ ...await execute(...args), cleaned: false });
  assert.equal((await runComparison(config(), f.options)).runs[0].status, 'error');
});
test('seal/distribution/runtime changes cannot silently start from a different point', async () => {
  const f = fakes(), prepare = f.options.prepare; let reads = 0;
  f.options.prepare = (...args) => { const p = prepare(...args); if (++reads > 2) p.provenance.commonInputHash = 'changed'; return p; };
  await assert.rejects(runComparison(config(), f.options), /input_changed/); assert.equal(f.state.executions, 0);
  const g = fakes(), stage = g.options.stage; let stages = 0;
  g.options.stage = (...args) => { const files = stage(...args); if (++stages > 2) files[1].bytes = Buffer.from('changed runtime'); return files; };
  await assert.rejects(runComparison(config(), g.options), /input_changed/); assert.equal(g.state.executions, 0);
});
test('rubric requires actual reads, exact original tree and reply fragments, not worker self-score', () => {
  const c = config(), f = fakes(), beforeHash = expectedTreeHash(f.input), base = { success: true,
    modelCalls: [{ success: true }], toolCalls: [{ name: 'read', isError: false, args: { path: '/work/restored/tracked.txt' } }],
    finalText: 'stable file; deleted.txt 不存在', beforeHash, afterHash: beforeHash, scored: true, pass: true };
  assert.equal(scoreReadOnlyFiles(base, c.rules, beforeHash).pass, true);
  for (const patch of [{ toolCalls: [] }, { afterHash: 'different' }, { finalText: 'done' }, { success: false },
    { toolCalls: [...base.toolCalls, { name: 'write', isError: true }] }]) assert.equal(scoreReadOnlyFiles({ ...base, ...patch }, c.rules, beforeHash).pass, false);
});
test('absence claims in the rubric must match the captured deletion state, never merely a reply fragment', () => {
  const f = fakes(), c = config(); c.rules.absentPaths = ['tracked.txt'];
  assert.throws(() => prepareComparison(c, f.options), /rules_invalid/);
  c.rules.absentPaths = ['never-captured.txt']; assert.throws(() => prepareComparison(c, f.options), /rules_invalid/);
});
test('selected key in rubric is refused before any event or execution, and invalid limits/config have no side effects', async () => {
  const f = fakes(), c = config(); c.rules.requiredReplyFragments.push(key);
  await assert.rejects(runComparison(c, f.options), /output_contains_key/); assert.equal(f.state.events.length, 0); assert.equal(f.state.executions, 0);
  for (const patch of [{ repeats: 0 }, { repeats: 21 }, { timeoutMs: 0 }, { key: 'not permitted in config' }]) assert.throws(() => prepareComparison({ ...config(), ...patch }, f.options), /config_invalid/);
});
test('CLI run requires explicit confirmation and a new output file; plan does not request auth', () => {
  const file = path.resolve('case.json'), output = path.resolve('result.jsonl');
  assert.equal(argumentsFor(['--config', file, '--plan'])['--plan'], true);
  assert.equal(argumentsFor(['--config', file, '--run', '--confirmed', '--output', output])['--run'], true);
  for (const args of [['--config', file, '--run'], ['--config', file, '--run', '--output', output], ['--config', file, '--plan', '--run'],
    ['--config', file, '--plan', '--output', output], ['--config', 'relative', '--plan'], ['--config', file, '--plan', '--unknown']]) assert.throws(() => argumentsFor(args), /cli_invalid/);
});
