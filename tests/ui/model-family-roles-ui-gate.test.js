const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const projectRoot = path.resolve(__dirname, '..', '..');
const fixturePath = path.join(projectRoot, 'designs', 'model-family-roles-ui-gate.html');
const contractPath = path.join(
  projectRoot,
  '.trellis',
  'spec',
  'frontend',
  'model-family-management.md'
);

function edgeExecutable() {
  const candidates = [
    process.env.MSEDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(executable, 'Microsoft Edge is required for the UI Design Gate contract test');
  return executable;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function serveFixture() {
  const fixture = fs.readFileSync(fixturePath);
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/model-family-roles-ui-gate.html')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(fixture);
      return;
    }
    response.writeHead(404);
    response.end('Not found');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server,
    port: server.address().port,
  };
}

async function authoritativeCapabilitySnapshots() {
  const piAiRoot = path.join(
    projectRoot,
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
    'node_modules',
    '@earendil-works',
    'pi-ai',
    'dist'
  );
  const [{ getSupportedThinkingLevels }, { getBuiltinModel }] = await Promise.all([
    import(pathToFileURL(path.join(piAiRoot, 'index.js')).href),
    import(pathToFileURL(path.join(piAiRoot, 'providers', 'all.js')).href),
  ]);
  const sources = {
    'openai/gpt-5.4': ['openai', 'gpt-5.4'],
    'openai/gpt-5-mini': ['openai', 'gpt-5-mini'],
    'anthropic/claude-sonnet-4.5': ['anthropic', 'claude-sonnet-4-5'],
    'anthropic/claude-opus-4.5': ['anthropic', 'claude-opus-4-5'],
    'google/gemini-2.5-pro': ['google', 'gemini-2.5-pro'],
    'deepseek/deepseek-v3.2': ['openrouter', 'deepseek/deepseek-v3.2'],
    'zhipu/glm-5': ['openrouter', 'z-ai/glm-5'],
    'moonshot/kimi-k2.5': ['moonshotai', 'kimi-k2.5'],
  };
  return Object.fromEntries(
    Object.entries(sources).map(([fixtureKey, [provider, modelId]]) => [
      fixtureKey,
      getSupportedThinkingLevels(getBuiltinModel(provider, modelId)),
    ])
  );
}

async function findPage(debugPort) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
      const page = targets.find((target) => target.type === 'page');
      if (page) {
        return page;
      }
    } catch {}
    await delay(100);
  }
  throw new Error('Edge DevTools target did not become available');
}

async function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) {
      return;
    }
    const operation = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      operation.reject(new Error(JSON.stringify(message.error)));
    } else {
      operation.resolve(message.result);
    }
  });

  return {
    socket,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

async function key(cdp, keyName, modifiers = 0) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: keyName,
    code: keyName,
    windowsVirtualKeyCode: keyName === 'Tab' ? 9 : 27,
    nativeVirtualKeyCode: keyName === 'Tab' ? 9 : 27,
    modifiers,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: keyName,
    code: keyName,
    windowsVirtualKeyCode: keyName === 'Tab' ? 9 : 27,
    nativeVirtualKeyCode: keyName === 'Tab' ? 9 : 27,
    modifiers,
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  return result.result.value;
}

