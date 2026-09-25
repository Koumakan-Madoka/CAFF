const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Lazy load: the module may not match the new contract before the fix lands,
// and the SDK fact-pinning tests below must still run in that red state.
let inspectDialectEndpoint = null;
try {
  ({ inspectDialectEndpoint } = require('../../build/server/domain/models/endpoint-diagnostics'));
} catch {}

function inspect(dialect, baseUrl) {
  assert.equal(typeof inspectDialectEndpoint, 'function', 'endpoint-diagnostics module must exist');
  return inspectDialectEndpoint(dialect, baseUrl);
}

// ---------------------------------------------------------------------------
// Verified combination: Kimi For Coding (api.kimi.com), both directions.
// Basis A (anthropic): pi's vendored model registry pins kimi-coding as
//   anthropic-messages + https://api.kimi.com/coding (see registry pin test).
// Basis B (openai): models.dev kimi-code-plan-cn documents
//   @ai-sdk/openai-compatible + https://api.kimi.com/coding/v1, and the OpenAI
//   SDK appends /chat/completions to the configured baseURL (see fact test).
// ---------------------------------------------------------------------------

test('verified mismatch: anthropic-messages with the OpenAI-compatible Kimi Coding URL gets a suggestion', () => {
  const result = inspect('anthropic-messages', 'https://api.kimi.com/coding/v1');
  assert.ok(result);
  assert.equal(result.status, 'mismatch');
  assert.equal(result.code, 'verified_endpoint_protocol_mismatch');
  assert.equal(result.suggestion, 'https://api.kimi.com/coding');
  assert.match(result.basis, /kimi-coding/u);
  assert.match(result.message, /\/v1\/messages/u);
});

test('verified mismatch: trailing-slash variant normalizes to the same suggestion', () => {
  const result = inspect('anthropic-messages', 'https://api.kimi.com/coding/v1/');
  assert.ok(result);
  assert.equal(result.status, 'mismatch');
  assert.equal(result.suggestion, 'https://api.kimi.com/coding');
});

test('verified mismatch: openai-completions with the Anthropic Kimi Coding URL gets the reverse suggestion', () => {
  const result = inspect('openai-completions', 'https://api.kimi.com/coding');
  assert.ok(result);
  assert.equal(result.status, 'mismatch');
  assert.equal(result.code, 'verified_endpoint_protocol_mismatch');
  assert.equal(result.suggestion, 'https://api.kimi.com/coding/v1');
  assert.match(result.basis, /kimi-code-plan/u);
  assert.match(result.message, /\/chat\/completions/u);
});

test('verified consistent combinations stay silent', () => {
  assert.equal(inspect('anthropic-messages', 'https://api.kimi.com/coding'), null);
  assert.equal(inspect('openai-completions', 'https://api.kimi.com/coding/v1'), null);
  assert.equal(inspect('openai-completions', 'https://api.kimi.com/coding/v1/'), null);
});

// ---------------------------------------------------------------------------
// Unknown endpoints: never a suggestion, but never silent either. The
// anthropic + trailing /v1 pattern earns a path-specific verify hint; other
// anthropic/openai dialects earn a neutral hint with the pinned SDK path
// fact; everything else (google, unknown dialects) earns a generic hint
// without path claims. Silence is reserved for verified matches, so
// "no diagnostic" can never read as "checked and fine".
// ---------------------------------------------------------------------------

test('R1: anthropic-messages on a custom gateway with /v1 is an unverified hint without any suggestion', () => {
  const result = inspect('anthropic-messages', 'https://gateway.example.com/tenant/v1');
  assert.ok(result, 'a soft verify hint is allowed');
  assert.equal(result.status, 'unverified');
  assert.equal(result.code, 'anthropic_base_url_version_suffix');
  assert.equal(result.suggestion, undefined, 'unknown endpoints never receive a guessed address');
  assert.match(result.message, /\/tenant\/v1\/v1\/messages/u, 'hint states the factual request path');
  assert.match(result.message, /核对/u);
});

test('R1: anthropic-messages with a root /v1 on an unknown host never suggests the host root', () => {
  const result = inspect('anthropic-messages', 'https://gateway.example.com/v1');
  assert.ok(result);
  assert.equal(result.status, 'unverified');
  assert.equal(result.suggestion, undefined);
});

test('anthropic-messages on unknown hosts without a /v1 suffix gets the generic unverified hint', () => {
  const result = inspect('anthropic-messages', 'https://gateway.example.com/tenant');
  assert.ok(result, 'silence is reserved for verified matches');
  assert.equal(result.status, 'unverified');
  assert.equal(result.code, 'endpoint_not_verified');
  assert.equal(result.suggestion, undefined, 'never a guessed address');
  assert.match(result.message, /核对/u);
});

