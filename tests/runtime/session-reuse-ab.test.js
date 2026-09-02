const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { withTempDir } = require('../helpers/temp-dir');

// A/B regression for ADR 0001: the same room history is executed in fresh mode
// (flag OFF / no prior session) and reused mode (flag ON + reusable snapshot).
// Reused mode must resume the stored provider session with only the delta
// messages appended, while the legacy path must stay byte-identical and never
// touch the reuse store.

const PROVIDER = 'reuse-provider';
const MODEL = 'reuse-model';
const PROFILE_ID = 'reuse-profile';
const CONTEXT_WINDOW = 1000;
const LAST_CALL_INPUT_TOKENS = 100; // usage ratio 0.1, below the 0.5 threshold

function createRunHandle(reply, overrides = {}) {
  const handle = new EventEmitter();
  handle.runId = Object.hasOwn(overrides, 'runId') ? overrides.runId : 'run-reuse-ab';
  handle.sessionPath = '/tmp/reuse-ab/session.jsonl';
  const usageCall = {
    key: 'reuse-call-1',
    responseId: 'reuse-response-1',
    stopReason: 'stop',
    timestamp: 1,
    usage: { input: LAST_CALL_INPUT_TOKENS, output: 10, cacheRead: 0, totalTokens: LAST_CALL_INPUT_TOKENS + 10 },
  };
  handle.resultPromise = Promise.resolve({
    reply,
    runId: handle.runId,
    usage: usageCall.usage,
    usageCalls: [usageCall],
    heartbeatCount: 0,
    sessionPath: handle.sessionPath,
    assistantErrors: [],
    ...overrides,
  });
  return handle;
}

function createReuseState() {
  return { row: null, calls: [] };
}

// In-memory mirror of ChatSessionReuseRepository semantics (see
// storage/chat/session-reuse.repository.ts): claim is atomic and guarded by
// the expected static hash, poison keeps the row for audit, and markReusable
// upserts over any prior state (including poisoned).
function attachReuseStore(store, reuseState) {
  store.getAgentSessionReuse = () => {
    reuseState.calls.push(['get']);
    return reuseState.row ? { ...reuseState.row } : null;
  };
  store.claimAgentSessionReuse = (payload) => {
    reuseState.calls.push(['claim', payload]);
    if (typeof store.beforeReuseClaim === 'function') {
      const beforeClaim = store.beforeReuseClaim;
      store.beforeReuseClaim = null;
      beforeClaim(payload);
    }
    const row = reuseState.row;
    if (
      !row
      || row.state !== 'reusable'
      || row.staticSegmentHash !== payload.expectedHash
      || row.cursorMessageId !== payload.expectedCursorMessageId
      || row.cursorMessageCount !== payload.expectedCursorMessageCount
      || row.cursorFirstMessageId !== payload.expectedCursorFirstMessageId
      || row.cursorMaxUpdatedAt !== payload.expectedCursorMaxUpdatedAt
    ) {
      return null;
    }
    const messages = store.listMessages(row.conversationId);
    const cursorIndex = messages.findIndex((message) => message.id === row.cursorMessageId);
    const prefix = cursorIndex >= 0 ? messages.slice(0, cursorIndex + 1) : [];
    const maxUpdatedAt = prefix.reduce(
      (max, message) => String(message.updatedAt || message.createdAt || '') > max
        ? String(message.updatedAt || message.createdAt || '')
        : max,
      ''
    );
    if (
      prefix.length !== row.cursorMessageCount
      || !prefix[0]
      || prefix[0].id !== row.cursorFirstMessageId
      || maxUpdatedAt !== row.cursorMaxUpdatedAt
    ) {
      return null;
    }
    const snapshot = { ...row };
    reuseState.row = { ...row, state: 'busy', updatedAt: payload.now };
    return snapshot;
  };
  store.restoreAgentSessionReuse = (snapshot, now) => {
    reuseState.calls.push(['restore']);
    if (reuseState.row && reuseState.row.state === 'busy') {
      reuseState.row = { ...snapshot, state: 'reusable', updatedAt: now };
    }
  };
  store.markAgentSessionReuseReusable = (payload) => {
    reuseState.calls.push(['markReusable', payload]);
    reuseState.row = { ...payload, state: 'reusable', updatedAt: payload.now };
  };
  store.markAgentSessionReusePoisoned = (conversationId, agentId, profileId, reason, now) => {
    reuseState.calls.push(['markPoisoned', reason]);
    reuseState.row = {
      ...(reuseState.row || {}),
      conversationId,
      agentId,
      profileId,
      state: 'poisoned',
      poisonReason: reason,
      updatedAt: now,
    };
  };
  return store;
}

