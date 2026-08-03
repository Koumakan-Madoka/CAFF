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

  const commandDocument = patchModelProvider(envDocument, 'zhipu', {
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
