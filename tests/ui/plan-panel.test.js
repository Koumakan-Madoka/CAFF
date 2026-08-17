const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

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
  'plan-node-verify',
  'plan-node-base-branch',
  'plan-node-worker',
  'plan-node-verifier',
  'plan-node-execution',
  'plan-history',
  'plan-history-list',
  'plan-node-deps',
  'plan-node-spawned',
  'plan-node-delete-button',
  'plan-expand-overlay',
  'plan-expand-close-button',
  'plan-graph-expanded',
  'plan-zoom-in-button',
  'plan-zoom-out-button',
  'plan-zoom-reset-button',
  'plan-drawer-zoom-in-button',
  'plan-drawer-zoom-out-button',
  'plan-drawer-zoom-fit-button',
];

function buildWindow() {
  const inputs = ['plan-node-title', 'plan-node-branch', 'plan-node-verify', 'plan-node-base-branch'];
  const textareas = ['plan-node-goal'];
  const selects = ['plan-node-status', 'plan-node-kind', 'plan-node-worker', 'plan-node-verifier'];
  const fixture = FIXTURE_IDS.map((id) => {
    if (inputs.includes(id)) {
      return `<input id="${id}" />`;
    }
    if (textareas.includes(id)) {
      return `<textarea id="${id}"></textarea>`;
    }
    if (id === 'plan-history') {
      return '<details id="plan-history"><summary>执行历史</summary></details>';
    }
    if (selects.includes(id)) {
      const options = id === 'plan-node-status'
        ? '<option value="pending">待办</option><option value="doing">进行</option><option value="done">完成</option><option value="blocked">阻塞</option>'
        : id === 'plan-node-kind'
          ? '<option value="work">work</option><option value="merge">merge</option>'
          : '<option value="">自动</option>';
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

function sampleDoc() {
  return {
    nodes: [
      { id: 'n1', title: '根任务', goal: 'g1', status: 'done', depends_on: [], branch: 'feat/root', kind: 'work' },
      { id: 'n2', title: '并行A', goal: '', status: 'doing', depends_on: ['n1'], branch: '', kind: 'work' },
      { id: 'n3', title: '并行B', goal: '', status: 'pending', depends_on: ['n1'], branch: '', kind: 'work' },
      { id: 'n4', title: '合并', goal: '', status: 'pending', depends_on: ['n2', 'n3'], branch: '', kind: 'merge' },
    ],
  };
}

function samplePlan(overrides = {}) {
  return {
    id: 'plan-1',
    ownerConversationId: 'conv-1',
    status: 'draft',
    version: 1,
    doc: sampleDoc(),
    activatedAt: null,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    ...overrides,
  };
}

test('layoutPlan layers a diamond DAG and derives edges', () => {
  const window = buildWindow();
  const { layoutPlan } = window.CaffChat.planDagView;
  const layout = layoutPlan(sampleDoc());

  assert.equal(layout.placed.size, 4);
  assert.equal(layout.edges.length, 4);

  const byLayer = new Map();
  for (const entry of layout.placed.values()) {
    byLayer.set(entry.id, entry.y);
  }
  assert.ok(byLayer.get('n1') < byLayer.get('n2'), 'root above children');
  assert.ok(byLayer.get('n2') === byLayer.get('n3'), 'parallel nodes same layer');
  assert.ok(byLayer.get('n4') > byLayer.get('n2'), 'merge below parallel pair');
});

test('renderGraph draws svg nodes with status classes and merge styling', () => {
  const window = buildWindow();
  const { renderGraph } = window.CaffChat.planDagView;
  const container = window.document.getElementById('plan-graph');

  renderGraph(container, sampleDoc(), { selectedNodeId: 'n2' });

  const nodes = container.querySelectorAll('.plan-node');
  assert.equal(nodes.length, 4);
  assert.equal(container.querySelectorAll('.plan-edge').length, 4);
  assert.ok(container.querySelector('.plan-node.status-doing[data-node-id="n2"].selected'));
  assert.ok(container.querySelector('.plan-node.kind-merge[data-node-id="n4"]'));
  assert.match(container.querySelector('[data-node-id="n4"] .plan-node-subtitle').textContent, /merge/);
  // 居中舞台：svg 包在 .plan-graph-stage 里，小于视口时居中、大于视口时可滚动
  const stage = container.querySelector('.plan-graph-stage');
  assert.ok(stage, 'svg should be wrapped in .plan-graph-stage for centering');
  assert.equal(stage.firstElementChild.tagName.toLowerCase(), 'svg');
});

test('controller loads draft plan, edits node title, saves with version', async () => {
  const window = buildWindow();
  const refs = domRefs(window);
  const saved = [];
  const toasts = [];
  const state = { currentConversation: { id: 'conv-1' } };

  const controller = window.CaffChat.createPlanPanelController({
    state,
    dom: refs,
    helpers: {
      async fetchPlan() {
        return { ownerConversationId: 'conv-1', plan: samplePlan() };
      },
      async savePlan(conversationId, body) {
        saved.push({ conversationId, body });
        return { ownerConversationId: 'conv-1', plan: samplePlan({ version: body.version + 1, doc: body.doc }) };
      },
      async activatePlan() {
        throw new Error('not used');
      },
      async revertPlan() {
        throw new Error('not used');
      },
      async openConversation() {},
    },
    showToast(message) {
      toasts.push(String(message));
    },
  });

  controller.bindEvents();
  controller.render();
  await flush();
  await flush();

  assert.equal(refs.planGraph.querySelectorAll('.plan-node').length, 4);
  assert.match(refs.planPanelStatus.textContent, /v1/);
  assert.equal(refs.planSaveButton.disabled, true, 'no edits yet');

  const node = refs.planGraph.querySelector('[data-node-id="n2"]');
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();

  assert.equal(refs.planEditor.classList.contains('hidden'), false);
  assert.equal(refs.planNodeTitle.value, '并行A');

  refs.planNodeTitle.value = '并行A-改';
  refs.planNodeTitle.dispatchEvent(new window.Event('input', { bubbles: true }));
  await flush();

  assert.equal(refs.planSaveButton.disabled, false, 'dirty draft enables save');
  refs.planSaveButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();
  await flush();

  assert.equal(saved.length, 1);
  assert.equal(saved[0].conversationId, 'conv-1');
  assert.equal(saved[0].body.version, 1, 'optimistic concurrency sends read version');
  const savedNode = saved[0].body.doc.nodes.find((entry) => entry.id === 'n2');
  assert.equal(savedNode.title, '并行A-改');
  assert.match(refs.planPanelStatus.textContent, /v2/);
});

test('active plan locks structure and persists status change immediately', async () => {
  const window = buildWindow();
  const refs = domRefs(window);
  const saved = [];
  const state = { currentConversation: { id: 'conv-1' } };

  const controller = window.CaffChat.createPlanPanelController({
    state,
    dom: refs,
    helpers: {
      async fetchPlan() {
        return { ownerConversationId: 'conv-1', plan: samplePlan({ status: 'active', version: 7 }) };
      },
      async savePlan(conversationId, body) {
        saved.push(body);
        return { ownerConversationId: 'conv-1', plan: samplePlan({ status: 'active', version: body.version + 1, doc: body.doc }) };
      },
      async activatePlan() {
        throw new Error('not used');
      },
      async revertPlan() {
        return { ownerConversationId: 'conv-1', plan: samplePlan({ status: 'draft', version: 9 }) };
      },
      async openConversation() {},
    },
    showToast() {},
  });

  controller.bindEvents();
  controller.render();
  await flush();
  await flush();

  assert.equal(refs.planAddNodeButton.disabled, true, 'active: no structural add');
  assert.equal(refs.planActivateButton.disabled, true);
  assert.equal(refs.planRevertButton.disabled, false);

  const node = refs.planGraph.querySelector('[data-node-id="n3"]');
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();

  assert.equal(refs.planNodeTitle.disabled, true, 'active: title locked');
  assert.equal(refs.planNodeDeleteButton.disabled, true, 'active: delete locked');
  assert.equal(refs.planGraph.querySelectorAll('.plan-handle').length, 0, 'active: no link handles');
  assert.equal(refs.planGraph.querySelectorAll('.plan-edge-hit').length, 0, 'active: edges not removable');

  refs.planNodeStatus.value = 'doing';
  refs.planNodeStatus.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();
  await flush();

  assert.equal(saved.length, 1, 'status change persisted immediately');
  assert.equal(saved[0].version, 7);
  const savedNode = saved[0].doc.nodes.find((entry) => entry.id === 'n3');
  assert.equal(savedNode.status, 'doing');
  const untouched = saved[0].doc.nodes.find((entry) => entry.id === 'n2');
  assert.equal(untouched.title, '并行A', 'structure untouched in status-only write');
});

test('404 yields empty state; applyPlanEvent refreshes from SSE', async () => {
  const window = buildWindow();
  const refs = domRefs(window);
  const state = { currentConversation: { id: 'conv-1' } };
  let fetchCount = 0;

  const controller = window.CaffChat.createPlanPanelController({
    state,
    dom: refs,
    helpers: {
      async fetchPlan() {
        fetchCount += 1;
        if (fetchCount === 1) {
          const error = new Error('Conversation tree has no plan');
          error.status = 404;
          error.code = 'plan_not_found';
          throw error;
        }
        return {
          ownerConversationId: 'conv-1',
          participants: [{ id: 'role-family-gpt', name: 'GPT' }, { id: 'role-family-kimi', name: 'Kimi' }],
          plan: samplePlan({ version: 3 }),
        };
      },
      async savePlan() {
        throw new Error('not used');
      },
      async activatePlan() {
        throw new Error('not used');
      },
      async revertPlan() {
        throw new Error('not used');
      },
      async openConversation() {},
    },
    showToast() {},
  });

  controller.bindEvents();
  controller.render();
  await flush();
  await flush();

  assert.match(refs.planPanelStatus.textContent, /还没有规划图/);
  assert.equal(refs.planGraph.querySelectorAll('.plan-node').length, 0);

  controller.applyPlanEvent({
    conversationId: 'conv-1',
    ownerConversationId: 'conv-1',
    plan: samplePlan({ version: 3 }),
  });
  await flush();
  await flush();

  assert.equal(refs.planGraph.querySelectorAll('.plan-node').length, 4, 'SSE event renders incoming plan');
  assert.match(refs.planPanelStatus.textContent, /v3/);
  refs.planGraph.querySelector('[data-node-id="n1"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.equal(refs.planNodeWorker.disabled, false, 'SSE-created plan hydrates participant role choices');
  assert.equal(refs.planNodeWorker.options.length, 3);
});

test('drawer zoom buttons rescale drawer graph; dblclick edits node; Delete removes selection', async () => {
  const window = buildWindow();
  const refs = domRefs(window);
  const state = { currentConversation: { id: 'conv-1' } };

  const controller = window.CaffChat.createPlanPanelController({
    state,
    dom: refs,
    helpers: {
      async fetchPlan() {
        return { ownerConversationId: 'conv-1', plan: samplePlan() };
      },
      async savePlan() {
        throw new Error('not used');
      },
      async activatePlan() {
        throw new Error('not used');
      },
      async revertPlan() {
        throw new Error('not used');
      },
      async openConversation() {},
    },
    showToast() {},
  });

  controller.bindEvents();
  controller.render();
  await flush();
  await flush();

  const svgWidth = () => Number(refs.planGraph.querySelector('.plan-svg').getAttribute('width'));
  const before = svgWidth();
  assert.ok(before > 0);

  refs.planDrawerZoomInButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.ok(svgWidth() > before * 1.1, 'drawer zoom-in enlarges drawer svg');

  refs.planDrawerZoomOutButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.ok(Math.abs(svgWidth() - before) < 0.01, 'zoom-out restores drawer svg size');

  const node = refs.planGraph.querySelector('[data-node-id="n3"]');
  node.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  await flush();
  assert.equal(refs.planEditor.classList.contains('hidden'), false, 'dblclick opens editor');
  assert.equal(refs.planNodeTitle.value, '并行B');

  window.document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  await flush();
  assert.equal(refs.planGraph.querySelectorAll('.plan-node').length, 3, 'Delete removes selected node in draft');
});

test('edge handles: drag links nodes, cycle rejected, click edge removes dependency', async () => {
  const window = buildWindow();
  const refs = domRefs(window);
  const saved = [];
  const toasts = [];
  const state = { currentConversation: { id: 'conv-1' } };

  const controller = window.CaffChat.createPlanPanelController({
    state,
    dom: refs,
    helpers: {
      async fetchPlan() {
        return { ownerConversationId: 'conv-1', plan: samplePlan() };
      },
      async savePlan(conversationId, body) {
        saved.push(body);
        return { ownerConversationId: 'conv-1', plan: samplePlan({ version: body.version + 1, doc: body.doc }) };
      },
      async activatePlan() {
        throw new Error('not used');
      },
      async revertPlan() {
        throw new Error('not used');
      },
      async openConversation() {},
    },
    showToast(message) {
      toasts.push(String(message));
    },
  });

  controller.bindEvents();
  controller.render();
  await flush();
  await flush();

  const edgeCount = () => refs.planGraph.querySelectorAll('.plan-edge').length;
  assert.equal(edgeCount(), 4);
  assert.equal(refs.planGraph.querySelectorAll('.plan-handle-out').length, 4, 'draft: every node has an out handle');
  assert.equal(refs.planGraph.querySelectorAll('.plan-edge-hit').length, 4, 'draft: edges clickable for removal');

  // 拖拽 n2 底部手柄 → n3 节点：建立 n3 depends_on n2
  const outHandle = refs.planGraph.querySelector('.plan-node[data-node-id="n2"] .plan-handle-out');
  outHandle.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
  const n3 = refs.planGraph.querySelector('.plan-node[data-node-id="n3"]');
  n3.dispatchEvent(new window.MouseEvent('pointerenter', { bubbles: false }));
  n3.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true }));
  await flush();

  assert.equal(edgeCount(), 5, 'drag creates a new edge');
  assert.equal(refs.planSaveButton.disabled, false, 'new edge marks draft dirty');

  refs.planSaveButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();
  await flush();
  const savedN3 = saved[0].doc.nodes.find((entry) => entry.id === 'n3');
  assert.deepEqual(Array.from(savedN3.depends_on), ['n1', 'n2'], 'linked dependency persisted');

  // 拖拽 n4 底部手柄 → n1：会形成环，前端即时拦截
  const outHandle4 = refs.planGraph.querySelector('.plan-node[data-node-id="n4"] .plan-handle-out');
  outHandle4.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
  const n1 = refs.planGraph.querySelector('.plan-node[data-node-id="n1"]');
  n1.dispatchEvent(new window.MouseEvent('pointerenter', { bubbles: false }));
  n1.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true }));
  await flush();

  assert.equal(edgeCount(), 5, 'cyclic edge rejected');
  assert.ok(toasts.some((message) => message.includes('环')), 'cycle rejection toast shown');

  // 点击 n1 → n3 的边：移除该依赖
  const hit = refs.planGraph.querySelector('.plan-edge-hit[data-from="n1"][data-to="n3"]');
  assert.ok(hit, 'hit path exists for n1→n3');
  hit.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.equal(edgeCount(), 4, 'clicking edge removes the dependency');

  refs.planSaveButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();
  await flush();
  const savedAgain = saved[1].doc.nodes.find((entry) => entry.id === 'n3');
  assert.deepEqual(Array.from(savedAgain.depends_on), ['n2'], 'edge removal persisted');

  // 显性删边入口：边中点的 × 按钮（draft 态渲染，active 态不渲染）
  assert.equal(refs.planGraph.querySelectorAll('.plan-edge-del').length, 4, 'draft: edge midpoint delete badges rendered');
  const delBadge = refs.planGraph.querySelector('.plan-edge-del[data-from="n2"][data-to="n3"]');
  assert.ok(delBadge, 'delete badge exists for n2→n3');
  delBadge.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.equal(edgeCount(), 3, 'clicking midpoint badge removes the dependency');
  const afterBadge = (savedDoc) => savedDoc.nodes.find((entry) => entry.id === 'n3');
  refs.planSaveButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();
  await flush();
  assert.deepEqual(Array.from(afterBadge(saved[2].doc).depends_on), [], 'badge removal persisted');
});

