/**
 * DAG execution scheduler (第二阶段, PRD .trellis/tasks/dag-execution/prd.md).
 *
 * Event-hook driven (D21 — no polling, no watcher process):
 * - `handleEvent('conversation_plan_updated', …)` → readiness dispatch:
 *   pending nodes whose depends_on are all done get started (pending→doing),
 *   one git worktree per node (D22), one spawned child conversation per node
 *   (D13 flat under the root conversation), goal + upstream result summaries
 *   injected as the initial instruction (D23).
 * - `handleEvent('agent_slot_finished', …)` → failure write-back and
 *   goal-aware settle: a finished turn no longer completes the node (D27) —
 *   it only settles when the child's session goal already reached a terminal
 *   or verifiable state; slot failures still flip the node to blocked.
 * - `handleEvent('conversation_goal_proposal_updated'/'_cleared', …)` →
 *   D27/D28 completion flow: the worker announces completion via a goal
 *   complete proposal; the scheduler routes it to the node's verifier agent
 *   (targeted delivery into the same child conversation) or auto-accepts
 *   when the node has no verifier; verifier accept → done + result, reject →
 *   feedback delivered back to the worker (unbounded, goal budget-backed);
 *   a goal-runner budget pause proposal flips the node to blocked.
 *   done write-backs carry a ≤2000-char result summary (D23) and trigger
 *   readiness dispatch so downstream nodes start (D16-consistent: a blocked
 *   upstream never lets downstream start). Merge nodes additionally pass
 *   through the `verifyNodeCompletion` hook (D11/D19 fail-closed) even after
 *   acceptance.
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

import {
  applySessionGoalAction,
  getSessionGoal,
  getSessionGoalProposal,
} from '../conversation/session-goal';
import { ensureDagNodeGoalBinding, getDagNodeGoalBinding } from '../conversation/dag-goal-binding';

/**
 * D28 verifier resolution. The worker is always the owner conversation's
 * first participant agent (spawn copies participants and dispatches to the
 * primary). Explicit node.verifier must be a participant and must differ
 * from the worker (no self-review); when omitted, the first participant
 * other than the worker verifies; a single-agent owner means no verifier
 * (the scheduler auto-accepts the completion proposal instead).
 */
function resolveNodeVerifier(node: any, participantIds: string[]): { verifierId: string | null; error: string | null } {
  const workerId = String(participantIds[0] || '').trim();
  const explicit = String(node && node.verifier || '').trim();
  if (explicit) {
    if (!participantIds.includes(explicit)) {
      return { verifierId: null, error: `dag_verifier_invalid: verifier "${explicit}" is not a participant agent of the owner conversation` };
    }
    if (explicit === workerId) {
      return { verifierId: null, error: `dag_verifier_self_review: verifier "${explicit}" is the executing agent; a node cannot verify its own work (no self-review)` };
    }
    return { verifierId: explicit, error: null };
  }
  const fallback = participantIds.find((id) => id && id !== workerId);
  return { verifierId: fallback || null, error: null };
}

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

/** Participant agent ids of a conversation, in declaration order. */
function participantIdsOf(conversation: any): string[] {
  const agents = conversation && Array.isArray(conversation.agents) ? conversation.agents : [];
  return agents.map((agent: any) => String(agent && agent.id || '').trim()).filter(Boolean);
}

