const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ModelCatalogCacheError,
  atomicReplaceCatalogCache,
  readCatalogCache,
  selectCatalogSource,
} = require('../../build/server/domain/models/models-dev-catalog-cache');

function catalogProvider() {
  return {
    openai: {
      env: ['OPENAI_API_KEY'],
      api: 'https://api.openai.com/v1',
      models: {
        'gpt-5': { family: 'gpt' },
      },
    },
  };
}

function cacheDocument() {
  return {
    schemaVersion: 1,
    provenance: {
      kind: 'vendored',
      sourceUrl: 'https://models.dev/api.json',
      commitSha: 'verified-sha',
      payloadSha256: 'verified-hash',
      fetchedAt: '2026-08-06T00:00:00.000Z',
    },
    providers: catalogProvider(),
  };
}

test('catalog cache is separate from models.json and survives a read round trip', () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-models-dev-cache-'));
  const result = atomicReplaceCatalogCache(agentDir, cacheDocument());

  assert.equal(result.path, path.join(agentDir, 'models-dev-catalog.json'));
  assert.equal(fs.existsSync(path.join(agentDir, 'models.json')), false);
  assert.deepEqual(readCatalogCache(agentDir), cacheDocument());
});

test('invalid cache replacement fails before touching the last-known-good document', () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-models-dev-cache-'));
  atomicReplaceCatalogCache(agentDir, cacheDocument());

  assert.throws(
    () => atomicReplaceCatalogCache(agentDir, { ...cacheDocument(), schemaVersion: 2 }),
    (error) => error instanceof ModelCatalogCacheError && error.code === 'catalog_cache_schema_invalid'
  );
  assert.deepEqual(readCatalogCache(agentDir), cacheDocument());
});

test('catalog source precedence keeps user configuration above imports and caches', () => {
  const modelsJson = { providers: { openai: { models: [{ id: 'gpt-5' }] } } };
  const explicitImport = { providerId: 'openai', modelId: 'gpt-5' };
  const onlineCache = { schemaVersion: 1, provenance: { kind: 'online' } };
  const vendored = { schemaVersion: 1, provenance: { kind: 'vendored' } };

  assert.deepEqual(selectCatalogSource({ modelsJson, explicitImport, onlineCache, vendored }), {
    kind: 'models-json',
    value: modelsJson,
  });
  assert.deepEqual(selectCatalogSource({ explicitImport, onlineCache, vendored }), {
    kind: 'explicit-import',
    value: explicitImport,
  });
  assert.deepEqual(selectCatalogSource({ onlineCache, vendored }), {
    kind: 'online-cache',
    value: onlineCache,
  });
});
