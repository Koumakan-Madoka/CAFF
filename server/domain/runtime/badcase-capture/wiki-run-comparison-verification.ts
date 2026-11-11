// Publication proof against immutable attempt packets; no models, tools or
// current runtime prompt. Reading an already saved result needs no live packet.
import { createWikiRunStore } from './wiki-run-store';
import { buildWikiRunRequest, classifyWikiRunOutput, wikiRunHash } from './wiki-run-replay';
import { resolveFrozenWikiRubric, wikiValueHash } from './wiki-rubric';
import { verifyWikiRunWireRequest } from './wiki-run-wire';
import { prepareWikiRunChecks, finishWikiRunChecks } from './wiki-run-checks';
import { finishWikiRunCheckAssessment } from './wiki-run-check-scoring';
const fail = () => Object.assign(Error('wiki_comparison_invalid'), { code: 'wiki_comparison_invalid' });
function check(v: any): asserts v { if (!v) throw fail(); }
const same = (a: any, b: any) => wikiValueHash(a) === wikiValueHash(b);
export function verifyWikiRunPublication(wiki: any, options: any, payload: any, c: any, source: any, candidate: any) {
  try {
    const selection = payload.experiment.cases.find((p: any) => p.caseId === c.sourceCaseId);
    const execution = selection?.execution, decision = wiki.getDehydration(source.id)?.decision;
    check(!source.sealedCheckpointId && !c.replayId && same(execution, c.execution) && execution.level === 'run'
      && execution.traceBundleHash === source.traceBundle?.hash && execution.dehydrationHash === decision?.hash
      && decision.kind === 'single' && decision.level === 'run' && c.rubric
      && same(resolveFrozenWikiRubric(wiki.read(), source.id, c.rubric.hash), c.rubric)
      && same(c.hardAssertionIds, []) && selection.hardAssertionsHash === wikiValueHash({ kind: 'completion-public-reply-v1' }));
    const bundle = wiki.readCaseTrace(source.id), packets = createWikiRunStore(options);
    for (const row of c.runs) {
      const { reservation, result } = packets.read(row.runReplayId), request = reservation.request;
      check(result && result.toolExecutions === 0 && result.requestHash === row.requestHash && reservation.attempt
        && reservation.attempt.planHash === payload.experiment.planHash && reservation.attempt.executionId === payload.executionId
        && reservation.attempt.iteration === row.iteration && request.variant.kind === row.variant
        && request.metadata.caseId === source.id && request.metadata.traceHash === execution.traceBundleHash
        && request.metadata.decisionHash === execution.dehydrationHash);
      const { definitionsHash: _definitionHash, ...versions } = request.metadata.toolset;
      const rebuilt = buildWikiRunRequest({ item: source, bundle, decision, toolset: { ...versions, definitions: request.context.tools },
        ...(row.variant === 'candidate' ? { candidate: { id: candidate.id, targetId: candidate.targetId, baseText: candidate.baseText,
          baseHash: candidate.baseHash, replacement: candidate.candidateText } } : {}) });
      check(wikiRunHash(rebuilt) === row.requestHash);
      if (result.modelCalls === 1) check(verifyWikiRunWireRequest(rebuilt, result.wireRequest, options.knownKeyValues || []));
      if (c.rubric.toolCheck && result.message) {
        const prepared = prepareWikiRunChecks(result.message, c.rubric), final = finishWikiRunChecks(prepared), legacy = classifyWikiRunOutput(result.message);
        check(same(result.checks, { rubricHash: c.rubric.hash, prepared }));
        const outcome = legacy.status === 'error' ? legacy : { status: prepared.needsReplyJudge ? 'reached' : final.status,
          reason: prepared.needsReplyJudge ? null : final.reason, reply: prepared.reply };
        check(same(result.outcome, outcome));
        if (row.checks) {
          check((row.assessment !== undefined) === prepared.needsReplyJudge);
          const checked = finishWikiRunCheckAssessment(prepared, c.rubric, row.assessment);
          check(same(row.checks, checked) && row.status === checked.status && (row.reason ?? null) === checked.reason);
        } else check(row.status === 'error' && row.assessment === undefined);
      } else {
        if (result.message) check(same(classifyWikiRunOutput(result.message), result.outcome));
        if (row.status === 'invalid') check(result.outcome.status === 'invalid' && row.assessment === undefined);
        else if (row.status === 'pass' || row.status === 'fail' || row.assessment !== undefined) check(result.outcome.status === 'reached');
        else check(row.status === 'error');
      }
      if (row.assessment) for (const vote of row.assessment.votes) for (const judgment of vote) for (const quote of judgment.evidence)
        check(quote.source === 'reply' && result.outcome.reply.includes(quote.text));
      const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'], usage = result.message?.usage;
      const called = result.modelCalls === 1, known = called && usage && fields.every(k => Number.isSafeInteger(usage[k]) && usage[k] >= 0);
      const expected = { knownCalls: known ? 1 : 0, callsWithoutUsage: called && !known ? 1 : 0, callsUnavailable: !called,
        knownTokens: known ? Object.fromEntries(fields.map(k => [k, usage[k]])) : null, complete: Boolean(known) };
      check(same(row.tokenUsage, expected));
    }
    check(c.modelCallsKnown === c.runs.filter((r: any) => !r.tokenUsage.callsUnavailable).length
      && c.callsUnavailable === c.runs.some((r: any) => r.tokenUsage.callsUnavailable));
  } catch { throw fail(); }
}
