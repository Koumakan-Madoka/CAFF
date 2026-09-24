const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ModelCatalogError,
  classifyCatalogEnv,
  mapCatalogFamily,
  mergeCatalogProviderModel,
  projectCatalogModel,
  projectCatalogModelLimits,
  validateModelsDevDocument,
} = require('../../build/server/domain/models/models-dev-import');

function catalogFixture() {
  return {
    openai: {
      name: 'OpenAI',
      env: ['OPENAI_API_KEY', 'OPENAI_ORG_ID'],
      api: 'https://api.openai.com/v1',
      npm: '@ai-sdk/openai-compatible',
      models: {
        'gpt-5': {
          name: 'GPT-5',
          family: 'chatgpt',
          provider: {
            npm: '@ai-sdk/openai',
            api: 'openai-responses',
          },
          modalities: { input: ['text'], output: ['text'] },
          reasoning_options: ['minimal', 'high'],
          cost: { input: 1, output: 2 },
          limit: { context: 200000, output: 8192 },
        },
      },
    },
  };
}

test('catalog validation rejects malformed provider maps and missing model records', () => {
  assert.doesNotThrow(() => validateModelsDevDocument({
    '302ai': { env: ['302AI_API_KEY'], models: { model: {} } },
  }));

  assert.throws(
    () => validateModelsDevDocument({ openai: { env: ['OPEN AI_API_KEY'], models: { model: {} } } }),
    (error) => error instanceof ModelCatalogError && error.code === 'catalog_env_invalid'
  );

  assert.throws(
    () => validateModelsDevDocument({ openai: { env: [], models: [] } }),
    (error) => error instanceof ModelCatalogError && error.code === 'catalog_models_invalid'
  );

  assert.throws(
    () => validateModelsDevDocument({ openai: { env: ['OPENAI_API_KEY'], models: { 'gpt-5': null } } }),
    (error) => error instanceof ModelCatalogError && error.code === 'catalog_model_invalid'
  );
});

test('model-level provider overrides win while provider defaults remain available', () => {
  const result = mergeCatalogProviderModel(catalogFixture().openai, 'gpt-5', 'openai');

  assert.equal(result.providerId, 'openai');
  assert.equal(result.provider.npm, '@ai-sdk/openai');
  assert.equal(result.provider.api, 'openai-responses');
  assert.equal(result.provider.baseUrl, 'https://api.openai.com/v1');
  assert.deepEqual(result.model.modalities, { input: ['text'], output: ['text'] });
});

test('catalog env projection uses provider-specific key allowlists and never reads values', () => {
  assert.deepEqual(classifyCatalogEnv('openai', 'OPENAI_API_KEY'), {
    name: 'OPENAI_API_KEY',
    kind: 'key',
    required: true,
  });
  assert.deepEqual(classifyCatalogEnv('openai', 'OPENAI_ORG_ID'), {
    name: 'OPENAI_ORG_ID',
    kind: 'parameter',
    required: false,
  });

  const projected = projectCatalogModel(catalogFixture(), 'openai', 'gpt-5', {
    provenance: {
      kind: 'vendored',
      sourceUrl: 'https://models.dev/api.json',
      commitSha: 'verified-sha',
      payloadSha256: 'verified-hash',
      fetchedAt: '2026-08-06T00:00:00.000Z',
    },
  });

  assert.deepEqual(projected.env, [
    { name: 'OPENAI_API_KEY', kind: 'key', required: true },
    { name: 'OPENAI_ORG_ID', kind: 'parameter', required: false },
  ]);
  assert.equal(JSON.stringify(projected).includes('secret'), false);
  assert.equal(projected.providerName, 'OpenAI');
  assert.equal(projected.dialect, 'openai-responses');
  assert.equal(projected.manualConfigurationRequired, false);
  assert.equal(projected.contextWindow, 200000);
  assert.equal(projected.maxTokens, 8192);
});

