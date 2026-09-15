const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { ModelCatalogError } = require('../../build/server/domain/models/models-dev-import');
const {
  DEFAULT_MODELS_DEV_REFRESH_LIMITS,
  MODELS_DEV_API_URL,
  MODELS_DEV_COMMIT_URL,
  refreshModelsDevCatalog,
} = require('../../build/server/domain/models/models-dev-online-refresh');
const { withTempDir } = require('../helpers/temp-dir');

function upstreamDocument() {
  return {
    openai: {
      name: 'OpenAI',
      env: ['OPENAI_API_KEY'],
      api: 'https://api.openai.com/v1',
      npm: '@ai-sdk/openai',
      models: {
        'gpt-5': { name: 'GPT-5', family: 'gpt', limit: { context: 400000, output: 128000 } },
      },
    },
  };
}

function upstreamJson() {
  return `${JSON.stringify(upstreamDocument(), null, 2)}\n`;
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const buffer = Buffer.from(body, 'utf8');
  const headerMap = new Map(Object.entries(headers));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (headerMap.has(name) ? headerMap.get(name) : null) },
    body: (async function* streamBody() {
      yield buffer;
    })(),
  };
}

function commitResponse(sha) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ sha }),
  };
}

function createUpstreamFetch({ body = upstreamJson(), status = 200, headers = {}, commitSha = 'verified-commit-sha', requests = null } = {}) {
  return async function upstreamFetch(url, options = {}) {
    if (requests) requests.push({ url, options });
    if (url === MODELS_DEV_API_URL) {
      return jsonResponse(body, { status, headers });
    }
    if (url === MODELS_DEV_COMMIT_URL) {
      if (commitSha instanceof Error) throw commitSha;
      return commitResponse(commitSha);
    }
    throw new Error(`unexpected url ${url}`);
  };
}

test('models.dev online refresh writes an online-cache document with verified provenance', async () => {
  const agentDir = withTempDir('caff-models-dev-refresh-');
  const requests = [];
  const fetchImpl = createUpstreamFetch({
    headers: { etag: '"etag-1"' },
    requests,
  });

  const result = await refreshModelsDevCatalog({
    agentDir,
    fetchImpl,
    now: () => new Date('2026-09-15T00:00:00.000Z'),
  });

  assert.equal(result.status, 'refreshed');
  assert.equal(result.providerCount, 1);
  assert.equal(result.provenance.kind, 'online');
  assert.equal(result.provenance.sourceUrl, 'https://models.dev/api.json');
  assert.equal(result.provenance.payloadSha256, createHash('sha256').update(Buffer.from(upstreamJson(), 'utf8')).digest('hex'));
  assert.equal(result.provenance.fetchedAt, '2026-09-15T00:00:00.000Z');
  assert.equal(result.provenance.etag, '"etag-1"');
  assert.equal(result.provenance.commitSha, 'verified-commit-sha');

  const cachePath = path.join(agentDir, 'models-dev-catalog.json');
  assert.equal(result.cachePath, cachePath);
  const written = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(written.schemaVersion, 1);
  assert.equal(written.provenance.kind, 'online');
  assert.deepEqual(written.providers, upstreamDocument());
  assert.equal(fs.existsSync(path.join(agentDir, 'models.json')), false, 'refresh never writes models.json');

  assert.equal(requests.length, 2, 'catalog fetch plus independent commit verification');
  assert.equal(requests[0].url, MODELS_DEV_API_URL);
  assert.equal(requests[0].options.headers.accept, 'application/json');
  assert.equal('if-none-match' in requests[0].options.headers, false, 'no prior etag means no conditional header');
});

test('models.dev online refresh reuses the last-known-good etag and keeps the cache on 304', async () => {
  const agentDir = withTempDir('caff-models-dev-refresh-');
  await refreshModelsDevCatalog({
    agentDir,
    fetchImpl: createUpstreamFetch({ headers: { etag: '"etag-1"' } }),
    now: () => new Date('2026-09-15T00:00:00.000Z'),
  });
  const cachePath = path.join(agentDir, 'models-dev-catalog.json');
  const firstWrite = fs.readFileSync(cachePath, 'utf8');

  const requests = [];
  const fetchImpl = async function conditionalFetch(url, options = {}) {
    requests.push({ url, options });
    if (url === MODELS_DEV_API_URL) {
      return jsonResponse('', { status: 304, headers: {} });
    }
    return commitResponse('should-not-be-called');
  };

  const result = await refreshModelsDevCatalog({ agentDir, fetchImpl });

  assert.equal(result.status, 'not_modified');
  assert.equal(result.providerCount, 1);
  assert.equal(result.provenance.etag, '"etag-1"');
  assert.equal(fs.readFileSync(cachePath, 'utf8'), firstWrite, '304 keeps the last-known-good cache byte-identical');
  assert.equal(requests.length, 1, '304 short-circuits before commit verification');
  assert.equal(requests[0].options.headers['if-none-match'], '"etag-1"');
});

