const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const {
  applySessionGoalAction: applySessionGoalActionRaw,
  claimSessionGoalAutoContinue,
  getSessionGoal,
  getSessionGoalRunner,
  isSessionGoalModelFailurePaused,
  recordSessionGoalContinuationOutcome,
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

function providerFailure(summary, mode, code = 'assistant_error') {
  return {
    agentId: 'agent-a',
    senderName: 'Alpha',
    errorMessage: summary,
    invocationFailure: {
      kind: 'provider',
      code,
      eligible: true,
      mode,
      summary,
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
  failures = [providerFailure('fetch failed', 'provider:network')],
  failureThreshold = 3,
  totalFailureThreshold = 5,
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
    failureThreshold,
    totalFailureThreshold,
  };
}

test('agent invocation failures preserve structured kinds and assign bounded modes', () => {
  assert.deepEqual(
    classifyAgentInvocationFailure({
      message: 'Request failed',
      assistantErrors: ['insufficient balance'],
    }),
    {
      kind: 'provider',
      code: 'assistant_error',
      eligible: true,
      mode: 'provider:quota',
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
      mode: 'timeout:heartbeat',
      terminationType: 'heartbeat_timeout',
      summary: 'pi run exceeded 60000ms',
    }
  );
  assert.equal(classifyAgentInvocationFailure({ message: 'Request failed', assistantErrors: ['fetch failed'] }).mode, 'provider:network');
  assert.equal(classifyAgentInvocationFailure({ message: 'Request failed', assistantErrors: ['429 too many requests'] }).mode, 'provider:rate_limited');
  assert.equal(classifyAgentInvocationFailure({ message: 'Request failed', assistantErrors: ['401 unauthorized'] }).mode, 'provider:auth');
  assert.equal(classifyAgentInvocationFailure({ message: 'Request failed', assistantErrors: ['403 forbidden'] }).mode, 'provider:forbidden');
  assert.equal(classifyAgentInvocationFailure({ message: 'Request failed', assistantErrors: ['503 service unavailable'] }).mode, 'provider:server_error');
  assert.equal(classifyAgentInvocationFailure({ message: 'Request failed', assistantErrors: ['connection error: stream_read_error'] }).mode, 'provider:stream_read');
  assert.equal(classifyAgentInvocationFailure({ message: 'Request failed', assistantErrors: ['model refused the request'] }).mode, 'provider:other');
  assert.equal(classifyAgentInvocationFailure({ message: 'socket reset', code: 'ECONNRESET' }).mode, 'provider:network');
  assert.equal(classifyAgentInvocationFailure({ message: 'socket reset', code: 'UND_ERR_HEADERS_TIMEOUT' }).mode, 'provider:network');
  assert.equal(classifyAgentInvocationFailure({ message: 'pi exited', signal: 'SIGTERM' }).mode, 'process_exit:signal');
  assert.equal(classifyAgentInvocationFailure({ message: 'pi exited with code 7', exitCode: 7 }).mode, 'process_exit:other');
  assert.equal(classifyAgentInvocationFailure({ message: 'cancelled' }, { stopRequested: true }).mode, '');
  assert.equal(classifyAgentInvocationFailure(new Error('local projection failed')).mode, '');
  assert.equal(classifyAgentInvocationFailure(new Error('local projection failed')).eligible, false);
  assert.equal(
    classifyAgentInvocationFailure({
      message: 'Request failed',
      assistantErrors: ['Authorization: Bearer test-bearer-value'],
    }).summary,
    'Authorization: Bearer [redacted]'
  );
  // 哨兵：敏感内容不进 mode，mode 取自固定集合。
  const sentinel = classifyAgentInvocationFailure({
    message: 'Request failed',
    assistantErrors: ['fetch failed api_key=sk-live-secret-value-123'],
  });
  assert.equal(sentinel.mode, 'provider:network');
  assert.doesNotMatch(sentinel.mode, /sk-live/u);
});

test('mode classification uses a structured network-code whitelist and a bounded summary window', () => {
  // 非网络语义的 undici 码不得并入 provider:network；kind/code/eligible 逐字节不变。
  assert.deepEqual(
    classifyAgentInvocationFailure({ message: 'invalid argument', code: 'UND_ERR_INVALID_ARG' }),
    {
      kind: 'provider',
      code: 'und_err_invalid_arg',
      eligible: true,
      mode: 'provider:other',
      terminationType: '',
      summary: 'invalid argument',
    }
  );
  assert.equal(classifyAgentInvocationFailure({ message: 'operation not supported', code: 'UND_ERR_NOT_SUPPORTED' }).mode, 'provider:other');
  assert.equal(classifyAgentInvocationFailure({ message: 'request body mismatch', code: 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH' }).mode, 'provider:other');
  // 白名单内的连接层码仍归为网络模式。
  assert.equal(classifyAgentInvocationFailure({ message: 'connect timeout', code: 'UND_ERR_CONNECT_TIMEOUT' }).mode, 'provider:network');
  assert.equal(classifyAgentInvocationFailure({ message: 'socket error', code: 'UND_ERR_SOCKET' }).mode, 'provider:network');
  assert.equal(classifyAgentInvocationFailure({ message: 'body timeout', code: 'UND_ERR_BODY_TIMEOUT' }).mode, 'provider:network');
  // 已知结构化码优先于 assistantErrors 文本，不被无法归类的文本遮蔽。
  assert.equal(
    classifyAgentInvocationFailure({ message: 'Request failed', code: 'ECONNRESET', assistantErrors: ['unrecognized upstream failure'] }).mode,
    'provider:network'
  );
  assert.equal(
    classifyAgentInvocationFailure({ message: 'Request failed', code: 'ETIMEDOUT', assistantErrors: ['429 too many requests'] }).mode,
    'provider:network'
  );
  // 参与分类的输入必须有界：锚定前缀与关键词之间的海量空白不得穿透窗口。
  const padded = `connection error:${' '.repeat(1_000_000)}stream_read_error`;
  assert.equal(classifyAgentInvocationFailure({ message: 'Request failed', assistantErrors: [padded] }).mode, 'provider:other');
  // 无关正文即使包含模式关键词也不锚定归类。
  const noise = `${'upstream failure detail '.repeat(40)} 429 too many requests`;
  assert.equal(classifyAgentInvocationFailure({ message: 'Request failed', assistantErrors: [noise] }).mode, 'provider:other');
  // 超长敏感哨兵：窗口外内容不影响分类，mode 永远取自固定集合。
  const longSentinel = `unrecognized failure ${'x'.repeat(500)} api_key=sk-live-secret-value-123`;
  const classified = classifyAgentInvocationFailure({ message: 'Request failed', assistantErrors: [longSentinel] });
  assert.equal(classified.mode, 'provider:other');
  assert.doesNotMatch(classified.mode, /sk-live/u);
  assert.doesNotMatch(classified.summary, /sk-live-secret-value-123/u);
});

test('three consecutive same-mode failures pause the Goal regardless of turn duration', () => {
  const { store, conversation } = createConversationStore();
  // 68.5 秒的"慢"失败（事故形状）：旧实现按 slow_failure 不计数。
  const first = recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:01:00.000Z',
    endedAt: '2026-08-21T00:02:08.500Z',
  }));
  assert.equal(first.paused, false);
  assert.equal(getSessionGoalRunner(conversation).consecutiveSameModeFailureCount, 1);
  assert.equal(getSessionGoalRunner(conversation).consecutiveFailureCount, 1);

  // 4 分钟慢失败也不影响计数。
  const second = recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:03:00.000Z',
    endedAt: '2026-08-21T00:07:00.000Z',
  }));
  assert.equal(second.paused, false);
  assert.equal(getSessionGoalRunner(conversation).consecutiveSameModeFailureCount, 2);

  const third = recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:08:00.000Z',
    endedAt: '2026-08-21T00:09:08.500Z',
    failures: [providerFailure('fetch failed api_key=sk-test-secret', 'provider:network')],
  }));

  const goal = getSessionGoal(conversation);
  const runner = getSessionGoalRunner(conversation);
  assert.equal(third.paused, true);
  assert.equal(goal.status, 'paused');
  assert.equal(goal.revision, 2);
  assert.equal(runner.status, 'error_paused');
  assert.equal(runner.goalUpdatedAt, goal.updatedAt);
  assert.equal(runner.consecutiveSameModeFailureCount, 3);
  assert.equal(runner.consecutiveFailureCount, 3);
  assert.equal(runner.lastFailureMode, 'provider:network');
  assert.equal(runner.lastFailureKind, 'provider');
  assert.match(runner.pauseReason, /同模式/u);
  assert.doesNotMatch(runner.pauseReason, /sk-test-secret/u);
  assert.match(runner.lastFailureSummary, /\[redacted\]/u);
  assert.equal(isSessionGoalModelFailurePaused(conversation), true);
});

