const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ModelProviderConfigError,
  clearModelProviderSecret,
  detectApiKeyMode,
  patchModelProvider,
  projectModelProviderDocument,
  removeModelProvider,
  validateModelProviderDocument,
} = require('../../build/server/domain/models/model-provider-config');

function providerFixture() {
  return {
    providers: {
      deepseek: {
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        api: 'openai-completions',
        apiKey: '!resolve-deepseek --token inline-secret',
        authHeader: true,
        headers: {
          Authorization: 'Bearer provider-header-secret',
          'X-Internal-Token': 'another-secret',
        },
        compat: {
          supportsDeveloperRole: true,
        },
        models: [
          {
            id: 'deepseek-v3.2',
            name: 'DeepSeek V3.2',
            family: 'deepseek',
            reasoning: true,
            contextWindow: 262144,
            maxTokens: 32768,
            headers: {
              'X-Model-Key': 'model-secret',
            },
            cost: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
            },
          },
        ],
      },
    },
  };
}

test('detectApiKeyMode distinguishes literal, env, command, and none without exposing the value', () => {
  assert.equal(detectApiKeyMode(''), 'none');
  assert.equal(detectApiKeyMode('literal-secret'), 'literal');
  assert.equal(detectApiKeyMode('$DEEPSEEK_API_KEY'), 'env');
  assert.equal(detectApiKeyMode('${DEEPSEEK_API_KEY}'), 'env');
  assert.equal(detectApiKeyMode('${KEY_PREFIX}_${KEY_SUFFIX}'), 'env');
  assert.equal(detectApiKeyMode('Bearer $DEEPSEEK_API_KEY'), 'env');
  assert.equal(detectApiKeyMode('$$literal-dollar-prefix'), 'literal');
  assert.equal(detectApiKeyMode('$!literal-bang-prefix'), 'literal');
  assert.equal(detectApiKeyMode('!secret-tool --token embedded-value'), 'command');
});

test('provider projection is credential-blind for keys, references, commands, and custom headers', () => {
  const raw = providerFixture();
  const projected = projectModelProviderDocument(raw, {
    externalAuthProviderIds: new Set(['deepseek']),
  });

  assert.deepEqual(projected, {
    providers: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        api: 'openai-completions',
        authHeader: true,
        hasApiKey: true,
        hasExternalAuth: true,
        apiKeyMode: 'command',
        hasCustomHeaders: true,
        models: [
          {
            id: 'deepseek-v3.2',
            name: 'DeepSeek V3.2',
            api: '',
            baseUrl: '',
            family: 'deepseek',
            reasoning: true,
            input: ['text'],
            contextWindow: 262144,
            maxTokens: 32768,
            hasCustomHeaders: true,
          },
        ],
      },
    ],
  });

  const serialized = JSON.stringify(projected);
  for (const secret of [
    'inline-secret',
    'resolve-deepseek',
    'provider-header-secret',
    'another-secret',
    'model-secret',
    'DEEPSEEK_API_KEY',
  ]) {
    assert.equal(serialized.includes(secret), false, `projection leaked ${secret}`);
  }
});

test('provider projection treats an omitted model list as empty', () => {
  assert.deepEqual(projectModelProviderDocument({
    providers: {
      local: {
        name: 'Local',
      },
    },
  }), {
    providers: [
      {
        id: 'local',
        name: 'Local',
        baseUrl: '',
        api: '',
        authHeader: false,
        hasApiKey: false,
        hasExternalAuth: false,
        apiKeyMode: 'none',
        hasCustomHeaders: false,
        models: [],
      },
    ],
  });
});

