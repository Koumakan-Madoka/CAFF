const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applySessionGoalAction,
  getSessionGoal,
  proposeSessionGoalAction,
} = require('../../build/server/domain/conversation/session-goal');

function createStore() {
  const conversation = {
    id: 'goal-contract-conversation',
    title: 'Goal contract',
    type: 'standard',
    agents: [
      { id: 'author', name: 'Author' },
      { id: 'reviewer', name: 'Reviewer' },
    ],
    metadata: {},
    messages: [],
  };
  return {
    conversation,
    store: {
      getConversation(id) {
        return id === conversation.id ? conversation : null;
      },
      updateConversation(id, updates) {
        assert.equal(id, conversation.id);
        conversation.metadata = updates.metadata;
        return conversation;
      },
    },
  };
}

function criterion(overrides = {}) {
  return {
    id: 'criterion-1',
    statement: 'The observable behavior is delivered',
    verifyBy: 'node tests/runtime/goal-contract.test.js',
    status: 'pending',
    risk: 'normal',
    evidenceRefs: [],
    ...overrides,
  };
}

function setGoal(store, conversationId, overrides = {}) {
  return applySessionGoalAction(store, conversationId, {
    action: 'set',
    objective: 'Deliver a structured Goal',
    decisions: {
      committed: [],
      provisional: [],
      openQuestions: [],
      nonGoals: [],
      rejectedOptions: [],
    },
    acceptanceCriteria: [criterion()],
    workItems: [{ id: 'work-1', text: 'Implement behavior', status: 'in_progress' }],
    evidence: [],
    ...overrides,
  });
}

test('Goal creation requires observable acceptance criteria and verification methods', () => {
  const { store, conversation } = createStore();

  assert.throws(
    () => applySessionGoalAction(store, conversation.id, { action: 'set', objective: 'Missing criteria' }),
    (error) => error.statusCode === 400 && error.code === 'goal_acceptance_criteria_required'
  );
  assert.throws(
    () => applySessionGoalAction(store, conversation.id, {
      action: 'set',
      objective: 'Missing verifier',
      acceptanceCriteria: [criterion({ verifyBy: '' })],
    }),
    (error) => error.statusCode === 400 && error.code === 'goal_acceptance_verify_by_required'
  );

  const result = setGoal(store, conversation.id);
  assert.equal(result.goal.acceptanceCriteria.length, 1);
  assert.equal(result.goal.workItems.length, 1);
  assert.deepEqual(result.goal.evidence, []);
});

test('stale factual updates are rejected by the Goal revision', () => {
  const { store, conversation } = createStore();
  setGoal(store, conversation.id);
  const staleGoal = getSessionGoal(conversation);

  applySessionGoalAction(store, conversation.id, {
    action: 'update-delivery',
    ...staleGoal,
    workItems: [{ id: 'work-1', text: 'Implement behavior', status: 'done' }],
  });

  assert.throws(
    () => applySessionGoalAction(store, conversation.id, {
      action: 'update-delivery',
      ...staleGoal,
      workItems: [{ id: 'work-1', text: 'Implement behavior', status: 'todo' }],
    }),
    (error) => error.statusCode === 409 && error.code === 'goal_revision_conflict'
  );
  assert.equal(getSessionGoal(conversation).workItems[0].status, 'done');
});

test('direct revisions require a current revision and reject stale user writes', () => {
  const { store, conversation } = createStore();
  setGoal(store, conversation.id);
  const original = getSessionGoal(conversation);
  applySessionGoalAction(store, conversation.id, {
    ...original, action: 'revise', objective: 'Revised objective', goalRevision: original.revision,
    ruledBy: { kind: 'user' },
  });
  const revised = getSessionGoal(conversation);
  assert.equal(revised.goalId, original.goalId);
  assert.equal(revised.revision, original.revision + 1);
  assert.throws(() => applySessionGoalAction(store, conversation.id, {
    ...original, action: 'revise', goalRevision: original.revision, ruledBy: { kind: 'user' },
  }), (error) => error.statusCode === 409 && error.code === 'goal_revision_conflict');
  const { revision, ...withoutRevision } = original;
  assert.throws(() => applySessionGoalAction(store, conversation.id, {
    ...withoutRevision, action: 'revise', ruledBy: { kind: 'user' },
  }), (error) => error.statusCode === 400 && error.code === 'goal_revision_required');
  assert.deepEqual(getSessionGoal(conversation), revised);
});