test('projection drops arbitrary credential-bearing upstream fields', () => {
  const raw = catalogFixture();
  raw.openai.apiKey = 'provider-secret';
  raw.openai.headers = { Authorization: 'Bearer header-secret' };
  raw.openai.models['gpt-5'].headers = { Authorization: 'Bearer model-secret' };

  const projected = projectCatalogModel(raw, 'openai', 'gpt-5', {
    provenance: {
      kind: 'vendored',
      sourceUrl: 'https://models.dev/api.json',
      payloadSha256: 'hash',
      fetchedAt: '2026-08-06T00:00:00.000Z',
    },
  });

  const serialized = JSON.stringify(projected);
  for (const secret of ['provider-secret', 'header-secret', 'model-secret']) {
    assert.equal(serialized.includes(secret), false, `projection leaked ${secret}`);
  }
});

test('unknown dialects fail closed and explicit family mapping leaves unknown values unclassified', () => {
  const raw = catalogFixture();
  raw.openai.npm = '@unknown/provider';
  raw.openai.models['gpt-5'].provider = { npm: '@unknown/provider' };

  const projected = projectCatalogModel(raw, 'openai', 'gpt-5', {
    provenance: {
      kind: 'vendored',
      sourceUrl: 'https://models.dev/api.json',
      payloadSha256: 'hash',
      fetchedAt: '2026-08-06T00:00:00.000Z',
    },
  });

  assert.equal(projected.dialect, undefined);
  assert.equal(projected.manualConfigurationRequired, true);
  assert.equal(mapCatalogFamily('chatgpt'), 'gpt');
  assert.equal(mapCatalogFamily('experimental-family'), undefined);
  assert.equal(projected.family, 'gpt');
  assert.equal(projected.familyStatus, 'mapped');
});

test('catalog-only metadata is preserved as read-only metadata', () => {
  const projected = projectCatalogModel(catalogFixture(), 'openai', 'gpt-5', {
    provenance: {
      kind: 'vendored',
      sourceUrl: 'https://models.dev/api.json',
      payloadSha256: 'hash',
      fetchedAt: '2026-08-06T00:00:00.000Z',
    },
  });

  assert.deepEqual(projected.catalogMetadata, {
    modalities: { input: ['text'], output: ['text'] },
    reasoningOptions: ['minimal', 'high'],
    cost: { input: 1, output: 2 },
    limit: { context: 200000, output: 8192 },
  });
});

test('catalog limit projection accepts only valid Pi runtime limit pairs', () => {
  assert.deepEqual(projectCatalogModelLimits({ context: 262144, output: 32768 }), {
    contextWindow: 262144,
    maxTokens: 32768,
  });
  assert.deepEqual(projectCatalogModelLimits({ context: 262144 }), { contextWindow: 262144 });
  assert.deepEqual(projectCatalogModelLimits({ output: 8192 }), { maxTokens: 8192 });
  assert.deepEqual(projectCatalogModelLimits({ context: 8192 }), {}, 'Pi default output would exceed this context');
  assert.deepEqual(projectCatalogModelLimits({ context: '262144', output: 8192 }), { maxTokens: 8192 });
  assert.deepEqual(projectCatalogModelLimits({ context: 128000, output: 128001 }), {});
  assert.deepEqual(projectCatalogModelLimits({ context: -1, output: 0 }), {});
  assert.deepEqual(projectCatalogModelLimits(null), {});
});

test('catalog import projects modalities.input into a CAFF input capability array', () => {
  const projected = projectCatalogModel(catalogFixture(), 'openai', 'gpt-5', {
    provenance: {
      kind: 'vendored',
      sourceUrl: 'https://models.dev/api.json',
      payloadSha256: 'hash',
      fetchedAt: '2026-08-06T00:00:00.000Z',
    },
  });

  assert.deepEqual(projected.input, ['text']);
});

test('catalog import projects vision models into an input capability that includes image', () => {
  const raw = catalogFixture();
  raw.openai.models['gpt-5'].modalities = { input: ['text', 'image'], output: ['text'] };

  const projected = projectCatalogModel(raw, 'openai', 'gpt-5', {
    provenance: {
      kind: 'vendored',
      sourceUrl: 'https://models.dev/api.json',
      payloadSha256: 'hash',
      fetchedAt: '2026-08-06T00:00:00.000Z',
    },
  });

  assert.deepEqual(projected.input, ['text', 'image']);
});

