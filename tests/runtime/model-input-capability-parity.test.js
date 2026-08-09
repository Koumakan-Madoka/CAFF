const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  modelSupportsImageInput,
} = require('../../build/server/domain/models/model-provider-config');

const PI_TRANSFORM_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'node_modules',
  '@earendil-works',
  'pi-coding-agent',
  'node_modules',
  '@earendil-works',
  'pi-ai',
  'dist',
  'api',
  'transform-messages.js'
);

let transformMessages;
let loaded = false;
async function loadTransformMessages() {
  if (loaded) return transformMessages;
  const module = await import(pathToFileURL(PI_TRANSFORM_PATH).href);
  transformMessages = module.transformMessages;
  loaded = true;
  return transformMessages;
}

function userMessageWithImage(text) {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image', url: 'file:///tmp/example.png' },
    ],
  };
}

function assertNoImageContent(messages) {
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        assert.notEqual(block.type, 'image', 'non-vision model must never receive image content');
      }
    }
  }
}

test('CAFF capability judgement matches PI runtime model.input.includes(image)', async () => {
  await loadTransformMessages();
  const pi = (input) => Array.isArray(input) && input.includes('image');

  for (const input of [
    undefined,
    null,
    ['text'],
    ['text', 'image'],
    ['image'],
    [],
    'image',
    42,
  ]) {
    assert.equal(
      modelSupportsImageInput(input),
      pi(input),
      `CAFF/PI parity mismatch for input=${JSON.stringify(input)}`
    );
  }
});

test('parity regression: non-vision model images are downgraded by PI (must be preflighted away)', async () => {
  await loadTransformMessages();
  const downgraded = transformMessages(
    [userMessageWithImage('describe this')],
    { provider: 'local', api: 'openai-completions', id: 'text-only', input: ['text'] },
    null
  );
  assertNoImageContent(downgraded);
  const flattened = JSON.stringify(downgraded);
  assert.match(flattened, /image omitted/u, 'PI drops a placeholder text for unsupported images');
});

test('parity regression: vision model keeps image content through transform', async () => {
  await loadTransformMessages();
  const kept = transformMessages(
    [userMessageWithImage('describe this')],
    { provider: 'local', api: 'openai-completions', id: 'vision', input: ['text', 'image'] },
    null
  );
  const flattened = JSON.stringify(kept);
  assert.match(flattened, /image/u);
  assert.equal(flattened.includes('image omitted'), false);
});

test('parity regression: missing input defaults to text-only in PI (CAFF fail-closed matches)', async () => {
  await loadTransformMessages();
  const synthesized = { input: ['text'] };
  assert.equal(modelSupportsImageInput(synthesized.input), false);
  const downgraded = transformMessages(
    [userMessageWithImage('describe this')],
    { provider: 'local', api: 'openai-completions', id: 'unknown', input: synthesized.input },
    null
  );
  assertNoImageContent(downgraded);
});
