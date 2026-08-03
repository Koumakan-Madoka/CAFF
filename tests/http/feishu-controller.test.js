const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createFeishuController } = require('../../build/server/api/feishu-controller');
const { createFeishuIntegrationService } = require('../../build/server/domain/integrations/feishu/feishu-service');
const { createRoleService } = require('../../build/server/domain/roles/role-service');
const { withTempDir } = require('../helpers/temp-dir');

function createSilentLogger() {
  return {
    log() {},
    warn() {},
  };
}

function createFeishuTestHarness(t, options = {}) {
  const tempDir = withTempDir('caff-feishu-http-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const defaultRole = store.saveCustomRoleConfig({
    id: 'feishu-default-role',
    name: 'Feishu Default Role',
    personaPrompt: 'Handle explicitly configured Feishu conversations.',
  });
  const defaultRoleIds = Object.prototype.hasOwnProperty.call(options, 'defaultRoleIds')
    ? options.defaultRoleIds
    : [defaultRole.id];
  const roleService = createRoleService({
    store,
    modelCatalog: { getOptions() { return []; } },
  });
  const sentMessages = [];
  const calls = [];
  const client = {
    initialize() {
      return Promise.resolve(options.botOpenId || 'bot-open-id');
    },
    ensureBotOpenId() {
      return Promise.resolve(options.botOpenId || 'bot-open-id');
    },
    sendTextMessage(chatId, text) {
      sentMessages.push({ chatId, text });
      return Promise.resolve({ messageId: `om_out_${sentMessages.length}`, payload: { ok: true } });
    },
  };
  const turnOrchestrator = {
    submitConversationMessage(conversationId, input) {
      calls.push({ conversationId, input });

      if (typeof options.submitConversationMessage === 'function') {
        return options.submitConversationMessage({ conversationId, input, store, calls });
      }

      const acceptedMessage = store.createMessage({
        id: `accepted-${calls.length}`,
        conversationId,
        turnId: `turn-${calls.length}`,
        role: 'user',
        senderName: input.senderName,
        content: input.content,
        status: 'completed',
        metadata: input.metadata,
      });
      return {
        acceptedMessage,
        conversation: store.getConversation(conversationId),
        conversations: store.listConversations(),
        dispatch: 'started',
        dispatchLane: 'main',
        dispatchTargetAgentId: null,
        runtime: {},
      };
    },
  };
  const feishuService = createFeishuIntegrationService({
    store,
    turnOrchestrator,
    client,
    defaultRoleIds,
    modeStore: options.modeStore,
    roleService,
    verificationToken: 'test-feishu-token',
    logger: createSilentLogger(),
  });
  const controller = createFeishuController({ feishuService });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return {
    calls,
    controller,
    defaultRole,
    sentMessages,
    store,
  };
}

async function invokeWebhook(controller, body) {
  const req = new PassThrough();
  req.method = 'POST';
  const responseState = {
    statusCode: 0,
    headers: null,
    body: '',
  };
  const res = {
    writeHead(statusCode, headers) {
      responseState.statusCode = statusCode;
      responseState.headers = headers;
    },
    end(chunk = '') {
      responseState.body = String(chunk || '');
    },
  };

  const handledPromise = controller({
    req,
    res,
    pathname: '/api/integrations/feishu/webhook',
    requestUrl: new URL('http://127.0.0.1/api/integrations/feishu/webhook'),
  });

  req.end(JSON.stringify(body));

  const handled = await handledPromise;
  return {
    handled,
    json: responseState.body ? JSON.parse(responseState.body) : {},
    statusCode: responseState.statusCode,
  };
}

test('feishu controller returns challenge response after token verification', async (t) => {
  const { controller, calls } = createFeishuTestHarness(t);
  const response = await invokeWebhook(controller, {
    type: 'url_verification',
    token: 'test-feishu-token',
    challenge: 'challenge-token',
  });

  assert.equal(response.handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json, { challenge: 'challenge-token' });
  assert.equal(calls.length, 0);
});

test('feishu controller rejects invalid verification tokens', async (t) => {
  const { controller, store } = createFeishuTestHarness(t);

  await assert.rejects(
    () => invokeWebhook(controller, {
      type: 'url_verification',
      token: 'wrong-token',
      challenge: 'challenge-token',
    }),
    (error) => {
      assert.equal(error.statusCode, 401);
      assert.match(error.message, /verification token/i);
      return true;
    }
  );

  const bindingCount = store.db.prepare('SELECT COUNT(*) AS count FROM chat_channel_bindings').get().count;
  assert.equal(bindingCount, 0);
});

