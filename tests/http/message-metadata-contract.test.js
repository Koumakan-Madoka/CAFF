const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createConversationsController } = require('../../build/server/api/conversations-controller');
const { withTempDir } = require('../helpers/temp-dir');

function createSnapshot(conversationId, messageId, marker) {
  const displayContent = `${marker} display content ${'x'.repeat(2048)}`;
  const displayContentHash = crypto.createHash('sha256').update(displayContent, 'utf8').digest('hex');
  return {
    schemaVersion: 1,
    snapshotId: `snapshot-${marker}`,
    capturedAt: '2026-08-25T08:00:00.000Z',
    conversationId,
    turnId: `turn-${messageId}`,
    messageId,
    agentId: 'role-family-gpt',
    agentName: 'GPT',
    promptVersion: 'contract-http-test',
    immutable: true,
    totalApproxTokens: 512,
    totalByteSize: Buffer.byteLength(displayContent, 'utf8'),
    sections: [{
      sectionKey: 'conversation_history',
      title: 'Conversation History',
      source: 'conversation/messages',
      visibility: 'full',
      contentHash: displayContentHash,
      displayContentHash,
      approxTokens: 512,
      byteSize: Buffer.byteLength(displayContent, 'utf8'),
      truncated: false,
      truncationNote: '',
      redacted: false,
      policyNote: '',
      contentPreview: displayContent.slice(0, 180),
      displayContent,
    }],
  };
}

function createUsage(marker) {
  return {
    modelCallCount: 2,
    coldStartModelCallCount: 1,
    postColdModelCallCount: 1,
    providerMissCount: 1,
    calls: [1, 2].map((sequence) => ({
      sequence,
      responseId: `${marker}-response-${sequence}`,
      coldStart: sequence === 1,
      isColdStart: sequence === 1,
      providerMiss: sequence === 2,
      tokenUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    })),
  };
}

function snapshotReference(snapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    snapshotId: snapshot.snapshotId,
    capturedAt: snapshot.capturedAt,
    conversationId: snapshot.conversationId,
    turnId: snapshot.turnId,
    messageId: snapshot.messageId,
    agentId: snapshot.agentId,
    agentName: snapshot.agentName,
    promptVersion: snapshot.promptVersion,
    immutable: true,
    totalApproxTokens: snapshot.totalApproxTokens,
    totalByteSize: snapshot.totalByteSize,
    sectionCount: snapshot.sections.length,
  };
}

function usageSummary(usage) {
  return {
    modelCallCount: usage.modelCallCount,
    coldStartModelCallCount: usage.coldStartModelCallCount,
    postColdModelCallCount: usage.postColdModelCallCount,
    providerMissCount: usage.providerMissCount,
    callsTruncated: false,
    retainedCallCount: 2,
    droppedCallCount: 0,
  };
}

function rawInsertAssistant(store, input) {
  store.db.prepare(`
    INSERT INTO chat_messages (
      id, conversation_id, turn_id, role, agent_id, sender_name,
      content, status, task_id, run_id, error_message, metadata_json,
      client_request_id, created_at
    ) VALUES (?, ?, ?, 'assistant', 'role-family-gpt', 'GPT', ?, 'completed', NULL, NULL, NULL, ?, NULL, ?)
  `).run(
    input.id,
    input.conversationId,
    `turn-${input.id}`,
    input.content,
    JSON.stringify(input.metadata),
    input.createdAt
  );
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
  const contentType = String(state.headers['Content-Type'] || state.headers['content-type'] || '');
  return {
    handled,
    statusCode: state.statusCode,
    body: state.body,
    json: contentType.includes('application/json') && state.body ? JSON.parse(state.body) : null,
  };
}