/** Completion protocol lines shared by the bootstrap instruction and the goal objective (D27/D28). */
function completionProtocolLines(node: any, verifierId: string | null): string[] {
  return [
    '完工协议（D27/D28）：本节点由 session goal 持续驱动，单次回复结束不代表完工。',
    '达成目标后调用 suggest-goal --action complete --reason "<执行结果摘要>" 宣布完工（reason 会回写为节点 result，≤2000 字符，供下游消费）。',
    verifierId
      ? `验收 agent（${verifierId}）将复核你的完工提案：通过则节点标记 done；打回则按反馈改进后重新宣布完工。`
      : '完工提案确认后节点即标记 done。',
    '目标未达成前不要宣布完工。',
  ];
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
  // D28 verification channel: deliver a scheduler-authored message to a
  // specific participant of the spawned child conversation (verification
  // request → verifier, rejection feedback → worker). Wired in create-server
  // via crossConversationDeliveryService.submitFromSystem + direct dispatch.
  const deliverNodeMessage = typeof options.deliverNodeMessage === 'function'
    ? options.deliverNodeMessage
    : null;
  // Startup reconcile hook (D25 wiring): re-offer a doing node's QUEUED
  // scheduler-owned delivery for direct parallel dispatch. Only invoked when
  // the delivery worker already owns a non-terminal delivery for the spawned
  // conversation; the atomic claim makes double-dispatch impossible.
  const dispatchQueuedNodeDelivery = typeof options.dispatchQueuedNodeDelivery === 'function'
    ? options.dispatchQueuedNodeDelivery
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

  function buildInitialInstruction(plan: any, node: any, worktreePath: string, verifierId: string | null = null): string {
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
        ...completionProtocolLines(node, verifierId),
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
      ...completionProtocolLines(node, verifierId),
    ].filter((line) => line !== '').join('\n');
  }

  /** D27 lightweight session goal objective for the spawned child (≤2000 chars). */
  function buildNodeGoalObjective(plan: any, node: any, worktreePath: string, verifierId: string | null): string {
    const lines = [
      `[DAG 节点目标] ${node.id}：${node.title || node.id}`,
      `目标：${clipText(String(node.goal || '(未填写)'), 1200)}`,
      node.branch ? `分支：${node.branch}` : '',
      worktreePath ? `工作目录：${worktreePath}` : '',
      node.kind === 'merge' ? '节点类型：merge（按 depends_on 顺序逐条合并上游分支，冲突由你解决，verify 命令必须通过）。' : '',
      ...completionProtocolLines(node, verifierId),
    ].filter(Boolean);
    return clipText(lines.join('\n'), 2000);
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

  /** Find the doing node bound to a spawned child conversation. */
  function findDoingNodeForChild(plan: any, conversationId: string): any {
    return nodesOf(plan).find((candidate: any) =>
      nodeStatusOf(candidate) === 'doing'
      && String(candidate.spawned_conversation_id || '').trim() === conversationId) || null;
  }

  /**
   * D28 ruling authority for a node's completion proposal. The persisted
   * goal binding (written at dispatch) is authoritative — it is exactly
   * what the bridge enforces pre-mutation. Participant-order resolution is
   * the fallback for legacy children that predate the binding.
   */
  function resolveRulingAuthority(conversation: any, node: any, ownerConversationId: string)
    : { bound: boolean; verifierId: string | null } {
    const binding = getDagNodeGoalBinding(conversation);
    if (binding) {
      return { bound: true, verifierId: binding.verifierId ? String(binding.verifierId) : null };
    }
    const childIds = participantIdsOf(conversation);
    const ownerIds = participantIdsOf(store.getConversationWithoutMessages(ownerConversationId));
    const resolution = resolveNodeVerifier(node, childIds.length > 0 ? childIds : ownerIds);
    return { bound: false, verifierId: resolution && resolution.verifierId ? resolution.verifierId : null };
  }

  /**
   * D28 defense-in-depth: the bridge already 403s wrong rulers
   * pre-mutation, so a mismatched ruledBy here means a forged event or a
   * bug — never act on it. Allowed principals:
   * - the user (UI manual accept/dismiss, kind 'user') — always;
   * - the scheduler's own auto-accept (accept path only);
   * - bound node: ONLY the designated verifier agent; an exempt binding
   *   (verifierId null) accepts NO agent ruling — its completion can only
   *   come from the scheduler auto-accept or the user;
   * - legacy node (no binding): the resolved verifier, or an agent-less
   *   ruling on a verification-exempt node (tolerant legacy contract).
   */
  function isCompletionRulingAllowed(
    authority: { bound: boolean; verifierId: string | null },
    ruledBy: any,
    options: { schedulerAutoAccept: boolean },
  ): boolean {
    if (String(ruledBy && ruledBy.kind || '') === 'user') {
      return true;
    }
    const agentId = String(ruledBy && ruledBy.agentId || '').trim();
    if (options.schedulerAutoAccept && agentId === 'dag-scheduler') {
      return true;
    }
    if (authority.bound) {
      return authority.verifierId !== null && agentId === authority.verifierId;
    }
    if (authority.verifierId !== null) {
      return agentId === authority.verifierId;
    }
    return !agentId;
  }

  /**
   * Result summary for a done write-back (D23 requires non-empty): the
   * worker's completion-proposal reason first, then its terminal reply.
   */
  function extractNodeResultText(conversation: any, proposal: any): string {
    const reasonText = String(proposal && proposal.reason || '').trim();
    if (reasonText) {
      return clipText(reasonText, 2000);
    }
    const terminal = conversation ? findTerminalDagReply(conversation) : null;
    if (terminal && terminal.kind === 'completed' && String(terminal.message.content || '').trim()) {
      return clipText(String(terminal.message.content).trim(), 2000);
    }
    return '(no textual result)';
  }

  /** D28: verification request delivered to the verifier participant. */
  function buildVerificationRequestContent(node: any, proposal: any, workerId: string): string {
    const resultSummary = clipText(
      String(proposal && proposal.reason || '').trim() || '(worker 未在 reason 中提供摘要)',
      1500
    );
    return [
      `[DAG 验收请求] 节点 ${node.id}：${node.title || node.id}`,
      `工作 agent（${workerId || 'worker'}）已宣布完工，请你验收。`,
      '',
      `节点目标：${clipText(String(node.goal || '(未填写)'), 800)}`,
      `完工摘要（通过后将回写为节点 result）：${resultSummary}`,
      node.branch ? `分支：${node.branch}` : '',
      node.verify ? `verify 命令：\`${node.verify}\`` : '',
      '',
      '请审查节点目标的达成情况（可查看本会话上下文、worktree 产物与 git diff）。',
      '裁决方式：通过 → suggest-goal --action accept；打回 → suggest-goal --action reject --reason "<具体反馈>"。',
    ].filter((line) => line !== '').join('\n');
  }

  /**
   * D28 auto-accept: the node has no verifier (single-agent owner), so the
   * scheduler rules on the worker's completion proposal and settles done.
   */
  function acceptProposalAndSettle(ownerConversationId: string, plan: any, node: any, conversationId: string, proposal: any): void {
    const nodeId = String(node.id || '').trim();
    let goalConversation: any = null;
    try {
      const result = applySessionGoalAction(store, conversationId, { action: 'accept-proposal' });
      goalConversation = result && result.conversation ? result.conversation : null;
      broadcastEvent('conversation_goal_proposal_cleared', {
        conversationId,
        outcome: 'accepted',
        goal: result && result.goal ? result.goal : null,
        proposal,
        ruledBy: { agentId: 'dag-scheduler', agentName: DAG_RESUME_SENDER_NAME },
      });
    } catch (error: any) {
      logError(`auto-accept failed for node ${nodeId}`, error);
      return;
    }
    settleCompleted(
      ownerConversationId,
      plan,
      node,
      extractNodeResultText(goalConversation || store.getConversation(conversationId), proposal),
      'dag_goal_completed'
    );
  }

  /**
   * D28 routing of a pending complete proposal: verifier present → deliver a
   * verification request (idempotent per proposal); no verifier → auto-accept.
   */
  async function routeCompletionProposal(ownerConversationId: string, plan: any, node: any, conversationId: string, proposal: any): Promise<void> {
    const nodeId = String(node.id || '').trim();
    const conversation = store.getConversation(conversationId) || store.getConversationWithoutMessages(conversationId);
    // The persisted binding (written at dispatch) is the authoritative
    // worker/verifier contract — participant-order recomputation could drift
    // if the child conversation's participants are ever rearranged, and the
    // bridge enforces against the binding, so the scheduler must agree with
    // it. Legacy children without a binding fall back to participant order.
    const binding = getDagNodeGoalBinding(conversation);
    const childIds = participantIdsOf(conversation);
    const ownerIds = participantIdsOf(store.getConversationWithoutMessages(ownerConversationId));
    const participantIds = childIds.length > 0 ? childIds : ownerIds;
    // D28 fail-closed: only the node worker may declare completion. The
    // bridge rejects non-worker proposals at creation time (403); a
    // mismatched proposer reaching this point means a forged/legacy
    // proposal — block visibly instead of routing it to the verifier.
    const workerId = binding ? binding.workerId : (participantIds[0] || '');
    const proposerId = String(proposal && proposal.proposedBy && proposal.proposedBy.agentId || '').trim();
    if (workerId && proposerId && proposerId !== workerId) {
      writeExecution(
        ownerConversationId,
        [{ nodeId, status: 'blocked' }],
        `dag_completion_wrong_proposer: completion proposed by ${clipText(proposerId, 120)}, expected worker ${clipText(workerId, 120)}`
      );
      return;
    }
    let verifierId: string | null = null;
    if (binding) {
      verifierId = binding.verifierId || null;
    } else {
      const resolution = resolveNodeVerifier(node, participantIds);
      if (resolution.error) {
        writeExecution(ownerConversationId, [{ nodeId, status: 'blocked' }], clipText(resolution.error, 500));
        return;
      }
      verifierId = resolution.verifierId;
    }
    if (!verifierId) {
      acceptProposalAndSettle(ownerConversationId, plan, node, conversationId, proposal);
      return;
    }
    if (!deliverNodeMessage) {
      writeExecution(
        ownerConversationId,
        [{ nodeId, status: 'blocked' }],
        'dag_verify_unavailable: verifier configured but no delivery channel is wired'
      );
      return;
    }
    const proposalStamp = String(proposal && (proposal.id || proposal.createdAt || proposal.updatedAt) || 'na');
    const verifyKey = `dag-verify:${plan.id}:${nodeId}:${proposalStamp}`;
    try {
      await deliverNodeMessage({
        ownerConversationId,
        conversationId,
        targetAgentId: verifierId,
        content: buildVerificationRequestContent(node, proposal, workerId),
        idempotencyKey: verifyKey,
        // dagDeliveryKey is persisted on the target message so the
        // terminal-failure guard can identify current-cycle deliveries
        // authoritatively (the key format alone is forgeable).
        messageMetadata: { kind: 'dag_verify_request', dagNodeId: nodeId, dagDeliveryKey: verifyKey },
      });
    } catch (error: any) {
      // Persist/validation failed synchronously — no delivery exists to
      // retry, and the pending proposal would block the Goal Runner
      // forever. Fail closed; a human can flip the node back to pending to
      // re-drive the completion protocol.
      writeExecution(
        ownerConversationId,
        [{ nodeId, status: 'blocked' }],
        `dag_delivery_failed: verification request could not be persisted (${clipText(error && error.message ? error.message : error, 200)})`
      );
    }
  }

  /**
   * Goal-state driven settle shared by the spawn→bind race check and the
   * startup reconcile. Returns true when the goal state fully handled the
   * node (settled, blocked, or verification (re-)routed); false when the
   * caller should fall back to legacy terminal-reply / resume handling.
   */
  async function settleFromGoalState(ownerConversationId: string, plan: any, node: any, conversation: any, reasonPrefix: string): Promise<boolean> {
    const conversationId = String(conversation && conversation.id || '').trim();
    if (!conversationId) {
      return false;
    }
    const nodeId = String(node.id || '').trim();
    const goal = getSessionGoal(conversation);
    const proposal = getSessionGoalProposal(conversation);

    if (goal && goal.status === 'complete') {
      settleCompleted(ownerConversationId, plan, node, extractNodeResultText(conversation, proposal), `${reasonPrefix}_goal_complete`);
      return true;
    }
    if (proposal && proposal.action === 'pause'
      && String(proposal.proposedBy && proposal.proposedBy.agentId || '') === 'goal-runner') {
      writeExecution(
        ownerConversationId,
        [{ nodeId, status: 'blocked' }],
        `dag_goal_budget_exhausted: goal continuation budget exhausted (${reasonPrefix}, D27)`
      );
      return true;
    }
    if (proposal && proposal.action === 'complete') {
      await routeCompletionProposal(ownerConversationId, plan, node, conversationId, proposal);
      return true;
    }
    return false;
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

    // D28: resolve the verifier BEFORE any side effect. An invalid explicit
    // verifier (not a participant) or self-review (verifier == worker) fails
    // closed — better a visible blocked node than unverifiable execution.
    const ownerConversation = store.getConversationWithoutMessages(ownerConversationId);
    const ownerParticipantIds = participantIdsOf(ownerConversation);
    const verifierResolution = resolveNodeVerifier(node, ownerParticipantIds);
    if (verifierResolution.error) {
      writeExecution(ownerConversationId, [{ nodeId, status: 'blocked' }], clipText(verifierResolution.error, 500));
      return true;
    }
    const verifierId = verifierResolution.verifierId;

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
        initialMessage: buildInitialInstruction(current.plan, node, String(prepared.path || ''), verifierId),
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

    // D27: set the lightweight session goal BEFORE binding doing so the
    // continuation loop never observes a goal-less doing node. Explicit
    // empty checklist — the node must NOT inherit the heavy session-level
    // default checklist. An idempotent re-dispatch reusing a child that
    // already has a goal must NOT clobber it (the goal may already be
    // complete or under verification). Failure here is fail-closed: without
    // the goal the node has no sustained drive and no completion protocol.
    const existingGoalConversation = store.getConversationWithoutMessages(spawnedConversationId);
    if (!getSessionGoal(existingGoalConversation)) {
      try {
        applySessionGoalAction(store, spawnedConversationId, {
          action: 'set',
          objective: buildNodeGoalObjective(current.plan, node, String(prepared.path || ''), verifierId),
          checklist: [],
        });
      } catch (goalError: any) {
        writeExecution(
          ownerConversationId,
          [{ nodeId, status: 'blocked', spawnedConversationId }],
          `dag_goal_init_failed: ${clipText(goalError && goalError.message ? goalError.message : goalError, 500)}`
        );
        return true;
      }
    }

    // D28 enforcement anchor: record the worker/verifier binding in the
    // child conversation metadata so the agent-tool bridge can fail closed
    // (403) on non-worker completion claims and non-verifier rulings.
    // Written even when the goal already existed (idempotent re-dispatch)
    // to repair a crash window between goal-set and binding-write.
    let recordedBinding: any = null;
    try {
      recordedBinding = ensureDagNodeGoalBinding(store, spawnedConversationId, {
        planId: current.plan.id,
        nodeId,
        workerId: ownerParticipantIds[0] || '',
        verifierId: verifierId || null,
      });
    } catch (bindingError: any) {
      writeExecution(
        ownerConversationId,
        [{ nodeId, status: 'blocked', spawnedConversationId }],
        `dag_goal_binding_failed: ${clipText(bindingError && bindingError.message ? bindingError.message : bindingError, 500)}`
      );
      return true;
    }
    if (!recordedBinding) {
      // ensure() returns null when the child conversation (or the store
      // read path) is unavailable — without the binding the bridge cannot
      // enforce the worker/verifier contract, so fail closed.
      writeExecution(
        ownerConversationId,
        [{ nodeId, status: 'blocked', spawnedConversationId }],
        'dag_goal_binding_failed: binding could not be persisted'
      );
      return true;
    }

    writeExecution(
      ownerConversationId,
      [{ nodeId, status: 'doing', spawnedConversationId }],
      'dag_dispatch'
    );

    // Close the spawn→bind race: if the child already reached a terminal
    // goal state before the doing binding landed (extremely fast executor,
    // or a crash-restart re-dispatch that reused the idempotent child), the
    // goal events have already fired and will never re-fire — settle
    // immediately instead of leaving the node doing forever.
    try {
      const spawnedConversation = store.getConversation(spawnedConversationId);
      if (spawnedConversation) {
        await settleFromGoalState(ownerConversationId, current.plan, node, spawnedConversation, 'dag_dispatch_settled');
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
        const freshConversation = store.getConversation(normalizedConversationId);
        const goal = freshConversation ? getSessionGoal(freshConversation) : null;
        const binding = freshConversation ? getDagNodeGoalBinding(freshConversation) : null;
        if (goal) {
          // D27: a finished turn no longer completes the node — the goal
          // does. Settle only when the goal already reached a terminal or
          // verifiable state; otherwise the continuation loop (goal active)
          // or the verification flow (pending complete proposal) drives on.
          await settleFromGoalState(ownerConversationId, plan, node, freshConversation, 'dag_slot');
        } else if (binding) {
          // Bound child whose goal vanished (e.g. tampered metadata): the
          // completion protocol is unrecoverable from here — fail closed
          // instead of falling back to the goal-less legacy path, which
          // would bypass the verifier.
          writeExecution(
            ownerConversationId,
            [{ nodeId, status: 'blocked' }],
            'dag_goal_missing: bound node conversation lost its session goal (D27/D28)'
          );
        } else {
          // Child without a binding (pre-D27 or binding never written):
          // keep the legacy turn-terminal completion behavior.
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
        }
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
      '完工协议：达成目标后调用 suggest-goal --action complete --reason "<执行结果摘要>" 宣布完工（D27/D28）。',
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

      // D27/D28: for goal-driven children the goal state is the source of
      // truth — complete → done, budget-exhausted pause proposal → blocked,
      // pending complete proposal → (re-)route verification idempotently.
      if (await settleFromGoalState(ownerConversationId, plan, node, conversation, 'dag_reconcile')) {
        continue;
      }

      // Legacy terminal-reply settle only for children with NO binding and
      // no goal: with a goal active, a finished-but-unannounced turn must
      // NOT flip done (D27) — the resume below nudges the worker through
      // the completion protocol instead. A bound child whose goal vanished
      // fails closed (the completion protocol is unrecoverable).
      if (!getSessionGoal(conversation)) {
        if (getDagNodeGoalBinding(conversation)) {
          writeExecution(
            ownerConversationId,
            [{ nodeId, status: 'blocked' }],
            'dag_goal_missing: bound node conversation lost its session goal (D27/D28)'
          );
          continue;
        }
        const terminal = findTerminalDagReply(conversation);
        if (terminal) {
          settleTerminalReply(ownerConversationId, plan, node, terminal, 'dag_reconcile');
          continue;
        }
      }

      // No terminal reply. If the delivery worker still has an in-flight or
      // queued delivery for this conversation, it owns the dispatch — skip.
      if (typeof store.hasNonTerminalCrossConversationDelivery === 'function'
        && store.hasNonTerminalCrossConversationDelivery(spawnedConversationId)) {
        // A delivery still QUEUED at this point was never claimed (persisted
        // before direct dispatch existed, or the process died between persist
        // and dispatch). Re-offer it so it runs in parallel instead of
        // waiting behind the serial drain.
        if (dispatchQueuedNodeDelivery) {
          try {
            dispatchQueuedNodeDelivery({ ownerConversationId, plan, node, conversation });
          } catch (dispatchError) {
            logError(`queued-delivery re-dispatch failed for node ${nodeId}`, dispatchError);
          }
        }
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

  /**
   * D27/D28 goal events for spawned children. Both handlers re-resolve the
   * (plan, node) pair fresh inside the per-owner chain so stale event
   * payloads never drive a write.
   */
  function handleGoalProposalUpdated(conversationId: string): void {
    const normalizedConversationId = String(conversationId || '').trim();
    if (!normalizedConversationId) {
      return;
    }
    let ownerResult: any = null;
    try {
      ownerResult = store.getPlanForConversation(normalizedConversationId);
    } catch {
      return;
    }
    const plan = ownerResult && ownerResult.plan ? ownerResult.plan : null;
    if (!plan || plan.status !== 'active') {
      return;
    }
    const ownerConversationId = ownerResult.ownerConversationId;
    void enqueueForOwner(ownerConversationId, async () => {
      let fresh: any = null;
      try {
        fresh = store.getPlanForConversation(normalizedConversationId);
      } catch {
        return;
      }
      const freshPlan = fresh && fresh.plan ? fresh.plan : null;
      if (!freshPlan || freshPlan.status !== 'active') {
        return;
      }
      const node = findDoingNodeForChild(freshPlan, normalizedConversationId);
      if (!node) {
        return;
      }
      const nodeId = String(node.id || '').trim();
      const conversation = store.getConversation(normalizedConversationId);
      if (!conversation) {
        return;
      }
      const proposal = getSessionGoalProposal(conversation);
      if (!proposal) {
        return;
      }
      if (proposal.action === 'pause'
        && String(proposal.proposedBy && proposal.proposedBy.agentId || '') === 'goal-runner') {
        // D27 budget fuse: the continuation runner asked to pause after
        // exhausting its turn budget — for an unattended node that is a
        // terminal failure, not a user decision.
        writeExecution(
          ownerConversationId,
          [{ nodeId, status: 'blocked' }],
          'dag_goal_budget_exhausted: goal continuation budget exhausted (D27)'
        );
        await dispatchReadyNodes(ownerConversationId);
        return;
      }
      if (proposal.action === 'complete') {
        await routeCompletionProposal(ownerConversationId, freshPlan, node, normalizedConversationId, proposal);
        // Auto-accept settled the node (or a fail-closed path blocked it) —
        // either way a concurrency slot may have freed; refill it.
        await dispatchReadyNodes(ownerConversationId);
      }
      // Other proposal actions (set/pause/resume from the worker itself)
      // are left to the normal user-confirmation flow; the node stays doing.
    }).catch((error) => logError('goal proposal updated handling failed', error));
  }

  function handleGoalProposalCleared(conversationId: string, payload: any): void {
    const normalizedConversationId = String(conversationId || '').trim();
    if (!normalizedConversationId) {
      return;
    }
    let ownerResult: any = null;
    try {
      ownerResult = store.getPlanForConversation(normalizedConversationId);
    } catch {
      return;
    }
    const plan = ownerResult && ownerResult.plan ? ownerResult.plan : null;
    if (!plan || plan.status !== 'active') {
      return;
    }
    const ownerConversationId = ownerResult.ownerConversationId;
    void enqueueForOwner(ownerConversationId, async () => {
      let fresh: any = null;
      try {
        fresh = store.getPlanForConversation(normalizedConversationId);
      } catch {
        return;
      }
      const freshPlan = fresh && fresh.plan ? fresh.plan : null;
      if (!freshPlan || freshPlan.status !== 'active') {
        return;
      }
      const node = findDoingNodeForChild(freshPlan, normalizedConversationId);
      if (!node) {
        return;
      }
      const nodeId = String(node.id || '').trim();
      const conversation = store.getConversation(normalizedConversationId);
      if (!conversation) {
        return;
      }
      const outcome = String(payload && payload.outcome || '').trim();
      const proposal = payload && payload.proposal ? payload.proposal : null;
      const goal = (payload && payload.goal ? payload.goal : null) || getSessionGoal(conversation);

      if (goal && goal.status === 'complete') {
        // Accepted — but by WHOM matters (D28). Never settle on a ruling
        // the persisted authority contract would not have permitted.
        const authority = resolveRulingAuthority(conversation, node, ownerConversationId);
        const ruledBy = payload && payload.ruledBy ? payload.ruledBy : {};
        if (!isCompletionRulingAllowed(authority, ruledBy, { schedulerAutoAccept: true })) {
          logError(
            `ignoring completion accept for node ${nodeId}: ruled by ${String(ruledBy.agentId || ruledBy.kind || 'none')}, expected verifier ${authority.verifierId || '(exempt)'}`,
            new Error('dag_verifier_ruling_mismatch')
          );
          return;
        }
        settleCompleted(ownerConversationId, freshPlan, node, extractNodeResultText(conversation, proposal), 'dag_goal_completed');
        await dispatchReadyNodes(ownerConversationId);
        return;
      }

      if (outcome === 'rejected') {
        // Rejected — the same D28 ruling contract applies (a forged reject
        // would otherwise inject bogus feedback into the worker).
        const authority = resolveRulingAuthority(conversation, node, ownerConversationId);
        const ruledBy = payload && payload.ruledBy ? payload.ruledBy : {};
        if (!isCompletionRulingAllowed(authority, ruledBy, { schedulerAutoAccept: false })) {
          logError(
            `ignoring completion reject for node ${nodeId}: ruled by ${String(ruledBy.agentId || ruledBy.kind || 'none')}, expected verifier ${authority.verifierId || '(exempt)'}`,
            new Error('dag_verifier_ruling_mismatch')
          );
          return;
        }
        // D28 rejection: feed the verifier's feedback back to the worker;
        // the goal stays active so the continuation loop keeps driving.
        const binding = getDagNodeGoalBinding(conversation);
        const workerId = (binding && binding.workerId)
          || participantIdsOf(conversation)[0]
          || participantIdsOf(store.getConversationWithoutMessages(ownerConversationId))[0]
          || '';
        if (!deliverNodeMessage || !workerId) {
          return;
        }
        const verifierName = String(ruledBy.agentName || ruledBy.agentId || '验收 agent');
        const reasonText = String(payload && payload.reason || '').trim() || '(验收 agent 未给出具体反馈)';
        const proposalStamp = String(proposal && (proposal.id || proposal.createdAt || proposal.updatedAt) || 'na');
        // Shares the dag-verify: namespace so the direct-dispatch wiring and
        // the terminal-failure guard treat it as scheduler-owned.
        const feedbackKey = `dag-verify:${freshPlan.id}:${nodeId}:feedback:${proposalStamp}`;
        try {
          await deliverNodeMessage({
            ownerConversationId,
            conversationId: normalizedConversationId,
            targetAgentId: workerId,
            content: [
              `[DAG 验收打回] 节点 ${nodeId}：${node.title || nodeId} 的完工提案被 ${verifierName} 驳回。`,
              `验收反馈：${clipText(reasonText, 1500)}`,
              '请根据反馈继续改进；达成目标后再次调用 suggest-goal --action complete --reason "<执行结果摘要>" 宣布完工。',
            ].join('\n'),
            idempotencyKey: feedbackKey,
            messageMetadata: { kind: 'dag_verify_feedback', dagNodeId: nodeId, dagDeliveryKey: feedbackKey },
          });
        } catch (error: any) {
          // The proposal is already cleared — if the feedback cannot even be
          // persisted the worker will never learn about the rejection and
          // the node would idle in doing forever. Fail closed.
          writeExecution(
            ownerConversationId,
            [{ nodeId, status: 'blocked' }],
            `dag_delivery_failed: rejection feedback could not be persisted (${clipText(error && error.message ? error.message : error, 200)})`
          );
          await dispatchReadyNodes(ownerConversationId);
        }
      }
    }).catch((error) => logError('goal proposal cleared handling failed', error));
  }

  /**
   * Scheduler-owned delivery terminal-failure guard (fail closed).
   *
   * A scheduler delivery (dag-node: spawn, dag-resume: restart resume,
   * dag-verify: verification request / rejection feedback) that reaches a
   * TERMINAL failure (failed OR cancelled) must not leave the node doing
   * forever — the worker's pending proposal would otherwise block the Goal
   * Runner indefinitely with no further events.
   *
   * Trust boundary: the idempotency key is model-controllable for
   * agent-submitted deliveries, so ownership is established ONLY from the
   * persisted authoritative fields — principalKind 'operator', the exact
   * scheduler idempotency scopes, source = plan owner, target = the node's
   * current spawned child — and the key must equal one of the node's
   * CURRENT-cycle keys (activation stamp / pending proposal stamp). A stale
   * failure from a previous activation or an earlier proposal round never
   * blocks the current execution.
   */
  function handleDeliveryUpdated(payload: any): void {
    const delivery = payload && payload.delivery ? payload.delivery : null;
    if (!delivery) {
      return;
    }
    const key = String(delivery.idempotencyKey || '');
    if (!key.startsWith('dag-node:') && !key.startsWith('dag-verify:') && !key.startsWith('dag-resume:')) {
      return;
    }
    const dispatchStatus = String(delivery.dispatchStatus || '');
    if (dispatchStatus !== 'failed' && dispatchStatus !== 'cancelled') {
      return;
    }
    if (String(delivery.principalKind || '') !== 'operator') {
      return; // agent-principal delivery with a forged dag-* key — not ours
    }
    const sourceConversationId = String(delivery.sourceConversationId || '').trim();
    const targetConversationId = String(delivery.targetConversationId || '').trim();
    const scope = String(delivery.idempotencyScope || '');
    if (!sourceConversationId || !targetConversationId) {
      return;
    }
    const reason = String(payload && payload.reason || dispatchStatus).trim() || dispatchStatus;
    const activePlans = typeof store.listActivePlans === 'function' ? store.listActivePlans() : [];
    for (const plan of activePlans) {
      const planId = String(plan && plan.id || '').trim();
      const ownerConversationId = String(plan && plan.ownerConversationId || '').trim();
      if (!planId || !ownerConversationId || sourceConversationId !== ownerConversationId) {
        continue;
      }
      const expectedScopes = new Set([
        `operator:${ownerConversationId}:conversation_spawn`,
        `system:${ownerConversationId}:conversation_notify`,
      ]);
      if (!expectedScopes.has(scope)) {
        continue;
      }
      void enqueueForOwner(ownerConversationId, async () => {
        let fresh: any = null;
        try {
          fresh = store.getPlanForConversation(ownerConversationId);
        } catch {
          return;
        }
        const freshPlan = fresh && fresh.plan ? fresh.plan : null;
        if (!freshPlan || freshPlan.status !== 'active'
          || String(freshPlan.id || '').trim() !== planId) {
          return;
        }
        const activation = String(freshPlan.activatedAt || 'na');
        for (const candidate of nodesOf(freshPlan)) {
          const candidateId = String(candidate && candidate.id || '').trim();
          if (!candidateId || nodeStatusOf(candidate) !== 'doing') {
            continue;
          }
          const spawnedId = String(candidate.spawned_conversation_id || '').trim();
          if (!spawnedId || spawnedId !== targetConversationId) {
            continue;
          }
          // Rebuild the node's CURRENT-cycle scheduler keys. Verify-request
          // keys embed the pending proposal stamp; without a pending
          // proposal that delivery cannot belong to this cycle.
          const currentKeys = new Set([
            `dag-node:${planId}:${candidateId}:${activation}`,
            `dag-resume:${planId}:${candidateId}:${activation}`,
          ]);
          const childConversation = typeof store.getConversation === 'function'
            ? store.getConversation(spawnedId)
            : null;
          const pendingProposal = childConversation ? getSessionGoalProposal(childConversation) : null;
          const pendingCompletion = pendingProposal && pendingProposal.action === 'complete'
            ? pendingProposal
            : null;
          const proposalStamp = String(pendingCompletion && (pendingCompletion.id || pendingCompletion.createdAt || pendingCompletion.updatedAt) || '').trim();
          if (pendingCompletion && proposalStamp) {
            currentKeys.add(`dag-verify:${planId}:${candidateId}:${proposalStamp}`);
          }
          // Rejection-feedback keys OUTLIVE their (already cleared) proposal
          // round, so the stamp check above cannot cover them. The durable
          // currency marker is the persisted feedback message itself:
          // scheduler deliveries carry dagDeliveryKey in the target message
          // metadata, and only the LATEST feedback message belongs to the
          // current round. Additionally, once the worker has re-announced
          // completion (a new pending complete proposal), any prior feedback
          // delivery is superseded — its "notify the worker" purpose has
          // been served by the new proposal round — so a late failure of it
          // must not block the node.
          const childMessages = childConversation && Array.isArray(childConversation.messages)
            ? childConversation.messages
            : [];
          const latestFeedback = childMessages
            .filter((message: any) => message && message.metadata && typeof message.metadata === 'object'
              && message.metadata.kind === 'dag_verify_feedback')
            .pop();
          const latestFeedbackKey = String(
            latestFeedback && latestFeedback.metadata && latestFeedback.metadata.dagDeliveryKey || ''
          ).trim();
          if (latestFeedbackKey && !pendingCompletion) {
            currentKeys.add(latestFeedbackKey);
          }
          if (!currentKeys.has(key)) {
            continue; // stale activation / earlier proposal round
          }
          writeExecution(
            ownerConversationId,
            [{ nodeId: candidateId, status: 'blocked' }],
            `dag_delivery_failed: scheduler delivery reached terminal failure (${clipText(reason, 200)})`
          );
          await dispatchReadyNodes(ownerConversationId);
          return;
        }
      }).catch((error) => logError('delivery failure handling failed', error));
      return;
    }
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
        return;
      }
      if (eventName === 'conversation_goal_proposal_updated') {
        handleGoalProposalUpdated(payload && payload.conversationId);
        return;
      }
      if (eventName === 'conversation_goal_proposal_cleared') {
        handleGoalProposalCleared(payload && payload.conversationId, payload);
        return;
      }
      if (eventName === 'cross_conversation_delivery_updated') {
        handleDeliveryUpdated(payload);
        return;
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
