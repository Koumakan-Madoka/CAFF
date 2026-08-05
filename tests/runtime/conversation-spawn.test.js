const assert = require('node:assert/strict');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const {
  createConversationSpawnService,
} = require('../../build/server/domain/conversation/conversation-spawn');
const {
  createCrossConversationDeliveryWorker,
} = require('../../build/server/domain/conversation/cross-conversation-delivery');

function bindProjectScope(store, conversationId, projectScopeId = 'project-1') {
  store.db.prepare(`
    UPDATE chat_conversations
    SET project_scope_id = ?
    WHERE id = ?
  `).run(projectScopeId, conversationId);
}

function createFixture(options = {}) {
  const store = createChatAppStore({ agentDir: process.cwd(), sqlitePath: ':memory:' });
  const sourceAgent = store.saveCustomRoleConfig({
    id: options.sourceAgentId || 'spawn-source-agent',
    name: 'Spawn Source Agent',
    personaPrompt: 'Parent-only persona that must not be copied.',
    skills: ['parent-only-skill'],
  });
  const primaryAgent = store.saveCustomRoleConfig({
    id: options.primaryAgentId || 'spawn-primary-agent',
    name: 'Spawn Primary Agent',
    personaPrompt: 'Handle the public bootstrap message.',
  });
  const observerAgent = store.saveCustomRoleConfig({
    id: options.observerAgentId || 'spawn-observer-agent',
    name: 'Spawn Observer Agent',
    personaPrompt: 'Do not start automatically.',
  });
  const sourceConversation = store.createConversation({
    id: options.sourceConversationId || 'spawn-source-conversation',
    title: 'Spawn Source Conversation',
    metadata: {
      digest: { summary: 'Parent history must not be copied.' },
      taskState: { status: 'running' },
    },
    participants: [{
      agentId: sourceAgent.id,
      conversationSkillIds: ['parent-conversation-skill'],
    }],
  });
  if (options.bindSource !== false) {
    bindProjectScope(store, sourceConversation.id, options.projectScopeId || 'project-1');
  }
  const sourceMessage = store.createMessage({
    id: options.sourceMessageId || 'spawn-source-message',
    conversationId: sourceConversation.id,
    turnId: 'spawn-source-turn',
    role: 'assistant',
    agentId: sourceAgent.id,
    senderName: sourceAgent.name,
    content: 'This parent message is provenance only and must not be copied.',
  });

  let idSequence = 0;
  const service = createConversationSpawnService({
    store,
    now: () => new Date('2026-08-05T08:00:00.000Z'),
    createId: () => `spawn-generated-${++idSequence}`,
    validateParticipants(input) {
      if (options.validateParticipants) {
        return options.validateParticipants(input);
      }
      return store.normalizeConversationParticipantsInput(input);
    },
    resolveProject(projectScopeId) {
      if (options.resolveProject) {
        return options.resolveProject(projectScopeId);
      }
      return projectScopeId === (options.projectScopeId || 'project-1')
        ? { id: projectScopeId, name: 'Spawn Project' }
        : null;
    },
    onBootstrapAvailable: options.onBootstrapAvailable,
  });

  return {
    store,
    service,
    sourceAgent,
    primaryAgent,
    observerAgent,
    sourceConversation,
    sourceMessage,
  };
}

function spawnInput(fixture, overrides = {}) {
  return {
    title: 'Fresh Child Conversation',
    projectScopeId: 'project-1',
    participants: [
      { agentId: fixture.primaryAgent.id, conversationSkillIds: ['child-only-skill'] },
      { agentId: fixture.observerAgent.id },
    ],
    primaryAgentId: fixture.primaryAgent.id,
    initialMessage: 'This is the complete public bootstrap message.',
    sourceMessageId: fixture.sourceMessage.id,
    clientRequestId: 'spawn-client-request-1',
    ...overrides,
  };
}

function assertSpawnError(code, statusCode) {
  return (error) => error && error.code === code && error.statusCode === statusCode;
}

