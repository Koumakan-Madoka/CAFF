const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { withTempDir } = require('../helpers/temp-dir');

const {
  applySessionGoalAction: applySessionGoalActionRaw,
  claimSessionGoalAutoContinue,
  formatSessionGoalForPrompt,
  getSessionGoal,
  getSessionGoalProposal,
  pauseSessionGoalForRemovedOwner,
  proposeSessionGoalAction: proposeSessionGoalActionRaw,
} = require('../../build/server/domain/conversation/session-goal');

function applySessionGoalAction(store, conversationId, input = {}) {
  if (input.action !== 'set') return applySessionGoalActionRaw(store, conversationId, input);
  return applySessionGoalActionRaw(store, conversationId, {
    acceptanceCriteria: [{
      id: 'criterion-1',
      statement: input.objective || 'Goal result is observable',
      verifyBy: 'runtime test assertion',
      status: 'pending',
      risk: 'normal',
      evidenceRefs: [],
    }],
    ...input,
  });
}

function proposeSessionGoalAction(store, conversationId, input = {}, proposer = {}) {
  if (input.action !== 'set' && input.action !== 'revise') {
    return proposeSessionGoalActionRaw(store, conversationId, input, proposer);
  }
  return proposeSessionGoalActionRaw(store, conversationId, {
    acceptanceCriteria: [{
      id: 'criterion-1',
      statement: input.objective || 'Goal result is observable',
      verifyBy: 'runtime test assertion',
      status: 'pending',
      risk: 'normal',
      evidenceRefs: [],
    }],
    ...input,
  }, proposer);
}

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
  assert.match(goal.goalId, /^legacy_goal_[0-9a-f]{24}$/u);
  assert.equal(goal.goalId, getSessionGoal(conversation).goalId, 'legacy Goal identity must be stable across reads');
  assert.equal(goal.revision, 1);
  assert.deepEqual(goal.owner, { agentId: 'agent-b', agentName: 'Bravo' });

  const prompt = formatSessionGoalForPrompt(conversation);
  assert.ok(prompt.includes('Owner: Bravo'), 'goal prompt should name the owner agent');
});

test('a checklist update preserves the same Goal continuation epoch and advances its revision', () => {
  const { store, conversation } = createOwnerTestStore();
  const initial = applySessionGoalAction(store, conversation.id, {
    action: 'set',
    objective: 'Keep the Goal identity stable while tracking progress',
    checklist: [{ id: 'item-1', text: 'First step', status: 'todo' }],
  });
  const firstClaim = claimSessionGoalAutoContinue(store, conversation.id, { maxIterations: 20 });
  assert.equal(firstClaim.runner.iteration, 1);

  const updated = applySessionGoalAction(store, conversation.id, {
    action: 'update-checklist',
    checklist: [{ id: 'item-1', text: 'First step', status: 'done' }],
  });
  assert.equal(updated.goal.goalId, initial.goal.goalId);
  assert.equal(updated.goal.revision, initial.goal.revision + 1);

  const secondClaim = claimSessionGoalAutoContinue(store, conversation.id, { maxIterations: 20 });
  assert.equal(secondClaim.runner.iteration, 2);
});

test('real SQLite preserves continuation iteration across checklist revision and restart', (t) => {
  const tempDir = withTempDir('caff-goal-revision-runner-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  let store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = store.createConversation({
    id: 'conversation-goal-revision-runner',
    title: 'Goal revision runner',
    type: 'standard',
    projectScopeId: 'project-goal-revision-runner',
    participants: ['role-family-gpt'],
  });
  const initial = applySessionGoalAction(store, conversation.id, {
    action: 'set',
    objective: 'Keep continuation count across a checklist update',
    checklist: [{ id: 'item-1', text: 'First step', status: 'todo' }],
  });
  assert.equal(claimSessionGoalAutoContinue(store, conversation.id, { maxIterations: 20 }).runner.iteration, 1);

  const updated = applySessionGoalAction(store, conversation.id, {
    action: 'update-checklist',
    checklist: [{ id: 'item-1', text: 'First step', status: 'done' }],
  });
  assert.equal(updated.goal.goalId, initial.goal.goalId);
  assert.equal(updated.goal.revision, 2);

  store.close();
  store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const secondClaim = claimSessionGoalAutoContinue(store, conversation.id, { maxIterations: 20 });
  assert.equal(secondClaim.runner.iteration, 2);
  assert.equal(secondClaim.runner.consecutiveModelFailureCount, 0);
});

