const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { ModeStore } = require('../../build/lib/mode-store');
const { createFeishuLongConnectionSource } = require('../../build/server/domain/integrations/feishu/feishu-long-connection');
const { createFeishuIntegrationService } = require('../../build/server/domain/integrations/feishu/feishu-service');
const { withTempDir } = require('../helpers/temp-dir');

function createSilentLogger() {
  return {
    log() {},
    warn() {},
  };
}

test('feishu long connection source starts the official SDK client and forwards events to the feishu service', async () => {
  const handledPayloads = [];
  const loggedMessages = [];
  let dispatcherInstance = null;
  let startParams = null;
  let wsClientConfig = null;
  const closeParams = [];
  let wsClientCount = 0;
  const larkSdk = {
    Domain: {
      Feishu: 'feishu-domain',
    },
    LoggerLevel: {
      info: 3,
    },
    EventDispatcher: class FakeEventDispatcher {
      constructor(options) {
        this.options = options;
        this.handles = null;
        dispatcherInstance = this;
      }

      register(handles) {
        this.handles = handles;
        return this;
      }
    },
    WSClient: class FakeWSClient {
      constructor(config) {
        wsClientCount += 1;
        wsClientConfig = config;
      }

      start(params) {
        startParams = params;
        return Promise.resolve();
      }

      close(params) {
        closeParams.push(params);
      }
    },
  };
  const source = createFeishuLongConnectionSource({
    feishuService: {
      handleLongConnectionEvent(payload) {
        handledPayloads.push(payload);
        return Promise.resolve({ ok: true });
      },
    },
    logger: {
      log(message) {
        loggedMessages.push(String(message || ''));
      },
      warn() {},
    },
    larkSdk,
    env: {
      FEISHU_CONNECTION_MODE: 'long-connection',
      FEISHU_APP_ID: 'sdk_test_app',
      FEISHU_APP_SECRET: 'sdk_test_secret',
    },
  });

  assert.equal(source.isEnabled(), true);
  assert.equal(source.start(), true);
  assert.deepEqual(wsClientConfig, {
    appId: 'sdk_test_app',
    appSecret: 'sdk_test_secret',
    autoReconnect: true,
    domain: 'feishu-domain',
    loggerLevel: 3,
  });
  assert.ok(dispatcherInstance);
  assert.deepEqual(dispatcherInstance.options, { loggerLevel: 3 });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(startParams.eventDispatcher, dispatcherInstance);
  assert.ok(loggedMessages.includes('[feishu][long-connection] Starting SDK long connection client'));
  assert.ok(loggedMessages.includes('[feishu][long-connection] SDK long connection client is ready'));

  await dispatcherInstance.handles['im.message.receive_v1']({
    event_id: 'evt-long-1',
    event_type: 'im.message.receive_v1',
    sender: {
      sender_id: {
        open_id: 'ou-long-user-1',
      },
      sender_type: 'user',
    },
    message: {
      message_id: 'om-long-1',
      chat_id: 'oc-long-1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({
        text: 'hello from sdk',
      }),
    },
  });

  assert.equal(handledPayloads.length, 1);
  assert.equal(handledPayloads[0].header.event_id, 'evt-long-1');
  assert.equal(handledPayloads[0].header.event_type, 'im.message.receive_v1');
  assert.equal(handledPayloads[0].event.message.message_id, 'om-long-1');

  source.stop();
  assert.deepEqual(closeParams[0], { force: true });

  assert.equal(source.start(), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(wsClientCount, 2);
  source.stop();
  assert.deepEqual(closeParams[1], { force: true });
});

