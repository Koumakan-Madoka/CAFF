const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createDagScheduler } = require('../../build/server/domain/dag/dag-scheduler');
const {
  applySessionGoalAction,
  createSessionGoalBudgetProposal,
  getSessionGoal,
  getSessionGoalProposal,
  getSessionGoalRuling,
  proposeSessionGoalAction,
} = require('../../build/server/domain/conversation/session-goal');
const { withTempDir } = require('../helpers/temp-dir');

const ROOT_ID = 'root-conversation';
const WORKER_ID = 'role-family-gpt';
const VERIFIER_ID = 'role-family-kimi';

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

function createRoot(store, id = ROOT_ID, participants = [WORKER_ID]) {
  const conversation = store.createConversation({ id, title: 'Root', participants });
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
  const deliveries = [];

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
      if (!store.getConversationWithoutMessages(childId)) {
        createChildConversation(store, childId);
      }
      const priorSpawnsForNode = spawns.filter((entry) => entry.nodeId === input.node.id).length;
      const messageId = priorSpawnsForNode === 0
        ? `bootstrap-${input.node.id}`
        : `bootstrap-${input.node.id}-${priorSpawnsForNode + 1}`;
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
        workerId: input.workerId,
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
    async deliverNodeMessage(input) {
      // Mimic the real channel: submitFromSystem dedups by idempotency key
      // and persists the target message (with metadata) at submit time.
      if (deliveries.some((entry) => entry.idempotencyKey === input.idempotencyKey)) {
        return;
      }
      deliveries.push({
        conversationId: input.conversationId,
        targetAgentId: input.targetAgentId,
        content: input.content,
        idempotencyKey: input.idempotencyKey,
      });
      addMessage(store, {
        // Key-derived id: multiple harnesses (restart tests) share one store,
        // so a per-harness counter would collide on chat_messages.id.
        id: `delivery-${input.idempotencyKey.replace(/[^a-z0-9]+/gi, '-')}`,
        conversationId: input.conversationId,
        content: input.content,
        metadata: { ...(input.messageMetadata || {}) },
      });
    },
    ...overrides.schedulerOptions,
  });

  return { scheduler, spawns, resumes, broadcasts, prepareCalls, deliveries };
}

/** D27 completion protocol: the worker announces completion via a goal
 * complete proposal, then the scheduler event fires (as the bridge would). */
function announceComplete(store, scheduler, childId, resultText, proposerAgentId = WORKER_ID) {
  const result = proposeSessionGoalAction(
    store,
    childId,
    { action: 'complete', reason: resultText },
    { agentId: proposerAgentId, agentName: proposerAgentId },
  );
  scheduler.handleEvent('conversation_goal_proposal_updated', {
    conversationId: childId,
    goal: result.goal,
    proposal: result.proposal,
    conversation: result.conversation,
  });
  return result;
}

/** D28 verifier ruling: apply the verdict in the store (as the bridge
 * would), then fire the cleared event the scheduler subscribes to. The
 * ruling is persisted ATOMICALLY with the proposal clear (durable record)
 * — the scheduler validates that record, not just the event payload. */
function ruleOnProposal(store, scheduler, childId, verdict, reason = '', ruler = null) {
  const ruledBy = ruler || { agentId: VERIFIER_ID, agentName: VERIFIER_ID };
  const proposal = getSessionGoalProposal(store.getConversation(childId));
  const result = applySessionGoalAction(store, childId, {
    action: verdict === 'accept' ? 'accept-proposal' : 'dismiss-proposal',
    reason,
    ruledBy,
  });
  scheduler.handleEvent('conversation_goal_proposal_cleared', {
    conversationId: childId,
    outcome: verdict === 'accept' ? 'accepted' : 'rejected',
    reason,
    goal: result.goal,
    proposal,
    ruledBy,
  });
  return result;
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

function persistErrorPausedGoal(store, conversationId, timestamp = '2026-08-21T00:03:05.000Z') {
  const conversation = store.getConversationWithoutMessages(conversationId);
  const goal = getSessionGoal(conversation);
  assert.ok(goal);
  store.updateConversation(conversationId, {
    metadata: {
      ...(conversation.metadata || {}),
      sessionGoal: {
        ...goal,
        status: 'paused',
        updatedAt: timestamp,
      },
      sessionGoalRunner: {
        status: 'error_paused',
        goalUpdatedAt: timestamp,
        iteration: 3,
        maxIterations: 20,
        updatedAt: timestamp,
        consecutiveModelFailureCount: 3,
        failureStreakStartedAt: '2026-08-21T00:01:05.000Z',
        lastFailureAt: timestamp,
        lastFailureKind: 'provider',
        lastFailureCode: 'assistant_error',
        lastFailureSummary: 'insufficient balance',
        pauseReason: '连续 3 次快速模型调用失败，Goal 已自动暂停。',
        errorPausedAt: timestamp,
      },
    },
  });
}

test('error-paused goal update blocks a bound doing DAG node without a completion ruling', async () => {
  const store = createStore(test, 'caff-dag-goal-error-pause-event-');
  createRoot(store);
  const plan = createActivePlan(store, makeDoc([node('n1')]));
  const { scheduler } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);
  assert.equal(getNode(store, 'n1').status, 'doing');

  persistErrorPausedGoal(store, 'child-n1');
  scheduler.handleEvent('conversation_goal_updated', { conversationId: 'child-n1' });
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'blocked');
  assert.match(historyFor(store, 'n1').at(-1).reason, /dag_goal_model_failure_paused/u);
  assert.equal(getNode(store, 'n1').result, undefined);
});

test('startup reconcile blocks a bound DAG node whose Goal was error-paused before restart', async () => {
  const store = createStore(test, 'caff-dag-goal-error-pause-restart-');
  createRoot(store);
  const plan = createActivePlan(store, makeDoc([node('n1')]));
  const first = createHarness(store);

  first.scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(first.scheduler);
  persistErrorPausedGoal(store, 'child-n1');

  const restarted = createHarness(store);
  await restarted.scheduler.reconcileOnStartup();

  assert.equal(getNode(store, 'n1').status, 'blocked');
  assert.match(historyFor(store, 'n1').at(-1).reason, /dag_goal_model_failure_paused/u);
});

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

  // Free one slot: node a announces completion (D27) and is auto-accepted
  // (single-participant root → no verifier, D28).
  announceComplete(store, scheduler, 'child-a', 'a done');
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

  // D27: a finished turn alone no longer completes the node.
  assert.equal(getNode(store, 'n1').status, 'doing', 'turn end is not completion anymore');

  // Worker announces completion → no verifier → scheduler auto-accepts.
  announceComplete(store, scheduler, 'child-n1', 'n1 产出摘要');
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'done');
  assert.equal(getNode(store, 'n1').result, 'n1 产出摘要');
  assert.equal(getNode(store, 'n2').status, 'doing');
  assert.equal(spawns.length, 2);
  assert.ok(spawns[1].initialMessage.includes('n1 产出摘要'), 'downstream instruction embeds upstream result (D23)');

  const doneHistory = historyFor(store, 'n1').map((entry) => `${entry.from}->${entry.to}:${entry.reason}`);
  assert.deepEqual(doneHistory, ['pending->doing:dag_dispatch', 'doing->done:dag_goal_completed']);
});

