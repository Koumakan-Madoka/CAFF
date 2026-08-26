const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');

function readPublic(relativePath) {
  return fs.readFileSync(path.join(ROOT, 'public', relativePath), 'utf8');
}

function bootTimeline(messages, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="timeline"></div></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const { document } = window;
  const recoveryCalls = [];
  const toasts = [];
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

  const conversation = { id: 'conversation-1', agents: [], messages };
  const renderer = window.CaffChat.createMessageTimelineRenderer({
    dom: { messageTimeline: document.getElementById('timeline') },
    helpers: {
      agentById: () => null,
      buildAgentAvatarElement: () => document.createElement('span'),
      canInspectToolTrace: () => false,
      conversationSummaries: () => [],
      crossConversationBundleForMessage: () => null,
      deleteConversationMessages: async () => ({}),
      displayedMessageBody: (message) => message.content,
      digestStatusForConversation: () => null,
      formatDateTime: () => 'now',
      isConversationMessageDeletionBlocked: () => false,
      isPrivateTimelineMessage: () => false,
      liveStageForMessage: () => null,
      liveStageLabel: () => '',
      messageSessionInfo: () => ({ sessionPath: '', sessionName: '', canExport: false }),
      privateRecipientNames: () => [],
      recoverFailedMessage: async (conversationId, messageId) => {
        recoveryCalls.push({ conversationId, messageId });
        if (options.recoveryError) {
          throw options.recoveryError;
        }
        return {
          duplicate: false,
          recovery: {
            id: 'recovery-1',
            sourceMessageId: messageId,
            sourceTaskId: 'source-task',
            sourceRunId: 42,
            recoveryTaskId: 'recovery-task',
            recoveryRunId: null,
            recoveryMessageId: null,
            status: 'queued',
            fallbackUsed: false,
          },
        };
      },
      renderMessageBody: (container, text) => { container.textContent = text; },
      timelineMessagesForConversation: (item) => item.messages,
      toolTraceSignatureForMessage: () => '',
      toolTraceStateForMessage: () => null,
    },
    showToast(message) {
      toasts.push(String(message));
    },
  });
  renderer.render(conversation, null, []);
  return { dom, window, document, conversation, renderer, recoveryCalls, toasts };
}

function failedMessage(recovery = null) {
  return {
    id: 'failed-message',
    role: 'assistant',
    senderName: 'GPT',
    content: '',
    status: 'failed',
    taskId: 'source-task',
    runId: 42,
    errorMessage: 'stream_read_error',
    createdAt: '2026-08-26T00:00:00.000Z',
    metadata: { failure: true },
    deletionEligibility: { eligible: true, reasonCode: '', reason: '' },
    ...(recovery ? { recovery } : {}),
  };
}

test('failed assistant card exposes one manual recovery command and applies queued acknowledgement', async () => {
  const context = bootTimeline([failedMessage()]);
  const button = context.document.querySelector('.message-recovery-button');

  assert.ok(button);
  assert.equal(button.textContent, '整理失败现场');
  assert.equal(button.disabled, false);
  button.click();
  await new Promise((resolve) => context.window.setTimeout(resolve, 0));

  assert.deepEqual(context.recoveryCalls, [{ conversationId: 'conversation-1', messageId: 'failed-message' }]);
  const card = context.document.querySelector('[data-message-id="failed-message"]');
  assert.equal(card.querySelector('.message-recovery-button').disabled, true);
  assert.match(card.querySelector('.message-recovery-status').textContent, /等待整理/u);
});

test('recovery state labels are canonical and terminal states never offer retry', () => {
  const cases = [
    ['queued', false, '等待整理', true],
    ['running', false, '正在整理', true],
    ['completed', false, '整理完成', false],
    ['failed', true, '机械摘要', false],
  ];

  for (const [status, fallbackUsed, label, hasDisabledButton] of cases) {
    const recovery = {
      id: `recovery-${status}`,
      sourceMessageId: 'failed-message',
      sourceTaskId: 'source-task',
      sourceRunId: 42,
      recoveryTaskId: 'recovery-task',
      recoveryRunId: status === 'queued' ? null : 77,
      recoveryMessageId: ['completed', 'failed'].includes(status) ? 'result-message' : null,
      status,
      fallbackUsed,
    };
    const context = bootTimeline([failedMessage(recovery)]);
    const panel = context.document.querySelector('.message-recovery-panel');
    assert.match(panel.textContent, new RegExp(label, 'u'));
    const button = panel.querySelector('.message-recovery-button');
    assert.equal(Boolean(button), hasDisabledButton);
    if (button) {
      assert.equal(button.disabled, true);
    }
  }
});

test('recovery result message visibly identifies source trace and read-only provenance', () => {
  const resultMessage = {
    id: 'result-message',
    role: 'assistant',
    senderName: 'Recovery Scribe (Mechanical)',
    content: '这是只读现场整理，不会执行或重放原任务。',
    status: 'completed',
    createdAt: '2026-08-26T00:01:00.000Z',
    metadata: {
      recoveryResult: true,
      sourceMessageId: 'failed-message',
      sourceTaskId: 'source-task',
      sourceRunId: 42,
      recoveryTaskId: 'recovery-task',
      recoveryRunId: 77,
      fallbackUsed: true,
      nonExecution: true,
    },
  };
  const context = bootTimeline([resultMessage]);
  const provenance = context.document.querySelector('.message-recovery-provenance');

  assert.ok(provenance);
  assert.match(provenance.textContent, /机械摘要/u);
  assert.match(provenance.textContent, /failed-message/u);
  assert.match(provenance.textContent, /source-task/u);
  assert.match(provenance.textContent, /run 42/u);
  assert.match(provenance.textContent, /只读/u);
  assert.equal(context.document.querySelector('.message-recovery-button'), null);
});

test('recovery controls have stable touch geometry and SSE refresh wiring', () => {
  const styles = readPublic('styles.css');
  const app = readPublic('app.js');

  assert.match(styles, /\.message-recovery-button[\s\S]*?min-height:\s*44px/u);
  assert.match(styles, /\.message-recovery-panel[\s\S]*?min-width:\s*0/u);
  assert.match(app, /conversation_recovery_updated[\s\S]*?scheduleConversationRefresh/u);
  assert.match(app, /messages\/\$\{encodeURIComponent\(normalizedMessageId\)\}\/recovery/u);
});
