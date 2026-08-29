const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const validatorUrl = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'lib', 'pi-model-config-validator.mjs')
).href;

test('package dependencies pin one canonical PI family without the deprecated package', () => {
  const packageJson = require('../../package.json');

  assert.equal(packageJson.dependencies['@earendil-works/pi-coding-agent'], '0.84.3');
  assert.equal(packageJson.dependencies['@earendil-works/pi-ai'], '0.84.3');
  assert.equal(packageJson.dependencies.typebox, '1.3.7');
  assert.equal(Object.hasOwn(packageJson.dependencies, '@mariozechner/pi-ai'), false);

  const packageLock = require('../../package-lock.json');
  const piAiVersions = Object.entries(packageLock.packages)
    .filter(([packagePath]) => packagePath.endsWith('node_modules/@earendil-works/pi-ai'))
    .map(([, entry]) => entry.version);
  assert.ok(piAiVersions.length >= 1);
  assert.deepEqual([...new Set(piAiVersions)], ['0.84.3']);
  assert.equal(Object.hasOwn(packageLock.packages, 'node_modules/@mariozechner/pi-ai'), false);

  const digestSource = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'server', 'domain', 'conversation', 'conversation-digest.ts'),
    'utf8'
  );
  const extensionSource = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'lib', 'pi-extensions', 'caff-capabilities.mjs'),
    'utf8'
  );
  assert.match(digestSource, /@earendil-works\/pi-ai\/compat/u);
  assert.doesNotMatch(digestSource, /@mariozechner\/pi-ai/u);
  assert.match(extensionSource, /from 'typebox'/u);
  assert.doesNotMatch(extensionSource, /from '@(?:earendil-works|mariozechner)\/pi-ai'/u);
});

test('direct PI AI compat entry resolves the digest completion API without network access', async () => {
  const piAi = await import('@earendil-works/pi-ai/compat');
  assert.equal(typeof piAi.complete, 'function');
  assert.equal(typeof piAi.completeSimple, 'function');
  assert.equal(typeof piAi.getModel, 'function');
});

test('Pi model config validation is pinned to the repo runtime package family and version', async () => {
  const validator = await import(validatorUrl);
  const source = validator.resolvePinnedPiModelConfigSource();

  assert.deepEqual(source.codingAgent, {
    name: '@earendil-works/pi-coding-agent',
    version: '0.84.3',
  });
  assert.deepEqual(source.piAi, {
    name: '@earendil-works/pi-ai',
    version: '0.84.3',
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