test('post-bind settle: completion proposal announced before doing binding settles via auto-accept (spawn→bind race)', async () => {
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
        // Goal + worker completion PROPOSAL land BEFORE the scheduler binds
        // doing — the goal events have effectively fired into the void
        // (D27 race). The completion still goes through the D28 protocol:
        // worker proposal → (exempt) scheduler auto-accept → done.
        applySessionGoalAction(store, childId, { action: 'set', objective: 'instant race goal', checklist: [] });
        proposeSessionGoalAction(
          store,
          childId,
          { action: 'complete', reason: 'instant result' },
          { agentId: WORKER_ID, agentName: WORKER_ID },
        );
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
  assert.deepEqual(transitions, ['pending->doing:dag_dispatch', 'doing->done:dag_goal_completed']);
});

test('D28: goal complete WITHOUT a persisted worker→verifier ruling fails closed (dag_goal_completion_unverified)', async () => {
  const store = createStore(test);
  createRoot(store);
  const plan = createActivePlan(store, makeDoc([node('n1')]));
  const { scheduler } = createHarness(store, {
    schedulerOptions: {
      async spawnNodeConversation(input) {
        const childId = `child-${input.node.id}`;
        createChildConversation(store, childId);
        addMessage(store, {
          id: `bootstrap-${input.node.id}`,
          conversationId: childId,
          content: input.initialMessage,
          metadata: { kind: 'conversation_spawn_initial_message' },
        });
        // A DIRECT complete in the spawn→bind window (no worker proposal,
        // no ruling) — e.g. a UI race before the binding lands. D28: an
        // unverifiable completion must NOT settle done.
        applySessionGoalAction(store, childId, { action: 'set', objective: 'race goal', checklist: [] });
        applySessionGoalAction(store, childId, { action: 'complete' });
        return { conversationId: childId };
      },
    },
  });

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'blocked', 'unverified completion must not settle done');
  const reasons = historyFor(store, 'n1').map((entry) => entry.reason || '');
  assert.ok(reasons.some((reason) => reason.includes('dag_goal_completion_unverified')), JSON.stringify(reasons));
});

test('D27: spawn sets a lightweight session goal (no inherited default checklist)', async () => {
  const store = createStore(test);
  createRoot(store);
  const plan = createActivePlan(store, makeDoc([node('n1')]));
  const { scheduler } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);

  const goal = getSessionGoal(store.getConversation('child-n1'));
  assert.ok(goal, 'goal set on the spawned child');
  assert.equal(goal.status, 'active');
  assert.ok(goal.objective.includes('goal of n1'), 'objective carries the node goal');
  assert.ok(goal.objective.includes('suggest-goal'), 'objective teaches the completion protocol');
  assert.equal(goal.checklist, undefined, 'explicit empty checklist — heavy default NOT inherited');
});

test('D27: goal continuation budget exhaustion blocks the node', async () => {
  const store = createStore(test);
  createRoot(store);
  const plan = createActivePlan(store, makeDoc([node('n1'), node('n2', { depends_on: ['n1'] })]));
  const { scheduler, spawns } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);
  assert.equal(getNode(store, 'n1').status, 'doing');

  // Goal Runner 预算熔断：创建 pause 提案并广播（与 turn-orchestrator 同路径）
  const result = createSessionGoalBudgetProposal(store, 'child-n1', {});
  scheduler.handleEvent('conversation_goal_proposal_updated', {
    conversationId: 'child-n1',
    goal: result.goal,
    proposal: result.proposal,
    conversation: result.conversation,
  });
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'blocked');
  assert.ok(historyFor(store, 'n1').some((entry) => (entry.reason || '').includes('dag_goal_budget_exhausted')));
  assert.equal(getNode(store, 'n2').status, 'pending', 'D16: downstream stays pending');
  assert.equal(spawns.length, 1);
});

test('D28: verifier flow — proposal routes to verifier, accept settles done', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const { scheduler, deliveries } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);
  assert.equal(getNode(store, 'n1').status, 'doing');

  // Worker 宣布完工 → 不直接 done，调度器向 verifier 投递验收请求
  const announced = announceComplete(store, scheduler, 'child-n1', 'n1 完工摘要');
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'doing', 'pending verifier ruling');
  assert.equal(deliveries.length, 1, 'verification request delivered');
  assert.equal(deliveries[0].targetAgentId, VERIFIER_ID);
  assert.equal(deliveries[0].conversationId, 'child-n1');
  assert.ok(deliveries[0].content.includes('验收请求'));
  assert.ok(deliveries[0].content.includes('n1 完工摘要'), 'verifier sees the result summary');
  assert.ok(deliveries[0].idempotencyKey.startsWith('dag-verify:'));

  // Verifier 通过 → goal complete → done + result
  ruleOnProposal(store, scheduler, 'child-n1', 'accept');
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'done');
  assert.equal(getNode(store, 'n1').result, 'n1 完工摘要');
  assert.ok(announced.proposal, 'proposal existed before ruling');
  assert.deepEqual(
    historyFor(store, 'n1').map((entry) => `${entry.from}->${entry.to}:${entry.reason}`),
    ['pending->doing:dag_dispatch', 'doing->done:dag_goal_completed'],
  );
});

test('D28: verifier rejection feeds back to the worker; re-announce then accept completes', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const { scheduler, deliveries } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);

  announceComplete(store, scheduler, 'child-n1', '第一版完工');
  await flush(scheduler);
  assert.equal(deliveries.length, 1);

  // Verifier 打回 → 反馈注回 worker，goal 保持 active，节点保持 doing
  ruleOnProposal(store, scheduler, 'child-n1', 'reject', '缺少关键测试');
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'doing', 'rejection never completes the node');
  assert.equal(deliveries.length, 2, 'feedback delivered');
  assert.equal(deliveries[1].targetAgentId, WORKER_ID, 'feedback goes back to the worker');
  assert.ok(deliveries[1].content.includes('验收打回'));
  assert.ok(deliveries[1].content.includes('缺少关键测试'));
  assert.ok(deliveries[1].idempotencyKey.startsWith('dag-verify:'));
  assert.ok(deliveries[1].idempotencyKey.includes(':feedback:'), 'feedback shares the dag-verify namespace');
  const goalAfterReject = getSessionGoal(store.getConversation('child-n1'));
  assert.equal(goalAfterReject.status, 'active', 'goal keeps driving the worker');
  assert.equal(getSessionGoalProposal(store.getConversation('child-n1')), null, 'proposal dismissed');

  // Worker 改进后重新宣布 → 再次走验收 → 通过 → done（无重试上限，Q3）
  announceComplete(store, scheduler, 'child-n1', '第二版完工（补了测试）');
  await flush(scheduler);
  assert.equal(deliveries.length, 3, 'verification re-requested');
  assert.equal(deliveries[2].targetAgentId, VERIFIER_ID);

  ruleOnProposal(store, scheduler, 'child-n1', 'accept');
  await flush(scheduler);
  assert.equal(getNode(store, 'n1').status, 'done');
  assert.equal(getNode(store, 'n1').result, '第二版完工（补了测试）');
});

