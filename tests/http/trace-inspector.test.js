const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createSqliteRunStore } = require('../../build/lib/sqlite-store');
const { createConversationsController } = require('../../build/server/api/conversations-controller');
const { withTempDir } = require('../helpers/temp-dir');

function snapshot(conversationId, messageId, options = {}) {
  const deliveryMode = options.deliveryMode || 'fresh';
  return {
    schemaVersion: options.schemaVersion || 2,
    snapshotId: `snapshot-${messageId}`,
    capturedAt: options.capturedAt || '2026-09-03T01:00:00.000Z',
    conversationId,
    turnId: `turn-${messageId}`,
    messageId,
    agentId: 'role-family-gpt',
    agentName: 'GPT',
    promptVersion: 'trace-test',
    deliveryMode,
    retainedSessionPrefix: deliveryMode === 'resume'
      ? {
          sessionName: options.parentSessionName || `session-${options.parentMessageId}`,
          staticSegmentHash: `hash-${options.parentMessageId}`,
          cursorMessageId: options.parentMessageId,
          cursorMessageCount: options.cursorMessageCount || 2,
          cursorFirstMessageId: options.cursorFirstMessageId || 'trigger-root',
          cursorMaxUpdatedAt: options.capturedAt || '2026-09-03T01:00:00.000Z',
          lastReplyAt: options.capturedAt || '2026-09-03T01:00:00.000Z',
        }
      : null,
    immutable: true,
    totalApproxTokens: 4,
    totalByteSize: 16,
    sections: [{
      sectionKey: deliveryMode === 'resume' ? 'session_delta' : 'conversation_history',
      title: deliveryMode === 'resume' ? 'Session Resume Delta' : 'History',
      source: deliveryMode === 'resume' ? 'session/resume-delta' : 'conversation/messages',
      visibility: 'full',
      contentHash: `content-${messageId}`,
      displayContentHash: '',
      approxTokens: 4,
      byteSize: 16,
      truncated: false,
      truncationNote: '',
      redacted: false,
      policyNote: '',
      contentPreview: `safe-${messageId}`,
      displayContent: `safe-${messageId}`,
    }],
  };
}

function createAssistant(store, conversationId, messageId, options = {}) {
  const detail = snapshot(conversationId, messageId, options);
  return store.createMessage({
    id: messageId,
    conversationId,
    turnId: detail.turnId,
    role: 'assistant',
    agentId: 'role-family-gpt',
    senderName: 'GPT',
    content: options.content || `PRIVATE-PROMPT-${messageId}`,
    status: options.status || 'completed',
    taskId: options.taskId || null,
    errorMessage: options.errorMessage || '',
    metadata: {
      sessionName: options.sessionName || `session-${messageId}`,
      sessionReused: detail.deliveryMode === 'resume',
      sessionReuseReason: detail.deliveryMode === 'resume' ? 'reused' : options.sessionReuseReason || 'no_prior_session',
      privateOnly: options.privateOnly === true,
      triggeredByMessageId: options.triggeredByMessageId || 'trigger-root',
      triggerType: options.triggerType || 'user',
      tokenUsage: options.tokenUsage || {
        inputTokens: 20,
        uncachedInputTokens: 5,
        outputTokens: 7,
        cacheReadTokens: detail.deliveryMode === 'resume' ? 15 : 0,
        cacheWriteTokens: 0,
        totalTokens: 27,
      },
      modelUsage: options.modelUsage || {
        modelCallCount: 1,
        coldStartModelCallCount: 1,
        postColdModelCallCount: 0,
        providerMissCount: 0,
      },
      agentContextSnapshot: detail,
    },
    contextSnapshot: detail,
    createdAt: options.createdAt || detail.capturedAt,
  });
}

async function invoke(handler, pathname) {
  const requestUrl = new URL(pathname, 'http://127.0.0.1');
  const req = new PassThrough();
  req.method = 'GET';
  req.url = `${requestUrl.pathname}${requestUrl.search}`;
  req.headers = {};
  const response = { statusCode: 0, headers: {}, body: '' };
  const res = {
    writeHead(statusCode, headers) {
      response.statusCode = statusCode;
      response.headers = headers;
    },
    end(chunk = '') {
      response.body = String(chunk || '');
    },
  };
  const handledPromise = handler({ req, res, pathname: requestUrl.pathname, requestUrl });
  req.end();
  response.handled = await handledPromise;
  const contentType = String(response.headers['Content-Type'] || response.headers['content-type'] || '');
  response.json = response.body && contentType.includes('application/json') ? JSON.parse(response.body) : {};
  return response;
}

