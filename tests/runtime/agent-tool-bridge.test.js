const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createSqliteRunStore } = require('../../build/lib/sqlite-store');
const { createAgentToolBridge } = require('../../build/server/domain/runtime/agent-tool-bridge');
const { markConversationRetrievalTraceUsage } = require('../../build/server/domain/conversation/retrieval-trace');

const { withTempDir } = require('../helpers/temp-dir');

function createPublicInvocationFixture(store, suffix) {
  const agent = store.saveCustomRoleConfig({
    id: `bridge-agent-${suffix}`,
    name: `Bridge Agent ${suffix}`,
    personaPrompt: 'Reply briefly.',
  });
  const conversation = store.createConversation({
    id: `bridge-conversation-${suffix}`,
    title: `Bridge Conversation ${suffix}`,
    participants: [agent.id],
  });
  const assistantMessage = store.createMessage({
    id: `bridge-message-${suffix}`,
    conversationId: conversation.id,
    turnId: `bridge-turn-${suffix}`,
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: 'Thinking...',
    status: 'streaming',
  });
  const fullConversation = store.getConversation(conversation.id);
  const turnState = {
    conversationId: conversation.id,
    turnId: assistantMessage.turnId,
    stopRequested: false,
  };
  const stage = {
    status: 'running',
    replyLength: 0,
    preview: '',
    lastTextDeltaAt: null,
  };

  return {
    agent,
    conversation: fullConversation,
    assistantMessage,
    turnState,
    stage,
  };
}

test('agent tool bridge rejects stale invocations after a turn stops or completes', (t) => {
  const tempDir = withTempDir('caff-agent-tool-bridge-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const stoppedFixture = createPublicInvocationFixture(store, 'stopped');
  const stoppedContext = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: stoppedFixture.conversation.id,
      turnId: stoppedFixture.assistantMessage.turnId,
      agentId: stoppedFixture.agent.id,
      agentName: stoppedFixture.agent.name,
      assistantMessageId: stoppedFixture.assistantMessage.id,
      conversationAgents: stoppedFixture.conversation.agents,
      stage: stoppedFixture.stage,
      turnState: stoppedFixture.turnState,
    })
  );

  const firstPost = bridge.handlePostMessage({
    invocationId: stoppedContext.invocationId,
    callbackToken: stoppedContext.callbackToken,
    visibility: 'public',
    content: 'First draft',
  });

  assert.equal(firstPost.ok, true);
  assert.equal(firstPost.message.content, 'First draft');
  assert.ok(firstPost.message.publicPostedAt);

  stoppedFixture.turnState.stopRequested = true;

  assert.throws(
    () =>
      bridge.handlePostMessage({
        invocationId: stoppedContext.invocationId,
        callbackToken: stoppedContext.callbackToken,
        visibility: 'public',
        content: 'Late draft',
      }),
    (error) => error && error.statusCode === 409
  );

  const completedFixture = createPublicInvocationFixture(store, 'completed');
  const completedContext = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: completedFixture.conversation.id,
      turnId: completedFixture.assistantMessage.turnId,
      agentId: completedFixture.agent.id,
      agentName: completedFixture.agent.name,
      assistantMessageId: completedFixture.assistantMessage.id,
      conversationAgents: completedFixture.conversation.agents,
      stage: completedFixture.stage,
      turnState: completedFixture.turnState,
    })
  );

  completedFixture.stage.status = 'completed';

  assert.throws(
    () =>
      bridge.handlePostMessage({
        invocationId: completedContext.invocationId,
        callbackToken: completedContext.callbackToken,
        visibility: 'public',
        content: 'Should be rejected',
      }),
    (error) => error && error.statusCode === 409
  );
});