test('D28: explicit worker/verifier accept unique display names and bind canonical agent ids', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([
    node('n1', { worker: 'Kimi', verifier: 'GPT' }),
  ]));
  const { scheduler, spawns, deliveries } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'doing');
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].workerId, VERIFIER_ID, 'display-name worker resolves to canonical id');
  const binding = store.getConversationWithoutMessages('child-n1').metadata.dagNodeGoalBinding;
  assert.equal(binding.workerId, VERIFIER_ID);
  assert.equal(binding.verifierId, WORKER_ID);

  announceComplete(store, scheduler, 'child-n1', '显示名配置完成', VERIFIER_ID);
  await flush(scheduler);
  assert.equal(deliveries[0].targetAgentId, WORKER_ID);
});

test('D28: ambiguous participant display names fail closed before side effects', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const original = store.getConversationWithoutMessages.bind(store);
  store.getConversationWithoutMessages = (conversationId) => {
    const conversation = original(conversationId);
    if (conversationId === ROOT_ID && conversation) {
      return { ...conversation, agents: conversation.agents.map((agent) => ({ ...agent, name: 'Reviewer' })) };
    }
    return conversation;
  };
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: 'Reviewer' })]));
  const { scheduler, spawns, prepareCalls } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'blocked');
  assert.ok(historyFor(store, 'n1').some((entry) => (entry.reason || '').includes('dag_verifier_ambiguous')));
  assert.equal(spawns.length, 0);
  assert.equal(prepareCalls.length, 0);
});

test('D28: invalid or self-review verifier fails closed before any side effect', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([
    node('self', { verifier: WORKER_ID }),
    node('ghost', { verifier: 'no-such-agent' }),
  ]));
  const { scheduler, spawns, prepareCalls } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);

  assert.equal(getNode(store, 'self').status, 'blocked');
  assert.ok(historyFor(store, 'self').some((entry) => (entry.reason || '').includes('dag_verifier_self_review')));
  assert.equal(getNode(store, 'ghost').status, 'blocked');
  assert.ok(historyFor(store, 'ghost').some((entry) => (entry.reason || '').includes('dag_verifier_invalid')));
  assert.equal(spawns.length, 0, 'no child spawned for either node');
  assert.equal(prepareCalls.length, 0, 'verifier resolution runs before worktree prep');
});

test('D28: default verifier is the first participant other than the worker', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  // 不显式指定 verifier → 缺省取第一位 ≠ worker 的根会话 participant
  const plan = createActivePlan(store, makeDoc([node('n1')]));
  const { scheduler, deliveries } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);

  announceComplete(store, scheduler, 'child-n1', '默认验收路径');
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'doing');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].targetAgentId, VERIFIER_ID, 'default verifier resolved');
});

test('D25+D28: reconcile re-routes a pending completion proposal (idempotent)', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  store.writePlanNodeExecution(ROOT_ID, [{ nodeId: 'n1', status: 'doing', spawnedConversationId: 'child-n1' }]);
  createChildConversation(store, 'child-n1');
  addMessage(store, {
    id: 'bootstrap-n1',
    conversationId: 'child-n1',
    metadata: { kind: 'conversation_spawn_initial_message' },
  });
  applySessionGoalAction(store, 'child-n1', { action: 'set', objective: 'goal', checklist: [] });
  proposeSessionGoalAction(store, 'child-n1', { action: 'complete', reason: '重启前宣布完工' }, { agentId: WORKER_ID, agentName: WORKER_ID });

  const { scheduler, deliveries, resumes } = createHarness(store);
  await scheduler.reconcileOnStartup();

  assert.equal(getNode(store, 'n1').status, 'doing', 'verification still pending');
  assert.equal(deliveries.length, 1, 'verification request re-delivered after restart');
  assert.equal(deliveries[0].targetAgentId, VERIFIER_ID);
  assert.equal(resumes.length, 0, 'resume budget untouched while verification is pending');

  // 幂等：再次 reconcile 不重复投递（同一提案 → 同一幂等键）
  await scheduler.reconcileOnStartup();
  assert.equal(deliveries.length, 1);
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

  // Merger agent announces completion (D27), but the outcome check fails →
  // blocked even after the goal-level auto-accept (双层兜底, D28 + D19).
  announceComplete(store, scheduler, 'child-m1', 'merged');
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
  announceComplete(store, scheduler, 'child-m1', 'merged for real');
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
  announceComplete(store, scheduler, 'child-n1', 'done');
  await flush(scheduler);
  assert.equal(getNode(store, 'n1').status, 'done');
  assert.equal(verifyCalls.length, 0);
  assert.equal(getNode(store, 'm1').status, 'doing');

  // Merge node completion with a throwing hook → blocked, not done.
  announceComplete(store, scheduler, 'child-m1', 'merged');
  await flush(scheduler);
  assert.equal(verifyCalls.length, 1);
  assert.equal(getNode(store, 'm1').status, 'blocked');
  const reasons = historyFor(store, 'm1').map((entry) => entry.reason || '');
  assert.ok(reasons.some((reason) => reason.includes('worktree gone')), JSON.stringify(reasons));
});

test('D28 hardening: complete proposal from a non-worker blocks the node (dag_completion_wrong_proposer)', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const { scheduler, deliveries } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);
  assert.equal(getNode(store, 'n1').status, 'doing');

  // The verifier (or any non-worker participant) must not be able to
  // declare the node complete on the worker's behalf.
  announceComplete(store, scheduler, 'child-n1', '我替他宣布完工', VERIFIER_ID);
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'blocked');
  const reasons = historyFor(store, 'n1').map((entry) => entry.reason || '');
  assert.ok(reasons.some((reason) => reason.includes('dag_completion_wrong_proposer')), JSON.stringify(reasons));
  assert.equal(deliveries.length, 0, 'no verification request routed for a forged proposal');
});

