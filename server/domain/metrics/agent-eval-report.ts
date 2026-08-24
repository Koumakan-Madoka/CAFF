// YYYY-MM-DD, optionally with THH:mm[:ss[.sss]] and an optional Z or ±hh:mm zone.
const ISO_BOUNDARY_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const MAX_METRICS_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

export type MetricsWindowValidationError = {
  message: string;
};

function boundaryFormatError(field: string, raw: string) {
  return `Agent metrics ${field} boundary must be a YYYY-MM-DD date or an ISO 8601 datetime: ${raw}`;
}

/**
 * Parses a boundary into its canonical UTC instant.
 *
 * All datetime boundaries (Z, ±hh:mm offset, or zone-less) are normalized to
 * a canonical UTC `...Z` instant so SQLite TEXT comparison against persisted
 * UTC created_at values selects rows chronologically: raw offset strings do
 * not share lexical order with UTC strings. Zone-less datetimes are defined
 * as UTC wall-clock time, matching the baseline lexical behavior. Impossible
 * calendar dates (e.g. 2026-02-31) are rejected because Date.parse would
 * silently normalize them via the legacy parser.
 */
function parseIsoBoundaryInstant(raw: string, field: string): { error: string } | { ms: number; dateOnly: boolean } {
  const match = ISO_BOUNDARY_RE.exec(raw);

  if (!match) {
    return { error: boundaryFormatError(field, raw) };
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const calendar = new Date(Date.UTC(year, month - 1, day));

  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    return { error: `Agent metrics ${field} boundary is not a real calendar date: ${raw}` };
  }

  if (hourText === undefined) {
    return { ms: Date.UTC(year, month - 1, day), dateOnly: true };
  }

  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText || '0');

  if (hour > 23 || minute > 59 || second > 59) {
    return { error: boundaryFormatError(field, raw) };
  }

  // Zone-less datetimes are treated as UTC (append Z before parsing).
  const ms = Date.parse(zone ? raw : `${raw}Z`);

  if (!Number.isFinite(ms)) {
    return { error: boundaryFormatError(field, raw) };
  }

  return { ms, dateOnly: false };
}

function boundaryInstantOrThrow(raw: string, field: string): { ms: number; dateOnly: boolean } {
  const parsed = parseIsoBoundaryInstant(raw, field);

  if ('error' in parsed) {
    throw new Error(parsed.error);
  }

  return parsed;
}

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
    const parsed = parseIsoBoundaryInstant(raw, field);

    if ('error' in parsed) {
      return { message: parsed.error };
    }
  }

  const sinceInstant = boundaryInstantOrThrow(since, 'since');
  const untilInstant = boundaryInstantOrThrow(until, 'until');
  const sinceMs = sinceInstant.ms;
  // Date-only until boundaries are inclusive of the whole selected day.
  const untilMs = untilInstant.dateOnly ? untilInstant.ms + 24 * 60 * 60 * 1000 : untilInstant.ms;
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

  // Strictly validated canonical UTC instant for every accepted form
  // (date-only midnight, Z, offset, zone-less-as-UTC) so SQLite TEXT
  // comparison against persisted UTC created_at values stays chronological.
  // Date-only until boundaries are inclusive of the whole selected day.
  const instant = boundaryInstantOrThrow(raw, 'boundary');
  const ms = instant.dateOnly && options.exclusiveEndOfDay
    ? instant.ms + 24 * 60 * 60 * 1000
    : instant.ms;

  return new Date(ms).toISOString();
}

// Compact integer type codes for projected JSON values: small integers are
// cheap in V8 (SMIs) and in the better-sqlite3 row transfer, unlike the
// json_type() strings, which cost ~50 bytes per value and broke the RSS
// budget on production-scale event tables (484k rows x several fields).
const JSON_TYPE_TEXT = 1;
const JSON_TYPE_INTEGER = 2;
const JSON_TYPE_REAL = 3;
const JSON_TYPE_TRUE = 4;
const JSON_TYPE_FALSE = 5;
const JSON_TYPE_OBJECT = 6;
const JSON_TYPE_ARRAY = 7;

