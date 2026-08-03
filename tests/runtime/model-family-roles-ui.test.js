const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..', '..');

function loadManagementUtils() {
  const sourcePath = path.join(projectRoot, 'public/personas/management-utils.js');
  const context = { structuredClone, window: { CaffPersonas: {} } };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  return context.window.CaffPersonas.managementUtils;
}

test('production management page loads focused modules before the entry and preserves the compatibility route', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'public/personas.html'), 'utf8');
  const scripts = Array.from(html.matchAll(/<script defer src="([^"]+)"/gu), (match) => match[1]);
  assert.deepEqual(scripts.slice(-6), [
    '/personas/management-utils.js',
    '/personas/role-editor.js',
    '/personas/role-management.js',
    '/personas/provider-editor.js',
    '/personas/provider-management.js',
    '/personas.js',
  ]);
  assert.match(html, /id="role-management-view"/u);
  assert.match(html, /id="provider-management-view"/u);
  assert.match(html, /模型供应商/u);
  assert.equal(html.includes('人格管理中心'), false);
});

test('role UI payload keeps family fields credential-free and preserves complete custom capabilities', () => {
  const utils = loadManagementUtils();
  const family = utils.buildRolePayload({
    id: 'role-family-gpt', roleKind: 'model_family', provider: 'openai', model: 'gpt-5.4', thinking: 'high',
    personaPrompt: 'must not leak', skillIds: ['must-not-submit'], isDefaultChatRole: true,
    modelProfiles: [{ id: 'deep', name: 'Deep', provider: 'openai', model: 'gpt-5.4', thinking: 'high', personaPrompt: 'must not leak' }],
  }, [{ key: 'openai\u001fgpt-5.4', provider: 'openai', model: 'gpt-5.4', family: 'gpt' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(family)), {
    provider: 'openai', model: 'gpt-5.4', thinking: 'high',
    modelProfiles: [{ id: 'deep', name: 'Deep', description: '', provider: 'openai', model: 'gpt-5.4', thinking: 'high' }],
    isDefaultChatRole: true,
  });

  const custom = utils.buildRolePayload({
    id: 'custom-reviewer', roleKind: 'custom', name: 'Reviewer', description: 'Review', sandboxName: 'reviewer',
    avatarDataUrl: '', personaPrompt: 'Review carefully', provider: 'anthropic', model: 'claude-opus', thinking: 'high',
    accentColor: '#123456', skillIds: ['source-audit'], isDefaultChatRole: false,
    modelProfiles: [{ id: 'deep', name: 'Deep', provider: 'openai', model: 'gpt-5.4', thinking: 'high', personaPrompt: 'Profile persona' }],
  }, []);
  assert.equal(custom.personaPrompt, 'Review carefully');
  assert.deepEqual(Array.from(custom.skillIds), ['source-audit']);
  assert.equal(custom.modelProfiles[0].personaPrompt, 'Profile persona');
});

test('shared fetch client merges CSRF headers without changing the JSON contract', async () => {
  let captured = null;
  const sourcePath = path.join(projectRoot, 'public/shared/api-client.js');
  const context = {
    fetch: async (url, options) => {
      captured = { url, options };
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    },
    window: { CaffShared: {} },
  };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  const result = await context.window.CaffShared.fetchJson('/api/model-providers/openai', {
    method: 'PUT', body: { apiKey: '' }, headers: { 'X-CAFF-CSRF-Token': 'token' },
  });
  assert.equal(result.ok, true);
  assert.equal(captured.options.headers['X-CAFF-CSRF-Token'], 'token');
  assert.equal(captured.options.headers['Content-Type'], 'application/json');
  assert.equal(captured.options.body, '{"apiKey":""}');
});
