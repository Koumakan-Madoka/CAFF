const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const {
  applySessionGoalAction,
  claimSessionGoalAutoContinue,
  getSessionGoal,
  getSessionGoalRunner,
  isSessionGoalModelFailurePaused,
  recordSessionGoalContinuationOutcome,
} = require('../../build/server/domain/conversation/session-goal');
const {
  classifyAgentInvocationFailure,
} = require('../../build/server/domain/conversation/turn/agent-executor');
const { withTempDir } = require('../helpers/temp-dir');

function createConversationStore(overrides = {}) {
  const conversation = {
    id: 'conversation-goal-failure-streak',
    title: 'Goal failure streak',
    type: 'standard',
    metadata: {
      sessionGoal: {
        objective: 'Finish without burning the continuation budget',
        status: 'active',
        createdAt: '2026-08-21T00:00:00.000Z',
        updatedAt: '2026-08-21T00:00:00.000Z',
      },
      ...overrides,
    },
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

function goalRunnerOutcome({
  startedAt,
  endedAt,
  completedCount = 0,
  failedCount = 1,
  stopRequested = false,
  terminationReason = 'parallel_responses_completed',
  failures = [
    {
      agentId: 'agent-a',
      senderName: 'Alpha',
      errorMessage: 'Provider rejected the request',
      invocationFailure: {
        kind: 'provider',
        code: 'assistant_error',
        eligible: true,
        summary: 'Provider rejected the request',
      },
    },
  ],
} = {}) {
  return {
    sourceMessages: [
      {
        id: `goal-message-${endedAt}`,
        metadata: {
          source: 'goal-runner',
          goalAutoContinue: true,
        },
      },
    ],
    turn: {
      startedAt,
      endedAt,
      completedCount,
      failedCount,
      stopRequested,
      terminationReason,
    },
    failures,
    fastFailureMs: 60_000,
    failureWindowMs: 5 * 60_000,
    failureThreshold: 3,
  };
}

test('agent invocation failures preserve structured provider, timeout, process, cancellation, and unknown kinds', () => {
  assert.deepEqual(
    classifyAgentInvocationFailure({
      message: 'Request failed',
      assistantErrors: ['insufficient balance'],
    }),
    {
      kind: 'provider',
      code: 'assistant_error',
      eligible: true,
      terminationType: '',
      summary: 'insufficient balance',
    }
  );
  assert.deepEqual(
    classifyAgentInvocationFailure({
      message: 'pi run exceeded 60000ms',
      terminationReason: { type: 'heartbeat_timeout' },
    }),
    {
      kind: 'timeout',
      code: 'heartbeat_timeout',
      eligible: true,
      terminationType: 'heartbeat_timeout',
      summary: 'pi run exceeded 60000ms',
    }
  );
  assert.equal(classifyAgentInvocationFailure({ message: 'pi exited with code 7', exitCode: 7 }).kind, 'process_exit');
  assert.equal(classifyAgentInvocationFailure({ message: 'socket reset', code: 'ECONNRESET' }).kind, 'provider');
  assert.equal(classifyAgentInvocationFailure({ message: 'cancelled' }, { stopRequested: true }).kind, 'cancelled');
  assert.equal(classifyAgentInvocationFailure(new Error('local projection failed')).eligible, false);
  assert.equal(
    classifyAgentInvocationFailure({
      message: 'Request failed',
      assistantErrors: ['Authorization: Bearer test-bearer-value'],
    }).summary,
    'Authorization: Bearer [redacted]'
  );
});

test('three consecutive fast model failures pause the same Goal epoch and persist a redacted reason', () => {
  const { store, conversation } = createConversationStore();
  const first = recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:01:00.000Z',
    endedAt: '2026-08-21T00:01:05.000Z',
  }));
  assert.equal(first.paused, false);
  assert.equal(getSessionGoalRunner(conversation).consecutiveModelFailureCount, 1);

  const second = recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:02:00.000Z',
    endedAt: '2026-08-21T00:02:05.000Z',
  }));
  assert.equal(second.paused, false);
  assert.equal(getSessionGoalRunner(conversation).consecutiveModelFailureCount, 2);

  const third = recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:03:00.000Z',
    endedAt: '2026-08-21T00:03:05.000Z',
    failures: [
      {
        agentId: 'agent-a',
        senderName: 'Alpha',
        errorMessage: 'Authorization: Bearer test-bearer-value',
        invocationFailure: {
          kind: 'provider',
          code: 'assistant_error',
          eligible: true,
          summary: 'Authorization: Bearer test-bearer-value',
        },
      },
    ],
  }));

  const goal = getSessionGoal(conversation);
  const runner = getSessionGoalRunner(conversation);
  assert.equal(third.paused, true);
  assert.equal(goal.status, 'paused');
  assert.equal(runner.status, 'error_paused');
  assert.equal(runner.goalUpdatedAt, goal.updatedAt);
  assert.equal(runner.consecutiveModelFailureCount, 3);
  assert.equal(runner.lastFailureKind, 'provider');
  assert.match(runner.pauseReason, /连续 3 次/u);
  assert.doesNotMatch(runner.pauseReason, /test-bearer-value/u);
  assert.match(runner.lastFailureSummary, /\[redacted\]/u);
});

