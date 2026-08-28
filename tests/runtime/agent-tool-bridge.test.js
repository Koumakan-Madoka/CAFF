const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createSqliteRunStore } = require('../../build/lib/sqlite-store');
const {
  createModelCallObservabilityEvent,
  createObservabilityTimelineState,
} = require('../../build/lib/observability-timeline');
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

test('agent tool bridge projects bounded private handoff dispatch without echoing content', (t) => {
  const tempDir = withTempDir('caff-agent-tool-private-dispatch-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const sender = store.saveCustomRoleConfig({
    id: 'bridge-private-sender',
    name: 'Private Sender',
    personaPrompt: 'Send one complete review request.',
  });
  const recipient = store.saveCustomRoleConfig({
    id: 'bridge-private-recipient',
    name: 'Private Recipient',
    personaPrompt: 'Review requests.',
  });
  const conversation = store.createConversation({
    id: 'bridge-private-dispatch-conversation',
    title: 'Private dispatch projection',
    participants: [sender.id, recipient.id],
  });
  const assistantMessage = store.createMessage({
    id: 'bridge-private-dispatch-message',
    conversationId: conversation.id,
    turnId: 'bridge-private-dispatch-turn',
    role: 'assistant',
    agentId: sender.id,
    senderName: sender.name,
    content: 'Thinking...',
    status: 'streaming',
  });
  const fullConversation = store.getConversation(conversation.id);
  const bridge = createAgentToolBridge({ store });
  let enqueueCallCount = 0;
  const enqueueInputs = [];
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: conversation.id,
      turnId: assistantMessage.turnId,
      agentId: sender.id,
      agentName: sender.name,
      assistantMessageId: assistantMessage.id,
      conversationAgents: fullConversation.agents,
      stage: { status: 'running', runId: 'sender-run-1' },
      turnState: { conversationId: conversation.id, turnId: assistantMessage.turnId, stopRequested: false },
      enqueueAgent(input) {
        enqueueCallCount += 1;
        enqueueInputs.push(input);
        return {
          enqueuedAgentIds: [recipient.id],
          dispatch: [{
            agentId: recipient.id,
            outcome: 'launched',
            detail: 'Recipient started immediately in this turn.',
          }],
        };
      },
    })
  );

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const response = bridge.handlePostMessage({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    visibility: 'private',
    recipients: [recipient.name],
    content: 'Private review body must not appear in dispatch telemetry.',
  });

  assert.equal(response.handoffRequested, true);
  assert.equal(enqueueCallCount, 1);
  assert.equal(enqueueInputs[0].triggerType, 'private');
  assert.equal(enqueueInputs[0].triggeredByAgentId, sender.id);
  assert.equal(enqueueInputs[0].parentRunId, 'sender-run-1');
  assert.deepEqual(enqueueInputs[0].agentIds, [recipient.id]);
  assert.deepEqual(response.enqueuedAgentIds, [recipient.id]);
  assert.deepEqual(response.dispatch, [{
    agentId: recipient.id,
    outcome: 'launched',
    detail: 'Recipient started immediately in this turn.',
  }]);
  assert.equal(JSON.stringify(response.dispatch).includes('Private review body'), false);

  const selfNote = bridge.handlePostMessage({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    visibility: 'private',
    recipients: [sender.name],
    content: 'Self note only.',
  });
  const noHandoff = bridge.handlePostMessage({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    visibility: 'private',
    recipients: [recipient.name],
    noHandoff: true,
    content: 'Persist without wake-up.',
  });

  assert.equal(selfNote.handoffRequested, false);
  assert.deepEqual(selfNote.dispatch, []);
  assert.equal(noHandoff.handoffRequested, false);
  assert.deepEqual(noHandoff.dispatch, []);
  assert.equal(enqueueCallCount, 1, 'self-private and no-handoff must not dispatch another Agent');
});

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

