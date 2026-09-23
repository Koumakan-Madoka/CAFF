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
    recoveryCapability: {
      enabled: true,
      eligible: true,
      reasonCode: '',
      reason: '',
      sourceKind: 'failed',
      systemActorType: 'recovery_scribe',
      routable: false,
    },
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

test('user-cancelled assistant card uses the optional stop-scene action label', async () => {
  const context = bootTimeline([{
    ...failedMessage(),
    metadata: {
      failure: true,
      cancelled: true,
      invocationFailure: {
        kind: 'cancelled',
        code: 'cancelled',
        eligible: false,
        terminationType: 'cancelled',
      },
    },
    recoveryCapability: {
      enabled: true,
      eligible: true,
      reasonCode: '',
      reason: '',
      sourceKind: 'user_cancelled',
      systemActorType: 'recovery_scribe',
      routable: false,
    },
  }]);
  const button = context.document.querySelector('.message-recovery-button');

  assert.ok(button);
  assert.equal(button.textContent, '整理停止现场');
  button.click();
  await new Promise((resolve) => context.window.setTimeout(resolve, 0));
  assert.deepEqual(context.recoveryCalls, [{ conversationId: 'conversation-1', messageId: 'failed-message' }]);
});

test('eligible capability with a missing or unknown source kind fails closed in the browser', () => {
  for (const sourceKind of [undefined, 'system_cancelled']) {
    const capability = {
      enabled: true,
      eligible: true,
      reasonCode: '',
      reason: '',
      systemActorType: 'recovery_scribe',
      routable: false,
      ...(sourceKind === undefined ? {} : { sourceKind }),
    };
    const context = bootTimeline([{
      ...failedMessage(),
      recoveryCapability: capability,
    }]);

    assert.equal(context.document.querySelector('.message-recovery-button'), null);
  }
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
    senderName: '系统书记（机械摘要）',
    content: '这是只读现场整理，不会执行或重放原任务。',
    status: 'completed',
    createdAt: '2026-08-26T00:01:00.000Z',
    metadata: {
      recoveryResult: true,
      systemActorType: 'recovery_scribe',
      systemActorRoutable: false,
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
  assert.match(provenance.textContent, /系统书记/u);
  assert.match(provenance.textContent, /机械摘要/u);
  assert.match(provenance.textContent, /只读/u);
  assert.match(provenance.textContent, /run 42/u);

  const chips = Array.from(provenance.querySelectorAll('.message-recovery-ref'));
  assert.equal(chips.length, 3);
  assert.match(chips[0].textContent, /来源消息 failed-m…/u);
  assert.match(chips[0].title, /failed-message/u);
  assert.match(chips[1].textContent, /task source-t…/u);
  assert.match(chips[1].title, /source-task/u);
  assert.match(chips[2].textContent, /run 42/u);
  assert.equal(chips.every((chip) => chip.disabled === false), true);

  const locateSource = provenance.querySelector('.message-recovery-locate');
  assert.ok(locateSource);
  assert.match(locateSource.textContent, /定位来源/u);
  assert.equal(context.document.querySelector('.message-recovery-button'), null);
});

test('disabled system scribe is visible as a platform service state and has no recovery command', () => {
  const context = bootTimeline([{
    ...failedMessage(),
    recoveryCapability: {
      enabled: false,
      eligible: false,
      reasonCode: 'conversation_recovery_disabled',
      reason: '系统书记已停用',
      systemActorType: 'recovery_scribe',
      routable: false,
    },
  }]);
  const panel = context.document.querySelector('.message-recovery-panel');

  assert.ok(panel);
  assert.match(panel.textContent, /系统书记已停用/u);
  assert.equal(panel.querySelector('.message-recovery-button'), null);
});

test('server-rejected recovery source shows the stable reason without an action', () => {
  const context = bootTimeline([{
    ...failedMessage(),
    recoveryCapability: {
      enabled: true,
      eligible: false,
      reasonCode: 'conversation_recovery_source_run_not_failed',
      reason: '来源运行没有可验证的失败终态或 assistant error 证据',
      systemActorType: 'recovery_scribe',
      routable: false,
    },
  }]);
  const panel = context.document.querySelector('.message-recovery-panel');

  assert.ok(panel);
  assert.match(panel.textContent, /来源运行没有可验证的失败终态/u);
  assert.equal(panel.querySelector('.message-recovery-button'), null);
});

test('failed assistant without a server recovery capability fails closed without an action', () => {
  const message = failedMessage();
  delete message.recoveryCapability;
  const context = bootTimeline([message]);

  assert.equal(context.document.querySelector('.message-recovery-button'), null);
});

test('terminal recovery state links the source card to the persisted result message', () => {
  const context = bootTimeline([failedMessage({
    id: 'recovery-1',
    sourceMessageId: 'failed-message',
    sourceTaskId: 'source-task',
    sourceRunId: 42,
    recoveryTaskId: 'recovery-task',
    recoveryRunId: 77,
    recoveryMessageId: 'result-message',
    status: 'completed',
    fallbackUsed: false,
  })]);
  const panel = context.document.querySelector('.message-recovery-panel');
  const locateResult = panel.querySelector('.message-recovery-locate');

  assert.ok(locateResult);
  assert.match(locateResult.textContent, /查看整理结果/u);
  locateResult.click();
  assert.equal(context.toasts.some((message) => /不在时间线/u.test(message)), true);
});

test('long partial reply stays collapsible while failure explanation remains visible', () => {
  const partialReply = `已完成部分调查 ${'x'.repeat(600)}`;
  const context = bootTimeline([{ ...failedMessage(), content: partialReply }]);
  const card = context.document.querySelector('[data-message-id="failed-message"]');
  const body = card.querySelector('.message-body');
  const toggle = card.querySelector('.message-error-toggle');

  assert.ok(toggle);
  assert.equal(toggle.hidden, false);
  assert.equal(body.classList.contains('collapsed-error'), true);
  assert.match(toggle.textContent, /展开错误详情/u);

  toggle.click();
  assert.equal(body.classList.contains('collapsed-error'), false);
  assert.match(toggle.textContent, /收起错误详情/u);

  toggle.click();
  assert.equal(body.classList.contains('collapsed-error'), true);
});

test('short failed error body stays fully visible without a toggle', () => {
  const context = bootTimeline([failedMessage()]);
  const card = context.document.querySelector('[data-message-id="failed-message"]');

  assert.equal(card.querySelector('.message-body').classList.contains('collapsed-error'), false);
  assert.equal(card.querySelector('.message-error-toggle').hidden, true);
});

test('failed bubbles explain the observed failure instead of internal wrapper errors', () => {
  const cases = [
    [{ kind: 'timeout', code: 'progress_timeout' }, '等待进展超时', '可刷新进度'],
    [{ kind: 'timeout', code: 'heartbeat_timeout' }, '运行心跳超时', '心跳'],
    [{ kind: 'timeout', code: 'run_timeout' }, '运行总时限已到', '总时限'],
    [{ kind: 'cancelled', code: 'stop_requested' }, '运行已停止', '停止请求'],
    [{ kind: 'process_exit', code: 'SIGTERM' }, '运行进程异常退出', 'SIGTERM'],
    [{ kind: 'provider', code: 'assistant_error', summary: '429 Too Many Requests' }, '模型调用失败', '限流'],
    [{ kind: 'provider', code: 'assistant_error', summary: '401 Unauthorized' }, '模型调用失败', '认证失败'],
    [{ kind: 'provider', code: 'econnreset' }, '模型调用失败', '连接被重置'],
    [{ kind: 'provider', code: 'assistant_error', summary: 'connection error: stream_read_error' }, '模型调用失败', '响应流读取失败'],
    [{ kind: 'provider', code: 'assistant_error', summary: 'insufficient balance' }, '模型调用失败', '余额或额度不足'],
    [{ kind: 'provider', code: 'assistant_error', summary: 'HTTP 503 Service unavailable' }, '模型调用失败', '服务端错误'],
    [{ kind: 'provider', code: 'assistant_error', summary: '403 Forbidden' }, '模型调用失败', '访问被拒绝'],
    [{ kind: 'provider', code: 'assistant_error', summary: 'Unknown error: request body contains 401 and rate limit' }, '模型调用失败', '未提供可安全展示'],
    [{ kind: 'timeout', code: 'unexpected' }, '运行超时', '未明确超时类型'],
    [{ kind: 'provider', code: 'assistant_error' }, '模型调用失败', '未提供可安全展示的具体原因'],
    [{ kind: 'unknown', code: 'unclassified_invocation_error' }, '回复失败', '无法确认具体原因'],
  ];
  for (const [failure, title, explanation] of cases) {
    const context = bootTimeline([{
      ...failedMessage(), errorMessage: failure.kind === 'unknown' ? 'local invocation failed' : 'pi assistant reported a model invocation error',
      metadata: { invocationFailure: failure },
    }]);
    const panel = context.document.querySelector('.message-failure-panel');
    assert.ok(panel, title);
    assert.equal(panel.hidden, false);
    assert.match(panel.textContent, new RegExp(title, 'u'));
    assert.match(panel.textContent, new RegExp(explanation, 'u'));
    assert.match(panel.querySelector('details').textContent, /run 42/u);
    assert.doesNotMatch(panel.textContent, /pi assistant reported/u);
    context.window.close();
  }
});

test('empty reply is explained without claiming a timeout or a provider root cause', () => {
  const context = bootTimeline([{ ...failedMessage(), errorMessage: 'Empty agent reply' }]);
  const panel = context.document.querySelector('.message-failure-panel');
  assert.ok(panel);
  assert.match(panel.textContent, /未收到可展示的最终答复/u);
  assert.doesNotMatch(panel.textContent, /挂死|超时|Empty agent reply/u);
  context.window.close();
});

test('failure stays visible beside partial output and updates when only classification changes', () => {
  const message = { ...failedMessage(), content: '已完成第一步。', metadata: { invocationFailure: { kind: 'timeout', code: 'progress_timeout' } } };
  const context = bootTimeline([message]);
  const card = context.document.querySelector('.message-card');
  assert.match(card.querySelector('.message-body').textContent, /已完成第一步/u);
  assert.match(card.querySelector('.message-failure-panel').textContent, /等待进展超时/u);
  card.querySelector('.message-failure-panel details').open = true;
  message.metadata.invocationFailure = { kind: 'cancelled', code: 'cancelled' };
  context.renderer.render(context.conversation, null, []);
  assert.match(card.querySelector('.message-failure-panel').textContent, /运行已停止/u);
  assert.equal(card.querySelector('.message-failure-panel details').open, true);
  message.status = 'completed';
  context.renderer.render(context.conversation, null, []);
  assert.equal(card.querySelector('.message-failure-panel').hidden, true);
  assert.equal(card.querySelector('.message-failure-panel').textContent, '');
  context.window.close();
});

test('failure presentation never renders arbitrary provider bodies, codes, credentials or markup', () => {
  const sentinel = 'PRIVATE_SENTINEL';
  const raw = `401 Unauthorized {"api_key":"${sentinel}","prompt":"${sentinel}"} https://user:${sentinel}@host/?token=${sentinel} <img src=x onerror=alert(1)>`;
  const context = bootTimeline([{
    ...failedMessage(), content: `[错误] ${raw}`, errorMessage: raw,
    metadata: { invocationFailure: { kind: 'provider', code: sentinel, summary: raw } },
  }]);
  const card = context.document.querySelector('.message-card');
  assert.doesNotMatch(card.outerHTML, /PRIVATE_SENTINEL|api_key|onerror|https:\/\//u);
  assert.equal(card.querySelector('.message-failure-panel img'), null);
  assert.match(card.querySelector('.message-failure-panel').textContent, /认证失败/u);
  context.window.close();
});

test('runtime classification survives transport into the bubble without mutating recovery policy', () => {
  const { classifyAgentInvocationFailure } = require('../../build/server/domain/conversation/turn/agent-executor');
  const { projectMessageForTransport } = require('../../build/lib/message-detail-contract');
  const failures = [
    [{ message: 'pi assistant reported a model invocation error', assistantErrors: ['connection error: stream_read_error'] }, '响应流读取失败'],
    [{ message: 'progress expired', terminationReason: { type: 'progress_timeout' } }, '等待进展超时'],
    [new Error('Empty agent reply'), '未收到最终回复'],
  ];
  for (const [error, label] of failures) {
    const classification = classifyAgentInvocationFailure(error);
    const message = projectMessageForTransport({ ...failedMessage(), errorMessage: error.message, metadata: { invocationFailure: classification } });
    const before = JSON.stringify(message);
    Object.freeze(classification);
    const context = bootTimeline([message]);
    assert.match(context.document.querySelector('.message-failure-panel').textContent, new RegExp(label, 'u'));
    assert.equal(JSON.stringify(message), before);
    assert.equal(context.document.querySelector('.message-recovery-button').disabled, false);
    context.window.close();
  }
});

test('legacy wrappers, malformed metadata and non-failure messages degrade safely', () => {
  const context = bootTimeline([]);
  const project = context.window.CaffChat.messageFailurePresentation;
  const message = { ...failedMessage(), errorMessage: 'pi assistant reported a model invocation error' };
  assert.equal(project(message).title, '模型调用失败');
  for (const metadata of [null, 'bad', { invocationFailure: null }, { invocationFailure: 'bad' }]) {
    assert.equal(project({ ...message, metadata }).title, '模型调用失败');
  }
  assert.equal(project({ ...message, status: 'completed' }), null);
  assert.equal(project({ ...message, role: 'user' }), null);
  const untrusted = project({ ...message, runId: 'PRIVATE_SENTINEL', metadata: { invocationFailure: { kind: 'process_exit', code: 'PRIVATE_SENTINEL' } } });
  assert.doesNotMatch(JSON.stringify(untrusted), /PRIVATE_SENTINEL/u);
  context.window.close();
});

test('app display fallback uses safe failure text and preserves ordinary and private replies', () => {
  const context = bootTimeline([]);
  const source = readPublic('app.js');
  const start = source.indexOf('function messageDisplayText(');
  const end = source.indexOf('function conversationPreviewText(', start);
  context.window.eval(source.slice(start, end));
  const display = context.window.messageDisplayText;
  assert.match(display({ ...failedMessage(), errorMessage: 'Empty agent reply' }), /未收到可展示的最终答复/u);
  assert.doesNotMatch(display({ ...failedMessage(), errorMessage: 'secret=PRIVATE_SENTINEL' }), /PRIVATE_SENTINEL/u);
  assert.equal(display({ status: 'completed', content: '正常答复' }), '正常答复');
  assert.equal(display({ status: 'completed', content: '', metadata: { privateOnly: true } }), '[仅私密备注]');
  context.window.close();
});

test('recovery controls have stable touch geometry and SSE refresh wiring', () => {
  const styles = readPublic('styles.css');
  const app = readPublic('app.js');

  assert.match(styles, /\.message-recovery-button[\s\S]*?min-height:\s*44px/u);
  assert.match(styles, /\.message-recovery-panel[\s\S]*?min-width:\s*0/u);
  assert.match(app, /conversation_recovery_updated[\s\S]*?scheduleConversationRefresh/u);
  assert.match(app, /messages\/\$\{encodeURIComponent\(normalizedMessageId\)\}\/recovery/u);
});