test('agent tool bridge writes one bounded pending experience draft per turn', (t) => {
  const tempDir = withTempDir('caff-agent-tool-experience-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const broadcastEvents = [];
  const bridge = createAgentToolBridge({
    store,
    broadcastEvent(eventName, payload) {
      broadcastEvents.push({ eventName, payload });
    },
  });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'experience');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const result = bridge.handleWriteExperience({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    title: 'Reuse model-backed digest drafts safely',
    category: 'pattern',
    scenario: 'When digest-to-skill extraction needs a reusable lesson discovered during tool use.',
    steps: ['Write a pending experience draft before the final public reply.'],
    validation: ['node --test tests/runtime/agent-tool-bridge.test.js'],
    artifacts: ['server/domain/conversation/experience-draft.ts'],
    confidence: 'high',
    source: { agentId: 'spoofed-agent' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.draft.status, 'pending');
  assert.equal(result.draft.source.agentId, fixture.agent.id);
  assert.equal(result.draft.source.turnId, fixture.assistantMessage.turnId);
  assert.equal(result.draft.source.agentId === 'spoofed-agent', false);

  const storedDrafts = store.getConversation(fixture.conversation.id).metadata.experienceDrafts;
  assert.equal(storedDrafts.length, 1);
  assert.equal(storedDrafts[0].title, 'Reuse model-backed digest drafts safely');
  assert.equal(broadcastEvents.some((event) => event.eventName === 'conversation_experience_draft_updated'), true);

  assert.throws(
    () => bridge.handleWriteExperience({
      invocationId: context.invocationId,
      callbackToken: context.callbackToken,
      title: 'Second draft from same turn',
      scenario: 'This should be rejected because the same turn already wrote one draft.',
    }),
    (error) => error && error.statusCode === 409
  );
});

test('agent tool bridge rejects unsafe experience drafts', (t) => {
  const tempDir = withTempDir('caff-agent-tool-experience-secret-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'experience-secret');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  assert.throws(
    () => bridge.handleWriteExperience({
      invocationId: context.invocationId,
      callbackToken: context.callbackToken,
      title: '',
      category: 'other',
    }),
    (error) =>
      error &&
      error.statusCode === 400 &&
      /title is required/u.test(error.message) &&
      Array.isArray(error.issues) &&
      error.issues.some((issue) => issue && issue.field === 'title')
  );

  assert.throws(
    () => bridge.handleWriteExperience({
      invocationId: context.invocationId,
      callbackToken: context.callbackToken,
      title: 'Store leaked token handling',
      scenario: 'The api token abc123 should be remembered for later use.',
    }),
    (error) => error && error.statusCode === 400 && /secrets|tokens/u.test(error.message)
  );

  assert.throws(
    () => bridge.handleWriteExperience({
      invocationId: context.invocationId,
      callbackToken: context.callbackToken,
      title: 'Store leaked authorization header handling',
      scenario: 'Authorization Bearer abc123 should never be stored as reusable experience.',
    }),
    (error) => error && error.statusCode === 400 && /secrets|tokens/u.test(error.message)
  );

  assert.equal(store.getConversation(fixture.conversation.id).metadata.experienceDrafts, undefined);
});

test('agent tool bridge creates pending session goal proposals without mutating the goal', (t) => {
  const tempDir = withTempDir('caff-agent-tool-goal-proposal-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const broadcastEvents = [];
  const summaryEvents = [];
  const bridge = createAgentToolBridge({
    store,
    broadcastEvent(eventName, payload) {
      broadcastEvents.push({ eventName, payload });
    },
    broadcastConversationSummary(conversationId) {
      summaryEvents.push(conversationId);
    },
  });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'goal-proposal');
  store.updateConversation(fixture.conversation.id, {
    metadata: {
      sessionGoal: {
        objective: 'Finish a long task',
        status: 'active',
        createdAt: '2026-05-03T00:00:00.000Z',
        updatedAt: '2026-05-03T00:00:00.000Z',
      },
    },
  });
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const result = bridge.handleSuggestGoal({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    action: 'complete',
    reason: 'All requested work appears done',
  });

  const updatedConversation = store.getConversation(fixture.conversation.id);

  assert.equal(result.ok, true);
  assert.equal(result.goal.status, 'active');
  assert.equal(result.proposal.action, 'complete');
  assert.equal(result.proposal.reason, 'All requested work appears done');
  assert.equal(updatedConversation.metadata.sessionGoal.status, 'active');
  assert.equal(updatedConversation.metadata.sessionGoalProposal.action, 'complete');
  assert.ok(broadcastEvents.some((event) => event.eventName === 'conversation_goal_proposal_updated'));
  assert.deepEqual(summaryEvents, [fixture.conversation.id]);
});

test('agent tool bridge updates session goal checklist progress', (t) => {
  const tempDir = withTempDir('caff-agent-tool-goal-checklist-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const broadcastEvents = [];
  const bridge = createAgentToolBridge({
    store,
    broadcastEvent(eventName, payload) {
      broadcastEvents.push({ eventName, payload });
    },
  });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'goal-checklist');
  store.updateConversation(fixture.conversation.id, {
    metadata: {
      sessionGoal: {
        objective: 'Finish a long task',
        status: 'active',
        createdAt: '2026-05-03T00:00:00.000Z',
        updatedAt: '2026-05-03T00:00:00.000Z',
      },
    },
  });
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const result = bridge.handleUpdateGoalChecklist({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    checklistText: '[x] Plan\n[~] Implement\n[ ] Validate',
  });

  const updatedGoal = store.getConversation(fixture.conversation.id).metadata.sessionGoal;

  assert.equal(result.ok, true);
  assert.equal(result.checklist.length, 3);
  assert.equal(updatedGoal.status, 'active');
  assert.equal(updatedGoal.checklist[0].status, 'done');
  assert.equal(updatedGoal.checklist[1].status, 'in_progress');
  assert.ok(broadcastEvents.some((event) => event.eventName === 'conversation_goal_updated'));
});

test('agent tool bridge enforces skill-test run and case auth scope', (t) => {
  const tempDir = withTempDir('caff-agent-tool-bridge-skill-test-auth-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'skill-test-auth');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
      authScope: 'skill-test',
      caseId: 'case-1',
      runId: 'run-1',
      tokenTtlSec: 60,
      dryRun: true,
    })
  );

  assert.throws(
    () =>
      bridge.handlePostMessage({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        visibility: 'public',
        content: 'missing scope',
      }),
    (error) => error && error.statusCode === 403
  );

  assert.throws(
    () =>
      bridge.handlePostMessage({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        skillTestRunId: 'run-1',
        skillTestCaseId: 'case-2',
        visibility: 'public',
        content: 'wrong case',
      }),
    (error) => error && error.statusCode === 403
  );

  const okPost = bridge.handlePostMessage({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    skillTestRunId: 'run-1',
    skillTestCaseId: 'case-1',
    visibility: 'public',
    content: 'scoped ok',
  });

  assert.equal(okPost.ok, true);
  assert.equal(context.auth.validated, true);
  assert.equal(context.auth.validatedCount, 1);
  assert.deepEqual(
    context.auth.rejects.map((entry) => entry.reason),
    ['missing_case_binding', 'case_binding_mismatch']
  );
});

test('agent tool bridge expires invocation auth tokens', (t) => {
  const tempDir = withTempDir('caff-agent-tool-bridge-auth-expiry-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'auth-expiry');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
      authScope: 'skill-test',
      caseId: 'case-expired',
      runId: 'run-expired',
      expiresAt: '2000-01-01T00:00:00.000Z',
      dryRun: true,
    })
  );

  assert.throws(
    () =>
      bridge.handlePostMessage({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        skillTestRunId: 'run-expired',
        skillTestCaseId: 'case-expired',
        visibility: 'public',
        content: 'too late',
      }),
    (error) => error && error.statusCode === 401
  );

  assert.equal(context.auth.rejects.length, 1);
  assert.equal(context.auth.rejects[0].reason, 'token_expired');
});

test('agent tool bridge appends tool-call telemetry events when runStore + stage taskId are available', (t) => {
  const tempDir = withTempDir('caff-agent-tool-bridge-telemetry-');
  const sqlitePath = path.join(tempDir, 'telemetry.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const runStore = createSqliteRunStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      runStore.close();
    } catch {}
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'telemetry');
  const taskId = 'task-tool-telemetry';
  fixture.stage.taskId = taskId;
  runStore.createTask({
    taskId,
    kind: 'conversation_agent_reply',
    title: 'Telemetry Task',
    status: 'running',
    metadata: { source: 'test' },
  });

  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
      runStore,
    })
  );

  const okPost = bridge.handlePostMessage({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    visibility: 'public',
    content: 'Hello tool telemetry',
  });

  assert.equal(okPost.ok, true);

  assert.throws(
    () =>
      bridge.handlePostMessage({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        visibility: 'public',
        content: '',
      }),
    (error) => error && error.statusCode === 400
  );

  const events = runStore.listTaskEvents(taskId);
  const toolEvents = events.filter((event) => event && event.event_type === 'agent_tool_call');

  assert.ok(toolEvents.length >= 2);
  assert.ok(toolEvents.some((event) => event && event.payload && event.payload.tool === 'send-public' && event.payload.status === 'succeeded'));
  assert.ok(toolEvents.some((event) => event && event.payload && event.payload.tool === 'send-public' && event.payload.status === 'failed'));
});