function createFixture(t, name) {
  const tempDir = withTempDir(`caff-trace-inspector-${name}-`);
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const conversation = store.createConversation({
    id: `trace-${name}`,
    title: `Trace ${name}`,
    type: 'standard',
    projectScopeId: 'project-trace',
    participants: ['role-family-gpt'],
  });
  const handler = createConversationsController({
    store,
    turnOrchestrator: {
      buildRuntimePayload() { return {}; },
      clearConversationState() {},
      resolveAssistantMessageSessionPath() { return ''; },
    },
    buildBootstrapPayload() { return {}; },
  });
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { store, conversation, handler, tempDir, sqlitePath };
}

function traceUrl(conversationId, messageId) {
  return `/api/conversations/${conversationId}/messages/${messageId}/trace-inspector`;
}

test('Trace Inspector returns safe current-parent-ancestor lineage and complete bounded phases', async (t) => {
  const { store, conversation, handler } = createFixture(t, 'three-generations');
  createAssistant(store, conversation.id, 'assistant-root', {
    sessionName: 'session-root',
    capturedAt: '2026-09-03T01:00:00.000Z',
  });
  createAssistant(store, conversation.id, 'assistant-parent', {
    deliveryMode: 'resume',
    parentMessageId: 'assistant-root',
    parentSessionName: 'session-root',
    sessionName: 'session-root',
    capturedAt: '2026-09-03T01:01:00.000Z',
  });
  createAssistant(store, conversation.id, 'assistant-current', {
    deliveryMode: 'resume',
    parentMessageId: 'assistant-parent',
    parentSessionName: 'session-root',
    sessionName: 'session-root',
    capturedAt: '2026-09-03T01:02:00.000Z',
  });

  store.listMessages = () => {
    throw new Error('Trace Inspector lineage must use bounded point reads');
  };
  store.getConversation = () => {
    throw new Error('Trace Inspector must not hydrate a full conversation');
  };

  const response = await invoke(handler, traceUrl(conversation.id, 'assistant-current'));
  assert.equal(response.handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.schemaVersion, 1);
  assert.deepEqual(response.json.lineage.nodes.map((node) => [node.relation, node.messageId]), [
    ['current', 'assistant-current'],
    ['parent', 'assistant-parent'],
    ['ancestor', 'assistant-root'],
  ]);
  assert.equal(response.json.lineage.termination.code, 'fresh_root');
  assert.equal(response.json.lineage.maxDepth, 8);
  assert.equal(response.json.session.mode, 'resume');
  assert.equal(response.json.session.label, '复用旧 Session');
  assert.equal(response.json.snapshot.sections[0].sectionKey, 'session_delta');
  assert.deepEqual(
    response.json.trace.events.filter((event) => event.kind === 'lifecycle').map((event) => event.phase),
    ['trigger', 'reuse_decision', 'claim', 'session', 'prompt', 'usage', 'persistence']
  );
  assert.equal(response.json.trace.events.some((event) => event.phase === 'prompt' && /delta/u.test(event.summary)), true);

  const serialized = JSON.stringify(response.json.lineage);
  assert.doesNotMatch(serialized, /PRIVATE-PROMPT/u);
  assert.doesNotMatch(serialized, /displayContent|sections/u);

  const exported = await invoke(handler, `${traceUrl(conversation.id, 'assistant-current')}-export`);
  assert.equal(exported.statusCode, 200);
  assert.match(exported.headers['Content-Disposition'], /trace-inspector-GPT-turn-assistant-current\.md/u);
  assert.match(exported.body, /Trace Timeline/u);
  assert.match(exported.body, /复用旧 Session/u);
  assert.doesNotMatch(exported.body, /PRIVATE-PROMPT/u);
});

