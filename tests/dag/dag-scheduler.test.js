const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createDagScheduler } = require('../../build/server/domain/dag/dag-scheduler');
const { withTempDir } = require('../helpers/temp-dir');

const ROOT_ID = 'root-conversation';

function createStore(t, prefix = 'caff-dag-scheduler-') {
  const tempDir = withTempDir(prefix);
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return store;
}

function createRoot(store, id = ROOT_ID) {
  const conversation = store.createConversation({ id, title: 'Root', participants: ['role-family-gpt'] });
  store.bindConversationProjectScope(id, 'proj-test');
  return conversation;
}

function createChildConversation(store, id, originId = ROOT_ID) {
  return store.conversationRepository.create({
    id,
    title: `Child ${id}`,
    type: 'standard',
    metadataJson: '{}',
    parentConversationId: originId,
    originConversationId: originId,
    treeDepth: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function addMessage(store, payload) {
  return store.messageRepository.create({
    id: payload.id,
    conversationId: payload.conversationId,
    turnId: payload.turnId || `turn-${payload.id}`,
    role: payload.role || 'user',
    agentId: payload.agentId || null,
    senderName: payload.senderName || 'You',
    content: payload.content || '',
    status: payload.status || 'completed',
    errorMessage: payload.errorMessage || null,
    metadataJson: JSON.stringify(payload.metadata || {}),
    createdAt: payload.createdAt || new Date().toISOString(),
  });
}

function makeDoc(nodes) {
  return { nodes };
}

function node(id, overrides = {}) {
  return {
    id,
    title: `Node ${id}`,
    goal: `goal of ${id}`,
    status: 'pending',
    depends_on: [],
    branch: `dag/${id}`,
    kind: 'work',
    ...overrides,
  };
}

function createActivePlan(store, doc) {
  store.savePlanForConversation(ROOT_ID, { doc }, { actor: { type: 'user' } });
  const result = store.activatePlanForConversation(ROOT_ID, { type: 'user' });
  return result.plan;
}

/**
 * Scheduler harness with stubbed side effects. The spawn stub persists a
 * real child conversation + bootstrap initial message so completion and
 * reconcile paths can read message state from the store.
 */
function createHarness(store, overrides = {}) {
  const spawns = [];
  const resumes = [];
  const broadcasts = [];
  const prepareCalls = [];

  const scheduler = createDagScheduler({
    store,
    maxConcurrency: overrides.maxConcurrency || 3,
    logger: { error() {} },
    broadcastEvent(eventName, payload) {
      broadcasts.push({ eventName, payload });
    },
    prepareNodeWorktree(input) {
      prepareCalls.push({ nodeId: input.node.id });
      if (overrides.prepare) {
        return overrides.prepare(input);
      }
      return { ok: true, path: `/tmp/worktrees/${input.node.id}` };
    },
    async spawnNodeConversation(input) {
      if (overrides.spawnError) {
        throw new Error(overrides.spawnError);
      }
      const childId = `child-${input.node.id}`;
      createChildConversation(store, childId);
      const messageId = `bootstrap-${input.node.id}`;
      addMessage(store, {
        id: messageId,
        conversationId: childId,
        content: input.initialMessage,
        metadata: { kind: 'conversation_spawn_initial_message' },
      });
      spawns.push({
        nodeId: input.node.id,
        conversationId: childId,
        bootstrapMessageId: messageId,
        initialMessage: input.initialMessage,
        clientRequestId: input.clientRequestId,
      });
      return { conversationId: childId };
    },
    async resumeNodeConversation(input) {
      resumes.push({ nodeId: input.node.id, conversationId: input.conversation.id, content: input.content });
      // Mimic the real delivery persist: the marker message is the durable
      // D25 attempt counter.
      addMessage(store, {
        id: `resume-${input.node.id}-${resumes.length}`,
        conversationId: input.conversation.id,
        content: input.content,
        metadata: { kind: 'dag_resume', dagResume: true, dagNodeId: input.node.id },
      });
    },
    ...overrides.schedulerOptions,
  });

  return { scheduler, spawns, resumes, broadcasts, prepareCalls };
}

function getNode(store, nodeId) {
  const { plan } = store.getPlanForConversation(ROOT_ID);
  return plan.doc.nodes.find((candidate) => candidate.id === nodeId);
}

function historyFor(store, nodeId) {
  const { plan } = store.getPlanForConversation(ROOT_ID);
  return (plan.doc.history || []).filter((entry) => entry.node_id === nodeId);
}

async function flush(scheduler) {
  await scheduler.dispatchReadyNodes(ROOT_ID);
}

test('activate dispatches in-degree-0 nodes and binds spawned conversations (D13/D21)', async () => {
  const store = createStore(test);
  createRoot(store);
  const plan = createActivePlan(store, makeDoc([
    node('n1'),
    node('n2'),
    node('n3', { depends_on: ['n1', 'n2'], kind: 'merge' }),
  ]));
  const { scheduler, spawns, broadcasts } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);

  assert.equal(spawns.length, 2);
  assert.deepEqual(spawns.map((spawn) => spawn.nodeId), ['n1', 'n2']);
  assert.ok(spawns[0].initialMessage.includes('goal of n1'));
  assert.ok(spawns[0].clientRequestId.includes('dag-node:'));

  assert.equal(getNode(store, 'n1').status, 'doing');
  assert.equal(getNode(store, 'n1').spawned_conversation_id, 'child-n1');
  assert.equal(getNode(store, 'n2').status, 'doing');
  assert.equal(getNode(store, 'n3').status, 'pending'); // deps not done yet
  assert.equal(getNode(store, 'n3').spawned_conversation_id || null, null);

  const history = historyFor(store, 'n1');
  assert.equal(history.length, 1);
  assert.equal(history[0].from, 'pending');
  assert.equal(history[0].to, 'doing');
  assert.equal(history[0].actor, 'system');
  assert.equal(history[0].reason, 'dag_dispatch');

  assert.ok(broadcasts.some((entry) => entry.eventName === 'conversation_plan_updated'));
});

test('D24 concurrency cap holds and freed slots are refilled FIFO in doc order', async () => {
  const store = createStore(test);
  createRoot(store);
  const plan = createActivePlan(store, makeDoc([node('a'), node('b'), node('c'), node('d')]));
  const { scheduler, spawns } = createHarness(store, { maxConcurrency: 2 });

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);

  assert.deepEqual(spawns.map((spawn) => spawn.nodeId), ['a', 'b']);
  assert.equal(getNode(store, 'c').status, 'pending');
  assert.equal(getNode(store, 'd').status, 'pending');

  // Free one slot: node a completes.
  scheduler.handleEvent('agent_slot_finished', {
    conversationId: 'child-a',
    slot: { sourceMessageId: 'bootstrap-a', status: 'completed', finalContent: 'a done' },
  });
  await flush(scheduler);

  assert.equal(getNode(store, 'a').status, 'done');
  assert.equal(getNode(store, 'a').result, 'a done');
  assert.deepEqual(spawns.map((spawn) => spawn.nodeId), ['a', 'b', 'c']);
  assert.equal(getNode(store, 'c').status, 'doing');
  assert.equal(getNode(store, 'd').status, 'pending');
});

test('completion write-back carries result and unblocks downstream (D23)', async () => {
  const store = createStore(test);
  createRoot(store);
  const plan = createActivePlan(store, makeDoc([
    node('n1'),
    node('n2', { depends_on: ['n1'] }),
  ]));
  const { scheduler, spawns } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);
  assert.equal(spawns.length, 1);

  scheduler.handleEvent('agent_slot_finished', {
    conversationId: 'child-n1',
    slot: { sourceMessageId: 'bootstrap-n1', status: 'completed', finalContent: 'n1 产出摘要' },
  });
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'done');
  assert.equal(getNode(store, 'n1').result, 'n1 产出摘要');
  assert.equal(getNode(store, 'n2').status, 'doing');
  assert.equal(spawns.length, 2);
  assert.ok(spawns[1].initialMessage.includes('n1 产出摘要'), 'downstream instruction embeds upstream result (D23)');

  const doneHistory = historyFor(store, 'n1').map((entry) => `${entry.from}->${entry.to}:${entry.reason}`);
  assert.deepEqual(doneHistory, ['pending->doing:dag_dispatch', 'doing->done:dag_node_completed']);
});