test('Goal identity stays stable across lifecycle revisions and changes only on replacement', () => {
  const { store, conversation } = createOwnerTestStore();
  const initial = applySessionGoalAction(store, conversation.id, {
    action: 'set',
    objective: 'Track Goal identity and revision',
  }).goal;
  assert.match(initial.goalId, /^goal_/u);
  assert.equal(initial.revision, 1);

  const paused = applySessionGoalAction(store, conversation.id, { action: 'pause' }).goal;
  assert.equal(paused.goalId, initial.goalId);
  assert.equal(paused.revision, 2);

  const resumed = applySessionGoalAction(store, conversation.id, { action: 'resume' }).goal;
  assert.equal(resumed.goalId, initial.goalId);
  assert.equal(resumed.revision, 3);

  const replaced = applySessionGoalAction(store, conversation.id, {
    action: 'set',
    objective: 'A replacement Goal',
  }).goal;
  assert.notEqual(replaced.goalId, resumed.goalId);
  assert.equal(replaced.revision, 1);
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

test('set-owner changes the owner without resetting the continuation epoch', () => {
  const { store, conversation } = createOwnerTestStore({
    sessionGoal: {
      objective: 'Owner changes must not refresh the continuation budget',
      status: 'active',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
      owner: { agentId: 'agent-a', agentName: 'Alpha' },
    },
    sessionGoalRunner: {
      status: 'running',
      goalUpdatedAt: '2026-08-24T00:00:00.000Z',
      iteration: 7,
      maxIterations: 20,
      consecutiveModelFailureCount: 2,
      failureThreshold: 3,
      failureStreakStartedAt: '2026-08-24T00:02:00.000Z',
      lastFailureAt: '2026-08-24T00:02:00.000Z',
    },
  });

  const firstClaim = claimSessionGoalAutoContinue(store, conversation.id, { maxIterations: 20 });
  assert.equal(firstClaim.claimed, true);
  assert.equal(firstClaim.runner.iteration, 8);

  const changed = applySessionGoalAction(store, conversation.id, {
    action: 'set-owner',
    ownerAgentId: 'agent-b',
  });
  assert.deepEqual(changed.goal.owner, { agentId: 'agent-b', agentName: 'Bravo' });

  const secondClaim = claimSessionGoalAutoContinue(store, conversation.id, { maxIterations: 20 });
  assert.equal(secondClaim.claimed, true);
  assert.equal(secondClaim.runner.iteration, 9, 'iteration must continue across an owner change');
  assert.equal(secondClaim.runner.consecutiveModelFailureCount, 2, 'failure streak must survive an owner change');

  const cleared = applySessionGoalAction(store, conversation.id, {
    action: 'set-owner',
    ownerAgentId: '',
  });
  assert.equal(cleared.goal.owner, undefined);

  const thirdClaim = claimSessionGoalAutoContinue(store, conversation.id, { maxIterations: 20 });
  assert.equal(thirdClaim.claimed, true);
  assert.equal(thirdClaim.runner.iteration, 10, 'clearing the owner must not reset the epoch either');
});

test('owner-removed auto-pause keeps an existing pending proposal instead of replacing it', () => {
  const { store, conversation } = createOwnerTestStore({
    sessionGoal: {
      objective: 'Pause even while a proposal is pending',
      status: 'active',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
      owner: { agentId: 'agent-b', agentName: 'Bravo' },
    },
    sessionGoalProposal: {
      action: 'pause',
      status: 'pending',
      id: 'proposal-budget-1',
      reason: 'budget exhausted, waiting on user',
      proposedBy: { agentId: 'goal-runner', agentName: 'Goal Runner' },
      createdAt: '2026-08-24T00:01:00.000Z',
      updatedAt: '2026-08-24T00:01:00.000Z',
    },
  });
  conversation.agents = [{ id: 'agent-a', name: 'Alpha' }];

  const result = pauseSessionGoalForRemovedOwner(store, conversation.id, {
    agentId: 'agent-b',
    agentName: 'Bravo',
  });

  assert.equal(result.paused, true);
  assert.equal(result.goal.status, 'paused');
  assert.equal(result.proposal.id, 'proposal-budget-1', 'existing user decision must not be silently replaced');
  assert.equal(getSessionGoalProposal(conversation).id, 'proposal-budget-1');
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

  conversation.agents.push({ id: 'recovery_scribe', name: '系统书记' });
  assert.throws(
    () => applySessionGoalAction(store, conversation.id, {
      action: 'set-owner',
      ownerAgentId: 'recovery_scribe',
    }),
    (error) => error
      && error.statusCode === 400
      && error.code === 'session_goal_owner_system_actor_not_routable'
  );
});
