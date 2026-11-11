// Trusted original-only trace adapter. Reuses sealed preparation, the native
// comparison executor and its receipt scorer, never the run-level shell parser.
const path = require('node:path');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { resolveWikiReplayRequest } = require(base + 'wiki-replay-location');
const { prepareEvaluationCallbackTrace } = require(base + 'evaluation-trace');
const { wikiValueHash } = require(base + 'wiki-rubric');
const { isWikiJudgeTechnicalError } = require(base + 'wiki-scoring-v2');
const { prepareSealedOriginalTurn } = require('./sealed-direct-input.cjs');
const { prepareComparison, runComparison } = require('./direct-comparison.cjs');
const { prepareDirectTurnFiles } = require('./direct-docker.cjs');
const { manifestFor } = require('./pi-probe-materials.cjs');
const { CODEX_PROFILE } = require('./direct-model.cjs');
const { createBudgetedTraceTransport } = require('./wiki-precheck-trace-transport.cjs');
const fail = code => Object.assign(Error(code), { code });
const same = (a, b) => wikiValueHash(a) === wikiValueHash(b);
function comparisonOptions(dependencies, values) {
  // Injection is available only to trusted in-process tests, NOT config JSON.
  const { prepare, stage, executeCodex } = dependencies.traceOptions || {};
  return { knownValues: values, ...(prepare ? { prepare } : {}), ...(stage ? { stage } : {}), ...(executeCodex ? { executeCodex } : {}) };
}
function prepareTracePrecheck(config, { state, item, rubric, binding }, dependencies, values) {
  const trace = config.trace, required = ['repoRoot', 'dependencyRoot', 'image', 'repository', 'dependencies'];
  if (!trace || Array.isArray(trace) || required.some(k => !Object.hasOwn(trace, k))
    || Object.keys(trace).some(k => ![...required, 'dockerBackend'].includes(k))
    || !path.isAbsolute(trace.repoRoot || '') || !path.isAbsolute(trace.dependencyRoot || '')) throw fail('wiki_original_precheck_trace_config_invalid');
  const replay = state.replayCases.find(r => r.sourceCaseId === item.id && r.request?.association?.checkpointId === item.sealedCheckpointId);
  if (!replay || ['projectId', 'conversationId', 'messageId', 'agentId'].some(k => item.source[k] !== replay.request.association[k])) throw fail('wiki_original_precheck_trace_source_changed');
  const request = resolveWikiReplayRequest(config, replay.request), options = comparisonOptions(dependencies, values);
  const turn = (options.prepare || (q => prepareSealedOriginalTurn(q, { knownKeyValues: values })))(request);
  if (!turn.supported || turn.provenance.checkpointHash !== replay.checkpointHash) throw fail('wiki_original_precheck_trace_unavailable');
  const callback = turn.input.callback, prepared = prepareEvaluationCallbackTrace(callback?.trace, callback?.expectedTraceHash, callback?.association);
  if (prepared.seed.agent.id !== item.source.agentId || prepared.seed.assistantMessageId !== item.source.messageId
    || prepared.seed.conversationId !== item.source.conversationId) throw fail('wiki_original_precheck_trace_source_changed');
  const scoring = { kind: 'wiki-score-v2', rubric, binding, task: prepared.seed.userMessage.content, expected: item.expected };
  // One fixed attempt per outer precheck slot. No alternating-valid policy,
  // candidate or replacement attempts can enter this configuration.
  const comparisonConfig = { ...trace, request, variants: ['original'], repeats: 1, scoring, rules: replay.rules,
    modelProfile: CODEX_PROFILE, keySource: 'caff-codex-access', codexAuthFile: config.codexAuthFile, knownKeySources: config.knownKeySources,
    timeoutMs: Math.max(1000, Math.min(config.timeoutMs ?? 600000, config.limits.maxDurationMs)) };
  const comparison = prepareComparison(comparisonConfig, options);
  if (!comparison.supported || comparison.summary.checkpointHash !== replay.checkpointHash) throw fail('wiki_original_precheck_trace_unavailable');
  const files = (options.stage || prepareDirectTurnFiles)(trace.repoRoot, trace.dependencyRoot, trace.image, comparison.inputs.original, CODEX_PROFILE);
  const manifest = manifestFor(files, { replayWorkspace: true });
  // Bind both sealed input and actual staged runtime bytes at --plan, BEFORE
  // confirmation/auth. The comparison verifies these again before execution.
  return { scoring, comparisonConfig, request: { comparison: comparison.summary, inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash } };
}
async function executeTracePrecheck(fixed, config, dependencies, { values, budget, append, judge }) {
  const receipts = [], options = comparisonOptions(dependencies, values), workerBefore = budget.snapshot().workerRequests;
  const comparison = await runComparison(fixed.comparisonConfig, { ...options, confirmed: true, signal: budget.signal, judge,
    createCodexTransport: (cfg, guards) => createBudgetedTraceTransport(cfg, guards, { budget, append, knownValues: values,
      ...(dependencies.createTraceTransport ? { createTransport: dependencies.createTraceTransport } : {}) }),
    onEvent(event) {
      if (event.event === 'plan') {
        const { event: ignored, runtimeHash, ...summary } = event;
        if (!same(summary, fixed.request.comparison) || runtimeHash !== fixed.request.runtimeHash) throw fail('wiki_original_precheck_trace_input_changed');
      }
      append({ event: 'trace_comparison_event', value: event });
    },
    onReceipt(receipt) {
      if (receipt.inputHash !== fixed.request.inputHash || receipt.runtimeHash !== fixed.request.runtimeHash) throw fail('wiki_original_precheck_trace_input_changed');
      // The comparison invokes this hook only AFTER envelope/hash/isolation and
      // known-value checks. Retain native structured args as well as Goal calls.
      receipts.push(structuredClone(receipt)); append({ event: 'trace_receipt', receipt });
    },
  });
  const row = comparison.runs?.[0];
  if (!comparison.supported || comparison.runs.length !== 1 || row.variant !== 'original'
    || !row.cleaned || !/^[a-f0-9]{64}$/.test(row.containerId || '') || row.isolation?.network !== 'none'
    || row.inputHash !== fixed.request.inputHash || receipts.length !== 1
    || row.hostRequestAttempts < 1 || row.hostRequestAttempts !== budget.snapshot().workerRequests - workerBefore
    || comparison.measurements.hostRequestAttempts !== row.hostRequestAttempts || row.modelCalls.length !== row.hostRequestAttempts) throw fail('wiki_original_precheck_trace_evidence_invalid');
  if (row.status === 'error' && !isWikiJudgeTechnicalError(row.assessment)) throw fail('wiki_original_precheck_trace_execution_failed');
  return { packet: { comparison, receipts }, status: row.status };
}
module.exports = { prepareTracePrecheck, executeTracePrecheck };
