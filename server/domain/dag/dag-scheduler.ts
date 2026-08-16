/**
 * DAG execution scheduler (第二阶段, PRD .trellis/tasks/dag-execution/prd.md).
 *
 * Event-hook driven (D21 — no polling, no watcher process):
 * - `handleEvent('conversation_plan_updated', …)` → readiness dispatch:
 *   pending nodes whose depends_on are all done get started (pending→doing),
 *   one git worktree per node (D22), one spawned child conversation per node
 *   (D13 flat under the root conversation), goal + upstream result summaries
 *   injected as the initial instruction (D23).
 * - `handleEvent('agent_slot_finished', …)` → completion write-back: the
 *   spawned conversation's terminal slot flips the node to done (with a
 *   ≤2000-char result summary) or blocked (with the failure reason), then
 *   readiness dispatch runs again so downstream nodes start (D16-consistent:
 *   a blocked upstream never lets downstream start). Merge nodes additionally
 *   pass through the `verifyNodeCompletion` hook (D11/D19 fail-closed): every
 *   source branch must be merged and the verify command must pass, otherwise
 *   the completion becomes blocked with the verification reason.
 * - `reconcileOnStartup()` → D25: re-scan active plans after a server
 *   restart; finished children are written back, interrupted children get ONE
 *   automatic resume injection into the original conversation (marker
 *   message metadata.dagResume is the durable attempt counter), nodes whose
 *   resume budget is spent flip to blocked with the reason.
 *
 * Concurrency: at most `maxConcurrency` nodes doing at once (D24, default 3,
 * env CAFF_DAG_MAX_CONCURRENCY); surplus ready nodes stay pending and are
 * filled FIFO in doc.nodes declaration order when a slot frees.
 *
 * All plan mutations go through store.writePlanNodeExecution (the internal
 * system-actor channel): version-guarded, D16-checked, history-audited.
 * Mutations for one plan owner are serialized on a per-owner promise chain;
 * events re-entering while we write (our own broadcasts included) simply
 * re-run an idempotent dispatch pass that converges because each pass
 * strictly reduces the number of startable nodes.
 */

const DAG_RESUME_SENDER_NAME = 'DAG Scheduler';