test('agent tool bridge auto-completes active runs after successful public posts', async (t) => {
  const tempDir = withTempDir('caff-agent-tool-bridge-auto-final-');
  const sqlitePath = path.join(tempDir, 'bridge-auto-final.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'auto-final');
  let callbackPayload = null;
  const callbackPromise = new Promise((resolve) => {
    const context = bridge.registerInvocation(
      bridge.createInvocationContext({
        conversationId: fixture.conversation.id,
        turnId: fixture.assistantMessage.turnId,
        agentId: fixture.agent.id,
        agentName: fixture.agent.name,
        assistantMessageId: fixture.assistantMessage.id,
        conversationAgents: fixture.conversation.agents,
        stage: fixture.stage,
        turnState: fixture.turnState,
        autoCompleteOnPublicPost: true,
        onPublicPostCompleted(payload) {
          callbackPayload = payload;
          resolve(payload);
        },
      })
    );

    const response = bridge.handlePostMessage({
      invocationId: context.invocationId,
      callbackToken: context.callbackToken,
      visibility: 'public',
      content: 'Auto final public reply',
    });

    assert.equal(response.ok, true);
  });

  await callbackPromise;

  assert.ok(callbackPayload);
  assert.equal(callbackPayload.messageId, fixture.assistantMessage.id);
  assert.equal(callbackPayload.publicPostCount, 1);
  assert.equal(callbackPayload.publicPostMode, 'replace');
});

test('agent tool bridge broadcasts live tool events for started and finished bridge steps', (t) => {
  const tempDir = withTempDir('caff-agent-tool-bridge-live-events-');
  const sqlitePath = path.join(tempDir, 'bridge-live-events.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const liveEvents = [];
  const bridge = createAgentToolBridge({
    store,
    agentDir: tempDir,
    broadcastEvent(eventName, payload) {
      if (eventName === 'conversation_tool_event') {
        liveEvents.push({ eventName, payload });
      }
    },
  });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'live-events');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const response = bridge.handlePostMessage({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    visibility: 'public',
    content: 'Live bridge event test',
  });

  assert.equal(response.ok, true);
  assert.ok(liveEvents.length >= 2);
  assert.ok(
    liveEvents.some(
      (entry) =>
        entry &&
        entry.payload &&
        entry.payload.phase === 'started' &&
        entry.payload.step &&
        entry.payload.step.toolName === 'send-public' &&
        entry.payload.step.status === 'running' &&
        entry.payload.step.requestSummary &&
        entry.payload.step.requestSummary.visibility === 'public'
    )
  );
  assert.ok(
    liveEvents.some(
      (entry) =>
        entry &&
        entry.payload &&
        entry.payload.phase === 'updated' &&
        entry.payload.step &&
        entry.payload.step.toolName === 'send-public' &&
        entry.payload.step.status === 'succeeded'
    )
  );
});

test('agent tool trellis-init previews and applies a scaffold under the active project', (t) => {
  const tempDir = withTempDir('caff-agent-tool-trellis-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'trellis');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      projectDir,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const preview = bridge.handleTrellisInit({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    taskName: 'demo',
  });

  assert.equal(preview.ok, true);
  assert.equal(preview.applied, false);
  assert.equal(fs.existsSync(path.join(projectDir, '.trellis')), false);
  assert.ok(Array.isArray(preview.operations));
  assert.ok(preview.operations.length > 0);

  const applied = bridge.handleTrellisInit({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    taskName: 'demo',
    confirm: true,
  });

  assert.equal(applied.ok, true);
  assert.equal(applied.applied, true);
  assert.ok(fs.existsSync(path.join(projectDir, '.trellis', 'workflow.md')));
  assert.ok(fs.existsSync(path.join(projectDir, '.trellis', 'tasks', 'demo', 'prd.md')));
});

