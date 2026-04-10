import fs from 'node:fs';
import path from 'node:path';

import { isPathWithin } from '../conversation/turn/session-export';

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

function toPortablePath(value: string) {
  return String(value || '').replace(/\\/g, '/');
}

function previewAbsolutePath(value: any, options: any = {}) {
  const rawValue = String(value || '').trim();

  if (!rawValue) {
    return '';
  }

  const portableValue = toPortablePath(rawValue);
  const roots = [process.cwd(), options.agentDir]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .map((entry) => toPortablePath(path.resolve(entry)))
    .sort((left, right) => right.length - left.length);
  const compareValue = process.platform === 'win32' ? portableValue.toLowerCase() : portableValue;

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

function loadToolEventRows(db: any, taskId: string) {
  if (!db || !taskId) {
    return [];
  }

  try {
    return db
      .prepare(
        `
        SELECT event_json, created_at
        FROM (
          SELECT id, event_json, created_at
          FROM a2a_task_events
          WHERE task_id = @taskId
            AND event_type = 'agent_tool_call'
          ORDER BY id DESC
          LIMIT ${MAX_TOOL_EVENT_COUNT}
        ) latest_events
        ORDER BY id ASC
      `
      )
      .all({ taskId });
  } catch {
    return [];
  }
}

const BRIDGE_COMMAND_HINTS = [
  { token: 'send-public', toolName: 'send-public' },
  { token: 'send-private', toolName: 'send-private' },
  { token: 'read-context', toolName: 'read-context' },
  { token: 'list-participants', toolName: 'participants' },
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
  };
}

