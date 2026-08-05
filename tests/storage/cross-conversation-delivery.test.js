const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { pickConversationSummary } = require('../../build/server/domain/conversation/conversation-view');
const { migrateChatSchema } = require('../../build/storage/sqlite/migrations');
const {
  createCrossConversationDeliveryRepository,
} = require('../../build/storage/chat/cross-conversation-delivery.repository');

function listColumnNames(db, tableName) {
  return new Set(
    db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => String(column.name))
  );
}

function openMigratedDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateChatSchema(db);
  return db;
}

function insertConversation(db, input) {
  db.prepare(`
    INSERT INTO chat_conversations (
      id,
      title,
      type,
      metadata_json,
      project_scope_id,
      parent_conversation_id,
      origin_conversation_id,
      origin_message_id,
      tree_depth,
      created_at,
      updated_at,
      last_message_at
    ) VALUES (?, ?, 'standard', '{}', ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    input.id,
    input.title || input.id,
    input.projectScopeId || null,
    input.parentConversationId || null,
    input.originConversationId || null,
    input.originMessageId || null,
    input.treeDepth || 0,
    input.createdAt || '2026-08-05T00:00:00.000Z',
    input.updatedAt || input.createdAt || '2026-08-05T00:00:00.000Z'
  );
}

function insertMessage(db, input) {
  db.prepare(`
    INSERT INTO chat_messages (
      id, conversation_id, turn_id, role, agent_id, sender_name, content,
      status, task_id, run_id, error_message, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', NULL, NULL, NULL, ?, ?)
  `).run(
    input.id,
    input.conversationId,
    input.turnId || `turn-${input.id}`,
    input.role || 'system',
    input.agentId || null,
    input.senderName || 'System',
    input.content || '',
    input.metadataJson || '{}',
    input.createdAt || '2026-08-05T00:00:00.000Z'
  );
}

function createDeliveryPayload(overrides = {}) {
  return {
    id: 'delivery-1',
    kind: 'request',
    idempotencyScope: 'agent:invocation-1:conversation_request',
    idempotencyKey: 'request-1',
    principalKind: 'agent',
    sourceConversationId: 'conversation-source',
    sourceMessageId: null,
    sourceTurnId: 'turn-source',
    sourceInvocationId: 'invocation-1',
    sourceAgentId: 'role-family-gpt',
    sourceAgentName: 'GPT',
    sourceProjectScopeId: 'project-1',
    targetConversationId: 'conversation-target',
    targetAgentId: 'role-family-qwen',
    targetMessageId: null,
    sourceReceiptMessageId: null,
    targetProjectScopeId: 'project-1',
    traceId: 'trace-1',
    rootDeliveryId: 'delivery-1',
    parentDeliveryId: null,
    replyToDeliveryId: null,
    hopCount: 0,
    messageStatus: 'pending',
    dispatchStatus: 'queued',
    responseStatus: 'waiting',
    attemptCount: 0,
    deadlineAt: '2026-08-05T00:10:00.000Z',
    cancelRequestedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    claimOwner: null,
    claimExpiresAt: null,
    nextAttemptAt: '2026-08-05T00:00:00.000Z',
    targetInvocationId: null,
    deliveredAt: null,
    startedAt: null,
    completedAt: null,
    respondedAt: null,
    terminalAt: null,
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    ...overrides,
  };
}

function seedDeliveryConversations(db) {
  insertConversation(db, {
    id: 'conversation-source',
    projectScopeId: 'project-1',
    createdAt: '2026-08-05T00:00:00.000Z',
  });
  insertConversation(db, {
    id: 'conversation-target',
    projectScopeId: 'project-1',
    createdAt: '2026-08-05T00:00:01.000Z',
  });
}

test('F003 migration adds lineage and durable delivery schema without losing legacy conversations', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE chat_conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'standard',
      metadata_json TEXT,
      project_scope_id TEXT,
      parent_conversation_id TEXT,
      origin_conversation_id TEXT,
      origin_message_id TEXT,
      tree_depth INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_message_at TEXT
    );
    INSERT INTO chat_conversations (
      id, title, type, metadata_json, created_at, updated_at, last_message_at
    ) VALUES (
      'legacy-conversation', 'Legacy', 'standard', '{}',
      '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z', NULL
    );
  `);

  migrateChatSchema(db);

  const conversationColumns = listColumnNames(db, 'chat_conversations');
  for (const column of [
    'project_scope_id',
    'parent_conversation_id',
    'origin_conversation_id',
    'origin_message_id',
    'tree_depth',
  ]) {
    assert.equal(conversationColumns.has(column), true, `missing ${column}`);
  }
  assert.equal(listColumnNames(db, 'chat_cross_conversation_deliveries').has('dispatch_status'), true);
  assert.equal(listColumnNames(db, 'chat_cross_conversation_delivery_events').has('event_type'), true);

  const legacy = db.prepare(`
    SELECT project_scope_id, parent_conversation_id, origin_conversation_id,
           origin_message_id, tree_depth
    FROM chat_conversations
    WHERE id = 'legacy-conversation'
  `).get();
  assert.deepEqual(legacy, {
    project_scope_id: null,
    parent_conversation_id: null,
    origin_conversation_id: null,
    origin_message_id: null,
    tree_depth: 0,
  });
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
});

