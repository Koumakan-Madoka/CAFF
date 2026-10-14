const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');

function readPublic(relativePath) {
  return fs.readFileSync(path.join(ROOT, 'public', relativePath), 'utf8');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createPreviewHarness({ fetchPreview, debounceMs = 5, conversationId = 'conv-1' } = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="bar" class="routing-preview hidden"></div><textarea id="input"></textarea></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only' }
  );
  const { window } = dom;
  window.CaffChat = {};
  window.eval(readPublic('chat/routing-preview.js'));

  const input = window.document.getElementById('input');
  const bar = window.document.getElementById('bar');
  const env = { conversationId };
  const calls = [];
  const trackingFetch = (id, content) => {
    calls.push({ conversationId: id, content });
    return fetchPreview(id, content);
  };

  const controller = window.CaffChat.createRoutingPreviewController({
    dom: { composerInput: input, routingPreview: bar },
    helpers: {
      getConversationId: () => env.conversationId,
      fetchPreview: trackingFetch,
      debounceMs,
    },
  });
  controller.bindEvents();

  function type(value) {
    input.value = value;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  }

  return { dom, window, input, bar, controller, env, calls, type };
}

const GPT_PREVIEW = {
  conversationId: 'conv-1',
  agentIds: ['role-family-gpt'],
  agents: [{ id: 'role-family-gpt', name: 'GPT' }],
  strategy: 'user_mentions',
  executionMode: 'serial',
  explicitIntent: '',
};

test('preview bar debounces input and renders target, reason and execution mode', async () => {
  const harness = createPreviewHarness({
    fetchPreview: async () => GPT_PREVIEW,
  });

  try {
    harness.type('hello @GPT');
    assert.equal(harness.calls.length, 0, 'fetch must be debounced, not fired synchronously');
    assert.equal(harness.bar.classList.contains('hidden'), true);

    await delay(40);
    assert.equal(harness.calls.length, 1);
    assert.deepEqual(harness.calls[0], { conversationId: 'conv-1', content: 'hello @GPT' });
    assert.equal(harness.bar.classList.contains('hidden'), false);
    assert.equal(harness.bar.textContent, '将唤醒 GPT · mention 命中 · 串行执行');
  } finally {
    harness.dom.window.close();
  }
});

test('empty draft hides the bar and sends zero requests', async () => {
  const harness = createPreviewHarness({
    fetchPreview: async () => GPT_PREVIEW,
  });

  try {
    harness.type('');
    await delay(40);
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.bar.classList.contains('hidden'), true);
  } finally {
    harness.dom.window.close();
  }
});

test('stale responses never overwrite a newer draft preview', async () => {
  const first = deferred();
  const second = deferred();
  const previews = [first, second];
  let index = 0;
  const harness = createPreviewHarness({
    fetchPreview: () => previews[index++].promise,
  });

  try {
    harness.type('first draft');
    await delay(30);
    assert.equal(harness.calls.length, 1);

    harness.type('second draft');
    await delay(30);
    assert.equal(harness.calls.length, 2);

    second.resolve({
      ...GPT_PREVIEW,
      agents: [{ id: 'role-family-kimi', name: 'Kimi' }],
      strategy: 'default_last_agent',
    });
    await delay(10);
    assert.equal(harness.bar.textContent, '将唤醒 Kimi · 跟随最近回复者 · 串行执行');

    // The older request resolves last; it must not clobber the newer preview.
    first.resolve(GPT_PREVIEW);
    await delay(10);
    assert.equal(harness.bar.textContent, '将唤醒 Kimi · 跟随最近回复者 · 串行执行');
  } finally {
    harness.dom.window.close();
  }
});

test('a late response must not re-show the bar after the draft was cleared', async () => {
  const pending = deferred();
  const harness = createPreviewHarness({
    fetchPreview: () => pending.promise,
  });

  try {
    harness.type('hello');
    await delay(30);
    assert.equal(harness.calls.length, 1);

    harness.type('');
    assert.equal(harness.bar.classList.contains('hidden'), true);

    pending.resolve(GPT_PREVIEW);
    await delay(10);
    assert.equal(harness.bar.classList.contains('hidden'), true);
    assert.equal(harness.bar.textContent, '');
  } finally {
    harness.dom.window.close();
  }
});

