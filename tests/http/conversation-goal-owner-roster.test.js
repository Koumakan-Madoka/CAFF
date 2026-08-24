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
  applySessionGoalAction,
  getSessionGoal,
  getSessionGoalProposal,
} = require('../../build/server/domain/conversation/session-goal');
const { withTempDir } = require('../helpers/temp-dir');

const CONVERSATION_ID = 'conv-goal-owner-roster';
const OWNER_ID = 'role-family-gpt';
const OTHER_ID = 'role-family-kimi';

async function invokePut(controller, conversationId, body) {
  const req = new PassThrough();
  req.method = 'PUT';
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
  const requestUrl = new URL(`http://127.0.0.1/api/conversations/${conversationId}`);
  const handledPromise = controller({ req, res, pathname: requestUrl.pathname, requestUrl });
  req.end(JSON.stringify(body || {}));
  const handled = await handledPromise;
  return {
    handled,
    statusCode: state.statusCode,
    json: state.body ? JSON.parse(state.body) : {},
  };
}

function createStore(t) {
  const tempDir = withTempDir('caff-goal-owner-roster-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'chat.sqlite') });
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return store;
}

function setupConversationWithOwnedGoal(store, ownerAgentId = OWNER_ID) {
  store.createConversation({
    id: CONVERSATION_ID,
    title: 'Goal owner roster',
    participants: [OWNER_ID, OTHER_ID],
  });
  applySessionGoalAction(store, CONVERSATION_ID, {
    action: 'set',
    objective: 'Owner survives roster changes or pauses safely',
  });
  if (ownerAgentId) {
    applySessionGoalAction(store, CONVERSATION_ID, {
      action: 'set-owner',
      ownerAgentId,
    });
  }
}

test('PUT roster removing the goal owner eagerly pauses the goal with a resume proposal', async (t) => {
  const store = createStore(t);
  setupConversationWithOwnedGoal(store, OWNER_ID);
  const controller = createConversationsController({ store });

  const { statusCode, json } = await invokePut(controller, CONVERSATION_ID, {
    participants: [OTHER_ID],
  });

  assert.equal(statusCode, 200);
  const persisted = store.getConversation(CONVERSATION_ID);
  const goal = getSessionGoal(persisted);
  const proposal = getSessionGoalProposal(persisted);

  assert.equal(goal.status, 'paused', 'goal must be paused eagerly on roster PUT');
  assert.ok(proposal, 'a pending resume proposal must be created');
  assert.equal(proposal.action, 'resume');
  assert.equal(proposal.status, 'pending');
  assert.ok(String(proposal.reason || '').includes('主理人'), 'proposal reason names the owner');

  assert.equal(json.conversation.metadata.sessionGoal.status, 'paused');
  assert.equal(json.goalOwnerRemoved, true);
  assert.equal(json.conversation.metadata.sessionGoalProposal.action, 'resume');
});

test('PUT roster keeping the goal owner leaves the active goal untouched', async (t) => {
  const store = createStore(t);
  setupConversationWithOwnedGoal(store, OWNER_ID);
  const controller = createConversationsController({ store });

  const { statusCode, json } = await invokePut(controller, CONVERSATION_ID, {
    participants: [OWNER_ID],
  });

  assert.equal(statusCode, 200);
  const goal = getSessionGoal(store.getConversation(CONVERSATION_ID));
  assert.equal(goal.status, 'active');
  assert.equal(getSessionGoalProposal(store.getConversation(CONVERSATION_ID)), null);
  assert.equal(json.goalOwnerRemoved, undefined);
});

test('PUT roster change on an owner-less goal keeps current default routing behavior', async (t) => {
  const store = createStore(t);
  setupConversationWithOwnedGoal(store, null);
  const controller = createConversationsController({ store });

  const { statusCode, json } = await invokePut(controller, CONVERSATION_ID, {
    participants: [OTHER_ID],
  });

  assert.equal(statusCode, 200);
  const goal = getSessionGoal(store.getConversation(CONVERSATION_ID));
  assert.equal(goal.status, 'active', 'no owner means no eager pause');
  assert.equal(getSessionGoalProposal(store.getConversation(CONVERSATION_ID)), null);
  assert.equal(json.goalOwnerRemoved, undefined);
});
