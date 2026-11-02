// Manual synthetic browser check (no agent/model/real collection).
// Run after npm run build: node scripts/badcase-capture/verify-sealing-ui.cjs
// Uses an installed Playwright Chromium, loopback port 0 and disposable SQLite/CAS.
// This exercises the production panel/controller, not the complete app shell.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '../..');
const { chromium } = require('playwright-core');
const load = file => require(path.join(repo, 'build', file));
const { createBadcaseFlagsController } = load('server/api/badcase-flags-controller');
const { createBadcaseFlagService } = load('server/domain/runtime/badcase-capture/badcase-flags');
const { createBadcaseSealingService } = load('server/domain/runtime/badcase-capture/sealing-service');
const { createCaptureStore } = load('server/domain/runtime/badcase-capture/capture-store');
const { createChatAppStore } = load('lib/chat-app-store');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-sealing-browser-'));
const dbOptions = { agentDir: root, sqlitePath: path.join(root, 'synthetic.sqlite') };
const captureRoot = path.join(root, 'cas'), captureStore = createCaptureStore({ captureRoot });
let chat, authority, controller, browser, server;
const calls = [], errors = [];
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><script src="/shared/api-client.js"></script><script src="/shared/badcase-flags.js"></script><button id="open">标记问题</button><dialog id="panel"></dialog><script>const panel=CaffShared.createBadcaseFlagPanel({root:document.querySelector('dialog'),fetchJson:CaffShared.fetchJson}); document.querySelector('#open').onclick=()=>panel.open({projectId:'project-a',conversationId:'room-a',messageId:'message-a'});</script></html>`;
function rebuild() {
  const flags = createBadcaseFlagService({ captureRoot, captureStore, chatStore: chat });
  controller = createBadcaseFlagsController({ service: flags,
    sealingService: createBadcaseSealingService({ flags, captureStore, databasePath: dbOptions.sqlitePath }),
    projectManager: { listProjects: () => [{ id: 'project-a' }] }, host: '127.0.0.1',
    getAuthority: () => authority, csrfToken: 'synthetic-browser-only' });
}
(async () => {
  try {
    chat = createChatAppStore(dbOptions);
    chat.saveCustomRoleConfig({ id: 'agent-a', name: 'Synthetic', personaPrompt: 'not executed' });
    chat.createConversation({ id: 'room-a', title: 'Synthetic', participants: ['agent-a'], projectScopeId: 'project-a' });
    chat.createMessage({ id: 'message-a', conversationId: 'room-a', role: 'assistant', status: 'completed',
      agentId: 'agent-a', turnId: 'turn-a', taskId: 'task-a', runId: 1, content: 'not archived', metadata: { badcaseCheckpointId: 'cp-a' } });
    load('lib/sqlite-store').createSqliteRunStore({ agentDir: root, db: chat.db });
    chat.db.prepare(`INSERT INTO runs (id, agent_dir, cwd, prompt, prompt_length, status, started_at, task_id, assistant_errors_json)
      VALUES (1, '/not-read', '/not-read', 'not-read', 8, 'succeeded', '2026-01-01', 'task-a', '[]')`).run();
    chat.db.prepare(`INSERT INTO a2a_tasks (id, run_id, kind, status, metadata_json, output_text, created_at, updated_at)
      VALUES ('task-a', 1, 'conversation_agent_reply', 'succeeded', ?, 'RAW-NOT-ARCHIVED', '2026-01-01', '2026-01-01')`)
      .run(JSON.stringify({ conversationId: 'room-a', turnId: 'turn-a', agentId: 'agent-a' }));
    captureStore.saveCheckpoint('project-a', { schemaVersion: 1, projectId: 'project-a', conversationId: 'room-a',
      checkpointId: 'cp-a', turnId: 'turn-a', agentId: 'agent-a', files: {},
      replayInput: { deliveryMode: 'fresh', complete: false, incompleteReasons: ['synthetic'], harness: { skillSnapshots: [] } } });
    captureStore.savePolicy({ ...captureStore.loadPolicy('project-a'), stagingQuotaBytes: 1 });
    server = http.createServer(async (req, res) => {
      const pathname = new URL(req.url, 'http://test').pathname;
      const json = (data, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      try {
        if (pathname === '/api/bootstrap') return json({ localAdmin: { modelProviders: { enabled: true, csrfToken: 'synthetic-browser-only' } } });
        if (pathname.endsWith('/badcase-flag')) { calls.push(req.method); if (await controller({ req, res, pathname })) return; }
        if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
        if (['/shared/api-client.js', '/shared/badcase-flags.js'].includes(pathname)) {
          res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync(path.join(repo, 'public', pathname.slice(1))));
        }
        res.writeHead(404); res.end();
      } catch (error) { json({ issues: error.issues || [] }, error.statusCode || 500); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    authority = `127.0.0.1:${server.address().port}`; rebuild();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.route('**/*', route => new URL(route.request().url()).host === authority ? route.continue() : route.abort());
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    const action = name => page.locator(`[data-flag-action="${name}"]`);
    const waitStatus = text => page.waitForFunction(value => document.querySelector('[data-flag-status]').textContent.includes(value), text);
    await page.goto(`http://${authority}/`); await page.locator('#open').click(); await waitStatus('尚未标记');
    assert.equal(calls.filter(x => x === 'POST').length, 0);
    await page.locator('[name="actual"]').fill('合成问题'); await page.locator('[name="expected"]').fill('合成期望');
    let confirmations = 0;
    page.once('dialog', dialog => { confirmations++; void dialog.dismiss(); });
    await action('submit').click(); assert.equal(calls.filter(x => x === 'POST').length, 0);
    page.once('dialog', dialog => { confirmations++; void dialog.accept(); });
    await action('submit').click(); await waitStatus('现场保存失败');
    assert.match(await page.locator('[data-flag-status]').textContent(), /seal_quota_exceeded/);
    assert.equal(await page.locator('[name="actual"]').getAttribute('readonly'), '');
    captureStore.savePolicy({ ...captureStore.loadPolicy('project-a'), stagingQuotaBytes: 10 * 1024 * 1024 });
    page.on('dialog', dialog => { confirmations++; void dialog.dismiss(); });
    await action('submit').click(); await waitStatus('现场已保存');
    assert.equal(confirmations, 2, 'retry must not ask for a second seal confirmation');
    assert.match(await page.locator('[data-flag-status]').textContent(), /材料不完整/);
    assert.equal(await action('submit').isDisabled(), true);
    const before = captureStore.computeUsage('project-a');
    await action('close').click(); chat.close(); chat = createChatAppStore(dbOptions); rebuild();
    await page.reload(); await page.locator('#open').click(); await waitStatus('现场已保存');
    assert.equal(await page.locator('[name="actual"]').inputValue(), '合成问题');
    assert.equal(calls.filter(x => x === 'POST').length, 2);
    assert.deepEqual(captureStore.computeUsage('project-a'), before);
    assert.equal(captureStore.loadPolicy('project-a').status, 'disabled');
    const dir = path.join(captureRoot, 'projects/project-a/cases');
    assert.equal(fs.readdirSync(dir).length, 1);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'), /RAW-NOT-ARCHIVED/);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ pass: true, browser: browser.version(), platform: process.platform, calls, confirmations,
      cases: 1, limitations: 'Synthetic page/bootstrap/project/checkpoint; real panel, controller, SQLite and file worker. Service/SQLite reconstruction, not a full app process restart. No real collection/agent/model.' }));
  } finally {
    await browser?.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    chat?.close(); fs.rmSync(root, { recursive: true, force: true }); // only this script's disposable fixture
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