test('post-bind settle: child already terminal before doing binding completes immediately (spawn→bind race)', async () => {
  const store = createStore(test);
  createRoot(store);
  const plan = createActivePlan(store, makeDoc([node('n1')]));
  const { scheduler, spawns } = createHarness(store, {
    schedulerOptions: {
      async spawnNodeConversation(input) {
        const childId = `child-${input.node.id}`;
        createChildConversation(store, childId);
        const messageId = `bootstrap-${input.node.id}`;
        addMessage(store, {
          id: messageId,
          conversationId: childId,
          content: input.initialMessage,
          metadata: { kind: 'conversation_spawn_initial_message' },
        });
        // Terminal reply lands BEFORE the scheduler binds doing — the
        // agent_slot_finished event has effectively fired into the void.
        addMessage(store, {
          id: `reply-${input.node.id}`,
          conversationId: childId,
          role: 'assistant',
          agentId: 'role-family-gpt',
          content: 'instant result',
          status: 'completed',
          metadata: { triggeredByMessageId: messageId },
        });
        spawns.push({ nodeId: input.node.id, conversationId: childId, bootstrapMessageId: messageId });
        return { conversationId: childId };
      },
    },
  });

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'done', 'must not stay doing forever');
  assert.equal(getNode(store, 'n1').result, 'instant result');
  const transitions = historyFor(store, 'n1').map((entry) => `${entry.from}->${entry.to}:${entry.reason}`);
  assert.deepEqual(transitions, ['pending->doing:dag_dispatch', 'doing->done:dag_dispatch_settled_completed']);
});

