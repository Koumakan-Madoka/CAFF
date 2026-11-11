// Pure two-stage checks. No judge client, tool executor, filesystem or retries.
// M2's runner must obey needsReplyJudge before contacting the reply-only judge.
import { classifyWikiRunOutput, publicMessage } from './wiki-run-replay';
import { parseWikiToolCall } from './wiki-tool-call-parse';
import { validateWikiToolCheck, wikiToolRulePasses, type WikiToolCheck } from './wiki-tool-check';
import type { WikiRubricQuestion } from './wiki-rubric';
export type WikiRunCheckStatus = 'pass' | 'fail' | 'invalid';
interface CheckResult { status: WikiRunCheckStatus | 'unreached' | 'unconfigured'; reason: string | null }
export interface WikiPreparedRunChecks {
  tool: CheckResult; reply: string | null; needsReplyJudge: boolean; reason: string | null;
}
function toolResult(calls: any[], check: WikiToolCheck): CheckResult {
  let reached = check.mode === 'forbid', unresolved = false, failed = false;
  for (const call of calls) {
    const parsed = parseWikiToolCall(call, check.target);
    if (parsed.kind === 'unknown') { unresolved = true; continue; }
    if (parsed.kind !== 'target') continue;
    reached = true;
    for (const rule of check.rules) {
      const value = parsed.parameters[rule.parameter];
      if (!Object.hasOwn(parsed.parameters, rule.parameter)
        || !(value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value))) {
        unresolved = true; continue;
      }
      if (!wikiToolRulePasses(rule, value as string | number | boolean | null)) failed = true;
    }
  }
  // An observed violation is decisive, even if another call cannot be parsed.
  return failed ? { status: 'fail', reason: 'tool_rule_failed' } : unresolved ? { status: 'invalid', reason: 'arguments_unparseable' }
    : reached ? { status: 'pass', reason: null } : { status: 'unreached', reason: 'target_not_called' };
}
export function prepareWikiRunChecks(message: any, config: { questions: WikiRubricQuestion[]; toolCheck?: WikiToolCheck | null }): WikiPreparedRunChecks {
  const tool: CheckResult = { status: 'unconfigured', reason: null };
  const invalid = (reason: string): WikiPreparedRunChecks => ({ tool, reply: null, needsReplyJudge: false, reason });
  if (message?.role !== 'assistant' || !['stop', 'toolUse'].includes(message.stopReason) || !Array.isArray(message.content)
    || message.content.some((b: any) => !b || typeof b.type !== 'string' || b.type === 'text' && typeof b.text !== 'string')) return invalid('model_failed');
  const calls = message.content.filter((b: any) => b.type === 'toolCall');
  const text = message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
  if (!calls.length && !text.trim()) return invalid('empty_output');
  let reply: string | null;
  if (!config.toolCheck) {
    // Do not widen historical eligibility (especially mixed public/other tools).
    const legacy = classifyWikiRunOutput(message);
    reply = legacy.reply;
  } else {
    Object.assign(tool, toolResult(calls, validateWikiToolCheck(config.toolCheck)));
    const sent = calls.map(publicMessage).filter((s: string | null): s is string => typeof s === 'string' && !!s.trim());
    reply = calls.length ? sent.length ? sent.join('\n') : null : text.trim() ? text : null;
  }
  if (!config.questions.length) reply = null;
  return { tool, reply, needsReplyJudge: !!reply && !['fail', 'invalid'].includes(tool.status), reason: null };
}
export function finishWikiRunChecks(prepared: WikiPreparedRunChecks, replyStatus?: WikiRunCheckStatus): { status: WikiRunCheckStatus; reason: string | null } {
  if (prepared.tool.status === 'fail') return { status: 'fail', reason: prepared.tool.reason };
  if (prepared.needsReplyJudge && replyStatus === 'fail') return { status: 'fail', reason: 'reply_check_failed' };
  if (prepared.reason || prepared.tool.status === 'invalid') return { status: 'invalid', reason: prepared.reason || prepared.tool.reason };
  if (prepared.needsReplyJudge && replyStatus !== 'pass') return { status: 'invalid', reason: 'reply_judge_invalid' };
  return prepared.tool.status === 'pass' || prepared.needsReplyJudge && replyStatus === 'pass'
    ? { status: 'pass', reason: null } : { status: 'invalid', reason: 'no_check_reached' };
}