function clipText(value: any, maxLength: number): string {
  const text = String(value || '');
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function nodeStatusOf(node: any): string {
  const status = node && node.status;
  return ['pending', 'doing', 'done', 'blocked'].includes(status) ? status : 'pending';
}

function nodeDepsOf(node: any): string[] {
  return Array.isArray(node && node.depends_on)
    ? node.depends_on.map((dep: any) => String(dep || '').trim()).filter(Boolean)
    : [];
}

/** True when the message was injected by the scheduler (bootstrap/resume). */
function isDagSourceMessage(message: any): boolean {
  const metadata = message && message.metadata && typeof message.metadata === 'object'
    ? message.metadata
    : null;
  if (!metadata) {
    return false;
  }
  return metadata.kind === 'conversation_spawn_initial_message' || metadata.dagResume === true;
}

function isTerminalMessage(message: any): boolean {
  const status = String(message && message.status || '').trim();
  return status === 'completed' || status === 'failed';
}

export function createDagScheduler(options: any = {}) {
  const store = options.store;
  const broadcastEvent = typeof options.broadcastEvent === 'function' ? options.broadcastEvent : () => {};
  const spawnNodeConversation = typeof options.spawnNodeConversation === 'function'
    ? options.spawnNodeConversation
    : null;
  const resumeNodeConversation = typeof options.resumeNodeConversation === 'function'
    ? options.resumeNodeConversation
    : null;
  const prepareNodeWorktreeForNode = typeof options.prepareNodeWorktree === 'function'
    ? options.prepareNodeWorktree
    : () => ({ ok: true });
  // Merge-node post-check (D11/D19 fail-closed): called before a merge node
  // may flip to done; { ok: false, error } turns the completion into blocked.
  const verifyNodeCompletion = typeof options.verifyNodeCompletion === 'function'
    ? options.verifyNodeCompletion
    : null;
  const logger = options.logger || console;
  const maxConcurrency = Number.isInteger(options.maxConcurrency) && options.maxConcurrency > 0
    ? options.maxConcurrency
    : Math.max(1, Number.parseInt(String(process.env.CAFF_DAG_MAX_CONCURRENCY || '3'), 10) || 3);

  if (!store) {
    throw new Error('DAG scheduler requires a chat store');
  }

  // Per-owner serialization: all mutations of one plan chain onto this map.
  const ownerChains = new Map<string, Promise<void>>();

  function logError(scope: string, error: any) {
    try {
      logger.error(`[dag-scheduler] ${scope}: ${error && error.stack ? error.stack : error}`);
    } catch {}
  }

  function enqueueForOwner(ownerConversationId: string, task: () => Promise<void> | void): Promise<void> {
    const key = String(ownerConversationId || '').trim();
    if (!key) {
      return Promise.resolve();
    }
    const previous = ownerChains.get(key) || Promise.resolve();
    const next = previous.then(() => Promise.resolve().then(task)).catch((error) => {
      logError(`owner ${key} task failed`, error);
    });
    ownerChains.set(key, next);
    // Avoid unbounded map growth: drop settled tail entries.
    void next.then(() => {
      if (ownerChains.get(key) === next) {
        ownerChains.delete(key);
      }
    });
    return next;
  }

  function getActivePlanForOwner(ownerConversationId: string) {
    const result = store.getPlanForConversation(ownerConversationId);
    const plan = result && result.plan ? result.plan : null;
    if (!plan || plan.status !== 'active') {
      return null;
    }
    return { ownerConversationId: result.ownerConversationId, plan };
  }

  function nodesOf(plan: any): any[] {
    return plan && plan.doc && Array.isArray(plan.doc.nodes) ? plan.doc.nodes : [];
  }

  function findReadyNode(plan: any): any {
    const nodes = nodesOf(plan);
    const statusById = new Map<string, string>();
    for (const node of nodes) {
      statusById.set(String(node && node.id || '').trim(), nodeStatusOf(node));
    }
    const doingCount = nodes.filter((node: any) => nodeStatusOf(node) === 'doing').length;
    if (doingCount >= maxConcurrency) {
      return null;
    }
    for (const node of nodes) {
      if (nodeStatusOf(node) !== 'pending') {
        continue;
      }
      const deps = nodeDepsOf(node);
      const allDepsDone = deps.every((depId) => statusById.get(depId) === 'done');
      if (allDepsDone) {
        return node;
      }
    }
    return null;
  }

  function buildInitialInstruction(plan: any, node: any, worktreePath: string): string {
    const nodes = nodesOf(plan);
    const nodeById = new Map<string, any>();
    for (const candidate of nodes) {
      nodeById.set(String(candidate && candidate.id || '').trim(), candidate);
    }
    const deps = nodeDepsOf(node);
    const upstreamLines = deps.map((depId) => {
      const parent = nodeById.get(depId);
      const summary = parent && typeof parent.result === 'string' && parent.result.trim()
        ? parent.result.trim()
        : '(无摘要)';
      return `- ${depId}（${parent && parent.title ? parent.title : depId}）：${summary}`;
    });

    if (node.kind === 'merge') {
      // D26: merger agent environment — branch order, verify command, D12 flow.
      const sourceBranches = deps.map((depId) => {
        const parent = nodeById.get(depId);
        return parent && parent.branch ? `${depId} → ${parent.branch}` : `${depId} → (未声明分支)`;
      });
      const verifyLine = node.verify
        ? `每合并完一条源分支以及全部合并完成后，各运行一次 verify 命令：\`${node.verify}\``
        : '本节点未配置 verify 命令；合并后请自行做基本健全性检查。';
      return [
        `[DAG 合并节点任务] 节点 ${node.id}：${node.title || node.id}`,
        `目标（集成分支）：${node.branch || '(未声明)'}`,
        worktreePath ? `工作目录已检出到集成分支的专属 worktree：${worktreePath}（请在该目录内执行 git 操作）` : '',
        '',
        '请按 depends_on 声明顺序逐条合并以下上游分支（不做章鱼合并，D11）：',
        ...sourceBranches.map((line) => `- ${line}`),
        '',
        verifyLine,
        '',
        '冲突处理流程（D10/D12）：发生冲突时由你解决；同一源分支合并失败可有界重试（≤3 次，可先 merge --abort 再重来）；',
        '仍失败则停止并在回复中说明原因，调度器会把节点置为 blocked 并回写原因。',
        '完成后请输出简短的合并结果摘要（将回写为节点 result）。',
      ].filter(Boolean).join('\n');
    }

    return [
      `[DAG 节点任务] 节点 ${node.id}：${node.title || node.id}`,
      `目标：${node.goal || '(未填写)'}`,
      node.branch ? `分支：${node.branch}` : '',
      worktreePath ? `工作目录已检出到该分支的专属 worktree：${worktreePath}（请在该目录内工作）` : '',
      '',
      upstreamLines.length > 0 ? '上游节点执行结果：' : '本节点无上游依赖。',
      ...upstreamLines,
      '',
      '完成后请输出简短的执行结果摘要（将回写为节点 result，供下游节点消费）。',
    ].filter((line) => line !== '').join('\n');
  }

  function broadcastPlanUpdated(ownerConversationId: string, plan: any) {
    broadcastEvent('conversation_plan_updated', {
      conversationId: ownerConversationId,
      ownerConversationId,
      plan,
    });
  }

  /**
   * Terminal assistant reply triggered by a scheduler-injected source
   * message (bootstrap or resume), if any. Stray replies not attributable
   * to a DAG source message never settle a node.
   */
  function findTerminalDagReply(conversation: any): { kind: 'completed' | 'failed'; message: any } | null {
    const messages = conversation && Array.isArray(conversation.messages) ? conversation.messages : [];
    const dagSourceMessageIds = new Set(
      messages.filter(isDagSourceMessage).map((message: any) => String(message.id || '').trim())
    );
    const terminalReplies = messages.filter((message: any) =>
      message && message.role === 'assistant' && isTerminalMessage(message)
      && dagSourceMessageIds.has(String(message.metadata && message.metadata.triggeredByMessageId || '').trim()));
    const completedReply = terminalReplies.filter((message: any) => message.status === 'completed').pop();
    if (completedReply) {
      return { kind: 'completed', message: completedReply };
    }
    const failedReply = terminalReplies.filter((message: any) => message.status === 'failed').pop();
    if (failedReply) {
      return { kind: 'failed', message: failedReply };
    }
    return null;
  }

  /** done write-back, guarded by the merge-outcome check for merge nodes. */
  function settleCompleted(ownerConversationId: string, plan: any, node: any, resultText: string, reason: string): void {
    const nodeId = String(node && node.id || '').trim();
    if (String(node && node.kind || '') === 'merge' && verifyNodeCompletion) {
      let verdict: any = null;
      try {
        verdict = verifyNodeCompletion({ ownerConversationId, plan, node });
      } catch (error: any) {
        verdict = { ok: false, error: error && error.message ? error.message : String(error) };
      }
      if (verdict && verdict.ok === false) {
        writeExecution(
          ownerConversationId,
          [{ nodeId, status: 'blocked' }],
          `dag_merge_verify_failed: ${clipText(verdict.error || 'merge outcome verification failed', 500)}`
        );
        return;
      }
    }
    writeExecution(ownerConversationId, [{ nodeId, status: 'done', result: resultText }], reason);
  }

  /** Write back a terminal child state: done+result or blocked+reason (D23/D18). */
  function settleTerminalReply(ownerConversationId: string, plan: any, node: any, terminal: { kind: string; message: any }, reasonPrefix: string): void {
    if (terminal.kind === 'completed') {
      settleCompleted(
        ownerConversationId,
        plan,
        node,
        clipText(String(terminal.message.content || '').trim() || '(no textual result)', 2000),
        `${reasonPrefix}_completed`
      );
      return;
    }
    writeExecution(
      ownerConversationId,
      [{ nodeId: String(node && node.id || '').trim(), status: 'blocked' }],
      `${reasonPrefix}_failed: ${clipText(terminal.message.errorMessage || 'spawned conversation turn failed', 500)}`
    );
  }

  /** One write with bounded version-conflict retry (re-reads between tries). */
  function writeExecution(ownerConversationId: string, updates: any[], reason: string) {
    const result = store.writePlanNodeExecution(ownerConversationId, updates, { reason });
    broadcastPlanUpdated(result.ownerConversationId, result.plan);
    return result;
  }

  async function dispatchOneNode(ownerConversationId: string): Promise<boolean> {
    const current = getActivePlanForOwner(ownerConversationId);
    if (!current) {
      return false;
    }
    const node = findReadyNode(current.plan);
    if (!node) {
      return false;
    }
    const nodeId = String(node.id || '').trim();

    // D22: one worktree per node; a dirty/invalid worktree fails closed.
    const prepared = prepareNodeWorktreeForNode({
      plan: current.plan,
      node,
      ownerConversationId,
    });
    if (!prepared || prepared.ok !== true) {
      const detail = prepared && prepared.error ? String(prepared.error) : 'worktree prepare failed';
      writeExecution(ownerConversationId, [{ nodeId, status: 'blocked' }], `dag_worktree_failed: ${clipText(detail, 500)}`);
      return true;
    }

    // D13: spawn the child conversation flat under the root. The idempotency
    // key embeds activatedAt so crash-retries within one activation reuse the
    // canonical conversation while a re-activation spawns afresh.
    const clientRequestId = `dag-node:${current.plan.id}:${nodeId}:${current.plan.activatedAt || 'na'}`;
    let spawned: any = null;
    try {
      spawned = await spawnNodeConversation({
        ownerConversationId,
        plan: current.plan,
        node,
        initialMessage: buildInitialInstruction(current.plan, node, String(prepared.path || '')),
        clientRequestId,
      });
    } catch (error: any) {
      writeExecution(
        ownerConversationId,
        [{ nodeId, status: 'blocked' }],
        `dag_spawn_failed: ${clipText(error && error.message ? error.message : error, 500)}`
      );
      return true;
    }

    const spawnedConversationId = String(spawned && spawned.conversationId || '').trim();
    if (!spawnedConversationId) {
      writeExecution(ownerConversationId, [{ nodeId, status: 'blocked' }], 'dag_spawn_failed: empty conversation id');
      return true;
    }

    writeExecution(
      ownerConversationId,
      [{ nodeId, status: 'doing', spawnedConversationId }],
      'dag_dispatch'
    );

    // Close the spawn→bind race: if the child already produced a terminal
    // reply before the doing binding landed (extremely fast executor, or a
    // crash-restart re-dispatch that reused the idempotent child), its
    // agent_slot_finished event has already fired and will never re-fire —
    // settle immediately instead of leaving the node doing forever.
    try {
      const spawnedConversation = store.getConversation(spawnedConversationId);
      const terminal = spawnedConversation ? findTerminalDagReply(spawnedConversation) : null;
      if (terminal) {
        settleTerminalReply(ownerConversationId, current.plan, node, terminal, 'dag_dispatch_settled');
      }
    } catch (settleError) {
      logError(`post-bind settle failed for node ${nodeId}`, settleError);
    }
    return true;
  }

  /** Fill free concurrency slots with ready nodes (D24 FIFO in doc order). */
  async function dispatchReadyNodes(ownerConversationId: string): Promise<void> {
    // Each iteration starts at most one node; the loop re-reads the plan so a
    // version conflict in one write never wedges the queue — it just retries.
    for (let attempts = 0; attempts < 64; attempts += 1) {
      let progressed = false;
      try {
        progressed = await dispatchOneNode(ownerConversationId);
      } catch (error: any) {
        if (error && error.code === 'plan_version_conflict') {
          continue; // someone else wrote; re-read and retry
        }
        throw error;
      }
      if (!progressed) {
        return;
      }
    }
  }

  /**
   * Completion write-back: match the finished side-dispatch slot to a doing
   * node via its spawned conversation, then flip done/blocked and re-dispatch.
   */
  async function completeNodeFromSlot(conversationId: string, slot: any): Promise<void> {
    const normalizedConversationId = String(conversationId || '').trim();
    if (!normalizedConversationId) {
      return;
    }

    let ownerResult: any = null;
    try {
      ownerResult = store.getPlanForConversation(normalizedConversationId);
    } catch {
      return; // conversation unknown to the plan subsystem
    }
    const plan = ownerResult && ownerResult.plan ? ownerResult.plan : null;
    if (!plan || plan.status !== 'active') {
      return;
    }
    const ownerConversationId = ownerResult.ownerConversationId;

    const node = nodesOf(plan).find((candidate: any) =>
      nodeStatusOf(candidate) === 'doing'
      && String(candidate.spawned_conversation_id || '').trim() === normalizedConversationId);
    if (!node) {
      return;
    }
    const nodeId = String(node.id || '').trim();

    // Only scheduler-injected source messages (bootstrap/resume) may complete
    // a node — stray side dispatches into the child conversation are ignored.
    const conversation = store.getConversation(normalizedConversationId);
    const messages = conversation && Array.isArray(conversation.messages) ? conversation.messages : [];
    const dagSourceMessageIds = new Set(
      messages.filter(isDagSourceMessage).map((message: any) => String(message.id || '').trim())
    );
    const slotSourceMessageId = String(slot && slot.sourceMessageId || '').trim();
    if (!slotSourceMessageId || !dagSourceMessageIds.has(slotSourceMessageId)) {
      return;
    }

    await enqueueForOwner(ownerConversationId, async () => {
      const slotStatus = String(slot && slot.status || '').trim();
      if (slotStatus === 'completed') {
        const fallbackReply = messages
          .filter((message: any) => message && message.role === 'assistant' && isTerminalMessage(message)
            && dagSourceMessageIds.has(String(message.metadata && message.metadata.triggeredByMessageId || '').trim()))
          .pop();
        const resultText = clipText(
          (slot.finalContent && String(slot.finalContent).trim())
            || (fallbackReply && String(fallbackReply.content || '').trim())
            || '(no textual result)',
          2000
        );
        settleCompleted(ownerConversationId, plan, node, resultText, 'dag_node_completed');
      } else {
        const reason = (slot.errorMessage && String(slot.errorMessage).trim())
          || `spawned conversation slot ${slotStatus || 'failed'}`;
        writeExecution(
          ownerConversationId,
          [{ nodeId, status: 'blocked' }],
          `dag_node_failed: ${clipText(reason, 500)}`
        );
      }
      await dispatchReadyNodes(ownerConversationId);
    });
  }

  /** D25: one automatic resume into the ORIGINAL child conversation. */
  async function resumeDoingNode(ownerConversationId: string, plan: any, node: any, conversation: any) {
    const nodeId = String(node.id || '').trim();
    const content = [
      `[DAG 恢复指令] 节点 ${nodeId}：${node.title || nodeId}`,
      'server 重启导致本次执行被中断。请基于当前 worktree 与对话上下文继续完成节点目标：',
      `目标：${node.goal || '(未填写)'}`,
      '完成后请输出简短的执行结果摘要。',
    ].join('\n');
    await resumeNodeConversation({
      ownerConversationId,
      plan,
      node,
      conversation,
      content,
      idempotencyKey: `dag-resume:${plan.id}:${nodeId}:${plan.activatedAt || 'na'}`,
    });
  }

  async function reconcilePlan(ownerConversationId: string): Promise<void> {
    const current = getActivePlanForOwner(ownerConversationId);
    if (!current) {
      return;
    }
    const { plan } = current;

    for (const node of nodesOf(plan)) {
      if (nodeStatusOf(node) !== 'doing') {
        continue;
      }
      const nodeId = String(node.id || '').trim();
      const spawnedConversationId = String(node.spawned_conversation_id || '').trim();

      if (!spawnedConversationId) {
        // doing without a child can only come from a manual status flip or a
        // torn write — fail closed and make it visible.
        writeExecution(ownerConversationId, [{ nodeId, status: 'blocked' }], 'dag_reconcile_orphan_doing: doing node has no spawned conversation after restart');
        continue;
      }

      const conversation = store.getConversation(spawnedConversationId);
      if (!conversation) {
        writeExecution(ownerConversationId, [{ nodeId, status: 'blocked' }], 'dag_reconcile_missing_conversation: spawned conversation not found');
        continue;
      }

      const terminal = findTerminalDagReply(conversation);
      if (terminal) {
        settleTerminalReply(ownerConversationId, plan, node, terminal, 'dag_reconcile');
        continue;
      }

      // No terminal reply. If the delivery worker still has an in-flight or
      // queued delivery for this conversation, it owns the dispatch — skip.
      if (typeof store.hasNonTerminalCrossConversationDelivery === 'function'
        && store.hasNonTerminalCrossConversationDelivery(spawnedConversationId)) {
        continue;
      }

      // D25: exactly one automatic resume, counted durably by the marker
      // message (metadata.dagResume) inside the child conversation.
      const conversationMessages = Array.isArray(conversation.messages) ? conversation.messages : [];
      const resumeAttempts = conversationMessages.filter((message: any) =>
        message && message.metadata && typeof message.metadata === 'object'
        && message.metadata.dagResume === true).length;
      if (resumeAttempts >= 1) {
        writeExecution(
          ownerConversationId,
          [{ nodeId, status: 'blocked' }],
          'dag_reconcile_resume_exhausted: server 重启中断，自动恢复已耗尽（D25）'
        );
        continue;
      }
      try {
        await resumeDoingNode(ownerConversationId, plan, node, conversation);
      } catch (error: any) {
        writeExecution(
          ownerConversationId,
          [{ nodeId, status: 'blocked' }],
          `dag_reconcile_resume_failed: ${clipText(error && error.message ? error.message : error, 500)}`
        );
      }
    }

    await dispatchReadyNodes(ownerConversationId);
  }

  function handleEvent(eventName: string, payload: any): void {
    try {
      if (eventName === 'conversation_plan_updated') {
        const ownerConversationId = String(payload && payload.ownerConversationId || '').trim();
        const plan = payload && payload.plan ? payload.plan : null;
        if (!ownerConversationId || !plan || plan.status !== 'active') {
          return;
        }
        void enqueueForOwner(ownerConversationId, () => dispatchReadyNodes(ownerConversationId));
        return;
      }
      if (eventName === 'agent_slot_finished') {
        const conversationId = String(payload && payload.conversationId || '').trim();
        void completeNodeFromSlot(conversationId, payload && payload.slot ? payload.slot : {}).catch((error) => {
          logError('agent_slot_finished handling failed', error);
        });
      }
    } catch (error) {
      logError(`handleEvent(${eventName}) failed`, error);
    }
  }

  async function reconcileOnStartup(): Promise<void> {
    const activePlans = typeof store.listActivePlans === 'function' ? store.listActivePlans() : [];
    for (const plan of activePlans) {
      const ownerConversationId = String(plan && plan.ownerConversationId || '').trim();
      if (!ownerConversationId) {
        continue;
      }
      await enqueueForOwner(ownerConversationId, () => reconcilePlan(ownerConversationId));
    }
  }

  /**
   * D22 cwd hook: when a conversation is a DAG node child with a prepared
   * worktree, resolve its working directory to that worktree; null otherwise
   * (caller falls back to the active project dir).
   */
  function resolveConversationWorkdir(conversation: any): string | null {
    const conversationId = String(conversation && conversation.id || '').trim();
    if (!conversationId || typeof options.resolveWorktreePathForNode !== 'function') {
      return null;
    }
    let ownerResult: any = null;
    try {
      ownerResult = store.getPlanForConversation(conversationId);
    } catch {
      return null;
    }
    const plan = ownerResult && ownerResult.plan ? ownerResult.plan : null;
    if (!plan || !ownerResult.ownerConversationId || ownerResult.ownerConversationId === conversationId) {
      return null;
    }
    const node = nodesOf(plan).find((candidate: any) =>
      String(candidate && candidate.spawned_conversation_id || '').trim() === conversationId);
    if (!node) {
      return null;
    }
    return options.resolveWorktreePathForNode({ plan, node, ownerConversationId: ownerResult.ownerConversationId }) || null;
  }

  return {
    handleEvent,
    reconcileOnStartup,
    resolveConversationWorkdir,
    // exposed for tests
    dispatchReadyNodes: (ownerConversationId: string) =>
      enqueueForOwner(ownerConversationId, () => dispatchReadyNodes(ownerConversationId)),
    maxConcurrency,
  };
}