test('responses from a previous conversation are dropped', async () => {
  const pendings = [];
  const harness = createPreviewHarness({
    fetchPreview: () => {
      const pending = deferred();
      pendings.push(pending);
      return pending.promise;
    },
  });

  try {
    harness.type('hello');
    await delay(30);
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0].conversationId, 'conv-1');

    // Switching rooms re-targets the same draft at the new conversation.
    harness.env.conversationId = 'conv-2';
    harness.controller.syncDraft();
    await delay(30);
    assert.equal(harness.calls.length, 2);
    assert.equal(harness.calls[1].conversationId, 'conv-2');

    // The old conversation's late response must not render.
    pendings[0].resolve(GPT_PREVIEW);
    await delay(10);
    assert.equal(harness.bar.classList.contains('hidden'), true);

    pendings[1].resolve({ ...GPT_PREVIEW, conversationId: 'conv-2' });
    await delay(10);
    assert.equal(harness.bar.classList.contains('hidden'), false);
  } finally {
    harness.dom.window.close();
  }
});

test('multi-target drafts render all agents with parallel mode and explicit intent', async () => {
  const harness = createPreviewHarness({
    fetchPreview: async () => ({
      conversationId: 'conv-1',
      agentIds: ['role-family-gpt', 'role-family-kimi'],
      agents: [
        { id: 'role-family-gpt', name: 'GPT' },
        { id: 'role-family-kimi', name: 'Kimi' },
      ],
      strategy: 'user_mentions',
      executionMode: 'parallel',
      explicitIntent: 'ideate',
    }),
  });

  try {
    harness.type('@GPT @Kimi #ideate brainstorm');
    await delay(40);
    assert.equal(harness.bar.textContent, '将唤醒 GPT、Kimi · mention 命中 · #ideate · 并行执行');
  } finally {
    harness.dom.window.close();
  }
});

test('fetch failures hide the bar quietly', async () => {
  const harness = createPreviewHarness({
    fetchPreview: async () => {
      throw new Error('boom');
    },
  });

  try {
    harness.type('hello');
    await delay(40);
    assert.equal(harness.bar.classList.contains('hidden'), true);
  } finally {
    harness.dom.window.close();
  }
});

test('routing annotation model reflects persisted accept-time routing', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  });

  try {
    dom.window.CaffChat = {};
    dom.window.eval(readPublic('chat/routing-preview.js'));
    const { routingPreview } = dom.window.CaffChat;
    const agents = [
      { id: 'role-family-gpt', name: 'GPT' },
      { id: 'role-family-kimi', name: 'Kimi' },
    ];
    const agentById = (id) => agents.find((agent) => agent.id === id) || null;

    const annotation = routingPreview.routingAnnotationForMessage(
      {
        role: 'user',
        metadata: {
          routing: {
            agentIds: ['role-family-gpt'],
            strategy: 'user_mentions',
            executionMode: 'serial',
            explicitIntent: '',
          },
        },
      },
      agentById
    );
    assert.ok(annotation);
    assert.equal(annotation.lane, 'main');
    assert.equal(annotation.text, '已路由 → GPT · mention 命中 · 串行执行');

    const side = routingPreview.routingAnnotationForMessage(
      {
        role: 'user',
        metadata: {
          dispatchLane: 'side',
          dispatchTargetAgentId: 'role-family-kimi',
          routing: {
            agentIds: ['role-family-gpt'],
            strategy: 'user_mentions',
            executionMode: 'serial',
            explicitIntent: '',
          },
        },
      },
      agentById
    );
    assert.ok(side);
    assert.equal(side.lane, 'side');
    assert.equal(side.text, '已路由 → Kimi · 旁路派发');

    // Legacy messages without routing metadata render nothing and never throw.
    assert.equal(routingPreview.routingAnnotationForMessage({ role: 'user' }, agentById), null);
    assert.equal(
      routingPreview.routingAnnotationForMessage({ role: 'user', metadata: { routing: { agentIds: [] } } }, agentById),
      null
    );
  } finally {
    dom.window.close();
  }
});