async function browserContract() {
  const { server, port } = await serveFixture();
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-model-family-ui-gate-'));
  const browser = spawn(
    edgeExecutable(),
    [
      '--headless=new',
      '--disable-gpu',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true }
  );

  try {
    const page = await findPage(debugPort);
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 812,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: 375,
      screenHeight: 812,
    });
    await cdp.send('Page.navigate', {
      url: `http://127.0.0.1:${port}/model-family-roles-ui-gate.html?contract=1#clean`,
    });
    await delay(500);

    const providerView = await evaluate(
      cdp,
      `(() => {
        const providerNav = document.getElementById('nav-providers');
        if (!providerNav) return { missing: true };
        providerNav.click();
        const removeProvider = document.getElementById('remove-provider');
        if (!removeProvider) return { missingRemoval: true };
        const secret = document.getElementById('provider-api-key');
        document.getElementById('clear-provider-secret').click();
        const existing = {
          secretType: secret.type,
          secretValue: secret.value,
          familyValue: document.getElementById('provider-model-family').value,
          clearConfirmationVisible: !document.getElementById('clear-secret-confirmation').classList.contains('hidden'),
          clearConfirmationFocus: document.activeElement.id,
        };
        document.getElementById('cancel-clear-secret').click();
        removeProvider.click();
        existing.removeConfirmationVisible = !document.getElementById('remove-provider-confirmation').classList.contains('hidden');
        existing.removeConfirmationFocus = document.activeElement.id;
        existing.removeImpactText = document.getElementById('remove-provider-confirmation').textContent;
        document.getElementById('cancel-remove-provider').click();
        existing.removeCancelFocus = document.activeElement.id;
        document.querySelector('[data-provider-id="anthropic"]').click();
        const external = {
          mode: document.getElementById('provider-auth-mode').value,
          clearDisabled: document.getElementById('clear-provider-secret').disabled,
          secretValue: document.getElementById('provider-api-key').value,
          referenceValue: document.getElementById('provider-auth-reference').value,
        };
        document.getElementById('add-provider').click();
        const draft = {
          providerIdReadonly: document.getElementById('provider-id').readOnly,
          authMode: document.getElementById('provider-auth-mode').value,
          clearDisabled: document.getElementById('clear-provider-secret').disabled,
          emptyModelsVisible: Boolean(document.getElementById('provider-empty-models')),
          saveDisabled: document.getElementById('save-provider').disabled,
          referenceValue: document.getElementById('provider-auth-reference').value,
        };
        document.getElementById('add-provider-model').click();
        draft.modelRowsAfterAdd = document.querySelectorAll('.provider-detail .model-row:not(.header)').length;
        draft.modelFamilyAfterAdd = document.getElementById('provider-model-family').value;
        draft.focusAfterAdd = document.activeElement.id;
        draft.removeLabel = document.getElementById('remove-provider').textContent.trim();
        document.getElementById('remove-provider').click();
        draft.removeConfirmationVisible = !document.getElementById('remove-provider-confirmation').classList.contains('hidden');
        draft.removeConfirmationFocus = document.activeElement.id;
        document.getElementById('cancel-remove-provider').click();
        draft.removeCancelFocus = document.activeElement.id;
        history.replaceState(null, '', '#provider-locked');
        switchManagementView('providers');
        const locked = {
          removeDisabled: document.getElementById('remove-provider').disabled,
          validateDisabled: document.getElementById('validate-provider').disabled,
          saveDisabled: document.getElementById('save-provider').disabled,
        };
        history.replaceState(null, '', '#clean');
        switchManagementView('providers');
        return {
          rolesHidden: document.getElementById('role-management-view').classList.contains('hidden'),
          providersHidden: document.getElementById('provider-management-view').classList.contains('hidden'),
          providerNavActive: providerNav.classList.contains('active'),
          providerDemoActive: document.querySelector('[data-demo="providers"]').classList.contains('active'),
          existing,
          external,
          draft,
          locked,
          scrollWidth: document.documentElement.scrollWidth,
        };
      })()`
    );

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: 900,
      screenHeight: 800,
    });
    await delay(100);
    const intermediateViewport = await evaluate(
      cdp,
      `(() => ({
        fieldColumns: getComputedStyle(document.querySelector('.provider-detail .field-grid')).gridTemplateColumns.trim().split(/\\s+/).length,
        modelColumns: getComputedStyle(document.querySelector('.provider-detail .model-row:not(.header)')).gridTemplateColumns.trim().split(/\\s+/).length,
        scrollWidth: document.documentElement.scrollWidth,
      }))()`
    );
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 812,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: 375,
      screenHeight: 812,
    });
    await delay(100);

    const roleCatalogSource = await evaluate(
      cdp,
      `(() => {
        const rolesNav = document.getElementById('nav-roles');
        if (!rolesNav) return { missing: true };
        rolesNav.click();
        return {
          rolesHidden: document.getElementById('role-management-view').classList.contains('hidden'),
          providersHidden: document.getElementById('provider-management-view').classList.contains('hidden'),
          rolesNavActive: rolesNav.classList.contains('active'),
          sourceVisible: document.getElementById('role-detail').textContent.includes('模型供应商'),
        };
      })()`
    );

    const roleRuntimeControls = await evaluate(
      cdp,
      `(() => {
        const defaultThinking = document.getElementById('role-default-thinking');
        const addProfile = document.getElementById('add-runtime-profile');
        if (!defaultThinking || !addProfile) return { missing: true };
        const family = {
          thinkingTag: defaultThinking.tagName,
          thinkingValue: defaultThinking.value,
          thinkingOptions: Array.from(defaultThinking.options).map((option) => option.value),
          profileCount: document.querySelectorAll('[data-runtime-profile]').length,
          profileModelOptions: Array.from(document.getElementById('runtime-profile-model-0').options).map((option) => option.value),
          profileThinkingOptions: Array.from(document.getElementById('runtime-profile-thinking-0').options).map((option) => option.value),
          profilePersonaVisible: Boolean(document.querySelector('[data-runtime-profile] [data-profile-persona]')),
        };
        addProfile.click();
        family.profileCountAfterAdd = document.querySelectorAll('[data-runtime-profile]').length;
        family.focusAfterAdd = document.activeElement.id;
        document.querySelector('[data-role-id="custom-architecture-reviewer"]').click();
        const custom = {
          personaVisible: Boolean(document.getElementById('role-persona-prompt')),
          skillsVisible: Boolean(document.getElementById('role-skill-options')),
          profilePersonaVisible: Boolean(document.querySelector('[data-runtime-profile] [data-profile-persona]')),
          profileModelOptions: Array.from(document.getElementById('runtime-profile-model-0').options).map((option) => option.value),
        };
        const customModel = document.getElementById('role-default-model');
        customModel.value = 'openai/gpt-5.4';
        customModel.dispatchEvent(new Event('change', { bubbles: true }));
        const customThinking = document.getElementById('role-default-thinking');
        customThinking.value = 'xhigh';
        customThinking.dispatchEvent(new Event('change', { bubbles: true }));
        customModel.value = 'moonshot/kimi-k2.5';
        customModel.dispatchEvent(new Event('change', { bubbles: true }));
        custom.thinkingAfterIncompatibleModel = document.getElementById('role-default-thinking').value;
        custom.thinkingOptionsAfterModelSwitch = Array.from(
          document.getElementById('role-default-thinking').options
        ).map((option) => option.value);
        custom.resetNotice = document.getElementById('toast').textContent;
        const capabilities = Object.fromEntries(
          [
            'openai/gpt-5.4',
            'openai/gpt-5-mini',
            'anthropic/claude-sonnet-4.5',
            'anthropic/claude-opus-4.5',
            'google/gemini-2.5-pro',
            'deepseek/deepseek-v3.2',
            'zhipu/glm-5',
            'moonshot/kimi-k2.5',
          ].map((model) => [model, supportedThinkingLevels(model)])
        );
        document.querySelector('[data-role-id="role-family-gpt"]').click();
        return { family, custom, capabilities, scrollWidth: document.documentElement.scrollWidth };
      })()`
    );

    const opened = await evaluate(
      cdp,
      `(() => {
        const trigger = document.getElementById('open-new-chat');
        trigger.focus();
        trigger.click();
        return {
          appInert: document.getElementById('app-shell').inert,
          demoInert: document.querySelector('.demo-bar').inert,
          activeId: document.activeElement.id,
          scrollWidth: document.documentElement.scrollWidth,
        };
      })()`
    );

    await evaluate(cdp, `document.getElementById('create-conversation').focus()`);
    await key(cdp, 'Tab');
    const wrappedForward = await evaluate(cdp, `document.activeElement.id`);

    await evaluate(cdp, `document.getElementById('close-dialog').focus()`);
    await key(cdp, 'Tab', 8);
    const wrappedBackward = await evaluate(cdp, `document.activeElement.id`);

    const gameState = await evaluate(
      cdp,
      `(() => {
        document.getElementById('clear-selection').click();
        const before = document.getElementById('dialog-error').classList.contains('visible');
        const type = document.getElementById('conversation-type');
        type.value = 'werewolf';
        type.dispatchEvent(new Event('change', { bubbles: true }));
        return {
          errorBefore: before,
          errorAfter: document.getElementById('dialog-error').classList.contains('visible'),
          pickerHidden: document.querySelector('.participant-picker').classList.contains('hidden'),
        };
      })()`
    );

    await key(cdp, 'Escape');
    const closed = await evaluate(
      cdp,
      `({
        hidden: document.getElementById('new-chat-backdrop').classList.contains('hidden'),
        appInert: document.getElementById('app-shell').inert,
        demoInert: document.querySelector('.demo-bar').inert,
        activeId: document.activeElement.id,
      })`
    );

    cdp.socket.close();
    return {
      opened,
      providerView,
      intermediateViewport,
      roleCatalogSource,
      roleRuntimeControls,
      wrappedForward,
      wrappedBackward,
      gameState,
      closed,
    };
  } finally {
    browser.kill();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const failures = [];
  const contractDocument = fs.readFileSync(contractPath, 'utf8');
  const fixture = fs.readFileSync(fixturePath, 'utf8');
  const authoritativeCapabilities = await authoritativeCapabilitySnapshots();

  if (!contractDocument.includes('| 861–1023px |') || !contractDocument.includes('| 701–860px |')) {
    failures.push('Responsive Contract must use the fixture canonical 860px participant breakpoint');
  }
  if (!contractDocument.includes('focus trap') || !contractDocument.includes('焦点归还')) {
    failures.push('Feature Spec AC must freeze modal focus trap and focus restoration');
  }
  if (!fixture.includes('生产入口位于聊天侧栏')) {
    failures.push('Fixture must disclose that the production entry replaces the chat sidebar quick form');
  }
  if (!fixture.includes('模型供应商') || !fixture.includes('provider-api-key')) {
    failures.push('Fixture must expose first-class provider management with an API-key field');
  }
  if (!fixture.includes('Provider ID') || !fixture.includes('Base URL') || !fixture.includes('API 协议')) {
    failures.push('Provider form must expose provider ID, base URL, and API protocol');
  }
  if (!fixture.includes('模型族归类') || !fixture.includes('provider-model-family')) {
    failures.push('Provider model rows must expose explicit model-family classification');
  }
  if (/sk-[A-Za-z0-9_-]{8,}/.test(fixture)) {
    failures.push('Fixture must never contain a plaintext API key');
  }
  if (fixture.includes('authReference')) {
    failures.push('Fixture must not model raw env/command references as readable browser state');
  }
  for (const contract of ['读取接口永不返回明文密钥', '留空保留现有密钥', '显式清除', '原子替换', '可恢复备份']) {
    if (!contractDocument.includes(contract)) {
      failures.push(`Provider security contract must freeze: ${contract}`);
    }
  }
  for (const contract of ['local-admin-only', 'CSRF', '验证连接', '禁止执行 command', 'platform-aware', 'directory_sync_unsupported']) {
    if (!contractDocument.includes(contract)) {
      failures.push(`Provider privilege/durability contract must freeze: ${contract}`);
    }
  }
  for (const contract of ['DELETE /api/model-providers/:id', '不删除历史']) {
    if (!contractDocument.includes(contract)) {
      failures.push(`Provider removal contract must freeze: ${contract}`);
    }
  }
  for (const contract of ['supportedThinkingLevels', 'off / minimal / low / medium / high / xhigh / max', '不允许静默 clamp']) {
    if (!contractDocument.includes(contract)) {
      failures.push(`Role thinking contract must freeze: ${contract}`);
    }
  }
  for (const contract of [
    '@earendil-works/pi-coding-agent@0.84.3',
    'nested @earendil-works/pi-ai',
    'global CLI',
  ]) {
    if (!contractDocument.includes(contract)) {
      failures.push(`Thinking capability source contract must identify: ${contract}`);
    }
  }

  const browser = await browserContract();
  if (
    browser.providerView.missing ||
    browser.providerView.missingRemoval ||
    !browser.providerView.rolesHidden ||
    browser.providerView.providersHidden ||
    !browser.providerView.providerNavActive ||
    !browser.providerView.providerDemoActive ||
    browser.providerView.existing.secretType !== 'password' ||
    browser.providerView.existing.secretValue !== '' ||
    browser.providerView.existing.familyValue !== 'gpt' ||
    !browser.providerView.existing.clearConfirmationVisible ||
    browser.providerView.existing.clearConfirmationFocus !== 'confirm-clear-secret' ||
    !browser.providerView.existing.removeConfirmationVisible ||
    browser.providerView.existing.removeConfirmationFocus !== 'confirm-remove-provider' ||
    !browser.providerView.existing.removeImpactText.includes('2 个模型') ||
    !browser.providerView.existing.removeImpactText.includes('GPT') ||
    !browser.providerView.existing.removeImpactText.includes('架构评审') ||
    !browser.providerView.existing.removeImpactText.includes('历史聊天') ||
    browser.providerView.existing.removeCancelFocus !== 'remove-provider' ||
    browser.providerView.external.mode !== 'external' ||
    !browser.providerView.external.clearDisabled ||
    browser.providerView.external.secretValue !== '' ||
    browser.providerView.external.referenceValue !== '' ||
    browser.providerView.draft.providerIdReadonly ||
    browser.providerView.draft.authMode !== 'none' ||
    !browser.providerView.draft.clearDisabled ||
    !browser.providerView.draft.emptyModelsVisible ||
    !browser.providerView.draft.saveDisabled ||
    browser.providerView.draft.referenceValue !== '' ||
    browser.providerView.draft.modelRowsAfterAdd !== 1 ||
    browser.providerView.draft.modelFamilyAfterAdd !== '' ||
    browser.providerView.draft.focusAfterAdd !== 'provider-model-id-0' ||
    browser.providerView.draft.removeLabel !== '放弃草稿' ||
    !browser.providerView.draft.removeConfirmationVisible ||
    browser.providerView.draft.removeConfirmationFocus !== 'confirm-remove-provider' ||
    browser.providerView.draft.removeCancelFocus !== 'remove-provider' ||
    !browser.providerView.locked.removeDisabled ||
    !browser.providerView.locked.validateDisabled ||
    !browser.providerView.locked.saveDisabled
  ) {
    failures.push(`Provider navigation must show a masked, empty-on-read provider editor: ${JSON.stringify(browser.providerView)}`);
  }
  if (browser.providerView.scrollWidth !== 375) {
    failures.push(`Provider management must remain width-safe at 375px: ${browser.providerView.scrollWidth}`);
  }
  if (
    browser.intermediateViewport.fieldColumns !== 1 ||
    browser.intermediateViewport.modelColumns !== 2 ||
    browser.intermediateViewport.scrollWidth !== 900
  ) {
    failures.push(`900px provider layout must use one-column fields and two-column model rows: ${JSON.stringify(browser.intermediateViewport)}`);
  }
  if (
    browser.roleCatalogSource.missing ||
    browser.roleCatalogSource.rolesHidden ||
    !browser.roleCatalogSource.providersHidden ||
    !browser.roleCatalogSource.rolesNavActive ||
    !browser.roleCatalogSource.sourceVisible
  ) {
    failures.push(`Returning to roles must identify provider catalog as the availability source: ${JSON.stringify(browser.roleCatalogSource)}`);
  }
  if (
    browser.roleRuntimeControls.missing ||
    browser.roleRuntimeControls.family.thinkingTag !== 'SELECT' ||
    browser.roleRuntimeControls.family.thinkingValue !== 'medium' ||
    !browser.roleRuntimeControls.family.thinkingOptions.includes('') ||
    !browser.roleRuntimeControls.family.thinkingOptions.includes('off') ||
    !browser.roleRuntimeControls.family.thinkingOptions.includes('xhigh') ||
    browser.roleRuntimeControls.family.thinkingOptions.includes('max') ||
    browser.roleRuntimeControls.family.profileCount !== 1 ||
    browser.roleRuntimeControls.family.profileCountAfterAdd !== 2 ||
    browser.roleRuntimeControls.family.focusAfterAdd !== 'runtime-profile-name-1' ||
    browser.roleRuntimeControls.family.profilePersonaVisible ||
    browser.roleRuntimeControls.family.profileModelOptions.some((model) => !model.startsWith('openai/gpt-')) ||
    browser.roleRuntimeControls.family.profileThinkingOptions.includes('max') ||
    !browser.roleRuntimeControls.custom.personaVisible ||
    !browser.roleRuntimeControls.custom.skillsVisible ||
    !browser.roleRuntimeControls.custom.profilePersonaVisible ||
    !browser.roleRuntimeControls.custom.profileModelOptions.includes('anthropic/claude-opus-4.5') ||
    !browser.roleRuntimeControls.custom.profileModelOptions.includes('openai/gpt-5.4') ||
    browser.roleRuntimeControls.custom.thinkingAfterIncompatibleModel !== '' ||
    !browser.roleRuntimeControls.custom.thinkingOptionsAfterModelSwitch.includes('off') ||
    !browser.roleRuntimeControls.custom.thinkingOptionsAfterModelSwitch.includes('minimal') ||
    !browser.roleRuntimeControls.custom.thinkingOptionsAfterModelSwitch.includes('high') ||
    browser.roleRuntimeControls.custom.thinkingOptionsAfterModelSwitch.includes('max') ||
    !browser.roleRuntimeControls.custom.resetNotice.includes('跟随运行时默认')
  ) {
    failures.push(`Role runtime controls must expose capability-aware thinking and editable Profiles: ${JSON.stringify(browser.roleRuntimeControls)}`);
  }
  const expectedCapabilitySnapshots = {
    'openai/gpt-5.4': ['off', 'low', 'medium', 'high', 'xhigh'],
    'openai/gpt-5-mini': ['minimal', 'low', 'medium', 'high'],
    'anthropic/claude-sonnet-4.5': ['off', 'minimal', 'low', 'medium', 'high'],
    'anthropic/claude-opus-4.5': ['off', 'minimal', 'low', 'medium', 'high'],
    'google/gemini-2.5-pro': ['off', 'minimal', 'low', 'medium', 'high'],
    'deepseek/deepseek-v3.2': ['off', 'minimal', 'low', 'medium', 'high'],
    'zhipu/glm-5': ['off', 'minimal', 'low', 'medium', 'high'],
    'moonshot/kimi-k2.5': ['off', 'minimal', 'low', 'medium', 'high'],
  };
  if (JSON.stringify(browser.roleRuntimeControls.capabilities) !== JSON.stringify(expectedCapabilitySnapshots)) {
    failures.push(
      `Fixture capability snapshots must match the audited Pi 0.84.3 catalog values: ${JSON.stringify(browser.roleRuntimeControls.capabilities)}`
    );
  }
  if (JSON.stringify(authoritativeCapabilities) !== JSON.stringify(expectedCapabilitySnapshots)) {
    failures.push(
      `Audited fixture snapshots must remain aligned with repo-pinned Pi: ${JSON.stringify(authoritativeCapabilities)}`
    );
  }
  if (browser.roleRuntimeControls.scrollWidth !== 375) {
    failures.push(`Role runtime controls must remain width-safe at 375px: ${browser.roleRuntimeControls.scrollWidth}`);
  }
  if (!browser.opened.appInert || !browser.opened.demoInert || browser.opened.activeId !== 'conversation-title') {
    failures.push(`Opening dialog must inert background and move focus to title: ${JSON.stringify(browser.opened)}`);
  }
  if (browser.opened.scrollWidth !== 375) {
    failures.push(`375px viewport must not overflow horizontally: ${browser.opened.scrollWidth}`);
  }
  if (browser.wrappedForward !== 'close-dialog' || browser.wrappedBackward !== 'create-conversation') {
    failures.push(
      `Tab focus must wrap inside dialog: forward=${browser.wrappedForward}, backward=${browser.wrappedBackward}`
    );
  }
  if (!browser.gameState.errorBefore || browser.gameState.errorAfter || !browser.gameState.pickerHidden) {
    failures.push(`Game type switch must clear standard-only error state: ${JSON.stringify(browser.gameState)}`);
  }
  if (!browser.closed.hidden || browser.closed.appInert || browser.closed.demoInert || browser.closed.activeId !== 'open-new-chat') {
    failures.push(`Closing dialog must restore trigger focus and background: ${JSON.stringify(browser.closed)}`);
  }

  if (failures.length > 0) {
    failures.forEach((failure) => console.error(`FAIL ${failure}`));
    process.exitCode = 1;
    return;
  }

  console.log('PASS model-family roles UI Design Gate contract');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