test('D28 hardening: an accepted ruling from a non-verifier agent is ignored', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const { scheduler, deliveries } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);
  announceComplete(store, scheduler, 'child-n1', '完工摘要');
  await flush(scheduler);
  assert.equal(deliveries.length, 1);

  // Forge a cleared event as if a THIRD agent had accepted (the bridge
  // 403s this pre-mutation; the scheduler must still refuse to settle).
  const pendingProposal = getSessionGoalProposal(store.getConversation('child-n1'));
  scheduler.handleEvent('conversation_goal_proposal_cleared', {
    conversationId: 'child-n1',
    outcome: 'accepted',
    goal: { ...getSessionGoal(store.getConversation('child-n1')), status: 'complete' },
    proposal: pendingProposal,
    ruledBy: { agentId: 'role-family-deepseek', agentName: 'DeepSeek' },
  });
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'doing', 'forged accept never settles the node');
  assert.ok(getSessionGoalProposal(store.getConversation('child-n1')), 'proposal still pending');

  // The real verifier ruling still completes the node afterwards.
  ruleOnProposal(store, scheduler, 'child-n1', 'accept');
  await flush(scheduler);
  assert.equal(getNode(store, 'n1').status, 'done');
  assert.equal(getNode(store, 'n1').result, '完工摘要');
});

test('D28 hardening: exempt (verifierId=null) bound node never settles on bare cleared events — only on the durable ruling', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1')]));
  const { scheduler } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);
  assert.equal(getNode(store, 'n1').status, 'doing');

  // The binding says verifierId=null (exempt): its completion may only come
  // from the scheduler auto-accept or the user — and in ALL cases the
  // durable ruling record is the proof. Cleared events WITHOUT a persisted
  // mutation are forged noise: no goal complete in the store, no ruling —
  // ignored regardless of the claimed principal (even a forged
  // 'dag-scheduler' marker).
  for (const ruledBy of [undefined, { agentId: 'dag-scheduler', agentName: 'DAG Scheduler' }]) {
    scheduler.handleEvent('conversation_goal_proposal_cleared', {
      conversationId: 'child-n1',
      outcome: 'accepted',
      goal: { ...getSessionGoal(store.getConversation('child-n1')), status: 'complete' },
      proposal: { action: 'complete', reason: '伪造摘要', createdAt: new Date().toISOString() },
      ...(ruledBy ? { ruledBy } : {}),
    });
    await flush(scheduler);
    assert.equal(getNode(store, 'n1').status, 'doing', `forged event (ruledBy=${JSON.stringify(ruledBy)}) is ignored`);
  }

  // The legitimate path: worker announces → exempt auto-accept persists the
  // ruling atomically → done.
  announceComplete(store, scheduler, 'child-n1', '自动验收摘要');
  await flush(scheduler);
  assert.equal(getNode(store, 'n1').status, 'done');
  assert.equal(getNode(store, 'n1').result, '自动验收摘要');
});

test('D28 hardening: a rejected ruling from a non-verifier agent is ignored', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const { scheduler, deliveries } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);
  announceComplete(store, scheduler, 'child-n1', '完工摘要');
  await flush(scheduler);
  assert.equal(deliveries.length, 1, 'verification request routed');

  // Forge a rejection as if a THIRD agent had dismissed the proposal — the
  // scheduler must not feed bogus feedback back to the worker.
  const pendingProposal = getSessionGoalProposal(store.getConversation('child-n1'));
  scheduler.handleEvent('conversation_goal_proposal_cleared', {
    conversationId: 'child-n1',
    outcome: 'rejected',
    reason: '伪造打回',
    goal: getSessionGoal(store.getConversation('child-n1')),
    proposal: pendingProposal,
    ruledBy: { agentId: 'role-family-deepseek', agentName: 'DeepSeek' },
  });
  await flush(scheduler);

  assert.equal(deliveries.length, 1, 'forged reject delivers no feedback');
  assert.equal(getNode(store, 'n1').status, 'doing');
  assert.ok(getSessionGoalProposal(store.getConversation('child-n1')), 'proposal still pending');

  // The real verifier rejection still feeds back to the worker.
  ruleOnProposal(store, scheduler, 'child-n1', 'reject', '还差一步');
  await flush(scheduler);
  assert.equal(deliveries.length, 2, 'verifier rejection feedback delivered');
  assert.equal(deliveries[1].targetAgentId, WORKER_ID);
  assert.ok(deliveries[1].content.includes('还差一步'));
  assert.equal(getNode(store, 'n1').status, 'doing', 'rejection keeps the node doing');
});

test('D28: user UI dismiss (manual reject) feeds the feedback back to the worker', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const { scheduler, deliveries } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);
  announceComplete(store, scheduler, 'child-n1', '完工摘要');
  await flush(scheduler);
  assert.equal(deliveries.length, 1);

  // Mirror the controller path for dismiss-proposal: the user ruling is
  // persisted ATOMICALLY with the proposal clear (ruledBy { kind: 'user' }
  // is forced server-side, never client-supplied), then the cleared event
  // carries the pre-clear snapshot + user ruling marker.
  const cleared = applySessionGoalAction(store, 'child-n1', {
    action: 'dismiss-proposal',
    reason: '用户打回：补测试',
    ruledBy: { kind: 'user' },
  });
  scheduler.handleEvent('conversation_goal_proposal_cleared', {
    conversationId: 'child-n1',
    outcome: 'rejected',
    reason: '用户打回：补测试',
    goal: cleared.goal,
    proposal: cleared.clearedProposal,
    ruledBy: { kind: 'user' },
  });
  await flush(scheduler);

  assert.equal(deliveries.length, 2, 'user rejection feedback delivered');
  assert.equal(deliveries[1].targetAgentId, WORKER_ID);
  assert.ok(deliveries[1].content.includes('用户打回'));
  assert.equal(getNode(store, 'n1').status, 'doing', 'rejection keeps the node doing');
});

test('D28: user UI accept settles done with the result taken from the cleared proposal snapshot', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const { scheduler } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);
  announceComplete(store, scheduler, 'child-n1', '用户人工验收摘要');
  await flush(scheduler);

  // Mirror the controller path: the user ruling is persisted atomically
  // with the proposal clear, then the cleared event carries the pre-clear
  // proposal snapshot + an explicit user ruling marker.
  const cleared = applySessionGoalAction(store, 'child-n1', {
    action: 'accept-proposal',
    ruledBy: { kind: 'user' },
  });
  assert.ok(cleared.clearedProposal, 'cleared proposal snapshot is exposed');
  scheduler.handleEvent('conversation_goal_proposal_cleared', {
    conversationId: 'child-n1',
    outcome: 'accepted',
    goal: cleared.goal,
    proposal: cleared.clearedProposal,
    ruledBy: { kind: 'user' },
  });
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'done');
  assert.equal(getNode(store, 'n1').result, '用户人工验收摘要', 'result comes from the proposal snapshot, not a fallback');
});

/** Fabricate a scheduler-owned delivery payload with the authoritative
 * persisted fields the terminal-failure guard validates against. */
function schedulerDelivery(overrides = {}) {
  return {
    id: `delivery-${Math.random().toString(36).slice(2, 10)}`,
    principalKind: 'operator',
    idempotencyScope: `system:${ROOT_ID}:conversation_notify`,
    sourceConversationId: ROOT_ID,
    targetConversationId: 'child-n1',
    dispatchStatus: 'failed',
    ...overrides,
  };
}

