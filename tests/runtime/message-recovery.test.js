const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createSqliteRunStore } = require('../../build/lib/sqlite-store');
const { createMessageRecoveryService } = require('../../build/server/domain/conversation/message-recovery');
const { withClearedRecoveryRuntimeEnvironment } = require('../helpers/recovery-runtime-env');
const { withTempDir } = require('../helpers/temp-dir');

const VALID_RECOVERY_SUBMISSION = {
  alreadyCompleted: ['npm run build'],
  failureLocation: ['stream_read_error'],
  possiblyEffective: ['kubectl apply'],
  notCompleted: ['browser acceptance'],
  recoveryPoint: ['verify rollout state'],
  unknown: ['provider-side cause'],
};

function recoverySubmissionOutput(argumentsOverride = {}, options = {}) {
  return {
    role: 'assistant',
    stopReason: options.stopReason || 'toolUse',
    content: [
      ...(Array.isArray(options.prefixContent) ? options.prefixContent : []),
      {
        type: 'toolCall',
        id: options.id || 'submit-recovery-note',
        name: options.name || 'submit_recovery_note',
        arguments: { ...VALID_RECOVERY_SUBMISSION, ...argumentsOverride },
      },
      ...(Array.isArray(options.suffixContent) ? options.suffixContent : []),
    ],
    usage: { input: 100, output: 50 },
  };
}

