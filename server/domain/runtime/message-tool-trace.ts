import fs from 'node:fs';
import path from 'node:path';

import { isPathWithin } from '../conversation/turn/session-export';
import { normalizeObservabilityTimeline } from '../../../lib/observability-timeline';
import { summarizeModelUsageCalls } from './token-usage';

const MAX_TOOL_EVENT_COUNT = 200;
const MAX_PREVIEW_LENGTH = 240;
const MAX_COLLECTION_ITEMS = 8;
const MAX_SUMMARY_DEPTH = 4;

function clipText(text: any, maxLength = MAX_PREVIEW_LENGTH) {
  const value = String(text || '');

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function safeJsonParse(value: any) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeSessionContentType(value: any) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
}

function normalizeToolStatus(value: any) {
  const normalized = String(value || '').trim().toLowerCase();

  if (normalized === 'succeeded' || normalized === 'completed' || normalized === 'ok') {
    return 'succeeded';
  }

  if (normalized === 'failed' || normalized === 'error' || normalized === 'timeout') {
    return 'failed';
  }

  if (normalized === 'running' || normalized === 'queued' || normalized === 'pending') {
    return normalized;
  }

  return normalized || 'observed';
}

function isSensitiveKey(key: any) {
  const normalized = String(key || '')
    .trim()
    .toLowerCase();

  if (!normalized) {
    return false;
  }

  return [
    'authorization',
    'cookie',
    'token',
    'secret',
    'password',
    'passwd',
    'api_key',
    'apikey',
    'access_key',
    'client_secret',
    'callbacktoken',
  ].some((part) => normalized.includes(part));
}