test('conversation lineage constraints reject missing parents, self-parenting, depth overflow, and parent deletion', () => {
  const db = openMigratedDatabase();
  insertConversation(db, { id: 'root', projectScopeId: 'project-1' });

  assert.throws(
    () => insertConversation(db, {
      id: 'missing-parent-child',
      projectScopeId: 'project-1',
      parentConversationId: 'missing-parent',
      originConversationId: 'missing-parent',
      treeDepth: 1,
    }),
    /FOREIGN KEY constraint failed/
  );
  assert.throws(
    () => insertConversation(db, {
      id: 'self-parent',
      projectScopeId: 'project-1',
      parentConversationId: 'self-parent',
      originConversationId: 'self-parent',
      treeDepth: 1,
    }),
    /CHECK constraint failed/
  );
  assert.throws(
    () => insertConversation(db, {
      id: 'too-deep',
      projectScopeId: 'project-1',
      parentConversationId: 'root',
      originConversationId: 'root',
      treeDepth: 3,
    }),
    /CHECK constraint failed/
  );

  insertConversation(db, {
    id: 'child',
    projectScopeId: 'project-1',
    parentConversationId: 'root',
    originConversationId: 'root',
    treeDepth: 1,
  });
  assert.throws(
    () => db.prepare("DELETE FROM chat_conversations WHERE id = 'root'").run(),
    /FOREIGN KEY constraint failed/
  );
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
});

test('conversation repository exposes stable tree ordering and generic updates cannot mutate lineage', () => {
  const db = openMigratedDatabase();
  const { createChatConversationRepository } = require('../../build/storage/chat/conversation.repository');
  const repository = createChatConversationRepository(db);

  repository.create({
    id: 'root-z',
    title: 'Root Z',
    type: 'standard',
    metadataJson: '{}',
    projectScopeId: 'project-1',
    parentConversationId: null,
    originConversationId: null,
    originMessageId: null,
    treeDepth: 0,
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    lastMessageAt: null,
  });
  repository.create({
    id: 'root-a',
    title: 'Root A',
    type: 'standard',
    metadataJson: '{}',
    projectScopeId: 'project-1',
    parentConversationId: null,
    originConversationId: null,
    originMessageId: null,
    treeDepth: 0,
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    lastMessageAt: null,
  });
  repository.create({
    id: 'root-later',
    title: 'Root Later',
    type: 'standard',
    metadataJson: '{}',
    projectScopeId: 'project-1',
    parentConversationId: null,
    originConversationId: null,
    originMessageId: null,
    treeDepth: 0,
    createdAt: '2026-08-05T00:00:01.000Z',
    updatedAt: '2026-08-05T00:00:01.000Z',
    lastMessageAt: null,
  });

  assert.deepEqual(repository.listTreeHeaders().map((row) => row.id), [
    'root-a',
    'root-z',
    'root-later',
  ]);

  repository.update('root-a', {
    title: 'Updated',
    type: 'standard',
    metadataJson: '{"updated":true}',
    projectScopeId: 'forbidden-project',
    parentConversationId: 'root-z',
    treeDepth: 1,
    updatedAt: '2026-08-05T01:00:00.000Z',
  });
  const updated = repository.get('root-a');
  assert.equal(updated.project_scope_id, 'project-1');
  assert.equal(updated.parent_conversation_id, null);
  assert.equal(updated.tree_depth, 0);
  db.close();
});

