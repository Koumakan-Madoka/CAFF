// CONTAINER ONLY. Execute an explicitly prepared input through the original
// CAFF runtime/SDK and native provider SSE. This worker does NOT certify that
// its caller prepared a complete sealed checkpoint; that is a separate gate.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function collectFileEvidence(cwd, paths, key) {
  assert.ok(Array.isArray(paths) && paths.length > 0 && paths.length <= 16 && new Set(paths).size === paths.length);
  const { containsSecretSentinel } = require('/work/build/server/domain/runtime/badcase-capture/secrets');
  let total = 0;
  return paths.map(name => {
    assert.ok(typeof name === 'string' && name.length <= 512 && /^[A-Za-z0-9_.@/-]+$/.test(name)
      && name.split('/').every(p => p && p !== '.' && p !== '..' && p !== '.git'));
    try {
      const parts = name.split('/'); let target = cwd, stat;
      for (const [index, part] of parts.entries()) {
        target += '/' + part; stat = fs.lstatSync(target);
        if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) return { path: name, state: 'unsupported' };
      }
      if (!stat.isFile() || stat.size > 65536) return { path: name, state: 'unsupported' };
      const bytes = fs.readFileSync(target); total += bytes.length;
      const text = bytes.toString('utf8');
      if (bytes.length > 65536 || total > 262144 || !Buffer.from(text).equals(bytes) || text.includes('\0')
        || bytes.includes(key) || containsSecretSentinel(bytes)) return { path: name, state: 'unsupported' };
      return { path: name, state: 'file', base64: bytes.toString('base64'), sha256: hash(bytes), size: bytes.length };
    } catch (e) { return { path: name, state: e.code === 'ENOENT' ? 'missing' : 'unsupported' }; }
  });
}
async function main({ baseUrl, loadModule = s => import(s) } = {}) {
  assert.ok(process.platform === 'linux' && process.getuid?.() === 65534 && process.cwd() === '/work' && fs.existsSync('/.dockerenv'));
  const direct = require('/work/direct-model.cjs'), profile = JSON.parse(fs.readFileSync('/work/evaluation-profile.json'));
  const codex = profile === direct.CODEX_PROFILE;
  if (codex) assert.equal(process.env[direct.KEY_ENV], undefined, 'codex_container_credential_forbidden');
  const key = codex ? direct.CODEX_INERT_KEY : direct.validKey(process.env[direct.KEY_ENV]);
  // The immutable-stage verifier rejects auth. Codex has no injected key at
  // all; create the public inert SDK identity only AFTER stage verification.
  delete process.env[direct.KEY_ENV];
  let manifest;
  try { ({ manifest } = require('/work/caff-runtime-bootstrap.cjs').verifyCaffRuntimeStage({ replayWorkspace: true })); }
  finally { if (!codex) process.env[direct.KEY_ENV] = key; }
  const selected = direct.modelProfile(profile);
  if (codex) process.env[direct.KEY_ENV] = key;
  const input = JSON.parse(fs.readFileSync('/work/replay-input.json'));
  assert.equal(input.kind, 'prepared-caff-turn-v1'); assert.equal(typeof input.prompt, 'string');
  if (input.recordedModelConfig !== undefined) {
    assert.deepEqual(Object.keys(input.recordedModelConfig).sort(), ['fast', 'model', 'provider', 'thinking']);
    assert.equal(input.recordedModelConfig.thinking, selected.thinking || 'off');
    assert.equal(input.recordedModelConfig.fast, false);
  }
  assert.ok(input.prompt.trim() && Buffer.byteLength(input.prompt) <= 256 * 1024);
  assert.ok(input.sessionText === null || typeof input.sessionText === 'string' && input.sessionText.endsWith('\n'));
  assert.ok(Array.isArray(input.files) && input.files.length <= 1024);
  assert.ok(input.settings === null || input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings));
  assert.ok(input.systemPrompt === null || typeof input.systemPrompt === 'string');
  const cwd = '/work/restored', agentDir = '/work/agent', sessionPath = '/work/session.jsonl';
  assert.ok(input.workspace === undefined || input.workspace === 'replay-workspace');
  const gitFiles = input.gitFiles || [];
  assert.ok(Array.isArray(gitFiles) && (gitFiles.length === 0 && input.repository === undefined
    || gitFiles.length === 6 && Number.isSafeInteger(input.repository?.historyCommitCount) && input.repository.historyCommitCount >= 1
      && (input.repository.kind === 'sanitized-root-git-v1' && input.repository.historyIncluded === false && input.repository.headIdenticalToSource === false
        || input.repository.kind === 'preserved-head-git-v1' && input.repository.historyIncluded === true && input.repository.headIdenticalToSource === true)));
  const directoryWorkspace = input.workspace === 'replay-workspace' && input.files.length + gitFiles.length > 0;
  if (!directoryWorkspace) fs.mkdirSync(cwd, { mode: 0o700 });
  fs.mkdirSync(agentDir, { mode: 0o700 });
  const write = (p, b) => fs.writeFileSync(p, b, { flag: 'wx', mode: 0o600 });
  const names = new Set();
  for (const f of [...input.files, ...gitFiles]) {
    const gitFile = gitFiles.includes(f);
    assert.ok(typeof f.path === 'string' && !names.has(f.path) && (gitFile
      ? /^\.git\/(?:HEAD|config|index|refs\/heads\/replay-baseline|objects\/pack\/pack-[a-f0-9]{40,64}\.(?:pack|idx))$/.test(f.path)
      : /^[A-Za-z0-9_.@/-]+$/.test(f.path) && f.path.split('/').every(p => p && p !== '.' && p !== '..' && p !== '.git')));
    names.add(f.path);
    let bytes;
    if (directoryWorkspace) {
      const source = '/work/replay-workspace/' + f.path, st = fs.lstatSync(source);
      assert.ok(st.isFile() && !st.isSymbolicLink() && st.size === f.size && f.base64 === undefined);
      bytes = fs.readFileSync(source); assert.equal(bytes.length, f.size);
    } else {
      bytes = Buffer.from(f.base64, 'base64'); assert.equal(bytes.toString('base64'), f.base64);
      const target = cwd + '/' + f.path; fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); write(target, bytes);
    }
    assert.equal(hash(bytes), f.sha256);
  }
  if (directoryWorkspace) fs.renameSync('/work/replay-workspace', cwd);
  let repository;
  if (gitFiles.length) {
    const { execFileSync } = require('node:child_process');
    const git = args => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const restoredHead = git(['rev-parse', '--verify', 'HEAD']), count = git(['rev-list', '--all', '--count']);
    assert.equal(restoredHead, input.repository.restoredHead); assert.equal(count, String(input.repository.historyCommitCount));
    assert.equal(restoredHead === input.repository.sourceHead, input.repository.headIdenticalToSource);
    repository = { ...input.repository, gitAvailable: true, historyCommitCount: Number(count) };
  }
  const dependencies = input.dependencies === undefined ? undefined
    : require('/work/restore-replay-dependencies.cjs').restoreReplayDependencies(cwd, input.dependencies);
  const treeHash = () => {
    const rows = [];
    function walk(dir, relative = '') {
      for (const name of fs.readdirSync(dir).sort()) {
        if (relative === '' && (name === '.git' && repository || name === 'node_modules' && dependencies)) continue;
        const p = dir + '/' + name, rel = relative + name, st = fs.lstatSync(p);
        if (st.isDirectory()) walk(p, rel + '/'); else rows.push({ path: rel, type: st.isSymbolicLink() ? 'symlink' : 'file', sha256: st.isFile() ? hash(fs.readFileSync(p)) : null });
      }
    }
    walk(cwd); rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return hash(JSON.stringify(rows));
  };
  const resources = input.projectResources === undefined ? null : require('/work/build/server/domain/runtime/badcase-capture/project-resources');
  if (resources) resources.validateProjectResources(input.projectResources, input.files);
  const beforeHash = treeHash();
  const settings = codex ? { ...input.settings, transport: 'sse', retry: { ...input.settings?.retry, enabled: false,
    provider: { ...input.settings?.retry?.provider, maxRetries: 0 } } } : input.settings;
  if (settings !== null) write(agentDir + '/settings.json', JSON.stringify(settings));
  if (input.systemPrompt !== null) write(agentDir + '/SYSTEM.md', input.systemPrompt);
  write(agentDir + '/models.json', JSON.stringify(direct.directModelRouting(baseUrl, profile)));
  assert.equal(fs.existsSync(sessionPath), false);
  let runtime, callback, observer, receipt, projectResources, toolCalls = [], extensionErrors = [];
  const toolArgs = new Map(); let prompt = input.prompt, sessionText = input.sessionText;
  const replaySession = direct.replaySessionInfo(sessionText);
  const originalFetch = globalThis.fetch;
  try {
    if (input.callback !== null) {
      assert.ok(input.callback?.trace && input.callback?.expectedTraceHash && input.callback?.association);
      callback = await require('/work/build/server/domain/runtime/badcase-capture/evaluation-callback').startEvaluationCallback({
        ...input.callback, directory: '/work/callback', lifetimeMs: 45 * 60 * 1000 });
      Object.assign(process.env, { CAFF_CHAT_API_URL: callback.apiUrl, CAFF_CHAT_INVOCATION_ID: callback.credentials.invocationId,
        CAFF_CHAT_CALLBACK_TOKEN: callback.credentials.callbackToken });
    }
    Object.assign(process.env, { PI_OFFLINE: '1', PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: '0',
      CAFF_CHAT_TOOLS_PATH: '/work/build/lib/agent-chat-tools.js', CAFF_CHAT_TOOLS_RELATIVE_PATH: '../build/lib/agent-chat-tools.js' });
    if (input.bindings !== undefined) {
      assert.ok(callback);
      fs.mkdirSync('/tmp/sandbox', { mode: 0o700 }); fs.mkdirSync('/tmp/private', { mode: 0o700 });
      const values = { CAFF_CHAT_API_URL: callback.apiUrl, CAFF_CHAT_INVOCATION_ID: callback.credentials.invocationId,
        CAFF_CHAT_CALLBACK_TOKEN: callback.credentials.callbackToken, CAFF_CHAT_CONVERSATION_ID: input.callback.association.conversationId,
        CAFF_CHAT_TURN_ID: input.callback.association.turnId, CAFF_CHAT_TOOLS_PATH: '/work/build/lib/agent-chat-tools.js',
        CAFF_CHAT_TOOLS_RELATIVE_PATH: '../build/lib/agent-chat-tools.js', PI_AGENT_SANDBOX_DIR: '/tmp/sandbox', PI_AGENT_PRIVATE_DIR: '/tmp/private' };
      Object.assign(process.env, values); ({ prompt, sessionText } = direct.bindDirectInputs(prompt, sessionText, input.bindings, values));
    }
    if (sessionText !== null) {
      const validation = require('/work/build/server/domain/runtime/badcase-capture/session-validator').validateSessionV2(sessionText, { authorizedRoot: cwd });
      assert.ok(validation.ok && validation.unverifiedDimensions.length === 0);
      assert.equal(JSON.parse(sessionText.split('\n')[0]).cwd, cwd);
      write(sessionPath, sessionText);
    }
    const providerFetch = codex ? require('/work/codex-mailbox.cjs').createCodexMailboxFetch({ callbackUrl: callback?.apiUrl, callbackFetch: originalFetch }) : originalFetch;
    observer = direct.observeDirectFetch(providerFetch, { baseUrl, profile, callbackUrl: callback?.apiUrl });
    globalThis.fetch = observer.fetch;
    const sdk = await loadModule('/work/runtime/dist/bundle/index.js'); assert.equal(sdk.VERSION, '0.85.1');
    const host = await loadModule('/work/build/lib/pi-sdk-host.mjs');
    const config = host.normalizeStartCommand({ type: 'start', prompt, config: {
      cwd, agentDir, sessionPath, resume: sessionText !== null, provider: selected.provider, model: selected.model,
      thinking: selected.thinking || 'off', fast: false, extensionPaths: ['/work/build/lib/pi-extensions/caff-capabilities.mjs'],
      additionalSkillPaths: resources ? input.projectResources.skillPaths.map(p => cwd + '/' + p) : [], retireUserScopeSkills: true } }).config;
    ({ runtime } = await host.createSdkRuntime(sdk, config)); const session = runtime.session;
    if (codex) {
      runtime.services.settingsManager.applyOverrides({ retry: { enabled: false, provider: { maxRetries: 0 } } });
      session.agent.transport = 'sse'; // project-local settings must not enable WebSocket or retries
    }
    await session.bindExtensions({ mode: 'json', onError: () => extensionErrors.push(true) });
    assert.equal(runtime.modelFallbackMessage, undefined); assert.equal(session.model.provider, selected.provider); assert.equal(session.model.id, selected.model);
    if (codex) { assert.equal(session.model.api, selected.api); assert.equal(session.thinkingLevel, selected.thinking); }
    assert.equal(runtime.services.resourceLoader.getExtensions().errors.length, 0);
    if (resources) projectResources = resources.verifyLoadedProjectResources(input.projectResources, input.files, runtime.services.resourceLoader, cwd);
    const initialHistory = sessionText === null ? [] : sdk.buildSessionContext(sessionText.trimEnd().split('\n').map(JSON.parse).slice(1)).messages;
    assert.deepEqual(session.messages, initialHistory);
    if (sessionText !== null) assert.ok(fs.readFileSync(sessionPath, 'utf8').startsWith(sessionText), 'replay_session_prefix_changed');
    const tools = session.agent.state.tools.map(t => t.name); assert.ok(tools.length >= 10);
    session.subscribe(e => {
      if (e.type === 'message_end' && e.message?.role === 'assistant') observer.complete(e.message);
      if (e.type === 'tool_execution_start') {
        const args = {}; for (const key of ['path', 'command']) if (typeof e.args?.[key] === 'string') args[key] = e.args[key].slice(0, 8192);
        toolArgs.set(e.toolCallId, args);
      }
      if (e.type === 'tool_execution_end') toolCalls.push({ name: e.toolName, isError: e.isError === true, ...(input.bindings ? { args: toolArgs.get(e.toolCallId) || {} } : {}) });
    });
    let threw = false;
    try { await session.prompt(prompt); } catch { threw = true; }
    const final = session.messages.filter(m => m.role === 'assistant').at(-1);
    const text = (final?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    // A callback turn is graded on what it actually published, including no
    // publication. Internal SDK text is diagnostic only, never a substitute.
    const finalText = callback ? callback.readPublicReply() : text;
    const replySource = finalText ? (callback ? 'public' : 'internal') : 'none';
    receipt = { kind: 'direct-caff-turn-v1', inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash,
      success: !threw && final?.stopReason === 'stop' && observer.calls.length > 0 && observer.calls.every(c => c.success),
      historyMessages: initialHistory.length, historyHash: hash(JSON.stringify(initialHistory)), tools, toolCalls,
      modelCalls: observer.calls, finalText, replySource, beforeHash, afterHash: treeHash(),
      ...(codex ? { modelConfig: { api: selected.api, thinking: session.thinkingLevel, fast: false, transport: session.agent.transport, credentialDelivery: 'host-only-mailbox' } } : {}),
      ...(input.recordedModelConfig ? { recordedModelConfig: input.recordedModelConfig } : {}),
      ...(replaySession ? { replaySession } : {}), ...(projectResources ? { projectResources } : {}),
      ...(repository ? { repository } : {}), ...(dependencies ? { dependencies } : {}),
      ...(input.fileEvidencePaths === undefined ? {} : { fileEvidence: collectFileEvidence(cwd, input.fileEvidencePaths, key) }),
      // No worker self-score. The host scores only after container removal.
      scored: false, sealedCheckpointVerified: false };
    assert.deepEqual(extensionErrors, []);
    assert.ok(!JSON.stringify(receipt).includes(key), 'evaluation_output_contains_key');
  } finally {
    try { await runtime?.dispose(); }
    finally { try { await callback?.stop(); }
      finally { globalThis.fetch = originalFetch;
        for (const k of [direct.KEY_ENV, 'PI_OFFLINE', 'PI_CODING_AGENT_DIR', 'PI_TELEMETRY', 'CAFF_CHAT_API_URL', 'CAFF_CHAT_INVOCATION_ID', 'CAFF_CHAT_CALLBACK_TOKEN', 'CAFF_CHAT_TOOLS_PATH', 'CAFF_CHAT_TOOLS_RELATIVE_PATH', 'CAFF_CHAT_CONVERSATION_ID', 'CAFF_CHAT_TURN_ID', 'PI_AGENT_SANDBOX_DIR', 'PI_AGENT_PRIVATE_DIR']) delete process.env[k]; } }
  }
  return receipt;
}
if (require.main === module) main().then(r => console.log(JSON.stringify(r))).catch(() => { process.stderr.write('direct_caff_turn_failed\n'); process.exitCode = 1; });
module.exports = { main, collectFileEvidence };