test('catalog import leaves input capability absent when catalog declares no modalities', () => {
  const raw = catalogFixture();
  delete raw.openai.models['gpt-5'].modalities;

  const projected = projectCatalogModel(raw, 'openai', 'gpt-5', {
    provenance: {
      kind: 'vendored',
      sourceUrl: 'https://models.dev/api.json',
      payloadSha256: 'hash',
      fetchedAt: '2026-08-06T00:00:00.000Z',
    },
  });

  assert.equal(projected.input, undefined);
});

// Pinned snapshot of the stale models.dev entry that triggered the bug report:
// npm=@ai-sdk/anthropic (→ anthropic-messages) but api= the OpenAI-compatible
// /coding/v1 URL. The projection must surface a diagnostic instead of letting
// the inconsistent pair silently through.
function staleKimiCodingCatalog() {
  return {
    'kimi-for-coding': {
      name: 'Kimi For Coding',
      env: ['KIMI_API_KEY'],
      npm: '@ai-sdk/anthropic',
      api: 'https://api.kimi.com/coding/v1',
      models: {
        'kimi-for-coding': {
          name: 'kimi-for-coding',
          modalities: { input: ['text'], output: ['text'] },
        },
      },
    },
  };
}

const TEST_PROVENANCE = {
  kind: 'vendored',
  sourceUrl: 'https://models.dev/api.json',
  payloadSha256: 'hash',
  fetchedAt: '2026-09-15T10:01:17.367Z',
};

test('projection flags the stale Kimi For Coding dialect/baseUrl mismatch with a suggestion', () => {
  const projected = projectCatalogModel(staleKimiCodingCatalog(), 'kimi-for-coding', 'kimi-for-coding', {
    provenance: TEST_PROVENANCE,
  });

  assert.equal(projected.dialect, 'anthropic-messages');
  assert.equal(projected.baseUrl, 'https://api.kimi.com/coding/v1');
  assert.ok(projected.endpointDiagnostic);
  assert.equal(projected.endpointDiagnostic.code, 'anthropic_base_url_version_suffix');
  assert.equal(projected.endpointDiagnostic.suggestion, 'https://api.kimi.com/coding');
  // The raw catalog values stay untouched — the diagnostic never rewrites them.
  assert.equal(projected.baseUrl, 'https://api.kimi.com/coding/v1');
});

test('consistent catalog entries produce no endpoint diagnostic', () => {
  const projected = projectCatalogModel(catalogFixture(), 'openai', 'gpt-5', {
    provenance: TEST_PROVENANCE,
  });
  assert.equal(projected.endpointDiagnostic, null);

  const fixed = staleKimiCodingCatalog();
  fixed['kimi-for-coding'].npm = '@ai-sdk/openai-compatible';
  const fixedProjection = projectCatalogModel(fixed, 'kimi-for-coding', 'kimi-for-coding', {
    provenance: TEST_PROVENANCE,
  });
  assert.equal(fixedProjection.dialect, 'openai-completions');
  assert.equal(fixedProjection.endpointDiagnostic, null);
});

test('model-level provider overrides feed the endpoint diagnostic', () => {
  const raw = staleKimiCodingCatalog();
  // Provider is consistent; the model-level override introduces the mismatch.
  raw['kimi-for-coding'].npm = '@ai-sdk/openai-compatible';
  raw['kimi-for-coding'].models['kimi-for-coding'].provider = {
    npm: '@ai-sdk/anthropic',
    baseUrl: 'https://api.kimi.com/coding/v1',
  };

  const projected = projectCatalogModel(raw, 'kimi-for-coding', 'kimi-for-coding', {
    provenance: TEST_PROVENANCE,
  });
  assert.equal(projected.dialect, 'anthropic-messages');
  assert.equal(projected.endpointDiagnostic?.code, 'anthropic_base_url_version_suffix');
  assert.equal(projected.endpointDiagnostic?.suggestion, 'https://api.kimi.com/coding');
});
