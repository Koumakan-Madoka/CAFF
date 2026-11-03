// Pure host fakes only: no credential source, Docker, model or marked case.
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), crypto = require('node:crypto');
const { prepareComparison, runComparison, expectedTreeHash, formatComparison } = require('../../scripts/badcase-capture/direct-comparison.cjs');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const profile = 'opencode-go/deepseek-v4.1-flash', hash = b => crypto.createHash('sha256').update(b).digest('hex');
function fixture({ failed = false, missingUsage = false, noReceipt = false } = {}) {
  const input = { kind: 'prepared-caff-turn-v1', prompt: 'Original prompt.', sessionText: null, deletions: [], files: [{ path: 'fact.txt', base64: Buffer.from('facts').toString('base64'), sha256: hash('facts') }] };
  const config = { request: {}, repoRoot: path.resolve('.'), dependencyRoot: path.resolve('.'), image: { imageId: 'sha256:' + '1'.repeat(64) }, repeats: 3,
    variants: ['original'], rules: { kind: 'read-only-files-v1', readPaths: ['fact.txt'], absentPaths: [], requiredReplyFragments: ['facts'] } };
  const state = { prepared: 0, staged: 0, executed: 0, keys: 0, events: [] };
  const options = { confirmed: true,
    prepare: (_request, candidate) => { state.prepared++; assert.equal(candidate, undefined, 'original-only must not prepare a replacement');
      return { supported: true, input, provenance: { caseId: 'synthetic', checkpointId: 'checkpoint', checkpointHash: 'fixed', commonInputHash: 'common' } }; },
    stage: (_root, _deps, _image, data) => { state.staged++; assert.equal(data.prompt, input.prompt); return [{ path: 'probe.cjs', bytes: Buffer.from(JSON.stringify(data)) }]; },
    readKey: () => { state.keys++; return 'synthetic-key-for-original-test'; }, onEvent: e => state.events.push(e),
    execute: async (_image, files) => {
      state.executed++; if (noReceipt) return { code: 70, failed: true, cleaned: true };
      const m = manifestFor(files), calls = Array.from({ length: 2 }, (_, i) => ({ model: profile, success: !failed, durationMs: 2,
        httpStatus: failed ? 503 : 200, usage: missingUsage && i === 1 ? null : { input: 11, output: 5, cacheRead: 3, cacheWrite: 0, totalTokens: 19 } }));
      return { code: 0, cleaned: true, receipt: { kind: 'direct-caff-turn-v1', success: !failed, inputHash: m.inputHash, runtimeHash: m.runtimeHash,
        beforeHash: expectedTreeHash(input), afterHash: expectedTreeHash(input), replySource: 'public', finalText: 'facts', modelCalls: calls,
        toolCalls: [{ name: 'read', args: { path: 'fact.txt' }, isError: false }] } };
    },
  };
  return { input, config, state, options };
}
test('original-only plan has exactly one unchanged input, no candidate requirement and no credential/execution side effects', () => {
  const f = fixture(), p = prepareComparison(f.config, f.options);
  assert.equal(p.supported, true); assert.equal(p.summary.kind, 'sealed-original-replay-v1');
  assert.deepEqual(p.summary.variants, ['original']); assert.deepEqual(Object.keys(p.inputs), ['original']);
  assert.deepEqual(Object.keys(p.summary.inputHashes), ['original']); assert.equal(p.inputs.original.prompt, f.input.prompt);
  assert.equal(f.state.prepared, 1); assert.equal(f.state.keys, 0); assert.equal(f.state.executed, 0);
});
test('three original slots only, verified per-run duration/token sums and no candidate denominator or adoption conclusion', async () => {
  const f = fixture(), r = await runComparison(f.config, f.options);
  assert.equal(r.completed, true); assert.equal(f.state.executed, 3); assert.equal(f.state.keys, 1);
  assert.equal(r.runs.length, 3); assert.ok(r.runs.every(row => row.variant === 'original' && row.status === 'pass' && Number.isFinite(row.durationMs) && row.durationMs >= 0));
  assert.deepEqual(r.runs.map(row => row.iteration), [1, 2, 3]); assert.deepEqual(Object.keys(r.totals), ['original']);
  assert.equal(r.totals.original.planned, 3); assert.equal(r.totals.original.passed, 3); assert.equal(r.modelCallsKnown, 6);
  assert.equal(r.measurements.tokenUsage.complete, true); assert.equal(r.measurements.tokenUsage.knownCalls, 6);
  assert.deepEqual(r.measurements.tokenUsage.knownTokens, { input: 66, output: 30, cacheRead: 18, cacheWrite: 0, totalTokens: 114 });
  assert.ok(r.runs.every(row => row.tokenUsage.knownTokens.totalTokens === 38));
  assert.ok(f.state.events.filter(e => e.event === 'run').every(e => e.variant === 'original'));
  const text = formatComparison(r); assert.match(text, /原版单边回放/); assert.match(text, /不产生采纳结论/); assert.doesNotMatch(text, /candidate/);
  assert.match(text, /114/);
});
test('partial/missing usage remains explicitly partial or unknown, not fabricated zero consumption', async () => {
  const partial = fixture({ missingUsage: true }), r = await runComparison(partial.config, partial.options);
  assert.equal(r.measurements.tokenUsage.complete, false); assert.equal(r.measurements.tokenUsage.knownCalls, 3);
  assert.equal(r.measurements.tokenUsage.callsWithoutUsage, 3); assert.equal(r.measurements.tokenUsage.knownTokens.totalTokens, 57);
  const missing = fixture({ noReceipt: true }), m = await runComparison(missing.config, missing.options);
  assert.equal(m.completed, false); assert.equal(m.measurements.tokenUsage.knownTokens, null);
  assert.equal(m.measurements.tokenUsage.callsUnavailable, true); assert.equal(m.measurements.tokenUsage.complete, false);
  assert.equal(m.totals.original.notRun, 2); assert.match(formatComparison(m), /未知/);
});
test('environment failure stops original-only measurement without another slot or candidate', async () => {
  const f = fixture({ failed: true }), r = await runComparison(f.config, f.options);
  assert.equal(r.completed, false); assert.equal(f.state.executed, 1); assert.equal(r.runs[0].status, 'error');
  assert.equal(r.totals.original.notRun, 2); assert.equal(r.totals.candidate, undefined); assert.equal(r.modelCallsKnown, 2);
});
test('token measurement accepts reported zeros but not invalid numbers or overflowing totals', () => {
  const { tokenUsage } = require('../../scripts/badcase-capture/replay-measurements.cjs');
  const zero = { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } };
  assert.equal(tokenUsage([zero]).complete, true); assert.equal(tokenUsage([zero]).knownTokens.totalTokens, 0);
  assert.equal(tokenUsage([]).knownTokens, null); assert.equal(tokenUsage([{ usage: { ...zero.usage, totalTokens: -1 } }]).knownTokens, null);
  const overflow = tokenUsage([{ usage: { ...zero.usage, totalTokens: Number.MAX_SAFE_INTEGER } }, { usage: { ...zero.usage, totalTokens: 1 } }]);
  assert.equal(overflow.overflow, true); assert.equal(overflow.knownTokens, null); assert.equal(overflow.complete, false);
});
test('unsupported variant sets, hidden candidate selections and alternating policy cannot enter original-only mode', () => {
  const f = fixture();
  for (const patch of [{ variants: [] }, { variants: ['candidate'] }, { variants: ['original', 'candidate', 'original'] },
    { candidateRole: 'Do not use me.' }, { wikiCandidate: {} }, { globalWikiCandidate: {} }, { executionPolicy: 'alternating-valid-v1' }]) {
    assert.throws(() => prepareComparison({ ...f.config, ...patch }, f.options), /evaluation_config_invalid/);
  }
  assert.equal(f.state.keys, 0); assert.equal(f.state.executed, 0);
});