function createFakeStore(conversation, { withReuse = false } = {}) {
  let nextMessageIndex = 1;
  const messages = [];
  conversation.messages = messages;
  const messageWrites = { creates: [], updates: [] };
  const reuseState = createReuseState();

  const store = {
    messageWrites,
    reuseState,
    reuseCalls: reuseState.calls,
    peekReuseRow() {
      return reuseState.row ? { ...reuseState.row } : null;
    },
    seedReuseRow(row) {
      reuseState.row = { ...row };
    },
    createMessage(input) {
      const now = new Date().toISOString();
      messageWrites.creates.push(input);
      const message = {
        id: input.id || `message-${nextMessageIndex++}`,
        createdAt: now,
        updatedAt: now,
        ...input,
      };
      messages.push(message);
      return message;
    },
    updateMessage(messageId, patch) {
      messageWrites.updates.push({ messageId, patch });
      const message = messages.find((item) => item.id === messageId);
      assert.ok(message, `message ${messageId} should exist`);
      // Default updated_at bump, but an explicit patch.updatedAt wins so
      // fixtures can control the cursor-consistency timeline deterministically.
      Object.assign(message, { updatedAt: new Date().toISOString() }, patch);
      return { ...message };
    },
    getConversation(conversationId) {
      return conversationId === conversation.id ? conversation : null;
    },
    updateConversation(conversationId, patch) {
      assert.equal(conversationId, conversation.id);
      Object.assign(conversation, patch);
      return conversation;
    },
    listMessages(conversationId) {
      return conversationId === conversation.id ? messages.slice() : [];
    },
    listPrivateMessagesForAgent() {
      return [];
    },
    listVisibleMemoryCards() {
      return [];
    },
    getMessage(messageId) {
      return messages.find((item) => item.id === messageId) || null;
    },
  };

  return withReuse ? attachReuseStore(store, reuseState) : store;
}

function createFakeRunStore() {
  return {
    createTask() {},
    updateTask() {},
    appendTaskEvent() {},
    addArtifact() {},
  };
}

function createFakeAgentToolBridge() {
  return {
    createInvocationContext(input) {
      return input;
    },
    registerInvocation(context) {
      return {
        ...context,
        invocationId: 'invocation-reuse-ab',
        callbackToken: 'callback-reuse-ab',
        publicToolUsed: false,
        publicPostCount: 0,
        privatePostCount: 0,
        privateHandoffCount: 0,
        lastPublicContent: '',
      };
    },
    unregisterInvocation() {},
  };
}

function createAgent() {
  return {
    id: 'agent-reuse-ab',
    name: 'Reuse AB',
    description: 'A/B session reuse regression agent.',
    personaPrompt: 'Be brief.',
    runtimeConfig: {
      profileId: PROFILE_ID,
      profileName: 'Reuse profile',
      provider: PROVIDER,
      model: MODEL,
      thinking: 'low',
      personaPrompt: '',
      skillIds: [],
    },
  };
}

function createConversation(agent) {
  return {
    id: 'conversation-reuse-ab',
    title: 'Session reuse A/B',
    type: 'standard',
    agents: [agent],
    metadata: {},
  };
}