test('plan-panel: drag-pan does not steal pointer capture from edge delete badge', async () => {
  const window = buildWindow();
  const refs = domRefs(window);
  const saved = [];
  const state = { currentConversation: { id: 'conv-1' } };
  const twoNodeDoc = () => ({
    nodes: [
      { id: 'n1', title: '起点', goal: '', status: 'pending', depends_on: [], branch: '', kind: 'work' },
      { id: 'n2', title: '分支', goal: '', status: 'pending', depends_on: ['n1'], branch: '', kind: 'work' },
    ],
  });
  const plan = (version, doc) => ({
    id: 'plan-1',
    ownerConversationId: 'conv-1',
    status: 'draft',
    version,
    doc,
    activatedAt: null,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
  });
  const controller = window.CaffChat.createPlanPanelController({
    state,
    dom: refs,
    helpers: {
      async fetchPlan() {
        return { ownerConversationId: 'conv-1', plan: plan(1, twoNodeDoc()) };
      },
      async savePlan(conversationId, body) {
        saved.push(body);
        return { ownerConversationId: 'conv-1', plan: plan(body.version + 1, body.doc) };
      },
      async activatePlan() {
        throw new Error('not used');
      },
      async revertPlan() {
        throw new Error('not used');
      },
      openConversation() {},
    },
    showToast() {},
  });
  controller.bindEvents();
  controller.render();
  await flush();
  await flush();

  // 模拟浏览器 pointer capture 语义：pointerdown 落在删边徽章上时，
  // 容器若抢 capture，后续 click 会被重定向到容器，徽章点击失效（本次 bug 根因）。
  const captured = [];
  refs.planGraph.setPointerCapture = (pointerId) => {
    captured.push(pointerId);
  };
  const delBadge = refs.planGraph.querySelector('.plan-edge-del[data-from="n1"][data-to="n2"]');
  assert.ok(delBadge, 'delete badge rendered');
  delBadge.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
  assert.equal(captured.length, 0, 'pointerdown on delete badge must not trigger container pointer capture');
  delBadge.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.equal(refs.planGraph.querySelectorAll('.plan-edge').length, 0, 'badge click still removes the edge');

  // 空白背景上 pointerdown 仍然起手平移（不回归拖拽平移功能）
  const svg = refs.planGraph.querySelector('svg.plan-svg');
  svg.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
  assert.equal(captured.length, 1, 'pointerdown on blank background still starts drag-pan');
});

