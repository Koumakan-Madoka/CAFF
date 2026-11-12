// Trusted command composition against production-shaped synthetic stores only.
// GPT/DeepSeek are inert native-envelope fakes; recorded commands are never run.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const base = '../../build/server/domain/runtime/badcase-capture/';
const cli = () => require('../../scripts/badcase-capture/run-wiki-original-precheck.cjs');
const shapes = require('../fixtures/wikiskill-run-tool-call-command-shapes.json').items;
function output(n = 22, step = 30) { return { role: 'assistant', stopReason: 'toolUse', usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 13 },
  content: shapes.find(x => x.case === n && x.step === step).toolCalls.map((c, i) => ({ type: 'toolCall', id: 'synthetic-' + i, ...c })) }; }
function setup(t, { scene = false, reply = false, tool = true, repeats = 3, maxRequests = 50, outcomes } = {}) {
  const h = require('../helpers/wiki-scene-run.cjs')(t, { scene, reply, tool });
  const replay = { id: 'synthetic-replay', sourceCaseId: h.c.id, checkpointHash: 'c'.repeat(64), request: { association: { checkpointId: 'synthetic-checkpoint' } } };
  const store = scene ? { ...h.store, read() { return { ...h.store.read(), replayCases: [replay] }; } } : h.store;
  const cache = require(base + 'wiki-pipeline-prechecks').createWikiPipelinePrecheckStore(h.scope);
  cache.getOrCompute(scene ? { level: 'trace', replayId: replay.id, checkpointHash: replay.checkpointHash }
    : { level: 'run', traceHash: h.item().traceBundle.hash, decisionHash: h.decision.hash }, () => ({ status: 'supported' }));
  const config = { kind: 'wiki-original-precheck-v1', ...h.scope, caseId: h.c.id, rubricHash: h.rubric.hash, toolset: h.toolset,
    ...(scene ? { reportOnly: true } : {}), policy: { repeats }, codexAuthFile: path.join(h.root, '.pi-sandbox', 'auth.json'),
    knownKeySources: { sandboxRoot: path.join(h.root, '.pi-sandbox'), jevSource: 'pi-state.sqlite:turn-time-breakdown-jev' }, judgeCredentialDir: path.join(h.root, '.pi-sandbox'), stopFile: path.join(h.root, 'STOP'),
    limits: { maxRequests, maxInputTokens: 100000, maxOutputTokens: 100000, maxTotalTokens: 200000, maxDurationMs: 60000 } };
  if (reply) {
    const { CONFIGURATION, DEEPSEEK_JUDGE_PROMPT } = require('../../scripts/badcase-capture/wiki-judge-deepseek.cjs');
    const catalog = require('../helpers/wiki-judge-catalog.cjs')(h.root, [{ configuration: CONFIGURATION, prompt: DEEPSEEK_JUDGE_PROMPT }]);
    config.judgeCatalogFile = catalog.configFile;
  }
  const configFile = path.join(h.root, 'config.json'), outputFile = path.join(h.root, 'operator.jsonl'), requests = [], prints = [], judgeBodies = []; let clients = 0, closes = 0, reads = 0;
  const dependencies = { createStore: () => store, readKnownValues: () => ['synthetic-judge-key-not-real'], print: s => prints.push(s), readJudgeKey: () => { reads++; return 'synthetic-judge-key-not-real'; },
    async createRunClient({ signal }) { clients++; assert.ok(signal instanceof AbortSignal); return { state: () => ({ reason: null }), async close() { closes++; }, async complete(q) {
      requests.push(structuredClone(q)); const status = outcomes?.[requests.length - 1] ?? 'pass';
      const message = status === 'fail' ? output(22, 29) : status === 'invalid' ? output(23, 45) : output();
      if (status === 'error') message.stopReason = 'error'; if (reply) message.content.push({ type: 'toolCall', id: 'public', name: 'bash', arguments: { command: 'node "$CAFF_CHAT_TOOLS_PATH" send-public --content "Clear result."' } });
      return { networkRequests: 1, durationMs: 1, message, wireRequest: require(base + 'wiki-run-wire').buildWikiRunWireRequest(q) };
    } }; },
    createJudgeExchange({ expectedBody, signal }) { assert.ok(signal instanceof AbortSignal); judgeBodies.push(JSON.parse(expectedBody)); return { async close() {}, async exchange() {
      const input = JSON.parse(judgeBodies.at(-1).messages[1].content);
      const judgments = input.questions.map(q => ({ criterionId: q.id, verdict: 'satisfied', reason: 'Synthetic clear answer', evidence: [{ source: 'reply', text: 'Clear result.' }] }));
      return Buffer.from(JSON.stringify({ status: 200, body: Buffer.from(JSON.stringify({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ judgments }) } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })).toString('base64') }));
    } }; },
  };
  const write = () => fs.writeFileSync(configFile, JSON.stringify(config)); write();
  async function plan() { return cli().main(['--config', configFile, '--plan'], dependencies); }
  async function run(p, extra = {}) { return cli().main(['--config', configFile, '--run', '--confirmed', '--expected-plan', p.plan.planHash, '--approval', p.approvalHash, '--output', outputFile], { ...dependencies, ...extra }); }
  return { ...h, store, config, configFile, outputFile, dependencies, requests, prints, judgeBodies, write, plan, run, clients: () => clients, closes: () => closes, reads: () => reads };
}

