const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function loadCrossConversationUi() {
  const sourcePath = path.join(__dirname, '../../public/chat/cross-conversation-ui.js');
  const context = { window: { CaffChat: {} } };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  return context.window.CaffChat.crossConversationUi;
}

function conversation(id, overrides = {}) {
  return {
    id,
    title: id,
    type: 'standard',
    projectScopeId: 'project-1',
    parentConversationId: null,
    treeDepth: 0,
    createdAt: '2026-08-05T00:00:00.000Z',
    lastMessageAt: null,
    ...overrides,
  };
}

function delivery(overrides = {}) {
  return {
    id: 'delivery-1',
    kind: 'request',
    sourceConversationId: 'root-a',
    targetConversationId: 'child-a',
    targetAgentId: 'agent-1',
    messageStatus: 'persisted',
    dispatchStatus: 'queued',
    responseStatus: 'waiting',
    startedAt: null,
    targetInvocationId: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    updatedAt: '2026-08-05T00:00:00.000Z',
    ...overrides,
  };
}

test('conversation tree keeps sibling order stable, expands selected ancestors, and enforces max depth', () => {
  const ui = loadCrossConversationUi();
  const conversations = [
    conversation('child-b', {
      parentConversationId: 'root-a',
      treeDepth: 1,
      createdAt: '2026-08-05T00:03:00.000Z',
      lastMessageAt: '2026-08-05T09:00:00.000Z',
    }),
    conversation('root-b', { createdAt: '2026-08-05T00:01:00.000Z' }),
    conversation('grandchild-a', {
      parentConversationId: 'child-a',
      treeDepth: 2,
      createdAt: '2026-08-05T00:04:00.000Z',
    }),
    conversation('root-a', { createdAt: '2026-08-05T00:00:00.000Z' }),
    conversation('child-a', {
      parentConversationId: 'root-a',
      treeDepth: 1,
      createdAt: '2026-08-05T00:02:00.000Z',
      lastMessageAt: '2026-08-05T01:00:00.000Z',
    }),
  ];

  const first = ui.buildConversationTree(conversations, {
    selectedConversationId: 'grandchild-a',
    collapsedIds: new Set(['root-a', 'child-a']),
  });
  assert.deepEqual(Array.from(first.rows, (row) => row.conversation.id), [
    'root-a',
    'child-a',
    'grandchild-a',
    'child-b',
    'root-b',
  ]);
  assert.equal(first.rows[0].expanded, true, 'selected descendant must expand the root ancestor');
  assert.equal(first.rows[1].expanded, true, 'selected descendant must expand the direct parent');
  assert.equal(first.rows[2].canSpawn, false);
  assert.equal(first.rows[2].depthLimit, true);
  assert.equal(first.collapsedIds.has('root-a'), false);
  assert.equal(first.collapsedIds.has('child-a'), false);

  conversations[0].lastMessageAt = '2026-08-06T12:00:00.000Z';
  conversations[4].lastMessageAt = '2026-08-04T12:00:00.000Z';
  const second = ui.buildConversationTree(conversations, {
    selectedConversationId: 'root-b',
    collapsedIds: new Set(['root-a']),
  });
  assert.deepEqual(Array.from(second.rows, (row) => row.conversation.id), ['root-a', 'root-b']);
});

