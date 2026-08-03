const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const {
  connectCdp,
  delay,
  edgeExecutable,
  evaluate,
  findPage,
  freePort,
  waitFor,
} = require('../helpers/edge-cdp');

const projectRoot = path.resolve(__dirname, '..', '..');
const publicDir = path.join(projectRoot, 'public');
const modelKey = (provider, model) => `${provider}\u001f${model}`;

function publicScriptAndHtmlFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return publicScriptAndHtmlFiles(target);
    return /\.(?:html|js)$/u.test(entry.name) ? [target] : [];
  });
}

for (const file of publicScriptAndHtmlFiles(publicDir)) {
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /人格/u, `${path.relative(projectRoot, file)} still exposes legacy 人格 terminology`);
}

function createRoleFixture() {
  const modelOptions = [
    {
      key: modelKey('openai', 'gpt-5.4'), provider: 'openai', model: 'gpt-5.4', label: 'OpenAI / GPT-5.4',
      source: 'models_json', family: 'gpt', familySource: 'explicit',
      supportedThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    },
    {
      key: modelKey('openai', 'gpt-5-mini'), provider: 'openai', model: 'gpt-5-mini', label: 'OpenAI / GPT-5 mini',
      source: 'models_json', family: 'gpt', familySource: 'explicit',
      supportedThinkingLevels: ['minimal', 'low', 'medium', 'high'],
    },
    {
      key: modelKey('anthropic', 'claude-opus-4.1'), provider: 'anthropic', model: 'claude-opus-4.1', label: 'Anthropic / Claude Opus 4.1',
      source: 'models_json', family: 'claude', familySource: 'explicit',
      supportedThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'],
    },
    {
      key: modelKey('moonshotai', 'kimi-k2.5'), provider: 'moonshotai', model: 'kimi-k2.5', label: 'Moonshot / Kimi K2.5',
      source: 'models_json', family: 'kimi', familySource: 'explicit',
      supportedThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'],
    },
  ];
  const agents = [
    {
      id: 'role-family-gpt', name: 'GPT', description: 'OpenAI GPT 模型族', sandboxName: 'gpt', avatarDataUrl: '',
      personaPrompt: '', provider: 'openai', model: 'gpt-5.4', thinking: 'xhigh', accentColor: '#3975c6',
      skillIds: [], modelProfiles: [{ id: 'quick', name: '快速处理', description: '日常任务', provider: 'openai', model: 'gpt-5-mini', thinking: 'low', personaPrompt: '' }],
      roleKind: 'model_family', modelFamily: 'gpt', isDefaultChatRole: true, systemManaged: true,
      availability: { status: 'available', familyModelCount: 2 },
      editableFields: ['provider', 'model', 'thinking', 'modelProfiles', 'isDefaultChatRole'],
    },
    {
      id: 'role-family-qwen', name: 'Qwen', description: 'Qwen 模型族', sandboxName: 'qwen', avatarDataUrl: '',
      personaPrompt: '', provider: '', model: '', thinking: '', accentColor: '#6d55bd', skillIds: [], modelProfiles: [],
      roleKind: 'model_family', modelFamily: 'qwen', isDefaultChatRole: false, systemManaged: true,
      availability: { status: 'no_family_models', familyModelCount: 0 },
      editableFields: ['provider', 'model', 'thinking', 'modelProfiles', 'isDefaultChatRole'],
    },
    {
      id: 'role-family-kimi', name: 'Kimi', description: 'Moonshot Kimi 模型族', sandboxName: 'kimi', avatarDataUrl: '',
      personaPrompt: '', provider: 'moonshotai', model: 'kimi-k2.5', thinking: 'high', accentColor: '#7d5f9e', skillIds: [], modelProfiles: [],
      roleKind: 'model_family', modelFamily: 'kimi', isDefaultChatRole: false, systemManaged: true,
      availability: { status: 'available', familyModelCount: 1 },
      editableFields: ['provider', 'model', 'thinking', 'modelProfiles', 'isDefaultChatRole'],
    },
    {
      id: 'custom-reviewer', name: '架构评审', description: '自定义角色', sandboxName: 'reviewer', avatarDataUrl: '',
      personaPrompt: '从系统边界与失败路径审查。', provider: 'anthropic', model: 'claude-opus-4.1', thinking: 'max', accentColor: '#277d75',
      skillIds: ['source-audit'], roleKind: 'custom', modelFamily: null, isDefaultChatRole: true, systemManaged: false,
      availability: { status: 'available', familyModelCount: 0 },
      editableFields: ['name', 'description', 'sandboxName', 'avatarDataUrl', 'personaPrompt', 'provider', 'model', 'thinking', 'accentColor', 'skillIds', 'modelProfiles', 'isDefaultChatRole'],
      modelProfiles: [{ id: 'deep', name: '深度评审', description: '高风险审查', provider: 'anthropic', model: 'claude-opus-4.1', thinking: 'max', personaPrompt: '优先找不可逆风险。' }],
    },
  ];
  return { agents, modelOptions, skills: [{ id: 'source-audit', name: 'source-audit', description: '核验信源' }, { id: 'quality-gate', name: 'quality-gate', description: '交付门禁' }] };
}

