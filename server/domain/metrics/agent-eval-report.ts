const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_BOUNDARY_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const MAX_METRICS_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

export type MetricsWindowValidationError = {
  message: string;
};

export function validateAgentMetricsWindow(sinceInput: any, untilInput: any): MetricsWindowValidationError | null {
  const since = String(sinceInput || '').trim();
  const until = String(untilInput || '').trim();

  if (!since || !until) {
    return { message: 'Agent metrics require both since and until boundaries' };
  }

  for (const boundary of [
    ['since', since],
    ['until', until],
  ] as const) {
    const [field, raw] = boundary;

    if (!ISO_BOUNDARY_RE.test(raw) || !Number.isFinite(Date.parse(raw))) {
      return {
        message: `Agent metrics ${field} boundary must be a YYYY-MM-DD date or an ISO 8601 datetime: ${raw}`,
      };
    }
  }

  const sinceMs = Date.parse(normalizeIsoBoundary(since));
  const untilMs = Date.parse(normalizeIsoBoundary(until, { exclusiveEndOfDay: true }));
  const spanMs = untilMs - sinceMs;

  if (!(spanMs > 0)) {
    return { message: 'Agent metrics until boundary must be after the since boundary' };
  }

  if (spanMs > MAX_METRICS_WINDOW_MS) {
    return { message: 'Agent metrics window must not exceed 31 days' };
  }

  return null;
}

function normalizeIsoBoundary(value: any, options: any = {}) {
  const raw = String(value || '').trim();

  if (!raw) {
    return '';
  }

  if (DATE_ONLY_RE.test(raw)) {
    if (options.exclusiveEndOfDay) {
      const [year, month, day] = raw.split('-').map((part) => Number(part));
      return new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0)).toISOString();
    }

    return `${raw}T00:00:00.000Z`;
  }

  return raw;
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
  const sinceInput = String(options.since || '').trim();
  const untilInput = String(options.until || '').trim();
  const since = normalizeIsoBoundary(sinceInput);
  const until = normalizeIsoBoundary(untilInput, { exclusiveEndOfDay: true });
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
        m.agent_id AS agent_id,
        m.sender_name AS sender_name,
        m.status AS status,
        m.task_id AS task_id,
        CASE WHEN json_valid(m.metadata_json) THEN json_extract(m.metadata_json, '$.publicToolUsed') END AS public_tool_used,
        CASE WHEN json_valid(m.metadata_json) THEN json_extract(m.metadata_json, '$.publicPostCount') END AS public_post_count,
        CASE WHEN json_valid(m.metadata_json) THEN json_extract(m.metadata_json, '$.privatePostCount') END AS private_post_count,
        CASE WHEN json_valid(m.metadata_json) THEN json_extract(m.metadata_json, '$.privateHandoffCount') END AS private_handoff_count
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
        SELECT
          e.task_id AS task_id,
          e.event_type AS event_type,
          CASE WHEN json_valid(e.event_json) THEN
            CASE json_type(e.event_json)
              WHEN 'object' THEN 1
              WHEN 'array' THEN 1
              WHEN 'true' THEN 1
              WHEN 'text' THEN CASE WHEN length(e.event_json) > 2 THEN 1 ELSE 0 END
              WHEN 'integer' THEN CASE WHEN json_extract(e.event_json, '$') != 0 THEN 1 ELSE 0 END
              WHEN 'real' THEN CASE WHEN json_extract(e.event_json, '$') != 0 THEN 1 ELSE 0 END
              ELSE 0
            END
          ELSE 0 END AS root_truthy,
          CASE WHEN json_valid(e.event_json) THEN json_type(e.event_json, '$.expectations') END AS expectations_type,
          CASE WHEN json_valid(e.event_json) THEN json_extract(e.event_json, '$.expectations."send-public"') END AS send_public,
          CASE WHEN json_valid(e.event_json) THEN json_extract(e.event_json, '$.expectations."send-private"') END AS send_private,
          CASE WHEN json_valid(e.event_json) THEN json_extract(e.event_json, '$.tool') END AS tool,
          CASE WHEN json_valid(e.event_json) THEN json_extract(e.event_json, '$.status') END AS tool_status,
          CASE WHEN json_valid(e.event_json) THEN json_extract(e.event_json, '$.durationMs') END AS tool_duration_ms
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

      if (!taskId || !row.root_truthy) {
        continue;
      }

      if (eventType === 'agent_expectations') {
        expectationsByTask.set(taskId, {
          hasExpectationMap: row.expectations_type === 'object' || row.expectations_type === 'array',
          sendPublic: row.send_public,
          sendPrivate: row.send_private,
        });
        continue;
      }

      if (eventType === 'agent_tool_call') {
        const toolCall = {
          tool: row.tool,
          status: row.tool_status,
          durationMs: row.tool_duration_ms,
        };

        const existing = toolCallsByTask.get(taskId);
        if (existing) {
          existing.push(toolCall);
        } else {
          toolCallsByTask.set(taskId, [toolCall]);
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

    const metadataPublicToolUsed = row.public_tool_used;
    const metadataPublicPostCount = row.public_post_count;
    const metadataPrivatePostCount = row.private_post_count;
    const metadataPrivateHandoffCount = row.private_handoff_count;
    const publicToolUsed = Boolean(metadataPublicToolUsed);
    const publicPostCount = Number.isInteger(metadataPublicPostCount) ? metadataPublicPostCount : 0;
    const privatePostCount = Number.isInteger(metadataPrivatePostCount) ? metadataPrivatePostCount : 0;
    const privateHandoffCount = Number.isInteger(metadataPrivateHandoffCount) ? metadataPrivateHandoffCount : 0;
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
    const expectationMap = expectations && expectations.hasExpectationMap ? expectations : null;

    if (!expectationMap) {
      bucket.missingExpectations += 1;
    } else {
      const expSendPublic = String(expectationMap.sendPublic || '').trim();
      const expSendPrivate = String(expectationMap.sendPrivate || '').trim();

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
    since: sinceInput || null,
    until: untilInput || null,
    agentFilter: filterAgentId || null,
    agents: agentRows,
    tools: toolRows,
  };
}
