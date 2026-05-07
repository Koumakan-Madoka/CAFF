const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createConversationsController } = require('../../build/server/api/conversations-controller');
const { createMemoryController } = require('../../build/server/api/memory-controller');
const { maybeAutoCreateConversationDigest } = require('../../build/server/domain/conversation/conversation-digest');

const { requireSpawn } = require('../helpers/spawn');
const { withTempDir } = require('../helpers/temp-dir');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const FAKE_PI_TRELLIS_TOOLS_PATH = path.join(ROOT_DIR, 'tests', 'fixtures', 'fake-pi-trellis-tools.ps1');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function waitForServer(baseUrl, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'Server did not respond';

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with code ${child.exitCode}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/bootstrap`);

      if (response.ok) {
        return;
      }

      lastError = `Unexpected status: ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(lastError);
}

async function waitForCondition(check, timeoutMs = 15000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'Condition was not met in time';

  while (Date.now() < deadline) {
    try {
      const result = await check();

      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(lastError);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  const exitPromise = new Promise((resolve) => {
    child.once('exit', resolve);
  });

  child.kill('SIGTERM');

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }

      resolve();
    }, 5000);
  });

  await Promise.race([exitPromise, timeoutPromise]);
}

async function fetchJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }

  return data;
}

async function invokeConversationsController(handler, options = {}) {
  const req = new PassThrough();
  req.method = options.method || 'GET';
  const pathname = options.pathname || '/api/conversations';
  const requestUrl = new URL(`http://127.0.0.1${pathname}`);
  const responseState = {
    statusCode: 0,
    headers: null,
    body: '',
  };
  const res = {
    writeHead(statusCode, headers) {
      responseState.statusCode = statusCode;
      responseState.headers = headers;
    },
    end(chunk = '') {
      responseState.body = String(chunk || '');
    },
  };

  const handledPromise = handler({ req, res, pathname, requestUrl });
  req.end(options.body ? JSON.stringify(options.body) : '');
  const handled = await handledPromise;

  return {
    handled,
    statusCode: responseState.statusCode,
    json: responseState.body ? JSON.parse(responseState.body) : {},
  };
}

function createConversationsControllerHarness(t, options = {}) {
  const tempDir = withTempDir('caff-conversations-controller-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const runtimePayload = options.runtimePayload || {
    activeConversationIds: [],
    dispatchingConversationIds: [],
    conversationQueueDepths: {},
    agentSlotQueueDepths: {},
    activeTurns: [],
    activeAgentSlots: [],
  };
  const broadcastEvents = [];
  const handler = createConversationsController({
    store,
    turnOrchestrator: {
      buildRuntimePayload() {
        return runtimePayload;
      },
      clearConversationState() {},
    },
    undercoverService: { deleteConversationState() {} },
    werewolfService: { deleteConversationState() {} },
    buildBootstrapPayload() {
      return { conversations: store.listConversations(), agents: [], runtime: runtimePayload };
    },
    broadcastEvent(eventName, payload) {
      broadcastEvents.push({ eventName, payload });
    },
    modeStore: { get() { return null; } },
    digestOptions: { summaryMode: 'extractive', ...(options.digestOptions || {}) },
    digestModelRunner: options.digestModelRunner,
  });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return { handler, store, broadcastEvents };
}

test('conversations controller manages session goal lifecycle in metadata', async (t) => {
  const { handler, store, broadcastEvents } = createConversationsControllerHarness(t);
  const conversation = store.createConversation({
    id: 'goal-conversation',
    title: 'Goal Conversation',
  });

  const setResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/goal`,
    body: {
      action: 'set',
      objective: 'Ship a CAFF session goal MVP',
      checklistText: '[x] Add goal API\n[~] Build goal panel\n[ ] Run validation',
    },
  });

  assert.equal(setResult.handled, true);
  assert.equal(setResult.statusCode, 200);
  assert.equal(setResult.json.goal.objective, 'Ship a CAFF session goal MVP');
  assert.equal(setResult.json.goal.status, 'active');
  assert.equal(setResult.json.conversation.metadata.sessionGoal.objective, 'Ship a CAFF session goal MVP');
  assert.equal(setResult.json.summary.metadata.sessionGoal.status, 'active');
  assert.equal(setResult.json.goal.checklist.length, 3);
  assert.equal(setResult.json.goal.checklist[0].status, 'done');
  assert.equal(setResult.json.goal.checklist[1].status, 'in_progress');

  const checklistResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/goal`,
    body: {
      action: 'update-checklist',
      checklistText: '[x] Add goal API\n[x] Build goal panel\n[ ] Run validation',
    },
  });

  assert.equal(checklistResult.json.goal.status, 'active');
  assert.equal(checklistResult.json.goal.checklist[1].status, 'done');
  assert.equal(checklistResult.json.autoContinuation, null);

  const pauseResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/goal`,
    body: { action: 'pause' },
  });

  assert.equal(pauseResult.json.goal.status, 'paused');
  assert.equal(store.getConversation(conversation.id).metadata.sessionGoal.status, 'paused');

  const resumeResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/goal`,
    body: { action: 'resume' },
  });

  assert.equal(resumeResult.json.goal.status, 'active');

  const completeResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/goal`,
    body: { action: 'complete' },
  });

  assert.equal(completeResult.json.goal.status, 'complete');
  assert.ok(completeResult.json.goal.completedAt);

  const resumeCompleteResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/goal`,
    body: { action: 'resume' },
  });

  assert.equal(resumeCompleteResult.json.goal.status, 'active');
  assert.equal(resumeCompleteResult.json.goal.completedAt, undefined);

  const clearResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/goal`,
    body: { action: 'clear' },
  });

  assert.equal(clearResult.json.goal, null);
  assert.equal(clearResult.json.cleared, true);
  assert.equal(store.getConversation(conversation.id).metadata.sessionGoal, undefined);
  assert.ok(broadcastEvents.some((event) => event.eventName === 'conversation_goal_updated'));
  assert.ok(broadcastEvents.some((event) => event.eventName === 'conversation_goal_cleared'));
});

test('conversations controller applies default Trellis checklist when setting goal without checklist', async (t) => {
  const { handler, store } = createConversationsControllerHarness(t);
  const conversation = store.createConversation({
    id: 'goal-default-checklist-conversation',
    title: 'Goal Default Checklist Conversation',
  });

  const setResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/goal`,
    body: {
      action: 'set',
      objective: 'Ship a Trellis-backed long task',
    },
  });

  assert.equal(setResult.statusCode, 200);
  assert.equal(setResult.json.goal.checklist.length, 10);
  assert.equal(setResult.json.goal.checklist[0].text, '和其他 agent 一起头脑风暴，收敛目标、范围和风险');
  assert.equal(setResult.json.goal.checklist[9].text, '人工验收后记录会话并归档 Trellis 任务');
});

test('conversations controller creates and deletes conversation digests in metadata', async (t) => {
  const { handler, store, broadcastEvents } = createConversationsControllerHarness(t, {
    digestOptions: {
      resolveSummaryMemoryTaskName: () => 'Conversation Digest Auto-Compaction v2',
    },
  });
  const conversation = store.createConversation({
    id: 'digest-conversation',
    title: 'Digest Conversation',
  });

  store.createMessage({
    id: 'digest-message-1',
    conversationId: conversation.id,
    turnId: 'digest-turn-1',
    role: 'user',
    senderName: 'User',
    content: '我们决定先做 Conversation Digest MVP，并需要添加右侧摘要面板。',
  });
  store.createMessage({
    id: 'digest-message-2',
    conversationId: conversation.id,
    turnId: 'digest-turn-2',
    role: 'assistant',
    senderName: 'Builder',
    content: '下一步实现 server/domain/conversation/conversation-digest.ts，然后补 tests/runtime/turn-orchestrator.test.js。',
  });

  const createResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/digest`,
    body: { action: 'create' },
  });

  assert.equal(createResult.handled, true);
  assert.equal(createResult.statusCode, 200);
  assert.equal(createResult.json.digests.length, 1);
  assert.equal(createResult.json.digest.kind, 'entry');
  assert.equal(createResult.json.compacted, false);
  assert.equal(createResult.json.digest.messageRange.messageCount, 2);
  assert.equal(createResult.json.conversation.metadata.conversationDigests.length, 1);
  assert.equal(createResult.json.summary.metadata.conversationDigests.length, 1);
  assert.ok(createResult.json.digest.decisions.some((item) => item.includes('决定')));
  assert.ok(createResult.json.digest.nextActions.some((item) => item.includes('下一步')));
  assert.equal(store.searchSummarySegments({ query: 'Conversation Digest MVP 摘要面板' }).resultCount, 1);
  const taskAttributedSearch = store.searchSummarySegments({
    query: 'Conversation Digest MVP 摘要面板',
    taskName: 'Auto-Compaction v2',
  });
  assert.equal(taskAttributedSearch.resultCount, 1);
  assert.equal(taskAttributedSearch.results[0].taskName, 'Conversation Digest Auto-Compaction v2');
  assert.ok(broadcastEvents.some((event) => event.eventName === 'conversation_digest_updated'));
  assert.ok(broadcastEvents.some((event) => event.eventName === 'conversation_summary_updated'));

  const deleteResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/digest`,
    body: { action: 'delete', digestId: createResult.json.digest.id },
  });

  assert.equal(deleteResult.statusCode, 200);
  assert.equal(deleteResult.json.deleted, true);
  assert.equal(deleteResult.json.digests.length, 0);
  assert.equal(store.getConversation(conversation.id).metadata.conversationDigests, undefined);
  assert.equal(store.searchSummarySegments({ query: 'Conversation Digest MVP 摘要面板' }).resultCount, 0);
  assert.ok(broadcastEvents.some((event) => event.eventName === 'conversation_digest_deleted'));
});

