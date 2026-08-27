const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createSqliteRunStore } = require('../../build/lib/sqlite-store');
const { createMessageRecoveryService } = require('../../build/server/domain/conversation/message-recovery');
const { withClearedRecoveryRuntimeEnvironment } = require('../helpers/recovery-runtime-env');
const { withTempDir } = require('../helpers/temp-dir');

const VALID_SCRIBE_OUTPUT = [
  '## 执行异常后的现场摘要',
  '',
  '> 这是只读现场整理，不会执行或重放原任务。原失败 Trace 保持 failed。',
  '',
  '### 已经完成',
  '- npm run build',
  '',
  '### 失败位置',
  '- stream_read_error',
  '',
  '### 可能已生效但需核验',
  '- kubectl apply',
  '',
  '### 尚未完成',
  '- browser acceptance',
  '',
  '### 建议恢复点',
  '- verify rollout state',
  '',
  '### 无法从现场判断',
  '- provider-side cause',
].join('\n');

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
  runStore.finishRun(sourceRun.runId, {
    status: 'failed',
    terminationType: 'provider_error',
    errorMessage: 'stream_read_error',
    reply: '',
    stderrTail: '',
    parseErrors: 0,
    assistantErrors: ['stream_read_error'],
  });
  runStore.createTask({
    taskId: 'source-task',
    parentRunId: null,
    runId: sourceRun.runId,
    kind: 'conversation_agent_reply',
    title: 'Source Agent reply',
    status: 'failed',
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
    status: 'failed',
    taskId: 'source-task',
    runId: sourceRun.runId,
    errorMessage: 'pi assistant reported a model invocation error',
    metadata: {
      provider: 'source-provider',
      model: 'source-model',
      failure: true,
      sessionName: 'source-session',
      sessionPath,
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
      return { provider, id: model, name: model, api: 'openai-responses' };
    },
    async completeSimple(model, context, completeOptions) {
      modelCalls.push({ model, context, options: completeOptions });
      if (options.modelError) {
        throw new Error('scribe provider unavailable token=must-redact');
      }
      return {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: options.modelOutput || VALID_SCRIBE_OUTPUT }],
        usage: { input: 100, output: 50 },
      };
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
    thinking: 'low',
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

test('manual recovery is durable and idempotent before one no-tools scribe job runs', async (t) => {
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
  assert.equal(fixture.modelCalls[0].options.maxTokens, 2000);
  assert.equal(fixture.modelCalls[0].options.reasoning, 'low');
  assert.equal(Object.hasOwn(fixture.modelCalls[0].options, 'tools'), false);
  assert.match(fixture.modelCalls[0].context.systemPrompt, /no tools|无工具/iu);

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

test('invalid scribe output uses the same one-message mechanical fallback contract', async (t) => {
  const fixture = createFixture(t, { modelOutput: 'unstructured model answer' });
  const accepted = fixture.service.requestRecovery(fixture.conversation.id, fixture.sourceMessage.id);

  await fixture.scheduled[0]();

  const failed = fixture.store.getMessageRecovery(accepted.recovery.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.fallbackUsed, true);
  assert.equal(failed.errorCode, 'conversation_recovery_scribe_failed');
  assert.match(failed.errorMessage, /missing heading/u);
  const message = fixture.store.getMessage(failed.recoveryMessageId);
  assert.match(message.content, /不会执行或重放原任务/u);
  assert.equal(fixture.store.listMessages(fixture.conversation.id).filter((item) => item.metadata.recoveryResult).length, 1);
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
