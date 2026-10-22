const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { createServerApp } = require('../../build/server/app/create-server');
const { createMessageRecoveryService } = require('../../build/server/domain/conversation/message-recovery');
const { createAgentDelegation } = require('../../build/server/domain/conversation/agent-delegation');
const { createAgentToolBridge } = require('../../build/server/domain/runtime/agent-tool-bridge');
const { bindAndPersistRoomWorkspace } = require('../../build/server/domain/conversation/room-workspace');
const { registerTurnHandle, unregisterTurnHandle } = require('../../build/server/domain/conversation/turn/turn-stop');
const { createInterruptedFixture } = require('../helpers/interrupted-runs');
const { isolateExternalIntegrations } = require('../helpers/external-integrations');
const { withClearedRecoveryRuntimeEnvironment } = require('../helpers/recovery-runtime-env');

isolateExternalIntegrations();

function openApp(t, f, options = {}) {
  const app = withClearedRecoveryRuntimeEnvironment(() => createServerApp({
    host: '127.0.0.1', port: 0, agentDir: f.dir, sqlitePath: f.sqlitePath,
    projectDir: f.dir, uploadsDir: path.join(f.dir, 'uploads'),
    modelCatalog: {
      getOptions() { return [{
        key: 'test-provider\u001ftest-model', provider: 'test-provider', model: 'test-model',
        runtimeResolvable: true, supportedThinkingLevels: ['off', 'low', 'medium', 'high'],
      }]; },
      invalidate() {},
    },
    ...options,
  }));
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await new Promise(resolve => app.close(resolve));
  }
  f.addCleanup(close);
  return { app, close };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'synthetic execution did not reach expected state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('startup fails orphan messages, runs and tasks before dispatching new work', async t => {
  const f = createInterruptedFixture(t);
  const records = ['queued', 'running', 'streaming'].map(status => f.seed(status));
  const { app, close } = openApp(t, f);
  try {
    for (const record of records) {
      assert.equal(app.store.getMessage(record.message.id).status, 'failed');
      assert.equal(app.store.getMessage(record.message.id).errorMessage, '服务重启中断');
      assert.equal(f.runs.getRun(record.runId).status, 'failed');
      assert.equal(f.runs.getTask(record.taskId).status, 'failed');
    }
  } finally { await close(); }
});

test('startup reconciliation preserves side dispatch resubmission and pending user queue recovery', async t => {
  const f = createInterruptedFixture(t);
  const source = f.store.createMessage({
    conversationId: f.room.id, role: 'user', content: 'Synthetic side dispatch', status: 'completed',
    metadata: { dispatchLane: 'side', dispatchTargetAgentId: f.agent.id },
  });
  const stale = f.seed('streaming', { metadata: { triggeredByMessageId: source.id } });
  const pendingRoom = f.store.createConversation({ id: 'pending-room', title: 'Pending', participants: [f.agent.id] });
  const pending = f.store.createMessage({ conversationId: pendingRoom.id, role: 'user', content: 'Pending input', status: 'completed' });
  const executions = [];
  const { app, close } = openApp(t, f, {
    async executeConversationAgent(input) {
      executions.push({ lane: input.turnState.executionLane, source: input.promptUserMessage.id });
      input.completedReplies.push({ agentId: input.agent.id, content: 'Synthetic response', status: 'completed' });
      return { stopTurn: false };
    },
  });
  try {
    await waitFor(() => executions.some(e => e.source === source.id));
    assert.equal(executions.filter(e => e.source === source.id).length, 1);
    assert.equal(executions.find(e => e.source === source.id).lane, 'side');
    assert.equal(app.store.getMessage(stale.message.id).errorMessage, 'Recovered after process restart before side dispatch completed');
    assert.equal(app.turnOrchestrator.getConversationQueueDepth(pendingRoom.id), 1);
    assert.equal(app.store.getMessage(pending.id).role, 'user');
    assert.equal(f.runs.getRun(stale.runId).status, 'failed', 'old side-dispatch process is never resumed');
    await waitFor(() => app.turnOrchestrator.getRuntimeStats().activeAgentSlots === 0);
  } finally { await close(); }
});

