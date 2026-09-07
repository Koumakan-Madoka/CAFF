import {
  exportAgentContextSnapshotMarkdown,
  redactContextInspectorSecrets,
} from './turn/context-snapshot';

export const TRACE_INSPECTOR_SCHEMA_VERSION = 1;
export const MAX_SESSION_LINEAGE_DEPTH = 8;

type LineageTerminationCode =
  | 'fresh_root'
  | 'legacy_schema'
  | 'parent_missing'
  | 'parent_snapshot_missing'
  | 'protected_parent'
  | 'invalid_reference'
  | 'cycle'
  | 'depth_limit';

function plainObject(value: any) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value: any) {
  return String(value || '').trim();
}

function nonNegativeInteger(value: any): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function safeTraceValueText(value: any) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(value, (_key, entry) => {
      if (typeof entry === 'bigint') {
        return `${entry}n`;
      }

      if (!entry || typeof entry !== 'object') {
        return entry;
      }

      if (seen.has(entry)) {
        return '[循环引用]';
      }

      seen.add(entry);
      return entry;
    }, 2);
    return serialized === undefined ? '[结构化数据无法序列化]' : serialized;
  } catch {
    return '[结构化数据无法序列化]';
  }
}

function clipSafeText(value: any, maxLength = 360) {
  const text = redactContextInspectorSecrets(safeTraceValueText(value)).replace(/\s+/gu, ' ');
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function normalizedIso(value: any): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = typeof value === 'number' ? value : Number.NaN;
  const timestamp = Number.isFinite(numeric)
    ? numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
    : Date.parse(String(value));
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return new Date(timestamp).toISOString();
}

function deliveryMode(snapshot: any): 'fresh' | 'resume' | 'unknown' {
  const value = clean(snapshot && snapshot.deliveryMode).toLowerCase();
  return value === 'fresh' || value === 'resume' ? value : 'unknown';
}

function isPrivateOnly(message: any) {
  return plainObject(message && message.metadata).privateOnly === true;
}

function lineageNode(message: any, snapshot: any, depth: number) {
  const metadata = plainObject(message && message.metadata);
  const retained = plainObject(snapshot && snapshot.retainedSessionPrefix);
  const mode = deliveryMode(snapshot);
  const cursorCount = nonNegativeInteger(retained.cursorMessageCount);
  return {
    depth,
    relation: depth === 0 ? 'current' : depth === 1 ? 'parent' : 'ancestor',
    messageId: clean(message && message.id),
    snapshotId: clean(snapshot && snapshot.snapshotId),
    sessionName: clean(metadata.sessionName),
    deliveryMode: mode,
    capturedAt: clean(snapshot && snapshot.capturedAt),
    agentId: clean(snapshot && snapshot.agentId) || clean(message && message.agentId),
    agentName: clean(snapshot && snapshot.agentName) || clean(message && message.senderName),
    cursor: mode === 'resume'
      ? {
          messageId: clean(retained.cursorMessageId),
          messageCount: cursorCount === null ? 0 : cursorCount,
          firstMessageId: clean(retained.cursorFirstMessageId),
          maxUpdatedAt: retained.cursorMaxUpdatedAt ? clean(retained.cursorMaxUpdatedAt) : null,
        }
      : null,
  };
}

function termination(code: LineageTerminationCode, atDepth: number) {
  return { code, atDepth };
}