test('Trace Inspector projects model, tool, provider cache, and failed persistence evidence', async (t) => {
  const { store, conversation, handler, tempDir, sqlitePath } = createFixture(t, 'mixed-events');
  const runStore = createSqliteRunStore({ agentDir: tempDir, sqlitePath });
  runStore.createTask({
    taskId: 'mixed-task',
    kind: 'conversation_agent_reply',
    status: 'succeeded',
    startedAt: '2026-09-03T01:00:00.000Z',
    endedAt: '2026-09-03T01:00:04.000Z',
  });
  runStore.close();
  const completed = createAssistant(store, conversation.id, 'mixed-completed', {
    taskId: 'mixed-task',
    sessionName: 'mixed-session',
    tokenUsage: {
      inputTokens: 120,
      uncachedInputTokens: 30,
      outputTokens: 20,
      cacheReadTokens: 90,
      cacheWriteTokens: 0,
      totalTokens: 140,
    },
    modelUsage: {
      modelCallCount: 2,
      coldStartModelCallCount: 1,
      postColdModelCallCount: 1,
      providerMissCount: 1,
    },
  });
  const modelUsage = {
    modelCallCount: 2,
    coldStartModelCallCount: 1,
    postColdModelCallCount: 1,
    providerMissCount: 1,
    calls: [
      {
        sequence: 1,
        responseId: 'response-1',
        stopReason: 'toolUse',
        timestamp: Date.parse('2026-09-03T01:00:01.000Z'),
        coldStart: true,
        isColdStart: true,
        providerMiss: false,
        tokenUsage: { inputTokens: 80, uncachedInputTokens: 80, outputTokens: 8, cacheReadTokens: 0, totalTokens: 88 },
      },
      {
        sequence: 2,
        responseId: 'response-2',
        stopReason: 'stop',
        timestamp: Date.parse('2026-09-03T01:00:03.000Z'),
        coldStart: false,
        isColdStart: false,
        providerMiss: true,
        tokenUsage: { inputTokens: 40, uncachedInputTokens: 40, outputTokens: 12, cacheReadTokens: 0, totalTokens: 52 },
      },
    ],
  };
  const observabilityTimeline = {
    totalEventCount: 3,
    modelCallCount: 2,
    coldStartModelCallCount: 1,
    postColdModelCallCount: 1,
    providerMissCount: 1,
    toolExecutionCount: 1,
    failedToolExecutionCount: 0,
    totalToolDurationMs: 250,
    events: [
      { eventId: 'model-call:response-1', eventType: 'model_call', timelineSequence: 1, ...modelUsage.calls[0] },
      {
        eventId: 'tool:session:bash-1',
        eventType: 'tool_execution',
        timelineSequence: 2,
        kind: 'session',
        stepId: 'bash-1',
        toolName: 'bash',
        status: 'succeeded',
        createdAt: '2026-09-03T01:00:02.000Z',
        durationMs: 250,
        requestSummary: 'npm test',
        resultSummary: 'passed',
      },
      { eventId: 'model-call:response-2', eventType: 'model_call', timelineSequence: 3, ...modelUsage.calls[1] },
    ],
  };
  store.updateMessage(completed.id, {
    metadata: completed.metadata,
    modelUsage,
    observabilityTimeline,
  });

  const success = await invoke(handler, traceUrl(conversation.id, completed.id));
  assert.equal(success.statusCode, 200);
  assert.equal(success.json.trace.timelineWindow.totalEventCount, 3);
  assert.equal(success.json.trace.summary.status, 'completed');
  assert.equal(success.json.trace.summary.totalDurationMs, 4000);
  assert.equal(success.json.trace.summary.totalToolDurationMs, 250);
  assert.deepEqual(success.json.trace.events.filter((event) => event.kind !== 'lifecycle').map((event) => [event.kind, event.title]), [
    ['model_call', '新建 Session'],
    ['tool_execution', 'bash'],
    ['model_call', '模型调用 #2'],
  ]);
  const calls = success.json.trace.events.filter((event) => event.kind === 'model_call');
  assert.equal(calls[0].detail.sessionAction, 'fresh');
  assert.equal(calls[0].detail.providerCacheStatus, 'no_cache_read');
  assert.equal(calls[1].detail.sessionAction, null);
  assert.equal(calls[1].detail.providerCacheStatus, 'provider_miss');

  createAssistant(store, conversation.id, 'mixed-failed', {
    status: 'failed',
    errorMessage: 'bounded provider failure',
    sessionName: 'failed-session',
  });
  const failed = await invoke(handler, traceUrl(conversation.id, 'mixed-failed'));
  const failedPhases = failed.json.trace.events.filter((event) => event.status === 'failed').map((event) => event.phase);
  assert.equal(failed.json.trace.summary.status, 'failed');
  assert.deepEqual(failedPhases, ['session', 'failure', 'persistence']);
  assert.equal(failed.json.trace.events.at(-1).summary, 'assistant 消息已落库为 failed');
});