test('startup fails an old side reply task even when interruption preceded run creation', async t => {
  const f = createInterruptedFixture(t);
  const source = f.store.createMessage({
    conversationId: f.room.id, role: 'user', content: 'Side work before child spawn', status: 'completed',
    metadata: { dispatchLane: 'side', dispatchTargetAgentId: f.agent.id },
  });
  const task = f.runs.createTask({ taskId: 'before-spawn', kind: 'conversation_agent_reply', status: 'running' });
  const stale = f.store.createMessage({
    conversationId: f.room.id, role: 'assistant', content: 'Thinking...', status: 'queued', taskId: task.id,
    metadata: { triggeredByMessageId: source.id },
  });
  let resumed = false;
  const { app, close } = openApp(t, f, {
    async executeConversationAgent(input) {
      resumed = true;
      input.completedReplies.push({ agentId: input.agent.id, content: 'Fresh side execution', status: 'completed' });
      return { stopTurn: false };
    },
  });
  try {
    assert.equal(f.runs.getTask(task.id).status, 'failed');
    assert.equal(f.runs.getTask(task.id).error_message, '服务重启中断');
    assert.equal(app.store.getMessage(stale.id).errorMessage, 'Recovered after process restart before side dispatch completed');
    await waitFor(() => resumed);
    await waitFor(() => app.turnOrchestrator.getRuntimeStats().activeAgentSlots === 0);
  } finally { await close(); }
});