test('memory controller searches summary segments and can exclude the active conversation', async (t) => {
  const { store } = createConversationsControllerHarness(t);
  const currentConversation = store.createConversation({
    id: 'memory-search-current-conversation',
    title: 'Current Memory Conversation',
  });
  const historicalConversation = store.createConversation({
    id: 'memory-search-historical-conversation',
    title: 'Historical Memory Conversation',
  });
  const otherHistoricalConversation = store.createConversation({
    id: 'memory-search-other-historical-conversation',
    title: 'Other Historical Conversation',
  });
  const handler = createMemoryController({
    store,
    resolveCurrentTaskName: () => 'memory-panel-task',
  });

  store.saveSummarySegmentFromDigest(currentConversation.id, {
    id: 'digest-memory-search-current',
    kind: 'entry',
    summary: 'memory-panel-keyword current conversation digest should be excluded by default.',
    facts: ['Current memory-panel-keyword fact.'],
    createdAt: '2026-05-03T00:00:00.000Z',
    updatedAt: '2026-05-03T00:00:00.000Z',
  });
  store.saveSummarySegmentFromDigest(historicalConversation.id, {
    id: 'digest-memory-search-historical',
    kind: 'rollup',
    summary: 'memory-panel-keyword historical digest should be visible in the UI drawer.',
    decisions: ['The memory drawer can search historical summary segments.'],
    createdAt: '2026-05-03T00:01:00.000Z',
    updatedAt: '2026-05-03T00:01:00.000Z',
  }, { taskName: 'memory-panel-task' });
  store.saveSummarySegmentFromDigest(otherHistoricalConversation.id, {
    id: 'digest-memory-search-other-historical',
    kind: 'rollup',
    summary: 'memory-panel-keyword historical digest should be hidden by the title filter.',
    decisions: ['The memory drawer can filter by source conversation title.'],
    createdAt: '2026-05-03T00:02:00.000Z',
    updatedAt: '2026-05-03T00:02:00.000Z',
  }, { taskName: 'memory-panel-task' });

  const searchResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: '/api/memory/search',
    body: {
      query: 'memory-panel-keyword',
      excludeConversationId: currentConversation.id,
      taskName: 'memory-panel-task',
      sourceKind: 'rollup',
      conversationTitle: 'Historical Memory',
      updatedAfter: '2026-05-03',
      updatedBefore: '2026-05-03',
    },
  });

  assert.equal(searchResult.handled, true);
  assert.equal(searchResult.statusCode, 200);
  assert.equal(searchResult.json.resultCount, 1);
  assert.deepEqual(searchResult.json.filters, {
    excludeConversationId: currentConversation.id,
    taskName: 'memory-panel-task',
    sourceKind: 'rollup',
    conversationTitle: 'Historical Memory',
    updatedAfter: '2026-05-03T00:00:00.000Z',
    updatedBefore: '2026-05-03T23:59:59.999Z',
  });
  assert.equal(searchResult.json.results[0].sourceDigestId, 'digest-memory-search-historical');
  assert.deepEqual(searchResult.json.results[0].matchedTerms, ['memory-panel-keyword']);

  store.saveSummarySegmentFromDigest(historicalConversation.id, {
    id: 'digest-memory-current-task-filter',
    kind: 'entry',
    summary: 'current-task-panel-keyword belongs to the active Trellis task.',
    facts: ['Current task search should resolve the task filter server-side.'],
    createdAt: '2026-05-03T00:03:00.000Z',
    updatedAt: '2026-05-03T00:03:00.000Z',
  }, { taskName: 'memory-panel-task' });
  store.saveSummarySegmentFromDigest(otherHistoricalConversation.id, {
    id: 'digest-memory-current-task-filter-other',
    kind: 'entry',
    summary: 'current-task-panel-keyword belongs to another Trellis task.',
    facts: ['This segment should be hidden by useCurrentTask.'],
    createdAt: '2026-05-03T00:04:00.000Z',
    updatedAt: '2026-05-03T00:04:00.000Z',
  }, { taskName: 'other-memory-task' });

  const currentTaskResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: '/api/memory/search',
    body: {
      query: 'current-task-panel-keyword',
      excludeConversationId: currentConversation.id,
      useCurrentTask: true,
    },
  });

  assert.equal(currentTaskResult.statusCode, 200);
  assert.equal(currentTaskResult.json.resultCount, 1);
  assert.deepEqual(currentTaskResult.json.filters, {
    excludeConversationId: currentConversation.id,
    taskName: 'memory-panel-task',
  });
  assert.equal(currentTaskResult.json.results[0].sourceDigestId, 'digest-memory-current-task-filter');

  const latestResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: '/api/memory/search',
    body: {
      latest: true,
      excludeConversationId: currentConversation.id,
      limit: 2,
    },
  });

  assert.equal(latestResult.statusCode, 200);
  assert.equal(latestResult.json.query, '');
  assert.equal(latestResult.json.searchMode, 'like_latest');
  assert.equal(latestResult.json.resultCount, 2);
  assert.deepEqual(latestResult.json.results.map((result) => result.sourceDigestId), [
    'digest-memory-current-task-filter-other',
    'digest-memory-current-task-filter',
  ]);
});

test('memory controller reports summary memory health and pending digest backfill', async (t) => {
  const { store } = createConversationsControllerHarness(t);
  const legacyConversation = store.createConversation({
    id: 'memory-health-legacy-conversation',
    title: 'Memory Health Legacy Conversation',
    metadata: {
      conversationDigests: [
        {
          id: 'digest-memory-health-legacy',
          kind: 'entry',
          createdAt: '2026-05-03T00:02:00.000Z',
          updatedAt: '2026-05-03T00:02:00.000Z',
          summary: 'memory-health-keyword digest is waiting for searchable summary memory backfill.',
          facts: ['Health check should report unsynced digest metadata.'],
        },
      ],
    },
  });
  const handler = createMemoryController({ store });

  const initialHealth = await invokeConversationsController(handler, {
    method: 'GET',
    pathname: '/api/memory/health',
  });

  assert.equal(initialHealth.handled, true);
  assert.equal(initialHealth.statusCode, 200);
  assert.equal(initialHealth.json.ok, true);
  assert.equal(initialHealth.json.status, 'needs_backfill');
  assert.deepEqual(initialHealth.json.table, {
    name: 'chat_summary_segments',
    exists: true,
  });
  assert.equal(initialHealth.json.search.available, true);
  assert.equal(initialHealth.json.search.mode, 'like_latest');
  assert.equal(initialHealth.json.segments.count, 0);
  assert.equal(initialHealth.json.backfill.conversationCount, 1);
  assert.equal(initialHealth.json.backfill.digestCount, 1);
  assert.equal(initialHealth.json.backfill.unsyncedDigestCount, 1);
  assert.deepEqual(initialHealth.json.backfill.unsyncedDigests, [
    {
      conversationId: 'memory-health-legacy-conversation',
      conversationTitle: 'Memory Health Legacy Conversation',
      digestId: 'digest-memory-health-legacy',
      kind: 'entry',
      reason: 'missing_segment',
    },
  ]);

  const backfillResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: '/api/memory/backfill',
    body: {
      conversationId: legacyConversation.id,
    },
  });

  assert.equal(backfillResult.statusCode, 200);

  const finalHealth = await invokeConversationsController(handler, {
    method: 'GET',
    pathname: '/api/memory/health',
  });

  assert.equal(finalHealth.statusCode, 200);
  assert.equal(finalHealth.json.status, 'ok');
  assert.equal(finalHealth.json.segments.count, 1);
  assert.equal(finalHealth.json.segments.latest.sourceDigestId, 'digest-memory-health-legacy');
  assert.equal(finalHealth.json.backfill.unsyncedDigestCount, 0);
  assert.deepEqual(finalHealth.json.backfill.unsyncedDigests, []);
});

