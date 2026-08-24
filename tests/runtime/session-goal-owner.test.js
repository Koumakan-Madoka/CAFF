const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applySessionGoalAction,
  formatSessionGoalForPrompt,
  getSessionGoal,
  proposeSessionGoalAction,
} = require('../../build/server/domain/conversation/session-goal');

function createOwnerTestStore(overrides = {}) {
  const conversation = {
    id: 'conversation-goal-owner',
    title: 'Goal owner',
    type: 'standard',
    agents: [
      { id: 'agent-a', name: 'Alpha' },
      { id: 'agent-b', name: 'Bravo' },
    ],
    metadata: {
      ...overrides,
    },
    messages: [],
  };
  return {
    conversation,
    store: {
      getConversation(conversationId) {
        return conversationId === conversation.id ? conversation : null;
      },
      updateConversation(conversationId, updates) {
        assert.equal(conversationId, conversation.id);
        if (updates && updates.metadata && typeof updates.metadata === 'object') {
          conversation.metadata = updates.metadata;
        }
        return conversation;
      },
    },
  };
}

test('session goal owner persists through normalization and renders in the goal prompt', () => {
  const { conversation } = createOwnerTestStore({
    sessionGoal: {
      objective: 'Ship the owner routing feature',
      status: 'active',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
      owner: {
        agentId: 'agent-b',
        agentName: 'Bravo',
      },
    },
  });

  const goal = getSessionGoal(conversation);

  assert.ok(goal);
  assert.deepEqual(goal.owner, { agentId: 'agent-b', agentName: 'Bravo' });

  const prompt = formatSessionGoalForPrompt(conversation);
  assert.ok(prompt.includes('Owner: Bravo'), 'goal prompt should name the owner agent');
});

test('a user-created goal keeps owner empty', () => {
  const { store, conversation } = createOwnerTestStore();

  const result = applySessionGoalAction(store, conversation.id, {
    action: 'set',
    objective: 'User driven goal without an owner',
  });

  assert.ok(result.goal);
  assert.equal(result.goal.status, 'active');
  assert.equal(result.goal.objective, 'User driven goal without an owner');
  assert.equal(getSessionGoal(conversation).owner, undefined);
});

test('accepting a set proposal stamps the proposer as the goal owner', () => {
  const { store, conversation } = createOwnerTestStore();

  proposeSessionGoalAction(store, conversation.id, {
    action: 'set',
    objective: 'Agent proposed goal',
  }, {
    agentId: 'agent-b',
    agentName: 'Bravo',
  });

  const result = applySessionGoalAction(store, conversation.id, {
    action: 'accept-proposal',
  });

  assert.ok(result.goal);
  assert.equal(result.goal.status, 'active');
  assert.deepEqual(result.goal.owner, { agentId: 'agent-b', agentName: 'Bravo' });
});

test('set-owner action sets, clears, and validates the owner against conversation participants', () => {
  const { store, conversation } = createOwnerTestStore();

  applySessionGoalAction(store, conversation.id, {
    action: 'set',
    objective: 'Owner can be changed from the goal card',
  });

  const setByAgentB = applySessionGoalAction(store, conversation.id, {
    action: 'set-owner',
    ownerAgentId: 'agent-b',
  });
  assert.deepEqual(setByAgentB.goal.owner, { agentId: 'agent-b', agentName: 'Bravo' });

  const cleared = applySessionGoalAction(store, conversation.id, {
    action: 'set-owner',
    ownerAgentId: '',
  });
  assert.equal(cleared.goal.owner, undefined);

  assert.throws(
    () => applySessionGoalAction(store, conversation.id, {
      action: 'set-owner',
      ownerAgentId: 'agent-removed',
    }),
    (error) => error.statusCode === 400
  );
});