test('chat store and conversation summaries project scope/lineage without allowing generic lineage mutation', () => {
  const store = createChatAppStore({ agentDir: process.cwd(), sqlitePath: ':memory:' });

  try {
    const created = store.createConversation({
      id: 'scoped-root',
      title: 'Scoped Root',
      participants: [{ agentId: 'role-family-gpt' }],
    });
    assert.equal(created.projectScopeId, null);
    assert.equal(created.parentConversationId, null);
    assert.equal(created.originConversationId, null);
    assert.equal(created.originMessageId, null);
    assert.equal(created.treeDepth, 0);
    store.db.prepare(`
      UPDATE chat_conversations
      SET project_scope_id = 'project-1'
      WHERE id = 'scoped-root'
    `).run();
    const scoped = store.getConversationWithoutMessages('scoped-root');
    assert.equal(scoped.projectScopeId, 'project-1');
    assert.deepEqual(store.listConversationTree().map((conversation) => conversation.id), ['scoped-root']);

    const updated = store.updateConversation('scoped-root', {
      title: 'Renamed Root',
      projectScopeId: 'forbidden-project',
      parentConversationId: 'forbidden-parent',
      treeDepth: 1,
    });
    assert.equal(updated.title, 'Renamed Root');
    assert.equal(updated.projectScopeId, 'project-1');
    assert.equal(updated.parentConversationId, null);
    assert.equal(updated.treeDepth, 0);
    assert.deepEqual(pickConversationSummary(updated), {
      id: 'scoped-root',
      title: 'Renamed Root',
      type: 'standard',
      metadata: {},
      projectScopeId: 'project-1',
      parentConversationId: null,
      originConversationId: null,
      originMessageId: null,
      treeDepth: 0,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
      lastMessageAt: null,
      messageCount: 0,
      agentCount: 1,
      lastMessagePreview: '',
    });
  } finally {
    store.close();
  }
});

test('conversation tree headers include the latest target delivery state without activity reordering siblings', () => {
  const store = createChatAppStore({ agentDir: process.cwd(), sqlitePath: ':memory:' });
  const db = store.db;
  const deliveries = createCrossConversationDeliveryRepository(db);

  insertConversation(db, {
    id: 'tree-root',
    projectScopeId: 'project-1',
    createdAt: '2026-08-05T00:00:00.000Z',
  });
  insertConversation(db, {
    id: 'tree-child-a',
    projectScopeId: 'project-1',
    parentConversationId: 'tree-root',
    originConversationId: 'tree-root',
    treeDepth: 1,
    createdAt: '2026-08-05T00:01:00.000Z',
    updatedAt: '2026-08-05T12:00:00.000Z',
  });
  insertConversation(db, {
    id: 'tree-child-b',
    projectScopeId: 'project-1',
    parentConversationId: 'tree-root',
    originConversationId: 'tree-root',
    treeDepth: 1,
    createdAt: '2026-08-05T00:02:00.000Z',
  });

  deliveries.create(createDeliveryPayload({
    id: 'tree-delivery-old',
    rootDeliveryId: 'tree-delivery-old',
    traceId: 'trace-tree-old',
    kind: 'bootstrap',
    idempotencyScope: 'operator:tree-root:conversation_spawn',
    idempotencyKey: 'tree-old',
    principalKind: 'operator',
    sourceConversationId: 'tree-root',
    sourceTurnId: null,
    sourceInvocationId: null,
    sourceAgentId: null,
    sourceAgentName: 'Operator',
    targetConversationId: 'tree-child-a',
    targetAgentId: 'role-family-gpt',
    responseStatus: 'not_expected',
    createdAt: '2026-08-05T00:01:00.000Z',
    updatedAt: '2026-08-05T00:01:00.000Z',
  }));
  deliveries.create(createDeliveryPayload({
    id: 'tree-delivery-latest',
    rootDeliveryId: 'tree-delivery-latest',
    traceId: 'trace-tree-latest',
    kind: 'notify',
    idempotencyScope: 'agent:tree:conversation_notify',
    idempotencyKey: 'tree-latest',
    sourceConversationId: 'tree-root',
    targetConversationId: 'tree-child-a',
    dispatchStatus: 'running',
    responseStatus: 'not_expected',
    startedAt: '2026-08-05T00:03:00.000Z',
    targetInvocationId: 'invocation-tree',
    createdAt: '2026-08-05T00:03:00.000Z',
    updatedAt: '2026-08-05T00:03:00.000Z',
  }));

  const tree = store.listConversationTree();
  assert.deepEqual(tree.map((conversation) => conversation.id), [
    'tree-root',
    'tree-child-a',
    'tree-child-b',
  ]);
  assert.equal(tree[1].crossConversationStatus.id, 'tree-delivery-latest');
  assert.equal(tree[1].crossConversationStatus.dispatchStatus, 'running');
  assert.equal(tree[2].crossConversationStatus, null);

  store.close();
});