function writeSourceSession(agentDir) {
  const sessionPath = path.join(agentDir, 'named-sessions', 'source-session.jsonl');
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, `${[
    {
      type: 'message',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [{
          type: 'toolCall',
          id: 'tool-1',
          name: 'bash',
          arguments: { command: 'npm run build' },
        }],
      },
    },
    {
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'tool-1',
        toolName: 'bash',
        isError: false,
        content: [{ type: 'text', text: 'build passed' }],
        details: { exitCode: 0 },
      },
    },
  ].map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  return sessionPath;
}

function userCancelledSourceOptions() {
  return {
    sourceRunTerminationType: 'cancelled',
    sourceRunErrorMessage: 'Stopped by user',
    sourceAssistantErrors: [],
    sourceTaskStatus: 'cancelled',
    sourceMessageMetadata: {
      cancelled: true,
      invocationFailure: {
        kind: 'cancelled',
        code: 'cancelled',
        eligible: false,
        terminationType: 'cancelled',
        summary: 'Stopped by user',
      },
    },
  };
}

function createFixture(t, options = {}) {
  const tempDir = withTempDir('caff-message-recovery-service-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const runStore = createSqliteRunStore({ agentDir: tempDir, sqlitePath, db: store.db });
  const scheduled = [];
  const broadcasts = [];
  const modelCalls = [];
  const sessionPath = writeSourceSession(tempDir);
  const agent = store.saveCustomRoleConfig({ id: 'source-agent', name: 'Source Agent', personaPrompt: 'test' });
  const conversation = store.createConversation({
    id: 'recovery-conversation',
    title: 'Recovery',
    participants: [agent.id],
  });
  const sourceRun = runStore.startRun({
    sessionPath,
    requestedSession: 'source-session',
    provider: 'source-provider',
    model: 'source-model',
    thinking: 'high',
    prompt: 'source prompt',
    timeoutMs: 10_000,
    idleTimeoutMs: 10_000,
    heartbeatIntervalMs: 1_000,
    heartbeatTimeoutMs: 2_000,
    terminateGraceMs: 1_000,
    cwd: tempDir,
    taskId: 'source-task',
    taskKind: 'conversation_agent_reply',
    taskRole: agent.name,
    metadata: { conversationId: conversation.id, agentId: agent.id },
  });
  const sourceRunStatus = options.sourceRunStatus || 'failed';
  const sourceRunTerminationType = Object.prototype.hasOwnProperty.call(options, 'sourceRunTerminationType')
    ? options.sourceRunTerminationType
    : sourceRunStatus === 'failed' ? 'provider_error' : null;
  const sourceRunErrorMessage = Object.prototype.hasOwnProperty.call(options, 'sourceRunErrorMessage')
    ? options.sourceRunErrorMessage
    : sourceRunStatus === 'failed' ? 'stream_read_error' : null;
  const sourceAssistantErrors = options.sourceAssistantErrors === undefined
    ? ['stream_read_error']
    : options.sourceAssistantErrors;
  runStore.finishRun(sourceRun.runId, {
    status: sourceRunStatus,
    terminationType: sourceRunTerminationType,
    errorMessage: sourceRunErrorMessage,
    reply: '',
    stderrTail: '',
    parseErrors: 0,
    assistantErrors: sourceAssistantErrors,
  });
  runStore.createTask({
    taskId: 'source-task',
    parentRunId: null,
    runId: sourceRun.runId,
    kind: 'conversation_agent_reply',
    title: 'Source Agent reply',
    status: options.sourceTaskStatus || 'failed',
    assignedAgent: 'pi',
    assignedRole: agent.name,
    provider: 'source-provider',
    model: 'source-model',
    requestedSession: 'source-session',
    sessionPath,
    inputText: 'source prompt',
    errorMessage: 'pi assistant reported a model invocation error',
    metadata: { conversationId: conversation.id, agentId: agent.id },
    startedAt: '2026-08-26T00:00:00.000Z',
    endedAt: '2026-08-26T00:01:00.000Z',
  });
  const sourceMessage = store.createMessage({
    id: 'failed-source-message',
    conversationId: conversation.id,
    turnId: 'source-turn',
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: '',
    status: options.sourceMessageStatus || 'failed',
    taskId: 'source-task',
    runId: sourceRun.runId,
    errorMessage: 'pi assistant reported a model invocation error',
    metadata: {
      provider: 'source-provider',
      model: 'source-model',
      failure: true,
      sessionName: 'source-session',
      sessionPath,
      ...(options.sourceMessageMetadata || {}),
    },
    contextSnapshot: {
      snapshotId: 'source-snapshot',
      conversationId: conversation.id,
      turnId: 'source-turn',
      messageId: 'failed-source-message',
      agentId: agent.id,
      agentName: agent.name,
      sections: [{
        sectionKey: 'session_goal',
        title: 'Session goal',
        displayContent: 'Objective: finish recovery MVP\n- [ ] browser acceptance',
      }],
    },
  });

  const runtime = {
    getModel(provider, model) {
      return {
        provider,
        id: model,
        name: model,
        api: 'openai-responses',
        maxTokens: options.modelMaxTokens || 16_384,
      };
    },
    async completeSimple(model, context, completeOptions) {
      modelCalls.push({ model, context, options: completeOptions });
      if (options.modelError) {
        throw new Error('scribe provider unavailable token=must-redact');
      }
      const response = Array.isArray(options.modelResponses)
        ? options.modelResponses[modelCalls.length - 1]
        : null;
      if (response) {
        return structuredClone(response);
      }
      if (Object.prototype.hasOwnProperty.call(options, 'modelOutput')) {
        return {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: options.modelOutput }],
          usage: { input: 100, output: 50 },
        };
      }
      return recoverySubmissionOutput();
    },
  };
  const mutationState = options.busy
    ? { active: true, dispatching: false, activeTurnCount: 1, activeAgentSlotCount: 0, queuedUserCount: 0, queuedAgentSlotCount: 0, busy: true }
    : { active: false, dispatching: false, activeTurnCount: 0, activeAgentSlotCount: 0, queuedUserCount: 0, queuedAgentSlotCount: 0, busy: false };
  const service = createMessageRecoveryService({
    store,
    runStore,
    agentDir: tempDir,
    sqlitePath,
    modelCatalog: {
      getOptions() {
        return [
          {
            key: 'scribe-provider\u001fscribe-model',
            provider: 'scribe-provider',
            model: 'scribe-model',
            supportedThinkingLevels: ['off', 'low', 'high'],
          },
          {
            key: 'hot-provider\u001fhot-model',
            provider: 'hot-provider',
            model: 'hot-model',
            supportedThinkingLevels: ['off', 'medium'],
          },
        ];
      },
    },
    provider: 'scribe-provider',
    model: 'scribe-model',
    thinking: options.thinking || 'low',
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    getConversationMutationState: () => mutationState,
    resolveAssistantMessageSessionPath: () => sessionPath,
    modelRuntimeFactory: async () => runtime,
    scheduleBackground(work) {
      scheduled.push(work);
    },
    broadcastEvent(eventName, payload) {
      broadcasts.push({ eventName, payload });
    },
  });

  t.after(() => {
    try { runStore.close(); } catch {}
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return {
    tempDir,
    store,
    runStore,
    service,
    conversation,
    sourceMessage,
    sourceRun,
    scheduled,
    broadcasts,
    modelCalls,
  };
}

test('manual recovery is durable and idempotent before one non-Agent scribe job runs', async (t) => {
  const fixture = createFixture(t);
  const participantCountBefore = fixture.store.db.prepare(`
    SELECT COUNT(*) AS count
    FROM chat_conversation_agents
    WHERE conversation_id = ?
  `).get(fixture.conversation.id).count;
  const first = fixture.service.requestRecovery(fixture.conversation.id, fixture.sourceMessage.id);
  const duplicate = fixture.service.requestRecovery(fixture.conversation.id, fixture.sourceMessage.id);

  assert.equal(first.duplicate, false);
  assert.equal(first.recovery.status, 'queued');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.recovery.id, first.recovery.id);
  assert.equal(fixture.scheduled.length, 1);
  assert.equal(fixture.modelCalls.length, 0, 'HTTP acknowledgement must precede the model call');
  assert.equal(fixture.runStore.getTask(first.recovery.recoveryTaskId).status, 'queued');

  await fixture.scheduled[0]();

  const completed = fixture.store.getMessageRecovery(first.recovery.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.fallbackUsed, false);
  assert.equal(fixture.modelCalls.length, 1);
  assert.equal(fixture.modelCalls[0].model.provider, 'scribe-provider');
  assert.equal(fixture.modelCalls[0].model.id, 'scribe-model');
  assert.equal(fixture.modelCalls[0].options.maxTokens, 16_384);
  assert.equal(fixture.modelCalls[0].options.reasoning, 'low');
  assert.equal(Object.hasOwn(fixture.modelCalls[0].options, 'tools'), false);
  assert.deepEqual(fixture.modelCalls[0].context.tools.map((tool) => tool.name), ['submit_recovery_note']);
  assert.equal(fixture.modelCalls[0].options.toolChoice, 'auto');
  assert.match(fixture.modelCalls[0].context.systemPrompt, /no executable tools|无可执行工具/iu);

  const recoveryMessage = fixture.store.getMessage(completed.recoveryMessageId);
  assert.equal(recoveryMessage.status, 'completed');
  assert.equal(recoveryMessage.agentId, null);
  assert.equal(recoveryMessage.senderName, '系统书记');
  assert.equal(recoveryMessage.metadata.recoveryResult, true);
  assert.equal(recoveryMessage.metadata.systemActorType, 'recovery_scribe');
  assert.equal(recoveryMessage.metadata.systemActorRoutable, false);
  assert.equal(recoveryMessage.metadata.sourceMessageId, fixture.sourceMessage.id);
  assert.equal(recoveryMessage.metadata.sourceTaskId, 'source-task');
  assert.equal(recoveryMessage.metadata.sourceRunId, fixture.sourceRun.runId);
  assert.equal(recoveryMessage.metadata.recoveryTaskId, completed.recoveryTaskId);
  assert.equal(recoveryMessage.metadata.recoveryRunId, completed.recoveryRunId);
  assert.match(recoveryMessage.content, /只读现场整理/u);

  const sourceMessageAfter = fixture.store.getMessage(fixture.sourceMessage.id);
  assert.equal(sourceMessageAfter.status, 'failed');
  assert.equal(fixture.runStore.getTask('source-task').status, 'failed');
  assert.equal(fixture.runStore.getRun(fixture.sourceRun.runId).status, 'failed');
  const participantCountAfter = fixture.store.db.prepare(`
    SELECT COUNT(*) AS count
    FROM chat_conversation_agents
    WHERE conversation_id = ?
  `).get(fixture.conversation.id).count;
  assert.equal(participantCountAfter, participantCountBefore);
  assert.equal(fixture.store.getAgent('recovery_scribe'), null);

  const childTask = fixture.runStore.getTask(completed.recoveryTaskId);
  const childRun = fixture.runStore.getRun(completed.recoveryRunId);
  assert.equal(childTask.parent_task_id, 'source-task');
  assert.equal(childTask.parent_run_id, fixture.sourceRun.runId);
  assert.equal(childTask.run_id, completed.recoveryRunId);
  assert.equal(childTask.kind, 'conversation_recovery');
  assert.equal(childTask.assigned_agent, 'caff-system');
  assert.equal(childTask.assigned_role, 'recovery_scribe');
  assert.equal(childTask.status, 'succeeded');
  assert.equal(childRun.parent_run_id, fixture.sourceRun.runId);
  assert.equal(childRun.task_kind, 'conversation_recovery');
  assert.equal(childRun.task_role, 'recovery_scribe');
  assert.equal(childRun.status, 'completed');

  assert.deepEqual(
    fixture.broadcasts.map((event) => event.eventName),
    [
      'conversation_recovery_updated',
      'conversation_recovery_updated',
      'conversation_message_created',
      'conversation_summary_updated',
      'conversation_recovery_updated',
    ]
  );
});

test('scribe accepts one validated submission tool call with companion text and renders the fixed recovery note', async (t) => {
  const fixture = createFixture(t, {
    modelResponses: [{
      role: 'assistant',
      stopReason: 'toolUse',
      content: [
        { type: 'text', text: '现场已经整理完成。' },
        {
          type: 'toolCall',
          id: 'submit-recovery-note-1',
          name: 'submit_recovery_note',
          arguments: {
            alreadyCompleted: ['npm run build'],
            failureLocation: ['stream_read_error'],
            possiblyEffective: ['kubectl apply'],
            notCompleted: ['browser acceptance'],
            recoveryPoint: ['verify rollout state'],
            unknown: ['provider-side cause'],
          },
        }
      ],
      usage: { input: 100, output: 50 },
    }],
  });
  const accepted = fixture.service.requestRecovery(fixture.conversation.id, fixture.sourceMessage.id);

  await fixture.scheduled[0]();

  const completed = fixture.store.getMessageRecovery(accepted.recovery.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.fallbackUsed, false);
  assert.equal(fixture.modelCalls.length, 1);
  assert.deepEqual(fixture.modelCalls[0].context.tools.map((tool) => tool.name), ['submit_recovery_note']);
  assert.equal(fixture.modelCalls[0].options.toolChoice, 'auto');
  const message = fixture.store.getMessage(completed.recoveryMessageId);
  assert.match(message.content, /### 已经完成\n- npm run build/u);
  assert.match(message.content, /### 建议恢复点\n- verify rollout state/u);
  assert.match(message.content, /这是只读现场整理，不会执行或重放原任务。/u);
  assert.doesNotMatch(message.content, /现场已经整理完成/u);
  assert.doesNotMatch(message.content, /"alreadyCompleted"/u);
});

test('scribe retries one thinking-only length response with thinking off and the provider output budget', async (t) => {
  const fixture = createFixture(t, {
    thinking: 'high',
    modelMaxTokens: 32_768,
    modelResponses: [
      {
        role: 'assistant',
        stopReason: 'length',
        content: [{ type: 'thinking', thinking: 'hidden recovery reasoning must not be persisted as the report' }],
        usage: { input: 100, output: 32_768, reasoning: 32_768, totalTokens: 32_868 },
      },
      recoverySubmissionOutput(),
    ],
  });
  const accepted = fixture.service.requestRecovery(fixture.conversation.id, fixture.sourceMessage.id);

  await fixture.scheduled[0]();

  const completed = fixture.store.getMessageRecovery(accepted.recovery.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.fallbackUsed, false);
  assert.equal(fixture.modelCalls.length, 2);
  assert.deepEqual(
    fixture.modelCalls.map((call) => ({ maxTokens: call.options.maxTokens, reasoning: call.options.reasoning })),
    [
      { maxTokens: 32_768, reasoning: 'high' },
      { maxTokens: 32_768, reasoning: 'off' },
    ]
  );
  const events = fixture.runStore.listTaskEvents(completed.recoveryTaskId);
  const attempts = events.filter((event) => event.event_type === 'conversation_recovery_model_attempt');
  assert.deepEqual(attempts.map((event) => event.payload.diagnosticCode), ['length_exhausted', '']);
  assert.equal(JSON.stringify(attempts).includes('hidden recovery reasoning'), false);
});

test('saved system scribe configuration is used by the next recovery while accepted work keeps its request snapshot', async (t) => {
  const fixture = createFixture(t);
  const accepted = fixture.service.requestRecovery(fixture.conversation.id, fixture.sourceMessage.id);
  fixture.service.updateConfiguration({
    enabled: true,
    provider: 'hot-provider',
    model: 'hot-model',
    thinking: 'medium',
    timeoutMs: 45_000,
  });

  await fixture.scheduled[0]();
  assert.equal(fixture.modelCalls[0].model.provider, 'scribe-provider');
  assert.equal(fixture.modelCalls[0].model.id, 'scribe-model');
  assert.equal(fixture.runStore.getTask(accepted.recovery.recoveryTaskId).provider, 'scribe-provider');

  const next = createFixture(t);
  next.service.updateConfiguration({
    enabled: true,
    provider: 'hot-provider',
    model: 'hot-model',
    thinking: 'medium',
    timeoutMs: 45_000,
  });
  next.service.requestRecovery(next.conversation.id, next.sourceMessage.id);
  await next.scheduled[0]();
  assert.equal(next.modelCalls[0].model.provider, 'hot-provider');
  assert.equal(next.modelCalls[0].model.id, 'hot-model');
  assert.equal(next.modelCalls[0].options.reasoning, 'medium');

  const disabled = createFixture(t);
  disabled.service.updateConfiguration({
    enabled: false,
    provider: 'scribe-provider',
    model: 'scribe-model',
    thinking: 'low',
    timeoutMs: 60_000,
  });
  assert.throws(
    () => disabled.service.requestRecovery(disabled.conversation.id, disabled.sourceMessage.id),
    (error) => error && error.statusCode === 503 && error.code === 'conversation_recovery_disabled'
  );
  assert.equal(disabled.scheduled.length, 0);
});

test('scribe failure persists one mechanical fallback while the source trace stays failed', async (t) => {
  const fixture = createFixture(t, { modelError: true });
  const accepted = fixture.service.requestRecovery(fixture.conversation.id, fixture.sourceMessage.id);

  await fixture.scheduled[0]();

  const failed = fixture.store.getMessageRecovery(accepted.recovery.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.fallbackUsed, true);
  assert.equal(fixture.modelCalls.length, 1, 'provider exceptions must not trigger the output fallback retry');
  const providerAttempts = fixture.runStore.listTaskEvents(failed.recoveryTaskId)
    .filter((event) => event.event_type === 'conversation_recovery_model_attempt');
  assert.deepEqual(providerAttempts.map((event) => event.payload.diagnosticCode), ['provider_error']);
  assert.equal(JSON.stringify(providerAttempts).includes('must-redact'), false);
  assert.equal(failed.modelOutput, '');
  assert.equal(failed.errorCode, 'conversation_recovery_scribe_failed');
  assert.equal(failed.errorMessage.includes('must-redact'), false);

  const fallbackMessage = fixture.store.getMessage(failed.recoveryMessageId);
  assert.equal(fallbackMessage.agentId, null);
  assert.equal(fallbackMessage.senderName, '系统书记（机械摘要）');
  assert.equal(fallbackMessage.metadata.systemActorType, 'recovery_scribe');
  assert.equal(fallbackMessage.metadata.systemActorRoutable, false);
  assert.match(fallbackMessage.content, /机械|现场摘要/u);
  assert.match(fallbackMessage.content, /不会执行或重放原任务/u);
  assert.equal(fallbackMessage.metadata.fallbackUsed, true);
  assert.equal(fixture.store.listMessages(fixture.conversation.id).filter((message) => message.metadata.recoveryResult).length, 1);
  assert.equal(fixture.store.getMessage(fixture.sourceMessage.id).status, 'failed');
  assert.equal(fixture.runStore.getTask('source-task').status, 'failed');
  assert.equal(fixture.runStore.getRun(fixture.sourceRun.runId).status, 'failed');
  assert.equal(fixture.runStore.getTask(failed.recoveryTaskId).status, 'failed');
  assert.equal(fixture.runStore.getRun(failed.recoveryRunId).status, 'failed');
});

test('a second length response falls back with a specific bounded diagnostic', async (t) => {
  const fixture = createFixture(t, {
    thinking: 'high',
    modelResponses: [
      {
        role: 'assistant',
        stopReason: 'length',
        content: [{ type: 'thinking', thinking: 'first hidden reasoning' }],
        usage: { output: 16_384, reasoning: 16_384, totalTokens: 16_384 },
      },
      {
        role: 'assistant',
        stopReason: 'length',
        content: [{ type: 'text', text: 'truncated before the submission call' }],
        usage: { output: 16_384, reasoning: 0, totalTokens: 16_384 },
      },
    ],
  });
  const accepted = fixture.service.requestRecovery(fixture.conversation.id, fixture.sourceMessage.id);

  await fixture.scheduled[0]();

  const failed = fixture.store.getMessageRecovery(accepted.recovery.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.fallbackUsed, true);
  assert.equal(failed.errorCode, 'conversation_recovery_scribe_length_exhausted');
  assert.equal(fixture.modelCalls.length, 2);
  const attempts = fixture.runStore.listTaskEvents(failed.recoveryTaskId)
    .filter((event) => event.event_type === 'conversation_recovery_model_attempt');
  assert.deepEqual(attempts.map((event) => event.payload.retryScheduled), [true, false]);
  assert.equal(JSON.stringify(attempts).includes('first hidden reasoning'), false);
});

test('assistant provider errors and 429 responses do not trigger the output fallback retry', async (t) => {
  const fixture = createFixture(t, {
    thinking: 'high',
    modelResponses: [{
      role: 'assistant',
      stopReason: 'error',
      errorMessage: '429 provider overloaded',
      content: [],
      usage: { input: 10, output: 0, totalTokens: 10 },
    }],
  });
  const accepted = fixture.service.requestRecovery(fixture.conversation.id, fixture.sourceMessage.id);

  await fixture.scheduled[0]();

  const failed = fixture.store.getMessageRecovery(accepted.recovery.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'conversation_recovery_scribe_provider_error');
  assert.equal(fixture.modelCalls.length, 1);
});

test('two empty visible responses use the empty_text terminal diagnostic', async (t) => {
  const fixture = createFixture(t, {
    thinking: 'high',
    modelResponses: [1, 2].map((index) => ({
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'thinking', thinking: `hidden empty response ${index}` }],
      usage: { output: 100, reasoning: 100, totalTokens: 100 },
    })),
  });
  const accepted = fixture.service.requestRecovery(fixture.conversation.id, fixture.sourceMessage.id);

  await fixture.scheduled[0]();

  const failed = fixture.store.getMessageRecovery(accepted.recovery.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'conversation_recovery_scribe_empty_text');
  assert.equal(fixture.modelCalls.length, 2);
  const attempts = fixture.runStore.listTaskEvents(failed.recoveryTaskId)
    .filter((event) => event.event_type === 'conversation_recovery_model_attempt');
  assert.deepEqual(attempts.map((event) => event.payload.diagnosticCode), ['empty_text', 'empty_text']);
  assert.equal(JSON.stringify(attempts).includes('hidden empty response'), false);
});

test('invalid scribe output uses the same one-message mechanical fallback contract', async (t) => {
  const fixture = createFixture(t, { modelOutput: 'unstructured model answer' });
  const accepted = fixture.service.requestRecovery(fixture.conversation.id, fixture.sourceMessage.id);

  await fixture.scheduled[0]();

  const failed = fixture.store.getMessageRecovery(accepted.recovery.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.fallbackUsed, true);
  assert.equal(failed.errorCode, 'conversation_recovery_scribe_invalid_output');
  const message = fixture.store.getMessage(failed.recoveryMessageId);
  assert.match(message.content, /不会执行或重放原任务/u);
  assert.equal(fixture.store.listMessages(fixture.conversation.id).filter((item) => item.metadata.recoveryResult).length, 1);
});

test('scribe rejects wrong, multiple, and schema-invalid submissions without retrying', async (t) => {
  const { unknown: _unknown, ...missingUnknown } = VALID_RECOVERY_SUBMISSION;
  const cases = [
    ['wrong tool', recoverySubmissionOutput({}, { name: 'wrong_recovery_tool' })],
    ['multiple calls', recoverySubmissionOutput({}, {
      suffixContent: [{
        type: 'toolCall',
        id: 'second-recovery-submission',
        name: 'submit_recovery_note',
        arguments: VALID_RECOVERY_SUBMISSION,
      }],
    })],
    ['missing field', {
      role: 'assistant',
      stopReason: 'toolUse',
      content: [{
        type: 'toolCall',
        id: 'missing-recovery-field',
        name: 'submit_recovery_note',
        arguments: missingUnknown,
      }],
      usage: { input: 100, output: 50 },
    }],
  ];

  for (const [label, response] of cases) {
    await t.test(label, async (subtest) => {
      const fixture = createFixture(subtest, { modelResponses: [response] });
      const accepted = fixture.service.requestRecovery(fixture.conversation.id, fixture.sourceMessage.id);

      await fixture.scheduled[0]();

      const failed = fixture.store.getMessageRecovery(accepted.recovery.id);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.fallbackUsed, true);
      assert.equal(failed.errorCode, 'conversation_recovery_scribe_invalid_output');
      assert.equal(failed.modelOutput, '');
      assert.equal(fixture.modelCalls.length, 1);
      const attempts = fixture.runStore.listTaskEvents(failed.recoveryTaskId)
        .filter((event) => event.event_type === 'conversation_recovery_model_attempt');
      assert.deepEqual(attempts.map((event) => event.payload.diagnosticCode), ['invalid_output']);
    });
  }
});

test('stale queued work is projected as interrupted without replaying it', (t) => {
  const fixture = createFixture(t);
  const accepted = fixture.service.requestRecovery(fixture.conversation.id, fixture.sourceMessage.id);
  assert.equal(accepted.recovery.status, 'queued');
  assert.equal(fixture.scheduled.length, 1);

  const restartedService = withClearedRecoveryRuntimeEnvironment(() => createMessageRecoveryService({
    store: fixture.store,
    runStore: fixture.runStore,
    agentDir: fixture.tempDir,
    getConversationMutationState: () => ({ busy: false }),
  }));
  assert.equal(restartedService.getConfiguration().config.thinking, 'off');
  const projected = restartedService.projectMessages([fixture.store.getMessage(fixture.sourceMessage.id)])[0];

  assert.equal(projected.recovery.status, 'failed');
  assert.equal(projected.recovery.persistedStatus, 'queued');
  assert.equal(projected.recovery.interrupted, true);
  assert.equal(projected.recovery.errorCode, 'conversation_recovery_interrupted');
  assert.equal(fixture.modelCalls.length, 0);
  assert.equal(fixture.store.getMessageRecovery(accepted.recovery.id).status, 'queued');
});

test('disabled system scribe is projected as unavailable and cannot be triggered', (t) => {
  const fixture = createFixture(t, { enabled: false });
  const [projected] = fixture.service.projectMessages([
    fixture.store.getMessage(fixture.sourceMessage.id),
  ]);

  assert.deepEqual(projected.recoveryCapability, {
    enabled: false,
    eligible: false,
    reasonCode: 'conversation_recovery_disabled',
    reason: '系统书记已停用',
    sourceKind: null,
    systemActorType: 'recovery_scribe',
    routable: false,
  });
  assert.throws(
    () => fixture.service.requestRecovery(fixture.conversation.id, fixture.sourceMessage.id),
    (error) => error
      && error.statusCode === 503
      && error.code === 'conversation_recovery_disabled'
  );
  assert.equal(fixture.scheduled.length, 0);
  assert.equal(fixture.store.getMessageRecoveryBySourceMessage(fixture.sourceMessage.id), null);
  assert.throws(
    () => createMessageRecoveryService({
      store: fixture.store,
      runStore: fixture.runStore,
      agentDir: fixture.tempDir,
      enabled: 'typo',
    }),
    /recovery enabled/iu
  );
  assert.throws(
    () => createMessageRecoveryService({
      store: fixture.store,
      runStore: fixture.runStore,
      agentDir: fixture.tempDir,
      thinking: 'bogus',
    }),
    /Recovery scribe runtime defaults are invalid/iu
  );
  assert.throws(
    () => createMessageRecoveryService({
      store: fixture.store,
      runStore: fixture.runStore,
      agentDir: fixture.tempDir,
      timeoutMs: 60_001,
    }),
    /recovery timeout must be between 1000 and 60000/iu
  );
});

test('evidence-consistent user stop is projected and accepted without rewriting the cancelled source', async (t) => {
  const fixture = createFixture(t, userCancelledSourceOptions());
  const sourceBefore = {
    message: fixture.store.getMessage(fixture.sourceMessage.id),
    task: fixture.runStore.getTask('source-task'),
    run: fixture.runStore.getRun(fixture.sourceRun.runId),
  };
  const [projected] = fixture.service.projectMessages([sourceBefore.message]);

  assert.deepEqual(projected.recoveryCapability, {
    enabled: true,
    eligible: true,
    reasonCode: '',
    reason: '',
    sourceKind: 'user_cancelled',
    systemActorType: 'recovery_scribe',
    routable: false,
  });

  const accepted = fixture.service.requestRecovery(fixture.conversation.id, fixture.sourceMessage.id);
  assert.equal(accepted.duplicate, false);
  assert.equal(fixture.scheduled.length, 1, 'Stop settlement must not invoke the scribe automatically');
  assert.equal(
    fixture.runStore.getTask(accepted.recovery.recoveryTaskId).metadata.sourceKind,
    'user_cancelled'
  );
  await fixture.scheduled[0]();

  const completed = fixture.store.getMessageRecovery(accepted.recovery.id);
  assert.deepEqual(fixture.store.getMessage(fixture.sourceMessage.id), sourceBefore.message);
  assert.deepEqual(fixture.runStore.getTask('source-task'), sourceBefore.task);
  assert.deepEqual(fixture.runStore.getRun(fixture.sourceRun.runId), sourceBefore.run);
  assert.equal(fixture.runStore.getRun(completed.recoveryRunId).metadata.sourceKind, 'user_cancelled');
  assert.equal(fixture.store.getMessage(completed.recoveryMessageId).metadata.sourceKind, 'user_cancelled');
  assert.equal(fixture.modelCalls.length, 1);
  assert.equal(Object.hasOwn(fixture.modelCalls[0].options, 'tools'), false);
});

test('user-stopped source remains an optional action after service restart and is never auto-scheduled', (t) => {
  const fixture = createFixture(t, userCancelledSourceOptions());
  const restartedWork = [];
  const restartedService = withClearedRecoveryRuntimeEnvironment(() => createMessageRecoveryService({
    store: fixture.store,
    runStore: fixture.runStore,
    agentDir: fixture.tempDir,
    provider: 'scribe-provider',
    model: 'scribe-model',
    thinking: 'off',
    modelCatalog: {
      getOptions() {
        return [{
          key: 'scribe-provider\u001fscribe-model',
          provider: 'scribe-provider',
          model: 'scribe-model',
          supportedThinkingLevels: ['off'],
        }];
      },
    },
    getConversationMutationState: () => ({ busy: false }),
    scheduleBackground(work) {
      restartedWork.push(work);
    },
  }));

  const [projected] = restartedService.projectMessages([
    fixture.store.getMessage(fixture.sourceMessage.id),
  ]);
  assert.equal(projected.recoveryCapability.eligible, true);
  assert.equal(projected.recoveryCapability.sourceKind, 'user_cancelled');
  assert.equal(restartedWork.length, 0);
  assert.equal(fixture.store.getMessageRecoveryBySourceMessage(fixture.sourceMessage.id), null);

  const accepted = restartedService.requestRecovery(fixture.conversation.id, fixture.sourceMessage.id);
  assert.equal(accepted.duplicate, false);
  assert.equal(restartedWork.length, 1);
  assert.equal(fixture.modelCalls.length, 0);
});

test('user-stopped source retains busy, snapshot, and session fail-closed gates', (t) => {
  const busy = createFixture(t, { ...userCancelledSourceOptions(), busy: true });
  const [busyProjected] = busy.service.projectMessages([
    busy.store.getMessage(busy.sourceMessage.id),
  ]);
  assert.equal(busyProjected.recoveryCapability.eligible, false);
  assert.equal(busyProjected.recoveryCapability.reasonCode, 'conversation_recovery_conversation_busy');
  assert.equal(busyProjected.recoveryCapability.sourceKind, null);

  const missingSnapshot = createFixture(t, userCancelledSourceOptions());
  missingSnapshot.store.getMessageContextSnapshot = () => null;
  const [snapshotProjected] = missingSnapshot.service.projectMessages([
    missingSnapshot.store.getMessage(missingSnapshot.sourceMessage.id),
  ]);
  assert.equal(snapshotProjected.recoveryCapability.eligible, false);
  assert.equal(
    snapshotProjected.recoveryCapability.reasonCode,
    'conversation_recovery_source_snapshot_missing'
  );
  assert.throws(
    () => missingSnapshot.service.requestRecovery(
      missingSnapshot.conversation.id,
      missingSnapshot.sourceMessage.id
    ),
    (error) => error
      && error.statusCode === 409
      && error.code === 'conversation_recovery_source_snapshot_missing'
  );

  const missingSession = createFixture(t, userCancelledSourceOptions());
  fs.rmSync(missingSession.sourceMessage.metadata.sessionPath, { force: true });
  const [sessionProjected] = missingSession.service.projectMessages([
    missingSession.store.getMessage(missingSession.sourceMessage.id),
  ]);
  assert.equal(sessionProjected.recoveryCapability.eligible, false);
  assert.equal(
    sessionProjected.recoveryCapability.reasonCode,
    'conversation_recovery_source_session_missing'
  );
  assert.throws(
    () => missingSession.service.requestRecovery(
      missingSession.conversation.id,
      missingSession.sourceMessage.id
    ),
    (error) => error
      && error.statusCode === 409
      && error.code === 'conversation_recovery_source_session_missing'
  );
  assert.equal(busy.scheduled.length + missingSnapshot.scheduled.length + missingSession.scheduled.length, 0);
});

test('partial or contradictory cancellation evidence fails closed with one stable reason', (t) => {
  const cancellationMetadata = {
    cancelled: true,
    invocationFailure: {
      kind: 'cancelled',
      code: 'cancelled',
      eligible: false,
      terminationType: 'cancelled',
      summary: 'Stopped by user',
    },
  };
  const cases = [
    {
      name: 'message evidence only',
      options: { sourceMessageMetadata: cancellationMetadata },
    },
    {
      name: 'task and run evidence only',
      options: {
        sourceTaskStatus: 'cancelled',
        sourceRunTerminationType: 'cancelled',
        sourceAssistantErrors: [],
      },
    },
    {
      name: 'run termination only',
      options: {
        sourceRunTerminationType: 'cancelled',
        sourceAssistantErrors: [],
      },
    },
    {
      name: 'provider abort cannot impersonate a user stop',
      options: {
        sourceRunTerminationType: 'cancelled',
        sourceRunErrorMessage: 'provider aborted stream',
        sourceAssistantErrors: ['provider aborted stream'],
        sourceMessageMetadata: {
          cancelled: false,
          invocationFailure: {
            kind: 'provider',
            code: 'assistant_error',
            eligible: true,
            terminationType: '',
            summary: 'provider aborted stream',
          },
        },
      },
    },
    {
      name: 'cancelled invocation marked eligible',
      options: {
        sourceTaskStatus: 'cancelled',
        sourceRunTerminationType: 'cancelled',
        sourceAssistantErrors: [],
        sourceMessageMetadata: {
          ...cancellationMetadata,
          invocationFailure: {
            ...cancellationMetadata.invocationFailure,
            eligible: true,
          },
        },
      },
    },
  ];

  for (const entry of cases) {
    const fixture = createFixture(t, entry.options);
    const [projected] = fixture.service.projectMessages([
      fixture.store.getMessage(fixture.sourceMessage.id),
    ]);

    assert.equal(projected.recoveryCapability.eligible, false, entry.name);
    assert.equal(
      projected.recoveryCapability.reasonCode,
      'conversation_recovery_source_cancellation_mismatch',
      entry.name
    );
    assert.equal(projected.recoveryCapability.sourceKind, null, entry.name);
    assert.throws(
      () => fixture.service.requestRecovery(fixture.conversation.id, fixture.sourceMessage.id),
      (error) => error
        && error.statusCode === 409
        && error.code === 'conversation_recovery_source_cancellation_mismatch',
      entry.name
    );
    assert.equal(fixture.scheduled.length, 0, entry.name);
  }
});

test('timeout and provider failures remain failed-source recoveries, not user cancellations', (t) => {
  const cases = [
    {
      name: 'watchdog timeout',
      sourceRunTerminationType: 'progress_timeout',
      sourceRunErrorMessage: 'pi progress missing',
      sourceAssistantErrors: [],
      sourceMessageMetadata: {
        cancelled: false,
        invocationFailure: {
          kind: 'timeout',
          code: 'progress_timeout',
          eligible: true,
          terminationType: 'progress_timeout',
          summary: 'pi progress missing',
        },
      },
    },
    {
      name: 'provider abort',
      sourceRunTerminationType: 'provider_error',
      sourceRunErrorMessage: 'provider aborted stream',
      sourceAssistantErrors: ['provider aborted stream'],
      sourceMessageMetadata: {
        cancelled: false,
        invocationFailure: {
          kind: 'provider',
          code: 'assistant_error',
          eligible: true,
          terminationType: '',
          summary: 'provider aborted stream',
        },
      },
    },
  ];

  for (const options of cases) {
    const fixture = createFixture(t, options);
    const [projected] = fixture.service.projectMessages([
      fixture.store.getMessage(fixture.sourceMessage.id),
    ]);

    assert.equal(projected.recoveryCapability.eligible, true, options.name);
    assert.equal(projected.recoveryCapability.sourceKind, 'failed', options.name);
  }
});

test('ordinary success and queued cancellation without a linked run remain ineligible', (t) => {
  const succeeded = createFixture(t, {
    sourceRunStatus: 'succeeded',
    sourceAssistantErrors: [],
    sourceTaskStatus: 'succeeded',
    sourceMessageStatus: 'completed',
  });
  const [succeededProjection] = succeeded.service.projectMessages([
    succeeded.store.getMessage(succeeded.sourceMessage.id),
  ]);
  assert.equal(succeededProjection.recoveryCapability, undefined);
  assert.throws(
    () => succeeded.service.requestRecovery(succeeded.conversation.id, succeeded.sourceMessage.id),
    (error) => error
      && error.statusCode === 409
      && error.code === 'conversation_recovery_source_not_failed'
  );

  const queued = createFixture(t, {
    sourceTaskStatus: 'cancelled',
    sourceRunTerminationType: 'cancelled',
    sourceAssistantErrors: [],
    sourceMessageMetadata: {
      cancelled: true,
      invocationFailure: {
        kind: 'cancelled',
        code: 'cancelled',
        eligible: false,
        terminationType: 'cancelled',
        summary: 'Stopped before dispatch',
      },
    },
  });
  queued.store.updateMessage(queued.sourceMessage.id, { runId: null });
  const [queuedProjection] = queued.service.projectMessages([
    queued.store.getMessage(queued.sourceMessage.id),
  ]);
  assert.equal(queuedProjection.recoveryCapability.eligible, false);
  assert.equal(queuedProjection.recoveryCapability.reasonCode, 'conversation_recovery_source_run_missing');
  assert.throws(
    () => queued.service.requestRecovery(queued.conversation.id, queued.sourceMessage.id),
    (error) => error
      && error.statusCode === 409
      && error.code === 'conversation_recovery_source_run_missing'
  );
});

test('historical succeeded run with explicit assistant errors remains recoverable without source rewrites', async (t) => {
  const fixture = createFixture(t, {
    sourceRunStatus: 'succeeded',
    sourceAssistantErrors: ['connection error: stream_read_error'],
  });
  const [projected] = fixture.service.projectMessages([
    fixture.store.getMessage(fixture.sourceMessage.id),
  ]);

  assert.deepEqual(projected.recoveryCapability, {
    enabled: true,
    eligible: true,
    reasonCode: '',
    reason: '',
    sourceKind: 'failed',
    systemActorType: 'recovery_scribe',
    routable: false,
  });

  const accepted = fixture.service.requestRecovery(fixture.conversation.id, fixture.sourceMessage.id);
  assert.equal(accepted.duplicate, false);
  await fixture.scheduled[0]();

  assert.equal(fixture.store.getMessage(fixture.sourceMessage.id).status, 'failed');
  assert.equal(fixture.runStore.getTask('source-task').status, 'failed');
  assert.equal(fixture.runStore.getRun(fixture.sourceRun.runId).status, 'succeeded');
  assert.deepEqual(
    fixture.runStore.getRun(fixture.sourceRun.runId).assistantErrors,
    ['connection error: stream_read_error']
  );
});

test('succeeded run without explicit assistant errors is rejected and projected with a stable reason', (t) => {
  const fixture = createFixture(t, {
    sourceRunStatus: 'succeeded',
    sourceAssistantErrors: [],
  });
  const [projected] = fixture.service.projectMessages([
    fixture.store.getMessage(fixture.sourceMessage.id),
  ]);

  assert.deepEqual(projected.recoveryCapability, {
    enabled: true,
    eligible: false,
    reasonCode: 'conversation_recovery_source_run_not_failed',
    reason: '来源运行没有可验证的失败终态或 assistant error 证据',
    sourceKind: null,
    systemActorType: 'recovery_scribe',
    routable: false,
  });
  assert.throws(
    () => fixture.service.requestRecovery(fixture.conversation.id, fixture.sourceMessage.id),
    (error) => error
      && error.statusCode === 409
      && error.code === 'conversation_recovery_source_run_not_failed'
  );
  assert.equal(fixture.scheduled.length, 0);
});

test('busy and missing-session sources project the same stable rejection used by POST', (t) => {
  const busy = createFixture(t, { busy: true });
  const [busyProjected] = busy.service.projectMessages([
    busy.store.getMessage(busy.sourceMessage.id),
  ]);
  assert.deepEqual(busyProjected.recoveryCapability, {
    enabled: true,
    eligible: false,
    reasonCode: 'conversation_recovery_conversation_busy',
    reason: '会话仍有运行中或排队任务，空闲后才能整理失败现场',
    sourceKind: null,
    systemActorType: 'recovery_scribe',
    routable: false,
  });

  const missingSession = createFixture(t);
  fs.rmSync(missingSession.sourceMessage.metadata.sessionPath, { force: true });
  const [missingSessionProjected] = missingSession.service.projectMessages([
    missingSession.store.getMessage(missingSession.sourceMessage.id),
  ]);
  assert.equal(missingSessionProjected.recoveryCapability.eligible, false);
  assert.equal(
    missingSessionProjected.recoveryCapability.reasonCode,
    'conversation_recovery_source_session_missing'
  );
  assert.throws(
    () => missingSession.service.requestRecovery(
      missingSession.conversation.id,
      missingSession.sourceMessage.id
    ),
    (error) => error
      && error.statusCode === 409
      && error.code === 'conversation_recovery_source_session_missing'
  );
  assert.equal(missingSession.scheduled.length, 0);
});

test('manual recovery validates idle, same-conversation failed source integrity before persistence', (t) => {
  const busy = createFixture(t, { busy: true });
  assert.throws(
    () => busy.service.requestRecovery(busy.conversation.id, busy.sourceMessage.id),
    (error) => error && error.statusCode === 409 && error.code === 'conversation_recovery_conversation_busy'
  );
  assert.equal(busy.store.getMessageRecoveryBySourceMessage(busy.sourceMessage.id), null);

  const fixture = createFixture(t);
  assert.throws(
    () => fixture.service.requestRecovery('missing-conversation', fixture.sourceMessage.id),
    (error) => error && error.statusCode === 404 && error.code === 'conversation_recovery_conversation_not_found'
  );
  assert.throws(
    () => fixture.service.requestRecovery(fixture.conversation.id, 'missing-message'),
    (error) => error && error.statusCode === 404 && error.code === 'conversation_recovery_source_not_found'
  );

  const userMessage = fixture.store.createMessage({
    id: 'user-message',
    conversationId: fixture.conversation.id,
    turnId: 'user-turn',
    role: 'user',
    senderName: 'You',
    content: 'hello',
    status: 'completed',
  });
  assert.throws(
    () => fixture.service.requestRecovery(fixture.conversation.id, userMessage.id),
    (error) => error && error.statusCode === 409 && error.code === 'conversation_recovery_source_not_failed'
  );
});