test('alternating modes never trigger the same-mode guard but pause at the total threshold', () => {
  const { store, conversation } = createConversationStore();
  const modes = ['provider:network', 'provider:rate_limited', 'provider:auth', 'provider:server_error', 'provider:quota'];
  const summaries = ['fetch failed', '429 too many requests', '401 unauthorized', '503 service unavailable', 'insufficient balance'];
  let outcome = null;
  for (let index = 0; index < 5; index += 1) {
    outcome = recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
      startedAt: `2026-08-21T00:1${index}:00.000Z`,
      endedAt: `2026-08-21T00:1${index}:05.000Z`,
      failures: [providerFailure(summaries[index], modes[index])],
    }));
    if (index < 4) {
      assert.equal(outcome.paused, false, `turn ${index + 1} must not pause`);
      assert.equal(getSessionGoalRunner(conversation).consecutiveSameModeFailureCount, 1);
      assert.equal(getSessionGoalRunner(conversation).consecutiveFailureCount, index + 1);
    }
  }
  assert.equal(outcome.paused, true);
  const runner = getSessionGoalRunner(conversation);
  assert.equal(runner.consecutiveFailureCount, 5);
  assert.match(runner.pauseReason, /连续 5 轮/u);
  assert.equal(isSessionGoalModelFailurePaused(conversation), true);
});

