function normalizeIsoBoundary(value: any) {
  const raw = String(value || '').trim();

  if (!raw) {
    return '';
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw}T00:00:00.000Z`;
  }

  return raw;
}

function safeJsonParse(value: any) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function quantile(values: any[], q: number) {
  const clean = (Array.isArray(values) ? values : [])
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (clean.length === 0) {
    return null;
  }

  const index = Math.floor((clean.length - 1) * q);
  return clean[index];
}

function ensureAgentBucket(map: any, agentId: any, agentName: any) {
  const normalizedAgentId = String(agentId || '').trim() || 'unknown';
  const existing = map.get(normalizedAgentId);

  if (existing) {
    if (!existing.agentName && agentName) {
      existing.agentName = String(agentName || '').trim();
    }

    return existing;
  }

  const bucket = {
    agentId: normalizedAgentId,
    agentName: String(agentName || '').trim(),
    turns: 0,
    turnsCompleted: 0,
    turnsFailed: 0,
    missingExpectations: 0,
    sendPublic: { tp: 0, fp: 0, fn: 0, tn: 0, required: 0, forbidden: 0 },
    sendPrivate: { tp: 0, fp: 0, fn: 0, tn: 0, required: 0, forbidden: 0 },
    publicToolUsedTurns: 0,
    privateToolUsedTurns: 0,
    publicPostCount: 0,
    privatePostCount: 0,
    privateHandoffCount: 0,
    toolCalls: {} as Record<string, any>,
  };

  map.set(normalizedAgentId, bucket);
  return bucket;
}

function ensureToolBucket(toolCalls: any, toolName: any) {
  const key = String(toolName || '').trim() || 'unknown';

  if (toolCalls[key]) {
    return toolCalls[key];
  }

  toolCalls[key] = {
    tool: key,
    calls: 0,
    succeeded: 0,
    failed: 0,
    durationMs: [] as number[],
  };

  return toolCalls[key];
}

function summarizeToolBucket(bucket: any) {
  const durations = Array.isArray(bucket && bucket.durationMs) ? bucket.durationMs : [];
  const calls = Number.isFinite(bucket && bucket.calls) ? bucket.calls : 0;
  const succeeded = Number.isFinite(bucket && bucket.succeeded) ? bucket.succeeded : 0;
  const failed = Number.isFinite(bucket && bucket.failed) ? bucket.failed : 0;

  return {
    tool: bucket && bucket.tool ? String(bucket.tool) : 'unknown',
    calls,
    succeeded,
    failed,
    successRate: calls > 0 ? succeeded / calls : null,
    p50Ms: quantile(durations, 0.5),
    p95Ms: quantile(durations, 0.95),
  };
}

export function buildAgentEvalReport(db: any, options: any = {}) {
  const since = normalizeIsoBoundary(options.since);
  const until = normalizeIsoBoundary(options.until);
  const filterAgentId = String(options.agentId || options.agent || '').trim();
  const databasePath = options.databasePath ? String(options.databasePath) : '';

  const messageWhereClauses = ["m.role = 'assistant'", "m.task_id IS NOT NULL", "m.task_id != ''"];
  const params: Record<string, any> = {};

  if (since) {
    messageWhereClauses.push('m.created_at >= @since');
    params.since = since;
  }

  if (until) {
    messageWhereClauses.push('m.created_at < @until');
    params.until = until;
  }

  if (filterAgentId) {
    messageWhereClauses.push('m.agent_id = @agentId');
    params.agentId = filterAgentId;
  }

  const messageWhereSql = messageWhereClauses.join(' AND ');

  const messages = db
    .prepare(
      `
      SELECT
        m.id AS message_id,
        m.conversation_id,
        m.turn_id,
        m.role,
        m.agent_id,
        m.sender_name,
        m.status,
        m.task_id,
        m.metadata_json,
        m.created_at
      FROM chat_messages m
      WHERE ${messageWhereSql}
      ORDER BY m.created_at ASC, m.id ASC
    `
    )
    .all(params);

  const expectationsByTask = new Map();
  const toolCallsByTask = new Map();

  try {
    const events = db
      .prepare(
        `
        SELECT e.task_id, e.event_type, e.event_json, e.created_at
        FROM a2a_task_events e
        WHERE e.event_type IN ('agent_expectations', 'agent_tool_call')
          AND e.task_id IN (
            SELECT DISTINCT m.task_id
            FROM chat_messages m
            WHERE ${messageWhereSql}
          )
        ORDER BY e.created_at ASC, e.id ASC
      `
      )
      .all(params);

    for (const row of Array.isArray(events) ? events : []) {
      const taskId = String(row.task_id || '').trim();
      const eventType = String(row.event_type || '').trim();
      const payload = safeJsonParse(row.event_json);

      if (!taskId || !payload) {
        continue;
      }

      if (eventType === 'agent_expectations') {
        expectationsByTask.set(taskId, payload);
        continue;
      }

      if (eventType === 'agent_tool_call') {
        const existing = toolCallsByTask.get(taskId);
        if (existing) {
          existing.push(payload);
        } else {
          toolCallsByTask.set(taskId, [payload]);
        }
      }
    }
  } catch {
    // Run schema (a2a_task_events) might not exist yet; treat as no events.
  }

  const byAgent = new Map();
  const globalToolCalls: Record<string, any> = {};

  for (const row of Array.isArray(messages) ? messages : []) {
    const agentId = String(row.agent_id || '').trim() || 'unknown';
    const agentName = String(row.sender_name || '').trim();

    const bucket = ensureAgentBucket(byAgent, agentId, agentName);
    bucket.turns += 1;

    if (row.status === 'completed') {
      bucket.turnsCompleted += 1;
    } else if (row.status === 'failed') {
      bucket.turnsFailed += 1;
    }

    const metadata = safeJsonParse(row.metadata_json) || {};
    const publicToolUsed = Boolean(metadata.publicToolUsed);
    const publicPostCount = Number.isInteger(metadata.publicPostCount) ? metadata.publicPostCount : 0;
    const privatePostCount = Number.isInteger(metadata.privatePostCount) ? metadata.privatePostCount : 0;
    const privateHandoffCount = Number.isInteger(metadata.privateHandoffCount) ? metadata.privateHandoffCount : 0;
    const privateToolUsed = privatePostCount > 0;

    if (publicToolUsed) {
      bucket.publicToolUsedTurns += 1;
    }

    if (privateToolUsed) {
      bucket.privateToolUsedTurns += 1;
    }

    bucket.publicPostCount += publicPostCount;
    bucket.privatePostCount += privatePostCount;
    bucket.privateHandoffCount += privateHandoffCount;

    const taskId = String(row.task_id || '').trim();
    const expectations = taskId ? expectationsByTask.get(taskId) : null;
    const expectationMap =
      expectations && expectations.expectations && typeof expectations.expectations === 'object'
        ? expectations.expectations
        : null;

    if (!expectationMap) {
      bucket.missingExpectations += 1;
    } else {
      const expSendPublic = String(expectationMap['send-public'] || '').trim();
      const expSendPrivate = String(expectationMap['send-private'] || '').trim();

      if (expSendPublic === 'required' || expSendPublic === 'forbidden') {
        if (expSendPublic === 'required') {
          bucket.sendPublic.required += 1;
          if (publicToolUsed) {
            bucket.sendPublic.tp += 1;
          } else {
            bucket.sendPublic.fn += 1;
          }
        } else {
          bucket.sendPublic.forbidden += 1;
          if (publicToolUsed) {
            bucket.sendPublic.fp += 1;
          } else {
            bucket.sendPublic.tn += 1;
          }
        }
      }

      if (expSendPrivate === 'required' || expSendPrivate === 'forbidden') {
        if (expSendPrivate === 'required') {
          bucket.sendPrivate.required += 1;
          if (privateToolUsed) {
            bucket.sendPrivate.tp += 1;
          } else {
            bucket.sendPrivate.fn += 1;
          }
        } else {
          bucket.sendPrivate.forbidden += 1;
          if (privateToolUsed) {
            bucket.sendPrivate.fp += 1;
          } else {
            bucket.sendPrivate.tn += 1;
          }
        }
      }
    }

    const toolEvents = taskId ? toolCallsByTask.get(taskId) : null;
    for (const event of Array.isArray(toolEvents) ? toolEvents : []) {
      const toolName = event && event.tool ? String(event.tool) : 'unknown';
      const status = event && event.status ? String(event.status) : '';
      const durationMs = event && Number.isFinite(event.durationMs) ? event.durationMs : null;

      const agentToolBucket = ensureToolBucket(bucket.toolCalls, toolName);
      agentToolBucket.calls += 1;
      if (durationMs !== null) {
        agentToolBucket.durationMs.push(durationMs);
      }
      if (status === 'succeeded') {
        agentToolBucket.succeeded += 1;
      } else if (status === 'failed') {
        agentToolBucket.failed += 1;
      }

      const globalBucket = ensureToolBucket(globalToolCalls, toolName);
      globalBucket.calls += 1;
      if (durationMs !== null) {
        globalBucket.durationMs.push(durationMs);
      }
      if (status === 'succeeded') {
        globalBucket.succeeded += 1;
      } else if (status === 'failed') {
        globalBucket.failed += 1;
      }
    }
  }

  const agentRows = Array.from(byAgent.values()).map((bucket: any) => {
    const sendPublicRequired = bucket.sendPublic.required;
    const sendPublicRecall = sendPublicRequired > 0 ? bucket.sendPublic.tp / sendPublicRequired : null;
    const sendPublicFpr = bucket.sendPublic.forbidden > 0 ? bucket.sendPublic.fp / bucket.sendPublic.forbidden : null;

    const sendPrivateRequired = bucket.sendPrivate.required;
    const sendPrivateRecall = sendPrivateRequired > 0 ? bucket.sendPrivate.tp / sendPrivateRequired : null;

    const tools = Object.values(bucket.toolCalls).map(summarizeToolBucket);

    return {
      agentId: bucket.agentId,
      agentName: bucket.agentName,
      turns: bucket.turns,
      turnsCompleted: bucket.turnsCompleted,
      turnsFailed: bucket.turnsFailed,
      missingExpectations: bucket.missingExpectations,
      toolChatRate: bucket.turns > 0 ? bucket.publicToolUsedTurns / bucket.turns : null,
      privateToolRate: bucket.turns > 0 ? bucket.privateToolUsedTurns / bucket.turns : null,
      publicPostCount: bucket.publicPostCount,
      privatePostCount: bucket.privatePostCount,
      privateHandoffCount: bucket.privateHandoffCount,
      sendPublic: {
        ...bucket.sendPublic,
        recall: sendPublicRecall,
        falsePositiveRate: sendPublicFpr,
      },
      sendPrivate: {
        ...bucket.sendPrivate,
        recall: sendPrivateRecall,
      },
      tools,
    };
  });

  agentRows.sort((a: any, b: any) => (b.turns || 0) - (a.turns || 0));

  const toolRows = Object.values(globalToolCalls)
    .map(summarizeToolBucket)
    .sort((a: any, b: any) => (b.calls || 0) - (a.calls || 0));

  return {
    generatedAt: new Date().toISOString(),
    dbPath: databasePath || null,
    since: since || null,
    until: until || null,
    agentFilter: filterAgentId || null,
    agents: agentRows,
    tools: toolRows,
  };
}

