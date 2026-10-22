const fs = require('node:fs');
const path = require('node:path');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createSqliteRunStore } = require('../../build/lib/sqlite-store');
const { withTempDir } = require('./temp-dir');

function createInterruptedFixture(t) {
  const dir = withTempDir('caff-interrupted-runs-');
  const sqlitePath = path.join(dir, 'state.sqlite');
  const store = createChatAppStore({ agentDir: dir, sqlitePath });
  const runs = createSqliteRunStore({ agentDir: dir, sqlitePath, db: store.db });
  const agent = store.saveCustomRoleConfig({
    id: 'interrupted-agent', name: 'Interrupted Agent', personaPrompt: 'Synthetic test only.',
    provider: 'test-provider', model: 'test-model',
  });
  const room = store.createConversation({ id: 'interrupted-room', title: 'Interrupted', participants: [agent.id] });
  let sequence = 0;
  const cleanups = [];
  function seed(status = 'streaming', overrides = {}) {
    const id = `interrupted-${++sequence}`;
    const task = runs.createTask({ taskId: `${id}-task`, kind: 'conversation_agent_reply', status: 'running' });
    const run = runs.startRun({
      taskId: task.id, prompt: 'synthetic prompt', cwd: dir,
      provider: 'test-provider', model: 'test-model',
      metadata: { conversationId: room.id, agentId: agent.id },
    });
    runs.updateTask(task.id, { runId: run.runId });
    const message = store.createMessage({
      id, conversationId: room.id, turnId: `${id}-turn`, role: 'assistant', agentId: agent.id,
      content: 'Thinking...', status, taskId: task.id, runId: run.runId,
      metadata: { streaming: true, sentinel: 'preserve', provider: 'test-provider', model: 'test-model' },
      ...overrides,
    });
    return { message, runId: run.runId, taskId: task.id };
  }
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    try { runs.close(); } catch {}
    try { store.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, sqlitePath, store, runs, agent, room, seed, addCleanup: cleanup => cleanups.push(cleanup) };
}

module.exports = { createInterruptedFixture };