test('a startup-reconciled message is accepted by the unchanged recovery entry point', async t => {
  const f = createInterruptedFixture(t);
  const sessionPath = path.join(f.dir, 'named-sessions', 'source-session.jsonl');
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, `${JSON.stringify({ type: 'message', message: {
    role: 'assistant', content: [{ type: 'text', text: 'Partial synthetic answer' }], stopReason: 'error',
  } })}\n`);
  const record = f.seed('streaming', {
    metadata: { sessionPath },
    contextSnapshot: {
      snapshotId: 'synthetic-snapshot', conversationId: f.room.id, messageId: 'interrupted-1',
      sections: [{ sectionKey: 'session_goal', title: 'Goal', displayContent: 'Synthetic recovery compatibility' }],
    },
  });
  f.store.db.prepare('UPDATE runs SET session_path = ? WHERE id = ?').run(sessionPath, record.runId);
  f.runs.updateTask(record.taskId, { sessionPath });
  const { app, close } = openApp(t, f);
  const scheduled = [];
  const config = { enabled: true, provider: 'test-provider', model: 'test-model', thinking: 'off', timeoutMs: 60000 };
  const service = withClearedRecoveryRuntimeEnvironment(() => createMessageRecoveryService({
    store: app.store, agentDir: f.dir, sqlitePath: f.sqlitePath,
    configManager: { getConfiguration: () => ({ config, readiness: { ready: true } }), getConfigSnapshot: () => config },
    getConversationMutationState: () => app.turnOrchestrator.getConversationMutationState(f.room.id),
    resolveAssistantMessageSessionPath: () => sessionPath,
    scheduleBackground: work => scheduled.push(work),
    modelRuntimeFactory: async () => ({
      getModel: () => ({ provider: 'test-provider', id: 'test-model', maxTokens: 16384 }),
      completeSimple: async () => ({ role: 'assistant', stopReason: 'toolUse', content: [{
        type: 'toolCall', id: 'synthetic-note', name: 'submit_recovery_note', arguments: {
          alreadyCompleted: [], failureLocation: ['Service restart'], possiblyEffective: [],
          notCompleted: [], recoveryPoint: [], unknown: [],
        },
      }] }),
    }),
  }));
  try {
    const accepted = service.requestRecovery(f.room.id, record.message.id);
    assert.equal(accepted.duplicate, false);
    assert.equal(accepted.recovery.status, 'queued');
    assert.equal(scheduled.length, 1);
    await scheduled[0]();
    const recovered = app.store.getMessageRecovery(accepted.recovery.id);
    assert.equal(recovered.status, 'completed', recovered.errorMessage);
  } finally { await close(); }
});

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('startup reconciliation unblocks rename authorization; a live synthetic turn still blocks it', async t => {
  const f = createInterruptedFixture(t);
  f.seed();
  const repo = path.join(f.dir, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'CAFF Test']);
  git(repo, ['config', 'user.email', 'caff-test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'synthetic repository\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'synthetic base']);
  git(repo, ['branch', 'develop']);
  const project = { id: 'synthetic-project', path: repo };
  f.store.bindConversationProjectScope(f.room.id, project.id);
  bindAndPersistRoomWorkspace({ store: f.store, conversation: f.store.getConversationWithoutMessages(f.room.id), project });
  let release;
  let active = false;
  const { app, close } = openApp(t, f, {
    executeConversationAgent: async input => {
      const live = f.seed('streaming');
      active = true;
      await new Promise(resolve => { release = resolve; });
      f.store.updateMessage(live.message.id, { status: 'completed' });
      f.runs.finishRun(live.runId, { status: 'succeeded' });
      f.runs.updateTask(live.taskId, { status: 'succeeded' });
      input.completedReplies.push({ agentId: input.agent.id, content: 'Finished', status: 'completed' });
      return { stopTurn: false };
    },
  });
  const bridge = createAgentToolBridge({ store: app.store, resolveProject: () => project });
  const context = bridge.registerInvocation(bridge.createInvocationContext({
    conversationId: f.room.id, turnId: 'rename-request', agentId: f.agent.id,
    agentName: f.agent.name, conversationAgents: [f.agent],
  }));
  async function card(branchName) {
    await bridge.handlePiCapability('room_workspace_rename_preview', {
      invocationId: context.invocationId, callbackToken: context.callbackToken, arguments: { branchName },
    });
    return bridge.listRoomWorkspaceAuthorizations(f.room.id).find(c => c.status === 'pending');
  }
  function approve(c) {
    return bridge.handleRoomWorkspaceAuthorization({
      conversationId: f.room.id, authorizationId: c.id, token: c.token, decision: 'accepted', fingerprint: c.fingerprint,
    });
  }
  try {
    const approved = await approve(await card('feature/after-restart'));
    assert.equal(approved.record.status, 'accepted');
    app.turnOrchestrator.submitConversationMessage(f.room.id, { content: 'Synthetic live turn' });
    await waitFor(() => active);
    const blocked = await card('feature/while-active');
    await assert.rejects(approve(blocked), error => error.code === 'room_workspace_execution_active');
    release();
    await waitFor(() => app.turnOrchestrator.getRuntimeStats().activeTurns === 0);
  } finally {
    release?.();
    await close();
  }
});