export function createLiveSessionToolStep(toolCall: any, options: any = {}) {
  const normalized = normalizeSessionToolCall(
    {
      toolCallId: toolCall && toolCall.toolCallId ? toolCall.toolCallId : toolCall && toolCall.id ? toolCall.id : '',
      toolName: toolCall && toolCall.toolName ? toolCall.toolName : toolCall && toolCall.name ? toolCall.name : '',
      arguments: toolCall && toolCall.arguments !== undefined ? toolCall.arguments : null,
      partialJson: toolCall && toolCall.partialJson ? toolCall.partialJson : '',
    },
    0,
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
    stepId: String(payload.toolCallId || row.createdAt || randomStepId(payload.tool || 'tool')).trim(),
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

function buildTraceSummary(task: any, message: any, sessionToolCalls: any[], bridgeToolEvents: any[]) {
  const failedBridgeSteps = bridgeToolEvents.filter((event) => event && event.status === 'failed');
  const succeededBridgeSteps = bridgeToolEvents.filter((event) => event && event.status === 'succeeded');
  const totalDurationMs = bridgeToolEvents.reduce((sum, event) => {
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

  const totalSteps = sessionToolCalls.length + bridgeToolEvents.length;

  return {
    totalSteps,
    sessionToolCount: sessionToolCalls.length,
    bridgeToolCount: bridgeToolEvents.length,
    failedSteps: failedBridgeSteps.length,
    succeededSteps: succeededBridgeSteps.length,
    totalDurationMs,
    retryCount,
    hasRetries: retryCount > 0,
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

function buildTraceFailureContext(options: any = {}) {
  const message = options.message && typeof options.message === 'object' ? options.message : null;
  const task = options.task && typeof options.task === 'object' ? options.task : null;
  const session = options.session && typeof options.session === 'object' ? options.session : null;
  const steps: any[] = Array.isArray(options.steps) ? options.steps : [];
  const failedStep = steps.find((step: any) => step && step.status === 'failed') || null;
  const messageStatus = String(message && message.status ? message.status : '').trim().toLowerCase();
  const taskStatus = String(task && task.status ? task.status : '').trim().toLowerCase();
  const sessionStopReason = String(session && session.stopReason ? session.stopReason : '').trim().toLowerCase();
  const taskErrorText = formatFailureContextValue(task && task.errorMessage ? task.errorMessage : '');
  const sessionErrorText = formatFailureContextValue(session && session.errorMessage ? session.errorMessage : '');
  const assistantErrorsText = formatFailureContextValue(session && session.assistantErrors ? session.assistantErrors : '');
  const hasFailure = Boolean(
    failedStep ||
      messageStatus === 'failed' ||
      taskStatus === 'failed' ||
      taskErrorText ||
      sessionStopReason === 'error' ||
      sessionErrorText ||
      assistantErrorsText
  );

  if (!hasFailure) {
    return {
      hasFailure: false,
      source: '',
      stepId: '',
      toolName: '',
      text: '',
    };
  }

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
    source: failedStep ? 'step' : taskErrorText ? 'task' : sessionErrorText || assistantErrorsText ? 'session' : 'message',
    stepId: failedStep && failedStep.stepId ? String(failedStep.stepId) : '',
    toolName: failedStep && failedStep.toolName ? String(failedStep.toolName) : '',
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
  const taskMetadata = taskRow ? safeJsonParse(taskRow.metadata_json) : null;
  const taskSessionPath = taskRow && taskRow.session_path ? String(taskRow.session_path).trim() : '';
  const sessionSnapshot = readSessionAssistantSnapshot(taskSessionPath || resolvedSessionPath, agentDir);
  const sessionToolSource = sessionSnapshot && Array.isArray(sessionSnapshot.toolCalls) ? sessionSnapshot.toolCalls : [];
  const sessionToolCalls = sessionToolSource.map((toolCall: any, index: number) =>
    normalizeSessionToolCall(toolCall, index, { agentDir })
  );
  const bridgeToolEvents = loadToolEventRows(db, taskId)
    .map((row: any) => ({
      createdAt: row && row.created_at ? String(row.created_at).trim() : '',
      payload: safeJsonParse(row && row.event_json ? row.event_json : null),
    }))
    .filter((row: any) => row && row.payload)
    .map((row: any) => normalizeBridgeToolEvent(row, { agentDir }))
    .filter(Boolean);
  const steps = buildMergedTimelineSteps(sessionToolCalls, bridgeToolEvents);

  const task = taskRow
    ? {
        id: String(taskRow.id || '').trim(),
        status: String(taskRow.status || '').trim(),
        runId: Number.isInteger(taskRow.run_id) ? taskRow.run_id : taskRow.run_id ? Number(taskRow.run_id) : null,
        sessionPath: taskSessionPath ? previewAbsolutePath(taskSessionPath, { agentDir }) : null,
        requestedSession: taskRow.requested_session ? clipText(String(taskRow.requested_session)) : '',
        outputText: taskRow.output_text === null || taskRow.output_text === undefined ? '' : clipText(redactString(taskRow.output_text, { agentDir }), 360),
        errorMessage:
          taskRow.error_message === null || taskRow.error_message === undefined
            ? ''
            : clipText(redactString(taskRow.error_message, { agentDir }), 240),
        metadata: summarizeValue(taskMetadata, { agentDir }),
        startedAt: taskRow.started_at ? String(taskRow.started_at).trim() : '',
        endedAt: taskRow.ended_at ? String(taskRow.ended_at).trim() : '',
        updatedAt: taskRow.updated_at ? String(taskRow.updated_at).trim() : '',
      }
    : null;

  const session = sessionSnapshot
    ? {
        sessionPath: previewAbsolutePath(sessionSnapshot.sessionPath, { agentDir }),
        assistantMessageTotal: sessionSnapshot.assistantMessageTotal,
        stopReason: sessionSnapshot.stopReason,
        errorMessage: clipText(redactString(sessionSnapshot.errorMessage, { agentDir }), 240),
        provider: sessionSnapshot.provider,
        model: sessionSnapshot.model,
        api: sessionSnapshot.api,
        usage: summarizeValue(sessionSnapshot.usage, { agentDir }),
        assistantErrors: summarizeValue(sessionSnapshot.assistantErrors, { agentDir }),
      }
    : null;

  const summary = buildTraceSummary(task, message, sessionToolCalls, bridgeToolEvents);
  const activity = buildTraceActivity(summary, steps);
  const failureContext = buildTraceFailureContext({
    message: message
      ? {
          id: String(message.id || '').trim(),
          status: String(message.status || '').trim(),
          taskId: taskId || null,
          runId: message.runId === undefined ? null : message.runId,
          createdAt: String(message.createdAt || '').trim(),
        }
      : null,
    task,
    session,
    steps,
  });

  return {
    message: message
      ? {
          id: String(message.id || '').trim(),
          status: String(message.status || '').trim(),
          taskId: taskId || null,
          runId: message.runId === undefined ? null : message.runId,
          createdAt: String(message.createdAt || '').trim(),
        }
      : null,
    task,
    session,
    sessionToolCalls,
    bridgeToolEvents,
    steps,
    summary,
    activity,
    failureContext,
  };
}
