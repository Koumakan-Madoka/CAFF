const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const { createModelCatalogController } = require('../../build/server/api/model-catalog-controller');
const { withTempDir } = require('../helpers/temp-dir');

function catalogDocument() {
  return {
    provenance: {
      kind: 'vendored',
      sourceUrl: 'https://models.dev/api.json',
      commitSha: 'verified-sha',
      payloadSha256: 'verified-hash',
      fetchedAt: '2026-08-06T00:00:00.000Z',
    },
    providers: {
      openai: {
        name: 'OpenAI',
        env: ['OPENAI_API_KEY', 'OPENAI_ORG_ID'],
        api: 'https://api.openai.com/v1',
        npm: '@ai-sdk/openai',
        models: {
          'gpt-5/pro': {
            name: 'GPT-5 Pro',
            family: 'gpt',
            modalities: { input: ['text'], output: ['text'] },
            reasoning_options: ['minimal', 'high'],
            cost: { input: 1, output: 2 },
            limit: { context: 200000, output: 8192 },
          },
        },
      },
    },
  };
}

function createHarness(t) {
  const agentDir = withTempDir('caff-model-catalog-http-');
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(agentDir, 'models.json'), `${JSON.stringify({
    providers: {
      openai: {
        apiKey: '$OPENAI_API_KEY',
        models: [],
      },
    },
  }, null, 2)}\n`, 'utf8');

  const controller = createModelCatalogController({
    agentDir,
    host: '127.0.0.1',
    port: 4313,
    csrfToken: 'catalog-csrf-token',
    catalogDocument: catalogDocument(),
  });
  return { agentDir, controller };
}

async function invoke(controller, options = {}) {
  const method = options.method || 'GET';
  const pathname = options.pathname || '/api/model-catalog';
  const host = options.hostHeader || '127.0.0.1:4313';
  const req = new PassThrough();
  req.method = method;
  req.headers = {
    host,
    ...(options.headers || {}),
  };
  req.socket = { remoteAddress: options.remoteAddress || '127.0.0.1' };
  const state = { body: '', headers: {}, statusCode: 0 };
  const res = {
    writeHead(statusCode, headers) {
      state.statusCode = statusCode;
      state.headers = headers || {};
    },
    end(chunk = '') {
      state.body = String(chunk || '');
    },
  };

  const requestUrl = new URL(`http://${host}${pathname}`);
  const handledPromise = controller({
    req,
    res,
    pathname: requestUrl.pathname,
    requestUrl,
  });
  if (options.body === undefined) {
    req.end();
  } else {
    req.end(JSON.stringify(options.body));
  }

  const handled = await handledPromise;
  return {
    handled,
    statusCode: state.statusCode,
    headers: state.headers,
    json: state.body ? JSON.parse(state.body) : {},
  };
}

function mutationHeaders() {
  return {
    'content-type': 'application/json; charset=utf-8',
    origin: 'http://127.0.0.1:4313',
    'x-caff-csrf-token': 'catalog-csrf-token',
  };
}

test('catalog GET exposes an index and a safe single-model projection', async (t) => {
  const { controller } = createHarness(t);

  const index = await invoke(controller);
  assert.equal(index.handled, true);
  assert.equal(index.statusCode, 200);
  assert.equal(index.json.providers[0].id, 'openai');
  assert.equal(index.json.providers[0].models[0].id, 'gpt-5/pro');

  const projection = await invoke(controller, {
    pathname: '/api/model-catalog?providerId=openai&modelId=gpt-5%2Fpro',
  });
  assert.equal(projection.statusCode, 200);
  assert.equal(projection.json.projection.dialect, 'openai-responses');
  assert.deepEqual(projection.json.projection.env, [
    { name: 'OPENAI_API_KEY', kind: 'key', required: true },
    { name: 'OPENAI_ORG_ID', kind: 'parameter', required: false },
  ]);
  assert.equal(JSON.stringify(projection.json).includes('OPENAI_API_KEY'), true);
});

test('catalog import writes only reviewed provider fields and preserves existing secret references', async (t) => {
  const { agentDir, controller } = createHarness(t);
  const response = await invoke(controller, {
    method: 'POST',
    pathname: '/api/model-catalog/import',
    headers: mutationHeaders(),
    body: {
      providerId: 'openai',
      modelId: 'gpt-5/pro',
      name: 'GPT-5 Pro imported',
      reasoning: true,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json.providers[0].models[0].id, 'gpt-5/pro');
  assert.equal(response.json.providers[0].models[0].family, 'gpt');
  const persisted = JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8'));
  assert.equal(persisted.providers.openai.apiKey, '$OPENAI_API_KEY');
  assert.equal(persisted.providers.openai.api, 'openai-responses');
  assert.equal(persisted.providers.openai.baseUrl, 'https://api.openai.com/v1');
  assert.equal(persisted.providers.openai.models[0].reasoning, true);
});

test('catalog import rejects unknown provider or model without touching models.json', async (t) => {
  const { agentDir, controller } = createHarness(t);
  const before = fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8');

  await assert.rejects(
    () => invoke(controller, {
      method: 'POST',
      pathname: '/api/model-catalog/import',
      headers: mutationHeaders(),
      body: { providerId: 'openai', modelId: 'missing' },
    }),
    (error) => error && error.statusCode === 404
  );
  assert.equal(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8'), before);
});
