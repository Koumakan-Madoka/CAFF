// Offline trusted-CLI composition using real comparison/scoring/budget/host
// transport. Only sealed-input, container and provider boundaries are inert.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const base = '../../build/server/domain/runtime/badcase-capture/';
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const cli = () => require('../../scripts/badcase-capture/run-wiki-original-precheck.cjs');
const { PROFILE, createCodexTransport } = require('../../scripts/badcase-capture/codex-transport.cjs');
const { CODEX_CONFIG, expectedTreeHash } = require('../../scripts/badcase-capture/direct-comparison.cjs');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
function setup(t, { reply = false, repeats, reasons = ['safe'], maxRequests = 50, unknown = false, missingEvidence = false, callsPerTurn = 1 } = {}) {
  const h = require('../helpers/wiki-scene-run.cjs')(t, { scene: true, reply });
  fs.mkdirSync(h.scope.sourceWorktree); fs.mkdirSync(path.join(h.root, '.pi-sandbox'));
  const git = args => require('node:child_process').execFileSync('git', ['-C', h.scope.sourceWorktree, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args], {
    env: require('../../scripts/badcase-capture/replay-git.cjs').gitEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }).trim();
  git(['init', '-q', '--template=']);
  const pkg = { name: 'synthetic-precheck', version: '1.0.0' }, lock = { ...pkg, lockfileVersion: 3, packages: { '': pkg } };
  const files = [['package.json', JSON.stringify(pkg)], ['package-lock.json', JSON.stringify(lock)]].map(([p, text]) => {
    fs.writeFileSync(path.join(h.scope.sourceWorktree, p), text); return { path: p, base64: Buffer.from(text).toString('base64'), sha256: hash(text) };
  });
  git(['add', '.']); git(['-c', 'user.name=GPT', '-c', 'user.email=gpt@caff.local', 'commit', '-qm', 'Synthetic fixture']);
  const head = git(['rev-parse', 'HEAD']), association = { projectId: 'synthetic-project', conversationId: 'synthetic-scene', turnId: 'synthetic-turn', agentId: 'role-family-gpt', userMessageId: 'synthetic-user', assistantMessageId: 'mark' };
  const trace = JSON.stringify({ schemaVersion: 1, kind: 'caff-evaluation-callback-input-v1', association, assistantCreatedAt: '2026-11-09T00:00:01.000Z',
    conversation: { title: 'Synthetic trace', type: 'standard', metadata: {} }, participants: [{ id: 'role-family-gpt', name: 'GPT', description: 'OpenAI GPT 模型族' }], publicMessages: [
      { id: association.userMessageId, turnId: 'prior', role: 'user', agentId: null, senderName: 'User', content: 'Continue the task.', status: 'completed', createdAt: '2026-11-09T00:00:00.000Z', publicPostedAt: '', publicPostCount: 0, publicPostMode: '', mentions: [] },
    ], privateMessages: [], pendingDelegations: [] });
  const input = { kind: 'prepared-caff-turn-v1', prompt: 'Synthetic original prompt', sessionText: null, deletions: [], files,
    callback: { trace, association, expectedTraceHash: hash(trace) }, recordedModelConfig: { provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'xhigh' } };
  const image = { imageId: 'sha256:' + '1'.repeat(64), architecture: 'amd64', nodeVersion: 'v24.8.0' }, cacheRoot = path.join(h.root, 'cache'); fs.mkdirSync(cacheRoot);
  const recipe = require('../../scripts/badcase-capture/replay-dependencies.cjs').dependencyRecipe(input, image), cache = path.join(cacheRoot, recipe.cacheKey); fs.mkdirSync(cache);
  const archive = Buffer.from('synthetic-cache-not-extracted'); fs.writeFileSync(path.join(cache, 'node_modules.tar.gz'), archive);
  fs.writeFileSync(path.join(cache, 'receipt.json'), JSON.stringify({ recipe, receipt: { kind: 'npm-replay-dependencies-v1', nodeVersion: image.nodeVersion, npmVersion: 'synthetic', installCommand: recipe.installCommand, archiveHash: hash(archive), modelCalls: 0 } }));
  const replay = { id: 'synthetic-replay', sourceCaseId: h.c.id, checkpointHash: 'c'.repeat(64), request: { captureRoot: path.join(h.root, 'capture'), flagId: 'flag-' + hash(association.projectId + '\0mark'), association: {
    projectId: association.projectId, conversationId: association.conversationId, messageId: 'mark', turnId: association.turnId, taskId: 'synthetic-task', runId: 1, agentId: association.agentId, checkpointId: 'synthetic-checkpoint',
  } }, rules: { kind: 'completion-public-reply-v1' } };
  const store = { ...h.store, read() { const state = h.store.read(); return { ...state, cases: state.cases.map(c => ({ ...c, source: { ...c.source, projectId: association.projectId } })), replayCases: [replay] }; } };
  require(base + 'wiki-pipeline-prechecks').createWikiPipelinePrecheckStore(h.scope).getOrCompute({ level: 'trace', replayId: replay.id, checkpointHash: replay.checkpointHash }, () => ({ status: 'supported' }));
  const sandbox = path.join(h.root, '.pi-sandbox'), now = Date.now(), access = 'test.' + Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + 600, 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url') + '.test';
  fs.writeFileSync(path.join(sandbox, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'oauth', access, expires: now + 600000, refresh: 'synthetic-unused-refresh' } }));
  const config = { kind: 'wiki-original-precheck-v1', ...h.scope, caseId: h.c.id, rubricHash: h.rubric.hash, toolset: h.toolset,
    ...(repeats === undefined ? {} : { policy: { repeats } }), codexAuthFile: path.join(sandbox, 'auth.json'), knownKeySources: { sandboxRoot: sandbox, jevSource: 'TYPESAFE_API_KEY' }, judgeCredentialDir: sandbox, stopFile: path.join(h.root, 'STOP'),
    limits: { maxRequests, maxInputTokens: 100000, maxOutputTokens: 100000, maxTotalTokens: 200000, maxDurationMs: 60000 },
    trace: { repoRoot: path.resolve('.'), dependencyRoot: path.resolve('.'), image, repository: { sourceRoot: h.scope.sourceWorktree, head }, dependencies: { kind: 'npm-ci-linux-v1', cacheRoot } } };
  if (reply) config.judgeCatalogFile = require('../helpers/wiki-judge-catalog.cjs')(h.root, [{ configuration: require('../../scripts/badcase-capture/wiki-judge-deepseek.cjs').CONFIGURATION, prompt: require('../../scripts/badcase-capture/wiki-judge-deepseek.cjs').DEEPSEEK_JUDGE_PROMPT }]).configFile;
  const configFile = path.join(h.root, 'config.json'), outputFile = path.join(h.root, 'operator.jsonl'), state = { prepares: 0, containers: 0, sends: 0, closed: 0, judgeReads: 0, judgeSends: 0, receipts: [] };
  const dependencies = { createStore: () => store, readKnownValues: () => ['synthetic-judge-key-not-real'], print() {}, readJudgeKey() { state.judgeReads++; return 'synthetic-judge-key-not-real'; },
    traceOptions: {
      prepare() { state.prepares++; return { supported: true, input, provenance: { caseId: 'synthetic-seal-case', checkpointId: replay.request.association.checkpointId, checkpointHash: replay.checkpointHash, commonInputHash: hash('common') } }; },
      stage(_repo, _deps, _image, data) { return [{ path: 'probe.cjs', bytes: Buffer.from(JSON.stringify(data)) }, { path: 'runtime/test', bytes: Buffer.from('synthetic runtime') }]; },
      async executeCodex(_image, staged, opts) {
        state.containers++; assert.equal(opts.network, 'none'); assert.ok(opts.signal instanceof AbortSignal);
        for (let i = 0; i < callsPerTurn; i++) await opts.sendNativeRequest(Buffer.from(JSON.stringify({ headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: Buffer.from(JSON.stringify({ model: 'gpt-6.1-sol', input: [], stream: true, store: false, reasoning: { effort: 'xhigh' } })).toString('base64') })));
        const manifest = manifestFor(staged, { replayWorkspace: true }), data = JSON.parse(staged[0].bytes);
        // Real isolated Goal handler/ledger, with production error serialization.
        // Only loopback on an ephemeral owned port; these are NOT model calls.
        const cb = await require(base + 'evaluation-callback').startEvaluationCallback({ directory: path.join(h.root, 'callback-' + crypto.randomUUID()), ...input.callback, lifetimeMs: 60000 });
        let evidence;
        try {
          for (const reason of reasons) await fetch(cb.apiUrl + '/api/agent-tools/goal/suggest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...cb.credentials, action: 'pause', reason }) });
          evidence = cb.readGoalEvidence();
        } finally { await cb.stop(); }
        const receipt = { kind: 'direct-caff-turn-v1', success: true, inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash, modelConfig: CODEX_CONFIG, recordedModelConfig: input.recordedModelConfig,
          repository: { ...data.repository, gitAvailable: true }, dependencies: { ...data.dependencies, installed: true }, beforeHash: expectedTreeHash(input), afterHash: expectedTreeHash(input), replySource: 'public', finalText: 'Clear result.',
          toolCalls: [...require('../fixtures/wikiskill-run-tool-call-command-shapes.json').items.find(x => x.case === 23 && x.step === 45).toolCalls.map(c => ({ name: c.name, args: c.arguments, isError: false })), { name: 'read', args: { path: 'a.txt' }, isError: false }],
          modelCalls: Array.from({ length: callsPerTurn }, () => ({ model: PROFILE.model, success: true, httpStatus: 200, durationMs: 1, usage: unknown ? null : { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 13 } })), ...(missingEvidence ? {} : { goalEvidence: evidence }) };
        state.receipts.push(receipt); return { code: 0, cleaned: true, containerId: 'a'.repeat(64), inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash, isolation: { network: 'none' }, receipt };
      },
    },
    createTraceTransport(cfg, guards) { return createCodexTransport(cfg, { ...guards, now: () => now, createDispatcher: () => ({ async destroy() { state.closed++; } }), async fetch() {
      state.sends++; return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { ...(unknown ? {} : { usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13, input_tokens_details: { cached_tokens: 1 } } }) } }) + '\n\n');
    } }); },
    createJudgeExchange({ expectedBody, signal }) { assert.ok(signal instanceof AbortSignal); const input = JSON.parse(JSON.parse(expectedBody).messages[1].content); return { async close() {}, async exchange() {
      state.judgeSends++; const judgments = input.questions.map(q => ({ criterionId: q.id, verdict: 'satisfied', reason: 'Synthetic clear answer', evidence: [{ source: 'reply', text: 'Clear result.' }] }));
      return Buffer.from(JSON.stringify({ status: 200, body: Buffer.from(JSON.stringify({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ judgments }) } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })).toString('base64') }));
    } }; },
  };
  const write = () => fs.writeFileSync(configFile, JSON.stringify(config)); write();
  const plan = () => cli().main(['--config', configFile, '--plan'], dependencies);
  const run = (p, extra = {}) => cli().main(['--config', configFile, '--run', '--confirmed', '--expected-plan', p.plan.planHash, '--approval', p.approvalHash, '--output', outputFile], { ...dependencies, ...extra });
  return { ...h, store, config, configFile, outputFile, state, input, replay, dependencies, write, plan, run, access };
}
test('trace offline preparation pins original scene/input, default three attempts and calibrated scoring without auth or Docker', async t => {
  const h = setup(t); fs.unlinkSync(h.config.codexAuthFile); const before = JSON.stringify(h.store.read()), p = await h.plan();
  assert.equal(p.plan.execution.level, 'trace'); assert.equal(p.plan.policy.repeats, 3); assert.equal(p.plan.execution.checkpointHash, h.replay.checkpointHash); assert.equal(p.plan.judge, null);
  assert.equal(h.state.containers + h.state.sends + h.state.judgeReads, 0); assert.equal(fs.existsSync(h.outputFile), false); assert.equal(JSON.stringify(h.store.read()), before);
  assert.deepEqual(require(base + 'wiki-original-precheck-store').createWikiOriginalPrecheckStore(h.scope).list(), []);
});
test('trace command uses production comparison and record scorer, retains Goal/native observations, never formal statistics', async t => {
  const h = setup(t, { callsPerTurn: 2 }), p = await h.plan(), before = JSON.stringify(h.store.read()), r = await h.run(p);
  assert.equal(r.status, 'completed', r.reason); assert.equal(r.summary.pass, 3); assert.equal(r.summary.reproduced, false); assert.equal(r.budget.workerRequests, 6); assert.equal(r.budget.knownUsage.totalTokens, 78);
  assert.equal(h.state.sends, 6); assert.equal(h.state.containers, 3); assert.equal(h.state.closed, 3); assert.equal(h.state.judgeReads, 0);
  assert.deepEqual(r.runs.map(r => r.usage), Array.from({ length: 3 }, () => ({ input: 20, output: 4, cacheRead: 2, cacheWrite: 0, totalTokens: 26 })), 'trace whole-output cost includes both native worker requests, not 13 tokens per native call');
  const events = fs.readFileSync(h.outputFile, 'utf8').trim().split('\n').map(JSON.parse), artifacts = events.filter(e => e.event === 'attempt_result');
  assert.equal(artifacts.length, 3); assert.equal(events.filter(e => e.event === 'trace_request').length, 6); assert.equal(events.filter(e => e.event === 'trace_response').length, 6);
  for (const [i, a] of artifacts.entries()) {
    assert.equal(a.artifact.packet.comparison.runs[0].goalState, 'approximate-minimal-v1');
    assert.deepEqual(a.artifact.packet.receipts[0].goalEvidence, h.state.receipts[i].goalEvidence);
    assert.deepEqual(a.artifact.packet.receipts[0].toolCalls, h.state.receipts[i].toolCalls);
    assert.equal(a.artifact.packet.comparison.runs[0].assessment.tool.status, 'pass'); assert.equal(a.artifactHash, r.runs[i].artifactHash);
    assert.deepEqual(require(base + 'evaluation-goal-evidence').projectEvaluationGoalMarker(r.runs[i]), require(base + 'evaluation-goal-evidence').projectEvaluationGoalMarker(a.artifact.packet.comparison.runs[0]));
  }
  assert.equal(fs.readFileSync(h.outputFile, 'utf8').includes(h.access), false); assert.equal(JSON.stringify(h.store.read()), before);
  for (const folder of ['comparisons', 'run-replays', 'experiment-results']) assert.equal(fs.existsSync(path.join(h.scope.globalRoot, folder)), false);
});
test('trace optional receipt fields hash as retained JSON without aborting later scored slots', async t => {
  const h = setup(t, { reply: true, repeats: 2 }), p = await h.plan(), before = JSON.stringify(h.store.read());
  const execute = h.dependencies.traceOptions.executeCodex;
  const r = await h.run(p, { traceOptions: { ...h.dependencies.traceOptions, async executeCodex(...args) {
    const result = await execute(...args);
    // Valid optional receipt fields can be own undefined properties before
    // serialization. The existing JSONL receipt event already omits them.
    result.receipt.replaySession = undefined; result.receipt.projectResources = undefined;
    return result;
  } } });
  assert.equal(r.status, 'completed'); assert.equal(r.summary.pass, 2); assert.equal(r.summary.errors, 0);
  assert.equal(h.state.containers, 2); assert.equal(h.state.sends, 2); assert.equal(h.state.closed, 2); assert.equal(h.state.judgeSends, 6);
  assert.equal(r.budget.workerRequests, 2); assert.equal(r.budget.judgeRequests, 6); assert.equal(r.budget.knownUsage.totalTokens, 56);
  const saved = require(base + 'wiki-original-precheck-store').createWikiOriginalPrecheckStore(h.scope).read(r.id);
  const events = fs.readFileSync(h.outputFile, 'utf8').trim().split('\n').map(JSON.parse), artifacts = events.filter(e => e.event === 'attempt_result');
  assert.equal(artifacts.length, 2); assert.equal(events.at(-1).event, 'precheck_finished');
  for (const [i, a] of artifacts.entries()) {
    assert.equal(Object.hasOwn(a.artifact.packet.receipts[0], 'replaySession'), false);
    assert.equal(Object.hasOwn(a.artifact.packet.receipts[0], 'projectResources'), false);
    assert.equal(a.artifactHash, require(base + 'wiki-rubric').wikiValueHash(a.artifact));
    assert.equal(saved.result.runs[i].artifactHash, a.artifactHash);
    assert.equal(a.artifact.packet.comparison.runs[0].assessment.votes.length, 3);
  }
  assert.equal(JSON.stringify(h.store.read()), before);
  for (const folder of ['comparisons', 'run-replays', 'experiment-results']) assert.equal(fs.existsSync(path.join(h.scope.globalRoot, folder)), false);
});
test('trace record failure skips AI credentials and votes; invalid observations stay outside the denominator', async t => {
  for (const [reasons, expected] of [[['x'.repeat(1001), 'safe retry'], 'fail'], [[], 'invalid']]) {
    const h = setup(t, { reasons, reply: expected === 'fail' }), p = await h.plan(), r = await h.run(p);
    assert.equal(r.status, 'completed'); assert.equal(r.summary[expected], 3); assert.equal(h.state.judgeReads, 0); assert.equal(h.state.judgeSends, 0); assert.equal(h.state.containers, 3);
    assert.equal(r.summary.valid, expected === 'invalid' ? 0 : 3); assert.equal(r.summary.reproduced, expected === 'fail');
  }
});
test('trace reply checking invokes the same calibrated majority judge under the shared per-request budget', async t => {
  const h = setup(t, { reply: true, repeats: 1 }), p = await h.plan(), r = await h.run(p);
  assert.equal(r.status, 'completed'); assert.equal(r.summary.pass, 1); assert.equal(r.budget.workerRequests, 1); assert.equal(r.budget.judgeRequests, 3); assert.equal(h.state.judgeSends, 3);
  assert.equal(r.budget.knownUsage.totalTokens, 28); assert.ok(p.plan.judge.freezeHash);
  assert.deepEqual(r.runs[0].usage, { input: 19, output: 8, cacheRead: 1, cacheWrite: 0, totalTokens: 28 });
});
test('trace unknown usage and exact cap stop subsequent exchanges/attempts without replacement', async t => {
  for (const unknown of [false, true]) {
    const h = setup(t, { unknown, maxRequests: 1 }), p = await h.plan(), r = await h.run(p);
    assert.equal(r.status, 'stopped'); assert.equal(r.reason, unknown ? 'usage_unknown' : 'request_limit'); assert.equal(h.state.sends, 1); assert.equal(h.state.containers, 1);
    assert.equal(r.summary.reproduced, false); assert.equal(r.budget.usageComplete, !unknown); assert.equal(h.state.closed, 1);
  }
  const h = setup(t, { maxRequests: 1, repeats: 1 }), p = await h.plan(), r = await h.run(p); assert.equal(r.status, 'completed'); assert.equal(r.summary.pass, 1);
});
test('trace STOP, config drift and changed checkpoint reject before transport/container or judge credentials', async t => {
  const h = setup(t), p = await h.plan(); fs.writeFileSync(h.config.stopFile, 'STOP'); const r = await h.run(p);
  assert.equal(r.status, 'stopped'); assert.equal(h.state.containers + h.state.sends, 0);
  const c = setup(t), q = await c.plan(); c.config.trace.image.imageId = 'sha256:' + '2'.repeat(64); c.write(); await assert.rejects(c.run(q)); assert.equal(c.state.containers, 0);
  const stale = setup(t); stale.replay.checkpointHash = 'd'.repeat(64); await assert.rejects(stale.plan()); assert.equal(stale.state.containers, 0);
});
test('trace configuration is closed and does not accept a candidate, raw executor, arbitrary rule or auth override', async t => {
  for (const patch of [{ candidateRole: 'not allowed' }, { module: 'anything' }, { variants: ['original', 'candidate'] }, { scoring: {} }, { codexAuthFile: '/other/auth.json' }, { rules: {} }]) {
    const h = setup(t); Object.assign(h.config.trace, patch); h.write(); await assert.rejects(h.plan(), /wiki_original_precheck_(config|trace_config)_invalid/); assert.equal(h.state.containers, 0);
  }
});
test('missing trace Goal evidence is invalid, never parsed from opaque bash and never a favorable score', async t => {
  const h = setup(t, { missingEvidence: true, repeats: 1 }), p = await h.plan(), r = await h.run(p);
  assert.equal(r.status, 'completed'); assert.equal(r.summary.invalid, 1); assert.equal(r.summary.valid, 0); assert.equal(r.summary.controlEligible, false);
});