test('agent tool bridge preserves and updates checklist content on pending set proposals', (t) => {
  const tempDir = withTempDir('caff-agent-tool-goal-set-checklist-');
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

  const fixture = createPublicInvocationFixture(store, 'goal-set-checklist');
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

  const suggested = bridge.handleSuggestGoal({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    action: 'set',
    objective: 'Ship pending goal checklist support',
    reason: 'Keep approval content explicit',
    checklistText: '[x] Reproduce\n[~] Implement\n[ ] Validate',
  });

  assert.equal(suggested.goal, null);
  assert.equal(suggested.proposal.action, 'set');
  assert.equal(suggested.proposal.checklist.length, 3);
  assert.equal(suggested.proposal.checklist[0].status, 'done');
  assert.equal(suggested.proposal.checklist[1].status, 'in_progress');

  const updated = bridge.handleUpdateGoalChecklist({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    checklistText: '[x] Reproduce\n[x] Implement\n[~] Validate',
  });
  const conversation = store.getConversation(fixture.conversation.id);

  assert.equal(updated.goal, null);
  assert.equal(updated.checklistTarget, 'proposal');
  assert.equal(updated.checklist[1].status, 'done');
  assert.equal(conversation.metadata.sessionGoal, undefined);
  assert.equal(conversation.metadata.sessionGoalProposal.checklist[2].status, 'in_progress');
  assert.ok(broadcastEvents.some((event) => event.eventName === 'conversation_goal_proposal_updated'));
});