test('failed slot flips the node blocked and fail-closed keeps downstream pending (D16)', async () => {
  const store = createStore(test);
  createRoot(store);
  const plan = createActivePlan(store, makeDoc([
    node('n1'),
    node('n2', { depends_on: ['n1'] }),
  ]));
  const { scheduler, spawns } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);

  scheduler.handleEvent('agent_slot_finished', {
    conversationId: 'child-n1',
    slot: { sourceMessageId: 'bootstrap-n1', status: 'failed', errorMessage: 'model exploded' },
  });
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'blocked');
  assert.equal(getNode(store, 'n2').status, 'pending');
  assert.equal(spawns.length, 1, 'downstream must not be spawned');

  const blockedEntry = historyFor(store, 'n1').find((entry) => entry.to === 'blocked');
  assert.ok(blockedEntry.reason.includes('model exploded'));
});

test('dirty worktree fails closed: node blocked, siblings still dispatch (D22)', async () => {
  const store = createStore(test);
  createRoot(store);
  const plan = createActivePlan(store, makeDoc([node('n1'), node('n2')]));
  const { scheduler, spawns } = createHarness(store, {
    prepare(input) {
      return input.node.id === 'n1'
        ? { ok: false, error: 'dag_worktree_dirty: uncommitted changes' }
        : { ok: true, path: '/tmp/wt' };
    },
  });

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'blocked');
  assert.equal(getNode(store, 'n1').spawned_conversation_id || null, null);
  assert.equal(getNode(store, 'n2').status, 'doing');
  assert.deepEqual(spawns.map((spawn) => spawn.nodeId), ['n2']);
  assert.ok(historyFor(store, 'n1')[0].reason.includes('dag_worktree_failed'));
});

test('spawn failure flips the node blocked with the reason recorded', async () => {
  const store = createStore(test);
  createRoot(store);
  const plan = createActivePlan(store, makeDoc([node('n1')]));
  const { scheduler } = createHarness(store, { spawnError: 'source conversation unbound' });

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'blocked');
  assert.ok(historyFor(store, 'n1')[0].reason.includes('dag_spawn_failed'));
  assert.ok(historyFor(store, 'n1')[0].reason.includes('source conversation unbound'));
});

