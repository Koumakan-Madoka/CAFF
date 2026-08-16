const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createDagScheduler } = require('../../build/server/domain/dag/dag-scheduler');
const {
  resolveDagWorktreePath,
  prepareNodeWorktree: libPrepareNodeWorktree,
} = require('../../build/lib/dag-worktree');
const { prepareMergeNodeWorktree, verifyMergeOutcome } = require('../../build/lib/dag-merge');
const { withTempDir } = require('../helpers/temp-dir');

/**
 * dag-execution PRD §5 六条验收基线的端到端回归。
 *
 * 与 dag-scheduler.test.js 的差异：本文件的 worktree / merge / verify 全部
 * 走真实 git（临时仓库），只有 spawn/resume 是 stub（agent 本体不参与）。
 * 基线 1（POC 四步 demo 回归）由 tests/ui/dag-planning-demo.test.js 覆盖。
 */

const ROOT_ID = 'root-conversation';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createFixture(t, prefix = 'caff-dag-baseline-') {
  const tempDir = withTempDir(prefix);
  const repoRoot = path.join(tempDir, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  git(['init', '-b', 'main'], repoRoot);
  git(['config', 'user.email', 'test@example.com'], repoRoot);
  git(['config', 'user.name', 'Test'], repoRoot);
  fs.writeFileSync(path.join(repoRoot, 'README.md'), 'hello\n');
  git(['add', 'README.md'], repoRoot);
  git(['commit', '-m', 'init'], repoRoot);

  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'chat.sqlite') });
  store.createConversation({ id: ROOT_ID, title: 'Root', participants: ['role-family-gpt'] });

  t.after(() => {
    try {
      store.close();
    } catch {}
    try {
      git(['worktree', 'prune'], repoRoot);
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { tempDir, repoRoot, store };
}

function createChildConversation(store, id) {
  return store.conversationRepository.create({
    id,
    title: `Child ${id}`,
    type: 'standard',
    metadataJson: '{}',
    parentConversationId: ROOT_ID,
    originConversationId: ROOT_ID,
    treeDepth: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function addMessage(store, payload) {
  return store.messageRepository.create({
    id: payload.id,
    conversationId: payload.conversationId,
    turnId: payload.turnId || `turn-${payload.id}`,
    role: payload.role || 'user',
    agentId: payload.agentId || null,
    senderName: payload.senderName || 'You',
    content: payload.content || '',
    status: payload.status || 'completed',
    errorMessage: payload.errorMessage || null,
    metadataJson: JSON.stringify(payload.metadata || {}),
    createdAt: payload.createdAt || new Date().toISOString(),
  });
}

function node(id, overrides = {}) {
  return {
    id,
    title: `Node ${id}`,
    goal: `goal of ${id}`,
    status: 'pending',
    depends_on: [],
    branch: `dag/${id}`,
    kind: 'work',
    ...overrides,
  };
}

function createActivePlan(store, nodes) {
  store.savePlanForConversation(ROOT_ID, { doc: { nodes } }, { actor: { type: 'user' } });
  return store.activatePlanForConversation(ROOT_ID, { type: 'user' }).plan;
}

/**
 * 复刻 create-server 的真实接线：work 节点走 prepareNodeWorktree，merge 节点
 * 走 prepareMergeNodeWorktree（D11 LCA 检出），完结校验走 verifyMergeOutcome
 * （D19 fail-closed），全部作用于真实临时 git 仓库。
 */
function realGitWiring(repoRoot) {
  return {
    prepareNodeWorktree({ plan, node: currentNode }) {
      if (String(currentNode.kind) === 'merge') {
        const nodeById = new Map(plan.doc.nodes.map((entry) => [entry.id, entry]));
        const upstreamBranches = (currentNode.depends_on || []).map((depId) => {
          const parent = nodeById.get(depId);
          return parent ? String(parent.branch || '').trim() : '';
        });
        if (upstreamBranches.some((branch) => !branch)) {
          return { ok: false, error: 'dag_merge_missing_upstream_branch' };
        }
        const result = prepareMergeNodeWorktree({
          repoRoot,
          planId: plan.id,
          node: {
            id: currentNode.id,
            branch: currentNode.branch,
            base_branch: currentNode.base_branch || undefined,
          },
          upstreamBranches,
        });
        return result.ok
          ? { ok: true, path: result.path, reused: Boolean(result.reused) }
          : { ok: false, error: `${result.code || 'dag_worktree_failed'}: ${result.reason || ''}` };
      }
      const result = libPrepareNodeWorktree({
        repoRoot,
        planId: plan.id,
        nodeId: currentNode.id,
        branch: currentNode.branch,
        baseRef: currentNode.base_branch || undefined,
      });
      return result.ok
        ? { ok: true, path: result.path, reused: Boolean(result.reused) }
        : { ok: false, error: `${result.code || 'dag_worktree_failed'}: ${result.error || result.reason || ''}` };
    },
    verifyNodeCompletion({ plan, node: currentNode }) {
      if (String(currentNode.kind) !== 'merge') {
        return { ok: true };
      }
      const worktreePath = resolveDagWorktreePath(repoRoot, plan.id, currentNode.id);
      if (!worktreePath || !fs.existsSync(worktreePath)) {
        return { ok: false, error: 'integration worktree missing after reported merge completion' };
      }
      const nodeById = new Map(plan.doc.nodes.map((entry) => [entry.id, entry]));
      const sourceBranches = (currentNode.depends_on || [])
        .map((depId) => {
          const parent = nodeById.get(depId);
          return parent ? String(parent.branch || '').trim() : '';
        })
        .filter(Boolean);
      const verdict = verifyMergeOutcome({
        worktreePath,
        sourceBranches,
        verifyCommand: currentNode.verify || undefined,
      });
      return verdict.ok ? { ok: true } : { ok: false, error: verdict.reason };
    },
  };
}

function createHarness(store, repoRoot, overrides = {}) {
  const spawns = [];
  const resumes = [];
  const scheduler = createDagScheduler({
    store,
    maxConcurrency: overrides.maxConcurrency || 3,
    logger: { error() {} },
    broadcastEvent() {},
    ...realGitWiring(repoRoot),
    async spawnNodeConversation(input) {
      const childId = `child-${input.node.id}-${spawns.length}`;
      createChildConversation(store, childId);
      const messageId = `bootstrap-${input.node.id}-${spawns.length}`;
      addMessage(store, {
        id: messageId,
        conversationId: childId,
        content: input.initialMessage,
        metadata: { kind: 'conversation_spawn_initial_message' },
      });
      spawns.push({ nodeId: input.node.id, conversationId: childId, bootstrapMessageId: messageId, initialMessage: input.initialMessage });
      return { conversationId: childId };
    },
    async resumeNodeConversation(input) {
      const messageId = `resume-${input.node.id}-${resumes.length}`;
      addMessage(store, {
        id: messageId,
        conversationId: input.conversation.id,
        content: input.content,
        metadata: { kind: 'dag_resume', dagResume: true, dagNodeId: input.node.id },
      });
      resumes.push({ nodeId: input.node.id, conversationId: input.conversation.id, messageId });
    },
  });
  return { scheduler, spawns, resumes };
}

function getNode(store, nodeId) {
  const { plan } = store.getPlanForConversation(ROOT_ID);
  return plan.doc.nodes.find((entry) => entry.id === nodeId);
}

function historyLines(store, nodeId) {
  const { plan } = store.getPlanForConversation(ROOT_ID);
  return (plan.doc.history || [])
    .filter((entry) => entry.node_id === nodeId)
    .map((entry) => `${entry.from}->${entry.to}:${entry.reason || ''}`);
}

function worktreeOf(repoRoot, store, nodeId) {
  const { plan } = store.getPlanForConversation(ROOT_ID);
  return resolveDagWorktreePath(repoRoot, plan.id, nodeId);
}

/** 模拟子会话 agent 在节点 worktree 里真实干活：写文件并提交到节点分支。 */
function agentCommit(worktreePath, filename, content) {
  fs.writeFileSync(path.join(worktreePath, filename), content);
  git(['add', filename], worktreePath);
  git(['commit', '-m', `add ${filename}`], worktreePath);
}

function lastSpawnFor(spawns, nodeId) {
  return spawns.filter((spawn) => spawn.nodeId === nodeId).pop();
}

test('基线 2+3+4：菱形 DAG 真实 git 全程（activate→派发→完结传播→LCA merge→verify→done）', async (t) => {
  const { repoRoot, store } = createFixture(t);
  const verifyCmd = 'node -e "const fs=require(\'node:fs\');fs.accessSync(\'f1.txt\');fs.accessSync(\'f2.txt\');fs.accessSync(\'f3.txt\')"';
  const plan = createActivePlan(store, [
    node('n1'),
    node('n2', { depends_on: ['n1'], base_branch: 'dag/n1' }),
    node('n3', { depends_on: ['n1'], base_branch: 'dag/n1' }),
    node('m1', { depends_on: ['n2', 'n3'], kind: 'merge', branch: 'dag/integrate', verify: verifyCmd }),
  ]);
  const { scheduler, spawns } = createHarness(store, repoRoot);

  // ── 基线 2：activate → 入度 0 节点自动 doing + 子会话创建 + goal 注入
  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await scheduler.dispatchReadyNodes(ROOT_ID);

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].nodeId, 'n1');
  assert.ok(spawns[0].initialMessage.includes('goal of n1'), 'goal injected into initial message');
  assert.equal(getNode(store, 'n1').status, 'doing');
  assert.equal(getNode(store, 'n1').spawned_conversation_id, spawns[0].conversationId);
  const n1Worktree = worktreeOf(repoRoot, store, 'n1');
  assert.ok(fs.existsSync(n1Worktree), 'D22: real worktree created on disk');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], n1Worktree), 'dag/n1');

  // n1 agent 真实产出：在 worktree 里提交 f1.txt，然后完结
  agentCommit(n1Worktree, 'f1.txt', 'from n1\n');
  scheduler.handleEvent('agent_slot_finished', {
    conversationId: spawns[0].conversationId,
    slot: { sourceMessageId: spawns[0].bootstrapMessageId, status: 'completed', finalContent: 'n1 产出：f1' },
  });
  await scheduler.dispatchReadyNodes(ROOT_ID);

  // ── 基线 3：完结 → done + result → 下游自动就绪（D23 上游 result 注入）
  assert.equal(getNode(store, 'n1').status, 'done');
  assert.equal(getNode(store, 'n1').result, 'n1 产出：f1');
  assert.equal(spawns.length, 3, 'n2 and n3 dispatched after n1 done');
  const n2Spawn = lastSpawnFor(spawns, 'n2');
  const n3Spawn = lastSpawnFor(spawns, 'n3');
  assert.ok(n2Spawn.initialMessage.includes('n1 产出：f1'), 'upstream result embedded (D23)');
  assert.ok(n3Spawn.initialMessage.includes('n1 产出：f1'));
  assert.equal(getNode(store, 'n2').status, 'doing');
  assert.equal(getNode(store, 'n3').status, 'doing');
  // base_branch 链接：n2/n3 的 worktree 从 dag/n1 的 tip 检出，自带 f1.txt
  const n2Worktree = worktreeOf(repoRoot, store, 'n2');
  const n3Worktree = worktreeOf(repoRoot, store, 'n3');
  assert.ok(fs.existsSync(path.join(n2Worktree, 'f1.txt')), 'n2 branched from dag/n1 tip (base_branch)');
  assert.ok(fs.existsSync(path.join(n3Worktree, 'f1.txt')), 'n3 branched from dag/n1 tip');
  assert.equal(getNode(store, 'm1').status, 'pending', 'merge waits for both upstreams');

  // n2/n3 各自真实产出并完结
  agentCommit(n2Worktree, 'f2.txt', 'from n2\n');
  scheduler.handleEvent('agent_slot_finished', {
    conversationId: n2Spawn.conversationId,
    slot: { sourceMessageId: n2Spawn.bootstrapMessageId, status: 'completed', finalContent: 'n2 done' },
  });
  await scheduler.dispatchReadyNodes(ROOT_ID);
  assert.equal(getNode(store, 'm1').status, 'pending', 'merge still waits for n3');

  agentCommit(n3Worktree, 'f3.txt', 'from n3\n');
  scheduler.handleEvent('agent_slot_finished', {
    conversationId: n3Spawn.conversationId,
    slot: { sourceMessageId: n3Spawn.bootstrapMessageId, status: 'completed', finalContent: 'n3 done' },
  });
  await scheduler.dispatchReadyNodes(ROOT_ID);

  // ── 基线 4：merge 节点真实 LCA 检出 + 逐条合并 + verify
  const m1Spawn = lastSpawnFor(spawns, 'm1');
  assert.ok(m1Spawn, 'merge node dispatched');
  assert.equal(getNode(store, 'm1').status, 'doing');
  const m1Worktree = worktreeOf(repoRoot, store, 'm1');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], m1Worktree), 'dag/integrate');
  // D11：集成分支从上游 LCA（= dag/n1 tip）检出，f1 在、f2/f3 尚未合入
  assert.ok(fs.existsSync(path.join(m1Worktree, 'f1.txt')), 'integration branch based on upstream LCA');
  assert.ok(!fs.existsSync(path.join(m1Worktree, 'f2.txt')), 'f2 not merged yet');
  assert.ok(m1Spawn.initialMessage.indexOf('n2 → dag/n2') < m1Spawn.initialMessage.indexOf('n3 → dag/n3'), 'D26: merge order follows depends_on');

  // 主理人 agent 逐条合并（D11）
  git(['merge', '--no-edit', 'dag/n2'], m1Worktree);
  git(['merge', '--no-edit', 'dag/n3'], m1Worktree);
  scheduler.handleEvent('agent_slot_finished', {
    conversationId: m1Spawn.conversationId,
    slot: { sourceMessageId: m1Spawn.bootstrapMessageId, status: 'completed', finalContent: '合并完成：n2+n3' },
  });
  await scheduler.dispatchReadyNodes(ROOT_ID);

  // verifyNodeCompletion（真实 verifyMergeOutcome）通过才允许 done
  assert.equal(getNode(store, 'm1').status, 'done');
  assert.equal(getNode(store, 'm1').result, '合并完成：n2+n3');
  for (const file of ['f1.txt', 'f2.txt', 'f3.txt']) {
    assert.ok(fs.existsSync(path.join(m1Worktree, file)), `${file} integrated`);
  }
  // D11 fail-closed 的另一面：两条源分支都必须是集成 HEAD 的祖先
  // （git merge-base --is-ancestor 命中时 exit 0，不命中 execFileSync 抛错）
  git(['merge-base', '--is-ancestor', 'dag/n2', 'dag/integrate'], repoRoot);
  git(['merge-base', '--is-ancestor', 'dag/n3', 'dag/integrate'], repoRoot);
  assert.ok(git(['rev-parse', 'dag/integrate'], repoRoot), 'integration branch tip resolves');

  // D18：全链路 history 审计完整
  assert.deepEqual(historyLines(store, 'n1'), [
    'pending->doing:dag_dispatch',
    'doing->done:dag_node_completed',
  ]);
  assert.deepEqual(historyLines(store, 'm1'), [
    'pending->doing:dag_dispatch',
    'doing->done:dag_node_completed',
  ]);
});