test('memory controller backfills legacy metadata digests into summary segments', async (t) => {
  const { store } = createConversationsControllerHarness(t);
  const legacyConversation = store.createConversation({
    id: 'memory-backfill-legacy-conversation',
    title: 'Legacy Digest Conversation',
    metadata: {
      conversationDigests: [
        {
          id: 'digest-memory-backfill-legacy',
          kind: 'entry',
          createdAt: '2026-05-03T00:02:00.000Z',
          updatedAt: '2026-05-03T00:02:00.000Z',
          createdBy: 'model:legacy/test',
          triggerReason: 'manual',
          messageRange: {
            fromMessageId: 'legacy-message-1',
            toMessageId: 'legacy-message-2',
            messageCount: 2,
          },
          summary: 'legacy-backfill-keyword digest existed before summary segments were introduced.',
          decisions: ['Backfill should make old metadata digests searchable.'],
          artifacts: ['conversationDigests metadata'],
        },
      ],
    },
  });
  const handler = createMemoryController({ store });

  assert.equal(store.searchSummarySegments({ query: 'legacy-backfill-keyword' }).resultCount, 0);

  const backfillResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: '/api/memory/backfill',
    body: {
      conversationId: legacyConversation.id,
      taskName: 'legacy-memory-task',
    },
  });

  assert.equal(backfillResult.handled, true);
  assert.equal(backfillResult.statusCode, 200);
  assert.equal(backfillResult.json.action, 'backfill');
  assert.equal(backfillResult.json.conversationCount, 1);
  assert.equal(backfillResult.json.digestCount, 1);
  assert.equal(backfillResult.json.segmentCount, 1);

  const searchResult = store.searchSummarySegments({
    query: 'legacy-backfill-keyword',
    taskName: 'legacy-memory-task',
  });

  assert.equal(searchResult.resultCount, 1);
  assert.equal(searchResult.results[0].sourceDigestId, 'digest-memory-backfill-legacy');
  assert.equal(searchResult.results[0].taskName, 'legacy-memory-task');
  assert.equal(searchResult.results[0].metadata.trigger, 'metadata-backfill');
});

test('memory controller reports backfill failures with digest reasons', async (t) => {
  const { store } = createConversationsControllerHarness(t);
  const legacyConversation = store.createConversation({
    id: 'memory-backfill-failure-conversation',
    title: 'Legacy Digest Failure Conversation',
    metadata: {
      conversationDigests: [
        {
          id: 'digest-memory-backfill-failure',
          kind: 'entry',
          createdAt: '2026-05-03T00:02:00.000Z',
          updatedAt: '2026-05-03T00:02:00.000Z',
          summary: 'legacy backfill failure should return a concrete diagnostic.',
        },
      ],
    },
  });
  const originalSaveSummarySegmentFromDigest = store.saveSummarySegmentFromDigest.bind(store);
  store.saveSummarySegmentFromDigest = (conversationId, digest, options) => {
    if (digest && digest.id === 'digest-memory-backfill-failure') {
      throw new Error('synthetic summary segment write failure');
    }

    return originalSaveSummarySegmentFromDigest(conversationId, digest, options);
  };
  const handler = createMemoryController({ store });

  const backfillResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: '/api/memory/backfill',
    body: {
      conversationId: legacyConversation.id,
    },
  });

  assert.equal(backfillResult.handled, true);
  assert.equal(backfillResult.statusCode, 200);
  assert.equal(backfillResult.json.segmentCount, 0);
  assert.equal(backfillResult.json.failedCount, 1);
  assert.deepEqual(backfillResult.json.failures, [
    {
      conversationId: 'memory-backfill-failure-conversation',
      conversationTitle: 'Legacy Digest Failure Conversation',
      digestId: 'digest-memory-backfill-failure',
      kind: 'entry',
      reason: 'sync_failed',
      message: 'synthetic summary segment write failure',
    },
  ]);
});

test('conversation digest auto-creates model summaries after the message budget', async (t) => {
  const tempDir = withTempDir('caff-auto-digest-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const modelCalls = [];

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = store.createConversation({
    id: 'digest-auto-create-conversation',
    title: 'Digest Auto Create Conversation',
  });

  function appendPublicMessages(startIndex, count) {
    for (let offset = 0; offset < count; offset += 1) {
      const index = startIndex + offset;
      store.createMessage({
        id: `digest-auto-create-message-${index}`,
        conversationId: conversation.id,
        turnId: `digest-auto-create-turn-${index}`,
        role: index % 2 === 0 ? 'assistant' : 'user',
        senderName: index % 2 === 0 ? 'Builder' : 'User',
        content: `自动摘要消息 ${index}：决定继续用 DeepSeek 生成长期记忆，并保留最近原文优先。`,
      });
    }
  }

  appendPublicMessages(1, 23);
  const skippedResult = await maybeAutoCreateConversationDigest(store, conversation.id, {
    autoCreate: true,
    autoCreateMessageBudget: 24,
    autoCreateIdleMs: 0,
    autoCreateCooldownMs: 0,
    autoCreateHighValue: false,
    summaryMode: 'model',
    digestModelRunner: async (context) => {
      modelCalls.push(context);
      return {
        summary: `模型自动摘要 ${modelCalls.length}`,
        facts: ['模型事实：自动摘要达到消息预算后触发。'],
        decisions: ['模型决策：使用便宜模型生成摘要。'],
        openQuestions: [],
        nextActions: ['模型下一步：继续自动压缩旧摘要。'],
        artifacts: ['server/domain/conversation/conversation-digest.ts'],
      };
    },
  });

  assert.equal(skippedResult.digestChanged, false);
  assert.equal(skippedResult.reason, 'below_budget');
  assert.equal(modelCalls.length, 0);

  appendPublicMessages(24, 1);
  const createResult = await maybeAutoCreateConversationDigest(store, conversation.id, {
    autoCreate: true,
    autoCreateMessageBudget: 24,
    autoCreateIdleMs: 0,
    autoCreateCooldownMs: 0,
    autoCreateHighValue: false,
    summaryMode: 'model',
    provider: 'model-provider',
    model: 'model-name',
    resolveSummaryMemoryTaskName: () => 'Auto Digest Memory Task',
    digestModelRunner: async (context) => {
      modelCalls.push(context);
      return {
        summary: `模型自动摘要 ${modelCalls.length}`,
        facts: ['模型事实：自动摘要达到消息预算后触发。'],
        decisions: ['模型决策：使用便宜模型生成摘要。'],
        openQuestions: [],
        nextActions: ['模型下一步：继续自动压缩旧摘要。'],
        artifacts: ['server/domain/conversation/conversation-digest.ts'],
      };
    },
  });

  assert.equal(createResult.digestChanged, true);
  assert.equal(createResult.autoCreated, true);
  assert.equal(createResult.digest.messageRange.messageCount, 24);
  assert.equal(createResult.digest.createdBy, 'model:auto-digest:model-provider/model-name');
  const autoSegmentSearch = store.searchSummarySegments({
    query: '模型自动摘要',
    taskName: 'Auto Digest',
  });
  assert.equal(autoSegmentSearch.resultCount, 1);
  assert.equal(autoSegmentSearch.results[0].taskName, 'Auto Digest Memory Task');
  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].purpose, 'entry');

  const repeatedResult = await maybeAutoCreateConversationDigest(store, conversation.id, {
    autoCreate: true,
    autoCreateMessageBudget: 24,
    autoCreateIdleMs: 0,
    autoCreateCooldownMs: 0,
    autoCreateHighValue: false,
  });

  assert.equal(repeatedResult.digestChanged, false);
  assert.equal(repeatedResult.stateChanged, false);
  assert.equal(repeatedResult.pendingMessageCount, 0);
});