test('stray slot events are ignored: unknown conversation and non-DAG source message', async () => {
  const store = createStore(test);
  createRoot(store);
  const plan = createActivePlan(store, makeDoc([node('n1')]));
  const { scheduler } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);
  assert.equal(getNode(store, 'n1').status, 'doing');

  // Unknown conversation — must not throw.
  scheduler.handleEvent('agent_slot_finished', {
    conversationId: 'no-such-conversation',
    slot: { sourceMessageId: 'x', status: 'completed' },
  });
  // Right conversation, but a source message the scheduler never injected.
  scheduler.handleEvent('agent_slot_finished', {
    conversationId: 'child-n1',
    slot: { sourceMessageId: 'some-stray-message', status: 'completed', finalContent: 'stray' },
  });
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'doing');
});

test('non-active plan events are ignored', async () => {
  const store = createStore(test);
  createRoot(store);
  store.savePlanForConversation(ROOT_ID, { doc: makeDoc([node('n1')]) }, { actor: { type: 'user' } });
  const { plan } = store.getPlanForConversation(ROOT_ID);
  const { scheduler, spawns } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);

  assert.equal(spawns.length, 0);
  assert.equal(getNode(store, 'n1').status, 'pending');
});

test('reconcile writes back finished children and propagates downstream (D25)', async () => {
  const store = createStore(test);
  createRoot(store);
  createActivePlan(store, makeDoc([
    node('n1'),
    node('n2', { depends_on: ['n1'] }),
  ]));
  // Simulate a torn run: n1 doing with a spawned child that finished.
  store.writePlanNodeExecution(ROOT_ID, [{ nodeId: 'n1', status: 'doing', spawnedConversationId: 'child-n1' }]);
  createChildConversation(store, 'child-n1');
  addMessage(store, {
    id: 'bootstrap-n1',
    conversationId: 'child-n1',
    metadata: { kind: 'conversation_spawn_initial_message' },
  });
  addMessage(store, {
    id: 'reply-n1',
    conversationId: 'child-n1',
    role: 'assistant',
    agentId: 'role-family-gpt',
    senderName: 'GPT',
    content: 'reconcile result summary',
    status: 'completed',
    metadata: { triggeredByMessageId: 'bootstrap-n1' },
  });

  const { scheduler, spawns } = createHarness(store);
  await scheduler.reconcileOnStartup();

  assert.equal(getNode(store, 'n1').status, 'done');
  assert.equal(getNode(store, 'n1').result, 'reconcile result summary');
  assert.equal(getNode(store, 'n2').status, 'doing', 'downstream dispatched after reconcile write-back');
  assert.deepEqual(spawns.map((spawn) => spawn.nodeId), ['n2']);
  assert.ok(historyFor(store, 'n1').some((entry) => entry.reason === 'dag_reconcile_completed'));
});

test('reconcile blocks nodes whose child finished failed (D25)', async () => {
  const store = createStore(test);
  createRoot(store);
  createActivePlan(store, makeDoc([node('n1')]));
  store.writePlanNodeExecution(ROOT_ID, [{ nodeId: 'n1', status: 'doing', spawnedConversationId: 'child-n1' }]);
  createChildConversation(store, 'child-n1');
  addMessage(store, {
    id: 'bootstrap-n1',
    conversationId: 'child-n1',
    metadata: { kind: 'conversation_spawn_initial_message' },
  });
  addMessage(store, {
    id: 'reply-n1',
    conversationId: 'child-n1',
    role: 'assistant',
    agentId: 'role-family-gpt',
    senderName: 'GPT',
    status: 'failed',
    errorMessage: 'provider timeout',
    metadata: { triggeredByMessageId: 'bootstrap-n1' },
  });

  const { scheduler } = createHarness(store);
  await scheduler.reconcileOnStartup();

  assert.equal(getNode(store, 'n1').status, 'blocked');
  assert.ok(historyFor(store, 'n1').some((entry) => (entry.reason || '').includes('provider timeout')));
});