test('models.dev online refresh keeps the last-known-good cache when the payload is invalid', async () => {
  for (const scenario of [
    { name: 'not JSON', body: '<html>not json</html>' },
    { name: 'schema invalid', body: JSON.stringify({ openai: { name: 'OpenAI', models: 'nope' } }) },
    { name: 'empty providers', body: JSON.stringify({}) },
  ]) {
    const agentDir = withTempDir('caff-models-dev-refresh-');
    await refreshModelsDevCatalog({
      agentDir,
      fetchImpl: createUpstreamFetch({ headers: { etag: '"etag-1"' } }),
    });
    const cachePath = path.join(agentDir, 'models-dev-catalog.json');
    const firstWrite = fs.readFileSync(cachePath, 'utf8');

    await assert.rejects(
      refreshModelsDevCatalog({ agentDir, fetchImpl: createUpstreamFetch({ body: scenario.body }) }),
      (error) => error instanceof ModelCatalogError && error.code === 'catalog_refresh_payload_invalid'
    );
    assert.equal(fs.readFileSync(cachePath, 'utf8'), firstWrite, `${scenario.name}: last-known-good cache survives`);
  }
});

test('models.dev online refresh enforces payload size and count limits', async () => {
  const agentDir = withTempDir('caff-models-dev-refresh-');
  await assert.rejects(
    refreshModelsDevCatalog({
      agentDir,
      fetchImpl: createUpstreamFetch(),
      limits: { requestTimeoutMs: 1000, commitTimeoutMs: 1000, maxPayloadBytes: 16, maxProviders: 2, maxModelsPerProvider: 1 },
      verifyCommitSha: false,
    }),
    (error) => error instanceof ModelCatalogError && error.code === 'catalog_refresh_payload_too_large'
  );

  const manyModels = { openai: { name: 'OpenAI', env: [], models: { 'gpt-5': {}, 'gpt-4': {} } } };
  await assert.rejects(
    refreshModelsDevCatalog({
      agentDir,
      fetchImpl: createUpstreamFetch({ body: JSON.stringify(manyModels) }),
      limits: { requestTimeoutMs: 1000, commitTimeoutMs: 1000, maxPayloadBytes: 1024 * 1024, maxProviders: 2, maxModelsPerProvider: 1 },
      verifyCommitSha: false,
    }),
    (error) => error instanceof ModelCatalogError && error.code === 'catalog_refresh_model_count_exceeded'
  );

  const manyProviders = {};
  for (let index = 0; index < 3; index += 1) {
    manyProviders[`p-${index}`] = { name: `P${index}`, env: [], models: { 'm-1': {} } };
  }
  await assert.rejects(
    refreshModelsDevCatalog({
      agentDir,
      fetchImpl: createUpstreamFetch({ body: JSON.stringify(manyProviders) }),
      limits: { requestTimeoutMs: 1000, commitTimeoutMs: 1000, maxPayloadBytes: 1024 * 1024, maxProviders: 2, maxModelsPerProvider: 1 },
      verifyCommitSha: false,
    }),
    (error) => error instanceof ModelCatalogError && error.code === 'catalog_refresh_provider_count_exceeded'
  );

  assert.equal(fs.existsSync(path.join(agentDir, 'models-dev-catalog.json')), false, 'no cache is written on limit failures');
});

test('models.dev online refresh maps network failures to typed errors without touching the cache', async () => {
  const agentDir = withTempDir('caff-models-dev-refresh-');

  const timeoutError = new Error('The operation was aborted due to timeout');
  timeoutError.name = 'AbortError';
  await assert.rejects(
    refreshModelsDevCatalog({ agentDir, fetchImpl: async () => { throw timeoutError; } }),
    (error) => error instanceof ModelCatalogError && error.code === 'catalog_refresh_timeout'
  );

  await assert.rejects(
    refreshModelsDevCatalog({ agentDir, fetchImpl: createUpstreamFetch({ status: 503 }) }),
    (error) => error instanceof ModelCatalogError && error.code === 'catalog_refresh_source_failed'
  );

  assert.equal(fs.existsSync(path.join(agentDir, 'models-dev-catalog.json')), false);
});

test('models.dev online refresh records commitSha only when independently verified', async () => {
  const verified = withTempDir('caff-models-dev-refresh-');
  const githubDown = createUpstreamFetch({ commitSha: new Error('github unavailable') });
  const result = await refreshModelsDevCatalog({ agentDir: verified, fetchImpl: githubDown });
  assert.equal(result.status, 'refreshed');
  assert.equal('commitSha' in result.provenance, false, 'unverifiable commit is omitted, not fabricated');

  const disabled = withTempDir('caff-models-dev-refresh-');
  const disabledResult = await refreshModelsDevCatalog({
    agentDir: disabled,
    fetchImpl: createUpstreamFetch({ commitSha: 'should-not-be-called' }),
    verifyCommitSha: false,
  });
  assert.equal('commitSha' in disabledResult.provenance, false, 'verification can be skipped explicitly');
});

test('models.dev online refresh defaults stay inside the reviewed envelope', () => {
  assert.equal(DEFAULT_MODELS_DEV_REFRESH_LIMITS.requestTimeoutMs, 15000);
  assert.equal(DEFAULT_MODELS_DEV_REFRESH_LIMITS.maxPayloadBytes, 32 * 1024 * 1024);
  assert.equal(DEFAULT_MODELS_DEV_REFRESH_LIMITS.maxProviders, 2000);
  assert.equal(MODELS_DEV_API_URL, 'https://models.dev/api.json');
  assert.equal(MODELS_DEV_COMMIT_URL, 'https://api.github.com/repos/anomalyco/models.dev/commits/dev');
});
