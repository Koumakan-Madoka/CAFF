#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIB = 1024 * 1024;

function parseArgs(argv) {
  const args = { workDir: '', manifestPath: '' };
  for (let index = 2; index < argv.length; index += 2) {
    if (argv[index] === '--work-dir') args.workDir = argv[index + 1];
    else if (argv[index] === '--manifest') args.manifestPath = argv[index + 1];
  }
  if (!args.workDir || !args.manifestPath) {
    throw new Error('usage: gate-child.js --work-dir <dir> --manifest <path>');
  }
  return args;
}

function collectGarbage() {
  if (typeof global.gc !== 'function') throw new Error('gate child requires --expose-gc');
  global.gc();
  global.gc();
}

function sample(sampler) {
  const usage = process.memoryUsage();
  sampler.peakHeapUsed = Math.max(sampler.peakHeapUsed, usage.heapUsed);
  sampler.peakRss = Math.max(sampler.peakRss, usage.rss);
  sampler.samples += 1;
  return usage;
}

function createModelUsage(callCount) {
  const calls = Array.from({ length: callCount }, (_, index) => ({
    index,
    sequence: index + 1,
    key: `gate-call-${index + 1}`,
    responseId: `gate-response-${index + 1}`,
    stopReason: 'stop',
    timestamp: index + 1,
    coldStart: index === 0,
    isColdStart: index === 0,
    providerMiss: index > 0 && index % 7 === 0,
    tokenUsage: {
      inputTokens: 1000 + index,
      uncachedInputTokens: 100 + index,
      outputTokens: 50 + index,
      totalTokens: 1050 + (index * 2),
      cacheReadTokens: index === 0 ? 0 : 900,
      cacheWriteTokens: 0,
      inputCostUsd: null,
      outputCostUsd: null,
      cacheReadCostUsd: null,
      cacheWriteCostUsd: null,
      totalCostUsd: null,
    },
  }));
  return {
    modelCallCount: callCount,
    coldStartModelCallCount: 1,
    postColdModelCallCount: callCount - 1,
    providerMissCount: calls.filter((call) => call.providerMiss).length,
    calls,
  };
}

function cloneSnapshot(source, input) {
  const snapshot = JSON.parse(JSON.stringify(source));
  snapshot.snapshotId = `gate-snapshot-${input.index}`;
  snapshot.capturedAt = input.createdAt;
  snapshot.conversationId = input.conversationId;
  snapshot.turnId = input.turnId;
  snapshot.messageId = input.messageId;
  return snapshot;
}

function count(store, tableName) {
  return Number(store.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count || 0);
}

function oldMetadataBytes(store) {
  return Number(store.db.prepare(`
    SELECT COALESCE(SUM(LENGTH(CAST(metadata_json AS BLOB))), 0) AS bytes
    FROM chat_messages
    WHERE id LIKE 'synthetic-message-%'
  `).get().bytes || 0);
}