test('R1: non-standard forms of a verified host never earn a suggestion', () => {
  // The verified basis covers exactly the official endpoint form. A custom
  // port, scheme, query, fragment, or credential is a different endpoint the
  // evidence says nothing about: neutral hint only, never a replacement.
  const customForms = [
    'https://api.kimi.com:8443/coding/v1',
    'http://api.kimi.com/coding/v1',
    'https://api.kimi.com/coding/v1?tenant=fixture',
    'https://api.kimi.com/coding/v1#frag',
    'https://user:pass@api.kimi.com/coding/v1',
  ];
  for (const url of customForms) {
    const result = inspect('anthropic-messages', url);
    assert.ok(result, `hint expected for ${url}`);
    assert.equal(result.suggestion, undefined, `no suggestion for ${url}`);
    assert.notEqual(result.code, 'verified_endpoint_protocol_mismatch', `not a verified mismatch: ${url}`);
  }
  const openaiPort = inspect('openai-completions', 'https://api.kimi.com:8443/coding');
  assert.equal(openaiPort.code, 'endpoint_not_verified');
  assert.equal(openaiPort.suggestion, undefined, 'custom port never earns the reverse suggestion');
  const openaiQuery = inspect('openai-completions', 'https://api.kimi.com/coding?tenant=x');
  assert.equal(openaiQuery.suggestion, undefined);
});

test('unverified combinations across dialects get neutral hints; silence is reserved for verified matches', () => {
  // Google and unknown dialects get the generic hint without path claims —
  // CAFF does not guess client behavior it has not pinned.
  const google = inspect('google-generative-ai', 'https://generativelanguage.googleapis.com/v1beta');
  assert.ok(google, 'google dialect must not read as verified');
  assert.equal(google.status, 'unverified');
  assert.equal(google.code, 'endpoint_not_verified');
  assert.equal(google.suggestion, undefined);
  assert.doesNotMatch(google.message, /chat\/completions|\/responses|\/v1\/messages/u, 'no guessed path facts');
  assert.match(google.message, /核对/u);

  const mistral = inspect('mistral-conversations', 'https://api.mistral.example.com/v1');
  assert.ok(mistral, 'unknown dialects must not read as verified');
  assert.equal(mistral.status, 'unverified');
  assert.equal(mistral.suggestion, undefined);

  // Incomplete or unparseable inputs stay silent: nothing to diagnose.
  assert.equal(inspect('', 'https://api.kimi.com/coding/v1'), null);
  assert.equal(inspect('anthropic-messages', ''), null);
  assert.equal(inspect('anthropic-messages', 'not a url'), null);
  assert.equal(inspect(undefined, undefined), null);
});

test('unknown OpenAI endpoints get a neutral verify hint, never a suggestion', () => {
  const gateway = inspect('openai-completions', 'https://gateway.example.com/custom/v1');
  assert.ok(gateway, 'unknown openai endpoint must not be silent');
  assert.equal(gateway.status, 'unverified');
  assert.equal(gateway.code, 'endpoint_not_verified');
  assert.equal(gateway.suggestion, undefined, 'unknown endpoints never receive a guessed address');
  assert.match(gateway.message, /\/chat\/completions/u, 'hint states the factual request path');
  assert.match(gateway.message, /核对/u);

  const noVersion = inspect('openai-completions', 'https://gateway.example.com/custom');
  assert.equal(noVersion.status, 'unverified');
  assert.equal(noVersion.code, 'endpoint_not_verified');
  assert.equal(noVersion.suggestion, undefined);

  const responses = inspect('openai-responses', 'https://api.openai.com/v1');
  assert.equal(responses.status, 'unverified');
  assert.equal(responses.code, 'endpoint_not_verified');
  assert.equal(responses.suggestion, undefined);
  assert.match(responses.message, /\/responses/u, 'hint states the factual request path');

  // A verified host with an uncovered dialect is still an unverified combination.
  const kimiResponses = inspect('openai-responses', 'https://api.kimi.com/coding');
  assert.equal(kimiResponses.code, 'endpoint_not_verified');
  assert.equal(kimiResponses.suggestion, undefined, 'no verified basis for openai-responses');
});

// Incomplete/unparseable inputs stay silent (covered in the unified-semantics
// test above); every well-formed unverified combination earns a hint.

// ---------------------------------------------------------------------------
// Verifiable basis pins. These fail if the underlying facts ever change.
// ---------------------------------------------------------------------------

