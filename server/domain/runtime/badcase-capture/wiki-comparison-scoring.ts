// Allowlisted v2 result data. These are excerpts/judgments, not worker replies,
// trajectories or transport objects. Historical v1 bytes/hashes stay untouched.
import { validateWikiRubric, wikiExactKeys, wikiRubricText, wikiValueHash, type WikiRubric } from './wiki-rubric';
import { validateWikiJudgeBinding, type WikiJudgeBinding } from './wiki-scoring-v2';
import { containsSecretSentinel } from './secrets';
export const WIKI_COMPARISON_V2_MAX_BYTES = 8 * 1024 * 1024;
const fail = () => Object.assign(Error('wiki_comparison_invalid'), { code: 'wiki_comparison_invalid' });
function check(v: unknown): asserts v { if (!v) throw fail(); }
const same = (a: unknown, b: unknown) => wikiValueHash(a) === wikiValueHash(b);
const digest = (v: any) => { check(typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)); return v; };
const path = (v: any) => typeof v === 'string' && v.length <= 512 && /^[A-Za-z0-9_.@/-]+$/.test(v) && v.split('/').every((p: string) => p && p !== '.' && p !== '..');
export function wikiObjectiveRules(rules: any): any {
  if (rules.kind === 'file-literals-v1') return structuredClone(rules);
  if (rules.kind === 'read-only-files-v1') return { kind: rules.kind, readPaths: rules.readPaths, absentPaths: rules.absentPaths };
  return { kind: 'completion-public-reply-v1' };
}
export function wikiObjectiveAssertionIds(rules: any): string[] {
  return rules.kind === 'file-literals-v1' ? ['files'] : rules.kind === 'read-only-files-v1' ? ['readFiles', 'unchanged'] : [];
}
export function projectWikiScoringSummary(v: any, rubric: WikiRubric, binding: WikiJudgeBinding | null): any {
  wikiExactKeys(v, ['kind', 'configHash', 'rubricId', 'rubricVersion', 'rubricHash', 'binding', 'inputHash']);
  check(v.kind === 'wiki-score-v2' && v.rubricId === rubric.id && v.rubricVersion === rubric.version && v.rubricHash === rubric.hash && same(v.binding, binding));
  if (binding === null) check(rubric.toolCheck && !rubric.questions.length && v.binding === null);
  else validateWikiJudgeBinding(v.binding, rubric);
  return { kind: v.kind, configHash: digest(v.configHash), rubricId: v.rubricId, rubricVersion: v.rubricVersion, rubricHash: v.rubricHash,
    binding: structuredClone(v.binding), inputHash: digest(v.inputHash) };
}
export function projectWikiAssessment(v: any, source: WikiRubric, binding: WikiJudgeBinding, extraIds: string[]): any {
  const rubric = validateWikiRubric(source, true);
  wikiExactKeys(v, ['kind', 'status', 'reason', 'binding', 'rubricHash', 'hardAssertions', 'votes', 'judgments', 'referenceMetrics', ...(Object.hasOwn(v, 'referenceDetails') ? ['referenceDetails'] : [])]);
  check(v.kind === 'wiki-score-v2' && ['pass', 'fail', 'error'].includes(v.status) && v.rubricHash === rubric.hash && same(v.binding, binding));
  validateWikiJudgeBinding(v.binding, rubric);
  check(Array.isArray(v.hardAssertions) && v.hardAssertions.length >= 2 && v.hardAssertions.length <= 130);
  const hardAssertions = v.hardAssertions.map((a: any) => {
    wikiExactKeys(a, ['id', 'status']);
    check(typeof a.id === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(a.id) && ['pass', 'fail', 'error'].includes(a.status));
    return { id: a.id, status: a.status };
  });
  check(same(hardAssertions.map((a: any) => a.id), ['completed', 'publicReply', ...extraIds]) && new Set(hardAssertions.map((a: any) => a.id)).size === hardAssertions.length);
  check(Array.isArray(v.votes) && v.votes.length <= 3);
  const votes = v.votes.map((row: any) => {
    check(Array.isArray(row) && row.length === rubric.questions.length);
    return row.map((j: any, index: number) => {
      wikiExactKeys(j, ['criterionId', 'verdict', 'reason', 'evidence']);
      check(j.criterionId === rubric.questions[index].id && ['satisfied', 'not-satisfied'].includes(j.verdict));
      wikiRubricText(j.reason, 2048);
      check(Array.isArray(j.evidence) && j.evidence.length <= 8 && (j.verdict === 'not-satisfied' || j.evidence.length > 0));
      const evidence = j.evidence.map((q: any) => {
        wikiExactKeys(q, ['source', 'text', ...(q?.source === 'file' ? ['path'] : [])]);
        check(['reply', 'trace', 'file'].includes(q.source) && (q.source !== 'file' || path(q.path))); wikiRubricText(q.text, 4096);
        return { source: q.source, text: q.text, ...(q.source === 'file' ? { path: q.path } : {}) };
      });
      return { criterionId: j.criterionId, verdict: j.verdict, reason: j.reason, evidence };
    });
  });
  const judgments = votes.length === 3 ? rubric.questions.map((q, i) => {
    const verdict = votes.filter((row: any) => row[i].verdict === 'satisfied').length >= 2 ? 'satisfied' : 'not-satisfied';
    return { criterionId: q.id, verdict, majority: true };
  }) : [];
  check(same(v.judgments, judgments));
  const failed = hardAssertions.some((a: any) => a.status === 'fail'), missing = hardAssertions.some((a: any) => a.status === 'error');
  let status: string, reason: string | null;
  if (v.reason === 'environment_failure') { status = 'error'; reason = v.reason; check(votes.length === 0); }
  else if (failed) { status = 'fail'; reason = 'hard_assertion_failed'; check(votes.length === 0); }
  else if (missing) { status = 'error'; reason = 'hard_evidence_missing'; check(votes.length === 0); }
  else if (votes.length < 3) {
    status = 'error'; reason = v.reason;
    check(typeof reason === 'string' && ['judge_evidence_unavailable', 'judge_backend_failed', 'judge_output_invalid'].includes(reason) && (reason !== 'judge_evidence_unavailable' || votes.length === 0));
  } else if (judgments.some(j => j.verdict === 'not-satisfied')) { status = 'fail'; reason = 'rubric_not_satisfied'; }
  else { status = 'pass'; reason = null; }
  check(v.status === status && v.reason === reason);
  const referenceMetrics = v.referenceMetrics;
  check(referenceMetrics && typeof referenceMetrics === 'object' && !Array.isArray(referenceMetrics)
    && Buffer.byteLength(JSON.stringify(referenceMetrics)) <= 16384 && !containsSecretSentinel(JSON.stringify(referenceMetrics)));
  for (const [key, value] of Object.entries(referenceMetrics)) check(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)
    && (value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)));
  return { kind: v.kind, status, reason, binding: structuredClone(binding), rubricHash: rubric.hash, hardAssertions, votes, judgments, referenceMetrics: structuredClone(referenceMetrics) };
}
export function wikiComparisonDisplay(record: any): any {
  return { ...record, scoringKind: record.kind === 'wiki-staged-batch-comparison-v2' ? 'wiki-score-v2' : 'literal-rules-v1',
    scoringLabel: record.kind === 'wiki-staged-batch-comparison-v2' ? '硬断言＋AI 裁判' : '字面规则' };
}
