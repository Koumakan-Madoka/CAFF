const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');

const {
  createConversationCapabilityDefinitions,
  createPiCapabilityBridge,
  createRoomWorkspaceCapabilityDefinitions,
} = require('../../build/server/domain/runtime/pi-capability-bridge');
const { createAgentToolBridge } = require('../../build/server/domain/runtime/agent-tool-bridge');
const { createAgentToolsController } = require('../../build/server/api/agent-tools-controller');

const FORBIDDEN_PROXY_FIELDS = [
  'server',
  'tool',
  'transport',
  'command',
  'env',
  'headers',
  'credential',
  'arguments',
  'fallbackAction',
];

function createPrincipal(overrides = {}) {
  return {
    invocationId: 'invocation-f003',
    sourceConversationId: 'conversation-source',
    sourceAgentId: 'agent-source',
    sourceAgentName: 'Source Agent',
    projectScopeId: 'project-f003',
    traceId: 'trace-f003',
    incomingDeliveryId: null,
    ...overrides,
  };
}

function createDeliveryResult(kind, args) {
  return {
    ok: true,
    duplicate: false,
    delivery: {
      id: `delivery-${kind}`,
      kind,
      targetConversationId: args.targetConversationId,
      targetAgentId: args.targetAgentId,
      messageStatus: 'persisted',
      dispatchStatus: 'queued',
      responseStatus: kind === 'request' ? 'waiting' : 'not_applicable',
      deadlineAt: kind === 'request' ? '2026-08-05T12:00:00.000Z' : null,
      privateInternalField: 'must-not-project',
    },
    targetMessageId: 'target-message-f003',
    sourceReceiptMessageId: 'source-receipt-f003',
    rawSecret: 'must-not-project',
  };
}

function projectFixtureResult(result) {
  assert.ok(result && Array.isArray(result.content));
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(Object.keys(parsed).sort(), [
    'idempotencyKey',
    'projectScopeId',
    'traceId',
    'value',
  ]);
  return parsed;
}

function createMcpCapability(mode, overrides = {}) {
  const fixturePath = path.resolve('tests/fixtures/f003-mcp-stdio-server.mjs');
  return {
    facade: `fixture_${mode}`,
    kind: 'mcp',
    validateArguments(input) {
      assert.ok(input && typeof input === 'object' && !Array.isArray(input));
      assert.deepEqual(Object.keys(input).sort(), ['idempotencyKey', 'value']);
      assert.equal(typeof input.value, 'string');
      assert.equal(typeof input.idempotencyKey, 'string');
      return { value: input.value, idempotencyKey: input.idempotencyKey };
    },
    transport: {
      type: 'stdio',
      command: process.execPath,
      args: [fixturePath, mode, overrides.configuredSecret || ''],
      stderr: 'pipe',
    },
    toolName: 'fixed_echo',
    timeoutMs: overrides.timeoutMs || 1_000,
    buildArguments({ arguments: args, principal }) {
      return {
        value: args.value,
        projectScopeId: principal.projectScopeId,
        traceId: principal.traceId,
        idempotencyKey: args.idempotencyKey,
      };
    },
    projectResult: overrides.projectResult || projectFixtureResult,
    sensitiveValues: overrides.sensitiveValues || [],
  };
}

test('official MCP SDK is a direct exact dependency', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  const sdkPackage = JSON.parse(
    fs.readFileSync(path.resolve('node_modules/@modelcontextprotocol/sdk/package.json'), 'utf8')
  );

  assert.equal(packageJson.dependencies['@modelcontextprotocol/sdk'], '1.30.0');
  assert.equal(sdkPackage.version, '1.30.0');
  assert.doesNotMatch(packageJson.dependencies['@modelcontextprotocol/sdk'], /^[~^]/u);
});