export function buildSessionLineage(options: any = {}) {
  const conversationId = clean(options.conversationId);
  const rootMessage = options.message;
  const rootSnapshot = options.snapshot;
  const getMessage = typeof options.getMessage === 'function' ? options.getMessage : () => null;
  const getSnapshot = typeof options.getSnapshot === 'function' ? options.getSnapshot : () => null;
  const nodes: any[] = [];
  const visited = new Set<string>();
  const expectedAgentId = clean(rootMessage && rootMessage.agentId) || clean(rootSnapshot && rootSnapshot.agentId);
  let currentMessage = rootMessage;
  let currentSnapshot = rootSnapshot;

  for (let depth = 0; depth < MAX_SESSION_LINEAGE_DEPTH; depth += 1) {
    const currentMessageId = clean(currentMessage && currentMessage.id);
    if (!currentMessageId || visited.has(currentMessageId)) {
      return {
        maxDepth: MAX_SESSION_LINEAGE_DEPTH,
        nodes,
        termination: termination(currentMessageId ? 'cycle' : 'invalid_reference', depth),
      };
    }

    const currentConversationId = clean(currentMessage && currentMessage.conversationId);
    const currentSnapshotMessageId = clean(currentSnapshot && currentSnapshot.messageId);
    const currentSnapshotConversationId = clean(currentSnapshot && currentSnapshot.conversationId);
    const currentAgentId = clean(currentMessage && currentMessage.agentId) || clean(currentSnapshot && currentSnapshot.agentId);
    if (
      clean(currentMessage && currentMessage.role) !== 'assistant'
      || currentConversationId !== conversationId
      || (currentSnapshotMessageId && currentSnapshotMessageId !== currentMessageId)
      || (currentSnapshotConversationId && currentSnapshotConversationId !== conversationId)
      || (expectedAgentId && currentAgentId !== expectedAgentId)
    ) {
      return {
        maxDepth: MAX_SESSION_LINEAGE_DEPTH,
        nodes,
        termination: termination('invalid_reference', depth),
      };
    }

    visited.add(currentMessageId);
    nodes.push(lineageNode(currentMessage, currentSnapshot, depth));

    const mode = deliveryMode(currentSnapshot);
    if (mode === 'unknown' || Number(currentSnapshot && currentSnapshot.schemaVersion || 0) < 2) {
      return {
        maxDepth: MAX_SESSION_LINEAGE_DEPTH,
        nodes,
        termination: termination('legacy_schema', depth),
      };
    }
    if (mode === 'fresh') {
      return {
        maxDepth: MAX_SESSION_LINEAGE_DEPTH,
        nodes,
        termination: termination('fresh_root', depth),
      };
    }

    const parentMessageId = clean(currentSnapshot && currentSnapshot.retainedSessionPrefix
      && currentSnapshot.retainedSessionPrefix.cursorMessageId);
    if (!parentMessageId) {
      return {
        maxDepth: MAX_SESSION_LINEAGE_DEPTH,
        nodes,
        termination: termination('invalid_reference', depth + 1),
      };
    }
    if (visited.has(parentMessageId)) {
      return {
        maxDepth: MAX_SESSION_LINEAGE_DEPTH,
        nodes,
        termination: termination('cycle', depth + 1),
      };
    }
    if (nodes.length >= MAX_SESSION_LINEAGE_DEPTH) {
      return {
        maxDepth: MAX_SESSION_LINEAGE_DEPTH,
        nodes,
        termination: termination('depth_limit', nodes.length),
      };
    }

    const parentMessage = getMessage(parentMessageId);
    if (!parentMessage) {
      return {
        maxDepth: MAX_SESSION_LINEAGE_DEPTH,
        nodes,
        termination: termination('parent_missing', depth + 1),
      };
    }
    if (isPrivateOnly(parentMessage)) {
      const currentNode = nodes[nodes.length - 1];
      if (currentNode && currentNode.cursor) {
        currentNode.cursor = {
          ...currentNode.cursor,
          messageId: '',
          firstMessageId: '',
          maxUpdatedAt: null,
        };
      }
      return {
        maxDepth: MAX_SESSION_LINEAGE_DEPTH,
        nodes,
        termination: termination('protected_parent', depth + 1),
      };
    }
    if (
      clean(parentMessage.conversationId) !== conversationId
      || clean(parentMessage.role) !== 'assistant'
      || (expectedAgentId && clean(parentMessage.agentId) !== expectedAgentId)
    ) {
      return {
        maxDepth: MAX_SESSION_LINEAGE_DEPTH,
        nodes,
        termination: termination('invalid_reference', depth + 1),
      };
    }

    const parentSnapshot = getSnapshot(parentMessageId);
    if (!parentSnapshot) {
      return {
        maxDepth: MAX_SESSION_LINEAGE_DEPTH,
        nodes,
        termination: termination('parent_snapshot_missing', depth + 1),
      };
    }
    currentMessage = parentMessage;
    currentSnapshot = parentSnapshot;
  }

  return {
    maxDepth: MAX_SESSION_LINEAGE_DEPTH,
    nodes,
    termination: termination('depth_limit', nodes.length),
  };
}

