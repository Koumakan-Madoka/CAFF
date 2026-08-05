const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createSkillRegistry } = require('../../build/lib/skill-registry');
const { createServerApp } = require('../../build/server/app/create-server');
const { createBootstrapPayloadBuilder } = require('../../build/server/api/bootstrap-payload');
const { createConversationsController } = require('../../build/server/api/conversations-controller');
const { createMemoryController } = require('../../build/server/api/memory-controller');
const {
  createCrossConversationDeliveryService,
} = require('../../build/server/domain/conversation/cross-conversation-delivery');
const { maybeAutoCreateConversationDigest } = require('../../build/server/domain/conversation/conversation-digest');
const { maybeAutoCreateConversationSkillDraft } = require('../../build/server/domain/conversation/skill-draft');
const { createRoleService } = require('../../build/server/domain/roles/role-service');

const { requireSpawn } = require('../helpers/spawn');
const { withTempDir } = require('../helpers/temp-dir');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const FAKE_PI_SDK_HOST_TRELLIS_TOOLS_PATH = path.join(
  ROOT_DIR,
  'tests',
  'fixtures',
  'fake-pi-sdk-host-trellis-tools.mjs'
);

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

async function fetchJsonResponse(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();

  return {
    status: response.status,
    json: text ? JSON.parse(text) : {},
  };
}

function createSmokeConversation(store, input = {}) {
  const hasExplicitParticipants = Array.isArray(input.participants) || Array.isArray(input.agentIds);
  return store.createConversation(hasExplicitParticipants
    ? input
    : { ...input, participants: ['role-family-gpt'] });
}

async function invokeConversationsController(handler, options = {}) {
  const req = new PassThrough();
  req.method = options.method || 'GET';
  const requestTarget = options.pathname || '/api/conversations';
  const requestUrl = new URL(`http://127.0.0.1${requestTarget}`);
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

  const handledPromise = handler({ req, res, pathname: requestUrl.pathname, requestUrl });
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
    modeStore: options.modeStore || { get() { return null; } },
    projectManager: options.projectManager,
    projectDir: options.projectDir,
    digestOptions: { summaryMode: 'extractive', ...(options.digestOptions || {}) },
    digestModelRunner: options.digestModelRunner,
    skillDraftOptions: { generationMode: 'rules', ...(options.skillDraftOptions || {}) },
    skillDraftModelRunner: options.skillDraftModelRunner,
  });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return { handler, store, broadcastEvents };
}

test('create server wires loopback model-provider administration with bootstrap CSRF', async (t) => {
  const tempDir = withTempDir('caff-model-providers-server-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(tempDir, 'models.json'), JSON.stringify({
    providers: {
      moonshotai: {
        models: [{ id: 'kimi-k2.5', family: 'kimi' }],
      },
    },
  }), 'utf8');
  fs.writeFileSync(path.join(tempDir, 'auth.json'), JSON.stringify({
    moonshotai: { type: 'api_key', key: 'external-auth-smoke-secret' },
  }), 'utf8');
  const app = createServerApp({
    host: '127.0.0.1',
    port,
    agentDir: tempDir,
    sqlitePath,
    projectDir: tempDir,
  });
  let closed = false;

  t.after(async () => {
    if (!closed) {
      await new Promise((resolve) => app.close(resolve));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await new Promise((resolve) => app.start(resolve));
  const bootstrapResponse = await fetch(`${baseUrl}/api/bootstrap`);
  const bootstrap = await bootstrapResponse.json();
  const csrfToken = bootstrap.localAdmin.modelProviders.csrfToken;
  assert.equal(bootstrap.localAdmin.modelProviders.enabled, true);
  assert.ok(typeof csrfToken === 'string' && csrfToken.length >= 32);

  const getResponse = await fetch(`${baseUrl}/api/model-providers`);
  assert.equal(getResponse.status, 200);
  const providers = await getResponse.json();
  assert.equal(providers.providers[0].apiKeyMode, 'external');
  assert.equal(providers.providers[0].hasExternalAuth, true);
  assert.equal(JSON.stringify(providers).includes('external-auth-smoke-secret'), false);

  const putResponse = await fetch(`${baseUrl}/api/model-providers/moonshotai`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Origin: baseUrl,
      'X-CAFF-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      name: 'Moonshot',
      apiKeyMode: 'env',
      apiKey: '',
      models: [{ id: 'kimi-k2.5', name: 'Kimi Configured', family: 'kimi' }],
    }),
  });
  assert.equal(putResponse.status, 200);
  const updated = await putResponse.json();
  assert.equal(updated.providers[0].name, 'Moonshot');
  assert.equal(JSON.stringify(updated).includes('external-auth-smoke-secret'), false);

  const refreshedBootstrap = await (await fetch(`${baseUrl}/api/bootstrap`)).json();
  assert.equal(
    refreshedBootstrap.modelOptions.find((option) => option.key === 'moonshotai\u001fkimi-k2.5').label,
    'Kimi Configured'
  );

  await new Promise((resolve) => app.close(resolve));
  closed = true;
});

test('server smoke: Agent delivery, operator receipt lookup, cancellation, and project binding share one HTTP surface', async (t) => {
  const tempDir = withTempDir('caff-cross-delivery-http-smoke-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const app = createServerApp({
    host: '127.0.0.1',
    port,
    agentDir: tempDir,
    sqlitePath,
    projectDir: tempDir,
    deliveryWorkerFactory(options) {
      return {
        recoverExpiredClaims() {
          return { requeuedDeliveryIds: [], failedUnknownDeliveryIds: [] };
        },
        recoverPendingResponses() {
          return [];
        },
        expireRequestDeadlines() {
          return [];
        },
        async processNext() {
          return null;
        },
        async cancel(deliveryId, reason) {
          const cancelledAt = new Date().toISOString();
          return options.store.cancelQueuedCrossConversationDelivery(deliveryId, {
            reason,
            cancelledAt,
          });
        },
        async retry() {
          throw new Error('Retry is not used by this smoke path');
        },
      };
    },
    setDeliveryMaintenanceInterval() {
      return { unref() {} };
    },
    clearDeliveryMaintenanceInterval() {},
  });
  let closed = false;

  t.after(async () => {
    if (!closed) {
      await new Promise((resolve) => app.close(resolve));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const sourceAgent = app.store.saveCustomRoleConfig({
    id: 'delivery-http-source-agent',
    name: 'Delivery HTTP Source',
    personaPrompt: 'Send one bounded delivery.',
  });
  const targetAgent = app.store.saveCustomRoleConfig({
    id: 'delivery-http-target-agent',
    name: 'Delivery HTTP Target',
    personaPrompt: 'Receive one bounded delivery.',
  });
  const sourceConversation = app.store.createConversation({
    id: 'delivery-http-source-conversation',
    title: 'Delivery HTTP Source',
    participants: [sourceAgent.id],
  });
  const targetConversation = app.store.createConversation({
    id: 'delivery-http-target-conversation',
    title: 'Delivery HTTP Target',
    participants: [targetAgent.id],
  });

  await new Promise((resolve) => app.start(resolve));
  const projects = await fetchJson(baseUrl, '/api/projects');
  const projectId = projects.activeProjectId;
  assert.ok(projectId);

  for (const conversationId of [sourceConversation.id, targetConversation.id]) {
    const binding = await fetchJson(baseUrl, `/api/conversations/${conversationId}/project-scope`, {
      method: 'PUT',
      body: { projectId },
    });
    assert.equal(binding.conversation.projectScopeId, projectId);
  }

  const invocation = app.agentToolBridge.registerInvocation(
    app.agentToolBridge.createInvocationContext({
      conversationId: sourceConversation.id,
      turnId: 'delivery-http-source-turn',
      projectDir: tempDir,
      agentId: sourceAgent.id,
      agentName: sourceAgent.name,
      conversationAgents: [sourceAgent],
    })
  );
  const submitted = await fetchJson(baseUrl, '/api/agent-tools/conversation-notify', {
    method: 'POST',
    body: {
      invocationId: invocation.invocationId,
      callbackToken: invocation.callbackToken,
      targetConversationId: targetConversation.id,
      targetAgentId: targetAgent.id,
      content: 'Deliver through the fixed Agent HTTP route.',
      idempotencyKey: 'delivery-http-smoke-key',
    },
  });
  assert.equal(submitted.delivery.dispatchStatus, 'queued');

  const receipt = await fetchJson(
    baseUrl,
    `/api/conversation-deliveries/${submitted.delivery.id}`
  );
  assert.equal(receipt.delivery.id, submitted.delivery.id);
  assert.equal(receipt.targetMessage.id, submitted.targetMessageId);
  assert.equal(receipt.sourceReceipt.id, submitted.sourceReceiptMessageId);

  const cancelled = await fetchJson(
    baseUrl,
    `/api/conversation-deliveries/${submitted.delivery.id}/cancel`,
    { method: 'POST', body: { reason: 'Smoke cancellation' } }
  );
  assert.equal(cancelled.delivery.dispatchStatus, 'cancelled');

  await new Promise((resolve) => app.close(resolve));
  closed = true;
});

test('conversations controller preserves string participant ids when mode skills are merged', async (t) => {
  const { handler, store } = createConversationsControllerHarness(t, {
    modeStore: {
      get(modeId) {
        return modeId === 'standard'
          ? { id: 'standard', skillIds: ['skill-creator'] }
          : null;
      },
    },
  });
  const agent = store.saveCustomRoleConfig({
    id: 'string-participant-agent',
    name: 'String Participant Agent',
    description: 'Exercises the legacy string participant API contract.',
    personaPrompt: 'Reply briefly.',
  });

  const result = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: '/api/conversations',
    body: {
      title: 'String Participant Conversation',
      participants: [agent.id],
    },
  });

  assert.equal(result.statusCode, 201);
  assert.deepEqual(result.json.conversation.agents.map((participant) => participant.id), [agent.id]);
  assert.deepEqual(result.json.conversation.agents[0].conversationSkillIds, ['skill-creator']);
});

test('operator project binding resolves a real project and rejects non-terminal delivery ambiguity', async (t) => {
  const project = { id: 'project-scope-1', name: 'Project Scope One', path: process.cwd() };
  const otherProject = { id: 'project-scope-2', name: 'Project Scope Two', path: process.cwd() };
  const { handler, store } = createConversationsControllerHarness(t, {
    projectManager: {
      listProjects() {
        return [project, otherProject];
      },
    },
  });
  const source = createSmokeConversation(store, {
    id: 'project-binding-source',
    title: 'Project Binding Source',
  });
  const target = createSmokeConversation(store, {
    id: 'project-binding-target',
    title: 'Project Binding Target',
  });

  const bound = await invokeConversationsController(handler, {
    method: 'PUT',
    pathname: `/api/conversations/${source.id}/project-scope`,
    body: { projectId: project.id },
  });
  assert.equal(bound.statusCode, 200);
  assert.equal(bound.json.conversation.projectScopeId, project.id);
  assert.equal(bound.json.project.id, project.id);

  const idempotentBinding = await invokeConversationsController(handler, {
    method: 'PUT',
    pathname: `/api/conversations/${source.id}/project-scope`,
    body: { projectId: project.id },
  });
  assert.equal(idempotentBinding.statusCode, 200);
  assert.equal(idempotentBinding.json.conversation.projectScopeId, project.id);

  await assert.rejects(
    () => invokeConversationsController(handler, {
      method: 'PUT',
      pathname: `/api/conversations/${source.id}/project-scope`,
      body: { projectId: otherProject.id },
    }),
    (error) => error && error.statusCode === 409
      && error.issues[0].code === 'conversation_project_scope_immutable'
  );

  await assert.rejects(
    () => invokeConversationsController(handler, {
      method: 'PUT',
      pathname: `/api/conversations/${target.id}/project-scope`,
      body: { projectId: 'missing-project' },
    }),
    (error) => error && error.statusCode === 404 && error.issues[0].code === 'project_not_found'
  );

  store.db.prepare('UPDATE chat_conversations SET project_scope_id = ? WHERE id = ?')
    .run(project.id, target.id);
  const sourceAgent = store.getConversationWithoutMessages(source.id).agents[0];
  const targetAgent = store.getConversationWithoutMessages(target.id).agents[0];
  const service = createCrossConversationDeliveryService({ store });
  service.submitFromAgent({
    kind: 'agent',
    sourceConversationId: source.id,
    sourceInvocationId: 'project-binding-invocation',
    sourceAgentId: sourceAgent.id,
    sourceAgentName: sourceAgent.name,
  }, {
    kind: 'notify',
    targetConversationId: target.id,
    targetAgentId: targetAgent.id,
    content: 'Keep this delivery non-terminal while checking scope binding.',
    idempotencyKey: 'project-binding-delivery',
  });
  store.db.prepare('UPDATE chat_conversations SET project_scope_id = NULL WHERE id = ?').run(target.id);

  await assert.rejects(
    () => invokeConversationsController(handler, {
      method: 'PUT',
      pathname: `/api/conversations/${target.id}/project-scope`,
      body: { projectId: project.id },
    }),
    (error) => error && error.statusCode === 409
      && error.issues[0].code === 'conversation_project_scope_delivery_conflict'
  );
});

test('conversations controller exposes bounded cursor pages without hydrating public messages in the conversation projection', async (t) => {
  const { handler, store } = createConversationsControllerHarness(t);
  const conversation = createSmokeConversation(store, {
    id: 'message-page-api-conversation',
    title: 'Message Page API Conversation',
  });
  const otherConversation = createSmokeConversation(store, {
    id: 'message-page-api-other',
    title: 'Other Message Page API Conversation',
  });

  for (let index = 0; index < 55; index += 1) {
    const suffix = String(index).padStart(2, '0');
    store.createMessage({
      id: `api-message-${suffix}`,
      conversationId: conversation.id,
      turnId: `api-turn-${suffix}`,
      role: 'user',
      senderName: 'User',
      content: `message-${suffix}`,
      createdAt: index < 3 ? '2026-07-28T00:00:00.000Z' : `2026-07-28T00:${suffix}:00.000Z`,
    });
  }

  const conversationResult = await invokeConversationsController(handler, {
    pathname: `/api/conversations/${conversation.id}`,
  });
  assert.equal(conversationResult.handled, true);
  assert.equal(conversationResult.statusCode, 200);
  assert.equal(conversationResult.json.conversation.messageCount, 55);
  assert.deepEqual(conversationResult.json.conversation.messages, []);

  const defaultPage = await invokeConversationsController(handler, {
    pathname: `/api/conversations/${conversation.id}/messages`,
  });
  assert.equal(defaultPage.handled, true);
  assert.equal(defaultPage.statusCode, 200);
  assert.equal(defaultPage.json.items.length, 50);
  assert.equal(defaultPage.json.items[0].id, 'api-message-05');
  assert.equal(defaultPage.json.items[49].id, 'api-message-54');
  assert.equal(defaultPage.json.hasMore, true);
  assert.equal(typeof defaultPage.json.nextCursor, 'string');
  assert.ok(defaultPage.json.nextCursor.length > 0);

  const olderPage = await invokeConversationsController(handler, {
    pathname: `/api/conversations/${conversation.id}/messages?limit=3&before=${encodeURIComponent(defaultPage.json.nextCursor)}`,
  });
  assert.deepEqual(olderPage.json.items.map((message) => message.id), [
    'api-message-02',
    'api-message-03',
    'api-message-04',
  ]);
  assert.equal(olderPage.json.hasMore, true);

  const singleItemPage = await invokeConversationsController(handler, {
    pathname: `/api/conversations/${conversation.id}/messages?limit=1`,
  });
  assert.deepEqual(singleItemPage.json.items.map((message) => message.id), ['api-message-54']);
  assert.equal(singleItemPage.json.hasMore, true);

  const maximumPage = await invokeConversationsController(handler, {
    pathname: `/api/conversations/${conversation.id}/messages?limit=100`,
  });
  assert.equal(maximumPage.json.items.length, 55);
  assert.equal(maximumPage.json.hasMore, false);
  assert.equal(maximumPage.json.nextCursor, null);

  const emptyPage = await invokeConversationsController(handler, {
    pathname: `/api/conversations/${otherConversation.id}/messages`,
  });
  assert.deepEqual(emptyPage.json, { items: [], nextCursor: null, hasMore: false });

  await assert.rejects(
    () => invokeConversationsController(handler, {
      pathname: '/api/conversations/missing-message-page-conversation/messages',
    }),
    (error) => error && error.statusCode === 404
  );

  await assert.rejects(
    () => invokeConversationsController(handler, {
      pathname: `/api/conversations/${otherConversation.id}/messages?before=${encodeURIComponent(defaultPage.json.nextCursor)}`,
    }),
    (error) => error && error.statusCode === 400 && /cursor/i.test(error.message)
  );
  await assert.rejects(
    () => invokeConversationsController(handler, {
      pathname: `/api/conversations/${conversation.id}/messages?before=not-a-cursor`,
    }),
    (error) => error && error.statusCode === 400 && /cursor/i.test(error.message)
  );
  const invalidTimestampCursor = Buffer.from(JSON.stringify({
    v: 1,
    conversationId: conversation.id,
    createdAt: 'not-a-timestamp',
    id: 'api-message-10',
  })).toString('base64url');
  await assert.rejects(
    () => invokeConversationsController(handler, {
      pathname: `/api/conversations/${conversation.id}/messages?before=${invalidTimestampCursor}`,
    }),
    (error) => error && error.statusCode === 400 && /cursor/i.test(error.message)
  );

  for (const invalidLimit of ['0', '1.5', '101', 'abc']) {
    await assert.rejects(
      () => invokeConversationsController(handler, {
        pathname: `/api/conversations/${conversation.id}/messages?limit=${invalidLimit}`,
      }),
      (error) => error && error.statusCode === 400 && /limit/i.test(error.message)
    );
  }
});

