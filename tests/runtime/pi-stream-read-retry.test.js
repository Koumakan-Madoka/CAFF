const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { Type } = require('typebox');

const codingAgentRoot = path.resolve(
  __dirname,
  '..',
  '..',
  'node_modules',
  '@earendil-works',
  'pi-coding-agent'
);
const retryExtensionPath = path.resolve(
  __dirname,
  '..',
  '..',
  'lib',
  'pi-extensions',
  'caff-stream-read-retry.mjs'
);

const model = {
  id: 'caff-stream-read-retry-fixture',
  name: 'CAFF stream read retry fixture',
  api: 'fixture-api',
  provider: 'fixture-provider',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

function createUsage(sequence) {
  return {
    input: sequence,
    output: 1,
    cacheRead: sequence > 1 ? 10 : 0,
    cacheWrite: 0,
    totalTokens: sequence + 11,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createAssistantResponse(input, sequence) {
  const content = [];
  if (input.text) {
    content.push({ type: 'text', text: input.text });
  }
  if (input.toolCall) {
    content.push({
      type: 'toolCall',
      id: input.toolCall.id,
      name: input.toolCall.name,
      arguments: input.toolCall.arguments || {},
    });
  }

  const stopReason = input.stopReason || (input.errorMessage ? 'error' : 'stop');
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    responseId: `fixture-response-${sequence}`,
    usage: createUsage(sequence),
    stopReason,
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    timestamp: sequence,
  };
}

async function loadRuntimeModules() {
  const sdk = await import(pathToFileURL(path.join(codingAgentRoot, 'dist', 'index.js')).href);
  const { Agent } = await import(pathToFileURL(path.join(
    codingAgentRoot,
    'node_modules',
    '@earendil-works',
    'pi-agent-core',
    'dist',
    'agent.js'
  )).href);
  const { createAssistantMessageEventStream } = await import(pathToFileURL(path.join(
    codingAgentRoot,
    'node_modules',
    '@earendil-works',
    'pi-ai',
    'dist',
    'utils',
    'event-stream.js'
  )).href);
  return { sdk, Agent, createAssistantMessageEventStream };
}

function createMessageStream(createAssistantMessageEventStream, message) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const partial = { ...message, content: [], stopReason: 'pending' };
    stream.push({ type: 'start', partial: { ...partial } });

    for (const block of message.content) {
      const contentIndex = partial.content.length;
      if (block.type === 'text') {
        partial.content = [...partial.content, { type: 'text', text: '' }];
        stream.push({ type: 'text_start', contentIndex, partial: { ...partial } });
        partial.content[contentIndex].text = block.text;
        stream.push({ type: 'text_delta', contentIndex, delta: block.text, partial: { ...partial } });
        stream.push({ type: 'text_end', contentIndex, content: block.text, partial: { ...partial } });
        continue;
      }

      partial.content = [...partial.content, {
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: {},
      }];
      stream.push({ type: 'toolcall_start', contentIndex, partial: { ...partial } });
      const argumentsText = JSON.stringify(block.arguments || {});
      stream.push({ type: 'toolcall_delta', contentIndex, delta: argumentsText, partial: { ...partial } });
      partial.content[contentIndex].arguments = block.arguments || {};
      stream.push({ type: 'toolcall_end', contentIndex, toolCall: block, partial: { ...partial } });
    }

    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      stream.push({ type: 'error', reason: message.stopReason, error: message });
      stream.end(message);
      return;
    }

    stream.push({ type: 'done', reason: message.stopReason, message });
    stream.end(message);
  });
  return stream;
}