function seedUserMessage(store, id, content) {
  // Fixed timestamps keep the rendered history deterministic across runs so
  // the fresh/reused byte-parity assertion cannot be broken by wall clock.
  return store.createMessage({
    id,
    conversationId: store.getConversation('conversation-reuse-ab').id,
    role: 'user',
    senderName: 'User',
    content,
    status: 'completed',
    createdAt: `2026-09-02T10:00:0${id.slice(1)}.000Z`,
    updatedAt: `2026-09-02T10:00:0${id.slice(1)}.000Z`,
  });
}

function findAssistantCreate(store) {
  const create = store.messageWrites.creates.find((input) => input.role === 'assistant');
  assert.ok(create, 'assistant placeholder message should be created');
  return create;
}

async function runTurn({ executor, conversation, agent, store, turnId, reply = 'Done.' }) {
  const { createTurnState } = require(require.resolve('../../build/server/domain/conversation/turn/turn-state'));
  const turnState = createTurnState(conversation, turnId);
  await executor.executeConversationAgent({
    runStore: createFakeRunStore(),
    conversationId: conversation.id,
    turnId: turnState.turnId,
    rootTaskId: `root-${turnId}`,
    conversation,
    promptMessages: store.listMessages(conversation.id),
    promptUserMessage: { id: `trigger-${turnId}`, role: 'user', content: 'Go.' },
    queueItem: { triggerType: 'user', enqueueReason: 'user_message' },
    agent,
    turnState,
    completedReplies: [],
    failedReplies: [],
    routingMode: 'mention_queue',
    hop: 1,
    remainingSlots: 0,
    enqueueAgent() {},
    allowHandoffs: true,
    finalStopsTurn: true,
    projectDir: store.agentDir,
  });
}

