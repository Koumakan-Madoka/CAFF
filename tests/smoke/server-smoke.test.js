const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createConversationsController } = require('../../build/server/api/conversations-controller');

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
    modeStore: { get() { return null; } },
  });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return { handler, store };
}

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
