const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createConversationsController } = require('../../build/server/api/conversations-controller');
const { withTempDir } = require('../helpers/temp-dir');

function createSnapshot(conversationId, messageId, marker = messageId) {
  return {
    schemaVersion: 1,
    snapshotId: `snapshot-${marker}`,
    capturedAt: '2026-08-25T00:00:00.000Z',
    conversationId,
    turnId: `turn-${messageId}`,
    messageId,
    agentId: 'role-family-gpt',
    agentName: 'GPT',
    promptVersion: 'test',
    immutable: true,
    totalApproxTokens: 1,
    totalByteSize: marker.length,
    sections: [{
      sectionKey: 'conversation_history',
      title: 'History',
      source: 'conversation/messages',
      visibility: 'full',
      contentHash: `content-${marker}`,
      displayContentHash: `display-${marker}`,
      approxTokens: 1,
      byteSize: marker.length,
      truncated: false,
      truncationNote: '',
      redacted: false,
      policyNote: '',
      contentPreview: marker,
      displayContent: marker,
    }],
  };
}

function rawInsertLegacyMessage(store, conversationId, id, createdAt, snapshot) {
  store.db.prepare(`
    INSERT INTO chat_messages (
      id, conversation_id, turn_id, role, agent_id, sender_name,
      content, status, task_id, run_id, error_message, metadata_json,
      client_request_id, created_at
    ) VALUES (?, ?, ?, 'assistant', 'role-family-gpt', 'GPT', ?, 'completed', NULL, NULL, NULL, ?, NULL, ?)
  `).run(id, conversationId, `turn-${id}`, id, JSON.stringify({ agentContextSnapshot: snapshot }), createdAt);
}

async function invoke(handler, pathname) {
  const requestUrl = new URL(pathname, 'http://127.0.0.1');
  const req = new PassThrough();
  req.method = 'GET';
  req.url = `${requestUrl.pathname}${requestUrl.search}`;
  req.headers = {};
  const state = { statusCode: 0, headers: {}, body: '' };
  const res = {
    writeHead(statusCode, headers) {
      state.statusCode = statusCode;
      state.headers = headers;
    },
    end(chunk = '') {
      state.body = String(chunk || '');
    },
  };

  const handledPromise = handler({ req, res, pathname: requestUrl.pathname, requestUrl });
  req.end();
  const handled = await handledPromise;
  const isJson = String(state.headers['Content-Type'] || state.headers['content-type'] || '').includes('application/json');
  return {
    handled,
    statusCode: state.statusCode,
    headers: state.headers,
    body: state.body,
    json: isJson && state.body ? JSON.parse(state.body) : {},
  };
}

