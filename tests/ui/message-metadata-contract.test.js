const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');

function readPublic(relativePath) {
  return fs.readFileSync(path.join(ROOT, 'public', relativePath), 'utf8');
}

function renderLightweightAssistantMessage() {
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
  window.eval(readPublic('chat/message-timeline.js'));

  const message = {
    id: 'contract-ui-message',
    conversationId: 'contract-ui-conversation',
    turnId: 'contract-ui-turn',
    role: 'assistant',
    agentId: 'role-family-gpt',
    senderName: 'GPT',
    content: 'Contract reply',
    status: 'completed',
    createdAt: '2026-08-25T08:00:00.000Z',
    metadata: {
      agentContextSnapshot: {
        schemaVersion: 1,
        snapshotId: 'snapshot-contract-ui',
        capturedAt: '2026-08-25T08:00:00.000Z',
        conversationId: 'contract-ui-conversation',
        turnId: 'contract-ui-turn',
        messageId: 'contract-ui-message',
        agentId: 'role-family-gpt',
        agentName: 'GPT',
        promptVersion: 'contract-ui-test',
        immutable: true,
        totalApproxTokens: 1200,
        totalByteSize: 4800,
        sectionCount: 7,
      },
      modelUsage: {
        modelCallCount: 65,
        coldStartModelCallCount: 1,
        postColdModelCallCount: 64,
        providerMissCount: 2,
        callsTruncated: true,
        retainedCallCount: 64,
        droppedCallCount: 1,
      },
      tokenUsage: {
        inputTokens: 4000,
        uncachedInputTokens: 100,
        outputTokens: 200,
        totalTokens: 4200,
        cacheReadTokens: 3900,
        cacheWriteTokens: 0,
      },
    },
    deletionEligibility: { eligible: true, reasonCode: '', reason: '' },
  };
  const conversation = {
    id: 'contract-ui-conversation',
    agents: [{ id: 'role-family-gpt', name: 'GPT' }],
    messages: [message],
  };
  const renderer = window.CaffChat.createMessageTimelineRenderer({
    dom: { messageTimeline: document.getElementById('timeline') },
    helpers: {
      agentById: () => conversation.agents[0],
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
      renderMessageBody: (container, text) => { container.textContent = text; },
      timelineMessagesForConversation: (item) => item.messages,
      toolTraceSignatureForMessage: () => '',
      toolTraceStateForMessage: () => null,
    },
    showToast() {},
  });
  renderer.render(conversation, null, []);
  return { dom, document };
}

test('timeline keeps context inspection and aggregate usage UI with Contract metadata only', () => {
  const { dom, document } = renderLightweightAssistantMessage();
  try {
    const contextButton = document.querySelector('.message-context-button');
    assert.ok(contextButton);
    assert.equal(contextButton.disabled, false);
    assert.equal(contextButton.dataset.messageId, 'contract-ui-message');

    const usageBadge = document.querySelector('.message-token-usage');
    assert.ok(usageBadge);
    assert.match(usageBadge.textContent, /65 次模型调用/u);
    assert.match(usageBadge.textContent, /provider miss 2\/64 次模型调用/u);
    assert.equal(document.body.textContent.includes('displayContent'), false);
    assert.equal(document.body.textContent.includes('calls'), false);
  } finally {
    dom.window.close();
  }
});
