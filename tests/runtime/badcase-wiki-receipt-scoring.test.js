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
  const judge = { configuration, async evaluate(input) { seen.push(input); return { judgments: rubric.questions.map(q => ({ criterionId: q.id, verdict: 'satisfied', reason: 'Synthetic assessment', evidence: [{ source: 'reply', text: 'Ready.' }] })) }; } };
  const receipt = { success: true, finalText: 'Ready. Next, test P1.', replySource: 'public', modelCalls: [{ success: true }], beforeHash: hash('tree'), afterHash: hash('tree'),
    toolCalls: [{ name: 'read', args: { path: '/work/restored/a.txt' }, isError: false }] };
  const scoring = { rubric, binding, task: 'Explain the result', expected: 'Clear result' };
  const publicRules = { kind: 'public-reply-literals-v1', leadChars: 20, conclusionMarkers: ['结论'], forbiddenTerms: [], forbiddenPatterns: ['priority-code'] };
  const score = (rules = publicRules, patch = {}) => api().scoreWikiReceipt({ receipt, rules, scoring, beforeHash: hash('tree'), ...patch }, judge);
  return { rubric, scoring, receipt, judge, seen, score, publicRules };
}
function file(content = 'active') { const bytes = Buffer.from(content); return { path: 'status.txt', state: 'file', base64: bytes.toString('base64'), size: bytes.length, sha256: hash(content) }; }
const fileRules = { kind: 'file-literals-v1', files: [{ path: 'status.txt', contains: ['active'], notContains: ['confirmationRequired'] }] };
const readRules = { kind: 'read-only-files-v1', readPaths: ['a.txt'], absentPaths: ['absent.txt'], requiredReplyFragments: ['a legacy lexical fragment'] };
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
