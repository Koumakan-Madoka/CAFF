// CONTAINER ONLY. Actual SDK/tools with a host-mediated model, network=none.
// No model credential, endpoint, scoring rubric, prior result or host mount.
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
// Diagnostics only: never inspect an exception, SDK content or tool arguments.
// These labels are not execution/score authority and do not relax any guard.
let failurePhase = 'bootstrap', requestLimitAttempted = false;
(async () => {
  if (process.platform !== 'linux' || process.getuid?.() !== 65534 || process.cwd() !== '/work'
    || !fs.existsSync('/.dockerenv')) throw Error('container_required');
  failurePhase = 'materials';
  const { verifyMaterialBytes } = require('./pi-probe-guards.cjs');
  const manifest = JSON.parse(fs.readFileSync('/work/manifest.json'));
  assert.equal(manifest.schemaVersion, 1); assert.ok(Array.isArray(manifest.files) && manifest.files.length <= 4096);
  let total = 0; const names = new Set();
  for (const f of manifest.files) {
    assert.ok(/^[A-Za-z0-9_.@/-]+$/.test(f.path) && f.path.split('/').every(p => p && p !== '.' && p !== '..') && !names.has(f.path));
    names.add(f.path); const st = fs.lstatSync('/work/' + f.path);
    assert.ok(st.isFile() && !st.isSymbolicLink()); total += st.size; assert.ok(total <= 16 * 1024 * 1024);
    verifyMaterialBytes(fs.readFileSync('/work/' + f.path), f);
  }
  for (const name of ['probe.cjs', 'task.json', 'model-profile.json', 'container-model-adapter.cjs', 'capsule.json', 'expected.json', 'environment.json']) assert.ok(names.has(name));
  assert.equal(hash(JSON.stringify(manifest.files)), manifest.inputHash);
  assert.equal(hash(JSON.stringify(manifest.files.filter(f => f.path.startsWith('runtime/')))), manifest.runtimeHash);
  const environment = JSON.parse(fs.readFileSync('/work/environment.json'));
  assert.equal(process.version, environment.nodeVersion);
  assert.equal(require('node:child_process').execFileSync('/usr/bin/python3', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(), environment.pythonVersion);
  assert.equal(process.arch, environment.architecture === 'amd64' ? 'x64' : 'arm64');
  assert.equal(Object.keys(process.env).some(k => /^(CAFF_|PI_|OPENAI_|ANTHROPIC_|AWS_|NODE_OPTIONS$)/.test(k)), false);
  const q = JSON.parse(fs.readFileSync('/work/task.json'));
  assert.deepEqual(Object.keys(q).sort(), ['capsuleHash', 'deliveryMode', 'expiresAt', 'historyHash', 'invocationHash', 'role', 'runId']);
  assert.match(q.runId, /^[a-f0-9]{64}$/);
  assert.ok(typeof q.role === 'string' && q.role.trim() && Buffer.byteLength(q.role) <= 16384 && !require('./secrets.js').containsSecretSentinel(q.role));
  const start = performance.now();
  function gate() { assert.ok(Number.isSafeInteger(q.expiresAt) && Date.now() < q.expiresAt && performance.now() - start < 25000, 'task_expired'); }
  gate();
  failurePhase = 'input';
  const { planRetainedSdkDiagnostic } = require('./retained-sdk-diagnostic.js');
  const { materializeInitializationCapsule } = require('./capsule-materialization.js');
  const capsule = fs.readFileSync('/work/capsule.json', 'utf8'), expected = JSON.parse(fs.readFileSync('/work/expected.json'));
  const plan = planRetainedSdkDiagnostic(capsule, expected);
  assert.equal(q.capsuleHash, plan.materialized.capsuleHash); assert.equal(q.deliveryMode, plan.mode);
  assert.equal(q.invocationHash, hash(plan.invocation)); assert.equal(q.historyHash, hash(JSON.stringify(plan.messages)));
  assert.deepEqual(materializeInitializationCapsule(capsule, expected, '/work/restored'), plan.materialized);
  const cwd = '/work/restored/snapshot';
  process.env.PI_OFFLINE = '1'; process.env.PI_CODING_AGENT_DIR = '/work/agent';
  let networkCalls = 0, modelCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw Error('network_forbidden'); };
  failurePhase = 'runtime';
  const sdk = await import('./runtime/dist/bundle/index.js');
  assert.equal(sdk.VERSION, '0.85.1');
  for (const p of ['runtime/package.json', 'runtime/bundled-pi-ai/package.json']) assert.equal(JSON.parse(fs.readFileSync('/work/' + p)).version, '0.85.1');
  const profile = JSON.parse(fs.readFileSync('/work/model-profile.json'));
  const s = profile.settings;
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: '/work/agent/auth.json', modelsPath: '/work/agent/models.json', modelsStorePath: '/work/agent/models-store.json', allowModelNetwork: false });
  modelRuntime.registerProvider(s.provider, { baseUrl: 'http://offline.invalid', api: 'openai-completions', apiKey: 'offline-inert-marker',
    models: [{ id: s.model, name: s.model, reasoning: false, input: ['text'], contextWindow: s.contextWindowTokens, maxTokens: s.maxOutputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const model = modelRuntime.getModel(s.provider, s.model); assert.ok(model);
  const { createMailbox, modelStream } = require('./container-model-adapter.cjs');
  const mailbox = createMailbox(profile, gate);
  modelRuntime.streamSimple = modelStream(profile, async body => {
    modelCalls++;
    if (modelCalls > profile.maxRequests) requestLimitAttempted = true;
    return mailbox(body);
  }, gate);
  const sessionPath = '/work/resume-input.jsonl';
  if (plan.mode === 'resume') fs.writeFileSync(sessionPath, plan.sessionText, { flag: 'wx', mode: 0o600 });
  const manager = plan.mode === 'resume' ? sdk.SessionManager.open(sessionPath, '/work/sessions', cwd) : sdk.SessionManager.create(cwd, '/work/sessions');
  const resourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => q.role, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
  };
  failurePhase = 'session';
  const { session, modelFallbackMessage } = await sdk.createAgentSession({ cwd, agentDir: '/work/agent', model, modelRuntime,
    thinkingLevel: 'off', tools: ['read', 'write', 'edit', 'bash'], resourceLoader, sessionManager: manager,
    settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) });
  try {
    assert.equal(modelFallbackMessage, undefined); assert.equal(manager.getCwd(), cwd); assert.deepEqual(session.messages, plan.messages);
    if (plan.mode === 'resume') assert.equal(manager.getSessionId(), plan.sessionId);
    const toolNames = []; session.subscribe(e => { if (e.type === 'tool_execution_end') toolNames.push(e.toolName); });
    failurePhase = 'prompt';
    gate(); await session.prompt(plan.invocation, { expandPromptTemplates: false }); gate();
    failurePhase = 'final';
    assert.ok(modelCalls > 0); assert.equal(networkCalls, 0);
    assert.equal(session.messages.at(-1).role, 'assistant'); assert.equal(session.messages.at(-1).stopReason, 'stop');
    // Only this fixed bounded artifact goes to the independent host scorer.
    failurePhase = 'artifact';
    const artifact = cwd + '/evaluation-result.txt'; const st = fs.lstatSync(artifact, { bigint: true });
    assert.ok(st.isFile() && st.size <= 4096n);
    const fd = fs.openSync(artifact, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let bytes;
    try {
      const actual = fs.fstatSync(fd, { bigint: true }); assert.equal(actual.ino, st.ino); assert.equal(actual.dev, st.dev); assert.equal(actual.size, st.size);
      bytes = Buffer.alloc(4097); const n = fs.readSync(fd, bytes, 0, bytes.length, 0); assert.ok(n <= 4096); bytes = bytes.subarray(0, n);
    } finally { fs.closeSync(fd); }
    failurePhase = 'receipt';
    console.log(JSON.stringify({ kind: 'model-sdk-task-v1', runId: q.runId, roleHash: hash(q.role), capsuleHash: q.capsuleHash,
      inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash, deliveryMode: plan.mode,
      invocationHash: hash(plan.invocation), historyHash: hash(JSON.stringify(plan.messages)), modelCalls, networkCalls, toolNames,
      artifactBase64: bytes.toString('base64') }));
    failurePhase = 'dispose';
  } finally { session.dispose(); }
})().catch(() => {
  process.stderr.write('model_sdk_task_failed:' + (requestLimitAttempted ? 'request_limit' : failurePhase) + '\n');
  process.exitCode = 1;
});