test('unattributable provider:other failures count only toward the total and break the same-mode streak', () => {
  const { store, conversation } = createConversationStore();
  const at = (minute) => ({
    startedAt: `2026-08-21T00:${String(minute).padStart(2, '0')}:00.000Z`,
    endedAt: `2026-08-21T00:${String(minute).padStart(2, '0')}:05.000Z`,
  });
  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome(at(1)));
  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome(at(2)));
  assert.equal(getSessionGoalRunner(conversation).consecutiveSameModeFailureCount, 2);

  // other 模式：只进总数，同模式连击断开。
  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    ...at(3),
    failures: [providerFailure('model refused the request', 'provider:other')],
  }));
  let runner = getSessionGoalRunner(conversation);
  assert.equal(runner.consecutiveSameModeFailureCount, 0);
  assert.equal(runner.lastFailureMode || '', '');
  assert.equal(runner.consecutiveFailureCount, 3);

  // 同模式重新开始计数，不因历史达到 2 而立即暂停。
  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome(at(4)));
  runner = getSessionGoalRunner(conversation);
  assert.equal(runner.consecutiveSameModeFailureCount, 1);
  assert.equal(runner.consecutiveFailureCount, 4);

  const fifth = recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    ...at(5),
    failures: [providerFailure('model refused the request', 'provider:other')],
  }));
  assert.equal(fifth.paused, true);
  assert.match(getSessionGoalRunner(conversation).pauseReason, /连续 5 轮/u);
});

test('a mixed-mode multi-failure turn counts once toward the total and resets the same-mode streak', () => {
  const { store, conversation } = createConversationStore();
  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:01:00.000Z',
    endedAt: '2026-08-21T00:01:05.000Z',
  }));
  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:02:00.000Z',
    endedAt: '2026-08-21T00:02:05.000Z',
  }));
  assert.equal(getSessionGoalRunner(conversation).consecutiveSameModeFailureCount, 2);

  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:03:00.000Z',
    endedAt: '2026-08-21T00:03:05.000Z',
    failedCount: 2,
    failures: [
      providerFailure('fetch failed', 'provider:network'),
      providerFailure('429 too many requests', 'provider:rate_limited'),
    ],
  }));
  const runner = getSessionGoalRunner(conversation);
  assert.equal(runner.consecutiveSameModeFailureCount, 0);
  assert.equal(runner.consecutiveFailureCount, 3);
  assert.equal(getSessionGoal(conversation).status, 'active');
});

test('success and ordinary user turns reset both counters while cancellation is neutral', () => {
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
  assert.equal(getSessionGoalRunner(conversation).consecutiveFailureCount, 0);
  assert.equal(getSessionGoalRunner(conversation).consecutiveSameModeFailureCount, 0);

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
  assert.equal(getSessionGoalRunner(conversation).consecutiveFailureCount, 1);
  assert.equal(getSessionGoalRunner(conversation).consecutiveSameModeFailureCount, 1);

  const ordinaryUserOutcome = goalRunnerOutcome({
    startedAt: '2026-08-21T00:05:00.000Z',
    endedAt: '2026-08-21T00:05:05.000Z',
    completedCount: 1,
    failedCount: 0,
    failures: [],
  });
  ordinaryUserOutcome.sourceMessages = [{ id: 'user-message', metadata: {} }];
  recordSessionGoalContinuationOutcome(store, conversation.id, ordinaryUserOutcome);
  assert.equal(getSessionGoalRunner(conversation).consecutiveFailureCount, 0);
  assert.equal(getSessionGoalRunner(conversation).consecutiveSameModeFailureCount, 0);
});

test('elapsed time between failures no longer matters: a 10-minute gap keeps the streak', () => {
  const { store, conversation } = createConversationStore();
  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:00:00.000Z',
    endedAt: '2026-08-21T00:00:05.000Z',
  }));
  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:10:01.000Z',
    endedAt: '2026-08-21T00:10:06.000Z',
  }));
  assert.equal(getSessionGoalRunner(conversation).consecutiveSameModeFailureCount, 2);
  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:20:01.000Z',
    endedAt: '2026-08-21T00:20:06.000Z',
  }));
  assert.equal(getSessionGoal(conversation).status, 'paused');
});