test('P2: terminal failure of a scheduler delivery blocks the node (dag_delivery_failed)', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const { scheduler, deliveries } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);
  announceComplete(store, scheduler, 'child-n1', '完工摘要');
  await flush(scheduler);
  assert.equal(deliveries.length, 1);
  assert.equal(getNode(store, 'n1').status, 'doing');

  scheduler.handleEvent('cross_conversation_delivery_updated', {
    conversationId: 'child-n1',
    delivery: schedulerDelivery({ idempotencyKey: deliveries[0].idempotencyKey }),
    reason: 'dispatch_failed',
  });
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'blocked', 'terminal delivery failure never strands the node doing');
  const reasons = historyFor(store, 'n1').map((entry) => entry.reason || '');
  assert.ok(reasons.some((reason) => reason.includes('dag_delivery_failed')), JSON.stringify(reasons));
});

test('delivery unknown-outcome block is recoverable when the same child later earns an authoritative accepted ruling', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const { scheduler, deliveries } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);

  // The delivery lease expires after invocation started. The scheduler must
  // fail closed immediately, but the already-running child may still finish.
  scheduler.handleEvent('cross_conversation_delivery_updated', {
    conversationId: 'child-n1',
    delivery: schedulerDelivery({
      idempotencyKey: `dag-node:${plan.id}:n1:${plan.activatedAt}`,
      idempotencyScope: `operator:${ROOT_ID}:conversation_spawn`,
    }),
    reason: 'recovered_unknown_outcome',
  });
  await flush(scheduler);
  assert.equal(getNode(store, 'n1').status, 'blocked');

  // The live child finishes after the transport-level block. Its proposal
  // must still reach the verifier, and a durable valid ruling supersedes the
  // earlier operational failure for this same bound child execution.
  announceComplete(store, scheduler, 'child-n1', '未知结果恢复后的完工摘要');
  await flush(scheduler);
  assert.equal(deliveries.length, 1, 'blocked child completion is still routed to its verifier');

  ruleOnProposal(store, scheduler, 'child-n1', 'accept', '验收通过');
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'done');
  assert.equal(getNode(store, 'n1').result, '未知结果恢复后的完工摘要');
  const transitions = historyFor(store, 'n1').map((entry) => `${entry.from}->${entry.to}:${entry.reason}`);
  assert.ok(transitions.some((entry) => entry === 'blocked->done:dag_goal_completed'), JSON.stringify(transitions));
});

test('manual user block remains terminal even if the child later records an accepted ruling', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const harness = createHarness(store);

  harness.scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(harness.scheduler);

  const current = store.getPlanForConversation(ROOT_ID).plan;
  const manuallyBlockedDoc = JSON.parse(JSON.stringify(current.doc));
  manuallyBlockedDoc.nodes.find((entry) => entry.id === 'n1').status = 'blocked';
  store.savePlanForConversation(
    ROOT_ID,
    { doc: manuallyBlockedDoc, version: current.version },
    { actor: { type: 'user' } },
  );

  proposeSessionGoalAction(
    store,
    'child-n1',
    { action: 'complete', reason: '用户阻塞后迟到的摘要' },
    { agentId: WORKER_ID, agentName: WORKER_ID },
  );
  applySessionGoalAction(store, 'child-n1', {
    action: 'accept-proposal',
    reason: '迟到验收',
    ruledBy: { agentId: VERIFIER_ID, agentName: VERIFIER_ID },
  });

  harness.scheduler.handleEvent('conversation_goal_proposal_cleared', { conversationId: 'child-n1' });
  await flush(harness.scheduler);
  await harness.scheduler.reconcileOnStartup();

  assert.equal(getNode(store, 'n1').status, 'blocked', 'scheduler must not override an explicit user block');
  assert.equal(getNode(store, 'n1').result, undefined);
  const transitions = historyFor(store, 'n1').map((entry) => `${entry.from}->${entry.to}:${entry.actor}`);
  assert.ok(transitions.some((entry) => entry === 'doing->blocked:user'), JSON.stringify(transitions));
  assert.equal(transitions.some((entry) => entry.startsWith('blocked->done:')), false);
});

test('manual blocked→pending redispatch resets the reused child goal epoch before post-bind settle', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const harness = createHarness(store);

  harness.scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(harness.scheduler);
  proposeSessionGoalAction(
    store,
    'child-n1',
    { action: 'complete', reason: '旧执行周期摘要' },
    { agentId: WORKER_ID, agentName: WORKER_ID },
  );
  applySessionGoalAction(store, 'child-n1', {
    action: 'accept-proposal',
    ruledBy: { agentId: VERIFIER_ID, agentName: VERIFIER_ID },
  });
  store.writePlanNodeExecution(ROOT_ID, [{ nodeId: 'n1', status: 'blocked' }], { reason: 'old attempt failed' });

  const blockedPlan = store.getPlanForConversation(ROOT_ID).plan;
  const pendingDoc = JSON.parse(JSON.stringify(blockedPlan.doc));
  pendingDoc.nodes.find((entry) => entry.id === 'n1').status = 'pending';
  const reset = store.savePlanForConversation(
    ROOT_ID,
    { doc: pendingDoc, version: blockedPlan.version },
    { actor: { type: 'user' } },
  );
  harness.scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan: reset.plan });
  await flush(harness.scheduler);

  assert.equal(getNode(store, 'n1').status, 'doing', 'stale accepted ruling must not auto-complete the retry');
  assert.equal(getNode(store, 'n1').result, undefined);
  assert.equal(getSessionGoal(store.getConversation('child-n1')).status, 'active', 'retry starts a fresh goal epoch');
  assert.equal(getSessionGoalRuling(store.getConversation('child-n1')), null, 'stale ruling is cleared before doing bind');
  assert.equal(harness.spawns.length, 2, 'idempotent spawn reuses the child for the retry attempt');
});

test('restart reconcile does not reuse an accepted ruling from before the latest execution attempt', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const harness = createHarness(store);

  harness.scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(harness.scheduler);
  proposeSessionGoalAction(
    store,
    'child-n1',
    { action: 'complete', reason: '旧执行周期摘要' },
    { agentId: WORKER_ID, agentName: WORKER_ID },
  );
  applySessionGoalAction(store, 'child-n1', {
    action: 'accept-proposal',
    ruledBy: { agentId: VERIFIER_ID, agentName: VERIFIER_ID },
  });

  // Start a later attempt without dispatching an event. The old durable
  // ruling remains in the reused child metadata, but predates this attempt.
  store.writePlanNodeExecution(ROOT_ID, [{ nodeId: 'n1', status: 'blocked' }], { reason: 'first attempt failed' });
  const blockedPlan = store.getPlanForConversation(ROOT_ID).plan;
  const pendingDoc = JSON.parse(JSON.stringify(blockedPlan.doc));
  pendingDoc.nodes.find((entry) => entry.id === 'n1').status = 'pending';
  store.savePlanForConversation(
    ROOT_ID,
    { doc: pendingDoc, version: blockedPlan.version },
    { actor: { type: 'user' } },
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  store.writePlanNodeExecution(
    ROOT_ID,
    [{ nodeId: 'n1', status: 'doing', spawnedConversationId: 'child-n1' }],
    { reason: 'later attempt' },
  );
  store.writePlanNodeExecution(ROOT_ID, [{ nodeId: 'n1', status: 'blocked' }], { reason: 'later attempt interrupted' });

  const restarted = createHarness(store);
  await restarted.scheduler.reconcileOnStartup();

  assert.equal(getNode(store, 'n1').status, 'blocked', 'stale evidence must not settle the latest attempt');
  assert.equal(getNode(store, 'n1').result, undefined);
});

