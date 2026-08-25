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

function copySqliteFamily(sourcePath, targetPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${sourcePath}${suffix}`;
    const target = `${targetPath}${suffix}`;
    if (fs.existsSync(source)) fs.copyFileSync(source, target);
  }
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
    key: `contract-gate-call-${index + 1}`,
    responseId: `contract-gate-response-${index + 1}`,
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
  snapshot.snapshotId = `${input.prefix}-snapshot-${input.index}`;
  snapshot.capturedAt = input.createdAt;
  snapshot.conversationId = input.conversationId;
  snapshot.turnId = input.turnId;
  snapshot.messageId = input.messageId;
  return snapshot;
}

function historicalMetadataBytes(store) {
  return Number(store.db.prepare(`
    SELECT COALESCE(SUM(LENGTH(CAST(metadata_json AS BLOB))), 0) AS bytes
    FROM chat_messages
    WHERE id LIKE 'synthetic-message-%'
  `).get().bytes || 0);
}

function databaseBytes(sqlitePath) {
  return ['', '-wal', '-shm'].reduce((total, suffix) => {
    const filePath = `${sqlitePath}${suffix}`;
    return total + (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0);
  }, 0);
}

function writeMessages(store, input) {
  const ids = [];
  const fullMetadataBytes = [];
  const actualMetadataBytes = [];

  for (let index = 0; index < input.count; index += 1) {
    const messageId = `${input.prefix}-message-${String(index).padStart(3, '0')}`;
    const turnId = `${input.prefix}-turn-${String(index).padStart(3, '0')}`;
    const createdAt = new Date(input.baseTime + index * 1000).toISOString();
    const snapshot = cloneSnapshot(input.snapshot, {
      prefix: input.prefix,
      index,
      messageId,
      turnId,
      conversationId: input.conversationId,
      createdAt,
    });
    const metadata = {
      provider: 'synthetic-provider',
      model: 'synthetic-model',
      promptVersion: 'p2c-contract-gate',
      sessionName: `${input.prefix}-session-${index}`,
      sessionScope: 'agent_turn',
      streaming: false,
      routingMode: 'mention_queue',
      hop: 1,
      tokenUsage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
      usage: { input: 1000, output: 100, totalTokens: 1100 },
      crossConversation: index === 0 ? { deliveryId: 'contract-gate-delivery' } : undefined,
      goalAutoContinue: index === 1,
      agentContextSnapshot: snapshot,
      modelUsage: input.modelUsage,
    };
    fullMetadataBytes.push(Buffer.byteLength(JSON.stringify(metadata), 'utf8'));
    const createPayload = {
      id: messageId,
      conversationId: input.conversationId,
      turnId,
      role: 'assistant',
      agentId: 'role-family-gpt',
      senderName: 'GPT',
      content: 'Thinking...',
      status: 'queued',
      metadata: { ...metadata, modelUsage: undefined, phase: 'queued' },
      createdAt,
    };
    if (input.contract) createPayload.contextSnapshot = snapshot;
    store.createMessage(createPayload);

    if (index === 0) {
      const before = store.db.prepare(`
        SELECT snapshot_json, updated_at FROM chat_message_context_snapshots WHERE message_id = ?
      `).get(messageId);
      for (let updateIndex = 0; updateIndex < 3; updateIndex += 1) {
        const streamingPayload = {
          status: 'streaming',
          metadata: {
            ...store.getMessage(messageId).metadata,
            phase: `streaming-${updateIndex}`,
            toolBridge: { enabled: true, publicPostCount: updateIndex + 1 },
          },
        };
        if (input.contract) streamingPayload.contextSnapshot = snapshot;
        store.updateMessage(messageId, streamingPayload);
      }
      const after = store.db.prepare(`
        SELECT snapshot_json, updated_at FROM chat_message_context_snapshots WHERE message_id = ?
      `).get(messageId);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        throw new Error(`${input.prefix} immutable snapshot was rewritten`);
      }
    }

    const completePayload = {
      content: `completed ${index}`,
      status: 'completed',
      metadata: { ...metadata, phase: 'completed' },
    };
    if (input.contract) {
      completePayload.contextSnapshot = snapshot;
      completePayload.modelUsage = input.modelUsage;
    }
    store.updateMessage(messageId, completePayload);
    const row = store.db.prepare('SELECT metadata_json FROM chat_messages WHERE id = ?').get(messageId);
    actualMetadataBytes.push(Buffer.byteLength(row.metadata_json, 'utf8'));
    ids.push(messageId);
    input.sample();
  }

  return { ids, fullMetadataBytes, actualMetadataBytes };
}

async function main() {
  const args = parseArgs(process.argv);
  const manifest = JSON.parse(fs.readFileSync(args.manifestPath, 'utf8'));
  const contractPath = path.join(args.workDir, 'chat.sqlite');
  const expandPath = path.join(args.workDir, 'expand-control.sqlite');
  copySqliteFamily(contractPath, expandPath);

  const { createChatAppStore } = require('../../build/lib/chat-app-store');
  const { projectConversationMessageEventPayload } = require('../../build/lib/message-detail-contract');
  const { buildConversationMessagePage } = require('../../build/server/domain/conversation/message-pagination');
  let contractStore = createChatAppStore({ agentDir: args.workDir, sqlitePath: contractPath });
  let expandStore = createChatAppStore({ agentDir: args.workDir, sqlitePath: expandPath });
  const checks = [];
  const forbiddenCalls = { getConversation: 0, listMessages: 0 };

  try {
    const conversationId = manifest.p2cExpand.conversationId;
    const historicalBytesBefore = historicalMetadataBytes(contractStore);
    const contractBytesBefore = databaseBytes(contractPath);
    const expandBytesBefore = databaseBytes(expandPath);
    const largestSnapshotMessage = contractStore.db.prepare(`
      SELECT id
      FROM chat_messages
      WHERE conversation_id = ?
        AND json_valid(metadata_json) = 1
        AND json_type(metadata_json, '$.agentContextSnapshot') = 'object'
      ORDER BY length(json_extract(metadata_json, '$.agentContextSnapshot')) DESC
      LIMIT 1
    `).get(conversationId);
    const sourceSnapshot = contractStore.getMessageContextSnapshot(largestSnapshotMessage && largestSnapshotMessage.id);
    const sourceSnapshotBytes = Buffer.byteLength(JSON.stringify(sourceSnapshot), 'utf8');
    checks.push({
      name: 'production-shape full snapshot is at least 200KiB',
      pass: sourceSnapshotBytes >= 200 * 1024,
      detail: `${(sourceSnapshotBytes / 1024).toFixed(1)}KiB`,
    });

    for (const name of Object.keys(forbiddenCalls)) {
      contractStore[name] = () => {
        forbiddenCalls[name] += 1;
        throw new Error(`forbidden hydration: ${name}`);
      };
    }

    collectGarbage();
    const baseline = process.memoryUsage();
    const sampler = { peakHeapUsed: baseline.heapUsed, peakRss: baseline.rss, samples: 0 };
    const interval = setInterval(() => sample(sampler), 10);
    if (typeof interval.unref === 'function') interval.unref();
    const startedAt = process.hrtime.bigint();
    const latest = contractStore.db.prepare(`
      SELECT created_at FROM chat_messages
      WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(conversationId);
    const baseTime = Math.max(Date.parse(latest.created_at) + 1000, Date.parse('2026-08-25T12:00:00.000Z'));
    const fullUsage = createModelUsage(100);
    const contractWrites = writeMessages(contractStore, {
      contract: true,
      prefix: 'p2c-contract-gate',
      count: 50,
      baseTime,
      conversationId,
      snapshot: sourceSnapshot,
      modelUsage: fullUsage,
      sample: () => sample(sampler),
    });
    const expandWrites = writeMessages(expandStore, {
      contract: false,
      prefix: 'p2c-expand-control',
      count: 50,
      baseTime,
      conversationId,
      snapshot: sourceSnapshot,
      modelUsage: fullUsage,
      sample: () => sample(sampler),
    });

    const firstContractId = contractWrites.ids[0];
    const firstContractMessage = contractStore.getMessage(firstContractId);
    const serializedContractMetadata = JSON.stringify(firstContractMessage.metadata);
    const contractSnapshot = contractStore.getMessageContextSnapshot(firstContractId);
    const contractUsage = contractStore.getMessageModelUsage(firstContractId);
    checks.push({
      name: 'Contract metadata omits full snapshot and calls while detail stays complete',
      pass: !serializedContractMetadata.includes('displayContent')
        && !serializedContractMetadata.includes('"calls"')
        && contractSnapshot.sections[0].displayContent === sourceSnapshot.sections[0].displayContent
        && contractUsage.calls.length === 64
        && contractUsage.calls[0].sequence === 1
        && contractUsage.calls[1].sequence === 38
        && contractUsage.calls[63].sequence === 100
        && contractUsage.modelCallCount === 100
        && contractUsage.droppedCallCount === 36,
    });

    const contractMetadataBytes = contractWrites.actualMetadataBytes.reduce((sum, value) => sum + value, 0);
    const expandMetadataBytes = expandWrites.actualMetadataBytes.reduce((sum, value) => sum + value, 0);
    checks.push({
      name: 'future Contract metadata bytes are at least 90% smaller than Expand control',
      pass: contractMetadataBytes <= expandMetadataBytes * 0.1,
      detail: `contract=${contractMetadataBytes}, expand=${expandMetadataBytes}`,
    });

    const page = buildConversationMessagePage(
      contractStore,
      conversationId,
      new URLSearchParams('limit=50')
    );
    const pageJson = JSON.stringify(page);
    checks.push({
      name: 'latest 50-message page is bounded and contains no detail bodies',
      pass: page.items.length === 50
        && pageJson.length < 256 * 1024
        && !pageJson.includes('displayContent')
        && !pageJson.includes('"calls"'),
      detail: `${Buffer.byteLength(pageJson, 'utf8')} bytes`,
    });

    const eventPayload = projectConversationMessageEventPayload('conversation_message_updated', {
      conversationId,
      message: firstContractMessage,
    });
    const eventJson = JSON.stringify(eventPayload);
    checks.push({
      name: 'message SSE projection is bounded and contains no detail bodies',
      pass: Buffer.byteLength(eventJson, 'utf8') < 16 * 1024
        && !eventJson.includes('displayContent')
        && !eventJson.includes('"calls"'),
      detail: `${Buffer.byteLength(eventJson, 'utf8')} bytes`,
    });

    contractStore.deleteConversationMessages(conversationId, [contractWrites.ids[1]]);
    checks.push({
      name: 'Contract message deletion cascades both detail rows',
      pass: !contractStore.db.prepare('SELECT 1 FROM chat_message_context_snapshots WHERE message_id = ?').get(contractWrites.ids[1])
        && !contractStore.db.prepare('SELECT 1 FROM chat_message_model_usage_calls WHERE message_id = ?').get(contractWrites.ids[1]),
    });

    clearInterval(interval);
    sample(sampler);
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    contractStore.db.pragma('wal_checkpoint(TRUNCATE)');
    expandStore.db.pragma('wal_checkpoint(TRUNCATE)');
    const contractBytesAfter = databaseBytes(contractPath);
    const expandBytesAfter = databaseBytes(expandPath);
    const contractDeltaBytes = contractBytesAfter - contractBytesBefore;
    const expandDeltaBytes = expandBytesAfter - expandBytesBefore;
    checks.push({
      name: 'Contract database growth is materially smaller than Expand control',
      pass: contractDeltaBytes > 0 && expandDeltaBytes > 0 && contractDeltaBytes <= expandDeltaBytes * 0.7,
      detail: `contract=${contractDeltaBytes}, expand=${expandDeltaBytes}`,
    });

    const historicalBytesAfter = historicalMetadataBytes(contractStore);
    checks.push({
      name: 'historical metadata bytes remain unchanged',
      pass: historicalBytesAfter === historicalBytesBefore,
      detail: `${historicalBytesBefore} bytes`,
    });
    checks.push({
      name: 'forbidden hydration counters stay zero',
      pass: Object.values(forbiddenCalls).every((value) => value === 0),
      detail: JSON.stringify(forbiddenCalls),
    });
    const integrityCheck = contractStore.db.pragma('integrity_check', { simple: true });
    const foreignKeyViolations = contractStore.db.prepare('PRAGMA foreign_key_check').all().length;
    checks.push({
      name: 'SQLite integrity and foreign keys remain valid',
      pass: integrityCheck === 'ok' && foreignKeyViolations === 0,
      detail: `integrity=${integrityCheck}, foreignKeyViolations=${foreignKeyViolations}`,
    });

    contractStore.close();
    contractStore = createChatAppStore({ agentDir: args.workDir, sqlitePath: contractPath });
    const restartedSnapshot = contractStore.getMessageContextSnapshot(firstContractId);
    const restartedUsage = contractStore.getMessageModelUsage(firstContractId);
    checks.push({
      name: 'restart preserves full Contract detail reads',
      pass: restartedSnapshot && restartedSnapshot.sections[0].displayContent === sourceSnapshot.sections[0].displayContent
        && restartedUsage && restartedUsage.calls.length === 64,
    });

    collectGarbage();
    const retainedMemory = process.memoryUsage();
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
        contractDatabaseDeltaBytes: contractDeltaBytes,
        expandDatabaseDeltaBytes: expandDeltaBytes,
        contractMetadataBytes,
        expandMetadataBytes,
        pagePayloadBytes: Buffer.byteLength(pageJson, 'utf8'),
        ssePayloadBytes: Buffer.byteLength(eventJson, 'utf8'),
      },
      counts: {
        contractMessages: contractWrites.ids.length,
        expandControlMessages: expandWrites.ids.length,
        forbiddenCalls,
      },
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    try { contractStore.close(); } catch {}
    try { expandStore.close(); } catch {}
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error && error.stack || error) })}\n`);
  process.exitCode = 1;
});
