// Host-only receipt -> objective assertions/reference metrics -> bound judge.
// Caller must first verify the executor envelope/isolation/input provenance.
// No credentials, provider implementation, prompt or automatic paid call here.
const { scoreWikiRun, bindWikiJudge, validateWikiJudgeBinding } = require('../../build/server/domain/runtime/badcase-capture/wiki-scoring-v2');
const { validateWikiRubric, wikiExactKeys, wikiRubricText, wikiValueHash } = require('../../build/server/domain/runtime/badcase-capture/wiki-rubric');
const { scoreLiteralFiles, parseLiteralEvidence } = require('./file-literal-rules.cjs');
const { scorePublicReply } = require('./public-reply-literal-rules.cjs');
const fail = code => Object.assign(Error(code), { code });
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function validateWikiScoring(value, { runChecks = false } = {}) {
  wikiExactKeys(value, ['kind', 'rubric', 'binding', 'task', 'expected']);
  if (value.kind !== 'wiki-score-v2') throw fail('wiki_scoring_config_required');
  validateWikiRubric(value.rubric, true);
  if (value.rubric.toolCheck && !runChecks && !value.rubric.questions.length) throw fail('wiki_tool_check_run_only');
  if (runChecks && value.rubric.toolCheck && !value.rubric.questions.length) {
    if (value.binding !== null) throw fail('wiki_scoring_config_required');
  } else validateWikiJudgeBinding(value.binding, value.rubric);
  wikiRubricText(value.task, 32768); wikiRubricText(value.expected, 8192);
  return structuredClone(value);
}
function wikiScoringSummary(value, options) {
  value = validateWikiScoring(value, options);
  return { kind: 'wiki-score-v2', configHash: wikiValueHash(value), rubricId: value.rubric.id, rubricVersion: value.rubric.version,
    rubricHash: value.rubric.hash, binding: value.binding, inputHash: wikiValueHash({ task: value.task, expected: value.expected }) };
}
function assertWikiScoringJudge(value, judge, { runChecks = false } = {}) {
  if (runChecks && value.rubric.toolCheck && !value.rubric.questions.length && value.binding === null) return;
  if (!judge || typeof judge.evaluate !== 'function') throw fail('wiki_judge_adapter_required');
  try { if (wikiValueHash(value.binding) === wikiValueHash(bindWikiJudge(judge.configuration, value.rubric))) return; }
  catch { /* Invalid runtime adapter config is drift, not a provider retry. */ }
  throw fail('wiki_judge_binding_changed');
}
function traceSummary(receipt, files) {
  if (!Array.isArray(receipt?.toolCalls) || receipt.toolCalls.some(c => !c || typeof c.name !== 'string' || typeof c.isError !== 'boolean')) return undefined;
  const calls = receipt.toolCalls.map(c => {
    const args = c.args, item = { name: c.name, isError: c.isError };
    if (typeof args?.path === 'string' && ['read', 'write', 'edit'].includes(c.name)) item.path = args.path;
    if (c.name === 'write' && typeof args?.content === 'string') item.content = args.content;
    if (c.name === 'edit' && Array.isArray(args?.edits)) item.edits = args.edits.map(e => typeof e?.oldText === 'string' && typeof e?.newText === 'string'
      ? { oldText: e.oldText, newText: e.newText } : { evidenceMissing: true });
    if (c.name === 'bash' && typeof args?.command === 'string') item.command = args.command;
    // Unknown tool arguments are not guessed or exposed. No arbitrary receipt,
    // runner/model metadata, candidate text, version tags or hidden reasoning.
    return item;
  });
  return JSON.stringify({ toolCalls: calls,
    ...(digest(receipt.beforeHash) && digest(receipt.afterHash) ? { treeChanged: receipt.beforeHash !== receipt.afterHash } : {}),
    ...(files ? { fileEvidence: files.map(f => ({ path: f.path, state: f.state, ...(f.state === 'file' ? { content: f.text } : {}) })) } : {}) });
}
async function scoreWikiReceipt({ receipt, rules, scoring, beforeHash, environmentError = false }, judge) {
  // Lazy to avoid a module cycle when the comparison executor adopts this
  // adapter. Legacy validators/scorers remain authoritative for objective rules.
  const legacy = require('./direct-comparison.cjs');
  rules ??= { kind: 'completion-public-reply-v1' };
  if (rules.kind === 'completion-public-reply-v1') {
    if (Object.keys(rules).join(',') !== 'kind') throw fail('evaluation_rules_invalid');
  } else rules = legacy.validateRules(rules);
  if (!judge || typeof judge.evaluate !== 'function') throw fail('wiki_judge_adapter_required');
  if (!scoring || !scoring.rubric || !scoring.binding) throw fail('wiki_scoring_config_required');
  const hardAssertions = [], referenceMetrics = rules.kind === 'completion-public-reply-v1' ? {} : { legacyRuleKind: rules.kind };
  let referenceDetails = null, files;
  if (rules.kind === 'file-literals-v1') {
    const score = scoreLiteralFiles(receipt, rules);
    hardAssertions.push({ id: 'files', status: score.available === false ? 'error' : score.checks.files ? 'pass' : 'fail' });
    if (score.available !== false) { referenceDetails = score.details; files = parseLiteralEvidence(receipt, rules); }
  } else if (rules.kind === 'read-only-files-v1') {
    if (!digest(beforeHash)) throw fail('evaluation_initial_tree_required');
    if (receipt?.beforeHash !== undefined && receipt.beforeHash !== beforeHash) throw fail('evaluation_initial_tree_changed');
    const score = legacy.scoreReadOnlyFiles(receipt, rules, beforeHash);
    const callsAvailable = Array.isArray(receipt?.toolCalls) && receipt.toolCalls.every(c => c && typeof c.name === 'string' && typeof c.isError === 'boolean');
    hardAssertions.push({ id: 'readFiles', status: !callsAvailable ? 'error' : score.checks.readFiles ? 'pass' : 'fail' },
      { id: 'unchanged', status: !callsAvailable || !digest(receipt?.beforeHash) || !digest(receipt?.afterHash) ? 'error' : score.checks.unchanged ? 'pass' : 'fail' });
    referenceMetrics.replyFragments = score.checks.reply;
  } else if (rules.kind !== 'completion-public-reply-v1') {
    const score = scorePublicReply(receipt, rules);
    referenceMetrics.literalEvidenceAvailable = score.available !== false;
    if (score.available !== false) {
      referenceMetrics.conclusionInLead = score.checks.conclusionInLead;
      referenceMetrics.noForbiddenTerms = score.checks.noForbiddenTerms;
      referenceMetrics.forbiddenCount = score.details.forbidden.length;
      referenceDetails = score.details;
    }
  }
  const completed = typeof receipt?.success === 'boolean' && Array.isArray(receipt.modelCalls) && receipt.modelCalls.length > 0
    && receipt.modelCalls.every(c => typeof c?.success === 'boolean') ? receipt.success && receipt.modelCalls.every(c => c.success) : undefined;
  let trace;
  try { trace = traceSummary(receipt, files); } catch { /* Missing evidence is never fabricated. */ }
  const result = await scoreWikiRun({ rubric: scoring.rubric, binding: scoring.binding, hardAssertions, referenceMetrics,
    run: { completed, replySource: receipt?.replySource, publicReply: receipt?.finalText, task: scoring.task, expected: scoring.expected,
      environmentError: environmentError === true, traceSummary: trace,
      ...(files ? { files: files.filter(f => f.state === 'file').map(f => ({ path: f.path, content: f.text })) } : {}) },
  }, judge);
  return { ...result, referenceDetails };
}
module.exports = { scoreWikiReceipt, validateWikiScoring, wikiScoringSummary, assertWikiScoringJudge };