test('restart reconcile recovers a system-blocked node from its durable accepted ruling', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const harness = createHarness(store);

  harness.scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(harness.scheduler);
  harness.scheduler.handleEvent('cross_conversation_delivery_updated', {
    conversationId: 'child-n1',
    delivery: schedulerDelivery({
      idempotencyKey: `dag-node:${plan.id}:n1:${plan.activatedAt}`,
      idempotencyScope: `operator:${ROOT_ID}:conversation_spawn`,
    }),
    reason: 'recovered_unknown_outcome',
  });
  await flush(harness.scheduler);

  proposeSessionGoalAction(
    store,
    'child-n1',
    { action: 'complete', reason: '崩溃窗口中的完工摘要' },
    { agentId: WORKER_ID, agentName: WORKER_ID },
  );
  applySessionGoalAction(store, 'child-n1', {
    action: 'accept-proposal',
    reason: '验收通过',
    ruledBy: { agentId: VERIFIER_ID, agentName: VERIFIER_ID },
  });

  const restarted = createHarness(store);
  await restarted.scheduler.reconcileOnStartup();

  assert.equal(getNode(store, 'n1').status, 'done');
  assert.equal(getNode(store, 'n1').result, '崩溃窗口中的完工摘要');
  const transitions = historyFor(store, 'n1').map((entry) => `${entry.from}->${entry.to}:${entry.reason}`);
  assert.ok(transitions.some((entry) => entry === 'blocked->done:dag_reconcile_goal_complete'), JSON.stringify(transitions));
});

test('P2: non-terminal or foreign delivery events are ignored', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const { scheduler, deliveries } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);
  announceComplete(store, scheduler, 'child-n1', '完工摘要');
  await flush(scheduler);
  assert.equal(deliveries.length, 1);

  // Retry scheduled (not terminal) → ignored.
  scheduler.handleEvent('cross_conversation_delivery_updated', {
    conversationId: 'child-n1',
    delivery: schedulerDelivery({ idempotencyKey: deliveries[0].idempotencyKey, dispatchStatus: 'queued' }),
    reason: 'retry_scheduled',
  });
  // A failed delivery with a non-DAG key → ignored.
  scheduler.handleEvent('cross_conversation_delivery_updated', {
    conversationId: 'child-n1',
    delivery: schedulerDelivery({ idempotencyKey: 'req:someone-else' }),
    reason: 'dispatch_failed',
  });
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'doing');
});

test('delivery guard: forged agent-principal delivery with a dag-* key is ignored', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const { scheduler, deliveries } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);
  announceComplete(store, scheduler, 'child-n1', '完工摘要');
  await flush(scheduler);
  assert.equal(deliveries.length, 1);

  // Agent-forged key: agents may pick arbitrary idempotency keys, so the
  // guard must trust only the persisted principal/scope/source/target.
  scheduler.handleEvent('cross_conversation_delivery_updated', {
    conversationId: 'child-n1',
    delivery: schedulerDelivery({
      idempotencyKey: deliveries[0].idempotencyKey,
      principalKind: 'agent',
    }),
    reason: 'dispatch_failed',
  });
  // Wrong scope (agent invocation scope, not the scheduler's).
  scheduler.handleEvent('cross_conversation_delivery_updated', {
    conversationId: 'child-n1',
    delivery: schedulerDelivery({
      idempotencyKey: deliveries[0].idempotencyKey,
      idempotencyScope: 'agent:invocation-1:conversation_request',
    }),
    reason: 'dispatch_failed',
  });
  // Wrong target (another conversation).
  scheduler.handleEvent('cross_conversation_delivery_updated', {
    conversationId: 'child-n1',
    delivery: schedulerDelivery({
      idempotencyKey: deliveries[0].idempotencyKey,
      targetConversationId: 'some-other-conversation',
    }),
    reason: 'dispatch_failed',
  });
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'doing', 'forged/mismatched deliveries never block the node');
});

test('delivery guard: stale activation or earlier proposal-round failures are ignored', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const { scheduler, deliveries } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);
  announceComplete(store, scheduler, 'child-n1', '第一轮完工摘要');
  await flush(scheduler);
  assert.equal(deliveries.length, 1);
  const roundOneVerifyKey = deliveries[0].idempotencyKey;

  // Verifier rejects round 1 → feedback delivered → worker re-announces.
  ruleOnProposal(store, scheduler, 'child-n1', 'reject', '还差一点');
  await flush(scheduler);
  assert.equal(deliveries.length, 2);
  const roundOneFeedbackKey = deliveries[1].idempotencyKey;
  announceComplete(store, scheduler, 'child-n1', '第二轮完工摘要');
  await flush(scheduler);
  assert.equal(deliveries.length, 3, 'round-2 verification requested');

  // Late failures from a stale activation stamp and from round 1's
  // verify/feedback deliveries must NOT block the current round.
  scheduler.handleEvent('cross_conversation_delivery_updated', {
    conversationId: 'child-n1',
    delivery: schedulerDelivery({ idempotencyKey: `dag-node:${plan.id}:n1:stale-activation` }),
    reason: 'dispatch_failed',
  });
  scheduler.handleEvent('cross_conversation_delivery_updated', {
    conversationId: 'child-n1',
    delivery: schedulerDelivery({ idempotencyKey: roundOneVerifyKey }),
    reason: 'dispatch_failed',
  });
  scheduler.handleEvent('cross_conversation_delivery_updated', {
    conversationId: 'child-n1',
    delivery: schedulerDelivery({ idempotencyKey: roundOneFeedbackKey }),
    reason: 'dispatch_failed',
  });
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'doing', 'stale failures never block the current cycle');
});

test('delivery guard: current-cycle feedback failure blocks the node', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const { scheduler, deliveries } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);
  announceComplete(store, scheduler, 'child-n1', '完工摘要');
  await flush(scheduler);
  ruleOnProposal(store, scheduler, 'child-n1', 'reject', '缺少关键测试');
  await flush(scheduler);
  assert.equal(deliveries.length, 2);
  assert.equal(getNode(store, 'n1').status, 'doing');

  // The proposal is already cleared at this point — the guard identifies
  // the current feedback delivery via the persisted dagDeliveryKey on the
  // latest feedback message, not via a pending proposal stamp.
  scheduler.handleEvent('cross_conversation_delivery_updated', {
    conversationId: 'child-n1',
    delivery: schedulerDelivery({
      idempotencyKey: deliveries[1].idempotencyKey,
      dispatchStatus: 'cancelled',
    }),
    reason: 'delivery_cancelled',
  });
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'blocked', 'feedback terminal failure (failed OR cancelled) never strands the node');
  const reasons = historyFor(store, 'n1').map((entry) => entry.reason || '');
  assert.ok(reasons.some((reason) => reason.includes('dag_delivery_failed')), JSON.stringify(reasons));
});

