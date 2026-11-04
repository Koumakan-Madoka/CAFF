const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { classify } = require('../../scripts/badcase-capture/wiki-induction-container.cjs');
const { inductWikiCases } = require('../../scripts/badcase-capture/wiki-induction.cjs');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const key = 'synthetic-private-wiki-key';
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-diagnostics-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createWikiStore({ globalRoot: path.join(root, 'global'), sourceWorktree: path.join(root, 'source') });
  const c = store.addTextCases([{ source: { origin: 'http://127.0.0.1:3100', projectId: null, conversationId: 'c1', messageId: 'm1', agentId: 'role-family-gpt' }, role: 'GPT', actual: 'a', expected: 'b', message: '', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }]).cases[0];
  return { root, store, c, args: { store, confirmed: true, expectedRevision: 1 } };
}
const proposal = id => ({ title: 't', failureMode: 'f', symptoms: 's', rootCauseHypothesis: 'r', guideline: 'g', caseIds: [id] });

test('worker retains exact envelope transiently and identifies the rejected envelope field without retry', async () => {
  const raw = JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"results":[]}' } }] });
  let calls = 0;
  const r = await classify({ cases: [] }, { key, fetchImpl: async () => { calls++; return new Response(raw); } });
  assert.equal(calls, 1); assert.equal(r.modelOutput, raw);
  assert.deepEqual(r.validationIssue, { field: 'choices[0].finish_reason', rule: 'must_equal_stop' });
});

test('store retains strict validation and gives exact result/proposal field and rule', t => {
  const h = setup(t);
  const record = result => h.store.recordInduction({ caseIds: [h.c.id], model: 'deepseek/deepseek-v4-flash', proof: { inputHash: 'a'.repeat(64), calls: [], cleaned: true }, results: [result] }, 1);
  for (const [result, field, rule] of [
    [{ caseId: h.c.id, kind: 'assign', entryId: 'not-approved', reason: 'r', confidence: '高' }, 'results[0].entryId', 'must_reference_approved_entry'],
    [{ caseId: h.c.id, kind: 'new', reason: 'r', confidence: '高', proposal: { ...proposal(h.c.id), symptoms: ['s'] } }, 'results[0].proposal.symptoms', 'wiki_invalid_text'],
    [{ caseId: h.c.id, kind: 'new', reason: 'r', confidence: '高', proposal: { ...proposal(h.c.id), guideline: '字'.repeat(301) } }, 'results[0].proposal.guideline', 'wiki_guideline_too_long'],
  ]) assert.throws(() => record(result), e => { assert.deepEqual(e.validationIssue, { field, rule }); return true; });
  assert.equal(h.store.read().revision, 1);
});

test('default failure logger saves only local redacted raw output; proof and thrown HTTP error never contain it', async t => {
  const h = setup(t), raw = '  {"verbatim":"original layout ' + key + '"}\n';
  const result = { cleaned: true, receipt: { ok: true, results: [], calls: [], modelOutput: raw } }, events = [];
  // Default-on logger, not an injected logger. Directory override is test-only.
  await assert.rejects(inductWikiCases(h.args, { readKey: () => key, execute: async () => result,
    diagnosticDirectory: path.join(process.cwd(), '.tmp', 'wiki-diagnostics-test-' + path.basename(h.root)),
    readDiagnosticValues: () => [key], onEvent: e => events.push(e) }), e => e.code === 'wiki_model_output_invalid' && !JSON.stringify(e).includes(raw));
  const directory = path.join(process.cwd(), '.tmp', 'wiki-diagnostics-test-' + path.basename(h.root));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const names = fs.readdirSync(directory); assert.equal(names.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, names[0]), 'utf8'));
  assert.equal(saved.modelOutput, raw.replace(key, '[*]'));
  assert.deepEqual(saved.validationIssue, { field: 'results', rule: 'must_cover_each_input_once' });
  assert.equal(saved.phase, 'induction'); assert.equal(saved.redactionCount, 1);
  assert.equal(JSON.stringify(events).includes('original layout'), false); assert.equal(h.store.read().revision, 1);
  assert.equal(result.receipt.modelOutput, undefined);
});

