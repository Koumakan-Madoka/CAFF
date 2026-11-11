const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const base = '../../build/server/domain/runtime/badcase-capture/';
const api = () => require('../../scripts/badcase-capture/wiki-receipt-scoring.cjs');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
function fixture(evidence = 'reply') {
  const { createWikiRubric } = require(base + 'wiki-rubric'), { bindWikiJudge } = require(base + 'wiki-scoring-v2');
  const rubric = { ...createWikiRubric({ caseId: 'case', version: 1, model: 'deepseek/deepseek-v4-flash', actual: 'Unclear', expected: 'Clear result', scoringModel: { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash' },
    questions: [{ id: 'q1', question: 'The result is clear.', evidence }, { id: 'q2', question: 'The next step is clear.', evidence: 'reply' }] }),
    status: 'frozen', confirmedAt: '2026-11-04T00:00:00.000Z', confirmationRecord: 'Synthetic user approval' };
  const configuration = { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash', settings: {}, promptHash: hash('synthetic-not-a-judge-prompt') };
  const binding = bindWikiJudge(configuration, rubric), seen = [];
  const judge = { configuration, async evaluate(input) { seen.push(input); return { judgments: rubric.questions.map(q => ({ criterionId: q.id, verdict: 'satisfied', reason: 'Synthetic assessment', evidence: [
    q.evidence === 'trace' ? { source: 'trace', text: input.evidence.traceSummary.text }
      : q.evidence === 'files' ? { source: 'file', path: input.evidence.files[0].path, text: input.evidence.files[0].content }
        : { source: 'reply', text: 'Ready.' },
  ] })) }; } };
  const receipt = { success: true, finalText: 'Ready. Next, test P1.', replySource: 'public', modelCalls: [{ success: true }], beforeHash: hash('tree'), afterHash: hash('tree'),
    toolCalls: [{ name: 'read', args: { path: '/work/restored/a.txt' }, isError: false }] };
  const scoring = { rubric, binding, task: 'Explain the result', expected: 'Clear result' };
  const publicRules = { kind: 'public-reply-literals-v1', leadChars: 20, conclusionMarkers: ['结论'], forbiddenTerms: [], forbiddenPatterns: ['priority-code'] };
  const score = (rules = publicRules, patch = {}) => api().scoreWikiReceipt({ receipt, rules, scoring, beforeHash: hash('tree'), ...patch }, judge);
  return { rubric, scoring, receipt, judge, seen, score, publicRules };
}
function file(content = 'active') { const bytes = Buffer.from(content); return { path: 'status.txt', state: 'file', base64: bytes.toString('base64'), size: bytes.length, sha256: hash(content) }; }
function withTool(h, only = false, tool = { method: 'code', target: { kind: 'caff-chat', name: 'suggest-goal' }, mode: 'on-call', rules: [{ parameter: 'reason', kind: 'max-chars', max: 1000 }] }) {
  const { createWikiRubric } = require(base + 'wiki-rubric'), { bindWikiJudge } = require(base + 'wiki-scoring-v2');
  h.scoring.rubric = { ...createWikiRubric({ ...h.rubric, actual: 'Unclear', expected: 'Clear result', toolCheck: tool,
    ...(only ? { questions: [], scoringModel: null } : {}) }), status: 'frozen', confirmedAt: h.rubric.confirmedAt, confirmationRecord: h.rubric.confirmationRecord };
  h.scoring.binding = only ? null : bindWikiJudge(h.judge.configuration, h.scoring.rubric); h.scoring.kind = 'wiki-score-v2';
  return h;
}
function ledger(...reasons) {
  const executionId = crypto.randomUUID(), seed = null;
  return { kind: 'evaluation-goal-evidence-v1', executionId, goalState: 'unseeded', seed, seedHash: hash(JSON.stringify(seed)),
    calls: reasons.map((reason, i) => ({ executionId, sequence: i + 1, endpoint: 'goal/suggest', parameters: { action: 'pause', reason },
      statusCode: reason.length > 1000 ? 400 : 200, errorCode: null, response: reason.length > 1000 ? { error: 'Goal proposal reason must be 1000 characters or fewer' } : { ok: true } })) };
}
const fileRules = { kind: 'file-literals-v1', files: [{ path: 'status.txt', contains: ['active'], notContains: ['confirmationRequired'] }] };
const readRules = { kind: 'read-only-files-v1', readPaths: ['a.txt'], absentPaths: ['absent.txt'], requiredReplyFragments: ['a legacy lexical fragment'] };
test('trace tool rules apply before the AI judge and a violation is decisive with zero judge calls', async () => {
  const h = fixture('trace'), before = JSON.stringify(h.rubric), { createWikiRubric } = require(base + 'wiki-rubric'), { bindWikiJudge } = require(base + 'wiki-scoring-v2');
  const ordinary = await h.score(); assert.equal(ordinary.status, 'pass'); h.seen.length = 0;
  const rubric = { ...createWikiRubric({ ...h.rubric, actual: 'Unclear', expected: 'Clear result',
    toolCheck: { method: 'code', target: { kind: 'native', name: 'read' }, mode: 'on-call', rules: [{ parameter: 'path', kind: 'allowed-values', values: ['never-matches'] }] } }),
    status: 'frozen', confirmedAt: h.rubric.confirmedAt, confirmationRecord: h.rubric.confirmationRecord };
  const scoring = { ...h.scoring, rubric, binding: bindWikiJudge(h.judge.configuration, rubric), kind: 'wiki-score-v2' };
  assert.equal(api().validateWikiScoring(scoring).rubric.hash, rubric.hash);
  assert.equal(api().wikiScoringSummary(scoring).rubricHash, rubric.hash);
  const withTool = await h.score(h.publicRules, { scoring }); assert.equal(withTool.status, 'fail'); assert.equal(withTool.reason, 'tool_rule_failed'); assert.equal(h.seen.length, 0);
  assert.deepEqual(withTool.tool, { status: 'fail', reason: 'tool_rule_failed' });
  assert.equal(withTool.votes.length, 0); assert.equal(JSON.stringify(h.rubric), before);
});
test('executor receipt bridge treats public literal failures as reference metrics, not pass/fail', async () => {
  const h = fixture(), before = structuredClone(h.publicRules), r = await h.score();
  assert.equal(r.status, 'pass'); assert.equal(h.seen.length, 3); assert.equal(r.referenceMetrics.conclusionInLead, false);
  assert.equal(r.referenceMetrics.noForbiddenTerms, false); assert.equal(r.referenceDetails.forbidden[0].match, 'P1'); assert.deepEqual(h.publicRules, before);
});
test('a new case needs no keyword rules: completion/public reply plus its rubric suffice', async () => {
  const h = fixture();
  const r = await api().scoreWikiReceipt({ receipt: h.receipt, scoring: h.scoring }, h.judge);
  assert.equal(r.status, 'pass'); assert.deepEqual(r.referenceMetrics, {}); assert.equal(h.seen.length, 3);
});
test('existing control file assertions remain hard and cannot be rescued by an accepting judge', async () => {
  const h = fixture(); h.receipt.fileEvidence = [file('confirmationRequired')];
  const r = await h.score(fileRules); assert.equal(r.status, 'fail'); assert.equal(h.seen.length, 0);
  assert.equal(r.hardAssertions.find(c => c.id === 'files').status, 'fail');
});
test('missing or corrupt file evidence is error, never a model failure or a positive judge vote', async () => {
  const h = fixture();
  for (const evidence of [undefined, [], [{ ...file(), sha256: 'f'.repeat(64) }]]) {
    h.receipt.fileEvidence = evidence; assert.equal((await h.score(fileRules)).status, 'error');
  }
  assert.equal(h.seen.length, 0);
});
test('read/unchanged checks stay hard but reply fragments are only reference metrics', async () => {
  const h = fixture(); let r = await h.score(readRules);
  assert.equal(r.status, 'pass'); assert.equal(r.referenceMetrics.replyFragments, false);
  h.receipt.afterHash = hash('modified'); r = await h.score(readRules); assert.equal(r.status, 'fail');
  h.receipt.afterHash = h.receipt.beforeHash; h.receipt.toolCalls = []; assert.equal((await h.score(readRules)).status, 'fail');
});
test('missing read/unchanged evidence is error and explicit initial-tree drift is refused', async () => {
  const h = fixture(); delete h.receipt.toolCalls;
  assert.equal((await h.score(readRules)).status, 'error'); assert.equal(h.seen.length, 0);
  h.receipt.toolCalls = []; h.receipt.beforeHash = hash('other tree');
  await assert.rejects(h.score(readRules), /evaluation_initial_tree_changed/);
});
test('only allowlisted execution/file observations enter the requested trace, without labels or candidate metadata', async () => {
  const h = fixture('trace'); h.receipt.fileEvidence = [file()];
  h.receipt.variant = 'candidate'; h.receipt.candidateGuideline = 'MUST_NOT_ENTER'; h.receipt.toolCalls[0].privateMetadata = 'MUST_NOT_ENTER';
  const r = await h.score(fileRules); assert.equal(r.status, 'pass');
  const input = h.seen[0]; assert.equal(input.evidence.files, undefined); assert.ok(input.evidence.traceSummary.text.includes('active'));
  assert.equal(JSON.stringify(input).includes('MUST_NOT_ENTER'), false); assert.equal(JSON.stringify(input).includes('candidate'), false);
});
test('requested file evidence is decoded/verified before judging and remains referenceable original text', async () => {
  const h = fixture('files'); h.receipt.fileEvidence = [file()]; assert.equal((await h.score(fileRules)).status, 'pass');
  assert.equal(h.seen[0].evidence.files[0].content, 'active'); assert.equal(h.seen[0].evidence.traceSummary, undefined);
});
test('non-file rules cannot supply requested files even when an arbitrary receipt contains them', async () => {
  for (const rules of [{ kind: 'completion-public-reply-v1' }, readRules, fixture().publicRules]) {
    const h = fixture('files'); h.receipt.fileEvidence = [file()];
    const result = await h.score(rules);
    assert.equal(result.status, 'error'); assert.equal(result.reason, 'judge_evidence_unavailable'); assert.equal(h.seen.length, 0);
  }
});
test('no trace/evidence is invented and environment/model completion keep their distinct outcomes', async () => {
  const h = fixture('trace'); delete h.receipt.toolCalls;
  assert.equal((await h.score()).status, 'error'); assert.equal(h.seen.length, 0);
  const other = fixture(); other.receipt.success = false; assert.equal((await other.score()).status, 'fail');
  assert.equal((await other.score(other.publicRules, { environmentError: true })).status, 'error');
});

// Immutable publication follows the same tool/hard/AI precedence as the host.
test('structured trace publication round-trips tool/hard/AI outcomes without exposing callback records', async () => {
  const { projectWikiTraceAssessment, projectWikiAssessment } = require(base + 'wiki-comparison-scoring');
  for (const only of [false, true]) for (const scenario of ['pass', 'violation', 'unreached', 'unavailable', 'hard-fail', 'hard-missing', 'environment', 'judge-down']) {
    const h = withTool(fixture(), only); h.receipt.goalEvidence = ledger(scenario === 'violation' ? 'x'.repeat(1001) : 'ok');
    if (scenario === 'unreached') h.receipt.goalEvidence.calls = [];
    if (['unavailable', 'hard-fail', 'hard-missing'].includes(scenario)) delete h.receipt.goalEvidence;
    if (scenario === 'hard-fail') h.receipt.success = false;
    if (scenario === 'hard-missing') delete h.receipt.success;
    if (scenario === 'judge-down') h.judge.evaluate = async () => { throw Error('synthetic backend failure'); };
    const result = await api().scoreWikiReceipt({ receipt: h.receipt, scoring: h.scoring, environmentError: scenario === 'environment' }, only ? undefined : h.judge);
    const before = JSON.stringify(result), { referenceDetails, ...expected } = result;
    const projected = projectWikiTraceAssessment(result, h.scoring.rubric, h.scoring.binding, []);
    assert.deepEqual(projected, expected, `${only}/${scenario}`); assert.equal(JSON.stringify(result), before);
    assert.equal(Object.hasOwn(projected, 'goalEvidence'), false);
    assert.throws(() => projectWikiAssessment(result, h.scoring.rubric, h.scoring.binding, []), 'legacy projection must not accept structured trace checks');
    for (const patch of [{ status: result.status === 'pass' ? 'fail' : 'pass' }, { tool: { status: 'unconfigured', reason: null } },
      { tool: { status: 'pass', reason: 'tool_rule_failed' } }, { tool: { status: 'fail', reason: 'tool_evidence_unavailable' } }]) {
      assert.throws(() => projectWikiTraceAssessment({ ...result, ...patch }, h.scoring.rubric, h.scoring.binding, []));
    }
  }
});

// Trace D3: the receipt contains callback observations, not parsed bash arguments.
test('tool-only trace config/summary validates with null binding and never needs a judge adapter', async () => {
  const h = withTool(fixture(), true); h.receipt.goalEvidence = ledger('x'.repeat(862));
  assert.equal(api().validateWikiScoring(h.scoring).binding, null);
  assert.equal(api().wikiScoringSummary(h.scoring).binding, null);
  assert.doesNotThrow(() => api().assertWikiScoringJudge(h.scoring));
  const r = await api().scoreWikiReceipt({ receipt: h.receipt, scoring: h.scoring });
  assert.equal(r.status, 'pass'); assert.equal(r.binding, null); assert.equal(r.rubricHash, h.scoring.rubric.hash);
  assert.deepEqual(r.tool, { status: 'pass', reason: null }); assert.deepEqual(r.votes, []); assert.deepEqual(r.judgments, []);
  assert.deepEqual(r.hardAssertions.map(c => c.status), ['pass', 'pass']); assert.equal(h.seen.length, 0);
});
test('recorded parameters decide trace pass/fail for pipeline, heredoc and inline-node shapes, including every retry', async () => {
  const shapes = require('../fixtures/wikiskill-run-tool-call-command-shapes.json').items;
  for (const length of [1000, 1001, 862]) for (const shape of shapes) {
    const h = withTool(fixture(), true); h.receipt.goalEvidence = ledger('x'.repeat(length));
    h.receipt.toolCalls = shape.toolCalls.map(c => ({ name: c.name, args: c.arguments, isError: length > 1000 }));
    const r = await api().scoreWikiReceipt({ receipt: h.receipt, scoring: h.scoring });
    assert.equal(r.status, length > 1000 ? 'fail' : 'pass'); assert.equal(h.seen.length, 0);
  }
  const h = withTool(fixture(), true); h.receipt.goalEvidence = ledger('x'.repeat(1001), 'valid retry');
  assert.equal((await api().scoreWikiReceipt({ receipt: h.receipt, scoring: h.scoring })).status, 'fail');
});
test('trace no-check-reached and unavailable/redacted params are invalid, never an AI rescue or a valid denominator', async () => {
  const h = withTool(fixture(), true); h.receipt.goalEvidence = ledger();
  let r = await api().scoreWikiReceipt({ receipt: h.receipt, scoring: h.scoring });
  assert.equal(r.status, 'invalid'); assert.equal(r.reason, 'no_check_reached');
  delete h.receipt.goalEvidence;
  r = await api().scoreWikiReceipt({ receipt: h.receipt, scoring: h.scoring });
  assert.equal(r.status, 'invalid'); assert.equal(r.reason, 'tool_evidence_unavailable');
  const mixed = withTool(fixture()); mixed.receipt.goalEvidence = ledger('redacted');
  mixed.receipt.goalEvidence.calls[0] = { ...mixed.receipt.goalEvidence.calls[0], parameters: null, redacted: true };
  r = await mixed.score(); assert.equal(r.status, 'invalid'); assert.equal(mixed.seen.length, 0);
});
test('mixed checks retain normal three-vote judging when tools pass or on-call is unreached; judge failures stay errors', async () => {
  for (const reasons of [[], ['valid']]) {
    const h = withTool(fixture('trace')); h.receipt.goalEvidence = ledger(...reasons);
    const r = await h.score(); assert.equal(r.status, 'pass'); assert.equal(h.seen.length, 3);
    assert(h.seen.every(v => v.questions.length === 2 && v.evidence.traceSummary));
    assert.equal(JSON.stringify(h.seen).includes('goalEvidence'), false);
  }
  const h = withTool(fixture()); h.receipt.goalEvidence = ledger('valid');
  h.judge.evaluate = async () => { throw Error('synthetic technical failure'); };
  const r = await h.score(); assert.equal(r.status, 'error'); assert.equal(r.reason, 'judge_backend_failed');
  assert.equal(require(base + 'wiki-scoring-v2').isWikiJudgeTechnicalError(r), true);
});
test('tool checks do not waive trace hard assertions, environment errors, or missing AI evidence', async () => {
  const h = withTool(fixture(), true); h.receipt.goalEvidence = ledger('valid');
  h.receipt.replySource = 'internal'; assert.equal((await api().scoreWikiReceipt({ receipt: h.receipt, scoring: h.scoring })).reason, 'hard_assertion_failed');
  h.receipt.replySource = 'public'; h.receipt.success = false;
  assert.equal((await api().scoreWikiReceipt({ receipt: h.receipt, scoring: h.scoring })).status, 'fail');
  h.receipt.success = true; h.receipt.goalEvidence = ledger('x'.repeat(1001));
  const r = await api().scoreWikiReceipt({ receipt: h.receipt, scoring: h.scoring, environmentError: true });
  assert.equal(r.status, 'error'); assert.equal(r.reason, 'environment_failure');
  const mixed = withTool(fixture('trace')); mixed.receipt.goalEvidence = ledger('valid'); delete mixed.receipt.toolCalls;
  assert.equal((await mixed.score()).reason, 'judge_evidence_unavailable'); assert.equal(mixed.seen.length, 0);
});