test('message pagination projects legacy, Expand, and Contract metadata without sending detail bodies', async (t) => {
  const tempDir = withTempDir('caff-message-metadata-http-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'chat.sqlite') });
  const conversation = store.createConversation({
    id: 'message-metadata-http',
    title: 'Message Metadata HTTP',
    type: 'standard',
    projectScopeId: 'project-1',
    participants: ['role-family-gpt'],
  });

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const legacySnapshot = createSnapshot(conversation.id, 'legacy-message', 'legacy-secret');
  const legacyUsage = createUsage('legacy-secret');
  rawInsertAssistant(store, {
    id: 'legacy-message',
    conversationId: conversation.id,
    content: 'legacy',
    createdAt: '2026-08-25T08:00:01.000Z',
    metadata: {
      agentContextSnapshot: legacySnapshot,
      modelUsage: legacyUsage,
      tokenUsage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 },
      crossConversation: { deliveryId: 'delivery-legacy' },
      goalAutoContinue: true,
      privateOnly: false,
      contentBlocks: [{ type: 'text', text: 'legacy' }],
    },
  });

  const expandSnapshot = createSnapshot(conversation.id, 'expand-message', 'expand-secret');
  const expandUsage = createUsage('expand-secret');
  store.createMessage({
    id: 'expand-message',
    conversationId: conversation.id,
    turnId: 'turn-expand-message',
    role: 'assistant',
    agentId: 'role-family-gpt',
    senderName: 'GPT',
    content: 'expand',
    status: 'completed',
    metadata: {
      agentContextSnapshot: expandSnapshot,
      modelUsage: expandUsage,
      tokenUsage: { inputTokens: 30, outputTokens: 3, totalTokens: 33 },
      digestStatus: 'completed',
    },
    createdAt: '2026-08-25T08:00:02.000Z',
  });

  const contractSnapshot = createSnapshot(conversation.id, 'contract-message', 'contract-secret');
  const contractUsage = createUsage('contract-secret');
  store.createMessage({
    id: 'contract-message',
    conversationId: conversation.id,
    turnId: 'turn-contract-message',
    role: 'assistant',
    agentId: 'role-family-gpt',
    senderName: 'GPT',
    content: 'contract',
    status: 'completed',
    metadata: { agentContextSnapshot: contractSnapshot, modelUsage: contractUsage },
    createdAt: '2026-08-25T08:00:03.000Z',
  });
  store.db.prepare('UPDATE chat_messages SET metadata_json = ? WHERE id = ?').run(JSON.stringify({
    agentContextSnapshot: snapshotReference(contractSnapshot),
    modelUsage: usageSummary(contractUsage),
    tokenUsage: { inputTokens: 40, outputTokens: 4, totalTokens: 44 },
  }), 'contract-message');

  const handler = createConversationsController({
    store,
    turnOrchestrator: {
      buildRuntimePayload() { return {}; },
      clearConversationState() {},
    },
    buildBootstrapPayload() { return {}; },
  });

  const page = await invoke(handler, `/api/conversations/${conversation.id}/messages?limit=50`);
  assert.equal(page.handled, true);
  assert.equal(page.statusCode, 200);
  assert.equal(page.json.items.length, 3);
  assert.equal(page.body.includes('displayContent'), false);
  assert.equal(page.body.includes('legacy-secret display content'), false);
  assert.equal(page.body.includes('expand-secret display content'), false);
  assert.equal(page.body.includes('"calls"'), false);
  assert.equal(page.body.includes('legacy-secret-response-1'), false);
  assert.equal(page.body.includes('expand-secret-response-1'), false);

  const byId = new Map(page.json.items.map((message) => [message.id, message]));
  assert.deepEqual(byId.get('legacy-message').metadata.agentContextSnapshot, snapshotReference(legacySnapshot));
  assert.deepEqual(byId.get('legacy-message').metadata.modelUsage, usageSummary(legacyUsage));
  assert.equal(byId.get('legacy-message').metadata.crossConversation.deliveryId, 'delivery-legacy');
  assert.equal(byId.get('legacy-message').metadata.goalAutoContinue, true);
  assert.equal(byId.get('legacy-message').metadata.contentBlocks[0].type, 'text');
  assert.deepEqual(byId.get('expand-message').metadata.agentContextSnapshot, snapshotReference(expandSnapshot));
  assert.deepEqual(byId.get('expand-message').metadata.modelUsage, usageSummary(expandUsage));
  assert.deepEqual(byId.get('contract-message').metadata.agentContextSnapshot, snapshotReference(contractSnapshot));

  const legacyDetail = await invoke(
    handler,
    `/api/conversations/${conversation.id}/messages/legacy-message/context-snapshot`
  );
  assert.equal(legacyDetail.statusCode, 200);
  assert.equal(legacyDetail.json.snapshot.sections[0].displayContent, legacySnapshot.sections[0].displayContent);

  const expandDetail = await invoke(
    handler,
    `/api/conversations/${conversation.id}/messages/expand-message/context-snapshot`
  );
  assert.equal(expandDetail.statusCode, 200);
  assert.equal(expandDetail.json.snapshot.sections[0].displayContent, expandSnapshot.sections[0].displayContent);

  const contractDetail = await invoke(
    handler,
    `/api/conversations/${conversation.id}/messages/contract-message/context-snapshot`
  );
  assert.equal(contractDetail.statusCode, 200);
  assert.equal(contractDetail.json.snapshot.sections[0].displayContent, contractSnapshot.sections[0].displayContent);

  const contractExport = await invoke(
    handler,
    `/api/conversations/${conversation.id}/messages/contract-message/context-snapshot-export`
  );
  assert.equal(contractExport.statusCode, 200);
  assert.match(contractExport.body, /contract-secret display content/u);
  assert.match(contractExport.body, /Conversation History/u);
});