test('failed worker output is diagnosed without publication; logger failure cannot expose raw error or retry', async t => {
  const h = setup(t); let count = 0, logs = 0;
  await assert.rejects(inductWikiCases(h.args, { readKey: () => key,
    execute: async () => { count++; return { cleaned: true, receipt: { ok: false, calls: [], modelOutput: 'private', validationIssue: { field: 'content', rule: 'valid_json_required' } } }; },
    writeDiagnostic: details => { logs++; assert.equal(details.modelOutput, 'private'); throw Error('private ' + key); },
  }), e => e.code === 'wiki_generation_failed' && !JSON.stringify(e).includes(key));
  assert.equal(count, 1); assert.equal(logs, 1); assert.equal(h.store.read().revision, 1);
});

test('successful result discards raw envelope and does not write diagnostics', async t => {
  const h = setup(t); let logs = 0;
  const result = { cleaned: true, receipt: { ok: true, calls: [], modelOutput: 'PRIVATE RAW', results: [{ caseId: h.c.id, kind: 'none', reason: 'r', confidence: '低' }] } };
  const saved = await inductWikiCases(h.args, { readKey: () => key, execute: async () => result, writeDiagnostic: () => { logs++; } });
  assert.equal(logs, 0); assert.equal(result.receipt.modelOutput, undefined);
  assert.equal(JSON.stringify(saved).includes('PRIVATE RAW'), false); assert.equal(JSON.stringify(h.store.read()).includes('PRIVATE RAW'), false);
});

test('diagnostic key inventory uses explicit profile plus memory only and never reads refresh fields', t => {
  const h = setup(t), { readDiagnosticValues } = require('../../scripts/badcase-capture/wiki-diagnostics.cjs');
  fs.writeFileSync(path.join(h.root, 'models.json'), JSON.stringify({ providers: { one: { apiKey: '$MODEL_KEY' }, two: { apiKey: 'literal-provider-value' } } }));
  fs.writeFileSync(path.join(h.root, 'auth.json'), JSON.stringify({ 'openai-codex': { access: 'access-only-value', refresh: 'never-use-refresh' } }));
  const values = readDiagnosticValues({ PI_CODING_AGENT_DIR: h.root, MODEL_KEY: 'resolved-model-value', EXTRA_TOKEN: 'memory-value' });
  assert.deepEqual(new Set(values), new Set(['resolved-model-value', 'literal-provider-value', 'access-only-value', 'memory-value']));
  assert.equal(values.includes('never-use-refresh'), false);
  assert.throws(() => readDiagnosticValues({ PI_CODING_AGENT_DIR: h.root }), /wiki_diagnostic_storage_invalid/);
});

test('private diagnostic writer rejects nonignored destinations and redacts escaped and base64 known values', t => {
  const h = setup(t), { writeWikiDiagnostic } = require('../../scripts/badcase-capture/wiki-diagnostics.cjs');
  assert.throws(() => writeWikiDiagnostic({ modelOutput: key, validationIssue: { field: 'x', rule: 'y' } }, { directory: h.root, knownValues: [key] }), /wiki_diagnostic_storage_invalid/);
  const directory = path.join(process.cwd(), '.tmp', 'wiki-diagnostics-test-' + path.basename(h.root));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const secret = 'synthetic-quoted-"value', raw = [secret, JSON.stringify(secret).slice(1, -1), Buffer.from(secret).toString('base64')].join('\n');
  writeWikiDiagnostic({ phase: 'induction', modelOutput: raw, validationIssue: { field: 'results[0]', rule: 'wiki_invalid_input' } }, { directory, knownValues: [secret] });
  const data = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8'));
  assert.equal(data.modelOutput, '[*]\n[*]\n[*]');
  assert.equal(data.redactionCount, 3);
});