function extractJsonStyleKey(segment: any) {
  const match = String(segment || '').match(/(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*:\s*$/);

  if (!match) {
    return '';
  }

  return String(match[1] || match[2] || match[3] || '').trim();
}

function redactJsonStyleSecrets(value: any) {
  return String(value || '').replace(
    /((?:"[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\]]*)/g,
    (match, prefix) => {
      const key = extractJsonStyleKey(prefix);

      if (!isSensitiveKey(key)) {
        return match;
      }

      return `${prefix}"[redacted]"`;
    }
  );
}

function redactJsonContainer(value: any, options: any = {}) {
  const text = String(value || '').trim();

  if (!text || (text[0] !== '{' && text[0] !== '[')) {
    return '';
  }

  const parsed = safeJsonParse(text);

  if (!parsed || typeof parsed !== 'object') {
    return '';
  }

  try {
    return JSON.stringify(summarizeValue(parsed, options));
  } catch {
    return '';
  }
}

function toPortablePath(value: string) {
  return String(value || '').replace(/\\/g, '/');
}

function normalizeVisiblePathRoots(options: any = {}) {
  const roots = Array.isArray(options.visiblePathRoots)
    ? options.visiblePathRoots
    : Array.isArray(options.visibleRoots)
      ? options.visibleRoots
      : [];
  const normalized = new Set<string>();

  for (const entry of roots) {
    const raw = String(entry || '').trim();

    if (!raw) {
      continue;
    }

    const portable = toPortablePath(raw).replace(/\/+$/g, '');
    if (portable) {
      normalized.add(portable);
    }

    try {
      const resolved = toPortablePath(path.resolve(raw)).replace(/\/+$/g, '');
      if (resolved) {
        normalized.add(resolved);
      }
    } catch {}
  }

  return Array.from(normalized).sort((left, right) => right.length - left.length);
}

function previewAbsolutePath(value: any, options: any = {}) {
  const rawValue = String(value || '').trim();

  if (!rawValue) {
    return '';
  }

  const portableValue = toPortablePath(rawValue);
  const portableComparableValue = portableValue.replace(/\/+$/g, '');
  const visibleRoots = normalizeVisiblePathRoots(options);
  const compareValue = process.platform === 'win32' ? portableComparableValue.toLowerCase() : portableComparableValue;

  for (const root of visibleRoots) {
    const compareRoot = process.platform === 'win32' ? root.toLowerCase() : root;

    if (compareValue === compareRoot || compareValue.startsWith(`${compareRoot}/`)) {
      return portableValue;
    }
  }

  const roots = [process.cwd(), options.agentDir]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .map((entry) => toPortablePath(path.resolve(entry)).replace(/\/+$/g, ''))
    .sort((left, right) => right.length - left.length);

  for (const root of roots) {
    const compareRoot = process.platform === 'win32' ? root.toLowerCase() : root;

    if (compareValue === compareRoot) {
      return '.';
    }

    if (compareValue.startsWith(`${compareRoot}/`)) {
      return `./${portableValue.slice(root.length + 1)}`;
    }
  }

  const segments = portableValue.split('/').filter(Boolean);

  if (segments.length >= 2) {
    return `<path:.../${segments.slice(-2).join('/')}>`;
  }

  if (segments.length === 1) {
    return `<path:${segments[0]}>`;
  }

  return '<path>';
}

function redactString(value: any, options: any = {}) {
  let text = String(value || '');

  if (!text) {
    return '';
  }

  const jsonRedacted = redactJsonContainer(text, options);

  if (jsonRedacted) {
    text = jsonRedacted;
  }

  text = redactJsonStyleSecrets(text);
  text = text.replace(/(authorization\s*[:=]\s*bearer\s+)([^\s,;]+)/gi, '$1[redacted]');
  text = text.replace(/(authorization\s*[:=]\s*)([^\s,;]+)/gi, '$1[redacted]');
  text = text.replace(/\b(bearer)\s+([A-Za-z0-9._~+/=-]+)/gi, '$1 [redacted]');
  text = text.replace(
    /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_?KEY|ACCESS_?KEY|AUTHORIZATION)[A-Z0-9_]*)=([^\s]+)/g,
    '$1=[redacted]'
  );
  text = text.replace(/[A-Za-z]:[\\/][^\s"'`]+/g, (match) => previewAbsolutePath(match, options) || '<path>');
  text = text.replace(/(?:^|[\s"'=])(\/(?:[^\s"'`]+\/?)+)/g, (match, matchedPath) => {
    const preview = previewAbsolutePath(matchedPath, options) || '<path>';
    return match.replace(matchedPath, preview);
  });

  return clipText(text);
}

function summarizeValue(value: any, options: any = {}, depth = 0, keyHint = ''): any {
  if (value == null) {
    return value;
  }

  if (typeof value === 'string') {
    if (isSensitiveKey(keyHint)) {
      return '[redacted]';
    }

    if (/(^|[\\/])[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+$/.test(value) && path.isAbsolute(value)) {
      return previewAbsolutePath(value, options) || '<path>';
    }

    return redactString(value, options);
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_SUMMARY_DEPTH) {
      return value.length > 0 ? [`[${value.length} items]`] : [];
    }

    const summarized = value
      .slice(0, MAX_COLLECTION_ITEMS)
      .map((entry) => summarizeValue(entry, options, depth + 1, keyHint))
      .filter((entry) => entry !== undefined);

    if (value.length > MAX_COLLECTION_ITEMS) {
      summarized.push(`[+${value.length - MAX_COLLECTION_ITEMS} more]`);
    }

    return summarized;
  }

  if (typeof value === 'object') {
    if (depth >= MAX_SUMMARY_DEPTH) {
      return '[object]';
    }

    const entries = Object.entries(value).slice(0, MAX_COLLECTION_ITEMS);
    const summarized: Record<string, unknown> = {};

    for (const [key, entry] of entries) {
      summarized[key] = summarizeValue(entry, options, depth + 1, key);
    }

    if (Object.keys(value).length > entries.length) {
      summarized.__truncated = `+${Object.keys(value).length - entries.length} keys`;
    }

    return summarized;
  }

  return clipText(String(value));
}

export function readSessionAssistantSnapshot(sessionPath: any, agentDir: any) {
  const pathValue = String(sessionPath || '').trim();
  const baseDir = String(agentDir || '').trim();

  if (!pathValue || !baseDir) {
    return null;
  }

  const sessionsDir = path.resolve(baseDir, 'named-sessions');
  const resolvedPath = path.resolve(pathValue);

  if (!isPathWithin(sessionsDir, resolvedPath)) {
    return null;
  }

  let text = '';

  try {
    if (!fs.existsSync(resolvedPath)) {
      return null;
    }

    text = fs.readFileSync(resolvedPath, 'utf8');
  } catch {
    return null;
  }

  const lines = text.split(/\r?\n/);
  const thinkingParts: string[] = [];
  const textParts: string[] = [];
  const toolCalls: any[] = [];
  const modelCalls: any[] = [];
  const assistantErrors: string[] = [];
  let assistantMessageTotal = 0;
  let lastAssistant: any = null;

  for (const line of lines) {
    const trimmed = String(line || '').trim();

    if (!trimmed) {
      continue;
    }

    const entry = safeJsonParse(trimmed);

    if (!entry || entry.type !== 'message' || !entry.message || entry.message.role !== 'assistant') {
      continue;
    }

    const message = entry.message;
    assistantMessageTotal += 1;
    lastAssistant = message;

    let modelCallSequence: number | null = null;

    if (message.usage && typeof message.usage === 'object' && !Array.isArray(message.usage)) {
      modelCallSequence = modelCalls.length + 1;
      modelCalls.push({
        key: message.responseId ? String(message.responseId) : `assistant:${assistantMessageTotal}`,
        responseId: message.responseId ? String(message.responseId) : '',
        stopReason: message.stopReason ? String(message.stopReason) : '',
        timestamp: message.timestamp !== undefined ? message.timestamp : null,
        usage: message.usage,
      });
    }

    if (message.stopReason === 'error' && message.errorMessage) {
      assistantErrors.push(String(message.errorMessage));
    }

    const content = Array.isArray(message.content) ? message.content : [];

    for (const item of content) {
      const type = normalizeSessionContentType(item && item.type ? item.type : '');

      if (type === 'thinking') {
        const thinkingText = item && item.thinking ? String(item.thinking) : '';
        if (thinkingText) {
          thinkingParts.push(thinkingText);
        }
        continue;
      }

      if (type === 'text') {
        const chunk = item && item.text ? String(item.text) : '';
        if (chunk) {
          textParts.push(chunk);
        }
        continue;
      }

      if (
        type === 'tool_call' ||
        type === 'toolcall' ||
        type === 'tool_use' ||
        type === 'tooluse'
      ) {
        toolCalls.push({
          toolCallId: item && item.id ? String(item.id) : '',
          toolName: item && item.name ? String(item.name) : '',
          arguments: item && item.arguments !== undefined ? item.arguments : null,
          partialJson: item && item.partialJson ? String(item.partialJson) : '',
          assistantMessageIndex: assistantMessageTotal,
          modelCallSequence,
        });
      }
    }
  }

  return {
    sessionPath: resolvedPath,
    assistantMessageTotal,
    stopReason: lastAssistant && lastAssistant.stopReason ? String(lastAssistant.stopReason) : '',
    errorMessage: lastAssistant && lastAssistant.errorMessage ? String(lastAssistant.errorMessage) : '',
    api: lastAssistant && lastAssistant.api ? String(lastAssistant.api) : '',
    provider: lastAssistant && lastAssistant.provider ? String(lastAssistant.provider) : '',
    model: lastAssistant && lastAssistant.model ? String(lastAssistant.model) : '',
    responseId: lastAssistant && lastAssistant.responseId ? String(lastAssistant.responseId) : '',
    timestamp: lastAssistant && lastAssistant.timestamp !== undefined ? lastAssistant.timestamp : null,
    usage: lastAssistant && lastAssistant.usage && typeof lastAssistant.usage === 'object' ? lastAssistant.usage : null,
    thinking: thinkingParts.filter(Boolean).join('\n\n---\n\n'),
    text: textParts.filter(Boolean).join(''),
    toolCalls,
    modelCalls,
    assistantErrors,
  };
}

function loadTaskRow(db: any, taskId: string) {
  if (!db || !taskId) {
    return null;
  }

  try {
    return db
      .prepare(
        `
        SELECT
          id,
          status,
          run_id,
          session_path,
          requested_session,
          output_text,
          error_message,
          metadata_json,
          started_at,
          ended_at,
          updated_at
        FROM a2a_tasks
        WHERE id = @taskId
      `
      )
      .get({ taskId });
  } catch {
    return null;
  }
}

function loadRunRow(db: any, runId: any) {
  if (!db || !runId) {
    return null;
  }

  try {
    return db
      .prepare(
        `
        SELECT id, status, assistant_errors_json
        FROM runs
        WHERE id = @runId
      `
      )
      .get({ runId });
  } catch {
    return null;
  }
}

function loadExpectedCompletionEvent(db: any, taskId: string) {
  if (!db || !taskId) {
    return null;
  }

  try {
    const rows = db
      .prepare(
        `
        SELECT event_json, created_at
        FROM a2a_task_events
        WHERE task_id = @taskId
          AND event_type = 'agent_reply_terminating'
        ORDER BY id DESC
        LIMIT 16
      `
      )
      .all({ taskId });

    for (const row of rows) {
      const payload = safeJsonParse(row && row.event_json ? row.event_json : null);

      if (payload && payload.type === 'expected_completion') {
        return {
          createdAt: row && row.created_at ? String(row.created_at).trim() : '',
          payload,
        };
      }
    }
  } catch {}

  return null;
}

function loadToolEventRows(db: any, taskId: string) {
  if (!db || !taskId) {
    return [];
  }

  try {
    return db
      .prepare(
        `
        SELECT id, event_json, created_at
        FROM a2a_task_events
        WHERE task_id = @taskId
          AND event_type = 'agent_tool_call'
          AND (
            id = (
              SELECT MIN(id) FROM a2a_task_events
              WHERE task_id = @taskId AND event_type = 'agent_tool_call'
            )
            OR id IN (
              SELECT id FROM a2a_task_events
              WHERE task_id = @taskId AND event_type = 'agent_tool_call'
              ORDER BY id DESC
              LIMIT ${MAX_TOOL_EVENT_COUNT - 1}
            )
          )
        ORDER BY id ASC
      `
      )
      .all({ taskId });
  } catch {
    return [];
  }
}

function loadToolEventStats(db: any, taskId: string) {
  if (!db || !taskId) {
    return { totalCount: 0, failedCount: 0, succeededCount: 0, totalDurationMs: 0 };
  }
  try {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS total_count,
        SUM(CASE WHEN lower(json_extract(event_json, '$.status')) IN ('failed', 'error', 'timeout') THEN 1 ELSE 0 END) AS failed_count,
        SUM(CASE WHEN lower(json_extract(event_json, '$.status')) IN ('succeeded', 'completed', 'ok') THEN 1 ELSE 0 END) AS succeeded_count,
        SUM(CASE WHEN json_type(event_json, '$.durationMs') IN ('integer', 'real') THEN json_extract(event_json, '$.durationMs') ELSE 0 END) AS total_duration_ms
      FROM a2a_task_events
      WHERE task_id = @taskId AND event_type = 'agent_tool_call'
    `).get({ taskId });
    return {
      totalCount: Number(row && row.total_count || 0),
      failedCount: Number(row && row.failed_count || 0),
      succeededCount: Number(row && row.succeeded_count || 0),
      totalDurationMs: Number(row && row.total_duration_ms || 0),
    };
  } catch {
    return { totalCount: 0, failedCount: 0, succeededCount: 0, totalDurationMs: 0 };
  }
}

const BRIDGE_COMMAND_HINTS = [
  { token: 'send-public', toolName: 'send-public' },
  { token: 'send-private', toolName: 'send-private' },
  { token: 'read-context', toolName: 'read-context' },
  { token: 'list-participants', toolName: 'participants' },
  { token: 'suggest-goal', toolName: 'suggest-goal' },
  { token: 'update-goal-checklist', toolName: 'update-goal-checklist' },
  { token: 'trellis-init', toolName: 'trellis-init' },
  { token: 'trellis-write', toolName: 'trellis-write' },
];

function normalizeToolNameKey(value: any) {
  return String(value || '').trim().toLowerCase();
}

function inferBridgeToolNameFromSessionCall(toolCall: any) {
  const toolName = normalizeToolNameKey(toolCall && toolCall.toolName ? toolCall.toolName : '');

  if (toolName !== 'bash') {
    return '';
  }

  const command = normalizeToolNameKey(
    toolCall && toolCall.arguments && toolCall.arguments.command ? toolCall.arguments.command : ''
  );

  if (!command) {
    return '';
  }

  for (const candidate of BRIDGE_COMMAND_HINTS) {
    if (command.includes(candidate.token)) {
      return candidate.toolName;
    }
  }

  return '';
}

function normalizeSessionToolCall(toolCall: any, index: number, options: any = {}) {
  const bridgeToolHint = inferBridgeToolNameFromSessionCall(toolCall);
  const toolCallId = String(toolCall && toolCall.toolCallId ? toolCall.toolCallId : '').trim();

  return {
    stepId: toolCallId ? `session-${toolCallId}` : `session-${index + 1}`,
    kind: 'session',
    toolCallId,
    toolName: String(toolCall && toolCall.toolName ? toolCall.toolName : '').trim() || 'tool',
    status: 'observed',
    requestSummary:
      toolCall && toolCall.arguments !== undefined ? summarizeValue(toolCall.arguments, options, 0, 'arguments') : null,
    partialJson:
      toolCall && toolCall.partialJson ? clipText(redactString(toolCall.partialJson, options), 360) : '',
    bridgeToolHint,
    modelCallSequence: Number.isFinite(Number(toolCall && toolCall.modelCallSequence))
      ? Number(toolCall.modelCallSequence)
      : null,
    assistantMessageIndex: Number.isFinite(Number(toolCall && toolCall.assistantMessageIndex))
      ? Number(toolCall.assistantMessageIndex)
      : null,
  };
}

export function createLiveSessionToolStep(toolCall: any, options: any = {}) {
  const index = Number.isInteger(options.index) && Number(options.index) >= 0 ? Number(options.index) : 0;
  const normalized = normalizeSessionToolCall(
    {
      toolCallId: toolCall && toolCall.toolCallId ? toolCall.toolCallId : toolCall && toolCall.id ? toolCall.id : '',
      toolName: toolCall && toolCall.toolName ? toolCall.toolName : toolCall && toolCall.name ? toolCall.name : '',
      arguments: toolCall && toolCall.arguments !== undefined ? toolCall.arguments : null,
      partialJson: toolCall && toolCall.partialJson ? toolCall.partialJson : '',
    },
    index,
    options
  );

  return {
    ...normalized,
    status: normalizeToolStatus(options.status || 'running'),
    createdAt: String(options.createdAt || '').trim() || new Date().toISOString(),
  };
}

function normalizeBridgeToolEvent(row: any, options: any = {}) {
  const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : null;

  if (!payload) {
    return null;
  }

  return {
    stepId: String(payload.toolCallId || (row && row.id ? `bridge-event-${row.id}` : row.createdAt) || randomStepId(payload.tool || 'tool')).trim(),
    kind: 'bridge',
    toolCallId: String(payload.toolCallId || '').trim(),
    toolName: String(payload.tool || payload.toolName || '').trim() || 'tool',
    status: normalizeToolStatus(payload.status),
    durationMs: Number.isFinite(payload.durationMs) ? Number(payload.durationMs) : null,
    createdAt: row && row.createdAt ? String(row.createdAt).trim() : '',
    requestSummary: payload.request !== undefined ? summarizeValue(payload.request, options, 0, 'request') : null,
    resultSummary: payload.result !== undefined ? summarizeValue(payload.result, options, 0, 'result') : null,
    errorSummary: payload.error !== undefined ? summarizeValue(payload.error, options, 0, 'error') : null,
  };
}

export function createLiveBridgeToolStep(payload: any, options: any = {}) {
  return normalizeBridgeToolEvent(
    {
      createdAt: String(options.createdAt || '').trim() || new Date().toISOString(),
      payload,
    },
    options
  );
}

function randomStepId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildMergedTimelineSteps(sessionToolCalls: any[], bridgeToolEvents: any[]) {
  const sessionSteps = Array.isArray(sessionToolCalls) ? sessionToolCalls : [];
  const bridgeSteps = Array.isArray(bridgeToolEvents) ? bridgeToolEvents : [];
  const remainingBridgeByTool = new Map();
  const matchedBridgeStepIds = new Set();
  const timelineSteps: any[] = [];

  for (const bridgeStep of bridgeSteps) {
    const key = normalizeToolNameKey(bridgeStep && bridgeStep.toolName ? bridgeStep.toolName : '');

    if (!key) {
      continue;
    }

    const bucket = remainingBridgeByTool.get(key);

    if (bucket) {
      bucket.push(bridgeStep);
      continue;
    }

    remainingBridgeByTool.set(key, [bridgeStep]);
  }

  for (const sessionStep of sessionSteps) {
    const bridgeKey = normalizeToolNameKey(sessionStep && sessionStep.bridgeToolHint ? sessionStep.bridgeToolHint : '');
    const bucket = bridgeKey ? remainingBridgeByTool.get(bridgeKey) : null;
    const matchedBridgeStep = bucket && bucket.length > 0 ? bucket.shift() : null;
    const normalizedSessionStep =
      matchedBridgeStep && !sessionStep.createdAt && matchedBridgeStep.createdAt
        ? {
            ...sessionStep,
            createdAt: matchedBridgeStep.createdAt,
          }
        : sessionStep;

    timelineSteps.push(normalizedSessionStep);

    if (!matchedBridgeStep) {
      continue;
    }

    matchedBridgeStepIds.add(matchedBridgeStep.stepId);
    timelineSteps.push({
      ...matchedBridgeStep,
      linkedFromStepId: normalizedSessionStep.stepId,
      linkedFromToolName: normalizedSessionStep.toolName,
      modelCallSequence: normalizedSessionStep.modelCallSequence || null,
      assistantMessageIndex: normalizedSessionStep.assistantMessageIndex || null,
    });
  }

  for (const bridgeStep of bridgeSteps) {
    const stepId = String(bridgeStep && bridgeStep.stepId ? bridgeStep.stepId : '').trim();

    if (stepId && matchedBridgeStepIds.has(stepId)) {
      continue;
    }

    timelineSteps.push(bridgeStep);
  }

  return timelineSteps.map((step, index) => ({
    ...step,
    timelineIndex: index,
  }));
}

function normalizePositiveSequence(value: any) {
  const sequence = Number(value);

  if (!Number.isFinite(sequence) || sequence <= 0) {
    return null;
  }

  return Math.round(sequence);
}

function buildTraceTimelineEvents(modelUsage: any, steps: any[]) {
  const normalizedSteps = Array.isArray(steps) ? steps.filter(Boolean) : [];
  const modelCalls = modelUsage && Array.isArray(modelUsage.calls) ? modelUsage.calls : [];
  const timelineEvents: any[] = [];
  const usedToolIndexes = new Set<number>();

  for (const call of modelCalls) {
    const sequence = normalizePositiveSequence(call && call.sequence);

    if (!sequence) {
      continue;
    }

    timelineEvents.push({
      eventType: 'model_call',
      stepId: `model-call-${sequence}`,
      modelCallSequence: sequence,
      sequence,
      index: call.index,
      key: call.key,
      responseId: call.responseId,
      stopReason: call.stopReason,
      timestamp: call.timestamp,
      coldStart: call.coldStart,
      isColdStart: call.isColdStart,
      providerMiss: call.providerMiss,
      tokenUsage: call.tokenUsage,
    });

    normalizedSteps.forEach((step, index) => {
      if (usedToolIndexes.has(index)) {
        return;
      }

      if (normalizePositiveSequence(step && step.modelCallSequence) !== sequence) {
        return;
      }

      usedToolIndexes.add(index);
      timelineEvents.push({
        ...step,
        eventType: 'tool_execution',
        toolExecutionSequence: index + 1,
      });
    });
  }

  // Defensive fallback for legacy or partially written traces: unmatched tools
  // remain visible at the end rather than disappearing from the timeline.
  normalizedSteps.forEach((step, index) => {
    if (usedToolIndexes.has(index)) {
      return;
    }

    timelineEvents.push({
      ...step,
      eventType: 'tool_execution',
      toolExecutionSequence: index + 1,
    });
  });

  return timelineEvents.map((event, index) => {
    const timelineSequence = index + 1;
    const eventId = event.eventType === 'model_call'
      ? `model-call:${String(event.responseId || event.key || event.modelCallSequence || timelineSequence)}`
      : `tool:${String(event.kind || 'session')}:${String(event.stepId || event.toolCallId || timelineSequence).replace(/^session-/u, '')}`;
    return {
      ...event,
      eventId,
      timelineSequence,
      timelineIndex: index,
    };
  });
}

function buildTraceSummary(task: any, message: any, sessionToolCalls: any[], bridgeToolEvents: any[], modelUsage: any = null, bridgeStats: any = null) {
  const failedBridgeSteps = bridgeToolEvents.filter((event) => event && event.status === 'failed');
  const succeededBridgeSteps = bridgeToolEvents.filter((event) => event && event.status === 'succeeded');
  const totalBridgeCount = bridgeStats ? Number(bridgeStats.totalCount || 0) : bridgeToolEvents.length;
  const failedBridgeCount = bridgeStats ? Number(bridgeStats.failedCount || 0) : failedBridgeSteps.length;
  const succeededBridgeCount = bridgeStats ? Number(bridgeStats.succeededCount || 0) : succeededBridgeSteps.length;
  const totalDurationMs = bridgeStats ? Number(bridgeStats.totalDurationMs || 0) : bridgeToolEvents.reduce((sum, event) => {
    const nextDuration = Number.isFinite(event && event.durationMs) ? Number(event.durationMs) : 0;
    return sum + nextDuration;
  }, 0);
  const retryFingerprints = new Map();
  let retryCount = 0;

  for (const event of bridgeToolEvents) {
    const fingerprint = JSON.stringify([event.toolName, event.requestSummary || null]);
    const nextCount = (retryFingerprints.get(fingerprint) || 0) + 1;
    retryFingerprints.set(fingerprint, nextCount);
  }

  for (const count of retryFingerprints.values()) {
    if (count > 1) {
      retryCount += count - 1;
    }
  }

  const messageStatus = String(message && message.status ? message.status : '').trim().toLowerCase();
  const taskStatus = String(task && task.status ? task.status : '').trim().toLowerCase();
  const running =
    messageStatus === 'queued' ||
    messageStatus === 'streaming' ||
    taskStatus === 'queued' ||
    taskStatus === 'running';
  const failed = failedBridgeSteps.length > 0 || messageStatus === 'failed' || taskStatus === 'failed';

  const totalSteps = sessionToolCalls.length + totalBridgeCount;

  return {
    // Legacy alias for toolExecutionCount; keep for existing API consumers.
    totalSteps,
    toolExecutionCount: totalSteps,
    sessionToolCount: sessionToolCalls.length,
    bridgeToolCount: totalBridgeCount,
    failedSteps: failedBridgeCount,
    succeededSteps: succeededBridgeCount,
    totalDurationMs,
    retryCount,
    hasRetries: retryCount > 0,
    modelCallCount: modelUsage && Number.isFinite(modelUsage.modelCallCount) ? Number(modelUsage.modelCallCount) : 0,
    coldStartModelCallCount: modelUsage && Number.isFinite(modelUsage.coldStartModelCallCount) ? Number(modelUsage.coldStartModelCallCount) : 0,
    postColdModelCallCount: modelUsage && Number.isFinite(modelUsage.postColdModelCallCount) ? Number(modelUsage.postColdModelCallCount) : 0,
    providerMissCount: modelUsage && Number.isFinite(modelUsage.providerMissCount) ? Number(modelUsage.providerMissCount) : 0,
    status: failed ? 'failed' : running ? 'running' : totalSteps > 0 ? 'succeeded' : 'idle',
  };
}

function buildTraceActivity(summary: any, steps: any[]) {
  const normalizedSteps = Array.isArray(steps) ? steps.filter(Boolean) : [];
  const status = String(summary && summary.status ? summary.status : '').trim().toLowerCase() || 'idle';
  const explicitRunningStep =
    normalizedSteps
      .slice()
      .reverse()
      .find((step) => {
        const stepStatus = normalizeToolStatus(step && step.status ? step.status : '');
        return stepStatus === 'running' || stepStatus === 'queued';
      }) || null;

  if (explicitRunningStep) {
    const toolName = String(explicitRunningStep.toolName || '').trim();

    return {
      status,
      hasCurrentTool: Boolean(toolName),
      currentToolName: toolName,
      currentStepId: String(explicitRunningStep.stepId || '').trim(),
      currentStepKind: String(explicitRunningStep.kind || '').trim(),
      inferred: false,
      label: toolName ? `当前工具：${toolName}` : '',
    };
  }

  if (status !== 'running') {
    return {
      status,
      hasCurrentTool: false,
      currentToolName: '',
      currentStepId: '',
      currentStepKind: '',
      inferred: false,
      label: '',
    };
  }

  const lastStep = normalizedSteps.length > 0 ? normalizedSteps[normalizedSteps.length - 1] : null;
  const inferredToolName = String(
    lastStep && (lastStep.bridgeToolHint || lastStep.toolName) ? lastStep.bridgeToolHint || lastStep.toolName : ''
  ).trim();

  if (!lastStep || !inferredToolName || lastStep.kind !== 'session') {
    return {
      status,
      hasCurrentTool: false,
      currentToolName: '',
      currentStepId: '',
      currentStepKind: '',
      inferred: false,
      label: '',
    };
  }

  return {
    status,
    hasCurrentTool: true,
    currentToolName: inferredToolName,
    currentStepId: String(lastStep.stepId || '').trim(),
    currentStepKind: String(lastStep.bridgeToolHint ? 'bridge' : lastStep.kind || 'session').trim(),
    inferred: true,
    label: `当前工具：${inferredToolName}`,
  };
}

function formatFailureContextValue(value: any, maxLength = 1200) {
  if (value == null || value === '') {
    return '';
  }

  if (Array.isArray(value)) {
    const filtered = value.filter((entry) => entry !== undefined && entry !== null && entry !== '');

    if (filtered.length === 0) {
      return '';
    }

    value = filtered;
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value);

    if (keys.length === 0) {
      return '';
    }
  }

  if (typeof value === 'string') {
    return clipText(value, maxLength);
  }

  try {
    return clipText(JSON.stringify(value, null, 2), maxLength);
  } catch {
    return clipText(String(value), maxLength);
  }
}

function isExpectedCompletionAbortNoise(options: any = {}) {
  const messageStatus = String(options.messageStatus || '').trim().toLowerCase();
  const taskStatus = String(options.taskStatus || '').trim().toLowerCase();
  const sessionStopReason = String(options.sessionStopReason || '').trim().toLowerCase();
  const sessionErrorText = String(options.sessionErrorText || '').trim().toLowerCase();
  const assistantErrorsText = String(options.assistantErrorsText || '').trim().toLowerCase();
  const messageCompleted = messageStatus === 'completed';
  const taskSucceeded = taskStatus === 'succeeded' || taskStatus === 'completed';
  const abortError = sessionErrorText.replace(/[.!]+$/u, '') === 'request was aborted';

  return (
    messageCompleted &&
    taskSucceeded &&
    sessionStopReason === 'aborted' &&
    abortError &&
    !assistantErrorsText
  );
}

function isResolvedAssistantRetryHistory(options: any = {}) {
  const messageStatus = String(options.messageStatus || '').trim().toLowerCase();
  const taskStatus = String(options.taskStatus || '').trim().toLowerCase();
  const sessionStopReason = String(options.sessionStopReason || '').trim().toLowerCase();
  const sessionErrorText = String(options.sessionErrorText || '').trim();
  const assistantErrorsText = String(options.assistantErrorsText || '').trim();

  return (
    messageStatus === 'completed' &&
    (taskStatus === 'succeeded' || taskStatus === 'completed') &&
    (sessionStopReason === 'stop' || sessionStopReason === 'length') &&
    !sessionErrorText &&
    Boolean(assistantErrorsText)
  );
}

function isAuthoritativeExpectedCompletionTailResolved(options: any = {}) {
  const messageStatus = String(options.messageStatus || '').trim().toLowerCase();
  const taskStatus = String(options.taskStatus || '').trim().toLowerCase();
  const runStatus = String(options.runStatus || '').trim().toLowerCase();
  const runAssistantErrors = options.runAssistantErrors;
  const terminationType = String(
    options.expectedCompletionEvent && options.expectedCompletionEvent.payload
      ? options.expectedCompletionEvent.payload.type
      : ''
  ).trim().toLowerCase();

  return (
    messageStatus === 'completed' &&
    (taskStatus === 'succeeded' || taskStatus === 'completed') &&
    runStatus === 'succeeded' &&
    Array.isArray(runAssistantErrors) &&
    runAssistantErrors.length === 0 &&
    terminationType === 'expected_completion'
  );
}

function conciseFailureSummary(value: any, fallback = '') {
  const formatted = formatFailureContextValue(value, 360);

  if (!formatted) {
    return fallback;
  }

  return clipText(formatted.replace(/\s+/gu, ' ').trim(), 240);
}

function buildTraceFailureContext(options: any = {}) {
  const message = options.message && typeof options.message === 'object' ? options.message : null;
  const task = options.task && typeof options.task === 'object' ? options.task : null;
  const session = options.session && typeof options.session === 'object' ? options.session : null;
  const steps: any[] = Array.isArray(options.steps) ? options.steps : [];
  const failedStep = steps.find((step: any) => step && step.status === 'failed') || null;
  const messageStatus = String(message && message.status ? message.status : '').trim().toLowerCase();
  const taskStatus = String(task && task.status ? task.status : '').trim().toLowerCase();
  const sessionStopReason = String(session && session.stopReason ? session.stopReason : '').trim().toLowerCase();
  const messageErrorText = formatFailureContextValue(message && message.errorMessage ? message.errorMessage : '');
  const taskErrorText = formatFailureContextValue(task && task.errorMessage ? task.errorMessage : '');
  const sessionErrorText = formatFailureContextValue(session && session.errorMessage ? session.errorMessage : '');
  const assistantErrorsText = formatFailureContextValue(session && session.assistantErrors ? session.assistantErrors : '');
  const expectedCompletionAbortNoise = isExpectedCompletionAbortNoise({
    messageStatus,
    taskStatus,
    sessionStopReason,
    sessionErrorText,
    assistantErrorsText,
  });
  const resolvedAssistantRetryHistory = isResolvedAssistantRetryHistory({
    messageStatus,
    taskStatus,
    sessionStopReason,
    sessionErrorText,
    assistantErrorsText,
  });
  const expectedCompletionTailIgnored = Boolean(options.expectedCompletionTailIgnored);
  const hasFailure = Boolean(
    failedStep ||
      messageStatus === 'failed' ||
      taskStatus === 'failed' ||
      messageErrorText ||
      taskErrorText ||
      (!expectedCompletionTailIgnored && sessionStopReason === 'error') ||
      (!expectedCompletionAbortNoise && !expectedCompletionTailIgnored && Boolean(sessionErrorText)) ||
      (!resolvedAssistantRetryHistory && !expectedCompletionTailIgnored && Boolean(assistantErrorsText))
  );

  if (!hasFailure) {
    return {
      hasFailure: false,
      source: '',
      stepId: '',
      toolName: '',
      summary: '',
      text: '',
    };
  }

  const failedStepSummary = failedStep
    ? conciseFailureSummary(
        failedStep.errorSummary || failedStep.resultSummary,
        `工具 ${failedStep.toolName || 'tool'} 执行失败`
      )
    : '';
  const summary = failedStepSummary ||
    conciseFailureSummary(taskErrorText) ||
    conciseFailureSummary(messageErrorText) ||
    conciseFailureSummary(sessionErrorText) ||
    conciseFailureSummary(assistantErrorsText) ||
    (taskStatus === 'failed'
      ? '任务执行失败，未提供错误详情'
      : messageStatus === 'failed'
        ? '消息处理失败，未提供错误详情'
        : sessionStopReason === 'error'
          ? '模型会话异常结束，未提供错误详情'
          : '会话执行失败，未提供错误详情');
  const lines = [];

  if (message) {
    const messageBits = [`消息: ${message.id || '(unknown)'}`];

    if (message.status) {
      messageBits.push(`status=${message.status}`);
    }

    if (message.createdAt) {
      messageBits.push(`created=${message.createdAt}`);
    }

    lines.push(messageBits.join(' · '));
  }

  if (task) {
    const taskBits = [`任务: ${task.id || '(unknown)'}`];

    if (task.status) {
      taskBits.push(`status=${task.status}`);
    }

    if (task.runId !== null && task.runId !== undefined) {
      taskBits.push(`run=${task.runId}`);
    }

    lines.push(taskBits.join(' · '));
  }

  if (session) {
    const sessionBits = [];

    if (session.provider || session.model) {
      sessionBits.push(`会话: ${session.provider || 'unknown'}/${session.model || 'unknown'}`);
    } else {
      sessionBits.push('会话: assistant');
    }

    if (session.stopReason) {
      sessionBits.push(`stop=${session.stopReason}`);
    }

    lines.push(sessionBits.join(' · '));
  }

  if (failedStep) {
    lines.push('');
    lines.push(`失败步骤: ${failedStep.toolName || 'tool'} · ${failedStep.kind || 'tool'}`);

    if (failedStep.durationMs) {
      lines.push(`耗时: ${failedStep.durationMs}ms`);
    }

    if (failedStep.toolCallId) {
      lines.push(`调用 ID: ${failedStep.toolCallId}`);
    }

    const requestText = formatFailureContextValue(failedStep.requestSummary);
    const resultText = formatFailureContextValue(failedStep.resultSummary);
    const errorText = formatFailureContextValue(failedStep.errorSummary);
    const partialText = formatFailureContextValue(failedStep.partialJson);

    if (requestText) {
      lines.push('输入摘要:');
      lines.push(requestText);
    }

    if (resultText) {
      lines.push('输出摘要:');
      lines.push(resultText);
    }

    if (errorText) {
      lines.push('错误摘要:');
      lines.push(errorText);
    }

    if (partialText) {
      lines.push('局部参数:');
      lines.push(partialText);
    }
  }

  if (messageErrorText) {
    lines.push('');
    lines.push('消息错误:');
    lines.push(messageErrorText);
  }

  if (taskErrorText) {
    lines.push('');
    lines.push('任务错误:');
    lines.push(taskErrorText);
  }

  if (sessionErrorText) {
    lines.push('');
    lines.push('会话错误:');
    lines.push(sessionErrorText);
  }

  if (assistantErrorsText) {
    lines.push('');
    lines.push('Assistant 错误:');
    lines.push(assistantErrorsText);
  }

  return {
    hasFailure: true,
    source: failedStep
      ? 'step'
      : taskErrorText || taskStatus === 'failed'
        ? 'task'
        : messageErrorText || messageStatus === 'failed'
          ? 'message'
          : 'session',
    stepId: failedStep && failedStep.stepId ? String(failedStep.stepId) : '',
    toolName: failedStep && failedStep.toolName ? String(failedStep.toolName) : '',
    summary,
    text: lines.join('\n').trim(),
  };
}

export function buildAssistantMessageToolTrace(options: any = {}) {
  const db = options.db;
  const agentDir = String(options.agentDir || '').trim();
  const message = options.message && typeof options.message === 'object' ? options.message : null;
  const resolvedSessionPath = String(options.resolvedSessionPath || '').trim();
  const taskId = String(message && message.taskId ? message.taskId : '').trim();
  const taskRow = taskId ? loadTaskRow(db, taskId) : null;
  const runRow = taskRow && taskRow.run_id ? loadRunRow(db, taskRow.run_id) : null;
  const runAssistantErrors = runRow ? safeJsonParse(runRow.assistant_errors_json) : null;
  const expectedCompletionEvent = loadExpectedCompletionEvent(db, taskId);
  const taskMetadata = taskRow ? safeJsonParse(taskRow.metadata_json) : null;
  const taskSessionPath = taskRow && taskRow.session_path ? String(taskRow.session_path).trim() : '';
  const storedTimeline = normalizeObservabilityTimeline(options.observabilityTimeline);
  const sessionSnapshot = storedTimeline
    ? null
    : readSessionAssistantSnapshot(taskSessionPath || resolvedSessionPath, agentDir);
  const sessionToolSource = sessionSnapshot && Array.isArray(sessionSnapshot.toolCalls) ? sessionSnapshot.toolCalls : [];
  const sessionModelUsage = summarizeModelUsageCalls(sessionSnapshot && Array.isArray(sessionSnapshot.modelCalls) ? sessionSnapshot.modelCalls : []);
  const modelUsage = storedTimeline
    ? {
        modelCallCount: storedTimeline.modelCallCount,
        coldStartModelCallCount: storedTimeline.coldStartModelCallCount,
        postColdModelCallCount: storedTimeline.postColdModelCallCount,
        providerMissCount: storedTimeline.providerMissCount,
        calls: storedTimeline.events.filter((event: any) => event.eventType === 'model_call'),
      }
    : sessionModelUsage;
  const visiblePathRoots = taskMetadata && Array.isArray(taskMetadata.visiblePathRoots)
    ? taskMetadata.visiblePathRoots
    : [];
  const traceOptions = { agentDir, visiblePathRoots };
  const sessionToolCalls = sessionToolSource.map((toolCall: any, index: number) =>
    normalizeSessionToolCall(toolCall, index, traceOptions)
  );
  const bridgeToolStats = loadToolEventStats(db, taskId);
  const bridgeToolEvents = loadToolEventRows(db, taskId)
    .map((row: any) => ({
      id: row && row.id ? Number(row.id) : null,
      createdAt: row && row.created_at ? String(row.created_at).trim() : '',
      payload: safeJsonParse(row && row.event_json ? row.event_json : null),
    }))
    .filter((row: any) => row && row.payload)
    .map((row: any) => normalizeBridgeToolEvent(row, traceOptions))
    .filter(Boolean);
  const steps = storedTimeline
    ? storedTimeline.events.filter((event: any) => event.eventType === 'tool_execution')
    : buildMergedTimelineSteps(sessionToolCalls, bridgeToolEvents);
  const projectedTimeline = storedTimeline || normalizeObservabilityTimeline({
    events: buildTraceTimelineEvents(modelUsage, steps),
    totalEventCount: (modelUsage ? modelUsage.modelCallCount : 0) + sessionToolCalls.length + bridgeToolStats.totalCount,
    modelCallCount: modelUsage ? modelUsage.modelCallCount : 0,
    coldStartModelCallCount: modelUsage ? modelUsage.coldStartModelCallCount : 0,
    postColdModelCallCount: modelUsage ? modelUsage.postColdModelCallCount : 0,
    providerMissCount: modelUsage ? modelUsage.providerMissCount : 0,
    toolExecutionCount: sessionToolCalls.length + bridgeToolStats.totalCount,
    failedToolExecutionCount: bridgeToolStats.failedCount + sessionToolCalls.filter((step: any) => step && step.status === 'failed').length,
    totalToolDurationMs: bridgeToolStats.totalDurationMs,
  });
  const timelineEvents = projectedTimeline ? projectedTimeline.events : [];

  const task = taskRow
    ? {
        id: String(taskRow.id || '').trim(),
        status: String(taskRow.status || '').trim(),
        runId: Number.isInteger(taskRow.run_id) ? taskRow.run_id : taskRow.run_id ? Number(taskRow.run_id) : null,
        sessionPath: taskSessionPath ? previewAbsolutePath(taskSessionPath, traceOptions) : null,
        requestedSession: taskRow.requested_session ? clipText(String(taskRow.requested_session)) : '',
        outputText: taskRow.output_text === null || taskRow.output_text === undefined ? '' : clipText(redactString(taskRow.output_text, traceOptions), 360),
        errorMessage:
          taskRow.error_message === null || taskRow.error_message === undefined
            ? ''
            : clipText(redactString(taskRow.error_message, traceOptions), 240),
        metadata: summarizeValue(taskMetadata, traceOptions),
        startedAt: taskRow.started_at ? String(taskRow.started_at).trim() : '',
        endedAt: taskRow.ended_at ? String(taskRow.ended_at).trim() : '',
        updatedAt: taskRow.updated_at ? String(taskRow.updated_at).trim() : '',
      }
    : null;

  const expectedCompletionTailIgnored = Boolean(
    sessionSnapshot &&
    (
      String(sessionSnapshot.stopReason || '').trim().toLowerCase() === 'error' ||
      Boolean(String(sessionSnapshot.errorMessage || '').trim()) ||
      (Array.isArray(sessionSnapshot.assistantErrors) && sessionSnapshot.assistantErrors.length > 0)
    ) &&
    isAuthoritativeExpectedCompletionTailResolved({
      messageStatus: message && message.status,
      taskStatus: task && task.status,
      runStatus: runRow && runRow.status,
      runAssistantErrors,
      expectedCompletionEvent,
    })
  );

  const session = sessionSnapshot
    ? {
        sessionPath: previewAbsolutePath(sessionSnapshot.sessionPath, traceOptions),
        assistantMessageTotal: sessionSnapshot.assistantMessageTotal,
        stopReason: sessionSnapshot.stopReason,
        errorMessage: clipText(redactString(sessionSnapshot.errorMessage, traceOptions), 240),
        provider: sessionSnapshot.provider,
        model: sessionSnapshot.model,
        api: sessionSnapshot.api,
        usage: summarizeValue(sessionSnapshot.usage, traceOptions),
        // Compatibility/session diagnostics copy. The top-level
        // modelUsageSummary is the canonical trace summary for UI consumers.
        modelUsageSummary: modelUsage
          ? {
              modelCallCount: modelUsage.modelCallCount,
              coldStartModelCallCount: modelUsage.coldStartModelCallCount,
              postColdModelCallCount: modelUsage.postColdModelCallCount,
              providerMissCount: modelUsage.providerMissCount,
            }
          : null,
        assistantErrors: summarizeValue(sessionSnapshot.assistantErrors, traceOptions),
        expectedCompletionTailIgnored,
      }
    : null;

  const summary = buildTraceSummary(task, message, sessionToolCalls, bridgeToolEvents, modelUsage, bridgeToolStats);
  if (storedTimeline) {
    summary.totalSteps = storedTimeline.toolExecutionCount;
    summary.toolExecutionCount = storedTimeline.toolExecutionCount;
    summary.sessionToolCount = steps.filter((step: any) => step.kind === 'session').length;
    summary.bridgeToolCount = steps.filter((step: any) => step.kind === 'bridge').length;
    summary.failedSteps = storedTimeline.failedToolExecutionCount;
    summary.totalDurationMs = storedTimeline.totalToolDurationMs;
    summary.modelCallCount = storedTimeline.modelCallCount;
    summary.coldStartModelCallCount = storedTimeline.coldStartModelCallCount;
    summary.postColdModelCallCount = storedTimeline.postColdModelCallCount;
    summary.providerMissCount = storedTimeline.providerMissCount;
  }
  const activity = buildTraceActivity(summary, steps);
  const failureContext = buildTraceFailureContext({
    message: message
      ? {
          id: String(message.id || '').trim(),
          status: String(message.status || '').trim(),
          taskId: taskId || null,
          runId: message.runId === undefined ? null : message.runId,
          createdAt: String(message.createdAt || '').trim(),
          errorMessage:
            message.errorMessage === null || message.errorMessage === undefined
              ? ''
              : clipText(redactString(message.errorMessage, traceOptions), 240),
        }
      : null,
    task,
    session,
    steps,
    expectedCompletionTailIgnored,
  });

  return {
    message: message
      ? {
          id: String(message.id || '').trim(),
          status: String(message.status || '').trim(),
          taskId: taskId || null,
          runId: message.runId === undefined ? null : message.runId,
          createdAt: String(message.createdAt || '').trim(),
          errorMessage:
            message.errorMessage === null || message.errorMessage === undefined
              ? ''
              : clipText(redactString(message.errorMessage, traceOptions), 240),
        }
      : null,
    task,
    session,
    modelUsageSummary: modelUsage
      ? {
          modelCallCount: modelUsage.modelCallCount,
          coldStartModelCallCount: modelUsage.coldStartModelCallCount,
          postColdModelCallCount: modelUsage.postColdModelCallCount,
          providerMissCount: modelUsage.providerMissCount,
        }
      : null,
    modelUsageCalls: timelineEvents.filter((event: any) => event.eventType === 'model_call'),
    sessionToolCalls: timelineEvents.filter((event: any) => event.eventType === 'tool_execution' && event.kind === 'session'),
    bridgeToolEvents: timelineEvents.filter((event: any) => event.eventType === 'tool_execution' && event.kind === 'bridge'),
    steps: timelineEvents.filter((event: any) => event.eventType === 'tool_execution'),
    timelineEvents,
    timelineWindow: projectedTimeline
      ? {
          totalEventCount: projectedTimeline.totalEventCount,
          retainedEventCount: projectedTimeline.retainedEventCount,
          droppedEventCount: projectedTimeline.droppedEventCount,
          truncated: projectedTimeline.truncated,
          modelCallCount: projectedTimeline.modelCallCount,
          coldStartModelCallCount: projectedTimeline.coldStartModelCallCount,
          postColdModelCallCount: projectedTimeline.postColdModelCallCount,
          providerMissCount: projectedTimeline.providerMissCount,
          toolExecutionCount: projectedTimeline.toolExecutionCount,
          failedToolExecutionCount: projectedTimeline.failedToolExecutionCount,
          totalToolDurationMs: projectedTimeline.totalToolDurationMs,
        }
      : {
          totalEventCount: 0,
          retainedEventCount: 0,
          droppedEventCount: 0,
          truncated: false,
          modelCallCount: 0,
          coldStartModelCallCount: 0,
          postColdModelCallCount: 0,
          providerMissCount: 0,
          toolExecutionCount: 0,
          failedToolExecutionCount: 0,
          totalToolDurationMs: 0,
        },
    summary,
    activity,
    failureContext,
  };
}
