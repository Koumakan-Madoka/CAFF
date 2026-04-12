const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createFeishuIntegrationService } = require('../../build/server/domain/integrations/feishu/feishu-service');
const { withTempDir } = require('../helpers/temp-dir');

function createSilentLogger() {
  return {
    log() {},
    warn() {},
  };
}

test('feishu delivery service sends completed assistant replies once per bound conversation', async (t) => {
  const tempDir = withTempDir('caff-feishu-delivery-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const sentMessages = [];
  const client = {
    initialize() {
      return Promise.resolve('ou-bot-1');
    },
    ensureBotOpenId() {
      return Promise.resolve('ou-bot-1');
    },
    sendTextMessage(chatId, text) {
      sentMessages.push({ chatId, text });
      return Promise.resolve({
        messageId: `om-outbound-${sentMessages.length}`,
        payload: { ok: true, messageId: `om-outbound-${sentMessages.length}` },
      });
    },
  };
  const service = createFeishuIntegrationService({
    store,
    turnOrchestrator: {},
    client,
    verificationToken: 'test-feishu-token',
    logger: createSilentLogger(),
  });

  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = store.createConversation({
    title: 'Bound Feishu Conversation',
  });
  const binding = store.createConversationChannelBinding({
    platform: 'feishu',
    externalChatId: 'oc-bound-chat-1',
    conversationId: conversation.id,
    metadata: { chatType: 'p2p' },
  });
  assert.ok(binding);

  const assistantMessage = store.createMessage({
    conversationId: conversation.id,
    turnId: 'turn-feishu-1',
    role: 'assistant',
    senderName: 'Builder',
    content: 'Hello Feishu',
    status: 'completed',
  });

  const firstDelivery = await service.deliverAssistantMessage(assistantMessage);
  assert.equal(firstDelivery.delivered, true);
  assert.equal(sentMessages.length, 1);
  assert.deepEqual(sentMessages[0], {
    chatId: 'oc-bound-chat-1',
    text: '【Builder】Hello Feishu',
  });

  const eventRow = store.db.prepare('SELECT * FROM chat_external_events WHERE message_id = ?').get(assistantMessage.id);
  assert.equal(eventRow.platform, 'feishu');
  assert.equal(eventRow.direction, 'outbound');
  assert.equal(eventRow.external_message_id, 'om-outbound-1');
  assert.equal(JSON.parse(eventRow.metadata_json).speakerName, 'Builder');

  const duplicateDelivery = await service.deliverAssistantMessage(assistantMessage);
  assert.equal(duplicateDelivery.delivered, false);
  assert.equal(duplicateDelivery.reason, 'duplicate_outbound');
  assert.equal(sentMessages.length, 1);
});
