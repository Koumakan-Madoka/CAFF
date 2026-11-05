// CONTAINER ONLY: real SDK prompt/tool loop with a fixed SCRIPTED model, no LLM.
// Not faithful replay. The captured provider is deliberately replaced and reported
// by the host as caff-offline-scripted/tool-loop-v1. No scoring rules are here.
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { isSafeDistributionPath } = require('./replay-path.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
(async () => {
  if (process.platform !== 'linux' || process.getuid?.() !== 65534 || process.cwd() !== '/work'
    || !fs.existsSync('/.dockerenv')) throw Error('container_required');
  const { verifyMaterialBytes } = require('./pi-probe-guards.cjs');
  const manifest = JSON.parse(fs.readFileSync('/work/manifest.json'));
  assert.equal(manifest.schemaVersion, 1); assert.ok(Array.isArray(manifest.files) && manifest.files.length <= 4096);
  let total = 0; const names = new Set();
  for (const f of manifest.files) {
    assert.ok(isSafeDistributionPath(f.path) && !names.has(f.path));
    names.add(f.path);
    const st = fs.lstatSync('/work/' + f.path); assert.ok(st.isFile() && !st.isSymbolicLink());
    total += st.size; assert.ok(total <= 16 * 1024 * 1024);
    verifyMaterialBytes(fs.readFileSync('/work/' + f.path), f);
  }
  for (const name of ['probe.cjs', 'task.json', 'capsule.json', 'expected.json', 'environment.json']) assert.ok(names.has(name));
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
  assert.ok(typeof q.role === 'string' && q.role.trim() && !q.role.includes('\0') && Buffer.byteLength(q.role) <= 16384
    && Buffer.from(q.role).toString('utf8') === q.role && !require('./secrets.js').containsSecretSentinel(q.role));
  const start = performance.now();
  function gate() { assert.ok(Number.isSafeInteger(q.expiresAt) && Date.now() < q.expiresAt && performance.now() - start < 25000, 'task_expired'); }
  gate();
  const { planRetainedSdkDiagnostic } = require('./retained-sdk-diagnostic.js');
  const { materializeInitializationCapsule, decodeInitializationCapsule } = require('./capsule-materialization.js');
  const capsule = fs.readFileSync('/work/capsule.json', 'utf8'), expected = JSON.parse(fs.readFileSync('/work/expected.json'));
  const plan = planRetainedSdkDiagnostic(capsule, expected);
  assert.equal(q.capsuleHash, plan.materialized.capsuleHash); assert.equal(q.deliveryMode, plan.mode);
  assert.equal(q.invocationHash, hash(plan.invocation)); assert.equal(q.historyHash, hash(JSON.stringify(plan.messages)));
  assert.deepEqual(materializeInitializationCapsule(capsule, expected, '/work/restored'), plan.materialized);
  const cwd = '/work/restored/snapshot', artifact = cwd + '/evaluation-result.txt';
  assert.equal(fs.existsSync(artifact), false); // never overwrite an input path
  process.env.PI_OFFLINE = '1'; process.env.PI_CODING_AGENT_DIR = '/work/agent';
  let networkCalls = 0, scriptCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw Error('network_forbidden'); };
  const sdk = await import('./runtime/dist/bundle/index.js');
  assert.equal(sdk.VERSION, '0.85.1');
  for (const p of ['runtime/package.json', 'runtime/bundled-pi-ai/package.json']) assert.equal(JSON.parse(fs.readFileSync('/work/' + p)).version, '0.85.1');
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: '/work/agent/auth.json', modelsPath: '/work/agent/models.json', modelsStorePath: '/work/agent/models-store.json', allowModelNetwork: false });
  const provider = 'caff-offline-scripted', modelId = 'tool-loop-v1';
  // Public inert marker only, not a credential. Network is disabled by Docker and
  // by the runtime. The adapter is not selectable as a paid model fallback.
  modelRuntime.registerProvider(provider, { baseUrl: 'http://offline.invalid', api: 'openai-completions', apiKey: 'offline-inert-marker',
    models: [{ id: modelId, name: modelId, reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const model = modelRuntime.getModel(provider, modelId); assert.ok(model);
  const steps = [
    { name: 'write', arguments: { path: 'evaluation-result.txt', content: 'draft\n' } },
    { name: 'read', arguments: { path: 'evaluation-result.txt' } },
    { name: 'edit', arguments: { path: 'evaluation-result.txt', oldText: 'draft', newText: 'done' } },
    { name: 'bash', arguments: { command: 'cat evaluation-result.txt', timeout: 5 } },
  ];
  // SDK calls this through its normal agent loop. Tools are never invoked directly.
  modelRuntime.streamSimple = (selected, context, options) => {
    gate(); assert.ok(!options?.signal?.aborted); assert.equal(selected.provider, provider); assert.equal(selected.id, modelId);
    assert.ok(context.systemPrompt.includes(q.role));
    assert.equal(context.messages.filter(m => m.role === 'user').at(-1).content[0].text, plan.invocation);
    const results = context.messages.filter(m => m.role === 'toolResult');
    assert.equal(results.length, scriptCalls); assert.ok(results.every(r => !r.isError));
    assert.ok(scriptCalls < 5); const step = steps[scriptCalls++];
    const content = step ? [{ type: 'toolCall', id: 'call-' + scriptCalls, ...step }] : [{ type: 'text', text: 'Scripted task complete.' }];
    const output = { role: 'assistant', content, api: selected.api, provider, model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: step ? 'toolUse' : 'stop', timestamp: Date.now() };
    return { async *[Symbol.asyncIterator]() {
      yield { type: 'start', partial: output };
      if (step) yield { type: 'toolcall_end', contentIndex: 0, toolCall: content[0], partial: output };
      else yield { type: 'text_end', contentIndex: 0, content: content[0].text, partial: output };
      yield { type: 'done', reason: output.stopReason, message: output };
    }, result: async () => output };
  };
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
  const { session, modelFallbackMessage } = await sdk.createAgentSession({ cwd, agentDir: '/work/agent', model, modelRuntime,
    thinkingLevel: 'off', tools: ['read', 'write', 'edit', 'bash'], resourceLoader, sessionManager: manager,
    settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) });
  try {
    assert.equal(modelFallbackMessage, undefined); assert.equal(manager.getCwd(), cwd);
    assert.deepEqual(session.messages, plan.messages);
    if (plan.mode === 'resume') assert.equal(manager.getSessionId(), plan.sessionId);
    const toolNames = []; session.subscribe(e => { if (e.type === 'tool_execution_end') { assert.equal(e.isError, false); toolNames.push(e.toolName); } });
    gate(); await session.prompt(plan.invocation, { expandPromptTemplates: false });
    gate(); assert.equal(scriptCalls, 5); assert.equal(networkCalls, 0);
    assert.equal(session.messages.at(-1).role, 'assistant'); assert.equal(session.messages.at(-1).stopReason, 'stop');
    assert.deepEqual(toolNames, ['write', 'read', 'edit', 'bash']);
    // Source archives and initial files remain intact; only the fixed new output is changed.
    for (const f of decodeInitializationCapsule(capsule, expected).files) assert.deepEqual(fs.readFileSync('/work/restored/' + f.path), f.bytes);
    const st = fs.lstatSync(artifact); assert.ok(st.isFile() && !st.isSymbolicLink() && st.size <= 4096);
    const bytes = fs.readFileSync(artifact); assert.ok(bytes.length <= 4096);
    console.log(JSON.stringify({ kind: 'scripted-sdk-task-v1', runId: q.runId, roleHash: hash(q.role), capsuleHash: q.capsuleHash,
      inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash, deliveryMode: plan.mode,
      invocationHash: hash(plan.invocation), historyHash: hash(JSON.stringify(plan.messages)), scriptCalls, networkCalls,
      toolNames, artifactBase64: bytes.toString('base64') }));
  } finally { session.dispose(); }
})().catch(() => { process.stderr.write('scripted_sdk_task_failed\n'); process.exitCode = 1; });
