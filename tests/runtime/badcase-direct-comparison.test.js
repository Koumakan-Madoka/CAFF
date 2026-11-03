// Pure host orchestration fakes: no Docker/SDK/supplier or credentials are used.
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), crypto = require('node:crypto');
const { prepareComparison, runComparison, scoreReadOnlyFiles, formatComparison, expectedTreeHash } = require('../../scripts/badcase-capture/direct-comparison.cjs');
const { argumentsFor } = require('../../scripts/badcase-capture/compare-sealed.cjs');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const fs = require('node:fs'), os = require('node:os'), vm = require('node:vm');
const key = 'fake-unit-test-model-key-123456789', model = 'opencode-go/deepseek-v4.1-flash';
// Execute the actual worker main with a mapped disposable filesystem and fake
// SDK/callback. No container assertion bypass or network is added to production.
async function workerReceipt(t, { files = [], fileBytes = {}, directoryWorkspace = false, repositorySnapshot, published = '', withCallback = true, fileEvidencePaths, afterTurn = () => {}, profile = model, prompt = 'Inspect the files.', recordedModelConfig } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-worker-regression-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = { kind: 'prepared-caff-turn-v1', prompt, files: files.map(p => ({ path: p,
    base64: Buffer.from(fileBytes[p] ?? p).toString('base64'), sha256: crypto.createHash('sha256').update(fileBytes[p] ?? p).digest('hex') })),
    sessionText: null, settings: null, systemPrompt: null,
    ...(recordedModelConfig === undefined ? {} : { recordedModelConfig }),
    ...(repositorySnapshot ? { repository: repositorySnapshot.report, gitFiles: repositorySnapshot.gitFiles } : {}),
    callback: withCallback ? { trace: {}, expectedTraceHash: 'fixture', association: {} } : null,
    ...(fileEvidencePaths === undefined ? {} : { fileEvidencePaths }) };
  fs.writeFileSync(path.join(root, 'evaluation-profile.json'), JSON.stringify(profile));
  if (directoryWorkspace) {
    const staged = require('../../scripts/badcase-capture/direct-docker.cjs').prepareDirectReplayInput(input);
    for (const f of staged) { const dest = path.join(root, f.path); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, f.bytes); }
  } else fs.writeFileSync(path.join(root, 'replay-input.json'), JSON.stringify(input));
  const mapped = p => { assert.ok(p.startsWith('/work/')); return path.join(root, p.slice(6)); };
  const workerFs = Object.fromEntries(['mkdirSync', 'readFileSync', 'writeFileSync', 'readdirSync', 'lstatSync']
    .map(name => [name, (p, ...args) => fs[name](mapped(p), ...args)]));
  workerFs.existsSync = p => p === '/.dockerenv' || fs.existsSync(mapped(p));
  workerFs.renameSync = (a, b) => fs.renameSync(mapped(a), mapped(b));
  const observer = { calls: [], complete() {}, fetch: async () => { throw Error('unexpected_network'); } };
  let subscriber, disposed = false, stopped = false, startConfig, callbackLifetimeMs, invocationPrompt;
  const selected = require('../../scripts/badcase-capture/direct-model.cjs').modelProfile(profile);
  const session = { messages: [], model: { provider: selected.provider, id: selected.model, api: selected.api || 'openai-completions' }, thinkingLevel: selected.thinking || 'off',
    agent: { transport: 'websocket', state: { tools: Array.from({ length: 10 }, (_, i) => ({ name: 'tool-' + i })) } },
    bindExtensions: async () => {}, subscribe: f => { subscriber = f; }, prompt: async submitted => {
      invocationPrompt = submitted;
      const message = { role: 'assistant', content: [{ type: 'text', text: 'INTERNAL ONLY: stable file; deleted.txt 不存在' }], stopReason: 'stop' };
      afterTurn(path.join(root, 'restored'));
      session.messages.push(message); observer.calls.push({ model: profile, durationMs: 1, success: true });
      subscriber({ type: 'message_end', message });
    } };
  const runtime = { session, services: { settingsManager: { applyOverrides: () => {} }, resourceLoader: { getExtensions: () => ({ errors: [] }) } }, dispose: async () => { disposed = true; } };
  const workerRequire = name => {
    if (name === 'node:fs') return workerFs;
    if (name === 'node:child_process') return { execFileSync: (program, args, options) => {
      assert.equal(program, 'git'); assert.equal(options.env.CAFF_BADCASE_MODEL_KEY, undefined);
      return require('node:child_process').execFileSync(program, args.map(a => a === '/work/restored' ? mapped(a) : a),
        { ...options, env: { ...require('../../scripts/badcase-capture/replay-git.cjs').gitEnvironment(), ...options.env, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
    } };
    if (name === '/work/direct-model.cjs') return { ...require('../../scripts/badcase-capture/direct-model.cjs'), observeDirectFetch: () => observer };
    if (name === '/work/codex-mailbox.cjs') return { createCodexMailboxFetch: () => observer.fetch };
    if (name === '/work/build/server/domain/runtime/badcase-capture/secrets') return require('../../build/server/domain/runtime/badcase-capture/secrets');
    if (name === '/work/caff-runtime-bootstrap.cjs') return { verifyCaffRuntimeStage: () => ({ manifest: { inputHash: 'input', runtimeHash: 'runtime' } }) };
    if (name === '/work/build/server/domain/runtime/badcase-capture/evaluation-callback') return { startEvaluationCallback: async config => {
      callbackLifetimeMs = config.lifetimeMs;
      return { apiUrl: 'http://127.0.0.1:1', credentials: { invocationId: 'fixture', callbackToken: 'fixture-only' },
        readPublicReply: () => published, stop: async () => { stopped = true; } }; } };
    assert.ok(name.startsWith('node:'), name); return require(name);
  };
  const workerModule = { exports: {} }, filename = require.resolve('../../scripts/badcase-capture/direct-sdk-container.cjs');
  vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports', 'process'], { filename })(
    workerRequire, workerModule, workerModule.exports, { platform: 'linux', getuid: () => 65534, cwd: () => '/work', env: profile === 'openai-codex/gpt-6.1-sol' ? {} : { CAFF_BADCASE_MODEL_KEY: key } });
  const receipt = await workerModule.exports.main({ loadModule: async name => {
    if (name === '/work/runtime/dist/bundle/index.js') return { VERSION: '0.85.1' };
    assert.equal(name, '/work/build/lib/pi-sdk-host.mjs');
    return { normalizeStartCommand: c => c, createSdkRuntime: async (_sdk, config) => { startConfig = config; return { runtime }; } };
  } });
  assert.equal(disposed, true); assert.equal(stopped, withCallback);
  return { receipt, input, startConfig, callbackLifetimeMs, invocationPrompt, settings: fs.existsSync(path.join(root, 'agent/settings.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'agent/settings.json'))) : null };
}
function config() {
  return { repoRoot: path.resolve('.'), dependencyRoot: path.resolve('.'), request: {}, image: { imageId: 'sha256:' + '1'.repeat(64) },
    repeats: 2, candidateRole: 'Check every file.', rules: { kind: 'read-only-files-v1', readPaths: ['tracked.txt'], absentPaths: ['deleted.txt'], requiredReplyFragments: ['stable file', 'deleted.txt 不存在'] } };
}
function fakes({ badReply = false, modelError = false, workerError = false, badBefore = false, leaked = false } = {}) {
  const state = { executions: 0, keys: 0, events: [] };
  const input = { kind: 'prepared-caff-turn-v1', files: [{ path: 'tracked.txt', base64: Buffer.from('stable file').toString('base64'),
    sha256: crypto.createHash('sha256').update('stable file').digest('hex') }], prompt: 'original', sessionText: null, deletions: ['deleted.txt'] };
  const prepare = (_request, candidate) => ({ supported: true, input: { ...input, prompt: candidate || 'original' },
    provenance: { caseId: 'case1', checkpointId: 'cp1', checkpointHash: 'c', commonInputHash: 'common' } });
  const stage = (_repo, _deps, _image, input) => [{ path: 'probe.cjs', bytes: Buffer.from(JSON.stringify(input)) }, { path: 'runtime/test', bytes: Buffer.from('same runtime') }];
  const execute = async (_image, files, options) => {
    state.executions++; assert.equal(options.key, key); assert.equal(options.network, 'bridge');
    if (workerError) throw Error('not returned to logs ' + key);
    const m = manifestFor(files), candidate = JSON.parse(files[0].bytes).prompt !== 'original';
    return { code: 0, cleaned: true, containerId: 'a'.repeat(64), isolation: { privileged: false }, receipt: {
      kind: 'direct-caff-turn-v1', inputHash: m.inputHash, runtimeHash: m.runtimeHash, success: !modelError,
      beforeHash: badBefore ? 'wrong' : expectedTreeHash(input), afterHash: expectedTreeHash(input),
      toolCalls: [{ name: 'read', isError: false, args: { path: 'tracked.txt' } }],
      replySource: 'public', finalText: leaked ? key : badReply && candidate ? 'wrong facts' : 'stable file; deleted.txt 不存在',
      modelCalls: [{ model: files.find(f => f.path === 'evaluation-profile.json') ? JSON.parse(files.find(f => f.path === 'evaluation-profile.json').bytes) : model, durationMs: 10, success: !modelError, httpStatus: modelError ? 401 : 200, usage: null }] } };
  };
  return { state, input, options: { prepare, stage, execute, confirmed: true, readKey: () => { state.keys++; return key; }, onEvent: e => state.events.push(e) } };
}
test('planning is credential/Docker-free; unsupported and unconfirmed inputs cannot run', async () => {
  const f = fakes(); const p = prepareComparison(config(), f.options); assert.equal(p.supported, true); assert.equal(f.state.keys, 0); assert.equal(f.state.executions, 0);
  await assert.rejects(runComparison(config(), { ...f.options, confirmed: false }), /confirmation_required/);
  const no = await runComparison(config(), { ...f.options, prepare: () => ({ supported: false }) });
  assert.equal(no.supported, false); assert.equal(f.state.executions, 0); assert.equal(f.state.keys, 0);
});
test('Codex cannot enter legacy CLI key injection without an explicitly selected host access source', async () => {
  const f = fakes(), c = { ...config(), modelProfile: 'openai-codex/gpt-6.1-sol' };
  assert.throws(() => prepareComparison(c, f.options), /evaluation_codex_auth_source_required/);
  await assert.rejects(runComparison(c, f.options), /evaluation_codex_auth_source_required/);
  assert.equal(f.state.keys, 0); assert.equal(f.state.executions, 0);
});
test('N real-driver slots per variant, per-call rows, host scoring only after cleanup, exact pass totals', async () => {
  const f = fakes({ badReply: true }), r = await runComparison(config(), f.options);
  assert.equal(r.completed, true); assert.equal(f.state.executions, 4); assert.equal(f.state.keys, 1);
  assert.equal(r.totals.original.passed, 2); assert.equal(r.totals.candidate.passed, 0); assert.equal(r.totals.candidate.failed, 2);
  assert.equal(r.modelCallsKnown, 4); assert.equal(f.state.events.filter(e => e.event === 'model_call').length, 4);
  assert.equal(f.state.events.filter(e => e.event === 'run').length, 4); assert.equal(JSON.stringify(r).includes(key), false);
  assert.match(formatComparison(r), /original: 2\/2/); assert.match(formatComparison(r), /candidate: 0\/2/);
  assert.match(formatComparison(r), /usage=null/);
});
test('explicit DeepSeek profile reaches both stages, manifests and receipts; CAFF auth cannot be used for OpenCode', async () => {
  const c = { ...config(), modelProfile: 'deepseek/deepseek-v4-flash', keySource: 'caff-deepseek' }, f = fakes(), stage = f.options.stage;
  f.options.stage = (...args) => { assert.equal(args[4], c.modelProfile); return [...stage(...args), { path: 'evaluation-profile.json', bytes: Buffer.from(JSON.stringify(args[4])) }]; };
  const plan = prepareComparison(c, f.options); assert.equal(plan.summary.model, c.modelProfile); assert.equal(f.state.keys, 0);
  const r = await runComparison(c, f.options); assert.equal(r.completed, true); assert.equal(r.model, c.modelProfile);
  assert.ok(r.runs.every(r => r.modelCalls.every(c => c.model === 'deepseek/deepseek-v4-flash')));
  assert.throws(() => prepareComparison({ ...c, modelProfile: undefined }, f.options), /config_invalid/);
  assert.throws(() => prepareComparison({ ...c, keySource: 'ambient-discovery' }, f.options), /config_invalid/);
});
test('model failure stops immediately without retry/candidate; request row retained and not-run denominator explicit', async () => {
  const f = fakes({ modelError: true }), r = await runComparison(config(), f.options);
  assert.equal(f.state.executions, 1); assert.equal(r.completed, false); assert.equal(r.runs[0].status, 'error');
  assert.equal(r.modelCallsKnown, 1); assert.equal(r.callsUnavailable, false); assert.equal(r.totals.original.notRun, 1); assert.equal(r.totals.candidate.notRun, 2);
  assert.equal(f.state.events.find(e => e.event === 'model_call').httpStatus, 401);
});
test('a turn stopped after successful HTTP calls is still error, never pass or a fabricated failed request', async () => {
  const f = fakes(), execute = f.options.execute;
  f.options.execute = async (...args) => {
    const result = await execute(...args);
    result.receipt.success = false; // e.g. the next SDK attempt hit the request budget before HTTP.
    return result;
  };
  const r = await runComparison(config(), f.options);
  assert.equal(f.state.executions, 1);
  assert.equal(r.completed, false);
  assert.equal(r.runs[0].status, 'error');
  assert.equal(r.runs[0].reason, 'model_turn_failed');
  assert.equal(r.runs[0].modelCalls[0].success, true);
  assert.equal(r.modelCallsKnown, 1);
  assert.equal(r.totals.original.notRun, 1);
  assert.equal(r.totals.candidate.notRun, 2);
});
test('missing worker/cleanup/before-state or leaked output cannot score; raw errors and selected key never logged', async () => {
  for (const setup of [{ workerError: true }, { badBefore: true }, { leaked: true }]) {
    const f = fakes(setup), r = await runComparison(config(), f.options);
    assert.equal(f.state.executions, 1); assert.equal(r.runs[0].status, 'error'); assert.equal(r.callsUnavailable, true);
    assert.equal(r.runs[0].replySource, 'unknown');
    assert.equal(r.totals.original.passed, 0); assert.equal(r.modelCallsKnown, 0);
    assert.equal(JSON.stringify(f.state.events).includes(key), false); assert.equal(JSON.stringify(r).includes(key), false);
    assert.match(formatComparison(r), /unknown/);
  }
  const f = fakes(), execute = f.options.execute;
  f.options.execute = async (...args) => ({ ...await execute(...args), cleaned: false });
  assert.equal((await runComparison(config(), f.options)).runs[0].status, 'error');
});
test('seal/distribution/runtime changes cannot silently start from a different point', async () => {
  const f = fakes(), prepare = f.options.prepare; let reads = 0;
  f.options.prepare = (...args) => { const p = prepare(...args); if (++reads > 2) p.provenance.commonInputHash = 'changed'; return p; };
  await assert.rejects(runComparison(config(), f.options), /input_changed/); assert.equal(f.state.executions, 0);
  const g = fakes(), stage = g.options.stage; let stages = 0;
  g.options.stage = (...args) => { const files = stage(...args); if (++stages > 2) files[1].bytes = Buffer.from('changed runtime'); return files; };
  await assert.rejects(runComparison(config(), g.options), /input_changed/); assert.equal(g.state.executions, 0);
});
test('rubric requires actual reads, exact original tree and reply fragments, not worker self-score', () => {
  const c = config(), f = fakes(), beforeHash = expectedTreeHash(f.input), base = { success: true,
    modelCalls: [{ success: true }], toolCalls: [{ name: 'read', isError: false, args: { path: '/work/restored/tracked.txt' } }],
    replySource: 'public', finalText: 'stable file; deleted.txt 不存在', beforeHash, afterHash: beforeHash, scored: true, pass: true };
  assert.equal(scoreReadOnlyFiles(base, c.rules, beforeHash).pass, true);
  for (const patch of [{ toolCalls: [] }, { afterHash: 'different' }, { finalText: 'done' }, { success: false },
    { toolCalls: [...base.toolCalls, { name: 'write', isError: true }] }]) assert.equal(scoreReadOnlyFiles({ ...base, ...patch }, c.rules, beforeHash).pass, false);
});
test('turn timeout accepts up to 45 minutes, is bound into plan and reaches the executor unchanged', async () => {
  const f = fakes(), c = { ...config(), timeoutMs: 2700000 }, execute = f.options.execute;
  const plan = prepareComparison(c, f.options); assert.equal(plan.summary.timeoutMs, c.timeoutMs);
  assert.equal(prepareComparison(config(), f.options).summary.timeoutMs, 120000);
  f.options.execute = (...args) => { assert.equal(args[2].timeoutMs, c.timeoutMs); return execute(...args); };
  const result = await runComparison(c, f.options); assert.equal(result.completed, true);
  assert.match(formatComparison(result), /容器时限：2700秒/);
  for (const timeoutMs of [999, 2700001, Infinity]) assert.throws(() => prepareComparison({ ...c, timeoutMs }, f.options), /evaluation_config_invalid/);
});
test('worker accepts the full 256 KiB prompt and keeps public callback valid for the 45-minute ceiling', async t => {
  const prompt = '中'.repeat(87381) + 'a', r = await workerReceipt(t, { prompt });
  assert.equal(Buffer.byteLength(prompt), 262144); assert.equal(r.invocationPrompt, prompt);
  assert.equal(r.input.prompt, prompt); assert.equal(r.callbackLifetimeMs, 2700000); assert.equal(r.receipt.success, true);
  await assert.rejects(workerReceipt(t, { prompt: prompt + 'a' }), /AssertionError/);
});
test('Codex worker uses credential-free mailbox, xhigh native model, SSE and no automatic retry', async t => {
  const { receipt, startConfig, settings } = await workerReceipt(t, { profile: 'openai-codex/gpt-6.1-sol' });
  assert.equal(startConfig.provider, 'openai-codex'); assert.equal(startConfig.model, 'gpt-6.1-sol'); assert.equal(startConfig.thinking, 'xhigh');
  assert.equal(settings.transport, 'sse'); assert.equal(settings.retry.enabled, false); assert.equal(settings.retry.provider.maxRetries, 0);
  assert.deepEqual(receipt.modelConfig, { api: 'openai-codex-responses', thinking: 'xhigh', fast: false, transport: 'sse', credentialDelivery: 'host-only-mailbox' });
  assert.equal(receipt.success, true); assert.equal(receipt.modelCalls[0].model, 'openai-codex/gpt-6.1-sol');
});
test('worker reports the recorded production configuration and refuses silent thinking conversion', async t => {
  const recorded = { provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'xhigh', fast: false };
  const r = await workerReceipt(t, { profile: 'openai-codex/gpt-6.1-sol', recordedModelConfig: recorded });
  assert.deepEqual(JSON.parse(JSON.stringify(r.receipt.recordedModelConfig)), recorded); assert.equal(r.startConfig.thinking, 'xhigh');
  await assert.rejects(workerReceipt(t, { profile: 'openai-codex/gpt-6.1-sol', recordedModelConfig: { ...recorded, thinking: 'off' } }), /AssertionError/);
});
test('host requires matching recorded config in worker evidence; missing or changed thinking never scores', async () => {
  for (const mode of ['matching', 'missing', 'changed']) {
    const f = fakes(), prepare = f.options.prepare, execute = f.options.execute;
    const recorded = { provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off', fast: false };
    f.options.prepare = (...args) => { const p = prepare(...args); p.input.recordedModelConfig = recorded; return p; };
    f.options.execute = async (...args) => { const task = await execute(...args);
      if (mode !== 'missing') task.receipt.recordedModelConfig = { ...recorded, ...(mode === 'changed' ? { thinking: 'xhigh' } : {}) }; return task; };
    const result = await runComparison(config(), f.options);
    assert.equal(result.completed, mode === 'matching'); assert.equal(result.runs[0].status, mode === 'matching' ? 'pass' : 'error');
    if (mode !== 'matching') { assert.equal(f.state.executions, 1); assert.equal(result.totals.original.passed, 0); }
  }
});
test('worker hashes nested files and same-prefix siblings in the same order as the host', async t => {
  const { receipt, input } = await workerReceipt(t, { files: ['src/index.js', 'src.js', 'a/item.txt', 'a.txt', 'docs/readme.md', 'docs.md'] });
  assert.equal(receipt.beforeHash, expectedTreeHash(input));
  assert.equal(receipt.afterHash, expectedTreeHash(input));
});
test('worker consumes a large verified directory workspace without needing file bodies in JSON', async t => {
  const bytes = Buffer.alloc(25 * 1024 * 1024, 0x61);
  const { receipt, input } = await workerReceipt(t, { files: ['nested/large.txt', 'plain.txt'],
    fileBytes: { 'nested/large.txt': bytes }, directoryWorkspace: true });
  assert.equal(receipt.beforeHash, expectedTreeHash(input)); assert.equal(receipt.afterHash, expectedTreeHash(input));
});
test('actual worker verifies preserved Git HEAD and multiple commits, hashing only captured working files', async t => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-git-source-'));
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  const { prepareReplayGit, gitEnvironment } = require('../../scripts/badcase-capture/replay-git.cjs');
  const git = args => require('node:child_process').execFileSync('git', ['-C', sourceRoot, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { env: gitEnvironment(), encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']); fs.writeFileSync(path.join(sourceRoot, 'source.txt'), 'before'); git(['add', 'source.txt']); git(['commit', '-q', '-m', 'unit test source']);
  git(['commit', '-q', '--allow-empty', '-m', 'second source commit']);
  const head = git(['rev-parse', 'HEAD']).trim(), repositorySnapshot = prepareReplayGit({ sourceRoot, head }, { files: [{ path: 'source.txt' }], deletions: [] });
  const { receipt, input } = await workerReceipt(t, { files: ['source.txt'], fileBytes: { 'source.txt': 'captured dirty file' }, directoryWorkspace: true, repositorySnapshot });
  assert.equal(receipt.repository.gitAvailable, true); assert.equal(receipt.repository.historyCommitCount, 2);
  assert.equal(receipt.repository.historyIncluded, true); assert.equal(receipt.repository.sourceHead, head);
  assert.equal(receipt.repository.restoredHead, head); assert.equal(receipt.beforeHash, expectedTreeHash(input));
});
test('worker callback reply never falls back to internal SDK text, and source is explicit', async t => {
  const missing = (await workerReceipt(t)).receipt;
  assert.equal(missing.success, true); assert.equal(missing.finalText, ''); assert.equal(missing.replySource, 'none');
  const posted = (await workerReceipt(t, { published: 'Public facts, not internal text.' })).receipt;
  assert.equal(posted.finalText, 'Public facts, not internal text.'); assert.equal(posted.replySource, 'public');
  const standalone = (await workerReceipt(t, { withCallback: false })).receipt;
  assert.match(standalone.finalText, /INTERNAL ONLY/); assert.equal(standalone.replySource, 'internal');
});
test('worker returns only requested final file bytes, with explicit missing/unsupported and no encoded credentials', async t => {
  const { scoreLiteralFiles } = require('../../scripts/badcase-capture/file-literal-rules.cjs');
  const rules = { kind: 'file-literals-v1', files: [{ path: 'output.txt', contains: ['verified result'], notContains: ['TODO'] }] };
  const successful = (await workerReceipt(t, { files: ['source.txt'], fileEvidencePaths: ['output.txt'],
    afterTurn: cwd => fs.writeFileSync(path.join(cwd, 'output.txt'), 'verified result\n') })).receipt;
  assert.equal(scoreLiteralFiles(successful, rules).pass, true); assert.equal(successful.fileEvidence.length, 1);
  assert.equal(successful.fileEvidence[0].size, Buffer.byteLength('verified result\n'));
  const missing = (await workerReceipt(t, { fileEvidencePaths: ['output.txt'] })).receipt;
  assert.equal(missing.fileEvidence[0].state, 'missing'); assert.equal(scoreLiteralFiles(missing, rules).pass, false);
  for (const bytes of [Buffer.from([0xff, 0xfe]), Buffer.from('a\0b'), Buffer.from('x'.repeat(65537)), Buffer.from(key), Buffer.from('sk-FAKE_SENTINEL_123456')]) {
    const receipt = (await workerReceipt(t, { fileEvidencePaths: ['output.txt'], afterTurn: cwd => fs.writeFileSync(path.join(cwd, 'output.txt'), bytes) })).receipt;
    assert.deepEqual(receipt.fileEvidence, [{ path: 'output.txt', state: 'unsupported' }]);
    assert.equal(scoreLiteralFiles(receipt, rules).available, false);
    assert.equal(JSON.stringify(receipt).includes(bytes.toString('base64')), false);
  }
});

test('host requires public provenance even if internal/legacy text matches every reply fragment', () => {
  const f = fakes(), beforeHash = expectedTreeHash(f.input), base = { success: true, modelCalls: [{ success: true }],
    toolCalls: [{ name: 'read', isError: false, args: { path: 'tracked.txt' } }], beforeHash, afterHash: beforeHash,
    finalText: 'stable file; deleted.txt 不存在', replySource: 'public' };
  assert.equal(scoreReadOnlyFiles(base, config().rules, beforeHash).pass, true);
  for (const replySource of ['internal', 'none', undefined, 'unknown']) {
    const score = scoreReadOnlyFiles({ ...base, replySource }, config().rules, beforeHash);
    assert.equal(score.pass, false); assert.equal(score.checks.reply, false);
  }
});
test('run events/results and CLI expose public publication or its absence without substituting text', async () => {
  for (const replySource of ['public', 'none', 'internal', undefined]) {
    const f = fakes(), execute = f.options.execute;
    f.options.execute = async (...args) => {
      const task = await execute(...args); task.receipt.replySource = replySource;
      if (replySource === 'none') task.receipt.finalText = '';
      return task;
    };
    const r = await runComparison(config(), f.options), source = replySource ?? 'unknown';
    assert.equal(r.completed, true);
    assert.ok(r.runs.every(row => row.replySource === source && row.status === (source === 'public' ? 'pass' : 'fail')));
    assert.ok(f.state.events.filter(e => e.event === 'run').every(row => row.replySource === source));
    assert.match(formatComparison(r), new RegExp('original\\t1\\t' + (source === 'public' ? 'pass' : 'fail') + '\\t1\\t' + source));
  }
});
test('absence claims in the rubric must match the captured deletion state, never merely a reply fragment', () => {
  const f = fakes(), c = config(); c.rules.absentPaths = ['tracked.txt'];
  assert.throws(() => prepareComparison(c, f.options), /rules_invalid/);
  c.rules.absentPaths = ['never-captured.txt']; assert.throws(() => prepareComparison(c, f.options), /rules_invalid/);
});
test('selected key in rubric is refused before any event or execution, and invalid limits/config have no side effects', async () => {
  const f = fakes(), c = config(); c.rules.requiredReplyFragments.push(key);
  await assert.rejects(runComparison(c, f.options), /output_contains_key/); assert.equal(f.state.events.length, 0); assert.equal(f.state.executions, 0);
  for (const patch of [{ repeats: 0 }, { repeats: 21 }, { timeoutMs: 0 }, { key: 'not permitted in config' }]) assert.throws(() => prepareComparison({ ...config(), ...patch }, f.options), /config_invalid/);
});
test('CLI run requires explicit confirmation and a new output file; plan does not request auth', () => {
  const file = path.resolve('case.json'), output = path.resolve('result.jsonl');
  assert.equal(argumentsFor(['--config', file, '--plan'])['--plan'], true);
  assert.equal(argumentsFor(['--config', file, '--run', '--confirmed', '--output', output])['--run'], true);
  for (const args of [['--config', file, '--run'], ['--config', file, '--run', '--output', output], ['--config', file, '--plan', '--run'],
    ['--config', file, '--plan', '--output', output], ['--config', 'relative', '--plan'], ['--config', file, '--plan', '--unknown']]) assert.throws(() => argumentsFor(args), /cli_invalid/);
});