test('native structured arguments also use production trace scoring, without bash parsing or an AI judge', async t => {
  const h = setup(t, { repeats: 1 });
  const d = h.store.saveRubricDraft({ caseId: h.c.id, model: 'deepseek/deepseek-v4-flash', questions: [], scoringModel: null,
    toolCheck: { method: 'code', target: { kind: 'native', name: 'read' }, mode: 'on-call', rules: [{ parameter: 'path', kind: 'max-chars', max: 4 }] } }, h.store.read().revision);
  const rubric = h.store.confirmRubric({ rubricId: d.id, hash: d.hash, confirmationRecord: 'Synthetic native approval' }, h.store.read().revision);
  h.config.rubricHash = rubric.hash; h.write(); const p = await h.plan(), r = await h.run(p);
  assert.equal(r.status, 'completed'); assert.equal(r.summary.fail, 1); assert.equal(h.state.judgeReads, 0);
});
test('trace cap between two exchanges cancels the turn, retains known first usage and never starts a replacement', async t => {
  const h = setup(t, { callsPerTurn: 2, maxRequests: 1 }), p = await h.plan(), r = await h.run(p);
  assert.equal(r.status, 'stopped'); assert.equal(r.reason, 'request_limit'); assert.equal(r.runs.length, 1); assert.equal(r.runs[0].status, 'error');
  assert.equal(r.budget.knownUsage.totalTokens, 13); assert.equal(r.budget.usageComplete, true); assert.equal(h.state.sends, 1); assert.equal(h.state.containers, 1); assert.equal(h.state.closed, 1);
});
test('Ctrl+C joins the trace execution and closes transport; no later paid exchange or attempt', async t => {
  const h = setup(t), p = await h.plan(), listeners = process.listenerCount('SIGINT'), execute = h.dependencies.traceOptions.executeCodex;
  let joined = false;
  const r = await h.run(p, { traceOptions: { ...h.dependencies.traceOptions, async executeCodex(...args) {
    const result = await execute(...args); process.emit('SIGINT'); assert.equal(args[2].signal.aborted, true); await Promise.resolve(); joined = true; return result;
  } } });
  assert.equal(r.status, 'stopped'); assert.equal(r.reason, 'operator_interrupted'); assert.equal(h.state.containers, 1); assert.equal(h.state.closed, 1); assert.equal(joined, true);
  assert.equal(process.listenerCount('SIGINT'), listeners); assert.equal(r.summary.reproduced, false);
});
test('known-usage technical judge errors consume fixed trace slots, not new worker answers', async t => {
  const h = setup(t, { reply: true, repeats: 2 }), p = await h.plan();
  const r = await h.run(p, { createJudgeExchange() { return { async close() {}, async exchange() {
    h.state.judgeSends++; return Buffer.from(JSON.stringify({ status: 200, body: Buffer.from(JSON.stringify({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content: 'not-json' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })).toString('base64') }));
  } }; } });
  assert.equal(r.status, 'completed', r.reason); assert.equal(r.summary.errors, 2); assert.equal(r.summary.valid, 0); assert.equal(h.state.containers, 2); assert.equal(h.state.judgeSends, 4);
  assert.equal(r.summary.reproduced, false); assert.equal(r.summary.controlEligible, false);
});
test('unverified cleanup or receipt credential leakage cannot qualify or be retained as a successful trace', async t => {
  for (const failure of ['cleanup', 'leak']) {
    const h = setup(t, { repeats: 1 }), p = await h.plan(), execute = h.dependencies.traceOptions.executeCodex;
    const r = await h.run(p, { traceOptions: { ...h.dependencies.traceOptions, async executeCodex(...args) { const result = await execute(...args);
      if (failure === 'cleanup') result.cleaned = false; else result.receipt.finalText = h.access; return result;
    } } });
    assert.equal(r.status, 'failed'); assert.equal(r.summary.reproduced, false); assert.equal(r.summary.controlEligible, false); assert.equal(h.state.containers, 1);
    assert.equal(fs.readFileSync(h.outputFile, 'utf8').includes(h.access), false);
  }
});
test('each trace slot must match host-observed exchanges, not inherit known usage or trust claimed model calls', async t => {
  for (const fault of ['zero-second', 'extra-claimed']) {
    const h = setup(t, { repeats: 2 }), p = await h.plan(), execute = h.dependencies.traceOptions.executeCodex; let iteration = 0;
    const r = await h.run(p, { traceOptions: { ...h.dependencies.traceOptions, async executeCodex(image, files, options) {
      iteration++;
      const result = await execute(image, files, fault === 'zero-second' && iteration === 2 ? { ...options, sendNativeRequest: async () => Buffer.from('{}') } : options);
      if (fault === 'extra-claimed') result.receipt.modelCalls.push({ ...result.receipt.modelCalls[0] });
      return result;
    } } });
    assert.equal(r.status, 'failed'); assert.equal(r.summary.reproduced, false); assert.equal(r.summary.controlEligible, false);
    assert.equal(r.reason, 'wiki_original_precheck_trace_evidence_invalid');
    if (fault === 'zero-second') assert.equal(Object.hasOwn(r.runs[1], 'usage'), false, 'a zero-request failed slot cannot inherit prior known usage');
  }
});
test('runtime drift after offline preparation is refused before auth/container/provider execution', async t => {
  const h = setup(t), p = await h.plan(), stage = h.dependencies.traceOptions.stage;
  await assert.rejects(h.run(p, { traceOptions: { ...h.dependencies.traceOptions, stage(...args) { return [...stage(...args), { path: 'runtime/drift', bytes: Buffer.from('changed') }]; } } }), /wiki_precheck_confirmation_required/);
  assert.equal(h.state.containers + h.state.sends, 0); assert.equal(fs.existsSync(h.outputFile), false);
});