async function runScenario(responseInputs, options = {}) {
  const { sdk, Agent, createAssistantMessageEventStream } = await loadRuntimeModules();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-stream-read-retry-'));
  const responses = responseInputs.map(createAssistantResponse);
  const contexts = [];
  let providerCalls = 0;
  let toolExecutions = 0;

  const sideEffectTool = {
    name: 'commit_side_effect',
    label: 'Commit side effect',
    description: 'Records one committed side effect for retry-boundary testing.',
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      toolExecutions += 1;
      return {
        content: [{ type: 'text', text: `committed-${toolExecutions}` }],
        details: { committed: toolExecutions },
      };
    },
  };
  const tools = options.withTool ? [sideEffectTool] : [];
  const agent = new Agent({
    initialState: {
      systemPrompt: 'Controlled retry fixture.',
      model,
      thinkingLevel: 'off',
      tools,
      messages: [],
    },
    streamFn(_model, context) {
      contexts.push({
        systemPrompt: context.systemPrompt,
        messages: structuredClone(context.messages),
        toolNames: Array.isArray(context.tools) ? context.tools.map((tool) => tool.name) : [],
      });
      const response = responses[Math.min(providerCalls, responses.length - 1)];
      providerCalls += 1;
      return createMessageStream(createAssistantMessageEventStream, response);
    },
    getApiKey: () => 'fixture-key',
  });
  const settingsManager = sdk.SettingsManager.inMemory({
    retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 },
    compaction: { enabled: false },
  });
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: tempDir,
    agentDir: tempDir,
    settingsManager,
    additionalExtensionPaths: [retryExtensionPath],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const modelRuntime = {
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ type: 'api_key', key: 'fixture-key' }),
    isUsingOAuth: () => false,
    getAuth: async () => ({ auth: { apiKey: 'fixture-key', headers: {} }, env: {} }),
    getAvailable: async () => [model],
    getModel: () => model,
    registerProvider() {},
    unregisterProvider() {},
  };
  const session = new sdk.AgentSession({
    agent,
    sessionManager: sdk.SessionManager.inMemory(tempDir),
    settingsManager,
    resourceLoader,
    modelRuntime,
    cwd: tempDir,
    baseToolsOverride: Object.fromEntries(tools.map((tool) => [tool.name, tool])),
    initialActiveToolNames: tools.map((tool) => tool.name),
  });
  const events = [];
  session.subscribe((event) => events.push(structuredClone(event)));

  try {
    await session.prompt('Run the controlled scenario.');
    await session.waitForIdle();
    return {
      providerCalls,
      toolExecutions,
      contexts,
      events,
      assistantEnds: events.filter(
        (event) => event.type === 'message_end' && event.message?.role === 'assistant'
      ).map((event) => event.message),
      retryStarts: events.filter((event) => event.type === 'auto_retry_start'),
      retryEnds: events.filter((event) => event.type === 'auto_retry_end'),
      finalMessages: session.messages,
    };
  } finally {
    session.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('exact stream_read_error retries once through PI and recovers', async () => {
  const result = await runScenario([
    { errorMessage: 'stream_read_error' },
    { text: 'recovered response' },
  ]);

  assert.equal(result.providerCalls, 2);
  assert.deepEqual(result.retryStarts.map((event) => event.attempt), [1]);
  assert.deepEqual(result.retryEnds.map((event) => ({ success: event.success, attempt: event.attempt })), [
    { success: true, attempt: 1 },
  ]);
  assert.equal(result.assistantEnds[0].errorMessage, 'connection error: stream_read_error');
  assert.equal(result.assistantEnds.at(-1).stopReason, 'stop');
  assert.equal(result.assistantEnds.at(-1).content[0].text, 'recovered response');
});

test('four consecutive exact failures stop after three native retries', async () => {
  const result = await runScenario([
    { errorMessage: 'stream_read_error' },
    { errorMessage: 'stream_read_error' },
    { errorMessage: 'stream_read_error' },
    { errorMessage: 'stream_read_error' },
  ]);

  assert.equal(result.providerCalls, 4);
  assert.deepEqual(result.retryStarts.map((event) => event.attempt), [1, 2, 3]);
  assert.deepEqual(result.retryEnds.map((event) => ({ success: event.success, attempt: event.attempt })), [
    { success: false, attempt: 3 },
  ]);
  assert.equal(result.retryEnds[0].finalError, 'connection error: stream_read_error');
  assert.equal(result.assistantEnds.at(-1).stopReason, 'error');
  assert.equal(result.assistantEnds.at(-1).errorMessage, 'connection error: stream_read_error');
});

test('partial text from the failed attempt is discarded from live PI context before recovery', async () => {
  const result = await runScenario([
    { text: 'discard this partial text', errorMessage: 'stream_read_error' },
    { text: 'keep this recovered text' },
  ]);

  assert.equal(result.providerCalls, 2);
  assert.equal(result.assistantEnds[0].content[0].text, 'discard this partial text');
  assert.equal(result.finalMessages.some((message) => (
    message.role === 'assistant'
    && message.content?.some((block) => block.type === 'text' && block.text.includes('discard this'))
  )), false);
  assert.equal(result.finalMessages.some((message) => (
    message.role === 'assistant'
    && message.content?.some((block) => block.type === 'text' && block.text.includes('keep this recovered'))
  )), true);
});

test('non-exact provider, quota, authentication, authorization, and abort failures are not remapped', async (t) => {
  const cases = [
    ['http-400', { errorMessage: 'HTTP 400: bad request' }],
    ['http-401', { errorMessage: 'HTTP 401: unauthorized' }],
    ['http-403', { errorMessage: 'HTTP 403: forbidden' }],
    ['quota', { errorMessage: 'insufficient quota' }],
    ['suffix', { errorMessage: 'stream_read_error: provider detail' }],
    ['prefix', { errorMessage: 'provider stream_read_error' }],
    ['abort', { stopReason: 'aborted', errorMessage: 'stream_read_error' }],
  ];

  for (const [name, response] of cases) {
    await t.test(name, async () => {
      const result = await runScenario([response, { text: 'must not run' }]);
      assert.equal(result.providerCalls, 1);
      assert.equal(result.retryStarts.length, 0);
      assert.equal(result.retryEnds.length, 0);
      assert.equal(result.assistantEnds[0].errorMessage, response.errorMessage);
      assert.equal(result.assistantEnds[0].stopReason, response.stopReason || 'error');
    });
  }
});

test('ordinary PI-recognized connection failures keep native retry behavior', async () => {
  const result = await runScenario([
    { errorMessage: 'connection error: fixture disconnect' },
    { text: 'ordinary retry recovered' },
  ]);

  assert.equal(result.providerCalls, 2);
  assert.equal(result.retryStarts.length, 1);
  assert.equal(result.retryEnds.length, 1);
  assert.equal(result.retryEnds[0].success, true);
  assert.equal(result.assistantEnds[0].errorMessage, 'connection error: fixture disconnect');
});

test('a completed tool side effect is not executed again when a later model stream retries', async () => {
  const result = await runScenario([
    {
      stopReason: 'toolUse',
      toolCall: { id: 'tool-call-1', name: 'commit_side_effect', arguments: {} },
    },
    { text: 'partial after committed tool', errorMessage: 'stream_read_error' },
    { text: 'final after retry' },
  ], { withTool: true });

  assert.equal(result.providerCalls, 3, JSON.stringify(result.assistantEnds));
  assert.equal(result.toolExecutions, 1);
  assert.equal(result.retryStarts.length, 1);
  assert.equal(result.retryEnds[0].success, true);
  const retryContext = result.contexts[2];
  assert.equal(retryContext.messages.filter((message) => message.role === 'toolResult').length, 1);
  assert.equal(retryContext.messages.filter((message) => (
    message.role === 'assistant'
    && message.stopReason === 'error'
  )).length, 0);
  assert.equal(result.assistantEnds.length, 3);
});