test('feishu controller creates a conversation binding and deduplicates repeated inbound messages', async (t) => {
  const { controller, calls, store } = createFeishuTestHarness(t);
  const payload = {
    header: {
      token: 'test-feishu-token',
      event_id: 'evt-feishu-1',
      event_type: 'im.message.receive_v1',
    },
    event: {
      sender: {
        sender_id: {
          open_id: 'ou-user-1',
        },
        sender_type: 'user',
      },
      message: {
        message_id: 'om-inbound-1',
        chat_id: 'oc-chat-1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({
          text: 'hello from feishu',
        }),
      },
    },
  };

  const firstResponse = await invokeWebhook(controller, payload);
  assert.equal(firstResponse.statusCode, 200);
  assert.equal(firstResponse.json.processed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.content, 'hello from feishu');
  assert.equal(calls[0].input.senderName, 'FeishuUser:ou-user-1');
  assert.equal(calls[0].input.metadata.source, 'feishu');
  assert.equal(calls[0].input.metadata.feishu.chatId, 'oc-chat-1');

  const binding = store.getConversationChannelBinding('feishu', 'oc-chat-1');
  assert.ok(binding);
  assert.equal(binding.platform, 'feishu');
  assert.equal(store.getConversation(binding.conversationId).type, 'standard');

  const firstEventCount = store.db.prepare('SELECT COUNT(*) AS count FROM chat_external_events').get().count;
  assert.equal(firstEventCount, 1);

  const secondResponse = await invokeWebhook(controller, payload);
  assert.equal(secondResponse.statusCode, 200);
  assert.equal(secondResponse.json.deduped, true);
  assert.equal(calls.length, 1);

  const secondEventCount = store.db.prepare('SELECT COUNT(*) AS count FROM chat_external_events').get().count;
  assert.equal(secondEventCount, 1);
});

test('feishu controller accepts group messages without requiring bot mention and preserves text', async (t) => {
  const { controller, calls } = createFeishuTestHarness(t, { botOpenId: 'ou-bot-1' });
  const response = await invokeWebhook(controller, {
    header: {
      token: 'test-feishu-token',
      event_id: 'evt-feishu-group-1',
      event_type: 'im.message.receive_v1',
    },
    event: {
      sender: {
        sender_id: {
          open_id: 'ou-group-user-1',
        },
        sender_type: 'user',
      },
      message: {
        message_id: 'om-group-1',
        chat_id: 'oc-group-1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({
          text: '@_user_2 你好',
          mentions: [
            {
              key: '@_user_2',
              id: { open_id: 'ou-group-user-2' },
              name: 'Alice',
            },
          ],
        }),
      },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json.processed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.content, '@_user_2 你好');
  assert.equal(calls[0].input.metadata.feishu.mentions[0].name, 'Alice');
});

test('feishu controller ignores non-text messages with a diagnostic response', async (t) => {
  const { controller, calls } = createFeishuTestHarness(t);
  const response = await invokeWebhook(controller, {
    header: {
      token: 'test-feishu-token',
      event_id: 'evt-feishu-image-1',
      event_type: 'im.message.receive_v1',
    },
    event: {
      sender: {
        sender_id: {
          open_id: 'ou-image-user-1',
        },
        sender_type: 'user',
      },
      message: {
        message_id: 'om-image-1',
        chat_id: 'oc-image-1',
        chat_type: 'p2p',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_v2_test' }),
      },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json.ignored, 'unsupported_message_type');
  assert.equal(calls.length, 0);
});

test('feishu controller handles /new by rebinding the chat without submitting a user message', async (t) => {
  const { controller, calls, sentMessages, store } = createFeishuTestHarness(t);
  const buildPayload = (eventId, messageId, text) => ({
    header: {
      token: 'test-feishu-token',
      event_id: eventId,
      event_type: 'im.message.receive_v1',
    },
    event: {
      sender: {
        sender_id: {
          open_id: 'ou-user-new',
        },
        sender_type: 'user',
      },
      message: {
        message_id: messageId,
        chat_id: 'oc-chat-new',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text }),
      },
    },
  });

  const firstResponse = await invokeWebhook(controller, buildPayload('evt-new-before', 'om-new-before', 'before new'));
  assert.equal(firstResponse.statusCode, 200);
  assert.equal(firstResponse.json.processed, true);
  assert.equal(calls.length, 1);
  const firstBinding = store.getConversationChannelBinding('feishu', 'oc-chat-new');
  const firstConversationId = firstBinding.conversationId;

  const commandResponse = await invokeWebhook(controller, buildPayload('evt-new-command', 'om-new-command', ' /new '));
  assert.equal(commandResponse.statusCode, 200);
  assert.equal(commandResponse.json.processed, true);
  assert.equal(commandResponse.json.command, '/new');
  assert.equal(calls.length, 1);
  assert.deepEqual(sentMessages, [
    {
      chatId: 'oc-chat-new',
      text: '已新建并切换到新的会话。',
    },
  ]);

  const reboundBinding = store.getConversationChannelBinding('feishu', 'oc-chat-new');
  assert.notEqual(reboundBinding.conversationId, firstConversationId);
  assert.equal(store.getConversation(reboundBinding.conversationId).type, 'standard');

  const duplicateCommandResponse = await invokeWebhook(controller, buildPayload('evt-new-command', 'om-new-command', ' /new '));
  assert.equal(duplicateCommandResponse.statusCode, 200);
  assert.equal(duplicateCommandResponse.json.deduped, true);
  assert.equal(sentMessages.length, 1);

  const nextResponse = await invokeWebhook(controller, buildPayload('evt-new-after', 'om-new-after', 'after new'));
  assert.equal(nextResponse.statusCode, 200);
  assert.equal(nextResponse.json.processed, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].conversationId, reboundBinding.conversationId);
  assert.equal(calls[1].input.content, 'after new');
});