test('spawn atomically creates a non-Fork child, public first message, receipt, and bootstrap delivery', () => {
  const fixture = createFixture();
  try {
    const first = fixture.service.spawn(
      fixture.sourceConversation.id,
      spawnInput(fixture)
    );
    const duplicate = fixture.service.spawn(
      fixture.sourceConversation.id,
      spawnInput(fixture)
    );

    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.conversation.id, first.conversation.id);
    assert.equal(duplicate.delivery.id, first.delivery.id);

    assert.equal(first.conversation.projectScopeId, 'project-1');
    assert.equal(first.conversation.parentConversationId, fixture.sourceConversation.id);
    assert.equal(first.conversation.originConversationId, fixture.sourceConversation.id);
    assert.equal(first.conversation.originMessageId, fixture.sourceMessage.id);
    assert.equal(first.conversation.treeDepth, 1);
    assert.equal(first.conversation.type, 'standard');
    assert.deepEqual(first.conversation.metadata, {});
    assert.deepEqual(
      first.conversation.agents.map((agent) => agent.id),
      [fixture.primaryAgent.id, fixture.observerAgent.id]
    );
    assert.deepEqual(first.conversation.agents[0].conversationSkills, ['child-only-skill']);

    const childMessages = fixture.store.listMessages(first.conversation.id);
    assert.equal(childMessages.length, 1);
    assert.equal(childMessages[0].id, first.initialMessage.id);
    assert.equal(childMessages[0].role, 'user');
    assert.equal(childMessages[0].senderName, 'You');
    assert.equal(childMessages[0].content, 'This is the complete public bootstrap message.');
    assert.equal(childMessages[0].metadata.kind, 'conversation_spawn_initial_message');
    assert.equal(childMessages[0].metadata.crossConversation.deliveryId, first.delivery.id);
    assert.equal(childMessages[0].metadata.crossConversation.authority, 'user');
    assert.equal(childMessages[0].metadata.crossConversation.sourceConversationId, fixture.sourceConversation.id);

    assert.equal(first.sourceReceipt.role, 'system');
    assert.equal(first.sourceReceipt.metadata.kind, 'cross_conversation_receipt');
    assert.equal(first.sourceReceipt.metadata.crossConversation.deliveryId, first.delivery.id);
    assert.equal(first.delivery.kind, 'bootstrap');
    assert.equal(first.delivery.principalKind, 'operator');
    assert.equal(first.delivery.targetConversationId, first.conversation.id);
    assert.equal(first.delivery.targetAgentId, fixture.primaryAgent.id);
    assert.equal(first.delivery.targetMessageId, first.initialMessage.id);
    assert.equal(first.delivery.sourceReceiptMessageId, first.sourceReceipt.id);
    assert.equal(first.delivery.messageStatus, 'persisted');
    assert.equal(first.delivery.dispatchStatus, 'queued');
    assert.equal(first.delivery.responseStatus, 'not_expected');

    assert.equal(
      fixture.store.db.prepare('SELECT COUNT(*) AS count FROM chat_conversations').get().count,
      2
    );
    assert.equal(
      fixture.store.db.prepare('SELECT COUNT(*) AS count FROM chat_cross_conversation_deliveries').get().count,
      1
    );
    assert.equal(
      fixture.store.db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get().count,
      3
    );
    assert.doesNotMatch(
      JSON.stringify(first.conversation),
      /Parent history must not be copied|Parent-only persona|parent-only-skill|parent-conversation-skill/u
    );
    assert.doesNotMatch(
      JSON.stringify(fixture.store.listCrossConversationDeliveryEvents(first.delivery.id)),
      /complete public bootstrap message/u
    );
  } finally {
    fixture.store.close();
  }
});

