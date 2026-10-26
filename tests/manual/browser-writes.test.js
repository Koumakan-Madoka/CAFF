// Opt-in real Edge + real CAFF acceptance, with synthetic execution only.
// npm run build && node tests/manual/browser-writes.test.js --run
// Evidence stays under os.tmpdir(); no persistent instance or credentials used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

test('real browser writes carry CSRF and preserve chat, Goal, workspace, provider and project flows',
  { skip: !process.argv.includes('--run'), timeout: 120000 }, async (t) => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-planner-browser-evidence-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-planner-browser-runtime-'));
    // Do not pass bridge, provider or integration credentials to the fixture.
    const env = {};
    for (const key of ['SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'ComSpec', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'WINDIR', 'ProgramFiles', 'ProgramFiles(x86)']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    Object.assign(env, { HOME: home, USERPROFILE: home, CAFF_DISABLE_ENV_LOCAL: '1', FEISHU_CONNECTION_MODE: 'webhook' });
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    const { chromium } = require('playwright-core');
    const { createTestServerApp } = require('../helpers/server-app');
    const { edgeExecutable } = require('../helpers/edge-cdp');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init', '-b', 'main']);
    git(['-c', 'user.name=GPT', '-c', 'user.email=gpt@caff.local', 'commit', '--allow-empty', '-m', 'Synthetic browser fixture']);
    git(['branch', 'develop']);
    let app, browser;
    const writes = [], results = [], pageErrors = [], externalRequests = [];
    t.after(async () => {
      try { if (browser) await browser.close(); }
      finally {
        try { if (app) await new Promise(resolve => app.close(resolve)); }
        finally {
          fs.rmSync(root, { recursive: true, force: true });
          fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ results, writes, pageErrors, externalRequests, runtimeDeleted: !fs.existsSync(root) }, null, 2));
          console.info('Sanitized browser acceptance evidence: ' + output);
        }
      }
    });
    const model = { key: 'openai\u001fgpt-5', provider: 'openai', model: 'gpt-5', label: 'Synthetic GPT', family: 'gpt',
      input: ['text', 'image'], runtimeResolvable: true, supportedThinkingLevels: ['off'] };
    let executions = 0;
    app = createTestServerApp({ host: '127.0.0.1', port: 0, projectDir: repo, agentDir: path.join(root, 'agent'),
      sqlitePath: path.join(root, 'chat.sqlite'), uploadsDir: path.join(root, 'uploads'),
      modelCatalog: { getOptions: () => [model], invalidate() {} },
      validateProvider: async () => ({ ok: true, status: 'reachable' }),
      executeConversationAgent: async () => { executions += 1; return { stopTurn: true, terminationReason: 'synthetic' }; } });
    const agent = app.store.saveCustomRoleConfig({ id: 'browser-author', name: 'Browser Author', personaPrompt: 'Synthetic only', provider: model.provider, model: model.model });
    await new Promise(resolve => app.start(resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    assert.ok(![3100, 3200].includes(app.server.address().port));
    browser = await chromium.launch({ executablePath: edgeExecutable(), headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== base) {
        externalRequests.push(new URL(route.request().url()).origin);
        return route.abort();
      }
      return route.continue();
    });
    context.on('page', page => {
      page.on('pageerror', error => pageErrors.push(String(error)));
      page.on('response', response => {
        const request = response.request();
        if (!new URL(request.url()).pathname.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return;
        const headers = request.headers();
        // Never store CSRF values, authorization, request bodies or one-time card tokens.
        writes.push({ path: new URL(request.url()).pathname, method: request.method(), status: response.status(),
          csrfPresent: Boolean(headers['x-caff-csrf-token']), originMatches: headers.origin === base,
          contentType: headers['content-type'] || '' });
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    let acceptDialogs = true;
    page.on('dialog', dialog => acceptDialogs ? dialog.accept() : dialog.dismiss());
    async function clickWrite(selector, pathname, method = 'POST', expected = 200) {
      const pending = page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === method);
      await page.locator(selector).click();
      const response = await pending;
      assert.equal(response.status(), expected, `${method} ${pathname}`);
      return response.json();
    }
    async function idle(id) {
      await page.waitForFunction(async id => {
        const payload = await fetch('/api/bootstrap').then(response => response.json());
        return !(payload.runtime?.activeConversationIds || []).includes(id)
          && !(payload.runtime?.dispatchingConversationIds || []).includes(id)
          && !(payload.runtime?.queuedUserConversationIds || []).includes(id);
      }, id);
    }
    function passed(name) { results.push({ name, passed: true }); console.info('PASS | ' + name); }

    // Create a project through its real form. The entire repository is disposable.
    await page.goto(base + '/projects.html');
    await page.fill('#project-name', 'Browser isolated project');
    await page.fill('#project-path', repo);
    const projectResult = await clickWrite('#create-project-button', '/api/projects', 'POST', 201);
    const projectId = projectResult.activeProjectId || projectResult.project?.id;
    assert.ok(projectId);
    passed('project form creates and activates an isolated Git project');

    // Save both provider configuration and a role through actual management UI.
    await page.goto(base + '/personas.html');
    await page.click('#show-provider-management');
    await page.click('#add-provider');
    await page.fill('#provider-id', 'browser-fixture');
    await page.fill('#provider-name', 'Synthetic only');
    await page.fill('#provider-base-url', 'https://example.invalid/v1');
    await page.selectOption('#provider-api-protocol', 'openai-completions');
    await page.click('#add-provider-model');
    await page.locator('[data-provider-model] [data-field="id"]').fill('synthetic-model');
    await clickWrite('#save-provider', '/api/model-providers/browser-fixture', 'PUT');
    const models = JSON.parse(fs.readFileSync(path.join(root, 'agent', 'models.json'), 'utf8'));
    assert.equal(models.providers['browser-fixture'].models[0].id, 'synthetic-model');
    passed('provider and model form persists configuration without network validation');
    await page.click('#show-role-management');
    await page.locator(`#custom-role-list button[data-id="${agent.id}"]`).click();
    await page.fill('#role-description', 'Browser accepted update');
    await clickWrite('#save-role', '/api/agents/' + agent.id, 'PUT');
    assert.equal(app.store.getAgent(agent.id).description, 'Browser accepted update');
    passed('role form persists an update');

    // Room creation is a real UI submit, not an API fixture substitute.
    await page.goto(base + '/');
    await page.click('#open-new-conversation-button');
    await page.selectOption('#new-conversation-project', projectId);
    await page.fill('#new-conversation-title', 'Browser mutation acceptance');
    await page.check(`input[name="new-conversation-participants"][value="${agent.id}"]`);
    const created = await clickWrite('#new-conversation-submit', '/api/conversations', 'POST', 201);
    const room = created.conversation;
    await page.waitForSelector('#new-conversation-backdrop.hidden', { state: 'attached' });
    passed('new-room dialog persists a room');

    // A synthetic agent asks for a genuine workspace preview. The user approves
    // using the real card; Git effects are contained in root/worktrees only.
    const invocation = app.agentToolBridge.registerInvocation(app.agentToolBridge.createInvocationContext({
      conversationId: room.id, turnId: 'browser-workspace', agentId: agent.id, agentName: agent.name,
      conversationAgents: [agent], projectDir: repo, turnState: { conversationId: room.id, turnId: 'browser-workspace', stopRequested: false } }));
    const preview = await app.agentToolBridge.handlePiCapability('room_workspace_preview', {
      invocationId: invocation.invocationId, callbackToken: invocation.callbackToken, arguments: {} });
    assert.equal(path.relative(root, preview.worktreePath).startsWith('..'), false);
    const card = app.agentToolBridge.listRoomWorkspaceAuthorizations(room.id).find(item => item.status === 'pending');
    assert.ok(card);
    await page.reload();
    await clickWrite('[data-workspace-authorization-decision="accepted"]', `/api/conversations/${room.id}/workspace/authorizations/${card.id}/decision`);
    const bound = app.store.getConversationWithoutMessages(room.id);
    assert.equal(git(['branch', '--show-current'], bound.worktreePath), preview.branch);
    passed('workspace authorization card binds the exact preview in a disposable repository');

    // Exercise both JSON message send and real browser-generated multipart.
    await page.fill('#composer-input', 'Browser text acceptance');
    const textResult = await clickWrite('#send-button', `/api/conversations/${room.id}/messages`);
    assert.equal(app.store.getMessage(textResult.acceptedMessage.id).metadata.source, 'web-ui');
    await idle(room.id);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZfkAAAAASUVORK5CYII=', 'base64');
    const imageResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/conversations/${room.id}/images` && response.request().method() === 'POST');
    await page.locator('input[type="file"][accept*="image"]').setInputFiles({ name: 'one.png', mimeType: 'image/png', buffer: png });
    assert.equal((await imageResponse).status(), 200);
    await page.fill('#composer-input', 'Browser image acceptance');
    const imageResult = await clickWrite('#send-button', `/api/conversations/${room.id}/messages`);
    assert.ok(app.store.getMessage(imageResult.acceptedMessage.id).metadata.contentBlocks.some(block => block.type === 'image'));
    await idle(room.id);
    assert.ok(executions >= 2);
    passed('text and image messages persist; multipart includes browser boundary and CSRF');

    await page.click('#drawerToggle');
    await page.click('#tab-goal');
    await page.fill('#session-goal-objective', 'Browser Goal acceptance');
    await page.fill('#session-goal-acceptance', 'Browser changes persist | Read back SQLite');
    await clickWrite('#session-goal-save-button', `/api/conversations/${room.id}/goal`);
    await clickWrite('#session-goal-pause-button', `/api/conversations/${room.id}/goal`);
    await page.fill('#session-goal-objective', 'Browser Goal revised');
    await clickWrite('#session-goal-save-button', `/api/conversations/${room.id}/goal`);
    assert.equal(app.store.getConversationWithoutMessages(room.id).metadata.sessionGoal.objective, 'Browser Goal revised');
    // M3: exercise real confirmation controls, not only mocked window.confirm.
    const suggest = command => app.agentToolBridge.handleSuggestGoal({ invocationId: invocation.invocationId, callbackToken: invocation.callbackToken, ...command });
    const proposal = suggest({ action: 'pause', reason: 'Browser milestone review' }).proposal;
    await page.waitForSelector('#session-goal-proposal-card:not(.hidden)');
    await page.fill('#session-goal-objective', 'Browser Goal supersession');
    acceptDialogs = false;
    const beforeCancel = structuredClone(app.store.getConversationWithoutMessages(room.id).metadata);
    const writesBeforeCancel = writes.length;
    await page.click('#session-goal-save-button');
    await page.waitForFunction(() => !document.querySelector('#session-goal-save-button').disabled);
    assert.deepEqual(app.store.getConversationWithoutMessages(room.id).metadata, beforeCancel);
    assert.equal(writes.length, writesBeforeCancel);
    acceptDialogs = true;
    const superseded = await clickWrite('#session-goal-save-button', `/api/conversations/${room.id}/goal`);
    assert.equal(superseded.ruling.outcome, 'superseded');
    assert.equal(superseded.ruling.proposalId, proposal.id);
    assert.equal(app.store.listSessionGoalRulings(room.id).at(-1).proposalId, proposal.id);
    passed('pending proposal confirmation cancels without writes and supersedes with durable audit');

    await page.waitForSelector('#session-goal-bind-planner-button:not(.hidden)');
    acceptDialogs = false;
    const beforeAdoption = structuredClone(app.store.getConversationWithoutMessages(room.id).metadata);
    await page.click('#session-goal-bind-planner-button');
    assert.deepEqual(app.store.getConversationWithoutMessages(room.id).metadata, beforeAdoption);
    acceptDialogs = true;
    const adopted = await clickWrite('#session-goal-bind-planner-button', `/api/conversations/${room.id}/goal`);
    assert.equal(adopted.goal.goalId, beforeAdoption.sessionGoal.goalId);
    assert.equal(adopted.goal.revision, beforeAdoption.sessionGoal.revision + 1);
    assert.equal(app.store.getConversationWithoutMessages(room.id).metadata.sessionGoalPlannerBinding.plannerName, 'Isolated Test Planner');
    assert.deepEqual(adopted.ruling, beforeAdoption.sessionGoalRuling);
    suggest({ action: 'pause', reason: 'Planner-bound draft' });
    assert.throws(() => suggest({ action: 'accept' }), error => error.statusCode === 403 && error.code === 'goal_planner_ruling_required');
    passed('user adoption confirms, preserves Goal and ruling, and blocks agent verdicts');
    await page.screenshot({ path: path.join(output, 'goal-adopted.png') });
    await clickWrite('#session-goal-clear-button', `/api/conversations/${room.id}/goal`);
    assert.equal(app.store.getConversationWithoutMessages(room.id).metadata.sessionGoalPlannerBinding, undefined);
    passed('Goal create, pause, revise and clear buttons succeed');
    await page.screenshot({ path: path.join(output, 'goal-writes.png') });

    await page.click('#tab-settings');
    await page.fill('#conversation-title-input', 'Browser renamed');
    await clickWrite('#rename-conversation-button', `/api/conversations/${room.id}`, 'PUT');
    await clickWrite('#save-conversation-button', `/api/conversations/${room.id}`, 'PUT');
    assert.equal(app.store.getConversationWithoutMessages(room.id).title, 'Browser renamed');
    passed('conversation rename persists through settings');

    await page.goto(base + '/personas.html');
    await page.click('#show-provider-management');
    await page.locator('#provider-list button[data-id="browser-fixture"]').click();
    await page.click('#remove-provider');
    await clickWrite('#confirm-remove-provider', '/api/model-providers/browser-fixture', 'DELETE');
    passed('provider removal confirmation succeeds');

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(externalRequests, []);
    assert.ok(writes.length >= 16);
    assert.ok(writes.every(write => write.status >= 200 && write.status < 300 && write.csrfPresent && write.originMatches));
    assert.ok(writes.every(write => /\/images$/.test(write.path)
      ? /^multipart\/form-data; boundary=/.test(write.contentType) : /^application\/json/.test(write.contentType)));
    passed('all actual browser mutations are successful and carry Origin, route Content-Type and CSRF');
  });