test('agent tool trellis-init refuses to follow symlinks inside .trellis', (t) => {
  const tempDir = withTempDir('caff-agent-tool-trellis-init-symlink-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const trellisDir = path.join(projectDir, '.trellis');
  fs.mkdirSync(trellisDir, { recursive: true });

  const externalDir = path.join(tempDir, 'external-target');
  fs.mkdirSync(externalDir, { recursive: true });

  const tasksLink = path.join(trellisDir, 'tasks');

  try {
    fs.symlinkSync(externalDir, tasksLink, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`symlink creation not supported in this environment: ${error && error.message ? error.message : error}`);
    return;
  }

  const fixture = createPublicInvocationFixture(store, 'trellis-init-symlink');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      projectDir,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  assert.throws(
    () =>
      bridge.handleTrellisInit({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        taskName: 'demo',
        confirm: true,
      }),
    (err) => err && err.statusCode === 400
  );

  assert.equal(fs.existsSync(path.join(trellisDir, 'workflow.md')), false);
});

test('agent tool trellis-init rejects directory collisions before writing', (t) => {
  const tempDir = withTempDir('caff-agent-tool-trellis-init-dir-collision-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(path.join(projectDir, '.trellis', 'tasks', 'demo', 'prd.md'), { recursive: true });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'trellis-init-dir-collision');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      projectDir,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  assert.equal(fs.existsSync(path.join(projectDir, '.trellis', 'workflow.md')), false);

  assert.throws(
    () =>
      bridge.handleTrellisInit({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        taskName: 'demo',
        confirm: true,
        force: true,
      }),
    (error) => error && error.statusCode === 400
  );

  assert.equal(fs.existsSync(path.join(projectDir, '.trellis', 'workflow.md')), false);
  assert.equal(fs.existsSync(path.join(projectDir, '.trellis', '.gitignore')), false);
});

test('agent tool trellis-init rejects invocations without an active projectDir', (t) => {
  const tempDir = withTempDir('caff-agent-tool-trellis-init-missing-project-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'trellis-init-missing-project');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      projectDir: '',
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  assert.throws(
    () =>
      bridge.handleTrellisInit({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        taskName: 'demo',
      }),
    (error) => error && error.statusCode === 409
  );
});

test('agent tool trellis-init rejects when .trellis exists as a file', (t) => {
  const tempDir = withTempDir('caff-agent-tool-trellis-init-root-file-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.trellis'), 'not a directory', 'utf8');

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'trellis-init-root-file');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      projectDir,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  assert.throws(
    () =>
      bridge.handleTrellisInit({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        taskName: 'demo',
        confirm: true,
      }),
    (error) => error && error.statusCode === 409
  );
});

test('agent tool trellis-write previews and writes files under .trellis', (t) => {
  const tempDir = withTempDir('caff-agent-tool-trellis-write-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'trellis-write');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      projectDir,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const preview = bridge.handleTrellisWrite({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    relativePath: '.trellis/tasks/demo/prd.md',
    content: '# Hello\n\nFrom agent.\n',
  });

  assert.equal(preview.ok, true);
  assert.equal(preview.applied, false);
  assert.equal(fs.existsSync(path.join(projectDir, '.trellis')), false);
  assert.ok(Array.isArray(preview.operations));
  assert.ok(preview.operations.some((op) => op.path === '.trellis/tasks/demo/prd.md'));

  const applied = bridge.handleTrellisWrite({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    relativePath: '.trellis/tasks/demo/prd.md',
    content: '# Hello\n\nFrom agent.\n',
    confirm: true,
  });

  assert.equal(applied.ok, true);
  assert.equal(applied.applied, true);
  assert.ok(fs.existsSync(path.join(projectDir, '.trellis', 'tasks', 'demo', 'prd.md')));
  assert.equal(fs.readFileSync(path.join(projectDir, '.trellis', 'tasks', 'demo', 'prd.md'), 'utf8'), '# Hello\n\nFrom agent.\n');

  assert.throws(
    () =>
      bridge.handleTrellisWrite({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        relativePath: '../oops.txt',
        content: 'nope',
        confirm: true,
      }),
    (error) => error && error.statusCode === 400
  );

  assert.throws(
    () =>
      bridge.handleTrellisWrite({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        files: [
          { relativePath: '.trellis/tasks/demo/extra.md', content: 'ok' },
          { relativePath: '../oops.txt', content: 'nope' },
        ],
        confirm: true,
        force: true,
      }),
    (error) => error && error.statusCode === 400
  );

  assert.equal(fs.existsSync(path.join(projectDir, '.trellis', 'tasks', 'demo', 'extra.md')), false);

  assert.throws(
    () =>
      bridge.handleTrellisWrite({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        relativePath: '.trellis//',
        content: 'nope',
        confirm: true,
        force: true,
      }),
    (error) => error && error.statusCode === 400
  );

  assert.throws(
    () =>
      bridge.handleTrellisWrite({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        relativePath: '.trellis/.',
        content: 'nope',
        confirm: true,
        force: true,
      }),
    (error) => error && error.statusCode === 400
  );

  fs.mkdirSync(path.join(projectDir, '.trellis', 'spec'), { recursive: true });

  assert.throws(
    () =>
      bridge.handleTrellisWrite({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        relativePath: '.trellis/spec',
        content: 'nope',
        confirm: true,
        force: true,
      }),
    (error) => error && error.statusCode === 400
  );
});

test('agent tool trellis-write rejects when .trellis exists as a file', (t) => {
  const tempDir = withTempDir('caff-agent-tool-trellis-write-root-file-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  const projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.trellis'), 'not a directory', 'utf8');

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'trellis-write-root-file');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      projectDir,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  assert.throws(
    () =>
      bridge.handleTrellisWrite({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        relativePath: '.trellis/tasks/demo/prd.md',
        content: '# Hello\n',
        confirm: true,
      }),
    (error) => error && error.statusCode === 409
  );
});

