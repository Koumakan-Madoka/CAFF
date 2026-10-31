const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto'), path = require('node:path');
const { validateLiteralRules, scoreLiteralFiles } = require('../../scripts/badcase-capture/file-literal-rules.cjs');
const { prepareComparison, runComparison, expectedTreeHash } = require('../../scripts/badcase-capture/direct-comparison.cjs');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const evidence = text => ({ path: 'output.txt', state: 'file', base64: Buffer.from(text).toString('base64'), sha256: sha(text), size: Buffer.byteLength(text) });
const rules = () => ({ kind: 'file-literals-v1', files: [{ path: 'output.txt', contains: ['REFERENCE RESULT'], notContains: ['FORBIDDEN MARKER'] }] });
const receipt = () => ({ success: true, modelCalls: [{ success: true }], fileEvidence: [evidence('REFERENCE RESULT')] });
function setup() {
  const key = 'synthetic-literal-eval-key-123456', state = { executions: 0, keys: 0, events: [], staged: [] };
  const input = { kind: 'prepared-caff-turn-v1', prompt: 'task', files: [], deletions: [], sessionText: null };
  const config = { repoRoot: path.resolve('.'), dependencyRoot: path.resolve('.'), request: {}, repeats: 2, candidateRole: 'candidate',
    image: { imageId: 'sha256:' + '1'.repeat(64) }, rules: rules() };
  const options = { confirmed: true, readKey: () => { state.keys++; return key; }, onEvent: e => state.events.push(e),
    prepare: (_req, role) => ({ supported: true, input: { ...input, prompt: role || 'original' }, provenance: { checkpointHash: 'cp', commonInputHash: 'common', caseId: 'c1', checkpointId: 'cp1' } }),
    stage: (_r, _d, _i, input) => { state.staged.push(input); return [{ path: 'probe.cjs', bytes: Buffer.from(JSON.stringify(input)) }, { path: 'runtime/test', bytes: Buffer.from('fixed') }]; },
    execute: async (_image, files) => {
      state.executions++; const m = manifestFor(files);
      return { code: 0, cleaned: true, containerId: 'a'.repeat(64), receipt: { kind: 'direct-caff-turn-v1', inputHash: m.inputHash, runtimeHash: m.runtimeHash,
        beforeHash: expectedTreeHash(input), afterHash: sha('changed tree allowed'), finalText: '', replySource: 'none', toolCalls: [{ name: 'write' }],
        ...receipt(), modelCalls: [{ model: 'opencode-go/deepseek-v4.1-flash', success: true, durationMs: 1, usage: null }] } };
    } };
  return { state, config, options, key };
}