test('conversation digest auto-create falls back to digest timestamps when covered messages are missing', async (t) => {
  const tempDir = withTempDir('caff-auto-digest-missing-boundary-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const digestTimestamp = '2026-05-03T10:00:00.000Z';
  const conversation = store.createConversation({
    id: 'digest-auto-create-missing-boundary-conversation',
    title: 'Digest Auto Create Missing Boundary Conversation',
    metadata: {
      conversationDigests: [{
        id: 'digest-missing-boundary',
        kind: 'entry',
        createdAt: digestTimestamp,
        updatedAt: digestTimestamp,
        createdBy: 'system:auto-digest',
        messageRange: {
          fromMessageId: 'deleted-message-1',
          toMessageId: 'deleted-message-2',
          messageCount: 2,
        },
        summary: '已总结过的旧消息。',
        facts: ['旧事实已进入摘要。'],
        decisions: [],
        openQuestions: [],
        nextActions: [],
        artifacts: [],
      }],
    },
  });

  for (let index = 1; index <= 3; index += 1) {
    store.createMessage({
      id: `digest-auto-create-missing-boundary-old-${index}`,
      conversationId: conversation.id,
      turnId: 'digest-auto-create-missing-boundary-old-turn',
      role: index % 2 === 0 ? 'assistant' : 'user',
      senderName: index % 2 === 0 ? 'Builder' : 'User',
      content: `旧消息 ${index}：这些内容已经由缺失边界消息覆盖。`,
      createdAt: '2026-05-03T09:00:00.000Z',
    });
  }

  store.createMessage({
    id: 'digest-auto-create-missing-boundary-new-1',
    conversationId: conversation.id,
    turnId: 'digest-auto-create-missing-boundary-new-turn',
    role: 'user',
    senderName: 'User',
    content: '新消息 1：这条在旧摘要之后，应该计入待总结。',
    createdAt: '2026-05-03T11:00:00.000Z',
  });

  const skippedResult = await maybeAutoCreateConversationDigest(store, conversation.id, {
    autoCreate: true,
    autoCreateMessageBudget: 2,
    autoCreateIdleMs: 0,
    autoCreateCooldownMs: 0,
    autoCreateHighValue: false,
    summaryMode: 'extractive',
  });

  assert.equal(skippedResult.digestChanged, false);
  assert.equal(skippedResult.reason, 'below_budget');
  assert.equal(skippedResult.pendingMessageCount, 1);

  store.createMessage({
    id: 'digest-auto-create-missing-boundary-new-2',
    conversationId: conversation.id,
    turnId: 'digest-auto-create-missing-boundary-new-turn',
    role: 'assistant',
    senderName: 'Builder',
    content: '新消息 2：第二条新内容达到自动摘要预算。',
    createdAt: '2026-05-03T11:05:00.000Z',
  });

  const createResult = await maybeAutoCreateConversationDigest(store, conversation.id, {
    autoCreate: true,
    autoCreateMessageBudget: 2,
    autoCreateIdleMs: 0,
    autoCreateCooldownMs: 0,
    autoCreateHighValue: false,
    summaryMode: 'extractive',
  });

  assert.equal(createResult.autoCreated, true);
  assert.equal(createResult.digest.messageRange.messageCount, 2);
  assert.equal(createResult.digest.messageRange.fromMessageId, 'digest-auto-create-missing-boundary-new-1');
  assert.equal(createResult.digest.messageRange.toMessageId, 'digest-auto-create-missing-boundary-new-2');
});

test('conversation digest auto-create respects idle, cooldown, and high-value gates', async (t) => {
  const tempDir = withTempDir('caff-auto-digest-gates-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const idleConversation = store.createConversation({
    id: 'digest-auto-create-idle-conversation',
    title: 'Digest Auto Create Idle Conversation',
  });
  const recentTimestamp = new Date().toISOString();

  for (let index = 1; index <= 4; index += 1) {
    store.createMessage({
      id: `digest-auto-create-idle-message-${index}`,
      conversationId: idleConversation.id,
      turnId: 'digest-auto-create-idle-turn',
      role: index % 2 === 0 ? 'assistant' : 'user',
      senderName: index % 2 === 0 ? 'Builder' : 'User',
      content: `自动摘要等待安静窗口消息 ${index}：决定先别把半截讨论写进长期记忆。`,
      createdAt: recentTimestamp,
    });
  }

  const idleResult = await maybeAutoCreateConversationDigest(store, idleConversation.id, {
    autoCreate: true,
    autoCreateMessageBudget: 4,
    autoCreateIdleMs: 10 * 60 * 1000,
    summaryMode: 'extractive',
  });

  assert.equal(idleResult.digestChanged, false);
  assert.equal(idleResult.stateChanged, true);
  assert.equal(idleResult.reason, 'idle_wait');
  assert.equal(idleResult.pendingMessageCount, 4);
  assert.ok(idleResult.retryAfterMs > 0);
  assert.equal(store.getConversation(idleConversation.id).metadata.conversationDigestState.pendingPublicMessageCount, 4);

  const gatedConversation = store.createConversation({
    id: 'digest-auto-create-gated-conversation',
    title: 'Digest Auto Create Gated Conversation',
  });
  const oldTimestamp = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  let nextMessageIndex = 1;

  function appendOldMessages(count, content) {
    for (let offset = 0; offset < count; offset += 1) {
      const index = nextMessageIndex;
      nextMessageIndex += 1;
      store.createMessage({
        id: `digest-auto-create-gated-message-${index}`,
        conversationId: gatedConversation.id,
        turnId: `digest-auto-create-gated-turn-${index}`,
        role: index % 2 === 0 ? 'assistant' : 'user',
        senderName: index % 2 === 0 ? 'Builder' : 'User',
        content: `${content} ${index}`,
        createdAt: oldTimestamp,
      });
    }
  }

  appendOldMessages(4, '自动摘要冷却消息：决定完成一轮摘要并记录水位线。');
  const createResult = await maybeAutoCreateConversationDigest(store, gatedConversation.id, {
    autoCreate: true,
    autoCreateMessageBudget: 4,
    autoCreateIdleMs: 10 * 60 * 1000,
    autoCreateCooldownMs: 60 * 60 * 1000,
    summaryMode: 'extractive',
  });

  assert.equal(createResult.autoCreated, true);
  assert.equal(createResult.triggerReason, 'message_budget');
  assert.equal(store.getConversation(gatedConversation.id).metadata.conversationDigestState.lastAutoDigestAt, createResult.conversation.metadata.conversationDigestState.lastAutoDigestAt);

  appendOldMessages(4, '自动摘要冷却消息：继续讨论但应等待 cooldown。');
  const cooldownResult = await maybeAutoCreateConversationDigest(store, gatedConversation.id, {
    autoCreate: true,
    autoCreateMessageBudget: 4,
    autoCreateIdleMs: 10 * 60 * 1000,
    autoCreateCooldownMs: 60 * 60 * 1000,
    summaryMode: 'extractive',
  });

  assert.equal(cooldownResult.digestChanged, false);
  assert.equal(cooldownResult.reason, 'cooldown');
  assert.equal(cooldownResult.pendingMessageCount, 4);
  assert.ok(cooldownResult.retryAfterMs > 0);

  const highValueConversation = store.createConversation({
    id: 'digest-auto-create-high-value-conversation',
    title: 'Digest Auto Create High Value Conversation',
  });

  for (let index = 1; index <= 6; index += 1) {
    store.createMessage({
      id: `digest-auto-create-high-value-message-${index}`,
      conversationId: highValueConversation.id,
      turnId: 'digest-auto-create-high-value-turn',
      role: index % 2 === 0 ? 'assistant' : 'user',
      senderName: index % 2 === 0 ? 'Builder' : 'User',
      content: `高价值自动摘要消息 ${index}：决定修复 bug，更新 server/domain/file.ts 并提交 commit。`,
      createdAt: oldTimestamp,
    });
  }

  const highValueResult = await maybeAutoCreateConversationDigest(store, highValueConversation.id, {
    autoCreate: true,
    autoCreateMessageBudget: 24,
    autoCreateHighValue: true,
    autoCreateHighValueMinMessages: 6,
    summaryMode: 'extractive',
  });

  assert.equal(highValueResult.autoCreated, true);
  assert.equal(highValueResult.triggerReason, 'high_value_signal');
  assert.equal(highValueResult.digest.messageRange.messageCount, 6);
  assert.equal(highValueResult.signalFlags.decision, true);
  assert.equal(highValueResult.signalFlags.code, true);
  assert.equal(highValueResult.signalFlags.errorFix, true);
});

test('conversation digest auto-create feeds existing auto-compaction', async (t) => {
  const tempDir = withTempDir('caff-auto-digest-compact-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = store.createConversation({
    id: 'digest-auto-create-compact-conversation',
    title: 'Digest Auto Create Compact Conversation',
  });

  let nextMessageIndex = 1;
  let lastResult = null;
  for (const cycle of [1, 2, 3, 4]) {
    for (let offset = 0; offset < 2; offset += 1) {
      const index = nextMessageIndex;
      nextMessageIndex += 1;
      store.createMessage({
        id: `digest-auto-create-compact-message-${index}`,
        conversationId: conversation.id,
        turnId: `digest-auto-create-compact-turn-${cycle}`,
        role: index % 2 === 0 ? 'assistant' : 'user',
        senderName: index % 2 === 0 ? 'Builder' : 'User',
        content: `自动摘要压缩轮次 ${cycle} 消息 ${index}：需要保留 rollup 和最近详细摘要。`,
      });
    }

    lastResult = await maybeAutoCreateConversationDigest(store, conversation.id, {
      autoCreate: true,
      autoCreateMessageBudget: 2,
      autoCreateIdleMs: 0,
      autoCreateCooldownMs: 0,
      autoCreateHighValue: false,
      summaryMode: 'extractive',
    });
  }

  assert.equal(lastResult.digestChanged, true);
  assert.equal(lastResult.compacted, true);
  assert.equal(lastResult.digests.length, 4);
  assert.equal(lastResult.digests[0].kind, 'rollup');
  assert.deepEqual(lastResult.digests.slice(1).map((digest) => digest.kind), ['entry', 'entry', 'entry']);
});

