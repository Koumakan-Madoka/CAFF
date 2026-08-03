const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const projectRoot = path.resolve(__dirname, '..', '..');
const publicDir = path.join(projectRoot, 'public');

function edgeExecutable() {
  const candidates = [
    process.env.MSEDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(executable, 'Microsoft Edge is required for the production new-chat UI test');
  return executable;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function role(overrides) {
  return {
    id: 'role-family-gpt',
    name: 'GPT',
    description: 'OpenAI GPT 模型族',
    roleKind: 'model_family',
    modelFamily: 'gpt',
    accentColor: '#3975c6',
    isDefaultChatRole: true,
    availability: { status: 'available', familyModelCount: 2 },
    ...overrides,
  };
}

async function serveProductionUi() {
  const requests = [];
  const eventStreams = new Set();
  const agents = [
    role({}),
    role({
      id: 'role-family-claude',
      name: 'Claude',
      description: 'Anthropic Claude 模型族',
      modelFamily: 'claude',
      accentColor: '#a35f3f',
    }),
    role({
      id: 'role-family-gemini',
      name: 'Gemini',
      description: 'Google Gemini 模型族',
      modelFamily: 'gemini',
      accentColor: '#5e6fc9',
    }),
    role({
      id: 'role-family-qwen',
      name: 'Qwen',
      description: 'Qwen 模型族',
      modelFamily: 'qwen',
      accentColor: '#6d55bd',
      provider: 'qwen',
      model: 'qwen-missing',
      modelProfiles: [{
        id: 'qwen-recovery',
        name: '恢复配置',
        description: '使用仍可用的同族模型',
        provider: 'qwen',
        model: 'qwen-live',
        thinking: 'high',
      }],
      availability: { status: 'default_model_missing', familyModelCount: 1 },
    }),
    role({
      id: 'custom-reviewer',
      name: '架构评审',
      description: '自定义角色',
      roleKind: 'custom',
      modelFamily: null,
      accentColor: '#277d75',
      isDefaultChatRole: false,
    }),
  ];
  const timestamp = '2026-08-03T00:00:00.000Z';
  const recoveryConversation = {
    id: 'conversation-recovery',
    title: '需要恢复的会话',
    type: 'standard',
    agents: [
      { ...agents[0], selectedModelProfileId: null, conversationSkillIds: [] },
      { ...agents[3], selectedModelProfileId: null, conversationSkillIds: [] },
    ],
    messages: [],
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const conversationUpdates = [];
  const bootstrap = {
    localAdmin: { modelProviders: { enabled: true, csrfToken: 'test-token' } },
    runtime: {
      activeConversationIds: [],
      dispatchingConversationIds: [],
      conversationQueueDepths: {},
      conversationQueueFailures: {},
      agentSlotQueueDepths: {},
      activeTurns: [],
      activeAgentSlots: [],
    },
    modelOptions: [{
      key: 'qwen\u001fqwen-live',
      provider: 'qwen',
      model: 'qwen-live',
      label: 'Qwen / qwen-live',
      family: 'qwen',
      supportedThinkingLevels: ['off', 'low', 'high'],
    }],
    skills: [{ id: 'tdd', name: 'TDD' }],
    modes: [
      { id: 'standard', name: '普通对话' },
      { id: 'skill_test_design', name: 'Skill Test 设计' },
      { id: 'werewolf', name: '狼人杀' },
      { id: 'who_is_undercover', name: '谁是卧底' },
    ],
    agents,
    conversations: [recoveryConversation],
    selectedConversationId: recoveryConversation.id,
  };

  const mimeTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
  };
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');
    if (request.url === '/api/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write(': connected\n\n');
      eventStreams.add(response);
      response.once('close', () => eventStreams.delete(response));
      return;
    }
    if (request.url === '/api/bootstrap') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(bootstrap));
      return;
    }
    if (request.url === '/api/channel-bindings/feishu') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ chats: [] }));
      return;
    }
    if (requestUrl.pathname === '/api/conversations/conversation-recovery' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ conversation: recoveryConversation }));
      return;
    }
    if (requestUrl.pathname === '/api/conversations/conversation-recovery/messages' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ items: [], hasMore: false, nextCursor: null }));
      return;
    }
    if (request.url === '/api/conversations' && request.method === 'POST') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        requests.push(parsed);
        const selectedAgents = parsed.participants.map((participant) => {
          const selectedRole = agents.find((agent) => agent.id === participant.agentId);
          return {
            ...selectedRole,
            selectedModelProfileId: participant.modelProfileId || null,
            conversationSkillIds: participant.conversationSkillIds || [],
          };
        });
        const conversation = {
          id: 'conversation-created',
          title: parsed.title || '新会话',
          type: parsed.type,
          agents: selectedAgents,
          messages: [],
          metadata: parsed.metadata || {},
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        response.writeHead(201, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ conversation, conversations: [conversation] }));
      });
      return;
    }
    if (request.url === '/api/conversations/conversation-recovery' && request.method === 'PUT') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        conversationUpdates.push(parsed);
        recoveryConversation.agents = parsed.participants.map((participant) => ({
          ...agents.find((agent) => agent.id === participant.agentId),
          selectedModelProfileId: participant.modelProfileId || null,
          conversationSkillIds: participant.conversationSkillIds || [],
        }));
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ conversation: recoveryConversation, conversations: [recoveryConversation] }));
      });
      return;
    }

    const pathname = requestUrl.pathname;
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//u, '');
    const filePath = path.resolve(publicDir, relativePath);
    if (!filePath.startsWith(`${publicDir}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    response.writeHead(200, { 'content-type': mimeTypes[path.extname(filePath)] || 'application/octet-stream' });
    response.end(fs.readFileSync(filePath));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    requests,
    conversationUpdates,
    close: async () => {
      eventStreams.forEach((stream) => stream.end());
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function findPage(debugPort) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
      const page = targets.find((target) => target.type === 'page');
      if (page) return page;
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
    if (!message.id || !pending.has(message.id)) return;
    const operation = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) operation.reject(new Error(JSON.stringify(message.error)));
    else operation.resolve(message.result);
  });
  return {
    socket,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Browser evaluation failed');
  return result.result.value;
}

async function key(cdp, keyName, modifiers = 0) {
  const virtualKeyCode = keyName === 'Tab' ? 9 : 27;
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: keyName, code: keyName, windowsVirtualKeyCode: virtualKeyCode, modifiers,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: keyName, code: keyName, windowsVirtualKeyCode: virtualKeyCode, modifiers,
  });
}

async function waitFor(cdp, expression) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await evaluate(cdp, expression)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function captureScreenshot(cdp, fileName) {
  const evidenceDir = String(process.env.CAFF_UI_EVIDENCE_DIR || '').trim();
  if (!evidenceDir) return;
  fs.mkdirSync(evidenceDir, { recursive: true });
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(path.join(evidenceDir, fileName), Buffer.from(result.data, 'base64'));
}

(async () => {
  const fixture = await serveProductionUi();
  const debugPort = await freePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-new-chat-edge-'));
  const browser = spawn(edgeExecutable(), [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    `http://127.0.0.1:${fixture.port}/`,
  ], { stdio: 'ignore' });

  try {
    const page = await findPage(debugPort);
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await waitFor(cdp, `Boolean(document.getElementById('open-new-conversation-button'))`);
    await waitFor(cdp, `document.getElementById('runtime-pill').textContent !== '正在连接本地服务...'`);

    const recoverySettings = await evaluate(cdp, `(() => {
      const card = document.querySelector('[data-agent-id="role-family-qwen"]');
      return {
        checked: card.querySelector('input[name="conversation-agent"]').checked,
        checkboxDisabled: card.querySelector('input[name="conversation-agent"]').disabled,
        profileDisabled: card.querySelector('.profile-dropdown-trigger').disabled,
        warning: card.querySelector('[data-role-availability]').textContent,
      };
    })()`);
    assert.equal(recoverySettings.checked, true);
    assert.equal(recoverySettings.checkboxDisabled, false);
    assert.equal(recoverySettings.profileDisabled, false);
    assert.match(recoverySettings.warning, /默认模型不可用/u);
    assert.match(recoverySettings.warning, /改选有效运行 Profile/u);

    await evaluate(cdp, `(() => {
      const card = document.querySelector('[data-agent-id="role-family-qwen"]');
      card.querySelector('.profile-dropdown-trigger').click();
      card.querySelector('[data-profile-id="qwen-recovery"]').click();
      document.getElementById('conversation-settings-form').requestSubmit();
    })()`);
    for (let attempt = 0; attempt < 50 && fixture.conversationUpdates.length === 0; attempt += 1) await delay(100);
    assert.equal(fixture.conversationUpdates.length, 1);
    assert.equal(
      fixture.conversationUpdates[0].participants.find((participant) => participant.agentId === 'role-family-qwen').modelProfileId,
      'qwen-recovery'
    );

    await evaluate(cdp, `document.getElementById('open-new-conversation-button').click()`);
    await waitFor(cdp, `document.activeElement && document.activeElement.id === 'new-conversation-title'`);
    const opened = await evaluate(cdp, `(() => ({
      inert: document.getElementById('app-shell').inert,
      checked: Array.from(document.querySelectorAll('input[name="new-conversation-participants"]:checked')).map((item) => item.value),
      qwenDisabled: document.querySelector('input[name="new-conversation-participants"][value="role-family-qwen"]').disabled,
      qwenText: document.querySelector('input[name="new-conversation-participants"][value="role-family-qwen"]').closest('label').textContent,
      activeId: document.activeElement.id,
    }))()`);
    assert.equal(opened.inert, true);
    assert.deepEqual(opened.checked, ['role-family-gpt', 'role-family-claude', 'role-family-gemini']);
    assert.equal(opened.qwenDisabled, true);
    assert.match(opened.qwenText, /不可用/u);
    assert.equal(opened.activeId, 'new-conversation-title');
    await captureScreenshot(cdp, 'new-conversation-defaults-desktop.png');

    await evaluate(cdp, `document.getElementById('new-conversation-submit').focus()`);
    await key(cdp, 'Tab');
    assert.equal(await evaluate(cdp, `document.activeElement.id`), 'new-conversation-close');
    await key(cdp, 'Tab', 8);
    assert.equal(await evaluate(cdp, `document.activeElement.id`), 'new-conversation-submit');

    await key(cdp, 'Escape');
    await waitFor(cdp, `document.getElementById('new-conversation-backdrop').classList.contains('hidden')`);
    assert.equal(await evaluate(cdp, `document.activeElement.id`), 'open-new-conversation-button');
    assert.equal(fixture.requests.length, 0);

    await evaluate(cdp, `document.getElementById('open-new-conversation-button').click()`);
    await waitFor(cdp, `document.activeElement && document.activeElement.id === 'new-conversation-title'`);
    const emptyState = await evaluate(cdp, `(() => {
      document.querySelectorAll('input[name="new-conversation-participants"]:checked').forEach((input) => {
        input.checked = false;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      return {
        disabled: document.getElementById('new-conversation-submit').disabled,
        errorVisible: !document.getElementById('new-conversation-error').classList.contains('hidden'),
      };
    })()`);
    assert.deepEqual(emptyState, { disabled: true, errorVisible: true });
    await captureScreenshot(cdp, 'new-conversation-empty-desktop.png');

    const gameState = await evaluate(cdp, `(() => {
      const type = document.getElementById('new-conversation-type');
      type.value = 'werewolf';
      type.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        checked: document.querySelectorAll('input[name="new-conversation-participants"]:checked').length,
        policy: document.getElementById('new-conversation-policy-note').textContent,
        title: document.getElementById('new-conversation-participants-title').textContent,
      };
    })()`);
    assert.equal(gameState.checked, 0);
    assert.match(gameState.policy, /不读取普通聊天默认/u);
    assert.equal(gameState.title, '选择玩家');

    await evaluate(cdp, `(() => {
      const input = document.querySelector('input[name="new-conversation-participants"][value="role-family-gpt"]');
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('new-conversation-title').value = '明确玩家';
      document.getElementById('new-conversation-form').requestSubmit();
    })()`);
    for (let attempt = 0; attempt < 50 && fixture.requests.length === 0; attempt += 1) await delay(100);
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(fixture.requests[0], {
      title: '明确玩家',
      type: 'werewolf',
      participants: [{ agentId: 'role-family-gpt', modelProfileId: null, conversationSkillIds: [] }],
    });

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 375, height: 812, deviceScaleFactor: 1, mobile: true,
    });
    await evaluate(cdp, `document.getElementById('open-new-conversation-button').click()`);
    await waitFor(cdp, `!document.getElementById('new-conversation-backdrop').classList.contains('hidden')`);
    const mobile = await evaluate(cdp, `(() => {
      const dialog = document.getElementById('new-conversation-dialog').getBoundingClientRect();
      return {
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        dialogLeft: dialog.left,
        dialogRight: dialog.right,
        dialogHeight: dialog.height,
      };
    })()`);
    assert.equal(mobile.innerWidth, 375);
    assert.equal(mobile.scrollWidth, 375);
    assert.equal(mobile.dialogLeft, 0);
    assert.equal(mobile.dialogRight, 375);
    assert.equal(mobile.dialogHeight, 812);
    await captureScreenshot(cdp, 'new-conversation-mobile-375.png');
    cdp.socket.close();

    console.log('PASS production new-conversation dialog contract');
  } finally {
    browser.kill();
    await Promise.race([once(browser, 'exit'), delay(2000)]);
    await fixture.close();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