test('literal scoring checks UTF-8 final bytes, permits writes, requires file existence even for negative-only rules', () => {
  const r = receipt(); assert.equal(scoreLiteralFiles(r, rules()).pass, true);
  assert.equal(scoreLiteralFiles({ ...r, fileEvidence: [evidence('REFERENCE RESULT FORBIDDEN MARKER')] }, rules()).pass, false);
  assert.equal(scoreLiteralFiles({ ...r, fileEvidence: [evidence('different')] }, rules()).pass, false);
  assert.equal(scoreLiteralFiles({ ...r, success: false }, rules()).pass, false);
  const negative = { kind: 'file-literals-v1', files: [{ path: 'output.txt', contains: [], notContains: ['NO'] }] };
  assert.equal(scoreLiteralFiles({ ...r, fileEvidence: [{ path: 'output.txt', state: 'missing' }] }, negative).pass, false);
  assert.equal(scoreLiteralFiles({ ...r, fileEvidence: [evidence('')] }, negative).pass, true);
});
test('invalid paths, extra fields, empty predicates, duplicate files, oversized or nonliteral fragments reject', () => {
  const base = rules().files[0];
  for (const files of [[{ ...base, path: '../outside' }], [{ ...base, path: 'a/.git/config' }], [{ ...base, path: '/absolute' }],
    [{ ...base, contains: [], notContains: [] }], [base, base], [{ ...base, contains: [''] }], [{ ...base, contains: ['x\0y'] }],
    [{ ...base, contains: ['字'.repeat(400)] }], [{ ...base, semantic: true }]]) {
    assert.throws(() => validateLiteralRules({ kind: 'file-literals-v1', files }), /rules_invalid/);
  }
  assert.throws(() => validateLiteralRules({ ...rules(), rubric: 'hidden' }), /rules_invalid/);
});
test('malformed, missing, binary, secret, mismatched-hash and oversized evidence cannot become task pass/fail', () => {
  const base = evidence('REFERENCE RESULT');
  for (const fileEvidence of [undefined, [], [base, base], [{ ...base, path: 'other' }], [{ ...base, sha256: 'a'.repeat(64) }], [{ ...base, size: 1 }],
    [{ path: 'output.txt', state: 'unsupported' }], [{ ...base, base64: base.base64 + '\n' }], [evidence('a\0b')], [evidence('sk-FAKE_SENTINEL_123456')], [evidence('x'.repeat(65537))]]) {
    assert.equal(scoreLiteralFiles({ ...receipt(), fileEvidence }, rules()).available, false);
  }
});
test('planning stays credential-free; only evidence paths reach both SDK inputs, never predicates', async () => {
  const h = setup(), p = prepareComparison(h.config, h.options);
  assert.deepEqual(p.inputs.original.fileEvidencePaths, ['output.txt']); assert.deepEqual(p.inputs.candidate.fileEvidencePaths, ['output.txt']);
  assert.equal(JSON.stringify(p.inputs).includes('REFERENCE RESULT'), false); assert.equal(h.state.keys, 0);
  const result = await runComparison(h.config, h.options);
  assert.equal(result.completed, true); assert.equal(result.totals.original.passed, 2); assert.equal(result.totals.candidate.passed, 2);
  assert.equal(h.state.staged.every(input => !JSON.stringify(input).includes('REFERENCE RESULT') && !JSON.stringify(input).includes('FORBIDDEN MARKER')), true);
  assert.equal(result.runs.every(r => r.fileEvidence[0].sha256 === sha('REFERENCE RESULT') && r.fileChecks[0].exists), true);
  assert.equal(h.state.events.filter(e => e.event === 'run').every(r => r.fileEvidence.length === 1), true);
});
test('known missing file is a scored failure; unavailable evidence is error and stops, retaining real call records', async () => {
  for (const bad of [undefined, [{ path: 'output.txt', state: 'unsupported' }], [{ path: 'output.txt', state: 'missing' }]]) {
    const h = setup(), execute = h.options.execute;
    h.options.execute = async (...args) => { const task = await execute(...args); task.receipt.fileEvidence = bad; return task; };
    const result = await runComparison(h.config, h.options), missing = bad?.[0].state === 'missing';
    assert.equal(result.completed, missing); assert.equal(result.runs[0].status, missing ? 'fail' : 'error');
    assert.equal(result.modelCallsKnown, missing ? 4 : 1); assert.equal(result.callsUnavailable, false);
    assert.equal(result.totals.candidate.notRun, missing ? 0 : 2);
  }
});
test('selected credential hidden in base64 is refused and never persisted as evidence', async () => {
  const h = setup(), execute = h.options.execute;
  h.options.execute = async (...args) => { const task = await execute(...args); task.receipt.fileEvidence = [evidence(h.key)]; return task; };
  const result = await runComparison(h.config, h.options);
  assert.equal(result.runs[0].status, 'error'); assert.equal(result.callsUnavailable, true);
  assert.equal(JSON.stringify(result).includes(Buffer.from(h.key).toString('base64')), false);
  assert.equal(JSON.stringify(h.state.events).includes(Buffer.from(h.key).toString('base64')), false);
});