test('conversations controller creates model-generated conversation digests when requested', async (t) => {
  const modelCalls = [];
  const { handler, store } = createConversationsControllerHarness(t, {
    digestModelRunner: async (context) => {
      modelCalls.push(context);
      return {
        summary: '模型总结：已经确认用便宜模型生成会话摘要。',
        facts: ['模型事实：用户希望摘要由模型生成。'],
        decisions: ['模型决策：保留规则摘要作为兜底。'],
        openQuestions: ['模型问题：生产环境使用哪个便宜模型？'],
        nextActions: ['模型下一步：配置 CAFF_DIGEST_PROVIDER 和 CAFF_DIGEST_MODEL。'],
        artifacts: ['server/domain/conversation/conversation-digest.ts'],
      };
    },
  });
  const conversation = store.createConversation({
    id: 'digest-model-conversation',
    title: 'Digest Model Conversation',
  });

  store.createMessage({
    id: 'digest-model-message-1',
    conversationId: conversation.id,
    turnId: 'digest-model-turn-1',
    role: 'user',
    senderName: 'User',
    content: '改造成模型总结吧，我有便宜好用的模型。',
  });

  const createResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/digest`,
    body: {
      action: 'create',
      summaryMode: 'model',
      provider: 'cheap-provider',
      model: 'cheap-model',
    },
  });

  assert.equal(createResult.statusCode, 200);
  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].purpose, 'entry');
  assert.equal(modelCalls[0].config.provider, 'cheap-provider');
  assert.equal(modelCalls[0].config.model, 'cheap-model');
  assert.equal(createResult.json.digest.summary, '模型总结：已经确认用便宜模型生成会话摘要。');
  assert.equal(createResult.json.digest.createdBy, 'model:cheap-provider/cheap-model');
  assert.ok(createResult.json.digest.decisions.some((item) => item.includes('保留规则摘要')));
});

test('conversations controller falls back to extractive digests when model summaries fail', async (t) => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
  });

  const throwingModelCalls = [];
  const throwingHarness = createConversationsControllerHarness(t, {
    digestModelRunner: async (context) => {
      throwingModelCalls.push(context);
      throw new Error('simulated digest model failure');
    },
  });
  const throwingConversation = throwingHarness.store.createConversation({
    id: 'digest-model-throw-fallback-conversation',
    title: 'Digest Model Throw Fallback Conversation',
  });
  throwingHarness.store.createMessage({
    id: 'digest-model-throw-fallback-message-1',
    conversationId: throwingConversation.id,
    turnId: 'digest-model-throw-fallback-turn-1',
    role: 'user',
    senderName: 'User',
    content: '决定让模型摘要失败时继续用规则摘要兜底。',
  });

  const throwingResult = await invokeConversationsController(throwingHarness.handler, {
    method: 'POST',
    pathname: `/api/conversations/${throwingConversation.id}/digest`,
    body: {
      action: 'create',
      summaryMode: 'model',
      provider: 'cheap-provider',
      model: 'cheap-model',
    },
  });

  assert.equal(throwingResult.statusCode, 200);
  assert.equal(throwingModelCalls.length, 1);
  assert.equal(throwingResult.json.digest.createdBy, 'user');
  assert.match(throwingResult.json.digest.summary, /^Extractive digest of 1 public messages\./u);
  assert.ok(throwingResult.json.digest.decisions.some((item) => item.includes('规则摘要兜底')));

  const invalidModelCalls = [];
  const invalidHarness = createConversationsControllerHarness(t, {
    digestModelRunner: async (context) => {
      invalidModelCalls.push(context);
      return 'not valid digest JSON';
    },
  });
  const invalidConversation = invalidHarness.store.createConversation({
    id: 'digest-model-invalid-fallback-conversation',
    title: 'Digest Model Invalid Fallback Conversation',
  });
  invalidHarness.store.createMessage({
    id: 'digest-model-invalid-fallback-message-1',
    conversationId: invalidConversation.id,
    turnId: 'digest-model-invalid-fallback-turn-1',
    role: 'assistant',
    senderName: 'Builder',
    content: '下一步验证模型返回坏格式时也不能中断 /digest。',
  });

  const invalidResult = await invokeConversationsController(invalidHarness.handler, {
    method: 'POST',
    pathname: `/api/conversations/${invalidConversation.id}/digest`,
    body: {
      action: 'create',
      summaryMode: 'model',
      provider: 'cheap-provider',
      model: 'cheap-model',
    },
  });

  assert.equal(invalidResult.statusCode, 200);
  assert.equal(invalidModelCalls.length, 1);
  assert.equal(invalidResult.json.digest.createdBy, 'user');
  assert.match(invalidResult.json.digest.summary, /^Extractive digest of 1 public messages\./u);
  assert.ok(invalidResult.json.digest.nextActions.some((item) => item.includes('坏格式')));
  assert.ok(warnings.some((warning) => warning.includes('Model digest failed')));
});

test('conversations controller auto-compacts old conversation digests into a rollup', async (t) => {
  const { handler, store } = createConversationsControllerHarness(t);
  const conversation = store.createConversation({
    id: 'digest-auto-compact-conversation',
    title: 'Digest Auto Compact Conversation',
  });

  store.createMessage({
    id: 'digest-auto-message-1',
    conversationId: conversation.id,
    turnId: 'digest-auto-turn-1',
    role: 'user',
    senderName: 'User',
    content: '决定保留 rollup 摘要，并把旧摘要自动压缩。',
  });

  let lastResult = null;
  for (const index of [1, 2, 3, 4]) {
    lastResult = await invokeConversationsController(handler, {
      method: 'POST',
      pathname: `/api/conversations/${conversation.id}/digest`,
      body: {
        action: 'create',
        summary: `Digest entry ${index}`,
        facts: [`Fact ${index}`],
      },
    });
  }

  assert.equal(lastResult.statusCode, 200);
  assert.equal(lastResult.json.compacted, true);
  assert.equal(lastResult.json.rollup.kind, 'rollup');
  assert.equal(lastResult.json.digests.length, 4);
  assert.equal(lastResult.json.digests[0].kind, 'rollup');
  assert.deepEqual(lastResult.json.digests.slice(1).map((digest) => digest.kind), ['entry', 'entry', 'entry']);
  assert.equal(lastResult.json.digests[0].sourceDigestIds.length, 1);
  assert.equal(store.getConversation(conversation.id).metadata.conversationDigests[0].kind, 'rollup');
});

test('conversations controller manually compacts digest entries', async (t) => {
  const { handler, store } = createConversationsControllerHarness(t);
  const conversation = store.createConversation({
    id: 'digest-manual-compact-conversation',
    title: 'Digest Manual Compact Conversation',
  });

  store.createMessage({
    id: 'digest-manual-message-1',
    conversationId: conversation.id,
    turnId: 'digest-manual-turn-1',
    role: 'assistant',
    senderName: 'Builder',
    content: '下一步支持 /digest compact 手动压缩旧摘要。',
  });

  for (const index of [1, 2]) {
    await invokeConversationsController(handler, {
      method: 'POST',
      pathname: `/api/conversations/${conversation.id}/digest`,
      body: {
        action: 'create',
        summary: `Manual compact digest ${index}`,
      },
    });
  }

  const compactResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/digest`,
    body: { action: 'compact' },
  });

  assert.equal(compactResult.statusCode, 200);
  assert.equal(compactResult.json.compacted, true);
  assert.equal(compactResult.json.digests.length, 2);
  assert.equal(compactResult.json.digests[0].kind, 'rollup');
  assert.equal(compactResult.json.digests[1].kind, 'entry');
  assert.equal(compactResult.json.rollup.sourceDigestIds.length, 1);
});

test('conversations controller uses model-generated rollups when manual compact requests model mode', async (t) => {
  const modelCalls = [];
  const { handler, store } = createConversationsControllerHarness(t, {
    digestModelRunner: async (context) => {
      modelCalls.push(context);
      return {
        summary: '模型 rollup：旧摘要已经合并成长期历史。',
        facts: ['模型 rollup 事实：保留旧摘要要点。'],
        decisions: ['模型 rollup 决策：压缩层继续保留。'],
        openQuestions: [],
        nextActions: ['模型 rollup 下一步：检查 prompt 顺序。'],
        artifacts: [],
      };
    },
  });
  const conversation = store.createConversation({
    id: 'digest-model-rollup-conversation',
    title: 'Digest Model Rollup Conversation',
  });

  store.createMessage({
    id: 'digest-model-rollup-message-1',
    conversationId: conversation.id,
    turnId: 'digest-model-rollup-turn-1',
    role: 'assistant',
    senderName: 'Builder',
    content: '先生成两条摘要，然后用模型压缩旧摘要。',
  });

  for (const index of [1, 2]) {
    await invokeConversationsController(handler, {
      method: 'POST',
      pathname: `/api/conversations/${conversation.id}/digest`,
      body: {
        action: 'create',
        summary: `Model rollup source ${index}`,
      },
    });
  }

  const compactResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/digest`,
    body: { action: 'compact', summaryMode: 'model' },
  });

  assert.equal(compactResult.statusCode, 200);
  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].purpose, 'rollup');
  assert.equal(compactResult.json.rollup.summary, '模型 rollup：旧摘要已经合并成长期历史。');
  assert.ok(compactResult.json.rollup.createdBy.startsWith('model:auto-compaction:'));
});

test('conversations controller handles empty session goal clear', async (t) => {
  const { handler, store } = createConversationsControllerHarness(t);
  const conversation = store.createConversation({
    id: 'goal-empty-clear-conversation',
    title: 'Goal Empty Clear Conversation',
  });

  const clearResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/goal`,
    body: { action: 'clear' },
  });

  assert.equal(clearResult.statusCode, 200);
  assert.equal(clearResult.json.goal, null);
  assert.equal(clearResult.json.cleared, true);
  assert.equal(store.getConversation(conversation.id).metadata.sessionGoal, undefined);
});

