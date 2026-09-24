const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const projectRoot = path.resolve(__dirname, '..', '..');

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function providerDraft(overrides = {}) {
  return {
    id: 'kimi-for-coding',
    name: 'Kimi For Coding',
    baseUrl: 'https://api.kimi.com/coding/v1',
    api: 'anthropic-messages',
    authHeader: false,
    apiKeyMode: 'none',
    hasApiKey: false,
    hasExternalAuth: false,
    models: [{ id: 'kimi-for-coding', name: 'kimi-for-coding', family: 'kimi', reasoning: false, input: ['text'] }],
    ...overrides,
  };
}

function setup() {
  const dom = new JSDOM('<div id="root"></div>');
  const context = {
    document: dom.window.document,
    Event: dom.window.Event,
    URL,
    structuredClone,
    window: { CaffPersonas: {}, CaffShared: {} },
  };
  for (const rel of ['public/shared/model-options.js', 'public/personas/management-utils.js', 'public/personas/provider-editor.js']) {
    const sourcePath = path.join(projectRoot, rel);
    vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  }
  const saves = [];
  const editor = context.window.CaffPersonas.createProviderEditor({
    root: dom.window.document.getElementById('root'),
    isEnabled: () => true,
    onSave: async (id, payload) => saves.push({ id, payload }),
    onValidate: async () => {},
    onClear: async () => {},
    onRemove: async () => {},
  });
  return {
    editor,
    saves,
    document: dom.window.document,
    input(id) {
      return dom.window.document.getElementById(id);
    },
    setSelect(id, value) {
      const element = dom.window.document.getElementById(id);
      element.value = value;
      element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    },
    type(id, value) {
      const element = dom.window.document.getElementById(id);
      element.value = value;
      element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    },
  };
}

test('provider editor warns on load when a saved anthropic provider carries a /v1 base URL', async () => {
  const session = setup();
  session.editor.show(providerDraft());
  await flush();

  const warning = session.document.getElementById('provider-endpoint-warning');
  assert.ok(warning, 'endpoint warning exists');
  assert.match(warning.textContent, /\/v1\/messages/u);
  const apply = session.document.getElementById('provider-apply-endpoint-suggestion');
  assert.ok(apply, 'explicit apply button exists');
  // Nothing changes until the user clicks.
  assert.equal(session.input('provider-base-url').value, 'https://api.kimi.com/coding/v1');
});

test('explicit apply updates the URL and the saved payload carries the suggestion', async () => {
  const session = setup();
  session.editor.show(providerDraft());
  await flush();

  session.document.getElementById('provider-apply-endpoint-suggestion').click();
  await flush();

  assert.equal(session.input('provider-base-url').value, 'https://api.kimi.com/coding');
  assert.equal(session.document.getElementById('provider-endpoint-warning'), null, 'warning clears after applying');

  session.document.getElementById('save-provider').click();
  await flush();
  assert.equal(session.saves.length, 1);
  assert.equal(session.saves[0].payload.baseUrl, 'https://api.kimi.com/coding');
  assert.equal(session.saves[0].payload.api, 'anthropic-messages');
});

test('switching protocols refreshes the diagnostic and never applies a stale suggestion', async () => {
  const session = setup();
  session.editor.show(providerDraft({ api: 'openai-completions' }));
  await flush();
  assert.equal(session.document.getElementById('provider-endpoint-warning'), null, 'openai-completions + /v1 is legal, no warning');

  // Switch to anthropic-messages: mismatch appears with a fresh suggestion.
  session.setSelect('provider-api-protocol', 'anthropic-messages');
  await flush();
  assert.ok(session.document.getElementById('provider-endpoint-warning'), 'warning appears after switching to anthropic-messages');
  assert.ok(session.document.getElementById('provider-apply-endpoint-suggestion'));

  // Switch back before applying: the stale suggestion must disappear entirely.
  session.setSelect('provider-api-protocol', 'openai-completions');
  await flush();
  assert.equal(session.document.getElementById('provider-endpoint-warning'), null, 'stale suggestion is gone');
  assert.equal(session.document.getElementById('provider-apply-endpoint-suggestion'), null);
  assert.equal(session.input('provider-base-url').value, 'https://api.kimi.com/coding/v1', 'user URL untouched');

  // Save keeps the user's original values.
  session.document.getElementById('save-provider').click();
  await flush();
  assert.equal(session.saves[0].payload.baseUrl, 'https://api.kimi.com/coding/v1');
  assert.equal(session.saves[0].payload.api, 'openai-completions');
});

test('manually fixing the URL clears the warning without applying the suggestion', async () => {
  const session = setup();
  session.editor.show(providerDraft());
  await flush();
  assert.ok(session.document.getElementById('provider-endpoint-warning'));

  session.type('provider-base-url', 'https://api.kimi.com/coding');
  await flush();
  assert.equal(session.document.getElementById('provider-endpoint-warning'), null, 'warning clears on manual fix');
  assert.equal(session.input('provider-base-url').value, 'https://api.kimi.com/coding');
});

test('custom gateways and unknown protocols never get a suggestion', async () => {
  const session = setup();
  session.editor.show(providerDraft({
    api: 'openai-completions',
    baseUrl: 'https://gateway.internal.example.com/custom/v1',
  }));
  await flush();
  assert.equal(session.document.getElementById('provider-endpoint-warning'), null);

  session.setSelect('provider-api-protocol', 'mistral-conversations');
  await flush();
  assert.equal(session.document.getElementById('provider-endpoint-warning'), null);
  assert.equal(session.input('provider-base-url').value, 'https://gateway.internal.example.com/custom/v1');
});
