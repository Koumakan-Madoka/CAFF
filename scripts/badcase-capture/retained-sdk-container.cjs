// CONTAINER ONLY. Diagnostic initialization, never session.prompt or captured code.
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { isSafeDistributionPath } = require('./replay-path.cjs');
const { verifyMaterialBytes, verifyNoProbeSideEffects } = require('./pi-probe-guards.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
(async () => {
  if (process.platform !== 'linux' || process.getuid?.() !== 65534 || process.cwd() !== '/work'
    || !fs.existsSync('/.dockerenv')) throw Error('container_required');
  const manifest = JSON.parse(fs.readFileSync('/work/manifest.json'));
  assert.equal(manifest.schemaVersion, 1); assert.ok(Array.isArray(manifest.files) && manifest.files.length <= 4096);
  let total = 0;
  for (const f of manifest.files) {
    assert.ok(isSafeDistributionPath(f.path));
    const st = fs.lstatSync('/work/' + f.path); assert.ok(st.isFile() && !st.isSymbolicLink());
    total += st.size; assert.ok(total <= 16 * 1024 * 1024);
    verifyMaterialBytes(fs.readFileSync('/work/' + f.path), f);
  }
  assert.equal(hash(JSON.stringify(manifest.files)), manifest.inputHash);
  assert.equal(hash(JSON.stringify(manifest.files.filter(f => f.path.startsWith('runtime/')))), manifest.runtimeHash);
  const environment = JSON.parse(fs.readFileSync('/work/environment.json'));
  assert.equal(process.version, environment.nodeVersion);
  assert.equal(require('node:child_process').execFileSync('/usr/bin/python3', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(), environment.pythonVersion);
  assert.equal(process.arch, environment.architecture === 'amd64' ? 'x64' : 'arm64');
  assert.equal(Object.keys(process.env).some(k => /^(CAFF_|PI_|OPENAI_|ANTHROPIC_|AWS_|NODE_OPTIONS$)/.test(k)), false);
  const { planRetainedSdkDiagnostic, observedDiagnosticReceipt } = require('./retained-sdk-diagnostic.js');
  const { materializeInitializationCapsule, decodeInitializationCapsule } = require('./capsule-materialization.js');
  const capsule = fs.readFileSync('/work/capsule.json', 'utf8'), expected = JSON.parse(fs.readFileSync('/work/expected.json'));
  const plan = planRetainedSdkDiagnostic(capsule, expected); // before restoration or SDK import
  const materialized = materializeInitializationCapsule(capsule, expected, '/work/restored');
  assert.deepEqual(materialized, plan.materialized);
  process.env.PI_OFFLINE = '1'; process.env.PI_CODING_AGENT_DIR = '/work/agent';
  let modelCalls = 0, networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw Error('network_forbidden'); };
  const sdk = await import('./runtime/dist/bundle/index.js');
  assert.equal(sdk.VERSION, '0.85.1');
  for (const p of ['runtime/package.json', 'runtime/bundled-pi-ai/package.json']) assert.equal(JSON.parse(fs.readFileSync('/work/' + p)).version, '0.85.1');
  const cwd = '/work/restored/snapshot', sessionPath = '/work/resume-input.jsonl';
  if (plan.mode === 'resume') {
    fs.writeFileSync(sessionPath, plan.sessionText, { flag: 'wx', mode: 0o600 });
    assert.equal(fs.readFileSync(sessionPath, 'utf8'), plan.sessionText); // missing never reaches open
  } else assert.equal(fs.existsSync(sessionPath), false);
  const manager = plan.mode === 'resume' ? sdk.SessionManager.open(sessionPath, '/work/sessions', cwd) : sdk.SessionManager.create(cwd, '/work/sessions');
  // Separate behavior experiment, not a fallback for the real input above.
  const absent = '/work/absent-session.jsonl'; assert.equal(fs.existsSync(absent), false);
  const missing = sdk.SessionManager.open(absent, '/work/missing-sessions', cwd);
  const missingObservation = { missingSessionId: missing.getSessionId(), missingEntries: missing.getEntries(),
    missingMessages: missing.buildSessionContext().messages };
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: '/work/agent/auth.json', modelsPath: '/work/agent/models.json', modelsStorePath: '/work/agent/models-store.json', allowModelNetwork: false });
  modelRuntime.streamSimple = () => { modelCalls++; throw Error('model_forbidden'); };
  const model = modelRuntime.getModel(plan.provider, plan.model); assert.ok(model, 'model_unavailable');
  const diagnosticPrompt = 'Retained input initialization diagnostic only. Never submit an invocation.';
  const resourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => diagnosticPrompt, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
  };
  const { session, modelFallbackMessage } = await sdk.createAgentSession({ cwd, agentDir: '/work/agent', model, modelRuntime,
    thinkingLevel: 'off', tools: ['read', 'write', 'edit', 'bash'], resourceLoader, sessionManager: manager,
    settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) });
  try {
    assert.equal(modelFallbackMessage, undefined); assert.equal(manager.getCwd(), cwd);
    assert.equal(session.model.provider, plan.provider); assert.equal(session.model.id, plan.model);
    assert.deepEqual(session.messages, plan.messages);
    assert.ok(session.agent.state.systemPrompt.includes(diagnosticPrompt));
    verifyNoProbeSideEffects(session.agent.state.systemPrompt, modelCalls, networkCalls);
    assert.deepEqual(session.agent.state.tools.map(t => t.name).sort(), ['bash', 'edit', 'read', 'write']);
    if (plan.mode === 'resume') assert.equal(manager.getSessionId(), plan.sessionId);
    // SDK initialization must not rewrite restored source bytes (including traps).
    for (const f of decodeInitializationCapsule(capsule, expected).files) assert.deepEqual(fs.readFileSync('/work/restored/' + f.path), f.bytes);
    // Read the restored archive and the SDK working copy separately. Never use
    // plan.sessionText as an observation, and never generate an expected receipt here.
    const observations = { ...missingObservation,
      archivedSessionBytes: plan.mode === 'resume' ? fs.readFileSync('/work/restored/materials/blobs/' + hash(plan.sessionText)) : null,
      workingSessionBytes: plan.mode === 'resume' ? fs.readFileSync(sessionPath) : null };
    const receipt = observedDiagnosticReceipt(plan, observations);
    console.log(JSON.stringify({ ...receipt, inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash }));
  } finally { session.dispose(); }
})().catch(() => { process.stderr.write('retained_sdk_diagnostic_failed\n'); process.exitCode = 1; });