test('delivery repository enforces idempotency/projection uniqueness and supports one atomic claim winner', () => {
  const db = openMigratedDatabase();
  seedDeliveryConversations(db);
  const repository = createCrossConversationDeliveryRepository(db);

  const created = repository.create(createDeliveryPayload());
  assert.equal(created.id, 'delivery-1');
  assert.equal(created.message_status, 'pending');
  assert.throws(
    () => db.prepare("DELETE FROM chat_conversations WHERE id = 'conversation-target'").run(),
    /FOREIGN KEY constraint failed/
  );
  assert.equal(
    repository.getByIdempotency('agent:invocation-1:conversation_request', 'request-1').id,
    'delivery-1'
  );

  assert.throws(
    () => repository.create(createDeliveryPayload({ id: 'delivery-duplicate-key' })),
    /UNIQUE constraint failed/
  );
  assert.throws(
    () => repository.create(createDeliveryPayload({
      id: 'delivery-cross-project',
      idempotencyKey: 'request-cross-project',
      traceId: 'trace-cross-project',
      rootDeliveryId: 'delivery-cross-project',
      targetProjectScopeId: 'project-2',
    })),
    /CHECK constraint failed/
  );

  insertMessage(db, {
    id: 'target-message-1',
    conversationId: 'conversation-target',
    role: 'external_agent',
    agentId: 'role-family-gpt',
    senderName: 'GPT',
    content: 'Please inspect this.',
  });
  insertMessage(db, {
    id: 'source-receipt-1',
    conversationId: 'conversation-source',
    content: '',
  });
  assert.equal(repository.markMessagesPersisted('delivery-1', {
    targetMessageId: 'source-receipt-1',
    sourceReceiptMessageId: 'target-message-1',
    deliveredAt: '2026-08-05T00:00:01.000Z',
    updatedAt: '2026-08-05T00:00:01.000Z',
  }), null);
  const persisted = repository.markMessagesPersisted('delivery-1', {
    targetMessageId: 'target-message-1',
    sourceReceiptMessageId: 'source-receipt-1',
    deliveredAt: '2026-08-05T00:00:02.000Z',
    updatedAt: '2026-08-05T00:00:02.000Z',
  });
  assert.equal(persisted.message_status, 'persisted');
  assert.equal(
    repository.markMessagesPersisted('delivery-1', {
      targetMessageId: 'target-message-1',
      sourceReceiptMessageId: 'source-receipt-1',
      deliveredAt: '2026-08-05T00:00:03.000Z',
      updatedAt: '2026-08-05T00:00:03.000Z',
    }),
    null
  );

  const claim = repository.claimNext({
    owner: 'worker-a',
    now: '2026-08-05T00:00:03.000Z',
    claimExpiresAt: '2026-08-05T00:01:03.000Z',
  });
  assert.equal(claim.id, 'delivery-1');
  assert.equal(claim.claim_owner, 'worker-a');
  assert.equal(claim.attempt_count, 1);
  assert.equal(repository.claimNext({
    owner: 'worker-b',
    now: '2026-08-05T00:00:03.000Z',
    claimExpiresAt: '2026-08-05T00:01:03.000Z',
  }), null);

  db.close();
});

