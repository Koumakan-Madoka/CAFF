// CONTAINER ONLY. Consume actual capsule/config, never a synthetic replacement.
// Default: initialization only. The separate trusted bridge entry also probes
// real tools/callback, still without a prompt/provider credential/model run.
const fs = require('node:fs'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
async function runRetainedCaffContainer(loadModule = specifier => import(specifier), bridgeProbe = false) {
  const { manifest, image, mode } = require('./caff-runtime-bootstrap.cjs').verifyCaffRuntimeStage();
  const base = '/work/build/server/domain/runtime/badcase-capture/';
  const { planRetainedCaffInitialization } = require(base + 'caff-replay-start');
  const { materializeWorktreeReplayInputs, planWorktreeReplayMaterialization } = require(base + 'worktree-replay-materialization');
  const { planModePreservingReplayCapsule } = require(base + 'capsule-materialization');
  const read = name => fs.readFileSync('/work/' + name, 'utf8');
  const capsule = read('capsule.json'), expected = JSON.parse(read('expected.json'));
  const worktree = JSON.parse(read('worktree.json')), bindings = JSON.parse(read('bindings.json'));
  const plan = planRetainedCaffInitialization(capsule, expected, worktree, bindings);
  assert.equal(plan.receipt.deliveryMode, mode);
  const material = planModePreservingReplayCapsule(capsule, expected);
  const working = planWorktreeReplayMaterialization(capsule, expected, worktree);
  assert.equal(typeof bridgeProbe, 'boolean');
  let runtime, callback, callbackAdapter, modelCalls = 0, externalFetchCalls = 0;
  const modelGuards = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!callback || u.origin !== callback.apiUrl) { externalFetchCalls++; throw Error('external_fetch_forbidden'); }
    return originalFetch(input, options);
  };
  try {
    assert.deepEqual(materializeWorktreeReplayInputs(capsule, expected, worktree, '/work/restored'), working.expectedReceipt);
    assert.equal(read('restored/working-inputs/prompt.txt'), plan.invocation);
    if (plan.config.resume) assert.equal(fs.readFileSync(plan.config.sessionPath, 'utf8'), plan.sessionText);
    else {
      assert.equal(fs.existsSync('/work/restored/working-inputs/session.jsonl'), false);
      // lstat, not exists(): even a dangling link must not be accepted as new.
      // This is an exclusively created variant directory, never the source path.
      if (plan.config.sessionPath) {
        let absent = false;
        try { fs.lstatSync(plan.config.sessionPath); } catch (e) { if (e.code === 'ENOENT') absent = true; else throw e; }
        assert.equal(absent, true);
      }
    }
    if (bridgeProbe) {
      assert.equal(plan.archivedHarness.toolBridgeEnabled, true);
      callbackAdapter = require('./retained-caff-callback.cjs');
      callback = await callbackAdapter.startRetainedCaffCallback(capsule, expected, JSON.parse(read('bridge-association.json')), originalFetch);
    }
    process.env.PI_OFFLINE = '1'; process.env.PI_CODING_AGENT_DIR = plan.config.agentDir; process.env.PI_TELEMETRY = '0';
    const sdk = await loadModule('/work/runtime/dist/bundle/index.js'); assert.equal(sdk.VERSION, '0.85.1');
    // Cover service construction and factory/extension initialization, not just
    // the returned runtime. This is a pinned-SDK diagnostic, not a network audit:
    // module top-level code and direct provider/child-process APIs remain outside
    // this counter and are isolated by Docker network=none and credential gates.
    for (const name of ['stream', 'complete', 'streamSimple', 'completeSimple', 'streamDeferred', 'fetchDeferred', 'cancelDeferred']) {
      const prototype = sdk.ModelRuntime.prototype, descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      assert.equal(typeof descriptor?.value, 'function');
      modelGuards.push({ prototype, name, descriptor });
      Object.defineProperty(prototype, name, { ...descriptor, value: () => { modelCalls++; throw Error('model_forbidden'); } });
    }
    // The pinned SDK's context builder is the reference, not a hand-written
    // linear-history projection. No open() on a missing session or fresh fallback.
    const history = plan.config.resume ? sdk.buildSessionContext(plan.sessionEntries.slice(1)).messages : [];
    const host = await loadModule('/work/build/lib/pi-sdk-host.mjs');
    const command = host.normalizeStartCommand({ type: 'start', prompt: plan.invocation, config: plan.config });
    assert.deepEqual(command.config, plan.config); assert.equal(command.prompt, plan.invocation);
    ({ runtime } = await host.createSdkRuntime(sdk, command.config));
    const session = runtime.session, errors = [];
    if (plan.config.sessionPath) assert.equal(session.sessionFile, plan.config.sessionPath);
    await session.bindExtensions({ mode: 'json', onError: () => errors.push(true) });
    assert.equal(runtime.modelFallbackMessage, undefined);
    assert.equal(session.model.provider, plan.config.provider); assert.equal(session.model.id, plan.config.model);
    assert.deepEqual(session.messages, history);
    if (plan.config.resume) assert.equal(session.sessionId, plan.sessionEntries[0].id);
    const loader = runtime.services.resourceLoader;
    assert.equal(loader.getExtensions().errors.length, 0);
    // Observe loaded resources, not just their presence on disk. Project SYSTEM
    // precedence is retained, but its selected source must be archived too.
    const archivedAt = p => material.files.find(f => f.path === 'snapshot/' + p.slice('/work/restored/snapshot/'.length));
    const rolePath = loader.getSystemPromptSource()?.path;
    assert.ok(typeof rolePath === 'string' && rolePath.startsWith('/work/restored/snapshot/'));
    const role = archivedAt(rolePath); assert.ok(role);
    const roleText = role.bytes.toString('utf8').replace(/^\uFEFF/, '');
    assert.equal(loader.getSystemPrompt(), roleText);
    assert.ok(session.agent.state.systemPrompt.includes(roleText.trim()));
    const archivedSettings = JSON.parse(archivedAt(plan.config.agentDir + '/settings.json').bytes);
    const contains = (actual, expected) => {
      if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
        assert.ok(actual && typeof actual === 'object' && !Array.isArray(actual));
        for (const key of Object.keys(expected)) { assert.ok(Object.hasOwn(actual, key)); contains(actual[key], expected[key]); }
      } else assert.deepEqual(actual, expected);
    };
    // SDK may add default-model fields to this variant's settings; supplied
    // archived global keys must still be observed. This is not a claim about
    // every key's downstream effect or arbitrary settings migrations.
    contains(session.settingsManager.getGlobalSettings(), archivedSettings);
    if (callback) {
      await callbackAdapter.probeRetainedCaffTools(session, plan.config, callback);
      assert.deepEqual(session.messages, history); // direct probe must not invent a model turn
    }
    assert.deepEqual(errors, []); assert.equal(modelCalls, 0); assert.equal(externalFetchCalls, 0);
    // Only archive materials are immutable: SDK session/settings changes belong
    // to this variant's working copy. Never mutate or unpin the retained source.
    for (const f of material.files.filter(f => f.path.startsWith('materials/'))) {
      assert.deepEqual(fs.readFileSync('/work/restored/' + f.path), f.bytes);
    }
    assert.equal(read('capsule.json'), capsule);
    const observation = { historyHash: hash(JSON.stringify(session.messages)), historyMessages: session.messages.length,
      systemPromptHash: hash(session.agent.state.systemPrompt), toolsHash: hash(JSON.stringify(session.agent.state.tools.map(t => t.name).sort())) };
    return { ...plan.receipt, kind: 'retained-caff-initialization-v1', sdkInitialized: true,
      initializationOnly: true, productionRuntimeFactory: true, fileModePreserved: true,
      historyVerified: true, archivedMaterialsUnchanged: true, archivedResourcesVerified: true, modelGuardBeforeFactory: true,
      callbackWired: false, controlledReplacementsApplied: false,
      invocationSubmitted: false, modelCalls, externalFetchCalls,
      nodeVersion: image.nodeVersion, architecture: image.architecture, inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash,
      dependencyHash: hash(JSON.stringify(manifest.files.filter(f => f.path.startsWith('node_modules/')))),
      ...(callback ? { kind: 'retained-caff-bridge-probe-v1', initializationOnly: false, bridgeProbeOnly: true,
        callbackWired: true, callbackToolsVerified: true, callbackClosed: true, runtimeBridgeReplacementsApplied: true,
        callbackInputHash: callback.plan.receipt.callbackInputHash,
        callbackAssociationHash: hash(JSON.stringify(callback.plan.callbackInput.association)),
        runtimeBridgeReplacementsHash: callbackAdapter.bridgeReplacementsHash } : {}), observation };
  } finally {
    try { await runtime?.dispose(); }
    finally {
      try { await callback?.stop(); }
      finally {
        for (const { prototype, name, descriptor } of modelGuards.reverse()) Object.defineProperty(prototype, name, descriptor);
        globalThis.fetch = originalFetch;
        for (const key of ['PI_OFFLINE', 'PI_CODING_AGENT_DIR', 'PI_TELEMETRY']) delete process.env[key];
        assert.equal(modelCalls, 0); assert.equal(externalFetchCalls, 0);
      }
    }
  }
}
if (require.main === module) runRetainedCaffContainer().then(r => console.log(JSON.stringify(r))).catch(() => {
  process.stderr.write('retained_caff_initialization_failed\n'); process.exitCode = 1;
});
module.exports = { runRetainedCaffContainer };
