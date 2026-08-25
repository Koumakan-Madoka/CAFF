#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIB = 1024 * 1024;

function parseArgs(argv) {
  const args = { scenario: '', workDir: '', manifestPath: '' };
  for (let index = 2; index < argv.length; index += 2) {
    if (argv[index] === '--scenario') args.scenario = argv[index + 1];
    else if (argv[index] === '--work-dir') args.workDir = argv[index + 1];
    else if (argv[index] === '--manifest') args.manifestPath = argv[index + 1];
  }
  if (!args.scenario || !args.workDir || !args.manifestPath) {
    throw new Error('usage: gate-child.js --scenario <name> --work-dir <dir> --manifest <path>');
  }
  return args;
}

function collectGarbage() {
  if (typeof global.gc !== 'function') throw new Error('gate child requires --expose-gc');
  global.gc();
  global.gc();
}

function createSampler() {
  return { maxHeapUsed: 0, maxRss: 0, samples: 0 };
}

function sampleMemory(sampler) {
  const usage = process.memoryUsage();
  sampler.maxHeapUsed = Math.max(sampler.maxHeapUsed, usage.heapUsed);
  sampler.maxRss = Math.max(sampler.maxRss, usage.rss);
  sampler.samples += 1;
  return usage;
}

function resetSampler(sampler, baseline) {
  sampler.maxHeapUsed = baseline.heapUsed;
  sampler.maxRss = baseline.rss;
  sampler.samples = 0;
}

function timedAsync(fn) {
  const start = process.hrtime.bigint();
  return Promise.resolve()
    .then(fn)
    .then((value) => ({ value, durationMs: Number(process.hrtime.bigint() - start) / 1e6 }));
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function canonical(messages) {
  for (let index = 1; index < messages.length; index += 1) {
    const left = messages[index - 1];
    const right = messages[index];
    if (left.createdAt > right.createdAt || (left.createdAt === right.createdAt && left.id > right.id)) {
      return false;
    }
  }
  return true;
}

function openStore(args, sampler) {
  const { createChatAppStore } = require('../../build/lib/chat-app-store');
  const sqlitePath = path.join(args.workDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: args.workDir, sqlitePath });
  const fullHydration = { getConversation: 0, listMessages: 0, listPrivateMessages: 0 };
  const projections = {};
  const boundViolations = [];
  const originalMethods = {};

  for (const name of Object.keys(fullHydration)) {
    originalMethods[name] = store[name].bind(store);
    store[name] = () => {
      fullHydration[name] += 1;
      throw new Error(`forbidden full hydration: ${name}`);
    };
  }

  const projectionNames = [
    'getConversationWithoutMessages',
    'updateConversationWithoutMessages',
    'inferLastConsumedUserMessageId',
    'listPendingMainUserMessages',
    'findPreviousUserMessageId',
    'findLatestPublicCompletedAssistantReplyAgentId',
    'listMessagesByIds',
    'listPromptMessages',
    'listSideDispatchRecoveryMessages',
    'listAssistantRepliesForSourceMessage',
    'getMessage',
    'listPrivateMessagesForAgent',
  ];

  for (const name of projectionNames) {
    if (typeof store[name] !== 'function') continue;
    const original = store[name].bind(store);
    store[name] = (...methodArgs) => {
      sampleMemory(sampler);
      const result = original(...methodArgs);
      const rowCount = Array.isArray(result) ? result.length : result ? 1 : 0;
      const stats = projections[name] || { calls: 0, selectedRows: 0, maxSelectedRows: 0 };
      stats.calls += 1;
      stats.selectedRows += rowCount;
      stats.maxSelectedRows = Math.max(stats.maxSelectedRows, rowCount);
      projections[name] = stats;

      if (name === 'listPromptMessages') {
        const conversationId = String(methodArgs[0] || '').trim();
        const options = methodArgs[1] && typeof methodArgs[1] === 'object' ? methodArgs[1] : {};
        const historyLimit = options.historyLimit === undefined ? 24 : Number(options.historyLimit || 0);
        const requiredIds = new Set(
          (Array.isArray(options.requiredMessageIds) ? options.requiredMessageIds : [])
            .map((id) => String(id || '').trim())
            .filter(Boolean)
        );
        const currentTurnId = String(options.currentTurnId || '').trim();
        const currentRows = currentTurnId
          ? Number(store.db.prepare(`
              SELECT COUNT(*) AS count FROM chat_messages
              WHERE conversation_id = ? AND turn_id = ?
            `).get(conversationId, currentTurnId).count || 0)
          : 0;
        const upperBound = historyLimit + requiredIds.size + currentRows;
        if (rowCount > upperBound || !canonical(result)) {
          boundViolations.push({ rowCount, upperBound, canonical: canonical(result), options });
        }
      }
      sampleMemory(sampler);
      return result;
    };
  }

  return { store, sqlitePath, fullHydration, projections, boundViolations, originalMethods };
}

