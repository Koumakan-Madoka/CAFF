const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const projectRoot = path.resolve(__dirname, '..', '..');
const KNOWN_API_PROTOCOLS = [
  'openai-completions',
  'mistral-conversations',
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
  'anthropic-messages',
  'bedrock-converse-stream',
  'google-generative-ai',
  'google-vertex',
  'pi-messages',
];

function setup({ provider }) {
  const dom = new JSDOM('<div id="root"></div>');
  const context = {
    document: dom.window.document,
    Event: dom.window.Event,
    structuredClone,
    window: { CaffPersonas: {}, CaffShared: {} },
  };
  for (const rel of ['public/shared/model-options.js', 'public/personas/management-utils.js', 'public/personas/provider-editor.js']) {
    const sourcePath = path.join(projectRoot, rel);
    vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  }
  let savedPayload = null;
  const editor = context.window.CaffPersonas.createProviderEditor({
    root: dom.window.document.getElementById('root'),
    isEnabled: () => true,
    onSave: async (id, payload) => { savedPayload = { id, payload }; },
    onValidate: async () => {},
    onClear: async () => {},
    onRemove: async () => {},
  });
  return {
    editor,
    document: dom.window.document,
    saved: () => savedPayload,
    checkbox(index) {
      const row = dom.window.document.querySelectorAll('[data-provider-model]')[index];
      return row.querySelector('[data-field="input-image"]');
    },
    click(id) {
      dom.window.document.getElementById(id).click();
    },
  };
}

test('provider editor renders the image input capability checkbox from model.input', () => {
  const provider = {
    id: 'vision',
    name: 'Vision',
    models: [
      { id: 'vision-model', name: 'Vision', input: ['text', 'image'] },
      { id: 'text-model', name: 'Text', input: ['text'] },
      { id: 'plain-model', name: 'Plain' },
    ],
  };
  const session = setup({ provider });
  session.editor.show(provider);

  assert.equal(session.checkbox(0).checked, true, 'vision model checkbox is checked');
  assert.equal(session.checkbox(1).checked, false, 'text-only model checkbox is unchecked');
  assert.equal(session.checkbox(2).checked, false, 'missing input defaults to unchecked');
});

test('provider editor toggling the image capability checkbox edits the input array membership', () => {
  const provider = { id: 'vision', name: 'Vision', models: [{ id: 'vision-model', name: 'Vision', input: ['text'] }] };
  const session = setup({ provider });
  session.editor.show(provider);

  const checkbox = session.checkbox(0);
  checkbox.checked = true;
  checkbox.dispatchEvent(new session.document.defaultView.Event('input', { bubbles: true }));

  session.click('save-provider');
  assert.deepEqual(session.saved().payload.models[0].input, ['text', 'image']);

  checkbox.checked = false;
  checkbox.dispatchEvent(new session.document.defaultView.Event('input', { bubbles: true }));
  session.click('save-provider');
  assert.deepEqual(session.saved().payload.models[0].input, ['text']);
});

test('provider editor keeps text capability present when image is toggled off', () => {
  const provider = { id: 'vision', name: 'Vision', models: [{ id: 'm', name: 'M', input: ['text', 'image'] }] };
  const session = setup({ provider });
  session.editor.show(provider);

  const checkbox = session.checkbox(0);
  checkbox.checked = false;
  checkbox.dispatchEvent(new session.document.defaultView.Event('input', { bubbles: true }));

  session.click('save-provider');
  assert.deepEqual(session.saved().payload.models[0].input, ['text']);
});

test('provider editor saves a newly entered API key as a literal secret by default', () => {
  const provider = {
    id: 'kimi-for-coding',
    name: 'Kimi for Coding',
    apiKeyMode: 'none',
    hasApiKey: false,
    models: [],
  };
  const session = setup({ provider });
  session.editor.show(provider);

  const apiKeyInput = session.document.getElementById('provider-api-key');
  apiKeyInput.value = 'sk-test-secret';
  apiKeyInput.dispatchEvent(new session.document.defaultView.Event('input', { bubbles: true }));

  assert.equal(session.document.getElementById('provider-auth-mode').value, 'literal');
  session.click('save-provider');

  assert.equal(session.saved().payload.apiKeyMode, 'literal');
  assert.equal(session.saved().payload.apiKey, 'sk-test-secret');
});

test('provider editor renders known API protocols as a select and saves the selected value', () => {
  const provider = {
    id: 'anthropic',
    name: 'Anthropic',
    api: 'anthropic-messages',
    models: [],
  };
  const session = setup({ provider });
  session.editor.show(provider);

  const protocolSelect = session.document.getElementById('provider-api-protocol');
  assert.equal(protocolSelect.tagName, 'SELECT');
  assert.deepEqual(
    Array.from(protocolSelect.options, (option) => option.value),
    KNOWN_API_PROTOCOLS,
  );
  assert.equal(protocolSelect.value, 'anthropic-messages');

  protocolSelect.value = 'google-generative-ai';
  session.click('save-provider');
  assert.equal(session.saved().payload.api, 'google-generative-ai');
});

test('provider editor preserves a historical custom API protocol as an extra selected option', () => {
  const provider = {
    id: 'extension',
    name: 'Extension',
    api: 'custom-stream-v2',
    models: [],
  };
  const session = setup({ provider });
  session.editor.show(provider);

  const protocolSelect = session.document.getElementById('provider-api-protocol');
  assert.equal(protocolSelect.tagName, 'SELECT');
  assert.equal(protocolSelect.value, 'custom-stream-v2');
  const customOption = Array.from(protocolSelect.options).find((option) => option.value === 'custom-stream-v2');
  assert.ok(customOption);
  assert.match(customOption.textContent, /自定义/);

  session.click('save-provider');
  assert.equal(session.saved().payload.api, 'custom-stream-v2');
});