test('Pi extension omits conversation_request from the model-visible facade schemas', async () => {
  const extensionPath = path.resolve('lib/pi-extensions/caff-capabilities.mjs');
  const extension = await import(`${pathToFileURL(extensionPath).href}?schema=${Date.now()}`);
  const tools = [];
  extension.default({
    registerTool(tool) {
      tools.push(tool);
    },
  });

  assert.deepEqual(tools.map((tool) => tool.name), [
    'conversation_notify',
    'room_workspace_preview',
    'room_workspace_bind',
  ]);

  const notify = tools[0];
  const preview = tools[1];
  const bind = tools[2];
  assert.deepEqual(Object.keys(preview.parameters.properties), []);
  assert.deepEqual(Object.keys(bind.parameters.properties), ['confirm']);
  assert.equal(preview.parameters.additionalProperties, false);
  assert.equal(bind.parameters.additionalProperties, false);
  assert.match(JSON.stringify(bind.parameters), /explicitly confirms/u);
  assert.deepEqual(Object.keys(notify.parameters.properties), [
    'targetConversationId',
    'targetAgentId',
    'content',
    'idempotencyKey',
  ]);
  assert.equal(notify.parameters.additionalProperties, false);

  const visibleSchema = JSON.stringify(tools.map((tool) => tool.parameters));
  for (const forbiddenField of FORBIDDEN_PROXY_FIELDS) {
    assert.doesNotMatch(visibleSchema, new RegExp(`"${forbiddenField}"`, 'u'));
  }
});