test('feishu controller keeps the inbound dedupe record when downstream submission fails', async (t) => {
  const { controller, calls, store } = createFeishuTestHarness(t, {
    submitConversationMessage({ conversationId, input, store: testStore }) {
      testStore.createMessage({
        id: 'accepted-failed-1',
        conversationId,
        turnId: 'turn-failed-1',
        role: 'user',
        senderName: input.senderName,
        content: input.content,
        status: 'completed',
        metadata: input.metadata,
      });

      throw new Error('downstream dispatch failed');
    },
  });
  const payload = {
    header: {
      token: 'test-feishu-token',
      event_id: 'evt-feishu-failed-1',
      event_type: 'im.message.receive_v1',
    },
    event: {
      sender: {
        sender_id: {
          open_id: 'ou-failed-user-1',
        },
        sender_type: 'user',
      },
      message: {
        message_id: 'om-failed-1',
        chat_id: 'oc-failed-1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({
          text: 'this will fail once',
        }),
      },
    },
  };

  await assert.rejects(() => invokeWebhook(controller, payload), /downstream dispatch failed/u);

  const failedEvent = store.db
    .prepare('SELECT * FROM chat_external_events WHERE external_event_id = ? LIMIT 1')
    .get('evt-feishu-failed-1');
  assert.ok(failedEvent);
  assert.equal(failedEvent.direction, 'inbound');
  const failedMetadata = JSON.parse(failedEvent.metadata_json);
  assert.equal(failedMetadata.status, 'failed');
  assert.match(failedMetadata.error, /downstream dispatch failed/u);

  const firstMessageCount = store.db.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE conversation_id = ?').get(failedEvent.conversation_id).count;
  assert.equal(firstMessageCount, 1);

  const retryResponse = await invokeWebhook(controller, payload);
  assert.equal(retryResponse.statusCode, 200);
  assert.equal(retryResponse.json.deduped, true);
  assert.equal(calls.length, 1);

  const secondMessageCount = store.db.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE conversation_id = ?').get(failedEvent.conversation_id).count;
  assert.equal(secondMessageCount, 1);
});

test('feishu controller ignores bot self messages', async (t) => {
  const { controller, calls } = createFeishuTestHarness(t, { botOpenId: 'ou-bot-self' });
  const selfResponse = await invokeWebhook(controller, {
    header: {
      token: 'test-feishu-token',
      event_id: 'evt-feishu-self-1',
      event_type: 'im.message.receive_v1',
    },
    event: {
      sender: {
        sender_id: {
          open_id: 'ou-bot-self',
        },
        sender_type: 'user',
      },
      message: {
        message_id: 'om-self-1',
        chat_id: 'oc-self-1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({
          text: 'echo loop',
        }),
      },
    },
  });

  assert.equal(selfResponse.statusCode, 200);
  assert.equal(selfResponse.json.ignored, 'self_message');
  assert.equal(calls.length, 0);
});