test('plan-panel: editor form renders dependency chips with remove buttons in draft', async () => {
  const window = buildWindow();
  const refs = domRefs(window);
  const saved = [];
  const state = { currentConversation: { id: 'conv-1' } };
  const twoNodeDoc = () => ({
    nodes: [
      { id: 'n1', title: '起点', goal: '', status: 'pending', depends_on: [], branch: '', kind: 'work' },
      { id: 'n2', title: '分支', goal: '', status: 'pending', depends_on: ['n1'], branch: '', kind: 'work' },
    ],
  });
  const plan = (version, doc) => ({
    id: 'plan-1',
    ownerConversationId: 'conv-1',
    status: 'draft',
    version,
    doc,
    activatedAt: null,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
  });

  const controller = window.CaffChat.createPlanPanelController({
    state,
    dom: refs,
    helpers: {
      async fetchPlan() {
        return { ownerConversationId: 'conv-1', plan: plan(1, twoNodeDoc()) };
      },
      async savePlan(conversationId, body) {
        saved.push(body);
        return { ownerConversationId: 'conv-1', plan: plan(body.version + 1, body.doc) };
      },
      async activatePlan() {
        throw new Error('not used');
      },
      async revertPlan() {
        throw new Error('not used');
      },
      async openConversation() {},
    },
    showToast() {},
  });

  controller.bindEvents();
  controller.render();
  await flush();
  await flush();

  // 选中 n2 → 编辑表单里出现依赖 chip，点 × 直接移除依赖
  const n2 = refs.planGraph.querySelector('.plan-node[data-node-id="n2"]');
  n2.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();

  const chip = refs.planNodeDeps.querySelector('.plan-dep-chip');
  assert.ok(chip, 'dependency chip rendered for selected node');
  assert.ok(chip.textContent.includes('起点'), 'chip shows dependency title');
  const removeBtn = chip.querySelector('.plan-dep-chip-remove');
  assert.ok(removeBtn, 'chip has a remove button');
  removeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();

  assert.equal(refs.planGraph.querySelectorAll('.plan-edge').length, 0, 'chip × removes the edge from the graph');
  assert.equal(refs.planNodeDeps.querySelectorAll('.plan-dep-chip').length, 0, 'chip list refreshes after removal');

  refs.planSaveButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();
  await flush();
  const savedN2 = saved[0].doc.nodes.find((entry) => entry.id === 'n2');
  assert.deepEqual(Array.from(savedN2.depends_on), [], 'chip removal persisted');
});