test('基线 5：失败 → blocked 回写原因 → D16 拒绝下游 → 人工解除 → 重派成功', async (t) => {
  const { repoRoot, store } = createFixture(t);
  const plan = createActivePlan(store, [
    node('a1'),
    node('a2', { depends_on: ['a1'], base_branch: 'dag/a1' }),
  ]);
  const { scheduler, spawns } = createHarness(store, repoRoot);

  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await scheduler.dispatchReadyNodes(ROOT_ID);
  assert.equal(getNode(store, 'a1').status, 'doing');

  // a1 失败 → blocked + 原因落 history
  scheduler.handleEvent('agent_slot_finished', {
    conversationId: spawns[0].conversationId,
    slot: { sourceMessageId: spawns[0].bootstrapMessageId, status: 'failed', errorMessage: '测试失败：断言不通过' },
  });
  await scheduler.dispatchReadyNodes(ROOT_ID);

  assert.equal(getNode(store, 'a1').status, 'blocked');
  const blockedLine = historyLines(store, 'a1').find((line) => line.startsWith('doing->blocked:'));
  assert.ok(blockedLine && blockedLine.includes('测试失败'), `blocked reason recorded: ${blockedLine}`);
  assert.equal(getNode(store, 'a2').status, 'pending', 'D16 fail-closed: downstream stays pending');

  // D16：blocked 期间用户强推下游 pending→doing 必须被拒
  const { plan: current } = store.getPlanForConversation(ROOT_ID);
  const forcedDoc = JSON.parse(JSON.stringify(current.doc));
  forcedDoc.nodes.find((entry) => entry.id === 'a2').status = 'doing';
  assert.throws(
    () => store.savePlanForConversation(ROOT_ID, { doc: forcedDoc, version: current.version }, { actor: { type: 'user' } }),
    (error) => error && error.code === 'plan_upstream_blocked',
  );

  // 人工解除：用户把 a1 blocked→pending，调度器重派（幂等键复用，不重复建会话语义由真实通道保证）
  const { plan: blockedPlan } = store.getPlanForConversation(ROOT_ID);
  const unblockDoc = JSON.parse(JSON.stringify(blockedPlan.doc));
  unblockDoc.nodes.find((entry) => entry.id === 'a1').status = 'pending';
  const unblocked = store.savePlanForConversation(
    ROOT_ID,
    { doc: unblockDoc, version: blockedPlan.version },
    { actor: { type: 'user' } },
  );
  scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan: unblocked.plan });
  await scheduler.dispatchReadyNodes(ROOT_ID);

  assert.equal(getNode(store, 'a1').status, 'doing', 'redispatched after manual unblock');
  const retrySpawn = lastSpawnFor(spawns, 'a1');
  assert.ok(retrySpawn, 'a1 respawned');

  // 重试成功 → done → a2 自动就绪
  scheduler.handleEvent('agent_slot_finished', {
    conversationId: retrySpawn.conversationId,
    slot: { sourceMessageId: retrySpawn.bootstrapMessageId, status: 'completed', finalContent: 'a1 重试成功' },
  });
  await scheduler.dispatchReadyNodes(ROOT_ID);
  assert.equal(getNode(store, 'a1').status, 'done');
  assert.equal(getNode(store, 'a2').status, 'doing', 'downstream dispatched after unblock+retry');
});