async function main() {
  const args = parseArgs(process.argv);
  const manifest = JSON.parse(fs.readFileSync(args.manifestPath, 'utf8'));
  const sqlitePath = path.join(args.workDir, 'chat.sqlite');
  const databaseBytesBefore = fs.statSync(sqlitePath).size;
  const { createChatAppStore } = require('../../build/lib/chat-app-store');
  const store = createChatAppStore({ agentDir: args.workDir, sqlitePath });
  const checks = [];
  const forbiddenCalls = { getConversation: 0, listMessages: 0 };

  try {
    const conversationId = manifest.p2cExpand.conversationId;
    const historyBytesBefore = oldMetadataBytes(store);
    checks.push({
      name: 'migration leaves historical detail tables empty',
      pass: count(store, 'chat_message_context_snapshots') === 0
        && count(store, 'chat_message_model_usage_calls') === 0,
    });
    checks.push({
      name: 'synthetic seed has production-shape legacy snapshots',
      pass: manifest.p2cExpand.legacySnapshotRows >= 50,
      detail: `${manifest.p2cExpand.legacySnapshotRows} object snapshots`,
    });
    const pagePlan = store.db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT message.id
      FROM chat_messages message
      LEFT JOIN chat_message_context_snapshots detail ON detail.message_id = message.id
      WHERE message.conversation_id = ? AND message.role = 'assistant'
      ORDER BY message.created_at DESC, message.id DESC
      LIMIT 51
    `).all(conversationId).map((row) => String(row.detail || ''));
    checks.push({
      name: 'snapshot page uses the existing conversation cursor index',
      pass: pagePlan.some((detail) => detail.includes('idx_chat_messages_conversation_id')),
      detail: pagePlan.join(' | '),
    });

    for (const name of Object.keys(forbiddenCalls)) {
      store[name] = () => {
        forbiddenCalls[name] += 1;
        throw new Error(`forbidden hydration: ${name}`);
      };
    }

    const warm = store.listContextSnapshotPage(conversationId, { limit: 50 });
    if (warm.items.length !== 50) throw new Error(`warm page length ${warm.items.length}`);
    const largestSnapshotMessage = store.db.prepare(`
      SELECT id
      FROM chat_messages
      WHERE conversation_id = ?
        AND json_valid(metadata_json) = 1
        AND json_type(metadata_json, '$.agentContextSnapshot') = 'object'
      ORDER BY length(json_extract(metadata_json, '$.agentContextSnapshot')) DESC
      LIMIT 1
    `).get(conversationId);
    const legacySnapshot = store.getMessageContextSnapshot(largestSnapshotMessage && largestSnapshotMessage.id);
    if (!legacySnapshot) throw new Error('legacy fallback snapshot missing');
    const legacySnapshotBytes = Buffer.byteLength(JSON.stringify(legacySnapshot), 'utf8');
    checks.push({
      name: 'new writes use a production-scale context snapshot',
      pass: legacySnapshotBytes >= 200 * 1024,
      detail: `${(legacySnapshotBytes / 1024).toFixed(1)}KiB`,
    });

    collectGarbage();
    const baseline = process.memoryUsage();
    const sampler = { peakHeapUsed: baseline.heapUsed, peakRss: baseline.rss, samples: 0 };
    const interval = setInterval(() => sample(sampler), 10);
    if (typeof interval.unref === 'function') interval.unref();
    const startedAt = process.hrtime.bigint();

    const page = store.listContextSnapshotPage(conversationId, { limit: 50 });
    checks.push({
      name: 'bounded legacy page returns 50 rows without full hydration',
      pass: page.items.length === 50 && page.hasMore === true,
    });

    const latest = store.db.prepare(`
      SELECT created_at FROM chat_messages
      WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(conversationId);
    const baseTime = Math.max(Date.parse(latest.created_at) + 1000, Date.parse('2026-08-25T12:00:00.000Z'));
    const fullUsage = createModelUsage(100);
    const newMessageIds = [];

    for (let index = 0; index < 8; index += 1) {
      const messageId = `p2c-expand-gate-message-${index}`;
      const turnId = `p2c-expand-gate-turn-${index}`;
      const createdAt = new Date(baseTime + index * 1000).toISOString();
      const snapshot = cloneSnapshot(legacySnapshot, { index, messageId, turnId, conversationId, createdAt });
      store.createMessage({
        id: messageId,
        conversationId,
        turnId,
        role: 'assistant',
        agentId: 'role-family-gpt',
        senderName: 'GPT',
        content: 'Thinking...',
        status: 'queued',
        metadata: { phase: 'queued', agentContextSnapshot: snapshot },
        createdAt,
      });
      const snapshotUpdatedAt = store.db.prepare(`
        SELECT updated_at FROM chat_message_context_snapshots WHERE message_id = ?
      `).get(messageId).updated_at;
      for (let updateIndex = 0; updateIndex < 3; updateIndex += 1) {
        store.updateMessage(messageId, {
          status: 'streaming',
          metadata: { phase: `streaming-${updateIndex}`, agentContextSnapshot: snapshot },
        });
      }
      const afterLifecycleUpdatedAt = store.db.prepare(`
        SELECT updated_at FROM chat_message_context_snapshots WHERE message_id = ?
      `).get(messageId).updated_at;
      if (afterLifecycleUpdatedAt !== snapshotUpdatedAt) {
        throw new Error(`immutable snapshot rewritten for ${messageId}`);
      }
      store.updateMessage(messageId, {
        content: `completed ${index}`,
        status: 'completed',
        metadata: { phase: 'completed', agentContextSnapshot: snapshot, modelUsage: fullUsage },
      });
      newMessageIds.push(messageId);
      sample(sampler);
    }

    const retained = store.getMessageModelUsage(newMessageIds[0]);
    const fullMetadata = store.getMessage(newMessageIds[0]).metadata.modelUsage;
    checks.push({
      name: 'full metadata and retained model detail stay compatible',
      pass: fullMetadata.calls.length === 100
        && retained.calls.length === 64
        && retained.calls[0].sequence === 1
        && retained.calls[1].sequence === 38
        && retained.calls[63].sequence === 100
        && retained.droppedCallCount === 36
        && retained.modelCallCount === 100,
    });

    store.db.prepare('UPDATE chat_messages SET metadata_json = ? WHERE id = ?').run(
      JSON.stringify({
        modelUsage: {
          modelCallCount: 100,
          coldStartModelCallCount: 1,
          postColdModelCallCount: 99,
          providerMissCount: fullUsage.providerMissCount,
        },
      }),
      newMessageIds[0]
    );
    const tableOnlySnapshot = store.getMessageContextSnapshot(newMessageIds[0]);
    const tableOnlyUsage = store.getMessageModelUsage(newMessageIds[0]);
    checks.push({
      name: 'table-first reads survive Contract-shaped lightweight metadata',
      pass: tableOnlySnapshot && tableOnlySnapshot.messageId === newMessageIds[0]
        && tableOnlyUsage && tableOnlyUsage.calls.length === 64,
    });

    const mixedPage = store.listContextSnapshotPage(conversationId, { limit: 50 });
    checks.push({
      name: 'mixed table and metadata rows share one stable page',
      pass: mixedPage.items.length === 50
        && mixedPage.items[0].messageId === newMessageIds[newMessageIds.length - 1]
        && mixedPage.items.some((snapshot) => snapshot.messageId === newMessageIds[0]),
    });

    store.deleteConversationMessages(conversationId, [newMessageIds[1]]);
    checks.push({
      name: 'message deletion cascades both detail rows',
      pass: !store.getMessage(newMessageIds[1])
        && !store.db.prepare('SELECT 1 FROM chat_message_context_snapshots WHERE message_id = ?').get(newMessageIds[1])
        && !store.db.prepare('SELECT 1 FROM chat_message_model_usage_calls WHERE message_id = ?').get(newMessageIds[1]),
    });

    clearInterval(interval);
    sample(sampler);
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    collectGarbage();
    const retainedMemory = process.memoryUsage();
    store.db.pragma('wal_checkpoint(TRUNCATE)');
    const databaseBytesAfter = fs.statSync(sqlitePath).size;
    const historyBytesAfter = oldMetadataBytes(store);
    const integrityCheck = store.db.pragma('integrity_check', { simple: true });
    const foreignKeyViolations = store.db.prepare('PRAGMA foreign_key_check').all().length;

    checks.push({
      name: 'historical metadata bytes are unchanged',
      pass: historyBytesAfter === historyBytesBefore,
      detail: `${historyBytesBefore} bytes`,
    });
    checks.push({
      name: 'forbidden hydration counters stay zero',
      pass: Object.values(forbiddenCalls).every((value) => value === 0),
      detail: JSON.stringify(forbiddenCalls),
    });
    checks.push({
      name: 'SQLite integrity and foreign keys remain valid',
      pass: integrityCheck === 'ok' && foreignKeyViolations === 0,
      detail: `integrity=${integrityCheck}, foreignKeyViolations=${foreignKeyViolations}`,
    });

    const result = {
      ok: checks.every((check) => check.pass),
      checks,
      metrics: {
        durationMs,
        baselineHeapUsedMiB: baseline.heapUsed / MIB,
        peakHeapUsedMiB: sampler.peakHeapUsed / MIB,
        retainedHeapUsedMiB: retainedMemory.heapUsed / MIB,
        baselineRssMiB: baseline.rss / MIB,
        peakRssMiB: sampler.peakRss / MIB,
        retainedRssMiB: retainedMemory.rss / MIB,
        samples: sampler.samples,
        databaseBytesBefore,
        databaseBytesAfter,
        databaseDeltaBytes: databaseBytesAfter - databaseBytesBefore,
      },
      counts: {
        contextSnapshots: count(store, 'chat_message_context_snapshots'),
        modelUsage: count(store, 'chat_message_model_usage_calls'),
        forbiddenCalls,
      },
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    store.close();
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error && error.stack || error) })}\n`);
  process.exitCode = 1;
});
