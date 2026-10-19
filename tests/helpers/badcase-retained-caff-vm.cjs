// Inert execution of the REAL container entry. All FS/SDK boundaries are spies.
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const base = '../../build/server/domain/runtime/badcase-capture/';
const start = require(base + 'caff-replay-start'), material = require(base + 'capsule-materialization');
const working = require(base + 'worktree-replay-materialization');
module.exports = function containerVm(value, image, options = {}) {
  const plan = start.planRetainedCaffInitialization(value.capsule, value.expected, value.worktree, value.bindings);
  const source = material.planModePreservingReplayCapsule(value.capsule, value.expected);
  const inputs = working.planWorktreeReplayMaterialization(value.capsule, value.expected, value.worktree);
  const bytes = new Map([['capsule.json', value.capsule], ['expected.json', JSON.stringify(value.expected)],
    ['worktree.json', JSON.stringify(value.worktree)], ['bindings.json', JSON.stringify(value.bindings)]].map(([p, b]) => ['/work/' + p, Buffer.from(b)]));
  const events = [], loads = [], reads = []; let disposals = 0;
  const messages = plan.sessionEntries.slice(1).flatMap(e => e.type === 'message' ? [e.message] : e.type === 'custom_message'
    ? [{ role: 'custom', customType: e.customType, content: e.content, display: e.display, timestamp: Date.parse(e.timestamp) }] : []);
  const fakeFs = { readFileSync: (p, encoding) => { reads.push(p); assert.ok(bytes.has(p), p); const b = bytes.get(p); return encoding ? b.toString(encoding) : b; }, existsSync: p => bytes.has(p),
    lstatSync: p => { if (bytes.has(p) || options.danglingFresh && p === plan.config.sessionPath) return {};
      throw Object.assign(Error('missing'), { code: 'ENOENT' }); } };
  const role = source.files.find(f => f.path === 'snapshot/.agent/SYSTEM.md').bytes.toString();
  const settings = JSON.parse(source.files.find(f => f.path === 'snapshot/.agent/settings.json').bytes);
  class ModelRuntime {}
  const modelMethods = ['stream', 'complete', 'streamSimple', 'completeSimple', 'streamDeferred', 'fetchDeferred', 'cancelDeferred'];
  for (const name of modelMethods) ModelRuntime.prototype[name] = () => { events.push('unguarded-model:' + name); };
  const originalMethods = new Map(modelMethods.map(name => [name, ModelRuntime.prototype[name]]));
  const modelRuntime = new ModelRuntime(), session = { model: { provider: plan.config.provider, id: plan.config.model },
    sessionFile: options.wrongSessionFile ? '/wrong-session.jsonl' : plan.config.sessionPath || '/generated.jsonl',
    settingsManager: { getGlobalSettings: () => options.wrongSettings ? { ...settings, retry: { enabled: true, maxRetries: 0 } } : settings },
    messages: options.wrongHistory ? [] : structuredClone(messages), sessionId: options.wrongId ? 'fresh-created' : plan.sessionEntries[0]?.id,
    agent: { state: { systemPrompt: options.wrongRole || options.wrongComposedRole ? 'wrong synthetic role' : role + '\nretained project context', tools: [{ name: 'read' }, { name: 'bash' }] } },
    bindExtensions: async cfg => { events.push('bind'); if (options.extensionError) cfg.onError({});
      if (options.modelAttempt) modelRuntime.streamSimple(); if (options.networkAttempt) await context.fetch('https://not-allowed.invalid'); } };
  const runtime = { session, services: { modelRuntime, resourceLoader: {
    getSystemPrompt: () => options.wrongRole || options.wrongLoadedRole ? 'wrong synthetic role' : role,
    getSystemPromptSource: () => ({ path: options.wrongRoleSource ? '/outside/SYSTEM.md' : plan.config.agentDir + '/SYSTEM.md' }),
    getExtensions: () => ({ errors: options.loaderError ? ['missing'] : [] }) } },
    modelFallbackMessage: options.fallback ? 'fallback' : undefined,
    dispose: async () => { disposals++; events.push('dispose'); if (options.disposeFailure) throw Error('inert_dispose_failure'); } };
  const mod = { exports: {} }, originalFetch = async () => assert.fail('unexpected real fetch');
  const context = { module: mod, process: { env: {} }, Buffer, console: { log: () => assert.fail('unexpected stdout') }, fetch: originalFetch,
    require: name => {
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:crypto') return crypto;
      if (name === 'node:assert/strict') return { ...assert, deepEqual: (a, b) => assert.deepEqual(
        JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))) };
      if (name === './caff-runtime-bootstrap.cjs') return { verifyCaffRuntimeStage: () => {
        events.push('guard'); if (options.guardFailure) throw Error('inert_guard');
        return { manifest: { inputHash: 'a'.repeat(64), runtimeHash: 'b'.repeat(64), files: [] }, image, mode: options.wrongMode ? 'fresh' : plan.receipt.deliveryMode };
      } };
      assert.ok(name.startsWith('/work/build/server/domain/runtime/badcase-capture/'));
      events.push('require:' + path.basename(name));
      if (name.endsWith('/caff-replay-start')) return start;
      if (name.endsWith('/capsule-materialization')) return material;
      if (name.endsWith('/worktree-replay-materialization')) return { ...working, materializeWorktreeReplayInputs: (...args) => {
        events.push('restore'); assert.equal(args[3], '/work/restored');
        if (options.restoreFailure) throw Error('inert_restore');
        for (const f of source.files) bytes.set('/work/restored/' + f.path, Buffer.from(f.bytes));
        for (const f of inputs.files) bytes.set('/work/restored/working-inputs/' + f.path, Buffer.from(f.bytes));
        if (options.missingSession) bytes.delete('/work/restored/working-inputs/session.jsonl');
        if (options.existingFresh) bytes.set('/work/restored/working-inputs/fresh-session.jsonl', Buffer.from('old history must never be opened'));
        return inputs.expectedReceipt;
      } };
      assert.fail(name);
    } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../scripts/badcase-capture/retained-caff-container.cjs'), 'utf8'), context, { timeout: 1000 });
  return { events, loads, reads, bytes, context, originalFetch, disposals: () => disposals,
    modelGuardRestored: () => modelMethods.every(name => ModelRuntime.prototype[name] === originalMethods.get(name)),
    run: () => mod.exports.runRetainedCaffContainer(async name => {
      loads.push(name); events.push('load:' + name);
      if (options.importFailure) throw Error('inert_import');
      if (name === '/work/runtime/dist/bundle/index.js') return { VERSION: '0.85.1', ModelRuntime, buildSessionContext: entries => {
        assert.deepEqual(entries, plan.sessionEntries.slice(1)); return { messages: structuredClone(messages) };
      } };
      assert.equal(name, '/work/build/lib/pi-sdk-host.mjs');
      return { normalizeStartCommand: command => { assert.deepEqual(command.config, plan.config); assert.equal(command.prompt, plan.invocation);
        return options.configDrift ? { ...command, config: { ...command.config, thinking: 'high' } } : command; },
      createSdkRuntime: async () => { events.push('factory');
        if (options.modelDuringFactory) modelRuntime[options.modelDuringFactory]();
        assert.equal(bytes.get('/work/restored/working-inputs/prompt.txt').toString(), plan.invocation);
        if (options.archiveTamper) bytes.set('/work/restored/materials/checkpoint.json', Buffer.from('changed'));
        if (options.wrongModel) session.model.id = 'different';
        return { runtime };
      } };
    }) };
};