test('基线 6：server 重启 reconcile——down 期间完结的回写传播，中断的向原会话恢复一次（D25）', async (t) => {
  const { repoRoot, store } = createFixture(t);
  const plan = createActivePlan(store, [
    node('r1'),
    node('r2', { depends_on: ['r1'], base_branch: 'dag/r1' }),
    node('r3'),
  ]);
  const first = createHarness(store, repoRoot);

  first.scheduler.handleEvent('conversation_plan_updated', { ownerConversationId: ROOT_ID, plan });
  await first.scheduler.dispatchReadyNodes(ROOT_ID);
  assert.equal(getNode(store, 'r1').status, 'doing');
  assert.equal(getNode(store, 'r3').status, 'doing');
  const r1Spawn = lastSpawnFor(first.spawns, 'r1');
  const r3Spawn = lastSpawnFor(first.spawns, 'r3');

  // 模拟 server 停机：r3 的子会话在停机期间完结（终态回复已落库），r1 被中断（无回复）
  addMessage(store, {
    id: 'reply-r3',
    conversationId: r3Spawn.conversationId,
    role: 'assistant',
    agentId: 'role-family-gpt',
    content: 'r3 在重启前已完成',
    status: 'completed',
    metadata: { triggeredByMessageId: r3Spawn.bootstrapMessageId },
  });

  // 重启：新调度器实例 + reconcileOnStartup
  const second = createHarness(store, repoRoot);
  await second.scheduler.reconcileOnStartup();

  // 完结的 r3 回写 done + result；中断的 r1 向原子会话注入一次恢复
  assert.equal(getNode(store, 'r3').status, 'done');
  assert.equal(getNode(store, 'r3').result, 'r3 在重启前已完成');
  assert.equal(second.resumes.length, 1, 'r1 resumed exactly once');
  assert.equal(second.resumes[0].nodeId, 'r1');
  assert.equal(second.resumes[0].conversationId, r1Spawn.conversationId, 'resume targets the ORIGINAL child conversation');
  assert.equal(getNode(store, 'r1').status, 'doing', 'resumed node stays doing');
  assert.equal(getNode(store, 'r2').status, 'pending');

  // 恢复后 r1 的 agent 完结（回复由 resume 消息触发）→ done → r2 就绪
  addMessage(store, {
    id: 'reply-r1',
    conversationId: r1Spawn.conversationId,
    role: 'assistant',
    agentId: 'role-family-gpt',
    content: 'r1 恢复后完成',
    status: 'completed',
    metadata: { triggeredByMessageId: second.resumes[0].messageId },
  });
  second.scheduler.handleEvent('agent_slot_finished', {
    conversationId: r1Spawn.conversationId,
    slot: { sourceMessageId: second.resumes[0].messageId, status: 'completed', finalContent: 'r1 恢复后完成' },
  });
  await second.scheduler.dispatchReadyNodes(ROOT_ID);

  assert.equal(getNode(store, 'r1').status, 'done');
  assert.equal(getNode(store, 'r2').status, 'doing', 'downstream dispatched after reconcile+resume completes');
  assert.deepEqual(historyLines(store, 'r1'), [
    'pending->doing:dag_dispatch',
    'doing->done:dag_node_completed',
  ]);
});