test('provider patch preserves blank secrets and unknown compatibility fields', () => {
  const raw = providerFixture();
  const next = patchModelProvider(raw, 'deepseek', {
    name: 'DeepSeek Cloud',
    baseUrl: 'https://api.deepseek.com',
    api: 'openai-responses',
    authHeader: false,
    apiKeyMode: 'command',
    apiKey: '   ',
    models: [
      {
        id: 'deepseek-v3.2',
        name: 'DeepSeek V3.2 Updated',
        family: 'deepseek',
        reasoning: true,
      },
    ],
  });

  assert.equal(next.providers.deepseek.apiKey, raw.providers.deepseek.apiKey);
  assert.deepEqual(next.providers.deepseek.headers, raw.providers.deepseek.headers);
  assert.deepEqual(next.providers.deepseek.compat, raw.providers.deepseek.compat);
  assert.deepEqual(next.providers.deepseek.models[0].headers, raw.providers.deepseek.models[0].headers);
  assert.deepEqual(next.providers.deepseek.models[0].cost, raw.providers.deepseek.models[0].cost);
  assert.equal(next.providers.deepseek.name, 'DeepSeek Cloud');
  assert.equal(next.providers.deepseek.api, 'openai-responses');
  assert.equal(next.providers.deepseek.authHeader, false);
  assert.equal(next.providers.deepseek.models[0].name, 'DeepSeek V3.2 Updated');
});

test('model token limits project, patch, clear, and preserve unrelated compatibility fields', () => {
  const raw = providerFixture();
  const updated = patchModelProvider(raw, 'deepseek', {
    models: [{
      id: 'deepseek-v3.2',
      contextWindow: 131072,
      maxTokens: 16384,
    }],
  });

  assert.equal(updated.providers.deepseek.models[0].contextWindow, 131072);
  assert.equal(updated.providers.deepseek.models[0].maxTokens, 16384);
  assert.deepEqual(updated.providers.deepseek.models[0].cost, raw.providers.deepseek.models[0].cost);

  const cleared = patchModelProvider(updated, 'deepseek', {
    models: [{ id: 'deepseek-v3.2', contextWindow: null, maxTokens: null }],
  });
  assert.equal(Object.hasOwn(cleared.providers.deepseek.models[0], 'contextWindow'), false);
  assert.equal(Object.hasOwn(cleared.providers.deepseek.models[0], 'maxTokens'), false);
  assert.equal(projectModelProviderDocument(cleared).providers[0].models[0].contextWindow, null);
  assert.equal(projectModelProviderDocument(cleared).providers[0].models[0].maxTokens, null);
});

test('model token limits reject invalid integers and inconsistent effective values with stable paths', () => {
  for (const [field, value] of [
    ['contextWindow', 0],
    ['contextWindow', 1.5],
    ['maxTokens', -1],
    ['maxTokens', '16384'],
  ]) {
    assert.throws(
      () => validateModelProviderDocument({
        providers: { custom: { models: [{ id: 'model-a', [field]: value }] } },
      }),
      (error) =>
        error instanceof ModelProviderConfigError &&
        error.code === 'provider_model_limit_invalid' &&
        error.path === `providers.custom.models[0].${field}`
    );
  }

  for (const model of [
    { id: 'model-a', contextWindow: 8192 },
    { id: 'model-a', maxTokens: 131072 },
    { id: 'model-a', contextWindow: 32768, maxTokens: 65536 },
  ]) {
    assert.throws(
      () => validateModelProviderDocument({ providers: { custom: { models: [model] } } }),
      (error) =>
        error instanceof ModelProviderConfigError &&
        error.code === 'provider_model_limits_inconsistent' &&
        error.path === 'providers.custom.models[0].maxTokens'
    );
  }
});

