#!/usr/bin/env node
/**
 * Deterministic production-shape synthetic SQLite seed generator for the P1
 * metrics/SSE/observability gate.
 *
 * Message shape mirrors the measured production baseline recorded in the
 * frozen plan `.trellis/tasks/08-24-develop-oom-remediation-plan/remediation-plan.md`
 * (same shape as the P0 seed generator):
 *   - 256 conversations
 *   - 15,052 messages, ~9.7 MB total content
 *   - ~373 MB total message metadata_json, of which 5,819 rows carry
 *     agentContextSnapshot + modelUsage (~369 MB), largest single row ~323 KB
 *
 * P1-specific shape (metrics worst case, all inside one 31-day window):
 *   - every assistant message carries a task_id
 *   - one a2a_tasks row per task
 *   - a2a_task_events: 484,602 rows (~38 MB) of 'agent_expectations' /
 *     'agent_tool_call' events (~80 bytes each), all task ids inside the
 *     window — the worst case for the bounded 31-day report
 *   - message metadata carries the metrics fields (publicToolUsed,
 *     publicPostCount, privatePostCount, privateHandoffCount)
 *   - one extra small conversation ('sse-driver') for the concurrent
 *     metrics+SSE scenario; its messages have no task_id and are therefore
 *     excluded from agent metrics
 *
 * The manifest records the exact expected agent metrics aggregates the gate
 * asserts against, computed alongside generation from the same deterministic
 * random stream.
 *
 * All data is synthetic and non-sensitive. No production copy is used.
 * Output is disposable and must live under a gitignored directory.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SEED_RANDOM = 20260825;
const CONVERSATION_COUNT = 256;
const MESSAGE_COUNT = 15052;
const LARGEST_CONVERSATION_MESSAGES = 3044;
const BIG_METADATA_ROWS = 5819;
const BIG_METADATA_TOTAL_BYTES = 369 * 1024 * 1024;
const LARGEST_CONVERSATION_METADATA_BYTES = 87.5 * 1024 * 1024;
const MAX_SINGLE_METADATA_BYTES = 323 * 1024;

// Everything lives inside [WINDOW_START, WINDOW_START + 29 days] so a single
// date-only 31-day window (since = day 0, until = day 29) covers the entire
// seed: the worst case for the bounded report.
const WINDOW_START_MS = Date.parse('2025-06-01T00:00:00.000Z');
const WINDOW_DAYS = 29;
const CONVERSATIONS_PER_DAY = 9; // 256 / 9 -> days 0..28

const TASK_EVENT_COUNT = 484602;
const AGENT_ROSTER = ['role-family-gpt', 'role-family-glm', 'role-family-kimi'];
const TOOL_NAMES = ['send-public', 'send-private', 'read-context', 'search-messages', 'write-experience'];
const TOOL_WEIGHTS = [0.34, 0.18, 0.2, 0.18, 0.1];

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

function pickTool(random) {
  const roll = random();
  let cumulative = 0;
  for (let i = 0; i < TOOL_NAMES.length; i += 1) {
    cumulative += TOOL_WEIGHTS[i];
    if (roll < cumulative) {
      return TOOL_NAMES[i];
    }
  }
  return TOOL_NAMES[0];
}

function buildBigMetadata(sequence, targetBytes, random, metricsFields) {
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
    ...metricsFields,
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
  // manifest records the true worst-case single-row shape.
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

// Deterministic per-task expectations and metrics fields, shared by the
// generated data and the expected-aggregate accumulator so both consume the
// same decisions.
function drawTaskFixture(random) {
  const publicToolUsed = random() < 0.65;
  const publicPostCount = publicToolUsed ? 1 + Math.floor(random() * 3) : 0;
  const privatePostCount = random() < 0.3 ? 1 + Math.floor(random() * 2) : 0;
  const privateHandoffCount = random() < 0.15 ? 1 : 0;

  const sendPublicRoll = random();
  const sendPublic = sendPublicRoll < 0.7 ? 'required' : sendPublicRoll < 0.9 ? 'forbidden' : 'optional';

  const sendPrivateRoll = random();
  const sendPrivate = sendPrivateRoll < 0.3 ? 'required' : sendPrivateRoll < 0.4 ? 'forbidden' : 'optional';

  const metricsFields = {
    publicToolUsed,
    publicPostCount,
    privatePostCount,
    privateHandoffCount,
  };

  const expectations = {
    'send-public': sendPublic,
    'send-private': sendPrivate,
  };

  return { metricsFields, expectations };
}

function ensureExpectedAgentBucket(expectedAgents, agentId, agentName) {
  if (!expectedAgents.has(agentId)) {
    expectedAgents.set(agentId, {
      agentId,
      agentName,
      turns: 0,
      turnsCompleted: 0,
      turnsFailed: 0,
      missingExpectations: 0,
      publicToolUsedTurns: 0,
      publicPostCount: 0,
      privatePostCount: 0,
      privateHandoffCount: 0,
      sendPublic: { tp: 0, fp: 0, fn: 0, tn: 0, required: 0, forbidden: 0 },
      sendPrivate: { tp: 0, fp: 0, fn: 0, tn: 0, required: 0, forbidden: 0 },
      tools: new Map(),
    });
  }
  return expectedAgents.get(agentId);
}

function ensureExpectedToolBucket(tools, toolName) {
  if (!tools.has(toolName)) {
    tools.set(toolName, { tool: toolName, calls: 0, succeeded: 0, failed: 0 });
  }
  return tools.get(toolName);
}

// Mirrors the report's accumulation semantics for one assistant message.
function accumulateExpectedMessage(bucket, metricsFields, expectations, toolEvents) {
  bucket.turns += 1;
  bucket.turnsCompleted += 1; // every seeded assistant message is 'completed'

  const publicToolUsed = Boolean(metricsFields.publicToolUsed);
  const publicPostCount = Number.isInteger(metricsFields.publicPostCount) ? metricsFields.publicPostCount : 0;
  const privatePostCount = Number.isInteger(metricsFields.privatePostCount) ? metricsFields.privatePostCount : 0;
  const privateHandoffCount = Number.isInteger(metricsFields.privateHandoffCount)
    ? metricsFields.privateHandoffCount
    : 0;
  const privateToolUsed = privatePostCount > 0;

  if (publicToolUsed) {
    bucket.publicToolUsedTurns += 1;
  }
  bucket.publicPostCount += publicPostCount;
  bucket.privatePostCount += privatePostCount;
  bucket.privateHandoffCount += privateHandoffCount;

  if (!expectations) {
    bucket.missingExpectations += 1;
  } else {
    const expSendPublic = String(expectations['send-public'] || '').trim();
    const expSendPrivate = String(expectations['send-private'] || '').trim();

    if (expSendPublic === 'required') {
      bucket.sendPublic.required += 1;
      if (publicToolUsed) {
        bucket.sendPublic.tp += 1;
      } else {
        bucket.sendPublic.fn += 1;
      }
    } else if (expSendPublic === 'forbidden') {
      bucket.sendPublic.forbidden += 1;
      if (publicToolUsed) {
        bucket.sendPublic.fp += 1;
      } else {
        bucket.sendPublic.tn += 1;
      }
    }

    if (expSendPrivate === 'required') {
      bucket.sendPrivate.required += 1;
      if (privateToolUsed) {
        bucket.sendPrivate.tp += 1;
      } else {
        bucket.sendPrivate.fn += 1;
      }
    } else if (expSendPrivate === 'forbidden') {
      bucket.sendPrivate.forbidden += 1;
      if (privateToolUsed) {
        bucket.sendPrivate.fp += 1;
      } else {
        bucket.sendPrivate.tn += 1;
      }
    }
  }

  for (const event of toolEvents) {
    const agentToolBucket = ensureExpectedToolBucket(bucket.tools, event.tool);
    agentToolBucket.calls += 1;
    if (event.status === 'succeeded') {
      agentToolBucket.succeeded += 1;
    } else if (event.status === 'failed') {
      agentToolBucket.failed += 1;
    }
  }
}

function generateSyntheticSeed(options) {
  const outputDir = options.outputDir;
  const sqlitePath = options.sqlitePath || path.join(outputDir, 'chat.sqlite');
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });

  const { createChatAppStore } = require('../../build/lib/chat-app-store');
  const { migrateRunSchema } = require('../../build/storage/sqlite/migrations');
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

  const assistantTaskIds = [];
  const taskFixtures = new Map(); // taskId -> { metricsFields, expectations, toolEvents }
  let nextBigSizeIndex = 0;

  const expectedAgents = new Map();
  const expectedGlobalTools = new Map();

  const manifest = {
    generator: {
      script: 'scripts/p1-metrics-sse/synthetic-seed.js',
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
    },
    metricsWindow: {
      since: '2025-06-01',
      until: '2025-06-30',
      spanDays: 30,
    },
    taskCount: 0,
    taskEvents: 0,
    taskEventBytes: 0,
    expectedMetrics: null,
    sqlitePath,
  };

  const store = createChatAppStore({
    agentDir: outputDir,
    sqlitePath,
  });

  function taskIdFor(conversationIndex, messageIndex) {
    return `synthetic-task-${String(conversationIndex).padStart(4, '0')}-${String(messageIndex).padStart(5, '0')}`;
  }

  try {
    for (let conversationIndex = 0; conversationIndex < CONVERSATION_COUNT; conversationIndex += 1) {
      const conversationId = `synthetic-conversation-${String(conversationIndex).padStart(4, '0')}`;
      const messageCount = conversationSizes[conversationIndex];
      const conversationDay = Math.floor(conversationIndex / CONVERSATIONS_PER_DAY);
      const conversationStartMs = WINDOW_START_MS + conversationDay * 86400_000;
      // Fit all messages inside the conversation's day (~12h span).
      const messageStepMs = Math.max(1000, Math.floor((12 * 3600_000) / messageCount));

      store.createConversation({
        id: conversationId,
        title: `Synthetic Conversation ${String(conversationIndex).padStart(4, '0')}`,
        participants: [AGENT_ROSTER[conversationIndex % AGENT_ROSTER.length]],
        metadata: {},
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
        let taskId = null;
        let agentId = null;
        let taskFixture = null;

        if (!isUser) {
          taskId = taskIdFor(conversationIndex, messageIndex);
          agentId = AGENT_ROSTER[(conversationIndex + messageIndex) % AGENT_ROSTER.length];
          taskFixture = drawTaskFixture(random);
          taskFixtures.set(taskId, taskFixture);
          assistantTaskIds.push(taskId);
          manifest.taskCount += 1;
        }

        if (bigRowPositions.has(messageIndex)) {
          const size = bigMetadataSizes[nextBigSizeIndex % bigMetadataSizes.length];
          nextBigSizeIndex += 1;
          const built = buildBigMetadata(sequence, size, random, taskFixture ? taskFixture.metricsFields : {});
          metadata = built.metadata;
          manifest.metadataBytes += built.bytes;
          manifest.bigMetadataBytes += built.bytes;
          manifest.bigMetadataRowsActual += 1;
          manifest.maxSingleMetadataBytes = Math.max(manifest.maxSingleMetadataBytes, built.bytes);
          if (conversationIndex === 0) {
            manifest.largestConversation.metadataBytes += built.bytes;
          }
        } else {
          metadata = taskFixture
            ? { synthetic: true, sequence, ...taskFixture.metricsFields }
            : { synthetic: true, sequence };
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
          agentId: isUser ? null : agentId,
          senderName: isUser ? null : `Agent ${agentId}`,
          content,
          status: 'completed',
          taskId,
          metadata,
          createdAt: new Date(conversationStartMs + messageIndex * messageStepMs).toISOString(),
        });
        manifest.messages += 1;
      }

      if ((conversationIndex + 1) % 32 === 0) {
        process.stderr.write(`seed: conversations ${conversationIndex + 1}/${CONVERSATION_COUNT}\n`);
      }
    }

    // Extra small conversation used by the concurrent metrics+SSE scenario.
    // No task_id messages: excluded from agent metrics.
    store.createConversation({
      id: 'synthetic-conversation-sse-driver',
      title: 'Synthetic SSE Driver',
      participants: [AGENT_ROSTER[0], AGENT_ROSTER[1]],
      metadata: {},
    });
    for (let messageIndex = 0; messageIndex < 24; messageIndex += 1) {
      const isUser = messageIndex % 2 === 0;
      store.createMessage({
        id: `synthetic-sse-driver-message-${String(messageIndex).padStart(5, '0')}`,
        conversationId: 'synthetic-conversation-sse-driver',
        turnId: 'synthetic-sse-driver-turn-0',
        role: isUser ? 'user' : 'assistant',
        agentId: isUser ? null : AGENT_ROSTER[messageIndex % 2],
        senderName: isUser ? null : 'Agent',
        content: buildContentText(messageIndex + 1),
        status: 'completed',
        metadata: { synthetic: true },
        createdAt: new Date(WINDOW_START_MS + messageIndex * 60_000).toISOString(),
      });
      manifest.messages += 1;
    }

    // Plan tool events per task so the total hits TASK_EVENT_COUNT exactly.
    const expectationsEvents = assistantTaskIds.length;
    const toolEventTotal = TASK_EVENT_COUNT - expectationsEvents;
    const toolEventsPerTask = new Array(assistantTaskIds.length);
    let assignedToolEvents = 0;
    for (let i = 0; i < assistantTaskIds.length; i += 1) {
      const count = Math.floor(toolEventTotal / assistantTaskIds.length);
      toolEventsPerTask[i] = count;
      assignedToolEvents += count;
    }
    let toolEventDeficit = toolEventTotal - assignedToolEvents;
    let toolDeficitIndex = 0;
    while (toolEventDeficit > 0) {
      toolEventsPerTask[toolDeficitIndex % toolEventsPerTask.length] += 1;
      toolEventDeficit -= 1;
      toolDeficitIndex += 1;
    }

    // a2a_tasks + a2a_task_events rows (compact production-scale shape,
    // ~80 bytes per event; 484,602 events total).
    migrateRunSchema(store.db);
    const insertTask = store.db.prepare(`
      INSERT INTO a2a_tasks (id, kind, title, status, assigned_agent, created_at, updated_at)
      VALUES (?, 'task', ?, 'completed', ?, ?, ?)
    `);
    const insertEvent = store.db.prepare(`
      INSERT INTO a2a_task_events (task_id, event_type, event_json, created_at)
      VALUES (?, ?, ?, ?)
    `);

    process.stderr.write(`seed: inserting ${TASK_EVENT_COUNT} task events...\n`);
    store.db.transaction(() => {
      for (let taskIndex = 0; taskIndex < assistantTaskIds.length; taskIndex += 1) {
        const taskId = assistantTaskIds[taskIndex];
        const fixture = taskFixtures.get(taskId);
        const createdAt = new Date(WINDOW_START_MS + 3600_000 + taskIndex * 1000).toISOString();

        insertTask.run(taskId, `Synthetic task ${taskIndex}`, 'role-family-glm', createdAt, createdAt);

        const expectationsJson = JSON.stringify({ expectations: fixture.expectations });
        manifest.taskEventBytes += Buffer.byteLength(expectationsJson, 'utf8');
        insertEvent.run(taskId, 'agent_expectations', expectationsJson, createdAt);
        manifest.taskEvents += 1;

        const toolEvents = [];
        const toolCount = toolEventsPerTask[taskIndex];
        for (let e = 0; e < toolCount; e += 1) {
          const tool = pickTool(random);
          const status = random() < 0.93 ? 'succeeded' : 'failed';
          const durationMs = 50 + Math.floor(random() * 4950);
          const eventJson = JSON.stringify({ tool, status, durationMs });
          manifest.taskEventBytes += Buffer.byteLength(eventJson, 'utf8');
          insertEvent.run(taskId, 'agent_tool_call', eventJson, createdAt);
          manifest.taskEvents += 1;
          toolEvents.push({ tool, status, durationMs });
        }

        // The assistant message agent for a task is deterministic from the
        // same formula used when creating the message row.
        const conversationIndex = Number(taskId.slice('synthetic-task-'.length, 'synthetic-task-'.length + 4));
        const messageIndex = Number(taskId.slice(-5));
        const agentId = AGENT_ROSTER[(conversationIndex + messageIndex) % AGENT_ROSTER.length];
        const bucket = ensureExpectedAgentBucket(expectedAgents, agentId, `Agent ${agentId}`);
        accumulateExpectedMessage(bucket, fixture.metricsFields, fixture.expectations, toolEvents);

        for (const event of toolEvents) {
          const globalBucket = ensureExpectedToolBucket(expectedGlobalTools, event.tool);
          globalBucket.calls += 1;
          if (event.status === 'succeeded') {
            globalBucket.succeeded += 1;
          } else if (event.status === 'failed') {
            globalBucket.failed += 1;
          }
        }

        if ((taskIndex + 1) % 1000 === 0) {
          process.stderr.write(`seed: task events for ${taskIndex + 1}/${assistantTaskIds.length} tasks\n`);
        }
      }
    })();

    const expectedAgentsOut = Array.from(expectedAgents.values()).map((bucket) => ({
      agentId: bucket.agentId,
      agentName: bucket.agentName,
      turns: bucket.turns,
      turnsCompleted: bucket.turnsCompleted,
      turnsFailed: bucket.turnsFailed,
      missingExpectations: bucket.missingExpectations,
      publicToolUsedTurns: bucket.publicToolUsedTurns,
      publicPostCount: bucket.publicPostCount,
      privatePostCount: bucket.privatePostCount,
      privateHandoffCount: bucket.privateHandoffCount,
      sendPublic: bucket.sendPublic,
      sendPrivate: bucket.sendPrivate,
      tools: Array.from(bucket.tools.values()),
    }));
    expectedAgentsOut.sort((a, b) => b.turns - a.turns);

    manifest.expectedMetrics = {
      agents: expectedAgentsOut,
      tools: Array.from(expectedGlobalTools.values()).sort((a, b) => b.calls - a.calls),
      totalTurns: expectedAgentsOut.reduce((sum, agent) => sum + agent.turns, 0),
    };

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
  const outputDir = process.argv[2] || path.join('.tmp', 'p1-metrics-sse-gate', 'seed');
  const manifest = generateSyntheticSeed({ outputDir });
  process.stdout.write(`${JSON.stringify({
    conversations: manifest.conversations,
    messages: manifest.messages,
    metadataBytes: manifest.metadataBytes,
    taskCount: manifest.taskCount,
    taskEvents: manifest.taskEvents,
    dbSizeBytes: manifest.dbSizeBytes,
  })}\n`);
}
