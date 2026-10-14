// Container-only SYNTHETIC SDK capability probe. Never sends a prompt.
// Not a retained-case launcher or permission to run a model.
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { verifyMaterialBytes, verifyNoProbeSideEffects } = require('./pi-probe-guards.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
(async () => {
  if (process.platform !== 'linux' || process.getuid?.() !== 65534 || process.cwd() !== '/work'
      || !fs.existsSync('/.dockerenv')) throw Error('probe_container_required');
  const manifest = JSON.parse(fs.readFileSync('/work/manifest.json'));
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length <= 4096);
  let total = 0;
  for (const f of manifest.files) {
    assert.ok(/^[A-Za-z0-9_.@/-]+$/.test(f.path) && f.path.split('/').every(p => p && p !== '.' && p !== '..'));
    const st = fs.lstatSync('/work/' + f.path);
    assert.ok(st.isFile() && !st.isSymbolicLink());
    total += st.size; assert.ok(total <= 16 * 1024 * 1024);
    const bytes = fs.readFileSync('/work/' + f.path);
    verifyMaterialBytes(bytes, f);
  }
  assert.equal(hash(JSON.stringify(manifest.files)), manifest.inputHash);
  assert.equal(hash(JSON.stringify(manifest.files.filter(f => f.path.startsWith('runtime/')))), manifest.runtimeHash);
  const environment = JSON.parse(fs.readFileSync('/work/environment.json'));
  assert.equal(process.version, environment.nodeVersion);
  assert.equal(require('node:child_process').execFileSync('/usr/bin/python3', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(), environment.pythonVersion);
  assert.equal(process.arch, environment.architecture === 'amd64' ? 'x64' : 'arm64');
  assert.equal(Object.keys(process.env).some(k => /^(CAFF_|PI_|OPENAI_|ANTHROPIC_|AWS_|NODE_OPTIONS$)/.test(k)), false);
  process.env.PI_OFFLINE = '1';
  process.env.PI_CODING_AGENT_DIR = '/work/agent';
  let networkCalls = 0, modelCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw Error('probe_network_forbidden'); };
  const sdk = await import('./runtime/dist/bundle/index.js');
  const version = JSON.parse(fs.readFileSync('/work/runtime/package.json')).version;
  assert.equal(version, '0.85.1');
  assert.equal(JSON.parse(fs.readFileSync('/work/runtime/bundled-pi-ai/package.json')).version, '0.85.1');
  assert.equal(sdk.VERSION, '0.85.1');
  const mode = fs.readFileSync('/work/mode.txt', 'utf8');
  assert.ok(['fresh', 'resume'].includes(mode));
  const cwd = '/work/snapshot';
  fs.mkdirSync(cwd, { recursive: true });
  // These must never be discovered or executed by the resource loader.
  fs.mkdirSync(cwd + '/.pi/extensions', { recursive: true });
  fs.writeFileSync(cwd + '/.pi/extensions/trap.js', 'throw Error("discovery forbidden")');
  fs.writeFileSync(cwd + '/AGENTS.md', 'Unapproved discovery trap');
  const entries = [
    { type: 'session', version: 3, id: 'synthetic-session', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/historical/not-mounted' },
    { type: 'thinking_level_change', id: 'e1', parentId: null, timestamp: '2026-01-01T00:00:00.001Z', thinkingLevel: 'off' },
    { type: 'message', id: 'e2', parentId: 'e1', timestamp: '2026-01-01T00:00:00.002Z', message: { role: 'user', content: 'synthetic history only', timestamp: 1 } },
  ];
  const sessionPath = '/work/resume.jsonl';
  // Explicit existence and exact synthetic fixture check BEFORE SessionManager.open:
  // that SDK API otherwise creates a new session when the input path is absent.
  if (mode === 'resume') assert.equal(fs.readFileSync(sessionPath, 'utf8'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  else assert.equal(fs.existsSync(sessionPath), false);
  const before = mode === 'resume' ? hash(fs.readFileSync(sessionPath)) : null;
  const manager = mode === 'resume' ? sdk.SessionManager.open(sessionPath, '/work/sessions', cwd) : sdk.SessionManager.create(cwd, '/work/sessions');
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: '/work/agent/auth.json', modelsPath: '/work/agent/models.json', modelsStorePath: '/work/agent/models-store.json', allowModelNetwork: false });
  modelRuntime.streamSimple = () => { modelCalls++; throw Error('probe_model_forbidden'); };
  const model = modelRuntime.getModel('anthropic', 'claude-sonnet-4-5');
  assert.ok(model, 'fixed catalog model missing');
  const resourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'Synthetic initialization only. Never call a model.', getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
  };
  const { session, modelFallbackMessage } = await sdk.createAgentSession({ cwd, agentDir: '/work/agent', model, modelRuntime,
    thinkingLevel: 'off', tools: ['read', 'write', 'edit', 'bash'], resourceLoader, sessionManager: manager,
    settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) });
  try {
    assert.equal(modelFallbackMessage, undefined);
    assert.equal(manager.getCwd(), cwd);
    assert.equal(session.messages.length, mode === 'resume' ? 1 : 0);
    if (mode === 'resume') {
      assert.equal(manager.getSessionId(), 'synthetic-session');
      assert.equal(session.messages[0].content, 'synthetic history only');
      assert.equal(hash(fs.readFileSync(sessionPath)), before);
    }
    verifyNoProbeSideEffects(session.agent.state.systemPrompt, modelCalls, networkCalls);
    const tools = new Map(session.agent.state.tools.map(t => [t.name, t]));
    assert.deepEqual([...tools.keys()].sort(), ['bash', 'edit', 'read', 'write']);
    await tools.get('write').execute('p1', { path: 'probe.txt', content: 'before' });
    await tools.get('edit').execute('p2', { path: 'probe.txt', edits: [{ oldText: 'before', newText: 'after' }] });
    const read = await tools.get('read').execute('p3', { path: 'probe.txt' });
    assert.equal(read.content[0].text, 'after');
    const shell = await tools.get('bash').execute('p4', { command: 'test "$(id -u)" = 65534 && test "$(pwd)" = /work/snapshot && test ! -e /var/run/docker.sock && printf container-shell', timeout: 5 });
    assert.equal(shell.content[0].text.trim(), 'container-shell');
    verifyNoProbeSideEffects(session.agent.state.systemPrompt, modelCalls, networkCalls);
    console.log(JSON.stringify({ kind: 'synthetic-pi-initialization', mode, piVersion: version,
      inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash, runtimeBytes: manifest.runtimeBytes,
      historyMessages: session.messages.length, sessionBytesUnchanged: mode === 'resume' ? true : null,
      toolsVerified: ['read', 'write', 'edit', 'bash'], modelCalls, networkCalls,
      runnable: false, reproduced: false, evaluable: false, strictEvalEligible: false }));
  } finally { session.dispose(); }
})().catch(() => { process.stderr.write('pi_initialization_probe_failed\n'); process.exitCode = 1; });
