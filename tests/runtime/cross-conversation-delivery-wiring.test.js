const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createServerApp } = require('../../build/server/app/create-server');
const { createProjectManager } = require('../../build/lib/project-manager');
const { isolateExternalIntegrations } = require('../helpers/external-integrations');
const { withTempDir } = require('../helpers/temp-dir');

isolateExternalIntegrations();

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('server composition shares delivery service, wires worker adapters, maintenance, broadcasts, and cleanup', async (t) => {
  const tempDir = withTempDir('caff-cross-delivery-wiring-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const broadcasts = [];
  const serviceCalls = [];
  let serviceOptions = null;
  let workerOptions = null;
  let maintenanceCallback = null;
  let clearedTimer = null;
  let recoverCount = 0;
  let responseRecoveryCount = 0;
  let deadlineCount = 0;
  let processNextCount = 0;
  const maintenanceTimer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const canonicalResult = {
    duplicate: false,
    delivery: {
      id: 'delivery-wiring-1',
      sourceConversationId: 'delivery-wiring-source',
      targetConversationId: 'delivery-wiring-target',
      targetAgentId: 'delivery-wiring-target-agent',
      dispatchStatus: 'queued',
      responseStatus: 'not_expected',
    },
    targetMessage: {
      id: 'delivery-wiring-target-message',
      conversationId: 'delivery-wiring-target',
    },
    sourceReceipt: {
      id: 'delivery-wiring-source-receipt',
      conversationId: 'delivery-wiring-source',
    },
  };
  const deliveryService = {
    submitFromAgent(principal, input) {
      serviceCalls.push({ principal, input });
      return canonicalResult;
    },
  };
  const deliveryWorker = {
    recoverExpiredClaims() {
      recoverCount += 1;
      return { requeuedDeliveryIds: [], failedUnknownDeliveryIds: [] };
    },
    recoverPendingResponses() {
      responseRecoveryCount += 1;
      return [];
    },
    expireRequestDeadlines() {
      deadlineCount += 1;
      return [];
    },
    async processNext() {
      processNextCount += 1;
      return null;
    },
  };
  const app = createServerApp({
    host: '127.0.0.1',
    port: 0,
    agentDir: tempDir,
    sqlitePath,
    projectDir: tempDir,
    onBroadcastEvent(eventName, payload) {
      broadcasts.push({ eventName, payload });
    },
    deliveryServiceFactory(options) {
      serviceOptions = options;
      return deliveryService;
    },
    deliveryWorkerFactory(options) {
      workerOptions = options;
      return deliveryWorker;
    },
    setDeliveryMaintenanceInterval(callback) {
      maintenanceCallback = callback;
      return maintenanceTimer;
    },
    clearDeliveryMaintenanceInterval(timer) {
      clearedTimer = timer;
    },
  });
  let closed = false;

  t.after(async () => {
    if (!closed) {
      await new Promise((resolve) => app.close(resolve));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const sourceAgent = app.store.saveCustomRoleConfig({
    id: 'delivery-wiring-source-agent',
    name: 'Source Agent',
    personaPrompt: 'Source.',
  });
  const targetAgent = app.store.saveCustomRoleConfig({
    id: 'delivery-wiring-target-agent',
    name: 'Target Agent',
    personaPrompt: 'Target.',
  });
  app.store.createConversation({
    id: canonicalResult.delivery.sourceConversationId,
    title: 'Source',
    participants: [sourceAgent.id],
  });
  app.store.createConversation({
    id: canonicalResult.delivery.targetConversationId,
    title: 'Target',
    participants: [targetAgent.id],
  });

  assert.ok(serviceOptions);
  assert.ok(workerOptions);
  assert.equal(app.crossConversationDeliveryService, deliveryService);

  const invocation = app.agentToolBridge.registerInvocation(
    app.agentToolBridge.createInvocationContext({
      conversationId: canonicalResult.delivery.sourceConversationId,
      turnId: 'delivery-wiring-turn',
      projectDir: tempDir,
      agentId: sourceAgent.id,
      agentName: sourceAgent.name,
      conversationAgents: [sourceAgent],
    })
  );
  const bridgeResponse = app.agentToolBridge.handleConversationNotify({
    invocationId: invocation.invocationId,
    callbackToken: invocation.callbackToken,
    targetConversationId: canonicalResult.delivery.targetConversationId,
    targetAgentId: targetAgent.id,
    content: 'Notify target.',
    idempotencyKey: 'delivery-wiring-notify',
  });
  assert.equal(bridgeResponse.delivery.id, canonicalResult.delivery.id);
  assert.equal(serviceCalls.length, 1);

  let dispatchedInput = null;
  app.turnOrchestrator.dispatchCrossConversationDelivery = async (input) => {
    dispatchedInput = input;
    return { replyMessage: null };
  };
  const dispatchResult = await workerOptions.dispatchTarget({ delivery: canonicalResult.delivery });
  assert.deepEqual(dispatchResult, { replyMessage: null });
  assert.equal(dispatchedInput.delivery.id, canonicalResult.delivery.id);

  let stoppedInput = null;
  app.turnOrchestrator.requestStopCrossConversationDelivery = (delivery, reason) => {
    stoppedInput = { delivery, reason };
    return true;
  };
  assert.equal(await workerOptions.stopTarget(canonicalResult.delivery), true);
  assert.equal(stoppedInput.delivery.id, canonicalResult.delivery.id);

  await new Promise((resolve) => app.start(resolve));
  await nextTurn();
  assert.equal(recoverCount, 1);
  assert.equal(responseRecoveryCount, 1);
  assert.equal(processNextCount >= 1, true);
  assert.equal(maintenanceTimer.unrefCalled, true);

  const processCountBeforeSubmit = processNextCount;
  serviceOptions.onDeliveryPersisted(canonicalResult);
  await nextTurn();
  assert.equal(processNextCount > processCountBeforeSubmit, true);
  assert.equal(broadcasts.some((event) => event.eventName === 'conversation_message_created'
    && event.payload.message.id === canonicalResult.targetMessage.id), true);
  assert.equal(broadcasts.some((event) => event.eventName === 'conversation_message_created'
    && event.payload.message.id === canonicalResult.sourceReceipt.id), true);
  assert.equal(broadcasts.filter((event) => event.eventName === 'cross_conversation_delivery_updated'
    && event.payload.delivery.id === canonicalResult.delivery.id).length >= 2, true);

  const responseMessage = {
    id: 'delivery-wiring-response-message',
    conversationId: canonicalResult.delivery.sourceConversationId,
  };
  workerOptions.onDeliveryChanged({
    delivery: {
      ...canonicalResult.delivery,
      dispatchStatus: 'completed',
      responseStatus: 'received',
    },
    reason: 'response_persisted',
    response: { responseMessage },
  });
  assert.equal(broadcasts.some((event) => event.eventName === 'conversation_message_created'
    && event.payload.message.id === responseMessage.id), true);

  assert.equal(typeof maintenanceCallback, 'function');
  maintenanceCallback();
  await nextTurn();
  assert.equal(recoverCount, 2);
  assert.equal(responseRecoveryCount, 2);
  assert.equal(deadlineCount, 1);

  await new Promise((resolve) => app.close(resolve));
  closed = true;
  assert.equal(clearedTimer, maintenanceTimer);
});

test('server composition dispatches DAG scheduler deliveries directly and skips the serial drain', async (t) => {
  const tempDir = withTempDir('caff-dag-direct-dispatch-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const directDispatched = [];
  let processNextCount = 0;
  let dagOptions = null;
  const deliveryWorker = {
    recoverExpiredClaims() {
      return { requeuedDeliveryIds: [], failedUnknownDeliveryIds: [] };
    },
    recoverPendingResponses() {
      return [];
    },
    expireRequestDeadlines() {
      return [];
    },
    async processNext() {
      processNextCount += 1;
      return null;
    },
    async processDeliveryById(deliveryId) {
      directDispatched.push(deliveryId);
      return null;
    },
  };
  const app = createServerApp({
    host: '127.0.0.1',
    port: 0,
    agentDir: tempDir,
    sqlitePath,
    projectDir: tempDir,
    crossConversationDeliveryWorker: deliveryWorker,
    dagSchedulerFactory(options) {
      dagOptions = options;
      return {
        handleEvent() {},
        resolveConversationWorkdir() {
          return null;
        },
        async reconcileOnStartup() {},
      };
    },
  });
  let closed = false;

  t.after(async () => {
    if (!closed) {
      await new Promise((resolve) => app.close(() => resolve()));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  assert.ok(dagOptions, 'dag scheduler wiring options captured');

  const projectManager = createProjectManager({ agentDir: tempDir });
  const project = projectManager.listProjects()[0];
  assert.ok(project && project.id, 'project auto-registered for projectDir');

  const agent = app.store.saveCustomRoleConfig({
    id: 'dag-wiring-agent',
    name: 'DAG Wiring Agent',
    personaPrompt: 'Run node work.',
  });
  app.store.createConversation({
    id: 'dag-wiring-owner',
    title: 'DAG Owner',
    participants: [agent.id],
  });
  app.store.db.prepare(`
    UPDATE chat_conversations SET project_scope_id = ? WHERE id = ?
  `).run(project.id, 'dag-wiring-owner');

  // Spawn path: the bootstrap delivery must go straight to processDeliveryById.
  const spawned = await dagOptions.spawnNodeConversation({
    ownerConversationId: 'dag-wiring-owner',
    node: { id: 'n1', title: 'Node One' },
    initialMessage: 'Complete node one.',
    clientRequestId: 'dag-node:plan-1:n1:ts',
  });
  assert.ok(spawned.conversationId, 'child conversation spawned');
  const spawnBundle = app.store.getCrossConversationDeliveryBundleByIdempotency(
    'operator:dag-wiring-owner:conversation_spawn',
    'dag-node:plan-1:n1:ts'
  );
  assert.ok(spawnBundle && spawnBundle.delivery, 'bootstrap delivery persisted');
  assert.deepEqual(directDispatched, [spawnBundle.delivery.id]);
  assert.equal(processNextCount, 0, 'serial drain never claimed the DAG bootstrap');

  // Resume path (D25): the notify delivery is also dispatched directly.
  const child = app.store.getConversation(spawned.conversationId);
  await dagOptions.resumeNodeConversation({
    ownerConversationId: 'dag-wiring-owner',
    conversation: child,
    node: { id: 'n1' },
    content: 'Continue node one.',
    idempotencyKey: 'dag-resume:plan-1:n1:ts',
  });
  const resumeBundle = app.store.getCrossConversationDeliveryBundleByIdempotency(
    'system:dag-wiring-owner:conversation_notify',
    'dag-resume:plan-1:n1:ts'
  );
  assert.ok(resumeBundle && resumeBundle.delivery, 'resume delivery persisted');
  assert.deepEqual(directDispatched, [spawnBundle.delivery.id, resumeBundle.delivery.id]);
  assert.equal(processNextCount, 0, 'serial drain never claimed the DAG resume');

  // Negative control: a non-DAG delivery still flows through the serial drain.
  app.crossConversationDeliveryService.submitFromSystem({
    sourceConversationId: 'dag-wiring-owner',
    targetConversationId: spawned.conversationId,
    targetAgentId: agent.id,
    content: 'Manual notify still drains serially.',
    idempotencyKey: 'manual-notify-1',
  });
  await nextTurn();
  await nextTurn();
  assert.equal(processNextCount >= 1, true, 'non-DAG delivery still triggers the drain');
  assert.equal(directDispatched.length, 2, 'non-DAG delivery was not directly dispatched');

  await new Promise((resolve) => app.close(() => resolve()));
  closed = true;
});