test('a configured threshold is persisted and remains authoritative for paused-state consumers', () => {
  const { store, conversation } = createConversationStore();
  const first = goalRunnerOutcome({
    startedAt: '2026-08-21T00:01:00.000Z',
    endedAt: '2026-08-21T00:01:05.000Z',
  });
  first.failureThreshold = 2;
  recordSessionGoalContinuationOutcome(store, conversation.id, first);
  const second = goalRunnerOutcome({
    startedAt: '2026-08-21T00:02:00.000Z',
    endedAt: '2026-08-21T00:02:05.000Z',
  });
  second.failureThreshold = 2;
  recordSessionGoalContinuationOutcome(store, conversation.id, second);

  assert.equal(getSessionGoalRunner(conversation).failureThreshold, 2);
  assert.equal(isSessionGoalModelFailurePaused(conversation), true);
});

test('success and ordinary user turns reset the streak while cancellation is neutral', () => {
  const { store, conversation } = createConversationStore();
  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:01:00.000Z',
    endedAt: '2026-08-21T00:01:05.000Z',
  }));

  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:02:00.000Z',
    endedAt: '2026-08-21T00:02:05.000Z',
    completedCount: 1,
    failedCount: 0,
    failures: [],
  }));
  assert.equal(getSessionGoalRunner(conversation).consecutiveModelFailureCount, 0);

  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:03:00.000Z',
    endedAt: '2026-08-21T00:03:05.000Z',
  }));
  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:04:00.000Z',
    endedAt: '2026-08-21T00:04:05.000Z',
    failedCount: 0,
    stopRequested: true,
    terminationReason: 'stopped_by_user',
    failures: [],
  }));
  assert.equal(getSessionGoalRunner(conversation).consecutiveModelFailureCount, 1);

  const ordinaryUserOutcome = goalRunnerOutcome({
    startedAt: '2026-08-21T00:05:00.000Z',
    endedAt: '2026-08-21T00:05:05.000Z',
    completedCount: 1,
    failedCount: 0,
    failures: [],
  });
  ordinaryUserOutcome.sourceMessages = [{ id: 'user-message', metadata: {} }];
  recordSessionGoalContinuationOutcome(store, conversation.id, ordinaryUserOutcome);
  assert.equal(getSessionGoalRunner(conversation).consecutiveModelFailureCount, 0);
});

