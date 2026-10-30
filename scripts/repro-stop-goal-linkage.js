#!/usr/bin/env node
/**
 * 手动复现脚本：停止功能与 Goal 续跑联动（AC1）。
 *
 * 场景 A（修复前行为等价物）：active Goal 运行中，调用不带 stopGoal 的旧式
 * 会话级停止 —— Goal 保持 active，drain 循环在 turn 结束后立即 claim 下一轮，
 * 产生新的 Goal Runner 消息（即用户反馈的“停止后 goal 重复触发”）。
 *
 * 场景 B（修复后）：同样的停止携带 stopGoal=true —— stop 被接受的同一时刻
 * Goal 同步 paused，drain settle 后无任何新增 Goal Runner 消息。
 *
 * 运行：npm run build && node scripts/repro-stop-goal-linkage.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTurnOrchestrator } = require('../build/server/domain/conversation/turn-orchestrator');
const { getSessionGoal } = require('../build/server/domain/conversation/session-goal');

function waitForCondition(check, timeoutMs = 8000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      let passed = false;
      try {
        passed = Boolean(check());
      } catch (error) {
        reject(error);
        return;
      }
      if (passed) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error('Timed out waiting for condition'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function createHarness(label) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `caff-repro-stop-goal-${label}-`));
  const conversation = {
    id: `conversation-${label}`,
    title: label,
    type: 'standard',
    agents: [{ id: 'agent-owner', name: 'Owner' }],
    messages: [],
    metadata: {
      sessionGoal: {
        goalId: `goal-${label}`,
        objective: 'Reproduce stop/goal linkage',
        status: 'active',
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        owner: { agentId: 'agent-owner', agentName: 'Owner' },
        workItems: [],
        acceptanceCriteria: [],
        evidence: [],
      },
    },
  };
  let messageCounter = 0;
  const store = {
    getConversation: (id) => (id === conversation.id ? conversation : null),
    listConversations: () => [],
    createMessage(input) {
      messageCounter += 1;
      const message = { id: input.id || `m-${messageCounter}`, createdAt: new Date().toISOString(), ...input };
      conversation.messages.push(message);
      return message;
    },
    getMessage: (id) => conversation.messages.find((message) => message.id === id) || null,
    updateMessage(id, updates) {
      const index = conversation.messages.findIndex((message) => message.id === id);
      if (index >= 0) conversation.messages[index] = { ...conversation.messages[index], ...updates };
      return conversation.messages[index] || null;
    },
    updateConversation(id, updates) {
      if (updates && updates.metadata) conversation.metadata = updates.metadata;
      return conversation;
    },
  };

  // 每次执行阻塞 200ms，模拟进行中的回答；goal-runner 会在每轮结束后立即续派。
  const orchestrator = createTurnOrchestrator({
    store,
    skillRegistry: { listSkills: () => [], resolveSkills: () => [] },
    modeStore: { get: () => null },
    agentToolBridge: {},
    host: '127.0.0.1',
    port: 0,
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'repro.sqlite'),
    toolBaseUrl: 'http://127.0.0.1:0',
    agentToolScriptPath: path.join(tempDir, 'agent-chat-tools.js'),
    executeConversationAgent: async ({ turnState, completedReplies, agent }) => {
      turnState.runHandles.add({
        turnStageAgentId: agent.id,
        cancel() {},
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (turnState.stopRequested) {
        return { stopTurn: true, terminationReason: 'stopped_by_user' };
      }
      completedReplies.push({ agentId: agent.id, senderName: agent.name, content: 'ok', status: 'completed' });
      return { stopTurn: false, terminationReason: '' };
    },
    broadcastEvent() {},
  });

  const goalRunnerMessageCount = () =>
    conversation.messages.filter(
      (message) => message && message.metadata && message.metadata.source === 'goal-runner'
    ).length;

  return { orchestrator, conversation, goalRunnerMessageCount, tempDir };
}

async function startGoalTurn(harness) {
  // 走真实的 submitConversationMessage → drainConversationQueue 路径（goal-runner
  // 续派只发生在 drain 循环内）。Goal 处于 active，每轮结束后 drain 都会尝试续派。
  const result = harness.orchestrator.submitConversationMessage(harness.conversation.id, {
    content: '@Owner 推进目标',
  });
  assert.equal(result.dispatch, 'started');
  await waitForCondition(
    () => harness.orchestrator.listTurnSummaries({ conversationId: harness.conversation.id }).length === 1
  );
}

async function waitForDrainSettle(harness) {
  await waitForCondition(() => {
    const runtime = harness.orchestrator.buildRuntimePayload();
    const turns = harness.orchestrator.listTurnSummaries({ conversationId: harness.conversation.id });
    return turns.length === 0 && !(runtime.conversationQueueDepths && runtime.conversationQueueDepths[harness.conversation.id] > 0);
  });
  // 观察窗口：drain settle 后再等一拍，确认没有新的 goal-runner 派发。
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function scenarioA() {
  const harness = createHarness('legacy-stop');
  try {
    await startGoalTurn(harness);
    const before = harness.goalRunnerMessageCount();

    // 旧调用方：不带 stopGoal，行为必须保持不变（AC4）。
    harness.orchestrator.requestStopConversationExecution(harness.conversation.id, '用户停止（旧语义）');

    assert.equal(getSessionGoal(harness.conversation).status, 'active', 'A: legacy stop must not pause the goal');
    // 观察窗口：goal 仍 active，drain 循环会在每轮结束后立即 claim 下一轮。
    await new Promise((resolve) => setTimeout(resolve, 900));
    const after = harness.goalRunnerMessageCount();
    assert.ok(after > before, `A: expected the goal-runner to retrigger (before=${before}, after=${after})`);
    console.log(`场景 A（旧语义）：goal 保持 active，900ms 内 goal-runner 消息 ${before} -> ${after}（复现“停止后重复触发”）。`);
  } finally {
    try {
      harness.orchestrator.requestStopConversationExecution(harness.conversation.id, 'cleanup', { stopGoal: true });
    } catch {}
    // 等待进行中的 turn 收尾、sqlite run store 关闭后再清理临时目录。
    await new Promise((resolve) => setTimeout(resolve, 600));
    try {
      fs.rmSync(harness.tempDir, { recursive: true, force: true });
    } catch {}
  }
}

async function scenarioB() {
  const harness = createHarness('stop-goal');
  try {
    await startGoalTurn(harness);
    const before = harness.goalRunnerMessageCount();

    // 新语义：stop 被接受的同一时刻同步断言 goal=paused（无竞态窗口）。
    const result = harness.orchestrator.requestStopConversationExecution(harness.conversation.id, '用户停止', { stopGoal: true });
    assert.equal(result.goal && result.goal.status, 'paused', 'B: stop response must carry the paused goal');
    assert.equal(getSessionGoal(harness.conversation).status, 'paused', 'B: goal must be paused synchronously');

    await waitForDrainSettle(harness);
    const after = harness.goalRunnerMessageCount();
    assert.equal(after, before, `B: no new goal-runner message expected (before=${before}, after=${after})`);
    console.log(`场景 B（新语义）：stop 接受时 goal=paused（同步断言通过），观察窗口内 goal-runner 消息 ${before} -> ${after}（无重复派发）。`);
  } finally {
    try {
      fs.rmSync(harness.tempDir, { recursive: true, force: true });
    } catch {}
  }
}

(async () => {
  await scenarioA();
  await scenarioB();
  console.log('复现脚本通过：AC1 服务端断言成立。');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
