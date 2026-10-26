const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createTestServerApp } = require('./server-app');
const { isolateExternalIntegrations } = require('./external-integrations');
isolateExternalIntegrations();

async function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-planner-ws-'));
  const cli = path.join(root, 'fake cli.cjs');
  fs.copyFileSync(path.join(__dirname, '../fixtures/fake-planner-cli.cjs'), cli);
  const app = createTestServerApp({ host: extra.bindHost || '127.0.0.1', port: 0, agentDir: root, sqlitePath: path.join(root, 'chat.sqlite'), projectDir: root, uploadsDir: path.join(root, 'uploads'),
    ...(extra.plannerCredential ? { plannerCredential: extra.plannerCredential } : {}),
    embeddedPlanner: { enabled: true, cliPath: cli, env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, SystemRoot: process.env.SystemRoot }, authTimeoutMs: 100, ...extra },
    modelCatalog: { getOptions: () => [], invalidate() {} }, executeConversationAgent: async () => ({ stopTurn: true }) });
  const sockets = []; let stopped = false;
  async function close() { if (!stopped) { stopped = true; await new Promise(resolve => app.close(resolve)); } }
  t.after(async () => { sockets.forEach(s => s.terminate()); await close(); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise(resolve => app.start(resolve));
  const port = app.server.address().port, base = `http://127.0.0.1:${port}`;
  const boot = await (await fetch(base + '/api/bootstrap')).json();
  const projects = await (await fetch(base + '/api/projects')).json();
  const projectId = projects.activeProjectId || projects.projects?.[0]?.id;
  const agent = app.store.saveCustomRoleConfig({ id: 'synthetic', name: 'Synthetic', personaPrompt: 'test', provider: 'test', model: 'test' });
  const room = app.store.createConversation({ title: 'Synthetic terminal', projectScopeId: projectId, participants: [{ agentId: agent.id }] });
  function connect(headers = { Origin: base }, suffix = '', socketOptions = {}) {
    const s = new WebSocket(`ws://127.0.0.1:${port}/api/conversations/${room.id}/planner/terminal${suffix}`, { ...socketOptions, headers });
    sockets.push(s); return s;
  }
  return { app, root, port, base, boot, room, connect, close, auth: { type: 'auth', version: 1, token: boot.apiSecurity.csrfToken, cols: 120, rows: 30 } };
}
async function closed(ws, send) {
  const messages = []; ws.on('message', x => messages.push(x.toString()));
  const end = once(ws, 'close'); await once(ws, 'open'); if (send) send(ws);
  const [code] = await end; return { code, messages };
}
async function rejected(ws) {
  return new Promise(resolve => { ws.on('unexpected-response', (_, res) => { res.resume(); resolve(res.statusCode); }); ws.on('error', () => {}); });
}
module.exports = { fixture, closed, rejected };
