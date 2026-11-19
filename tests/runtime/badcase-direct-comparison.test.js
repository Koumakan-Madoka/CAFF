// Pure host orchestration fakes: no Docker/SDK/supplier or credentials are used.
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), crypto = require('node:crypto');
const { prepareComparison, runComparison, scoreReadOnlyFiles, formatComparison, expectedTreeHash } = require('../../scripts/badcase-capture/direct-comparison.cjs');
const { argumentsFor } = require('../../scripts/badcase-capture/compare-sealed.cjs');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const fs = require('node:fs'), os = require('node:os'), vm = require('node:vm');
const key = 'fake-unit-test-model-key-123456789', model = 'opencode-go/deepseek-v4.1-flash';
// Execute the actual worker main with a mapped disposable filesystem and fake
// SDK/callback. No container assertion bypass or network is added to production.
async function workerReceipt(t, { events = [], nativeMaxRequests, files = [], fileBytes = {}, fileModes = {}, directoryWorkspace = false, repositorySnapshot, published = '', withCallback = true, goalEvidence, fileEvidencePaths, afterTurn = () => {}, profile = model, prompt = 'Inspect the files.', recordedModelConfig, sessionText = null, bindings, projectResources, resourceLoaderPatch = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-worker-regression-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = { kind: 'prepared-caff-turn-v1', prompt, files: files.map(p => ({ path: p,
    base64: Buffer.from(fileBytes[p] ?? p).toString('base64'), sha256: crypto.createHash('sha256').update(fileBytes[p] ?? p).digest('hex'), ...(fileModes[p] === undefined ? {} : { mode: fileModes[p] }) })),
    sessionText, settings: null, systemPrompt: null,
    ...(bindings === undefined ? {} : { bindings }),
    ...(projectResources === undefined ? {} : { projectResources }),
    ...(recordedModelConfig === undefined ? {} : { recordedModelConfig }),
    ...(repositorySnapshot ? { repository: repositorySnapshot.report, gitFiles: repositorySnapshot.gitFiles } : {}),
    callback: withCallback ? { trace: {}, expectedTraceHash: 'fixture', association: { conversationId: 'c1', turnId: 't1' } } : null,
    ...(fileEvidencePaths === undefined ? {} : { fileEvidencePaths }) };
  fs.writeFileSync(path.join(root, 'evaluation-profile.json'), JSON.stringify(profile));
  if (nativeMaxRequests !== undefined) fs.writeFileSync(path.join(root, 'evaluation-limits.json'), JSON.stringify({ maxRequests: nativeMaxRequests }));
  if (directoryWorkspace) {
    const staged = require('../../scripts/badcase-capture/direct-docker.cjs').prepareDirectReplayInput(input);
    for (const f of staged) { const dest = path.join(root, f.path); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, f.bytes); }
  } else fs.writeFileSync(path.join(root, 'replay-input.json'), JSON.stringify(input));
  fs.mkdirSync(path.join(root, 'tmp'));
  const mapped = p => { assert.ok(p.startsWith('/work/') || p.startsWith('/tmp/')); return path.join(root, p.slice(1).replace(/^work\//, '')); };
  const modeRestorations = [];
  const workerFs = Object.fromEntries(['mkdirSync', 'readFileSync', 'writeFileSync', 'readdirSync', 'lstatSync', 'chmodSync']
    .map(name => [name, (p, ...args) => fs[name](mapped(p), ...args)]));
  workerFs.chmodSync = (p, mode) => { modeRestorations.push({ path: p, mode }); fs.chmodSync(mapped(p), mode); };
  workerFs.existsSync = p => p === '/.dockerenv' || fs.existsSync(mapped(p));
  workerFs.renameSync = (a, b) => fs.renameSync(mapped(a), mapped(b));
  const observer = { calls: [], complete() {}, fetch: async () => { throw Error('unexpected_network'); } };
  let subscriber, disposed = false, stopped = false, startConfig, callbackLifetimeMs, invocationPrompt, observerOptions, mailboxOptions;
  const selected = require('../../scripts/badcase-capture/direct-model.cjs').modelProfile(profile);
  const session = { messages: [], model: { provider: selected.provider, id: selected.model, api: selected.api || 'openai-completions' }, thinkingLevel: selected.thinking || 'off',
    agent: { transport: 'websocket', state: { tools: Array.from({ length: 10 }, (_, i) => ({ name: 'tool-' + i })) } },
    bindExtensions: async () => {}, subscribe: f => { subscriber = f; }, prompt: async submitted => {
      invocationPrompt = submitted;
      const message = { role: 'assistant', content: [{ type: 'text', text: 'INTERNAL ONLY: stable file; deleted.txt 不存在' }], stopReason: 'stop' };
      afterTurn(path.join(root, 'restored'));
      for (const event of events) subscriber(event);
      session.messages.push(message); observer.calls.push({ model: profile, durationMs: 1, success: true });
      subscriber({ type: 'message_end', message });
    } };
  const runtime = { session, services: { settingsManager: { applyOverrides: () => {} }, resourceLoader: { getExtensions: () => ({ errors: [] }),
    getAgentsFiles: () => ({ agentsFiles: projectResources?.contextFile ? [{ path: '/work/restored/' + projectResources.contextFile, content: fileBytes[projectResources.contextFile].replace(/^\uFEFF/, '') }] : [] }),
    getSkills: () => ({ skills: files.filter(p => p.endsWith('/SKILL.md')).map(p => ({ filePath: '/work/restored/' + p })) }), ...resourceLoaderPatch } }, dispose: async () => { disposed = true; } };
  const workerRequire = name => {
    if (name === './replay-path.cjs') return require('../../scripts/badcase-capture/replay-path.cjs');
    if (name === 'node:fs') return workerFs;
    if (name === 'node:child_process') return { execFileSync: (program, args, options) => {
      assert.equal(program, 'git'); assert.equal(options.env.CAFF_BADCASE_MODEL_KEY, undefined);
      return require('node:child_process').execFileSync(program, args.map(a => a === '/work/restored' ? mapped(a) : a),
        { ...options, env: { ...require('../../scripts/badcase-capture/replay-git.cjs').gitEnvironment(), ...options.env, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
    } };
    if (name === '/work/direct-model.cjs') return { ...require('../../scripts/badcase-capture/direct-model.cjs'), observeDirectFetch: (_fetch, options) => { observerOptions = options; return observer; } };
    if (name === '/work/codex-mailbox.cjs') return { ...require('../../scripts/badcase-capture/codex-mailbox.cjs'),
      createCodexMailboxFetch: options => { mailboxOptions = options; return observer.fetch; } };
    if (name === '/work/build/server/domain/runtime/badcase-capture/secrets') return require('../../build/server/domain/runtime/badcase-capture/secrets');
    if (name === '/work/build/server/domain/runtime/badcase-capture/session-validator') return require('../../build/server/domain/runtime/badcase-capture/session-validator');
    if (name === '/work/build/server/domain/runtime/badcase-capture/project-resources') return require('../../build/server/domain/runtime/badcase-capture/project-resources');
    if (name === '/work/caff-runtime-bootstrap.cjs') return { verifyCaffRuntimeStage: () => ({ manifest: { inputHash: 'input', runtimeHash: 'runtime' } }),
      hashFile: p => require('../../scripts/badcase-capture/replay-streams.cjs').hashFile(mapped(p)) };
    if (name === '/work/build/server/domain/runtime/badcase-capture/evaluation-callback') return { startEvaluationCallback: async config => {
      callbackLifetimeMs = config.lifetimeMs;
      return { apiUrl: 'http://127.0.0.1:1', credentials: { invocationId: 'fixture', callbackToken: 'fixture-only' },
        readPublicReply: () => published, ...(goalEvidence ? { readGoalEvidence: () => structuredClone(goalEvidence) } : {}), stop: async () => { stopped = true; } }; } };
    assert.ok(name.startsWith('node:'), name); return require(name);
  };
  const workerModule = { exports: {} }, filename = require.resolve('../../scripts/badcase-capture/direct-sdk-container.cjs');
  vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports', 'process'], { filename })(
    workerRequire, workerModule, workerModule.exports, { platform: 'linux', getuid: () => 65534, cwd: () => '/work', env: profile === 'openai-codex/gpt-6.1-sol' ? {} : { CAFF_BADCASE_MODEL_KEY: key } });
  const receipt = await workerModule.exports.main({ loadModule: async name => {
    if (name === '/work/runtime/dist/bundle/index.js') return { VERSION: '0.85.1', buildSessionContext: entries => ({ messages: entries.filter(e => e.type === 'message').map(e => e.message) }) };
    assert.equal(name, '/work/build/lib/pi-sdk-host.mjs');
    return { normalizeStartCommand: c => c, createSdkRuntime: async (_sdk, config) => { startConfig = config;
      if (config.resume) session.messages = JSON.parse('[' + fs.readFileSync(mapped(config.sessionPath), 'utf8').trim().split('\n').slice(1).join(',') + ']').filter(e => e.type === 'message').map(e => e.message);
      return { runtime }; } };
  } });
  assert.equal(disposed, true); assert.equal(stopped, withCallback);
  return { receipt, input, startConfig, callbackLifetimeMs, invocationPrompt, modeRestorations, observerOptions, mailboxOptions,
    workingSessionText: fs.existsSync(path.join(root, 'session.jsonl')) ? fs.readFileSync(path.join(root, 'session.jsonl'), 'utf8') : null, settings: fs.existsSync(path.join(root, 'agent/settings.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'agent/settings.json'))) : null };
}
test('actual worker preserves original native goal_action args including locally rejected calls without clipping', async t => {
  const original = { action: 'pause', reason: '  ' + '😀'.repeat(5000) + '  ' };
  const events = [
    { type: 'tool_execution_start', toolCallId: 'long', toolName: 'goal_action', args: original },
    { type: 'tool_execution_end', toolCallId: 'long', toolName: 'goal_action', isError: true },
    { type: 'tool_execution_start', toolCallId: 'retry', toolName: 'goal_action', args: { action: 'pause', reason: 'short retry' } },
    { type: 'tool_execution_end', toolCallId: 'retry', toolName: 'goal_action', isError: false },
  ];
  const { receipt } = await workerReceipt(t, { events });
  assert.deepEqual(receipt.toolCalls, [
    { name: 'goal_action', isError: true, args: original },
    { name: 'goal_action', isError: false, args: { action: 'pause', reason: 'short retry' } },
  ]);
  const check = { method: 'code', target: { kind: 'native', name: 'goal_action' }, mode: 'on-call', rules: [{ parameter: 'reason', kind: 'max-chars', max: 1000 }] };
  const { checkWikiTraceTools } = require('../../build/server/domain/runtime/badcase-capture/wiki-trace-tool-checks');
  assert.deepEqual(checkWikiTraceTools(receipt, check), { status: 'fail', reason: 'tool_rule_failed' });
  assert.deepEqual(checkWikiTraceTools({ toolCalls: [receipt.toolCalls[1]] }, check), { status: 'pass', reason: null });
});

test('actual worker passes only captured SDK origins and rejects missing/extra/renamed discoveries for both transports', async t => {
  const { prepareCapturedProjectResources, projectResourcesSummary } = require('../../build/server/domain/runtime/badcase-capture/project-resources');
  const sdkSkills = [], promptSkills = [], projectSkills = [];
  for (const name of ['sdk', 'prompt', 'both']) {
    const originalPath = '/project/.agents/skills/' + name, skill = { name, filePath: originalPath + '/SKILL.md' };
    if (name !== 'prompt') sdkSkills.push(skill); if (name !== 'sdk') promptSkills.push(skill);
    const content = Buffer.from(name);
    projectSkills.push({ originalPath, rootKind: 'directory', internal: false, relativePath: 'posix/project/.agents/skills/' + name,
      files: { 'SKILL.md': { content, hash: crypto.createHash('sha256').update(content).digest('hex'), mode: 0o100644 } } });
  }
  const prepared = prepareCapturedProjectResources({ schemaVersion: 1, kind: 'portable-captured-project-resources-v1', supported: true, filePaths: [], skillPaths: [] },
    [], { additionalSkillPaths: [] }, { targetDir: '/room', gitSnapshot: { skillInventoryStatus: 'loaded', sdkLoadedSkills: sdkSkills, promptLoadedSkills: promptSkills } }, { projectSkills });
  const manifest = prepared.manifest, files = prepared.files.map(f => f.path), fileBytes = Object.fromEntries(prepared.files.map(f => [f.path, Buffer.from(f.base64, 'base64').toString()]));
  const nativeSkills = manifest.skills.filter(s => s.origins.includes('sdk')).map(s => ({ name: s.sdkName, filePath: '/work/restored/' + s.path }));
  for (const directoryWorkspace of [false, true]) {
    const options = { files, fileBytes, projectResources: manifest, directoryWorkspace, resourceLoaderPatch: { getSkills: () => ({ skills: nativeSkills }) } };
    const r = await workerReceipt(t, options);
    assert.deepEqual(r.startConfig.additionalSkillPaths, manifest.skillPaths.map(p => '/work/restored/' + p));
    assert.deepEqual(JSON.parse(JSON.stringify(r.receipt.projectResources)), { ...projectResourcesSummary(manifest), verified: true, loadedContextFiles: 0, loadedSkills: 2 });
    for (const skills of [nativeSkills.slice(1), [...nativeSkills, { name: 'prompt', filePath: '/work/restored/' + manifest.skills.find(s => s.name === 'prompt').path }],
      nativeSkills.map(s => ({ ...s, name: s.name + '-changed' }))]) {
      await assert.rejects(workerReceipt(t, { ...options, resourceLoaderPatch: { getSkills: () => ({ skills }) } }), /replay_project_resources_invalid/);
    }
  }
});

test('actual worker restores captured modes after transport for inline and directory workspaces', async t => {
  for (const directoryWorkspace of [false, true]) {
    const result = await workerReceipt(t, { files: ['plain.js', 'executable.sh'], fileModes: { 'plain.js': 0o100644, 'executable.sh': 0o100755 }, directoryWorkspace });
    assert.deepEqual(result.modeRestorations.map(r => ({ name: r.path.split('/').at(-1), mode: r.mode })), [{ name: 'plain.js', mode: 0o644 }, { name: 'executable.sh', mode: 0o755 }]);
  }
});
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
test('launcher diagnostics survive a thrown attempt without becoming evidence or exposing extra strings', async () => {
  const f = fakes();
  f.options.execute = async (_image, _files, options) => {
    options.onDiagnostic({ phase: 'read', errorCode: 'relay_failed', message: key, stdout: key });
    options.onDiagnostic({ phase: key, errorCode: key });
    options.onDiagnostic({ phase: 'cleanup', errorCode: 'none', cleanup: { attempted: true, completed: true, stderr: key } });
    throw Error(key);
  };
  const result = await runComparison({ ...config(), repeats: 1 }, f.options);
  assert.deepEqual(f.state.events.filter(e => e.event === 'launcher_diagnostic'), [
    { event: 'launcher_diagnostic', variant: 'original', iteration: 1, phase: 'read', errorCode: 'relay_failed' },
    { event: 'launcher_diagnostic', variant: 'original', iteration: 1, phase: 'cleanup', errorCode: 'none', cleanup: { attempted: true, completed: true } },
  ]);
  assert.equal(result.runs[0].reason, 'run_evidence_unavailable'); assert.equal(result.runs[0].status, 'error');
  assert.equal(result.runs[0].cleaned, false); assert.equal(result.callsUnavailable, true); assert.equal(result.completed, false);
  assert.equal(JSON.stringify(f.state.events).includes(key), false);
});
test('public-reply literal rules stay on the host, score public output, and require reply evidence', async () => {
  const c = { ...config(), rules: { kind: 'public-reply-literals-v1', leadChars: 30, conclusionMarkers: ['LITERAL_MARKER'], forbiddenTerms: ['P2'], forbiddenPatterns: ['commit-hash'] } };
  const f = fakes(), execute = f.options.execute;
  f.options.execute = async (...args) => { const task = await execute(...args); const candidate = JSON.parse(args[1][0].bytes).prompt !== 'original'; task.receipt.finalText = candidate ? 'LITERAL_MARKER P2' : 'LITERAL_MARKER complete'; return task; };
  const plan = prepareComparison(c, f.options);
  assert.equal(plan.supported, true); assert.equal(JSON.stringify(plan.inputs).includes('LITERAL_MARKER'), false);
  const result = await runComparison(c, f.options);
  assert.equal(result.totals.original.passed, 2); assert.equal(result.totals.candidate.failed, 2);
  assert.ok(result.runs.every(r => !Object.hasOwn(r, 'fileEvidence')));
  assert.ok(result.runs.every(r => r.replyChecks));
  for (const replySource of ['internal', 'none']) {
    const g = fakes(), go = g.options.execute;
    g.options.execute = async (...args) => { const task = await go(...args); task.receipt.finalText = 'LITERAL_MARKER complete'; task.receipt.replySource = replySource; return task; };
    const observed = await runComparison(c, g.options); assert.equal(observed.totals.original.passed, 0); assert.equal(observed.runs[0].status, 'fail');
  }
  const missing = fakes(), run = missing.options.execute;
  missing.options.execute = async (...args) => { const task = await run(...args); delete task.receipt.finalText; return task; };
  const unavailable = await runComparison(c, missing.options);
  assert.equal(unavailable.completed, false); assert.equal(unavailable.runs[0].status, 'error'); assert.equal(unavailable.runs[0].reason, 'reply_evidence_unavailable');
  assert.equal(missing.state.executions, 1);
});
test('known-value guard streams a combined input larger than the V8 string ceiling before execution', async () => {
  const { constants } = require('node:buffer'), f = fakes(), prepare = f.options.prepare;
  const chunk = 'x'.repeat(1024 * 1024), padding = Array(Math.ceil(constants.MAX_STRING_LENGTH / chunk.length / 2) + 1).fill(chunk);
  const original = prepare({}, null).input, candidate = prepare({}, 'candidate').input;
  original.padding = padding; candidate.padding = padding;
  assert.throws(() => JSON.stringify({ original, candidate }), RangeError);
  f.options.prepare = (_request, replacement) => ({ ...prepare({}, replacement), input: replacement ? candidate : original });
  // Do not serialize large synthetic data into a fake probe. Exercise the real
  // preflight hashes + known-value guard, then stop at an inert executor.
  f.options.stage = () => [{ path: 'probe.cjs', bytes: Buffer.from('inert') }];
  let executions = 0;
  f.options.execute = async () => { executions++; throw Error('inert_executor_stop'); };
  const result = await runComparison({ ...config(), repeats: 1 }, f.options);
  assert.equal(executions, 1); assert.equal(result.runs[0].reason, 'run_evidence_unavailable');
});
test('v2 capture omissions persist through plan, JSON result and human-readable result without being called complete', async () => {
  const f = fakes(), original = f.options.prepare;
  const disclosures = { roomRecord: { available: false, reason: 'callback_input_unavailable', replayMode: 'isolated-placeholder-not-original-history' },
    uncaptured: [{ path: 'omitted 中文.txt', reason: 'index_assume_unchanged' }], portableGaps: [{ path: '.', reason: 'fast_mode_not_replayed' }],
    incompleteReasons: ['callback_input_unavailable', 'files_uncaptured'] };
  f.options.prepare = (...args) => { const p = original(...args); p.provenance.captureDisclosures = disclosures; return p; };
  assert.deepEqual(prepareComparison(config(), f.options).summary.captureDisclosures, disclosures);
  const result = await runComparison(config(), f.options); assert.deepEqual(result.captureDisclosures, disclosures);
  const text = formatComparison(result); assert.match(text, /房间记录不可用/); assert.match(text, /omitted 中文.txt/); assert.match(text, /index_assume_unchanged/); assert.match(text, /fast_mode_not_replayed/);
});

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
  for (const timeoutMs of [999, Infinity]) assert.throws(() => prepareComparison({ ...c, timeoutMs }, f.options), /evaluation_config_invalid/);
  assert.throws(() => prepareComparison({ ...c, timeoutMs: 2700001 }, f.options), { code: 'evaluation_timeout_limit' });
});
test('worker accepts the full 256 KiB prompt and keeps public callback valid for the 45-minute ceiling', async t => {
  const prompt = '中'.repeat(87381) + 'a', r = await workerReceipt(t, { prompt });
  assert.equal(Buffer.byteLength(prompt), 262144); assert.equal(r.invocationPrompt, prompt);
  assert.equal(r.input.prompt, prompt); assert.equal(r.callbackLifetimeMs, 2700000); assert.equal(r.receipt.success, true);
  await assert.rejects(workerReceipt(t, { prompt: prompt + 'a' }), /AssertionError/);
});
test('actual native worker reads stage-bound limits for both mailbox and request observer without changing archived input', async t => {
  for (const nativeMaxRequests of [undefined, 64]) {
    const r = await workerReceipt(t, { profile: 'openai-codex/gpt-6.1-sol', nativeMaxRequests });
    assert.equal(r.mailboxOptions.maxRequests, nativeMaxRequests ?? 32);
    assert.equal(r.observerOptions.maxRequests, nativeMaxRequests ?? 32);
    assert.equal(r.input.nativeMaxRequests, undefined);
  }
  for (const nativeMaxRequests of [0, 65, null, '64']) {
    await assert.rejects(workerReceipt(t, { profile: 'openai-codex/gpt-6.1-sol', nativeMaxRequests }), /evaluation_codex_mailbox_limits_invalid/);
  }
});
test('Codex worker uses credential-free mailbox, xhigh native model, SSE and no automatic retry', async t => {
  const { receipt, startConfig, settings } = await workerReceipt(t, { profile: 'openai-codex/gpt-6.1-sol' });
  assert.equal(startConfig.provider, 'openai-codex'); assert.equal(startConfig.model, 'gpt-6.1-sol'); assert.equal(startConfig.thinking, 'xhigh');
  assert.equal(settings.transport, 'sse'); assert.equal(settings.retry.enabled, false); assert.equal(settings.retry.provider.maxRetries, 0);
  assert.deepEqual(receipt.modelConfig, { api: 'openai-codex-responses', thinking: 'xhigh', fast: false, transport: 'sse', credentialDelivery: 'host-only-mailbox' });
  assert.equal(receipt.success, true); assert.equal(receipt.modelCalls[0].model, 'openai-codex/gpt-6.1-sol');
});
test('worker restores project context and skills with native discovery, binds the inventory receipt, and refuses unexpected loader content', async t => {
  const { prepareProjectResources, projectResourcesSummary } = require('../../build/server/domain/runtime/badcase-capture/project-resources');
  const fileBytes = { 'AGENTS.md': '\uFEFFArchived project context\n', '.agents/skills/demo/SKILL.md': '---\nname: demo\ndescription: Archived skill\n---\nBody', '.agents/skills/demo/references/guide.md': 'Archived reference' };
  const files = Object.keys(fileBytes).sort(), records = files.map(p => ({ path: p, sha256: crypto.createHash('sha256').update(fileBytes[p]).digest('hex') }));
  const projectResources = prepareProjectResources({ schemaVersion: 1, kind: 'portable-project-resources-v1', supported: true,
    filePaths: files, skillPaths: ['.agents/skills/demo'] }, records, { cwd: 'C:\\old\\project', additionalSkillPaths: ['C:\\old\\project\\.agents\\skills\\demo'] });
  for (const directoryWorkspace of [false, true]) {
    const r = await workerReceipt(t, { files, fileBytes, projectResources, directoryWorkspace });
    assert.deepEqual(Array.from(r.startConfig.additionalSkillPaths), ['/work/restored/.agents/skills/demo']);
    assert.deepEqual(JSON.parse(JSON.stringify(r.receipt.projectResources)), { ...projectResourcesSummary(projectResources), verified: true, loadedContextFiles: 1, loadedSkills: 1 });
  }
  for (const resourceLoaderPatch of [{ getAgentsFiles: () => ({ agentsFiles: [] }) }, { getAgentsFiles: () => ({ agentsFiles: [{ path: '/work/restored/AGENTS.md', content: 'Current file, not archive' }] }) },
    { getSkills: () => ({ skills: [{ filePath: '/outside/current/SKILL.md' }] }) }]) {
    await assert.rejects(workerReceipt(t, { files, fileBytes, projectResources, resourceLoaderPatch }), /replay_project_resources_invalid/);
  }
});
test('host cannot score missing or altered project-resource evidence', async () => {
  for (const mode of ['matching', 'missing', 'changed']) {
    const f = fakes(), prepare = f.options.prepare, execute = f.options.execute;
    const manifest = { kind: 'replay-project-resources-v1', manifestHash: '1'.repeat(64), files: [], contextFile: null, skillPaths: [] };
    f.options.prepare = (...args) => { const p = prepare(...args); p.input.projectResources = manifest; return p; };
    f.options.execute = async (...args) => { const task = await execute(...args);
      if (mode !== 'missing') task.receipt.projectResources = { kind: manifest.kind, manifestHash: mode === 'changed' ? '2'.repeat(64) : manifest.manifestHash,
        fileCount: 0, contextFile: null, skillPaths: [], verified: true, loadedContextFiles: 0, loadedSkills: 0 }; return task; };
    const result = await runComparison(config(), f.options);
    assert.equal(result.completed, mode === 'matching'); assert.equal(result.runs[0].status, mode === 'matching' ? 'pass' : 'error');
    if (mode !== 'matching') assert.equal(f.state.executions, 1);
  }
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
test('actual worker starts resume from the bound exact prefix and reports its archived identity', async t => {
  const sourceRoot = 'C:\\old\\root', prompt = 'Now {{CAFF_CHAT_API_URL}}';
  const sessionText = [{ type: 'session', version: 3, id: 'same-id', cwd: sourceRoot },
    { type: 'message', id: 'm1', parentId: null, message: { role: 'user', content: 'Earlier {{PI_AGENT_PRIVATE_DIR}}', timestamp: 1 } }].map(JSON.stringify).join('\r\n') + '\r\n';
  const r = await workerReceipt(t, { prompt, sessionText, bindings: { sourceRoot, controlledReplacements: [{ name: 'CAFF_CHAT_API_URL', count: 1 }, { name: 'PI_AGENT_PRIVATE_DIR', count: 1 }] } });
  assert.equal(r.startConfig.resume, true); assert.equal(r.receipt.historyMessages, 1);
  assert.deepEqual(r.receipt.replaySession, require('../../scripts/badcase-capture/direct-model.cjs').replaySessionInfo(sessionText));
  assert.equal(r.workingSessionText, sessionText.replace(JSON.stringify(sourceRoot), JSON.stringify('/work/restored')).replace('{{PI_AGENT_PRIVATE_DIR}}', '/tmp/private'));
  assert.equal(r.invocationPrompt, 'Now http://127.0.0.1:1'); assert.equal(r.input.sessionText, sessionText);
});
test('actual worker loads frozen bash and retired tools as context, never current tool executions', async t => {
  const sourceRoot = '/old/root', entries = [
    { type: 'session', version: 3, id: 'same-id', cwd: sourceRoot },
    { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'Earlier request', timestamp: 1 } },
    { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', api: 'a', provider: 'p', model: 'm', usage: {}, stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'bash-1', name: 'bash', arguments: { command: 'node -e "throw Error(\'historical-only\')" ' + sourceRoot } },
      { type: 'toolCall', id: 'plugin-1', name: 'retired_plugin', arguments: { path: '/outside/workspace' } },
    ] } },
    ...['bash', 'retired_plugin'].map((name, i) => ({ type: 'message', id: 'r' + i, parentId: i ? 'r0' : 'a', message: { role: 'toolResult', toolCallId: i ? 'plugin-1' : 'bash-1', toolName: name, isError: false, content: [{ type: 'text', text: sourceRoot + '/original-result' }] } })),
  ];
  const sessionText = entries.map(JSON.stringify).join('\n') + '\n';
  const result = await workerReceipt(t, { sessionText, bindings: { sourceRoot, controlledReplacements: [] } });
  assert.equal(result.startConfig.resume, true); assert.equal(result.receipt.historyMessages, 4);
  assert.deepEqual(result.receipt.toolCalls, []);
  assert.equal(result.workingSessionText, sessionText.replace(JSON.stringify(sourceRoot), JSON.stringify('/work/restored')));
  assert.equal(result.invocationPrompt, 'Inspect the files.');
});

test('missing or conflicting resume receipt never scores and stops subsequent slots', async () => {
  for (const mode of ['matching', 'missing', 'changed']) {
    const f = fakes(), prepare = f.options.prepare, execute = f.options.execute;
    const sessionText = '{"type":"session","version":3,"id":"old","cwd":"/work/restored"}\n';
    const replaySession = require('../../scripts/badcase-capture/direct-model.cjs').replaySessionInfo(sessionText);
    f.options.prepare = (...args) => { const p = prepare(...args); p.input.sessionText = sessionText; return p; };
    f.options.execute = async (...args) => { const task = await execute(...args);
      if (mode !== 'missing') task.receipt.replaySession = { ...replaySession, ...(mode === 'changed' ? { deliveryMode: 'fresh' } : {}) }; return task; };
    const result = await runComparison(config(), f.options);
    assert.equal(result.completed, mode === 'matching'); assert.equal(result.runs[0].status, mode === 'matching' ? 'pass' : 'error');
    assert.deepEqual(result.replaySession, replaySession);
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

test('Goal evidence is exported by the actual trace worker without changing prompt/session/prepared-input bytes or hashes', async t => {
  const sourceRoot = 'C:/synthetic/room', prompt = 'Now {{CAFF_CHAT_API_URL}}';
  const sessionText = [{ type: 'session', version: 3, id: 'goal-prefix', cwd: sourceRoot },
    { type: 'message', id: 'm1', parentId: null, message: { role: 'user', content: [{ type: 'text', text: '{{PI_AGENT_PRIVATE_DIR}}' }], timestamp: 1 } }].map(JSON.stringify).join('\n') + '\n';
  const options = { prompt, sessionText, bindings: { sourceRoot, controlledReplacements: [{ name: 'CAFF_CHAT_API_URL', count: 1 }, { name: 'PI_AGENT_PRIVATE_DIR', count: 1 }] } };
  const evidence = { kind: 'evaluation-goal-evidence-v1', executionId: 'synthetic-worker-execution', goalState: 'approximate-minimal-v1', seedHash: 'a'.repeat(64), seed: { status: 'active' }, calls: [] };
  const a = await workerReceipt(t, options), b = await workerReceipt(t, { ...options, goalEvidence: evidence });
  for (const key of ['input', 'invocationPrompt', 'workingSessionText']) {
    assert.deepEqual(a[key], b[key]); assert.equal(crypto.createHash('sha256').update(JSON.stringify(a[key])).digest('hex'), crypto.createHash('sha256').update(JSON.stringify(b[key])).digest('hex'));
  }
  assert.deepEqual(a.receipt.replaySession, b.receipt.replaySession); assert.equal(a.receipt.historyHash, b.receipt.historyHash);
  assert.equal(a.receipt.inputHash, b.receipt.inputHash); assert.deepEqual(b.receipt.goalEvidence, evidence); assert.equal(Object.hasOwn(a.receipt, 'goalEvidence'), false);
});