test('plan is offline, original-only and read-only; confirmation is exact and config is closed', async t => {
  const h = setup(t), before = JSON.stringify(h.store.read()), p = await h.plan();
  assert.equal(p.plan.variant, 'original'); assert.equal(p.plan.execution.level, 'run'); assert.equal(p.plan.policy.repeats, 3); assert.equal(p.preparedOnly, true);
  assert.equal(h.clients(), 0); assert.equal(h.reads(), 0); assert.equal(h.requests.length, 0); assert.equal(fs.existsSync(h.outputFile), false);
  assert.deepEqual(require(base + 'wiki-original-precheck-store').createWikiOriginalPrecheckStore(h.scope).list(), []);
  assert.equal(JSON.stringify(h.store.read()), before);
  await assert.rejects(h.run({ ...p, approvalHash: 'f'.repeat(64) }), /wiki_precheck_confirmation_required/);
  assert.equal(h.clients(), 0); assert.equal(fs.existsSync(h.outputFile), false);
  h.config.candidateId = 'not-allowed'; h.write(); await assert.rejects(h.plan(), /wiki_original_precheck_config_invalid/);
});
test('the real CLI plans offline from owned synthetic files, with no injected store or auth/network adapter', t => {
  const h = setup(t), sandbox = h.config.knownKeySources.sandboxRoot;
  fs.mkdirSync(sandbox); fs.writeFileSync(path.join(sandbox, 'auth.json'), '{}'); fs.writeFileSync(path.join(sandbox, 'models.json'), '{"providers":{}}');
  h.config.knownKeySources.jevSource = 'TYPESAFE_API_KEY'; h.write();
  const child = require('node:child_process').spawnSync(process.execPath, ['scripts/badcase-capture/run-wiki-original-precheck.cjs', '--config', h.configFile, '--plan'], {
    cwd: path.resolve(__dirname, '../..'), env: { ...process.env, TYPESAFE_API_KEY: 'synthetic-native-plan-inventory-value' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr); const result = JSON.parse(child.stdout);
  assert.equal(result.preparedOnly, true); assert.equal(result.plan.variant, 'original'); assert.equal(result.plan.judge, null);
  assert.equal(child.stdout.includes('synthetic-native-plan-inventory-value'), false);
  assert.equal(fs.existsSync(path.join(h.scope.globalRoot, 'original-prechecks')), false); assert.equal(fs.existsSync(h.outputFile), false);
});
test('run precheck uses real code scorer, retains immutable outputs, and never creates formal statistics', async t => {
  const h = setup(t), p = await h.plan(), before = JSON.stringify(h.store.read()), result = await h.run(p);
  assert.equal(result.status, 'completed'); assert.equal(result.summary.pass, 3); assert.equal(result.summary.reproduced, false);
  assert.equal(h.clients(), 3); assert.equal(h.closes(), 3); assert.equal(h.reads(), 0); assert.equal(h.requests.length, 3);
  assert.ok(h.requests.every(r => r.variant.kind === 'original')); assert.equal(result.budget.requests, 3); assert.equal(result.budget.knownUsage.totalTokens, 39);
  const saved = require(base + 'wiki-original-precheck-store').createWikiOriginalPrecheckStore(h.scope).read(result.id);
  assert.equal(saved.result.summary.pass, 3); assert.equal(saved.reservation.plan.planHash, p.plan.planHash);
  assert.deepEqual(saved.result.runs.map(r => r.usage), Array.from({ length: 3 }, () => ({ input: 10, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 13 })), 'each whole-output cost is a per-attempt delta, never cumulative');
  const records = fs.readFileSync(h.outputFile, 'utf8').trim().split('\n').map(JSON.parse), artifacts = records.filter(e => e.event === 'attempt_result');
  assert.equal(artifacts.length, 3); assert.ok(records.some(e => e.event === 'request_reserved')); assert.ok(records.some(e => e.event === 'request_finished'));
  for (const [i, artifact] of artifacts.entries()) {
    assert.equal(saved.result.runs[i].artifactHash, require(base + 'wiki-rubric').wikiValueHash(artifact.artifact));
    assert.ok(artifact.artifact.packet.message.content[0].arguments.command.includes('suggest-goal'));
  }
  assert.equal(JSON.stringify(h.store.read()), before); assert.equal(fs.existsSync(path.join(h.scope.globalRoot, 'comparisons')), false);
  assert.deepEqual(require(base + 'wiki-run-store').createWikiRunStore(h.scope).list(), [], 'precheck packets cannot pollute the formal run or report stores');
  await assert.rejects(h.run(p), e => e.code === 'EEXIST'); assert.equal(h.clients(), 3, 'existing output is never overwritten or used to resend');
});
test('trusted command is a real caller of replayWikiRunReport; scene results remain report-only', async t => {
  const h = setup(t, { scene: true, repeats: 2 }), p = await h.plan(), result = await h.run(p);
  assert.equal(p.plan.reportOnly, true); assert.equal(result.summary.pass, 2); assert.equal(result.summary.reproduced, false); assert.equal(result.summary.controlEligible, false);
  assert.ok(h.requests.every(q => q.metadata.report?.kind === 'wiki-run-report-v1'));
  const rows = require(base + 'wiki-run-store').createWikiRunStore({ ...h.scope, globalRoot: result.packetRoot }).list(); assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.reportOnly && !r.caseEligibleForGateAndScreen)); assert.equal(h.judgeBodies.length, 0);
});
test('reply-judge calls share the worker budget, use production majority scoring and retain usage', async t => {
  for (const scene of [false, true]) {
    const h = setup(t, { scene, reply: true, repeats: 1 }), p = await h.plan(), r = await h.run(p);
    assert.equal(r.status, 'completed'); assert.equal(r.summary.pass, 1); assert.equal(h.judgeBodies.length, 3);
    assert.equal(r.budget.workerRequests, 1); assert.equal(r.budget.judgeRequests, 3); assert.equal(r.budget.knownUsage.totalTokens, 28);
    assert.deepEqual(r.runs[0].usage, { input: 19, output: 8, cacheRead: 1, cacheWrite: 0, totalTokens: 28 }, 'all three judge votes count toward the output estimate');
    assert.ok(h.judgeBodies.every(q => JSON.parse(q.messages[1].content).publicReply === 'Clear result.'));
    assert.equal(fs.readFileSync(h.outputFile, 'utf8').includes('synthetic-judge-key-not-real'), false);
  }
});
for (const scene of [false, true]) test(`native SDK ${scene ? 'report' : 'run'} packets hash the exact retained JSON, including omitted optional wire fields`, async t => {
  const h = setup(t, { scene, reply: true, tool: false, repeats: 2 }), p = await h.plan();
  const before = JSON.stringify(h.store.read()); let sends = 0, closes = 0;
  const r = await h.run(p, { async createRunClient(options) {
    // Real pinned SDK serializer/parser, inert transport only. No auth file is
    // opened and no provider request is sent. Unlike buildWikiRunWireRequest,
    // onPayload retains own undefined properties such as prompt_cache_key.
    const client = await require('../../scripts/badcase-capture/wiki-run-client.cjs').createWikiRunClient(options, {
      createTransport: () => ({ async close() { closes++; }, async fetch() {
        sends++;
        const item = { type: 'message', id: 'synthetic', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Clear result.', annotations: [] }] };
        const events = [{ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'synthetic', status: 'completed',
          usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13, input_tokens_details: { cached_tokens: 1 } } } }];
        return new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''));
      } }),
    });
    return { close: () => client.close(), async complete(q) {
      const result = await client.complete(q);
      assert.equal(Object.hasOwn(result.wireRequest, 'prompt_cache_key'), true);
      assert.equal(result.wireRequest.prompt_cache_key, undefined);
      assert.throws(() => require(base + 'wiki-rubric').wikiValueHash(result.wireRequest), /wiki_rubric_invalid/);
      return result;
    } };
  } });
  assert.equal(r.status, 'completed'); assert.equal(r.summary.pass, 2); assert.equal(r.summary.errors, 0);
  assert.equal(sends, 2); assert.equal(closes, 2); assert.equal(h.judgeBodies.length, 6);
  assert.equal(r.budget.workerRequests, 2); assert.equal(r.budget.judgeRequests, 6); assert.equal(r.budget.knownUsage.totalTokens, 56);
  const saved = require(base + 'wiki-original-precheck-store').createWikiOriginalPrecheckStore(h.scope).read(r.id);
  const events = fs.readFileSync(h.outputFile, 'utf8').trim().split('\n').map(JSON.parse), artifacts = events.filter(e => e.event === 'attempt_result');
  assert.equal(artifacts.length, 2); assert.equal(events.at(-1).event, 'precheck_finished');
  for (const [i, a] of artifacts.entries()) {
    assert.equal(Object.hasOwn(a.artifact.packet.wireRequest, 'prompt_cache_key'), false);
    assert.equal(a.artifactHash, require(base + 'wiki-rubric').wikiValueHash(a.artifact));
    assert.equal(saved.result.runs[i].artifactHash, a.artifactHash);
    assert.equal(a.artifact.scoring.assessment.status, 'pass');
    assert.equal(a.artifact.scoring.assessment.votes.length, 3);
  }
  assert.equal(JSON.stringify(h.store.read()), before);
  assert.equal(fs.existsSync(path.join(h.scope.globalRoot, 'comparisons')), false);
});
test('request cap stops before a second worker; an exact full-sample cap can still finish', async t => {
  const h = setup(t, { maxRequests: 1 }), p = await h.plan(), r = await h.run(p);
  assert.equal(r.status, 'stopped'); assert.equal(r.reason, 'request_limit'); assert.equal(r.runs.length, 1); assert.equal(h.clients(), 1);
  const exact = setup(t, { repeats: 1, maxRequests: 1 }), q = await exact.plan(), done = await exact.run(q);
  assert.equal(done.status, 'completed'); assert.equal(done.summary.pass, 1);
});
test('unknown worker usage stops after one retained output; no substitution or automatic retry', async t => {
  const h = setup(t), p = await h.plan();
  const r = await h.run(p, { createRunClient: async () => ({ async close() {}, state: () => ({ reason: null }), async complete(q) {
    h.requests.push(q); const message = output(); delete message.usage;
    return { networkRequests: 1, durationMs: 1, message, wireRequest: require(base + 'wiki-run-wire').buildWikiRunWireRequest(q) };
  } }) });
  assert.equal(r.status, 'stopped'); assert.equal(r.reason, 'usage_unknown'); assert.equal(r.summary.reproduced, false); assert.equal(r.runs[0].usageComplete, false);
  assert.equal(h.requests.length, 1); assert.equal(r.budget.unknownRequests, 1); assert.match(fs.readFileSync(h.outputFile, 'utf8'), /attempt_result/);
  assert.equal(Object.hasOwn(r.runs[0], 'usage'), false, 'unknown usage cannot become a zero-cost historical sample');
});
test('STOP and changed approval stop before auth/client; stale offline support cannot be reused', async t => {
  const h = setup(t), p = await h.plan(); fs.writeFileSync(h.config.stopFile, 'STOP');
  const r = await h.run(p); assert.equal(r.status, 'stopped'); assert.equal(r.runs.length, 0); assert.equal(h.clients(), 0); assert.equal(h.reads(), 0);
  const stale = setup(t), q = await stale.plan(); stale.config.limits.maxRequests++; stale.write();
  await assert.rejects(stale.run(q), /wiki_precheck_confirmation_required/); assert.equal(stale.clients(), 0);
  fs.rmSync(path.join(stale.scope.globalRoot, 'pipeline-prechecks'), { recursive: true });
  await assert.rejects(stale.plan(), /wiki_original_precheck_invalid/); assert.equal(stale.clients(), 0);
});
test('wire mismatch and technical client failure retain evidence but cannot qualify or rerun', async t => {
  for (const fault of ['wire', 'client']) {
    const h = setup(t), p = await h.plan(); let calls = 0;
    const r = await h.run(p, { createRunClient: async () => ({ state: () => ({ reason: null }), async close() {}, async complete() {
      calls++; if (fault === 'client') throw Error('PRIVATE-ERROR');
      return { networkRequests: 1, durationMs: 1, message: output(), wireRequest: {} };
    } }) });
    assert.notEqual(r.status, 'completed'); assert.equal(calls, 1); assert.equal(r.summary.reproduced, false); assert.equal(r.summary.controlEligible, false);
    assert.equal(fs.readFileSync(h.outputFile, 'utf8').includes('PRIVATE-ERROR'), false);
  }
});
test('strict reproduction threshold and invalid/error denominator use the same production scorers', async t => {
  for (const [outcomes, reproduced] of [[['pass', 'fail', 'invalid', 'error'], false], [['fail', 'fail', 'pass', 'invalid'], true]]) {
    const h = setup(t, { repeats: 4, outcomes }), p = await h.plan(), r = await h.run(p);
    assert.equal(r.status, 'completed'); assert.equal(r.summary.reproduced, reproduced);
    assert.equal(r.summary.valid, outcomes.filter(s => ['pass', 'fail'].includes(s)).length);
    assert.equal(h.requests.length, 4); assert.equal(r.summary.invalid, 1);
  }
});
test('all 20 configured attempts are supported without widening legacy formal-run slot semantics', async t => {
  const h = setup(t, { repeats: 20 }), p = await h.plan(), r = await h.run(p);
  assert.equal(r.status, 'completed'); assert.equal(r.summary.pass, 20); assert.equal(h.requests.length, 20);
});
test('a required judge key must already be in the authorized redaction inventory', async t => {
  const h = setup(t, { reply: true, repeats: 1 }), p = await h.plan();
  const r = await h.run(p, { readJudgeKey: () => 'synthetic-foreign-judge-key' });
  assert.notEqual(r.status, 'completed'); assert.equal(h.judgeBodies.length, 0);
  assert.equal(fs.readFileSync(h.outputFile, 'utf8').includes('synthetic-foreign-judge-key'), false);
});
test('unknown judge usage stops at that exchange even when production scorer wants to retry or vote', async t => {
  const h = setup(t, { reply: true, repeats: 1 }), p = await h.plan(); let opened = 0, sends = 0;
  const r = await h.run(p, { createJudgeExchange({ expectedBody }) {
    opened++; const input = JSON.parse(JSON.parse(expectedBody).messages[1].content);
    return { async close() {}, async exchange() {
      sends++; const judgments = input.questions.map(q => ({ criterionId: q.id, verdict: 'satisfied', reason: 'Synthetic', evidence: [{ source: 'reply', text: 'Clear result.' }] }));
      return Buffer.from(JSON.stringify({ status: 200, body: Buffer.from(JSON.stringify({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ judgments }) } }] })).toString('base64') }));
    } };
  } });
  assert.equal(r.status, 'stopped'); assert.equal(r.reason, 'usage_unknown'); assert.equal(r.budget.workerRequests, 1); assert.equal(r.budget.judgeRequests, 1);
  assert.equal(sends, 1); assert.equal(opened, 1); assert.equal(r.runs[0].usageComplete, false);
  assert.equal(Object.hasOwn(r.runs[0], 'usage'), false, 'known worker tokens do not make unknown judge usage complete');
});
test('AI precheck requires the same calibrated configuration as formal evaluation, and pins the attestation', async t => {
  const h = setup(t, { reply: true, repeats: 1 }), p = await h.plan();
  const { wikiValueHash } = require(base + 'wiki-rubric');
  assert.equal(p.plan.judge.configurationHash, wikiValueHash(require('../../scripts/badcase-capture/wiki-judge-deepseek.cjs').CONFIGURATION));
  assert.match(p.plan.judge.freezeHash, /^[a-f0-9]{64}$/);
  delete h.config.judgeCatalogFile; h.write();
  await assert.rejects(h.plan(), /wiki_judge_not_eligible/); assert.equal(h.clients(), 0); assert.equal(h.reads(), 0);
  h.config.judgeCatalogFile = path.join(h.root, 'missing.json'); h.write(); await assert.rejects(h.plan(), /wiki_judge_catalog_invalid/);
});
test('budget-blocked judging never reads judge credentials or opens a judge transport', async t => {
  const h = setup(t, { reply: true, repeats: 1, maxRequests: 1 }), p = await h.plan(), r = await h.run(p);
  assert.equal(r.status, 'stopped'); assert.equal(r.reason, 'request_limit'); assert.equal(r.budget.workerRequests, 1);
  assert.equal(r.budget.judgeRequests, 0); assert.equal(h.reads(), 0); assert.equal(h.judgeBodies.length, 0);
});
test('Ctrl+C during a fake worker preserves known output but disqualifies the stopped batch', async t => {
  const h = setup(t), p = await h.plan(), listeners = process.listenerCount('SIGINT'); let closed = 0;
  const r = await h.run(p, { createRunClient: async ({ signal }) => ({ async close() { closed++; }, async complete(q) {
    process.emit('SIGINT'); assert.equal(signal.aborted, true);
    return { networkRequests: 1, durationMs: 1, message: output(), wireRequest: require(base + 'wiki-run-wire').buildWikiRunWireRequest(q) };
  } }) });
  assert.equal(r.status, 'stopped'); assert.equal(r.reason, 'operator_interrupted'); assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0].usageComplete, true); assert.equal(r.summary.reproduced, false); assert.equal(closed, 1);
  assert.equal(process.listenerCount('SIGINT'), listeners);
});
test('CLI rejects ambiguous flags and unsafe paths without reading config or starting a model', () => {
  for (const argv of [[], ['--config', 'relative', '--plan'], ['--config', path.resolve('missing'), '--plan', '--run'],
    ['--config', path.resolve('missing'), '--plan', '--confirmed'], ['--config', path.resolve('missing'), '--run', '--confirmed'],
    ['--config', path.resolve('missing'), '--plan', '--plan']]) assert.throws(() => cli().argumentsFor(argv), /wiki_original_precheck_arguments_invalid/);
});
test('trace precheck requires explicit trace restoration configuration before auth/model execution', async t => {
  const h = setup(t, { scene: true }); delete h.config.reportOnly; h.write();
  await assert.rejects(h.plan(), /wiki_original_precheck_trace_config_invalid/);
  assert.equal(h.clients(), 0); assert.equal(h.reads(), 0);
});