function sessionProjection(message: any, snapshot: any, runEvidence: any) {
  const metadata = plainObject(message && message.metadata);
  const mode = deliveryMode(snapshot);
  return {
    mode,
    reused: runEvidence && runEvidence.sessionReused === true,
    reason: clean(runEvidence && runEvidence.sessionReuseReason) || clean(metadata.sessionReuseReason),
    sessionName: clean(metadata.sessionName),
    provider: clean(metadata.provider),
    model: clean(metadata.model),
    label: mode === 'resume'
      ? '复用旧 Session'
      : mode === 'fresh'
        ? '新建 Session'
        : '旧版 Session（模式未知）',
  };
}

function traceStatusForMessage(message: any) {
  const status = clean(message && message.status).toLowerCase();
  if (status === 'failed') return 'failed';
  if (status === 'completed') return 'completed';
  if (status === 'queued') return 'queued';
  return 'running';
}

function providerCacheProjection(event: any) {
  const tokenUsage = plainObject(event && event.tokenUsage);
  const cacheReadTokens = nonNegativeInteger(tokenUsage.cacheReadTokens);
  if (event && event.providerMiss === true) {
    return { status: 'provider_miss', label: 'provider miss' };
  }
  if (cacheReadTokens !== null && cacheReadTokens > 0) {
    return { status: 'cache_hit', label: '缓存命中' };
  }
  if (cacheReadTokens === 0) {
    return { status: 'no_cache_read', label: '未读取缓存' };
  }
  return { status: 'unknown', label: '缓存证据未知' };
}

function normalizeToolStatus(value: any) {
  const status = clean(value).toLowerCase();
  if (status === 'failed' || status === 'error' || status === 'timeout') return 'failed';
  if (status === 'running' || status === 'queued' || status === 'pending') return 'running';
  return 'completed';
}