test('configured thresholds persist and remain authoritative for paused-state consumers', () => {
  const { store, conversation } = createConversationStore();
  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:01:00.000Z',
    endedAt: '2026-08-21T00:01:05.000Z',
    failureThreshold: 2,
    totalFailureThreshold: 4,
  }));
  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:02:00.000Z',
    endedAt: '2026-08-21T00:02:05.000Z',
    failureThreshold: 2,
    totalFailureThreshold: 4,
  }));

  const runner = getSessionGoalRunner(conversation);
  assert.equal(runner.failureThreshold, 2);
  assert.equal(runner.totalFailureThreshold, 4);
  assert.equal(runner.status, 'error_paused');
  assert.equal(isSessionGoalModelFailurePaused(conversation), true);
});

test('legacy error_paused runners recorded by the fast-failure rule stay recognized as paused', () => {
  const { conversation } = createConversationStore({
    sessionGoal: {
      objective: 'Legacy pause state',
      status: 'paused',
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:03:05.000Z',
    },
    sessionGoalRunner: {
      status: 'error_paused',
      goalUpdatedAt: '2026-08-21T00:03:05.000Z',
      iteration: 3,
      maxIterations: 20,
      consecutiveModelFailureCount: 3,
      failureThreshold: 3,
      failureStreakStartedAt: '2026-08-21T00:01:05.000Z',
      lastFailureAt: '2026-08-21T00:03:05.000Z',
      lastFailureKind: 'provider',
      lastFailureCode: 'assistant_error',
      lastFailureSummary: 'fetch failed',
      pauseReason: '连续 3 次快速模型调用失败，Goal 已自动暂停。',
      errorPausedAt: '2026-08-21T00:03:05.000Z',
    },
  });
  assert.equal(isSessionGoalModelFailurePaused(conversation), true);
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
  assert.equal(getSessionGoalRunner(store.getConversation(conversationId)).consecutiveSameModeFailureCount, 2);
  store.close();

  store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  claimSessionGoalAutoContinue(store, conversationId, { maxIterations: 20 });
  const result = recordSessionGoalContinuationOutcome(store, conversationId, goalRunnerOutcome({
    startedAt: '2026-08-21T00:03:00.000Z',
    endedAt: '2026-08-21T00:03:05.000Z',
  }));

  assert.equal(result.paused, true);
  assert.equal(getSessionGoal(store.getConversation(conversationId)).status, 'paused');
  assert.equal(getSessionGoalRunner(store.getConversation(conversationId)).consecutiveSameModeFailureCount, 3);
});

test('stale or malformed runner metadata starts a fresh streak and Goal set clears it', () => {
  const { store, conversation } = createConversationStore({
    sessionGoalRunner: {
      status: 'running',
      goalUpdatedAt: '2026-08-20T00:00:00.000Z',
      iteration: 'broken',
      maxIterations: -20,
      consecutiveModelFailureCount: 99,
      consecutiveFailureCount: 99,
      consecutiveSameModeFailureCount: 99,
      lastFailureMode: 'forged-mode',
      failureStreakStartedAt: 'not-a-date',
      lastFailureKind: 'forged-kind',
    },
  });

  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:01:00.000Z',
    endedAt: '2026-08-21T00:01:05.000Z',
  }));
  assert.equal(getSessionGoalRunner(conversation).consecutiveFailureCount, 1);
  assert.equal(getSessionGoalRunner(conversation).consecutiveSameModeFailureCount, 1);
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

test('an owner change migrates the failure streak instead of resetting it', () => {
  const { store, conversation } = createConversationStore();
  conversation.agents = [
    { id: 'role-family-gpt', name: 'GPT' },
    { id: 'role-family-kimi', name: 'Kimi' },
  ];
  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:01:00.000Z',
    endedAt: '2026-08-21T00:01:05.000Z',
  }));
  recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:02:00.000Z',
    endedAt: '2026-08-21T00:02:05.000Z',
  }));

  applySessionGoalAction(store, conversation.id, { action: 'set-owner', ownerAgentId: 'role-family-kimi' });

  const runner = getSessionGoalRunner(conversation);
  assert.equal(runner.consecutiveSameModeFailureCount, 2);
  assert.equal(runner.consecutiveFailureCount, 2);
  assert.equal(runner.goalUpdatedAt, getSessionGoal(conversation).updatedAt);

  const third = recordSessionGoalContinuationOutcome(store, conversation.id, goalRunnerOutcome({
    startedAt: '2026-08-21T00:03:00.000Z',
    endedAt: '2026-08-21T00:03:05.000Z',
  }));
  assert.equal(third.paused, true);
});