test('a reviewed revision proposal cannot overwrite a newer Goal revision', () => {
  const { store, conversation } = createStore();
  setGoal(store, conversation.id);
  const proposedFrom = getSessionGoal(conversation);

  proposeSessionGoalAction(store, conversation.id, {
    action: 'revise',
    ...proposedFrom,
    objective: 'Deliver a revised structured Goal',
  }, { agentId: 'author', agentName: 'Author' });

  applySessionGoalAction(store, conversation.id, {
    action: 'update-delivery',
    ...proposedFrom,
    workItems: [{ id: 'work-1', text: 'Implement behavior', status: 'done' }],
  });

  assert.throws(
    () => applySessionGoalAction(store, conversation.id, {
      action: 'accept-proposal',
      ruledBy: { agentId: 'reviewer', agentName: 'Reviewer' },
    }),
    (error) => error.statusCode === 409 && error.code === 'goal_revision_conflict'
  );
  assert.equal(getSessionGoal(conversation).objective, 'Deliver a structured Goal');
  assert.equal(getSessionGoal(conversation).workItems[0].status, 'done');
});

test('work completion cannot complete a Goal while acceptance is pending', () => {
  const { store, conversation } = createStore();
  setGoal(store, conversation.id);

  applySessionGoalAction(store, conversation.id, {
    action: 'update-delivery',
    ...getSessionGoal(conversation),
    workItems: [{ id: 'work-1', text: 'Implement behavior', status: 'done' }],
  });

  assert.throws(
    () => applySessionGoalAction(store, conversation.id, { action: 'complete' }),
    (error) => error.statusCode === 409 && error.code === 'goal_acceptance_incomplete'
  );
  assert.throws(
    () => proposeSessionGoalAction(store, conversation.id, {
      action: 'complete',
      reason: 'Work items are done',
    }, { agentId: 'author', agentName: 'Author' }),
    (error) => error.statusCode === 409 && error.code === 'goal_acceptance_incomplete'
  );

  applySessionGoalAction(store, conversation.id, {
    action: 'update-delivery',
    ...getSessionGoal(conversation),
    acceptanceCriteria: [criterion({ status: 'passed', evidenceRefs: ['evidence-1'] })],
    evidence: [{
      id: 'evidence-1',
      criterionIds: ['criterion-1'],
      kind: 'test',
      summary: 'Goal contract regression test passed',
      reference: 'node tests/runtime/goal-contract.test.js',
    }],
  });
  const completed = applySessionGoalAction(store, conversation.id, { action: 'complete' });
  assert.equal(completed.goal.status, 'complete');
});

test('completion review preserves criterion evidence instead of fabricating blanket proof', () => {
  const { store, conversation } = createStore();
  setGoal(store, conversation.id);
  applySessionGoalAction(store, conversation.id, {
    action: 'update-delivery',
    ...getSessionGoal(conversation),
    acceptanceCriteria: [criterion({ status: 'passed', evidenceRefs: ['evidence-1'] })],
    evidence: [{
      id: 'evidence-1',
      criterionIds: ['criterion-1'],
      kind: 'test',
      summary: 'Observed contract behavior passed',
    }],
  });
  proposeSessionGoalAction(store, conversation.id, {
    action: 'complete',
    reason: 'All recorded criteria are satisfied',
  }, { agentId: 'author', agentName: 'Author' });

  const accepted = applySessionGoalAction(store, conversation.id, {
    action: 'accept-proposal',
    ruledBy: { agentId: 'reviewer', agentName: 'Reviewer' },
  });

  assert.equal(accepted.goal.status, 'complete');
  assert.deepEqual(accepted.goal.acceptanceCriteria[0].evidenceRefs, ['evidence-1']);
  assert.equal(accepted.goal.evidence.length, 1);
  assert.equal(accepted.goal.workItems[0].status, 'in_progress');
});

