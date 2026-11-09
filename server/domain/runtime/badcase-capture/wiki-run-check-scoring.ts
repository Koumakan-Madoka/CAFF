// Reply-only judge adapter for the two-stage single-call check contract.
// No model worker, tool executor or prompt changes. Technical judge failures
// stay separate from invalid outputs and retain the original score-v2 evidence.
import { prepareWikiRunChecks, finishWikiRunChecks, type WikiPreparedRunChecks } from './wiki-run-checks';
import { scoreWikiRun, type WikiJudgeAdapter, type WikiJudgeBinding, type WikiScoreResult } from './wiki-scoring-v2';
import { validateWikiRubric, type WikiRubric } from './wiki-rubric';
export interface WikiRunCheckAssessment {
  kind: 'wiki-run-checks-v1'; rubricHash: string; tool: WikiPreparedRunChecks['tool'];
  reply: 'unconfigured' | 'unreached' | 'pass' | 'fail' | 'invalid' | 'error';
  status: 'pass' | 'fail' | 'invalid' | 'error'; reason: string | null;
}
export function finishWikiRunCheckAssessment(prepared: WikiPreparedRunChecks, rubric: WikiRubric, assessment?: WikiScoreResult): WikiRunCheckAssessment {
  const final = prepared.needsReplyJudge && assessment?.status === 'error'
    ? { status: 'error' as const, reason: assessment.reason }
    : finishWikiRunChecks(prepared, assessment?.status === 'error' ? undefined : assessment?.status);
  return { kind: 'wiki-run-checks-v1', rubricHash: rubric.hash, tool: structuredClone(prepared.tool),
    reply: !rubric.questions.length ? 'unconfigured' : !prepared.needsReplyJudge ? 'unreached' : assessment?.status ?? 'invalid', ...final };
}
export async function scoreWikiRunChecks(input: { message: any; rubric: WikiRubric; binding: WikiJudgeBinding | null; task: string; expected: string }, judge?: WikiJudgeAdapter) {
  const rubric = validateWikiRubric(input.rubric, true);
  if (!rubric.toolCheck || rubric.questions.some(q => q.evidence !== 'reply')) throw Object.assign(Error('wiki_rubric_run_evidence_invalid'), { code: 'wiki_rubric_run_evidence_invalid' });
  const prepared = prepareWikiRunChecks(input.message, rubric);
  const assessment = prepared.needsReplyJudge ? await scoreWikiRun({ rubric, binding: input.binding!, hardAssertions: [],
    run: { completed: true, replySource: 'public', publicReply: prepared.reply!, task: input.task, expected: input.expected } }, judge!) : undefined;
  return { checks: finishWikiRunCheckAssessment(prepared, rubric, assessment), ...(assessment ? { assessment } : {}) };
}