function renderTimelineWithMessage(message) {
  const dom = new JSDOM('<!doctype html><html><body><div id="timeline"></div></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const { document } = window;
  window.CaffShared = {
    conversationDigest: {
      digestsForConversation: () => [],
      digestKindLabel: () => '',
      digestKindHelp: () => '',
      createDigestSourceLocator: () => ({ focusSourceMessage() {} }),
    },
  };
  window.CaffIcons = {
    create(name) {
      const icon = document.createElement('span');
      icon.dataset.icon = name;
      return icon;
    },
  };
  window.CaffChat = {
    crossConversationUi: {
      receiptModel: () => null,
      provenanceModel: () => null,
      birthModel: () => null,
    },
  };
  window.eval(readPublic('chat/message-images.js'));
  window.eval(readPublic('chat/routing-preview.js'));
  window.eval(readPublic('chat/message-timeline.js'));

  const agents = [
    { id: 'role-family-gpt', name: 'GPT' },
    { id: 'role-family-kimi', name: 'Kimi' },
  ];
  const conversation = { id: 'conv-ui', agents, messages: [message] };
  const renderer = window.CaffChat.createMessageTimelineRenderer({
    dom: { messageTimeline: document.getElementById('timeline') },
    helpers: {
      agentById: (id) => agents.find((agent) => agent.id === id) || null,
      buildAgentAvatarElement: () => document.createElement('span'),
      canInspectToolTrace: () => false,
      conversationSummaries: () => [],
      crossConversationBundleForMessage: () => null,
      deleteConversationMessages: async () => ({}),
      displayedMessageBody: (item) => item.content,
      digestStatusForConversation: () => null,
      formatDateTime: () => 'now',
      isConversationMessageDeletionBlocked: () => false,
      isPrivateTimelineMessage: () => false,
      liveStageForMessage: () => null,
      liveStageLabel: () => '',
      messageSessionInfo: () => ({ sessionPath: '', sessionName: '', canExport: false }),
      privateRecipientNames: () => [],
      renderMessageBody: (container, text) => {
        container.textContent = text;
      },
      timelineMessagesForConversation: (item) => item.messages,
      toolTraceSignatureForMessage: () => '',
      toolTraceStateForMessage: () => null,
    },
    showToast() {},
  });
  renderer.render(conversation, null, []);
  return { dom, document };
}

test('sent user message renders the persisted routing annotation', () => {
  const { dom, document } = renderTimelineWithMessage({
    id: 'u-routed',
    conversationId: 'conv-ui',
    role: 'user',
    senderName: 'You',
    content: 'hello @GPT',
    status: 'completed',
    createdAt: '2026-10-14T08:00:00.000Z',
    metadata: {
      routing: {
        agentIds: ['role-family-gpt'],
        strategy: 'user_mentions',
        executionMode: 'serial',
        explicitIntent: '',
      },
    },
    deletionEligibility: { eligible: true, reasonCode: '', reason: '' },
  });

  try {
    const badge = document.querySelector('.message-routing-annotation');
    assert.ok(badge, 'routing annotation should be rendered');
    assert.equal(badge.textContent, '已路由 → GPT · mention 命中 · 串行执行');
    assert.equal(badge.dataset.routingLane, 'main');
  } finally {
    dom.window.close();
  }
});

test('legacy user message without routing metadata renders no annotation and does not throw', () => {
  const { dom, document } = renderTimelineWithMessage({
    id: 'u-legacy',
    conversationId: 'conv-ui',
    role: 'user',
    senderName: 'You',
    content: 'old message',
    status: 'completed',
    createdAt: '2026-10-01T08:00:00.000Z',
    metadata: {},
    deletionEligibility: { eligible: true, reasonCode: '', reason: '' },
  });

  try {
    assert.equal(document.querySelector('.message-routing-annotation'), null);
  } finally {
    dom.window.close();
  }
});
