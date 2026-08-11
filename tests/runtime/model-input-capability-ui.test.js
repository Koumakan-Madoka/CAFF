const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const projectRoot = path.resolve(__dirname, '..', '..');

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
