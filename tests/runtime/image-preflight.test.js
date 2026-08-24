const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertImagePreflightForTargets,
  resolveInitialTargetAgentIds,
  resolveTargetModelCapabilities,
} = require('../../build/server/domain/conversation/turn/image-preflight');

function conversationFixture(agents) {
  return {
    id: 'conversation-1',
    type: 'standard',
    agents,
  };
}

function agentFixture(id, runtimeConfig) {
  return {
    id,
    name: id,
    runtimeConfig,
  };
}

function catalogFixture(modelInputByKey) {
  return {
    getOptions() {
      return Object.entries(modelInputByKey).map(([key, input]) => {
        const [provider, model] = key.split('\u001f');
        return { provider, model, input };
      });
    },
  };
}

test('image preflight resolves initial targets by mention set or first agent', () => {
  const agents = [
    agentFixture('vision-agent', { provider: 'openai', model: 'gpt-5' }),
    agentFixture('text-agent', { provider: 'deepseek', model: 'deepseek-v3' }),
  ];

  assert.deepEqual(resolveInitialTargetAgentIds({ content: '@vision-agent hello', cleanedContent: '@vision-agent hello', initialAgentIds: [] }, conversationFixture(agents)), ['vision-agent']);
  assert.deepEqual(resolveInitialTargetAgentIds({ content: 'plain message', cleanedContent: 'plain message', initialAgentIds: [] }, conversationFixture(agents)), ['vision-agent']);
  assert.deepEqual(resolveInitialTargetAgentIds({ content: 'hello', cleanedContent: 'hello', initialAgentIds: ['text-agent'] }, conversationFixture(agents)), ['text-agent']);
  assert.deepEqual(resolveInitialTargetAgentIds({ content: '@vision-agent @text-agent hello', cleanedContent: '@vision-agent @text-agent hello', initialAgentIds: [] }, conversationFixture(agents)), ['vision-agent', 'text-agent']);
});

test('image preflight defaults to the latest completed public-reply agent used by text routing', () => {
  const catalog = catalogFixture({
    'openai\u001fgpt-5': ['text', 'image'],
    'deepseek\u001fdeepseek-v3': ['text'],
  });
  const agents = [
    agentFixture('vision-agent', { provider: 'openai', model: 'gpt-5' }),
    agentFixture('text-agent', { provider: 'deepseek', model: 'deepseek-v3' }),
  ];
  const conversation = {
    ...conversationFixture(agents),
    messages: [
      {
        id: 'message-text-agent-public',
        role: 'assistant',
        agentId: 'text-agent',
        content: 'Most recent completed public reply',
        status: 'completed',
        metadata: {},
        createdAt: '2026-08-24T00:00:00.000Z',
      },
    ],
  };
  const turnInput = {
    content: 'describe the image without a mention',
    cleanedContent: 'describe the image without a mention',
    initialAgentIds: [],
    imageIds: ['image-1'],
  };

  assert.deepEqual(resolveInitialTargetAgentIds(turnInput, conversation), ['text-agent']);
  assert.throws(
    () => assertImagePreflightForTargets(turnInput, conversation, { modelCatalog: catalog }),
    (error) => error.statusCode === 422 && error.code === 'MODEL_NO_IMAGE_INPUT' && /text-agent/u.test(error.message)
  );
});

test('image preflight resolves model capabilities from the configured model catalog', () => {
  const catalog = catalogFixture({
    'openai\u001fgpt-5': ['text', 'image'],
    'deepseek\u001fdeepseek-v3': ['text'],
  });
  const agents = [
    agentFixture('vision-agent', { provider: 'openai', model: 'gpt-5' }),
    agentFixture('text-agent', { provider: 'deepseek', model: 'deepseek-v3' }),
  ];

  const capabilities = resolveTargetModelCapabilities(agents, catalog);
  assert.deepEqual(capabilities, [
    { agentId: 'vision-agent', provider: 'openai', model: 'gpt-5', input: ['text', 'image'], supportsImage: true },
    { agentId: 'text-agent', provider: 'deepseek', model: 'deepseek-v3', input: ['text'], supportsImage: false },
  ]);
});

test('image preflight fails closed when the model is missing from the catalog', () => {
  const catalog = catalogFixture({});
  const agents = [agentFixture('mystery-agent', { provider: 'unknown', model: 'not-configured' })];

  const capabilities = resolveTargetModelCapabilities(agents, catalog);
  assert.deepEqual(capabilities, [
    { agentId: 'mystery-agent', provider: 'unknown', model: 'not-configured', input: ['text'], supportsImage: false },
  ]);
});

test('image preflight rejects with 422 MODEL_NO_IMAGE_INPUT when any initial target cannot read images', () => {
  const catalog = catalogFixture({
    'openai\u001fgpt-5': ['text', 'image'],
    'deepseek\u001fdeepseek-v3': ['text'],
  });
  const agents = [
    agentFixture('vision-agent', { provider: 'openai', model: 'gpt-5' }),
    agentFixture('text-agent', { provider: 'deepseek', model: 'deepseek-v3' }),
  ];
  const conversation = conversationFixture(agents);
  const turnInput = {
    content: '@vision-agent @text-agent describe the image',
    cleanedContent: '@vision-agent @text-agent describe the image',
    initialAgentIds: [],
    imageIds: ['image-1'],
  };

  assert.throws(
    () => assertImagePreflightForTargets(turnInput, conversation, { modelCatalog: catalog }),
    (error) => error.statusCode === 422 && error.code === 'MODEL_NO_IMAGE_INPUT' && /text-agent/u.test(error.message)
  );
});

test('image preflight passes when all initial targets can read images', () => {
  const catalog = catalogFixture({
    'openai\u001fgpt-5': ['text', 'image'],
  });
  const agents = [agentFixture('vision-agent', { provider: 'openai', model: 'gpt-5' })];
  const conversation = conversationFixture(agents);
  const turnInput = {
    content: 'describe the image',
    cleanedContent: 'describe the image',
    initialAgentIds: [],
    imageIds: ['image-1'],
  };

  assert.doesNotThrow(() => assertImagePreflightForTargets(turnInput, conversation, { modelCatalog: catalog }));
});

test('image preflight does nothing for text-only messages', () => {
  const catalog = catalogFixture({
    'deepseek\u001fdeepseek-v3': ['text'],
  });
  const agents = [agentFixture('text-agent', { provider: 'deepseek', model: 'deepseek-v3' })];
  const conversation = conversationFixture(agents);
  const turnInput = {
    content: 'plain text',
    cleanedContent: 'plain text',
    initialAgentIds: [],
    imageIds: [],
  };

  assert.doesNotThrow(() => assertImagePreflightForTargets(turnInput, conversation, { modelCatalog: catalog }));
});
