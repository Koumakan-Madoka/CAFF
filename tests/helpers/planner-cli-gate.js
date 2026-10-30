// Synthetic credentials and finish receiver ONLY. No production wakeup route,
// scheduler, transcript store, real Claude or external model is started here.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { createTestServerApp } = require('./server-app');
const { createInMemoryPlannerCredential } = require('../../build/server/domain/security/planner-credential');
const { applySessionGoalAction, proposeSessionGoalAction } = require('../../build/server/domain/conversation/session-goal');
const { buildPlannerWakeupCandidate } = require('../../build/server/domain/runtime/embedded-planner-wakeup-command');
const { isolateExternalIntegrations } = require('./external-integrations');

async function createPlannerCliGate() {
  isolateExternalIntegrations();
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'caff-planner-cli-gate-')));
  const token = randomBytes(32).toString('base64url'), attemptId = randomUUID();
  const credential = createInMemoryPlannerCredential({ token, plannerName: 'Synthetic Gate Planner' });
  const model = { provider: 'synthetic', model: 'synthetic', runtimeResolvable: true, input: ['text'], supportedThinkingLevels: ['off'] };
  const app = createTestServerApp({ host: '127.0.0.1', port: 0, agentDir: root, sqlitePath: path.join(root, 'test.sqlite'), projectDir: root, uploadsDir: path.join(root, 'uploads'),
    plannerCredential: credential, embeddedPlanner: { enabled: false }, modelCatalog: { getOptions: () => [model], invalidate() {} }, executeConversationAgent: async () => ({ stopTurn: true }) });
  app.store.saveCustomRoleConfig({ id: 'synthetic-owner', name: 'Synthetic Owner', personaPrompt: 'Synthetic only', provider: model.provider, model: model.model });
  const room = app.store.createConversation({ title: 'Synthetic CLI gate', participants: ['synthetic-owner'] });
  const goal = applySessionGoalAction(app.store, room.id, { action: 'set', goalId: null, goalRevision: 0, objective: 'Synthetic CLI policy gate', status: 'paused', owner: { agentId: 'synthetic-owner' },
    acceptanceCriteria: [{ id: 'test', statement: 'Synthetic only', verifyBy: 'Gate assertions' }], ruledBy: credential.identity }).goal;
  const proposal = proposeSessionGoalAction(app.store, room.id, { action: 'pause', reason: 'Synthetic pending item' }, { agentId: 'synthetic-owner', agentName: 'Synthetic Owner' }).proposal;
  const sequence = app.store.listPlannerAttention({ conversationId: room.id, after: 0, limit: 100, status: 'unresolved' }).items[0].sequence;
  const route = `/api/conversations/${room.id}/planner/wakeups/${attemptId}/finish`;
  const original = app.server.listeners('request'); let receipt = null;
  app.server.removeAllListeners('request');
  app.server.on('request', async (req, res) => {
    if (req.url !== route) { for (const listener of original) listener.call(app.server, req, res); return; }
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.method !== 'POST' || req.headers['x-caff-principal'] !== 'planner' || req.headers.authorization !== 'Bearer ' + token) return reply(401, { code: 'synthetic_gate_auth_required' });
    try {
      let text = ''; for await (const b of req) { text += b; if (Buffer.byteLength(text) > 16384) throw new Error(); }
      const body = JSON.parse(text), item = body?.items?.[0];
      if (Object.keys(body).join() !== 'items' || !Array.isArray(body.items) || body.items.length !== 1 || Object.keys(item).sort().join() !== 'disposition,reason,sequence'
        || item.sequence !== sequence || !['handled','needs_user','no_action'].includes(item.disposition) || typeof item.reason !== 'string' || !item.reason.trim()
        || [...item.reason].length > 500 || /[\p{Cc}\u2028\u2029]/u.test(item.reason)) throw new Error();
      if (receipt && JSON.stringify(receipt) !== JSON.stringify(body)) return reply(409, { code: 'synthetic_gate_receipt_conflict' });
      receipt = body;
      reply(200, { synthetic: true, durable: false, attemptId, items: receipt.items });
    } catch { reply(400, { code: 'synthetic_gate_receipt_invalid' }); }
  });
  await new Promise(resolve => app.start(resolve));
  const port = app.server.address().port;
  if ([3100, 3200].includes(port)) { await new Promise(resolve => app.close(resolve)); throw new Error('Reserved instance port'); }
  const credentialPath = path.join(root, 'synthetic-planner.json');
  fs.writeFileSync(credentialPath, JSON.stringify({ version: 1, plannerId: 'local-planner', plannerName: 'Synthetic Gate Planner', token, issuedAt: new Date().toISOString() }), { mode: 0o600 });
  const env = { CAFF_BASE_URL: `http://127.0.0.1:${port}`, CAFF_ROOM_ID: room.id, CAFF_PLANNER_CREDENTIAL_FILE: credentialPath };
  const candidate = buildPlannerWakeupCandidate({ sessionId: randomUUID(), appendPrompt: 'Synthetic candidate only. No approval or policy verification is implied.' });
  let closed = false;
  return { app, root, env, room, goal, proposal, attemptId, sequence, candidate, get receipt() { return receipt; },
    async close() { if (closed) return; closed = true; await new Promise(resolve => app.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); } };
}
module.exports = { createPlannerCliGate };