function buildTraceEvents(message: any, snapshot: any, runEvidence: any, toolTrace: any, session: any, getMessage: any) {
  const metadata = plainObject(message && message.metadata);
  const triggerMessageId = clean(metadata.triggeredByMessageId);
  const triggerMessage = triggerMessageId && typeof getMessage === 'function' ? getMessage(triggerMessageId) : null;
  const safeTriggerMessage = triggerMessage && !isPrivateOnly(triggerMessage) ? triggerMessage : null;
  const task = plainObject(toolTrace && toolTrace.task);
  const timelineEvents = Array.isArray(toolTrace && toolTrace.timelineEvents)
    ? toolTrace.timelineEvents.filter((event: any) => event && typeof event === 'object')
    : [];
  const events: any[] = [];
  const push = (event: any) => {
    events.push({
      id: clean(event.id) || `trace:${events.length + 1}:${event.phase}`,
      sequence: events.length + 1,
      kind: event.kind || 'lifecycle',
      phase: event.phase,
      status: event.status || 'observed',
      title: event.title,
      occurredAt: normalizedIso(event.occurredAt),
      durationMs: nonNegativeInteger(event.durationMs),
      summary: clipSafeText(event.summary),
      detailRef: event.detailRef || null,
      ...(event.detail && typeof event.detail === 'object' ? { detail: event.detail } : {}),
    });
  };
  const reuseReason = session.reason || 'unknown';
  const blockedBeforeProvider = Array.isArray(metadata.invocationBlocks) && metadata.invocationBlocks.length > 0;

  push({
    phase: 'trigger',
    status: 'observed',
    title: '触发回复',
    occurredAt: safeTriggerMessage && safeTriggerMessage.createdAt || message && message.createdAt,
    summary: safeTriggerMessage
      ? `${clean(metadata.triggerType) || 'user'} 触发，来源消息 ${triggerMessageId}`
      : `${clean(metadata.triggerType) || 'user'} 触发`,
    detailRef: 'message',
  });
  push({
    phase: 'reuse_decision',
    status: reuseReason === 'reuse_evaluation_error' ? 'failed' : session.mode === 'resume' ? 'completed' : 'observed',
    title: 'Session 复用判定',
    occurredAt: snapshot && snapshot.capturedAt,
    summary: session.mode === 'resume' ? '判定通过，准备恢复旧 Session' : `未复用旧 Session：${reuseReason}`,
    detailRef: 'session',
  });
  push({
    phase: 'claim',
    status: session.mode === 'resume' ? 'completed' : reuseReason === 'claim_conflict' ? 'failed' : 'skipped',
    title: 'Session claim',
    occurredAt: snapshot && snapshot.capturedAt,
    summary: session.mode === 'resume' ? '原子 claim 成功，当前 run 取得复用权' : `未取得复用 claim：${reuseReason}`,
    detailRef: 'session',
  });
  push({
    phase: 'session',
    status: blockedBeforeProvider ? 'skipped' : traceStatusForMessage(message),
    title: session.label,
    occurredAt: task.startedAt || snapshot && snapshot.capturedAt,
    summary: blockedBeforeProvider
      ? '运行前门禁阻止 provider Session 启动'
      : session.mode === 'resume'
        ? 'provider runtime 使用 resume 恢复既有 Session'
        : session.mode === 'fresh'
          ? 'provider runtime 创建新的 Session'
          : '旧记录未保存 Session 启动方式',
    detailRef: 'session',
  });
  push({
    phase: 'prompt',
    status: blockedBeforeProvider
      ? 'skipped'
      : session.mode === 'unknown' && session.reused
        ? 'observed'
        : 'completed',
    title: session.mode === 'resume' ? '投递本轮增量' : session.mode === 'fresh' ? '投递完整上下文' : '投递上下文',
    occurredAt: snapshot && snapshot.capturedAt,
    summary: blockedBeforeProvider
      ? '快照已捕获，但 prompt 未投递给 provider'
      : session.mode === 'resume'
        ? `实际投递 session_delta，${Number(snapshot && snapshot.sections && snapshot.sections.length || 0)} 个分区`
        : session.mode === 'fresh' || !session.reused
          ? `实际投递完整 prompt，${Number(snapshot && snapshot.sections && snapshot.sections.length || 0)} 个分区`
          : '旧版复用快照未记录实际 prompt 投递方式，分区口径不可靠',
    detailRef: 'context',
  });

  timelineEvents.forEach((event: any, index: number) => {
    if (event.eventType === 'model_call') {
      const callSequence = nonNegativeInteger(event.modelCallSequence || event.sequence) || index + 1;
      const cache = providerCacheProjection(event);
      const firstCall = callSequence === 1;
      push({
        id: event.eventId,
        kind: 'model_call',
        phase: 'model_call',
        status: clean(event.stopReason).toLowerCase() === 'error' ? 'failed' : 'completed',
        title: firstCall ? session.label : `模型调用 #${callSequence}`,
        occurredAt: event.timestamp,
        summary: firstCall ? `${session.label} · ${cache.label}` : cache.label,
        detailRef: 'model_call',
        detail: {
          eventId: clean(event.eventId),
          modelCallSequence: callSequence,
          stopReason: clean(event.stopReason),
          sessionAction: firstCall ? session.mode : null,
          providerCacheStatus: cache.status,
          providerCacheLabel: cache.label,
          tokenUsage: plainObject(event.tokenUsage),
        },
      });
      return;
    }

    push({
      id: event.eventId,
      kind: 'tool_execution',
      phase: 'tool',
      status: normalizeToolStatus(event.status),
      title: clean(event.toolName) || 'tool',
      occurredAt: event.createdAt,
      durationMs: event.durationMs,
      summary: event.errorSummary || event.resultSummary || event.requestSummary || clean(event.status),
      detailRef: 'tool_execution',
      detail: {
        eventId: clean(event.eventId),
        source: clean(event.kind),
        toolName: clean(event.toolName),
        requestSummary: clipSafeText(event.requestSummary),
        resultSummary: clipSafeText(event.resultSummary),
        errorSummary: clipSafeText(event.errorSummary),
      },
    });
  });

  const usageModelCallCount = nonNegativeInteger(runEvidence && runEvidence.modelCallCount);
  const usageInputTokens = nonNegativeInteger(runEvidence && runEvidence.inputTokens);
  const usagePresent = usageInputTokens !== null || usageModelCallCount !== null;
  push({
    phase: 'usage',
    status: usagePresent ? 'completed' : 'skipped',
    title: '采集 usage',
    occurredAt: task.endedAt || message && message.updatedAt,
    summary: usagePresent
      ? `${usageModelCallCount === null ? '模型调用次数未知' : `${usageModelCallCount} 次模型调用`}，${usageInputTokens === null ? 'input tokens 未知' : `input ${usageInputTokens} tokens`}`
      : '没有可用的 provider usage 证据',
    detailRef: 'usage',
  });

  const failure = toolTrace && toolTrace.failureContext && toolTrace.failureContext.hasFailure
    ? toolTrace.failureContext
    : null;
  if (failure) {
    push({
      phase: 'failure',
      status: 'failed',
      title: '运行失败',
      occurredAt: task.endedAt || message && message.updatedAt,
      summary: failure.summary || '运行记录包含失败证据',
      detailRef: 'failure',
    });
  }

  push({
    phase: 'persistence',
    status: traceStatusForMessage(message),
    title: '消息落库',
    occurredAt: message && message.updatedAt || task.endedAt,
    summary: `assistant 消息已落库为 ${clean(message && message.status) || 'unknown'}`,
    detailRef: 'message',
  });

  return events;
}