test('delivery guard: synchronous verification-request persist failure blocks the node', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const { scheduler } = createHarness(store, {
    schedulerOptions: {
      async deliverNodeMessage() {
        throw new Error('validation blew up');
      },
    },
  });

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);
  announceComplete(store, scheduler, 'child-n1', '完工摘要');
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'blocked', 'unpersisted verification request must not idle forever');
  const reasons = historyFor(store, 'n1').map((entry) => entry.reason || '');
  assert.ok(reasons.some((reason) => reason.includes('dag_delivery_failed')), JSON.stringify(reasons));
});

test('goal-driven child whose session goal vanishes fails closed (dag_goal_missing)', async () => {
  const store = createStore(test);
  createRoot(store);
  const plan = createActivePlan(store, makeDoc([node('n1')]));
  const { scheduler, spawns } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);
  assert.equal(spawns.length, 1);
  const childId = spawns[0].conversationId;

  // The binding exists but the goal disappeared (tampered metadata): the
  // completion protocol is unrecoverable, so the slot settle must NOT fall
  // back to the legacy turn-terminal done path.
  const child = store.getConversation(childId);
  const metadata = { ...(child.metadata || {}) };
  delete metadata.sessionGoal;
  delete metadata.sessionGoalProposal;
  store.updateConversation(childId, { title: child.title, type: child.type, metadata });

  const bootstrapMessageId = spawns[0].bootstrapMessageId;
  addMessage(store, {
    id: 'reply-1',
    conversationId: childId,
    role: 'assistant',
    content: 'done-ish',
    metadata: { triggeredByMessageId: bootstrapMessageId },
  });
  scheduler.handleEvent('agent_slot_finished', {
    conversationId: childId,
    slot: { status: 'completed', sourceMessageId: bootstrapMessageId, finalContent: 'done-ish' },
  });
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'blocked');
  const reasons = historyFor(store, 'n1').map((entry) => entry.reason || '');
  assert.ok(reasons.some((reason) => reason.includes('dag_goal_missing')), JSON.stringify(reasons));
});

test('D28: accepted ruling persisted but cleared event lost — reconcile settles done from the durable ruling (accept crash window)', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const { scheduler, deliveries } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);
  announceComplete(store, scheduler, 'child-n1', '崩溃前完工摘要');
  await flush(scheduler);
  assert.equal(deliveries.length, 1, 'verification request delivered');

  // Crash window: the verifier's accept mutation PERSISTED (proposal
  // cleared + goal complete + ruling record) but the process died before
  // the cleared event was broadcast — the scheduler never saw it.
  applySessionGoalAction(store, 'child-n1', {
    action: 'accept-proposal',
    reason: '验收通过',
    ruledBy: { agentId: VERIFIER_ID, agentName: VERIFIER_ID },
  });

  // Restart: a fresh scheduler over the same store reconciles.
  const restarted = createHarness(store);
  await restarted.scheduler.reconcileOnStartup();

  assert.equal(getNode(store, 'n1').status, 'done', 'durable accepted ruling settles the node after restart');
  assert.equal(getNode(store, 'n1').result, '崩溃前完工摘要', 'result recovered from the persisted ruling proposal snapshot');
  const transitions = historyFor(store, 'n1').map((entry) => `${entry.from}->${entry.to}:${entry.reason}`);
  assert.ok(transitions.some((entry) => entry === 'doing->done:dag_reconcile_goal_complete'), JSON.stringify(transitions));
});

test('D28: rejected ruling persisted but feedback lost — reconcile re-drives the feedback idempotently (reject crash window)', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const harness = createHarness(store);

  harness.scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(harness.scheduler);
  announceComplete(store, harness.scheduler, 'child-n1', '完工摘要');
  await flush(harness.scheduler);
  assert.equal(harness.deliveries.length, 1, 'verification request delivered');

  // Crash window: the rejection ruling persisted (proposal cleared) but
  // the feedback delivery was never persisted/sent.
  applySessionGoalAction(store, 'child-n1', {
    action: 'dismiss-proposal',
    reason: '验收打回：缺少关键测试',
    ruledBy: { agentId: VERIFIER_ID, agentName: VERIFIER_ID },
  });

  // Restart: reconcile must re-drive the feedback to the worker.
  const restarted = createHarness(store);
  await restarted.scheduler.reconcileOnStartup();

  assert.equal(getNode(store, 'n1').status, 'doing', 'rejection keeps the node doing');
  const feedback = restarted.deliveries.filter((entry) => entry.idempotencyKey.includes(':feedback:'));
  assert.equal(feedback.length, 1, 'feedback re-delivered after restart');
  assert.equal(feedback[0].targetAgentId, WORKER_ID);
  assert.ok(feedback[0].content.includes('验收打回：缺少关键测试'));
  assert.equal(restarted.resumes.length, 0, 'the redriven feedback owns the worker nudge — no resume on the first reconcile');

  // Idempotent: a second reconcile must NOT duplicate the feedback (the
  // persisted feedback message carries the dagDeliveryKey currency marker).
  await restarted.scheduler.reconcileOnStartup();
  const feedbackAfter = restarted.deliveries.filter((entry) => entry.idempotencyKey.includes(':feedback:'));
  assert.equal(feedbackAfter.length, 1, 'no duplicate feedback delivery');
});

test('D28: goal complete with a ruling from the WRONG agent fails closed at the cleared event (defense in depth)', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const { scheduler } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);
  announceComplete(store, scheduler, 'child-n1', '完工摘要');
  await flush(scheduler);

  // Tampered/buggy mutation: the store layer has no ruler validation
  // (enforcement lives in the bridge/REST), so a ruling ruled by a THIRD
  // agent can be persisted. The scheduler must refuse to settle on it.
  const proposal = getSessionGoalProposal(store.getConversation('child-n1'));
  const cleared = applySessionGoalAction(store, 'child-n1', {
    action: 'accept-proposal',
    ruledBy: { agentId: 'role-family-third', agentName: 'Third' },
  });
  scheduler.handleEvent('conversation_goal_proposal_cleared', {
    conversationId: 'child-n1',
    outcome: 'accepted',
    goal: cleared.goal,
    proposal,
    ruledBy: { agentId: 'role-family-third', agentName: 'Third' },
  });
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'blocked', 'a ruling the binding contract forbids must not settle done');
  const reasons = historyFor(store, 'n1').map((entry) => entry.reason || '');
  assert.ok(reasons.some((reason) => reason.includes('dag_goal_completion_unverified')), JSON.stringify(reasons));
});

