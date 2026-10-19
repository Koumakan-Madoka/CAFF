// CONTAINER ONLY. Consume actual capsule/config, never a synthetic replacement.
// Initialization ONLY: no prompt, tools, callback context, credentials or model run.
const fs = require('node:fs'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
async function runRetainedCaffContainer(loadModule = specifier => import(specifier)) {
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
  let runtime, modelCalls = 0, externalFetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { externalFetchCalls++; throw Error('external_fetch_forbidden'); };
  try {
    assert.deepEqual(materializeWorktreeReplayInputs(capsule, expected, worktree, '/work/restored'), working.expectedReceipt);
    assert.equal(read('restored/working-inputs/prompt.txt'), plan.invocation);
    if (plan.config.resume) assert.equal(fs.readFileSync(plan.config.sessionPath, 'utf8'), plan.sessionText);
    else assert.equal(fs.existsSync('/work/restored/working-inputs/session.jsonl'), false);
    process.env.PI_OFFLINE = '1'; process.env.PI_CODING_AGENT_DIR = plan.config.agentDir; process.env.PI_TELEMETRY = '0';
    const sdk = await loadModule('/work/runtime/dist/bundle/index.js'); assert.equal(sdk.VERSION, '0.85.1');
    // The pinned SDK's context builder is the reference, not a hand-written
    // linear-history projection. No open() on a missing session or fresh fallback.
    const history = plan.config.resume ? sdk.buildSessionContext(plan.sessionEntries.slice(1)).messages : [];
    const host = await loadModule('/work/build/lib/pi-sdk-host.mjs');
    const command = host.normalizeStartCommand({ type: 'start', prompt: plan.invocation, config: plan.config });
    assert.deepEqual(command.config, plan.config); assert.equal(command.prompt, plan.invocation);
    ({ runtime } = await host.createSdkRuntime(sdk, command.config));
    runtime.services.modelRuntime.streamSimple = () => { modelCalls++; throw Error('model_forbidden'); };
    const session = runtime.session, errors = [];
    await session.bindExtensions({ mode: 'json', onError: () => errors.push(true) });
    assert.equal(runtime.modelFallbackMessage, undefined);
    assert.equal(session.model.provider, plan.config.provider); assert.equal(session.model.id, plan.config.model);
    assert.deepEqual(session.messages, history);
    if (plan.config.resume) assert.equal(session.sessionId, plan.sessionEntries[0].id);
    assert.equal(runtime.services.resourceLoader.getExtensions().errors.length, 0);
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
      historyVerified: true, archivedMaterialsUnchanged: true, callbackWired: false, controlledReplacementsApplied: false,
      invocationSubmitted: false, modelCalls, externalFetchCalls,
      nodeVersion: image.nodeVersion, architecture: image.architecture, inputHash: manifest.inputHash, runtimeHash: manifest.runtimeHash,
      dependencyHash: hash(JSON.stringify(manifest.files.filter(f => f.path.startsWith('node_modules/')))), observation };
  } finally {
    try { await runtime?.dispose(); }
    finally {
      globalThis.fetch = originalFetch;
      for (const key of ['PI_OFFLINE', 'PI_CODING_AGENT_DIR', 'PI_TELEMETRY']) delete process.env[key];
    }
  }
}
if (require.main === module) runRetainedCaffContainer().then(r => console.log(JSON.stringify(r))).catch(() => {
  process.stderr.write('retained_caff_initialization_failed\n'); process.exitCode = 1;
});
module.exports = { runRetainedCaffContainer };