export function exportMessageTraceInspectorMarkdown(inspector: any) {
  if (!inspector || typeof inspector !== 'object' || Array.isArray(inspector)) {
    return '# Trace Inspector\n\nNo trace is available.\n';
  }

  const lines = [
    '# Trace Inspector / 回复审计轨迹',
    '',
    `- Message: ${clean(inspector.message && inspector.message.id) || 'unknown'}`,
    `- Agent: ${clean(inspector.message && inspector.message.agentName) || clean(inspector.message && inspector.message.agentId) || 'unknown'}`,
    `- Status: ${clean(inspector.message && inspector.message.status) || 'unknown'}`,
    `- Session: ${clean(inspector.session && inspector.session.label) || 'unknown'}`,
    `- Session reason: ${clean(inspector.session && inspector.session.reason) || 'unknown'}`,
    '',
    '## Session Lineage',
    '',
    '| Relation | Message | Snapshot | Session | Mode | Captured at |',
    '| --- | --- | --- | --- | --- | --- |',
  ];

  const tableCell = (value: any) => clipSafeText(value).replace(/\|/gu, '\\|');
  for (const node of Array.isArray(inspector.lineage && inspector.lineage.nodes) ? inspector.lineage.nodes : []) {
    lines.push(
      `| ${tableCell(node.relation)} | ${tableCell(node.messageId)} | ${tableCell(node.snapshotId)} | ${tableCell(node.sessionName)} | ${tableCell(node.deliveryMode)} | ${tableCell(node.capturedAt)} |`
    );
  }
  lines.push(
    '',
    `Lineage termination: ${clean(inspector.lineage && inspector.lineage.termination && inspector.lineage.termination.code) || 'unknown'}`,
    '',
    '## Trace Timeline',
    '',
    '| # | Phase | Status | Time | Title | Summary |',
    '| ---: | --- | --- | --- | --- | --- |'
  );
  for (const event of Array.isArray(inspector.trace && inspector.trace.events) ? inspector.trace.events : []) {
    lines.push(
      `| ${Number(event.sequence || 0)} | ${tableCell(event.phase)} | ${tableCell(event.status)} | ${tableCell(event.occurredAt || '')} | ${tableCell(event.title)} | ${tableCell(event.summary)} |`
    );
  }

  lines.push('', exportAgentContextSnapshotMarkdown(inspector.snapshot).trim(), '');
  return `${lines.join('\n')}\n`;
}