test('session goal: proposal ids are strong-unique (randomUUID) and survive normalization', async () => {
  const store = createStore(test);
  createRoot(store);
  applySessionGoalAction(store, ROOT_ID, { action: 'set', objective: 'id uniqueness goal', checklist: [] });

  const first = proposeSessionGoalAction(store, ROOT_ID, { action: 'complete', reason: 'one' }, { agentId: WORKER_ID, agentName: WORKER_ID });
  const second = proposeSessionGoalAction(store, ROOT_ID, { action: 'complete', reason: 'two' }, { agentId: WORKER_ID, agentName: WORKER_ID });

  assert.ok(String(first.proposal.id).startsWith('prop_'));
  assert.ok(String(second.proposal.id).startsWith('prop_'));
  assert.notEqual(first.proposal.id, second.proposal.id, 'same-ms proposals must not collide (delivery idempotency depends on it)');
  // Read-back normalization preserves the id (dag scheduler stamps keys with it).
  assert.equal(getSessionGoalProposal(store.getConversation(ROOT_ID)).id, second.proposal.id);
});

test('session goal ruling: accept/dismiss persist a durable ruling atomically with the mutation', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  applySessionGoalAction(store, ROOT_ID, { action: 'set', objective: 'ruling goal', checklist: [] });

  // Accept: ruling record carries outcome/snapshot/ruledBy in one write.
  proposeSessionGoalAction(store, ROOT_ID, { action: 'complete', reason: 'worker 摘要' }, { agentId: WORKER_ID, agentName: WORKER_ID });
  const accepted = applySessionGoalAction(store, ROOT_ID, {
    action: 'accept-proposal',
    reason: '验收通过',
    ruledBy: { agentId: VERIFIER_ID, agentName: VERIFIER_ID },
  });
  const acceptRuling = getSessionGoalRuling(accepted.conversation);
  assert.ok(acceptRuling, 'ruling persisted with the accept mutation');
  assert.equal(acceptRuling.outcome, 'accepted');
  assert.equal(acceptRuling.action, 'complete');
  assert.equal(acceptRuling.ruledBy.kind, 'agent');
  assert.equal(acceptRuling.ruledBy.agentId, VERIFIER_ID);
  assert.equal(acceptRuling.reason, '验收通过');
  assert.equal(acceptRuling.proposalSnapshot.reason, 'worker 摘要', 'snapshot carries the worker result summary (D23)');
  assert.equal(acceptRuling.proposalSnapshot.proposedBy.agentId, WORKER_ID);
  assert.ok(acceptRuling.proposalId, 'ruling references the ruled proposal');
  assert.equal(acceptRuling.proposalId, acceptRuling.proposalSnapshot.id, 'ruling id and snapshot id must identify the same proposal');
  assert.equal(getSessionGoalProposal(accepted.conversation), null, 'proposal cleared in the same write');

  const checklistUpdated = applySessionGoalAction(store, ROOT_ID, {
    action: 'update-checklist',
    checklistText: '- [x] verified',
  });
  assert.equal(
    getSessionGoalRuling(checklistUpdated.conversation).id,
    acceptRuling.id,
    'checklist-only updates must preserve the durable ruling record',
  );
  assert.equal(checklistUpdated.proposalChanged, false, 'checklist-only updates must not claim a proposal was cleared');
  assert.equal(checklistUpdated.proposalCleared, false);

  // A checklist update during a pending round also preserves the proposal
  // and must not emit proposal-cleared response flags.
  proposeSessionGoalAction(store, ROOT_ID, { action: 'complete', reason: '第二次完工' }, { agentId: WORKER_ID, agentName: WORKER_ID });
  const pendingChecklistUpdated = applySessionGoalAction(store, ROOT_ID, {
    action: 'update-checklist',
    checklistText: '- [~] awaiting review',
  });
  assert.equal(pendingChecklistUpdated.proposal.reason, '第二次完工');
  assert.equal(pendingChecklistUpdated.proposalChanged, false);
  assert.equal(pendingChecklistUpdated.proposalCleared, false);

  // Reject: the pending fresh round is ruled by the user.
  const dismissed = applySessionGoalAction(store, ROOT_ID, {
    action: 'dismiss-proposal',
    reason: '用户打回',
    ruledBy: { kind: 'user' },
  });
  const rejectRuling = getSessionGoalRuling(dismissed.conversation);
  assert.ok(rejectRuling, 'ruling persisted with the dismiss mutation');
  assert.equal(rejectRuling.outcome, 'rejected');
  assert.equal(rejectRuling.ruledBy.kind, 'user');
  assert.equal(rejectRuling.reason, '用户打回');
  assert.equal(rejectRuling.proposalSnapshot.reason, '第二次完工');

  // Ruling without an explicit ruledBy is marked system (never silently
  // treated as user/verifier by the scheduler).
  proposeSessionGoalAction(store, ROOT_ID, { action: 'complete', reason: '第三次' }, { agentId: WORKER_ID, agentName: WORKER_ID });
  const unmarked = applySessionGoalAction(store, ROOT_ID, { action: 'accept-proposal' });
  assert.equal(getSessionGoalRuling(unmarked.conversation).ruledBy.kind, 'system');

  // Replacing the goal starts a new epoch: the stale ruling is dropped.
  const replaced = applySessionGoalAction(store, ROOT_ID, { action: 'set', objective: 'new epoch', checklist: [] });
  assert.equal(getSessionGoalRuling(replaced.conversation), null, 'goal replacement drops the stale ruling');
});

test('D28: a ruling whose proposalId disagrees with its proposal snapshot is rejected and cannot settle', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const harness = createHarness(store);

  harness.scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(harness.scheduler);
  announceComplete(store, harness.scheduler, 'child-n1', '待验收摘要');
  await flush(harness.scheduler);

  applySessionGoalAction(store, 'child-n1', {
    action: 'accept-proposal',
    ruledBy: { agentId: VERIFIER_ID, agentName: VERIFIER_ID },
  });
  const conversation = store.getConversation('child-n1');
  store.updateConversation('child-n1', {
    metadata: {
      ...conversation.metadata,
      sessionGoalRuling: {
        ...conversation.metadata.sessionGoalRuling,
        proposalId: 'prop_tampered',
      },
    },
  });

  assert.equal(getSessionGoalRuling(store.getConversation('child-n1')), null, 'normalization rejects the mismatched durable record');

  const restarted = createHarness(store);
  await restarted.scheduler.reconcileOnStartup();

  assert.equal(getNode(store, 'n1').status, 'blocked', 'a mismatched ruling cannot prove completion');
  const reasons = historyFor(store, 'n1').map((entry) => entry.reason || '');
  assert.ok(reasons.some((reason) => reason.includes('dag_goal_completion_unverified')), JSON.stringify(reasons));
});
