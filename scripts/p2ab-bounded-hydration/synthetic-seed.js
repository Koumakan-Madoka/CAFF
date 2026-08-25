#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { generateSyntheticSeed: generateBaseSeed } = require('../summary-memory-p0/synthetic-seed');

function parseJson(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function updateMessageMetadata(store, messageId, patch) {
  const row = store.db.prepare('SELECT metadata_json FROM chat_messages WHERE id = ?').get(messageId);
  const metadata = { ...parseJson(row && row.metadata_json), ...patch };
  store.db.prepare('UPDATE chat_messages SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), messageId);
}

function generateSyntheticSeed(options) {
  const outputDir = path.resolve(options.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const manifest = generateBaseSeed({ outputDir });
  const { createChatAppStore } = require('../../build/lib/chat-app-store');
  const store = createChatAppStore({ agentDir: outputDir, sqlitePath: manifest.sqlitePath });

  try {
    const goalConversationId = 'synthetic-conversation-0003';
    const goalConversation = store.getConversationWithoutMessages(goalConversationId);
    store.updateConversationWithoutMessages(goalConversationId, {
      metadata: {
        ...(goalConversation.metadata || {}),
        sessionGoal: {
          objective: 'Execute a long bounded hydration workload',
          status: 'active',
          createdAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
        },
      },
    });

    const sideConversationId = 'synthetic-conversation-0001';
    const sideConversation = store.getConversationWithoutMessages(sideConversationId);
    const sideSource = store.db.prepare(`
      SELECT user_message.id, user_message.created_at
      FROM chat_messages user_message
      WHERE user_message.conversation_id = ?
        AND user_message.role = 'user'
        AND EXISTS (
          SELECT 1 FROM chat_messages later
          WHERE later.conversation_id = user_message.conversation_id
            AND (later.created_at, later.id) > (user_message.created_at, user_message.id)
        )
      ORDER BY user_message.created_at DESC, user_message.id DESC
      LIMIT 1
    `).get(sideConversationId);
    const sideLate = store.db.prepare(`
      SELECT id FROM chat_messages
      WHERE conversation_id = ? AND (created_at, id) > (?, ?)
      ORDER BY created_at ASC, id ASC LIMIT 1
    `).get(sideConversationId, sideSource.created_at, sideSource.id);
    const sideAgentId = String(sideConversation.agents[0] && sideConversation.agents[0].id || '').trim();
    updateMessageMetadata(store, sideSource.id, {
      dispatchLane: 'side',
      dispatchTargetAgentId: sideAgentId,
    });

    const imageRow = store.db.prepare(`
      SELECT id FROM chat_messages
      WHERE conversation_id = 'synthetic-conversation-0002' AND role = 'user'
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get();
    updateMessageMetadata(store, imageRow.id, {
      contentBlocks: [
        { type: 'text', text: 'synthetic image fixture' },
        { type: 'image', imageId: 'synthetic-image-1', url: '/uploads/synthetic-image-1.png' },
      ],
    });

    const failedRow = store.db.prepare(`
      SELECT id FROM chat_messages
      WHERE conversation_id = 'synthetic-conversation-0004' AND role = 'assistant'
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get();
    store.db.prepare("UPDATE chat_messages SET status = 'failed', error_message = 'synthetic bounded failure' WHERE id = ?")
      .run(failedRow.id);

    for (let index = 0; index < 32; index += 1) {
      const senderAgentId = index % 2 === 0 ? 'role-family-gpt' : 'role-family-glm';
      const recipientAgentId = index % 2 === 0 ? 'role-family-glm' : 'role-family-gpt';
      store.createPrivateMessage({
        id: `synthetic-private-${String(index).padStart(3, '0')}`,
        conversationId: 'synthetic-conversation-0000',
        turnId: `synthetic-private-turn-${index}`,
        senderAgentId,
        senderName: senderAgentId,
        recipientAgentIds: [recipientAgentId],
        content: `synthetic private mailbox row ${index}`,
        metadata: { synthetic: true },
        createdAt: new Date(Date.parse('2026-08-25T01:00:00.000Z') + index * 1000).toISOString(),
      });
    }

    const measured = store.db.prepare(`
      SELECT
        COUNT(*) AS messages,
        COALESCE(SUM(LENGTH(CAST(metadata_json AS BLOB))), 0) AS metadata_bytes
      FROM chat_messages
    `).get();
    const privateCount = store.db.prepare('SELECT COUNT(*) AS count FROM chat_private_messages').get();
    const integrity = store.db.pragma('integrity_check', { simple: true });

    manifest.metadataBytes = Number(measured.metadata_bytes || 0);
    manifest.dbSizeBytes = fs.statSync(manifest.sqlitePath).size;
    manifest.p2ab = {
      goalConversationId,
      sideConversationId,
      sideSourceMessageId: sideSource.id,
      sideLateMessageId: sideLate.id,
      sideAgentId,
      imageMessageId: imageRow.id,
      failedMessageId: failedRow.id,
      privateMessages: Number(privateCount && privateCount.count || 0),
      integrityCheck: integrity,
    };
    fs.writeFileSync(
      path.join(outputDir, 'shape-manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );
    return manifest;
  } finally {
    store.close();
  }
}

module.exports = { generateSyntheticSeed };

if (require.main === module) {
  const outputDir = process.argv[2] || path.join('.tmp', 'p2ab-bounded-hydration-gate', 'seed');
  const manifest = generateSyntheticSeed({ outputDir });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
