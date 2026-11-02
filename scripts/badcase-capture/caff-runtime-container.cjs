// CONTAINER ONLY. Fixed synthetic project, production CAFF runtime factory.
// Real tools execute here, but NO prompt/model turn or captured code is submitted.
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// Shared immutable-stage guard. No capsule restoration, SDK or fixture creation.
function verifyCaffRuntimeStage({ replayWorkspace = false } = {}) {
  if (process.platform !== 'linux' || process.getuid?.() !== 65534 || process.cwd() !== '/work' || !fs.existsSync('/.dockerenv')
    || Object.keys(process.env).some(k => /^(CAFF_|PI_|OPENAI_|ANTHROPIC_|AWS_|NODE_OPTIONS$|NODE_PATH$|LD_PRELOAD$|LD_LIBRARY_PATH$)/.test(k))) throw Error();
  const m = JSON.parse(fs.readFileSync('manifest.json')), image = JSON.parse(fs.readFileSync('environment.json'));
  assert.equal(m.schemaVersion, 1); assert.ok(Array.isArray(m.files) && m.files.length <= (replayWorkspace ? 5126 : 4096));
  assert.equal(hash(JSON.stringify(m.files)), m.inputHash);
  const names = new Set(); let total = 0, staticCount = 0, workspaceCount = 0;
  for (const f of m.files) {
    assert.ok(typeof f.path === 'string' && /^[A-Za-z0-9_.@/-]+$/.test(f.path)
      && f.path.split('/').every(p => p && p !== '.' && p !== '..') && !names.has(f.path)); names.add(f.path);
    const st = fs.lstatSync('/work/' + f.path);
    if (replayWorkspace && f.path.startsWith('replay-workspace/')) workspaceCount++;
    else { total += st.size; staticCount++; }
    assert.ok(total <= 16 * 1024 * 1024 && staticCount <= 4096 && workspaceCount <= 1030
      && st.isFile() && !st.isSymbolicLink() && st.size === f.size);
    assert.equal(hash(fs.readFileSync('/work/' + f.path)), f.sha256);
  }
  assert.equal(hash(JSON.stringify(m.files.filter(f => f.path.startsWith('runtime/')))), m.runtimeHash);
  assert.equal(process.version, image.nodeVersion); assert.equal(process.arch, image.architecture === 'amd64' ? 'x64' : 'arm64');
  const mode = fs.readFileSync('mode.txt', 'utf8'); assert.ok(['fresh', 'resume'].includes(mode));
  return { manifest: m, image, mode };
}
// Injected importer is for inert VM tests only; the Docker entry always uses import().
async function runCaffRuntimeContainer(loadModule = specifier => import(specifier)) {
  const { manifest: m, image, mode } = verifyCaffRuntimeStage();
  const cwd = '/work/project', agentDir = '/work/agent';
  fs.mkdirSync(cwd, { mode: 0o700 }); fs.mkdirSync(agentDir, { mode: 0o700 });
  const write = (name, text) => fs.writeFileSync(name, text, { flag: 'wx', mode: 0o600 });
  const skill = (directory, name, description) => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    write(directory + '/SKILL.md', '---\nname: ' + name + '\ndescription: ' + description + '\n---\nFixed trusted synthetic instructions.\n');
  };
  write(cwd + '/AGENTS.md', '# Project context\nCAFF_WIRING_PROJECT_CONTEXT\n');
  write(agentDir + '/SYSTEM.md', 'CAFF_WIRING_ROLE_INSTRUCTIONS');
  write(agentDir + '/settings.json', JSON.stringify({ defaultProjectTrust: 'always', enableInstallTelemetry: false }));
  skill(cwd + '/.agents/skills/wiring-project', 'wiring-project', 'CAFF_WIRING_PROJECT_SKILL');
  skill('/work/contract-skill', 'wiring-contract', 'CAFF_WIRING_CONTRACT_SKILL');
  skill(agentDir + '/skills/retired', 'wiring-retired', 'CAFF_WIRING_RETIRED_SKILL');
  const historical = { role: 'user', content: 'CAFF_WIRING_PRIOR_USER', timestamp: 1 };
  const archived = [
    { type: 'session', version: 3, id: 'wiring-session', timestamp: '2026-01-01T00:00:00.000Z', cwd },
    { type: 'thinking_level_change', id: 'thinking', parentId: null, timestamp: '2026-01-01T00:00:00.001Z', thinkingLevel: 'off' },
    { type: 'message', id: 'prior', parentId: 'thinking', timestamp: '2026-01-01T00:00:00.002Z', message: historical },
  ].map(e => JSON.stringify(e)).join('\n') + '\n';
  const sessionPath = '/work/working-session.jsonl';
  if (mode === 'resume') { write('/work/archived-session.jsonl', archived); write(sessionPath, archived); }
  else assert.equal(fs.existsSync(sessionPath), false);
  process.env.PI_OFFLINE = '1'; process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_TELEMETRY = '0';
  let runtime, callback, modelCalls = 0, externalFetchCalls = 0;
  const originalFetch = globalThis.fetch, envKeys = ['CAFF_CHAT_API_URL', 'CAFF_CHAT_INVOCATION_ID', 'CAFF_CHAT_CALLBACK_TOKEN'];
  globalThis.fetch = async (input, options) => {
    const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!callback || u.origin !== callback.apiUrl) { externalFetchCalls++; throw Error('external_fetch_forbidden'); }
    return originalFetch(input, options);
  };
  try {
    const { startEvaluationCallback } = require('/work/build/server/domain/runtime/badcase-capture/evaluation-callback');
    const seed = { conversationId: 'wiring-room', turnId: 'wiring-turn', agent: { id: 'wiring-agent', name: 'Wiring Agent' },
      userMessage: { id: 'wiring-user', content: 'CAFF_WIRING_CONTEXT' }, assistantMessageId: 'wiring-assistant' };
    callback = await startEvaluationCallback({ directory: '/work/callback', seed, lifetimeMs: 20000 });
    process.env.CAFF_CHAT_API_URL = callback.apiUrl;
    process.env.CAFF_CHAT_INVOCATION_ID = callback.credentials.invocationId;
    process.env.CAFF_CHAT_CALLBACK_TOKEN = callback.credentials.callbackToken;
    const sdk = await loadModule('/work/runtime/dist/bundle/index.js'); assert.equal(sdk.VERSION, '0.85.1');
    const host = await loadModule('/work/build/lib/pi-sdk-host.mjs');
    const config = host.normalizeStartCommand({ type: 'start', prompt: 'Never submitted synthetic input', config: {
      cwd, agentDir, provider: 'openai', model: 'gpt-4o-mini', thinking: 'off', resume: mode === 'resume',
      sessionPath: mode === 'resume' ? sessionPath : '',
      extensionPaths: ['/work/build/lib/pi-extensions/caff-capabilities.mjs'],
      additionalSkillPaths: ['/work/contract-skill'], retireUserScopeSkills: true,
    } }).config;
    ({ runtime } = await host.createSdkRuntime(sdk, config));
    runtime.services.modelRuntime.streamSimple = () => { modelCalls++; throw Error('model_forbidden'); };
    const session = runtime.session, errors = [];
    await session.bindExtensions({ mode: 'json', onError: () => errors.push(true) });
    assert.equal(runtime.modelFallbackMessage, undefined);
    assert.deepEqual(session.messages, mode === 'resume' ? [historical] : []);
    assert.equal(session.model.provider, config.provider); assert.equal(session.model.id, config.model);
    const prompt = session.agent.state.systemPrompt;
    for (const marker of ['CAFF_WIRING_ROLE_INSTRUCTIONS', 'CAFF_WIRING_PROJECT_CONTEXT', 'CAFF_WIRING_PROJECT_SKILL', 'CAFF_WIRING_CONTRACT_SKILL']) assert.ok(prompt.includes(marker));
    assert.equal(prompt.includes('CAFF_WIRING_RETIRED_SKILL'), false);
    const loaded = runtime.services.resourceLoader.getExtensions();
    assert.equal(loaded.errors.length, 0);
    assert.deepEqual(loaded.extensions.map(e => e.path).sort(), [
      '/work/build/lib/pi-extensions/caff-capabilities.mjs', '/work/build/lib/pi-extensions/caff-stream-read-retry.mjs'].sort());
    const tools = session.agent.state.tools;
    for (const name of ['read', 'write', 'edit', 'bash', 'jev_ask', 'list_rooms', 'conversation_notify', 'conversation_request', 'room_workspace_preview', 'room_workspace_bind']) assert.ok(tools.some(t => t.name === name));
    const tool = (name, args) => tools.find(t => t.name === name).execute('wiring-' + name, args, AbortSignal.timeout(3000));
    const text = result => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    await tool('write', { path: 'tool.txt', content: 'before\n' });
    assert.equal(text(await tool('read', { path: 'tool.txt' })).trim(), 'before');
    await tool('edit', { path: 'tool.txt', edits: [{ oldText: 'before', newText: 'after' }] });
    assert.equal(text(await tool('read', { path: 'tool.txt' })).trim(), 'after');
    assert.equal(fs.readFileSync(cwd + '/tool.txt', 'utf8'), 'after\n');
    const namespace = await tool('bash', { command: 'printf "%s:" "$(id -u)"; pwd', timeout: 2 });
    assert.equal(text(namespace).trim(), '65534:' + cwd);
    const cli = args => tool('bash', { command: 'node /work/build/lib/agent-chat-tools.js ' + args, timeout: 2 });
    const before = JSON.parse(text(await cli('read-context'))); assert.equal(before.latestUserMessage?.content, seed.userMessage.content);
    const sent = JSON.parse(text(await cli('send-public --content CAFF_WIRING_RESULT --no-finalize'))); assert.equal(sent.message?.id, seed.assistantMessageId);
    const after = JSON.parse(text(await cli('read-context')));
    assert.equal(after.publicMessages.find(m => m.id === seed.assistantMessageId).content, 'CAFF_WIRING_RESULT');
    await assert.rejects(tool('list_rooms', {}), /^Error: evaluation_callback_route_unavailable$/);
    if (mode === 'resume') { assert.equal(fs.readFileSync('/work/archived-session.jsonl', 'utf8'), archived); assert.equal(session.sessionId, 'wiring-session'); }
    assert.equal(modelCalls, 0); assert.equal(externalFetchCalls, 0); assert.deepEqual(errors, []);
  } finally {
    const results = await Promise.allSettled([() => runtime?.dispose(), () => callback?.stop()].map(f => Promise.resolve().then(f)));
    globalThis.fetch = originalFetch; for (const key of envKeys) delete process.env[key];
    assert.ok(results.every(r => r.status === 'fulfilled'));
  }
  const receipt = { kind: 'caff-runtime-wiring-diagnostic-v1', deliveryMode: mode,
    productionRuntimeFactory: true, sdkInitialized: true, extensionsVerified: true,
    projectContextVerified: true, projectSkillVerified: true, contractSkillVerified: true, retiredSkillExcluded: true,
    fileToolsVerified: true, shellToolVerified: true, bridgeCliVerified: true, capabilityRouteDenied: true,
    historyMessages: mode === 'resume' ? 1 : 0, archivedSessionUnchanged: mode === 'resume' ? true : null,
    modelCalls, externalFetchCalls, invocationSubmitted: false,
    runnable: false, reproduced: false, evaluable: false, strictEvalEligible: false,
    nodeVersion: image.nodeVersion, architecture: image.architecture, inputHash: m.inputHash, runtimeHash: m.runtimeHash,
    dependencyHash: hash(JSON.stringify(m.files.filter(f => f.path.startsWith('node_modules/')))) };
  return receipt;
}
if (require.main === module) runCaffRuntimeContainer().then(r => console.log(JSON.stringify(r))).catch(() => {
  process.stderr.write('caff_runtime_container_failed\n'); process.exitCode = 1;
});
module.exports = { runCaffRuntimeContainer, verifyCaffRuntimeStage };