test('delivery dispatch transitions are guarded and delivery events are database-enforced append-only', () => {
  const db = openMigratedDatabase();
  seedDeliveryConversations(db);
  const repository = createCrossConversationDeliveryRepository(db);
  repository.create(createDeliveryPayload());
  insertMessage(db, {
    id: 'target-message-1',
    conversationId: 'conversation-target',
    role: 'external_agent',
    agentId: 'role-family-gpt',
    senderName: 'GPT',
    content: 'Please inspect this.',
  });
  insertMessage(db, {
    id: 'source-receipt-1',
    conversationId: 'conversation-source',
    content: '',
  });
  repository.markMessagesPersisted('delivery-1', {
    targetMessageId: 'target-message-1',
    sourceReceiptMessageId: 'source-receipt-1',
    deliveredAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
  });
  repository.claimNext({
    owner: 'worker-a',
    now: '2026-08-05T00:00:00.000Z',
    claimExpiresAt: '2026-08-05T00:01:00.000Z',
  });

  const running = repository.markDispatchStarted('delivery-1', {
    claimOwner: 'worker-a',
    targetInvocationId: 'target-invocation-1',
    startedAt: '2026-08-05T00:00:05.000Z',
    updatedAt: '2026-08-05T00:00:05.000Z',
  });
  assert.equal(running.dispatch_status, 'running');
  assert.equal(running.target_invocation_id, 'target-invocation-1');
  assert.equal(repository.markDispatchStarted('delivery-1', {
    claimOwner: 'worker-a',
    targetInvocationId: 'target-invocation-2',
    startedAt: '2026-08-05T00:00:06.000Z',
    updatedAt: '2026-08-05T00:00:06.000Z',
  }), null);

  const completed = repository.markDispatchCompleted('delivery-1', {
    claimOwner: 'worker-a',
    completedAt: '2026-08-05T00:00:10.000Z',
    terminalAt: '2026-08-05T00:00:10.000Z',
    updatedAt: '2026-08-05T00:00:10.000Z',
  });
  assert.equal(completed.dispatch_status, 'completed');
  assert.equal(completed.claim_owner, null);
  assert.equal(repository.markDispatchCompleted('delivery-1', {
    claimOwner: 'worker-a',
    completedAt: '2026-08-05T00:00:11.000Z',
    terminalAt: '2026-08-05T00:00:11.000Z',
    updatedAt: '2026-08-05T00:00:11.000Z',
  }), null);

  const event = repository.appendEvent({
    deliveryId: 'delivery-1',
    eventType: 'dispatch_completed',
    attemptNumber: 1,
    actorKind: 'worker',
    actorId: 'worker-a',
    eventJson: '{"result":"ok"}',
    createdAt: '2026-08-05T00:00:10.000Z',
  });
  assert.equal(event.event_type, 'dispatch_completed');
  assert.equal(repository.listEvents('delivery-1').length, 1);
  assert.throws(
    () => db.prepare(`
      UPDATE chat_cross_conversation_delivery_events
      SET event_type = 'tampered'
      WHERE id = ?
    `).run(event.id),
    /append-only/
  );
  assert.throws(
    () => db.prepare('DELETE FROM chat_cross_conversation_delivery_events WHERE id = ?').run(event.id),
    /append-only/
  );

  db.close();
});

