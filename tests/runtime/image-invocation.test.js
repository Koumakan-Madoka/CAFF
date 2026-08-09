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

function pngBytes(width = 100, height = 50) {
  const buffer = Buffer.alloc(33);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  sig.copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer.writeUInt8(8, 24);
  buffer.writeUInt8(6, 25);
  buffer.writeUInt8(0, 26);
  buffer.writeUInt8(0, 27);
  buffer.writeUInt8(0, 28);
  return buffer;
}

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
    readImageBytes: () => pngBytes(),
    imageMimeType: (url) => 'image/png',
  });

  assert.equal(result.block, null);
  assert.deepEqual(result.images, [
    { type: 'image', data: pngBytes().toString('base64'), mimeType: 'image/png' },
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
    readImageBytes: () => pngBytes(),
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
    readImageBytes: () => pngBytes(),
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
    readImageBytes: () => pngBytes(),
    imageMimeType: () => 'image/png',
  });

  assert.equal(result.block, null);
  assert.deepEqual(result.images, []);
});

test('buildInvocationImages resolves mime from magic bytes, not url extension', () => {
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
    readImageBytes: () => pngBytes(),
  });

  assert.equal(result.block, null);
  assert.equal(result.images[0].mimeType, 'image/png');
});

test('buildInvocationImages blocks IMAGE_MIME_MISMATCH when persisted mime contradicts magic bytes', () => {
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
    readImageBytes: () => pngBytes(),
    imageMimeType: () => 'image/jpeg',
  });

  assert.equal(result.block.code, 'IMAGE_MIME_MISMATCH');
  assert.equal(result.images.length, 0);
});

test('buildInvocationImages blocks IMAGE_MAGIC_BYTE_MISMATCH for bytes with no image header', () => {
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
    readImageBytes: () => Buffer.from('not-an-image'),
  });

  assert.equal(result.block.code, 'IMAGE_MAGIC_BYTE_MISMATCH');
  assert.equal(result.images.length, 0);
});

test('buildInvocationImages does not block when image is outside the projection window', () => {
  const messages = [];
  messages.push(imageMessage('old', [{ imageId: 'i0', url: '/uploads/b1/0-a.png' }], 'first with image'));

  for (let i = 0; i < 24; i += 1) {
    messages.push({ id: `t${i}`, role: 'user', content: `text ${i}`, contentBlocks: [{ type: 'text', text: `text ${i}` }], metadata: {} });
  }

  const result = buildInvocationImages({
    promptMessages: messages,
    modelCatalog: {
      getOptions() {
        return [{ provider: 'deepseek', model: 'deepseek-v3', input: ['text'] }];
      },
    },
    agent: { runtimeConfig: { provider: 'deepseek', model: 'deepseek-v3' } },
    readImageBytes: () => pngBytes(),
  });

  assert.equal(result.block, null);
  assert.equal(result.images.length, 0);
});

test('buildInvocationImages returns projectedText with image markers in window order', () => {
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
    readImageBytes: () => pngBytes(),
  });

  assert.equal(result.block, null);
  assert.equal(result.images.length, 1);
  assert.match(result.projectedText, /\[image:0:0\]/u);
});