test('waivers require review and high-risk waivers require the user', () => {
  const { store, conversation } = createStore();
  setGoal(store, conversation.id);
  const current = getSessionGoal(conversation);

  proposeSessionGoalAction(store, conversation.id, {
    action: 'revise',
    objective: current.objective,
    decisions: current.decisions,
    acceptanceCriteria: [criterion({ status: 'waived', waiver: { reason: 'Not meaningful in this environment' } })],
    workItems: current.workItems,
    evidence: current.evidence,
    reason: 'The normal criterion is not meaningful in this environment',
  }, { agentId: 'author', agentName: 'Author' });
  const accepted = applySessionGoalAction(store, conversation.id, {
    action: 'accept-proposal',
    ruledBy: { agentId: 'reviewer', agentName: 'Reviewer' },
  });
  assert.equal(accepted.goal.acceptanceCriteria[0].status, 'waived');
  assert.equal(accepted.goal.acceptanceCriteria[0].waiver.waivedBy, 'Reviewer');

  setGoal(store, conversation.id, { acceptanceCriteria: [criterion({ risk: 'high' })] });
  const highRisk = getSessionGoal(conversation);
  proposeSessionGoalAction(store, conversation.id, {
    action: 'revise',
    objective: highRisk.objective,
    decisions: highRisk.decisions,
    acceptanceCriteria: [criterion({ risk: 'high', status: 'waived', waiver: { reason: 'Risk accepted' } })],
    workItems: highRisk.workItems,
    evidence: [],
    reason: 'Request high-risk waiver',
  }, { agentId: 'author', agentName: 'Author' });
  assert.throws(
    () => applySessionGoalAction(store, conversation.id, {
      action: 'accept-proposal',
      ruledBy: { agentId: 'reviewer', agentName: 'Reviewer' },
    }),
    (error) => error.statusCode === 403 && error.code === 'goal_high_risk_waiver_user_required'
  );
});

test('provisional changes require impact and produce a visible durable notice after review', () => {
  const { store, conversation } = createStore();
  setGoal(store, conversation.id, {
    decisions: {
      committed: [],
      provisional: [{ id: 'storage', statement: 'Use SQLite first' }],
      openQuestions: [],
      nonGoals: [],
      rejectedOptions: [],
    },
  });
  const current = getSessionGoal(conversation);
  const revisedDecisions = {
    ...current.decisions,
    provisional: [{ id: 'storage', statement: 'Use Postgres first' }],
  };

  assert.throws(
    () => proposeSessionGoalAction(store, conversation.id, {
      action: 'revise',
      objective: current.objective,
      decisions: revisedDecisions,
      acceptanceCriteria: current.acceptanceCriteria,
      workItems: current.workItems,
      evidence: [],
      reason: 'Concurrency evidence changed the choice',
    }, { agentId: 'author', agentName: 'Author' }),
    (error) => error.statusCode === 400 && error.code === 'goal_provisional_change_context_required'
  );

  proposeSessionGoalAction(store, conversation.id, {
    action: 'revise',
    objective: current.objective,
    decisions: revisedDecisions,
    acceptanceCriteria: current.acceptanceCriteria,
    workItems: current.workItems,
    evidence: [],
    reason: 'Concurrency evidence changed the choice',
    impact: 'Storage adapter and deployment configuration change',
    affectedWorkItems: ['work-1'],
  }, { agentId: 'author', agentName: 'Author' });
  const accepted = applySessionGoalAction(store, conversation.id, {
    action: 'accept-proposal',
    ruledBy: { agentId: 'reviewer', agentName: 'Reviewer' },
  });
  assert.equal(accepted.changeNotice.type, 'provisional_decision_changed');
  assert.equal(accepted.changeNotice.changes[0].previous, 'Use SQLite first');
  assert.equal(accepted.changeNotice.changes[0].next, 'Use Postgres first');
  assert.equal(accepted.goal.changeNotices.length, 1);
});

test('an agent reviewer cannot replace a committed decision backed by an accepted ADR', () => {
  const { store, conversation } = createStore();
  setGoal(store, conversation.id, {
    decisions: {
      committed: [{ id: 'workflow', statement: 'Goal is the source of truth', adrPath: 'docs/decisions/0001.md' }],
      provisional: [],
      openQuestions: [],
      nonGoals: [],
      rejectedOptions: [],
    },
  });
  const current = getSessionGoal(conversation);
  proposeSessionGoalAction(store, conversation.id, {
    action: 'revise',
    objective: current.objective,
    decisions: {
      ...current.decisions,
      committed: [{ id: 'workflow', statement: 'Tickets are the source of truth', adrPath: 'docs/decisions/0001.md' }],
    },
    acceptanceCriteria: current.acceptanceCriteria,
    workItems: current.workItems,
    evidence: [],
    reason: 'Change workflow authority',
  }, { agentId: 'author', agentName: 'Author' });

  assert.throws(
    () => applySessionGoalAction(store, conversation.id, {
      action: 'accept-proposal',
      ruledBy: { agentId: 'reviewer', agentName: 'Reviewer' },
    }),
    (error) => error.statusCode === 403 && error.code === 'goal_accepted_adr_change_user_required'
  );
});
