const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createAgentToolBridge } = require('../../build/server/domain/runtime/agent-tool-bridge');
const { createConversationSpawnService } = require('../../build/server/domain/conversation/conversation-spawn');
const { withTempDir } = require('../helpers/temp-dir');

const SOURCE_PATH = path.join(__dirname, '../../public/chat/plan-panel.js');

const FIXTURE_IDS = [
  'plan-drawer',
  'plan-panel-status',
  'plan-refresh-button',
  'plan-add-node-button',
  'plan-save-button',
  'plan-activate-button',
  'plan-revert-button',
  'plan-expand-button',
  'plan-issues',
  'plan-graph',
  'plan-editor',
  'plan-node-id',
  'plan-node-title',
  'plan-node-goal',
  'plan-node-status',
  'plan-node-kind',
  'plan-node-branch',
  'plan-node-deps',
  'plan-node-spawned',
  'plan-node-delete-button',
  'plan-expand-overlay',
  'plan-expand-close-button',
  'plan-graph-expanded',
  'plan-zoom-in-button',
  'plan-zoom-out-button',
  'plan-zoom-reset-button',
];

function buildWindow() {
  const inputs = ['plan-node-title', 'plan-node-branch'];
  const textareas = ['plan-node-goal'];
  const selects = ['plan-node-status', 'plan-node-kind'];
  const fixture = FIXTURE_IDS.map((id) => {
    if (inputs.includes(id)) {
      return `<input id="${id}" />`;
    }
    if (textareas.includes(id)) {
      return `<textarea id="${id}"></textarea>`;
    }
    if (selects.includes(id)) {
      const options = id === 'plan-node-status'
        ? '<option value="pending">待办</option><option value="doing">进行</option><option value="done">完成</option><option value="blocked">阻塞</option>'
        : '<option value="work">work</option><option value="merge">merge</option>';
      return `<select id="${id}">${options}</select>`;
    }
    return `<div id="${id}"></div>`;
  }).join('\n');
  const dom = new JSDOM(`<!doctype html><html><body>${fixture}</body></html>`, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  });
  dom.window.eval(fs.readFileSync(SOURCE_PATH, 'utf8'));
  dom.window.confirm = () => true;
  return dom.window;
}

function domRefs(window) {
  const refs = {};
  for (const id of FIXTURE_IDS) {
    const key = id.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    refs[key] = window.document.getElementById(id);
  }
  return refs;
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function demoDoc() {
  return {
    nodes: [
      {
        id: 'n1',
        title: '存储与迁移',
        goal: 'plans 表 + conversations.branch',
        status: 'pending',
        depends_on: [],
        branch: 'feat/dag-planning/root',
        kind: 'work',
      },
      {
        id: 'n2',
        title: '并行实现 A',
        goal: 'plan API + shared 校验',
        status: 'pending',
        depends_on: ['n1'],
        branch: 'feat/dag-planning/root/n2-api',
        kind: 'work',
      },
      {
        id: 'n3',
        title: '并行实现 B',
        goal: 'propose-plan tool + skill',
        status: 'pending',
        depends_on: ['n1'],
        branch: 'feat/dag-planning/root/n3-tool',
        kind: 'work',
      },
      {
        id: 'n4',
        title: '合并',
        goal: 'merge 节点汇合并行分支',
        status: 'pending',
        depends_on: ['n2', 'n3'],
        branch: 'feat/dag-planning/root/merge',
        kind: 'merge',
      },
    ],
  };
}

function bindProjectScope(store, conversationId, projectScopeId) {
  store.db.prepare(`
    UPDATE chat_conversations
    SET project_scope_id = ?
    WHERE id = ?
  `).run(projectScopeId, conversationId);
}

function createPanel(window, conversationId, store) {
  const refs = domRefs(window);
  const state = { currentConversation: { id: conversationId } };
  const controller = window.CaffChat.createPlanPanelController({
    state,
    dom: refs,
    helpers: {
      async fetchPlan(id) {
        return store.getPlanForConversation(id);
      },
      async savePlan(id, body) {
        return store.savePlanForConversation(id, body);
      },
      async activatePlan(id) {
        return store.activatePlanForConversation(id);
      },
      async revertPlan(id) {
        return store.revertPlanForConversation(id);
      },
      async openConversation() {},
    },
    showToast() {},
  });
  controller.bindEvents();
  return { controller, refs, state };
}

async function renderPanel(panel) {
  panel.controller.render();
  await flush();
  await flush();
}

function registerPlanInvocation(bridge, store, conversation, agent) {
  const assistantMessage = store.createMessage({
    id: `dag-demo-assistant-${conversation.id}`,
    conversationId: conversation.id,
    turnId: `dag-demo-turn-${conversation.id}`,
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: 'Updating plan status...',
    status: 'streaming',
  });
  const fullConversation = store.getConversation(conversation.id);
  return bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: conversation.id,
      turnId: assistantMessage.turnId,
      agentId: agent.id,
      agentName: agent.name,
      assistantMessageId: assistantMessage.id,
      conversationAgents: fullConversation.agents,
      stage: { status: 'running', replyLength: 0, preview: '', lastTextDeltaAt: null },
      turnState: { conversationId: conversation.id, turnId: assistantMessage.turnId, stopRequested: false },
    })
  );
}

