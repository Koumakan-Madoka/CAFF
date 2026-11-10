// Original-only screening is separate from formal gate/test comparisons. Its
// frozen input identity and policy are deterministic; creating a plan does not
// restore an archive, invoke a model, or change any Wiki snapshot.
import { resolveFrozenWikiRubric, wikiValueHash } from './wiki-rubric';
import { wikiRunHash, WIKI_RUN_MODEL } from './wiki-run-replay';
import { wikiSourceFamily } from './wiki-evaluation-suite';
import { wikiGoalCaseNumber } from './wiki-suite';
import { wikiSceneReportChecks } from './wiki-run-check-scoring';
const fail = (code = 'wiki_original_precheck_invalid') => Object.assign(Error(code), { code });
function check(value: unknown): asserts value { if (!value) throw fail(); }
function shape(v: any, required: string[], optional: string[] = []) {
  check(v && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k))
    && Object.keys(v).every(k => required.includes(k) || optional.includes(k)));
}
function id(v: any) { check(typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)); }
function hash(v: any) { check(typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)); }
export interface WikiOriginalPrecheckPolicy {
  kind: 'original-fixed-attempts-v1'; repeats: number; failureThreshold: number; controlThreshold: number;
}
export type WikiOriginalPrecheckExecution = {
  level: 'trace'; traceHash: string | null; sceneCheckpointId: string; replayId: string; checkpointHash: string;
} | {
  level: 'run'; traceHash: string; sceneCheckpointId: string | null; replayId: string | null; checkpointHash: string | null; decisionHash: string; cutStep: number;
};
export interface WikiOriginalPrecheckPlan {
  kind: 'wiki-original-precheck-plan-v1'; caseId: string; variant: 'original'; model: typeof WIKI_RUN_MODEL;
  execution: WikiOriginalPrecheckExecution; split: 'train' | 'gate' | 'test' | null; rubricHash: string; rubricVersion: number; sourceHash: string;
  inputHash: string; policy: WikiOriginalPrecheckPolicy; reportOnly: boolean; planHash: string;
}
// These are references to host-retained, already scored output packets, not an
// HTTP score submission format. The trusted executor must retain the packet
// before publishing its hash here. No reply, command text, path or auth is stored.
export interface WikiOriginalPrecheckAttempt {
  iteration: number; variant: 'original'; status: 'pass' | 'fail' | 'invalid' | 'error';
  artifactId: string; artifactHash: string; usageComplete: boolean;
}
export interface WikiOriginalPrecheckOutcome {
  status: 'completed' | 'stopped' | 'failed'; reason: string | null; runs: WikiOriginalPrecheckAttempt[];
}
function policy(input: any, level: 'run' | 'trace'): WikiOriginalPrecheckPolicy {
  shape(input, [], ['repeats', 'failureThreshold', 'controlThreshold']);
  const value: WikiOriginalPrecheckPolicy = { kind: 'original-fixed-attempts-v1', repeats: level === 'run' ? 5 : 3,
    failureThreshold: .5, controlThreshold: 1, ...input };
  check(Number.isSafeInteger(value.repeats) && value.repeats >= 1 && value.repeats <= 20
    && Number.isFinite(value.failureThreshold) && value.failureThreshold >= 0 && value.failureThreshold <= 1
    && Number.isFinite(value.controlThreshold) && value.controlThreshold > 0 && value.controlThreshold <= 1);
  return value;
}
export function validateWikiOriginalPrecheckPlan(value: WikiOriginalPrecheckPlan): WikiOriginalPrecheckPlan {
  shape(value, ['kind', 'caseId', 'variant', 'model', 'execution', 'split', 'rubricHash', 'rubricVersion', 'sourceHash', 'inputHash', 'policy', 'reportOnly', 'planHash']);
  check(value.kind === 'wiki-original-precheck-plan-v1' && value.variant === 'original' && value.model === WIKI_RUN_MODEL
    && typeof value.reportOnly === 'boolean' && (value.split === null || ['train', 'gate', 'test'].includes(value.split)));
  id(value.caseId); hash(value.rubricHash); hash(value.sourceHash); hash(value.inputHash); hash(value.planHash);
  check(Number.isSafeInteger(value.rubricVersion) && value.rubricVersion >= 1);
  const e = value.execution;
  if (e?.level === 'trace') {
    shape(e, ['level', 'traceHash', 'sceneCheckpointId', 'replayId', 'checkpointHash']);
    check(!value.reportOnly); id(e.sceneCheckpointId); id(e.replayId); hash(e.checkpointHash); if (e.traceHash !== null) hash(e.traceHash);
  } else {
    shape(e, ['level', 'traceHash', 'sceneCheckpointId', 'replayId', 'checkpointHash', 'decisionHash', 'cutStep']);
    check(e.level === 'run' && Number.isSafeInteger(e.cutStep) && e.cutStep >= 1);
    hash(e.traceHash); hash(e.decisionHash);
    if (value.reportOnly) { id(e.sceneCheckpointId); id(e.replayId); hash(e.checkpointHash); }
    else check(e.sceneCheckpointId === null && e.replayId === null && e.checkpointHash === null);
  }
  shape(value.policy, ['kind', 'repeats', 'failureThreshold', 'controlThreshold']);
  const { kind, ...selected } = value.policy;
  check(kind === 'original-fixed-attempts-v1'); policy(selected, e.level);
  const { planHash, ...payload } = value; check(wikiValueHash(payload) === planHash);
  return structuredClone(value);
}
export function createWikiOriginalPrecheckPlan(input: any): WikiOriginalPrecheckPlan {
  shape(input, ['state', 'caseId', 'rubricHash', 'inputHash', 'replayChecks'], ['policy', 'reportOnly']);
  id(input.caseId); hash(input.inputHash); check(Array.isArray(input.replayChecks));
  check(input.reportOnly === undefined || typeof input.reportOnly === 'boolean');
  const { state, caseId } = input, source = state?.cases?.find((c: any) => c.id === caseId);
  check(source && wikiSourceFamily(source) === 'GPT' && ![4, 10, 14].includes(wikiGoalCaseNumber(caseId)!));
  const rubric = resolveFrozenWikiRubric(state, caseId, input.rubricHash), scene = !!source.sealedCheckpointId, reportOnly = input.reportOnly === true;
  check(!reportOnly || scene);
  let execution: WikiOriginalPrecheckExecution;
  if (scene && !reportOnly) {
    const replay = state.replayCases?.find((r: any) => r.sourceCaseId === caseId && r.request?.association?.checkpointId === source.sealedCheckpointId);
    check(replay && input.replayChecks.some((c: any) => c.caseId === caseId && c.level === 'trace' && c.status === 'supported' && c.checkpointHash === replay.checkpointHash));
    execution = { level: 'trace', traceHash: source.traceBundle?.hash ?? null, sceneCheckpointId: source.sealedCheckpointId,
      replayId: replay.id, checkpointHash: replay.checkpointHash };
  } else {
    const decision = (state.dehydrations || []).findLast((d: any) => d.caseId === caseId && d.traceHash === source.traceBundle?.hash)?.decision;
    const { hash: decisionHash, ...content } = decision || {};
    check(decision?.caseId === caseId && decision.kind === 'single' && decision.level === 'run'
      && decision.traceHash === source.traceBundle?.hash && decisionHash === wikiRunHash(content));
    const replay = reportOnly ? state.replayCases?.find((r: any) => r.sourceCaseId === caseId && r.request?.association?.checkpointId === source.sealedCheckpointId) : null;
    if (reportOnly) {
      check(replay && input.replayChecks.some((c: any) => c.caseId === caseId && c.level === 'trace' && c.status === 'supported' && c.checkpointHash === replay.checkpointHash));
      const observed = wikiSceneReportChecks(rubric); check(observed.toolCheck || observed.questions.length);
    } else {
      check(rubric.questions.every(q => q.evidence === 'reply') && input.replayChecks.some((c: any) => c.caseId === caseId && c.level === 'run'
        && c.status === 'supported' && c.traceHash === source.traceBundle?.hash && c.decisionHash === decisionHash && c.cutStep === decision.cutStep));
    }
    execution = { level: 'run', traceHash: source.traceBundle.hash, sceneCheckpointId: reportOnly ? source.sealedCheckpointId : null,
      replayId: replay?.id ?? null, checkpointHash: replay?.checkpointHash ?? null, decisionHash, cutStep: decision.cutStep };
  }
  const payload: Omit<WikiOriginalPrecheckPlan, 'planHash'> = { kind: 'wiki-original-precheck-plan-v1', caseId, variant: 'original', model: WIKI_RUN_MODEL,
    execution, split: source.split, rubricHash: rubric.hash, rubricVersion: rubric.version, sourceHash: rubric.sourceHash, inputHash: input.inputHash,
    policy: policy(input.policy ?? {}, execution.level), reportOnly };
  return validateWikiOriginalPrecheckPlan({ ...payload, planHash: wikiValueHash(payload) });
}
export function summarizeWikiOriginalPrecheck(plan: WikiOriginalPrecheckPlan, value: WikiOriginalPrecheckOutcome) {
  validateWikiOriginalPrecheckPlan(plan);
  shape(value, ['status', 'reason', 'runs']);
  check(['completed', 'stopped', 'failed'].includes(value.status) && Array.isArray(value.runs) && value.runs.length <= plan.policy.repeats);
  check(value.status === 'completed' ? value.reason === null : typeof value.reason === 'string' && /^[a-z][a-z0-9_]{0,95}$/.test(value.reason));
  for (const [i, row] of value.runs.entries()) {
    shape(row, ['iteration', 'variant', 'status', 'artifactId', 'artifactHash', 'usageComplete']);
    check(row.iteration === i + 1 && row.variant === 'original' && ['pass', 'fail', 'invalid', 'error'].includes(row.status) && typeof row.usageComplete === 'boolean');
    id(row.artifactId); hash(row.artifactHash);
  }
  const complete = value.status === 'completed';
  check(!complete || value.runs.length === plan.policy.repeats && value.runs.every(r => r.usageComplete));
  const pass = value.runs.filter(r => r.status === 'pass').length, failCount = value.runs.filter(r => r.status === 'fail').length, valid = pass + failCount;
  const failureRatio = valid ? failCount / valid : null, passRatio = valid ? pass / valid : null;
  return { planned: plan.policy.repeats, attempted: value.runs.length, valid, pass, fail: failCount,
    invalid: value.runs.filter(r => r.status === 'invalid').length, errors: value.runs.filter(r => r.status === 'error').length,
    failureRatio, passRatio, complete,
    reproduced: !plan.reportOnly && complete && valid > 0 && failureRatio! > plan.policy.failureThreshold,
    // A control needs measured valid answers for the entire configured sample,
    // not an apparently perfect ratio obtained by dropping technical failures.
    controlEligible: !plan.reportOnly && plan.split === 'gate' && complete && valid === plan.policy.repeats && passRatio! >= plan.policy.controlThreshold };
}