test('chat store persists one canonical child spawn transaction with lineage and bootstrap projections', () => {
  const store = createChatAppStore({ agentDir: process.cwd(), sqlitePath: ':memory:' });
  try {
    const sourceAgent = store.saveCustomRoleConfig({
      id: 'spawn-storage-source-agent',
      name: 'Spawn Storage Source',
      personaPrompt: 'Source only.',
    });
    const primaryAgent = store.saveCustomRoleConfig({
      id: 'spawn-storage-primary-agent',
      name: 'Spawn Storage Primary',
      personaPrompt: 'Primary only.',
    });
    const source = store.createConversation({
      id: 'spawn-storage-source',
      title: 'Spawn Storage Source',
      participants: [sourceAgent.id],
    });
    store.db.prepare('UPDATE chat_conversations SET project_scope_id = ? WHERE id = ?')
      .run('project-1', source.id);
    const sourceMessage = store.createMessage({
      id: 'spawn-storage-source-message',
      conversationId: source.id,
      turnId: 'spawn-storage-source-turn',
      role: 'assistant',
      agentId: sourceAgent.id,
      senderName: sourceAgent.name,
      content: 'Spawn a child.',
    });
    const createdAt = '2026-08-05T08:00:00.000Z';
    const payload = {
      conversation: {
        id: 'spawn-storage-child',
        title: 'Spawn Storage Child',
        type: 'standard',
        metadata: {},
        projectScopeId: 'project-1',
        parentConversationId: source.id,
        originConversationId: source.id,
        originMessageId: sourceMessage.id,
        treeDepth: 1,
        participants: [{ agentId: primaryAgent.id, conversationSkills: ['child-skill'] }],
        createdAt,
      },
      delivery: createDeliveryPayload({
        id: 'spawn-storage-delivery',
        kind: 'bootstrap',
        idempotencyScope: `operator:${source.id}:conversation_spawn`,
        idempotencyKey: 'spawn-storage-request',
        principalKind: 'operator',
        sourceConversationId: source.id,
        sourceMessageId: sourceMessage.id,
        sourceTurnId: null,
        sourceInvocationId: null,
        sourceAgentId: null,
        sourceAgentName: 'Operator',
        sourceProjectScopeId: 'project-1',
        targetConversationId: 'spawn-storage-child',
        targetAgentId: primaryAgent.id,
        targetMessageId: null,
        sourceReceiptMessageId: null,
        targetProjectScopeId: 'project-1',
        traceId: 'spawn-storage-trace',
        rootDeliveryId: 'spawn-storage-delivery',
        responseStatus: 'not_expected',
        deadlineAt: null,
        createdAt,
        updatedAt: createdAt,
        nextAttemptAt: createdAt,
      }),
      initialMessage: {
        id: 'spawn-storage-initial-message',
        conversationId: 'spawn-storage-child',
        turnId: 'conversation-spawn:spawn-storage-delivery',
        role: 'user',
        agentId: null,
        senderName: 'You',
        content: 'Complete public initial message.',
        status: 'completed',
        taskId: null,
        runId: null,
        errorMessage: null,
        metadata: { kind: 'conversation_spawn_initial_message' },
        createdAt,
      },
      sourceReceipt: {
        id: 'spawn-storage-source-receipt',
        conversationId: source.id,
        turnId: 'conversation-spawn:spawn-storage-delivery',
        role: 'system',
        agentId: null,
        senderName: 'System',
        content: '',
        status: 'completed',
        taskId: null,
        runId: null,
        errorMessage: null,
        metadata: { kind: 'cross_conversation_receipt' },
        createdAt,
      },
      persistedEvent: {
        kind: 'bootstrap',
        initialMessageLength: 32,
      },
      deliveredAt: createdAt,
    };

    const first = store.persistConversationSpawn(payload);
    const duplicate = store.persistConversationSpawn(payload);

    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.conversation.id, first.conversation.id);
    assert.equal(duplicate.delivery.id, first.delivery.id);
    assert.equal(first.conversation.parentConversationId, source.id);
    assert.equal(first.conversation.originConversationId, source.id);
    assert.equal(first.conversation.originMessageId, sourceMessage.id);
    assert.equal(first.conversation.treeDepth, 1);
    assert.equal(first.initialMessage.role, 'user');
    assert.equal(first.delivery.kind, 'bootstrap');
    assert.equal(first.delivery.messageStatus, 'persisted');
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS count FROM chat_cross_conversation_deliveries').get().count,
      1
    );
  } finally {
    store.close();
  }
});
