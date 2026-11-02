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
  const { rejectWith = null, ...resultOverrides } = overrides;
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
  handle.resultPromise = rejectWith
    ? Promise.reject(rejectWith)
    : Promise.resolve({
        reply,
        runId: handle.runId,
        usage: usageCall.usage,
        usageCalls: [usageCall],
        heartbeatCount: 0,
        sessionPath: handle.sessionPath,
        assistantErrors: [],
        ...resultOverrides,
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
      || (row.goalId || null) !== (payload.expectedGoalId || null)
      || (row.goalRevision || null) !== (payload.expectedGoalRevision || null)
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
    const row = reuseState.row;
    // Mirror the repository's guarded upsert: a busy row belongs to the run
    // that claimed it, so a concurrent claim holding a different session name
    // is never released or replaced by another run's completion.
    if (row && row.state === 'busy' && row.sessionName !== payload.sessionName) {
      return null;
    }
    reuseState.row = { ...payload, state: 'reusable', updatedAt: payload.now };
    return reuseState.row;
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

function createFakeAgentToolBridge(releasedInvocations = []) {
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
    unregisterInvocation(invocationId) { releasedInvocations.push(invocationId); },
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

async function runTurn({ executor, conversation, agent, store, turnId, reply = 'Done.', promptUserMessage = null, persistedRunStore = null, onTurnState = null, projectDir = store.agentDir }) {
  const { createTurnState } = require(require.resolve('../../build/server/domain/conversation/turn/turn-state'));
  const turnState = createTurnState(conversation, turnId);
  if (onTurnState) onTurnState(turnState);
  const events = [];
  const failedReplies = [];
  const runStore = persistedRunStore || createFakeRunStore();
  const appendTaskEvent = runStore.appendTaskEvent.bind(runStore);
  runStore.appendTaskEvent = (...args) => { events.push(args); return appendTaskEvent(...args); };
  if (persistedRunStore) runStore.createTask({ taskId: `root-${turnId}`, kind: 'conversation_turn', status: 'running' });
  const outcome = await executor.executeConversationAgent({
    runStore,
    conversationId: conversation.id,
    turnId: turnState.turnId,
    rootTaskId: `root-${turnId}`,
    conversation,
    promptMessages: store.listMessages(conversation.id),
    promptUserMessage: promptUserMessage || { id: `trigger-${turnId}`, role: 'user', content: 'Go.' },
    queueItem: { triggerType: 'user', enqueueReason: 'user_message' },
    agent,
    turnState,
    completedReplies: [],
    failedReplies,
    routingMode: 'mention_queue',
    hop: 1,
    remainingSlots: 0,
    enqueueAgent() {},
    allowHandoffs: true,
    finalStopsTurn: true,
    projectDir,
  });
  return { outcome, turnState, events, failedReplies };
}

function setupExecutorTest(t, { reuseEnabled }) {
  const tempDir = withTempDir('caff-session-reuse-ab-');
  const minimalPiPath = require.resolve('../../build/lib/minimal-pi');
  const agentExecutorPath = require.resolve('../../build/server/domain/conversation/turn/agent-executor');
  const minimalPi = require(minimalPiPath);
  const originalStartRun = minimalPi.startRun;
  const previousFlag = process.env.PI_CHAT_SESSION_REUSE_ENABLED;
  const captured = [];
  const releasedInvocations = [];
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
    releasedInvocations,
    createExecutor(store, { onStartRun, badcaseCapture, runId = 'run-reuse-ab', reply = 'Done.', resultOverrides = {} } = {}) {
      startRunImpl = (provider, model, prompt, options) => {
        const record = { provider, model, prompt, options };
        if (typeof onStartRun === 'function') {
          record.midRunReuseRow = onStartRun(record);
        }
        captured.push(record);
        return createRunHandle(reply, { runId, ...resultOverrides });
      };
      return createAgentExecutor({
        store,
        skillRegistry: { resolveSkills: () => [] },
        modeStore: { get: () => null },
        agentToolBridge: createFakeAgentToolBridge(releasedInvocations),
        badcaseCapture,
        agentDir: tempDir,
        sqlitePath: path.join(tempDir, 'chat.sqlite'),
        toolBaseUrl: 'http://127.0.0.1:3100',
        agentToolScriptPath: path.join(tempDir, 'agent-chat-tools.js'),
        agentToolRelativePath: './lib/agent-chat-tools.js',
        modelCatalog: { getOptions: () => [{
          provider: PROVIDER, model: MODEL, contextWindow: CONTEXT_WINDOW,
          runtimeResolvable: true, supportedThinkingLevels: ['off', 'low'],
        }] },
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
  const reusedContextSnapshot = assistantCreates[1].contextSnapshot;
  assert.equal(reusedContextSnapshot.deliveryMode, 'resume');
  assert.equal(reusedContextSnapshot.sections.length, 1);
  assert.equal(reusedContextSnapshot.sections[0].sectionKey, 'session_delta');
  assert.equal(reusedContextSnapshot.sections[0].displayContent, reusedRun.prompt);
  assert.equal(reusedContextSnapshot.sections[0].displayContent.includes('ALPHA-U1-CONTENT'), false);
  assert.equal(reusedContextSnapshot.sections[0].displayContent.includes('BRAVO-U2-CONTENT'), false);
  assert.deepEqual(reusedContextSnapshot.retainedSessionPrefix, {
    sessionName: freshRun.options.session,
    staticSegmentHash: snapshot.staticSegmentHash,
    cursorMessageId: snapshot.cursorMessageId,
    cursorMessageCount: snapshot.cursorMessageCount,
    cursorFirstMessageId: snapshot.cursorFirstMessageId,
    cursorMaxUpdatedAt: snapshot.cursorMaxUpdatedAt,
    lastReplyAt: snapshot.lastReplyAt,
  });

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

// This is an executor wiring regression: capture and startRun are stubs. It
// does not validate session JSONL, archive bytes, run pi, or prove replayability.
test('resume capture matches the invocation before start; synchronous failure restores the claim and checkpoint link', async (t) => {
  for (const mode of ['success', 'throw-no-id', 'throw-with-id']) {
    await t.test(mode, async (t) => {
      const env = setupExecutorTest(t, { reuseEnabled: true });
      const { resolveSessionPath } = require('../../build/lib/minimal-pi');
      const agent = createAgent();
      const conversation = createConversation(agent);
      const store = createFakeStore(conversation, { withReuse: true });
      store.agentDir = env.tempDir;
      seedUserMessage(store, 'u1', 'HISTORICAL-CAPTURE-CONTENT');
      const captures = [];
      const starts = [];
      const order = [];
      const badcaseCapture = {
        captureTurnCheckpoint(input) {
          order.push('capture');
          captures.push({ input, reuseRow: store.peekReuseRow() });
          return { captured: true, checkpointId: `checkpoint-${captures.length}` };
        },
      };
      const executor1 = env.createExecutor(store, {
        badcaseCapture,
        onStartRun(record) { order.push('start'); starts.push(record); },
      });
      await runTurn({ executor: executor1, conversation, agent, store, turnId: 'turn-capture-fresh' });
      const saved = store.peekReuseRow();
      assert.equal(saved.state, 'reusable');
      const freshMessage = store.listMessages(conversation.id).find((m) => m.role === 'assistant');
      assert.equal(freshMessage.metadata.badcaseCheckpointId, 'checkpoint-1');

      seedUserMessage(store, 'u2', 'DELTA-CAPTURE-CONTENT');
      const reuseCallOffset = store.reuseCalls.length;
      const startError = new Error(`resume synchronous failure: ${mode}`);
      if (mode === 'throw-with-id') {
        startError.runId = 'run-resume-start-error';
        startError.sessionPath = resolveSessionPath(saved.sessionName, env.tempDir);
      }
      const executor2 = env.createExecutor(store, {
        badcaseCapture,
        onStartRun(record) {
          order.push('start');
          starts.push(record);
          if (mode !== 'success') throw startError;
        },
      });
      const result = await runTurn({ executor: executor2, conversation, agent, store, turnId: 'turn-capture-resume' });
      // Assertions stay outside stubs: the executor catches capture/start errors.
      // Throwing an assertion there could otherwise hide a failing observation.
      assert.deepEqual(order, ['capture', 'start', 'capture', 'start']);
      assert.equal(captures.length, 2);
      assert.equal(starts.length, 2);
      assert.equal(captures[0].input.deliveryMode, 'fresh');
      assert.equal(captures[0].input.sessionPath, '');
      // Use the installed ESM package identity, not a fixture-supplied version.
      assert.equal(captures[0].input.harness.configSnapshot.piVersion, 'pi:0.85.1');
      assert.equal(captures[0].input.prompt, starts[0].prompt);
      const input = captures[1].input;
      const run = starts[1];
      assert.equal(captures[1].reuseRow.state, 'busy');
      assert.equal(run.options.resume, true);
      assert.equal(run.options.session, saved.sessionName);
      assert.equal(input.deliveryMode, 'resume');
      assert.equal(input.harness.configSnapshot.deliveryMode, 'resume');
      assert.equal(input.sessionPath, resolveSessionPath(run.options.session, run.options.agentDir));
      assert.equal(input.prompt, run.prompt);
      assert.match(input.prompt, /DELTA-CAPTURE-CONTENT/u);
      assert.equal(input.prompt.includes('HISTORICAL-CAPTURE-CONTENT'), false);
      assert.deepEqual(input.images, run.options.images);
      const { resolveSdkStartConfig } = require('../../build/lib/minimal-pi');
      for (let i = 0; i < captures.length; i++) {
        assert.deepEqual(captures[i].input.harness.configSnapshot.sdkStartConfig,
          resolveSdkStartConfig(starts[i].provider, starts[i].model, starts[i].options));
      }
      assert.equal(input.runConfig.provider, run.provider);
      assert.equal(input.runConfig.model, run.model);
      assert.equal(input.conversationId, conversation.id);
      assert.equal(input.turnId, 'turn-capture-resume');
      assert.equal(input.agentId, agent.id);
      const message = store.listMessages(conversation.id).filter((m) => m.role === 'assistant').at(-1);
      assert.equal(message.metadata.badcaseCheckpointId, 'checkpoint-2');
      assert.equal(message.metadata.sessionReused, true);
      assert.equal(message.metadata.sessionName, saved.sessionName);
      assert.deepEqual(env.releasedInvocations, ['invocation-reuse-ab', 'invocation-reuse-ab']);
      assert.equal(result.turnState.runHandles.size, 0);
      const eventNames = result.events.map(([, name]) => name);
      const calls = store.reuseCalls.slice(reuseCallOffset).map(([name]) => name);
      if (mode === 'success') {
        assert.equal(message.status, 'completed');
        assert.deepEqual(calls, ['get', 'claim', 'markReusable']);
        assert.equal(result.failedReplies.length, 0);
        assert.equal(eventNames.includes('agent_reply_started'), true);
      } else {
        assert.equal(message.status, 'failed');
        assert.equal(message.errorMessage, startError.message);
        assert.equal(message.runId, startError.runId || null);
        assert.equal(message.metadata.sessionPath, startError.sessionPath || '');
        assert.equal(result.failedReplies.length, 1);
        assert.equal(result.failedReplies[0].id, message.id);
        assert.equal(eventNames.includes('agent_reply_started'), false);
        assert.equal(eventNames.includes('agent_reply_failed'), true);
        assert.deepEqual(calls, ['get', 'claim', 'restore']);
        const restored = store.peekReuseRow();
        // Only restore time may change; the previous cursor/hash/session/usage
        // must survive, rather than advancing or poisoning an unstarted run.
        assert.deepEqual({ ...restored, updatedAt: saved.updatedAt }, saved);
      }
    });
  }
});

test('SDK descriptor drift across awaited capture never associates a stale checkpoint, but does not block the turn', async t => {
  for (const delivery of ['fresh', 'resume']) for (const drift of [false, true]) {
    await t.test(`${delivery}/${drift ? 'drift' : 'unchanged'}`, async t => {
      const previous = process.env.PI_THINKING; process.env.PI_THINKING = '';
      t.after(() => { if (previous === undefined) delete process.env.PI_THINKING; else process.env.PI_THINKING = previous; });
      const env = setupExecutorTest(t, { reuseEnabled: true }), agent = createAgent(), conversation = createConversation(agent);
      agent.runtimeConfig.thinking = '';
      const store = createFakeStore(conversation, { withReuse: true }); store.agentDir = env.tempDir;
      seedUserMessage(store, 'u1', 'CONFIG-CAPTURE');
      if (delivery === 'resume') {
        await runTurn({ executor: env.createExecutor(store), conversation, agent, store, turnId: 'config-seed' });
        seedUserMessage(store, 'u2', 'CONFIG-DELTA');
      }
      let release, enter, snapshot;
      const pending = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { enter = resolve; });
      const executor = env.createExecutor(store, { badcaseCapture: { captureTurnCheckpoint(input) {
        snapshot = structuredClone(input.harness.configSnapshot.sdkStartConfig); enter(); return pending;
      } } });
      const running = runTurn({ executor, conversation, agent, store, turnId: 'config-await' });
      try { await entered; if (drift) process.env.PI_THINKING = 'high'; }
      finally { release({ captured: true, checkpointId: 'config-cp' }); }
      await running;
      const run = env.captured.at(-1), { resolveSdkStartConfig } = require('../../build/lib/minimal-pi');
      const current = resolveSdkStartConfig(run.provider, run.model, run.options);
      assert.equal(snapshot.resume, delivery === 'resume');
      assert.equal(snapshot.thinking, ''); assert.equal(current.thinking, drift ? 'high' : '');
      const message = store.listMessages(conversation.id).filter(m => m.role === 'assistant').at(-1);
      assert.equal(message.status, 'completed');
      assert.equal(message.metadata.badcaseCheckpointId || '', drift ? '' : 'config-cp');
      assert.equal(run.options.resume, delivery === 'resume');
    });
  }
});

test('pre-turn asynchronous capture settles before startRun and preserves fresh/resume, including stop while waiting', async (t) => {
  for (const delivery of ['fresh', 'resume']) {
    for (const mode of ['success', 'refusal', 'exception', 'empty', 'stop', 'stop-exception', 'stop-stage']) {
      await t.test(`${delivery}/${mode}`, async (t) => {
        const env = setupExecutorTest(t, { reuseEnabled: true });
        const agent = createAgent(), conversation = createConversation(agent);
        const worktree = path.join(env.tempDir, 'actual-worktree');
        fs.mkdirSync(worktree);
        conversation.worktreePath = path.join(env.tempDir, 'stale-room-root');
        const store = createFakeStore(conversation, { withReuse: true });
        // runTurn passes this fixture field as the execution projectDir, while
        // the real agent/session directory remains env.tempDir. The old test
        // labelled Room metadata "actual" but started the SDK in its parent.
        store.agentDir = worktree;
        seedUserMessage(store, 'u1', 'BEFORE-ASYNC-CAPTURE');
        let saved;
        if (delivery === 'resume') {
          await runTurn({ executor: env.createExecutor(store), conversation, agent, store, turnId: 'seed-async' });
          saved = store.peekReuseRow();
          seedUserMessage(store, 'u2', 'ASYNC-RESUME-DELTA');
        }
        const startCount = env.captured.length, releases = env.releasedInvocations.length;
        const reuseOffset = store.reuseCalls.length, order = [], observations = [];
        let enter, resolveCapture, rejectCapture, turnState;
        const entered = new Promise(resolve => { enter = resolve; });
        const pending = new Promise((resolve, reject) => { resolveCapture = resolve; rejectCapture = reject; });
        // Keep red-first runs from creating an unhandled rejection when the old
        // executor ignores this promise. The tested promise itself is unchanged.
        pending.catch(() => {});
        const executor = env.createExecutor(store, {
          badcaseCapture: { captureTurnCheckpoint(input) {
            observations.push(input); order.push('capture-enter'); enter(); return pending;
          } },
          onStartRun() { order.push('startRun'); },
        });
        const running = runTurn({ executor, conversation, agent, store, turnId: 'turn-async-capture',
          onTurnState(state) { turnState = state; } });
        let result;
        try {
          await entered;
          // Advance one event-loop turn, not a wall-clock timing assumption.
          await new Promise(resolve => setImmediate(resolve));
          assert.equal(env.captured.length, startCount, 'no provider run before capture settles');
          assert.deepEqual(order, ['capture-enter']);
          assert.equal(env.releasedInvocations.length, releases, 'callback remains registered while waiting');
          assert.equal(observations[0].targetDir, worktree, 'actual SDK cwd, not Room metadata or application/session dir');
          assert.equal(observations[0].targetDir, observations[0].harness.configSnapshot.sdkStartConfig.cwd);
          assert.equal(observations[0].deliveryMode, delivery);
          if (delivery === 'resume') assert.equal(store.peekReuseRow().state, 'busy');
        } finally {
          if (mode.startsWith('stop')) {
            const stoppedState = mode === 'stop-stage' ? turnState.agents.find(stage => stage.agentId === agent.id) : turnState;
            stoppedState.stopRequested = true; stoppedState.stopReason = 'test stop while capturing';
          }
          order.push('capture-settle');
          if (mode.endsWith('exception')) rejectCapture(new Error('synthetic asynchronous capture failure'));
          else resolveCapture(mode === 'empty' ? undefined : mode === 'refusal'
            ? { captured: false, checkpointId: 'must-not-associate', reason: 'synthetic_refusal' }
            : { captured: true, checkpointId: 'checkpoint-async' });
          result = await running;
        }
        const stopped = mode.startsWith('stop');
        assert.equal(env.captured.length, startCount + (stopped ? 0 : 1));
        assert.deepEqual(order, stopped ? ['capture-enter', 'capture-settle'] : ['capture-enter', 'capture-settle', 'startRun']);
        const message = store.listMessages(conversation.id).filter(m => m.role === 'assistant').at(-1);
        const hasCheckpoint = mode === 'success' || mode === 'stop' || mode === 'stop-stage';
        assert.equal(message.metadata.badcaseCheckpointId || '', hasCheckpoint ? 'checkpoint-async' : '');
        assert.equal(message.status, stopped ? 'failed' : 'completed');
        assert.equal(result.failedReplies.length, 0, 'user stop is cancellation, not a failed agent reply');
        assert.equal(result.turnState.failedCount, 0);
        assert.equal(result.turnState.runHandles.size, 0);
        assert.equal(env.releasedInvocations.length, releases + 1);
        assert.equal(result.events.some(([, name]) => name === 'agent_reply_started'), !stopped);
        if (stopped) {
          assert.equal(message.runId, null);
          assert.equal(message.errorMessage, 'Stopped before agent run started');
          assert.equal(result.outcome.terminationReason, mode === 'stop-stage' ? '' : 'stopped_by_user');
          assert.equal(result.outcome.stopTurn, mode !== 'stop-stage');
          if (delivery === 'resume') {
            assert.deepEqual(store.reuseCalls.slice(reuseOffset).map(([name]) => name), ['get', 'claim', 'restore']);
            assert.deepEqual({ ...store.peekReuseRow(), updatedAt: saved.updatedAt }, saved,
              'an unstarted resumed session is restored, not advanced or poisoned');
          }
        } else {
          const run = env.captured.at(-1);
          assert.equal(run.options.resume, delivery === 'resume');
          assert.equal(run.prompt, observations[0].prompt);
          assert.equal(observations[0].harness.configSnapshot.deliveryMode, delivery);
          if (delivery === 'resume') assert.equal(run.options.session, saved.sessionName);
        }
      });
    }
  }
});

// Internal Windows collector injection, not the management/service enable path.
test('Windows native composed collector publishes before real executor fresh/resume start and never associates failed publication',
  { skip: process.platform !== 'win32' }, async t => {
  const base = '../../build/server/domain/runtime/badcase-capture/';
  const { createBadcaseCaptureService } = require(base + 'index');
  const { createWindowsTurnCollector } = require(base + 'windows-turn-collector');
  const { resolveSessionPath } = require('../../build/lib/minimal-pi');
  const { execFileSync } = require('node:child_process');
  const digest = b => require('node:crypto').createHash('sha256').update(b).digest('hex');
  const env = setupExecutorTest(t, { reuseEnabled: true });
  const projectDir = path.join(env.tempDir, 'project'), captureRoot = path.join(env.tempDir, 'capture'), projectId = 'windows-fixture';
  fs.mkdirSync(projectDir); fs.mkdirSync(path.join(env.tempDir, 'named-sessions'));
  const git = (...args) => execFileSync('git', ['-C', projectDir, ...args], { windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(env.tempDir, 'absent-global'), GIT_TEMPLATE_DIR: '' } });
  git('init', '-q'); git('config', 'core.ignorecase', 'false'); fs.writeFileSync(path.join(projectDir, 'file.txt'), 'before fresh'); git('add', 'file.txt');
  const agent = createAgent(), conversation = createConversation(agent);
  conversation.projectId = projectId; conversation.worktreePath = projectDir;
  const store = createFakeStore(conversation, { withReuse: true }); store.agentDir = projectDir;
  seedUserMessage(store, 'u1', 'WINDOWS-COMPOSED-FRESH');
  const service = createBadcaseCaptureService({ captureRoot });
  service.savePolicy(projectId, { authorizedDirs: [projectDir], authorizedInputDirs: [env.tempDir], excludedPatterns: [] });
  const policy = service.authorizeProject(projectId); assert.equal(policy.status, 'disabled');
  // Explicit synthetic writer setup only; public Windows enable gate is unchanged.
  service.store.savePolicy({ ...policy, status: 'enabled' });
  const nativeCollector = createWindowsTurnCollector({ store: service.store }), pendingCaptures = [];
  const collector = { captureTurnCheckpoint(input) { const pending = nativeCollector.captureTurnCheckpoint(input); pendingCaptures.push(pending); return pending; } };
  const bytes = Buffer.from([{ type: 'session', version: 3, id: 's', cwd: projectDir },
    { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'fixture history', timestamp: 1 } }].map(x => JSON.stringify(x)).join('\r\n') + '\r\n');
  const seen = [];
  const observe = record => {
    const cp = service.store.loadLatestCheckpoint(projectId, projectDir); assert.ok(cp, 'manifest on disk before startRun');
    assert.equal(cp.replayInput.deliveryMode, record.options.resume ? 'resume' : 'fresh');
    assert.equal(cp.replayInput.complete, false); assert.equal(cp.strictEvalEligible, false);
    assert.equal(cp.files['file.txt'].hash, digest(record.options.resume ? 'before resume' : 'before fresh'));
    assert.equal(cp.turnId, record.options.resume ? 'win-resume' : 'win-fresh');
    if (record.options.resume) assert.deepEqual(service.store.readBlob(projectId, cp.replayInput.sessionBlobHash), bytes);
    else fs.writeFileSync(resolveSessionPath(record.options.session, record.options.agentDir), bytes);
    fs.writeFileSync(path.join(projectDir, 'file.txt'), record.options.resume ? 'after resume' : 'before resume');
    seen.push(cp);
  };
  for (const [index, mode] of ['fresh', 'resume'].entries()) {
    if (index) seedUserMessage(store, 'u2', 'WINDOWS-COMPOSED-DELTA');
    await runTurn({ executor: env.createExecutor(store, { badcaseCapture: collector, onStartRun: observe }), conversation, agent, store, turnId: `win-${mode}` });
    await Promise.all(pendingCaptures); // Drain even a deliberately mutated executor before fixture cleanup.
    const message = store.listMessages(conversation.id).filter(m => m.role === 'assistant').at(-1);
    assert.equal(message.status, 'completed', message.metadata?.errorMessage); assert.equal(message.metadata.badcaseCheckpointId, seen[index].checkpointId);
  }
  const old = service.store.loadLatestCheckpoint(projectId, projectDir), save = service.store.saveCheckpoint;
  service.store.saveCheckpoint = () => { throw Error('PRIVATE_WRITE_SENTINEL'); };
  seedUserMessage(store, 'u3', 'WINDOWS-PUBLICATION-FAILURE');
  try {
    await runTurn({ executor: env.createExecutor(store, { badcaseCapture: collector, onStartRun: () => {
      assert.equal(service.store.loadLatestCheckpoint(projectId, projectDir).checkpointId, old.checkpointId);
      assert.equal(service.store.loadPolicy(projectId).status, 'suspended');
    } }), conversation, agent, store, turnId: 'win-failed-publication' });
  } finally { await Promise.all(pendingCaptures); service.store.saveCheckpoint = save; }
  const failedCaptureMessage = store.listMessages(conversation.id).filter(m => m.role === 'assistant').at(-1);
  assert.equal(failedCaptureMessage.status, 'completed'); assert.equal(failedCaptureMessage.metadata.badcaseCheckpointId || '', '');
  assert.equal(JSON.stringify(failedCaptureMessage).includes('PRIVATE_WRITE_SENTINEL'), false);
  assert.equal(env.captured.length, 3); assert.equal(fs.existsSync(path.join(captureRoot, 'projects', projectId, '.writer-lock')), false);
});

// Real collector/CAS/helper/restore, synthetic session and mock startRun/store.
// This closes the wiring-to-archive gap, not real pi/DB replay acceptance.
test('real capture service archives pre-start fresh/resume inputs and survives restart', { skip: require('../helpers/capture-capability').capSkip }, async (t) => {
  const { createBadcaseCaptureService } = require('../../build/server/domain/runtime/badcase-capture');
  const { resolveSessionPath } = require('../../build/lib/minimal-pi');
  const { createHash } = require('node:crypto');
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  for (const mode of ['archived', 'missing-session', 'unauthorized-session']) {
    await t.test(mode, async (t) => {
      const env = setupExecutorTest(t, { reuseEnabled: true });
      const projectId = 'project-real-capture';
      const projectDir = path.join(env.tempDir, 'project');
      const sessionDir = path.join(env.tempDir, 'named-sessions');
      const captureRoot = path.join(env.tempDir, 'capture');
      fs.mkdirSync(projectDir);
      fs.mkdirSync(sessionDir);
      fs.writeFileSync(path.join(projectDir, 'file.txt'), 'before fresh');
      const agent = createAgent();
      const conversation = createConversation(agent);
      conversation.projectId = projectId;
      conversation.worktreePath = projectDir;
      const store = createFakeStore(conversation, { withReuse: true });
      store.agentDir = projectDir;
      seedUserMessage(store, 'u1', 'HISTORICAL-REAL-CAPTURE');
      const sessionBytes = Buffer.from([
        JSON.stringify({ type: 'session', version: 3, id: 'synthetic-session' }),
        JSON.stringify({ type: 'message', id: 'm1', parentId: 'synthetic-session', message: {
          role: 'user', content: [{ type: 'text', text: 'ARCHIVED-HISTORY-BEFORE-RESUME' }],
        } }), '',
      ].join('\n'));
      let service = createBadcaseCaptureService({ captureRoot });
      service.savePolicy(projectId, {
        status: 'enabled', authorizedDirs: [projectDir], authorizedInputDirs: [sessionDir],
      });
      service.authorizeProject(projectId);
      const observations = [];
      let sessionPath;
      const observeStart = (record) => {
        // Observe persisted bytes before the mock runtime writes anything.
        const checkpoint = service.store.loadLatestCheckpoint(projectId, projectDir);
        observations.push({ checkpoint, record });
        sessionPath = resolveSessionPath(record.options.session, record.options.agentDir);
        if (!record.options.resume) fs.writeFileSync(sessionPath, sessionBytes);
        else fs.appendFileSync(sessionPath, 'POST-START-NOT-ARCHIVED\n');
        fs.writeFileSync(path.join(projectDir, 'file.txt'), record.options.resume ? 'after resume' : 'before resume');
      };
      await runTurn({ executor: env.createExecutor(store, { badcaseCapture: service, onStartRun: observeStart }),
        conversation, agent, store, turnId: 'turn-real-fresh' });
      assert.equal(observations.length, 1);
      const fresh = observations[0].checkpoint;
      assert.ok(fresh, 'real checkpoint must be on disk before startRun');
      assert.equal(fresh.replayInput.deliveryMode, 'fresh');
      // This store is an in-memory executor fake, not an authorized SQLite
      // callback source. File/session capture works; completeness must not lie.
      assert.equal(fresh.replayInput.complete, false);
      assert.deepEqual(fresh.replayInput.incompleteReasons, ['callback_input_unavailable']);
      assert.equal(fresh.replayInput.sessionBlobHash, '');
      assert.match(service.store.readBlob(projectId, fresh.replayInput.promptBlobHash).toString('utf8'), /HISTORICAL-REAL-CAPTURE/u);
      assert.equal(fresh.files['file.txt'].hash, digest('before fresh'));
      const freshMessage = store.listMessages(conversation.id).filter((m) => m.role === 'assistant').at(-1);
      assert.equal(freshMessage.status, 'completed');
      assert.equal(freshMessage.metadata.badcaseCheckpointId, fresh.checkpointId);
      const harness = JSON.parse(service.store.readBlob(projectId, fresh.replayInput.harness.configSnapshotHash));
      assert.equal(harness.piVersion, 'pi:0.85.1');

      // Recreate the service: policy/pins and prior manifest must come from disk.
      service = createBadcaseCaptureService({ captureRoot });
      if (mode === 'missing-session') fs.unlinkSync(sessionPath);
      if (mode === 'unauthorized-session') {
        service.savePolicy(projectId, { ...service.loadPolicy(projectId), authorizedInputDirs: [] });
      }
      seedUserMessage(store, 'u2', 'DELTA-REAL-CAPTURE');
      await runTurn({ executor: env.createExecutor(store, { badcaseCapture: service, onStartRun: observeStart }),
        conversation, agent, store, turnId: 'turn-real-resume' });
      assert.equal(observations.length, 2);
      const { checkpoint: resume, record } = observations[1];
      assert.ok(resume);
      assert.equal(record.options.resume, true, 'capture degradation must not change invocation mode');
      assert.equal(resume.replayInput.deliveryMode, 'resume');
      assert.equal(resume.replayInput.complete, false);
      assert.ok(resume.replayInput.incompleteReasons.includes('callback_input_unavailable'));
      if (mode === 'archived') assert.deepEqual(resume.replayInput.incompleteReasons, ['callback_input_unavailable']);
      assert.equal(resume.files['file.txt'].hash, digest('before resume'));
      assert.match(record.prompt, /DELTA-REAL-CAPTURE/u);
      assert.equal(record.prompt.includes('HISTORICAL-REAL-CAPTURE'), false);
      const archivedPrompt = service.store.readBlob(projectId, resume.replayInput.promptBlobHash).toString('utf8');
      assert.match(archivedPrompt, /DELTA-REAL-CAPTURE/u);
      assert.equal(archivedPrompt.includes('HISTORICAL-REAL-CAPTURE'), false);
      const finalMessage = store.listMessages(conversation.id).filter((m) => m.role === 'assistant').at(-1);
      assert.equal(finalMessage.status, 'completed');
      assert.equal(finalMessage.metadata.badcaseCheckpointId, resume.checkpointId);
      assert.equal(finalMessage.metadata.sessionReused, true);
      assert.equal(resume.conversationId, conversation.id);
      assert.equal(resume.turnId, 'turn-real-resume');
      assert.equal(resume.agentId, agent.id);
      if (mode === 'archived') {
        assert.equal(resume.replayInput.sessionBlobHash, digest(sessionBytes));
        assert.deepEqual(service.store.readBlob(projectId, resume.replayInput.sessionBlobHash), sessionBytes);
      } else {
        assert.equal(resume.replayInput.sessionBlobHash, '');
        assert.ok(resume.replayInput.incompleteReasons.includes(mode === 'missing-session' ? 'session_missing' : 'session_not_authorized'));
        assert.equal(service.store.hasBlob(projectId, digest(sessionBytes)), false);
      }
      // Post-start writes and service recreation cannot mutate archived bytes.
      const restarted = createBadcaseCaptureService({ captureRoot });
      assert.deepEqual(restarted.store.loadCheckpoint(projectId, resume.checkpointId), resume);
      for (const checkpoint of [fresh, resume]) {
        const restored = [1, 2].map((copy) => {
          const targetDir = path.join(env.tempDir, `${checkpoint.checkpointId}-${copy}`);
          const result = restarted.restoreCheckpoint({ projectId, checkpointId: checkpoint.checkpointId, targetDir });
          assert.equal(result.ok, true);
          assert.equal(result.replayInputComplete, false);
          assert.equal(result.strictEvalEligible, false);
          assert.equal(fs.readFileSync(path.join(targetDir, 'file.txt'), 'utf8'), checkpoint === fresh ? 'before fresh' : 'before resume');
          return result.restoredFiles;
        });
        assert.deepEqual(restored[0], restored[1]);
      }
      if (mode === 'archived') assert.deepEqual(restarted.store.readBlob(projectId, resume.replayInput.sessionBlobHash), sessionBytes);
    });
  }
});

// Same-process HTTP/controller + real Linux collector + real SQLite repositories
// and both sealing workers. Only startRun/bridge/model catalog are synthetic.
// This is not a real model invocation, browser test, or full app restart.
test('authorized capture to message seal survives SQLite/service reconstruction with real executor wiring', {
  skip: process.platform !== 'linux', timeout: 90000,
}, async t => {
  const http = require('node:http');
  const { spawnSync } = require('node:child_process');
  const { createHash } = require('node:crypto');
  const load = file => require('../../build/' + file);
  const { createChatAppStore } = load('lib/chat-app-store');
  const { createSqliteRunStore } = load('lib/sqlite-store');
  const { createBadcaseCaptureService } = load('server/domain/runtime/badcase-capture');
  const { createBadcaseCaptureController } = load('server/api/badcase-capture-controller');
  const { createBadcaseFlagsController } = load('server/api/badcase-flags-controller');
  const { createBadcaseFlagService } = load('server/domain/runtime/badcase-capture/badcase-flags');
  const { createBadcaseSealingService } = load('server/domain/runtime/badcase-capture/sealing-service');
  const { resolveSessionPath } = load('lib/minimal-pi');
  let chat, server;
  // Close DB/listener before setupExecutorTest removes its disposable directory.
  t.after(async () => { if (server?.listening) await new Promise(resolve => server.close(resolve)); chat?.close(); });
  const env = setupExecutorTest(t, { reuseEnabled: true });
  const projectId = 'project-capture-chain', agent = createAgent();
  const projectDir = path.join(env.tempDir, 'project'), captureRoot = path.join(env.tempDir, 'capture');
  const sessionDir = path.join(env.tempDir, 'named-sessions');
  fs.mkdirSync(projectDir); fs.mkdirSync(sessionDir);
  const target = path.join(projectDir, 'file.txt'); fs.writeFileSync(target, 'before fresh');
  const dbOptions = { agentDir: env.tempDir, sqlitePath: path.join(env.tempDir, 'chat.sqlite') };
  chat = createChatAppStore(dbOptions);
  let capture, captureController, flagsController, base;
  chat.saveCustomRoleConfig(agent);
  chat.createConversation({ id: 'conversation-reuse-ab', title: 'Synthetic capture chain', participants: [agent.id], projectScopeId: projectId });
  const conversation = { ...chat.getConversation('conversation-reuse-ab'), agents: [agent], worktreePath: projectDir };
  const rebuild = () => {
    capture = createBadcaseCaptureService({ captureRoot, chatStore: chat });
    const options = { projectManager: { listProjects: () => [{ id: projectId }] }, host: '127.0.0.1',
      getAuthority: () => new URL(base).host, csrfToken: 'synthetic-capture-chain' };
    captureController = createBadcaseCaptureController({ ...options, service: capture });
    const flags = createBadcaseFlagService({ captureRoot, captureStore: capture.store, chatStore: chat });
    flagsController = createBadcaseFlagsController({ ...options, service: flags,
      sealingService: createBadcaseSealingService({ flags, captureStore: capture.store, databasePath: dbOptions.sqlitePath }) });
  };
  server = http.createServer(async (req, res) => {
    try {
      const args = { req, res, pathname: new URL(req.url, base).pathname };
      if (await captureController(args) || await flagsController(args)) return;
      res.writeHead(404); res.end();
    } catch (e) { res.writeHead(e.statusCode || 500); res.end(JSON.stringify({ issues: e.issues || [] })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`; rebuild();
  const api = async (url, body, status = 200) => {
    const response = await fetch(base + url, body === undefined ? {} : { method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-caff-csrf-token': 'synthetic-capture-chain' }, body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
  };
  const endpoint = `/api/projects/${projectId}/badcase-capture`;
  assert.equal((await api(endpoint)).policy.status, 'disabled');
  await api(endpoint + '/authorize', { confirmed: true, authorizedDirs: [projectDir], authorizedInputDirs: [sessionDir],
    includedIgnoredPatterns: [], excludedPatterns: ['.git', 'node_modules'], callbackInputAuthorized: true });
  const estimate = await api(endpoint + '/estimate', {});
  assert.equal(estimate.complete, true); assert.equal(estimate.totalBytes, Buffer.byteLength('before fresh'));
  assert.equal(capture.loadPolicy(projectId).status, 'disabled');
  assert.equal(capture.store.listCheckpoints(projectId).length, 0);
  await api(endpoint + '/enable', { confirmed: true, estimateId: estimate.estimateId });
  assert.equal(capture.loadPolicy(projectId).status, 'enabled');
  const sessionBytes = Buffer.from(JSON.stringify({ type: 'session', version: 3, id: 'chain-session' }) + '\n'
    + JSON.stringify({ type: 'message', id: 'prior-user', parentId: 'chain-session', message: { role: 'user', content: [{ type: 'text', text: 'synthetic prior input' }] } }) + '\n');
  const observed = [], messages = [], seals = [];
  for (const [index, mode] of ['fresh', 'resume'].entries()) {
    const usageBefore = capture.computeUsage(projectId);
    const user = chat.createMessage({ id: `u${index + 1}`, conversationId: conversation.id, turnId: `accepted-${mode}`,
      role: 'user', status: 'completed', content: `synthetic input ${mode}` });
    const runStore = createSqliteRunStore({ agentDir: env.tempDir, db: chat.db });
    const executor = env.createExecutor(chat, { badcaseCapture: capture, runId: index + 1,
      onStartRun(record) {
        const checkpoint = capture.store.loadLatestCheckpoint(projectId, projectDir);
        // Collect observations here; assert outside startRun's caught error boundary.
        const sessionPath = resolveSessionPath(record.options.session, record.options.agentDir);
        const run = runStore.startRun({ ...record.options, provider: record.provider, model: record.model,
          prompt: record.prompt, cwd: projectDir, sessionPath, requestedSession: record.options.session, requestedResume: record.options.resume });
        runStore.finishRun(run.runId, { status: 'succeeded', reply: 'synthetic result', assistantErrors: [] });
        observed.push({ checkpoint, runId: run.runId, resume: record.options.resume, usage: capture.computeUsage(projectId) });
        if (index === 0) fs.writeFileSync(sessionPath, sessionBytes);
        else fs.appendFileSync(sessionPath, 'POST-START-NOT-ARCHIVED\n');
        fs.writeFileSync(target, index === 0 ? 'before resume' : 'after resume');
      } });
    await runTurn({ executor, conversation, agent, store: chat, projectDir, turnId: `chain-${mode}`, promptUserMessage: user, persistedRunStore: runStore });
    assert.equal(observed.length, index + 1);
    const observation = observed[index], cp = observation.checkpoint;
    assert.ok(cp, 'checkpoint must already exist before synthetic startRun');
    assert.equal(observation.runId, index + 1); assert.equal(observation.resume, index === 1,
      JSON.stringify(chat.listMessages(conversation.id).filter(m => m.role === 'assistant').at(-1)?.metadata));
    assert.equal(cp.replayInput.deliveryMode, mode); assert.equal(cp.replayInput.complete, true, JSON.stringify(cp.replayInput.incompleteReasons));
    const { readCapturedCallbackInput } = load('server/domain/runtime/badcase-capture/callback-input');
    const callback = readCapturedCallbackInput(cp, hash => capture.store.readBlob(projectId, hash));
    assert.equal(callback.association.userMessageId, user.id); assert.equal(callback.association.assistantMessageId,
      chat.listMessages(conversation.id).filter(m => m.role === 'assistant').at(-1).id);
    assert.equal(cp.files['file.txt'].hash, createHash('sha256').update(`before ${mode}`).digest('hex'));
    if (index === 1) assert.deepEqual(capture.store.readBlob(projectId, cp.replayInput.sessionBlobHash), sessionBytes);
    const message = chat.listMessages(conversation.id).filter(m => m.role === 'assistant').at(-1);
    assert.equal(message.status, 'completed'); assert.equal(message.runId, observation.runId);
    assert.equal(message.metadata.badcaseCheckpointId, cp.checkpointId);
    messages.push(message);
    const url = `/api/projects/${projectId}/conversations/${conversation.id}/messages/${message.id}/badcase-flag`;
    const body = { confirmed: true, actual: `synthetic ${mode} problem`, expected: 'synthetic expected behavior' };
    assert.equal((await api(url)).flag, null);
    const marked = await api(url, body, 201); seals.push(marked);
    assert.deepEqual(marked.flag.sealAssociation, { projectId, conversationId: conversation.id, messageId: message.id,
      turnId: message.turnId, agentId: agent.id, checkpointId: cp.checkpointId, taskId: message.taskId, runId: message.runId });
    assert.equal(marked.seal.state, 'saved_incomplete'); assert.equal(marked.seal.checkpointSaved, true);
    assert.equal(marked.seal.trajectory.reason, 'trajectory_provenance_unverified', 'real SQLite worker must validate direct associations, not fall back to unavailable');
    assert.ok(marked.seal.trajectory.totalTaskEventCount > 0);
    for (const key of ['captured', 'runnable', 'reproduced', 'evaluable', 'strictEvalEligible', 'complete']) assert.equal(marked.seal[key], false);
    const usage = capture.computeUsage(projectId);
    assert.equal(observation.usage.totalBytes - usageBefore.totalBytes, cp.stats.totalNewBytes);
    t.diagnostic(JSON.stringify({ mode, captureNewBytes: cp.stats.totalNewBytes, newBlobBytes: cp.stats.newBlobBytes,
      newManifestBytes: cp.stats.newManifestBytes, captureDurationMs: cp.stats.durationMs,
      sessionBytes: mode === 'resume' ? sessionBytes.length : 0, sealAndFlagNewBytes: usage.totalBytes - observation.usage.totalBytes,
      totalLogicalBytes: usage.totalBytes, synthetic: true, imageBytes: 0 }));
    const duplicate = await api(url, body);
    assert.equal(duplicate.created, false); assert.deepEqual(duplicate.seal, marked.seal);
    assert.deepEqual(capture.computeUsage(projectId), usage);
    // Close/reopen actual DB and recreate controllers, not in-memory mirrors.
    chat.close(); chat = createChatAppStore(dbOptions); rebuild();
    assert.deepEqual((await api(url)).seal, marked.seal);
    assert.deepEqual(chat.getMessage(message.id), message);
  }
  const cases = path.join(captureRoot, 'projects', projectId, 'cases');
  assert.equal(fs.readdirSync(cases).length, 2);
  assert.equal(fs.readdirSync(path.join(captureRoot, 'projects', projectId, 'retention')).length, 2);
  const usageBeforeReader = capture.computeUsage(projectId);
  // A separate Node process proves reads do not depend on parent caches.
  chat.close(); chat = null;
  const child = spawnSync(process.execPath, ['-e', `
    const {createChatAppStore}=require(${JSON.stringify(require.resolve('../../build/lib/chat-app-store'))});
    const {createCaptureStore}=require(${JSON.stringify(require.resolve('../../build/server/domain/runtime/badcase-capture/capture-store'))});
    const {createBadcaseFlagService}=require(${JSON.stringify(require.resolve('../../build/server/domain/runtime/badcase-capture/badcase-flags'))});
    const {createBadcaseSealingService}=require(${JSON.stringify(require.resolve('../../build/server/domain/runtime/badcase-capture/sealing-service'))});
    const chat=createChatAppStore(${JSON.stringify(dbOptions)}),captureStore=createCaptureStore({captureRoot:${JSON.stringify(captureRoot)}});
    try { const flags=createBadcaseFlagService({captureRoot:captureStore.captureRoot,captureStore,chatStore:chat});
      const service=createBadcaseSealingService({flags,captureStore,databasePath:${JSON.stringify(dbOptions.sqlitePath)}});
      process.stdout.write(JSON.stringify(${JSON.stringify(messages.map(m => ({ projectId, conversationId: conversation.id, messageId: m.id })))}.map(scope=>service.get(scope))));
    } finally { chat.close(); }
  `], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), seals.map(({ flag, seal }) => ({ flag, seal })));
  chat = createChatAppStore(dbOptions); rebuild();
  assert.deepEqual(capture.computeUsage(projectId), usageBeforeReader);
  await api(endpoint + '/disable', {});
  const beforeDisabled = capture.computeUsage(projectId), count = capture.store.listCheckpoints(projectId).length;
  const user = chat.createMessage({ id: 'u3', conversationId: conversation.id, role: 'user', status: 'completed', content: 'disabled synthetic turn' });
  await runTurn({ executor: env.createExecutor(chat, { badcaseCapture: capture, runId: 3 }), conversation, agent, store: chat, projectDir,
    turnId: 'chain-disabled', promptUserMessage: user });
  const disabledMessage = chat.listMessages(conversation.id).filter(m => m.role === 'assistant').at(-1);
  assert.equal(disabledMessage.metadata.badcaseCheckpointId, '');
  assert.equal(capture.store.listCheckpoints(projectId).length, count);
  assert.deepEqual(capture.computeUsage(projectId), beforeDisabled);
  const historical = chat.createMessage({ conversationId: conversation.id, agentId: agent.id, role: 'assistant', status: 'completed', content: 'historical synthetic message' });
  const historicalUrl = `/api/projects/${projectId}/conversations/${conversation.id}/messages/${historical.id}/badcase-flag`;
  const missing = await api(historicalUrl, { confirmed: true, actual: 'no checkpoint', expected: 'report missing' }, 201);
  assert.equal(missing.seal.state, 'unavailable'); assert.equal(missing.seal.checkpointSaved, false);
  assert.equal(fs.readdirSync(cases).length, 2, 'historical marker must not fabricate a case');
  for (const [index, cp] of observed.map(o => o.checkpoint).entries()) {
    const restored = capture.restoreCheckpoint({ projectId, checkpointId: cp.checkpointId, targetDir: path.join(env.tempDir, `restore-${index}`) });
    assert.equal(restored.ok, true);
    assert.equal(fs.readFileSync(path.join(env.tempDir, `restore-${index}/file.txt`), 'utf8'), index === 0 ? 'before fresh' : 'before resume');
  }
  // A complete collector input is NOT permission to drop the actual CAFF
  // bridge/replacements to fit the deliberately narrower model launcher.
  const { prepareOperator } = require('../../scripts/badcase-capture/model-evaluation-operator.cjs');
  const repo = path.resolve(__dirname, '../..');
  const sources = {
    runtimeArchive: require('../../scripts/badcase-capture/runtime-archive.cjs').archiveRuntime(repo, path.join(env.tempDir, 'runtime')),
    harnessArchive: require('../../scripts/badcase-capture/harness-archive.cjs').archiveHarness(repo, path.join(env.tempDir, 'harness')),
  };
  const model = { settings: { provider: 'synthetic', model: 'fixture', contextWindowTokens: 1000, maxOutputTokens: 100, temperature: 0,
    inputMicroUsdPerMillionTokens: 1000000, outputMicroUsdPerMillionTokens: 1000000, maxRequestBytes: 4096, maxResponseBytes: 4096 },
    endpoint: { hostname: 'api.example.com', address: '93.184.216.34', path: '/v1/chat/completions', timeoutMs: 1000, maxRequestBytes: 4096, maxResponseBytes: 4096 },
    maxRequests: 2, tools: [{ type: 'function', function: { name: 'read', description: 'synthetic', parameters: { type: 'object' } } }] };
  const operatorRoot = path.join(env.tempDir, 'never-approved-model-reviews');
  for (const [index, message] of messages.entries()) {
    const cp = observed[index].checkpoint, archived = JSON.stringify(cp);
    const harnessBytes = capture.store.readBlob(projectId, cp.replayInput.harness.configSnapshotHash);
    assert.equal(JSON.parse(harnessBytes).toolBridgeEnabled, true);
    // This synthetic bridge does not embed live callback values in the prompt;
    // its replacement list can be empty. The full executor configuration has
    // several unsupported dimensions; this is not an isolated bridge predicate
    // test (the independent diagnostic suite covers that guard).
    assert.ok(Array.isArray(cp.replayInput.controlledReplacements));
    assert.throws(() => prepareOperator({ root: operatorRoot, captureRoot,
      selection: { id: 'actual-executor-' + index, projectId, conversationId: conversation.id, messageId: message.id },
      image: { imageId: 'sha256:' + '1'.repeat(64), repositoryDigest: 'node@sha256:' + '2'.repeat(64), architecture: 'amd64', nodeVersion: 'v24.21.0', pythonVersion: 'Python 3.11.2' },
      sources, roles: { baseline: 'synthetic baseline', candidate: 'synthetic candidate' },
      rule: { expectedHash: createHash('sha256').update('done').digest('hex'), badcaseHash: createHash('sha256').update('draft').digest('hex') }, model,
      limits: { repetitions: 1, timeoutMs: 25000, perRunLimitMicroUsd: 2200, totalLimitMicroUsd: 4400 },
    }), /^Error: sdk_diagnostic_unsupported$/);
    assert.equal(JSON.stringify(capture.store.loadCheckpoint(projectId, cp.checkpointId)), archived);
    assert.deepEqual(capture.store.readBlob(projectId, cp.replayInput.harness.configSnapshotHash), harnessBytes);
    assert.deepEqual((await api(`/api/projects/${projectId}/conversations/${conversation.id}/messages/${message.id}/badcase-flag`)).seal, seals[index].seal);
  }
  assert.equal(fs.existsSync(operatorRoot), false, 'rejected preview must not create an approval or dispatch');
});

test('executor forwards Fast from the resolved config or selected profile, never falls back from profile false', async (t) => {
  const env = setupExecutorTest(t, { reuseEnabled: false });
  for (const [defaultFast, profileFast, resolvedFast, expected] of [
    [true, false, undefined, false], [false, true, undefined, true],
    [true, undefined, undefined, false], [true, true, false, false], [false, false, true, true],
  ]) {
    const agent = createAgent();
    if (resolvedFast === undefined) {
      Object.assign(agent, agent.runtimeConfig, { fast: defaultFast,
        selectedModelProfile: { ...agent.runtimeConfig, fast: profileFast },
      });
      delete agent.runtimeConfig;
    } else agent.runtimeConfig.fast = resolvedFast;
    const conversation = createConversation(agent);
    const store = createFakeStore(conversation);
    store.agentDir = env.tempDir;
    seedUserMessage(store, 'u1', 'Go.');
    await runTurn({ executor: env.createExecutor(store), conversation, agent, store, turnId: `forward-${env.captured.length}` });
    assert.equal(env.captured.at(-1).options.fast, expected);
  }
});

test('Fast toggles apply on the next turn without changing the legacy static fingerprint or session', async (t) => {
  const env = setupExecutorTest(t, { reuseEnabled: true });
  const agent = createAgent();
  const conversation = createConversation(agent);
  const store = createFakeStore(conversation, { withReuse: true });
  store.agentDir = env.tempDir;
  seedUserMessage(store, 'u1', 'Start.');
  await runTurn({ executor: env.createExecutor(store), conversation, agent, store, turnId: 'fast-1' });
  const initialHash = store.peekReuseRow().staticSegmentHash;
  const initialSession = env.captured[0].options.session;
  assert.equal(env.captured[0].options.fast, false, 'legacy config defaults off');
  for (const [index, fast] of [true, false, true].entries()) {
    agent.runtimeConfig.fast = fast;
    seedUserMessage(store, `u${index + 2}`, 'Continue.');
    await runTurn({ executor: env.createExecutor(store), conversation, agent, store, turnId: `fast-${index + 2}` });
    const captured = env.captured.at(-1);
    assert.equal(captured.options.fast, fast);
    assert.equal(captured.options.resume, true);
    assert.equal(captured.options.session, initialSession);
    assert.equal(store.peekReuseRow().staticSegmentHash, initialHash);
    const message = store.messageWrites.creates.filter((m) => m.role === 'assistant').at(-1);
    assert.equal(message.metadata.sessionReuseReason, 'reused');
  }
  // Shipping Fast must not change hashes even when the field is absent.
  const source = fs.readFileSync(path.resolve(__dirname, '../../server/domain/conversation/turn/agent-executor.ts'), 'utf8');
  assert.match(source, /computeStaticPromptHash\(promptSections, \[provider, model, reuseProfileId, thinking\]\)/u);
});

test('Goal Runner reuse requires matching Goal identity, revision, and usage below 50%', async (t) => {
  const env = setupExecutorTest(t, { reuseEnabled: true });
  const agent = createAgent();
  const conversation = createConversation(agent);
  conversation.metadata.sessionGoal = {
    goalId: 'goal-strict-a',
    revision: 3,
    objective: 'Continue only with proven Goal context',
    status: 'active',
    createdAt: '2026-09-02T09:00:00.000Z',
    updatedAt: '2026-09-02T09:00:00.000Z',
  };
  const store = createFakeStore(conversation, { withReuse: true });
  store.agentDir = env.tempDir;
  seedUserMessage(store, 'u1', 'START-STRICT-GOAL');

  await runTurn({
    executor: env.createExecutor(store),
    conversation,
    agent,
    store,
    turnId: 'turn-goal-fresh',
  });
  assert.equal(env.captured[0].options.resume, false);
  assert.equal(store.peekReuseRow().goalId, 'goal-strict-a');
  assert.equal(store.peekReuseRow().goalRevision, 3);

  const matchingGoalMessage = store.createMessage({
    id: 'goal-runner-1',
    conversationId: conversation.id,
    turnId: 'turn-goal-resume',
    role: 'user',
    senderName: 'Goal Runner',
    content: 'Continue Goal A revision 3',
    status: 'completed',
    metadata: {
      source: 'goal-runner',
      goalAutoContinue: true,
      goalId: 'goal-strict-a',
      goalRevision: 3,
    },
  });
  await runTurn({
    executor: env.createExecutor(store),
    conversation,
    agent,
    store,
    turnId: 'turn-goal-resume',
    promptUserMessage: matchingGoalMessage,
  });
  assert.equal(env.captured[1].options.resume, true);
  const assistantCreates = () => store.messageWrites.creates.filter((input) => input.role === 'assistant');
  assert.equal(assistantCreates()[1].metadata.goalAutoContinue, true);
  assert.equal(assistantCreates()[1].metadata.goalId, 'goal-strict-a');
  assert.equal(assistantCreates()[1].metadata.goalRevision, 3);

  conversation.metadata.sessionGoal = {
    ...conversation.metadata.sessionGoal,
    revision: 4,
    updatedAt: '2026-09-02T09:10:00.000Z',
  };
  const revisedGoalMessage = store.createMessage({
    id: 'goal-runner-2',
    conversationId: conversation.id,
    turnId: 'turn-goal-revision-fresh',
    role: 'user',
    senderName: 'Goal Runner',
    content: 'Continue Goal A revision 4',
    status: 'completed',
    metadata: {
      source: 'goal-runner',
      goalAutoContinue: true,
      goalId: 'goal-strict-a',
      goalRevision: 4,
    },
  });
  await runTurn({
    executor: env.createExecutor(store),
    conversation,
    agent,
    store,
    turnId: 'turn-goal-revision-fresh',
    promptUserMessage: revisedGoalMessage,
  });
  assert.equal(env.captured[2].options.resume, false);
  assert.equal(assistantCreates()[2].metadata.sessionReuseReason, 'goal_revision_mismatch');
  assert.equal(store.peekReuseRow().goalRevision, 4);

  store.seedReuseRow({ ...store.peekReuseRow(), usageRatio: 0.5 });
  const thresholdGoalMessage = store.createMessage({
    id: 'goal-runner-3',
    conversationId: conversation.id,
    turnId: 'turn-goal-threshold-fresh',
    role: 'user',
    senderName: 'Goal Runner',
    content: 'Continue at the strict usage boundary',
    status: 'completed',
    metadata: {
      source: 'goal-runner',
      goalAutoContinue: true,
      goalId: 'goal-strict-a',
      goalRevision: 4,
    },
  });
  await runTurn({
    executor: env.createExecutor(store),
    conversation,
    agent,
    store,
    turnId: 'turn-goal-threshold-fresh',
    promptUserMessage: thresholdGoalMessage,
  });
  assert.equal(env.captured[3].options.resume, false);
  assert.equal(assistantCreates()[3].metadata.sessionReuseReason, 'usage_ratio_above_threshold');

  store.seedReuseRow({ ...store.peekReuseRow(), goalId: 'another-goal', goalRevision: 99 });
  const humanMessage = store.createMessage({
    id: 'u-human-after-goal',
    conversationId: conversation.id,
    turnId: 'turn-human-normal-policy',
    role: 'user',
    senderName: 'User',
    content: 'A human follow-up keeps normal reuse rules',
    status: 'completed',
  });
  await runTurn({
    executor: env.createExecutor(store),
    conversation,
    agent,
    store,
    turnId: 'turn-human-normal-policy',
    promptUserMessage: humanMessage,
  });
  assert.equal(env.captured[4].options.resume, true);
  assert.equal(assistantCreates()[4].metadata.sessionReuseReason, 'reused');
  assert.equal(store.peekReuseRow().goalId, 'another-goal');
  assert.equal(store.peekReuseRow().goalRevision, 99);
});

test('reused delta applies the same private and incomplete-message visibility rules as fresh prompts', async (t) => {
  const env = setupExecutorTest(t, { reuseEnabled: true });
  const agent = createAgent();
  const conversation = createConversation(agent);
  const store = createFakeStore(conversation, { withReuse: true });
  store.agentDir = env.tempDir;
  seedUserMessage(store, 'u1', 'INITIAL-CONTENT');

  const executor1 = env.createExecutor(store);
  await runTurn({ executor: executor1, conversation, agent, store, turnId: 'turn-visibility-1' });

  const privateMessage = store.createMessage({
    id: 'private-other-agent',
    conversationId: conversation.id,
    role: 'user',
    senderName: 'Other agent',
    content: 'PRIVATE-DELTA-MUST-NOT-LEAK',
    status: 'completed',
    metadata: { privateOnly: true },
  });
  const visibleMessage = store.createMessage({
    id: 'visible-trigger',
    conversationId: conversation.id,
    turnId: 'turn-visibility-2',
    role: 'user',
    senderName: 'User',
    content: 'VISIBLE-DELTA-CONTENT',
    status: 'completed',
    metadata: { privateOnly: true },
  });
  const queuedAssistant = store.createMessage({
    id: 'queued-peer',
    conversationId: conversation.id,
    turnId: 'turn-visibility-2',
    role: 'assistant',
    agentId: 'peer-agent',
    senderName: 'Peer',
    content: 'QUEUED-PARTIAL-MUST-NOT-APPEAR',
    status: 'queued',
  });

  const executor2 = env.createExecutor(store);
  await runTurn({
    executor: executor2,
    conversation,
    agent,
    store,
    turnId: 'turn-visibility-2',
    promptUserMessage: { ...visibleMessage, content: 'VISIBLE-DELTA-CLEANED' },
  });

  const reusedRun = env.captured[1];
  assert.equal(reusedRun.options.resume, true);
  assert.match(reusedRun.prompt, /VISIBLE-DELTA-CLEANED/u);
  assert.equal(reusedRun.prompt.includes(visibleMessage.content), false, 'prompt user replacement must match fresh mode');
  assert.equal(reusedRun.prompt.includes(privateMessage.content), false, 'other private-only messages must stay hidden');
  assert.equal(reusedRun.prompt.includes(queuedAssistant.content), false, 'current-turn partial assistants must stay hidden');

  const persisted = store.peekReuseRow();
  const completedAssistants = store.messageWrites.creates.filter(
    (input) => input.role === 'assistant' && input.status === 'queued' && input.agentId === agent.id
  );
  assert.equal(completedAssistants.length, 2);
  assert.equal(persisted.cursorMessageCount, 6, 'storage cursor still covers hidden rows plus the completed reply');
  assert.equal(persisted.cursorMessageId, completedAssistants[1].id);

  // The prior run intentionally hid this private-only handoff while advancing
  // the storage cursor across it. When that message later becomes this run's
  // trigger, reused mode must restore the cleaned anchor just like fresh
  // routing's requiredMessageIds projection does. Add an unrelated post-cursor
  // message so reuse stays eligible; otherwise no_delta_messages safely falls
  // back to fresh mode before exercising the anchor-restoration path.
  seedUserMessage(store, 'u3', 'UNRELATED-LATER-DELTA');
  const executor3 = env.createExecutor(store);
  await runTurn({
    executor: executor3,
    conversation,
    agent,
    store,
    turnId: 'turn-visibility-3',
    promptUserMessage: { ...privateMessage, content: 'PRIVATE-HANDOFF-CLEANED' },
  });

  const handoffRun = env.captured[2];
  const handoffMetadata = store.messageWrites.creates.filter(
    (input) => input.role === 'assistant' && input.agentId === agent.id
  )[2].metadata;
  assert.equal(handoffRun.options.resume, true, `expected reuse, got ${handoffMetadata.sessionReuseReason}`);
  assert.match(handoffRun.prompt, /UNRELATED-LATER-DELTA/u);
  assert.match(handoffRun.prompt, /PRIVATE-HANDOFF-CLEANED/u);
  assert.equal(handoffRun.prompt.includes(privateMessage.content), false, 'raw private handoff text must be replaced');
  assert.equal(handoffRun.prompt.includes(visibleMessage.content), false, 'already-consumed public delta must not repeat');
});

test('executor-level private mailbox cursor is persisted and resumes only new authorized private messages', async (t) => {
  const env = setupExecutorTest(t, { reuseEnabled: true });
  const agent = createAgent();
  const conversation = createConversation(agent);
  const store = createFakeStore(conversation, { withReuse: true });
  store.agentDir = env.tempDir;

  const privateMailbox = [];
  const privateAfterCalls = [];
  const orderedVisiblePrivateMailbox = (agentId) => privateMailbox
    .filter((message) => (
      message
      && String(message.conversationId || '').trim() === conversation.id
      && Array.isArray(message.recipientAgentIds)
      && message.recipientAgentIds.includes(agentId)
    ))
    .sort((left, right) => {
      const leftCreatedAt = String(left.createdAt || '');
      const rightCreatedAt = String(right.createdAt || '');
      return leftCreatedAt === rightCreatedAt
        ? String(left.id || '').localeCompare(String(right.id || ''))
        : leftCreatedAt.localeCompare(rightCreatedAt);
    });

  store.listPrivateMessagesForAgent = (conversationId, agentId, { limit } = {}) => {
    if (conversationId !== conversation.id) {
      return [];
    }
    const ordered = orderedVisiblePrivateMailbox(agentId);
    const cap = Number.isInteger(limit) && limit > 0 ? limit : ordered.length;
    return ordered.slice(Math.max(ordered.length - cap, 0));
  };

  store.listPrivateMessagesForAgentAfter = (conversationId, agentId, { messageId, createdAt } = {}) => {
    if (conversationId !== conversation.id) {
      return [];
    }
    const cursorMessageId = String(messageId || '');
    const cursorCreatedAt = String(createdAt || '');
    privateAfterCalls.push({
      conversationId,
      agentId,
      cursorMessageId,
      cursorCreatedAt,
    });
    return orderedVisiblePrivateMailbox(agentId).filter((message) => {
      const messageCreatedAt = String(message.createdAt || '');
      const messageIdValue = String(message.id || '');
      return messageCreatedAt > cursorCreatedAt || (messageCreatedAt === cursorCreatedAt && messageIdValue > cursorMessageId);
    });
  };

  const addPrivateMailboxMessage = (input) => {
    privateMailbox.push({
      conversationId: conversation.id,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt || input.createdAt,
      senderAgentId: input.senderAgentId || null,
      senderName: input.senderName || 'Private Sender',
      recipientAgentIds: Array.isArray(input.recipientAgentIds) ? input.recipientAgentIds.slice() : [],
      content: input.content,
      id: input.id,
    });
  };

  const publicFresh = seedUserMessage(store, 'u1', 'PUBLIC-FRESH-1');
  addPrivateMailboxMessage({
    id: 'private-visible-1',
    senderAgentId: 'peer-agent-1',
    senderName: 'Peer One',
    recipientAgentIds: [agent.id],
    content: 'PRIVATE-OLD-1',
    createdAt: '2026-09-02T10:00:01.000Z',
  });
  addPrivateMailboxMessage({
    id: 'private-hidden-1',
    senderAgentId: 'peer-agent-hidden',
    senderName: 'Peer Hidden',
    recipientAgentIds: ['other-agent'],
    content: 'PRIVATE-HIDDEN-1',
    createdAt: '2026-09-02T10:00:02.000Z',
  });

  const executor1 = env.createExecutor(store);
  await runTurn({
    executor: executor1,
    conversation,
    agent,
    store,
    turnId: 'turn-private-cursor-1',
    promptUserMessage: publicFresh,
  });

  assert.equal(env.captured[0].options.resume, false);
  assert.match(env.captured[0].prompt, /PUBLIC-FRESH-1/u);
  assert.match(env.captured[0].prompt, /PRIVATE-OLD-1/u);
  assert.equal(env.captured[0].prompt.includes('PRIVATE-HIDDEN-1'), false, 'unauthorized private messages must stay hidden');
  assert.equal(env.captured[0].prompt.includes('Private mailbox visible only to you:'), true);
  const firstSnapshot = store.peekReuseRow();
  assert.equal(firstSnapshot.privateCursorInitialized, true);
  assert.equal(firstSnapshot.privateCursorMessageId, 'private-visible-1');
  assert.equal(firstSnapshot.privateCursorMessageCreatedAt, '2026-09-02T10:00:01.000Z');

  const publicResume = seedUserMessage(store, 'u2', 'PUBLIC-RESUME-2');
  addPrivateMailboxMessage({
    id: 'private-visible-2',
    senderAgentId: 'peer-agent-1',
    senderName: 'Peer One',
    recipientAgentIds: [agent.id],
    content: 'PRIVATE-NEW-2',
    createdAt: '2026-09-02T10:00:03.000Z',
  });
  addPrivateMailboxMessage({
    id: 'private-hidden-2',
    senderAgentId: 'peer-agent-hidden',
    senderName: 'Peer Hidden',
    recipientAgentIds: ['other-agent'],
    content: 'PRIVATE-HIDDEN-2',
    createdAt: '2026-09-02T10:00:04.000Z',
  });

  const executor2 = env.createExecutor(store, {
    onStartRun: () => {
      addPrivateMailboxMessage({
        id: 'private-visible-3',
        senderAgentId: 'peer-agent-1',
        senderName: 'Peer One',
        recipientAgentIds: [agent.id],
        content: 'PRIVATE-LATE-3',
        createdAt: '2026-09-02T10:00:05.000Z',
      });
    },
  });
  await runTurn({
    executor: executor2,
    conversation,
    agent,
    store,
    turnId: 'turn-private-cursor-2',
    promptUserMessage: publicResume,
  });

  assert.equal(env.captured[1].options.resume, true);
  assert.match(env.captured[1].prompt, /PUBLIC-RESUME-2/u);
  assert.match(env.captured[1].prompt, /PRIVATE-NEW-2/u);
  assert.equal(env.captured[1].prompt.includes('PRIVATE-OLD-1'), false, 'private delta must not repeat older mailbox messages');
  assert.equal(env.captured[1].prompt.includes('PRIVATE-HIDDEN-2'), false, 'unauthorized private messages must stay hidden');
  assert.equal(env.captured[1].prompt.includes('PRIVATE-LATE-3'), false, 'messages arriving during run must remain beyond the committed cursor');
  const secondSnapshot = store.peekReuseRow();
  assert.equal(secondSnapshot.privateCursorInitialized, true);
  assert.equal(secondSnapshot.privateCursorMessageId, 'private-visible-2');
  assert.equal(secondSnapshot.privateCursorMessageCreatedAt, '2026-09-02T10:00:03.000Z');

  const publicNext = seedUserMessage(store, 'u3', 'PUBLIC-AFTER-PRIVATE-3');
  const executor3 = env.createExecutor(store);
  await runTurn({
    executor: executor3,
    conversation,
    agent,
    store,
    turnId: 'turn-private-cursor-3',
    promptUserMessage: publicNext,
  });

  assert.equal(env.captured[2].options.resume, true);
  assert.match(env.captured[2].prompt, /PUBLIC-AFTER-PRIVATE-3/u);
  assert.match(env.captured[2].prompt, /PRIVATE-LATE-3/u);
  assert.equal(env.captured[2].prompt.includes('PRIVATE-NEW-2'), false, 'next run must advance past the prior private delta');
  const thirdSnapshot = store.peekReuseRow();
  assert.equal(thirdSnapshot.privateCursorInitialized, true);
  assert.equal(thirdSnapshot.privateCursorMessageId, 'private-visible-3');
  assert.equal(thirdSnapshot.privateCursorMessageCreatedAt, '2026-09-02T10:00:05.000Z');

  assert.equal(privateAfterCalls.length, 2);
  assert.deepEqual(privateAfterCalls[0], {
    conversationId: conversation.id,
    agentId: agent.id,
    cursorMessageId: 'private-visible-1',
    cursorCreatedAt: '2026-09-02T10:00:01.000Z',
  });
  assert.deepEqual(privateAfterCalls[1], {
    conversationId: conversation.id,
    agentId: agent.id,
    cursorMessageId: 'private-visible-2',
    cursorCreatedAt: '2026-09-02T10:00:03.000Z',
  });
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
  const firstReuseSnapshot = store.peekReuseRow();
  const editedAt = new Date(Date.parse(firstReuseSnapshot.cursorMaxUpdatedAt) + 1000).toISOString();
  store.updateMessage('u1', { content: 'ALPHA-U1-EDITED', updatedAt: editedAt });
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

test('clean empty final reply on a fresh run still fails the message but registers the session for reuse', async (t) => {
  const env = setupExecutorTest(t, { reuseEnabled: true });
  const agent = createAgent();
  const conversation = createConversation(agent);
  const store = createFakeStore(conversation, { withReuse: true });
  store.agentDir = env.tempDir;
  seedUserMessage(store, 'u1', 'ALPHA-U1-CONTENT');
  seedUserMessage(store, 'u2', 'BRAVO-U2-CONTENT');

  // Leg 1: the provider run ends cleanly (terminal assistant message, no open
  // tool calls) but the final reply is empty. The chat message must still
  // fail, while the session contents stay reusable.
  const executor1 = env.createExecutor(store, {
    reply: '',
    resultOverrides: {
      completionStopReason: 'stop',
      completionMessageKey: 'assistant-empty-1',
      openToolCallCount: 0,
      completionPersisted: true,
    },
  });
  await runTurn({ executor: executor1, conversation, agent, store, turnId: 'turn-empty-fresh-1' });

  const failedWrite = store.messageWrites.updates.find(({ patch }) => patch.status === 'failed');
  assert.ok(failedWrite, 'empty reply must still fail the chat message');
  assert.equal(failedWrite.patch.errorMessage, 'Empty agent reply');
  assert.equal(failedWrite.patch.metadata.invocationFailure.kind, 'unknown');
  assert.equal(failedWrite.patch.metadata.invocationFailure.eligible, false);

  const callNames = store.reuseCalls.map(([name]) => name);
  assert.deepEqual(callNames, ['get', 'markReusable'], 'clean empty reply must register the session instead of orphaning it');
  const snapshot = store.reuseCalls[1][1];
  const firstAssistantId = findAssistantCreate(store).id;
  assert.equal(snapshot.lastAssistantMessageId, firstAssistantId);
  assert.equal(snapshot.cursorMessageId, firstAssistantId);
  assert.equal(snapshot.cursorMessageCount, 3, 'cursor covers u1, u2, and the failed assistant reply');
  assert.equal(snapshot.usageInputTokens, LAST_CALL_INPUT_TOKENS);
  assert.equal(store.peekReuseRow().state, 'reusable');

  // Leg 2: the next turn must actually resume the same session with only the
  // new delta, instead of building yet another fresh session.
  seedUserMessage(store, 'u3', 'DELTA-U3-CONTENT');
  const executor2 = env.createExecutor(store);
  await runTurn({ executor: executor2, conversation, agent, store, turnId: 'turn-empty-fresh-2' });

  assert.equal(env.captured.length, 2);
  assert.equal(env.captured[1].options.resume, true);
  assert.equal(env.captured[1].options.session, env.captured[0].options.session);
  assert.match(env.captured[1].prompt, /DELTA-U3-CONTENT/u);
  assert.equal(env.captured[1].prompt.includes('ALPHA-U1-CONTENT'), false);
  const assistantCreates = store.messageWrites.creates.filter((input) => input.role === 'assistant');
  assert.equal(assistantCreates[1].metadata.sessionReused, true);
  assert.equal(assistantCreates[1].metadata.sessionReuseReason, 'reused');
});

test('clean empty final reply on a resumed run releases the claim back to reusable', async (t) => {
  const env = setupExecutorTest(t, { reuseEnabled: true });
  const agent = createAgent();
  const conversation = createConversation(agent);
  const store = createFakeStore(conversation, { withReuse: true });
  store.agentDir = env.tempDir;
  seedUserMessage(store, 'u1', 'ALPHA-U1-CONTENT');

  // Leg 1: establish the reusable snapshot with a normal reply.
  const executor1 = env.createExecutor(store);
  await runTurn({ executor: executor1, conversation, agent, store, turnId: 'turn-empty-resume-1' });
  const firstSessionName = env.captured[0].options.session;
  assert.equal(store.peekReuseRow().state, 'reusable');

  // Leg 2: resume, then end cleanly with an empty reply. The claim must
  // settle back to reusable for the same session, never poisoned.
  seedUserMessage(store, 'u2', 'DELTA-U2-CONTENT');
  const executor2 = env.createExecutor(store, {
    reply: '',
    resultOverrides: {
      completionStopReason: 'stop',
      completionMessageKey: 'assistant-empty-2',
      openToolCallCount: 0,
      completionPersisted: true,
    },
  });
  await runTurn({ executor: executor2, conversation, agent, store, turnId: 'turn-empty-resume-2' });

  assert.equal(env.captured[1].options.resume, true);
  const leg2CallNames = store.reuseCalls.slice(2).map(([name]) => name);
  assert.deepEqual(leg2CallNames, ['get', 'claim', 'markReusable']);
  const settledRow = store.peekReuseRow();
  assert.equal(settledRow.state, 'reusable');
  assert.equal(settledRow.sessionName, firstSessionName);
  const assistantCreates = store.messageWrites.creates.filter((input) => input.role === 'assistant');
  assert.equal(settledRow.cursorMessageId, assistantCreates[1].id);
  assert.equal(settledRow.cursorMessageCount, 4, 'cursor covers u1, a1, u2, and the failed a2');
  const failedWrite = store.messageWrites.updates.find(({ patch }) => patch.status === 'failed');
  assert.equal(failedWrite.patch.errorMessage, 'Empty agent reply');

  // Leg 3: the session survives the empty reply and resumes again.
  seedUserMessage(store, 'u3', 'DELTA-U3-CONTENT');
  const executor3 = env.createExecutor(store);
  await runTurn({ executor: executor3, conversation, agent, store, turnId: 'turn-empty-resume-3' });

  assert.equal(env.captured[2].options.resume, true);
  assert.equal(env.captured[2].options.session, firstSessionName);
  assert.match(env.captured[2].prompt, /DELTA-U3-CONTENT/u);
});

test('empty final reply without clean-completion evidence keeps the legacy protection', async (t) => {
  const env = setupExecutorTest(t, { reuseEnabled: true });
  const agent = createAgent();
  const conversation = createConversation(agent);
  const store = createFakeStore(conversation, { withReuse: true });
  store.agentDir = env.tempDir;
  seedUserMessage(store, 'u1', 'ALPHA-U1-CONTENT');

  // Leg 1: establish the reusable snapshot with a normal reply.
  const executor1 = env.createExecutor(store);
  await runTurn({ executor: executor1, conversation, agent, store, turnId: 'turn-empty-ungated-1' });
  assert.equal(store.peekReuseRow().state, 'reusable');

  // Leg 2: resumed run resolves with an empty reply but no terminal-message
  // evidence (no completionStopReason / openToolCallCount). The claim must be
  // poisoned exactly like before.
  seedUserMessage(store, 'u2', 'DELTA-U2-CONTENT');
  const executor2 = env.createExecutor(store, { reply: '' });
  await runTurn({ executor: executor2, conversation, agent, store, turnId: 'turn-empty-ungated-2' });

  assert.equal(env.captured[1].options.resume, true);
  const leg2CallNames = store.reuseCalls.slice(2).map(([name]) => name);
  assert.deepEqual(leg2CallNames, ['get', 'claim', 'markPoisoned']);
  assert.equal(store.peekReuseRow().state, 'poisoned');

  // Leg 3 (fresh): an empty reply without evidence must not register a new
  // session either; the poisoned row stays untouched.
  seedUserMessage(store, 'u3', 'DELTA-U3-CONTENT');
  const executor3 = env.createExecutor(store, { reply: '' });
  await runTurn({ executor: executor3, conversation, agent, store, turnId: 'turn-empty-ungated-3' });

  assert.equal(env.captured[2].options.resume, false);
  const leg3CallNames = store.reuseCalls.slice(5).map(([name]) => name);
  assert.deepEqual(leg3CallNames, ['get'], 'fresh empty reply without evidence must not touch the row');
  assert.equal(store.peekReuseRow().state, 'poisoned');
});

test('contradictory tool evidence (open tool calls at terminal stop) blocks empty-reply registration', async (t) => {
  const env = setupExecutorTest(t, { reuseEnabled: true });
  const agent = createAgent();
  const conversation = createConversation(agent);
  const store = createFakeStore(conversation, { withReuse: true });
  store.agentDir = env.tempDir;
  seedUserMessage(store, 'u1', 'ALPHA-U1-CONTENT');

  const executor1 = env.createExecutor(store, {
    reply: '',
    resultOverrides: {
      completionStopReason: 'stop',
      completionMessageKey: 'assistant-empty-tools-open',
      openToolCallCount: 1,
    },
  });
  await runTurn({ executor: executor1, conversation, agent, store, turnId: 'turn-empty-open-tools' });

  const failedWrite = store.messageWrites.updates.find(({ patch }) => patch.status === 'failed');
  assert.ok(failedWrite);
  assert.equal(failedWrite.patch.errorMessage, 'Empty agent reply');
  assert.deepEqual(
    store.reuseCalls.map(([name]) => name),
    ['get'],
    'open tool calls at run end must keep the session unregistered'
  );
  assert.equal(store.peekReuseRow(), null);
});

test('empty final reply without parent-verified persistence keeps the legacy protection', async (t) => {
  const env = setupExecutorTest(t, { reuseEnabled: true });
  const agent = createAgent();
  const conversation = createConversation(agent);
  const store = createFakeStore(conversation, { withReuse: true });
  store.agentDir = env.tempDir;
  seedUserMessage(store, 'u1', 'ALPHA-U1-CONTENT');

  // Leg 1: establish the reusable snapshot with a normal reply.
  const executor1 = env.createExecutor(store);
  await runTurn({ executor: executor1, conversation, agent, store, turnId: 'turn-empty-unverified-1' });
  assert.equal(store.peekReuseRow().state, 'reusable');

  // Leg 2 (resume): terminal-message evidence is present, but the runtime did
  // NOT verify the session artifact (completionPersisted absent — e.g. the
  // child died before appendMessage, or the tail did not match). The claim
  // must be poisoned exactly like any other unproven interruption.
  seedUserMessage(store, 'u2', 'DELTA-U2-CONTENT');
  const executor2 = env.createExecutor(store, {
    reply: '',
    resultOverrides: {
      completionStopReason: 'stop',
      completionMessageKey: 'assistant-unverified-1',
      openToolCallCount: 0,
    },
  });
  await runTurn({ executor: executor2, conversation, agent, store, turnId: 'turn-empty-unverified-2' });

  assert.equal(env.captured[1].options.resume, true);
  const leg2CallNames = store.reuseCalls.slice(2).map(([name]) => name);
  assert.deepEqual(leg2CallNames, ['get', 'claim', 'markPoisoned']);
  assert.equal(store.peekReuseRow().state, 'poisoned');
  const failedWrite = store.messageWrites.updates.find(({ patch }) => patch.status === 'failed');
  assert.equal(failedWrite.patch.errorMessage, 'Empty agent reply');

  // Leg 3 (fresh): explicit completionPersisted=false must not register a new
  // session either; the poisoned row stays untouched.
  seedUserMessage(store, 'u3', 'DELTA-U3-CONTENT');
  const executor3 = env.createExecutor(store, {
    reply: '',
    resultOverrides: {
      completionStopReason: 'stop',
      completionMessageKey: 'assistant-unverified-2',
      openToolCallCount: 0,
      completionPersisted: false,
    },
  });
  await runTurn({ executor: executor3, conversation, agent, store, turnId: 'turn-empty-unverified-3' });

  assert.equal(env.captured[2].options.resume, false);
  const leg3CallNames = store.reuseCalls.slice(5).map(([name]) => name);
  assert.deepEqual(leg3CallNames, ['get'], 'unverified empty reply must not touch the row');
  assert.equal(store.peekReuseRow().state, 'poisoned');
});

test('empty-reply registration keeps mid-run public and private messages beyond the committed cursor', async (t) => {
  const env = setupExecutorTest(t, { reuseEnabled: true });
  const agent = createAgent();
  const conversation = createConversation(agent);
  const store = createFakeStore(conversation, { withReuse: true });
  store.agentDir = env.tempDir;

  const privateMailbox = [];
  const orderedVisiblePrivateMailbox = (agentId) => privateMailbox
    .filter((message) => (
      message
      && String(message.conversationId || '').trim() === conversation.id
      && Array.isArray(message.recipientAgentIds)
      && message.recipientAgentIds.includes(agentId)
    ))
    .sort((left, right) => {
      const leftCreatedAt = String(left.createdAt || '');
      const rightCreatedAt = String(right.createdAt || '');
      return leftCreatedAt === rightCreatedAt
        ? String(left.id || '').localeCompare(String(right.id || ''))
        : leftCreatedAt.localeCompare(rightCreatedAt);
    });

  store.listPrivateMessagesForAgent = (conversationId, agentId, { limit } = {}) => {
    if (conversationId !== conversation.id) {
      return [];
    }
    const ordered = orderedVisiblePrivateMailbox(agentId);
    const cap = Number.isInteger(limit) && limit > 0 ? limit : ordered.length;
    return ordered.slice(Math.max(ordered.length - cap, 0));
  };

  store.listPrivateMessagesForAgentAfter = (conversationId, agentId, { messageId, createdAt } = {}) => {
    if (conversationId !== conversation.id) {
      return [];
    }
    const cursorMessageId = String(messageId || '');
    const cursorCreatedAt = String(createdAt || '');
    return orderedVisiblePrivateMailbox(agentId).filter((message) => {
      const messageCreatedAt = String(message.createdAt || '');
      const messageIdValue = String(message.id || '');
      return messageCreatedAt > cursorCreatedAt || (messageCreatedAt === cursorCreatedAt && messageIdValue > cursorMessageId);
    });
  };

  const addPrivateMailboxMessage = (input) => {
    privateMailbox.push({
      conversationId: conversation.id,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt || input.createdAt,
      senderAgentId: input.senderAgentId || null,
      senderName: input.senderName || 'Private Sender',
      recipientAgentIds: Array.isArray(input.recipientAgentIds) ? input.recipientAgentIds.slice() : [],
      content: input.content,
      id: input.id,
    });
  };

  seedUserMessage(store, 'u1', 'ALPHA-U1-CONTENT');
  addPrivateMailboxMessage({
    id: 'private-visible-1',
    senderAgentId: 'peer-agent-1',
    senderName: 'Peer One',
    recipientAgentIds: [agent.id],
    content: 'PRIVATE-OLD-1',
    createdAt: '2026-09-02T10:00:01.000Z',
  });

  // Leg 1: establish the reusable snapshot with a normal reply.
  const executor1 = env.createExecutor(store);
  await runTurn({ executor: executor1, conversation, agent, store, turnId: 'turn-empty-midrun-1' });
  const firstSnapshot = store.peekReuseRow();
  assert.equal(firstSnapshot.state, 'reusable');
  assert.equal(firstSnapshot.privateCursorMessageId, 'private-visible-1');

  // Leg 2: resume and end with a cleanly-persisted empty reply while a public
  // message and an authorized private message arrive mid-run. Both must stay
  // beyond the committed cursors.
  seedUserMessage(store, 'u2', 'DELTA-U2-CONTENT');
  const executor2 = env.createExecutor(store, {
    reply: '',
    resultOverrides: {
      completionStopReason: 'stop',
      completionMessageKey: 'assistant-empty-midrun',
      openToolCallCount: 0,
      completionPersisted: true,
    },
    onStartRun: () => {
      seedUserMessage(store, 'u9', 'MID-RUN-U9-CONTENT');
      addPrivateMailboxMessage({
        id: 'private-visible-9',
        senderAgentId: 'peer-agent-1',
        senderName: 'Peer One',
        recipientAgentIds: [agent.id],
        content: 'PRIVATE-LATE-EMPTY-9',
        createdAt: '2026-09-02T10:00:09.000Z',
      });
    },
  });
  await runTurn({ executor: executor2, conversation, agent, store, turnId: 'turn-empty-midrun-2' });

  assert.equal(env.captured[1].options.resume, true);
  assert.equal(env.captured[1].prompt.includes('MID-RUN-U9-CONTENT'), false);
  assert.equal(env.captured[1].prompt.includes('PRIVATE-LATE-EMPTY-9'), false);
  const failedWrite = store.messageWrites.updates.find(({ patch }) => patch.status === 'failed');
  assert.ok(failedWrite, 'empty reply must still fail the chat message');

  const leg2CallNames = store.reuseCalls.slice(2).map(([name]) => name);
  assert.deepEqual(leg2CallNames, ['get', 'claim', 'markReusable']);
  const registered = store.reuseCalls[4][1];
  const assistantCreates = store.messageWrites.creates.filter((input) => input.role === 'assistant');
  assert.equal(registered.cursorMessageId, assistantCreates[1].id);
  assert.equal(
    registered.cursorMessageCount,
    4,
    'cursor covers u1, a1, u2, and the failed a2 — never the mid-run u9'
  );
  assert.equal(registered.privateCursorMessageId, 'private-visible-1', 'mid-run private mail stays beyond the private cursor');
  assert.equal(store.peekReuseRow().state, 'reusable');

  // Leg 3: the session resumes again and both mid-run arrivals surface as the
  // delta instead of being swallowed.
  seedUserMessage(store, 'u3', 'DELTA-U3-CONTENT');
  const executor3 = env.createExecutor(store);
  await runTurn({ executor: executor3, conversation, agent, store, turnId: 'turn-empty-midrun-3' });

  assert.equal(env.captured[2].options.resume, true);
  assert.equal(env.captured[2].options.session, env.captured[0].options.session);
  assert.match(env.captured[2].prompt, /MID-RUN-U9-CONTENT/u, 'mid-run public message must reach the next turn');
  assert.match(env.captured[2].prompt, /PRIVATE-LATE-EMPTY-9/u, 'mid-run private message must reach the next turn');
  assert.match(env.captured[2].prompt, /DELTA-U3-CONTENT/u);
  assert.equal(env.captured[2].prompt.includes('ALPHA-U1-CONTENT'), false);
  assert.equal(env.captured[2].prompt.includes('PRIVATE-OLD-1'), false, 'already-consumed private mail must not repeat');
});

test('empty-reply registration failure keeps the resumed claim busy without poisoning', async (t) => {
  const env = setupExecutorTest(t, { reuseEnabled: true });
  const agent = createAgent();
  const conversation = createConversation(agent);
  const store = createFakeStore(conversation, { withReuse: true });
  store.agentDir = env.tempDir;
  seedUserMessage(store, 'u1', 'ALPHA-U1-CONTENT');

  // Leg 1: establish the reusable snapshot with a normal reply.
  const executor1 = env.createExecutor(store);
  await runTurn({ executor: executor1, conversation, agent, store, turnId: 'turn-empty-regfail-1' });
  const firstSessionName = env.captured[0].options.session;
  assert.equal(store.peekReuseRow().state, 'reusable');

  // Leg 2: resume, end with a cleanly-persisted empty reply, then make the
  // registration itself throw. The turn must still complete, the claim must
  // stay busy for the existing busy-stale sweep, and nothing may be poisoned.
  seedUserMessage(store, 'u2', 'DELTA-U2-CONTENT');
  store.markAgentSessionReuseReusable = (payload) => {
    store.reuseCalls.push(['markReusable', payload]);
    throw new Error('simulated registration failure');
  };
  const executor2 = env.createExecutor(store, {
    reply: '',
    resultOverrides: {
      completionStopReason: 'stop',
      completionMessageKey: 'assistant-empty-regfail',
      openToolCallCount: 0,
      completionPersisted: true,
    },
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await runTurn({ executor: executor2, conversation, agent, store, turnId: 'turn-empty-regfail-2' });
  } finally {
    console.error = originalConsoleError;
  }

  const failedWrite = store.messageWrites.updates.find(({ patch }) => patch.status === 'failed');
  assert.ok(failedWrite, 'the chat message must still fail');
  const leg2CallNames = store.reuseCalls.slice(2).map(([name]) => name);
  assert.deepEqual(leg2CallNames, ['get', 'claim', 'markReusable']);
  const row = store.peekReuseRow();
  assert.equal(row.state, 'busy', 'a failed registration must leave the claim for the busy-stale sweep');
  assert.equal(row.sessionName, firstSessionName);
});

test('empty-reply registration never overwrites a concurrent busy claim held by another session', async (t) => {
  const env = setupExecutorTest(t, { reuseEnabled: true });
  const agent = createAgent();
  const conversation = createConversation(agent);
  const store = createFakeStore(conversation, { withReuse: true });
  store.agentDir = env.tempDir;
  seedUserMessage(store, 'u1', 'ALPHA-U1-CONTENT');

  // Fresh run ending with a cleanly-persisted empty reply. Between the run and
  // its registration, another run claims the row busy with a DIFFERENT session.
  // The guarded upsert must refuse instead of releasing that claim.
  const originalMark = store.markAgentSessionReuseReusable;
  store.markAgentSessionReuseReusable = (payload) => {
    store.reuseState.row = {
      conversationId: conversation.id,
      agentId: agent.id,
      profileId: PROFILE_ID,
      state: 'busy',
      sessionName: 'concurrent-run-session',
      sessionPath: '/tmp/reuse-ab/concurrent.jsonl',
      staticSegmentHash: 'other-hash',
      updatedAt: '2026-09-02T11:00:00.000Z',
    };
    return originalMark(payload);
  };
  const executor1 = env.createExecutor(store, {
    reply: '',
    resultOverrides: {
      completionStopReason: 'stop',
      completionMessageKey: 'assistant-empty-conflict',
      openToolCallCount: 0,
      completionPersisted: true,
    },
  });
  await runTurn({ executor: executor1, conversation, agent, store, turnId: 'turn-empty-conflict-1' });

  const failedWrite = store.messageWrites.updates.find(({ patch }) => patch.status === 'failed');
  assert.ok(failedWrite, 'empty reply must still fail the chat message');
  assert.deepEqual(
    store.reuseCalls.map(([name]) => name),
    ['get', 'markReusable'],
    'registration is attempted but must not force the row'
  );
  const row = store.peekReuseRow();
  assert.equal(row.state, 'busy', 'the concurrent claim must survive');
  assert.equal(row.sessionName, 'concurrent-run-session');
});

test('timeout and interruption failures keep poisoning the claimed session', async (t) => {
  const env = setupExecutorTest(t, { reuseEnabled: true });
  const agent = createAgent();
  const conversation = createConversation(agent);
  const store = createFakeStore(conversation, { withReuse: true });
  store.agentDir = env.tempDir;
  seedUserMessage(store, 'u1', 'ALPHA-U1-CONTENT');

  // Leg 1: establish the reusable snapshot with a normal reply.
  const executor1 = env.createExecutor(store);
  await runTurn({ executor: executor1, conversation, agent, store, turnId: 'turn-timeout-1' });
  assert.equal(store.peekReuseRow().state, 'reusable');

  // Leg 2: the resumed run rejects with a progress timeout. The claim must be
  // poisoned; the new empty-reply path must not interfere.
  const timeoutError = new Error('pi progress timeout: no events');
  timeoutError.terminationReason = { type: 'progress_timeout', message: 'pi progress timeout: no events' };
  seedUserMessage(store, 'u2', 'DELTA-U2-CONTENT');
  const executor2 = env.createExecutor(store, { resultOverrides: { rejectWith: timeoutError } });
  await runTurn({ executor: executor2, conversation, agent, store, turnId: 'turn-timeout-2' });

  assert.equal(env.captured[1].options.resume, true);
  const leg2CallNames = store.reuseCalls.slice(2).map(([name]) => name);
  assert.deepEqual(leg2CallNames, ['get', 'claim', 'markPoisoned']);
  assert.match(String(store.peekReuseRow().poisonReason), /^run_failed:/u);
  const failedWrite = store.messageWrites.updates.find(({ patch }) => patch.status === 'failed');
  assert.equal(failedWrite.patch.metadata.invocationFailure.kind, 'timeout');
});