test('agent tool trellis-write rejects invocations without an active projectDir', (t) => {
  const tempDir = withTempDir('caff-agent-tool-trellis-write-missing-project-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'trellis-write-missing-project');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      projectDir: '',
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  assert.throws(
    () =>
      bridge.handleTrellisWrite({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        relativePath: '.trellis/tasks/demo/prd.md',
        content: '# Hello\n',
      }),
    (error) => error && error.statusCode === 409
  );
});

test('agent tool bridge no longer exposes read-skill compatibility handler', (t) => {
  const tempDir = withTempDir('caff-agent-tool-no-read-skill-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  assert.equal(typeof bridge.handleReadSkill, 'undefined');
});

test('agent tool read-context keeps the current turn user message visible', (t) => {
  const tempDir = withTempDir('caff-agent-tool-context-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'context');
  const baseTimestamp = Date.parse(fixture.assistantMessage.createdAt || Date.now());
  const userMessage = store.createMessage({
    id: 'bridge-user-message-context',
    conversationId: fixture.conversation.id,
    turnId: fixture.assistantMessage.turnId,
    role: 'user',
    senderName: 'You',
    content: '@BridgeAgent #execute 请继续这个方案',
    status: 'completed',
    createdAt: new Date(baseTimestamp + 1000).toISOString(),
  });

  store.updateMessage(fixture.assistantMessage.id, {
    content: '第一条中间回复',
    status: 'completed',
  });
  store.createMessage({
    id: 'bridge-extra-message-context-1',
    conversationId: fixture.conversation.id,
    turnId: fixture.assistantMessage.turnId,
    role: 'assistant',
    agentId: fixture.agent.id,
    senderName: fixture.agent.name,
    content: '第二条中间回复',
    status: 'completed',
    createdAt: new Date(baseTimestamp + 2000).toISOString(),
  });
  store.createMessage({
    id: 'bridge-extra-message-context-2',
    conversationId: fixture.conversation.id,
    turnId: fixture.assistantMessage.turnId,
    role: 'assistant',
    agentId: fixture.agent.id,
    senderName: fixture.agent.name,
    content: '第三条中间回复',
    status: 'completed',
    createdAt: new Date(baseTimestamp + 3000).toISOString(),
  });

  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      userMessageId: userMessage.id,
      promptUserMessage: {
        ...userMessage,
        content: '@BridgeAgent 请继续这个方案',
      },
      conversationAgents: store.getConversation(fixture.conversation.id).agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const requestUrl = new URL('http://127.0.0.1/api/agent-tools/context');
  requestUrl.searchParams.set('invocationId', context.invocationId);
  requestUrl.searchParams.set('callbackToken', context.callbackToken);
  requestUrl.searchParams.set('publicLimit', '2');

  const result = bridge.handleReadContext(requestUrl);

  assert.equal(result.ok, true);
  assert.equal(result.latestUserMessage.id, userMessage.id);
  assert.equal(result.latestUserMessage.content, '@BridgeAgent 请继续这个方案');
  assert.deepEqual(
    result.publicMessages.map((message) => message.id),
    [userMessage.id, 'bridge-extra-message-context-1', 'bridge-extra-message-context-2']
  );
  assert.equal(result.publicMessages[0].content, '@BridgeAgent 请继续这个方案');
});

test('agent tool search-messages returns scoped public recall results', (t) => {
  const tempDir = withTempDir('caff-agent-tool-search-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'search');
  const otherAgent = store.saveCustomRoleConfig({
    id: 'bridge-search-other-agent',
    name: 'Bridge Search Other Agent',
    personaPrompt: 'Reply briefly too.',
  });
  const otherConversation = store.createConversation({
    id: 'bridge-conversation-search-other',
    title: 'Bridge Search Other',
    participants: [fixture.agent.id],
  });

  store.createMessage({
    id: 'bridge-search-hit-1',
    conversationId: fixture.conversation.id,
    turnId: fixture.assistantMessage.turnId,
    role: 'user',
    senderName: 'You',
    content: 'Hermes memory retrieval is useful here.',
    status: 'completed',
  });
  store.createMessage({
    id: 'bridge-search-hit-2',
    conversationId: fixture.conversation.id,
    turnId: fixture.assistantMessage.turnId,
    role: 'assistant',
    agentId: fixture.agent.id,
    senderName: fixture.agent.name,
    content: 'Hermes recall should stay scoped.',
    status: 'completed',
  });
  store.createMessage({
    id: 'bridge-search-hit-cjk',
    conversationId: fixture.conversation.id,
    turnId: fixture.assistantMessage.turnId,
    role: 'user',
    senderName: 'You',
    content: 'Hermes 是一个开源项目。',
    status: 'completed',
  });
  store.createMessage({
    id: 'bridge-search-hit-other-agent',
    conversationId: fixture.conversation.id,
    turnId: fixture.assistantMessage.turnId,
    role: 'assistant',
    agentId: otherAgent.id,
    senderName: otherAgent.name,
    content: 'Hermes was mentioned by another agent here.',
    status: 'completed',
  });
  store.createMessage({
    id: 'bridge-search-miss-other',
    conversationId: otherConversation.id,
    turnId: 'bridge-search-turn-other',
    role: 'user',
    senderName: 'Other User',
    content: 'Hermes appears in another conversation.',
    status: 'completed',
  });

  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const result = bridge.handleSearchMessages({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    query: 'Hermes',
    limit: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.scope, 'conversation-public');
  assert.equal(result.query, 'Hermes');
  assert.equal(result.resultCount, 1);
  assert.ok(result.searchMode === 'fts5' || result.searchMode === 'like');
  assert.equal(Array.isArray(result.results), true);
  assert.equal(result.results[0].conversationId, fixture.conversation.id);
  assert.equal(result.results.some((entry) => entry.messageId === 'bridge-search-miss-other'), false);
  assert.match(result.results[0].snippet, /Hermes/u);

  const cjkResult = bridge.handleSearchMessages({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    query: 'Hermes 开源项目',
    limit: 5,
  });

  assert.equal(cjkResult.ok, true);
  assert.equal(cjkResult.scope, 'conversation-public');
  assert.equal(cjkResult.query, 'Hermes 开源项目');
  assert.equal(cjkResult.resultCount >= 1, true);
  assert.equal(cjkResult.results.some((entry) => entry.messageId === 'bridge-search-hit-cjk'), true);
  assert.equal(cjkResult.results.some((entry) => entry.messageId === 'bridge-search-miss-other'), false);
  if (cjkResult.searchMode === 'like') {
    assert.equal(cjkResult.diagnostics.some((entry) => entry && entry.code === 'fts5_no_match_fallback'), true);
  }

  const speakerResult = bridge.handleSearchMessages({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    speaker: fixture.agent.name,
    limit: 5,
  });

  assert.equal(speakerResult.ok, true);
  assert.equal(speakerResult.query, '');
  assert.equal(speakerResult.scope, 'conversation-public');
  assert.equal(speakerResult.filters.speaker, fixture.agent.name);
  assert.equal(speakerResult.searchMode, 'filtered');
  assert.equal(speakerResult.results.every((entry) => entry.senderName === fixture.agent.name), true);
  assert.equal(speakerResult.results.some((entry) => entry.messageId === 'bridge-search-hit-2'), true);
  assert.equal(speakerResult.results.some((entry) => entry.messageId === 'bridge-search-hit-other-agent'), false);

  const agentFilteredResult = bridge.handleSearchMessages({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    query: 'Hermes',
    agentId: otherAgent.id,
    limit: 5,
  });

  assert.equal(agentFilteredResult.ok, true);
  assert.equal(agentFilteredResult.filters.agentId, otherAgent.id);
  assert.equal(agentFilteredResult.resultCount, 1);
  assert.equal(agentFilteredResult.results[0].messageId, 'bridge-search-hit-other-agent');
});

test('agent tool bridge searches cross-conversation summary memory by default', (t) => {
  const tempDir = withTempDir('caff-agent-tool-summary-memory-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });
  const trellisTaskDir = path.join(tempDir, '.trellis', 'tasks', 'bridge-current-task');
  fs.mkdirSync(trellisTaskDir, { recursive: true });
  fs.writeFileSync(path.join(tempDir, '.trellis', '.current-task'), '.trellis/tasks/bridge-current-task\n');
  fs.writeFileSync(path.join(trellisTaskDir, 'task.json'), JSON.stringify({ title: 'Bridge Current Task' }));

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'summary-memory');
  const otherConversation = store.createConversation({
    id: 'bridge-summary-memory-other-conversation',
    title: 'Historical Digest Memory Conversation',
    participants: [fixture.agent.id],
  });

  store.saveSummarySegmentFromDigest(fixture.conversation.id, {
    id: 'digest-current-summary-memory',
    kind: 'entry',
    summary: 'bridge-memory-keyword current conversation digest should be excluded by default.',
    facts: ['Current conversation bridge-memory-keyword fact.'],
    decisions: [],
    openQuestions: [],
    nextActions: [],
    artifacts: [],
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    messageRange: { messageCount: 2 },
  });
  store.saveSummarySegmentFromDigest(otherConversation.id, {
    id: 'digest-other-summary-memory',
    kind: 'entry',
    summary: 'bridge-memory-keyword historical digest should be searchable by agents.',
    facts: ['Other conversation bridge-memory-keyword fact.'],
    decisions: ['Agents can retrieve historical digest memory on demand.'],
    openQuestions: [],
    nextActions: [],
    artifacts: ['chat_summary_segments'],
    createdAt: '2026-04-02T00:00:00.000Z',
    updatedAt: '2026-04-02T00:00:00.000Z',
    messageRange: { messageCount: 3 },
  }, { taskName: 'bridge-memory-task' });
  store.saveSummarySegmentFromDigest(otherConversation.id, {
    id: 'digest-other-summary-memory-rollup',
    kind: 'rollup',
    summary: 'bridge-filter-keyword historical rollup should be searchable by filter.',
    facts: ['Bridge summary memory filters can target rollups.'],
    decisions: [],
    openQuestions: [],
    nextActions: [],
    artifacts: [],
    createdAt: '2026-04-02T00:02:00.000Z',
    updatedAt: '2026-04-02T00:02:00.000Z',
    messageRange: { messageCount: 4 },
  }, { taskName: 'bridge-filter-task' });
  store.saveSummarySegmentFromDigest(otherConversation.id, {
    id: 'digest-current-task-summary-memory',
    kind: 'entry',
    summary: 'bridge-current-task-keyword historical digest belongs to the active Trellis task.',
    facts: ['Current-task shortcut resolves the active Trellis task name.'],
    decisions: [],
    openQuestions: [],
    nextActions: [],
    artifacts: [],
    createdAt: '2026-04-02T00:03:00.000Z',
    updatedAt: '2026-04-02T00:03:00.000Z',
    messageRange: { messageCount: 5 },
  }, { taskName: 'Bridge Current Task' });
  store.saveSummarySegmentFromDigest(otherConversation.id, {
    id: 'digest-current-task-summary-memory-other-task',
    kind: 'entry',
    summary: 'bridge-current-task-keyword historical digest belongs to another task.',
    facts: ['This should be filtered out by the current-task shortcut.'],
    decisions: [],
    openQuestions: [],
    nextActions: [],
    artifacts: [],
    createdAt: '2026-04-02T00:04:00.000Z',
    updatedAt: '2026-04-02T00:04:00.000Z',
    messageRange: { messageCount: 6 },
  }, { taskName: 'Other Bridge Task' });

  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      projectDir: tempDir,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const result = bridge.handleSearchMemory({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    query: 'bridge-memory-keyword',
    limit: 5,
  });

  assert.equal(result.ok, true);
  assert.equal(result.scope, 'summary-segments');
  assert.equal(result.activeConversationExcluded, true);
  assert.equal(result.resultCount, 1);
  assert.equal(result.results[0].conversationId, otherConversation.id);
  assert.equal(result.results[0].sourceDigestId, 'digest-other-summary-memory');
  assert.deepEqual(result.results[0].matchedTerms, ['bridge-memory-keyword']);
  assert.equal(result.recallTrace.resultCount, 1);
  assert.equal(result.recallTrace.storedResultCount, 1);

  const tracedConversation = store.getConversation(fixture.conversation.id);
  const retrievalTraces = tracedConversation.metadata.conversationRetrievalTraces;
  assert.equal(Array.isArray(retrievalTraces), true);
  assert.equal(retrievalTraces.length, 1);
  assert.equal(retrievalTraces[0].tool, 'search-memory');
  assert.equal(retrievalTraces[0].status, 'seen');
  assert.equal(retrievalTraces[0].agentId, fixture.agent.id);
  assert.equal(retrievalTraces[0].queryPreview, 'bridge-memory-keyword');
  assert.equal(retrievalTraces[0].results[0].status, 'seen');
  assert.equal(retrievalTraces[0].results[0].sourceDigestId, 'digest-other-summary-memory');
  assert.equal(retrievalTraces[0].results[0].summary, 'bridge-memory-keyword historical digest should be searchable by agents.');

  const usage = markConversationRetrievalTraceUsage(store, fixture.conversation.id, {
    assistantMessageId: fixture.assistantMessage.id,
    agentId: fixture.agent.id,
    replyText: 'The bridge-memory-keyword historical digest is the evidence I used.',
  });
  assert.equal(usage.updatedTraceCount, 1);
  assert.equal(usage.usedResultCount, 1);

  const usedTrace = store.getConversation(fixture.conversation.id).metadata.conversationRetrievalTraces[0];
  assert.equal(usedTrace.status, 'used');
  assert.equal(usedTrace.results[0].status, 'used');
  assert.ok(usedTrace.results[0].usedAt);
  assert.ok(usedTrace.results[0].usageScore >= 3);

  const included = bridge.handleSearchMemory({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    query: 'bridge-memory-keyword',
    includeCurrentConversation: true,
    limit: 5,
  });

  assert.equal(included.activeConversationExcluded, false);
  assert.equal(included.resultCount, 2);
  assert.equal(included.results.some((entry) => entry.conversationId === fixture.conversation.id), true);
  assert.equal(included.results.some((entry) => entry.conversationId === otherConversation.id), true);

  const filtered = bridge.handleSearchMemory({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    query: 'bridge-filter-keyword',
    taskName: 'bridge-filter-task',
    kind: 'rollup',
    conversationTitle: 'Historical Digest',
    since: '2026-04-02',
    until: '2026-04-03',
    limit: 5,
  });

  assert.equal(filtered.activeConversationExcluded, true);
  assert.deepEqual(filtered.filters, {
    excludeConversationId: fixture.conversation.id,
    taskName: 'bridge-filter-task',
    sourceKind: 'rollup',
    conversationTitle: 'Historical Digest',
    updatedAfter: '2026-04-02T00:00:00.000Z',
    updatedBefore: '2026-04-03T23:59:59.999Z',
  });
  assert.equal(filtered.resultCount, 1);
  assert.equal(filtered.results[0].sourceDigestId, 'digest-other-summary-memory-rollup');

  const currentTaskFiltered = bridge.handleSearchMemory({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    query: 'bridge-current-task-keyword',
    currentTask: true,
    limit: 5,
  });

  assert.equal(currentTaskFiltered.ok, true);
  assert.equal(currentTaskFiltered.filters.taskName, 'Bridge Current Task');
  assert.equal(currentTaskFiltered.resultCount, 1);
  assert.equal(currentTaskFiltered.results[0].sourceDigestId, 'digest-current-task-summary-memory');

  const latest = bridge.handleSearchMemory({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    latest: true,
    limit: 2,
  });

  assert.equal(latest.ok, true);
  assert.equal(latest.searchMode, 'like_latest');
  assert.equal(latest.activeConversationExcluded, true);
  assert.equal(latest.resultCount, 2);
  assert.equal(latest.results.some((entry) => entry.conversationId === fixture.conversation.id), false);
});

test('agent tool memory cards save durable local-user scope and stay agent-scoped', (t) => {
  const tempDir = withTempDir('caff-agent-tool-memory-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'memory');
  const otherAgent = store.saveCustomRoleConfig({
    id: 'bridge-memory-other-agent',
    name: 'Other Memory Agent',
    personaPrompt: 'Stay scoped.',
  });
  const secondConversation = store.createConversation({
    id: 'bridge-memory-conversation-second',
    title: 'Bridge Memory Second',
    participants: [fixture.agent.id, otherAgent.id],
  });

  store.updateConversation(fixture.conversation.id, {
    participants: [fixture.agent.id, otherAgent.id],
  });

  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: store.getConversation(fixture.conversation.id).agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const saved = bridge.handleSaveMemory({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    title: 'preference',
    content: 'User prefers retrieval-first experiments.',
    ttlDays: 14,
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.scope, 'local-user-agent');
  assert.equal(saved.card.title, 'preference');
  assert.equal(saved.card.agentId, fixture.agent.id);
  assert.equal(saved.card.scope, 'local-user-agent');
  assert.equal(saved.card.conversationId, null);
  assert.equal(saved.cardCount, 1);

  const memoriesUrl = new URL('http://127.0.0.1/api/agent-tools/memories');
  memoriesUrl.searchParams.set('invocationId', context.invocationId);
  memoriesUrl.searchParams.set('callbackToken', context.callbackToken);
  const listed = bridge.handleListMemories(memoriesUrl);

  assert.equal(listed.ok, true);
  assert.equal(listed.scope, 'agent-visible');
  assert.deepEqual(listed.scopes, ['conversation-agent', 'local-user-agent']);
  assert.equal(listed.cardCount, 1);
  assert.equal(listed.cards[0].title, 'preference');
  assert.equal(listed.cards[0].scope, 'local-user-agent');

  const secondAssistantMessage = store.createMessage({
    id: 'bridge-memory-second-assistant-message',
    conversationId: secondConversation.id,
    turnId: 'bridge-memory-second-turn',
    role: 'assistant',
    agentId: fixture.agent.id,
    senderName: fixture.agent.name,
    content: 'Continuing the durable memory check.',
    status: 'completed',
  });
  const secondContext = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: secondConversation.id,
      turnId: secondAssistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: secondAssistantMessage.id,
      conversationAgents: store.getConversation(secondConversation.id).agents,
      stage: fixture.stage,
      turnState: {
        ...fixture.turnState,
        conversationId: secondConversation.id,
        turnId: secondAssistantMessage.turnId,
      },
    })
  );
  const secondMemoriesUrl = new URL('http://127.0.0.1/api/agent-tools/memories');
  secondMemoriesUrl.searchParams.set('invocationId', secondContext.invocationId);
  secondMemoriesUrl.searchParams.set('callbackToken', secondContext.callbackToken);
  const crossConversationList = bridge.handleListMemories(secondMemoriesUrl);

  assert.equal(crossConversationList.cardCount, 1);
  assert.equal(crossConversationList.cards[0].scope, 'local-user-agent');
  assert.equal(crossConversationList.cards[0].title, 'preference');

  const otherCards = store.listVisibleMemoryCards(secondConversation.id, otherAgent.id);
  assert.equal(otherCards.length, 0);

  assert.throws(
    () =>
      bridge.handleSaveMemory({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        title: 'secret',
        content: 'API key is abc123',
      }),
    /Do not save secrets/u
  );
});

test('agent tool bridge keeps case-distinct overlay and durable memory titles visible', (t) => {
  const tempDir = withTempDir('caff-agent-tool-memory-case-visible-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'memory-case-visible');
  store.saveLocalUserMemoryCard(fixture.agent.id, {
    title: 'Preference',
    content: 'Durable uppercase preference.',
    ttlDays: 30,
  });
  store.saveConversationMemoryCard(fixture.conversation.id, fixture.agent.id, {
    title: 'preference',
    content: 'Conversation lowercase preference.',
    ttlDays: 7,
  });

  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const listUrl = new URL('http://127.0.0.1/api/agent-tools/memories');
  listUrl.searchParams.set('invocationId', context.invocationId);
  listUrl.searchParams.set('callbackToken', context.callbackToken);
  const listed = bridge.handleListMemories(listUrl);

  assert.equal(listed.ok, true);
  assert.equal(listed.cardCount, 2);
  assert.deepEqual(
    listed.cards.map((card) => ({ title: card.title, scope: card.scope })),
    [
      { title: 'preference', scope: 'conversation-agent' },
      { title: 'Preference', scope: 'local-user-agent' },
    ]
  );
});

test('agent tool memory cards update and forget durable local-user scope safely', (t) => {
  const tempDir = withTempDir('caff-agent-tool-memory-mutation-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'memory-mutation');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const saved = bridge.handleSaveMemory({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    title: 'preference',
    content: 'User prefers retrieval-first rollouts.',
    ttlDays: 30,
  });

  const updated = bridge.handleUpdateMemory({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    title: 'preference',
    content: 'User now prefers answer-first replies.',
    reason: 'User corrected this durable preference',
    expectedUpdatedAt: saved.card.updatedAt,
  });

  assert.equal(updated.ok, true);
  assert.equal(updated.scope, 'local-user-agent');
  assert.equal(updated.action, 'update');
  assert.equal(updated.card.content, 'User now prefers answer-first replies.');
  assert.equal(updated.card.status, 'active');

  const listUrl = new URL('http://127.0.0.1/api/agent-tools/memories');
  listUrl.searchParams.set('invocationId', context.invocationId);
  listUrl.searchParams.set('callbackToken', context.callbackToken);
  const listedAfterUpdate = bridge.handleListMemories(listUrl);

  assert.equal(listedAfterUpdate.cardCount, 1);
  assert.equal(listedAfterUpdate.cards[0].content, 'User now prefers answer-first replies.');

  assert.throws(
    () =>
      bridge.handleUpdateMemory({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        title: 'preference',
        content: 'Stale overwrite should fail.',
        reason: 'Old snapshot',
        expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
      }),
    (error) => error && error.statusCode === 409
  );

  const forgotten = bridge.handleForgetMemory({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    title: 'preference',
    reason: 'User said this should not persist',
    expectedUpdatedAt: updated.card.updatedAt,
  });

  assert.equal(forgotten.ok, true);
  assert.equal(forgotten.scope, 'local-user-agent');
  assert.equal(forgotten.action, 'forget');
  assert.equal(forgotten.card.status, 'deleted');
  assert.equal('content' in forgotten.card, false);

  const listedAfterForget = bridge.handleListMemories(listUrl);
  assert.equal(listedAfterForget.cardCount, 0);
});

test('agent tool bridge routes memory writes to invocation store overrides', (t) => {
  const liveDir = withTempDir('caff-agent-tool-live-store-');
  const isolatedDir = withTempDir('caff-agent-tool-isolated-store-');
  const liveStore = createChatAppStore({ agentDir: liveDir, sqlitePath: path.join(liveDir, 'live.sqlite') });
  const isolatedStore = createChatAppStore({ agentDir: isolatedDir, sqlitePath: path.join(isolatedDir, 'isolated.sqlite') });
  const bridge = createAgentToolBridge({ store: liveStore });

  t.after(() => {
    try {
      isolatedStore.close();
    } catch {}
    try {
      liveStore.close();
    } catch {}
    fs.rmSync(liveDir, { recursive: true, force: true });
    fs.rmSync(isolatedDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(liveStore, 'store-override');
  isolatedStore.saveCustomRoleConfig({
    id: fixture.agent.id,
    name: fixture.agent.name,
    personaPrompt: 'Reply briefly.',
  });
  isolatedStore.createConversation({
    id: fixture.conversation.id,
    title: fixture.conversation.title,
    participants: [fixture.agent.id],
  });

  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
      store: isolatedStore,
      toolPolicy: { allowedTools: ['save-memory', 'list-memories'], rejects: [] },
    })
  );

  const saved = bridge.handleSaveMemory({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    title: 'preference',
    content: 'User prefers isolated test worlds.',
    ttlDays: 30,
  });

  assert.equal(saved.ok, true);
  assert.equal(liveStore.listVisibleMemoryCards(fixture.conversation.id, fixture.agent.id, { limit: 6 }).length, 0);
  assert.equal(isolatedStore.listVisibleMemoryCards(fixture.conversation.id, fixture.agent.id, { limit: 6 }).length, 1);
});

test('agent tool bridge rejects blocked tools via invocation policy and records evidence', (t) => {
  const tempDir = withTempDir('caff-agent-tool-policy-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'policy');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      projectDir: tempDir,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
      dryRun: true,
      toolPolicy: { allowedTools: ['read-context'], rejects: [] },
    })
  );

  assert.throws(
    () =>
      bridge.handleTrellisWrite({
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        path: '.trellis/tasks/policy/prd.md',
        content: '# blocked',
      }),
    (error) => error && error.statusCode === 403
  );

  assert.equal(Array.isArray(context.policyRejects), true);
  assert.equal(context.policyRejects.length, 1);
  assert.equal(context.policyRejects[0].toolName, 'trellis-write');
});

test('agent tool bridge proxies sandbox file and bash tools via invocation adapter', async (t) => {
  const tempDir = withTempDir('caff-agent-tool-bridge-sandbox-tools-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });
  const sandboxFilePath = path.join(tempDir, 'project', 'SKILL.md');
  const sandboxWritePath = path.join(tempDir, 'project', 'notes.md');
  const sandboxDirPath = path.join(tempDir, 'project', 'nested');
  const sandboxCwd = path.join(tempDir, 'project');
  const calls = {
    access: [],
    read: [],
    write: [],
    mkdir: [],
    bash: [],
  };

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'sandbox-tools');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      projectDir: tempDir,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
      dryRun: true,
      sandboxToolAdapter: {
        async access(targetPath) {
          calls.access.push(targetPath);
        },
        async readFile(targetPath) {
          calls.read.push(targetPath);
          return Uint8Array.from(Buffer.from('# sandbox skill\n', 'utf8'));
        },
        async writeFile(targetPath, content) {
          calls.write.push({ targetPath, content });
        },
        async mkdir(targetPath) {
          calls.mkdir.push(targetPath);
        },
        async runCommand(command, options = {}) {
          calls.bash.push({ command, options });
          return {
            stdout: '/case/project\n',
            stderr: '',
            exitCode: 0,
          };
        },
      },
    })
  );

  const accessResult = await bridge.handleSandboxAccess({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    absolutePath: sandboxFilePath,
  });
  const readResult = await bridge.handleSandboxRead({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    absolutePath: sandboxFilePath,
  });
  const writeResult = await bridge.handleSandboxWrite({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    absolutePath: sandboxWritePath,
    content: '# sandbox write\n',
  });
  const mkdirResult = await bridge.handleSandboxMkdir({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    absolutePath: sandboxDirPath,
  });
  const bashResult = await bridge.handleSandboxBash({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    command: 'pwd',
    cwd: sandboxCwd,
    timeout: 12,
    env: { DEMO_FLAG: '1' },
  });

  assert.deepEqual(accessResult, { ok: true });
  assert.equal(Buffer.from(readResult.base64, 'base64').toString('utf8'), '# sandbox skill\n');
  assert.deepEqual(writeResult, { ok: true });
  assert.deepEqual(mkdirResult, { ok: true });
  assert.equal(bashResult.stdout, '/case/project\n');
  assert.equal(bashResult.stderr, '');
  assert.equal(bashResult.exitCode, 0);
  assert.deepEqual(calls.access, [sandboxFilePath]);
  assert.deepEqual(calls.read, [sandboxFilePath]);
  assert.deepEqual(calls.write, [{ targetPath: sandboxWritePath, content: '# sandbox write\n' }]);
  assert.deepEqual(calls.mkdir, [sandboxDirPath]);
  assert.deepEqual(calls.bash, [{ command: 'pwd', options: { cwd: sandboxCwd, timeout: 12, env: { DEMO_FLAG: '1' } } }]);
});
