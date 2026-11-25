const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const validatorUrl = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'lib', 'pi-model-config-validator.mjs')
).href;

test('PI runtime family stays pinned at 0.85.1 while the top-level pi-ai serves the subscription-login catalog', () => {
  const packageJson = require('../../package.json');

  assert.equal(packageJson.dependencies['@earendil-works/pi-coding-agent'], '0.85.1');
  assert.equal(packageJson.dependencies['@earendil-works/pi-ai'], '1.6.0');
  assert.equal(packageJson.dependencies.typebox, '1.3.7');
  assert.equal(Object.hasOwn(packageJson.dependencies, '@mariozechner/pi-ai'), false);

  const packageLock = require('../../package-lock.json');
  const TOP_LEVEL_PI_AI = 'node_modules/@earendil-works/pi-ai';
  const piAiEntries = Object.entries(packageLock.packages)
    .filter(([packagePath]) => packagePath.endsWith('node_modules/@earendil-works/pi-ai'));
  const topLevel = piAiEntries.find(([packagePath]) => packagePath === TOP_LEVEL_PI_AI);
  assert.ok(topLevel, 'top-level pi-ai must be installed');
  assert.equal(topLevel[1].version, '1.6.0');
  const nested = piAiEntries.filter(([packagePath]) => packagePath !== TOP_LEVEL_PI_AI);
  assert.ok(nested.length >= 1);
  assert.deepEqual([...new Set(nested.map(([, entry]) => entry.version))], ['0.85.1']);
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

test('direct PI AI compat completion preserves text and JSON-schema tool output with fake I/O', async (t) => {
  const { Type } = await import('typebox');
  const { complete, getModel } = await import('@earendil-works/pi-ai/compat');
  const model = getModel('openai', 'gpt-6.2-sol');
  const requests = [];
  let output;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    requests.push(JSON.parse(options.body));
    const events = [
      { type: 'response.created', response: { id: 'resp_test', status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: output },
      { type: 'response.output_item.done', output_index: 0, item: output },
      { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [output],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const context = { systemPrompt: 'Summarize.', messages: [{ role: 'user', content: 'Test only.', timestamp: 1 }] };
  const options = { apiKey: 'sk-test-only-not-a-real-key', maxTokens: 128, reasoningEffort: 'low', signal: AbortSignal.timeout(5000) };
  output = { type: 'message', id: 'msg_test', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'Test summary.', annotations: [] }] };
  const text = await complete(model, context, options);
  assert.equal(text.stopReason, 'stop', text.errorMessage);
  assert.equal(text.content.find((block) => block.type === 'text')?.text, 'Test summary.');

  output = { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'submit_summary',
    arguments: '{"summary":"Test summary."}', status: 'completed' };
  const structured = await complete(model, { ...context, tools: [{ name: 'submit_summary',
    description: 'Submit a summary.', parameters: Type.Object({ summary: Type.String() }) }] }, options);
  assert.equal(structured.stopReason, 'toolUse', structured.errorMessage);
  const call = structured.content.find((block) => block.type === 'toolCall');
  assert.equal(call?.name, 'submit_summary');
  assert.deepEqual(call.arguments, { summary: 'Test summary.' });
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.model, model.id);
    assert.equal(request.max_output_tokens, 128);
  }
});

test('Pi model config validation is pinned to the repo runtime package family and version', async () => {
  const validator = await import(validatorUrl);
  const source = validator.resolvePinnedPiModelConfigSource();

  assert.deepEqual(source.codingAgent, {
    name: '@earendil-works/pi-coding-agent',
    version: '0.85.1',
  });
  assert.deepEqual(source.piAi, {
    name: '@earendil-works/pi-ai',
    version: '0.85.1',
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
