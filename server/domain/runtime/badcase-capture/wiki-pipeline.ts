// Read-only page projection over already verified Wiki records. No scoring,
// model calls, regrouping or mutation. A raw reply is not a reproduced failure;
// only a strict majority of valid original v2 scores failing under the current
// frozen rubric can prove that. This projects existing results; it starts no checks.
import { wikiGoalCaseNumber } from './wiki-suite';
import { wikiSourceFamily } from './wiki-evaluation-suite';
import { wikiRubricSourceHash } from './wiki-rubric';
import { buildDehydrationPrefix } from './wiki-dehydration';
import { wikiRunHash } from './wiki-run-replay';

// OFFLINE operator only: trace checks may restore a git snapshot; run checks
// read/build the frozen prefix. HTTP must use readWikiPipelineInputs/cache only.
// Trusted readers; return no prepared file/prompt contents.
export function inspectWikiPipelineInputs(state: any, readers: any) {
  return state.cases.flatMap((c: any) => {
    if (wikiSourceFamily(c) !== 'GPT' || [4, 10, 14].includes(wikiGoalCaseNumber(c.id)!)) return [];
    if (c.sealedCheckpointId) {
      const replay = state.replayCases?.find((r: any) => r.sourceCaseId === c.id && r.request?.association?.checkpointId === c.sealedCheckpointId);
      if (!replay || typeof readers.inspectReplay !== 'function') return [{ caseId: c.id, level: 'trace', status: 'pending' }];
      try {
        const result = readers.inspectReplay(replay);
        if (result?.supported === true && result.checkpointHash === replay.checkpointHash) return [{ caseId: c.id, level: 'trace', status: 'supported', checkpointHash: replay.checkpointHash }];
        return [{ caseId: c.id, level: 'trace', status: 'unsupported', reason: /^replay_[a-z_]+$/.test(result?.reason || '') ? result.reason : 'replay_check_failed' }];
      } catch { return [{ caseId: c.id, level: 'trace', status: 'unsupported', reason: 'replay_check_failed' }]; }
    }
    const decision = (state.dehydrations || []).findLast((r: any) => r.caseId === c.id && r.traceHash === c.traceBundle?.hash)?.decision;
    if (decision?.level !== 'run') return [];
    try {
      const { hash, ...value } = decision;
      if (hash !== wikiRunHash(value) || decision.caseId !== c.id || decision.traceHash !== c.traceBundle?.hash || decision.kind !== 'single') {
        return [{ caseId: c.id, level: 'run', status: 'unsupported', reason: 'wiki_run_decision_invalid' }];
      }
      buildDehydrationPrefix(c, readers.readTrace(c.id), decision.cutStep);
      return [{ caseId: c.id, level: 'run', status: 'supported', traceHash: c.traceBundle.hash, decisionHash: hash, cutStep: decision.cutStep }];
    } catch (e: any) {
      return [{ caseId: c.id, level: 'run', status: 'unsupported', reason: /^wiki_(?:dehydration|trace)_[a-z_]+$/.test(e?.code || '') ? e.code : 'wiki_dehydration_prefix_unavailable' }];
    }
  });
}