test('DAG planning POC demo baseline: mock write → root render → child share → tool update refreshes both panels', async (t) => {
  const tempDir = withTempDir('caff-dag-planning-demo-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'demo.sqlite') });
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = store.saveCustomRoleConfig({
    id: 'dag-demo-agent',
    name: 'DAG Demo Agent',
    personaPrompt: 'Keep the plan truthful.',
  });
  const root = store.createConversation({
    id: 'dag-demo-root',
    title: 'DAG Demo Root',
    participants: [{ agentId: agent.id }],
  });
  bindProjectScope(store, root.id, 'project-dag-demo');

  // Step 1: mock plan JSON written into storage (root-owned, tree-shared).
  const created = store.savePlanForConversation(root.id, { doc: demoDoc() });
  assert.equal(created.ownerConversationId, root.id);
  assert.equal(created.plan.status, 'draft');
  assert.equal(created.plan.version, 1);
  assert.equal(created.plan.doc.nodes.length, 4);

  // Step 2: root conversation panel renders the graph from storage.
  const rootWindow = buildWindow();
  const rootPanel = createPanel(rootWindow, root.id, store);
  await renderPanel(rootPanel);
  assert.equal(rootPanel.refs.planGraph.querySelectorAll('.plan-node').length, 4);
  assert.equal(rootPanel.refs.planGraph.querySelectorAll('.plan-edge').length, 4);
  assert.match(rootPanel.refs.planPanelStatus.textContent, /v1/);
  assert.match(rootPanel.refs.planPanelStatus.textContent, /草稿/);
  assert.ok(rootPanel.refs.planGraph.querySelector('.plan-node.kind-merge[data-node-id="n4"]'));

  // Step 3: spawn a child conversation; its panel resolves and renders the same root plan.
  const spawnService = createConversationSpawnService({
    store,
    validateParticipants(input) {
      return store.normalizeConversationParticipantsInput(input);
    },
    resolveProject(projectScopeId) {
      return projectScopeId === 'project-dag-demo' ? { id: projectScopeId, name: 'DAG Demo Project' } : null;
    },
  });
  const spawned = spawnService.spawn(root.id, {
    title: 'DAG Demo Child',
    projectScopeId: 'project-dag-demo',
    participants: [{ agentId: agent.id }],
    primaryAgentId: agent.id,
    initialMessage: '执行 n2：plan API + shared 校验',
    clientRequestId: 'dag-demo-spawn-1',
  });
  assert.equal(spawned.conversation.parentConversationId, root.id);
  assert.equal(spawned.conversation.originConversationId, root.id);

  const fromChild = store.getPlanForConversation(spawned.conversation.id);
  assert.equal(fromChild.ownerConversationId, root.id);
  assert.equal(fromChild.plan.id, created.plan.id);

  const childWindow = buildWindow();
  const childPanel = createPanel(childWindow, spawned.conversation.id, store);
  await renderPanel(childPanel);
  assert.equal(childPanel.refs.planGraph.querySelectorAll('.plan-node').length, 4);
  assert.match(childPanel.refs.planPanelStatus.textContent, /v1/);
  assert.equal(
    childPanel.refs.planGraph.querySelector('[data-node-id="n2"] .plan-node-title').textContent,
    rootPanel.refs.planGraph.querySelector('[data-node-id="n2"] .plan-node-title').textContent
  );

  // User starts execution: structure locks on both panels (lifecycle gate).
  const activated = store.activatePlanForConversation(root.id);
  const activatePayload = {
    conversationId: root.id,
    ownerConversationId: activated.ownerConversationId,
    plan: activated.plan,
  };
  rootPanel.controller.applyPlanEvent(activatePayload);
  childPanel.controller.applyPlanEvent(activatePayload);
  assert.equal(activated.plan.status, 'active');
  assert.equal(activated.plan.version, 2);
  assert.equal(rootPanel.refs.planAddNodeButton.disabled, true);
  assert.equal(childPanel.refs.planAddNodeButton.disabled, true);
  assert.match(rootPanel.refs.planPanelStatus.textContent, /执行中/);
  assert.match(childPanel.refs.planPanelStatus.textContent, /执行中/);

  // Step 4: model updates the graph through propose-plan (status-only while active);
  // the broadcast payload refreshes both panels.
  const toolEvents = [];
  const bridge = createAgentToolBridge({
    store,
    broadcastEvent(type, payload) {
      toolEvents.push({ type, payload });
    },
  });
  const invocation = registerPlanInvocation(bridge, store, root, agent);
  const statusDoc = demoDoc();
  statusDoc.nodes[0].status = 'done';
  statusDoc.nodes[1].status = 'doing';

  const toolResult = bridge.handleProposePlan({
    invocationId: invocation.invocationId,
    callbackToken: invocation.callbackToken,
    doc: statusDoc,
    version: activated.plan.version,
  });
  assert.equal(toolResult.ok, true);
  assert.equal(toolResult.plan.status, 'active');
  assert.equal(toolResult.plan.version, 3);

  const planEvent = toolEvents.find((event) => event.type === 'conversation_plan_updated');
  assert.ok(planEvent, 'propose-plan must broadcast conversation_plan_updated');
  rootPanel.controller.applyPlanEvent(planEvent.payload);
  childPanel.controller.applyPlanEvent(planEvent.payload);
  await flush();

  for (const panel of [rootPanel, childPanel]) {
    assert.match(panel.refs.planPanelStatus.textContent, /v3/);
    assert.ok(panel.refs.planGraph.querySelector('.plan-node.status-done[data-node-id="n1"]'));
    assert.ok(panel.refs.planGraph.querySelector('.plan-node.status-doing[data-node-id="n2"]'));
    assert.ok(panel.refs.planGraph.querySelector('.plan-node.status-pending[data-node-id="n3"]'));
  }

  const persisted = store.getPlanForConversation(spawned.conversation.id);
  assert.equal(persisted.ownerConversationId, root.id);
  assert.equal(persisted.plan.version, 3);
  assert.equal(persisted.plan.doc.nodes[0].status, 'done');
  assert.equal(persisted.plan.doc.nodes[1].status, 'doing');
});