test('conversations controller accepts and dismisses session goal proposals', async (t) => {
  const { handler, store, broadcastEvents } = createConversationsControllerHarness(t);
  const conversation = store.createConversation({
    id: 'goal-proposal-conversation',
    title: 'Goal Proposal Conversation',
    metadata: {
      sessionGoal: {
        objective: 'Finish long-running work',
        status: 'active',
        createdAt: '2026-05-03T00:00:00.000Z',
        updatedAt: '2026-05-03T00:00:00.000Z',
      },
      sessionGoalProposal: {
        action: 'complete',
        status: 'pending',
        reason: 'All acceptance checks passed',
        proposedBy: {
          agentId: 'agent-builder',
          agentName: 'Builder',
        },
        createdAt: '2026-05-03T00:10:00.000Z',
        updatedAt: '2026-05-03T00:10:00.000Z',
      },
    },
  });

  const acceptResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/goal`,
    body: { action: 'accept-proposal' },
  });

  assert.equal(acceptResult.statusCode, 200);
  assert.equal(acceptResult.json.goal.status, 'complete');
  assert.equal(acceptResult.json.proposal, null);
  assert.equal(store.getConversation(conversation.id).metadata.sessionGoalProposal, undefined);
  assert.ok(broadcastEvents.some((event) => event.eventName === 'conversation_goal_updated'));
  assert.ok(broadcastEvents.some((event) => event.eventName === 'conversation_goal_proposal_cleared'));

  store.updateConversation(conversation.id, {
    metadata: {
      ...store.getConversation(conversation.id).metadata,
      sessionGoalProposal: {
        action: 'clear',
        status: 'pending',
        reason: 'No longer needed',
        proposedBy: {
          agentId: 'agent-builder',
          agentName: 'Builder',
        },
        createdAt: '2026-05-03T00:20:00.000Z',
        updatedAt: '2026-05-03T00:20:00.000Z',
      },
    },
  });

  const dismissResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/goal`,
    body: { action: 'dismiss-proposal' },
  });

  assert.equal(dismissResult.statusCode, 200);
  assert.equal(dismissResult.json.goal.status, 'complete');
  assert.equal(dismissResult.json.proposal, null);
  assert.equal(store.getConversation(conversation.id).metadata.sessionGoalProposal, undefined);
});

test('conversations controller rejects invalid session goal commands', async (t) => {
  const { handler, store } = createConversationsControllerHarness(t);
  const conversation = store.createConversation({
    id: 'goal-invalid-conversation',
    title: 'Goal Invalid Conversation',
  });

  await assert.rejects(
    () => invokeConversationsController(handler, {
      method: 'POST',
      pathname: `/api/conversations/${conversation.id}/goal`,
      body: { action: 'set', objective: '' },
    }),
    /Goal objective is required/u
  );

  await assert.rejects(
    () => invokeConversationsController(handler, {
      method: 'POST',
      pathname: `/api/conversations/${conversation.id}/goal`,
      body: { action: 'set', objective: 'x'.repeat(2001) },
    }),
    /Goal objective must be 2000 characters or fewer/u
  );

  await assert.rejects(
    () => invokeConversationsController(handler, {
      method: 'POST',
      pathname: `/api/conversations/${conversation.id}/goal`,
      body: { action: 'pause' },
    }),
    /No session goal is set/u
  );

  await assert.rejects(
    () => invokeConversationsController(handler, {
      method: 'POST',
      pathname: `/api/conversations/${conversation.id}/goal`,
      body: { action: 'unknown' },
    }),
    /Unsupported goal action/u
  );
});

test('conversations controller lists known Feishu chats by recent activity', async (t) => {
  const { handler, store } = createConversationsControllerHarness(t);
  const olderConversation = store.createConversation({
    id: 'feishu-known-chat-older',
    title: 'Older Feishu Chat',
  });
  const newerConversation = store.createConversation({
    id: 'feishu-known-chat-newer',
    title: 'Newer Feishu Chat',
  });
  store.createConversationChannelBinding({
    platform: 'feishu',
    externalChatId: 'oc-known-old',
    conversationId: olderConversation.id,
    metadata: { chatType: 'p2p' },
  });
  store.createConversationChannelBinding({
    platform: 'feishu',
    externalChatId: 'oc-known-new',
    conversationId: newerConversation.id,
    metadata: { chatType: 'group' },
  });
  store.db.prepare('UPDATE chat_conversations SET last_message_at = ?, updated_at = ? WHERE id = ?')
    .run('2026-04-20T10:00:00.000Z', '2026-04-20T10:00:00.000Z', olderConversation.id);
  store.db.prepare('UPDATE chat_conversations SET last_message_at = ?, updated_at = ? WHERE id = ?')
    .run('2026-04-21T10:00:00.000Z', '2026-04-21T10:00:00.000Z', newerConversation.id);

  const response = await invokeConversationsController(handler, {
    method: 'GET',
    pathname: '/api/channel-bindings/feishu',
  });

  assert.equal(response.handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json.chats.map((chat) => chat.chatId), ['oc-known-new', 'oc-known-old']);
  assert.equal(response.json.chats[0].conversationId, newerConversation.id);
  assert.equal(response.json.chats[0].conversationTitle, 'Newer Feishu Chat');
  assert.equal(response.json.chats[0].chatType, 'group');
  assert.equal(response.json.chats[0].lastActivityAt, '2026-04-21T10:00:00.000Z');
});

test('conversations controller binds an existing Feishu chat to the selected conversation', async (t) => {
  const { handler, store } = createConversationsControllerHarness(t);
  const firstConversation = store.createConversation({
    id: 'feishu-binding-source-conversation',
    title: 'Feishu Binding Source',
  });
  const targetConversation = store.createConversation({
    id: 'feishu-binding-target-conversation',
    title: 'Feishu Binding Target',
  });
  store.createConversationChannelBinding({
    platform: 'feishu',
    externalChatId: 'oc-bind-existing',
    conversationId: firstConversation.id,
    metadata: { chatType: 'p2p' },
  });

  const response = await invokeConversationsController(handler, {
    method: 'PUT',
    pathname: `/api/conversations/${encodeURIComponent(targetConversation.id)}/channel-bindings/feishu`,
    body: { chatId: 'oc-bind-existing' },
  });

  assert.equal(response.handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.moved, true);
  assert.equal(response.json.previousConversationId, firstConversation.id);
  assert.equal(response.json.binding.conversationId, targetConversation.id);
  assert.equal(response.json.binding.metadata.chatType, 'p2p');
  assert.equal(response.json.binding.metadata.manualBinding.source, 'web-ui');

  const persistedBinding = store.getConversationChannelBinding('feishu', 'oc-bind-existing');
  const bindingCount = store.db.prepare('SELECT COUNT(*) AS count FROM chat_channel_bindings').get().count;
  assert.equal(persistedBinding.conversationId, targetConversation.id);
  assert.equal(bindingCount, 1);
});

test('conversations controller rejects Feishu binding without chatId', async (t) => {
  const { handler, store } = createConversationsControllerHarness(t);
  const conversation = store.createConversation({
    id: 'feishu-binding-missing-chat-id',
    title: 'Feishu Binding Missing Chat Id',
  });

  await assert.rejects(
    () => invokeConversationsController(handler, {
      method: 'PUT',
      pathname: `/api/conversations/${encodeURIComponent(conversation.id)}/channel-bindings/feishu`,
      body: { chatId: '   ' },
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.issues[0].code, 'missing_chat_id');
      return true;
    }
  );
});

test('conversations controller rejects Feishu binding for unknown conversations', async (t) => {
  const { handler } = createConversationsControllerHarness(t);

  await assert.rejects(
    () => invokeConversationsController(handler, {
      method: 'PUT',
      pathname: '/api/conversations/feishu-binding-missing-conversation/channel-bindings/feishu',
      body: { chatId: 'oc-bind-missing-conversation' },
    }),
    (error) => {
      assert.equal(error.statusCode, 404);
      assert.equal(error.message, 'Conversation not found');
      return true;
    }
  );
});