test('shutdown cancels both lanes and queued side waiters without launching queued work', async t => {
  const f = createInterruptedFixture(t);
  f.store.saveCustomRoleConfig({ ...f.agent, name: 'Alpha' });
  const beta = f.store.saveCustomRoleConfig({
    id: 'beta-agent', name: 'Beta', personaPrompt: 'Synthetic only', provider: 'test-provider', model: 'test-model',
  });
  f.store.updateConversation(f.room.id, { participants: [f.agent.id, beta.id] });
  const executions = [];
  const cancellations = [];
  const releases = [];
  const { app, close } = openApp(t, f, {
    executeConversationAgent: async input => {
      let release;
      const done = new Promise(resolve => { release = resolve; });
      releases.push(release);
      const handle = { cancel(reason) { cancellations.push({ lane: input.turnState.executionLane, reason }); release(); } };
      registerTurnHandle(input.turnState, handle);
      executions.push({ lane: input.turnState.executionLane, agent: input.agent.id });
      await done;
      unregisterTurnHandle(input.turnState, handle);
      return { stopTurn: true };
    },
  });
  try {
    app.turnOrchestrator.submitConversationMessage(f.room.id, { content: '@Alpha main turn' });
    await waitFor(() => executions.length === 1);
    const queued = app.turnOrchestrator.submitConversationMessage(f.room.id, { content: '@Alpha queued side' });
    assert.equal(queued.dispatch, 'queued');
    assert.equal(queued.dispatchLane, 'side');
    app.turnOrchestrator.submitConversationMessage(f.room.id, { content: '@Beta live side' });
    await waitFor(() => executions.length === 2);
    app.turnOrchestrator.submitConversationMessage(f.room.id, { content: 'Pending main input' });
    await close();
    assert.equal(executions.length, 2, 'shutdown must not drain either pending lane');
    assert.equal(cancellations.length, 2);
    assert.ok(cancellations.every(item => item.reason === '服务关闭中断'));
    assert.deepEqual(app.turnOrchestrator.getRuntimeStats(), { activeTurns: 0, activeAgentSlots: 0, activeQueues: 0 });
    assert.notEqual(f.store.getMessage(queued.acceptedMessage.id).metadata.dispatchCancelled, true,
      'service shutdown is not persisted as a user cancellation of queued side work');
  } finally {
    for (const release of releases) release();
    await close();
  }
});

test('shutdown persists a settled delegation continuation without dispatch and restart keeps it pending', async t => {
  const f = createInterruptedFixture(t);
  const recipient = f.store.saveCustomRoleConfig({
    id: 'delegation-recipient', name: 'Recipient', personaPrompt: 'Synthetic only',
    provider: 'test-provider', model: 'test-model',
  });
  f.store.updateConversation(f.room.id, {
    participants: [f.agent.id, recipient.id],
    metadata: { conversationTurnQueue: { lastConsumedUserMessageId: '' } },
  });
  const executions = [];
  let release;
  const { app, close } = openApp(t, f, {
    executeConversationAgent: async input => {
      executions.push(input.agent.id);
      const reply = f.store.createMessage({
        conversationId: input.conversationId, turnId: input.turnId,
        role: 'assistant', agentId: input.agent.id, content: 'Thinking...', status: 'streaming',
        metadata: { streaming: true, triggeredByMessageId: input.promptUserMessage.id },
      });
      const stopped = new Promise(resolve => { release = resolve; });
      const handle = { cancel(reason) { release(reason); } };
      registerTurnHandle(input.turnState, handle);
      try {
        const reason = await stopped;
        f.store.updateMessage(reply.id, { status: 'failed', errorMessage: reason });
        // Let the real side-dispatch catch settle the child through the server's
        // delegation runtime/onCompletion wiring while shutdown is in progress.
        throw new Error(reason);
      } finally { unregisterTurnHandle(input.turnState, handle); }
    },
  });
  const created = createAgentDelegation(app.store, {
    conversationId: f.room.id, agentId: f.agent.id, agentName: f.agent.name,
    invocationId: 'shutdown-requester', turnId: 'shutdown-requester-turn',
  }, { recipientAgentIds: [recipient.id], content: 'Synthetic delegated work', idempotencyKey: 'shutdown' });
  const delegation = app.store.markAgentDelegationAwaiting(created.delegation.id, new Date().toISOString());
  app.turnOrchestrator.dispatchAgentDelegation({ delegation, childDelegations: created.childDelegations });
  const continuations = store => store.listMessages(f.room.id).filter(message =>
    message.metadata.source === 'agent-delegation-continuation' && message.metadata.delegationId === delegation.id);
  try {
    await waitFor(() => executions.length === 1);
    await close();
    assert.deepEqual(executions, [recipient.id], 'closing must not execute the requester continuation');
    assert.equal(f.store.getAgentDelegation(created.childDelegations[0].id).status, 'cancelled');
    const terminal = f.store.getAgentDelegation(delegation.id);
    assert.equal(terminal.status, 'failed');
    assert.ok(terminal.continuationEnqueuedAt);
    assert.equal(f.store.listAgentDelegationEvents(delegation.id)
      .filter(event => event.event_type === 'continuation_enqueued').length, 1);
    const persisted = continuations(f.store);
    assert.equal(persisted.length, 1, 'the one-shot continuation marker must have a durable requester message');
    assert.deepEqual(persisted[0].metadata.initialAgentIds, [f.agent.id]);
    assert.equal(persisted[0].role, 'user');
    assert.equal(persisted[0].status, 'completed');
    assert.match(persisted[0].content, /"status":"failed"/u);

    const restarted = openApp(t, f, {
      async executeConversationAgent(input) {
        executions.push(input.agent.id);
        return { stopTurn: false };
      },
    });
    try {
      assert.deepEqual(continuations(restarted.app.store).map(message => message.id), [persisted[0].id]);
      assert.deepEqual(restarted.app.store.listPendingMainUserMessages(f.room.id).map(message => message.id), [persisted[0].id]);
      assert.equal(restarted.app.turnOrchestrator.getConversationQueueDepth(f.room.id), 1);
      assert.deepEqual(executions, [recipient.id], 'restart must retain the pending message without replaying the stopped child');
      assert.equal(restarted.app.store.getAgentDelegation(delegation.id).continuationEnqueuedAt, terminal.continuationEnqueuedAt);
    } finally { await restarted.close(); }
  } finally {
    release?.('Synthetic cleanup');
    await close();
  }
});