function setupExecutorTest(t, { reuseEnabled }) {
  const tempDir = withTempDir('caff-session-reuse-ab-');
  const minimalPiPath = require.resolve('../../build/lib/minimal-pi');
  const agentExecutorPath = require.resolve('../../build/server/domain/conversation/turn/agent-executor');
  const minimalPi = require(minimalPiPath);
  const originalStartRun = minimalPi.startRun;
  const previousFlag = process.env.PI_CHAT_SESSION_REUSE_ENABLED;
  const captured = [];
  // agent-executor destructures startRun at module load, so install a stable
  // dispatcher BEFORE requiring it; createExecutor then swaps the impl.
  let startRunImpl = null;
  minimalPi.startRun = (...args) => startRunImpl(...args);

  if (reuseEnabled) {
    process.env.PI_CHAT_SESSION_REUSE_ENABLED = '1';
  } else {
    // Phase 2 default is ON, so an explicit off is required to exercise the
    // disabled path (ADR 0001).
    process.env.PI_CHAT_SESSION_REUSE_ENABLED = '0';
  }

  delete require.cache[agentExecutorPath];

  t.after(() => {
    minimalPi.startRun = originalStartRun;
    delete require.cache[agentExecutorPath];
    if (previousFlag === undefined) {
      delete process.env.PI_CHAT_SESSION_REUSE_ENABLED;
    } else {
      process.env.PI_CHAT_SESSION_REUSE_ENABLED = previousFlag;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { createAgentExecutor } = require(agentExecutorPath);

  return {
    tempDir,
    captured,
    createExecutor(store, { onStartRun, runId = 'run-reuse-ab' } = {}) {
      startRunImpl = (provider, model, prompt, options) => {
        const record = { provider, model, prompt, options };
        if (typeof onStartRun === 'function') {
          record.midRunReuseRow = onStartRun(record);
        }
        captured.push(record);
        return createRunHandle('Done.', { runId });
      };
      return createAgentExecutor({
        store,
        skillRegistry: { resolveSkills: () => [] },
        modeStore: { get: () => null },
        agentToolBridge: createFakeAgentToolBridge(),
        agentDir: tempDir,
        sqlitePath: path.join(tempDir, 'chat.sqlite'),
        toolBaseUrl: 'http://127.0.0.1:3100',
        agentToolScriptPath: path.join(tempDir, 'agent-chat-tools.js'),
        agentToolRelativePath: './lib/agent-chat-tools.js',
        modelCatalog: { getOptions: () => [{ provider: PROVIDER, model: MODEL, contextWindow: CONTEXT_WINDOW }] },
      });
    },
  };
}

test('flag OFF keeps the legacy fresh-session path byte-identical and never touches the reuse store', async (t) => {
  const env = setupExecutorTest(t, { reuseEnabled: false });

  // Store A: reuse-capable AND holding a reusable row. With the flag OFF the
  // executor must not even read it.
  const agentA = createAgent();
  const conversationA = createConversation(agentA);
  const storeA = createFakeStore(conversationA, { withReuse: true });
  storeA.agentDir = env.tempDir;
  seedUserMessage(storeA, 'u1', 'ALPHA-U1-CONTENT');
  seedUserMessage(storeA, 'u2', 'BRAVO-U2-CONTENT');
  storeA.seedReuseRow({
    conversationId: conversationA.id,
    agentId: agentA.id,
    profileId: PROFILE_ID,
    state: 'reusable',
    sessionName: 'chat-stale-session-that-must-be-ignored',
    sessionPath: '/tmp/reuse-ab/stale.jsonl',
    staticSegmentHash: 'any-hash',
    cursorMessageId: 'u2',
    cursorMessageCount: 2,
    cursorFirstMessageId: 'u1',
    cursorMaxUpdatedAt: null,
    usageRatio: 0.1,
    lastReplyAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const executorA = env.createExecutor(storeA);
  await runTurn({ executor: executorA, conversation: conversationA, agent: agentA, store: storeA, turnId: 'turn-parity' });

  assert.equal(env.captured.length, 1);
  const legacyRun = env.captured[0];
  assert.equal(legacyRun.options.resume, false);
  assert.match(legacyRun.options.session, /turn-parity/u);
  assert.match(legacyRun.prompt, /ALPHA-U1-CONTENT/u);
  assert.match(legacyRun.prompt, /BRAVO-U2-CONTENT/u);
  assert.deepEqual(storeA.reuseCalls, [], 'flag OFF must not touch the reuse store at all');
  const legacyMetadata = findAssistantCreate(storeA).metadata;
  assert.equal(legacyMetadata.sessionReused, false);
  assert.equal(legacyMetadata.sessionReuseReason, 'disabled');

  // Store B: flag ON but the store exposes no reuse API (legacy store shape).
  // Same turnId and fixtures; the rendered prompt must be byte-identical to
  // the flag-OFF run above. The flag is read at execution time, so toggling
  // the env between legs exercises both paths with one module instance.
  process.env.PI_CHAT_SESSION_REUSE_ENABLED = '1';
  const agentB = createAgent();
  const conversationB = createConversation(agentB);
  const storeB = createFakeStore(conversationB, { withReuse: false });
  storeB.agentDir = env.tempDir;
  seedUserMessage(storeB, 'u1', 'ALPHA-U1-CONTENT');
  seedUserMessage(storeB, 'u2', 'BRAVO-U2-CONTENT');

  const executorB = env.createExecutor(storeB);
  await runTurn({ executor: executorB, conversation: conversationB, agent: agentB, store: storeB, turnId: 'turn-parity' });

  assert.equal(env.captured.length, 2);
  assert.equal(env.captured[1].options.resume, false);
  assert.equal(
    env.captured[1].prompt,
    legacyRun.prompt,
    'flag OFF and legacy-store prompts must be byte-identical (no reuse drift in the legacy path)'
  );
});

test('reused mode resumes the stored session with only the delta appended and advances the cursor', async (t) => {
  const env = setupExecutorTest(t, { reuseEnabled: true });
  const agent = createAgent();
  const conversation = createConversation(agent);
  const store = createFakeStore(conversation, { withReuse: true });
  store.agentDir = env.tempDir;
  seedUserMessage(store, 'u1', 'ALPHA-U1-CONTENT');
  seedUserMessage(store, 'u2', 'BRAVO-U2-CONTENT');

  // Leg 1: no prior session -> fresh run persists a reusable snapshot.
  const executor1 = env.createExecutor(store);
  await runTurn({ executor: executor1, conversation, agent, store, turnId: 'turn-reuse-1' });

  assert.equal(env.captured.length, 1);
  const freshRun = env.captured[0];
  assert.equal(freshRun.options.resume, false);
  assert.match(freshRun.prompt, /ALPHA-U1-CONTENT/u);
  assert.match(freshRun.prompt, /BRAVO-U2-CONTENT/u);
  assert.equal(findAssistantCreate(store).metadata.sessionReused, false);
  assert.equal(findAssistantCreate(store).metadata.sessionReuseReason, 'no_prior_session');

  const callNames = store.reuseCalls.map(([name]) => name);
  assert.deepEqual(callNames, ['get', 'markReusable']);
  const snapshot = store.reuseCalls[1][1];
  assert.equal(snapshot.sessionName, freshRun.options.session);
  assert.equal(snapshot.sessionPath, '/tmp/reuse-ab/session.jsonl');
  assert.equal(snapshot.usageInputTokens, LAST_CALL_INPUT_TOKENS);
  assert.equal(snapshot.usageContextWindow, CONTEXT_WINDOW);
  assert.equal(snapshot.usageRatio, LAST_CALL_INPUT_TOKENS / CONTEXT_WINDOW);
  const firstAssistantId = findAssistantCreate(store).id;
  assert.equal(snapshot.cursorMessageId, firstAssistantId);
  assert.equal(snapshot.cursorMessageCount, 3, 'cursor covers u1, u2, and the completed assistant reply');
  assert.equal(snapshot.cursorFirstMessageId, 'u1');
  assert.ok(snapshot.staticSegmentHash);

  // Leg 2: a new user message arrives; the stored session must be claimed
  // (reusable -> busy) before startRun and resumed with only the delta.
  seedUserMessage(store, 'u3', 'DELTA-U3-CONTENT');
  const executor2 = env.createExecutor(store, {
    onStartRun: () => {
      const busyRow = store.peekReuseRow();
      seedUserMessage(store, 'u4', 'ARRIVED-DURING-RUN');
      return busyRow;
    },
  });
  await runTurn({ executor: executor2, conversation, agent, store, turnId: 'turn-reuse-2' });

  assert.equal(env.captured.length, 2);
  const reusedRun = env.captured[1];
  assert.equal(reusedRun.midRunReuseRow.state, 'busy', 'claim flips the row to busy before the provider run starts');
  assert.equal(reusedRun.options.session, freshRun.options.session, 'resumed session keeps the original session name');
  assert.equal(reusedRun.options.resume, true);
  assert.ok(
    reusedRun.prompt.startsWith('New messages since your last reply:'),
    `reused prompt should be the delta envelope, got: ${reusedRun.prompt.slice(0, 120)}`
  );
  assert.match(reusedRun.prompt, /DELTA-U3-CONTENT/u);
  assert.equal(reusedRun.prompt.includes('ALPHA-U1-CONTENT'), false, 'delta prompt must not re-inject old history');
  assert.equal(reusedRun.prompt.includes('BRAVO-U2-CONTENT'), false, 'delta prompt must not re-inject old history');

  const assistantCreates = store.messageWrites.creates.filter((input) => input.role === 'assistant');
  assert.equal(assistantCreates.length, 2);
  assert.equal(assistantCreates[1].metadata.sessionReused, true);
  assert.equal(assistantCreates[1].metadata.sessionReuseReason, 'reused');
  assert.equal(assistantCreates[1].metadata.sessionName, freshRun.options.session);

  const leg2CallNames = store.reuseCalls.slice(2).map(([name]) => name);
  assert.deepEqual(leg2CallNames, ['get', 'claim', 'markReusable']);
  const claim = store.reuseCalls[3][1];
  assert.deepEqual(
    {
      cursorMessageId: claim.expectedCursorMessageId,
      cursorMessageCount: claim.expectedCursorMessageCount,
      cursorFirstMessageId: claim.expectedCursorFirstMessageId,
      cursorMaxUpdatedAt: claim.expectedCursorMaxUpdatedAt,
    },
    {
      cursorMessageId: snapshot.cursorMessageId,
      cursorMessageCount: snapshot.cursorMessageCount,
      cursorFirstMessageId: snapshot.cursorFirstMessageId,
      cursorMaxUpdatedAt: snapshot.cursorMaxUpdatedAt,
    }
  );
  const advanced = store.reuseCalls[4][1];
  assert.equal(advanced.sessionName, freshRun.options.session, 'session identity survives across reused turns');
  assert.equal(advanced.cursorMessageId, assistantCreates[1].id);
  assert.equal(advanced.cursorMessageCount, 5, 'cursor covers only u1, u2, a1, u3, and a2');
  assert.equal(advanced.cursorFirstMessageId, 'u1');
  assert.equal(advanced.staticSegmentHash, snapshot.staticSegmentHash, 'static segments unchanged across turns');

  // u4 arrived after the resumed prompt was assembled. It must remain beyond
  // the committed cursor and appear in the next resumed delta.
  const executor3 = env.createExecutor(store);
  await runTurn({ executor: executor3, conversation, agent, store, turnId: 'turn-reuse-3' });

  assert.equal(env.captured.length, 3);
  assert.equal(env.captured[2].options.resume, true);
  assert.match(env.captured[2].prompt, /ARRIVED-DURING-RUN/u);
  assert.equal(env.captured[2].prompt.includes('DELTA-U3-CONTENT'), false);
});

test('routing executor can reuse after a fresh run with more than 24 stored messages', async (t) => {
  const env = setupExecutorTest(t, { reuseEnabled: true });
  const agent = createAgent();
  const conversation = createConversation(agent);
  const store = createFakeStore(conversation, { withReuse: true });
  store.agentDir = env.tempDir;
  store.listPromptMessages = (conversationId, options = {}) => {
    const messages = store.listMessages(conversationId);
    const selectedIds = new Set(
      (Array.isArray(options.requiredMessageIds) ? options.requiredMessageIds : [])
        .map((messageId) => String(messageId || '').trim())
        .filter(Boolean)
    );
    const historyLimit = Number(options.historyLimit) || 0;
    if (historyLimit > 0) {
      for (const message of messages.slice(-historyLimit)) {
        selectedIds.add(message.id);
      }
    }
    if (options.currentTurnId) {
      for (const message of messages) {
        if (message.turnId === options.currentTurnId) {
          selectedIds.add(message.id);
        }
      }
    }
    return messages.filter((message) => selectedIds.has(message.id));
  };

  for (let index = 1; index <= 30; index += 1) {
    seedUserMessage(store, `u${index}`, `HISTORY-${String(index).padStart(2, '0')}`);
  }

  const agentExecutor = env.createExecutor(store, { runId: null });
  const { createRoutingExecutor } = require(
    require.resolve('../../build/server/domain/conversation/turn/routing-executor')
  );
  const routingExecutor = createRoutingExecutor({
    store,
    executeConversationAgent: agentExecutor.executeConversationAgent,
    agentDir: env.tempDir,
    sqlitePath: path.join(env.tempDir, 'routing.sqlite'),
    activeConversationIds: new Set(),
    activeTurns: new Map(),
  });

  await routingExecutor(conversation.id, {
    content: 'FIRST-ROUTED-MESSAGE',
    initialAgentIds: [agent.id],
    executionMode: 'queue',
    allowHandoffs: false,
  });

  assert.equal(env.captured[0].options.resume, false);
  assert.equal(env.captured[0].prompt.includes('HISTORY-01'), false, 'routing history remains bounded');
  assert.match(env.captured[0].prompt, /FIRST-ROUTED-MESSAGE/u);
  const freshSnapshot = store.peekReuseRow();
  assert.equal(freshSnapshot.cursorFirstMessageId, 'u1');
  assert.equal(freshSnapshot.cursorMessageCount, 32, 'cursor covers 30 stored messages, routed input, and reply');

  await routingExecutor(conversation.id, {
    content: 'DELTA-AFTER-BOUNDED-FRESH',
    initialAgentIds: [agent.id],
    executionMode: 'queue',
    allowHandoffs: false,
  });

  assert.equal(env.captured[1].options.resume, true, 'real bounded orchestration must remain cursor-compatible');
  assert.match(env.captured[1].prompt, /DELTA-AFTER-BOUNDED-FRESH/u);
  assert.equal(env.captured[1].prompt.includes('HISTORY-30'), false);
});

test('cursor edit between evaluation and claim poisons the cached session and runs fresh', async (t) => {
  const env = setupExecutorTest(t, { reuseEnabled: true });
  const agent = createAgent();
  const conversation = createConversation(agent);
  const store = createFakeStore(conversation, { withReuse: true });
  store.agentDir = env.tempDir;
  seedUserMessage(store, 'u1', 'ALPHA-U1-CONTENT');

  const executor1 = env.createExecutor(store);
  await runTurn({ executor: executor1, conversation, agent, store, turnId: 'turn-claim-race-1' });
  seedUserMessage(store, 'u2', 'DELTA-U2-CONTENT');
  store.beforeReuseClaim = () => {
    store.updateMessage('u1', {
      content: 'EDITED-BETWEEN-EVALUATION-AND-CLAIM',
      updatedAt: '2099-01-01T00:00:00.000Z',
    });
  };

  const executor2 = env.createExecutor(store);
  await runTurn({ executor: executor2, conversation, agent, store, turnId: 'turn-claim-race-2' });

  assert.equal(env.captured[1].options.resume, false);
  const assistantCreates = store.messageWrites.creates.filter((input) => input.role === 'assistant');
  assert.equal(assistantCreates[1].metadata.sessionReuseReason, 'cursor_history_mutated');
  assert.deepEqual(
    store.reuseCalls.slice(2).map(([name]) => name),
    ['get', 'claim', 'get', 'markPoisoned', 'markReusable']
  );
});

test('stale busy state keeps busy_stale as the audited fallback reason', async (t) => {
  const env = setupExecutorTest(t, { reuseEnabled: true });
  const agent = createAgent();
  const conversation = createConversation(agent);
  const store = createFakeStore(conversation, { withReuse: true });
  store.agentDir = env.tempDir;
  seedUserMessage(store, 'u1', 'ALPHA-U1-CONTENT');

  const executor1 = env.createExecutor(store);
  await runTurn({ executor: executor1, conversation, agent, store, turnId: 'turn-stale-1' });
  store.seedReuseRow({
    ...store.peekReuseRow(),
    state: 'busy',
    updatedAt: '2000-01-01T00:00:00.000Z',
  });
  seedUserMessage(store, 'u2', 'DELTA-AFTER-STALE-BUSY');

  const executor2 = env.createExecutor(store);
  await runTurn({ executor: executor2, conversation, agent, store, turnId: 'turn-stale-2' });

  assert.equal(env.captured[1].options.resume, false);
  const assistantCreates = store.messageWrites.creates.filter((input) => input.role === 'assistant');
  assert.equal(assistantCreates[1].metadata.sessionReuseReason, 'busy_stale');
  assert.deepEqual(store.reuseCalls.slice(2).map(([name]) => name), ['get', 'markPoisoned', 'markReusable']);
});

test('per-agent toggle off skips reuse entirely while the global flag stays on', async (t) => {
  const env = setupExecutorTest(t, { reuseEnabled: true });
  const agent = { ...createAgent(), sessionReuseEnabled: false };
  const conversation = createConversation(agent);
  const store = createFakeStore(conversation, { withReuse: true });
  store.agentDir = env.tempDir;
  seedUserMessage(store, 'u1', 'ALPHA-U1-CONTENT');
  seedUserMessage(store, 'u2', 'BRAVO-U2-CONTENT');

  const executor = env.createExecutor(store);
  await runTurn({ executor, conversation, agent, store, turnId: 'turn-agent-off' });

  assert.equal(env.captured.length, 1);
  assert.equal(env.captured[0].options.resume, false);
  assert.match(env.captured[0].prompt, /ALPHA-U1-CONTENT/u);
  assert.deepEqual(store.reuseCalls, [], 'agent opt-out must not touch the reuse store at all');
  const metadata = findAssistantCreate(store).metadata;
  assert.equal(metadata.sessionReused, false);
  assert.equal(metadata.sessionReuseReason, 'agent_disabled');
});

test('edited history poisons the cached session and falls back to a fresh full-history run', async (t) => {
  const env = setupExecutorTest(t, { reuseEnabled: true });
  const agent = createAgent();
  const conversation = createConversation(agent);
  const store = createFakeStore(conversation, { withReuse: true });
  store.agentDir = env.tempDir;
  seedUserMessage(store, 'u1', 'ALPHA-U1-CONTENT');
  seedUserMessage(store, 'u2', 'BRAVO-U2-CONTENT');

  // Leg 1: establish the reusable snapshot.
  const executor1 = env.createExecutor(store);
  await runTurn({ executor: executor1, conversation, agent, store, turnId: 'turn-mutate-1' });
  const firstSessionName = env.captured[0].options.session;
  assert.equal(store.peekReuseRow().state, 'reusable');

  // Mutate an already-injected message (edit moves updated_at past the
  // snapshot's max), then add a new message. The cursor consistency check
  // must detect the edit, poison the session, and fall back to a fresh run
  // with the full (edited) history.
  store.updateMessage('u1', { content: 'ALPHA-U1-EDITED', updatedAt: '2026-09-02T11:00:00.000Z' });
  seedUserMessage(store, 'u3', 'DELTA-U3-CONTENT');
  const executor2 = env.createExecutor(store);
  await runTurn({ executor: executor2, conversation, agent, store, turnId: 'turn-mutate-2' });

  assert.equal(env.captured.length, 2);
  const fallbackRun = env.captured[1];
  assert.equal(fallbackRun.options.resume, false);
  assert.notEqual(fallbackRun.options.session, firstSessionName, 'fallback run uses a fresh session name');
  assert.match(fallbackRun.prompt, /ALPHA-U1-EDITED/u, 'fresh fallback injects the edited history');
  assert.match(fallbackRun.prompt, /BRAVO-U2-CONTENT/u);
  assert.match(fallbackRun.prompt, /DELTA-U3-CONTENT/u);

  const leg2CallNames = store.reuseCalls.slice(2).map(([name]) => name);
  assert.deepEqual(leg2CallNames, ['get', 'markPoisoned', 'markReusable']);
  assert.equal(store.reuseCalls[3][1], 'cursor_history_mutated');

  const assistantCreates = store.messageWrites.creates.filter((input) => input.role === 'assistant');
  assert.equal(assistantCreates[1].metadata.sessionReused, false);
  assert.equal(assistantCreates[1].metadata.sessionReuseReason, 'cursor_history_mutated');

  // The clean fresh run self-heals: markReusable upserts over the poisoned row.
  const healed = store.peekReuseRow();
  assert.equal(healed.state, 'reusable');
  assert.equal(healed.sessionName, fallbackRun.options.session);
  assert.equal(healed.cursorFirstMessageId, 'u1');
  assert.equal(healed.cursorMessageCount, 5, 'u1, u2, a1, u3, a2');
});