test('reconcile resumes an interrupted child once, then blocks when the budget is spent (D25)', async () => {
  const store = createStore(test);
  createRoot(store);
  createActivePlan(store, makeDoc([node('n1')]));
  store.writePlanNodeExecution(ROOT_ID, [{ nodeId: 'n1', status: 'doing', spawnedConversationId: 'child-n1' }]);
  createChildConversation(store, 'child-n1');
  addMessage(store, {
    id: 'bootstrap-n1',
    conversationId: 'child-n1',
    metadata: { kind: 'conversation_spawn_initial_message' },
  });

  const { scheduler, resumes } = createHarness(store);
  await scheduler.reconcileOnStartup();

  assert.equal(resumes.length, 1, 'first reconcile injects one resume');
  assert.equal(resumes[0].conversationId, 'child-n1');
  assert.ok(resumes[0].content.includes('继续'));
  assert.equal(getNode(store, 'n1').status, 'doing', 'node stays doing while the resume runs');

  // Resume produced no terminal reply (interrupted again) → second reconcile
  // sees the marker message and blocks the node instead of resuming twice.
  await scheduler.reconcileOnStartup();
  assert.equal(resumes.length, 1, 'no second resume');
  assert.equal(getNode(store, 'n1').status, 'blocked');
  assert.ok(historyFor(store, 'n1').some((entry) => (entry.reason || '').includes('dag_reconcile_resume_exhausted')));
});

test('reconcile re-offers a still-queued scheduler delivery for direct dispatch instead of resuming (D25 wiring)', async () => {
  const store = createStore(test);
  createRoot(store);
  createActivePlan(store, makeDoc([node('n1')]));
  store.writePlanNodeExecution(ROOT_ID, [{ nodeId: 'n1', status: 'doing', spawnedConversationId: 'child-n1' }]);
  createChildConversation(store, 'child-n1');
  addMessage(store, {
    id: 'bootstrap-n1',
    conversationId: 'child-n1',
    metadata: { kind: 'conversation_spawn_initial_message' },
  });

  const redispatched = [];
  const { scheduler, resumes } = createHarness(store, {
    schedulerOptions: {
      dispatchQueuedNodeDelivery(input) {
        redispatched.push({ nodeId: input.node.id, conversationId: input.conversation.id });
      },
    },
  });

  // Simulate a non-terminal (still queued or in-flight) delivery that the
  // delivery worker owns — e.g. a bootstrap persisted before direct dispatch
  // existed, stranded behind the serial drain.
  const original = store.hasNonTerminalCrossConversationDelivery;
  store.hasNonTerminalCrossConversationDelivery = () => true;
  try {
    await scheduler.reconcileOnStartup();
  } finally {
    store.hasNonTerminalCrossConversationDelivery = original;
  }

  assert.deepEqual(redispatched, [{ nodeId: 'n1', conversationId: 'child-n1' }]);
  assert.equal(resumes.length, 0, 'no resume while the worker owns a delivery');
  assert.equal(getNode(store, 'n1').status, 'doing', 'node state untouched');
});

test('reconcile blocks a doing node without spawned conversation (fail-closed)', async () => {
  const store = createStore(test);
  createRoot(store);
  createActivePlan(store, makeDoc([node('n1')]));
  store.writePlanNodeExecution(ROOT_ID, [{ nodeId: 'n1', status: 'doing' }]);

  const { scheduler, spawns } = createHarness(store);
  await scheduler.reconcileOnStartup();

  assert.equal(getNode(store, 'n1').status, 'blocked');
  assert.equal(spawns.length, 0);
  assert.ok(historyFor(store, 'n1').some((entry) => (entry.reason || '').includes('dag_reconcile_orphan_doing')));
});