test('feishu service processes long connection events without webhook token verification', async (t) => {
  const tempDir = withTempDir('caff-feishu-long-connection-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const calls = [];
  const client = {
    initialize() {
      return Promise.resolve('ou-bot-long-1');
    },
    ensureBotOpenId() {
      return Promise.resolve('ou-bot-long-1');
    },
    sendTextMessage() {
      return Promise.resolve({ messageId: 'om-outbound-ignore', payload: { ok: true } });
    },
  };
  const turnOrchestrator = {
    submitConversationMessage(conversationId, input) {
      calls.push({ conversationId, input });
      const acceptedMessage = store.createMessage({
        id: `accepted-long-${calls.length}`,
        conversationId,
        turnId: `turn-long-${calls.length}`,
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
  const service = createFeishuIntegrationService({
    store,
    turnOrchestrator,
    client,
    verificationToken: 'webhook-only-token',
    logger: createSilentLogger(),
  });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const result = await service.handleLongConnectionEvent({
    header: {
      event_id: 'evt-long-service-1',
      event_type: 'im.message.receive_v1',
    },
    event: {
      sender: {
        sender_id: {
          open_id: 'ou-long-user-1',
        },
        sender_type: 'user',
      },
      message: {
        message_id: 'om-long-service-1',
        chat_id: 'oc-long-chat-1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({
          text: 'hello from long connection',
        }),
      },
    },
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.processed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.content, 'hello from long connection');
  assert.equal(calls[0].input.metadata.source, 'feishu');
  assert.equal(calls[0].input.metadata.feishu.eventId, 'evt-long-service-1');

  const binding = store.getConversationChannelBinding('feishu', 'oc-long-chat-1');
  assert.ok(binding);
  const eventRow = store.db.prepare('SELECT * FROM chat_external_events WHERE external_event_id = ?').get('evt-long-service-1');
  assert.equal(eventRow.direction, 'inbound');
});

test('feishu service uses the configured Trellis Coding mode for new chats', async (t) => {
  const tempDir = withTempDir('caff-feishu-coding-mode-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const modeStore = new ModeStore(store.db);
  const codingMode = modeStore.save({
    id: 'custom-coding',
    name: 'Coding',
    skillIds: ['before-dev', 'start'],
    loadingStrategy: 'dynamic',
  });
  const calls = [];
  const client = {
    initialize() {
      return Promise.resolve('ou-bot-coding-mode');
    },
    ensureBotOpenId() {
      return Promise.resolve('ou-bot-coding-mode');
    },
    sendTextMessage() {
      return Promise.resolve({ messageId: 'om-outbound-ignore', payload: { ok: true } });
    },
  };
  const turnOrchestrator = {
    submitConversationMessage(conversationId, input) {
      calls.push({ conversationId, input });
      return {
        acceptedMessage: store.createMessage({
          id: `accepted-coding-mode-${calls.length}`,
          conversationId,
          turnId: `turn-coding-mode-${calls.length}`,
          role: 'user',
          senderName: input.senderName,
          content: input.content,
          status: 'completed',
          metadata: input.metadata,
        }),
        conversation: store.getConversation(conversationId),
        conversations: store.listConversations(),
        dispatch: 'started',
        dispatchLane: 'main',
        dispatchTargetAgentId: null,
        runtime: {},
      };
    },
  };
  const service = createFeishuIntegrationService({
    store,
    turnOrchestrator,
    client,
    modeStore,
    verificationToken: 'webhook-only-token',
    logger: createSilentLogger(),
  });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const result = await service.handleLongConnectionEvent({
    header: {
      event_id: 'evt-coding-mode-1',
      event_type: 'im.message.receive_v1',
    },
    event: {
      sender: {
        sender_id: {
          open_id: 'ou-coding-mode-user-1',
        },
        sender_type: 'user',
      },
      message: {
        message_id: 'om-coding-mode-service-1',
        chat_id: 'oc-coding-mode-chat-1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({
          text: 'hello from coding mode',
        }),
      },
    },
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.processed, true);
  assert.equal(calls.length, 1);

  const conversation = store.getConversation(calls[0].conversationId);
  assert.equal(conversation.type, codingMode.id);
  assert.ok(Array.isArray(conversation.agents));
  assert.ok(conversation.agents.length > 0);
  assert.deepEqual(conversation.agents[0].conversationSkillIds, ['before-dev', 'start']);
});
