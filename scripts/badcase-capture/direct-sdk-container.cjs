// CONTAINER ONLY. Execute an explicitly prepared input through the original
// CAFF runtime/SDK and native provider SSE. This worker does NOT certify that
// its caller prepared a complete sealed checkpoint; that is a separate gate.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
async function main({ baseUrl, loadModule = s => import(s) } = {}) {
  assert.ok(process.platform === 'linux' && process.getuid?.() === 65534 && process.cwd() === '/work' && fs.existsSync('/.dockerenv'));
  const direct = require('/work/direct-model.cjs'), key = direct.validKey(process.env[direct.KEY_ENV]);
  // The existing immutable-stage verifier intentionally rejects all auth. Hide
  // ONLY this one explicitly injected variable while verifying static bytes.
  delete process.env[direct.KEY_ENV];
  let manifest;
  try { ({ manifest } = require('/work/caff-runtime-bootstrap.cjs').verifyCaffRuntimeStage()); }
  finally { process.env[direct.KEY_ENV] = key; }
  const input = JSON.parse(fs.readFileSync('/work/replay-input.json'));
  assert.equal(input.kind, 'prepared-caff-turn-v1'); assert.equal(typeof input.prompt, 'string');
  assert.ok(input.prompt.trim() && Buffer.byteLength(input.prompt) <= 131072);
  assert.ok(input.sessionText === null || typeof input.sessionText === 'string' && input.sessionText.endsWith('\n'));
  assert.ok(Array.isArray(input.files) && input.files.length <= 1024);
  assert.ok(input.settings === null || input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings));
  assert.ok(input.systemPrompt === null || typeof input.systemPrompt === 'string');
  const cwd = '/work/restored', agentDir = '/work/agent', sessionPath = '/work/session.jsonl';
  fs.mkdirSync(cwd, { mode: 0o700 }); fs.mkdirSync(agentDir, { mode: 0o700 });
  const write = (p, b) => fs.writeFileSync(p, b, { flag: 'wx', mode: 0o600 });
  for (const f of input.files) {
    assert.ok(typeof f.path === 'string' && /^[A-Za-z0-9_.@/-]+$/.test(f.path) && f.path.split('/').every(p => p && p !== '.' && p !== '..' && p !== '.git'));
    const bytes = Buffer.from(f.base64, 'base64'); assert.equal(bytes.toString('base64'), f.base64); assert.equal(hash(bytes), f.sha256);
    const target = cwd + '/' + f.path; fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); write(target, bytes);
  }
  const treeHash = () => {
    const rows = [];
    function walk(dir, relative = '') {
      for (const name of fs.readdirSync(dir).sort()) {
        const p = dir + '/' + name, rel = relative + name, st = fs.lstatSync(p);
        if (st.isDirectory()) walk(p, rel + '/'); else rows.push({ path: rel, type: st.isSymbolicLink() ? 'symlink' : 'file', sha256: st.isFile() ? hash(fs.readFileSync(p)) : null });
      }
    }
    walk(cwd); return hash(JSON.stringify(rows));
  };
  const beforeHash = treeHash();
  if (input.settings !== null) write(agentDir + '/settings.json', JSON.stringify(input.settings));
  if (input.systemPrompt !== null) write(agentDir + '/SYSTEM.md', input.systemPrompt);
  write(agentDir + '/models.json', JSON.stringify(direct.directModelRouting(baseUrl)));
  if (input.sessionText !== null) write(sessionPath, input.sessionText);
  else assert.equal(fs.existsSync(sessionPath), false);
  let runtime, callback, observer, receipt, toolCalls = [], extensionErrors = [];
  const toolArgs = new Map(); let prompt = input.prompt;
  const originalFetch = globalThis.fetch;
  try {
    if (input.callback !== null) {
      assert.ok(input.callback?.trace && input.callback?.expectedTraceHash && input.callback?.association);
      callback = await require('/work/build/server/domain/runtime/badcase-capture/evaluation-callback').startEvaluationCallback({
        ...input.callback, directory: '/work/callback', lifetimeMs: 300000 });
      Object.assign(process.env, { CAFF_CHAT_API_URL: callback.apiUrl, CAFF_CHAT_INVOCATION_ID: callback.credentials.invocationId,
        CAFF_CHAT_CALLBACK_TOKEN: callback.credentials.callbackToken });
    }
    Object.assign(process.env, { PI_OFFLINE: '1', PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: '0',
      CAFF_CHAT_TOOLS_PATH: '/work/build/lib/agent-chat-tools.js', CAFF_CHAT_TOOLS_RELATIVE_PATH: '../build/lib/agent-chat-tools.js' });
    if (input.bindings !== undefined) {
      assert.ok(callback && input.sessionText === null);
      fs.mkdirSync('/tmp/sandbox', { mode: 0o700 }); fs.mkdirSync('/tmp/private', { mode: 0o700 });
      const values = { CAFF_CHAT_API_URL: callback.apiUrl, CAFF_CHAT_INVOCATION_ID: callback.credentials.invocationId,
        CAFF_CHAT_CALLBACK_TOKEN: callback.credentials.callbackToken, CAFF_CHAT_CONVERSATION_ID: input.callback.association.conversationId,
        CAFF_CHAT_TURN_ID: input.callback.association.turnId, CAFF_CHAT_TOOLS_PATH: '/work/build/lib/agent-chat-tools.js',
        CAFF_CHAT_TOOLS_RELATIVE_PATH: '../build/lib/agent-chat-tools.js', PI_AGENT_SANDBOX_DIR: '/tmp/sandbox', PI_AGENT_PRIVATE_DIR: '/tmp/private' };
      Object.assign(process.env, values); prompt = direct.bindDirectPrompt(prompt, input.bindings, values);
    }
    observer = direct.observeDirectFetch(originalFetch, { baseUrl, callbackUrl: callback?.apiUrl });
    globalThis.fetch = observer.fetch;
    const sdk = await loadModule('/work/runtime/dist/bundle/index.js'); assert.equal(sdk.VERSION, '0.85.1');
    const host = await loadModule('/work/build/lib/pi-sdk-host.mjs');
    const config = host.normalizeStartCommand({ type: 'start', prompt, config: {
      cwd, agentDir, sessionPath, resume: input.sessionText !== null, provider: direct.PROVIDER, model: direct.MODEL,
      thinking: 'off', fast: false, extensionPaths: ['/work/build/lib/pi-extensions/caff-capabilities.mjs'],
      additionalSkillPaths: [], retireUserScopeSkills: true } }).config;
    ({ runtime } = await host.createSdkRuntime(sdk, config)); const session = runtime.session;
    await session.bindExtensions({ mode: 'json', onError: () => extensionErrors.push(true) });
    assert.equal(runtime.modelFallbackMessage, undefined); assert.equal(session.model.provider, direct.PROVIDER); assert.equal(session.model.id, direct.MODEL);
    assert.equal(runtime.services.resourceLoader.getExtensions().errors.length, 0);
    const initialHistory = input.sessionText === null ? [] : sdk.buildSessionContext(input.sessionText.trimEnd().split('\n').map(JSON.parse).slice(1)).messages;
    assert.deepEqual(session.messages, initialHistory);
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
    receipt = { kind: 'direct-caff-turn-v1', inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash,
      success: !threw && final?.stopReason === 'stop' && observer.calls.length > 0 && observer.calls.every(c => c.success),
      historyMessages: initialHistory.length, historyHash: hash(JSON.stringify(initialHistory)), tools, toolCalls,
      modelCalls: observer.calls, finalText: callback?.readPublicReply?.() || text, beforeHash, afterHash: treeHash(),
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
module.exports = { main };