test('reconcile skips children with an in-flight delivery', async () => {
  const store = createStore(test);
  createRoot(store);
  createActivePlan(store, makeDoc([node('n1')]));
  store.writePlanNodeExecution(ROOT_ID, [{ nodeId: 'n1', status: 'doing', spawnedConversationId: 'child-n1' }]);
  createChildConversation(store, 'child-n1');
  addMessage(store, {
    id: 'bootstrap-n1',
    conversationId: 'child-n1',
    metadata: { kind: 'conversation_spawn_initial_message' },
  });
  store.hasNonTerminalCrossConversationDelivery = () => true;

  const { scheduler, resumes } = createHarness(store);
  await scheduler.reconcileOnStartup();

  assert.equal(resumes.length, 0, 'delivery worker owns the in-flight dispatch');
  assert.equal(getNode(store, 'n1').status, 'doing');
});

test('resolveConversationWorkdir maps spawned children to their worktree only', async () => {
  const store = createStore(test);
  createRoot(store);
  createActivePlan(store, makeDoc([node('n1')]));
  store.writePlanNodeExecution(ROOT_ID, [{ nodeId: 'n1', status: 'doing', spawnedConversationId: 'child-n1' }]);
  createChildConversation(store, 'child-n1');

  const workdirCalls = [];
  const { scheduler } = createHarness(store, {
    schedulerOptions: {
      resolveWorktreePathForNode(input) {
        workdirCalls.push({ nodeId: input.node.id });
        return `/tmp/worktrees/${input.node.id}`;
      },
    },
  });

  const child = store.getConversationWithoutMessages('child-n1');
  assert.equal(scheduler.resolveConversationWorkdir(child), '/tmp/worktrees/n1');
  assert.deepEqual(workdirCalls, [{ nodeId: 'n1' }]);

  const root = store.getConversationWithoutMessages(ROOT_ID);
  assert.equal(scheduler.resolveConversationWorkdir(root), null, 'root conversation never gets a worktree cwd');
  assert.equal(scheduler.resolveConversationWorkdir(null), null);
});

test('merge node instruction embeds source branch order and verify command (D26)', async () => {
  const store = createStore(test);
  createRoot(store);
  const plan = createActivePlan(store, makeDoc([
    node('n1', { result: 'r1' }),
    node('n2', { result: 'r2' }),
    node('m1', { depends_on: ['n1', 'n2'], kind: 'merge', branch: 'dag/integrate', verify: 'npm test' }),
  ]));
  store.writePlanNodeExecution(ROOT_ID, [
    { nodeId: 'n1', status: 'done', result: 'r1' },
    { nodeId: 'n2', status: 'done', result: 'r2' },
  ]);
  const { scheduler, spawns } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', {
    ownerConversationId: ROOT_ID,
    plan: store.getPlanForConversation(ROOT_ID).plan,
  });
  await flush(scheduler);

  assert.equal(spawns.length, 1);
  const instruction = spawns[0].initialMessage;
  assert.ok(instruction.includes('n1 → dag/n1'));
  assert.ok(instruction.indexOf('n1 → dag/n1') < instruction.indexOf('n2 → dag/n2'), 'depends_on order preserved');
  assert.ok(instruction.includes('`npm test`'));
  assert.ok(instruction.includes('merge --abort'));
  assert.equal(getNode(store, 'm1').status, 'doing');
});