test('feishu new rooms use only configured default roles and merge mode skills into that explicit roster', async (t) => {
  const modeStore = {
    resolveCodingMode() {
      return { id: 'coding', name: 'Coding', skillIds: ['feishu-mode-skill'] };
    },
  };
  const { controller, defaultRole, store } = createFeishuTestHarness(t, { modeStore });
  const response = await invokeWebhook(controller, {
    header: {
      token: 'test-feishu-token',
      event_id: 'evt-feishu-policy-1',
      event_type: 'im.message.receive_v1',
    },
    event: {
      sender: {
        sender_id: { open_id: 'ou-policy-user' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om-policy-1',
        chat_id: 'oc-policy-1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello explicit policy' }),
      },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json.processed, true);
  const binding = store.getConversationChannelBinding('feishu', 'oc-policy-1');
  const conversation = store.getConversation(binding.conversationId);
  assert.equal(conversation.type, 'coding');
  assert.deepEqual(conversation.agents.map((agent) => agent.id), [defaultRole.id]);
  assert.deepEqual(conversation.agents[0].conversationSkillIds, ['feishu-mode-skill']);
});

test('feishu new rooms return setup_required and write no conversation when default roles are missing or invalid', async (t) => {
  const missingPolicy = createFeishuTestHarness(t, { defaultRoleIds: [] });
  const missingResponse = await invokeWebhook(missingPolicy.controller, {
    header: {
      token: 'test-feishu-token',
      event_id: 'evt-feishu-policy-missing',
      event_type: 'im.message.receive_v1',
    },
    event: {
      sender: {
        sender_id: { open_id: 'ou-policy-missing' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om-policy-missing',
        chat_id: 'oc-policy-missing',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'needs setup' }),
      },
    },
  });

  assert.equal(missingResponse.statusCode, 200);
  assert.equal(missingResponse.json.status, 'setup_required');
  assert.equal(missingResponse.json.reason, 'feishu_default_roles_required');
  assert.equal(missingPolicy.calls.length, 0);
  assert.equal(missingPolicy.store.listConversations().length, 0);
  assert.equal(missingPolicy.store.listConversationChannelBindings('feishu').length, 0);

  const invalidPolicy = createFeishuTestHarness(t, { defaultRoleIds: ['missing-role'] });
  const invalidResponse = await invokeWebhook(invalidPolicy.controller, {
    header: {
      token: 'test-feishu-token',
      event_id: 'evt-feishu-policy-invalid',
      event_type: 'im.message.receive_v1',
    },
    event: {
      sender: {
        sender_id: { open_id: 'ou-policy-invalid' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om-policy-invalid',
        chat_id: 'oc-policy-invalid',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'invalid setup' }),
      },
    },
  });

  assert.equal(invalidResponse.statusCode, 200);
  assert.equal(invalidResponse.json.status, 'setup_required');
  assert.equal(invalidResponse.json.reason, 'feishu_default_roles_invalid');
  assert.equal(invalidResponse.json.issues[0].code, 'participant_role_unknown');
  assert.equal(invalidPolicy.calls.length, 0);
  assert.equal(invalidPolicy.store.listConversations().length, 0);
  assert.equal(invalidPolicy.store.listConversationChannelBindings('feishu').length, 0);
});

test('feishu existing bindings keep their roster without defaults while slash-new requires setup', async (t) => {
  const { controller, calls, defaultRole, store } = createFeishuTestHarness(t, { defaultRoleIds: [] });
  const existingConversation = store.createConversation({
    id: 'feishu-existing-roster',
    title: 'Existing Feishu roster',
    participants: [defaultRole.id],
  });
  store.createConversationChannelBinding({
    platform: 'feishu',
    externalChatId: 'oc-existing-roster',
    conversationId: existingConversation.id,
    metadata: { chatType: 'p2p' },
  });
  const buildPayload = (eventId, messageId, text) => ({
    header: {
      token: 'test-feishu-token',
      event_id: eventId,
      event_type: 'im.message.receive_v1',
    },
    event: {
      sender: {
        sender_id: { open_id: 'ou-existing-roster' },
        sender_type: 'user',
      },
      message: {
        message_id: messageId,
        chat_id: 'oc-existing-roster',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text }),
      },
    },
  });

  const messageResponse = await invokeWebhook(controller, buildPayload(
    'evt-existing-roster-message',
    'om-existing-roster-message',
    'continue existing room'
  ));
  assert.equal(messageResponse.json.processed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].conversationId, existingConversation.id);
  assert.deepEqual(store.getConversation(existingConversation.id).agents.map((agent) => agent.id), [defaultRole.id]);

  const conversationCountBeforeNew = store.listConversations().length;
  const newResponse = await invokeWebhook(controller, buildPayload(
    'evt-existing-roster-new',
    'om-existing-roster-new',
    '/new'
  ));
  assert.equal(newResponse.json.status, 'setup_required');
  assert.equal(newResponse.json.reason, 'feishu_default_roles_required');
  assert.equal(store.listConversations().length, conversationCountBeforeNew);
  assert.equal(
    store.getConversationChannelBinding('feishu', 'oc-existing-roster').conversationId,
    existingConversation.id
  );
});
