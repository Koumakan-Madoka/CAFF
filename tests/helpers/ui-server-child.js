// Explicit synthetic application for the opt-in real-browser verifier.
// Never selected by production environment configuration.
const path = require('node:path');
const { createTestServerApp } = require('./server-app');
const { isolateExternalIntegrations } = require('./external-integrations');
isolateExternalIntegrations();
const model = { key: 'openai\u001fgpt-5', provider: 'openai', model: 'gpt-5', label: 'UI synthetic model',
  input: ['text', 'image'], runtimeResolvable: true, supportedThinkingLevels: ['off'] };
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir || !process.env.PI_SQLITE_PATH) throw new Error('UI verifier requires isolated storage paths');
const app = createTestServerApp({ host: '127.0.0.1', port: Number(process.env.CHAT_APP_PORT || 0),
  agentDir, sqlitePath: process.env.PI_SQLITE_PATH, projectDir: agentDir, uploadsDir: path.join(agentDir, 'uploads'),
  modelCatalog: { getOptions: () => [model], invalidate() {} },
  executeConversationAgent: async () => ({ stopTurn: true, terminationReason: 'synthetic-ui-verification' }) });
app.store.saveCustomRoleConfig({ id: 'ui-verification-role', name: 'UI 验证角色', personaPrompt: 'Synthetic UI verification only',
  provider: model.provider, model: model.model });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => app.close(() => { process.exitCode = 0; }));
app.start(() => console.info('Synthetic UI verifier listening at http://127.0.0.1:' + app.server.address().port));
