const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const validatorUrl = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'lib', 'pi-model-config-validator.mjs')
).href;

test('Pi model config validation is pinned to the repo runtime package family and version', async () => {
  const validator = await import(validatorUrl);
  const source = validator.resolvePinnedPiModelConfigSource();

  assert.deepEqual(source.codingAgent, {
    name: '@earendil-works/pi-coding-agent',
    version: '0.80.10',
  });
  assert.deepEqual(source.piAi, {
    name: '@earendil-works/pi-ai',
    version: '0.80.10',
  });
  assert.doesNotThrow(() => validator.assertPinnedPiModelConfigSource(source));
  assert.throws(
    () => validator.assertPinnedPiModelConfigSource({
      ...source,
      piAi: { name: '@mariozechner/pi-ai', version: '0.68.1' },
    }),
    /pinned Pi model config source mismatch/u
  );
});
