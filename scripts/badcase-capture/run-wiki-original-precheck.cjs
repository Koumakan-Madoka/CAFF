#!/usr/bin/env node
// Trusted local operator ONLY. No HTTP/page route imports this command. Paid
// execution requires --plan followed by a matching, explicitly approved --run.
// Run/report adapter: one native worker request per attempt, original only.
// Trace restoration is deliberately refused until its budgeted adapter is wired.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { createWikiStore } = require(base + 'wiki-store');
const { createWikiRunStore } = require(base + 'wiki-run-store');
const { createWikiOriginalPrecheckStore } = require(base + 'wiki-original-precheck-store');
const { createWikiOriginalPrecheckPlan } = require(base + 'wiki-original-precheck');
const { createWikiPipelinePrecheckStore, readWikiPipelineInputs } = require(base + 'wiki-pipeline-prechecks');
const { buildWikiRunRequest, replayWikiRun, replayWikiRunReport, wikiRunHash } = require(base + 'wiki-run-replay');
const { pageDehydrationCause } = require(base + 'wiki-dehydration');
const { scoreWikiRunChecks, wikiSceneReportChecks } = require(base + 'wiki-run-check-scoring');
const { bindWikiJudge, scoreWikiRun } = require(base + 'wiki-scoring-v2');
const { verifyWikiRunWireRequest } = require(base + 'wiki-run-wire');
const { wikiValueHash } = require(base + 'wiki-rubric');
const { readWikiEligibleJudges, assertWikiEligibleConfiguration } = require(base + 'wiki-judge-catalog');
const { redactTraceKnownValues } = require(base + 'wiki-trace');
const { precheckApprovalHash, createPrecheckBudget } = require('./wiki-precheck-budget.cjs');
const { CONFIGURATION, createDeepseekWikiJudge } = require('./wiki-judge-deepseek.cjs');
const fail = code => Object.assign(Error(code), { code });
function argumentsFor(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--config', '--plan', '--run', '--confirmed', '--expected-plan', '--approval', '--output'].includes(flag) || Object.hasOwn(args, flag)) throw fail('wiki_original_precheck_arguments_invalid');
    if (['--config', '--output', '--expected-plan', '--approval'].includes(flag)) {
      const value = argv[++i];
      if (typeof value !== 'string' || (['--expected-plan', '--approval'].includes(flag) ? !/^[a-f0-9]{64}$/.test(value) : !path.isAbsolute(value))) throw fail('wiki_original_precheck_arguments_invalid');
      args[flag] = value;
    } else args[flag] = true;
  }
  if (!args['--config'] || !!args['--plan'] === !!args['--run']
    || args['--run'] && (!args['--confirmed'] || !args['--expected-plan'] || !args['--approval'] || !args['--output'])
    || args['--plan'] && ['--confirmed', '--expected-plan', '--approval', '--output'].some(k => args[k])) throw fail('wiki_original_precheck_arguments_invalid');
  return args;
}
function readConfig(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error();
    const c = JSON.parse(fs.readFileSync(file, 'utf8')), required = ['kind', 'globalRoot', 'sourceWorktree', 'caseId', 'rubricHash', 'toolset', 'codexAuthFile', 'knownKeySources', 'judgeCredentialDir', 'stopFile', 'limits'];
    if (!c || Array.isArray(c) || required.some(k => !Object.hasOwn(c, k)) || Object.keys(c).some(k => ![...required, 'policy', 'reportOnly', 'timeoutMs', 'judgeCatalogFile'].includes(k))
      || c.kind !== 'wiki-original-precheck-v1' || !['globalRoot', 'sourceWorktree', 'codexAuthFile', 'judgeCredentialDir', 'stopFile'].every(k => typeof c[k] === 'string' && path.isAbsolute(c[k]))
      || path.basename(c.codexAuthFile) !== 'auth.json' || path.basename(path.dirname(c.codexAuthFile)) !== '.pi-sandbox'
      || !c.knownKeySources || Object.keys(c.knownKeySources).sort().join(',') !== 'jevSource,sandboxRoot'
      || !['TYPESAFE_API_KEY', 'pi-state.sqlite:turn-time-breakdown-jev'].includes(c.knownKeySources.jevSource)
      || typeof c.knownKeySources.sandboxRoot !== 'string' || !path.isAbsolute(c.knownKeySources.sandboxRoot) || path.resolve(c.knownKeySources.sandboxRoot) !== path.dirname(c.codexAuthFile)
      || path.resolve(c.judgeCredentialDir) !== path.resolve(c.knownKeySources.sandboxRoot)
      || c.judgeCatalogFile !== undefined && (typeof c.judgeCatalogFile !== 'string' || !path.isAbsolute(c.judgeCatalogFile))
      || c.reportOnly !== undefined && typeof c.reportOnly !== 'boolean'
      || c.timeoutMs !== undefined && (!Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 1000 || c.timeoutMs > 2700000)) throw Error();
    // Validate all stop lines, without opening auth or creating any resource.
    precheckApprovalHash({ planHash: '0'.repeat(64), limits: c.limits, stopFile: c.stopFile });
    return c;
  } catch { throw fail('wiki_original_precheck_config_invalid'); }
}
function knownValues(config, dependencies) {
  const result = (dependencies.readKnownValues || (sources => require('./known-key-values.cjs').readKnownKeyValues(sources).values))(config.knownKeySources);
  if (!Array.isArray(result) || result.some(v => typeof v !== 'string')) throw fail('wiki_original_precheck_config_invalid');
  return [...result];
}
function prepare(config, dependencies, values) {
  const store = (dependencies.createStore || createWikiStore)(config), state = store.read(), item = state.cases.find(c => c.id === config.caseId);
  if (!item) throw fail('wiki_unknown_case');
  if (item.sealedCheckpointId && !config.reportOnly) throw fail('wiki_original_precheck_trace_adapter_required');
  const rubric = store.getFrozenRubric(config.caseId, config.rubricHash), bundle = store.readCaseTrace(config.caseId), decision = store.getDehydration(config.caseId)?.decision;
  const request = buildWikiRunRequest({ item, bundle, decision, toolset: config.toolset, ...(config.reportOnly ? { reportOnly: true, rubricHash: rubric.hash } : {}) });
  if (redactTraceKnownValues(request, values).count) throw fail('wiki_run_input_contains_known_key');
  const observed = config.reportOnly ? wikiSceneReportChecks(rubric) : rubric;
  let attestation = null;
  if (observed.questions.length) {
    const eligible = readWikiEligibleJudges(config.judgeCatalogFile);
    assertWikiEligibleConfiguration(CONFIGURATION, eligible);
    attestation = eligible.find(j => j.configurationHash === wikiValueHash(CONFIGURATION));
  }
  const plan = createWikiOriginalPrecheckPlan({ state, caseId: config.caseId, rubricHash: config.rubricHash, inputHash: wikiRunHash(request), judge: attestation,
    replayChecks: readWikiPipelineInputs(state, createWikiPipelinePrecheckStore(config)), ...(config.policy ? { policy: config.policy } : {}), ...(config.reportOnly ? { reportOnly: true } : {}) });
  const scoring = { rubric, binding: observed.questions.length ? bindWikiJudge(CONFIGURATION, rubric) : null, task: pageDehydrationCause(bundle).text, expected: item.expected };
  return { store, plan, request, scoring };
}
function judgeUsage(bytes) {
  try {
    const e = JSON.parse(bytes), u = JSON.parse(Buffer.from(e.body, 'base64')).usage;
    if (e.status !== 200 || !u) return null;
    const cacheRead = u.prompt_cache_hit_tokens ?? 0;
    return { input: u.prompt_tokens - cacheRead, output: u.completion_tokens, cacheRead, cacheWrite: 0, totalTokens: u.total_tokens };
  } catch { return null; }
}
async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = argumentsFor(argv), config = readConfig(args['--config']), values = knownValues(config, dependencies), fixed = prepare(config, dependencies, values);
  const approval = { planHash: fixed.plan.planHash, limits: config.limits, stopFile: config.stopFile }, approvalHash = precheckApprovalHash(approval);
  const print = dependencies.print || (text => process.stdout.write(text));
  if (args['--plan']) {
    const result = { preparedOnly: true, plan: fixed.plan, limits: config.limits, approvalHash, notFormalStatistics: true };
    print(JSON.stringify(result, null, 2) + '\n'); return result;
  }
  if (args['--expected-plan'] !== fixed.plan.planHash || args['--approval'] !== approvalHash) throw fail('wiki_precheck_confirmation_required');
  let fd, reservation, judge, fatal = null;
  const records = createWikiOriginalPrecheckStore(config), attempts = [];
  const append = event => {
    // Known-value inventory plus the selected judge key are host-only. Scan ALL
    // retained raw output/usage/errors, not only the page-safe final projection.
    const safe = redactTraceKnownValues(event, values).value;
    fs.writeSync(fd, JSON.stringify(safe) + '\n'); fs.fsyncSync(fd);
  };
  const budget = createPrecheckBudget({ ...approval, confirmed: true, approvalHash }, { onEvent: append });
  function getJudge() {
    if (fixed.scoring.binding === null) return undefined;
    if (!judge) {
      if (!budget.check()) throw fail('wiki_precheck_stopped');
      const key = (dependencies.readJudgeKey || require('./direct-model.cjs').readCaffDeepseekKey)({ ...process.env, PI_CODING_AGENT_DIR: config.judgeCredentialDir });
      if (!values.includes(key)) { fatal = 'wiki_original_precheck_key_inventory_mismatch'; throw fail(fatal); }
      // The bound adapter still owns three-vote/retry semantics. Budget EACH
      // actual exchange below it, so technical judge retries cannot evade caps.
      judge = createDeepseekWikiJudge({ key, maxRequests: config.limits.maxRequests, onCall: event => append({ event: 'judge_call', ...event }) }, {
        createExchange(options) {
          if (!budget.check()) throw fail('wiki_precheck_stopped');
          const exchange = (dependencies.createJudgeExchange || require('./wiki-host-model.cjs').createWikiHostExchange)({ ...options, signal: budget.signal });
          return { exchange: bytes => budget.request('judge', () => exchange.exchange(bytes), judgeUsage), close: () => exchange.close() };
        },
      });
    }
    return judge;
  }
  try {
    fd = fs.openSync(args['--output'], 'wx', 0o600);
    reservation = records.reserve(fixed.plan);
    // Separate retention root: precheck outputs must never enter ordinary run
    // accounting, report counts, formal comparison stores, gate or test data.
    const packetRoot = path.join(config.globalRoot, 'original-precheck-outputs', reservation.id), packets = createWikiRunStore({ ...config, globalRoot: packetRoot });
    append({ event: 'precheck_reserved', reservation, approval: { ...approval, approvalHash }, packetRoot, request: fixed.request });
    for (let iteration = 1; iteration <= fixed.plan.policy.repeats; iteration++) {
      if (!budget.check()) break;
      let fresh;
      try { fresh = prepare(config, dependencies, values); }
      catch { fatal = 'wiki_original_precheck_stale'; break; }
      if (fresh.plan.planHash !== fixed.plan.planHash || wikiValueHash(fresh.scoring) !== wikiValueHash(fixed.scoring)) { fatal = 'wiki_original_precheck_stale'; break; }
      let client, cleanupFailed = false;
      let packet, scored;
      try {
        const input = { store: fixed.store, runs: packets, caseId: config.caseId, toolset: config.toolset, approvedRequestHash: fixed.plan.inputHash,
          // Every precheck attempt gets its own packet execution ID. Outer
          // iteration/batch identity lives in the immutable precheck result;
          // this does not widen legacy formal runStore's 15-slot contract.
          attempt: { planHash: fixed.plan.planHash, executionId: crypto.randomUUID(), iteration: 1 },
          ...(config.reportOnly || fixed.scoring.rubric.toolCheck ? { rubricHash: config.rubricHash } : {}) };
        const adapter = { complete: q => budget.request('worker', async signal => {
          client = await (dependencies.createRunClient || require('./wiki-run-client.cjs').createWikiRunClient)({ authFile: config.codexAuthFile, knownKeyValues: values, signal,
            timeoutMs: Math.max(1000, Math.min(config.timeoutMs ?? 600000, config.limits.maxDurationMs)) });
          return client.complete(q);
        }, result => result?.networkRequests === 1 ? result.message?.usage : null) };
        // Lazy judge wrapper: report validation needs an adapter before worker
        // execution, but a tool-first failure never reads a judge credential.
        const judgeAdapter = fixed.scoring.binding === null ? undefined : { configuration: CONFIGURATION, evaluate: input => getJudge().evaluate(input) };
        packet = await (config.reportOnly ? replayWikiRunReport : replayWikiRun)(input, { confirmed: true, knownKeyValues: values, client: adapter, judge: judgeAdapter });
        const validWire = packet.modelCalls === 1 && verifyWikiRunWireRequest(fixed.request, packet.wireRequest, values);
        if (!validWire) fatal = packet.modelCalls === 1 ? 'wiki_run_wire_request_mismatch' : 'wiki_run_request_failed';
        else if (config.reportOnly) scored = packet.report;
        else if (packet.message && packet.outcome.status !== 'error') {
          if (fixed.scoring.rubric.toolCheck) scored = await scoreWikiRunChecks({ message: packet.message, ...fixed.scoring }, judgeAdapter);
          else if (packet.outcome.status === 'reached') scored = { assessment: await scoreWikiRun({ ...fixed.scoring, hardAssertions: [],
            run: { completed: true, replySource: 'public', publicReply: packet.outcome.reply, task: fixed.scoring.task, expected: fixed.scoring.expected } }, judgeAdapter) };
        }
      } catch { fatal = 'wiki_original_precheck_attempt_failed'; }
      finally { try { await client?.close(); } catch { cleanupFailed = true; fatal = 'wiki_run_client_cleanup_failed'; } }
      let status = scored?.checks?.status ?? scored?.assessment?.status ?? (['pass', 'fail', 'invalid', 'error'].includes(packet?.outcome?.status) ? packet.outcome.status : 'error');
      if (fatal || cleanupFailed) status = 'error';
      const artifact = { iteration, packet: packet ?? null, scoring: scored ?? null, status, reason: fatal }, artifactHash = wikiValueHash(artifact), artifactId = reservation.id + '-attempt-' + iteration;
      // Hash the exact redacted retained packet, not an unsanitized predecessor.
      const retained = redactTraceKnownValues(artifact, values);
      if (retained.count) { fatal = 'wiki_original_precheck_output_contains_key'; throw fail(fatal); }
      append({ event: 'attempt_result', artifactId, artifactHash, artifact });
      const b = budget.snapshot(); attempts.push({ iteration, variant: 'original', status, artifactId, artifactHash, usageComplete: b.usageComplete });
      if (fatal) break;
    }
    const accounting = budget.snapshot(), all = attempts.length === fixed.plan.policy.repeats;
    // A cap reached on the final fully-scored attempt is completion, not an
    // extra paid attempt. If it blocked a needed judge, status=error => stopped.
    const finishedAtCap = accounting.reason === 'request_limit' && all && attempts.at(-1).status !== 'error';
    const complete = !fatal && all && accounting.usageComplete && (!accounting.reason || finishedAtCap);
    const outcome = { status: complete ? 'completed' : fatal ? 'failed' : 'stopped', reason: complete ? null : fatal || accounting.reason || 'incomplete', runs: attempts };
    const result = records.finish(reservation.id, outcome), returned = { ...result, budget: accounting, packetRoot, notFormalStatistics: true };
    append({ event: 'precheck_finished', result: returned }); print(JSON.stringify(returned, null, 2) + '\n'); return returned;
  } finally { budget.close(); if (fd !== undefined) fs.closeSync(fd); }
}
if (require.main === module) main().then(r => { if (!r.preparedOnly && r.status !== 'completed') process.exitCode = 1; }).catch(e => {
  const code = /^(?:wiki|evaluation)_[a-z_]+$/.test(e?.code || '') ? e.code : 'wiki_original_precheck_failed';
  process.stderr.write(JSON.stringify({ error: code }) + '\n'); process.exitCode = 1;
});
module.exports = { main, argumentsFor };