test('Trace Inspector lineage fails closed for legacy, missing, protected, cycle, and depth limits', async (t) => {
  const { store, conversation, handler } = createFixture(t, 'failure-matrix');

  createAssistant(store, conversation.id, 'legacy-parent', {
    schemaVersion: 1,
    sessionName: 'legacy-session',
  });
  store.db.prepare(`
    UPDATE chat_message_context_snapshots
    SET snapshot_json = json_remove(snapshot_json, '$.deliveryMode', '$.retainedSessionPrefix'),
        summary_json = json_remove(summary_json, '$.deliveryMode', '$.retainedSessionPrefix')
    WHERE message_id = 'legacy-parent'
  `).run();
  createAssistant(store, conversation.id, 'legacy-current', {
    deliveryMode: 'resume',
    parentMessageId: 'legacy-parent',
  });
  const legacy = await invoke(handler, traceUrl(conversation.id, 'legacy-current'));
  assert.equal(legacy.json.lineage.termination.code, 'legacy_schema');
  assert.deepEqual(legacy.json.lineage.nodes.map((node) => node.messageId), ['legacy-current', 'legacy-parent']);

  createAssistant(store, conversation.id, 'deleted-parent', {
    sessionName: 'deleted-session',
  });
  createAssistant(store, conversation.id, 'missing-current', {
    deliveryMode: 'resume',
    parentMessageId: 'deleted-parent',
  });
  store.db.prepare('DELETE FROM chat_messages WHERE id = ?').run('deleted-parent');
  const missing = await invoke(handler, traceUrl(conversation.id, 'missing-current'));
  assert.equal(missing.json.lineage.termination.code, 'parent_missing');
  assert.deepEqual(missing.json.lineage.nodes.map((node) => node.messageId), ['missing-current']);

  createAssistant(store, conversation.id, 'protected-parent', {
    privateOnly: true,
    sessionName: 'do-not-project-this-session',
  });
  createAssistant(store, conversation.id, 'protected-current', {
    deliveryMode: 'resume',
    parentMessageId: 'protected-parent',
  });
  const protectedResult = await invoke(handler, traceUrl(conversation.id, 'protected-current'));
  assert.equal(protectedResult.json.lineage.termination.code, 'protected_parent');
  assert.deepEqual(protectedResult.json.lineage.nodes.map((node) => node.messageId), ['protected-current']);
  assert.doesNotMatch(JSON.stringify(protectedResult.json), /protected-parent|do-not-project/u);
  assert.equal(protectedResult.json.snapshot.retainedSessionPrefix.cursorMessageId, '');
  assert.equal(protectedResult.json.snapshot.retainedSessionPrefix.cursorFirstMessageId, '');
  const protectedExport = await invoke(handler, `${traceUrl(conversation.id, 'protected-current')}-export`);
  assert.doesNotMatch(protectedExport.body, /protected-parent|do-not-project/u);

  createAssistant(store, conversation.id, 'cycle-a', { deliveryMode: 'resume', parentMessageId: 'cycle-b' });
  createAssistant(store, conversation.id, 'cycle-b', { deliveryMode: 'resume', parentMessageId: 'cycle-a' });
  const cycle = await invoke(handler, traceUrl(conversation.id, 'cycle-a'));
  assert.equal(cycle.json.lineage.termination.code, 'cycle');
  assert.deepEqual(cycle.json.lineage.nodes.map((node) => node.messageId), ['cycle-a', 'cycle-b']);

  for (let index = 0; index < 10; index += 1) {
    createAssistant(store, conversation.id, `depth-${index}`, index === 0
      ? { sessionName: 'depth-session' }
      : {
          deliveryMode: 'resume',
          parentMessageId: `depth-${index - 1}`,
          parentSessionName: 'depth-session',
          sessionName: 'depth-session',
        });
  }
  const depth = await invoke(handler, traceUrl(conversation.id, 'depth-9'));
  assert.equal(depth.json.lineage.nodes.length, 8);
  assert.equal(depth.json.lineage.termination.code, 'depth_limit');
});