test('close cancels the synthetic in-flight handle and reconciles before closing the database', async t => {
  const f = createInterruptedFixture(t);
  const order = [];
  let record;
  let active = false;
  let release;
  const { app, close } = openApp(t, f, {
    executeConversationAgent: async input => {
      record = f.seed();
      const handle = { cancel(reason) { order.push(`cancel:${reason}`); release(); } };
      const done = new Promise(resolve => { release = resolve; });
      registerTurnHandle(input.turnState, handle);
      active = true;
      await done;
      await new Promise(resolve => setTimeout(resolve, 20));
      order.push('executor-settled');
      unregisterTurnHandle(input.turnState, handle);
      return { stopTurn: true };
    },
  });
  await new Promise(resolve => app.start(resolve));
  app.turnOrchestrator.submitConversationMessage(f.room.id, { content: 'Synthetic close test' });
  await waitFor(() => active);
  const originalClose = app.store.close.bind(app.store);
  let atClose;
  let databaseClosed = false;
  app.store.close = () => {
    order.push('database-close');
    atClose = {
      message: app.store.getMessage(record.message.id),
      run: f.runs.getRun(record.runId), task: f.runs.getTask(record.taskId),
    };
    // On the unfixed implementation keep the test DB alive solely for test
    // cleanup: otherwise its uncancelled executor would mask the ordering
    // regression with unrelated writes to a closed SQLite connection.
    if (order.some(event => event.startsWith('cancel:'))) {
      originalClose();
      databaseClosed = true;
    }
  };
  try {
    const closing = close();
    assert.throws(() => app.turnOrchestrator.submitConversationMessage(f.room.id, { content: 'Too late' }),
      error => error.code === 'server_closing');
    await closing;
    assert.ok(order[0]?.startsWith('cancel:'), 'cancel must happen before database close');
    assert.ok(order.indexOf('executor-settled') < order.indexOf('database-close'));
    assert.equal(atClose.message.status, 'failed');
    assert.equal(atClose.message.errorMessage, '服务关闭中断');
    assert.equal(atClose.run.status, 'failed');
    assert.equal(atClose.run.error_message, '服务关闭中断');
    assert.equal(atClose.task.status, 'failed');
    assert.equal(atClose.task.error_message, '服务关闭中断');
    assert.equal(order.at(-1), 'database-close');
  } finally {
    release?.();
    await waitFor(() => {
      const stats = app.turnOrchestrator.getRuntimeStats();
      return stats.activeTurns === 0 && stats.activeQueues === 0;
    });
    if (!databaseClosed) originalClose();
  }
});