export function buildMessageTraceInspector(options: any = {}) {
  const message = options.message;
  const snapshot = options.snapshot;
  const runEvidence = plainObject(options.runEvidence);
  const toolTrace = plainObject(options.toolTrace);
  const session = sessionProjection(message, snapshot, runEvidence);
  const lineage = buildSessionLineage({
    conversationId: options.conversationId,
    message,
    snapshot,
    getMessage: options.getMessage,
    getSnapshot: options.getSnapshot,
  });
  const events = buildTraceEvents(message, snapshot, runEvidence, toolTrace, session, options.getMessage);
  const protectedLineageBoundary = lineage.termination && lineage.termination.code === 'protected_parent';
  const task = plainObject(toolTrace.task);
  const taskStartedAt = normalizedIso(task.startedAt);
  const taskEndedAt = normalizedIso(task.endedAt);
  const totalDurationMs = taskStartedAt && taskEndedAt
    ? Math.max(0, Date.parse(taskEndedAt) - Date.parse(taskStartedAt))
    : null;
  const safeSnapshot = protectedLineageBoundary && snapshot && snapshot.retainedSessionPrefix
    ? {
        ...snapshot,
        retainedSessionPrefix: {
          ...snapshot.retainedSessionPrefix,
          sessionName: '',
          staticSegmentHash: '',
          cursorMessageId: '',
          cursorFirstMessageId: '',
          cursorMaxUpdatedAt: null,
          lastReplyAt: '',
        },
      }
    : snapshot;
  const messageTraceStatus = traceStatusForMessage(message);
  const toolTraceStatus = clean(toolTrace && toolTrace.summary && toolTrace.summary.status);
  const summaryStatus = messageTraceStatus === 'completed' || messageTraceStatus === 'failed'
    ? messageTraceStatus
    : toolTraceStatus === 'failed' || toolTraceStatus === 'running' || toolTraceStatus === 'queued'
      ? toolTraceStatus
      : messageTraceStatus;

  return {
    schemaVersion: TRACE_INSPECTOR_SCHEMA_VERSION,
    message: {
      id: clean(message && message.id),
      turnId: clean(message && message.turnId),
      agentId: clean(message && message.agentId),
      agentName: clean(message && message.senderName),
      status: clean(message && message.status),
      createdAt: clean(message && message.createdAt),
      updatedAt: clean(message && message.updatedAt),
    },
    session,
    snapshot: safeSnapshot,
    runEvidence,
    lineage,
    trace: {
      events,
      timelineWindow: toolTrace.timelineWindow || {
        totalEventCount: 0,
        retainedEventCount: 0,
        droppedEventCount: 0,
        truncated: false,
      },
      summary: {
        status: summaryStatus,
        totalDurationMs,
        totalToolDurationMs: nonNegativeInteger(toolTrace && toolTrace.timelineWindow && toolTrace.timelineWindow.totalToolDurationMs),
        modelCallCount: nonNegativeInteger(toolTrace && toolTrace.summary && toolTrace.summary.modelCallCount) || 0,
        toolExecutionCount: nonNegativeInteger(toolTrace && toolTrace.summary && toolTrace.summary.toolExecutionCount) || 0,
        providerMissCount: nonNegativeInteger(toolTrace && toolTrace.summary && toolTrace.summary.providerMissCount) || 0,
        failedToolExecutionCount: nonNegativeInteger(toolTrace && toolTrace.timelineWindow && toolTrace.timelineWindow.failedToolExecutionCount) || 0,
      },
      failureContext: toolTrace.failureContext || null,
    },
  };
}
