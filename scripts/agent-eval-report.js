#!/usr/bin/env node

const path = require('node:path');

const Database = require('better-sqlite3');

function parseArgs(argv) {
  const args = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function sanitizeEnvironmentName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function resolveDefaultAgentDir() {
  const runtimeEnv = sanitizeEnvironmentName(process.env.PI_ENV || '');
  return runtimeEnv ? path.join(process.cwd(), `.pi-sandbox-${runtimeEnv}`) : path.join(process.cwd(), '.pi-sandbox');
}

function resolveDbPath(args) {
  const explicit = args['db-path'] || args.db || args.sqlite || args.database;
  if (explicit) {
    return path.resolve(String(explicit));
  }

  const envOverride = String(process.env.PI_SQLITE_PATH || '').trim();
  if (envOverride) {
    return path.resolve(envOverride);
  }

  const agentDir = String(process.env.PI_CODING_AGENT_DIR || '').trim() || resolveDefaultAgentDir();
  return path.resolve(agentDir, 'pi-state.sqlite');
}

function normalizeIsoBoundary(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) {
    return fallback || '';
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw}T00:00:00.000Z`;
  }

  return raw;
}

function safeJsonParse(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function quantile(values, q) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (clean.length === 0) {
    return null;
  }

  const index = Math.floor((clean.length - 1) * q);
  return clean[index];
}

function ensureAgentBucket(map, agentId, agentName) {
  const normalizedAgentId = String(agentId || '').trim() || 'unknown';
  const existing = map.get(normalizedAgentId);
  if (existing) {
    if (!existing.agentName && agentName) {
      existing.agentName = agentName;
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
    toolCalls: {},
  };

  map.set(normalizedAgentId, bucket);
  return bucket;
}

function ensureToolBucket(toolCalls, toolName) {
  const key = String(toolName || '').trim() || 'unknown';
  if (toolCalls[key]) {
    return toolCalls[key];
  }

  toolCalls[key] = {
    tool: key,
    calls: 0,
    succeeded: 0,
    failed: 0,
    durationMs: [],
  };

  return toolCalls[key];
}

function summarizeToolBucket(bucket) {
  const durations = bucket.durationMs;
  const succeeded = bucket.succeeded;
  const calls = bucket.calls;
  const failed = bucket.failed;

  return {
    tool: bucket.tool,
    calls,
    succeeded,
    failed,
    successRate: calls > 0 ? succeeded / calls : null,
    p50Ms: quantile(durations, 0.5),
    p95Ms: quantile(durations, 0.95),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = resolveDbPath(args);
  const since = normalizeIsoBoundary(args.since, '');
  const until = normalizeIsoBoundary(args.until, '');
  const filterAgentId = String(args.agent || args['agent-id'] || '').trim();
  const jsonOnly = args.json === true;

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  try {
    const whereClauses = ["m.role = 'assistant'", "m.task_id IS NOT NULL", "m.task_id != ''"];
    const params = {};

    if (since) {
      whereClauses.push('m.created_at >= @since');
      params.since = since;
    }

    if (until) {
      whereClauses.push('m.created_at < @until');
      params.until = until;
    }

    if (filterAgentId) {
      whereClauses.push('m.agent_id = @agentId');
      params.agentId = filterAgentId;
    }

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
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY m.created_at ASC, m.id ASC
      `
      )
      .all(params);

    const taskIds = new Set(messages.map((row) => String(row.task_id || '').trim()).filter(Boolean));
    const taskIdList = Array.from(taskIds);

    const expectationsByTask = new Map();
    const toolCallsByTask = new Map();

    if (taskIdList.length > 0) {
      const placeholders = taskIdList.map((_, index) => `@task${index}`).join(', ');
      const eventParams = {};
      taskIdList.forEach((taskId, index) => {
        eventParams[`task${index}`] = taskId;
      });

      const events = db
        .prepare(
          `
          SELECT task_id, event_type, event_json, created_at
          FROM a2a_task_events
          WHERE task_id IN (${placeholders})
            AND event_type IN ('agent_expectations', 'agent_tool_call')
          ORDER BY created_at ASC, id ASC
        `
        )
        .all(eventParams);

      for (const row of events) {
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
    }

    const byAgent = new Map();
    const globalToolCalls = {};

    for (const row of messages) {
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
      const expectationMap = expectations && expectations.expectations && typeof expectations.expectations === 'object' ? expectations.expectations : null;

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

    const agentRows = Array.from(byAgent.values()).map((bucket) => {
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

    agentRows.sort((a, b) => b.turns - a.turns);

    const toolRows = Object.values(globalToolCalls).map(summarizeToolBucket).sort((a, b) => b.calls - a.calls);

    const report = {
      generatedAt: new Date().toISOString(),
      dbPath,
      since: since || null,
      until: until || null,
      agentFilter: filterAgentId || null,
      agents: agentRows,
      tools: toolRows,
    };

    if (jsonOnly) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    process.stdout.write(`DB: ${dbPath}\n`);
    if (since || until) {
      process.stdout.write(`Range: ${since || '-inf'} .. ${until || '+inf'}\n`);
    }
    process.stdout.write(`Agents: ${agentRows.length}\n`);
    process.stdout.write('\n');

    for (const agent of agentRows) {
      const nameSuffix = agent.agentName ? ` (${agent.agentName})` : '';
      process.stdout.write(`- ${agent.agentId}${nameSuffix}: turns=${agent.turns}, toolChatRate=${agent.toolChatRate ?? 'n/a'}\n`);
      if (agent.sendPublic.required > 0 || agent.sendPublic.forbidden > 0) {
        process.stdout.write(
          `  send-public: required=${agent.sendPublic.required}, recall=${agent.sendPublic.recall ?? 'n/a'}, forbidden=${agent.sendPublic.forbidden}, fpr=${agent.sendPublic.falsePositiveRate ?? 'n/a'}\n`
        );
      }
      if (agent.tools.length > 0) {
        const toolSummary = agent.tools
          .slice(0, 5)
          .map((tool) => `${tool.tool} ${tool.succeeded}/${tool.calls}`)
          .join(', ');
        process.stdout.write(`  tool calls: ${toolSummary}${agent.tools.length > 5 ? ', ...' : ''}\n`);
      }
    }

    process.stdout.write('\nTop tools:\n');
    for (const tool of toolRows.slice(0, 10)) {
      process.stdout.write(`- ${tool.tool}: ${tool.succeeded}/${tool.calls} (p50=${tool.p50Ms ?? 'n/a'}ms, p95=${tool.p95Ms ?? 'n/a'}ms)\n`);
    }
  } finally {
    db.close();
  }
}

main();