test('normalizeDoc preserves dag-execution fields (verify/base_branch/worker/verifier/result)', () => {
  const window = buildWindow();
  const { normalizeDoc } = window.CaffChat.planDagView;
  const doc = {
    nodes: [
      {
        id: 'm1', title: '合并', goal: '', status: 'pending', depends_on: [], branch: 'feat/m', kind: 'merge',
        verify: 'npm test', base_branch: 'feat/base', worker: 'role-family-gpt', verifier: 'role-family-kimi', result: '已合并两条分支',
        spawned_conversation_id: null,
      },
      { id: 'w1', title: '普通', goal: '', status: 'pending', depends_on: [], branch: '', kind: 'work', verify: '  ', result: '' },
    ],
    history: [{ node_id: 'm1', from: 'pending', to: 'doing', at: '2026-08-16T00:00:00.000Z', actor: 'system' }],
  };
  const normalized = normalizeDoc(doc);
  const m1 = normalized.nodes.find((node) => node.id === 'm1');
  assert.equal(m1.verify, 'npm test');
  assert.equal(m1.base_branch, 'feat/base');
  assert.equal(m1.worker, 'role-family-gpt');
  assert.equal(m1.verifier, 'role-family-kimi');
  assert.equal(m1.result, '已合并两条分支');
  const w1 = normalized.nodes.find((node) => node.id === 'w1');
  assert.equal('verify' in w1, false, 'blank verify is dropped');
  assert.equal('result' in w1, false, 'blank result is dropped');
  assert.equal('base_branch' in w1, false);
});

