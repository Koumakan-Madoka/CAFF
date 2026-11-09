// Allowlisted check summaries for immutable comparison records. Raw messages
// stay in run packets; publication separately recomputes against those packets.
import { wikiExactKeys, wikiValueHash, type WikiRubric } from './wiki-rubric';
import { finishWikiRunCheckAssessment } from './wiki-run-check-scoring';
import type { WikiPreparedRunChecks } from './wiki-run-checks';
import type { WikiScoreResult } from './wiki-scoring-v2';
const fail = () => Object.assign(Error('wiki_comparison_invalid'), { code: 'wiki_comparison_invalid' });
function check(value: unknown): asserts value { if (!value) throw fail(); }
export function projectWikiRunCheckAssessment(value: any, rubric: WikiRubric, assessment?: WikiScoreResult) {
  wikiExactKeys(value, ['kind', 'rubricHash', 'tool', 'reply', 'status', 'reason']);
  check(rubric.toolCheck && value.kind === 'wiki-run-checks-v1' && value.rubricHash === rubric.hash);
  wikiExactKeys(value.tool, ['status', 'reason']);
  const reasons: Record<string, string | null> = { pass: null, fail: 'tool_rule_failed', invalid: 'arguments_unparseable', unreached: 'target_not_called', unconfigured: null };
  check(Object.hasOwn(reasons, value.tool.status) && value.tool.reason === reasons[value.tool.status]);
  const empty = value.tool.status === 'unconfigured';
  check(!empty || value.status === 'invalid' && value.reason === 'empty_output' && !assessment);
  const prepared: WikiPreparedRunChecks = { tool: value.tool, reply: assessment ? 'reply evidence in immutable packet' : null,
    needsReplyJudge: !!assessment, reason: empty ? 'empty_output' : null };
  check(!assessment || rubric.questions.length && !['fail', 'invalid'].includes(value.tool.status));
  const projected = finishWikiRunCheckAssessment(prepared, rubric, assessment);
  check(wikiValueHash(projected) === wikiValueHash(value));
  return projected;
}
