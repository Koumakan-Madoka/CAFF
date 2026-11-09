// Prompt-free scoring core. Adapters supply judgments, not the final pass/fail.
// Neither backend is called by default: real adapters/calibration are a later gate.
import { containsSecretSentinel } from './secrets';
import { validateWikiRubric, wikiExactKeys, wikiRubricFail as fail, wikiRubricText, wikiValueHash, type WikiRubric, type WikiRubricQuestion } from './wiki-rubric';
export type WikiVerdict = 'satisfied' | 'not-satisfied';
export type WikiScoreStatus = 'pass' | 'fail' | 'error';
export interface WikiJudgeConfiguration {
  backend: 'deepseek' | 'jev'; model: string; settings: Record<string, string | boolean | number | null>; promptHash: string;
}
export interface WikiJudgeBinding {
  kind: 'wiki-judge-binding-v1'; backend: 'deepseek' | 'jev'; model: string; modelHash: string; promptHash: string; rubricHash: string; passes: 3;
}
export interface WikiJudgeInput {
  task: string; expected: string; questions: WikiRubricQuestion[]; publicReply: string;
  evidence?: { traceSummary?: { text: string; truncated: boolean }; files?: { path: string; content: string; truncated: boolean }[] };
}
export interface WikiJudgeAdapter {
  configuration: WikiJudgeConfiguration;
  evaluate(input: WikiJudgeInput): Promise<unknown>;
}
export interface WikiJudgeCitation { source: 'reply' | 'trace' | 'file'; text: string; path?: string }
export interface WikiCriterionJudgment { criterionId: string; verdict: WikiVerdict; reason: string; evidence: WikiJudgeCitation[] }
export interface WikiHardAssertion { id: string; status: WikiScoreStatus }
export interface WikiScoringRun {
  completed?: boolean; replySource?: 'public' | 'internal' | 'none'; publicReply?: string;
  task?: string; expected?: string; environmentError?: boolean; traceSummary?: string;
  files?: { path: string; content: string; truncated?: boolean }[];
}
export interface WikiScoreResult {
  kind: 'wiki-score-v2'; status: WikiScoreStatus; reason: string | null; binding: WikiJudgeBinding; rubricHash: string;
  hardAssertions: WikiHardAssertion[]; votes: WikiCriterionJudgment[][]; judgments: { criterionId: string; verdict: WikiVerdict; majority: boolean }[];
  referenceMetrics: Record<string, boolean | number | string | null>;
}
// A technical judge error consumes this reply's slot, not a new worker reply.
// Missing evidence and integrity/configuration failures are not in this class.
export function isWikiJudgeTechnicalError(value: { kind?: string; status?: string; reason?: string | null } | undefined): boolean {
  return value?.kind === 'wiki-score-v2' && value.status === 'error'
    && ['judge_backend_failed', 'judge_output_invalid'].includes(value.reason || '');
}
function safeText(value: unknown, cap: number, empty = false): asserts value is string {
  if (empty && value === '') return;
  wikiRubricText(value, cap);
}
export function bindWikiJudge(configuration: WikiJudgeConfiguration, rubric: WikiRubric): WikiJudgeBinding {
  validateWikiRubric(rubric, true);
  wikiExactKeys(configuration, ['backend', 'model', 'settings', 'promptHash']);
  if (rubric.kind === 'wiki-rubric-v2' && (rubric.scoringModel?.backend !== configuration.backend || rubric.scoringModel?.model !== configuration.model)) throw fail('wiki_judge_binding_changed');
  if (!['deepseek', 'jev'].includes(configuration.backend) || !/^[a-f0-9]{64}$/.test(configuration.promptHash)
    || !configuration.settings || typeof configuration.settings !== 'object' || Array.isArray(configuration.settings)
    || Object.keys(configuration.settings).length > 32) throw fail('wiki_judge_config_invalid');
  wikiRubricText(configuration.model, 256);
  if (configuration.backend === 'deepseek' && configuration.model !== 'deepseek/deepseek-v4-flash') throw fail('wiki_judge_config_invalid');
  for (const [key, value] of Object.entries(configuration.settings)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || /^(?:key|apiKey|authorization|password|credential|secret)$/i.test(key)
      || !(value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value))) throw fail('wiki_judge_config_invalid');
  }
  if (Buffer.byteLength(JSON.stringify(configuration)) > 8192 || containsSecretSentinel(JSON.stringify(configuration))) throw fail('wiki_judge_config_invalid');
  return { kind: 'wiki-judge-binding-v1', backend: configuration.backend, model: configuration.model,
    modelHash: wikiValueHash({ backend: configuration.backend, model: configuration.model, settings: configuration.settings }),
    promptHash: configuration.promptHash, rubricHash: rubric.hash, passes: 3 };
}
export function validateWikiJudgeBinding(binding: WikiJudgeBinding, rubric: WikiRubric): WikiJudgeBinding {
  validateWikiRubric(rubric, true);
  wikiExactKeys(binding, ['kind', 'backend', 'model', 'modelHash', 'promptHash', 'rubricHash', 'passes']);
  if (binding.kind !== 'wiki-judge-binding-v1' || !['deepseek', 'jev'].includes(binding.backend) || binding.passes !== 3
    || !/^[a-f0-9]{64}$/.test(binding.modelHash) || !/^[a-f0-9]{64}$/.test(binding.promptHash)
    || binding.rubricHash !== rubric.hash || rubric.kind === 'wiki-rubric-v2'
      && (rubric.scoringModel?.backend !== binding.backend || rubric.scoringModel?.model !== binding.model)) throw fail('wiki_judge_binding_changed');
  wikiRubricText(binding.model, 256);
  if (binding.backend === 'deepseek' && binding.model !== 'deepseek/deepseek-v4-flash') throw fail('wiki_judge_binding_changed');
  return structuredClone(binding);
}
function checkBinding(binding: WikiJudgeBinding, judge: WikiJudgeAdapter, rubric: WikiRubric) {
  // Recomputed before AND after every asynchronous call; no drift is a parse retry.
  try {
    if (wikiValueHash(binding) === wikiValueHash(bindWikiJudge(judge.configuration, rubric))) return;
  } catch { /* Invalid runtime configuration is drift, never a parse retry. */ }
  throw fail('wiki_judge_binding_changed');
}
function boundedText(text: string, maxBytes: number) {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  let size = 0, result = '';
  for (const char of text) { size += Buffer.byteLength(char); if (size > maxBytes) break; result += char; }
  return { text: result, truncated: true };
}
export function buildWikiJudgeInput(run: WikiScoringRun, rubric: WikiRubric, replyOnly = false): WikiJudgeInput {
  validateWikiRubric(rubric, true);
  safeText(run.task, 32768); safeText(run.expected, 8192); safeText(run.publicReply, 1024 * 1024);
  // Never spread run/rubric metadata: no variant, candidate guideline, other
  // results, version, case identifier, source label or hash enters the judge.
  // A scene's single-call report cannot observe trace/file evidence. Keep the
  // full validated frozen rubric/hash for binding, scope only judge questions.
  const questions = replyOnly ? rubric.questions.filter(q => q.evidence === 'reply') : rubric.questions;
  if (!questions.length) throw fail('wiki_judge_evidence_missing');
  const input: WikiJudgeInput = { task: run.task, expected: run.expected, questions: structuredClone(questions), publicReply: run.publicReply };
  const needs = new Set(questions.map(q => q.evidence));
  if (needs.has('trace')) {
    safeText(run.traceSummary, 16 * 1024 * 1024);
    input.evidence = { traceSummary: boundedText(run.traceSummary, 65536) };
  }
  if (needs.has('files')) {
    if (!Array.isArray(run.files) || !run.files.length || run.files.length > 64) throw fail('wiki_judge_evidence_missing');
    const seen = new Set<string>(); let remaining = 262144;
    const files = run.files.map(file => {
      if (!file || typeof file.path !== 'string' || file.path.length > 512 || !/^[A-Za-z0-9_.@/-]+$/.test(file.path)
        || file.path.split('/').some(p => !p || p === '.' || p === '..') || seen.has(file.path)
        || file.truncated !== undefined && typeof file.truncated !== 'boolean') throw fail('wiki_judge_evidence_invalid');
      seen.add(file.path); safeText(file.content, 16 * 1024 * 1024, true);
      const bounded = boundedText(file.content, Math.min(65536, remaining)); remaining -= Buffer.byteLength(bounded.text);
      return { path: file.path, content: bounded.text, truncated: bounded.truncated || file.truncated === true };
    });
    input.evidence = { ...input.evidence, files };
  }
  return input;
}
function parseJudgments(output: unknown, input: WikiJudgeInput): WikiCriterionJudgment[] {
  const value = typeof output === 'string' ? JSON.parse(output) : output;
  wikiExactKeys(value, ['judgments']);
  if (!Array.isArray(value.judgments) || value.judgments.length !== input.questions.length
    || new Set(value.judgments.map((j: any) => j?.criterionId)).size !== input.questions.length) throw fail('wiki_judge_output_invalid');
  return input.questions.map(q => {
    const j = value.judgments.find((v: any) => v?.criterionId === q.id);
    wikiExactKeys(j, ['criterionId', 'verdict', 'reason', 'evidence']);
    // Missing evidence can justify a rejection (e.g. the reply omitted a required
    // explanation), but never a positive assertion. There is no third verdict.
    if (!['satisfied', 'not-satisfied'].includes(j.verdict) || !Array.isArray(j.evidence) || j.evidence.length > 8
      || j.verdict === 'satisfied' && !j.evidence.length) throw fail('wiki_judge_output_invalid');
    safeText(j.reason, 2048);
    for (const quote of j.evidence) {
      wikiExactKeys(quote, ['source', 'text', ...(quote?.source === 'file' ? ['path'] : [])]);
      safeText(quote.text, 4096);
      const source = quote.source === 'reply' ? input.publicReply : quote.source === 'trace' ? input.evidence?.traceSummary?.text
        : quote.source === 'file' ? input.evidence?.files?.find(f => f.path === quote.path)?.content : undefined;
      if (typeof source !== 'string' || !source.includes(quote.text)) throw fail('wiki_judge_output_invalid');
    }
    // All citations above are verified, including the path for file evidence.
    // Positive execution claims need the configured source, not self-report alone.
    const requiredSource = q.evidence === 'files' ? 'file' : q.evidence;
    if (j.verdict === 'satisfied' && !j.evidence.some((quote: WikiJudgeCitation) => quote.source === requiredSource)) throw fail('wiki_judge_output_invalid');
    return structuredClone(j);
  });
}
function aggregateVotes(questions: WikiRubricQuestion[], votes: WikiCriterionJudgment[][]): WikiScoreResult['judgments'] {
  return questions.map((q, i) => {
    const verdict: WikiVerdict = votes.filter(row => row[i].verdict === 'satisfied').length >= 2 ? 'satisfied' : 'not-satisfied';
    return { criterionId: q.id, verdict, majority: true };
  });
}
export async function scoreWikiRun(options: {
  rubric: WikiRubric; binding: WikiJudgeBinding; run: WikiScoringRun; hardAssertions: WikiHardAssertion[];
  referenceMetrics?: WikiScoreResult['referenceMetrics']; replyOnly?: true;
}, judge: WikiJudgeAdapter): Promise<WikiScoreResult> {
  const rubric = validateWikiRubric(options.rubric, true), binding = structuredClone(options.binding);
  checkBinding(binding, judge, rubric);
  const run = structuredClone(options.run), extra = options.hardAssertions;
  if (!Array.isArray(extra) || extra.length > 128 || new Set(extra.map(v => v?.id)).size !== extra.length) throw fail('wiki_hard_assertions_invalid');
  for (const item of extra) {
    wikiExactKeys(item, ['id', 'status']);
    if (typeof item.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.id)
      || ['completed', 'publicReply'].includes(item.id) || !['pass', 'fail', 'error'].includes(item.status)) throw fail('wiki_hard_assertions_invalid');
  }
  const referenceMetrics = options.referenceMetrics ?? {};
  if (!referenceMetrics || typeof referenceMetrics !== 'object' || Array.isArray(referenceMetrics)
    || Buffer.byteLength(JSON.stringify(referenceMetrics)) > 16384 || containsSecretSentinel(JSON.stringify(referenceMetrics))
    || Object.entries(referenceMetrics).some(([k, v]) => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(k)
      || !(v === null || ['string', 'boolean'].includes(typeof v) || typeof v === 'number' && Number.isFinite(v)))) throw fail('wiki_reference_metrics_invalid');
  const hardAssertions: WikiHardAssertion[] = [
    { id: 'completed', status: run.completed === true ? 'pass' : run.completed === false ? 'fail' : 'error' },
    { id: 'publicReply', status: typeof run.publicReply !== 'string' || !['public', 'internal', 'none'].includes(run.replySource || '')
      ? 'error' : run.replySource === 'public' && run.publicReply.trim() ? 'pass' : 'fail' }, ...structuredClone(extra),
  ];
  const result: WikiScoreResult = { kind: 'wiki-score-v2', status: 'error', reason: null, binding, rubricHash: rubric.hash,
    hardAssertions, votes: [], judgments: [], referenceMetrics: structuredClone(referenceMetrics) };
  const finish = (status: WikiScoreStatus, reason: string | null): WikiScoreResult => ({ ...result, status, reason });
  if (run.environmentError === true) return finish('error', 'environment_failure');
  if (hardAssertions.some(c => c.status === 'fail')) return finish('fail', 'hard_assertion_failed');
  if (hardAssertions.some(c => c.status === 'error')) return finish('error', 'hard_evidence_missing');
  let input: WikiJudgeInput;
  try { input = buildWikiJudgeInput(run, rubric, options.replyOnly); }
  catch { return finish('error', 'judge_evidence_unavailable'); }
  for (let vote = 0; vote < 3; vote++) {
    let judgments: WikiCriterionJudgment[] | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      checkBinding(binding, judge, rubric);
      let output: unknown;
      try { output = await judge.evaluate(structuredClone(input)); }
      catch {
        checkBinding(binding, judge, rubric);
        if (attempt === 1) return finish('error', 'judge_backend_failed');
        continue;
      }
      checkBinding(binding, judge, rubric);
      try { judgments = parseJudgments(output, input); break; }
      catch { if (attempt === 1) return finish('error', 'judge_output_invalid'); }
    }
    result.votes.push(judgments!);
  }
  result.judgments = aggregateVotes(input.questions, result.votes);
  if (result.judgments.some(j => j.verdict === 'not-satisfied')) return finish('fail', 'rubric_not_satisfied');
  return finish('pass', null);
}
