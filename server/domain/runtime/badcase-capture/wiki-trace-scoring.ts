// Tool-first trace scoring. The caller supplies executed structured observations;
// the ordinary scorer still owns all hard assertions and AI evidence/vote rules.
import { validateWikiRubric, wikiRubricFail as fail, type WikiRubric } from './wiki-rubric';
import { prepareWikiScoreFacts, scoreWikiRun, validateWikiJudgeBinding, type WikiScoringRun, type WikiHardAssertion,
  type WikiJudgeAdapter, type WikiJudgeBinding, type WikiScoreResult } from './wiki-scoring-v2';
import type { WikiToolCheckResult } from './wiki-tool-rule-result';
export interface WikiTraceScoreResult extends Omit<WikiScoreResult, 'status' | 'binding'> {
  status: WikiScoreResult['status'] | 'invalid'; binding: WikiJudgeBinding | null; tool: WikiToolCheckResult;
}
export async function scoreWikiTraceRun(options: {
  rubric: WikiRubric; binding: WikiJudgeBinding | null; run: WikiScoringRun; hardAssertions: WikiHardAssertion[];
  referenceMetrics?: WikiScoreResult['referenceMetrics']; tool: WikiToolCheckResult;
}, judge?: WikiJudgeAdapter): Promise<WikiTraceScoreResult> {
  const rubric = validateWikiRubric(options.rubric, true), binding = structuredClone(options.binding);
  if (!rubric.toolCheck) throw fail('wiki_tool_check_required');
  if (rubric.questions.length) validateWikiJudgeBinding(binding!, rubric);
  else if (binding !== null) throw fail('wiki_scoring_config_required');
  const { run, hardAssertions, referenceMetrics } = prepareWikiScoreFacts(options), tool = structuredClone(options.tool);
  const result: WikiTraceScoreResult = { kind: 'wiki-score-v2', status: 'error', reason: null, binding, rubricHash: rubric.hash,
    hardAssertions, votes: [], judgments: [], referenceMetrics, tool };
  const finish = (status: WikiTraceScoreResult['status'], reason: string | null): WikiTraceScoreResult => ({ ...result, status, reason });
  if (run.environmentError === true) return finish('error', 'environment_failure');
  if (tool.status === 'fail') return finish('fail', tool.reason);
  if (hardAssertions.some(c => c.status === 'fail')) return finish('fail', 'hard_assertion_failed');
  if (hardAssertions.some(c => c.status === 'error')) return finish('error', 'hard_evidence_missing');
  if (tool.status === 'invalid') return finish('invalid', tool.reason);
  if (!rubric.questions.length) return tool.status === 'pass' ? finish('pass', null) : finish('invalid', 'no_check_reached');
  // Same full frozen rubric/hash, requested evidence, two-attempt vote retries,
  // and three-vote majority as historical trace scoring. No filtered/rehashed
  // rubric or tool/Goal metadata is supplied to the AI judge.
  const assessment = await scoreWikiRun({ ...options, rubric, binding: binding! }, judge!);
  return { ...assessment, tool };
}