test('delivery view preserves message, dispatch, and response state while exposing only safe actions', () => {
  const ui = loadCrossConversationUi();

  assert.deepEqual(JSON.parse(JSON.stringify(ui.deliveryView(delivery()))), {
    key: 'queued',
    label: '已排队',
    tone: 'neutral',
    live: true,
    failed: false,
    canRetry: false,
    canCancel: true,
    errorMessage: '',
  });
  assert.equal(ui.deliveryView(delivery({ dispatchStatus: 'running', startedAt: '2026-08-05T00:01:00.000Z' })).label, '处理中');
  assert.equal(ui.deliveryView(delivery({ dispatchStatus: 'completed', responseStatus: 'waiting' })).label, '等待回复');
  assert.equal(ui.deliveryView(delivery({ dispatchStatus: 'completed', responseStatus: 'received' })).label, '已回答');
  assert.equal(ui.deliveryView(delivery({ dispatchStatus: 'completed', responseStatus: 'late' })).label, '迟到回复');

  const failed = ui.deliveryView(delivery({
    dispatchStatus: 'failed',
    responseStatus: 'cancelled',
    lastErrorCode: 'runtime_unavailable',
    lastErrorMessage: 'Primary Agent is unavailable',
  }));
  assert.equal(failed.label, '失败');
  assert.equal(failed.tone, 'failed');
  assert.equal(failed.canRetry, true);
  assert.equal(failed.canCancel, false);
  assert.equal(failed.errorMessage, 'Primary Agent is unavailable');

  const unknownOutcome = ui.deliveryView(delivery({
    dispatchStatus: 'failed',
    startedAt: '2026-08-05T00:01:00.000Z',
    targetInvocationId: 'invocation-1',
  }));
  assert.equal(unknownOutcome.canRetry, false, 'started unknown outcomes must never offer replay');
});

test('receipt and provenance models use the delivery DTO as state truth and keep birth messages public', () => {
  const ui = loadCrossConversationUi();
  const conversations = [
    conversation('root-a', { title: 'Source room' }),
    conversation('child-a', { title: 'Child room', parentConversationId: 'root-a', treeDepth: 1 }),
  ];
  const dto = delivery({ kind: 'bootstrap', dispatchStatus: 'failed', responseStatus: 'not_expected' });
  const receiptMessage = {
    id: 'receipt-1',
    role: 'system',
    content: '',
    metadata: {
      kind: 'cross_conversation_receipt',
      crossConversation: {
        deliveryId: dto.id,
        kind: 'bootstrap',
        targetConversationId: 'child-a',
        targetConversationTitle: 'Child room',
        targetAgentId: 'agent-1',
      },
    },
  };
  const receipt = ui.receiptModel(receiptMessage, dto, conversations);
  assert.equal(receipt.kindLabel, '派生子会话');
  assert.equal(receipt.targetTitle, 'Child room');
  assert.equal(receipt.view.key, 'failed');
  assert.equal(receipt.jumpConversationId, 'child-a');

  const targetMessage = {
    id: 'target-1',
    role: 'external_agent',
    metadata: {
      crossConversation: {
        deliveryId: dto.id,
        kind: 'request',
        sourceConversationId: 'root-a',
        sourceConversationTitle: 'Source room',
        sourceAgentName: 'Reviewer',
      },
    },
  };
  const provenance = ui.provenanceModel(targetMessage, conversations);
  assert.equal(provenance.label, '来自 Source room');
  assert.equal(provenance.backlinkConversationId, 'root-a');
  assert.equal(provenance.sourceAgentName, 'Reviewer');

  const birthMessage = {
    id: 'birth-1',
    role: 'user',
    content: 'Complete public initial message',
    metadata: {
      kind: 'conversation_spawn_initial_message',
      crossConversation: {
        deliveryId: dto.id,
        kind: 'bootstrap',
        sourceConversationId: 'root-a',
        sourceConversationTitle: 'Source room',
      },
    },
  };
  const birth = ui.birthModel(birthMessage, conversations);
  assert.equal(birth.backlinkConversationId, 'root-a');
  assert.equal(birth.notice, '这是全新会话，不会复制父会话历史或配置。');
  assert.equal(birthMessage.role, 'user');
  assert.equal(birthMessage.content, 'Complete public initial message');
});