test('provider patch requires a new secret when changing auth mode and normalizes explicit env/command values', () => {
  const raw = providerFixture();

  assert.throws(
    () => patchModelProvider(raw, 'deepseek', {
      apiKeyMode: 'env',
      apiKey: '',
      models: raw.providers.deepseek.models,
    }),
    (error) => error instanceof ModelProviderConfigError && error.code === 'provider_secret_value_required'
  );

  const envDocument = patchModelProvider({ providers: {} }, 'zhipu', {
    name: 'Zhipu',
    apiKeyMode: 'env',
    apiKey: 'ZHIPU_API_KEY',
    models: [{ id: 'glm-5', family: 'glm' }],
  });
  assert.equal(envDocument.providers.zhipu.apiKey, '$ZHIPU_API_KEY');

  const interpolatedEnvDocument = patchModelProvider(envDocument, 'zhipu', {
    apiKeyMode: 'env',
    apiKey: '${KEY_PREFIX}_${KEY_SUFFIX}',
    models: [{ id: 'glm-5', family: 'glm' }],
  });
  assert.equal(interpolatedEnvDocument.providers.zhipu.apiKey, '${KEY_PREFIX}_${KEY_SUFFIX}');

  const commandDocument = patchModelProvider(interpolatedEnvDocument, 'zhipu', {
    apiKeyMode: 'command',
    apiKey: 'resolve-zhipu-key',
    models: [{ id: 'glm-5', family: 'glm' }],
  });
  assert.equal(commandDocument.providers.zhipu.apiKey, '!resolve-zhipu-key');
});

test('secret clear and provider removal are explicit independent operations', () => {
  const raw = providerFixture();
  const cleared = clearModelProviderSecret(raw, 'deepseek');

  assert.equal(Object.hasOwn(cleared.providers.deepseek, 'apiKey'), false);
  assert.deepEqual(cleared.providers.deepseek.models, raw.providers.deepseek.models);
  assert.deepEqual(raw.providers.deepseek.apiKey, '!resolve-deepseek --token inline-secret');

  const removed = removeModelProvider(cleared, 'deepseek');
  assert.deepEqual(removed, { providers: {} });

  assert.throws(
    () => removeModelProvider(removed, 'deepseek'),
    (error) => error instanceof ModelProviderConfigError && error.code === 'provider_not_found'
  );
});

test('document validation rejects duplicate model ids and invalid explicit families with stable paths', () => {
  assert.throws(
    () => validateModelProviderDocument({
      providers: {
        openai: {
          models: [{ id: 'gpt-5.4' }, { id: 'gpt-5.4' }],
        },
      },
    }),
    (error) =>
      error instanceof ModelProviderConfigError &&
      error.code === 'provider_model_duplicate' &&
      error.path === 'providers.openai.models[1].id'
  );

  assert.throws(
    () => validateModelProviderDocument({
      providers: {
        moonshot: {
          models: [{ id: 'kimi-k2.5', family: 'moon' }],
        },
      },
    }),
    (error) =>
      error instanceof ModelProviderConfigError &&
      error.code === 'model_family_invalid' &&
      error.path === 'providers.moonshot.models[0].family'
  );
});

test('provider ids preserve Pi case semantics but reject reserved, routed, and control-bearing keys', () => {
  assert.doesNotThrow(() => validateModelProviderDocument({
    providers: {
      CustomProvider: { models: [{ id: 'model-a' }] },
      customprovider: { models: [{ id: 'model-b' }] },
    },
  }));

  for (const providerId of ['__proto__', 'constructor', 'prototype', 'bad/provider', 'bad\\provider', 'bad\u001fprovider']) {
    const providers = Object.create(null);
    providers[providerId] = { models: [] };
    const document = { providers };
    assert.throws(
      () => validateModelProviderDocument(document),
      (error) =>
        error instanceof ModelProviderConfigError &&
        error.code === 'provider_id_invalid' &&
        error.path === `providers.${providerId}`
    );
  }
});

test('provider and model protocols allow extension APIs but reject malformed strings', () => {
  assert.doesNotThrow(() => validateModelProviderDocument({
    providers: {
      extension: {
        api: 'custom-stream-v2',
        models: [{ id: 'extension-model', api: 'custom-model-api' }],
      },
    },
  }));

  for (const [document, expectedPath] of [
    [{ providers: { extension: { api: 'bad\u0000api', models: [] } } }, 'providers.extension.api'],
    [{ providers: { extension: { api: 42, models: [] } } }, 'providers.extension.api'],
    [{ providers: { extension: { models: [{ id: 'extension-model', api: '\t' }] } } }, 'providers.extension.models[0].api'],
  ]) {
    assert.throws(
      () => validateModelProviderDocument(document),
      (error) =>
        error instanceof ModelProviderConfigError &&
        error.code === 'provider_protocol_invalid' &&
        error.path === expectedPath
    );
  }
});