test('merge node completion is gated by verifyNodeCompletion: pass → done, fail → blocked (D11/D19 fail-closed)', async () => {
  const store = createStore(test);
  createRoot(store);
  createActivePlan(store, makeDoc([
    node('n1'),
    node('n2'),
    node('m1', { depends_on: ['n1', 'n2'], kind: 'merge', branch: 'dag/integrate', verify: 'npm test' }),
    node('n3', { depends_on: ['m1'] }),
  ]));
  store.writePlanNodeExecution(ROOT_ID, [
    { nodeId: 'n1', status: 'done', result: 'r1' },
    { nodeId: 'n2', status: 'done', result: 'r2' },
  ]);

  let verdict = { ok: false, error: 'source branch "dag/n2" is not merged into the integration branch (D11)' };
  const verifyCalls = [];
  const { scheduler } = createHarness(store, {
    schedulerOptions: {
      verifyNodeCompletion(input) {
        verifyCalls.push({ nodeId: input.node.id, kind: input.node.kind });
        return verdict;
      },
    },
  });

  scheduler.handleEvent('conversation_plan_updated', {
    ownerConversationId: ROOT_ID,
    plan: store.getPlanForConversation(ROOT_ID).plan,
  });
  await flush(scheduler);
  assert.equal(getNode(store, 'm1').status, 'doing');

  // Merger agent reports completion, but the outcome check fails → blocked.
  scheduler.handleEvent('agent_slot_finished', {
    conversationId: 'child-m1',
    slot: { sourceMessageId: 'bootstrap-m1', status: 'completed', finalContent: 'merged' },
  });
  await flush(scheduler);

  assert.equal(verifyCalls.length, 1);
  assert.equal(getNode(store, 'm1').status, 'blocked');
  assert.equal(getNode(store, 'm1').result, undefined, 'blocked merge must not record a result');
  assert.equal(getNode(store, 'n3').status, 'pending', 'D16: downstream of blocked merge stays pending');
  const blockedHistory = historyFor(store, 'm1').map((entry) => `${entry.from}->${entry.to}:${entry.reason}`);
  assert.ok(blockedHistory.some((line) => line.startsWith('doing->blocked:dag_merge_verify_failed:')), JSON.stringify(blockedHistory));

  // Manual unblock + operator re-flip to doing, then a passing verdict → done.
  store.writePlanNodeExecution(ROOT_ID, [{ nodeId: 'm1', status: 'doing' }], { reason: 'manual retry after fixing merge' });
  verdict = { ok: true };
  scheduler.handleEvent('agent_slot_finished', {
    conversationId: 'child-m1',
    slot: { sourceMessageId: 'bootstrap-m1', status: 'completed', finalContent: 'merged for real' },
  });
  await flush(scheduler);

  assert.equal(verifyCalls.length, 2);
  assert.equal(getNode(store, 'm1').status, 'done');
  assert.equal(getNode(store, 'm1').result, 'merged for real');
  assert.equal(getNode(store, 'n3').status, 'doing', 'downstream dispatches after the merge passes verification');
});

test('verifyNodeCompletion errors fail closed (exception → blocked), and work nodes skip the hook', async () => {
  const store = createStore(test);
  createRoot(store);
  createActivePlan(store, makeDoc([
    node('n1'),
    node('m1', { depends_on: ['n1'], kind: 'merge', branch: 'dag/integrate' }),
  ]));
  const verifyCalls = [];
  const { scheduler } = createHarness(store, {
    schedulerOptions: {
      verifyNodeCompletion(input) {
        verifyCalls.push(input.node.id);
        throw new Error('worktree gone');
      },
    },
  });

  scheduler.handleEvent('conversation_plan_updated', {
    ownerConversationId: ROOT_ID,
    plan: store.getPlanForConversation(ROOT_ID).plan,
  });
  await flush(scheduler);
  assert.equal(getNode(store, 'n1').status, 'doing');

  // Work node completion never invokes the merge hook.
  scheduler.handleEvent('agent_slot_finished', {
    conversationId: 'child-n1',
    slot: { sourceMessageId: 'bootstrap-n1', status: 'completed', finalContent: 'done' },
  });
  await flush(scheduler);
  assert.equal(getNode(store, 'n1').status, 'done');
  assert.equal(verifyCalls.length, 0);
  assert.equal(getNode(store, 'm1').status, 'doing');

  // Merge node completion with a throwing hook → blocked, not done.
  scheduler.handleEvent('agent_slot_finished', {
    conversationId: 'child-m1',
    slot: { sourceMessageId: 'bootstrap-m1', status: 'completed', finalContent: 'merged' },
  });
  await flush(scheduler);
  assert.equal(verifyCalls.length, 1);
  assert.equal(getNode(store, 'm1').status, 'blocked');
  const reasons = historyFor(store, 'm1').map((entry) => entry.reason || '');
  assert.ok(reasons.some((reason) => reason.includes('worktree gone')), JSON.stringify(reasons));
});
