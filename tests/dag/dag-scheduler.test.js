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
    async deliverNodeMessage(input) {
      // Mimic the real channel: submitFromSystem dedups by idempotency key.
      if (deliveries.some((entry) => entry.idempotencyKey === input.idempotencyKey)) {
        return;
      }
      deliveries.push({
        conversationId: input.conversationId,
        targetAgentId: input.targetAgentId,
        content: input.content,
        idempotencyKey: input.idempotencyKey,
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
 * would), then fire the cleared event the scheduler subscribes to. */
function ruleOnProposal(store, scheduler, childId, verdict, reason = '') {
  const proposal = getSessionGoalProposal(store.getConversation(childId));
  const result = applySessionGoalAction(store, childId, {
    action: verdict === 'accept' ? 'accept-proposal' : 'dismiss-proposal',
  });
  scheduler.handleEvent('conversation_goal_proposal_cleared', {
    conversationId: childId,
    outcome: verdict === 'accept' ? 'accepted' : 'rejected',
    reason,
    goal: result.goal,
    proposal,
    ruledBy: { agentId: VERIFIER_ID, agentName: VERIFIER_ID },
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
        // Terminal reply + goal complete land BEFORE the scheduler binds
        // doing — the goal events have effectively fired into the void
        // (D27 race). Result text comes from the terminal reply.
        addMessage(store, {
          id: `reply-${input.node.id}`,
          conversationId: childId,
          role: 'assistant',
          agentId: 'role-family-gpt',
          content: 'instant result',
          status: 'completed',
          metadata: { triggeredByMessageId: messageId },
        });
        applySessionGoalAction(store, childId, { action: 'set', objective: 'instant race goal', checklist: [] });
        applySessionGoalAction(store, childId, { action: 'complete' });
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
  assert.deepEqual(transitions, ['pending->doing:dag_dispatch', 'doing->done:dag_dispatch_settled_goal_complete']);
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
  assert.ok(deliveries[1].idempotencyKey.startsWith('dag-verify-feedback:'));
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

test('D28: user UI accept settles done with the result taken from the cleared proposal snapshot', async () => {
  const store = createStore(test);
  createRoot(store, ROOT_ID, [WORKER_ID, VERIFIER_ID]);
  const plan = createActivePlan(store, makeDoc([node('n1', { verifier: VERIFIER_ID })]));
  const { scheduler } = createHarness(store);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await flush(scheduler);
  announceComplete(store, scheduler, 'child-n1', '用户人工验收摘要');
  await flush(scheduler);

  // Mirror the controller payload after the P1 fix: the cleared event
  // carries the pre-clear proposal snapshot + an explicit user ruling.
  const cleared = applySessionGoalAction(store, 'child-n1', { action: 'accept-proposal' });
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
    delivery: {
      id: 'delivery-1',
      idempotencyKey: deliveries[0].idempotencyKey,
      dispatchStatus: 'failed',
    },
    reason: 'dispatch_failed',
  });
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'blocked', 'terminal delivery failure never strands the node doing');
  const reasons = historyFor(store, 'n1').map((entry) => entry.reason || '');
  assert.ok(reasons.some((reason) => reason.includes('dag_delivery_failed')), JSON.stringify(reasons));
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
    delivery: { id: 'delivery-1', idempotencyKey: deliveries[0].idempotencyKey, dispatchStatus: 'queued' },
    reason: 'retry_scheduled',
  });
  // A failed delivery with a non-DAG key → ignored.
  scheduler.handleEvent('cross_conversation_delivery_updated', {
    conversationId: 'child-n1',
    delivery: { id: 'delivery-2', idempotencyKey: 'req:someone-else', dispatchStatus: 'failed' },
    reason: 'dispatch_failed',
  });
  await flush(scheduler);

  assert.equal(getNode(store, 'n1').status, 'doing');
});