test('spawn validates explicit scope, participants, primary Agent, message, source anchor, and max depth', () => {
  const fixture = createFixture();
  try {
    assert.throws(
      () => fixture.service.spawn(fixture.sourceConversation.id, spawnInput(fixture, { title: ' ' })),
      assertSpawnError('conversation_spawn_invalid_request', 400)
    );
    assert.throws(
      () => fixture.service.spawn(fixture.sourceConversation.id, spawnInput(fixture, { projectScopeId: 'missing-project' })),
      assertSpawnError('conversation_spawn_project_not_found', 404)
    );
    assert.throws(
      () => fixture.service.spawn(fixture.sourceConversation.id, spawnInput(fixture, { primaryAgentId: fixture.sourceAgent.id })),
      assertSpawnError('conversation_spawn_primary_not_participant', 422)
    );
    assert.throws(
      () => fixture.service.spawn(fixture.sourceConversation.id, spawnInput(fixture, { initialMessage: '' })),
      assertSpawnError('conversation_spawn_invalid_request', 400)
    );
    assert.throws(
      () => fixture.service.spawn(fixture.sourceConversation.id, spawnInput(fixture, { clientRequestId: '' })),
      assertSpawnError('conversation_spawn_invalid_request', 400)
    );
    assert.throws(
      () => fixture.service.spawn(fixture.sourceConversation.id, spawnInput(fixture, { sourceMessageId: 'missing-source-message' })),
      assertSpawnError('conversation_spawn_source_message_not_found', 404)
    );

    const child = fixture.service.spawn(
      fixture.sourceConversation.id,
      spawnInput(fixture, { clientRequestId: 'spawn-depth-child' })
    );
    const grandchild = fixture.service.spawn(
      child.conversation.id,
      spawnInput(fixture, {
        sourceMessageId: child.initialMessage.id,
        clientRequestId: 'spawn-depth-grandchild',
      })
    );
    assert.equal(grandchild.conversation.treeDepth, 2);
    assert.throws(
      () => fixture.service.spawn(
        grandchild.conversation.id,
        spawnInput(fixture, {
          sourceMessageId: grandchild.initialMessage.id,
          clientRequestId: 'spawn-depth-overflow',
        })
      ),
      assertSpawnError('conversation_spawn_max_depth', 409)
    );
  } finally {
    fixture.store.close();
  }

  const unbound = createFixture({ bindSource: false });
  try {
    assert.throws(
      () => unbound.service.spawn(unbound.sourceConversation.id, spawnInput(unbound)),
      assertSpawnError('conversation_spawn_source_unbound', 409)
    );
  } finally {
    unbound.store.close();
  }

  const crossProject = createFixture({
    resolveProject(projectScopeId) {
      return { id: projectScopeId, name: 'Accessible Project' };
    },
  });
  try {
    assert.throws(
      () => crossProject.service.spawn(
        crossProject.sourceConversation.id,
        spawnInput(crossProject, { projectScopeId: 'project-2' })
      ),
      assertSpawnError('conversation_spawn_project_mismatch', 403)
    );
  } finally {
    crossProject.store.close();
  }

  const unavailable = createFixture({
    validateParticipants() {
      const error = new Error('Conversation participant role is not currently runnable');
      error.statusCode = 422;
      error.code = 'participant_role_unavailable';
      throw error;
    },
  });
  try {
    assert.throws(
      () => unavailable.service.spawn(unavailable.sourceConversation.id, spawnInput(unavailable)),
      (error) => error && error.code === 'participant_role_unavailable' && error.statusCode === 422
    );
  } finally {
    unavailable.store.close();
  }
});

