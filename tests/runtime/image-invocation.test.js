const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveInvocationModelCapability,
  buildInvocationImages,
} = require('../../build/server/domain/conversation/turn/image-invocation');

function imageMessage(id, images, text = '') {
  const blocks = [];
  if (text) blocks.push({ type: 'text', text });
  for (const image of images) {
    blocks.push({ type: 'image', imageId: image.imageId, url: image.url });
  }
  return {
    id,
    role: 'user',
    content: text,
    contentBlocks: blocks,
    metadata: {},
  };
}

const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('invocation capability resolves from agent runtimeConfig through the model catalog', () => {
  const catalog = {
    getOptions() {
      return [
        { provider: 'openai', model: 'gpt-5', input: ['text', 'image'] },
        { provider: 'deepseek', model: 'deepseek-v3', input: ['text'] },
      ];
    },
  };

  assert.equal(resolveInvocationModelCapability(
    { runtimeConfig: { provider: 'openai', model: 'gpt-5' } },
    catalog
  ).supportsImage, true);

  assert.equal(resolveInvocationModelCapability(
    { runtimeConfig: { provider: 'deepseek', model: 'deepseek-v3' } },
    catalog
  ).supportsImage, false);

  assert.equal(resolveInvocationModelCapability(
    { runtimeConfig: { provider: 'unknown', model: 'not-configured' } },
    catalog
  ).supportsImage, false, 'missing model fails closed');
});

test('buildInvocationImages returns structured ImageContent for a vision model', () => {
  const result = buildInvocationImages({
    promptMessages: [
      imageMessage('m1', [{ imageId: 'i1', url: '/uploads/b1/0-a.png' }], 'what is this'),
    ],
    modelCatalog: {
      getOptions() {
        return [{ provider: 'openai', model: 'gpt-5', input: ['text', 'image'] }];
      },
    },
    agent: { runtimeConfig: { provider: 'openai', model: 'gpt-5' } },
    readImageBytes: (url) => pngBytes,
    imageMimeType: (url) => 'image/png',
  });

  assert.equal(result.block, null);
  assert.deepEqual(result.images, [
    { type: 'image', data: pngBytes.toString('base64'), mimeType: 'image/png' },
  ]);
});

test('buildInvocationImages blocks MODEL_NO_IMAGE_INPUT when the model cannot read images', () => {
  const result = buildInvocationImages({
    promptMessages: [
      imageMessage('m1', [{ imageId: 'i1', url: '/uploads/b1/0-a.png' }], 'what is this'),
    ],
    modelCatalog: {
      getOptions() {
        return [{ provider: 'deepseek', model: 'deepseek-v3', input: ['text'] }];
      },
    },
    agent: { runtimeConfig: { provider: 'deepseek', model: 'deepseek-v3' } },
    readImageBytes: () => pngBytes,
    imageMimeType: () => 'image/png',
  });

  assert.equal(result.block.code, 'MODEL_NO_IMAGE_INPUT');
  assert.equal(result.images.length, 0);
  assert.match(result.block.reason, /不支持/u);
});

test('buildInvocationImages blocks IMAGE_PROMPT_BUDGET_EXCEEDED on image count overflow', () => {
  const result = buildInvocationImages({
    promptMessages: [
      imageMessage('m1', [{ imageId: 'i1', url: '/uploads/b1/0-a.png' }], 'a'),
      imageMessage('m2', [{ imageId: 'i2', url: '/uploads/b1/1-b.png' }], 'b'),
      imageMessage('m3', [{ imageId: 'i3', url: '/uploads/b1/2-c.png' }], 'c'),
    ],
    modelCatalog: {
      getOptions() {
        return [{ provider: 'openai', model: 'gpt-5', input: ['text', 'image'] }];
      },
    },
    agent: { runtimeConfig: { provider: 'openai', model: 'gpt-5' } },
    readImageBytes: () => pngBytes,
    imageMimeType: () => 'image/png',
    maxImagesPerInvocation: 2,
  });

  assert.equal(result.block.code, 'IMAGE_PROMPT_BUDGET_EXCEEDED');
  assert.equal(result.images.length, 0);
});

test('buildInvocationImages blocks IMAGE_CONTENT_UNAVAILABLE when a referenced file is missing', () => {
  const result = buildInvocationImages({
    promptMessages: [
      imageMessage('m1', [{ imageId: 'i1', url: '/uploads/b1/0-a.png' }], 'what is this'),
    ],
    modelCatalog: {
      getOptions() {
        return [{ provider: 'openai', model: 'gpt-5', input: ['text', 'image'] }];
      },
    },
    agent: { runtimeConfig: { provider: 'openai', model: 'gpt-5' } },
    readImageBytes: () => null,
    imageMimeType: () => 'image/png',
  });

  assert.equal(result.block.code, 'IMAGE_CONTENT_UNAVAILABLE');
  assert.equal(result.images.length, 0);
});

test('buildInvocationImages returns no images for a text-only prompt', () => {
  const result = buildInvocationImages({
    promptMessages: [
      { id: 'm1', role: 'user', content: 'plain text', contentBlocks: [{ type: 'text', text: 'plain text' }], metadata: {} },
    ],
    modelCatalog: {
      getOptions() {
        return [{ provider: 'openai', model: 'gpt-5', input: ['text', 'image'] }];
      },
    },
    agent: { runtimeConfig: { provider: 'openai', model: 'gpt-5' } },
    readImageBytes: () => pngBytes,
    imageMimeType: () => 'image/png',
  });

  assert.equal(result.block, null);
  assert.deepEqual(result.images, []);
});

test('buildInvocationImages maps url mime types for common image formats', () => {
  const result = buildInvocationImages({
    promptMessages: [
      imageMessage('m1', [{ imageId: 'i1', url: '/uploads/b1/0-a.jpeg' }], 'what is this'),
    ],
    modelCatalog: {
      getOptions() {
        return [{ provider: 'openai', model: 'gpt-5', input: ['text', 'image'] }];
      },
    },
    agent: { runtimeConfig: { provider: 'openai', model: 'gpt-5' } },
    readImageBytes: () => pngBytes,
  });

  assert.equal(result.block, null);
  assert.equal(result.images[0].mimeType, 'image/jpeg');
});
