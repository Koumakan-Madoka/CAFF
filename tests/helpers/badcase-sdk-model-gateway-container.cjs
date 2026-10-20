// EXPLICIT DOCKER-ONLY transport conformance test. Full original CAFF factory,
// extensions/loader/tools and native SDK HTTP stream; synthetic provider replies.
// NOT a user capture, real supplier/model, historical badcase or scoring evidence.
const fs = require('node:fs'), assert = require('node:assert/strict');
let stage = 'guard', profileMetrics;
async function main() {
  const { manifest, image } = require('/work/caff-runtime-bootstrap.cjs').verifyCaffRuntimeStage();
  stage = 'setup';
  const { startSdkModelGateway, sdkGatewayModelRouting } = require('/work/scripts/badcase-capture/sdk-model-gateway.cjs');
  const { startEvaluationCallback } = require('/work/build/server/domain/runtime/badcase-capture/evaluation-callback');
  const cwd = '/work/gateway-project', agentDir = '/work/gateway-agent';
  fs.mkdirSync(cwd, { mode: 0o700 }); fs.mkdirSync(agentDir, { mode: 0o700 });
  const write = (file, text) => fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
  write(cwd + '/AGENTS.md', '# Native gateway context\nGATEWAY_PROJECT_CONTEXT\n');
  write(agentDir + '/SYSTEM.md', 'GATEWAY_NATIVE_ROLE\n');
  write(agentDir + '/settings.json', JSON.stringify({ defaultProjectTrust: 'always', enableInstallTelemetry: false }));
  fs.mkdirSync(cwd + '/.agents/skills/gateway-skill', { recursive: true });
  write(cwd + '/.agents/skills/gateway-skill/SKILL.md', '---\nname: gateway-skill\ndescription: GATEWAY_PROJECT_SKILL\n---\nTransport test instructions.\n');
  const settings = { provider: 'opencode-go', model: 'deepseek-v4.1-flash', contextWindowTokens: 131072, maxOutputTokens: 256,
    temperature: 0, inputMicroUsdPerMillionTokens: 1000000, outputMicroUsdPerMillionTokens: 2000000,
    maxRequestBytes: 262144, maxResponseBytes: 65536, compatibilityProfile: 'opencode-go-deepseek-nonthinking-cached-index0-v1' };
  let profile = { settings, tools: [{ type: 'function', function: { name: 'read', description: 'preflight declaration only', parameters: { type: 'object' } } }] };
  let gateway, callback, runtime, calls = 0, fetches = 0;
  const originalFetch = globalThis.fetch;
  const env = ['PI_OFFLINE', 'PI_CODING_AGENT_DIR', 'PI_TELEMETRY', 'CAFF_SDK_MODEL_GATEWAY_KEY',
    'CAFF_CHAT_API_URL', 'CAFF_CHAT_INVOCATION_ID', 'CAFF_CHAT_CALLBACK_TOKEN', 'CAFF_CHAT_TOOLS_PATH', 'CAFF_CHAT_TOOLS_RELATIVE_PATH'];
  globalThis.fetch = async (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin === callback?.apiUrl || url.origin === gateway?.baseUrl.replace(/\/v1$/, '')) return originalFetch(input, options);
    fetches++; throw Error('external_fetch_forbidden');
  };
  try {
    callback = await startEvaluationCallback({ directory: '/work/gateway-callback', lifetimeMs: 20000,
      seed: { conversationId: 'gateway-room', turnId: 'gateway-turn', agent: { id: 'gateway-agent', name: 'Synthetic Gateway Agent' },
        userMessage: { id: 'gateway-user', content: 'synthetic transport test' }, assistantMessageId: 'gateway-assistant' } });
    Object.assign(process.env, { PI_OFFLINE: '1', PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: '0', CAFF_CHAT_API_URL: callback.apiUrl,
      CAFF_CHAT_INVOCATION_ID: callback.credentials.invocationId, CAFF_CHAT_CALLBACK_TOKEN: callback.credentials.callbackToken,
      CAFF_CHAT_TOOLS_PATH: '/work/build/lib/agent-chat-tools.js', CAFF_CHAT_TOOLS_RELATIVE_PATH: '/work/build/lib/agent-chat-tools.js' });
    gateway = await startSdkModelGateway({ profile, maxRequests: 2, expiresAt: Date.now() + 15000 }, async () => { throw Error('preflight_model_forbidden'); });
    const configure = () => {
      const routing = sdkGatewayModelRouting(profile, gateway);
      fs.writeFileSync(agentDir + '/models.json', JSON.stringify(routing.models), { mode: 0o600 });
      Object.assign(process.env, routing.environment);
    };
    configure();
    stage = 'sdk';
    const sdk = await import('/work/runtime/dist/bundle/index.js'); assert.equal(sdk.VERSION, '0.85.1');
    const host = await import('/work/build/lib/pi-sdk-host.mjs');
    const config = host.normalizeStartCommand({ type: 'start', prompt: 'Synthetic transport input', config: {
      cwd, agentDir, provider: settings.provider, model: settings.model, thinking: 'off', resume: false,
      extensionPaths: ['/work/build/lib/pi-extensions/caff-capabilities.mjs'], additionalSkillPaths: [], retireUserScopeSkills: true } }).config;
    stage = 'preflight';
    ({ runtime } = await host.createSdkRuntime(sdk, config));
    await runtime.session.bindExtensions({ mode: 'json', onError: () => { throw Error('extension_error'); } });
    assert.equal(runtime.modelFallbackMessage, undefined); assert.equal(gateway.status().requests, 0);
    const tools = runtime.session.agent.state.tools.map(t => ({ type: 'function', function: {
      name: t.name, description: t.description, parameters: t.parameters } }));
    assert.ok(tools.length >= 10); // default built-ins PLUS real CAFF extension tools
    await runtime.dispose(); runtime = undefined; await gateway.stop();
    profile = JSON.parse(JSON.stringify({ settings, tools }));
    stage = 'profile'; profileMetrics = { count: tools.length, bytes: Buffer.byteLength(JSON.stringify(profile.tools)) };
    gateway = await startSdkModelGateway({ profile, maxRequests: 2, expiresAt: Date.now() + 15000 }, async bytes => {
      const body = JSON.parse(bytes); assert.equal(body.model, settings.model); assert.equal(body.stream, false);
      assert.ok(body.messages[0].content.includes('GATEWAY_NATIVE_ROLE')); assert.ok(body.messages[0].content.includes('GATEWAY_PROJECT_CONTEXT'));
      assert.ok(body.messages[0].content.includes('GATEWAY_PROJECT_SKILL')); assert.equal(++calls <= 2, true);
      const calling = calls === 1;
      return Buffer.from(JSON.stringify({ id: 'synthetic-response-' + calls, object: 'chat.completion', created: 1, model: settings.model,
        choices: [{ index: 0, message: { role: 'assistant', content: calling ? null : 'GATEWAY_NATIVE_FINISHED', reasoning_content: '',
          ...(calling ? { tool_calls: [{ index: 0, id: 'gateway-write', type: 'function', function: { name: 'write',
            arguments: '{"path":"gateway-result.txt","content":"native SDK real write tool\\n"}' } }] } : {}) }, finish_reason: calling ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
    });
    configure();
    stage = 'factory';
    ({ runtime } = await host.createSdkRuntime(sdk, config));
    const session = runtime.session, errors = [];
    await session.bindExtensions({ mode: 'json', onError: () => errors.push(true) });
    assert.equal(runtime.modelFallbackMessage, undefined); assert.equal(session.model.provider, settings.provider); assert.equal(session.model.id, settings.model);
    assert.equal(runtime.services.resourceLoader.getExtensions().errors.length, 0);
    assert.deepEqual(runtime.services.resourceLoader.getExtensions().extensions.map(e => e.path).sort(), [
      '/work/build/lib/pi-extensions/caff-capabilities.mjs', '/work/build/lib/pi-extensions/caff-stream-read-retry.mjs'].sort());
    assert.deepEqual(session.agent.state.tools.map(t => t.name), profile.tools.map(t => t.function.name));
    const execution = []; session.subscribe(e => { if (e.type === 'tool_execution_end') execution.push({ name: e.toolName, isError: e.isError }); });
    stage = 'prompt';
    await session.prompt('Write gateway-result.txt containing native SDK real write tool, then finish.');
    stage = 'verify';
    assert.deepEqual(execution, [{ name: 'write', isError: false }]); assert.equal(calls, 2); assert.equal(gateway.status().failed, false);
    assert.equal(fs.readFileSync(cwd + '/gateway-result.txt', 'utf8'), 'native SDK real write tool\n');
    const assistant = session.messages.filter(m => m.role === 'assistant'); assert.equal(assistant.length, 2);
    assert.equal(assistant[0].stopReason, 'toolUse'); assert.equal(assistant[1].stopReason, 'stop');
    assert.ok(assistant[1].content.some(b => b.type === 'text' && b.text === 'GATEWAY_NATIVE_FINISHED'));
    assert.deepEqual(errors, []); assert.equal(fetches, 0);
    return { kind: 'synthetic-native-sdk-gateway-v1', inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash,
      nodeVersion: image.nodeVersion, architecture: image.architecture, fullCaffFactory: true, originalSdkTransport: true,
      loaderExtensionsAndSkillVerified: true, nativeToolExecuted: 'write', tools: profile.tools.length,
      syntheticModelRequests: calls, supplierRequests: 0, externalFetches: fetches, realCapture: false, acceptance: false };
  } finally {
    try { await runtime?.dispose(); }
    finally {
      try { await gateway?.stop(); }
      finally { try { await callback?.stop(); } finally { globalThis.fetch = originalFetch; for (const key of env) delete process.env[key]; } }
    }
  }
}
if (require.main === module) main().then(r => console.log(JSON.stringify(r))).catch(() => {
  process.stderr.write('sdk_model_gateway_container_failed:' + stage + (stage === 'profile' ? ':' + profileMetrics.count + ':' + profileMetrics.bytes : '') + '\n'); process.exitCode = 1;
});