async function serveProductionUi() {
  const roleFixture = createRoleFixture();
  const requests = [];
  const bootstrap = {
    localAdmin: { modelProviders: { enabled: true, csrfToken: 'provider-test-token' } },
    runtime: {}, modes: [], conversations: [], selectedConversationId: null,
    ...roleFixture,
  };
  let providers = [
    {
      id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', api: 'openai-responses', authHeader: false,
      hasApiKey: true, hasExternalAuth: false, apiKeyMode: 'literal', hasCustomHeaders: false,
      models: [{ id: 'gpt-5.4', name: 'GPT-5.4', api: '', baseUrl: '', family: 'gpt', reasoning: true, hasCustomHeaders: false }],
    },
    {
      id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', authHeader: false,
      hasApiKey: false, hasExternalAuth: true, apiKeyMode: 'external', hasCustomHeaders: false,
      models: [{ id: 'claude-opus-4.1', name: 'Claude Opus 4.1', api: '', baseUrl: '', family: 'claude', reasoning: true, hasCustomHeaders: false }],
    },
  ];
  let holdNextProviderSave = false;
  let releaseProviderSave = null;

  function sendJson(response, status, payload) {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload));
  }

  async function readBody(request) {
    let body = '';
    for await (const chunk of request) body += chunk;
    return body ? JSON.parse(body) : {};
  }

  const mimeTypes = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');
    if (requestUrl.pathname === '/api/bootstrap') return sendJson(response, 200, bootstrap);
    if (requestUrl.pathname === '/api/agents' && request.method === 'GET') return sendJson(response, 200, roleFixture);
    if (requestUrl.pathname === '/api/model-providers' && request.method === 'GET') return sendJson(response, 200, { providers });

    const roleMatch = requestUrl.pathname.match(/^\/api\/agents\/([^/]+)$/u);
    if (roleMatch && request.method === 'PUT') {
      const body = await readBody(request);
      const id = decodeURIComponent(roleMatch[1]);
      requests.push({ url: requestUrl.pathname, method: request.method, headers: request.headers, body });
      const index = roleFixture.agents.findIndex((agent) => agent.id === id);
      roleFixture.agents[index] = { ...roleFixture.agents[index], ...body };
      return sendJson(response, 200, { agent: roleFixture.agents[index], ...roleFixture });
    }

    const providerMatch = requestUrl.pathname.match(/^\/api\/model-providers\/([^/]+)(?:\/(secret|validate))?$/u);
    if (providerMatch) {
      const id = decodeURIComponent(providerMatch[1]);
      const action = providerMatch[2] || '';
      const body = request.method === 'PUT' || request.method === 'POST' ? await readBody(request) : {};
      requests.push({ url: requestUrl.pathname, method: request.method, headers: request.headers, body });
      if (request.method === 'PUT' && !action) {
        if (holdNextProviderSave) {
          holdNextProviderSave = false;
          await new Promise((resolve) => { releaseProviderSave = resolve; });
          releaseProviderSave = null;
        }
        const existingIndex = providers.findIndex((provider) => provider.id === id);
        const previous = providers[existingIndex] || { id, hasApiKey: false, hasExternalAuth: false, hasCustomHeaders: false };
        const next = {
          ...previous, ...body, id,
          hasApiKey: body.apiKey ? true : previous.hasApiKey,
          apiKeyMode: body.apiKey ? body.apiKeyMode : previous.apiKeyMode,
          models: body.models || previous.models || [],
        };
        if (existingIndex === -1) providers.push(next);
        else providers[existingIndex] = next;
        return sendJson(response, 200, { providers, write: { backupCreated: true, durability: 'durable' } });
      }
      if (request.method === 'DELETE' && action === 'secret') {
        providers = providers.map((provider) => provider.id === id ? { ...provider, hasApiKey: false, apiKeyMode: provider.hasExternalAuth ? 'external' : 'none' } : provider);
        return sendJson(response, 200, { providers, write: { backupCreated: true, durability: 'durable' } });
      }
      if (request.method === 'DELETE' && !action) {
        providers = providers.filter((provider) => provider.id !== id);
        return sendJson(response, 200, { providers, write: { backupCreated: true, durability: 'durable' } });
      }
      if (request.method === 'POST' && action === 'validate') {
        return sendJson(response, 200, { validation: { status: 'ok', providerId: id, modelCount: providers.find((provider) => provider.id === id)?.models.length || 0 } });
      }
    }

    const relativePath = requestUrl.pathname === '/' ? 'personas.html' : requestUrl.pathname.replace(/^\//u, '');
    const filePath = path.resolve(publicDir, relativePath);
    if (!filePath.startsWith(`${publicDir}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      response.writeHead(404); response.end('Not found'); return;
    }
    response.writeHead(200, { 'content-type': mimeTypes[path.extname(filePath)] || 'application/octet-stream' });
    response.end(fs.readFileSync(filePath));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    bootstrap,
    port: server.address().port,
    requests,
    holdProviderSave() { holdNextProviderSave = true; },
    isProviderSaveBlocked() { return Boolean(releaseProviderSave); },
    releaseProviderSave() { if (releaseProviderSave) releaseProviderSave(); },
    close: async () => {
      if (releaseProviderSave) releaseProviderSave();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

(async () => {
  const fixture = await serveProductionUi();
  const debugPort = await freePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-role-provider-ui-'));
  const browser = spawn(edgeExecutable(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`,
    `http://127.0.0.1:${fixture.port}/personas.html`,
  ], { stdio: 'ignore' });

  try {
    const page = await findPage(debugPort);
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await waitFor(cdp, `Boolean(document.body && document.body.dataset.managementReady === 'true')`);

    const family = await evaluate(cdp, `(() => ({
      roleView: !document.getElementById('role-management-view').classList.contains('hidden'),
      providerView: document.getElementById('provider-management-view').classList.contains('hidden'),
      familyCount: document.querySelectorAll('#family-role-list [data-role-id]').length,
      customCount: document.querySelectorAll('#custom-role-list [data-role-id]').length,
      modelOptions: Array.from(document.getElementById('role-default-model').options).map((option) => option.value),
      thinkingOptions: Array.from(document.getElementById('role-default-thinking').options).map((option) => option.value),
      personaVisible: Boolean(document.getElementById('role-persona-prompt')),
      profilePersonaVisible: Boolean(document.querySelector('[data-runtime-profile] [data-profile-persona]')),
      defaultToggleLabel: document.getElementById('default-toggle').getAttribute('aria-label'),
      nextProfileId: window.CaffPersonas.managementUtils.nextProfileId([{ id: 'profile-1' }, { id: 'profile-3' }]),
    }))()`);
    assert.equal(family.roleView, true);
    assert.equal(family.providerView, true);
    assert.equal(family.familyCount, 3);
    assert.equal(family.customCount, 1);
    assert.deepEqual(family.modelOptions, [modelKey('openai', 'gpt-5.4'), modelKey('openai', 'gpt-5-mini')]);
    assert.deepEqual(family.thinkingOptions, ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    assert.equal(family.personaVisible, false);
    assert.equal(family.profilePersonaVisible, false);
    assert.equal(family.defaultToggleLabel, '新建普通聊天时默认预选 GPT');
    assert.equal(family.nextProfileId, 'profile-2');

    const profileFocus = await evaluate(cdp, `(() => {
      document.getElementById('add-runtime-profile').click();
      const names = document.querySelectorAll('[data-runtime-profile] [data-field="name"]');
      return { count: names.length, active: document.activeElement === names[names.length - 1] };
    })()`);
    assert.deepEqual(profileFocus, { count: 2, active: true });
    const removalFocus = await evaluate(cdp, `(() => {
      const buttons = document.querySelectorAll('[data-remove-runtime-profile]');
      buttons[buttons.length - 1].click();
      return { count: document.querySelectorAll('[data-runtime-profile]').length, activeId: document.activeElement.id };
    })()`);
    assert.deepEqual(removalFocus, { count: 1, activeId: 'add-runtime-profile' });

    await evaluate(cdp, `document.querySelector('[data-role-id="custom-reviewer"]').click()`);
    const custom = await evaluate(cdp, `(() => ({
      persona: document.getElementById('role-persona-prompt').value,
      skillValues: Array.from(document.querySelectorAll('input[name="role-skill"]')).map((input) => [input.value, input.checked]),
      profilePersona: document.querySelector('[data-runtime-profile] [data-profile-persona]').value,
      modelOptions: Array.from(document.getElementById('role-default-model').options).map((option) => option.value),
    }))()`);
    assert.match(custom.persona, /系统边界/u);
    assert.equal(custom.skillValues.find(([id]) => id === 'source-audit')[1], true);
    assert.match(custom.profilePersona, /不可逆/u);
    assert.equal(custom.modelOptions.includes(modelKey('openai', 'gpt-5.4')), true);
    assert.equal(custom.modelOptions.includes(modelKey('anthropic', 'claude-opus-4.1')), true);

    await evaluate(cdp, `document.getElementById('save-role').click()`);
    await waitFor(cdp, `document.getElementById('toast').textContent.includes('已保存')`);
    const customSave = fixture.requests.find((request) => request.url === '/api/agents/custom-reviewer');
    assert.ok(customSave);
    assert.equal(customSave.body.thinking, '');
    assert.equal(customSave.body.modelProfiles[0].thinking, '');

    await evaluate(cdp, `document.querySelector('[data-role-id="role-family-gpt"]').click()`);
    const thinkingReset = await evaluate(cdp, `(() => {
      const select = document.getElementById('role-default-model');
      select.value = ${JSON.stringify(modelKey('openai', 'gpt-5-mini'))};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        value: document.getElementById('role-default-thinking').value,
        notice: document.getElementById('toast').textContent,
      };
    })()`);
    assert.equal(thinkingReset.value, '');
    assert.match(thinkingReset.notice, /跟随运行时默认/u);

    await evaluate(cdp, `document.getElementById('save-role').click()`);
    await waitFor(cdp, `${JSON.stringify(true)} && window.__neverDefined !== 'force-sync' && document.getElementById('toast').textContent.includes('已保存')`);
    const familySave = fixture.requests.find((request) => request.url === '/api/agents/role-family-gpt');
    assert.ok(familySave);
    assert.equal(Object.hasOwn(familySave.body, 'personaPrompt'), false);
    assert.equal(Object.hasOwn(familySave.body.modelProfiles[0], 'personaPrompt'), false);

    await evaluate(cdp, `document.getElementById('show-provider-management').click()`);
    await waitFor(cdp, `!document.getElementById('provider-management-view').classList.contains('hidden')`);
    const provider = await evaluate(cdp, `(() => ({
      secretValue: document.getElementById('provider-api-key').value,
      configured: document.getElementById('provider-api-key').dataset.hasApiKey,
      authMode: document.getElementById('provider-auth-mode').value,
      rawLeak: document.getElementById('provider-detail').textContent.includes('resolve-') || document.getElementById('provider-detail').textContent.includes('$OPENAI'),
    }))()`);
    assert.deepEqual(provider, { secretValue: '', configured: 'true', authMode: 'literal', rawLeak: false });

    await evaluate(cdp, `document.getElementById('save-provider').click()`);
    await waitFor(cdp, `document.getElementById('toast').textContent.includes('供应商已保存')`);
    await waitFor(cdp, `!document.getElementById('add-provider').disabled && !document.getElementById('provider-detail').hasAttribute('aria-busy')`);
    const providerSave = fixture.requests.find((request) => request.url === '/api/model-providers/openai' && request.method === 'PUT');
    assert.ok(providerSave);
    assert.equal(providerSave.body.apiKey, '');
    assert.equal(providerSave.headers['x-caff-csrf-token'], 'provider-test-token');

    await evaluate(cdp, `document.getElementById('add-provider').click()`);
    const providerDraft = await evaluate(cdp, `(() => ({
      id: document.getElementById('provider-id').value,
      readOnly: document.getElementById('provider-id').readOnly,
      saveDisabled: document.getElementById('save-provider').disabled,
      emptyModels: Boolean(document.getElementById('provider-empty-models')),
      listText: document.querySelector('#provider-list [data-provider-id^="__draft-"]').textContent,
      countText: document.getElementById('provider-count').textContent,
    }))()`);
    assert.equal(providerDraft.id, '');
    assert.equal(providerDraft.readOnly, false);
    assert.equal(providerDraft.saveDisabled, true);
    assert.equal(providerDraft.emptyModels, true);
    assert.match(providerDraft.listText, /新供应商/u);
    assert.match(providerDraft.listText, /尚未保存/u);
    assert.equal(providerDraft.listText.includes('__draft-'), false);
    assert.equal(providerDraft.countText, '2 个连接 + 1 个草稿');
    const draftReady = await evaluate(cdp, `(() => {
      const id = document.getElementById('provider-id');
      id.value = 'team-gateway';
      id.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('provider-name').value = 'Team Gateway';
      document.getElementById('provider-base-url').value = 'https://gateway.example/v1';
      document.getElementById('provider-api-key').value = 'draft-only-secret';
      document.getElementById('add-provider-model').click();
      return {
        saveDisabled: document.getElementById('save-provider').disabled,
        name: document.getElementById('provider-name').value,
        baseUrl: document.getElementById('provider-base-url').value,
        apiKey: document.getElementById('provider-api-key').value,
      };
    })()`);
    assert.deepEqual(draftReady, {
      saveDisabled: false,
      name: 'Team Gateway',
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'draft-only-secret',
    });
    const removalKeepsDraft = await evaluate(cdp, `(() => {
      document.getElementById('provider-name').value = 'Team Gateway Updated';
      document.getElementById('provider-api-key').value = 'draft-only-secret';
      document.querySelector('[data-remove-provider-model]').click();
      return {
        name: document.getElementById('provider-name').value,
        apiKey: document.getElementById('provider-api-key').value,
      };
    })()`);
    assert.deepEqual(removalKeepsDraft, { name: 'Team Gateway Updated', apiKey: 'draft-only-secret' });
    fixture.holdProviderSave();
    await evaluate(cdp, `document.getElementById('save-provider').click()`);
    for (let attempt = 0; attempt < 50 && !fixture.isProviderSaveBlocked(); attempt += 1) await delay(100);
    assert.ok(fixture.requests.find((request) => request.url === '/api/model-providers/team-gateway' && request.method === 'PUT'));
    const providerSavePending = await evaluate(cdp, `(() => ({
      addDisabled: document.getElementById('add-provider').disabled,
      refreshDisabled: document.getElementById('refresh-providers').disabled,
      listInert: document.getElementById('provider-list').inert,
      detailInert: document.getElementById('provider-detail').inert,
      detailBusy: document.getElementById('provider-detail').getAttribute('aria-busy'),
    }))()`);
    fixture.releaseProviderSave();
    await waitFor(cdp, `Boolean(document.querySelector('[data-provider-id="team-gateway"]')) && !document.getElementById('provider-detail').inert`);
    assert.deepEqual(providerSavePending, {
      addDisabled: true, refreshDisabled: true, listInert: true, detailInert: true, detailBusy: 'true',
    });
    const abandonedDraft = await evaluate(cdp, `(() => {
      const before = document.querySelectorAll('#provider-list [data-provider-id]').length;
      document.getElementById('add-provider').click();
      const id = document.getElementById('provider-id');
      id.value = 'throwaway-provider';
      id.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('remove-provider').click();
      document.getElementById('confirm-remove-provider').click();
      return {
        before,
        after: document.querySelectorAll('#provider-list [data-provider-id]').length,
        draftRows: document.querySelectorAll('#provider-list [data-provider-id^="__draft-"]').length,
        ids: Array.from(document.querySelectorAll('#provider-list [data-provider-id]'), (row) => row.dataset.providerId),
      };
    })()`);
    assert.deepEqual(abandonedDraft, { before: 3, after: 3, draftRows: 0, ids: ['openai', 'anthropic', 'team-gateway'] });
    await evaluate(cdp, `document.querySelector('[data-provider-id="openai"]').click()`);
    await waitFor(cdp, `document.getElementById('provider-id').value === 'openai'`);

    await evaluate(cdp, `document.getElementById('clear-provider-secret').click()`);
    assert.equal(await evaluate(cdp, `!document.getElementById('clear-secret-confirmation').classList.contains('hidden')`), true);
    await evaluate(cdp, `document.getElementById('confirm-clear-secret').click()`);
    await waitFor(cdp, `document.getElementById('toast').textContent.includes('密钥已清除')`);
    assert.ok(fixture.requests.find((request) => request.url === '/api/model-providers/openai/secret' && request.method === 'DELETE'));

    await evaluate(cdp, `document.querySelector('[data-provider-id="anthropic"]').click()`);
    const external = await evaluate(cdp, `(() => ({
      mode: document.getElementById('provider-auth-mode').value,
      modes: Array.from(document.getElementById('provider-auth-mode').options, (option) => option.value),
      clearDisabled: document.getElementById('clear-provider-secret').disabled,
      secretValue: document.getElementById('provider-api-key').value,
      note: document.getElementById('provider-external-auth-note').textContent,
    }))()`);
    assert.deepEqual(external, {
      mode: 'none',
      modes: ['none', 'literal', 'env', 'command'],
      clearDisabled: true,
      secretValue: '',
      note: 'auth.json / CLI 外部认证只读；本页不会写入、替换或清除它。',
    });

    const providerModelFocus = await evaluate(cdp, `(() => {
      document.getElementById('add-provider-model').click();
      const rows = document.querySelectorAll('[data-provider-model]');
      return { count: rows.length, active: document.activeElement === rows[rows.length - 1].querySelector('[data-field="id"]') };
    })()`);
    assert.deepEqual(providerModelFocus, { count: 2, active: true });
    const providerModelRemoval = await evaluate(cdp, `(() => {
      const buttons = document.querySelectorAll('[data-remove-provider-model]');
      buttons[buttons.length - 1].click();
      return { count: document.querySelectorAll('[data-provider-model]').length, activeId: document.activeElement.id };
    })()`);
    assert.deepEqual(providerModelRemoval, { count: 1, activeId: 'add-provider-model' });

    await evaluate(cdp, `document.getElementById('validate-provider').click()`);
    await waitFor(cdp, `document.getElementById('toast').textContent.includes('连接验证完成')`);
    assert.ok(fixture.requests.find((request) => request.url === '/api/model-providers/anthropic/validate' && request.method === 'POST'));
    assert.match(
      await evaluate(cdp, `document.querySelector('[data-provider-id="anthropic"]').textContent`),
      /最近验证通过/u
    );

    const removalConfirmation = await evaluate(cdp, `(() => {
      document.getElementById('remove-provider').click();
      return {
        visible: !document.getElementById('remove-provider-confirmation').classList.contains('hidden'),
        text: document.getElementById('remove-provider-confirmation').textContent,
      };
    })()`);
    assert.equal(removalConfirmation.visible, true);
    assert.match(removalConfirmation.text, /历史聊天/u);
    assert.match(removalConfirmation.text, /外部认证/u);
    await evaluate(cdp, `document.getElementById('confirm-remove-provider').click()`);
    await waitFor(cdp, `document.getElementById('toast').textContent.includes('供应商已移除')`);
    assert.ok(fixture.requests.find((request) => request.url === '/api/model-providers/anthropic' && request.method === 'DELETE'));

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
    await delay(100);
    const medium = await evaluate(cdp, `(() => ({
      fieldColumns: getComputedStyle(document.querySelector('.management-detail .field-grid')).gridTemplateColumns.trim().split(/\\s+/).length,
      modelColumns: getComputedStyle(document.querySelector('[data-provider-model]')).gridTemplateColumns.trim().split(/\\s+/).length,
    }))()`);
    assert.deepEqual(medium, { fieldColumns: 1, modelColumns: 2 });

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
    await delay(100);
    const mobile = await evaluate(cdp, `(() => {
      const nav = document.querySelector('.management-topbar .topbar-nav');
      const first = nav.querySelector('.topbar-link');
      const active = nav.querySelector('.topbar-link.active');
      const navRect = nav.getBoundingClientRect();
      const firstRect = first.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      return {
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        firstVisible: firstRect.left >= navRect.left - 1,
        activeVisible: activeRect.left >= navRect.left - 1 && activeRect.right <= navRect.right + 1,
      };
    })()`);
    assert.deepEqual(mobile, { innerWidth: 375, scrollWidth: 375, firstVisible: true, activeVisible: true });

    fixture.bootstrap.localAdmin.modelProviders.enabled = false;
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(cdp, `Boolean(document.body && document.body.dataset.managementReady === 'true')`);
    await evaluate(cdp, `document.getElementById('show-provider-management').click()`);
    const locked = await evaluate(cdp, `(() => ({
      banner: document.getElementById('provider-local-admin-banner').textContent,
      addDisabled: document.getElementById('add-provider').disabled,
    }))()`);
    assert.match(locked.banner, /只读|本机/u);
    assert.equal(locked.addDisabled, true);

    console.log('PASS production model-family roles and provider management UI contract');
    cdp.socket.close();
  } finally {
    if (browser.exitCode === null) {
      browser.kill();
      await Promise.race([once(browser, 'exit'), delay(2000)]);
    }
    await fixture.close();
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
