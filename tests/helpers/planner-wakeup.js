const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { randomBytes, randomUUID } = require('node:crypto');
const { createTestServerApp } = require('./server-app');
const { createInMemoryPlannerCredential } = require('../../build/server/domain/security/planner-credential');
const { applySessionGoalAction } = require('../../build/server/domain/conversation/session-goal');
const { EmbeddedPlannerRepository } = require('../../build/storage/chat/embedded-planner.repository');
const { PlannerWakeupRepository } = require('../../build/storage/chat/planner-wakeup.repository');
const { createProjectManager } = require('../../build/lib/project-manager');
const { isolateExternalIntegrations } = require('./external-integrations');
isolateExternalIntegrations();
async function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-wakeup-http-')), token = randomBytes(32).toString('base64url'), file = path.join(root, 'synthetic-credential.json'), cli = path.join(root, 'fake-wakeup.cjs');
  fs.writeFileSync(file, JSON.stringify({ version: 1, plannerId: 'local-planner', plannerName: 'Synthetic', token, issuedAt: new Date().toISOString() }), { mode: 0o600 });
  fs.copyFileSync(path.join(__dirname, '../fixtures/fake-wakeup-cli.cjs'), cli);
  if (extra.version)
    fs.writeFileSync(path.join(root, 'fake-version'), extra.version);
  if (extra.mode)
    fs.writeFileSync(path.join(root, 'fake-mode'), extra.mode);
  const memory = createInMemoryPlannerCredential({ token, plannerName: 'Synthetic' }), credential = { ...memory, path: file };
  const sourceEnv={ PATH: process.env.PATH, HOME: root, USERPROFILE: root, SystemRoot: process.env.SystemRoot, ANTHROPIC_API_KEY: extra.expandingRedaction?'goal':'provider-sentinel', CLAUDE_CODE_SESSION_ID: 'session-sentinel', CAFF_CHAT_TOKEN: 'invocation-sentinel', HTTP_PROXY: 'http://proxy-user:proxy-pass@invalid' };
  const app = createTestServerApp({ host: '127.0.0.1', port: 0, agentDir: root, sqlitePath: path.join(root, 'chat.sqlite'), projectDir: root, uploadsDir: path.join(root, 'uploads'), plannerCredential: credential,
    modelCatalog: { getOptions: () => [{ key: 'openai\u001fgpt-5', provider: 'openai', model: 'gpt-5', family: 'gpt', runtimeResolvable: true, input: ['text'], supportedThinkingLevels: ['off'] }], invalidate() { } }, executeConversationAgent: async (input) => { const reply = app.store.createMessage({ conversationId: input.conversationId, turnId: input.turnState.turnId, agentId: input.agent.id, senderName: input.agent.name, role: 'assistant', content: 'Synthetic completed reply', status: 'completed' }); input.completedReplies.push(reply); return { stopTurn: true }; },
    embeddedPlanner: { enabled: true, cliPath: cli, env: sourceEnv, retryMs: 30, ...extra } });
  app.store.saveCustomRoleConfig({ id: 'owner', name: 'Owner', personaPrompt: 'Synthetic', provider: 'openai', model: 'gpt-5' });
  const projectId = createProjectManager({ agentDir: root, initialProjectDir: root }).listProjects()[0].id;
  const room = app.store.createConversation({ title: 'Wake-up fixture', projectScopeId: projectId, participants: ['owner'] });
  const goal = applySessionGoalAction(app.store, room.id, { action: 'set', goalId: null, goalRevision: 0, status: 'paused', objective: 'Synthetic wake-up', owner: { agentId: 'owner' }, acceptanceCriteria: [{ id: 'c', statement: 'Synthetic', verifyBy: 'Assertions' }], ruledBy: credential.identity }).goal;
  const sessions = new EmbeddedPlannerRepository(app.store);
  const claim = sessions.claim(room.id);
  sessions.release(room.id, claim.leaseId);
  let records = new PlannerWakeupRepository(app.store);
  const append = (kind = 'proposal_pending', overrides = {}) => app.store.plannerAttentionRepository.append({ conversationId: room.id, goalId: goal.goalId, goalRevision: goal.revision, kind, sourceId: randomUUID(), summary: 'Synthetic pending', createdAt: new Date().toISOString(), ...overrides });
  if (extra.preseed) {
    records.toggle(room.id, true);
    append();
  }
  let closed = false;
  async function close() { if (!closed) {
    closed = true;
    await new Promise(resolve => app.close(resolve));
  } }
  t.after(async () => { await close(); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise(resolve => app.start(resolve));
  const port = app.server.address().port;
  if ([3100, 3200].includes(port))
    throw new Error('Reserved port');
  const base = `http://127.0.0.1:${port}`, boot = await (await fetch(base + '/api/bootstrap')).json();
  async function call(suffix, body, planner = false, more = {}) { const res = await fetch(base + `/api/conversations/${room.id}/planner/` + suffix, { method: body === undefined ? 'GET' : suffix === 'wakeups' ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json', ...(planner ? { Authorization: 'Bearer ' + token, 'X-CAFF-Principal': 'planner' } : { Origin: base, 'X-CAFF-CSRF-Token': boot.apiSecurity.csrfToken }), ...more }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }); return { status: res.status, body: await res.json() }; }
  async function wait(check, ms = 15000) { const start = Date.now(); for (;;) {
    const value = await check();
    if (value)
      return value;
    if (Date.now() - start > ms)
      throw new Error('Synthetic wake-up condition timed out');
    await new Promise(r => setTimeout(r, 20));
  } }
  return { root, file, token, app, base, boot, room, goal, sessions, records, append, call, wait, close, launches: () => fs.existsSync(path.join(root, 'fake-wakeups.jsonl')) ? fs.readFileSync(path.join(root, 'fake-wakeups.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x)) : [] };
}
module.exports = { fixture };