test('Pi extension injects invocation credentials into a fixed local facade route', async (t) => {
  const extensionPath = path.resolve('lib/pi-extensions/caff-capabilities.mjs');
  const extension = await import(`${pathToFileURL(extensionPath).href}?execute=${Date.now()}`);
  const tools = [];
  const originalFetch = global.fetch;
  const previousEnv = {
    apiUrl: process.env.CAFF_CHAT_API_URL,
    invocationId: process.env.CAFF_CHAT_INVOCATION_ID,
    callbackToken: process.env.CAFF_CHAT_CALLBACK_TOKEN,
  };
  let captured = null;

  process.env.CAFF_CHAT_API_URL = 'http://127.0.0.1:3102/';
  process.env.CAFF_CHAT_INVOCATION_ID = 'invocation-extension';
  process.env.CAFF_CHAT_CALLBACK_TOKEN = 'callback-extension';
  global.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({
      ok: true,
      facade: 'conversation_notify',
      result: {
        deliveryId: 'delivery-extension',
        dispatchStatus: 'queued',
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  t.after(() => {
    global.fetch = originalFetch;
    if (previousEnv.apiUrl === undefined) delete process.env.CAFF_CHAT_API_URL;
    else process.env.CAFF_CHAT_API_URL = previousEnv.apiUrl;
    if (previousEnv.invocationId === undefined) delete process.env.CAFF_CHAT_INVOCATION_ID;
    else process.env.CAFF_CHAT_INVOCATION_ID = previousEnv.invocationId;
    if (previousEnv.callbackToken === undefined) delete process.env.CAFF_CHAT_CALLBACK_TOKEN;
    else process.env.CAFF_CHAT_CALLBACK_TOKEN = previousEnv.callbackToken;
  });

  extension.default({ registerTool(tool) { tools.push(tool); } });
  const result = await tools[0].execute(
    'tool-call-extension',
    {
      targetConversationId: 'conversation-target',
      targetAgentId: 'agent-target',
      content: 'hello',
      idempotencyKey: 'idem-extension',
    },
    undefined
  );

  assert.equal(
    captured.url,
    'http://127.0.0.1:3102/api/agent-tools/capabilities/conversation_notify'
  );
  const body = JSON.parse(captured.options.body);
  assert.deepEqual(body, {
    invocationId: 'invocation-extension',
    callbackToken: 'callback-extension',
    arguments: {
      targetConversationId: 'conversation-target',
      targetAgentId: 'agent-target',
      content: 'hello',
      idempotencyKey: 'idem-extension',
    },
  });
  assert.deepEqual(result.details, {
    deliveryId: 'delivery-extension',
    dispatchStatus: 'queued',
  });
  assert.equal(result.content[0].text, JSON.stringify(result.details));
});

test('registry injects principal into fixed internal delivery handlers and projects safe results', async () => {
  const calls = [];
  const capabilities = createConversationCapabilityDefinitions({
    async notify(input) {
      calls.push(input);
      return createDeliveryResult('notify', input.arguments);
    },
    async request(input) {
      calls.push(input);
      return createDeliveryResult('request', input.arguments);
    },
  });
  const bridge = createPiCapabilityBridge({ capabilities });
  const principal = createPrincipal();

  const notifyResult = await bridge.invokeFacade('conversation_notify', {
    principal,
    arguments: {
      targetConversationId: 'conversation-target',
      targetAgentId: 'agent-target',
      content: 'notify content',
      idempotencyKey: 'notify-idem',
    },
  });
  const requestResult = await bridge.invokeFacade('conversation_request', {
    principal,
    arguments: {
      targetConversationId: 'conversation-target',
      targetAgentId: 'agent-target',
      content: 'request content',
      idempotencyKey: 'request-idem',
      deadlineSeconds: 45,
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].principal, principal);
  assert.equal(calls[1].principal, principal);
  assert.deepEqual(notifyResult, {
    deliveryId: 'delivery-notify',
    duplicate: false,
    kind: 'notify',
    targetConversationId: 'conversation-target',
    targetAgentId: 'agent-target',
    messageStatus: 'persisted',
    dispatchStatus: 'queued',
    responseStatus: 'not_applicable',
    deadlineAt: null,
    targetMessageId: 'target-message-f003',
    sourceReceiptMessageId: 'source-receipt-f003',
  });
  assert.equal(requestResult.deliveryId, 'delivery-request');
  assert.equal(requestResult.responseStatus, 'waiting');
  assert.doesNotMatch(JSON.stringify([notifyResult, requestResult]), /rawSecret|privateInternalField|must-not-project/u);
});

test('Room workspace capability schemas reject caller-selected identity and require explicit bind confirmation', async () => {
  const calls = [];
  const workspace = {
    conversationId: 'conversation-source',
    projectScopeId: 'project-f003',
    repositoryPath: '/repo',
    baseBranch: 'develop',
    baseSha: 'a'.repeat(40),
    branch: 'room/conversa-demo',
    worktreePath: '/worktrees/room/conversa-demo',
    alreadyBound: false,
  };
  const bridge = createPiCapabilityBridge({
    capabilities: createRoomWorkspaceCapabilityDefinitions({
      preview(input) {
        calls.push({ kind: 'preview', input });
        return workspace;
      },
      bind(input) {
        calls.push({ kind: 'bind', input });
        return { ...workspace, alreadyBound: true };
      },
    }),
  });
  const principal = createPrincipal();

  const preview = await bridge.invokeFacade('room_workspace_preview', { principal, arguments: {} });
  assert.equal(preview.branch, workspace.branch);
  assert.equal(preview.reused, false);

  for (const argumentsValue of [
    {},
    { confirm: false },
    { confirm: true, branch: 'attacker-selected' },
    { confirm: true, conversationId: 'other-room' },
  ]) {
    await assert.rejects(
      bridge.invokeFacade('room_workspace_bind', { principal, arguments: argumentsValue }),
      (error) => error && error.code === 'pi_capability_invalid_arguments'
    );
  }
  const bound = await bridge.invokeFacade('room_workspace_bind', {
    principal,
    arguments: { confirm: true },
  });
  assert.equal(bound.alreadyBound, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].input.principal, principal);
});
test('registry rejects unknown facade and generic proxy fields before dispatch', async () => {
  let dispatchCount = 0;
  const capabilities = createConversationCapabilityDefinitions({
    async notify() {
      dispatchCount += 1;
      return createDeliveryResult('notify', {
        targetConversationId: 'conversation-target',
        targetAgentId: 'agent-target',
      });
    },
    async request() {
      dispatchCount += 1;
      return createDeliveryResult('request', {
        targetConversationId: 'conversation-target',
        targetAgentId: 'agent-target',
      });
    },
  });
  const bridge = createPiCapabilityBridge({ capabilities });
  const principal = createPrincipal();

  await assert.rejects(
    bridge.invokeFacade('mcp_proxy', { principal, arguments: {} }),
    (error) => error && error.code === 'pi_capability_unknown_facade'
  );

  for (const field of FORBIDDEN_PROXY_FIELDS) {
    await assert.rejects(
      bridge.invokeFacade('conversation_notify', {
        principal,
        arguments: {
          targetConversationId: 'conversation-target',
          targetAgentId: 'agent-target',
          content: 'hello',
          idempotencyKey: 'notify-idem',
          [field]: field === 'arguments' ? {} : 'attacker-controlled',
        },
      }),
      (error) => error && error.code === 'pi_capability_invalid_arguments'
    );
  }

  assert.equal(dispatchCount, 0);
});

test('agent bridge authenticates the invocation and injects project scope into Pi capability principal', async () => {
  let received = null;
  const piCapabilityBridge = {
    async invokeFacade(facade, input) {
      received = { facade, input };
      return { deliveryId: 'delivery-agent-bridge' };
    },
  };
  const store = {
    getConversation(conversationId) {
      return conversationId === 'conversation-source'
        ? { id: conversationId, projectScopeId: 'project-f003' }
        : null;
    },
    getCrossConversationDelivery(deliveryId) {
      return deliveryId === 'delivery-incoming'
        ? { id: deliveryId, traceId: 'trace-parent-f003' }
        : null;
    },
  };
  const bridge = createAgentToolBridge({ store, piCapabilityBridge });
  const context = bridge.registerInvocation(bridge.createInvocationContext({
    invocationId: 'invocation-agent-bridge',
    callbackToken: 'callback-agent-bridge',
    conversationId: 'conversation-source',
    turnId: 'turn-agent-bridge',
    agentId: 'agent-source',
    agentName: 'Source Agent',
    incomingDeliveryId: 'delivery-incoming',
    stage: { status: 'running' },
  }));

  const result = await bridge.handlePiCapability('conversation_notify', {
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    arguments: {
      targetConversationId: 'conversation-target',
      targetAgentId: 'agent-target',
      content: 'hello',
      idempotencyKey: 'agent-bridge-idem',
    },
  });

  assert.deepEqual(result, { deliveryId: 'delivery-agent-bridge' });
  assert.equal(received.facade, 'conversation_notify');
  assert.deepEqual(received.input.principal, {
    invocationId: 'invocation-agent-bridge',
    sourceConversationId: 'conversation-source',
    sourceAgentId: 'agent-source',
    sourceAgentName: 'Source Agent',
    projectScopeId: 'project-f003',
    traceId: 'trace-parent-f003',
    incomingDeliveryId: 'delivery-incoming',
  });
  assert.equal(received.input.arguments.content, 'hello');
});

test('default Agent bridge Pi facade enters the fixed Phase A delivery handler', async () => {
  let submitted = null;
  const store = {
    getConversation(conversationId) {
      return conversationId === 'conversation-source'
        ? { id: conversationId, projectScopeId: 'project-f003' }
        : null;
    },
  };
  const bridge = createAgentToolBridge({
    store,
    crossConversationDeliveryService: {
      submitFromAgent(principal, args) {
        submitted = { principal, args };
        return createDeliveryResult(args.kind, args);
      },
    },
  });
  const context = bridge.registerInvocation(bridge.createInvocationContext({
    invocationId: 'invocation-default-facade',
    callbackToken: 'callback-default-facade',
    conversationId: 'conversation-source',
    turnId: 'turn-default-facade',
    agentId: 'agent-source',
    agentName: 'Source Agent',
    assistantMessageId: 'assistant-source',
    stage: { status: 'running' },
  }));

  const result = await bridge.handlePiCapability('conversation_request', {
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    arguments: {
      targetConversationId: 'conversation-target',
      targetAgentId: 'agent-target',
      content: 'request through fixed facade',
      idempotencyKey: 'default-facade-idem',
      deadlineSeconds: 30,
    },
  });

  assert.equal(submitted.principal.sourceConversationId, 'conversation-source');
  assert.equal(submitted.principal.sourceAgentId, 'agent-source');
  assert.equal(submitted.args.kind, 'request');
  assert.equal(submitted.args.deadlineSeconds, 30);
  assert.equal(result.deliveryId, 'delivery-request');
  assert.equal(result.responseStatus, 'waiting');
});

test('default Agent bridge workspace facade is scoped to the invoking Room and Project', async () => {
  const conversation = {
    id: 'conversation-source',
    projectScopeId: 'project-f003',
    title: 'Workspace Facade',
    branch: 'room/conversa-workspace-facade',
    worktreePath: path.resolve('.'),
    workspaceBaseSha: 'b'.repeat(40),
  };
  let summaryBroadcasts = 0;
  const store = {
    getConversation(conversationId) {
      return conversationId === conversation.id ? conversation : null;
    },
    getConversationWithoutMessages(conversationId) {
      return conversationId === conversation.id ? conversation : null;
    },
  };
  const bridge = createAgentToolBridge({
    store,
    resolveProject(projectScopeId) {
      return projectScopeId === conversation.projectScopeId
        ? { id: projectScopeId, path: path.resolve('.') }
        : null;
    },
    broadcastConversationSummary() {
      summaryBroadcasts += 1;
    },
    crossConversationDeliveryService: {
      submitFromAgent() {
        throw new Error('not used');
      },
    },
  });
  const context = bridge.registerInvocation(bridge.createInvocationContext({
    invocationId: 'invocation-workspace-facade',
    callbackToken: 'callback-workspace-facade',
    conversationId: conversation.id,
    turnId: 'turn-workspace-facade',
    agentId: 'agent-source',
    agentName: 'Source Agent',
    stage: { status: 'running' },
  }));

  const preview = await bridge.handlePiCapability('room_workspace_preview', {
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    arguments: {},
  });
  assert.equal(preview.conversationId, conversation.id);
  assert.equal(preview.projectScopeId, conversation.projectScopeId);
  assert.equal(preview.branch, conversation.branch);
  assert.equal(preview.alreadyBound, true);

  const bound = await bridge.handlePiCapability('room_workspace_bind', {
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    arguments: { confirm: true },
  });
  assert.equal(bound.branch, conversation.branch);
  assert.equal(bound.reused, true);
  assert.equal(summaryBroadcasts, 1);
});
test('Agent tools controller exposes only a fixed facade route shape', async () => {
  let received = null;
  const controller = createAgentToolsController({
    agentToolBridge: {
      async handlePiCapability(facade, body) {
        received = { facade, body };
        return { deliveryId: 'delivery-controller' };
      },
    },
  });
  const requestBody = JSON.stringify({
    invocationId: 'invocation-controller',
    callbackToken: 'callback-controller',
    arguments: {
      targetConversationId: 'conversation-target',
      targetAgentId: 'agent-target',
      content: 'hello',
      idempotencyKey: 'controller-idem',
    },
  });
  const req = Readable.from([requestBody]);
  req.method = 'POST';
  let statusCode = null;
  let responseBody = '';
  const res = {
    writeHead(nextStatusCode) {
      statusCode = nextStatusCode;
    },
    end(body) {
      responseBody = String(body || '');
    },
  };
  const requestUrl = new URL(
    'http://127.0.0.1/api/agent-tools/capabilities/conversation_notify'
  );

  const handled = await controller({
    req,
    res,
    pathname: requestUrl.pathname,
    requestUrl,
  });

  assert.equal(handled, true);
  assert.equal(statusCode, 200);
  assert.equal(received.facade, 'conversation_notify');
  assert.deepEqual(received.body, JSON.parse(requestBody));
  assert.deepEqual(JSON.parse(responseBody), {
    ok: true,
    facade: 'conversation_notify',
    result: { deliveryId: 'delivery-controller' },
  });
});

test('dogfood: Pi extension reaches the authenticated delivery facade over real local HTTP', async (t) => {
  let submitted = null;
  const store = {
    getConversation(conversationId) {
      return conversationId === 'conversation-source'
        ? { id: conversationId, projectScopeId: 'project-f003' }
        : null;
    },
  };
  const bridge = createAgentToolBridge({
    store,
    crossConversationDeliveryService: {
      submitFromAgent(principal, args) {
        submitted = { principal, args };
        return createDeliveryResult(args.kind, args);
      },
    },
  });
  const context = bridge.registerInvocation(bridge.createInvocationContext({
    invocationId: 'invocation-dogfood',
    callbackToken: 'callback-dogfood',
    conversationId: 'conversation-source',
    turnId: 'turn-dogfood',
    agentId: 'agent-source',
    agentName: 'Source Agent',
    assistantMessageId: 'assistant-dogfood',
    stage: { status: 'running' },
  }));
  const controller = createAgentToolsController({ agentToolBridge: bridge });
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    try {
      const handled = await controller({
        req,
        res,
        pathname: requestUrl.pathname,
        requestUrl,
      });
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (error) {
      res.writeHead(Number.isInteger(error && error.statusCode) ? error.statusCode : 500, {
        'content-type': 'application/json',
      });
      res.end(JSON.stringify({ error: String(error && error.message || 'Internal server error') }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const previousEnv = {
    apiUrl: process.env.CAFF_CHAT_API_URL,
    invocationId: process.env.CAFF_CHAT_INVOCATION_ID,
    callbackToken: process.env.CAFF_CHAT_CALLBACK_TOKEN,
  };
  process.env.CAFF_CHAT_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.CAFF_CHAT_INVOCATION_ID = context.invocationId;
  process.env.CAFF_CHAT_CALLBACK_TOKEN = context.callbackToken;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (previousEnv.apiUrl === undefined) delete process.env.CAFF_CHAT_API_URL;
    else process.env.CAFF_CHAT_API_URL = previousEnv.apiUrl;
    if (previousEnv.invocationId === undefined) delete process.env.CAFF_CHAT_INVOCATION_ID;
    else process.env.CAFF_CHAT_INVOCATION_ID = previousEnv.invocationId;
    if (previousEnv.callbackToken === undefined) delete process.env.CAFF_CHAT_CALLBACK_TOKEN;
    else process.env.CAFF_CHAT_CALLBACK_TOKEN = previousEnv.callbackToken;
  });

  const extensionPath = path.resolve('lib/pi-extensions/caff-capabilities.mjs');
  const extension = await import(`${pathToFileURL(extensionPath).href}?dogfood=${Date.now()}`);
  const tools = [];
  extension.default({ registerTool(tool) { tools.push(tool); } });
  const result = await tools[0].execute(
    'tool-call-dogfood',
    {
      targetConversationId: 'conversation-target',
      targetAgentId: 'agent-target',
      content: 'dogfood through the full facade path',
      idempotencyKey: 'dogfood-idem',
    },
    undefined
  );

  assert.equal(submitted.principal.sourceInvocationId, 'invocation-dogfood');
  assert.equal(submitted.args.kind, 'notify');
  assert.equal(result.details.deliveryId, 'delivery-notify');
  assert.equal(result.details.dispatchStatus, 'queued');
});

test('fixed MCP stdio adapter uses trusted config and injects principal server-side', async () => {
  const bridge = createPiCapabilityBridge({
    capabilities: [createMcpCapability('echo', { timeoutMs: 10_000 })],
  });

  const result = await bridge.invokeFacade('fixture_echo', {
    principal: createPrincipal(),
    arguments: {
      value: 'hello over stdio',
      idempotencyKey: 'mcp-idem',
    },
  });

  assert.deepEqual(result, {
    value: 'hello over stdio',
    projectScopeId: 'project-f003',
    traceId: 'trace-f003',
    idempotencyKey: 'mcp-idem',
  });
});

test('MCP timeout, disconnect, malformed result, and secret projection fail closed', async () => {
  const configuredSecret = 'fixture-secret-must-not-escape';
  const auditEvents = [];
  const bridge = createPiCapabilityBridge({
    capabilities: [
      createMcpCapability('timeout', { timeoutMs: 50 }),
      createMcpCapability('disconnect'),
      createMcpCapability('malformed'),
      createMcpCapability('secret', {
        configuredSecret,
        sensitiveValues: [configuredSecret],
        projectResult(result) {
          return { message: result.content[0].text };
        },
      }),
    ],
    onAudit(event) {
      auditEvents.push(event);
    },
  });
  const input = {
    principal: createPrincipal(),
    arguments: { value: 'hello', idempotencyKey: 'mcp-failure-idem' },
  };

  await assert.rejects(
    bridge.invokeFacade('fixture_timeout', input),
    (error) => error && error.code === 'pi_capability_timeout'
  );
  await assert.rejects(
    bridge.invokeFacade('fixture_disconnect', input),
    (error) => error && error.code === 'pi_capability_mcp_failed'
  );
  await assert.rejects(
    bridge.invokeFacade('fixture_malformed', input),
    (error) => error && error.code === 'pi_capability_projection_failed'
  );
  await assert.rejects(
    bridge.invokeFacade('fixture_secret', input),
    (error) => {
      assert.equal(error.code, 'pi_capability_projection_failed');
      assert.doesNotMatch(String(error.message), new RegExp(configuredSecret, 'u'));
      return true;
    }
  );

  assert.doesNotMatch(JSON.stringify(auditEvents), new RegExp(configuredSecret, 'u'));
  assert.ok(auditEvents.every((event) => !('transport' in event) && !('toolName' in event)));
});

test('Pi capability bridge has no generic shell or HTTP fallback implementation', () => {
  const source = fs.readFileSync(
    path.resolve('server/domain/runtime/pi-capability-bridge.ts'),
    'utf8'
  );

  assert.doesNotMatch(source, /node:child_process|\bexecFile?\(|\bspawn\(|\bfetch\(|http\.request|https\.request/u);
  assert.doesNotMatch(source, /\{\s*server\s*,\s*tool\s*,\s*arguments\s*\}/u);
});

test('build output contains the CAFF-owned Pi capability extension', () => {
  assert.equal(
    fs.existsSync(path.resolve('build/lib/pi-extensions/caff-capabilities.mjs')),
    true
  );
});
