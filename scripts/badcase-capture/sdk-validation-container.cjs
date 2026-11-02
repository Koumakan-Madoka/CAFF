// Docker-only worker for NEW fresh validation inputs, never historical replay.
// Complete original SDK HTTP transport/factory/loader/extensions and tools.
// Supplier authority and scoring/reference material remain outside the container.
const fs = require('node:fs'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
async function main() {
  // Refuse host execution BEFORE absolute /work loads, SDK or native imports.
  assert.ok(process.platform === 'linux' && process.getuid?.() === 65534 && process.cwd() === '/work' && fs.existsSync('/.dockerenv'));
  const { manifest } = require('/work/caff-runtime-bootstrap.cjs').verifyCaffRuntimeStage();
  const input = JSON.parse(fs.readFileSync('/work/validation-input.json'));
  const task = JSON.parse(fs.readFileSync('/work/validation-task.json'));
  const profile = JSON.parse(fs.readFileSync('/work/model-profile.json'));
  assert.ok(typeof task.preflight === 'boolean' && Number.isSafeInteger(task.expiresAt) && task.expiresAt > Date.now());
  const gate = () => assert.ok(Date.now() < task.expiresAt, 'validation_expired');
  const { startSdkModelGateway, sdkGatewayModelRouting } = require('/work/scripts/badcase-capture/sdk-model-gateway.cjs');
  const { createMailbox } = require('/work/container-model-adapter.cjs');
  const { startEvaluationCallback } = require('/work/build/server/domain/runtime/badcase-capture/evaluation-callback');
  const cwd = '/work/validation-project', agentDir = '/work/validation-agent';
  fs.mkdirSync(cwd, { mode: 0o700 }); fs.mkdirSync(agentDir, { mode: 0o700 });
  const write = (p, b) => fs.writeFileSync(p, b, { flag: 'wx', mode: 0o600 });
  for (const f of input.files) {
    assert.ok(/^[A-Za-z0-9_.@/-]+$/.test(f.path) && f.path.split('/').every(p => p && p !== '.' && p !== '..'));
    const target = cwd + '/' + f.path; fs.mkdirSync(require('node:path').dirname(target), { recursive: true, mode: 0o700 }); write(target, f.content);
  }
  write(agentDir + '/SYSTEM.md', task.role);
  write(agentDir + '/settings.json', JSON.stringify({ defaultProjectTrust: 'always', enableInstallTelemetry: false }));
  let runtime, gateway, callback, externalFetches = 0;
  const fetch = globalThis.fetch;
  const envKeys = ['PI_OFFLINE', 'PI_CODING_AGENT_DIR', 'PI_TELEMETRY', 'CAFF_SDK_MODEL_GATEWAY_KEY',
    'CAFF_CHAT_API_URL', 'CAFF_CHAT_INVOCATION_ID', 'CAFF_CHAT_CALLBACK_TOKEN', 'CAFF_CHAT_TOOLS_PATH', 'CAFF_CHAT_TOOLS_RELATIVE_PATH'];
  globalThis.fetch = (request, options) => {
    const u = new URL(typeof request === 'string' || request instanceof URL ? request : request.url);
    if (u.origin === callback?.apiUrl || u.origin === gateway?.baseUrl.replace(/\/v1$/, '')) return fetch(request, options);
    externalFetches++; throw Error('validation_external_fetch_forbidden');
  };
  let receipt;
  try {
    gate();
    callback = await startEvaluationCallback({ directory: '/work/validation-callback', lifetimeMs: 20000,
      seed: { conversationId: 'validation-room', turnId: task.runId, agent: { id: 'validation-agent', name: 'Validation Agent' },
        userMessage: { id: 'validation-user', content: input.prompt }, assistantMessageId: 'validation-assistant' } });
    const exchange = task.preflight ? async () => { throw Error('preflight_model_forbidden'); } : createMailbox(profile, gate);
    gateway = await startSdkModelGateway({ profile: { settings: profile.settings, tools: profile.tools },
      maxRequests: profile.maxRequests, expiresAt: task.expiresAt }, exchange);
    const routing = sdkGatewayModelRouting({ settings: profile.settings, tools: profile.tools }, gateway);
    write(agentDir + '/models.json', JSON.stringify(routing.models));
    Object.assign(process.env, routing.environment, { PI_OFFLINE: '1', PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: '0',
      CAFF_CHAT_API_URL: callback.apiUrl, CAFF_CHAT_INVOCATION_ID: callback.credentials.invocationId,
      CAFF_CHAT_CALLBACK_TOKEN: callback.credentials.callbackToken, CAFF_CHAT_TOOLS_PATH: '/work/build/lib/agent-chat-tools.js',
      CAFF_CHAT_TOOLS_RELATIVE_PATH: '/work/build/lib/agent-chat-tools.js' });
    const sdk = await import('/work/runtime/dist/bundle/index.js'); assert.equal(sdk.VERSION, '0.85.1');
    const host = await import('/work/build/lib/pi-sdk-host.mjs');
    const sessionPath = '/work/validation-session.jsonl'; assert.equal(fs.existsSync(sessionPath), false);
    const config = host.normalizeStartCommand({ type: 'start', prompt: input.prompt, config: {
      cwd, agentDir, provider: profile.settings.provider, model: profile.settings.model, thinking: 'off', resume: false, sessionPath,
      extensionPaths: ['/work/build/lib/pi-extensions/caff-capabilities.mjs'], additionalSkillPaths: [], retireUserScopeSkills: true } }).config;
    gate(); ({ runtime } = await host.createSdkRuntime(sdk, config));
    const session = runtime.session, errors = [], toolNames = [];
    await session.bindExtensions({ mode: 'json', onError: () => errors.push(true) });
    assert.equal(runtime.modelFallbackMessage, undefined); assert.equal(session.model.provider, profile.settings.provider);
    assert.equal(session.model.id, profile.settings.model); assert.deepEqual(session.messages, []);
    assert.equal(runtime.services.resourceLoader.getExtensions().errors.length, 0);
    assert.deepEqual(runtime.services.resourceLoader.getExtensions().extensions.map(e => e.path).sort(), [
      '/work/build/lib/pi-extensions/caff-capabilities.mjs', '/work/build/lib/pi-extensions/caff-stream-read-retry.mjs'].sort());
    const tools = session.agent.state.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    assert.ok(tools.length >= 10); assert.equal(gateway.status().requests, 0);
    receipt = { kind: 'fresh-caff-sdk-validation-v1', inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash,
      runId: task.runId, roleHash: hash(task.role), preflight: task.preflight, externalFetches: 0, modelCalls: 0 };
    if (task.preflight) receipt.tools = tools;
    else {
      assert.deepEqual(tools, profile.tools); session.subscribe(e => { if (e.type === 'tool_execution_end') toolNames.push(e.toolName); });
      gate(); await session.prompt(input.prompt); gate();
      const final = session.messages.filter(m => m.role === 'assistant').at(-1);
      assert.equal(final?.stopReason, 'stop'); assert.equal(gateway.status().failed, false);
      assert.ok(gateway.status().requests > 0 && gateway.status().requests <= profile.maxRequests);
      const artifact = cwd + '/validation-result.txt', st = fs.lstatSync(artifact);
      assert.ok(st.isFile() && !st.isSymbolicLink() && st.size <= 4096);
      receipt.artifactBase64 = fs.readFileSync(artifact).toString('base64'); receipt.toolNames = toolNames;
      receipt.modelCalls = gateway.status().requests;
    }
    assert.equal(externalFetches, 0); assert.deepEqual(errors, []);
  } finally {
    try { await runtime?.dispose(); }
    finally { try { await gateway?.stop(); }
      finally { try { await callback?.stop(); }
        finally { globalThis.fetch = fetch; for (const name of envKeys) delete process.env[name]; } } }
  }
  gate(); return receipt; // stdout only AFTER all runtime/gateway/callback work joined
}
if (require.main === module) main().then(r => console.log(JSON.stringify(r))).catch(() => {
  process.stderr.write('sdk_validation_container_failed\n'); process.exitCode = 1;
});
module.exports = { main };
