// Host orchestration only: synthetic auth + fake native provider/container.
// No real auth file, Docker, proxy or model request is used.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { prepareComparison, runComparison, expectedTreeHash, formatComparison } = require('../../scripts/badcase-capture/direct-comparison.cjs');
const { createCodexTransport, PROFILE } = require('../../scripts/badcase-capture/codex-transport.cjs');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const modelConfig = { api: PROFILE.api, thinking: PROFILE.thinking, fast: false, transport: 'sse', credentialDelivery: 'host-only-mailbox' };
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function fixture(t, { expired = false, providerStatus = 200 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-comparison-')), dir = path.join(root, '.pi-sandbox'); fs.mkdirSync(dir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 2000000000000;
  const access = 'test.' + Buffer.from(JSON.stringify({ exp: now / 1000 + 600, 'https://api.openai.com/auth': { chatgpt_account_id: 'unit-test-account' } })).toString('base64url') + '.test';
  const authFile = path.join(dir, 'auth.json'), originalAuth = JSON.stringify({ 'openai-codex': { type: 'oauth', access,
    expires: now + (expired ? -1 : 600000), refresh: 'SYNTHETIC-UNUSED-REFRESH' } }); fs.writeFileSync(authFile, originalAuth);
  const config = { repoRoot: path.resolve('.'), dependencyRoot: path.resolve('.'), request: {}, image: { imageId: 'sha256:' + '1'.repeat(64) },
    repeats: 2, candidateRole: 'Candidate.', modelProfile: PROFILE.model, keySource: 'caff-codex-access', codexAuthFile: authFile,
    rules: { kind: 'read-only-files-v1', readPaths: ['source.txt'], absentPaths: [], requiredReplyFragments: ['public answer'] } };
  const input = { kind: 'prepared-caff-turn-v1', prompt: 'Original.', sessionText: null, deletions: [],
    files: [{ path: 'source.txt', base64: Buffer.from('safe bytes').toString('base64'), sha256: hash('safe bytes') }] };
  const state = { legacyReads: 0, legacyRuns: 0, nativeRuns: 0, sends: 0, closed: 0, events: [], transports: [] };
  const options = { confirmed: true,
    prepare: (_req, candidate) => ({ supported: true, input: { ...input, prompt: candidate || input.prompt }, provenance: { caseId: 'case', checkpointHash: 'checkpoint', commonInputHash: 'common' } }),
    stage: (_repo, _deps, _image, data, profile) => { assert.equal(profile, PROFILE.model); return [
      { path: 'probe.cjs', bytes: Buffer.from(JSON.stringify(data)) }, { path: 'runtime/a', bytes: Buffer.from('fixed runtime') } ]; },
    readKey: () => { state.legacyReads++; throw Error('legacy key forbidden'); }, execute: () => { state.legacyRuns++; throw Error('legacy runner forbidden'); },
    createCodexTransport: (cfg, guards) => {
      assert.deepEqual(cfg, { authFile, confirmed: true, timeoutMs: 120000 });
      const transport = createCodexTransport(cfg, { ...guards, now: () => now, createDispatcher: () => ({ destroy: async () => { state.closed++; } }),
        fetch: async (_url, q) => { state.sends++; assert.equal(q.headers.get('authorization'), 'Bearer ' + access);
          return providerStatus === 200 ? new Response('data: native bytes\n\n') : new Response('{"error":{"code":"usage_limit_reached"}}', { status: providerStatus }); } });
      state.transports.push(transport); return transport;
    },
    executeCodex: async (_image, files, opts) => {
      state.nativeRuns++; assert.equal(opts.network, 'none'); assert.equal(opts.key, undefined); assert.equal(typeof opts.sendNativeRequest, 'function');
      const fetch = require('../../scripts/badcase-capture/codex-mailbox.cjs').createCodexMailboxFetch({ exchange: opts.sendNativeRequest });
      await fetch(PROFILE.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ model: 'gpt-6.1-sol', input: [], stream: true, store: false, reasoning: { effort: 'xhigh' } }) });
      const manifest = manifestFor(files, { replayWorkspace: true });
      return { code: 0, cleaned: true, isolation: { network: 'none' }, receipt: { kind: 'direct-caff-turn-v1',
        modelConfig: { ...modelConfig }, success: providerStatus === 200, inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash,
        beforeHash: expectedTreeHash(input), afterHash: expectedTreeHash(input), replySource: 'public', finalText: 'public answer',
        toolCalls: [{ name: 'read', args: { path: 'source.txt' }, isError: false }],
        modelCalls: [{ model: PROFILE.model, success: providerStatus === 200, durationMs: 1, httpStatus: providerStatus, usage: null }] } };
    },
    onEvent: event => state.events.push(event),
  };
  return { config, options, state, input, access, authFile, originalAuth, expire: () => { now += 600000; } };
}
test('trusted native request cap is opt-in, plan-bound, forwarded to staging and launcher, and bounded before auth', async t => {
  const f = fixture(t), legacy = prepareComparison(f.config, f.options);
  assert.equal(Object.hasOwn(legacy.summary, 'nativeMaxRequests'), false);
  const stage = f.options.stage, execute = f.options.executeCodex;
  const config = { ...f.config, nativeMaxRequests: 64 };
  assert.equal(prepareComparison(config, f.options).summary.nativeMaxRequests, 64);
  let staged = 0, launched = 0;
  const result = await runComparison(config, { ...f.options,
    stage: (...args) => { assert.equal(args[5], 64); staged++; return stage(...args); },
    executeCodex: (...args) => { assert.equal(args[2].maxRequests, 64); launched++; return execute(...args); } });
  assert.equal(result.completed, true); assert.equal(result.nativeMaxRequests, 64);
  assert.equal(launched, 4); assert.equal(staged, 6);
  for (const nativeMaxRequests of [0, 65, null, '64', 1.5]) {
    assert.throws(() => prepareComparison({ ...config, nativeMaxRequests }, f.options), /evaluation_codex_mailbox_limits_invalid/);
  }
  assert.throws(() => prepareComparison({ ...f.config, modelProfile: undefined, keySource: undefined, codexAuthFile: undefined, nativeMaxRequests: 64 }, f.options), /evaluation_config_invalid/);
  const g = fixture(t); fs.unlinkSync(g.authFile);
  await assert.rejects(runComparison({ ...g.config, nativeMaxRequests: 65 }, g.options), /evaluation_codex_mailbox_limits_invalid/);
  assert.equal(g.state.transports.length, 0); assert.equal(g.state.nativeRuns, 0);
  assert.equal(JSON.stringify(prepareComparison(f.config, f.options).summary), JSON.stringify(legacy.summary));
});
test('native comparison forwards an optional precheck signal to its verified launcher', async t => {
  const f = fixture(t), controller = new AbortController(), execute = f.options.executeCodex;
  const r = await runComparison(f.config, { ...f.options, signal: controller.signal, executeCodex: async (image, files, options) => {
    assert.equal(options.signal, controller.signal); return execute(image, files, options);
  } });
  assert.equal(r.completed, true); assert.equal(f.state.nativeRuns, 4);
});
test('Codex plan is credential/Docker-free, config is explicit and summary pins only public model settings', async t => {
  const f = fixture(t); fs.unlinkSync(f.authFile);
  const plan = prepareComparison(f.config, f.options); assert.equal(plan.supported, true);
  assert.deepEqual(plan.summary.modelConfig, modelConfig); assert.equal(JSON.stringify(plan.summary).includes(f.authFile), false);
  assert.equal(f.state.transports.length, 0); assert.equal(f.state.nativeRuns, 0);
  await assert.rejects(runComparison(f.config, { ...f.options, confirmed: false }), /evaluation_confirmation_required/);
  for (const patch of [{ keySource: undefined }, { keySource: 'evaluation-env' }, { codexAuthFile: 'relative/auth.json' },
    { codexAuthFile: path.join(path.dirname(f.authFile), 'other.json') }]) assert.throws(() => prepareComparison({ ...f.config, ...patch }, f.options), /evaluation_codex_auth_source_required/);
  assert.throws(() => prepareComparison({ ...f.config, modelProfile: 'deepseek/deepseek-v4-flash', keySource: 'caff-deepseek' }, f.options), /evaluation_config_invalid/);
});
test('explicit Windows/WSL backend is credential-free during planning and bound to the result without touching legacy runners', async t => {
  const f = fixture(t); f.config.dockerBackend = { kind: 'windows-wsl-v1', distribution: 'Debian' };
  const plan = prepareComparison(f.config, f.options); assert.equal(plan.supported, true); assert.deepEqual(plan.summary.dockerBackend, f.config.dockerBackend);
  assert.equal(f.state.transports.length, 0); assert.equal(f.state.nativeRuns, 0);
  const r = await runComparison(f.config, f.options); assert.equal(r.completed, true); assert.deepEqual(r.dockerBackend, f.config.dockerBackend);
  assert.match(formatComparison(r), /WSL.*Debian/); assert.equal(f.state.legacyReads, 0); assert.equal(f.state.legacyRuns, 0);
  for (const dockerBackend of [{ kind: 'auto', distribution: 'Debian' }, { kind: 'windows-wsl-v1', distribution: 'Debian;sh' }]) {
    assert.throws(() => prepareComparison({ ...f.config, dockerBackend }, f.options), /evaluation_wsl_backend_invalid/);
  }
  assert.throws(() => prepareComparison({ ...f.config, modelProfile: 'deepseek/deepseek-v4-flash', keySource: 'caff-deepseek' }, f.options), /evaluation_config_invalid/);
});
test('Windows native run rejects before safety inventory/auth reads as well as before container launch', async t => {
  if (process.platform !== 'win32') return t.skip('Windows host boundary');
  const f = fixture(t); fs.unlinkSync(f.authFile);
  f.config.repository = { sourceRoot: path.dirname(f.authFile), head: 'a'.repeat(40) };
  f.config.knownKeySources = { sandboxRoot: path.dirname(f.authFile), jevSource: 'TYPESAFE_API_KEY' };
  const options = { ...f.options }; delete options.executeCodex;
  await assert.rejects(runComparison(f.config, options), /evaluation_linux_required/);
  assert.equal(f.state.transports.length, 0); assert.equal(f.state.events.length, 0);
});
test('unsupported WSL host or malformed selection rejects before known-source/auth reads', async t => {
  const f = fixture(t); fs.unlinkSync(f.authFile);
  f.config.knownKeySources = { sandboxRoot: path.dirname(f.authFile), jevSource: 'TYPESAFE_API_KEY' };
  const options = { ...f.options }; delete options.executeCodex;
  f.config.dockerBackend = { kind: 'windows-wsl-v1', distribution: 'invalid;name' };
  await assert.rejects(runComparison(f.config, options), /evaluation_wsl_backend_invalid/);
  if (process.platform !== 'win32') {
    f.config.dockerBackend.distribution = 'Debian';
    await assert.rejects(runComparison(f.config, options), /evaluation_wsl_host_required/);
  }
  assert.equal(f.state.transports.length, 0); assert.equal(f.state.nativeRuns, 0); assert.equal(f.state.events.length, 0);
});
test('native repository plans require explicit complete known-value sources rather than treating missing JEV as no secrets', async t => {
  const f = fixture(t); f.config.repository = { sourceRoot: path.dirname(f.authFile), head: 'a'.repeat(40) };
  assert.throws(() => prepareComparison(f.config, f.options), /evaluation_known_sources_required/);
  f.config.knownKeySources = { sandboxRoot: path.join(os.tmpdir(), '.pi-sandbox'), jevSource: 'TYPESAFE_API_KEY' };
  assert.throws(() => prepareComparison(f.config, f.options), /evaluation_known_sources_mismatch/);
  await assert.rejects(runComparison(f.config, { ...f.options, confirmed: false }), /evaluation_confirmation_required/);
  assert.equal(f.state.transports.length, 0); assert.equal(f.state.events.length, 0);
});
test('confirmed run uses host-only access/none-network launcher, verifies model settings, closes transport, never uses legacy key', async t => {
  const f = fixture(t), result = await runComparison(f.config, f.options);
  assert.equal(result.completed, true); assert.equal(f.state.nativeRuns, 4); assert.equal(f.state.sends, 4);
  assert.equal(f.state.legacyReads, 0); assert.equal(f.state.legacyRuns, 0); assert.equal(f.state.closed, 1);
  assert.deepEqual(result.modelConfig, modelConfig); assert.ok(result.runs.every(r => r.status === 'pass'));
  assert.equal(f.state.transports[0].state().closed, true); assert.equal(fs.readFileSync(f.authFile, 'utf8'), f.originalAuth);
  assert.equal(JSON.stringify([result, f.state.events]).includes(f.access), false); assert.match(formatComparison(result), /xhigh/);
});
test('native original-only three-repeat mode has no candidate and reports attempts without inventing remaining quota', async t => {
  const f = fixture(t); f.config.variants = ['original']; f.config.repeats = 3; delete f.config.candidateRole;
  const result = await runComparison(f.config, f.options);
  assert.equal(result.kind, 'sealed-original-replay-v1'); assert.equal(result.completed, true); assert.equal(f.state.nativeRuns, 3);
  assert.deepEqual(Object.keys(result.totals), ['original']); assert.ok(result.runs.every(r => r.variant === 'original' && r.hostRequestAttempts === 1));
  assert.equal(result.measurements.hostRequestAttempts, 3); assert.equal(result.measurements.remainingQuota, null);
  assert.equal(result.measurements.tokenUsage.knownTokens, null); assert.equal(result.measurements.tokenUsage.callsWithoutUsage, 3);
  assert.match(formatComparison(result), /剩余额度未知/);
});
test('host attempts survive missing worker evidence and are not misreported as zero model consumption', async t => {
  const f = fixture(t), execute = f.options.executeCodex; f.config.variants = ['original']; f.config.repeats = 3; delete f.config.candidateRole;
  f.options.executeCodex = async (...args) => { const task = await execute(...args); return { ...task, failed: true, receipt: undefined }; };
  const result = await runComparison(f.config, f.options);
  assert.equal(result.completed, false); assert.equal(result.measurements.hostRequestAttempts, 1); assert.equal(result.modelCallsKnown, 0);
  assert.equal(result.measurements.tokenUsage.complete, false); assert.equal(result.measurements.tokenUsage.callsUnavailable, true);
  assert.equal(result.measurements.tokenUsage.knownTokens, null); assert.equal(result.totals.original.notRun, 2);
});
test('missing/expired access fails before plan event or container, without env fallback', async t => {
  for (const missing of [true, false]) {
    const f = fixture(t, { expired: true }); if (missing) fs.unlinkSync(f.authFile);
    await assert.rejects(runComparison(f.config, f.options), /evaluation_codex_(auth_unavailable|access_expired)/);
    assert.equal(f.state.nativeRuns, 0); assert.equal(f.state.events.length, 0); assert.equal(f.state.legacyReads, 0);
    assert.equal(f.state.transports[0].state().closed, true);
  }
});
test('selected access is checked in staged plaintext, decoded file bytes and rules', async t => {
  for (const where of ['stage', 'file', 'rule']) {
    const f = fixture(t), stage = f.options.stage;
    if (where === 'stage') f.options.stage = (...args) => [...stage(...args), { path: 'runtime/leak', bytes: Buffer.from(f.access) }];
    if (where === 'file') f.input.files[0] = { path: 'source.txt', base64: Buffer.from(f.access).toString('base64'), sha256: hash(f.access) };
    if (where === 'rule') f.config.rules.requiredReplyFragments.push(f.access);
    await assert.rejects(runComparison(f.config, f.options), /evaluation_(input|output)_contains_key/);
    assert.equal(f.state.nativeRuns, 0); assert.equal(f.state.events.length, 0); assert.equal(f.state.transports[0].state().closed, true);
  }
});
test('quota/refusal and expiry between slots remain environment errors and stop without replacement', async t => {
  for (const mode of ['quota', 'expiry']) {
    const f = fixture(t, { providerStatus: mode === 'quota' ? 429 : 200 }), execute = f.options.executeCodex;
    f.options.executeCodex = async (...args) => { const task = await execute(...args); if (mode === 'expiry') f.expire(); return task; };
    const result = await runComparison(f.config, f.options);
    assert.equal(result.completed, false); assert.equal(f.state.sends, 1); assert.equal(f.state.nativeRuns, 1);
    const row = result.runs.at(-1); assert.equal(row.status, 'error'); assert.match(row.reason, mode === 'quota' ? /evaluation_codex_quota_exhausted/ : /evaluation_codex_access_expired/);
    assert.equal(f.state.transports[0].state().closed, true); assert.equal(f.state.closed, 1);
  }
});
test('late-selected access inside compressed Git baseline is refused before event or container', async t => {
  const f = fixture(t), sourceRoot = path.join(path.dirname(path.dirname(f.authFile)), 'source'); fs.mkdirSync(sourceRoot);
  const git = args => require('node:child_process').execFileSync('git', ['-C', sourceRoot, '-c', 'commit.gpgsign=false', ...args],
    { env: require('../../scripts/badcase-capture/replay-git.cjs').gitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  git(['init', '-q', '--template=']); fs.writeFileSync(path.join(sourceRoot, 'source.txt'), f.access);
  git(['add', 'source.txt']); git(['commit', '-q', '-m', 'Synthetic baseline']);
  f.config.repository = { sourceRoot, head: git(['rev-parse', 'HEAD']).trim() };
  f.options.knownValues = []; // Trusted test intentionally delays discovery of access.
  await assert.rejects(runComparison(f.config, f.options), /evaluation_input_contains_key/);
  assert.equal(f.state.nativeRuns, 0); assert.equal(f.state.events.length, 0); assert.equal(f.state.transports[0].state().closed, true);
});
test('known-value inventory also blocks credentials discovered by tools at the actual native egress boundary', async t => {
  const f = fixture(t), opaque = 'synthetic-other-provider-value-at-tool-time'; f.options.knownValues = [opaque];
  f.options.executeCodex = async (_image, _files, opts) => {
    f.state.nativeRuns++;
    await opts.sendNativeRequest(Buffer.from(JSON.stringify({ headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: Buffer.from(JSON.stringify({ model: 'gpt-6.1-sol', input: [], instructions: opaque, stream: true, store: false, reasoning: { effort: 'xhigh' } })).toString('base64') })));
    throw Error('egress should have been refused');
  };
  const result = await runComparison(f.config, f.options);
  assert.equal(f.state.sends, 0); assert.equal(f.state.nativeRuns, 1); assert.equal(result.runs[0].status, 'error');
  assert.equal(result.runs[0].reason, 'evaluation_codex_input_contains_known_key'); assert.equal(f.state.transports[0].state().closed, true);
});
test('safe launcher causes reach JSONL events without replacing missing receipt or authorizing replacements', async t => {
  for (const code of ['evaluation_codex_access_expired', 'evaluation_codex_input_contains_known_key', 'evaluation_codex_input_contains_access', 'wiki_precheck_trace_input_contains_key']) {
    const f = fixture(t);
    f.options.executeCodex = async (_image, _files, opts) => {
      f.state.nativeRuns++;
      opts.onDiagnostic({ phase: 'send', errorCode: code, message: f.access, cause: { code: f.access } });
      opts.onDiagnostic({ phase: 'send', errorCode: 'evaluation_codex_' + f.access });
      opts.onDiagnostic({ phase: 'cleanup', errorCode: 'none', cleanup: { attempted: true, completed: true } });
      throw Error('PRIVATE launcher error ' + f.access);
    };
    const result = await runComparison(f.config, f.options);
    assert.equal(f.state.nativeRuns, 1); assert.equal(f.state.sends, 0);
    assert.equal(result.completed, false); assert.equal(result.callsUnavailable, true);
    assert.equal(result.runs[0].reason, 'run_evidence_unavailable'); assert.equal(result.runs[0].cleaned, false);
    assert.equal(result.runs[0].hostRequestAttempts, 0);
    assert.deepEqual(f.state.events.filter(e => e.event === 'launcher_diagnostic'), [
      { event: 'launcher_diagnostic', variant: 'original', iteration: 1, phase: 'send', errorCode: code },
      { event: 'launcher_diagnostic', variant: 'original', iteration: 1, phase: 'cleanup', errorCode: 'none', cleanup: { attempted: true, completed: true } },
    ]);
    assert.equal(JSON.stringify([result, f.state.events]).includes(f.access), false);
  }
});
test('expiry before a later container is explicitly diagnosed and still stops without a replacement', async t => {
  const f = fixture(t), execute = f.options.executeCodex;
  f.options.executeCodex = async (...args) => { const task = await execute(...args); f.expire(); return task; };
  const result = await runComparison(f.config, f.options);
  assert.equal(result.completed, false); assert.equal(f.state.nativeRuns, 1); assert.equal(f.state.sends, 1);
  assert.deepEqual(f.state.events.filter(e => e.event === 'launcher_diagnostic'), [
    { event: 'launcher_diagnostic', variant: 'original', iteration: 2, phase: 'access', errorCode: 'evaluation_codex_access_expired' },
  ]);
  assert.equal(result.runs.at(-1).reason, 'evaluation_codex_access_expired');
});
test('native receipt config mismatch or encoded output leak never scores, and thrown event callback still closes transport', async t => {
  for (const mode of ['config', 'output', 'event']) {
    const f = fixture(t), execute = f.options.executeCodex;
    f.options.executeCodex = async (...args) => { const task = await execute(...args);
      if (mode === 'config') task.receipt.modelConfig.thinking = 'off';
      if (mode === 'output') task.receipt.fileEvidence = [{ base64: Buffer.from(f.access).toString('base64') }];
      return task; };
    if (mode === 'event') { f.options.onEvent = () => { throw Error('synthetic event error'); }; await assert.rejects(runComparison(f.config, f.options), /synthetic event error/); }
    else { const result = await runComparison(f.config, f.options); assert.equal(result.runs[0].status, 'error'); assert.equal(f.state.nativeRuns, 1);
      assert.equal(JSON.stringify([result, f.state.events]).includes(f.access), false); }
    assert.equal(f.state.transports[0].state().closed, true);
  }
});