test('conversations controller rejects Feishu binding while conversation has active work', async (t) => {
  const conversationId = 'feishu-binding-busy-conversation';
  const { handler, store } = createConversationsControllerHarness(t, {
    runtimePayload: {
      activeConversationIds: [conversationId],
      dispatchingConversationIds: [],
      conversationQueueDepths: {},
      agentSlotQueueDepths: {},
      activeTurns: [],
      activeAgentSlots: [],
    },
  });
  store.createConversation({
    id: conversationId,
    title: 'Feishu Binding Busy',
  });

  await assert.rejects(
    () => invokeConversationsController(handler, {
      method: 'PUT',
      pathname: `/api/conversations/${encodeURIComponent(conversationId)}/channel-bindings/feishu`,
      body: { chatId: 'oc-bind-busy' },
    }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.issues[0].code, 'conversation_busy');
      return true;
    }
  );

  assert.equal(store.getConversationChannelBinding('feishu', 'oc-bind-busy'), null);
});

test('conversations controller rejects Feishu binding while conversation has an active turn', async (t) => {
  const conversationId = 'feishu-binding-active-turn-conversation';
  const { handler, store } = createConversationsControllerHarness(t, {
    runtimePayload: {
      activeConversationIds: [],
      dispatchingConversationIds: [],
      conversationQueueDepths: {},
      agentSlotQueueDepths: {},
      activeTurns: [
        {
          conversationId,
          queueDepth: 0,
        },
      ],
      activeAgentSlots: [],
    },
  });
  store.createConversation({
    id: conversationId,
    title: 'Feishu Binding Active Turn',
  });

  await assert.rejects(
    () => invokeConversationsController(handler, {
      method: 'PUT',
      pathname: `/api/conversations/${encodeURIComponent(conversationId)}/channel-bindings/feishu`,
      body: { chatId: 'oc-bind-active-turn' },
    }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.issues[0].code, 'conversation_busy');
      assert.equal(error.issues[0].activeTurnCount, 1);
      return true;
    }
  );

  assert.equal(store.getConversationChannelBinding('feishu', 'oc-bind-active-turn'), null);
});

test('conversations controller rejects Feishu binding when target conversation is already bound elsewhere', async (t) => {
  const { handler, store } = createConversationsControllerHarness(t);
  const sourceConversation = store.createConversation({
    id: 'feishu-binding-conflict-source',
    title: 'Feishu Binding Conflict Source',
  });
  const targetConversation = store.createConversation({
    id: 'feishu-binding-conflict-target',
    title: 'Feishu Binding Conflict Target',
  });
  store.createConversationChannelBinding({
    platform: 'feishu',
    externalChatId: 'oc-bind-source',
    conversationId: sourceConversation.id,
  });
  store.createConversationChannelBinding({
    platform: 'feishu',
    externalChatId: 'oc-bind-target',
    conversationId: targetConversation.id,
  });

  await assert.rejects(
    () => invokeConversationsController(handler, {
      method: 'PUT',
      pathname: `/api/conversations/${encodeURIComponent(targetConversation.id)}/channel-bindings/feishu`,
      body: { chatId: 'oc-bind-source' },
    }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.issues[0].code, 'conversation_already_bound');
      return true;
    }
  );

  assert.equal(store.getConversationChannelBinding('feishu', 'oc-bind-source').conversationId, sourceConversation.id);
  assert.equal(store.getConversationChannelBinding('feishu', 'oc-bind-target').conversationId, targetConversation.id);
});

test('conversations controller rejects deleting queued conversations', async () => {
  const conversationId = 'queued-delete-conversation';
  let deleteCalled = false;
  const handler = createConversationsController({
    store: {
      getConversation(id) {
        return id === conversationId
          ? {
              id: conversationId,
              title: 'Queued delete conversation',
              type: 'standard',
              agents: [],
              messages: [],
            }
          : null;
      },
      deleteConversation() {
        deleteCalled = true;
      },
      listConversations() {
        return [];
      },
    },
    turnOrchestrator: {
      buildRuntimePayload() {
        return {
          activeConversationIds: [],
          dispatchingConversationIds: [],
          conversationQueueDepths: {
            [conversationId]: 1,
          },
        };
      },
      clearConversationState() {},
    },
    undercoverService: { deleteConversationState() {} },
    werewolfService: { deleteConversationState() {} },
    buildBootstrapPayload() {
      return { conversations: [], agents: [], runtime: {} };
    },
    modeStore: { get() { return null; } },
  });

  await assert.rejects(
    () => handler({
      req: { method: 'DELETE' },
      res: {},
      pathname: `/api/conversations/${encodeURIComponent(conversationId)}`,
      requestUrl: new URL(`http://127.0.0.1/api/conversations/${encodeURIComponent(conversationId)}`),
    }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /待处理消息|正在处理消息/u);
      return true;
    }
  );

  assert.equal(deleteCalled, false);
});

test('conversations controller force-deletes failed queued conversations when idle', async () => {
  const conversationId = 'failed-queued-delete-conversation';
  let deleteCalled = false;
  const handler = createConversationsController({
    store: {
      getConversation(id) {
        return id === conversationId
          ? {
              id: conversationId,
              title: 'Failed queued delete conversation',
              type: 'standard',
              agents: [],
              messages: [],
            }
          : null;
      },
      deleteConversation(id) {
        deleteCalled = id === conversationId;
      },
      listConversations() {
        return [];
      },
    },
    turnOrchestrator: {
      buildRuntimePayload() {
        return {
          activeConversationIds: [],
          dispatchingConversationIds: [],
          conversationQueueDepths: {
            [conversationId]: 2,
          },
          conversationQueueFailures: {
            [conversationId]: {
              failedBatchCount: 1,
              lastFailureAt: '2026-04-11T10:30:00.000Z',
              lastFailureMessage: 'Synthetic queued failure',
            },
          },
        };
      },
      clearConversationState() {},
    },
    undercoverService: { deleteConversationState() {} },
    werewolfService: { deleteConversationState() {} },
    buildBootstrapPayload() {
      return { conversations: [], agents: [], runtime: {} };
    },
    modeStore: { get() { return null; } },
  });

  const reqUrl = new URL(`http://127.0.0.1/api/conversations/${encodeURIComponent(conversationId)}?force=1`);
  const res = {
    writeHead() {},
    end() {},
  };

  const handled = await handler({
    req: { method: 'DELETE' },
    res,
    pathname: `/api/conversations/${encodeURIComponent(conversationId)}`,
    requestUrl: reqUrl,
  });

  assert.equal(handled, true);
  assert.equal(deleteCalled, true);
});

test('conversations controller rejects deleting conversations with active side slots', async () => {
  const conversationId = 'active-side-slot-delete-conversation';
  let deleteCalled = false;
  const handler = createConversationsController({
    store: {
      getConversation(id) {
        return id === conversationId
          ? {
              id: conversationId,
              title: 'Active side slot delete conversation',
              type: 'standard',
              agents: [],
              messages: [],
            }
          : null;
      },
      deleteConversation() {
        deleteCalled = true;
      },
      listConversations() {
        return [];
      },
    },
    turnOrchestrator: {
      buildRuntimePayload() {
        return {
          activeConversationIds: [],
          dispatchingConversationIds: [],
          conversationQueueDepths: {},
          agentSlotQueueDepths: {},
          activeAgentSlots: [
            {
              slotId: 'slot-1',
              conversationId,
              agentId: 'agent-b',
              agentName: 'Beta',
              status: 'running',
            },
          ],
        };
      },
      clearConversationState() {},
    },
    undercoverService: { deleteConversationState() {} },
    werewolfService: { deleteConversationState() {} },
    buildBootstrapPayload() {
      return { conversations: [], agents: [], runtime: {} };
    },
    modeStore: { get() { return null; } },
  });

  await assert.rejects(
    () => handler({
      req: { method: 'DELETE' },
      res: {},
      pathname: `/api/conversations/${encodeURIComponent(conversationId)}`,
      requestUrl: new URL(`http://127.0.0.1/api/conversations/${encodeURIComponent(conversationId)}`),
    }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /待处理消息|正在处理消息/u);
      return true;
    }
  );

  assert.equal(deleteCalled, false);
});

test('conversations controller rejects deleting conversations with queued agent slot work', async () => {
  const conversationId = 'queued-side-slot-delete-conversation';
  let deleteCalled = false;
  const handler = createConversationsController({
    store: {
      getConversation(id) {
        return id === conversationId
          ? {
              id: conversationId,
              title: 'Queued side slot delete conversation',
              type: 'standard',
              agents: [],
              messages: [],
            }
          : null;
      },
      deleteConversation() {
        deleteCalled = true;
      },
      listConversations() {
        return [];
      },
    },
    turnOrchestrator: {
      buildRuntimePayload() {
        return {
          activeConversationIds: [],
          dispatchingConversationIds: [],
          conversationQueueDepths: {},
          agentSlotQueueDepths: {
            [conversationId]: {
              'agent-b': 1,
            },
          },
          activeAgentSlots: [],
        };
      },
      clearConversationState() {},
    },
    undercoverService: { deleteConversationState() {} },
    werewolfService: { deleteConversationState() {} },
    buildBootstrapPayload() {
      return { conversations: [], agents: [], runtime: {} };
    },
    modeStore: { get() { return null; } },
  });

  await assert.rejects(
    () => handler({
      req: { method: 'DELETE' },
      res: {},
      pathname: `/api/conversations/${encodeURIComponent(conversationId)}`,
      requestUrl: new URL(`http://127.0.0.1/api/conversations/${encodeURIComponent(conversationId)}`),
    }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /待处理消息|正在处理消息/u);
      return true;
    }
  );

  assert.equal(deleteCalled, false);
});