function assertBounded(measured) {
  const forbiddenCalls = Object.values(measured.fullHydration).reduce((sum, value) => sum + value, 0);
  if (forbiddenCalls !== 0) {
    throw new Error(`forbidden full hydration calls: ${JSON.stringify(measured.fullHydration)}`);
  }
  if (measured.boundViolations.length > 0) {
    throw new Error(`prompt projection bound/order violations: ${JSON.stringify(measured.boundViolations.slice(0, 3))}`);
  }
}

function markSeedHistoryConsumed(store) {
  for (const conversation of store.listConversations()) {
    const latestMainUser = store.db.prepare(`
      SELECT id FROM chat_messages
      WHERE conversation_id = ? AND role = 'user'
        AND (json_valid(metadata_json) = 0 OR COALESCE(json_extract(metadata_json, '$.dispatchLane'), '') <> 'side')
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(conversation.id);
    const header = store.getConversationWithoutMessages(conversation.id);
    store.updateConversationWithoutMessages(conversation.id, {
      metadata: {
        ...(header.metadata || {}),
        conversationTurnQueue: { lastConsumedUserMessageId: latestMainUser ? latestMainUser.id : '' },
      },
    });
  }
}

function cancelSeedSideRecovery(store, manifest) {
  const messageId = manifest.p2ab.sideSourceMessageId;
  const row = store.db.prepare('SELECT metadata_json FROM chat_messages WHERE id = ?').get(messageId);
  const metadata = JSON.parse(row.metadata_json || '{}');
  store.db.prepare('UPDATE chat_messages SET metadata_json = ? WHERE id = ?')
    .run(JSON.stringify({ ...metadata, dispatchCancelled: true, dispatchCancelledAt: new Date().toISOString() }), messageId);
}

function createOrchestrator(args, store, executeConversationAgent, extra = {}) {
  const { createTurnOrchestrator } = require('../../build/server/domain/conversation/turn-orchestrator');
  return createTurnOrchestrator({
    store,
    skillRegistry: { listSkills() { return []; }, resolveSkills() { return []; } },
    modeStore: { get() { return null; } },
    agentToolBridge: {},
    host: '127.0.0.1',
    port: 0,
    agentDir: args.workDir,
    sqlitePath: path.join(args.workDir, 'chat.sqlite'),
    toolBaseUrl: 'http://127.0.0.1:0',
    agentToolScriptPath: path.join(args.workDir, 'agent-chat-tools.js'),
    executeConversationAgent,
    ...extra,
  });
}

function startSampling(sampler) {
  const interval = setInterval(() => sampleMemory(sampler), 10);
  if (typeof interval.unref === 'function') interval.unref();
  return interval;
}

function memoryMetrics(baseline, retained, sampler, durationMs) {
  return {
    durationMs,
    baselineHeapUsedMiB: baseline.heapUsed / MIB,
    peakHeapUsedMiB: sampler.maxHeapUsed / MIB,
    retainedHeapUsedMiB: retained.heapUsed / MIB,
    baselineRssMiB: baseline.rss / MIB,
    peakRssMiB: sampler.maxRss / MIB,
    retainedRssMiB: retained.rss / MIB,
    samples: sampler.samples,
  };
}

function oldestUserId(store, conversationId) {
  return store.db.prepare(`
    SELECT id FROM chat_messages
    WHERE conversation_id = ? AND role = 'user'
    ORDER BY created_at ASC, id ASC LIMIT 1
  `).get(conversationId).id;
}

async function runMainTurn(args, manifest) {
  const sampler = createSampler();
  const measured = openStore(args, sampler);
  const { store } = measured;
  cancelSeedSideRecovery(store, manifest);
  const conversationId = manifest.largestConversation.id;
  const sourceMessageId = oldestUserId(store, conversationId);
  let injectedIds = [];
  const orchestrator = createOrchestrator(args, store, async (input) => {
    injectedIds = input.promptMessages.map((message) => message.id);
    const reply = store.createMessage({
      conversationId,
      turnId: input.turnId,
      role: 'assistant',
      agentId: input.agent.id,
      senderName: input.agent.name,
      content: 'bounded main turn reply',
      status: 'completed',
    });
    input.completedReplies.push(reply);
    return { stopTurn: true, terminationReason: 'agent_final' };
  });
  collectGarbage();
  const baseline = process.memoryUsage();
  resetSampler(sampler, baseline);
  const interval = startSampling(sampler);
  try {
    const run = await timedAsync(() => orchestrator.runConversationTurn(conversationId, { batchMessageIds: [sourceMessageId] }));
    assertBounded(measured);
    if (injectedIds.length !== 25 || !injectedIds.includes(sourceMessageId)) {
      throw new Error(`main prompt cardinality/source mismatch: ${injectedIds.length}`);
    }
    if (!run.value.conversation || run.value.conversation.messages.length !== 26) {
      throw new Error(`final union cardinality mismatch: ${run.value.conversation && run.value.conversation.messages.length}`);
    }
    collectGarbage();
    const retained = process.memoryUsage();
    return {
      checks: [
        { name: '24 history + explicit source injected', pass: true },
        { name: 'final union adds one current-turn reply', pass: true },
        { name: 'zero forbidden hydration calls', pass: true },
      ],
      metrics: memoryMetrics(baseline, retained, sampler, run.durationMs),
      counts: { promptRows: injectedIds.length, finalRows: run.value.conversation.messages.length },
      projections: measured.projections,
    };
  } finally {
    clearInterval(interval);
    store.close();
  }
}

async function runRestartRecovery(args, manifest) {
  const { createChatAppStore } = require('../../build/lib/chat-app-store');
  const sqlitePath = path.join(args.workDir, 'chat.sqlite');
  const setupStore = createChatAppStore({ agentDir: args.workDir, sqlitePath });
  cancelSeedSideRecovery(setupStore, manifest);
  const conversationId = manifest.largestConversation.id;
  const latestUser = setupStore.db.prepare(`
    SELECT id FROM chat_messages WHERE conversation_id = ? AND role = 'user'
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(conversationId);
  const header = setupStore.getConversationWithoutMessages(conversationId);
  setupStore.updateConversationWithoutMessages(conversationId, {
    metadata: {
      ...(header.metadata || {}),
      conversationTurnQueue: { lastConsumedUserMessageId: latestUser.id },
    },
  });
  setupStore.close();

  const sampler = createSampler();
  collectGarbage();
  const baseline = process.memoryUsage();
  resetSampler(sampler, baseline);
  const interval = startSampling(sampler);
  const start = process.hrtime.bigint();
  const measured = openStore(args, sampler);
  try {
    const orchestrator = createOrchestrator(args, measured.store, async () => ({ stopTurn: false }));
    const queueDepth = orchestrator.getConversationQueueDepth(conversationId);
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    assertBounded(measured);
    if (queueDepth !== 0) throw new Error(`restart queue depth ${queueDepth} !== 0`);
    collectGarbage();
    const retained = process.memoryUsage();
    return {
      checks: [
        { name: 'fresh orchestrator prefers durable cursor', pass: true },
        { name: 'restart performs zero full conversation hydration', pass: true },
      ],
      metrics: memoryMetrics(baseline, retained, sampler, durationMs),
      counts: { queueDepth },
      projections: measured.projections,
    };
  } finally {
    clearInterval(interval);
    measured.store.close();
  }
}

async function runSideSnapshot(args, manifest) {
  const sampler = createSampler();
  const measured = openStore(args, sampler);
  let promptIds = [];
  collectGarbage();
  const baseline = process.memoryUsage();
  resetSampler(sampler, baseline);
  const interval = startSampling(sampler);
  const start = process.hrtime.bigint();
  try {
    const sideConversation = measured.store.getConversationWithoutMessages(manifest.p2ab.sideConversationId);
    const latestMainUser = measured.store.db.prepare(`
      SELECT id FROM chat_messages
      WHERE conversation_id = ? AND role = 'user'
        AND (json_valid(metadata_json) = 0 OR COALESCE(json_extract(metadata_json, '$.dispatchLane'), '') <> 'side')
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(manifest.p2ab.sideConversationId);
    measured.store.updateConversationWithoutMessages(manifest.p2ab.sideConversationId, {
      metadata: {
        ...(sideConversation.metadata || {}),
        conversationTurnQueue: { lastConsumedUserMessageId: latestMainUser ? latestMainUser.id : '' },
      },
    });
    const orchestrator = createOrchestrator(args, measured.store, async (input) => {
      if (input.queueItem && input.queueItem.triggerType === 'user') {
        promptIds = input.promptMessages.map((message) => message.id);
      }
      input.completedReplies.push({
        id: 'synthetic-side-gate-reply',
        agentId: input.agent.id,
        senderName: input.agent.name,
        content: 'side recovered',
        status: 'completed',
      });
      return { stopTurn: false };
    });
    await waitFor(() => promptIds.length > 0, 15_000, 'side snapshot recovery');
    await waitFor(() => orchestrator.getConversationMutationState(
      manifest.p2ab.sideConversationId
    ).busy === false, 15_000, 'side snapshot settlement');
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    assertBounded(measured);
    if (promptIds.length !== 25) throw new Error(`side prompt rows ${promptIds.length} !== 25`);
    if (!promptIds.includes(manifest.p2ab.sideSourceMessageId)) throw new Error('side source missing');
    if (promptIds.includes(manifest.p2ab.sideLateMessageId)) throw new Error('post-snapshot message leaked');
    collectGarbage();
    const retained = process.memoryUsage();
    return {
      checks: [
        { name: 'restart side source is recovered', pass: true },
        { name: 'side snapshot is 24 history + source', pass: true },
        { name: 'later persisted row remains invisible', pass: true },
      ],
      metrics: memoryMetrics(baseline, retained, sampler, durationMs),
      counts: { promptRows: promptIds.length },
      projections: measured.projections,
    };
  } finally {
    clearInterval(interval);
    measured.store.close();
  }
}

async function runDeletionReconcile(args, manifest) {
  const { createChatAppStore } = require('../../build/lib/chat-app-store');
  const sqlitePath = path.join(args.workDir, 'chat.sqlite');
  const setupStore = createChatAppStore({ agentDir: args.workDir, sqlitePath });
  cancelSeedSideRecovery(setupStore, manifest);
  const conversationId = manifest.largestConversation.id;
  const users = setupStore.db.prepare(`
    SELECT id, created_at FROM chat_messages WHERE conversation_id = ? AND role = 'user'
    ORDER BY created_at DESC, id DESC LIMIT 2
  `).all(conversationId);
  const consumed = users[0];
  const previous = users[1];
  const header = setupStore.getConversationWithoutMessages(conversationId);
  setupStore.updateConversationWithoutMessages(conversationId, {
    metadata: {
      ...(header.metadata || {}),
      conversationTurnQueue: { lastConsumedUserMessageId: consumed.id },
    },
  });
  setupStore.close();

  const sampler = createSampler();
  const measured = openStore(args, sampler);
  const orchestrator = createOrchestrator(args, measured.store, async () => ({ stopTurn: false }));
  const mutationState = orchestrator.getConversationMutationState(conversationId);
  if (mutationState.busy) throw new Error(`deletion fixture is unexpectedly busy: ${JSON.stringify(mutationState)}`);
  collectGarbage();
  const baseline = process.memoryUsage();
  resetSampler(sampler, baseline);
  const interval = startSampling(sampler);
  const start = process.hrtime.bigint();
  try {
    measured.store.db.prepare('DELETE FROM chat_messages WHERE id = ?').run(consumed.id);
    orchestrator.reconcileConversationQueueAfterMessageDeletion(conversationId, [{
      id: consumed.id,
      role: 'user',
      createdAt: consumed.created_at,
    }]);
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const persisted = measured.store.getConversationWithoutMessages(conversationId);
    const cursor = persisted.metadata.conversationTurnQueue.lastConsumedUserMessageId;
    const queueDepth = orchestrator.getConversationQueueDepth(conversationId);
    assertBounded(measured);
    if (cursor !== previous.id || queueDepth !== 0) {
      throw new Error(`deletion reconciliation mismatch: cursor=${cursor}, expected=${previous.id}, depth=${queueDepth}`);
    }
    collectGarbage();
    const retained = process.memoryUsage();
    return {
      checks: [
        { name: 'deleted cursor falls back to previous surviving user', pass: true },
        { name: 'reconciled queue remains empty', pass: true },
      ],
      metrics: memoryMetrics(baseline, retained, sampler, durationMs),
      counts: { queueDepth },
      projections: measured.projections,
    };
  } finally {
    clearInterval(interval);
    measured.store.close();
  }
}

async function runConcurrentTurns(args, manifest) {
  const sampler = createSampler();
  const measured = openStore(args, sampler);
  cancelSeedSideRecovery(measured.store, manifest);
  const conversations = Array.from({ length: 4 }, (_, offset) => `synthetic-conversation-${String(offset + 10).padStart(4, '0')}`);
  const sourceIds = conversations.map((conversationId) => oldestUserId(measured.store, conversationId));
  const promptSizes = [];
  const orchestrator = createOrchestrator(args, measured.store, async (input) => {
    promptSizes.push(input.promptMessages.length);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const reply = measured.store.createMessage({
      conversationId: input.conversationId,
      turnId: input.turnId,
      role: 'assistant',
      agentId: input.agent.id,
      senderName: input.agent.name,
      content: 'bounded concurrent reply',
      status: 'completed',
    });
    input.completedReplies.push(reply);
    return { stopTurn: true, terminationReason: 'agent_final' };
  });
  collectGarbage();
  const baseline = process.memoryUsage();
  resetSampler(sampler, baseline);
  const interval = startSampling(sampler);
  try {
    const run = await timedAsync(() => Promise.all(
      conversations.map((conversationId, index) => orchestrator.runConversationTurn(conversationId, {
        batchMessageIds: [sourceIds[index]],
      }))
    ));
    assertBounded(measured);
    if (promptSizes.length !== 4 || promptSizes.some((size) => size < 1 || size > 25)) {
      throw new Error(`concurrent prompt sizes exceed bounded union: ${promptSizes.join(',')}`);
    }
    if (run.value.some((result) => !result.conversation || result.conversation.messages.length > 26)) {
      throw new Error('concurrent final union exceeded 24 + explicit + current reply');
    }
    collectGarbage();
    const retained = process.memoryUsage();
    return {
      checks: [
        { name: 'four conversations execute concurrently', pass: true },
        { name: 'each concurrent prompt/final union remains bounded', pass: true },
      ],
      metrics: memoryMetrics(baseline, retained, sampler, run.durationMs),
      counts: { turns: run.value.length, promptSizes },
      projections: measured.projections,
    };
  } finally {
    clearInterval(interval);
    measured.store.close();
  }
}

async function runGoal300(args, manifest) {
  const { createChatAppStore } = require('../../build/lib/chat-app-store');
  const sqlitePath = path.join(args.workDir, 'chat.sqlite');
  const setupStore = createChatAppStore({ agentDir: args.workDir, sqlitePath });
  cancelSeedSideRecovery(setupStore, manifest);
  markSeedHistoryConsumed(setupStore);

  function seedGoalConversation(suffix) {
    const conversationId = `p2ab-goal-${suffix}`;
    setupStore.createConversation({
      id: conversationId,
      title: `P2AB Goal ${suffix}`,
      participants: ['role-family-gpt', 'role-family-glm'],
      metadata: {
        sessionGoal: {
          objective: 'Bounded workload objective',
          status: 'active',
          createdAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
        },
      },
    });
    for (let index = 0; index < 30; index += 1) {
      setupStore.createMessage({
        id: `p2ab-goal-${suffix}-seed-${index}`,
        conversationId,
        turnId: `p2ab-goal-${suffix}-seed-turn-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        agentId: index % 2 === 0 ? null : 'role-family-gpt',
        senderName: index % 2 === 0 ? 'You' : 'GPT',
        content: `goal seed ${index}`,
        status: 'completed',
        metadata: {},
        createdAt: `2026-08-25T00:00:${String(index).padStart(2, '0')}.000Z`,
      });
    }
    return conversationId;
  }

  const warmConversation = seedGoalConversation('warm');
  const cycleConversationIds = Array.from({ length: 15 }, (_, cycle) => seedGoalConversation(cycle));
  setupStore.close();

  const sampler = createSampler();
  const measured = openStore(args, sampler);
  const executed = [];
  const orchestrator = createOrchestrator(args, measured.store, async (input) => {
    executed.push(input.conversationId);
    const reply = measured.store.createMessage({
      conversationId: input.conversationId,
      turnId: input.turnId,
      role: 'assistant',
      agentId: input.agent.id,
      senderName: input.agent.name,
      content: 'bounded goal workload reply',
      status: 'completed',
    });
    input.completedReplies.push(reply);
    return { stopTurn: false };
  }, { sessionGoalAutoContinueMaxTurns: 20 });

  const warm = orchestrator.scheduleGoalContinuation(warmConversation);
  if (!warm.scheduled) throw new Error(`warm goal did not schedule: ${warm.reason}`);
  await waitFor(() => executed.length >= 20, 30_000, 'warm goal turns');
  await waitFor(() => orchestrator.getConversationMutationState(warmConversation).busy === false,
    10_000, 'warm goal settlement');

  collectGarbage();
  const baseline = process.memoryUsage();
  resetSampler(sampler, baseline);
  const interval = startSampling(sampler);
  const measuredStartCount = executed.length;
  const start = process.hrtime.bigint();
  try {
    for (let cycle = 0; cycle < 15; cycle += 1) {
      const conversationId = cycleConversationIds[cycle];
      const scheduled = orchestrator.scheduleGoalContinuation(conversationId);
      if (!scheduled.scheduled) throw new Error(`goal cycle ${cycle} did not schedule: ${scheduled.reason}`);
      const target = measuredStartCount + (cycle + 1) * 20;
      await waitFor(() => executed.length >= target, 60_000, `goal cycle ${cycle}`);
      await waitFor(() => orchestrator.getConversationMutationState(conversationId).busy === false,
        10_000, `goal cycle ${cycle} settlement`);
      sampleMemory(sampler);
    }
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const turns = executed.length - measuredStartCount;
    const stats = orchestrator.getRuntimeStats();
    assertBounded(measured);
    if (turns !== 300 || stats.activeTurns !== 0 || stats.activeQueues !== 0 || stats.activeAgentSlots !== 0) {
      throw new Error(`goal workload did not settle: turns=${turns}, stats=${JSON.stringify(stats)}`);
    }
    collectGarbage();
    const retained = process.memoryUsage();
    return {
      checks: [
        { name: '300 Goal continuation turns complete', pass: true },
        { name: 'Goal runtime counters settle to zero', pass: true },
        { name: 'all prompt projections satisfy union formula', pass: true },
      ],
      metrics: memoryMetrics(baseline, retained, sampler, durationMs),
      counts: { turns, cycles: 15 },
      projections: measured.projections,
    };
  } finally {
    clearInterval(interval);
    measured.store.close();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const manifest = JSON.parse(fs.readFileSync(args.manifestPath, 'utf8'));
  const scenarios = {
    'main-turn': () => runMainTurn(args, manifest),
    'goal-300': () => runGoal300(args, manifest),
    'concurrent-turns': () => runConcurrentTurns(args, manifest),
    'restart-recovery': () => runRestartRecovery(args, manifest),
    'side-snapshot': () => runSideSnapshot(args, manifest),
    'deletion-reconcile': () => runDeletionReconcile(args, manifest),
  };
  if (!scenarios[args.scenario]) throw new Error(`unknown scenario: ${args.scenario}`);
  const result = await scenarios[args.scenario]();
  process.stdout.write(`${JSON.stringify({ scenario: args.scenario, ok: true, ...result })}\n`);
}

main().catch((error) => {
  let scenario = '';
  try { scenario = parseArgs(process.argv).scenario; } catch {}
  process.stdout.write(`${JSON.stringify({ scenario, ok: false, error: String(error && error.stack || error) })}\n`);
  process.exitCode = 1;
});