test('context snapshot list uses bounded stable cursor pages across mixed old and new rows without full hydration', async (t) => {
  const tempDir = withTempDir('caff-context-snapshot-page-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const conversation = store.createConversation({
    id: 'context-page-conversation',
    title: 'Context Snapshot Pagination',
    type: 'standard',
    projectScopeId: 'project-1',
    participants: ['role-family-gpt'],
  });
  const otherConversation = store.createConversation({
    id: 'context-page-other',
    title: 'Other Context Snapshot Pagination',
    type: 'standard',
    projectScopeId: 'project-1',
    participants: ['role-family-gpt'],
  });

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  for (let index = 0; index < 55; index += 1) {
    const suffix = String(index).padStart(3, '0');
    const id = `snapshot-message-${suffix}`;
    const createdAt = index < 3
      ? '2026-08-25T01:00:00.000Z'
      : `2026-08-25T01:${String(index).padStart(2, '0')}:00.000Z`;
    const snapshot = createSnapshot(conversation.id, id, `source-${suffix}`);

    if (index % 2 === 0) {
      rawInsertLegacyMessage(store, conversation.id, id, createdAt, snapshot);
    } else {
      store.createMessage({
        id,
        conversationId: conversation.id,
        turnId: `turn-${id}`,
        role: 'assistant',
        agentId: 'role-family-gpt',
        senderName: 'GPT',
        content: id,
        status: 'completed',
        metadata: { agentContextSnapshot: snapshot },
        createdAt,
      });
    }
  }

  store.db.prepare(`
    INSERT INTO chat_messages (
      id, conversation_id, turn_id, role, agent_id, sender_name,
      content, status, metadata_json, created_at
    ) VALUES (?, ?, ?, 'assistant', 'role-family-gpt', 'GPT', ?, 'completed', ?, ?)
  `).run(
    'invalid-metadata-message',
    conversation.id,
    'turn-invalid-metadata-message',
    'invalid metadata',
    '{not-json',
    '2026-08-24T00:00:00.000Z'
  );
  rawInsertLegacyMessage(store, conversation.id, 'string-snapshot-message', '2026-08-24T00:00:01.000Z', 'not-an-object');
  rawInsertLegacyMessage(store, conversation.id, 'null-snapshot-message', '2026-08-24T00:00:02.000Z', null);

  const newestId = 'snapshot-message-054';
  const tableOnlyId = 'snapshot-message-053';
  store.db.prepare('UPDATE chat_messages SET metadata_json = ? WHERE id = ?').run('{}', tableOnlyId);
  const resumedSnapshot = {
    ...createSnapshot(conversation.id, newestId, 'source-054'),
    deliveryMode: 'resume',
    retainedSessionPrefix: {
      sessionName: 'chat-retained-session',
      staticSegmentHash: 'static-hash',
      cursorMessageId: 'assistant-first',
      cursorMessageCount: 3,
      cursorFirstMessageId: 'user-first',
      cursorMaxUpdatedAt: '2026-09-02T17:07:12.000Z',
      lastReplyAt: '2026-09-02T17:07:12.000Z',
    },
  };
  store.db.prepare('UPDATE chat_messages SET metadata_json = ? WHERE id = ?').run(JSON.stringify({
    agentContextSnapshot: resumedSnapshot,
    tokenUsage: {
      inputTokens: 56815,
      uncachedInputTokens: 2234,
      cacheReadTokens: 54581,
      cacheWriteTokens: 0,
    },
    modelUsage: { modelCallCount: 4 },
  }), newestId);

  const handler = createConversationsController({
    store,
    turnOrchestrator: {
      buildRuntimePayload() { return {}; },
      clearConversationState() {},
    },
    buildBootstrapPayload() { return {}; },
  });

  store.getConversation = () => {
    throw new Error('context snapshot list must not hydrate a conversation');
  };
  store.listMessages = () => {
    throw new Error('context snapshot list must not list unbounded messages');
  };

  const first = await invoke(handler, `/api/conversations/${conversation.id}/context-snapshots`);
  assert.equal(first.handled, true);
  assert.equal(first.statusCode, 200);
  assert.equal(first.json.conversationId, conversation.id);
  assert.equal(first.json.snapshots.length, 50);
  assert.equal(first.json.snapshots[0].messageId, newestId);
  assert.equal(first.json.snapshots[0].snapshotId, 'snapshot-source-054');
  assert.equal(first.json.snapshots[1].messageId, tableOnlyId);
  assert.equal(first.json.snapshots[1].snapshotId, 'snapshot-source-053');
  assert.equal(first.json.snapshots[49].messageId, 'snapshot-message-005');
  assert.deepEqual(Object.keys(first.json.pageInfo).sort(), ['hasMore', 'nextCursor']);
  assert.equal(first.json.pageInfo.hasMore, true);
  assert.equal(typeof first.json.pageInfo.nextCursor, 'string');

  const second = await invoke(
    handler,
    `/api/conversations/${conversation.id}/context-snapshots?before=${encodeURIComponent(first.json.pageInfo.nextCursor)}`
  );
  assert.deepEqual(second.json.snapshots.map((snapshot) => snapshot.messageId), [
    'snapshot-message-004',
    'snapshot-message-003',
    'snapshot-message-002',
    'snapshot-message-001',
    'snapshot-message-000',
  ]);
  assert.deepEqual(second.json.pageInfo, { hasMore: false, nextCursor: null });

  const tableOnlyDetail = await invoke(
    handler,
    `/api/conversations/${conversation.id}/messages/${tableOnlyId}/context-snapshot`
  );
  assert.equal(tableOnlyDetail.statusCode, 200);
  assert.equal(tableOnlyDetail.json.snapshot.snapshotId, 'snapshot-source-053');
  assert.equal(tableOnlyDetail.json.snapshot.messageId, tableOnlyId);

  const resumedDetail = await invoke(
    handler,
    `/api/conversations/${conversation.id}/messages/${newestId}/context-snapshot`
  );
  assert.equal(resumedDetail.statusCode, 200);
  assert.equal(resumedDetail.json.snapshot.deliveryMode, 'resume');
  assert.equal(resumedDetail.json.snapshot.retainedSessionPrefix.sessionName, 'chat-retained-session');
  assert.deepEqual(resumedDetail.json.runEvidence, {
    inputTokens: 56815,
    uncachedInputTokens: 2234,
    cacheReadTokens: 54581,
    cacheWriteTokens: 0,
    modelCallCount: 4,
  });

  const tableOnlyExport = await invoke(
    handler,
    `/api/conversations/${conversation.id}/messages/${tableOnlyId}/context-snapshot-export`
  );
  assert.equal(tableOnlyExport.statusCode, 200);
  assert.match(tableOnlyExport.headers['Content-Disposition'], /agent-context-GPT-turn-snapshot-message-053\.md/u);
  assert.match(tableOnlyExport.body, /source-053/u);

  const maximum = await invoke(handler, `/api/conversations/${conversation.id}/context-snapshots?limit=100`);
  assert.equal(maximum.json.snapshots.length, 55);
  assert.deepEqual(maximum.json.pageInfo, { hasMore: false, nextCursor: null });

  const one = await invoke(handler, `/api/conversations/${conversation.id}/context-snapshots?limit=1`);
  assert.deepEqual(one.json.snapshots.map((snapshot) => snapshot.messageId), [newestId]);
  assert.equal(one.json.pageInfo.hasMore, true);

  const empty = await invoke(handler, `/api/conversations/${otherConversation.id}/context-snapshots`);
  assert.deepEqual(empty.json, {
    conversationId: otherConversation.id,
    snapshots: [],
    pageInfo: { hasMore: false, nextCursor: null },
  });

  await assert.rejects(
    () => invoke(handler, '/api/conversations/missing-context-page/context-snapshots'),
    (error) => error && error.statusCode === 404
  );
  await assert.rejects(
    () => invoke(handler, `/api/conversations/${otherConversation.id}/context-snapshots?before=${encodeURIComponent(first.json.pageInfo.nextCursor)}`),
    (error) => error && error.statusCode === 400 && /cursor/iu.test(error.message)
  );
  await assert.rejects(
    () => invoke(handler, `/api/conversations/${conversation.id}/context-snapshots?before=not-a-cursor`),
    (error) => error && error.statusCode === 400 && /cursor/iu.test(error.message)
  );
  const invalidTimestampCursor = Buffer.from(JSON.stringify({
    v: 1,
    conversationId: conversation.id,
    createdAt: 'not-a-timestamp',
    id: newestId,
  })).toString('base64url');
  await assert.rejects(
    () => invoke(handler, `/api/conversations/${conversation.id}/context-snapshots?before=${invalidTimestampCursor}`),
    (error) => error && error.statusCode === 400 && /cursor/iu.test(error.message)
  );

  for (const invalidLimit of ['0', '1.5', '101', 'abc']) {
    await assert.rejects(
      () => invoke(handler, `/api/conversations/${conversation.id}/context-snapshots?limit=${invalidLimit}`),
      (error) => error && error.statusCode === 400 && /limit/iu.test(error.message)
    );
  }
});
