// Real scoring with inert trace/run messages only; no model, tool, container or auth.
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { wikiValueHash: hash } = require(base + 'wiki-rubric');
module.exports = function execution(h, { gateCandidatePasses = 6, validationLoss = 0, prefixes = {} } = {}) {
  h.config.experiment.plan = h.plan().summary.experiment;
  const pinned = h.plan(), events = [], executions = [];
  const compare = async (config, options) => {
    const caseId = config.scoring.rubric.caseId, item = pinned.prepared.find(c => c.sourceCaseId === caseId), repeats = config.repeats ?? 10;
    const run = item.execution?.level === 'run'; assert.equal(repeats, item.stage === 'gate' ? 10 : pinned.summary.experiment.validation.policy.repeats);
    executions.push({ caseId, stage: item.stage, level: run ? 'run' : 'trace', repeats });
    if (!run) options.onEvent({ event: 'plan', runtimeHash: hash('synthetic runtime') });
    const runs = [], valid = { original: 0, candidate: 0 }, attempts = { original: 0, candidate: 0 }; let next = 'original';
    while (valid.original < repeats || valid.candidate < repeats) {
      if (valid[next] === repeats) next = next === 'original' ? 'candidate' : 'original';
      const variant = next, iteration = ++attempts[variant], injected = prefixes[caseId]?.[runs.length];
      const limit = item.stage === 'gate' ? (variant === 'candidate' && caseId === pinned.summary.evaluation.gateCaseIds[0] ? gateCandidatePasses : 0)
        : variant === 'original' ? repeats : repeats - validationLoss;
      const pass = valid[variant] < limit; let assessment, checks, status;
      if (injected === 'error') status = 'error';
      else if (run) {
        const shape = require('../fixtures/wikiskill-run-tool-call-command-shapes.json').items.find(x => x.case === (injected === 'invalid' ? 23 : 22) && x.step === (injected === 'invalid' ? 45 : pass ? 30 : 29));
        const result = await require(base + 'wiki-run-check-scoring').scoreWikiRunChecks({ message: { role: 'assistant', stopReason: 'toolUse', content: shape.toolCalls.map((c, i) => ({ type: 'toolCall', id: 'fake-' + i, ...c })) }, ...config.scoring });
        status = result.checks.status; checks = result.checks; assessment = result.assessment;
      } else {
        const executionId = crypto.randomUUID(), receipt = { success: true, finalText: 'Synthetic public result. PRIVATE-REPLY', replySource: 'public', modelCalls: [{ success: true }], toolCalls: [],
          goalEvidence: { kind: 'evaluation-goal-evidence-v1', executionId, goalState: 'unseeded', seed: null, seedHash: hash(null), calls: injected === 'invalid' ? []
            : [{ executionId, sequence: 1, endpoint: 'goal/suggest', parameters: { action: 'pause', reason: pass ? 'Bounded reason.' : 'x'.repeat(1001) }, statusCode: pass ? 200 : 400, errorCode: null, response: { ok: pass } }] } };
        assessment = await require('../../scripts/badcase-capture/wiki-receipt-scoring.cjs').scoreWikiReceipt({ receipt, rules: config.rules, scoring: config.scoring }); status = assessment.status;
      }
      const row = { variant, iteration, status, ...(assessment ? { assessment } : {}), ...(checks ? { checks, toolExecutions: 0 } : {}),
        ...(status === 'error' ? { reason: 'model_error' } : {}), replySource: 'public', cleaned: true, finalText: 'Synthetic private reply.' };
      if (['pass', 'fail'].includes(status)) valid[variant]++;
      options.onEvent({ event: 'run_start', variant, iteration }); options.onEvent({ event: 'model_call', variant, iteration, model: h.config.modelProfile });
      runs.push(row); options.onEvent({ event: 'run', ...row }); next = next === 'original' ? 'candidate' : 'original';
      if (runs.filter(r => ['invalid', 'error'].includes(r.status)).length === 5) break;
    }
    return { completed: valid.original === repeats && valid.candidate === repeats, runs, modelCallsKnown: runs.length, callsUnavailable: false };
  };
  const options = { ...h.options, confirmed: true, expectedPlanHash: pinned.summary.planHash, onEvent: e => events.push(e), runProductionComparison: (c, o) => { assert.notEqual(c.kind, 'wikiskill-run-comparison-v1'); return compare(c, o); },
    runProductionRunComparison: (c, o) => { assert.equal(c.kind, 'wikiskill-run-comparison-v1'); return compare(c, o); }, readKey: () => assert.fail('No credential read') };
  return { pinned, events, executions, compare, options, run: () => require('../../scripts/badcase-capture/batch-comparison.cjs').runBatch(h.config, options) };
};