test('node editor renders participant dropdowns and prevents worker self-review selection', async () => {
  const window = buildWindow();
  const refs = domRefs(window);
  const saved = [];
  const doc = sampleDoc();
  doc.nodes[0].worker = 'GPT';
  doc.nodes[0].verifier = 'role-family-kimi';
  const participants = [
    { id: 'role-family-gpt', name: 'GPT' },
    { id: 'role-family-kimi', name: 'Kimi' },
  ];
  const controller = window.CaffChat.createPlanPanelController({
    state: { currentConversation: { id: 'conv-1' } },
    dom: refs,
    helpers: {
      async fetchPlan() {
        return { ownerConversationId: 'conv-1', participants, plan: samplePlan({ doc }) };
      },
      async savePlan(conversationId, body) {
        saved.push(body);
        return { ownerConversationId: 'conv-1', participants, plan: samplePlan({ version: 2, doc: body.doc }) };
      },
      async activatePlan() { throw new Error('not used'); },
      async revertPlan() { throw new Error('not used'); },
      async openConversation() {},
    },
    showToast() {},
  });

  controller.bindEvents();
  controller.render();
  await flush();
  await flush();
  refs.planGraph.querySelector('[data-node-id="n1"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();

  assert.equal(refs.planNodeWorker.value, 'role-family-gpt', 'legacy display name resolves in dropdown');
  assert.equal(refs.planNodeVerifier.value, 'role-family-kimi');
  assert.equal(Array.from(refs.planNodeVerifier.options).some((option) => option.value === 'role-family-gpt'), false, 'worker excluded from verifier options');

  refs.planNodeWorker.value = 'role-family-kimi';
  refs.planNodeWorker.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();
  assert.equal(refs.planNodeVerifier.value, '', 'self-review verifier is cleared after worker change');
  assert.equal(Array.from(refs.planNodeVerifier.options).some((option) => option.value === 'role-family-kimi'), false);

  refs.planSaveButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();
  await flush();
  const savedNode = saved[0].doc.nodes.find((node) => node.id === 'n1');
  assert.equal(savedNode.worker, 'role-family-kimi', 'dropdown persists canonical worker id');
  assert.equal('verifier' in savedNode, false);
});

test('deriveNodeBadges flags ready and upstream-blocked pending nodes', () => {
  const window = buildWindow();
  const { deriveNodeBadges } = window.CaffChat.planDagView;
  const doc = {
    nodes: [
      { id: 'n1', status: 'done', depends_on: [] },
      { id: 'n2', status: 'blocked', depends_on: ['n1'] },
      { id: 'n3', status: 'pending', depends_on: ['n2'] }, // 传递上游 blocked
      { id: 'n4', status: 'pending', depends_on: ['n1'] }, // 全部上游 done → ready
      { id: 'n5', status: 'pending', depends_on: ['n3'] }, // 传递上游 blocked（隔一层）
      { id: 'n6', status: 'pending', depends_on: ['n4'] }, // 上游 pending → 无徽标
    ],
  };
  const badges = deriveNodeBadges(doc);
  // jsdom 跨 realm：deriveNodeBadges 返回的对象原型与测试侧不同，逐字段断言
  const badgeOf = (id) => {
    const badge = badges.get(id);
    return badge ? { ready: badge.ready, upstreamBlocked: badge.upstreamBlocked } : null;
  };
  assert.deepEqual(badgeOf('n3'), { ready: false, upstreamBlocked: true });
  assert.deepEqual(badgeOf('n5'), { ready: false, upstreamBlocked: true }, 'transitive blocked propagates');
  assert.deepEqual(badgeOf('n4'), { ready: true, upstreamBlocked: false });
  assert.equal(badges.has('n6'), false, 'waiting on pending upstream: no badge');
  assert.equal(badges.has('n2'), false, 'non-pending nodes get no badge');
});

test('renderGraph renders derived badges when provided', () => {
  const window = buildWindow();
  const { renderGraph } = window.CaffChat.planDagView;
  const container = window.document.getElementById('plan-graph');
  const badges = new Map([
    ['n3', { ready: true, upstreamBlocked: false }],
    ['n4', { ready: false, upstreamBlocked: true }],
  ]);
  renderGraph(container, sampleDoc(), { badges });
  const ready = container.querySelector('[data-node-id="n3"] .plan-node-derived-badge.badge-ready');
  assert.ok(ready, 'ready badge rendered');
  assert.match(ready.textContent, /就绪待派发/);
  const blocked = container.querySelector('[data-node-id="n4"] .plan-node-derived-badge.badge-blocked');
  assert.ok(blocked, 'upstream-blocked badge rendered');
  assert.match(blocked.textContent, /上游阻塞/);
  assert.equal(container.querySelector('[data-node-id="n1"] .plan-node-derived-badge'), null, 'no badge without entry');
});

test('active plan shows derived badges, history timeline and node execution info; saves omit history', async () => {
  const window = buildWindow();
  const refs = domRefs(window);
  const saved = [];
  const state = { currentConversation: { id: 'conv-1' } };
  const doc = {
    nodes: [
      { id: 'n1', title: '根任务', goal: '', status: 'done', depends_on: [], branch: 'feat/root', kind: 'work', result: '根任务完成' },
      { id: 'n2', title: '并行A', goal: '', status: 'blocked', depends_on: ['n1'], branch: '', kind: 'work' },
      { id: 'n3', title: '并行B', goal: '', status: 'pending', depends_on: ['n1'], branch: '', kind: 'work' },
      { id: 'n4', title: '合并', goal: '', status: 'pending', depends_on: ['n2', 'n3'], branch: '', kind: 'merge' },
    ],
    history: [
      { node_id: 'n1', from: 'doing', to: 'done', at: '2026-08-16T01:00:00.000Z', actor: 'system' },
      { node_id: 'n2', from: 'doing', to: 'blocked', at: '2026-08-16T02:00:00.000Z', actor: 'system', reason: 'worktree 脏目录' },
    ],
  };

  const controller = window.CaffChat.createPlanPanelController({
    state,
    dom: refs,
    helpers: {
      async fetchPlan() {
        return { ownerConversationId: 'conv-1', plan: samplePlan({ status: 'active', version: 3, doc }) };
      },
      async savePlan(conversationId, body) {
        saved.push(body);
        return { ownerConversationId: 'conv-1', plan: samplePlan({ status: 'active', version: body.version + 1, doc: body.doc }) };
      },
      async activatePlan() {
        throw new Error('not used');
      },
      async revertPlan() {
        throw new Error('not used');
      },
      async openConversation() {},
    },
    showToast() {},
  });

  controller.bindEvents();
  controller.render();
  await flush();
  await flush();

  // 派生徽标：n3 上游全 done → 就绪待派发；n4 传递上游 n2 blocked → 上游阻塞
  assert.ok(refs.planGraph.querySelector('[data-node-id="n3"] .plan-node-derived-badge.badge-ready'), 'ready badge on n3');
  assert.ok(refs.planGraph.querySelector('[data-node-id="n4"] .plan-node-derived-badge.badge-blocked'), 'blocked badge on n4');
  assert.equal(refs.planGraph.querySelector('[data-node-id="n2"] .plan-node-derived-badge'), null, 'blocked node itself gets no derived badge');

  // D18 历史时间线：最新在前，含原因
  assert.equal(refs.planHistory.classList.contains('hidden'), false, 'history section visible');
  assert.match(refs.planHistory.querySelector('summary').textContent, /执行历史（2）/);
  const entries = refs.planHistoryList.querySelectorAll('.plan-history-entry');
  assert.equal(entries.length, 2);
  assert.match(entries[0].textContent, /并行A：进行 → 阻塞 · system · worktree 脏目录/);
  assert.match(entries[1].textContent, /根任务：进行 → 完成 · system/);

  // 节点执行信息：blocked 原因与 result 摘要
  refs.planGraph.querySelector('[data-node-id="n2"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.match(refs.planNodeExecution.textContent, /阻塞原因：worktree 脏目录/);
  refs.planGraph.querySelector('[data-node-id="n1"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.match(refs.planNodeExecution.textContent, /结果摘要：根任务完成/);

  // 保存时 history 字段被剥离（服务端继承路径，D18）
  refs.planNodeStatus.value = 'done';
  refs.planNodeStatus.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();
  await flush();
  assert.equal(saved.length, 1);
  assert.equal('history' in saved[0].doc, false, 'outbound payload omits server-owned history');
  const savedN1 = saved[0].doc.nodes.find((entry) => entry.id === 'n1');
  assert.equal(savedN1.result, '根任务完成', 'result field survives round-trip');
});