test('agent tool bridge seeds the default checklist on pending set proposals', (t) => {
  const tempDir = withTempDir('caff-agent-tool-goal-set-default-checklist-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'goal-set-default-checklist');
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
    action: 'set',
    objective: 'Use an explicit default checklist',
  });

  assert.equal(result.proposal.checklist.length, 10);
  assert.equal(result.proposal.checklist[0].text, '和其他 agent 一起头脑风暴，收敛目标、范围和风险');
  assert.equal(result.proposal.checklist[9].text, '人工验收后记录会话并归档 Trellis 任务');
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

test('agent tool bridge updates the active checklist when a non-set proposal is pending', (t) => {
  const tempDir = withTempDir('caff-agent-tool-goal-checklist-non-set-proposal-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'goal-checklist-non-set-proposal');
  store.updateConversation(fixture.conversation.id, {
    metadata: {
      sessionGoal: {
        objective: 'Finish an active task',
        status: 'active',
        createdAt: '2026-05-03T00:00:00.000Z',
        updatedAt: '2026-05-03T00:00:00.000Z',
      },
      sessionGoalProposal: {
        id: 'prop-complete-pending',
        action: 'complete',
        status: 'pending',
        reason: 'Await user acceptance',
        proposedBy: { agentId: 'agent-reviewer', agentName: 'Reviewer' },
        createdAt: '2026-05-03T00:10:00.000Z',
        updatedAt: '2026-05-03T00:10:00.000Z',
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
    checklistText: '[x] Finish implementation\n[ ] Await acceptance',
  });
  const conversation = store.getConversation(fixture.conversation.id);

  assert.equal(result.checklistTarget, 'goal');
  assert.equal(result.goal.checklist[0].status, 'done');
  assert.equal(conversation.metadata.sessionGoalProposal.action, 'complete');
  assert.equal(conversation.metadata.sessionGoalProposal.checklist, undefined);
});

test('agent tool bridge keeps missing goal checklist updates as 404 without a pending set proposal', (t) => {
  const tempDir = withTempDir('caff-agent-tool-goal-checklist-missing-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'goal-checklist-missing');
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
    () => bridge.handleUpdateGoalChecklist({
      invocationId: context.invocationId,
      callbackToken: context.callbackToken,
      checklistText: '[ ] There is no target',
    }),
    (error) => error && error.statusCode === 404 && /No session goal is set/u.test(error.message)
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

test('agent tool bridge keeps active runs alive when public posts opt out of finalization', async (t) => {
  const tempDir = withTempDir('caff-agent-tool-bridge-no-finalize-');
  const sqlitePath = path.join(tempDir, 'bridge-no-finalize.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'no-finalize');
  let callbackCount = 0;
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
      onPublicPostCompleted() {
        callbackCount += 1;
      },
    })
  );

  const response = bridge.handlePostMessage({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    visibility: 'public',
    content: 'Progress update before continuing work',
    noFinalize: true,
  });

  assert.equal(response.ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callbackCount, 0);
  assert.equal(context.publicPostCompletionRequested, false);

  const finalResponse = bridge.handlePostMessage({
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    visibility: 'public',
    content: 'Final public reply',
  });

  assert.equal(finalResponse.ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callbackCount, 1);
  assert.equal(context.publicPostCompletionRequested, true);
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
  const observabilityTimelineState = createObservabilityTimelineState();
  createModelCallObservabilityEvent(observabilityTimelineState, {
    responseId: 'bridge-shared-state-model-call',
    tokenUsage: {
      inputTokens: 10,
      uncachedInputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
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
      observabilityTimelineState,
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
  assert.equal(context.observabilityTimelineState, observabilityTimelineState);
  assert.ok(liveEvents.length >= 2);
  assert.deepEqual(
    liveEvents.map((entry) => entry.payload.step.timelineSequence),
    liveEvents.map(() => 2),
  );
  assert.deepEqual(
    liveEvents.map((entry) => entry.payload.timelineWindow.totalEventCount),
    liveEvents.map(() => 2),
  );
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

test('agent tool participant projection excludes platform system actors and reserved-name impersonators', (t) => {
  const tempDir = withTempDir('caff-agent-tool-system-actor-participants-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createPublicInvocationFixture(store, 'system-actor-participants');
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
  const getConversation = store.getConversation.bind(store);
  store.getConversation = (conversationId) => {
    const conversation = getConversation(conversationId);
    return conversation
      ? {
          ...conversation,
          agents: [
            ...conversation.agents,
            { id: 'recovery_scribe', name: '系统书记' },
            { id: 'legacy-scribe-role', name: 'Recovery_Scribe' },
          ],
        }
      : null;
  };
  const requestUrl = new URL('http://127.0.0.1/api/agent-tools/participants');
  requestUrl.searchParams.set('invocationId', context.invocationId);
  requestUrl.searchParams.set('callbackToken', context.callbackToken);

  const result = bridge.handleListParticipants(requestUrl);

  assert.deepEqual(result.participants.map((participant) => participant.id), [fixture.agent.id]);
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

function createDagBoundGoalFixture(store, suffix, participantCount = 2) {
  const agents = [];
  for (let index = 0; index < participantCount; index += 1) {
    agents.push(store.saveCustomRoleConfig({
      id: `bridge-agent-${suffix}-${index}`,
      name: `Bridge Agent ${suffix} ${index}`,
      personaPrompt: 'Reply briefly.',
    }));
  }
  const conversation = store.createConversation({
    id: `bridge-conversation-${suffix}`,
    title: `DAG Node ${suffix}`,
    participants: agents.map((agent) => agent.id),
  });
  const assistantMessage = store.createMessage({
    id: `bridge-message-${suffix}`,
    conversationId: conversation.id,
    turnId: `bridge-turn-${suffix}`,
    role: 'assistant',
    agentId: agents[0].id,
    senderName: agents[0].name,
    content: 'Thinking...',
    status: 'streaming',
  });
  store.updateConversation(conversation.id, {
    metadata: {
      sessionGoal: {
        objective: 'DAG node goal',
        status: 'active',
        createdAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T00:00:00.000Z',
      },
      dagNodeGoalBinding: {
        planId: 'plan-1',
        nodeId: 'n1',
        workerId: agents[0].id,
        verifierId: agents.length > 1 ? agents[1].id : null,
      },
    },
  });
  return {
    agents,
    conversation: store.getConversation(conversation.id),
    assistantMessage,
    turnState: { conversationId: conversation.id, turnId: assistantMessage.turnId, stopRequested: false },
    stage: { status: 'running', replyLength: 0, preview: '', lastTextDeltaAt: null },
  };
}

function registerAgentInvocation(bridge, fixture, agent) {
  return bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: agent.id,
      agentName: agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );
}

function createGoalTestBridge(store, broadcastEvents) {
  return createAgentToolBridge({
    store,
    broadcastEvent(eventName, payload) {
      broadcastEvents.push({ eventName, payload });
    },
    broadcastConversationSummary() {},
  });
}

function assertForbidden(error, code) {
  assert.equal(error && error.statusCode, 403, `expected 403, got ${error && error.statusCode}: ${error && error.message}`);
  assert.ok(String(error && error.message || '').includes(code), `expected ${code}: ${error && error.message}`);
}

test('DAG goal binding: only the node worker can declare completion (dag_completion_worker_only)', (t) => {
  const tempDir = withTempDir('caff-bridge-dag-worker-only-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'bridge.sqlite') });
  const broadcastEvents = [];
  const bridge = createGoalTestBridge(store, broadcastEvents);
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createDagBoundGoalFixture(store, 'dag-worker', 2);
  const [worker, verifier] = fixture.agents;

  // The verifier (non-worker) cannot announce completion on the worker's behalf.
  const verifierContext = registerAgentInvocation(bridge, fixture, verifier);
  assert.throws(
    () => bridge.handleSuggestGoal({
      invocationId: verifierContext.invocationId,
      callbackToken: verifierContext.callbackToken,
      action: 'complete',
      reason: 'I say it is done',
    }),
    (error) => { assertForbidden(error, 'dag_completion_worker_only'); return true; },
  );
  assert.equal(store.getConversation(fixture.conversation.id).metadata.sessionGoalProposal, undefined);

  // The worker can.
  const workerContext = registerAgentInvocation(bridge, fixture, worker);
  const result = bridge.handleSuggestGoal({
    invocationId: workerContext.invocationId,
    callbackToken: workerContext.callbackToken,
    action: 'complete',
    reason: 'Work finished',
  });
  assert.equal(result.ok, true);
  assert.equal(result.proposal.action, 'complete');
});

test('DAG goal binding: only the designated verifier can accept/reject (dag_verifier_only)', (t) => {
  const tempDir = withTempDir('caff-bridge-dag-verifier-only-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'bridge.sqlite') });
  const broadcastEvents = [];
  const bridge = createGoalTestBridge(store, broadcastEvents);
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createDagBoundGoalFixture(store, 'dag-verifier', 3);
  const [worker, verifier, third] = fixture.agents;

  // Worker proposes completion.
  const workerContext = registerAgentInvocation(bridge, fixture, worker);
  bridge.handleSuggestGoal({
    invocationId: workerContext.invocationId,
    callbackToken: workerContext.callbackToken,
    action: 'complete',
    reason: 'Work finished',
  });

  // A third participant cannot hijack the ruling.
  const thirdContext = registerAgentInvocation(bridge, fixture, third);
  assert.throws(
    () => bridge.handleSuggestGoal({
      invocationId: thirdContext.invocationId,
      callbackToken: thirdContext.callbackToken,
      action: 'accept',
    }),
    (error) => { assertForbidden(error, 'dag_verifier_only'); return true; },
  );

  // The worker still cannot self-review (binding check must not weaken it).
  const workerContext2 = registerAgentInvocation(bridge, fixture, worker);
  assert.throws(
    () => bridge.handleSuggestGoal({
      invocationId: workerContext2.invocationId,
      callbackToken: workerContext2.callbackToken,
      action: 'accept',
    }),
    (error) => { assertForbidden(error, 'goal_proposal_self_review'); return true; },
  );

  // The designated verifier can.
  const verifierContext = registerAgentInvocation(bridge, fixture, verifier);
  const result = bridge.handleSuggestGoal({
    invocationId: verifierContext.invocationId,
    callbackToken: verifierContext.callbackToken,
    action: 'accept',
    reason: 'looks good',
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'accepted');
  const clearedEvent = broadcastEvents.find((event) => event.eventName === 'conversation_goal_proposal_cleared');
  assert.ok(clearedEvent, 'cleared event broadcast');
  assert.equal(clearedEvent.payload.ruledBy.agentId, verifier.id);
  assert.ok(clearedEvent.payload.proposal, 'cleared event carries the proposal snapshot');

  // The ruling is persisted ATOMICALLY with the mutation (durable record
  // the DAG scheduler validates at settle/reconcile time).
  const ruling = store.getConversation(fixture.conversation.id).metadata.sessionGoalRuling;
  assert.ok(ruling, 'ruling record persisted with the accept mutation');
  assert.equal(ruling.outcome, 'accepted');
  assert.equal(ruling.action, 'complete');
  assert.equal(ruling.ruledBy.agentId, verifier.id);
  assert.equal(ruling.reason, 'looks good');
  assert.equal(ruling.proposalSnapshot.reason, 'Work finished');
  assert.ok(ruling.proposalId, 'ruling references the ruled proposal id');
});

test('DAG goal binding: verification-exempt node rejects ALL agent rulings (dag_verifier_exempt)', (t) => {
  const tempDir = withTempDir('caff-bridge-dag-exempt-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'bridge.sqlite') });
  const broadcastEvents = [];
  const bridge = createGoalTestBridge(store, broadcastEvents);
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Two participants, but the binding marks the node verification-EXEMPT
  // (verifierId null): completion may only be ruled by the scheduler
  // auto-accept or the user — never by an agent.
  const fixture = createDagBoundGoalFixture(store, 'dag-exempt', 2);
  const [worker, other] = fixture.agents;
  const current = store.getConversation(fixture.conversation.id);
  store.updateConversation(current.id, {
    metadata: {
      ...(current.metadata || {}),
      dagNodeGoalBinding: { planId: 'plan-1', nodeId: 'n1', workerId: worker.id, verifierId: null },
    },
  });

  const workerContext = registerAgentInvocation(bridge, fixture, worker);
  bridge.handleSuggestGoal({
    invocationId: workerContext.invocationId,
    callbackToken: workerContext.callbackToken,
    action: 'complete',
    reason: 'Work finished',
  });

  for (const action of ['accept', 'reject']) {
    const otherContext = registerAgentInvocation(bridge, fixture, other);
    assert.throws(
      () => bridge.handleSuggestGoal({
        invocationId: otherContext.invocationId,
        callbackToken: otherContext.callbackToken,
        action,
        reason: 'I rule anyway',
      }),
      (error) => { assertForbidden(error, 'dag_verifier_exempt'); return true; },
      `exempt node must 403 agent ${action}`,
    );
  }

  // The attempted rulings never happened: goal still active, proposal still pending.
  const conversation = store.getConversation(fixture.conversation.id);
  assert.equal(conversation.metadata.sessionGoal.status, 'active');
  assert.ok(conversation.metadata.sessionGoalProposal, 'proposal still pending');
  assert.equal(conversation.metadata.sessionGoalRuling, undefined, 'no ruling persisted');
});

test('DAG goal binding: agents cannot drive non-complete goal mutations (dag_goal_mutation_forbidden)', (t) => {
  const tempDir = withTempDir('caff-bridge-dag-mutation-lock-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'bridge.sqlite') });
  const broadcastEvents = [];
  const bridge = createGoalTestBridge(store, broadcastEvents);
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createDagBoundGoalFixture(store, 'dag-mutation', 2);
  const [worker, verifier] = fixture.agents;

  // set/pause/resume/clear proposals would bypass the worker→verifier
  // completion protocol — forbidden for BOTH the worker and the verifier.
  for (const agent of [worker, verifier]) {
    for (const action of ['set', 'pause', 'resume', 'clear']) {
      const context = registerAgentInvocation(bridge, fixture, agent);
      assert.throws(
        () => bridge.handleSuggestGoal({
          invocationId: context.invocationId,
          callbackToken: context.callbackToken,
          action,
          objective: 'hijack',
          reason: 'hijack',
        }),
        (error) => { assertForbidden(error, 'dag_goal_mutation_forbidden'); return true; },
        `${agent.id} must not propose ${action} on a DAG-bound goal`,
      );
    }
  }

  // The goal is untouched.
  const conversation = store.getConversation(fixture.conversation.id);
  assert.equal(conversation.metadata.sessionGoal.status, 'active');
  assert.equal(conversation.metadata.sessionGoalProposal, undefined);
});

test('agent tool bridge exposes runtime stats that track active invocation lifecycle', (t) => {
  const tempDir = withTempDir('caff-bridge-runtime-stats-');
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const store = createChatAppStore({
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'chat.sqlite'),
  });

  const agent = store.saveCustomRoleConfig({
    id: 'bridge-stats-agent',
    name: 'Stats Agent',
    personaPrompt: 'Reply briefly.',
  });
  const conversation = store.createConversation({
    id: 'bridge-stats-conversation',
    title: 'Bridge Stats Conversation',
    participants: [agent.id],
  });
  const assistantMessage = store.createMessage({
    id: 'bridge-stats-message',
    conversationId: conversation.id,
    turnId: 'bridge-stats-turn',
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: 'Thinking...',
    status: 'streaming',
  });
  const fullConversation = store.getConversation(conversation.id);
  const bridge = createAgentToolBridge({ store });

  assert.deepEqual(bridge.getRuntimeStats(), { activeInvocations: 0 });

  const first = bridge.registerInvocation(bridge.createInvocationContext({
    conversationId: conversation.id,
    turnId: assistantMessage.turnId,
    agentId: agent.id,
    agentName: agent.name,
    assistantMessageId: assistantMessage.id,
    conversationAgents: fullConversation.agents,
    stage: { status: 'running', runId: 'stats-run-1' },
    turnState: { conversationId: conversation.id, turnId: assistantMessage.turnId, stopRequested: false },
    enqueueAgent() {
      return { enqueuedAgentIds: [], dispatch: [] };
    },
  }));
  const second = bridge.registerInvocation(bridge.createInvocationContext({
    conversationId: conversation.id,
    turnId: assistantMessage.turnId,
    agentId: agent.id,
    agentName: agent.name,
    assistantMessageId: assistantMessage.id,
    conversationAgents: fullConversation.agents,
    stage: { status: 'running', runId: 'stats-run-2' },
    turnState: { conversationId: conversation.id, turnId: assistantMessage.turnId, stopRequested: false },
    enqueueAgent() {
      return { enqueuedAgentIds: [], dispatch: [] };
    },
  }));

  assert.deepEqual(bridge.getRuntimeStats(), { activeInvocations: 2 });

  bridge.unregisterInvocation(first.invocationId);
  assert.deepEqual(bridge.getRuntimeStats(), { activeInvocations: 1 });

  bridge.unregisterInvocation(second.invocationId);
  assert.deepEqual(bridge.getRuntimeStats(), { activeInvocations: 0 });
});