test('conversations controller manages session goal lifecycle in metadata', async (t) => {
  const { handler, store, broadcastEvents } = createConversationsControllerHarness(t);
  const conversation = createSmokeConversation(store, {
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
  const conversation = createSmokeConversation(store, {
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
  const conversation = createSmokeConversation(store, {
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
  const currentConversation = createSmokeConversation(store, {
    id: 'memory-search-current-conversation',
    title: 'Current Memory Conversation',
  });
  const historicalConversation = createSmokeConversation(store, {
    id: 'memory-search-historical-conversation',
    title: 'Historical Memory Conversation',
  });
  const otherHistoricalConversation = createSmokeConversation(store, {
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
  const legacyConversation = createSmokeConversation(store, {
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
  const legacyConversation = createSmokeConversation(store, {
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
  const legacyConversation = createSmokeConversation(store, {
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

  const conversation = createSmokeConversation(store, {
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

test('auto skill draft model review can reject and records a stable skip', async (t) => {
  const tempDir = withTempDir('caff-auto-skill-draft-review-reject-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = createSmokeConversation(store, {
    id: 'auto-skill-draft-review-reject-conversation',
    title: 'Auto Skill Draft Review Reject Conversation',
    metadata: {
      conversationDigests: [
        {
          id: 'digest-auto-skill-draft-review-reject',
          kind: 'entry',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          summary: 'A routine status update should not become a reusable skill draft.',
          facts: ['The user acknowledged the current status.'],
          decisions: [],
          openQuestions: [],
          nextActions: [],
          artifacts: ['server/domain/conversation/skill-draft.ts'],
          experience: [
            {
              sourceDraftId: 'expdraft-review-reject',
              title: 'Reject weak source-backed experience',
              category: 'other',
              scenario: 'When a pending experience draft turns out to describe a one-off status update.',
              steps: ['Ask the auto-review model to reject one-off updates.'],
              pitfalls: [],
              validation: [],
              artifacts: ['server/domain/conversation/skill-draft.ts'],
              confidence: 'medium',
            },
          ],
        },
      ],
      experienceDrafts: [
        {
          id: 'expdraft-review-reject',
          status: 'absorbed',
          title: 'Reject weak source-backed experience',
          category: 'other',
          scenario: 'When a pending experience draft turns out to describe a one-off status update.',
          steps: ['Ask the auto-review model to reject one-off updates.'],
          pitfalls: [],
          validation: [],
          artifacts: ['server/domain/conversation/skill-draft.ts'],
          confidence: 'medium',
          source: { type: 'agent-tool', agentId: 'agent-review' },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          absorbedAt: new Date().toISOString(),
          absorbedDigestId: 'digest-auto-skill-draft-review-reject',
        },
      ],
    },
  });
  let modelCalls = 0;

  const reviewResult = await maybeAutoCreateConversationSkillDraft(store, conversation.id, {
    digestId: 'digest-auto-skill-draft-review-reject',
    trigger: 'message_budget',
  }, {
    autoCreate: true,
    generationMode: 'model',
    skillDraftModelRunner: async () => {
      modelCalls += 1;
      return {
        shouldCreateSkill: false,
        reason: 'Only a one-off status update with no reusable workflow.',
        skill: null,
      };
    },
  });

  assert.equal(reviewResult.autoCreated, false);
  assert.equal(reviewResult.reason, 'review_rejected');
  assert.equal(reviewResult.changed, true);
  assert.equal(modelCalls, 1);
  assert.equal(store.getConversation(conversation.id).metadata.skillDrafts, undefined);
  assert.equal(store.getConversation(conversation.id).metadata.skillDraftAutoReviews.length, 1);
  assert.equal(store.getConversation(conversation.id).metadata.skillDraftAutoReviews[0].status, 'rejected');
  assert.match(store.getConversation(conversation.id).metadata.skillDraftAutoReviews[0].reason, /one-off status/u);

  const duplicateReviewResult = await maybeAutoCreateConversationSkillDraft(store, conversation.id, {
    digestId: 'digest-auto-skill-draft-review-reject',
    trigger: 'message_budget',
  }, {
    autoCreate: true,
    generationMode: 'model',
    skillDraftModelRunner: async () => {
      modelCalls += 1;
      return {
        shouldCreateSkill: true,
        reason: 'This should not be called again for the same digest.',
        skill: {
          id: 'unexpected-review-retry',
          name: 'Unexpected Review Retry',
          description: 'This draft should not be created after a stable rejection.',
          whenToUse: ['Never.'],
          steps: ['Never.'],
          pitfalls: [],
          validation: [],
          artifacts: [],
          confidence: 0.9,
        },
      };
    },
  });

  assert.equal(duplicateReviewResult.autoCreated, false);
  assert.equal(duplicateReviewResult.reason, 'review_rejected');
  assert.equal(duplicateReviewResult.changed, false);
  assert.equal(modelCalls, 1);
  assert.equal(store.getConversation(conversation.id).metadata.skillDrafts, undefined);
});

test('auto skill draft model review skips missing decisions instead of approving implicitly', async (t) => {
  const tempDir = withTempDir('caff-auto-skill-draft-review-missing-decision-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = createSmokeConversation(store, {
    id: 'auto-skill-draft-review-missing-decision-conversation',
    title: 'Auto Skill Draft Review Missing Decision Conversation',
    metadata: {
      conversationDigests: [
        {
          id: 'digest-auto-skill-draft-review-missing-decision',
          kind: 'entry',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          summary: 'A model response without an explicit review decision must not auto-create a skill draft.',
          facts: ['The digest has enough fields to reach model review.'],
          decisions: ['Skill draft automation must require explicit approval before creating pending drafts.'],
          openQuestions: [],
          nextActions: ['Review the model response.'],
          artifacts: ['server/domain/conversation/skill-draft.ts'],
          experience: [
            {
              sourceDraftId: 'expdraft-missing-decision',
              title: 'Require explicit auto-review decisions',
              category: 'pattern',
              scenario: 'When a source-backed experience reaches automatic Skill draft model review.',
              steps: ['Require shouldCreateSkill=true before storing a pending draft.'],
              pitfalls: [],
              validation: ['Missing shouldCreateSkill is treated as skipped.'],
              artifacts: ['server/domain/conversation/skill-draft.ts'],
              confidence: 'high',
            },
          ],
        },
      ],
      experienceDrafts: [
        {
          id: 'expdraft-missing-decision',
          status: 'absorbed',
          title: 'Require explicit auto-review decisions',
          category: 'pattern',
          scenario: 'When a source-backed experience reaches automatic Skill draft model review.',
          steps: ['Require shouldCreateSkill=true before storing a pending draft.'],
          pitfalls: [],
          validation: ['Missing shouldCreateSkill is treated as skipped.'],
          artifacts: ['server/domain/conversation/skill-draft.ts'],
          confidence: 'high',
          source: { type: 'agent-tool', agentId: 'agent-review' },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          absorbedAt: new Date().toISOString(),
          absorbedDigestId: 'digest-auto-skill-draft-review-missing-decision',
        },
      ],
    },
  });

  const reviewResult = await maybeAutoCreateConversationSkillDraft(store, conversation.id, {
    digestId: 'digest-auto-skill-draft-review-missing-decision',
    trigger: 'message_budget',
  }, {
    autoCreate: true,
    generationMode: 'model',
    skillDraftModelRunner: async () => ({
      reason: 'The model forgot to return shouldCreateSkill.',
      skill: {
        id: 'implicit-auto-approval',
        name: 'Implicit Auto Approval',
        description: 'This draft must not be created without an explicit model decision.',
        whenToUse: ['Never auto-create from implicit approval.'],
        steps: ['Require shouldCreateSkill=true.'],
        pitfalls: [],
        validation: [],
        artifacts: ['server/domain/conversation/skill-draft.ts'],
        confidence: 0.9,
      },
    }),
  });

  const updatedConversation = store.getConversation(conversation.id);
  assert.equal(reviewResult.autoCreated, false);
  assert.equal(reviewResult.reason, 'review_missing_decision');
  assert.equal(reviewResult.changed, true);
  assert.equal(updatedConversation.metadata.skillDrafts, undefined);
  assert.equal(updatedConversation.metadata.skillDraftAutoReviews.length, 1);
  assert.equal(updatedConversation.metadata.skillDraftAutoReviews[0].status, 'skipped');
  assert.equal(updatedConversation.metadata.skillDraftAutoReviews[0].reasonCode, 'review_missing_decision');
});

test('auto skill draft model review creates drafts only after approval', async (t) => {
  const tempDir = withTempDir('caff-auto-skill-draft-review-create-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const modelCalls = [];

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = createSmokeConversation(store, {
    id: 'auto-skill-draft-review-create-conversation',
    title: 'Auto Skill Draft Review Create Conversation',
    metadata: {
      conversationDigests: [
        {
          id: 'digest-auto-skill-draft-review-create',
          kind: 'entry',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          summary: 'A repeatable workflow was validated and should become a pending skill draft.',
          facts: ['Auto-created drafts remain pending until human confirmation.'],
          decisions: ['Generated Skill files must be confirmed by a user before writing to .agents/skills.'],
          openQuestions: [],
          nextActions: ['Review the draft before confirming it.'],
          artifacts: ['server/domain/conversation/skill-draft.ts'],
          experience: [
            {
              sourceDraftId: 'expdraft-review-create',
              title: 'Create pending drafts from reviewed experience',
              category: 'pattern',
              scenario: 'When a write-experience draft captures a repeatable validated CAFF workflow.',
              steps: ['Review source-backed digest experience before creating a pending Skill draft.'],
              pitfalls: ['Do not write Skill files before human confirmation.'],
              validation: ['The draft remains pending in conversation metadata.'],
              artifacts: ['server/domain/conversation/skill-draft.ts'],
              confidence: 'high',
            },
          ],
        },
      ],
      experienceDrafts: [
        {
          id: 'expdraft-review-create',
          status: 'absorbed',
          title: 'Create pending drafts from reviewed experience',
          category: 'pattern',
          scenario: 'When a write-experience draft captures a repeatable validated CAFF workflow.',
          steps: ['Review source-backed digest experience before creating a pending Skill draft.'],
          pitfalls: ['Do not write Skill files before human confirmation.'],
          validation: ['The draft remains pending in conversation metadata.'],
          artifacts: ['server/domain/conversation/skill-draft.ts'],
          confidence: 'high',
          source: { type: 'agent-tool', agentId: 'agent-review' },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          absorbedAt: new Date().toISOString(),
          absorbedDigestId: 'digest-auto-skill-draft-review-create',
        },
      ],
    },
  });

  const draftResult = await maybeAutoCreateConversationSkillDraft(store, conversation.id, {
    digestId: 'digest-auto-skill-draft-review-create',
    trigger: 'message_budget',
  }, {
    autoCreate: true,
    generationMode: 'model',
    skillDraftModelRunner: async (context) => {
      modelCalls.push(context);
      return {
        shouldCreateSkill: true,
        reason: 'The digest contains a repeatable confirmation guardrail.',
        skill: {
          id: 'reviewed-auto-skill-draft',
          name: 'Reviewed Auto Skill Draft',
          description: 'Create pending Skill drafts only after reusable evidence is reviewed.',
          whenToUse: ['Use when digest evidence describes a repeatable CAFF workflow.'],
          steps: ['Check reusable decisions before creating a pending draft.'],
          pitfalls: ['Do not write files before human confirmation.'],
          validation: ['Assert the draft remains pending in conversation metadata.'],
          artifacts: ['server/domain/conversation/skill-draft.ts'],
          confidence: 0.86,
        },
      };
    },
  });

  assert.equal(draftResult.autoCreated, true);
  assert.equal(draftResult.reason, 'created');
  assert.equal(modelCalls.length, 1);
  assert.match(modelCalls[0].prompt, /shouldCreateSkill/u);
  assert.equal(draftResult.draft.skill.id, 'reviewed-auto-skill-draft');
  assert.match(draftResult.draft.skill.body, /Model confidence: 0\.86/u);
  assert.equal(store.getConversation(conversation.id).metadata.skillDraftAutoReviews, undefined);
});

test('auto skill draft rules skip weak reusable signals without model approval', async (t) => {
  const tempDir = withTempDir('caff-auto-skill-draft-weak-rules-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = createSmokeConversation(store, {
    id: 'auto-skill-draft-weak-rules-conversation',
    title: 'Auto Skill Draft Weak Rules Conversation',
    metadata: {
      conversationDigests: [
        {
          id: 'digest-auto-skill-draft-weak-rules',
          kind: 'entry',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          summary: 'A digest with only generic facts should not be auto-converted by rule fallback.',
          facts: ['A file was mentioned during the conversation.'],
          decisions: [],
          openQuestions: [],
          nextActions: [],
          artifacts: ['README.md'],
        },
      ],
    },
  });

  const result = await maybeAutoCreateConversationSkillDraft(store, conversation.id, {
    digestId: 'digest-auto-skill-draft-weak-rules',
    trigger: 'message_budget',
  }, {
    autoCreate: true,
    generationMode: 'rules',
  });

  assert.equal(result.autoCreated, false);
  assert.equal(result.reason, 'weak_reusable_signal');
  assert.equal(result.changed, true);
  assert.equal(store.getConversation(conversation.id).metadata.skillDrafts, undefined);
  assert.equal(store.getConversation(conversation.id).metadata.skillDraftAutoReviews.length, 1);
  assert.equal(store.getConversation(conversation.id).metadata.skillDraftAutoReviews[0].status, 'skipped');
});

test('auto skill draft model review skips digests without source-backed experience', async (t) => {
  const tempDir = withTempDir('caff-auto-skill-draft-no-source-experience-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  let modelCalls = 0;

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = createSmokeConversation(store, {
    id: 'auto-skill-draft-no-source-experience-conversation',
    title: 'Auto Skill Draft No Source Experience Conversation',
    metadata: {
      conversationDigests: [
        {
          id: 'digest-auto-skill-draft-no-source-experience',
          kind: 'entry',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          summary: 'A digest has facts and decisions but no write-experience-backed experience.',
          facts: ['A generic digest fact exists.'],
          decisions: ['Generated Skill drafts still require human confirmation.'],
          openQuestions: [],
          nextActions: ['Review the generic digest.'],
          artifacts: ['server/domain/conversation/skill-draft.ts'],
        },
      ],
    },
  });

  const result = await maybeAutoCreateConversationSkillDraft(store, conversation.id, {
    digestId: 'digest-auto-skill-draft-no-source-experience',
    trigger: 'message_budget',
  }, {
    autoCreate: true,
    generationMode: 'model',
    skillDraftModelRunner: async () => {
      modelCalls += 1;
      return {
        shouldCreateSkill: true,
        reason: 'This should not be called without source-backed experience.',
        skill: {
          id: 'unexpected-no-source-experience',
          name: 'Unexpected No Source Experience',
          description: 'This draft should not be auto-created.',
          whenToUse: ['Never.'],
          steps: ['Never.'],
          pitfalls: [],
          validation: [],
          artifacts: [],
          confidence: 0.9,
        },
      };
    },
  });

  assert.equal(result.autoCreated, false);
  assert.equal(result.reason, 'weak_reusable_signal');
  assert.equal(result.changed, true);
  assert.equal(modelCalls, 0);
  assert.equal(store.getConversation(conversation.id).metadata.skillDrafts, undefined);
  assert.equal(store.getConversation(conversation.id).metadata.skillDraftAutoReviews[0].status, 'skipped');
});

test('auto skill draft review creates pending drafts from auto-created digests', async (t) => {
  const tempDir = withTempDir('caff-auto-skill-draft-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = createSmokeConversation(store, {
    id: 'auto-skill-draft-conversation',
    title: 'Auto Skill Draft Conversation',
    metadata: {
      experienceDrafts: [
        {
          id: 'expdraft-auto-skill-draft-source',
          status: 'pending',
          title: 'Auto-create Skill drafts from source experience',
          category: 'pattern',
          scenario: 'When an agent writes a reusable experience draft before auto digest creation.',
          steps: ['Absorb the pending experience into digest.experience before auto-reviewing Skill drafts.'],
          pitfalls: ['Do not create drafts from ordinary digest facts alone.'],
          validation: ['Auto-created Skill draft remains pending for human confirmation.'],
          artifacts: ['server/domain/conversation/skill-draft.ts'],
          confidence: 'high',
          source: { type: 'agent-tool', agentId: 'agent-experience' },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    },
  });

  for (let index = 1; index <= 2; index += 1) {
    store.createMessage({
      id: `auto-skill-draft-message-${index}`,
      conversationId: conversation.id,
      turnId: 'auto-skill-draft-turn',
      role: index % 2 === 0 ? 'assistant' : 'user',
      senderName: index % 2 === 0 ? 'Builder' : 'User',
      content: `经验复用消息 ${index}：决定把 digest 提炼成 pending skill draft，并保留人工确认。`,
    });
  }

  const digestResult = await maybeAutoCreateConversationDigest(store, conversation.id, {
    autoCreate: true,
    autoCreateMessageBudget: 2,
    autoCreateIdleMs: 0,
    autoCreateCooldownMs: 0,
    autoCreateHighValue: false,
    summaryMode: 'model',
    digestModelRunner: async () => ({
      summary: '自动复盘发现可复用经验：摘要可以提炼为 skill 草稿。',
      facts: ['自动复盘只能创建 pending draft，不能直接启用 skill。'],
      decisions: ['用户确认后才写入 .agents/skills。'],
      openQuestions: ['是否要把候选提升成正式 skill 仍需人工判断。'],
      nextActions: ['预览草稿并由用户确认或拒绝。'],
      artifacts: ['server/domain/conversation/skill-draft.ts'],
      experience: [
        {
          sourceDraftId: 'expdraft-auto-skill-draft-source',
          title: 'Auto-create Skill drafts from source experience',
          category: 'pattern',
          scenario: 'When an agent writes a reusable experience draft before auto digest creation.',
          steps: ['Absorb the pending experience into digest.experience before auto-reviewing Skill drafts.'],
          pitfalls: ['Do not create drafts from ordinary digest facts alone.'],
          validation: ['Auto-created Skill draft remains pending for human confirmation.'],
          artifacts: ['server/domain/conversation/skill-draft.ts'],
          confidence: 'high',
        },
      ],
    }),
  });

  assert.equal(digestResult.autoCreated, true);

  const disabledResult = await maybeAutoCreateConversationSkillDraft(store, conversation.id, {
    digestId: digestResult.digest.id,
    trigger: digestResult.triggerReason,
  }, {
    autoCreate: false,
  });

  assert.equal(disabledResult.autoCreated, false);
  assert.equal(disabledResult.reason, 'disabled');
  assert.equal(store.getConversation(conversation.id).metadata.skillDrafts, undefined);

  const draftResult = await maybeAutoCreateConversationSkillDraft(store, conversation.id, {
    digestId: digestResult.digest.id,
    trigger: digestResult.triggerReason,
  }, {
    autoCreate: true,
    generationMode: 'rules',
  });

  assert.equal(draftResult.autoCreated, true);
  assert.equal(draftResult.reason, 'created');
  assert.equal(draftResult.draft.status, 'pending');
  assert.equal(draftResult.draft.source.digestId, digestResult.digest.id);
  assert.equal(draftResult.draft.source.trigger, 'message_budget');
  assert.equal(draftResult.draft.source.createdBy, 'system:auto-skill-draft');
  assert.equal(draftResult.draft.source.autoCreated, true);
  assert.match(draftResult.draft.skill.body, /Limits \/ Unconfirmed Points/u);
  assert.match(draftResult.draft.skill.body, /是否要把候选提升成正式 skill/u);
  assert.equal(store.getConversation(conversation.id).metadata.skillDrafts.length, 1);

  const duplicateResult = await maybeAutoCreateConversationSkillDraft(store, conversation.id, {
    digestId: digestResult.digest.id,
    trigger: digestResult.triggerReason,
  }, {
    autoCreate: true,
  });

  assert.equal(duplicateResult.autoCreated, false);
  assert.equal(duplicateResult.reason, 'already_pending');
  assert.equal(store.getConversation(conversation.id).metadata.skillDrafts.length, 1);
});

test('create server auto-digest status announces pending experience absorption', async (t) => {
  const tempDir = withTempDir('caff-auto-digest-status-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const broadcastEvents = [];
  const app = createServerApp({
    host: '127.0.0.1',
    port: 0,
    agentDir: tempDir,
    sqlitePath,
    projectDir: tempDir,
    digestOptions: {
      autoCreate: true,
      autoCreateMessageBudget: 24,
      autoCreateIdleMs: 0,
      autoCreateCooldownMs: 0,
      autoCreateHighValue: false,
      summaryMode: 'extractive',
    },
    onBroadcastEvent(eventName, payload) {
      broadcastEvents.push({ eventName, payload });
    },
  });

  t.after(() => {
    try {
      app.store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = createSmokeConversation(app.store, {
    id: 'auto-digest-status-conversation',
    title: 'Auto Digest Status Conversation',
    metadata: {
      experienceDrafts: [
        {
          id: 'expdraft-auto-digest-status',
          status: 'pending',
          title: 'Await digest absorption before routing',
          category: 'decision',
          scenario: 'When an agent writes pending experience before its final public reply.',
          steps: ['Broadcast a compact status while the awaited digest hook runs.'],
          pitfalls: [],
          validation: ['node --test tests/smoke/server-smoke.test.js passed'],
          artifacts: ['server/app/create-server.ts'],
          confidence: 'high',
          source: {
            type: 'agent-tool',
            conversationId: 'auto-digest-status-conversation',
            agentId: 'agent-status',
            turnId: 'turn-status',
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    },
  });

  app.store.createMessage({
    id: 'auto-digest-status-message-1',
    conversationId: conversation.id,
    turnId: 'auto-digest-status-turn',
    role: 'assistant',
    senderName: 'Builder',
    content: '已验证 pending experience 需要在同轮路由前被摘要吸收。'
  });

  await app.runMaybeAutoCreateDigest(conversation.id);

  const eventNames = broadcastEvents.map((event) => event.eventName);
  const runningStatusIndex = broadcastEvents.findIndex(
    (event) => event.eventName === 'conversation_digest_status' && event.payload.status === 'running'
  );
  const digestEventIndex = eventNames.indexOf('conversation_digest_updated');
  const idleStatusIndex = broadcastEvents.findIndex(
    (event) => event.eventName === 'conversation_digest_status' && event.payload.status === 'idle'
  );

  assert.notEqual(runningStatusIndex, -1);
  assert.notEqual(digestEventIndex, -1);
  assert.notEqual(idleStatusIndex, -1);
  assert.ok(runningStatusIndex < digestEventIndex);
  assert.ok(digestEventIndex < idleStatusIndex);
  assert.equal(broadcastEvents[runningStatusIndex].payload.reason, 'pending_experience');
  assert.equal(broadcastEvents[runningStatusIndex].payload.pendingExperienceDraftCount, 1);
  assert.equal(app.store.getConversation(conversation.id).metadata.experienceDrafts[0].status, 'absorbed');
});

test('create server auto-digest status exposes model progress trace', async (t) => {
  const tempDir = withTempDir('caff-auto-digest-model-progress-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const broadcastEvents = [];
  const app = createServerApp({
    host: '127.0.0.1',
    port: 0,
    agentDir: tempDir,
    sqlitePath,
    projectDir: tempDir,
    digestOptions: {
      autoCreate: true,
      autoCreateMessageBudget: 1,
      autoCreateIdleMs: 0,
      autoCreateCooldownMs: 0,
      autoCreateHighValue: false,
      summaryMode: 'model',
    },
    digestModelRunner: async ({ onModelProgress }) => {
      onModelProgress({
        reason: 'model_digest',
        phase: 'entry',
        message: '会话摘要模型正在生成 JSON…',
        model: { provider: 'fake', model: 'digest-model', thinking: 'xhigh', label: 'fake/digest-model' },
        modelTrace: {
          eventCount: 3,
          thinkingPreview: '先识别事实，再输出 JSON。',
          outputPreview: '{"summary":"处理中"',
          runId: 'run-digest-progress',
        },
      });
      return {
        summary: '模型摘要完成。',
        facts: ['前端可以查看摘要模型进度。'],
        decisions: [],
        openQuestions: [],
        nextActions: [],
        artifacts: ['public/chat/message-timeline.js'],
      };
    },
    onBroadcastEvent(eventName, payload) {
      broadcastEvents.push({ eventName, payload });
    },
  });

  t.after(() => {
    try {
      app.store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = createSmokeConversation(app.store, {
    id: 'auto-digest-model-progress-conversation',
    title: 'Auto Digest Model Progress Conversation',
  });

  app.store.createMessage({
    id: 'auto-digest-model-progress-message-1',
    conversationId: conversation.id,
    role: 'assistant',
    senderName: 'Builder',
    content: '已完成一个需要摘要的模型进度展示改动。',
  });

  await app.runMaybeAutoCreateDigest(conversation.id);

  const progressStatusIndex = broadcastEvents.findIndex(
    (event) => event.eventName === 'conversation_digest_status'
      && event.payload.status === 'running'
      && event.payload.reason === 'model_digest'
  );
  const digestEventIndex = broadcastEvents.findIndex((event) => event.eventName === 'conversation_digest_updated');
  const idleStatusIndex = broadcastEvents.findIndex(
    (event) => event.eventName === 'conversation_digest_status' && event.payload.status === 'idle'
  );

  assert.notEqual(progressStatusIndex, -1);
  assert.notEqual(digestEventIndex, -1);
  assert.notEqual(idleStatusIndex, -1);
  assert.ok(progressStatusIndex < digestEventIndex);
  assert.ok(digestEventIndex < idleStatusIndex);
  assert.equal(broadcastEvents[progressStatusIndex].payload.model.label, 'fake/digest-model');
  assert.equal(broadcastEvents[progressStatusIndex].payload.modelTrace.thinkingPreview, '先识别事实，再输出 JSON。');
  assert.match(broadcastEvents[progressStatusIndex].payload.modelTrace.outputPreview, /summary/u);
});

test('create server auto-digest hook broadcasts auto skill draft updates', async (t) => {
  const tempDir = withTempDir('caff-auto-skill-draft-hook-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const broadcastEvents = [];
  const app = createServerApp({
    host: '127.0.0.1',
    port: 0,
    agentDir: tempDir,
    sqlitePath,
    projectDir: tempDir,
    digestOptions: {
      autoCreate: true,
      autoCreateMessageBudget: 2,
      autoCreateIdleMs: 0,
      autoCreateCooldownMs: 0,
      autoCreateHighValue: false,
      summaryMode: 'model',
    },
    skillDraftOptions: {
      autoCreate: true,
      generationMode: 'rules',
    },
    digestModelRunner: async () => ({
      summary: '自动摘要 hook 发现可复用经验。',
      facts: ['自动摘要 hook 应该创建 pending skill draft。'],
      decisions: ['必须先广播 skill draft 更新，再广播 digest 更新。'],
      openQuestions: [],
      nextActions: ['观察 SSE 事件并确认草稿仍需人工确认。'],
      artifacts: ['server/app/create-server.ts'],
      experience: [
        {
          sourceDraftId: 'expdraft-auto-skill-draft-hook-source',
          title: 'Hook creates drafts from source experience',
          category: 'pattern',
          scenario: 'When the create-server auto-digest hook absorbs a write-experience draft.',
          steps: ['Broadcast the pending Skill draft update before the digest update.'],
          pitfalls: ['Do not broadcast Skill drafts for ordinary auto digests without source experience.'],
          validation: ['SSE events show skill draft update before digest update.'],
          artifacts: ['server/app/create-server.ts'],
          confidence: 'high',
        },
      ],
    }),
    onBroadcastEvent(eventName, payload) {
      broadcastEvents.push({ eventName, payload });
    },
  });

  t.after(() => {
    try {
      app.store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = createSmokeConversation(app.store, {
    id: 'auto-skill-draft-hook-conversation',
    title: 'Auto Skill Draft Hook Conversation',
    metadata: {
      experienceDrafts: [
        {
          id: 'expdraft-auto-skill-draft-hook-source',
          status: 'pending',
          title: 'Hook creates drafts from source experience',
          category: 'pattern',
          scenario: 'When the create-server auto-digest hook absorbs a write-experience draft.',
          steps: ['Broadcast the pending Skill draft update before the digest update.'],
          pitfalls: ['Do not broadcast Skill drafts for ordinary auto digests without source experience.'],
          validation: ['SSE events show skill draft update before digest update.'],
          artifacts: ['server/app/create-server.ts'],
          confidence: 'high',
          source: { type: 'agent-tool', agentId: 'agent-experience' },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    },
  });

  for (const index of [1, 2]) {
    app.store.createMessage({
      id: `auto-skill-draft-hook-message-${index}`,
      conversationId: conversation.id,
      turnId: `auto-skill-draft-hook-turn-${index}`,
      role: index === 1 ? 'user' : 'assistant',
      senderName: index === 1 ? 'User' : 'Builder',
      content: `自动摘要 hook 消息 ${index}：提炼经验草稿但不自动启用 skill。`,
    });
  }

  await app.runMaybeAutoCreateDigest(conversation.id);

  const eventNames = broadcastEvents.map((event) => event.eventName);
  const skillDraftEventIndex = eventNames.indexOf('conversation_skill_draft_updated');
  const digestEventIndex = eventNames.indexOf('conversation_digest_updated');
  assert.notEqual(skillDraftEventIndex, -1);
  assert.notEqual(digestEventIndex, -1);
  assert.ok(skillDraftEventIndex < digestEventIndex);

  const skillDraftEvent = broadcastEvents[skillDraftEventIndex];
  assert.equal(skillDraftEvent.payload.autoCreated, true);
  assert.equal(skillDraftEvent.payload.reason, 'created');
  assert.equal(skillDraftEvent.payload.draft.source.autoCreated, true);
  assert.equal(app.store.getConversation(conversation.id).metadata.skillDrafts.length, 1);
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
  const conversation = createSmokeConversation(store, {
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

  const idleConversation = createSmokeConversation(store, {
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

  const gatedConversation = createSmokeConversation(store, {
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

  const highValueConversation = createSmokeConversation(store, {
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
  assert.equal(highValueResult.signalFlags.codeChange, true);
  assert.equal(highValueResult.signalFlags.fileArtifact, true);
  assert.equal(highValueResult.signalFlags.errorFix, true);

  const weakSignalConversation = createSmokeConversation(store, {
    id: 'digest-auto-create-weak-signal-conversation',
    title: 'Digest Auto Create Weak Signal Conversation',
  });

  for (let index = 1; index <= 6; index += 1) {
    store.createMessage({
      id: `digest-auto-create-weak-signal-message-${index}`,
      conversationId: weakSignalConversation.id,
      turnId: 'digest-auto-create-weak-signal-turn',
      role: index % 2 === 0 ? 'assistant' : 'user',
      senderName: index % 2 === 0 ? 'Builder' : 'User',
      content: `弱信号自动摘要消息 ${index}：只是提到 server/domain/file.ts、配置和测试名。`,
      createdAt: oldTimestamp,
    });
  }

  const weakSignalResult = await maybeAutoCreateConversationDigest(store, weakSignalConversation.id, {
    autoCreate: true,
    autoCreateMessageBudget: 24,
    autoCreateHighValue: true,
    autoCreateHighValueMinMessages: 6,
    summaryMode: 'extractive',
  });

  assert.equal(weakSignalResult.autoCreated, false);
  assert.equal(weakSignalResult.reason, 'below_budget');
  assert.equal(weakSignalResult.signalFlags.fileArtifact, true);
  assert.equal(weakSignalResult.signalFlags.codeChange, false);
  assert.equal(weakSignalResult.signalFlags.code, false);

  const experienceConversation = createSmokeConversation(store, {
    id: 'digest-auto-create-pending-experience-conversation',
    title: 'Digest Auto Create Pending Experience Conversation',
    metadata: {
      conversationDigestState: {
        lastAutoDigestAt: oldTimestamp,
      },
      experienceDrafts: [
        {
          id: 'expdraft-auto-create-source',
          status: 'pending',
          title: 'Pending experience should trigger a digest',
          category: 'pattern',
          scenario: 'When an agent writes a reusable experience draft before the normal digest message budget is reached.',
          steps: ['Let auto-create generate the next digest so digest.experience can feed Skill drafts.'],
          pitfalls: ['Do not wait indefinitely for the normal message budget when pending experience exists.'],
          validation: ['node --test tests/smoke/server-smoke.test.js passed'],
          artifacts: ['server/domain/conversation/conversation-digest.ts'],
          confidence: 'high',
          source: {
            type: 'agent-tool',
            agentId: 'agent-experience',
            turnId: 'turn-experience-auto-create',
            conversationId: 'digest-auto-create-pending-experience-conversation',
          },
          createdAt: oldTimestamp,
          updatedAt: oldTimestamp,
        },
      ],
    },
  });
  store.createMessage({
    id: 'digest-auto-create-pending-experience-message-1',
    conversationId: experienceConversation.id,
    turnId: 'turn-experience-auto-create',
    role: 'assistant',
    senderName: 'Builder',
    content: '已写入一条 pending experience，但普通摘要预算还没达到。',
    createdAt: oldTimestamp,
  });

  const experienceResult = await maybeAutoCreateConversationDigest(store, experienceConversation.id, {
    autoCreate: true,
    autoCreateMessageBudget: 24,
    autoCreateHighValue: false,
    autoCreateIdleMs: 60 * 60 * 1000,
    autoCreateCooldownMs: 60 * 60 * 1000,
    summaryMode: 'extractive',
  });

  assert.equal(experienceResult.autoCreated, true);
  assert.equal(experienceResult.triggerReason, 'pending_experience');
  assert.equal(experienceResult.digest.messageRange.messageCount, 1);
  assert.equal(experienceResult.digest.experience.length, 1);
  assert.equal(experienceResult.digest.experience[0].sourceDraftId, 'expdraft-auto-create-source');
  assert.equal(store.getConversation(experienceConversation.id).metadata.experienceDrafts[0].status, 'absorbed');
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

  const conversation = createSmokeConversation(store, {
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

test('conversations controller keeps extractive digest facts conservative', async (t) => {
  const { handler, store } = createConversationsControllerHarness(t);
  const conversation = createSmokeConversation(store, {
    id: 'digest-extractive-conservative-conversation',
    title: 'Digest Conservative Conversation',
  });

  store.createMessage({
    id: 'digest-conservative-user-message',
    conversationId: conversation.id,
    turnId: 'digest-conservative-turn',
    role: 'user',
    senderName: 'User',
    content: '用户确认事实：CAFF 需要摘要层记住已确认上下文。',
  });
  store.createMessage({
    id: 'digest-conservative-assistant-message',
    conversationId: conversation.id,
    turnId: 'digest-conservative-turn',
    role: 'assistant',
    senderName: 'Builder',
    content: '我觉得可能要先改 server/domain/conversation/conversation-digest.ts，这只是建议。',
  });
  store.createMessage({
    id: 'digest-conservative-verified-message',
    conversationId: conversation.id,
    turnId: 'digest-conservative-turn',
    role: 'assistant',
    senderName: 'Builder',
    content: '已验证：测试通过，保守摘要分类已经落地。',
  });

  const createResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/digest`,
    body: { action: 'create' },
  });

  assert.equal(createResult.statusCode, 200);
  assert.ok(createResult.json.digest.facts.some((item) => item.includes('用户确认事实')));
  assert.ok(createResult.json.digest.facts.some((item) => item.includes('已验证')));
  assert.ok(!createResult.json.digest.facts.some((item) => item.includes('这只是建议')));
  assert.ok(createResult.json.digest.openQuestions.some((item) => item.includes('这只是建议')));
  assert.ok(createResult.json.digest.artifacts.includes('server/domain/conversation/conversation-digest.ts'));
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
  const conversation = createSmokeConversation(store, {
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
  assert.match(modelCalls[0].prompt, /Return exactly one valid compact JSON object/u);
  assert.match(modelCalls[0].prompt, /Do not wrap it in markdown, code fences, XML, prose, comments, or multiple JSON objects/u);
  assert.match(modelCalls[0].prompt, /Few-shot valid output/u);
  assert.match(modelCalls[0].prompt, /Do not copy the few-shot example/u);
  assert.equal(createResult.json.digest.summary, '模型总结：已经确认用便宜模型生成会话摘要。');
  assert.equal(createResult.json.digest.createdBy, 'model:cheap-provider/cheap-model');
  assert.ok(createResult.json.digest.decisions.some((item) => item.includes('保留规则摘要')));
});

test('conversations controller accepts direct JSON mode digest output', async (t) => {
  const calls = [];
  global.__CAFF_JSON_MODE_DIGEST_CALLS = calls;
  t.after(() => {
    delete global.__CAFF_JSON_MODE_DIGEST_CALLS;
  });

  const moduleSource = `
    export function getModel(provider, model) {
      return { id: model, name: model, api: 'openai-completions', provider };
    }
    export async function complete(model, context, options) {
      const payload = options.onPayload({ model: model.id, messages: [], stream: false }, model);
      globalThis.__CAFF_JSON_MODE_DIGEST_CALLS.push({
        model,
        hasTools: Array.isArray(context.tools),
        toolChoice: options.toolChoice,
        responseFormat: payload && payload.response_format,
        maxTokens: options.maxTokens,
        systemPrompt: context.systemPrompt,
      });
      return {
        role: 'assistant',
        content: [{
          type: 'text',
          text: JSON.stringify({
            summary: 'JSON Mode 总结：摘要通过 response_format 返回。',
            facts: ['JSON Mode 事实：模型返回了合法 JSON 对象。'],
            decisions: ['JSON Mode 决策：不再使用虚拟工具调用。'],
            openQuestions: [],
            nextActions: ['继续验证 fallback。'],
            artifacts: ['server/domain/conversation/conversation-digest.ts']
          })
        }],
        stopReason: 'stop',
        timestamp: Date.now()
      };
    }
  `;
  const { handler, store } = createConversationsControllerHarness(t, {
    digestOptions: {
      piAiModuleSpecifier: `data:text/javascript,${encodeURIComponent(moduleSource)}`,
    },
  });
  const conversation = createSmokeConversation(store, {
    id: 'digest-json-mode-conversation',
    title: 'Digest JSON Mode Conversation',
  });

  store.createMessage({
    id: 'digest-json-mode-message-1',
    conversationId: conversation.id,
    turnId: 'digest-json-mode-turn-1',
    role: 'user',
    senderName: 'User',
    content: '决定让摘要模型用 JSON Mode 返回结构化内容。',
  });

  const result = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/digest`,
    body: {
      action: 'create',
      summaryMode: 'model',
      provider: 'cheap-provider',
      model: 'cheap-model',
    },
  });

  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hasTools, false);
  assert.equal(calls[0].toolChoice, undefined);
  assert.deepEqual(calls[0].responseFormat, { type: 'json_object' });
  assert.equal(calls[0].maxTokens, 4096);
  assert.match(calls[0].systemPrompt, /Return exactly one valid compact JSON object/u);
  assert.equal(result.json.digest.summary, 'JSON Mode 总结：摘要通过 response_format 返回。');
  assert.equal(result.json.digest.createdBy, 'model:cheap-provider/cheap-model');
  assert.ok(result.json.digest.facts.some((item) => item.includes('合法 JSON 对象')));
});

test('conversations controller extracts JSON mode text when response includes thinking blocks', async (t) => {
  const calls = [];
  global.__CAFF_JSON_MODE_THINKING_TEXT_CALLS = calls;
  t.after(() => {
    delete global.__CAFF_JSON_MODE_THINKING_TEXT_CALLS;
  });

  const moduleSource = `
    export function getModel(provider, model) {
      return { id: model, name: model, api: 'openai-completions', provider };
    }
    export async function complete(model, context, options) {
      const payload = options.onPayload({ model: model.id, messages: [], stream: false }, model);
      globalThis.__CAFF_JSON_MODE_THINKING_TEXT_CALLS.push({ responseFormat: payload && payload.response_format });
      return {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '这段思考不能被当成摘要 JSON。' },
          {
            type: 'output_text',
            text: JSON.stringify({
              summary: 'JSON Mode 总结：文本块里的摘要被正确提取。',
              facts: ['JSON Mode 事实：thinking 块被忽略。'],
              decisions: ['JSON Mode 决策：只解析可见文本 JSON。'],
              openQuestions: [],
              nextActions: [],
              artifacts: ['server/domain/conversation/conversation-digest.ts']
            })
          }
        ],
        stopReason: 'stop',
        timestamp: Date.now()
      };
    }
  `;
  const { handler, store } = createConversationsControllerHarness(t, {
    digestOptions: {
      piAiModuleSpecifier: `data:text/javascript,${encodeURIComponent(moduleSource)}`,
    },
  });
  const conversation = createSmokeConversation(store, {
    id: 'digest-json-mode-thinking-text-conversation',
    title: 'Digest JSON Mode Thinking Text Conversation',
  });

  store.createMessage({
    id: 'digest-json-mode-thinking-text-message-1',
    conversationId: conversation.id,
    turnId: 'digest-json-mode-thinking-text-turn-1',
    role: 'user',
    senderName: 'User',
    content: '如果 JSON Mode 响应带 thinking 块，也只能解析最终文本 JSON。',
  });

  const result = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/digest`,
    body: {
      action: 'create',
      summaryMode: 'model',
      provider: 'cheap-provider',
      model: 'cheap-model',
    },
  });

  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].responseFormat, { type: 'json_object' });
  assert.equal(result.json.digest.summary, 'JSON Mode 总结：文本块里的摘要被正确提取。');
  assert.equal(result.json.digest.createdBy, 'model:cheap-provider/cheap-model');
  assert.ok(result.json.digest.facts.some((item) => item.includes('thinking 块被忽略')));
});

test('conversations controller falls back when JSON mode digest output is missing required fields', async (t) => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
    delete global.__CAFF_JSON_MODE_MALFORMED_CALLS;
  });

  const calls = [];
  global.__CAFF_JSON_MODE_MALFORMED_CALLS = calls;
  const moduleSource = `
    export function getModel(provider, model) {
      return { id: model, name: model, api: 'openai-completions', provider };
    }
    export async function complete(model, context, options) {
      const payload = options.onPayload({ model: model.id, messages: [], stream: false }, model);
      globalThis.__CAFF_JSON_MODE_MALFORMED_CALLS.push({ responseFormat: payload && payload.response_format });
      return {
        role: 'assistant',
        content: [{
          type: 'text',
          text: JSON.stringify({
            summary: '这个缺少 openQuestions，不能入库。',
            facts: ['坏结构事实。'],
            decisions: [],
            nextActions: [],
            artifacts: []
          })
        }],
        stopReason: 'stop',
        timestamp: Date.now()
      };
    }
  `;
  const { handler, store } = createConversationsControllerHarness(t, {
    digestOptions: {
      piAiModuleSpecifier: `data:text/javascript,${encodeURIComponent(moduleSource)}`,
    },
  });
  const conversation = createSmokeConversation(store, {
    id: 'digest-json-mode-malformed-conversation',
    title: 'Digest JSON Mode Malformed Conversation',
  });

  store.createMessage({
    id: 'digest-json-mode-malformed-message-1',
    conversationId: conversation.id,
    turnId: 'digest-json-mode-malformed-turn-1',
    role: 'user',
    senderName: 'User',
    content: '决定缺字段的 JSON Mode 摘要必须回退到规则摘要。',
  });

  const result = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/digest`,
    body: {
      action: 'create',
      summaryMode: 'model',
      provider: 'cheap-provider',
      model: 'cheap-model',
    },
  });

  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].responseFormat, { type: 'json_object' });
  assert.equal(result.json.digest.createdBy, 'user');
  assert.match(result.json.digest.summary, /^Extractive digest of 1 public messages\./u);
  assert.ok(result.json.digest.decisions.some((item) => item.includes('规则摘要')));
  assert.ok(warnings.some((warning) => warning.includes('missing required field: openQuestions')));
});

test('conversations controller falls back when JSON mode digest output is not an object', async (t) => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
    delete global.__CAFF_JSON_MODE_BAD_OUTPUT_CALLS;
  });

  const calls = [];
  global.__CAFF_JSON_MODE_BAD_OUTPUT_CALLS = calls;
  const moduleSource = `
    export function getModel(provider, model) {
      return { id: model, name: model, api: 'openai-completions', provider };
    }
    export async function complete(model, context, options) {
      const payload = options.onPayload({ model: model.id, messages: [], stream: false }, model);
      globalThis.__CAFF_JSON_MODE_BAD_OUTPUT_CALLS.push({ responseFormat: payload && payload.response_format });
      return {
        role: 'assistant',
        content: [{ type: 'text', text: '["不是摘要对象"]' }],
        stopReason: 'stop',
        timestamp: Date.now()
      };
    }
  `;
  const { handler, store } = createConversationsControllerHarness(t, {
    digestOptions: {
      piAiModuleSpecifier: `data:text/javascript,${encodeURIComponent(moduleSource)}`,
    },
  });
  const conversation = createSmokeConversation(store, {
    id: 'digest-json-mode-bad-output-conversation',
    title: 'Digest JSON Mode Bad Output Conversation',
  });

  store.createMessage({
    id: 'digest-json-mode-bad-output-message-1',
    conversationId: conversation.id,
    turnId: 'digest-json-mode-bad-output-turn-1',
    role: 'assistant',
    senderName: 'Builder',
    content: '下一步确认坏 JSON Mode 摘要只能回退，不能污染摘要。',
  });

  const result = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/digest`,
    body: {
      action: 'create',
      summaryMode: 'model',
      provider: 'cheap-provider',
      model: 'cheap-model',
    },
  });

  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(result.json.digest.createdBy, 'user');
  assert.match(result.json.digest.summary, /^Extractive digest of 1 public messages\./u);
  assert.ok(result.json.digest.nextActions.some((item) => item.includes('只能回退')));
  assert.ok(warnings.some((warning) => warning.includes('digest JSON must be an object')));
});

test('conversations controller falls back when JSON mode assistant response has no text JSON', async (t) => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
    delete global.__CAFF_JSON_MODE_THINKING_ONLY_CALLS;
  });

  const calls = [];
  global.__CAFF_JSON_MODE_THINKING_ONLY_CALLS = calls;
  const moduleSource = `
    export function getModel(provider, model) {
      return { id: model, name: model, api: 'openai-completions', provider };
    }
    export async function complete(model, context, options) {
      const payload = options.onPayload({
        model: model.id,
        messages: [],
        stream: false,
        reasoning: { effort: 'high' },
        reasoning_effort: 'high'
      }, model);
      globalThis.__CAFF_JSON_MODE_THINKING_ONLY_CALLS.push({
        purpose: options.metadata && options.metadata.purpose,
        responseFormat: payload && payload.response_format,
        thinking: payload && payload.thinking,
        reasoning: payload && payload.reasoning,
        reasoningEffort: payload && payload.reasoning_effort,
      });
      return {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '这里只有思考内容，没有最终摘要 JSON。' }],
        stopReason: 'length',
        timestamp: Date.now()
      };
    }
  `;
  const { handler, store, broadcastEvents } = createConversationsControllerHarness(t, {
    digestOptions: {
      piAiModuleSpecifier: `data:text/javascript,${encodeURIComponent(moduleSource)}`,
    },
  });
  const conversation = createSmokeConversation(store, {
    id: 'digest-json-mode-thinking-only-conversation',
    title: 'Digest JSON Mode Thinking Only Conversation',
  });

  store.createMessage({
    id: 'digest-json-mode-thinking-only-message-1',
    conversationId: conversation.id,
    turnId: 'digest-json-mode-thinking-only-turn-1',
    role: 'assistant',
    senderName: 'Builder',
    content: '先准备两条摘要，然后让模型压缩旧摘要。',
  });

  for (const index of [1, 2]) {
    await invokeConversationsController(handler, {
      method: 'POST',
      pathname: `/api/conversations/${conversation.id}/digest`,
      body: {
        action: 'create',
        summary: `Thinking only source ${index}`,
        facts: [`ThinkingOnlyUnique${index}`],
      },
    });
  }

  const result = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/digest`,
    body: {
      action: 'compact',
      summaryMode: 'model',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    },
  });

  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].purpose, 'rollup');
  assert.deepEqual(calls[0].responseFormat, { type: 'json_object' });
  assert.deepEqual(calls[0].thinking, { type: 'disabled' });
  assert.equal(calls[0].reasoning, undefined);
  assert.equal(calls[0].reasoningEffort, undefined);
  assert.equal(result.json.rollup.createdBy, 'system:auto-compaction');
  assert.match(result.json.rollup.summary, /^Auto-compacted rollup/u);
  assert.ok(warnings.some((warning) => warning.includes('digest JSON text was missing from assistant response')));
  const runningStatusIndex = broadcastEvents.findIndex(
    (event) => event.eventName === 'conversation_digest_status'
      && event.payload.status === 'running'
      && event.payload.phase === 'rollup'
  );
  const idleStatusIndex = broadcastEvents.findIndex(
    (event) => event.eventName === 'conversation_digest_status' && event.payload.status === 'idle'
  );
  assert.notEqual(runningStatusIndex, -1);
  assert.notEqual(idleStatusIndex, -1);
  assert.ok(runningStatusIndex < idleStatusIndex);
  assert.match(broadcastEvents[runningStatusIndex].payload.message, /压缩历史摘要/u);
});

test('conversations controller falls back when JSON mode pi-ai module import fails', async (t) => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
  });

  const { handler, store } = createConversationsControllerHarness(t, {
    digestOptions: {
      piAiModuleSpecifier: 'caff-missing-pi-ai-module-for-test',
    },
  });
  const conversation = createSmokeConversation(store, {
    id: 'digest-json-mode-import-failure-conversation',
    title: 'Digest JSON Mode Import Failure Conversation',
  });

  store.createMessage({
    id: 'digest-json-mode-import-failure-message-1',
    conversationId: conversation.id,
    turnId: 'digest-json-mode-import-failure-turn-1',
    role: 'user',
    senderName: 'User',
    content: '如果 pi-ai 模块加载失败，摘要生成应该安全回退到规则摘要。',
  });

  const result = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/digest`,
    body: {
      action: 'create',
      summaryMode: 'model',
      provider: 'cheap-provider',
      model: 'cheap-model',
    },
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.json.digest.createdBy, 'user');
  assert.match(result.json.digest.summary, /^Extractive digest of 1 public messages\./u);
  assert.ok(warnings.some((warning) => warning.includes('caff-missing-pi-ai-module-for-test')));
});

test('conversations controller builds a direct DeepSeek digest model from models.json when pi-ai registry lacks it', async (t) => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalDeepSeekKey = process.env.DEEPSEEK_API_KEY;
  const agentDir = withTempDir('caff-deepseek-models-json-');
  const calls = [];
  global.__CAFF_DEEPSEEK_DIGEST_CALLS = calls;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.DEEPSEEK_API_KEY;
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      deepseek: {
        baseUrl: 'https://api.deepseek.example/v1',
        api: 'openai-completions',
        apiKey: 'test-models-json-deepseek-api-key',
        compat: { supportsStrictMode: false },
        models: [{
          id: 'deepseek-v4-flash',
          name: 'deepseek-v4-flash',
          reasoning: true,
          compat: { maxTokensField: 'max_tokens', supportsReasoningEffort: false },
        }],
      },
    },
  }));
  t.after(() => {
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    if (originalDeepSeekKey === undefined) {
      delete process.env.DEEPSEEK_API_KEY;
    } else {
      process.env.DEEPSEEK_API_KEY = originalDeepSeekKey;
    }
    fs.rmSync(agentDir, { recursive: true, force: true });
    delete global.__CAFF_DEEPSEEK_DIGEST_CALLS;
  });

  const moduleSource = `
    export function getModel() { return undefined; }
    export function getModels() { return []; }
    export async function complete(model, context, options) {
      const payload = options.onPayload({ model: model.id, messages: [], stream: false }, model);
      globalThis.__CAFF_DEEPSEEK_DIGEST_CALLS.push({
        model,
        hasTools: Array.isArray(context.tools),
        toolChoice: options.toolChoice,
        apiKey: options.apiKey,
        responseFormat: payload && payload.response_format,
      });
      return {
        role: 'assistant',
        content: [{
          type: 'text',
          text: JSON.stringify({
            summary: 'DeepSeek JSON Mode 总结：直连模型 fallback 已启用。',
            facts: ['DeepSeek v4 flash 不在 pi-ai registry 时会从 models.json 构造 openai-completions 模型。'],
            decisions: ['直接使用 JSON Mode，而不是虚拟工具调用。'],
            openQuestions: [],
            nextActions: [],
            artifacts: ['server/domain/conversation/conversation-digest.ts']
          })
        }],
        stopReason: 'stop',
        timestamp: Date.now()
      };
    }
  `;

  const { handler, store } = createConversationsControllerHarness(t, {
    digestOptions: {
      piAiModuleSpecifier: `data:text/javascript,${encodeURIComponent(moduleSource)}`,
    },
  });
  const conversation = createSmokeConversation(store, {
    id: 'digest-json-mode-deepseek-fallback-conversation',
    title: 'Digest JSON Mode DeepSeek Fallback Conversation',
  });

  store.createMessage({
    id: 'digest-json-mode-deepseek-fallback-message-1',
    conversationId: conversation.id,
    turnId: 'digest-json-mode-deepseek-fallback-turn-1',
    role: 'user',
    senderName: 'User',
    content: '请用 DeepSeek v4 flash 触发 JSON Mode 摘要。'
  });

  const result = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/digest`,
    body: {
      action: 'create',
      summaryMode: 'model',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    },
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.json.digest.summary, 'DeepSeek JSON Mode 总结：直连模型 fallback 已启用。');
  assert.equal(result.json.digest.createdBy, 'model:deepseek/deepseek-v4-flash');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model.id, 'deepseek-v4-flash');
  assert.equal(calls[0].model.provider, 'deepseek');
  assert.equal(calls[0].model.api, 'openai-completions');
  assert.equal(calls[0].model.baseUrl, 'https://api.deepseek.example/v1');
  assert.equal(calls[0].model.reasoning, false);
  assert.equal(calls[0].model.compat.maxTokensField, 'max_tokens');
  assert.equal(calls[0].model.compat.supportsReasoningEffort, false);
  assert.equal(calls[0].model.compat.supportsStrictMode, false);
  assert.equal(calls[0].hasTools, false);
  assert.equal(calls[0].toolChoice, undefined);
  assert.equal(calls[0].apiKey, 'test-models-json-deepseek-api-key');
  assert.deepEqual(calls[0].responseFormat, { type: 'json_object' });
});

test('conversations controller retries model digests with missing-escape diagnostics', async (t) => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
  });

  const modelCalls = [];
  const invalidRawOutput = '{"summary":"模型总结","facts":["README提示推荐1920x1080，圣遗物筛选"全选"可能失败"],"decisions":[],"openQuestions":[],"nextActions":[],"artifacts":[],"experience":[]}';
  const { handler, store } = createConversationsControllerHarness(t, {
    digestOptions: { logRawModelOutput: true },
    digestModelRunner: async (context) => {
      modelCalls.push(context);
      if (modelCalls.length === 1) {
        return invalidRawOutput;
      }

      return JSON.stringify({
        summary: '模型总结：已修复缺少转义符的 JSON 摘要。',
        facts: ['README提示推荐1920x1080，圣遗物筛选“全选”可能失败。'],
        decisions: [],
        openQuestions: [],
        nextActions: [],
        artifacts: [],
        experience: [],
      });
    },
  });
  const conversation = createSmokeConversation(store, {
    id: 'digest-model-repair-conversation',
    title: 'Digest Model Repair Conversation',
  });

  store.createMessage({
    id: 'digest-model-repair-message-1',
    conversationId: conversation.id,
    turnId: 'digest-model-repair-turn-1',
    role: 'assistant',
    senderName: 'Builder',
    content: 'README提示推荐1920x1080，圣遗物筛选"全选"可能失败。',
  });

  const result = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/digest`,
    body: {
      action: 'create',
      summaryMode: 'model',
      provider: 'cheap-provider',
      model: 'cheap-model',
    },
  });

  assert.equal(result.statusCode, 200);
  assert.equal(modelCalls.length, 2);
  assert.equal(result.json.digest.createdBy, 'model:cheap-provider/cheap-model');
  assert.equal(result.json.digest.summary, '模型总结：已修复缺少转义符的 JSON 摘要。');
  assert.match(modelCalls[1].prompt, /Validation diagnostic: Likely missing escape/u);
  assert.match(modelCalls[1].prompt, /escape literal double quote characters inside JSON string values/u);
  assert.match(modelCalls[1].prompt, /Invalid model output to repair/u);
  assert.ok(warnings.some((warning) => warning.includes('Diagnostic: Likely missing escape')));
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
  const throwingConversation = createSmokeConversation(throwingHarness.store, {
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
  const invalidRawOutput = 'not valid digest JSON\n{"summary":"missing close"';
  const invalidHarness = createConversationsControllerHarness(t, {
    digestOptions: { logRawModelOutput: true },
    digestModelRunner: async (context) => {
      invalidModelCalls.push(context);
      return invalidRawOutput;
    },
  });
  const invalidConversation = createSmokeConversation(invalidHarness.store, {
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
  assert.ok(warnings.some((warning) => warning.includes('Invalid model digest JSON')));
  assert.ok(warnings.some((warning) => warning.includes(invalidRawOutput)));
});

test('conversations controller auto-compacts old conversation digests into a rollup', async (t) => {
  const { handler, store } = createConversationsControllerHarness(t);
  const conversation = createSmokeConversation(store, {
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
        summary: `Digest entry ${index} AutoCompactUnique${index}`,
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
  assert.equal(store.searchSummarySegments({ query: 'AutoCompactUnique1', sourceKind: 'entry' }).resultCount, 0);
  assert.equal(store.searchSummarySegments({ query: 'AutoCompactUnique1', sourceKind: 'rollup' }).resultCount, 1);
});

test('conversations controller manually compacts digest entries', async (t) => {
  const { handler, store } = createConversationsControllerHarness(t);
  const conversation = createSmokeConversation(store, {
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
        summary: `Manual compact digest ${index} ManualCompactUnique${index}`,
      },
    });
  }

  assert.equal(store.searchSummarySegments({ query: 'ManualCompactUnique1', sourceKind: 'entry' }).resultCount, 1);

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
  assert.equal(store.searchSummarySegments({ query: 'ManualCompactUnique1', sourceKind: 'entry' }).resultCount, 0);
  assert.equal(store.searchSummarySegments({ query: 'ManualCompactUnique1', sourceKind: 'rollup' }).resultCount, 1);
  assert.equal(store.searchSummarySegments({ query: 'ManualCompactUnique2', sourceKind: 'entry' }).resultCount, 1);
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
  const conversation = createSmokeConversation(store, {
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
  assert.match(modelCalls[0].prompt, /Return exactly one valid compact JSON object/u);
  assert.match(modelCalls[0].prompt, /Few-shot valid output/u);
  assert.equal(compactResult.json.rollup.summary, '模型 rollup：旧摘要已经合并成长期历史。');
  assert.ok(compactResult.json.rollup.createdBy.startsWith('model:auto-compaction:'));
});

test('conversations controller absorbs experience drafts into digest and skill drafts', async (t) => {
  const { handler, store } = createConversationsControllerHarness(t);
  const timestamp = new Date().toISOString();
  const conversation = createSmokeConversation(store, {
    id: 'experience-digest-conversation',
    title: 'Experience Digest Conversation',
    metadata: {
      experienceDrafts: [
        {
          id: 'expdraft-digest-source',
          status: 'pending',
          title: 'Write experience before the final reply',
          category: 'pattern',
          scenario: 'When a reusable lesson appears during tool use and might be lost from the next agent invocation.',
          steps: ['Call write-experience with bounded fields before posting the final answer.'],
          pitfalls: ['Do not store raw tool transcripts or secrets.'],
          validation: ['node --test tests/runtime/agent-tool-bridge.test.js passed'],
          artifacts: ['server/domain/conversation/experience-draft.ts'],
          confidence: 'high',
          source: {
            type: 'agent-tool',
            agentId: 'agent-experience',
            turnId: 'turn-experience',
            conversationId: 'experience-digest-conversation',
          },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    },
  });
  store.createMessage({
    id: 'experience-user-message',
    conversationId: conversation.id,
    role: 'user',
    senderName: 'User',
    content: '请把经验写入工具接进 digest 和 skill 草稿链路。',
    status: 'completed',
    createdAt: timestamp,
  });
  store.createMessage({
    id: 'experience-assistant-message',
    conversationId: conversation.id,
    role: 'assistant',
    senderName: '咕咕嘎嘎',
    content: '已实现 write-experience 工具，并通过 runtime 测试。',
    status: 'completed',
    createdAt: timestamp,
  });

  const createResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/digest`,
    body: {
      action: 'create',
      summary: 'Experience drafts should be preserved inside conversation digest entries.',
    },
  });

  assert.equal(createResult.statusCode, 200);
  assert.equal(createResult.json.digest.experience.length, 1);
  assert.equal(createResult.json.digest.experience[0].title, 'Write experience before the final reply');

  const storedConversation = store.getConversation(conversation.id);
  assert.equal(storedConversation.metadata.experienceDrafts[0].status, 'absorbed');
  assert.equal(storedConversation.metadata.experienceDrafts[0].absorbedDigestId, createResult.json.digest.id);

  const extractResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/digest`,
    body: {
      action: 'extract-skill',
      digestId: createResult.json.digest.id,
      skillId: 'experience-backed-skill',
    },
  });

  assert.equal(extractResult.statusCode, 200);
  assert.match(extractResult.json.draft.skill.body, /Reusable Experience/u);
  assert.match(extractResult.json.draft.skill.body, /Write experience before the final reply/u);
  assert.match(extractResult.json.draft.skill.body, /Confidence: high/u);
});

test('conversations controller extracts and rejects skill drafts from digests', async (t) => {
  const { handler, store } = createConversationsControllerHarness(t);
  const conversation = createSmokeConversation(store, {
    id: 'skill-draft-extract-conversation',
    title: 'Skill Draft Extract Conversation',
    metadata: {
      conversationDigests: [
        {
          id: 'digest-skill-draft-source',
          kind: 'entry',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          summary: 'Skill extraction should turn verified digest fields into reusable workflow guidance.',
          facts: ['Digest facts are verified before entering the skill draft.'],
          decisions: ['Open questions stay limitations instead of hard rules.'],
          openQuestions: ['Whether automatic background extraction is safe remains unconfirmed.'],
          nextActions: ['Preview the generated skill draft before saving it.'],
          artifacts: ['server/domain/conversation/skill-draft.ts'],
        },
      ],
    },
  });

  const extractResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/digest`,
    body: {
      action: 'extract-skill',
      digestId: 'digest-skill-draft-source',
      skillId: 'digest-extraction-workflow',
      name: 'Digest Extraction Workflow',
      createdBy: 'system:auto-skill-draft',
      autoCreated: true,
    },
  });

  assert.equal(extractResult.statusCode, 200);
  assert.equal(extractResult.json.draft.status, 'pending');
  assert.equal(extractResult.json.draft.source.createdBy, 'user:manual');
  assert.equal(extractResult.json.draft.source.autoCreated, undefined);
  assert.equal(extractResult.json.draft.skill.id, 'digest-extraction-workflow');
  assert.match(extractResult.json.draft.skill.body, /Confirmed Facts/);
  assert.match(extractResult.json.draft.skill.body, /Limits \/ Unconfirmed Points/);
  assert.equal(store.getConversation(conversation.id).metadata.skillDrafts.length, 1);

  const listResult = await invokeConversationsController(handler, {
    method: 'GET',
    pathname: `/api/conversations/${conversation.id}/skill-drafts`,
  });

  assert.equal(listResult.statusCode, 200);
  assert.equal(listResult.json.skillDrafts.length, 1);

  const rejectResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/skill-drafts/${extractResult.json.draft.id}/reject`,
    body: { reason: 'Not reusable enough' },
  });

  assert.equal(rejectResult.statusCode, 200);
  assert.equal(rejectResult.json.draft.status, 'rejected');
  assert.equal(rejectResult.json.skillDrafts.length, 0);
  assert.equal(store.getConversation(conversation.id).metadata.skillDrafts, undefined);
});

test('conversations controller creates model-generated skill drafts from digest schema', async (t) => {
  const modelCalls = [];
  const { handler, store } = createConversationsControllerHarness(t, {
    skillDraftModelRunner: async (context) => {
      modelCalls.push(context);
      return {
        id: 'model-skill-from-digest',
        name: 'Model Skill From Digest',
        description: 'Reusable skill draft generated from structured digest fields.',
        whenToUse: ['Use when digest evidence describes a repeatable CAFF workflow.'],
        steps: [
          'Review confirmed facts and decisions before writing the skill.',
          'Whether auto-installing generated skills is safe remains unconfirmed.',
        ],
        pitfalls: ['Never install the draft before human confirmation.'],
        validation: ['Confirm the generated SKILL.md stays under .agents/skills.'],
        artifacts: ['server/domain/conversation/skill-draft.ts'],
        confidence: 0.72,
      };
    },
  });
  const conversation = createSmokeConversation(store, {
    id: 'skill-draft-model-conversation',
    title: 'Skill Draft Model Conversation',
    metadata: {
      conversationDigests: [
        {
          id: 'digest-skill-draft-model-source',
          kind: 'entry',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          summary: 'Model generation should create richer skill drafts from digest fields only.',
          facts: ['Skill drafts must remain pending until a user confirms them.'],
          decisions: ['Use schema output and keep rules as fallback.'],
          openQuestions: ['Whether auto-installing generated skills is safe remains unconfirmed.'],
          nextActions: ['Validate the generated draft before confirming it.'],
          artifacts: ['server/domain/conversation/skill-draft.ts'],
        },
      ],
    },
  });

  const extractResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/digest`,
    body: {
      action: 'extract-skill',
      digestId: 'digest-skill-draft-model-source',
      skillDraftMode: 'model',
    },
  });

  assert.equal(extractResult.statusCode, 200);
  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].purpose, 'skill-draft');
  assert.equal(modelCalls[0].digest.id, 'digest-skill-draft-model-source');
  assert.equal(extractResult.json.draft.skill.id, 'model-skill-from-digest');
  assert.match(extractResult.json.draft.skill.body, /## When To Use/u);
  assert.match(extractResult.json.draft.skill.body, /## Validation/u);
  assert.match(extractResult.json.draft.skill.body, /Model confidence: 0\.72/u);
  assert.match(extractResult.json.draft.skill.body, /Whether auto-installing generated skills is safe remains unconfirmed/u);
  assert.doesNotMatch(extractResult.json.draft.skill.body, /## Workflow Steps[\s\S]*Whether auto-installing generated skills is safe remains unconfirmed[\s\S]*## Pitfalls/u);
});

test('conversations controller merges model skill drafts into existing project skills after confirmation', async (t) => {
  const projectDir = withTempDir('caff-skill-draft-merge-project-');
  const existingSkillDir = path.join(projectDir, '.agents', 'skills', 'write-experience-workflow');
  fs.mkdirSync(existingSkillDir, { recursive: true });
  fs.writeFileSync(path.join(existingSkillDir, 'SKILL.md'), [
    '---',
    'name: "Write Experience Workflow"',
    'description: "Existing guidance for writing reusable experience drafts."',
    '---',
    '',
    '# Purpose',
    'Original guidance stays intact.',
    '',
  ].join('\n'), 'utf8');

  const modelCalls = [];
  const { handler, store } = createConversationsControllerHarness(t, {
    projectManager: {
      getActiveProject() {
        return { id: 'active-project', path: projectDir };
      },
    },
    skillDraftModelRunner: async (context) => {
      modelCalls.push(context);
      return {
        targetAction: 'update',
        targetSkillId: 'write-experience-workflow',
        targetReason: 'The absorbed experience extends the existing write-experience workflow.',
        id: 'ignored-new-skill-id',
        name: 'Write Experience Workflow',
        description: 'Existing guidance for writing reusable experience drafts.',
        whenToUse: ['Use when an agent captures reusable project experience.'],
        steps: ['Merge bounded validated lessons into the existing Skill draft.'],
        pitfalls: ['Do not create duplicate Skills for the same workflow.'],
        validation: ['Validate merged Skill content keeps original guidance.'],
        artifacts: ['server/domain/conversation/skill-draft.ts'],
        confidence: 0.91,
      };
    },
  });

  t.after(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const conversation = createSmokeConversation(store, {
    id: 'skill-draft-merge-conversation',
    title: 'Skill Draft Merge Conversation',
    metadata: {
      conversationDigests: [
        {
          id: 'digest-skill-draft-merge-source',
          kind: 'entry',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          summary: 'A write-experience workflow improvement should merge into the existing Skill instead of creating a duplicate.',
          facts: ['Existing Skill content must be preserved when integrating new experience.'],
          decisions: ['Model-reviewed Skill drafts may target update when an existing project Skill clearly matches.'],
          openQuestions: [],
          nextActions: ['Confirm the merge draft before writing the updated SKILL.md.'],
          artifacts: ['server/domain/conversation/skill-draft.ts'],
        },
      ],
    },
  });

  const extractResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/digest`,
    body: {
      action: 'extract-skill',
      digestId: 'digest-skill-draft-merge-source',
      skillDraftMode: 'model',
    },
  });

  assert.equal(extractResult.statusCode, 200);
  assert.equal(modelCalls.length, 1);
  assert.match(modelCalls[0].prompt, /Existing project skills JSON/u);
  assert.match(modelCalls[0].prompt, /write-experience-workflow/u);
  assert.equal(modelCalls[0].existingSkills[0].id, 'write-experience-workflow');
  assert.equal(extractResult.json.draft.target.action, 'update');
  assert.equal(extractResult.json.draft.target.skillId, 'write-experience-workflow');
  assert.equal(extractResult.json.draft.skill.id, 'write-experience-workflow');
  assert.match(extractResult.json.draft.skill.body, /Original guidance stays intact/u);
  assert.match(extractResult.json.draft.skill.body, /Validate merged Skill content keeps original guidance/u);

  const confirmResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/skill-drafts/${extractResult.json.draft.id}/confirm`,
    body: {},
  });

  assert.equal(confirmResult.statusCode, 200);
  assert.equal(confirmResult.json.skill.id, 'write-experience-workflow');
  assert.equal(confirmResult.json.skill.targetAction, 'update');
  assert.equal(confirmResult.json.skillDrafts.length, 0);

  const skillContent = fs.readFileSync(path.join(existingSkillDir, 'SKILL.md'), 'utf8');
  assert.match(skillContent, /Original guidance stays intact/u);
  assert.match(skillContent, /Validate merged Skill content keeps original guidance/u);
  assert.equal(fs.existsSync(path.join(projectDir, '.agents', 'skills', 'ignored-new-skill-id', 'SKILL.md')), false);
});

test('conversations controller falls back to rule skill drafts when model generation fails', async (t) => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
  });

  const { handler, store } = createConversationsControllerHarness(t, {
    skillDraftModelRunner: async () => {
      throw new Error('simulated skill draft model failure');
    },
  });
  const conversation = createSmokeConversation(store, {
    id: 'skill-draft-model-fallback-conversation',
    title: 'Skill Draft Model Fallback Conversation',
    metadata: {
      conversationDigests: [
        {
          id: 'digest-skill-draft-model-fallback-source',
          kind: 'entry',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          summary: 'Model failures should keep manual extraction usable through rule fallback.',
          facts: ['Rule fallback keeps pending skill draft creation available.'],
          decisions: [],
          openQuestions: [],
          nextActions: [],
          artifacts: ['server/domain/conversation/skill-draft.ts'],
        },
      ],
    },
  });

  const extractResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/digest`,
    body: {
      action: 'extract-skill',
      digestId: 'digest-skill-draft-model-fallback-source',
      skillDraftMode: 'model',
    },
  });

  assert.equal(extractResult.statusCode, 200);
  assert.match(extractResult.json.draft.skill.body, /Confirmed Facts/u);
  assert.ok(warnings.some((warning) => warning.includes('Model skill draft failed')));
});

test('conversations controller rejects skill extraction without reusable digest signals', async (t) => {
  const { handler, store } = createConversationsControllerHarness(t);
  const conversation = createSmokeConversation(store, {
    id: 'skill-draft-empty-digest-conversation',
    title: 'Skill Draft Empty Digest Conversation',
    metadata: {
      conversationDigests: [
        {
          id: 'digest-skill-draft-empty-source',
          kind: 'entry',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          summary: 'This digest only has a broad summary and unresolved questions.',
          facts: [],
          decisions: [],
          openQuestions: ['Whether this should become a skill is unconfirmed.'],
          nextActions: [],
          artifacts: [],
        },
      ],
    },
  });

  await assert.rejects(
    () => invokeConversationsController(handler, {
      method: 'POST',
      pathname: `/api/conversations/${conversation.id}/digest`,
      body: {
        action: 'extract-skill',
        digestId: 'digest-skill-draft-empty-source',
      },
    }),
    /Digest does not contain enough reusable facts/u
  );

  assert.equal(store.getConversation(conversation.id).metadata.skillDrafts, undefined);
});

test('conversations controller keeps skill draft metadata bounded', async (t) => {
  const { handler, store } = createConversationsControllerHarness(t);
  const conversation = createSmokeConversation(store, {
    id: 'skill-draft-bounded-conversation',
    title: 'Skill Draft Bounded Conversation',
    metadata: {
      conversationDigests: [
        {
          id: 'digest-skill-draft-bounded-source',
          kind: 'entry',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          summary: 'Repeated extraction should retain only the newest bounded draft previews.',
          facts: ['Bounded metadata prevents unreviewed skill drafts from growing forever.'],
          decisions: [],
          openQuestions: [],
          nextActions: [],
          artifacts: [],
        },
      ],
    },
  });

  let firstDraftId = '';
  let lastDraftBody = '';
  for (const index of [1, 2, 3, 4, 5, 6]) {
    const extractResult = await invokeConversationsController(handler, {
      method: 'POST',
      pathname: `/api/conversations/${conversation.id}/digest`,
      body: {
        action: 'extract-skill',
        digestId: 'digest-skill-draft-bounded-source',
        skillId: `bounded-skill-draft-${index}`,
      },
    });

    if (index === 1) {
      firstDraftId = extractResult.json.draft.id;
    }

    lastDraftBody = extractResult.json.draft.skill.body;
  }

  assert.doesNotMatch(lastDraftBody, /## Workflow Steps/u);

  const storedDrafts = store.getConversation(conversation.id).metadata.skillDrafts;
  assert.equal(storedDrafts.length, 5);
  assert.equal(storedDrafts.some((draft) => draft.id === firstDraftId), false);
  assert.deepEqual(storedDrafts.map((draft) => draft.skill.id), [
    'bounded-skill-draft-2',
    'bounded-skill-draft-3',
    'bounded-skill-draft-4',
    'bounded-skill-draft-5',
    'bounded-skill-draft-6',
  ]);
});

test('conversations controller rejects existing project skill files without overwrite', async (t) => {
  const projectDir = withTempDir('caff-skill-draft-conflict-project-');
  const projectSkillsDir = path.join(projectDir, '.agents', 'skills');
  const { handler, store } = createConversationsControllerHarness(t, {
    projectManager: {
      getActiveProject() {
        return { id: 'active-project', path: projectDir };
      },
    },
  });

  t.after(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const conversation = createSmokeConversation(store, {
    id: 'skill-draft-conflict-conversation',
    title: 'Skill Draft Conflict Conversation',
    metadata: {
      conversationDigests: [
        {
          id: 'digest-skill-draft-conflict-source',
          kind: 'entry',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          summary: 'Confirm should reject existing project skill files unless overwrite is explicit.',
          facts: ['Existing skill files require an overwrite opt-in.'],
          decisions: [],
          openQuestions: [],
          nextActions: [],
          artifacts: ['.agents/skills/existing-skill-from-digest/SKILL.md'],
        },
      ],
    },
  });

  const extractResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/digest`,
    body: {
      action: 'extract-skill',
      digestId: 'digest-skill-draft-conflict-source',
      skillId: 'existing-skill-from-digest',
      name: 'Existing Skill From Digest',
    },
  });

  const skillFilePath = path.join(projectSkillsDir, 'existing-skill-from-digest', 'SKILL.md');
  fs.mkdirSync(path.dirname(skillFilePath), { recursive: true });
  fs.writeFileSync(skillFilePath, '---\nname: "Existing"\ndescription: "Already there"\n---\n\n# Existing\n', 'utf8');

  await assert.rejects(
    () => invokeConversationsController(handler, {
      method: 'POST',
      pathname: `/api/conversations/${conversation.id}/skill-drafts/${extractResult.json.draft.id}/confirm`,
      body: {},
    }),
    /Skill already exists/u
  );

  assert.equal(store.getConversation(conversation.id).metadata.skillDrafts.length, 1);
  assert.match(fs.readFileSync(skillFilePath, 'utf8'), /Already there/);
});

test('conversations controller confirms skill drafts into active project skills', async (t) => {
  const projectDir = withTempDir('caff-skill-draft-project-');
  const registryAgentDir = withTempDir('caff-skill-draft-registry-');
  const projectSkillsDir = path.join(projectDir, '.agents', 'skills');
  const { handler, store } = createConversationsControllerHarness(t, {
    projectManager: {
      getActiveProject() {
        return { id: 'active-project', path: projectDir };
      },
    },
  });

  t.after(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(registryAgentDir, { recursive: true, force: true });
  });

  const conversation = createSmokeConversation(store, {
    id: 'skill-draft-confirm-conversation',
    title: 'Skill Draft Confirm Conversation',
    metadata: {
      conversationDigests: [
        {
          id: 'digest-skill-draft-confirm-source',
          kind: 'rollup',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          summary: 'Confirmed skill drafts should be saved as project scoped SKILL.md files.',
          facts: ['Project scoped skills live under .agents/skills.'],
          decisions: ['A human confirmation is required before saving a draft.'],
          openQuestions: [],
          nextActions: ['Save the confirmed draft and reload the skill registry.'],
          artifacts: ['.agents/skills/project-skill-from-digest/SKILL.md'],
        },
      ],
    },
  });

  const extractResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/digest`,
    body: {
      action: 'extract-skill',
      digestId: 'digest-skill-draft-confirm-source',
      skillId: 'project-skill-from-digest',
      name: 'Project Skill From Digest',
      description: 'Reusable workflow confirmed from a digest.',
    },
  });

  const confirmResult = await invokeConversationsController(handler, {
    method: 'POST',
    pathname: `/api/conversations/${conversation.id}/skill-drafts/${extractResult.json.draft.id}/confirm`,
    body: {},
  });

  assert.equal(confirmResult.statusCode, 200);
  assert.equal(confirmResult.json.draft.status, 'confirmed');
  assert.equal(confirmResult.json.skill.id, 'project-skill-from-digest');
  assert.equal(confirmResult.json.skillDrafts.length, 0);

  const skillFilePath = path.join(projectSkillsDir, 'project-skill-from-digest', 'SKILL.md');
  assert.equal(fs.existsSync(skillFilePath), true);
  assert.match(fs.readFileSync(skillFilePath, 'utf8'), /Project Skill From Digest/);

  const registry = createSkillRegistry({
    agentDir: registryAgentDir,
    extraSkillDirs: [projectSkillsDir],
  });
  const skill = registry.getSkill('project-skill-from-digest');
  assert.equal(skill.name, 'Project Skill From Digest');
  assert.equal(skill.readOnly, true);
});

test('conversations controller handles empty session goal clear', async (t) => {
  const { handler, store } = createConversationsControllerHarness(t);
  const conversation = createSmokeConversation(store, {
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
  const conversation = createSmokeConversation(store, {
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
  const conversation = createSmokeConversation(store, {
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
  const olderConversation = createSmokeConversation(store, {
    id: 'feishu-known-chat-older',
    title: 'Older Feishu Chat',
  });
  const newerConversation = createSmokeConversation(store, {
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
  const firstConversation = createSmokeConversation(store, {
    id: 'feishu-binding-source-conversation',
    title: 'Feishu Binding Source',
  });
  const targetConversation = createSmokeConversation(store, {
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
  const conversation = createSmokeConversation(store, {
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
  createSmokeConversation(store, {
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
  createSmokeConversation(store, {
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
  const sourceConversation = createSmokeConversation(store, {
    id: 'feishu-binding-conflict-source',
    title: 'Feishu Binding Conflict Source',
  });
  const targetConversation = createSmokeConversation(store, {
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
      FEISHU_APP_ID: '',
      FEISHU_APP_SECRET: '',
      FEISHU_CONNECTION_MODE: 'webhook',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrText = '';
  let stdoutText = '';
  child.stdout.on('data', (chunk) => {
    stdoutText += String(chunk);
  });
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

  const bootstrap = await fetchJson(baseUrl, '/api/bootstrap');
  assert.ok(Array.isArray(bootstrap.conversations), `Expected conversations to be an array, got ${typeof bootstrap.conversations}`);
  assert.ok(Array.isArray(bootstrap.agents), `Expected agents to be an array, got ${typeof bootstrap.agents}`);
  assert.ok(Array.isArray(bootstrap.skills), `Expected skills to be an array, got ${typeof bootstrap.skills}`);

  const healthResponse = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthResponse.status, 200);
  assert.equal(healthResponse.headers.get('cache-control'), 'no-store');
  const health = await healthResponse.json();
  assert.equal(health.ok, false);
  assert.deepEqual(health.core, { ready: true, host: '127.0.0.1', port });
  assert.deepEqual(health.chat, {
    ready: false,
    defaultRoleCount: 0,
    availableDefaultRoleCount: 0,
    roles: [],
  });
  assert.equal(health.optional.feishu.configured, false);
  assert.equal(health.optional.feishu.connectionMode, 'webhook');
  assert.equal(typeof health.optional.feishu.longConnectionSdkAvailable, 'boolean');
  assert.equal(Object.hasOwn(health.core, 'databasePath'), false);
  assert.match(health.timestamp, /^\d{4}-\d{2}-\d{2}T/u);

  const unsupportedHealth = await fetchJsonResponse(baseUrl, '/api/health', { method: 'POST' });
  assert.equal(unsupportedHealth.status, 404);

  await waitForCondition(() => stdoutText.includes(`Health: ${baseUrl}/api/health`));
  assert.match(stdoutText, /Chat defaults: 0\/0 ready/u);

  const metrics = await fetchJson(baseUrl, '/api/metrics/agent');
  assert.ok(Array.isArray(metrics.agents), `Expected metrics.agents to be an array, got ${typeof metrics.agents}`);
  assert.ok(Array.isArray(metrics.tools), `Expected metrics.tools to be an array, got ${typeof metrics.tools}`);

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

test('role API protects model-family roles and shares one availability projection', async (t) => {
  const tempDir = withTempDir('caff-role-service-smoke-');
  const sqlitePath = path.join(tempDir, 'roles.sqlite');
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const modelOptions = [
    {
      key: 'openai\u001fgpt-test',
      provider: 'openai',
      model: 'gpt-test',
      label: 'GPT Test',
      source: 'runtime_registry',
      sourceLabel: 'runtime registry',
      family: 'gpt',
      familySource: 'provider_alias',
      supportedThinkingLevels: ['off', 'low', 'high', 'max'],
    },
    {
      key: 'anthropic\u001fclaude-test',
      provider: 'anthropic',
      model: 'claude-test',
      label: 'Claude Test',
      source: 'runtime_registry',
      sourceLabel: 'runtime registry',
      family: 'claude',
      familySource: 'provider_alias',
      supportedThinkingLevels: ['off', 'low', 'high'],
    },
    {
      key: 'moonshot\u001fkimi-k2.5',
      provider: 'moonshot',
      model: 'kimi-k2.5',
      label: 'Kimi K2.5',
      source: 'runtime_registry',
      sourceLabel: 'runtime registry',
      family: 'kimi',
      familySource: 'provider_alias',
      supportedThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'],
    },
  ];
  const modelCatalog = {
    getOptions() {
      return structuredClone(modelOptions);
    },
    invalidate() {},
  };
  const app = createServerApp({
    host: '127.0.0.1',
    port,
    agentDir: tempDir,
    sqlitePath,
    projectDir: tempDir,
    modelCatalog,
  });
  let closed = false;

  t.after(async () => {
    if (!closed) {
      await new Promise((resolve) => app.close(resolve));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await new Promise((resolve) => app.start(resolve));

  const bootstrap = await fetchJson(baseUrl, '/api/bootstrap');
  const directory = await fetchJson(baseUrl, '/api/agents');
  assert.deepEqual(directory.modelOptions, bootstrap.modelOptions);
  assert.deepEqual(directory.agents, bootstrap.agents);
  assert.equal(directory.agents.length, 7);

  const initialGpt = directory.agents.find((agent) => agent.id === 'role-family-gpt');
  const initialQwen = directory.agents.find((agent) => agent.id === 'role-family-qwen');
  assert.equal(initialGpt.systemManaged, true);
  assert.deepEqual(initialGpt.editableFields, ['provider', 'model', 'thinking', 'modelProfiles', 'isDefaultChatRole']);
  assert.deepEqual(initialGpt.availability, { status: 'default_model_missing', familyModelCount: 1 });
  assert.deepEqual(initialQwen.availability, { status: 'no_family_models', familyModelCount: 0 });

  const lockedUpdate = await fetchJsonResponse(baseUrl, '/api/agents/role-family-gpt', {
    method: 'PUT',
    body: { name: 'Not GPT' },
  });
  assert.equal(lockedUpdate.status, 422);
  assert.equal(lockedUpdate.json.issues[0].code, 'role_locked_field');

  for (const body of [
    { personaPrompt: 'Pretend to be someone.' },
    { skillIds: ['persona-skill'] },
    {
      modelProfiles: [{
        id: 'persona-profile',
        name: 'Persona profile',
        provider: 'openai',
        model: 'gpt-test',
        personaPrompt: 'Override persona.',
      }],
    },
  ]) {
    const response = await fetchJsonResponse(baseUrl, '/api/agents/role-family-gpt', {
      method: 'PUT',
      body,
    });
    assert.equal(response.status, 422);
    assert.match(response.json.issues[0].code, /^family_(?:persona|skills)_not_allowed$/u);
  }

  const providerMismatch = await fetchJsonResponse(baseUrl, '/api/agents/role-family-gpt', {
    method: 'PUT',
    body: { provider: 'anthropic', model: 'gpt-test' },
  });
  assert.equal(providerMismatch.status, 422);
  assert.equal(providerMismatch.json.issues[0].code, 'provider_model_mismatch');

  const crossFamily = await fetchJsonResponse(baseUrl, '/api/agents/role-family-gpt', {
    method: 'PUT',
    body: { provider: 'anthropic', model: 'claude-test' },
  });
  assert.equal(crossFamily.status, 422);
  assert.equal(crossFamily.json.issues[0].code, 'model_out_of_family');

  const unsupportedThinking = await fetchJsonResponse(baseUrl, '/api/agents/role-family-gpt', {
    method: 'PUT',
    body: { provider: 'openai', model: 'gpt-test', thinking: 'medium' },
  });
  assert.equal(unsupportedThinking.status, 422);
  assert.equal(unsupportedThinking.json.issues[0].code, 'thinking_level_unsupported');
  assert.equal(unsupportedThinking.json.issues[0].path, 'thinking');

  const unsupportedProfileThinking = await fetchJsonResponse(baseUrl, '/api/agents/role-family-gpt', {
    method: 'PUT',
    body: {
      provider: 'openai',
      model: 'gpt-test',
      modelProfiles: [{
        id: 'bad-thinking',
        name: 'Bad thinking',
        provider: 'openai',
        model: 'gpt-test',
        thinking: 'medium',
      }],
    },
  });
  assert.equal(unsupportedProfileThinking.status, 422);
  assert.equal(unsupportedProfileThinking.json.issues[0].code, 'thinking_level_unsupported');
  assert.equal(unsupportedProfileThinking.json.issues[0].path, 'modelProfiles[0].thinking');

  const duplicateProfileIds = await fetchJsonResponse(baseUrl, '/api/agents/role-family-gpt', {
    method: 'PUT',
    body: {
      provider: 'openai',
      model: 'gpt-test',
      modelProfiles: [
        { id: 'profile-2', name: 'Existing', provider: 'openai', model: 'gpt-test' },
        { id: '', name: 'Generated collision', provider: 'openai', model: 'gpt-test' },
      ],
    },
  });
  assert.equal(duplicateProfileIds.status, 422);
  assert.equal(duplicateProfileIds.json.issues[0].code, 'profile_id_duplicate');
  assert.equal(duplicateProfileIds.json.issues[0].path, 'modelProfiles[1].id');

  const unavailableDefault = await fetchJsonResponse(baseUrl, '/api/agents/role-family-qwen', {
    method: 'PUT',
    body: { isDefaultChatRole: true },
  });
  assert.equal(unavailableDefault.status, 422);
  assert.equal(unavailableDefault.json.issues[0].code, 'role_default_unavailable');

  const savedGpt = await fetchJson(baseUrl, '/api/agents/role-family-gpt', {
    method: 'PUT',
    body: {
      provider: 'openai',
      model: 'gpt-test',
      thinking: 'high',
      isDefaultChatRole: true,
      modelProfiles: [{
        id: 'gpt-max',
        name: 'Max',
        description: 'Maximum supported effort',
        provider: 'openai',
        model: 'gpt-test',
        thinking: 'max',
      }],
    },
  });
  assert.equal(savedGpt.agent.provider, 'openai');
  assert.equal(savedGpt.agent.model, 'gpt-test');
  assert.equal(savedGpt.agent.isDefaultChatRole, true);
  assert.deepEqual(savedGpt.agent.availability, { status: 'available', familyModelCount: 1 });

  const savedClaude = await fetchJson(baseUrl, '/api/agents/role-family-claude', {
    method: 'PUT',
    body: {
      provider: 'anthropic',
      model: 'claude-test',
      thinking: 'high',
      isDefaultChatRole: true,
    },
  });
  assert.equal(savedClaude.agent.isDefaultChatRole, true);
  assert.equal(savedClaude.agents.filter((agent) => agent.isDefaultChatRole).length, 2);

  const countRuntimeRows = (tableName) => {
    const exists = app.store.db.prepare(
      'SELECT 1 AS found FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1'
    ).get('table', tableName);
    return exists ? app.store.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count : 0;
  };

  const runtimeConversation = await fetchJson(baseUrl, '/api/conversations', {
    method: 'POST',
    body: {
      title: 'Runtime role validation',
      participants: ['role-family-gpt', 'role-family-claude'],
    },
  });
  const runtimeGptOption = modelOptions.find((option) => option.key === 'openai\u001fgpt-test');
  const runtimeClaudeOption = modelOptions.find((option) => option.key === 'anthropic\u001fclaude-test');
  const originalRuntimeGptFamily = runtimeGptOption.family;
  const originalRuntimeClaudeThinking = runtimeClaudeOption.supportedThinkingLevels;
  const beforeRuntimeBlockCounts = {
    messages: app.store.db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get().count,
    tasks: countRuntimeRows('a2a_tasks'),
    runs: countRuntimeRows('runs'),
  };

  runtimeGptOption.family = 'claude';
  runtimeClaudeOption.supportedThinkingLevels = ['off'];
  const runtimeBlocked = await fetchJsonResponse(
    baseUrl,
    `/api/conversations/${encodeURIComponent(runtimeConversation.conversation.id)}/messages`,
    {
      method: 'POST',
      body: { content: 'This turn must fail before creating artifacts.' },
    }
  );
  assert.equal(runtimeBlocked.status, 409);
  assert.deepEqual(
    runtimeBlocked.json.issues.map((issue) => [issue.roleId, issue.availability.status]),
    [
      ['role-family-gpt', 'no_family_models'],
      ['role-family-claude', 'thinking_level_unsupported'],
    ]
  );
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get().count, beforeRuntimeBlockCounts.messages);
  assert.equal(countRuntimeRows('a2a_tasks'), beforeRuntimeBlockCounts.tasks);
  assert.equal(countRuntimeRows('runs'), beforeRuntimeBlockCounts.runs);
  runtimeGptOption.family = originalRuntimeGptFamily;
  runtimeClaudeOption.supportedThinkingLevels = originalRuntimeClaudeThinking;

  const staleProfileConversation = await fetchJson(baseUrl, '/api/conversations', {
    method: 'POST',
    body: {
      title: 'Stale selected profile',
      participants: [{ agentId: 'role-family-gpt', modelProfileId: 'gpt-max' }],
    },
  });
  app.store.db.prepare('UPDATE chat_agents SET model_profiles_json = ? WHERE id = ?').run(
    JSON.stringify([]),
    'role-family-gpt'
  );
  assert.equal(
    app.store.getConversation(staleProfileConversation.conversation.id).agents[0].selectedModelProfileId,
    'gpt-max'
  );
  const beforeStaleProfileCounts = {
    messages: app.store.db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get().count,
    tasks: countRuntimeRows('a2a_tasks'),
    runs: countRuntimeRows('runs'),
  };
  const staleProfileBlocked = await fetchJsonResponse(
    baseUrl,
    `/api/conversations/${encodeURIComponent(staleProfileConversation.conversation.id)}/messages`,
    {
      method: 'POST',
      body: { content: 'Do not silently fall back to the base model.' },
    }
  );
  assert.equal(staleProfileBlocked.status, 409);
  assert.equal(staleProfileBlocked.json.issues[0].code, 'participant_profile_invalid');
  assert.equal(staleProfileBlocked.json.issues[0].availability.status, 'profile_missing');
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get().count, beforeStaleProfileCounts.messages);
  assert.equal(countRuntimeRows('a2a_tasks'), beforeStaleProfileCounts.tasks);
  assert.equal(countRuntimeRows('runs'), beforeStaleProfileCounts.runs);
  app.store.db.prepare('UPDATE chat_agents SET model_profiles_json = ? WHERE id = ?').run(
    JSON.stringify(savedGpt.agent.modelProfiles),
    'role-family-gpt'
  );

  const familyPost = await fetchJsonResponse(baseUrl, '/api/agents', {
    method: 'POST',
    body: {
      roleKind: 'model_family',
      name: 'Injected family',
    },
  });
  assert.equal(familyPost.status, 422);
  assert.equal(familyPost.json.issues[0].code, 'custom_role_only');

  const reservedIdPost = await fetchJsonResponse(baseUrl, '/api/agents', {
    method: 'POST',
    body: {
      id: 'role-family-gpt',
      name: 'Reserved ID',
      personaPrompt: 'Should fail.',
    },
  });
  assert.equal(reservedIdPost.status, 422);
  assert.equal(reservedIdPost.json.issues[0].code, 'role_identity_not_reusable');

  const custom = await fetchJson(baseUrl, '/api/agents', {
    method: 'POST',
    body: {
      name: 'Cross-family custom role',
      description: 'Keeps the existing custom-role surface.',
      personaPrompt: 'Reply with a custom persona.',
      provider: 'openai',
      model: 'gpt-test',
      thinking: 'low',
      skillIds: ['custom-skill'],
      isDefaultChatRole: true,
      modelProfiles: [{
        id: 'claude-profile',
        name: 'Claude profile',
        provider: 'anthropic',
        model: 'claude-test',
        thinking: 'high',
        personaPrompt: 'Use the Claude-specific persona.',
      }],
    },
  });
  assert.equal(custom.agent.roleKind, 'custom');
  assert.equal(custom.agent.systemManaged, false);
  assert.deepEqual(custom.agent.skillIds, ['custom-skill']);
  assert.equal(custom.agent.modelProfiles[0].personaPrompt, 'Use the Claude-specific persona.');
  assert.equal(custom.agents.filter((agent) => agent.isDefaultChatRole).length, 3);

  const customConversation = createSmokeConversation(app.store, {
    id: 'custom-retirement-conversation',
    title: 'Custom retirement',
    participants: [custom.agent.id],
  });
  app.store.saveConversationMemoryCard(customConversation.id, custom.agent.id, {
    title: 'Persistent memory',
    content: 'Must survive custom role retirement.',
  });

  const retired = await fetchJson(baseUrl, `/api/agents/${encodeURIComponent(custom.agent.id)}`, {
    method: 'DELETE',
  });
  assert.equal(retired.deletedId, custom.agent.id);
  assert.equal(retired.agents.some((agent) => agent.id === custom.agent.id), false);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS count FROM chat_memory_cards WHERE agent_id = ?').get(custom.agent.id).count, 1);
  assert.equal(app.store.db.prepare('SELECT lifecycle_state FROM chat_role_identities WHERE role_id = ?').get(custom.agent.id).lifecycle_state, 'retired');
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS count FROM chat_conversation_agent_history WHERE role_id = ?').get(custom.agent.id).count, 1);

  const gptOption = modelOptions.find((option) => option.key === 'openai\u001fgpt-test');
  const alternateGptOption = {
    ...gptOption,
    key: 'openai\u001fgpt-alternate',
    model: 'gpt-alternate',
    label: 'GPT Alternate',
    supportedThinkingLevels: ['off'],
  };
  modelOptions.push(alternateGptOption);
  const readGptAvailability = async () => {
    const payload = await fetchJson(baseUrl, '/api/agents');
    return payload.agents.find((agent) => agent.id === 'role-family-gpt').availability;
  };

  modelOptions.splice(modelOptions.indexOf(gptOption), 1);
  assert.deepEqual(await readGptAvailability(), {
    status: 'default_model_missing',
    familyModelCount: 1,
  });
  modelOptions.push(gptOption);

  gptOption.family = 'claude';
  assert.deepEqual(await readGptAvailability(), {
    status: 'default_model_out_of_family',
    familyModelCount: 1,
    modelKey: 'openai\u001fgpt-test',
  });
  gptOption.family = 'gpt';

  const originalGptThinkingLevels = gptOption.supportedThinkingLevels;
  gptOption.supportedThinkingLevels = ['off'];
  assert.deepEqual(await readGptAvailability(), {
    status: 'thinking_level_unsupported',
    familyModelCount: 2,
    modelKey: 'openai\u001fgpt-test',
  });
  gptOption.supportedThinkingLevels = originalGptThinkingLevels;

  const driftedProfile = {
    id: 'drifted-profile',
    name: 'Drifted profile',
    description: '',
    provider: 'openai',
    model: 'gpt-profile',
    thinking: 'high',
    personaPrompt: '',
  };
  app.store.db.prepare('UPDATE chat_agents SET model_profiles_json = ? WHERE id = ?').run(
    JSON.stringify([driftedProfile]),
    'role-family-gpt'
  );
  assert.deepEqual(await readGptAvailability(), {
    status: 'profile_model_missing',
    familyModelCount: 2,
    profileId: 'drifted-profile',
  });

  const driftedProfileOption = {
    ...gptOption,
    key: 'openai\u001fgpt-profile',
    model: 'gpt-profile',
    label: 'GPT Profile',
    family: 'claude',
  };
  modelOptions.push(driftedProfileOption);
  assert.deepEqual(await readGptAvailability(), {
    status: 'profile_model_out_of_family',
    familyModelCount: 2,
    profileId: 'drifted-profile',
  });

  driftedProfileOption.family = 'gpt';
  driftedProfileOption.supportedThinkingLevels = ['off'];
  assert.deepEqual(await readGptAvailability(), {
    status: 'thinking_level_unsupported',
    familyModelCount: 3,
    modelKey: 'openai\u001fgpt-profile',
    profileId: 'drifted-profile',
  });

  app.store.db.prepare('UPDATE chat_agents SET model_profiles_json = ? WHERE id = ?').run(
    JSON.stringify(savedGpt.agent.modelProfiles),
    'role-family-gpt'
  );
  modelOptions.splice(modelOptions.indexOf(alternateGptOption), 1);
  modelOptions.splice(modelOptions.indexOf(driftedProfileOption), 1);

  const familyDelete = await fetchJsonResponse(baseUrl, '/api/agents/role-family-gpt', {
    method: 'DELETE',
  });
  assert.equal(familyDelete.status, 409);
  assert.equal(familyDelete.json.issues[0].code, 'system_role_delete_forbidden');

  await new Promise((resolve) => app.close(resolve));
  closed = true;
});

test('server smoke: pi-mono agent can initialize and write Trellis files for the active project', async (t) => {
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
      PI_SDK_HOST_OVERRIDE: FAKE_PI_SDK_HOST_TRELLIS_TOOLS_PATH,
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

    const encodedConversationId = encodeURIComponent(conversationResult.conversation.id);
    const [conversationPayload, messagePage] = await Promise.all([
      fetchJson(baseUrl, `/api/conversations/${encodedConversationId}?includePrivateMessages=1`),
      fetchJson(baseUrl, `/api/conversations/${encodedConversationId}/messages?limit=100`),
    ]);
    const assistantReplies = Array.isArray(messagePage.items)
      ? messagePage.items.filter((message) => message && message.role === 'assistant')
      : [];

    return assistantReplies.some((message) => message.status === 'completed')
      ? { ...conversationPayload.conversation, messages: messagePage.items }
      : null;
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

test('bootstrap leaves an empty conversation database untouched', (t) => {
  const tempDir = withTempDir('caff-bootstrap-read-only-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const builder = createBootstrapPayloadBuilder({
    store,
    skillRegistry: { listSkills() { return []; } },
    turnOrchestrator: { buildRuntimePayload() { return {}; } },
    modeStore: { list() { return []; } },
    modelCatalog: { getOptions() { return []; } },
    roleService: {
      getDirectory() {
        return { agents: [], modelOptions: [] };
      },
    },
  });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const payload = builder.buildBootstrapPayload();

  assert.deepEqual(payload.conversations, []);
  assert.equal(payload.selectedConversationId, null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM chat_conversations').get().count, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM chat_conversation_agents').get().count, 0);
});

test('conversation create validates the explicit roster and only merges mode skills into supplied participants', async (t) => {
  const tempDir = withTempDir('caff-conversation-participant-policy-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const modelOptions = [
    {
      key: 'openai\u001fgpt-participant-test',
      provider: 'openai',
      model: 'gpt-participant-test',
      label: 'GPT Participant Test',
      family: 'gpt',
      familySource: 'provider_alias',
      supportedThinkingLevels: ['off', 'low', 'high'],
    },
    {
      key: 'openai\u001fgpt-participant-recovery',
      provider: 'openai',
      model: 'gpt-participant-recovery',
      label: 'GPT Participant Recovery',
      family: 'gpt',
      familySource: 'provider_alias',
      supportedThinkingLevels: ['off', 'low', 'high'],
    },
    {
      key: 'anthropic\u001fclaude-participant-test',
      provider: 'anthropic',
      model: 'claude-participant-test',
      label: 'Claude Participant Test',
      family: 'claude',
      familySource: 'provider_alias',
      supportedThinkingLevels: ['off', 'low', 'high'],
    },
    {
      key: 'google\u001fgemini-participant-test',
      provider: 'google',
      model: 'gemini-participant-test',
      label: 'Gemini Participant Test',
      family: 'gemini',
      familySource: 'provider_alias',
      supportedThinkingLevels: ['off', 'low', 'high'],
    },
  ];
  const modelCatalog = {
    getOptions() {
      return structuredClone(modelOptions);
    },
  };
  const roleService = createRoleService({ store, modelCatalog });
  roleService.updateRole('role-family-gpt', {
    provider: 'openai',
    model: 'gpt-participant-test',
    modelProfiles: [{
      id: 'high-effort',
      name: 'High effort',
      provider: 'openai',
      model: 'gpt-participant-recovery',
      thinking: 'high',
    }],
  });
  roleService.updateRole('role-family-claude', {
    provider: 'anthropic',
    model: 'claude-participant-test',
  });
  roleService.updateRole('role-family-gemini', {
    provider: 'google',
    model: 'gemini-participant-test',
  });
  const controller = createConversationsController({
    store,
    roleService,
    turnOrchestrator: {
      buildRuntimePayload() { return {}; },
      clearConversationState() {},
    },
    undercoverHost: { buildPublicState() { return null; } },
    werewolfHost: { buildPublicState() { return null; } },
    undercoverService: { prepareConversation(id) { return store.getConversation(id); }, deleteConversationState() {} },
    werewolfService: { prepareConversation(id) { return store.getConversation(id); }, deleteConversationState() {} },
    skillRegistry: {
      getSkill(id) {
        return id === 'tdd' ? { id: 'tdd', name: 'TDD' } : null;
      },
    },
    modeStore: {
      get(id) {
        if (id === 'coding') return { id: 'coding', name: 'Coding', skillIds: ['mode-skill'] };
        return null;
      },
    },
    broadcastEvent() {},
  });
  const assertCreateError = async (body, statusCode, code) => {
    await assert.rejects(
      () => invokeConversationsController(controller, {
        method: 'POST',
        pathname: '/api/conversations',
        body,
      }),
      (error) => {
        assert.equal(error.statusCode, statusCode);
        assert.equal(error.issues[0].code, code);
        return true;
      }
    );
  };

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await assertCreateError({ title: 'Missing roster' }, 400, 'participants_required');
  await assertCreateError({ title: 'Empty roster', participants: [] }, 400, 'participants_required');
  await assertCreateError({ title: 'Unknown roster', participants: ['missing-role'] }, 422, 'participant_role_unknown');
  await assertCreateError({
    title: 'Invalid profile',
    participants: [{ agentId: 'role-family-gpt', modelProfileId: 'missing-profile' }],
  }, 422, 'participant_profile_invalid');

  const modeConversation = await invokeConversationsController(controller, {
    method: 'POST',
    pathname: '/api/conversations',
    body: {
      title: 'Explicit coding roster',
      type: 'coding',
      participants: [{ agentId: 'role-family-gpt', modelProfileId: 'high-effort' }],
    },
  });
  assert.equal(modeConversation.statusCode, 201);
  assert.equal(modeConversation.json.conversation.agents.length, 1);
  assert.equal(modeConversation.json.conversation.agents[0].id, 'role-family-gpt');
  assert.equal(modeConversation.json.conversation.agents[0].selectedModelProfileId, 'high-effort');
  assert.deepEqual(modeConversation.json.conversation.agents[0].conversationSkillIds, ['mode-skill']);

  const recoveryConversation = await invokeConversationsController(controller, {
    method: 'POST',
    pathname: '/api/conversations',
    body: {
      title: 'Recovery roster',
      participants: [{ agentId: 'role-family-gpt' }],
    },
  });
  assert.equal(recoveryConversation.statusCode, 201);

  const removedBaseOption = modelOptions.splice(
    modelOptions.findIndex((option) => option.model === 'gpt-participant-test'),
    1
  )[0];
  const recoveredConversation = await invokeConversationsController(controller, {
    method: 'PUT',
    pathname: `/api/conversations/${recoveryConversation.json.conversation.id}`,
    body: {
      participants: [{ agentId: 'role-family-gpt', modelProfileId: 'high-effort' }],
    },
  });
  assert.equal(recoveredConversation.statusCode, 200);
  assert.equal(recoveredConversation.json.conversation.agents[0].selectedModelProfileId, 'high-effort');

  await assertCreateError({
    title: 'Unavailable new role with valid profile',
    participants: [{ agentId: 'role-family-gpt', modelProfileId: 'high-effort' }],
  }, 422, 'participant_role_unavailable');
  modelOptions.push(removedBaseOption);

  const gameConversation = await invokeConversationsController(controller, {
    method: 'POST',
    pathname: '/api/conversations',
    body: {
      title: 'Explicit game roster',
      type: 'werewolf',
      participants: ['role-family-gpt', 'role-family-gemini'],
    },
  });
  assert.equal(gameConversation.statusCode, 201);
  assert.deepEqual(gameConversation.json.conversation.agents.map((agent) => agent.id), [
    'role-family-gpt',
    'role-family-gemini',
  ]);

  const skillTestModeRemoved = await invokeConversationsController(controller, {
    method: 'POST',
    pathname: '/api/conversations',
    body: {
      title: 'Retired skill-test mode roster',
      type: 'skill_test_design',
      skillId: 'tdd',
      participants: ['role-family-gpt'],
    },
  });
  assert.equal(JSON.stringify(skillTestModeRemoved.json.conversation || {}).includes('skillTestDesign'), false);
  assert.equal(JSON.stringify(skillTestModeRemoved.json).includes('agent-strategist'), false);

  modelOptions.splice(0, modelOptions.length);
  await assertCreateError({
    title: 'Unavailable role',
    participants: [{ agentId: 'role-family-gpt' }],
  }, 422, 'participant_role_unavailable');
  assert.equal(store.listConversations().length, 4);
});