test('delivery patches update only matching DTOs and newer tree status', () => {
  const ui = loadCrossConversationUi();
  const bundles = new Map([['delivery-1', { delivery: delivery() }]]);
  const conversations = [conversation('child-a', {
    crossConversationStatus: delivery({ updatedAt: '2026-08-05T00:00:00.000Z' }),
  })];
  const patch = delivery({
    dispatchStatus: 'running',
    startedAt: '2026-08-05T00:02:00.000Z',
    updatedAt: '2026-08-05T00:02:00.000Z',
  });

  ui.applyDeliveryPatch(bundles, conversations, patch);
  assert.equal(bundles.get('delivery-1').delivery.dispatchStatus, 'running');
  assert.equal(conversations[0].crossConversationStatus.dispatchStatus, 'running');

  ui.applyDeliveryPatch(bundles, conversations, delivery({
    dispatchStatus: 'queued',
    updatedAt: '2026-08-04T00:00:00.000Z',
  }));
  assert.equal(conversations[0].crossConversationStatus.dispatchStatus, 'running');
});

test('conversation list renders compact semantic tree rows with collapse, status, and bounded spawn actions', () => {
  const dom = new JSDOM('<ul id="conversation-list" class="conversation-list sidebar-list"></ul>', {
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.CaffChat = {};
  window.eval(fs.readFileSync(path.join(__dirname, '../../public/chat/cross-conversation-ui.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(__dirname, '../../public/chat/conversation-list.js'), 'utf8'));
  const state = {
    conversations: [
      conversation('root', { title: 'Root' }),
      conversation('child', {
        title: 'Child',
        parentConversationId: 'root',
        treeDepth: 1,
        createdAt: '2026-08-05T00:01:00.000Z',
        crossConversationStatus: delivery({
          id: 'bootstrap-child',
          kind: 'bootstrap',
          targetConversationId: 'child',
          dispatchStatus: 'running',
          responseStatus: 'not_expected',
        }),
      }),
      conversation('grandchild', {
        title: 'Grandchild',
        parentConversationId: 'child',
        treeDepth: 2,
        createdAt: '2026-08-05T00:02:00.000Z',
      }),
    ],
    selectedConversationId: 'grandchild',
  };
  const renderer = window.CaffChat.createConversationListRenderer({
    state,
    dom: { conversationList: window.document.getElementById('conversation-list') },
    helpers: {
      conversationPreviewText: (value) => String(value || ''),
      conversationTypeLabel: () => '标准',
      formatDateTime: () => '-',
      isConversationBusy: () => false,
      isUndercoverConversation: () => false,
      isWerewolfConversation: () => false,
    },
  });

  renderer.render();
  const rows = Array.from(window.document.querySelectorAll('.conversation-list-row'));
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.tagName === 'LI'));
  assert.ok(rows.every((row) => row.firstElementChild && row.firstElementChild.tagName === 'BUTTON'));
  assert.equal(rows[2].style.getPropertyValue('--tree-depth'), '2');
  assert.equal(rows[1].querySelector('.conversation-tree-status').textContent, '处理中');
  assert.ok(rows[0].querySelector('.conversation-spawn-button'));
  assert.equal(rows[2].querySelector('.conversation-spawn-button'), null);
  assert.equal(rows[2].dataset.depthLimit, 'true');
  const depthHint = rows[2].querySelector('.conversation-depth-limit-hint');
  assert.ok(depthHint, 'depth-limit row must render root-conversation guidance');
  assert.match(depthHint.textContent, /根聊天室|根会话|新建/);
  assert.equal(window.document.querySelector('[draggable="true"]'), null);

  state.selectedConversationId = 'root';
  renderer.toggle('root');
  assert.deepEqual(
    Array.from(window.document.querySelectorAll('.conversation-item'), (item) => item.dataset.id),
    ['root']
  );
});

test('tree rows hide compact status pills for terminal non-action delivery states', () => {
  const dom = new JSDOM('<ul id="conversation-list" class="conversation-list sidebar-list"></ul>', {
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.CaffChat = {};
  window.eval(fs.readFileSync(path.join(__dirname, '../../public/chat/cross-conversation-ui.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(__dirname, '../../public/chat/conversation-list.js'), 'utf8'));
  const state = {
    conversations: [
      conversation('root-a', { title: 'Root A' }),
      conversation('child-completed', {
        title: 'Child Done',
        parentConversationId: 'root-a',
        treeDepth: 1,
        createdAt: '2026-08-05T00:01:00.000Z',
        crossConversationStatus: delivery({
          dispatchStatus: 'completed',
          responseStatus: 'received',
        }),
      }),
      conversation('child-cancelled', {
        title: 'Child Cancelled',
        parentConversationId: 'root-a',
        treeDepth: 1,
        createdAt: '2026-08-05T00:02:00.000Z',
        crossConversationStatus: delivery({
          dispatchStatus: 'cancelled',
        }),
      }),
      conversation('child-failed', {
        title: 'Child Failed',
        parentConversationId: 'root-a',
        treeDepth: 1,
        createdAt: '2026-08-05T00:03:00.000Z',
        crossConversationStatus: delivery({
          dispatchStatus: 'failed',
          lastErrorCode: 'runtime_unavailable',
          lastErrorMessage: 'Primary Agent is unavailable',
        }),
      }),
      conversation('child-queued', {
        title: 'Child Queued',
        parentConversationId: 'root-a',
        treeDepth: 1,
        createdAt: '2026-08-05T00:04:00.000Z',
        crossConversationStatus: delivery({
          dispatchStatus: 'queued',
        }),
      }),
    ],
    selectedConversationId: 'child-completed',
  };
  const renderer = window.CaffChat.createConversationListRenderer({
    state,
    dom: { conversationList: window.document.getElementById('conversation-list') },
    helpers: {
      conversationPreviewText: (value) => String(value || ''),
      conversationTypeLabel: () => '标准',
      formatDateTime: () => '-',
      isConversationBusy: () => false,
      isUndercoverConversation: () => false,
      isWerewolfConversation: () => false,
    },
  });
  renderer.render();
  const rows = Array.from(window.document.querySelectorAll('.conversation-list-row'));
  const byTitle = new Map(rows.map((row) => [row.querySelector('.conversation-title-line strong').textContent, row]));
  assert.equal(byTitle.get('Child Done').querySelector('.conversation-tree-status'), null, 'completed terminal pill hidden');
  assert.equal(byTitle.get('Child Cancelled').querySelector('.conversation-tree-status'), null, 'cancelled terminal pill hidden');
  assert.equal(byTitle.get('Child Failed').querySelector('.conversation-tree-status').textContent, '失败', 'failed actionable pill shown');
  assert.equal(byTitle.get('Child Queued').querySelector('.conversation-tree-status').textContent, '已排队', 'queued actionable pill shown');
});

test('chat shell loads cross-conversation UI and the reused dialog exposes explicit non-Fork spawn fields', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  assert.match(html, /<script defer src="\/chat\/cross-conversation-ui\.js"><\/script>/u);
  for (const id of [
    'new-conversation-parent',
    'new-conversation-project',
    'new-conversation-primary-agent',
    'new-conversation-initial-message',
    'new-conversation-non-fork-note',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`, 'u'));
  }
});

test('message timeline renders durable receipt actions, external provenance, and a public spawn birth card', () => {
  const dom = new JSDOM('<div id="message-timeline"></div>', { runScripts: 'outside-only' });
  const { window } = dom;
  window.CaffChat = {};
  window.CaffShared = {};
  window.eval(fs.readFileSync(path.join(__dirname, '../../public/shared/conversation-digest.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(__dirname, '../../public/chat/cross-conversation-ui.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(__dirname, '../../public/chat/message-timeline.js'), 'utf8'));

  const failedBootstrap = delivery({
    id: 'bootstrap-1',
    kind: 'bootstrap',
    dispatchStatus: 'failed',
    responseStatus: 'not_expected',
    lastErrorMessage: 'Primary Agent is unavailable',
  });
  const requestDelivery = delivery({ id: 'request-1', kind: 'request', dispatchStatus: 'running' });
  const bundles = new Map([
    ['bootstrap-1', { delivery: failedBootstrap }],
    ['request-1', { delivery: requestDelivery }],
  ]);
  const messages = [
    {
      id: 'receipt-1',
      role: 'system',
      senderName: 'System',
      content: '',
      status: 'completed',
      createdAt: '2026-08-05T00:00:00.000Z',
      metadata: {
        kind: 'cross_conversation_receipt',
        crossConversation: {
          deliveryId: 'bootstrap-1',
          kind: 'bootstrap',
          targetConversationId: 'child',
          targetConversationTitle: 'Child room',
          targetAgentId: 'agent-1',
        },
      },
    },
    {
      id: 'external-1',
      role: 'external_agent',
      senderName: 'Reviewer',
      content: 'Please investigate this evidence.',
      status: 'completed',
      createdAt: '2026-08-05T00:01:00.000Z',
      metadata: {
        crossConversation: {
          deliveryId: 'request-1',
          kind: 'request',
          sourceConversationId: 'root',
          sourceConversationTitle: 'Root room',
          sourceAgentName: 'Reviewer',
        },
      },
    },
    {
      id: 'birth-1',
      role: 'user',
      senderName: 'You',
      content: 'This is the complete public first message.',
      status: 'completed',
      createdAt: '2026-08-05T00:02:00.000Z',
      metadata: {
        kind: 'conversation_spawn_initial_message',
        crossConversation: {
          deliveryId: 'bootstrap-1',
          kind: 'bootstrap',
          sourceConversationId: 'root',
          sourceConversationTitle: 'Root room',
        },
      },
    },
  ];
  const renderer = window.CaffChat.createMessageTimelineRenderer({
    dom: { messageTimeline: window.document.getElementById('message-timeline') },
    helpers: {
      agentById: () => null,
      buildAgentAvatarElement: () => window.document.createElement('span'),
      canInspectToolTrace: () => false,
      conversationSummaries: () => [conversation('root', { title: 'Root room' }), conversation('child', { title: 'Child room' })],
      crossConversationBundleForMessage(message) {
        const id = message.metadata && message.metadata.crossConversation && message.metadata.crossConversation.deliveryId;
        return bundles.get(id) || null;
      },
      displayedMessageBody: (message) => message.content,
      digestStatusForConversation: () => null,
      formatDateTime: () => '-',
      isPrivateTimelineMessage: () => false,
      liveStageForMessage: () => null,
      liveStageLabel: () => '',
      messageSessionInfo: () => ({ sessionPath: '', sessionName: '', canExport: false }),
      privateRecipientNames: () => [],
      renderMessageBody(container, text) { container.textContent = text; },
      timelineMessagesForConversation: (value) => value.messages,
      toolTraceSignatureForMessage: () => '',
      toolTraceStateForMessage: () => null,
    },
    showToast() {},
  });

  renderer.render({ id: 'root', messages, agents: [], metadata: {} }, null, []);

  const receipt = window.document.querySelector('[data-message-id="receipt-1"]');
  assert.ok(receipt.classList.contains('cross-conversation-receipt'));
  assert.equal(receipt.querySelector('.cross-conversation-status').textContent, '失败');
  assert.match(receipt.querySelector('.cross-conversation-error').textContent, /Primary Agent is unavailable/u);
  assert.ok(receipt.querySelector('[data-cross-conversation-action="retry"]'));
  assert.ok(receipt.querySelector('[data-cross-conversation-action="jump"]'));

  const external = window.document.querySelector('[data-message-id="external-1"]');
  assert.equal(external.querySelector('.cross-conversation-provenance').textContent.includes('来自 Root room'), true);
  assert.equal(external.querySelector('.message-body').textContent, 'Please investigate this evidence.');

  const birth = window.document.querySelector('[data-message-id="birth-1"]');
  assert.ok(birth.classList.contains('conversation-spawn-birth'));
  assert.match(birth.querySelector('.cross-conversation-birth').textContent, /全新会话/u);
  assert.equal(birth.querySelector('.cross-conversation-status').textContent, '失败');
  assert.match(birth.querySelector('.cross-conversation-error').textContent, /Primary Agent is unavailable/u);
  assert.ok(birth.querySelector('[data-cross-conversation-action="retry"]'));
  assert.equal(birth.querySelector('.message-body').textContent, 'This is the complete public first message.');
});
