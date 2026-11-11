// Shared v4 gate/control execution bindings. This layer never selects cases,
// grants execution permission, or changes assertion/judge scoring semantics.
import { wikiExperimentRunSceneHash, type WikiExperimentCase, type WikiExperimentExecution } from './wiki-experiment-plan';
import { bindWikiJudge, type WikiJudgeBinding, type WikiJudgeConfiguration } from './wiki-scoring-v2';
import { assertWikiEligibleConfiguration, readWikiEligibleJudges } from './wiki-judge-catalog';
import { validateWikiRubric, wikiExactKeys, wikiRubricSourceHash, wikiRubricText, wikiValueHash, wikiRubricFail as fail } from './wiki-rubric';
import { containsSecretSentinel } from './secrets';
const INVALID = 'wiki_holdout_plan_invalid';
function ensure(v: unknown): asserts v { if (!v) throw fail(INVALID); }
const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export interface WikiHoldoutCaseBinding {
  sceneHash: string; inputHash: string; hardAssertionsHash: string; rubricHash: string;
  judge: WikiJudgeBinding | null; execution: WikiExperimentExecution; traceToolCheck?: 'structured-v1';
}
export function validateWikiHoldoutCaseBinding(c: WikiHoldoutCaseBinding, row: { level: 'trace' | 'run'; precheck: { rubricHash: string } }): void {
  for (const key of ['sceneHash', 'inputHash', 'hardAssertionsHash', 'rubricHash'] as const) ensure(digest(c[key]));
  ensure(c.rubricHash === row.precheck.rubricHash && c.execution && c.execution.level === row.level);
  if (c.execution.level === 'trace') wikiExactKeys(c.execution, ['level']);
  else ensure(c.sceneHash === wikiExperimentRunSceneHash(c.execution));
  if (Object.hasOwn(c, 'traceToolCheck')) ensure(c.execution.level === 'trace' && c.traceToolCheck === 'structured-v1');
  const judge = c.judge;
  if (judge === null) { ensure(c.execution.level === 'run' || c.traceToolCheck === 'structured-v1'); return; }
  wikiExactKeys(judge, ['kind', 'backend', 'model', 'modelHash', 'promptHash', 'rubricHash', 'passes']);
  ensure(judge.kind === 'wiki-judge-binding-v1' && ['deepseek', 'jev'].includes(judge.backend) && judge.passes === 3
    && judge.rubricHash === c.rubricHash && digest(judge.modelHash) && digest(judge.promptHash));
  wikiRubricText(judge.model, 256);
  ensure(judge.backend !== 'deepseek' || judge.model === 'deepseek/deepseek-v4-flash');
}
export function bindWikiHoldoutCase(source: WikiExperimentCase, row: { level: 'trace' | 'run'; precheck: { rubricHash: string } }, judgeChoice: WikiJudgeConfiguration | null | undefined,
  eligibleJudges: () => ReturnType<typeof readWikiEligibleJudges>): WikiHoldoutCaseBinding {
  wikiExactKeys(source, ['id', 'sceneHash', 'task', 'actual', 'expected', 'hardAssertions', 'rubric', ...(source.execution === undefined ? [] : ['execution'])]);
  ensure(digest(source.sceneHash) && (source.execution?.level ?? 'trace') === row.level);
  if (source.execution !== undefined) ensure(source.sceneHash === wikiExperimentRunSceneHash(source.execution));
  wikiRubricText(source.task, 32768); wikiRubricText(source.expected, 8192);
  wikiValueHash(source.hardAssertions);
  const text = JSON.stringify(source.hardAssertions); ensure(Buffer.byteLength(text) <= 32768 && !containsSecretSentinel(text));
  const rubric = validateWikiRubric(source.rubric, true);
  ensure(rubric.kind === 'wiki-rubric-v2' && rubric.caseId === source.id && rubric.sourceHash === wikiRubricSourceHash(source.actual, source.expected)
    && rubric.hash === row.precheck.rubricHash);
  if (row.level === 'run' && rubric.questions.some(q => q.evidence !== 'reply')) throw fail('wiki_rubric_run_evidence_invalid');
  const codeOnly = !!rubric.toolCheck && !rubric.questions.length;
  if (codeOnly) ensure(judgeChoice == null);
  const judge = codeOnly ? null : bindWikiJudge(judgeChoice!, rubric);
  if (!codeOnly) assertWikiEligibleConfiguration(judgeChoice!, eligibleJudges());
  return { sceneHash: source.sceneHash, inputHash: wikiValueHash({ task: source.task, expected: source.expected }), hardAssertionsHash: wikiValueHash(source.hardAssertions),
    rubricHash: rubric.hash, judge, execution: source.execution ? structuredClone(source.execution) : { level: 'trace' as const },
    ...(!source.execution && rubric.toolCheck ? { traceToolCheck: 'structured-v1' as const } : {}) };
}
