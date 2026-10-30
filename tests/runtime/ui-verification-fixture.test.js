const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');
const { freePort } = require('../helpers/edge-cdp');
const { browserFetch } = require('../helpers/browser-fetch');

test('standalone UI fixture has a runnable synthetic role and isolated storage without provider credentials', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-ui-fixture-regression-'));
  const env = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'ComSpec', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const port = await freePort();
  Object.assign(env, { HOME: root, USERPROFILE: root, CAFF_DISABLE_ENV_LOCAL: '1', CHAT_APP_PORT: String(port),
    PI_CODING_AGENT_DIR: root, PI_SQLITE_PATH: path.join(root, 'ui.sqlite') });
  const child = spawn(process.execPath, [path.resolve(__dirname, '../helpers/ui-server-child.js')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let bootstrap;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, 'UI fixture exited unexpectedly');
    try { bootstrap = await (await fetch(base + '/api/bootstrap')).json(); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(bootstrap, logs);
  assert.equal(bootstrap.plannerTerminal.enabled, false);
  assert.equal(bootstrap.plannerTerminal.reasonCode, 'planner_terminal_disabled');
  const role = bootstrap.agents.find(agent => agent.id === 'ui-verification-role');
  assert.equal(role.availability.status, 'available');
  const projects = await (await fetch(base + '/api/projects')).json();
  const response = await browserFetch(base + '/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'UI fixture regression', projectScopeId: projects.projects[0].id, modeId: bootstrap.modes[0].id, participants: [{ agentId: role.id }] }) });
  assert.equal(response.status, 201);
  const room = (await response.json()).conversation;
  const sent = await browserFetch(base + `/api/conversations/${room.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'No real model must run' }) });
  assert.equal(sent.status, 200);
  assert.ok(fs.existsSync(path.join(root, 'ui.sqlite')));
  assert.equal(fs.existsSync(path.join(root, 'runtime', 'planner.json')), false);
});
