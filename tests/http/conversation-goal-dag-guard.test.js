const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const {
  createConversationsController,
} = require('../../build/server/api/conversations-controller');
const {
  proposeSessionGoalAction,
} = require('../../build/server/domain/conversation/session-goal');
const { withTempDir } = require('../helpers/temp-dir');

const ROOT_ID = 'root-conversation';
const CHILD_ID = 'child-n1';
const WORKER_ID = 'role-family-gpt';
const VERIFIER_ID = 'role-family-kimi';

async function invoke(controller, options = {}) {
  const pathname = options.pathname || `/api/conversations/${CHILD_ID}/goal`;
  const req = new PassThrough();
  req.method = options.method || 'POST';
  req.headers = { 'content-type': 'application/json' };
  const state = { body: '', statusCode: 0 };
  const res = {
    writeHead(statusCode) {
      state.statusCode = statusCode;
    },
    end(chunk = '') {
      state.body = String(chunk || '');
    },
  };
  const requestUrl = new URL(`http://127.0.0.1${pathname}`);
  const handledPromise = controller({ req, res, pathname: requestUrl.pathname, requestUrl });
  req.end(JSON.stringify(options.body || {}));
  const handled = await handledPromise;
  return {
    handled,
    statusCode: state.statusCode,
    json: state.body ? JSON.parse(state.body) : {},
  };
}

function createStore(t) {
  const tempDir = withTempDir('caff-goal-dag-guard-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'chat.sqlite') });
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return store;
}

/**
 * Build the DAG execution state: root conversation (worker + verifier), an
 * active plan with node n1 doing, and the spawned child conversation
 * carrying the D28 goal binding + an active session goal.
 */
function setupDagExecution(store, nodeStatus = 'doing') {
  store.createConversation({ id: ROOT_ID, title: 'Root', participants: [WORKER_ID, VERIFIER_ID] });
  store.bindConversationProjectScope(ROOT_ID, 'proj-test');
  store.conversationRepository.create({
    id: CHILD_ID,
    title: 'DAG n1',
    type: 'standard',
    metadataJson: JSON.stringify({
      sessionGoal: {
        objective: 'node goal',
        status: 'active',
        createdAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T00:00:00.000Z',
      },
      dagNodeGoalBinding: {
        planId: 'plan-1',
        nodeId: 'n1',
        workerId: WORKER_ID,
        verifierId: VERIFIER_ID,
      },
    }),
    parentConversationId: ROOT_ID,
    originConversationId: ROOT_ID,
    treeDepth: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  store.savePlanForConversation(ROOT_ID, {
    doc: {
      nodes: [{
        id: 'n1',
        title: 'Node n1',
        goal: 'goal of n1',
        status: nodeStatus,
        depends_on: [],
        branch: 'dag/n1',
        kind: 'work',
        spawned_conversation_id: CHILD_ID,
      }],
    },
  }, { actor: { type: 'user' } });
  store.activatePlanForConversation(ROOT_ID, { type: 'user' });
  if (nodeStatus !== 'pending') {
    store.writePlanNodeExecution(
      ROOT_ID,
      [{ nodeId: 'n1', status: nodeStatus, spawnedConversationId: CHILD_ID }],
      'test-setup'
    );
  }
}

test('DAG-bound doing node: direct goal mutations are rejected (dag_goal_mutation_forbidden)', async (t) => {
  const store = createStore(t);
  setupDagExecution(store);
  const controller = createConversationsController({ store });

  for (const action of ['complete', 'clear', 'pause', 'resume']) {
    await assert.rejects(
      invoke(controller, { body: { action } }),
      (error) => {
        assert.equal(error && error.statusCode, 403, `${action} must be 403`);
        assert.ok(String(error && error.message || '').length > 0);
        assert.equal(error && error.code, 'dag_goal_mutation_forbidden');
        return true;
      },
    );
  }
  await assert.rejects(
    invoke(controller, { body: { action: 'set', objective: 'hijack the goal' } }),
    (error) => error && error.statusCode === 403 && error.code === 'dag_goal_mutation_forbidden',
  );

  // The goal survived untouched.
  const conversation = store.getConversation(CHILD_ID);
  assert.equal(conversation.metadata.sessionGoal.status, 'active');
  assert.equal(conversation.metadata.sessionGoal.objective, 'node goal');
});

test('DAG-bound doing node: proposal rulings and checklist updates stay allowed', async (t) => {
  const store = createStore(t);
  setupDagExecution(store);
  const events = [];
  const controller = createConversationsController({
    store,
    broadcastEvent(eventName, payload) {
      events.push({ eventName, payload });
    },
  });

  // Checklist maintenance is allowed.
  const checklistResponse = await invoke(controller, {
    body: { action: 'update-checklist', checklistText: '- [ ] step one' },
  });
  assert.equal(checklistResponse.statusCode, 200);

  // The worker announces completion (proposal), then the USER accepts via
  // the UI — the D28 manual-verification path.
  proposeSessionGoalAction(
    store,
    CHILD_ID,
    { action: 'complete', reason: '节点完工摘要' },
    { agentId: WORKER_ID, agentName: WORKER_ID }
  );
  const acceptResponse = await invoke(controller, { body: { action: 'accept-proposal' } });
  assert.equal(acceptResponse.statusCode, 200);

  const clearedEvent = events.find((event) => event.eventName === 'conversation_goal_proposal_cleared');
  assert.ok(clearedEvent, 'cleared event broadcast');
  assert.equal(clearedEvent.payload.outcome, 'accepted');
  assert.deepEqual(clearedEvent.payload.ruledBy, { kind: 'user' });
  assert.equal(clearedEvent.payload.proposal.reason, '节点完工摘要', 'proposal snapshot preserved');
  const goal = store.getConversation(CHILD_ID).metadata.sessionGoal;
  assert.equal(goal.status, 'complete');
});

test('DAG binding without a doing node does not restrict goal mutations', async (t) => {
  const store = createStore(t);
  // Node already done — execution is over, cleanup must stay possible.
  setupDagExecution(store, 'done');
  const controller = createConversationsController({ store });

  const response = await invoke(controller, { body: { action: 'clear' } });
  assert.equal(response.statusCode, 200);
  assert.equal(store.getConversation(CHILD_ID).metadata.sessionGoal, undefined);
});