function jsonTypeCodeSql(path: string) {
  return 'CASE WHEN json_valid(e.event_json) THEN CASE json_type(e.event_json, ' + `'${path}'` + ') '
    + `WHEN 'text' THEN ${JSON_TYPE_TEXT} `
    + `WHEN 'integer' THEN ${JSON_TYPE_INTEGER} `
    + `WHEN 'real' THEN ${JSON_TYPE_REAL} `
    + `WHEN 'true' THEN ${JSON_TYPE_TRUE} `
    + `WHEN 'false' THEN ${JSON_TYPE_FALSE} `
    + `WHEN 'object' THEN ${JSON_TYPE_OBJECT} `
    + `WHEN 'array' THEN ${JSON_TYPE_ARRAY} `
    + 'ELSE 0 END ELSE 0 END';
}

function jsonIntegerCount(value: any) {
  // Baseline: Number.isInteger(JSON.parse(...)). The SQL projection already
  // gates on json_type IN ('integer', 'real') so JSON booleans (which SQLite
  // folds into 1/0), strings, and objects never reach here; the remaining JS
  // check keeps integral reals (JSON.parse turns 2.0 into the integral 2)
  // and rejects fractional or non-finite numbers.
  return Number.isInteger(value) ? value : 0;
}

function jsonJsValue(typeCode: any, extracted: any) {
  // Reconstructs the JS value behind a projected type-code + json_extract
  // pair so downstream String()/truthiness expressions keep the exact
  // baseline JSON.parse semantics. json_extract folds booleans into 1/0 and
  // objects/arrays into JSON text, none of which coerce like the parsed
  // values did; only the small projected subtree is reparsed for arrays,
  // never the raw event_json column.
  if (typeCode === JSON_TYPE_TEXT || typeCode === JSON_TYPE_INTEGER || typeCode === JSON_TYPE_REAL) {
    return extracted;
  }

  if (typeCode === JSON_TYPE_TRUE) {
    return true;
  }

  if (typeCode === JSON_TYPE_FALSE) {
    return false;
  }

  if (typeCode === JSON_TYPE_OBJECT) {
    return {};
  }

  if (typeCode === JSON_TYPE_ARRAY) {
    try {
      return JSON.parse(extracted);
    } catch {
      return String(extracted);
    }
  }

  return null;
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
        CASE WHEN json_valid(m.metadata_json) THEN CASE WHEN json_type(m.metadata_json, '$.publicPostCount') IN ('integer', 'real') THEN json_extract(m.metadata_json, '$.publicPostCount') END END AS public_post_count,
        CASE WHEN json_valid(m.metadata_json) THEN CASE WHEN json_type(m.metadata_json, '$.privatePostCount') IN ('integer', 'real') THEN json_extract(m.metadata_json, '$.privatePostCount') END END AS private_post_count,
        CASE WHEN json_valid(m.metadata_json) THEN CASE WHEN json_type(m.metadata_json, '$.privateHandoffCount') IN ('integer', 'real') THEN json_extract(m.metadata_json, '$.privateHandoffCount') END END AS private_handoff_count
      FROM chat_messages m
      WHERE ${messageWhereSql}
      ORDER BY m.created_at ASC, m.id ASC
    `
    )
    .all(params);

  const expectationsByTask = new Map();
  const toolCallsByTask = new Map();

  const rootTruthySql = `CASE WHEN json_valid(e.event_json) THEN
            CASE json_type(e.event_json)
              WHEN 'object' THEN 1
              WHEN 'array' THEN 1
              WHEN 'true' THEN 1
              WHEN 'text' THEN CASE WHEN length(e.event_json) > 2 THEN 1 ELSE 0 END
              WHEN 'integer' THEN CASE WHEN json_extract(e.event_json, '$') != 0 THEN 1 ELSE 0 END
              WHEN 'real' THEN CASE WHEN json_extract(e.event_json, '$') != 0 THEN 1 ELSE 0 END
              ELSE 0
            END
          ELSE 0 END`;

  // The two event families are queried separately so each result row carries
  // only the columns its own family needs: a single combined projection would
  // give every one of the production-scale event rows (484k+) property slots
  // for both families' fields, which broke the concurrent-report RSS budget.
  try {
    const expectations = db
      .prepare(
        `
        SELECT
          e.task_id AS task_id,
          ${rootTruthySql} AS root_truthy,
          CASE WHEN json_valid(e.event_json) THEN json_type(e.event_json, '$.expectations') END AS expectations_type,
          CASE WHEN json_valid(e.event_json) THEN json_extract(e.event_json, '$.expectations."send-public"') END AS send_public,
          ${jsonTypeCodeSql('$.expectations."send-public"')} AS send_public_type,
          CASE WHEN json_valid(e.event_json) THEN json_extract(e.event_json, '$.expectations."send-private"') END AS send_private,
          ${jsonTypeCodeSql('$.expectations."send-private"')} AS send_private_type
        FROM a2a_task_events e
        WHERE e.event_type = 'agent_expectations'
          AND e.task_id IN (
            SELECT DISTINCT m.task_id
            FROM chat_messages m
            WHERE ${messageWhereSql}
          )
        ORDER BY e.created_at ASC, e.id ASC
      `
      )
      .all(params);

    for (const row of Array.isArray(expectations) ? expectations : []) {
      const taskId = String(row.task_id || '').trim();

      if (!taskId || !row.root_truthy) {
        continue;
      }

      expectationsByTask.set(taskId, {
        hasExpectationMap: row.expectations_type === 'object' || row.expectations_type === 'array',
        sendPublic: jsonJsValue(row.send_public_type, row.send_public),
        sendPrivate: jsonJsValue(row.send_private_type, row.send_private),
      });
    }

    const toolCalls = db
      .prepare(
        `
        SELECT
          e.task_id AS task_id,
          ${rootTruthySql} AS root_truthy,
          CASE WHEN json_valid(e.event_json) THEN json_extract(e.event_json, '$.tool') END AS tool,
          ${jsonTypeCodeSql('$.tool')} AS tool_type,
          CASE WHEN json_valid(e.event_json) THEN json_extract(e.event_json, '$.status') END AS tool_status,
          ${jsonTypeCodeSql('$.status')} AS tool_status_type,
          CASE WHEN json_valid(e.event_json) THEN CASE WHEN json_type(e.event_json, '$.durationMs') IN ('integer', 'real') THEN json_extract(e.event_json, '$.durationMs') END END AS tool_duration_ms
        FROM a2a_task_events e
        WHERE e.event_type = 'agent_tool_call'
          AND e.task_id IN (
            SELECT DISTINCT m.task_id
            FROM chat_messages m
            WHERE ${messageWhereSql}
          )
        ORDER BY e.created_at ASC, e.id ASC
      `
      )
      .all(params);

    for (const row of Array.isArray(toolCalls) ? toolCalls : []) {
      const taskId = String(row.task_id || '').trim();

      if (!taskId || !row.root_truthy) {
        continue;
      }

      // durationMs is type-gated in SQL (JSON numbers only); booleans and
      // strings never reach the JS Number.isFinite check below, matching the
      // baseline JSON.parse semantics.
      const toolCall = {
        tool: jsonJsValue(row.tool_type, row.tool),
        status: jsonJsValue(row.tool_status_type, row.tool_status),
        durationMs: row.tool_duration_ms,
      };

      const existing = toolCallsByTask.get(taskId);
      if (existing) {
        existing.push(toolCall);
      } else {
        toolCallsByTask.set(taskId, [toolCall]);
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
    const publicToolUsed = Boolean(metadataPublicToolUsed);
    // Integer-typed counts gated on json_type keep the baseline
    // Number.isInteger(JSON.parse(...)) semantics (booleans never count,
    // integral reals do).
    const publicPostCount = jsonIntegerCount(row.public_post_count);
    const privatePostCount = jsonIntegerCount(row.private_post_count);
    const privateHandoffCount = jsonIntegerCount(row.private_handoff_count);
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