test('spawn transaction rolls back every persisted object when any insert step fails', async (t) => {
  const faultCases = [
    ['conversation', (fixture) => {
      fixture.store.conversationRepository.create = () => { throw new Error('fault: conversation'); };
    }],
    ['participants', (fixture) => {
      fixture.store.replaceConversationParticipants = () => { throw new Error('fault: participants'); };
    }],
    ['delivery', (fixture) => {
      fixture.store.crossConversationDeliveryRepository.create = () => { throw new Error('fault: delivery'); };
    }],
    ['initial message', (fixture) => {
      fixture.store.messageRepository.create = () => { throw new Error('fault: initial message'); };
    }],
    ['source receipt', (fixture) => {
      const original = fixture.store.messageRepository.create.bind(fixture.store.messageRepository);
      let callCount = 0;
      fixture.store.messageRepository.create = (payload) => {
        callCount += 1;
        if (callCount === 2) throw new Error('fault: source receipt');
        return original(payload);
      };
    }],
    ['message transition', (fixture) => {
      fixture.store.crossConversationDeliveryRepository.markMessagesPersisted = () => null;
    }],
    ['event', (fixture) => {
      fixture.store.crossConversationDeliveryRepository.appendEvent = () => { throw new Error('fault: event'); };
    }],
  ];

  for (const [name, injectFault] of faultCases) {
    await t.test(name, () => {
      const fixture = createFixture();
      try {
        const before = {
          conversations: fixture.store.db.prepare('SELECT COUNT(*) AS count FROM chat_conversations').get().count,
          messages: fixture.store.db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get().count,
          deliveries: fixture.store.db.prepare('SELECT COUNT(*) AS count FROM chat_cross_conversation_deliveries').get().count,
          events: fixture.store.db.prepare('SELECT COUNT(*) AS count FROM chat_cross_conversation_delivery_events').get().count,
        };
        injectFault(fixture);

        assert.throws(
          () => fixture.service.spawn(fixture.sourceConversation.id, spawnInput(fixture)),
          /fault:|message projection transition failed/u
        );
        assert.deepEqual({
          conversations: fixture.store.db.prepare('SELECT COUNT(*) AS count FROM chat_conversations').get().count,
          messages: fixture.store.db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get().count,
          deliveries: fixture.store.db.prepare('SELECT COUNT(*) AS count FROM chat_cross_conversation_deliveries').get().count,
          events: fixture.store.db.prepare('SELECT COUNT(*) AS count FROM chat_cross_conversation_delivery_events').get().count,
        }, before);
      } finally {
        fixture.store.close();
      }
    });
  }
});

test('bootstrap failure retains the child and retry reuses the same delivery while dispatching only primary', async () => {
  const available = [];
  const fixture = createFixture({
    onBootstrapAvailable(result) {
      available.push(result.delivery.id);
    },
  });
  try {
    const spawned = fixture.service.spawn(fixture.sourceConversation.id, spawnInput(fixture));
    let shouldFail = true;
    const dispatched = [];
    const worker = createCrossConversationDeliveryWorker({
      store: fixture.store,
      maxAttempts: 1,
      retryDelayMs: 0,
      now: (() => {
        let tick = 0;
        return () => new Date(Date.parse('2026-08-05T08:01:00.000Z') + tick++ * 1000);
      })(),
      async dispatchTarget(input) {
        dispatched.push({
          deliveryId: input.delivery.id,
          targetAgentId: input.delivery.targetAgentId,
          targetMessageRole: input.targetMessage.role,
        });
        if (shouldFail) {
          throw new Error('synthetic bootstrap pre-start failure');
        }
        await input.onInvocationStarting({ invocationId: 'spawn-bootstrap-invocation' });
        return {};
      },
    });

    const failed = await worker.processNext();
    assert.equal(failed.status, 'failed');
    assert.equal(fixture.store.getCrossConversationDelivery(spawned.delivery.id).dispatchStatus, 'failed');
    assert.ok(fixture.store.getConversation(spawned.conversation.id));
    assert.equal(fixture.store.listMessages(spawned.conversation.id).length, 1);

    const retried = await worker.retry(spawned.delivery.id, 'Retry the retained child bootstrap');
    assert.equal(retried.id, spawned.delivery.id);
    assert.equal(retried.dispatchStatus, 'queued');
    shouldFail = false;
    const completed = await worker.processNext();

    assert.equal(completed.status, 'completed');
    assert.equal(completed.delivery.id, spawned.delivery.id);
    assert.deepEqual(available, [spawned.delivery.id]);
    assert.deepEqual(dispatched, [
      {
        deliveryId: spawned.delivery.id,
        targetAgentId: fixture.primaryAgent.id,
        targetMessageRole: 'user',
      },
      {
        deliveryId: spawned.delivery.id,
        targetAgentId: fixture.primaryAgent.id,
        targetMessageRole: 'user',
      },
    ]);
    assert.equal(fixture.store.listMessages(spawned.conversation.id).length, 1);
  } finally {
    fixture.store.close();
  }
});