test('model input capability field validates only legal text/image arrays', () => {
  assert.doesNotThrow(() => validateModelProviderDocument({
    providers: {
      vision: {
        models: [
          { id: 'vision-model', input: ['text', 'image'] },
          { id: 'text-model', input: ['text'] },
        ],
      },
    },
  }));

  for (const [badInput, expectedPath] of [
    ['text', 'providers.vision.models[0].input'],
    [['text', 'video'], 'providers.vision.models[0].input'],
    [[42], 'providers.vision.models[0].input'],
  ]) {
    assert.throws(
      () => validateModelProviderDocument({
        providers: { vision: { models: [{ id: 'vision-model', input: badInput }] } },
      }),
      (error) =>
        error instanceof ModelProviderConfigError &&
        error.code === 'provider_model_input_invalid' &&
        error.path === expectedPath
    );
  }
});

test('model input capability field projects into the credential-blind view', () => {
  const projected = projectModelProviderDocument({
    providers: {
      vision: {
        models: [
          { id: 'vision-model', input: ['text', 'image'] },
          { id: 'text-model' },
        ],
      },
    },
  });

  assert.deepEqual(projected.providers[0].models, [
    { id: 'vision-model', name: '', api: '', baseUrl: '', family: '', reasoning: false, hasCustomHeaders: false, input: ['text', 'image'], contextWindow: null, maxTokens: null },
    { id: 'text-model', name: '', api: '', baseUrl: '', family: '', reasoning: false, hasCustomHeaders: false, input: ['text'], contextWindow: null, maxTokens: null },
  ]);
});

test('model input capability field is preserved and editable through patches', () => {
  const raw = providerFixture();
  raw.providers.deepseek.models[0].input = ['text', 'image'];

  const next = patchModelProvider(raw, 'deepseek', {
    models: [
      {
        id: 'deepseek-v3.2',
        name: 'DeepSeek V3.2 Updated',
        input: ['text'],
      },
    ],
  });
  assert.deepEqual(next.providers.deepseek.models[0].input, ['text']);
  assert.deepEqual(next.providers.deepseek.models[0].cost, raw.providers.deepseek.models[0].cost);

  const mergeResult = patchModelProvider(raw, 'deepseek', {
    models: [{ id: 'deepseek-v3.2', name: 'Name Only' }],
  });
  assert.deepEqual(mergeResult.providers.deepseek.models[0].input, ['text', 'image']);
});

test('model input capability field rejects illegal arrays on patch', () => {
  const raw = providerFixture();
  assert.throws(
    () => patchModelProvider(raw, 'deepseek', {
      models: [{ id: 'deepseek-v3.2', input: 'image' }],
    }),
    (error) =>
      error instanceof ModelProviderConfigError &&
      error.code === 'provider_model_input_invalid' &&
      error.path === 'providers.deepseek.models[0].input'
  );
});

test('provider patch removes blank optional Pi fields instead of persisting schema-invalid empty strings', () => {
  const next = patchModelProvider({
    providers: {
      custom: {
        name: 'Custom',
        baseUrl: 'https://custom.example/v1',
        api: 'custom-api',
        models: [{
          id: 'custom-model',
          name: 'Custom model',
          baseUrl: 'https://model.example/v1',
          api: 'custom-model-api',
        }],
      },
    },
  }, 'custom', {
    name: '',
    baseUrl: '',
    api: '',
    models: [{
      id: 'custom-model',
      name: '',
      baseUrl: '',
      api: '',
    }],
  });

  for (const field of ['name', 'baseUrl', 'api']) {
    assert.equal(Object.hasOwn(next.providers.custom, field), false);
    assert.equal(Object.hasOwn(next.providers.custom.models[0], field), false);
  }
});