test('server smoke: bootstrap, static files, projects, skills, agents, and conversations work', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const port = await findFreePort();
  const tempDir = withTempDir('caff-m0-');
  const sqlitePath = path.join(tempDir, 'smoke.sqlite');
  const child = spawn(process.execPath, ['build/lib/app-server.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      CHAT_APP_HOST: '127.0.0.1',
      CHAT_APP_PORT: String(port),
      PI_CODING_AGENT_DIR: tempDir,
      PI_SQLITE_PATH: sqlitePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrText = '';
  child.stderr.on('data', (chunk) => {
    stderrText += String(chunk);
  });

  t.after(async () => {
    await stopServer(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, child);

  const homeResponse = await fetch(baseUrl);
  assert.equal(homeResponse.status, 200);
  assert.match(homeResponse.headers.get('content-type') || '', /text\/html/);

  const sharedResponse = await fetch(`${baseUrl}/shared/api-client.js`);
  assert.equal(sharedResponse.status, 200);
  assert.match(sharedResponse.headers.get('content-type') || '', /javascript/);

  const casebookResponse = await fetch(`${baseUrl}/eval-cases.html`);
  assert.equal(casebookResponse.status, 200);
  assert.match(casebookResponse.headers.get('content-type') || '', /text\/html/);

  const bootstrap = await fetchJson(baseUrl, '/api/bootstrap');
  assert.ok(Array.isArray(bootstrap.conversations), `Expected conversations to be an array, got ${typeof bootstrap.conversations}`);
  assert.ok(Array.isArray(bootstrap.agents), `Expected agents to be an array, got ${typeof bootstrap.agents}`);
  assert.ok(Array.isArray(bootstrap.skills), `Expected skills to be an array, got ${typeof bootstrap.skills}`);

  const metrics = await fetchJson(baseUrl, '/api/metrics/agent');
  assert.ok(Array.isArray(metrics.agents), `Expected metrics.agents to be an array, got ${typeof metrics.agents}`);
  assert.ok(Array.isArray(metrics.tools), `Expected metrics.tools to be an array, got ${typeof metrics.tools}`);

  const evalCases = await fetchJson(baseUrl, '/api/eval-cases');
  assert.ok(Array.isArray(evalCases.cases), `Expected evalCases.cases to be an array, got ${typeof evalCases.cases}`);

  const projects = await fetchJson(baseUrl, '/api/projects');
  assert.ok(Array.isArray(projects.projects));
  assert.ok(projects.projects.length >= 1);
  assert.ok(projects.projects.some((project) => project && project.active));

  const createdProject = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST',
    body: {
      name: 'Smoke Project',
      path: tempDir,
    },
  });
  assert.equal(createdProject.activeProject.path, tempDir);

  const skillPayload = {
    name: 'Smoke Skill',
    description: 'Created by the M0 smoke test',
    body: 'Use this skill for smoke testing only.',
  };
  const skillResult = await fetchJson(baseUrl, '/api/skills', {
    method: 'POST',
    body: skillPayload,
  });
  assert.equal(skillResult.skill.name, 'Smoke Skill');

  const agentResult = await fetchJson(baseUrl, '/api/agents', {
    method: 'POST',
    body: {
      name: 'Smoke Agent',
      description: 'Created by the M0 smoke test',
      personaPrompt: 'Reply briefly.',
      skillIds: [skillResult.skill.id],
    },
  });
  assert.equal(agentResult.agent.name, 'Smoke Agent');

  const conversationResult = await fetchJson(baseUrl, '/api/conversations', {
    method: 'POST',
    body: {
      title: 'Smoke Conversation',
      participants: [agentResult.agent.id],
    },
  });
  assert.equal(conversationResult.conversation.title, 'Smoke Conversation');
  assert.ok(Array.isArray(conversationResult.conversation.agents));
  assert.equal(conversationResult.conversation.agents[0].id, agentResult.agent.id);

  assert.equal(stderrText.trim(), '');
});

test('server smoke: pi-mono agent can initialize and write Trellis files for the active project', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('PI_COMMAND_PATH override fixture is currently exercised on Windows only');
    return;
  }

  if (!requireSpawn(t)) {
    return;
  }

  const port = await findFreePort();
  const tempDir = withTempDir('caff-pi-trellis-smoke-');
  const projectDir = path.join(tempDir, 'project');
  const sqlitePath = path.join(tempDir, 'pi-trellis-smoke.sqlite');
  fs.mkdirSync(projectDir, { recursive: true });

  const child = spawn(process.execPath, ['build/lib/app-server.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      CHAT_APP_HOST: '127.0.0.1',
      CHAT_APP_PORT: String(port),
      PI_CODING_AGENT_DIR: tempDir,
      PI_SQLITE_PATH: sqlitePath,
      PI_COMMAND_PATH: FAKE_PI_TRELLIS_TOOLS_PATH,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrText = '';
  child.stderr.on('data', (chunk) => {
    stderrText += String(chunk);
  });

  t.after(async () => {
    await stopServer(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, child);

  const projectResult = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST',
    body: {
      name: 'pi Trellis Smoke Project',
      path: projectDir,
    },
  });
  assert.equal(projectResult.activeProject.path, projectDir);

  const agentResult = await fetchJson(baseUrl, '/api/agents', {
    method: 'POST',
    body: {
      name: 'pi Trellis Smoke Agent',
      description: 'Executes Trellis tool smoke flow.',
      personaPrompt: 'Initialize Trellis for the active project and write a PRD.',
    },
  });

  const conversationResult = await fetchJson(baseUrl, '/api/conversations', {
    method: 'POST',
    body: {
      title: 'pi Trellis Smoke Conversation',
      participants: [agentResult.agent.id],
    },
  });

  const trellisDir = path.join(projectDir, '.trellis');
  const currentTaskPath = path.join(trellisDir, '.current-task');
  const prdPath = path.join(trellisDir, 'tasks', 'pi-tool-smoke', 'prd.md');
  const workflowPath = path.join(trellisDir, 'workflow.md');
  const taskJsonPath = path.join(trellisDir, 'tasks', 'pi-tool-smoke', 'task.json');

  const clientRequestId = 'smoke-client-request-id';
  const messageResult = await fetchJson(
    baseUrl,
    `/api/conversations/${encodeURIComponent(conversationResult.conversation.id)}/messages`,
    {
      method: 'POST',
      body: {
        content: 'Please initialize Trellis for the active project and write the PRD for a smoke task.',
        clientRequestId,
      },
    }
  );

  assert.match(String(messageResult.dispatch || ''), /^(started|queued)$/u);
  assert.equal(messageResult.acceptedMessage.role, 'user');
  assert.equal(messageResult.acceptedMessage.metadata.clientRequestId, clientRequestId);

  const completedConversation = await waitForCondition(async () => {
    if (!fs.existsSync(prdPath) || !fs.existsSync(taskJsonPath) || !fs.existsSync(workflowPath)) {
      return null;
    }

    const conversationPayload = await fetchJson(
      baseUrl,
      `/api/conversations/${encodeURIComponent(conversationResult.conversation.id)}?includePrivateMessages=1`
    );
    const assistantReplies = Array.isArray(conversationPayload.conversation && conversationPayload.conversation.messages)
      ? conversationPayload.conversation.messages.filter((message) => message && message.role === 'assistant')
      : [];

    return assistantReplies.some((message) => message.status === 'completed') ? conversationPayload.conversation : null;
  });

  const assistantReplies = completedConversation.messages.filter((message) => message && message.role === 'assistant');
  assert.ok(assistantReplies.length >= 1);
  assert.equal(assistantReplies[assistantReplies.length - 1].status, 'completed');

  assert.ok(fs.existsSync(trellisDir));
  assert.ok(fs.existsSync(workflowPath));
  assert.ok(fs.existsSync(taskJsonPath));
  assert.ok(fs.existsSync(prdPath));
  assert.equal(fs.readFileSync(currentTaskPath, 'utf8').trim(), '.trellis/tasks/pi-tool-smoke');
  assert.match(fs.readFileSync(prdPath, 'utf8'), /Verify that a pi-mono agent can call trellis-init and trellis-write/u);
  assert.equal(stderrText.trim(), '');
});
