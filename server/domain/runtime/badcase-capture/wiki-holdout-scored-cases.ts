// Shared v4 row projection only. Versioned callers validate the plan, split,
// schedule and decision. This never applies a legacy gate/test formula.
import { projectWikiScoredCases } from './wiki-production-result-v2';
import { wikiValueHash } from './wiki-rubric';
import { projectEvaluationGoalMarker } from './evaluation-goal-evidence';
const invalid = () => Object.assign(Error('wiki_comparison_invalid'), { code: 'wiki_comparison_invalid' });
function check(v: unknown): asserts v { if (!v) throw invalid(); }
const same = (a: any, b: any) => wikiValueHash(a) === wikiValueHash(b);
const id = (v: any) => { check(typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)); return v; };
const digest = (v: any) => { check(typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)); return v; };
const count = (v: any) => { check(Number.isSafeInteger(v) && v >= 0); return v; };
const code = (v: any) => { check(typeof v === 'string' && /^[a-z_]{1,100}$/.test(v)); return v; };
export function projectWikiHoldoutScoredCases(rawCases: any[], experiment: any, splits: string[], totals: (cases: any[], repeats: number) => any): any[] {
  return rawCases.map((raw: any, n: number) => {
    const selection = experiment.cases[n], gate = selection.stage === 'gate', repeats = gate ? 10 : experiment.validation.policy.repeats;
    check(raw.sourceCaseId === selection.caseId && raw.stage === selection.stage && raw.split === splits[n] && raw.category === selection.category
      && raw.family === 'GPT' && raw.reportOnly === false && raw.targetReproduction === gate
      && ['completed', 'error', 'unsupported', 'not-run'].includes(raw.status) && typeof raw.callsUnavailable === 'boolean');
    check(Array.isArray(raw.runs) && raw.runs.length <= 2 * repeats + 5 && (!['unsupported', 'not-run'].includes(raw.status) || raw.runs.length === 0));
    let classification;
    if (raw.classification !== undefined) {
      check(['manual', 'model-confirmed'].includes(raw.classification.source) && typeof raw.classification.confirmedAt === 'string' && Number.isFinite(Date.parse(raw.classification.confirmedAt)));
      classification = { entryId: raw.classification.entryId === null ? null : id(raw.classification.entryId), source: raw.classification.source, confirmedAt: raw.classification.confirmedAt };
    }
    check(!classification || classification.entryId === (gate ? experiment.gate.targetEntryId : selection.entryId));
    const runs = raw.runs.map((r: any) => {
      check(['original', 'candidate'].includes(r.variant) && ['pass', 'fail', 'invalid', 'error'].includes(r.status));
      check(count(r.iteration) > 0);
      return { variant: r.variant, iteration: r.iteration, status: r.status, ...(r.reason === undefined ? {} : { reason: code(r.reason) }),
        replySource: ['public', 'internal', 'none'].includes(r.replySource) ? r.replySource : 'unknown', cleaned: r.cleaned === true, ...projectEvaluationGoalMarker(r) };
    });
    const run = selection.execution.level === 'run';
    check(run ? raw.replayId === null && same(raw.execution, selection.execution) : raw.execution === undefined && (typeof raw.replayId === 'string' || raw.replayId === null && ['unsupported', 'not-run'].includes(raw.status)));
    const comparison = raw.comparison ? Object.fromEntries(['checkpointId', 'checkpointHash', 'rulesHash', 'planHash'].filter(k => raw.comparison[k] !== undefined)
      .map(k => [k, k === 'checkpointId' ? id(raw.comparison[k]) : digest(raw.comparison[k])])) : null;
    const base = { sourceCaseId: selection.caseId, split: raw.split, stage: selection.stage, category: selection.category, family: 'GPT', reportOnly: false, targetReproduction: gate,
      ...(classification ? { classification } : {}), status: raw.status, replayId: raw.replayId === null ? null : id(raw.replayId), comparison,
      ...(raw.reason === undefined ? {} : { reason: code(raw.reason) }), runs, modelCallsKnown: count(raw.modelCallsKnown), callsUnavailable: raw.callsUnavailable };
    if (raw.rubric === undefined) {
      check(!runs.length && ['not-run', 'unsupported'].includes(raw.status) && raw.comparison === null && raw.hardAssertionIds === undefined);
      return { ...base, ...(run ? { execution: structuredClone(selection.execution) } : {}), totals: totals([base], repeats) };
    }
    // Only full v4 validation run summaries carry a stage-specific repeat
    // binding. Validate it here, and leave historical scoring schemas intact.
    let scoringInput = raw;
    if (run && !gate) {
      check(raw.comparison?.repeats === repeats);
      const { repeats: _repeats, ...comparison } = raw.comparison;
      scoringInput = { ...raw, comparison };
    }
    const scored = projectWikiScoredCases([base], [scoringInput], experiment, totals)[0];
    return { ...scored, ...(run && !gate ? { comparison: { ...scored.comparison, repeats } } : {}), totals: totals([scored], repeats) };
  });
}