export function projectWikiPipelineStates({ state, comparisons = [], runReplays = [], replayChecks = [] }: any) {
  return state.cases.map((c: any) => {
    const decision = (state.dehydrations || []).findLast((r: any) => r.caseId === c.id && r.traceHash === c.traceBundle?.hash)?.decision;
    const source = [4, 10, 14].includes(wikiGoalCaseNumber(c.id)!);
    const level = c.sealedCheckpointId ? 'trace' : decision?.level === 'reference' ? 'reference' : decision?.level === 'run' ? 'run' : 'pending';
    const originals = level === 'run' ? runReplays.filter((r: any) => r.caseId === c.id && r.traceHash === c.traceBundle?.hash
      && r.decisionHash === decision?.hash && r.variant?.kind === 'original' && !r.excludedReason && !r.reportOnly) : [];
    const invalidBaseline = originals.some((r: any) => r.status === 'invalid') && !originals.some((r: any) => ['reached', 'pass', 'fail', 'reserved'].includes(r.status));
    const stopReason = wikiSourceFamily(c) !== 'GPT' ? 'report_only' : source ? 'legacy_source' : level === 'reference' ? 'reference_only' : invalidBaseline ? 'invalid_baseline' : null;
    const versions = (state.rubrics || []).filter((r: any) => r.caseId === c.id).sort((a: any, b: any) => b.version - a.version);
    const frozen = versions.find((r: any) => r.status === 'frozen');
    const stale = frozen && frozen.sourceHash !== wikiRubricSourceHash(c.actual, c.expected);
    const incompatible = level === 'run' && frozen?.questions.some((q: any) => q.evidence !== 'reply')
      || level === 'trace' && frozen && !frozen.questions.length && !frozen.toolCheck;
    const assertion = { status: !frozen ? 'missing' : stale ? 'stale' : incompatible ? 'incompatible' : 'frozen',
      version: frozen?.version ?? null, hash: frozen?.hash ?? null, model: frozen?.scoringModel?.model ?? null,
      questions: structuredClone(frozen?.questions || []), draftVersion: versions.find((r: any) => r.status === 'draft' && (!frozen || r.version > frozen.version))?.version ?? null };
    const replay = state.replayCases?.find((r: any) => r.sourceCaseId === c.id && r.request?.association?.checkpointId === c.sealedCheckpointId);
    const check = replayChecks.find((r: any) => r.caseId === c.id && r.level === level && (r.status !== 'supported'
      || level === 'trace' && replay && r.checkpointHash === replay.checkpointHash
      || level === 'run' && r.traceHash === c.traceBundle?.hash && r.decisionHash === decision?.hash));
    const replayStatus = check ? { status: check.status, reason: check.reason ?? null, cutStep: check.cutStep ?? null }
      : { status: 'pending', reason: null, cutStep: null };
    // Do not combine independent executions or use old literals/proxy results.
    // One newest matching batch supplies both the denominator and provenance.
    const match = assertion.status === 'frozen' && !stopReason ? comparisons.filter((r: any) => r.kind === 'wiki-staged-batch-comparison-v2'
      && r.model === 'openai-codex/gpt-6.1-sol'
      && !r.cases.some((v: any) => v.reason === 'operator_interrupted' || v.runs?.some((v: any) => v.reason === 'operator_interrupted')))
      .slice().sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .map((batch: any) => ({ batch, row: batch.cases.find((r: any) => r.sourceCaseId === c.id && !r.reportOnly && r.rubric?.hash === frozen.hash
        && (level === 'trace' ? !r.execution && replay && r.replayId === replay.id && r.comparison?.checkpointHash === replay.checkpointHash
          : level === 'run' && r.execution?.level === 'run' && r.execution.traceBundleHash === c.traceBundle?.hash && r.execution.dehydrationHash === decision?.hash)) }))
      .find((r: any) => r.row?.runs.some((v: any) => v.variant === 'original')) : null;
    const runs = match?.row.runs.filter((r: any) => r.variant === 'original') || [];
    const pass = runs.filter((r: any) => r.status === 'pass').length, fail = runs.filter((r: any) => r.status === 'fail').length;
    const original = { source: match ? 'comparison' : originals.length ? 'run-replay' : null, comparisonId: match?.batch.id ?? null,
      valid: pass + fail, pass, fail, reproduced: fail > (pass + fail) / 2, outputs: level === 'run' ? originals.filter((r: any) => ['reached', 'pass', 'fail'].includes(r.status)).length : pass + fail,
      unscored: match ? 0 : originals.filter((r: any) => r.status === 'reached').length,
      invalid: (match ? runs : originals).filter((r: any) => r.status === 'invalid').length,
      errors: (match ? runs : originals).filter((r: any) => r.status === 'error').length,
      unknown: match ? 0 : originals.filter((r: any) => r.status === 'reserved').length };
    return { caseId: c.id, level, stopReason, assertion, replay: replayStatus, original,
      inLibrary: !stopReason && ['train', 'gate', 'test'].includes(c.split) && assertion.status === 'frozen'
        && replayStatus.status === 'supported' && original.reproduced };
  });
}
