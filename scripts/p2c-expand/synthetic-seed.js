#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { generateSyntheticSeed: generateP2ABSeed } = require('../p2ab-bounded-hydration/synthetic-seed');

function parseJson(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function buildSnapshot(row, displayContent) {
  const byteSize = Buffer.byteLength(displayContent, 'utf8');
  const contentHash = hash(displayContent);
  return {
    schemaVersion: 1,
    snapshotId: hash(`${row.conversation_id}:${row.turn_id}:${row.id}:${contentHash}`).slice(0, 24),
    capturedAt: row.created_at,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    messageId: row.id,
    agentId: row.agent_id || 'role-family-gpt',
    agentName: row.sender_name || 'GPT',
    promptVersion: 'p2c-expand-synthetic-v1',
    immutable: true,
    totalApproxTokens: Math.ceil(displayContent.length / 4),
    totalByteSize: byteSize,
    sections: [{
      sectionKey: 'conversation_history',
      title: 'Conversation History',
      displayTitle: 'Conversation History',
      source: 'conversation/messages',
      visibility: 'full',
      contentHash,
      displayContentHash: contentHash,
      approxTokens: Math.ceil(displayContent.length / 4),
      byteSize,
      truncated: false,
      truncationNote: '',
      redacted: false,
      policyNote: '',
      contentPreview: displayContent.slice(0, 180),
      displayContent,
    }],
  };
}

function augmentSyntheticSeed(options) {
  const outputDir = path.resolve(options.outputDir);
  const manifestPath = path.join(outputDir, 'shape-manifest.json');
  let manifest = options.manifest || (fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : null);
  if (!manifest || !manifest.p2ab) {
    manifest = generateP2ABSeed({ outputDir });
  }

  const sqlitePath = path.join(outputDir, 'chat.sqlite');
  manifest.sqlitePath = sqlitePath;
  const { createChatAppStore } = require('../../build/lib/chat-app-store');
  const store = createChatAppStore({ agentDir: outputDir, sqlitePath });
  try {
    const conversationId = manifest.largestConversation.id;
    const rows = store.db.prepare(`
      SELECT id, conversation_id, turn_id, agent_id, sender_name, metadata_json, created_at
      FROM chat_messages
      WHERE conversation_id = ? AND role = 'assistant'
      ORDER BY length(metadata_json) DESC, created_at DESC, id DESC
      LIMIT 60
    `).all(conversationId);

    const update = store.db.prepare('UPDATE chat_messages SET metadata_json = ? WHERE id = ?');
    const updateMany = store.db.transaction(() => {
      for (const row of rows) {
        const metadata = parseJson(row.metadata_json);
        const existing = metadata.agentContextSnapshot;
        const existingDisplayContent = existing && typeof existing === 'object'
          ? String(existing.sections && existing.sections[0] && existing.sections[0].displayContent || '')
          : String(existing || '');
        const filler = String(metadata.syntheticFiller || '');
        const displayContent = filler.length > existingDisplayContent.length ? filler : existingDisplayContent;
        const snapshot = buildSnapshot(row, displayContent || `synthetic context ${row.id}`);
        update.run(JSON.stringify({ ...metadata, agentContextSnapshot: snapshot }), row.id);
      }
    });
    updateMany();

    const measured = store.db.prepare(`
      SELECT
        COUNT(*) AS messages,
        COALESCE(SUM(LENGTH(CAST(metadata_json AS BLOB))), 0) AS metadata_bytes,
        SUM(CASE
          WHEN json_valid(metadata_json) = 1
           AND json_type(metadata_json, '$.agentContextSnapshot') = 'object'
          THEN 1 ELSE 0 END
        ) AS context_snapshots
      FROM chat_messages
    `).get();
    const detailCounts = {
      contextSnapshots: Number(store.db.prepare('SELECT COUNT(*) AS count FROM chat_message_context_snapshots').get().count || 0),
      modelUsage: Number(store.db.prepare('SELECT COUNT(*) AS count FROM chat_message_model_usage_calls').get().count || 0),
    };
    const integrityCheck = store.db.pragma('integrity_check', { simple: true });
    const foreignKeyViolations = store.db.prepare('PRAGMA foreign_key_check').all().length;

    manifest.metadataBytes = Number(measured.metadata_bytes || 0);
    manifest.dbSizeBytes = fs.statSync(sqlitePath).size;
    manifest.p2cExpand = {
      conversationId,
      legacySnapshotRows: Number(measured.context_snapshots || 0),
      convertedSnapshotRows: rows.length,
      detailCounts,
      integrityCheck,
      foreignKeyViolations,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return manifest;
  } finally {
    store.close();
  }
}

function generateSyntheticSeed(options) {
  const outputDir = path.resolve(options.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const manifest = generateP2ABSeed({ outputDir });
  return augmentSyntheticSeed({ outputDir, manifest });
}

module.exports = { augmentSyntheticSeed, generateSyntheticSeed };

if (require.main === module) {
  const outputDir = process.argv[2] || path.join('.tmp', 'p2c-expand-gate', 'seed');
  const manifest = generateSyntheticSeed({ outputDir });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