test('slow or out-of-window failures cannot complete an existing fast-failure streak', () => {
  const { store, conversation } = createConversationStore();
  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:00:00.000Z',
    endedAt: '2026-08-21T00:00:05.000Z',
  }));
  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:01:00.000Z',
    endedAt: '2026-08-21T00:01:05.000Z',
  }));
  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:02:00.000Z',
    endedAt: '2026-08-21T00:03:01.000Z',
  }));
  assert.equal(getSessionGoalRunner(conversation).consecutiveModelFailureCount, 0);
  assert.equal(getSessionGoal(conversation).status, 'active');

  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:04:00.000Z',
    endedAt: '2026-08-21T00:04:05.000Z',
  }));
  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:05:00.000Z',
    endedAt: '2026-08-21T00:05:05.000Z',
  }));
  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:10:01.000Z',
    endedAt: '2026-08-21T00:10:06.000Z',
  }));
  assert.equal(getSessionGoalRunner(conversation).consecutiveModelFailureCount, 1);
  assert.equal(getSessionGoal(conversation).status, 'active');
});

test('a real SQLite close and reopen preserves the same-epoch streak for the third claim', (t) => {
  const tempDir = withTempDir('caff-goal-failure-streak-restart-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  let store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const conversationId = 'conversation-goal-failure-sqlite-restart';
  store.createConversation({
    id: conversationId,
    title: 'Goal failure restart',
    participants: ['role-family-gpt'],
  });
  applySessionGoalAction(store, conversationId, {
    action: 'set',
    objective: 'Persist the provider failure streak',
    checklist: [],
  });

  claimSessionGoalAutoContinue(store, conversationId, { maxIterations: 20 });
  recordSessionGoalContinuationOutcome(store, conversationId, goalRunnerOutcome({
    startedAt: '2026-08-21T00:01:00.000Z',
    endedAt: '2026-08-21T00:01:05.000Z',
  }));
  claimSessionGoalAutoContinue(store, conversationId, { maxIterations: 20 });
  recordSessionGoalContinuationOutcome(store, conversationId, goalRunnerOutcome({
    startedAt: '2026-08-21T00:02:00.000Z',
    endedAt: '2026-08-21T00:02:05.000Z',
  }));
  assert.equal(getSessionGoalRunner(store.getConversation(conversationId)).consecutiveModelFailureCount, 2);
  store.close();

  store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  claimSessionGoalAutoContinue(store, conversationId, { maxIterations: 20 });
  const result = recordSessionGoalContinuationOutcome(store, conversationId, goalRunnerOutcome({
    startedAt: '2026-08-21T00:03:00.000Z',
    endedAt: '2026-08-21T00:03:05.000Z',
  }));

  assert.equal(result.paused, true);
  assert.equal(getSessionGoal(store.getConversation(conversationId)).status, 'paused');
  assert.equal(getSessionGoalRunner(store.getConversation(conversationId)).consecutiveModelFailureCount, 3);
});

test('stale or malformed runner metadata starts a fresh streak and Goal set clears it', () => {
  const { store, conversation } = createConversationStore({
    sessionGoalRunner: {
      status: 'running',
      goalUpdatedAt: '2026-08-20T00:00:00.000Z',
      iteration: 'broken',
      maxIterations: -20,
      consecutiveModelFailureCount: 99,
      failureStreakStartedAt: 'not-a-date',
      lastFailureKind: 'forged-kind',
    },
  });

  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:01:00.000Z',
    endedAt: '2026-08-21T00:01:05.000Z',
  }));
  assert.equal(getSessionGoalRunner(conversation).consecutiveModelFailureCount, 1);
  assert.equal(getSessionGoal(conversation).status, 'active');

  applySessionGoalAction(store, conversation.id, {
    action: 'set',
    objective: 'Start a new Goal epoch',
    checklist: [],
  });
  assert.equal(getSessionGoalRunner(conversation), null);
});

test('persisted streak survives a fresh caller and resume clears the guard state', () => {
  const { store, conversation } = createConversationStore();
  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:01:00.000Z',
    endedAt: '2026-08-21T00:01:05.000Z',
  }));
  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:02:00.000Z',
    endedAt: '2026-08-21T00:02:05.000Z',
  }));

  const restartedResult = recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:03:00.000Z',
    endedAt: '2026-08-21T00:03:05.000Z',
  }));
  assert.equal(restartedResult.paused, true);

  applySessionGoalAction(store, conversation.id, { action: 'resume' });
  assert.equal(getSessionGoal(conversation).status, 'active');
  assert.equal(getSessionGoalRunner(conversation), null);
});