test('vendored anthropic SDK appends /v1/messages to the configured baseURL', async () => {
  const Anthropic = require('@anthropic-ai/sdk');

  async function recordPath(baseURL) {
    const seen = [];
    const client = new Anthropic({
      apiKey: 'test-key',
      baseURL,
      maxRetries: 0,
      fetch: async (url) => {
        seen.push(new URL(String(url)).pathname);
        return new Response(JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'kimi-for-coding',
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    await client.messages.create({
      model: 'kimi-for-coding',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
    return seen[0];
  }

  assert.equal(await recordPath('https://api.kimi.com/coding'), '/coding/v1/messages');
  assert.equal(await recordPath('https://api.kimi.com/coding/v1'), '/coding/v1/v1/messages');
});

test('vendored openai SDK appends /chat/completions to the configured baseURL', async () => {
  // pi-ai bundles the official openai client; resolve its nested copy.
  const OpenAI = require(path.resolve(__dirname, '..', '..', 'node_modules', '@earendil-works', 'pi-ai', 'node_modules', 'openai'));

  async function recordPath(baseURL) {
    const seen = [];
    const client = new OpenAI({
      apiKey: 'test-key',
      baseURL,
      maxRetries: 0,
      fetch: async (url) => {
        seen.push(new URL(String(url)).pathname);
        return new Response(JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: 'kimi-for-coding',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    await client.chat.completions.create({ model: 'kimi-for-coding', messages: [{ role: 'user', content: 'hi' }] });
    return seen[0];
  }

  assert.equal(await recordPath('https://api.kimi.com/coding/v1'), '/coding/v1/chat/completions');
  assert.equal(await recordPath('https://api.kimi.com/coding'), '/coding/chat/completions');
});

test('vendored openai SDK appends /responses for the responses API', async () => {
  const OpenAI = require(path.resolve(__dirname, '..', '..', 'node_modules', '@earendil-works', 'pi-ai', 'node_modules', 'openai'));

  const seen = [];
  const client = new OpenAI({
    apiKey: 'test-key',
    baseURL: 'https://example.com/v1',
    maxRetries: 0,
    fetch: async (url) => {
      seen.push(new URL(String(url)).pathname);
      return new Response(JSON.stringify({
        id: 'resp_test',
        object: 'response',
        status: 'completed',
        output: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await client.responses.create({ model: 'gpt-5', input: 'hi' });
  assert.equal(seen[0], '/v1/responses');
});

test('pi vendored registry pins kimi-coding as anthropic-messages + https://api.kimi.com/coding', () => {
  const registryPath = path.resolve(__dirname, '..', '..', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data', 'kimi-coding.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const dialects = Object.keys(registry);
  assert.deepEqual(dialects, ['anthropic-messages'], 'kimi-coding registry only ships the anthropic-messages dialect');
  for (const model of Object.values(registry['anthropic-messages'])) {
    assert.equal(model.api, 'anthropic-messages');
    assert.equal(model.baseUrl, 'https://api.kimi.com/coding');
  }
});

// ---------------------------------------------------------------------------
// Browser mirror symmetry: public/shared/endpoint-diagnostics.js must produce
// exactly the server module's verdicts.
// ---------------------------------------------------------------------------

test('browser mirror matches the server module across the decision matrix', () => {
  const mirrorPath = path.resolve(__dirname, '..', '..', 'public', 'shared', 'endpoint-diagnostics.js');
  assert.ok(fs.existsSync(mirrorPath), 'shared browser mirror must exist');
  const context = { window: {}, URL };
  vm.runInNewContext(fs.readFileSync(mirrorPath, 'utf8'), context, { filename: mirrorPath });
  const mirror = context.window.CaffShared && context.window.CaffShared.endpointDiagnostics;
  assert.ok(mirror && typeof mirror.inspectDialectEndpoint === 'function', 'mirror exposes inspectDialectEndpoint');

  const cases = [
    ['anthropic-messages', 'https://api.kimi.com/coding/v1'],
    ['anthropic-messages', 'https://api.kimi.com/coding/v1/'],
    ['anthropic-messages', 'https://api.kimi.com/coding'],
    ['openai-completions', 'https://api.kimi.com/coding'],
    ['openai-completions', 'https://api.kimi.com/coding/v1'],
    ['openai-completions', 'https://api.kimi.com/coding/v1/'],
    ['anthropic-messages', 'https://gateway.example.com/tenant/v1'],
    ['anthropic-messages', 'https://gateway.example.com/v1'],
    ['anthropic-messages', 'https://gateway.example.com/tenant'],
    ['anthropic-messages', 'https://api.kimi.com:8443/coding/v1'],
    ['anthropic-messages', 'http://api.kimi.com/coding/v1'],
    ['anthropic-messages', 'https://api.kimi.com/coding/v1?tenant=fixture'],
    ['openai-completions', 'https://gateway.example.com/custom/v1'],
    ['openai-completions', 'https://api.kimi.com:8443/coding'],
    ['openai-responses', 'https://api.openai.com/v1'],
    ['openai-responses', 'https://api.kimi.com/coding'],
    ['google-generative-ai', 'https://generativelanguage.googleapis.com/v1beta'],
    ['mistral-conversations', 'https://api.kimi.com/coding/v1'],
    ['mistral-conversations', 'https://api.mistral.example.com/v1'],
    ['anthropic-messages', 'not a url'],
    ['', 'https://api.kimi.com/coding/v1'],
    ['anthropic-messages', ''],
    [undefined, undefined],
  ];
  for (const [dialect, baseUrl] of cases) {
    // Compare across the JSON boundary: the vm realm's prototypes differ,
    // and the real transport is JSON anyway.
    assert.deepEqual(
      JSON.parse(JSON.stringify(mirror.inspectDialectEndpoint(dialect, baseUrl))),
      JSON.parse(JSON.stringify(inspect(dialect, baseUrl))),
      `mirror mismatch for ${dialect} ${baseUrl}`
    );
  }
});
