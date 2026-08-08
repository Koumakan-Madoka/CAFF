const test = require('node:test');
const assert = require('node:assert/strict');

const {
  projectMultimodalPrompt,
  imageMarkerFor,
} = require('../../build/server/domain/conversation/turn/multimodal-projection');

function imageMessage(id, ordinal, images, text = '') {
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

test('multimodal projection inserts deterministic markers and collects images in order', () => {
  const messages = [
    imageMessage('m1', 0, [{ imageId: 'i1', url: '/uploads/i1.png' }], 'first image'),
    imageMessage('m2', 1, [
      { imageId: 'i2', url: '/uploads/i2.png' },
      { imageId: 'i3', url: '/uploads/i3.png' },
    ], 'second message'),
    imageMessage('m3', 2, [{ imageId: 'i4', url: '/uploads/i4.png' }], 'third'),
  ];

  const result = projectMultimodalPrompt(messages, {
    maxMessages: 24,
    readImage: (image) => Buffer.from(`bytes-${image.imageId}`),
  });

  assert.equal(result.text.includes('[image:0:0]'), true, 'marker for first image of first message');
  assert.equal(result.text.includes('[image:1:0]'), true, 'marker for first image of second message');
  assert.equal(result.text.includes('[image:1:1]'), true, 'marker for second image of second message');
  assert.equal(result.text.includes('[image:2:0]'), true, 'marker for first image of third message');
  assert.deepEqual(result.images.map((image) => image.marker), [
    '[image:0:0]',
    '[image:1:0]',
    '[image:1:1]',
    '[image:2:0]',
  ]);
  assert.deepEqual(result.images.map((image) => image.imageId), ['i1', 'i2', 'i3', 'i4']);
  assert.equal(result.text.indexOf('[image:0:0]') < result.text.indexOf('[image:1:0]'), true, 'markers in message order');
  assert.equal(result.budgetExceeded, false);
});

test('multimodal projection applies the same trailing window as formatHistory', () => {
  const messages = [];
  for (let index = 0; index < 30; index += 1) {
    messages.push(imageMessage(`m${index}`, index, [{ imageId: `i${index}`, url: `/uploads/i${index}.png` }], `message ${index}`));
  }

  const result = projectMultimodalPrompt(messages, {
    maxMessages: 24,
    maxImages: 24,
    readImage: (image) => Buffer.from(`bytes-${image.imageId}`),
  });

  assert.equal(result.images.length, 24, 'only the trailing 24 messages contribute images');
  assert.equal(result.text.includes('[image:0:0]'), true, 'first in-window message (original m6) has a marker');
  assert.equal(result.images[0].imageId, 'i6', 'first in-window message is the oldest surviving message');
});

test('multimodal projection fails closed when image count budget is exceeded', () => {
  const messages = [];
  for (let index = 0; index < 3; index += 1) {
    messages.push(imageMessage(`m${index}`, index, [{ imageId: `i${index}`, url: `/uploads/i${index}.png` }], `message ${index}`));
  }

  const result = projectMultimodalPrompt(messages, {
    maxMessages: 24,
    maxImages: 2,
    readImage: (image) => Buffer.from(`bytes-${image.imageId}`),
  });

  assert.equal(result.budgetExceeded, true);
  assert.equal(result.budgetReason, 'image_count');
  assert.equal(result.images.length, 0, 'no images projected when budget is exceeded');
});

test('multimodal projection fails closed when byte budget is exceeded', () => {
  const messages = [
    imageMessage('m0', 0, [{ imageId: 'i0', url: '/uploads/i0.png' }], 'a'),
    imageMessage('m1', 1, [{ imageId: 'i1', url: '/uploads/i1.png' }], 'b'),
  ];

  const result = projectMultimodalPrompt(messages, {
    maxMessages: 24,
    maxImages: 5,
    maxPromptBytes: 5,
    readImage: (image) => Buffer.from(`bytes-${image.imageId}`),
  });

  assert.equal(result.budgetExceeded, true);
  assert.equal(result.budgetReason, 'image_bytes');
  assert.equal(result.images.length, 0);
});

test('multimodal projection reports missing image files without silently dropping them', () => {
  const messages = [
    imageMessage('m0', 0, [{ imageId: 'i0', url: '/uploads/i0.png' }], 'a'),
  ];

  const result = projectMultimodalPrompt(messages, {
    maxMessages: 24,
    maxImages: 24,
    readImage: () => null,
  });

  assert.equal(result.missingImages.length, 1);
  assert.equal(result.missingImages[0].imageId, 'i0');
  assert.equal(result.images.length, 0);
});

test('imageMarkerFor produces deterministic markers', () => {
  assert.equal(imageMarkerFor(0, 0), '[image:0:0]');
  assert.equal(imageMarkerFor(12, 3), '[image:12:3]');
});

test('multimodal projection ignores non-user and text-only messages', () => {
  const messages = [
    imageMessage('m0', 0, [{ imageId: 'i0', url: '/uploads/i0.png' }], 'user image'),
    { id: 'a0', role: 'assistant', content: 'reply', contentBlocks: [{ type: 'text', text: 'reply' }], metadata: {} },
    { id: 'm1', role: 'user', content: 'plain text', contentBlocks: [{ type: 'text', text: 'plain text' }], metadata: {} },
  ];

  const result = projectMultimodalPrompt(messages, {
    maxMessages: 24,
    readImage: (image) => Buffer.from(`bytes-${image.imageId}`),
  });

  assert.deepEqual(result.images.map((image) => image.imageId), ['i0']);
  assert.equal(result.text.includes('plain text'), true);
  assert.equal(result.text.includes('reply'), true);
});
