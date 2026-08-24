#!/usr/bin/env node
/**
 * Deterministic production-shape synthetic SQLite seed generator for the P0
 * summary-memory gate (memory health / digest backfill OOM remediation).
 *
 * Shape mirrors the measured production baseline recorded in the frozen plan
 * `.trellis/tasks/08-24-develop-oom-remediation-plan/remediation-plan.md`:
 *   - 256 conversations
 *   - 15,052 messages, ~9.7 MB total content
 *   - ~373 MB total message metadata_json, of which 5,819 rows carry
 *     agentContextSnapshot + modelUsage (~369 MB), largest single row ~323 KB
 *   - largest conversation: 3,044 messages, ~87.5 MB metadata
 *   - bounded digest metadata on representative conversations; exact digest
 *     count / per-conversation distribution recorded in the shape manifest
 *
 * P0-scope omission (recorded in the manifest): a2a_task_events rows are NOT
 * generated. The P0 health/backfill paths never read a2a_task_events; that
 * data is only consumed by the P1 metrics gate, which will extend this
 * generator when P1 is scoped.
 *
 * All data is synthetic and non-sensitive. No production copy is used.
 * Output is disposable and must live under a gitignored directory.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SEED_RANDOM = 20260824;
const CONVERSATION_COUNT = 256;
const MESSAGE_COUNT = 15052;
const LARGEST_CONVERSATION_MESSAGES = 3044;
const BIG_METADATA_ROWS = 5819;
const BIG_METADATA_TOTAL_BYTES = 369 * 1024 * 1024;
const LARGEST_CONVERSATION_METADATA_BYTES = 87.5 * 1024 * 1024;
const MAX_SINGLE_METADATA_BYTES = 323 * 1024;
const LARGEST_CONVERSATION_DIGESTS = 12; // MAX_DIGEST_METADATA_ITEMS

const BASE_TIME_MS = Date.parse('2025-06-01T00:00:00.000Z');
const AGENT_ROSTER = ['role-family-gpt', 'role-family-glm', 'role-family-kimi'];

function createRandom(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function repeatToLength(prefix, targetLength) {
  let text = prefix;
  while (text.length < targetLength) {
    text += prefix;
  }
  return text.slice(0, targetLength);
}

function buildContentText(sequence) {
  return repeatToLength(`synthetic message content block ${sequence}. `, 640);
}

// Builds a big message metadata object whose JSON serialization is padded to
// an exact target byte length via a deterministic filler field.
function buildBigMetadata(sequence, targetBytes, random) {
  const callCount = 24 + Math.floor(random() * 8);
  const calls = [];
  for (let i = 0; i < callCount; i += 1) {
    calls.push({
      id: `call-${sequence}-${i}`,
      model: `synthetic-model-${1 + Math.floor(random() * 5)}`,
      inputTokens: 800 + Math.floor(random() * 4000),
      outputTokens: 200 + Math.floor(random() * 3000),
      latencyMs: 300 + Math.floor(random() * 9000),
    });
  }

  const metadata = {
    synthetic: true,
    agentContextSnapshot: repeatToLength(`context snapshot ${sequence} `, 4096),
    modelUsage: {
      totalCalls: callCount,
      calls,
    },
  };

  let serialized = JSON.stringify(metadata);
  if (serialized.length < targetBytes) {
    const fillerLength = targetBytes - serialized.length - 2;
    if (fillerLength > 0) {
      metadata.syntheticFiller = repeatToLength(`f${sequence} `, fillerLength);
      serialized = JSON.stringify(metadata);
    }
  }
  return { metadata, bytes: Buffer.byteLength(serialized, 'utf8') };
}

function digestFixture(conversationIndex, digestIndex) {
  const id = `synthetic-digest-${String(conversationIndex).padStart(4, '0')}-${String(digestIndex).padStart(2, '0')}`;
  return {
    id,
    kind: 'entry',
    createdAt: new Date(BASE_TIME_MS + conversationIndex * 3600_000 + digestIndex * 60_000).toISOString(),
    updatedAt: new Date(BASE_TIME_MS + conversationIndex * 3600_000 + digestIndex * 60_000 + 30_000).toISOString(),
    createdBy: 'synthetic-seed',
    triggerReason: 'manual',
    messageRange: {
      fromMessageId: `synthetic-message-${conversationIndex}-0`,
      toMessageId: `synthetic-message-${conversationIndex}-99`,
      messageCount: 100,
    },
    summary: repeatToLength(`synthetic digest summary for conversation ${conversationIndex} entry ${digestIndex}. `, 220),
    facts: [repeatToLength(`fact for digest ${id} `, 160)],
    decisions: [repeatToLength(`decision for digest ${id} `, 160)],
    openQuestions: [repeatToLength(`question for digest ${id} `, 120)],
    nextActions: [repeatToLength(`action for digest ${id} `, 120)],
    artifacts: [],
  };
}

function digestCountForConversation(conversationIndex) {
  if (conversationIndex === 0) {
    return LARGEST_CONVERSATION_DIGESTS;
  }
  if (conversationIndex % 4 === 0) {
    return 1 + (conversationIndex % 6);
  }
  return 0;
}

function planConversationSizes(random) {
  const sizes = [LARGEST_CONVERSATION_MESSAGES];
  const remaining = MESSAGE_COUNT - LARGEST_CONVERSATION_MESSAGES;
  const raw = [];
  let rawTotal = 0;
  for (let i = 1; i < CONVERSATION_COUNT; i += 1) {
    const weight = 4 + Math.floor(random() * 116);
    raw.push(weight);
    rawTotal += weight;
  }
  let allocated = 0;
  const scaled = raw.map((weight) => {
    const value = Math.max(3, Math.floor((weight / rawTotal) * remaining));
    allocated += value;
    return value;
  });
  let remainder = remaining - allocated;
  let index = 0;
  while (remainder > 0) {
    scaled[index % scaled.length] += 1;
    remainder -= 1;
    index += 1;
  }
  return sizes.concat(scaled);
}

function planBigMetadataSizes(random) {
  const rawSizes = [];
  for (let i = 0; i < BIG_METADATA_ROWS; i += 1) {
    const roll = random();
    let size;
    if (roll < 0.78) {
      size = 56_000 + Math.floor(random() * 12_000);
    } else if (roll < 0.94) {
      size = 90_000 + Math.floor(random() * 60_000);
    } else {
      size = 200_000 + Math.floor(random() * (MAX_SINGLE_METADATA_BYTES - 200_000));
    }
    rawSizes.push(size);
  }
  // Pin exactly one row to the measured production maximum (~323 KiB) so the
  // manifest records the true worst-case single-row shape instead of only
  // the scaled-down distribution peak; the remaining rows share the rest of
  // the frozen big-metadata byte budget.
  const pinnedIndex = 0;
  const pinnedBytes = MAX_SINGLE_METADATA_BYTES;
  const scalableTotal = rawSizes.reduce((sum, value) => sum + value, 0) - rawSizes[pinnedIndex];
  const scale = (BIG_METADATA_TOTAL_BYTES - pinnedBytes) / scalableTotal;
  return rawSizes.map((value, index) =>
    index === pinnedIndex
      ? pinnedBytes
      : Math.min(MAX_SINGLE_METADATA_BYTES, Math.max(8_000, Math.floor(value * scale)))
  );
}

function generateSyntheticSeed(options) {
  const outputDir = options.outputDir;
  const sqlitePath = options.sqlitePath || path.join(outputDir, 'chat.sqlite');
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });

  const { createChatAppStore } = require('../../build/lib/chat-app-store');
  const random = createRandom(SEED_RANDOM);

  const conversationSizes = planConversationSizes(random);
  const bigMetadataSizes = planBigMetadataSizes(random);

  // Reserve big rows for the largest conversation so its metadata total
  // mirrors the measured ~87.5 MB production projection.
  const averageBigBytes = bigMetadataSizes.reduce((sum, value) => sum + value, 0) / bigMetadataSizes.length;
  const largestConversationBigRows = Math.min(
    conversationSizes[0] - 4,
    Math.round(LARGEST_CONVERSATION_METADATA_BYTES / averageBigBytes)
  );
  const otherBigRows = BIG_METADATA_ROWS - largestConversationBigRows;
  const otherMessages = MESSAGE_COUNT - conversationSizes[0];

  // Exact big-row allocation: floor per conversation, then spread the
  // rounding deficit round-robin so the total hits BIG_METADATA_ROWS exactly.
  const bigRowTargets = [largestConversationBigRows];
  let assignedBigRows = largestConversationBigRows;
  for (let i = 1; i < CONVERSATION_COUNT; i += 1) {
    const target = Math.floor((conversationSizes[i] / otherMessages) * otherBigRows);
    bigRowTargets.push(target);
    assignedBigRows += target;
  }
  let bigRowDeficit = BIG_METADATA_ROWS - assignedBigRows;
  let deficitIndex = 0;
  while (bigRowDeficit > 0) {
    const conversationIndex = (deficitIndex % (CONVERSATION_COUNT - 1)) + 1;
    if (bigRowTargets[conversationIndex] < conversationSizes[conversationIndex]) {
      bigRowTargets[conversationIndex] += 1;
      bigRowDeficit -= 1;
    }
    deficitIndex += 1;
  }

  let nextBigSizeIndex = 0;
  const manifest = {
    generator: {
      script: 'scripts/summary-memory-p0/synthetic-seed.js',
      seedRandom: SEED_RANDOM,
      nodeVersion: process.version,
      generatedAt: new Date().toISOString(),
    },
    conversations: CONVERSATION_COUNT,
    messages: 0,
    contentBytes: 0,
    metadataBytes: 0,
    bigMetadataRows: BIG_METADATA_ROWS,
    bigMetadataRowsActual: 0,
    bigMetadataBytes: 0,
    maxSingleMetadataBytes: 0,
    largestConversation: {
      id: 'synthetic-conversation-0000',
      messages: conversationSizes[0],
      metadataBytes: 0,
      digests: LARGEST_CONVERSATION_DIGESTS,
    },
    digestConversations: 0,
    digestTotal: 0,
    digestDistribution: {},
    omitted: [
      'a2a_task_events rows are not generated: P0 health/backfill paths never read them; the P1 metrics gate will extend this generator.',
    ],
    sqlitePath,
  };

  const store = createChatAppStore({
    agentDir: outputDir,
    sqlitePath,
  });

  try {
    for (let conversationIndex = 0; conversationIndex < CONVERSATION_COUNT; conversationIndex += 1) {
      const conversationId = `synthetic-conversation-${String(conversationIndex).padStart(4, '0')}`;
      const messageCount = conversationSizes[conversationIndex];
      const digestCount = digestCountForConversation(conversationIndex);
      const digests = [];
      for (let d = 0; d < digestCount; d += 1) {
        digests.push(digestFixture(conversationIndex, d));
      }
      if (digestCount > 0) {
        manifest.digestConversations += 1;
        manifest.digestTotal += digestCount;
        const bucket = String(digestCount);
        manifest.digestDistribution[bucket] = (manifest.digestDistribution[bucket] || 0) + 1;
      }

      const conversationStartMs = BASE_TIME_MS + conversationIndex * 1.5 * 86400_000;
      const messageStepMs = Math.max(1000, Math.floor((60 * 86400_000) / messageCount));

      store.createConversation({
        id: conversationId,
        title: `Synthetic Conversation ${String(conversationIndex).padStart(4, '0')}`,
        participants: [AGENT_ROSTER[conversationIndex % AGENT_ROSTER.length]],
        metadata: digests.length > 0 ? { conversationDigests: digests } : {},
      });

      let conversationBigRows = bigRowTargets[conversationIndex];
      const bigRowPositions = new Set();
      const bigRowTarget = Math.min(conversationBigRows, messageCount);
      while (bigRowPositions.size < bigRowTarget) {
        bigRowPositions.add(Math.floor(random() * messageCount));
      }

      for (let messageIndex = 0; messageIndex < messageCount; messageIndex += 1) {
        const isUser = messageIndex % 2 === 0;
        const sequence = manifest.messages + 1;
        let metadata;
        if (bigRowPositions.has(messageIndex)) {
          const size = bigMetadataSizes[nextBigSizeIndex % bigMetadataSizes.length];
          nextBigSizeIndex += 1;
          const built = buildBigMetadata(sequence, size, random);
          metadata = built.metadata;
          manifest.metadataBytes += built.bytes;
          manifest.bigMetadataBytes += built.bytes;
          manifest.bigMetadataRowsActual += 1;
          manifest.maxSingleMetadataBytes = Math.max(manifest.maxSingleMetadataBytes, built.bytes);
          if (conversationIndex === 0) {
            manifest.largestConversation.metadataBytes += built.bytes;
            manifest.largestConversation.bigMetadataRows = (manifest.largestConversation.bigMetadataRows || 0) + 1;
          }
        } else {
          metadata = { synthetic: true, sequence };
          manifest.metadataBytes += 40;
          if (conversationIndex === 0) {
            manifest.largestConversation.metadataBytes += 40;
          }
        }

        const content = buildContentText(sequence);
        manifest.contentBytes += Buffer.byteLength(content, 'utf8');

        store.createMessage({
          id: `synthetic-message-${conversationIndex}-${String(messageIndex).padStart(5, '0')}`,
          conversationId,
          turnId: `synthetic-turn-${conversationIndex}-${Math.floor(messageIndex / 2)}`,
          role: isUser ? 'user' : 'assistant',
          agentId: isUser ? null : AGENT_ROSTER[(conversationIndex + messageIndex) % AGENT_ROSTER.length],
          content,
          status: 'completed',
          metadata,
          createdAt: new Date(conversationStartMs + messageIndex * messageStepMs).toISOString(),
        });
        manifest.messages += 1;
      }

      if ((conversationIndex + 1) % 32 === 0) {
        process.stderr.write(`seed: conversations ${conversationIndex + 1}/${CONVERSATION_COUNT}\n`);
      }
    }

    manifest.dbSizeBytes = fs.statSync(sqlitePath).size;
    fs.writeFileSync(
      path.join(path.dirname(sqlitePath), 'shape-manifest.json'),
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
  const outputDir = process.argv[2] || path.join('.tmp', 'summary-memory-p0-gate', 'seed');
  const manifest = generateSyntheticSeed({ outputDir });
  process.stdout.write(`${JSON.stringify({
    conversations: manifest.conversations,
    messages: manifest.messages,
    contentBytes: manifest.contentBytes,
    metadataBytes: manifest.metadataBytes,
    bigMetadataRows: manifest.bigMetadataRows,
    bigMetadataBytes: manifest.bigMetadataBytes,
    maxSingleMetadataBytes: manifest.maxSingleMetadataBytes,
    largestConversation: manifest.largestConversation,
    digestConversations: manifest.digestConversations,
    digestTotal: manifest.digestTotal,
    digestDistribution: manifest.digestDistribution,
    dbSizeBytes: manifest.dbSizeBytes,
  }, null, 2)}\n`);
}
