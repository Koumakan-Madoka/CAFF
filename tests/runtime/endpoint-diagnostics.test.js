const test = require('node:test');
const assert = require('node:assert/strict');

// Lazy load: the module does not exist before the fix lands, and the SDK
// fact-pinning test below must still run (and pass) in that red state.
let inspectDialectEndpoint = null;
try {
  ({ inspectDialectEndpoint } = require('../../build/server/domain/models/endpoint-diagnostics'));
} catch {}

function inspect(dialect, baseUrl) {
  assert.equal(typeof inspectDialectEndpoint, 'function', 'endpoint-diagnostics module must exist');
  return inspectDialectEndpoint(dialect, baseUrl);
}

test('anthropic-messages with a /v1 base URL is a mismatch with a deterministic suggestion', () => {
  const result = inspect('anthropic-messages', 'https://api.kimi.com/coding/v1');
  assert.ok(result);
  assert.equal(result.status, 'mismatch');
  assert.equal(result.code, 'anthropic_base_url_version_suffix');
  assert.equal(result.suggestion, 'https://api.kimi.com/coding');
  assert.equal(result.basis, 'vendored-anthropic-sdk-appends-v1-messages');
  assert.match(result.message, /\/v1\/messages/u);
});

test('anthropic-messages trailing-slash /v1/ variant normalizes to the same suggestion', () => {
  const result = inspect('anthropic-messages', 'https://api.kimi.com/coding/v1/');
  assert.ok(result);
  assert.equal(result.suggestion, 'https://api.kimi.com/coding');
});

test('anthropic-messages with a root /v1 base URL suggests the host root', () => {
  const result = inspect('anthropic-messages', 'https://gateway.example.com/v1');
  assert.ok(result);
  assert.equal(result.suggestion, 'https://gateway.example.com/');
});

test('anthropic-messages with an already-correct base URL stays silent', () => {
  assert.equal(inspect('anthropic-messages', 'https://api.kimi.com/coding'), null);
  assert.equal(inspect('anthropic-messages', 'https://api.anthropic.com'), null);
});

test('openai dialects keep legal /v1 base URLs untouched (custom gateways stay silent)', () => {
  assert.equal(inspect('openai-completions', 'https://api.kimi.com/coding/v1'), null);
  assert.equal(inspect('openai-responses', 'https://api.openai.com/v1'), null);
  assert.equal(inspect('openai-completions', 'https://gateway.example.com/custom/v1'), null);
});

test('unknown dialects and incomplete inputs never produce a suggestion', () => {
  assert.equal(inspect('mistral-conversations', 'https://example.com/v1'), null);
  assert.equal(inspect('', 'https://api.kimi.com/coding/v1'), null);
  assert.equal(inspect('anthropic-messages', ''), null);
  assert.equal(inspect('anthropic-messages', 'not a url'), null);
  assert.equal(inspect(undefined, undefined), null);
});

// Fact-pinning test: the vendored @anthropic-ai/sdk (the same package pi
// bundles) appends a literal /v1/messages to the configured baseURL. This is
// the verifiable basis for the mismatch rule above — it passes against the
// current dependency and fails if the SDK ever changes its path contract.
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
