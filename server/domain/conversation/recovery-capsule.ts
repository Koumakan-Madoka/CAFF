import fs from 'node:fs';
import path from 'node:path';

import { redactContextInspectorSecrets } from './turn/context-snapshot';
import { isPathWithin } from './turn/session-export';

export const MAX_RECOVERY_CAPSULE_BYTES = 64 * 1024;
export const MAX_RECOVERY_SESSION_BYTES = 8 * 1024 * 1024;
export const MAX_RECOVERY_CONTEXT_SECTION_CHARS = 6_000;
export const MAX_RECOVERY_CONTEXT_CHARS = 18_000;
export const MAX_RECOVERY_TOOL_COUNT = 80;
export const MAX_RECOVERY_TOOL_BYTES = 1_600;
export const MAX_RECOVERY_OUTPUT_CHARS = 8_000;

const MAX_SAFE_ERROR_CHARS = 240;
const MAX_COMMAND_CHARS = 500;
const MAX_PATH_CHARS = 400;
const MAX_OUTPUT_LINE_CHARS = 120;
const CONTEXT_SECTION_ALLOWLIST = new Set([
  'workspace_header',
  'trellis_context',
  'session_goal',
  'conversation_digest',
  'conversation_history',
  'turn_trigger',
  'final_instruction',
]);
const MUTATING_OR_EXTERNAL_TOOLS = new Set([
  'bash',
  'edit',
  'write',
  'browser',
  'conversation_notify',
  'conversation_request',
  'room_workspace_bind',
  'trellis-init',
  'trellis-write',
]);
const ERROR_LINE_PATTERN = /\b(error|failed?|fatal|exception|denied|timeout|timed out|enoent|stderr|unauthorized|forbidden)\b/iu;

type ToolEvidenceStatus = 'completed' | 'possibly_effective' | 'not_completed' | 'unknown';

function clipText(value: any, maxLength: number) {
  const text = String(value || '').trim();
  if (!text || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxLength - 14)).trimEnd()}...[truncated]`;
}

function jsonBytes(value: any) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function normalizePathRoots(values: any) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .map((value) => path.resolve(value))
    .sort((left, right) => right.length - left.length);
}

function portablePath(value: any) {
  return String(value || '').replace(/\\/gu, '/');
}

function safePathPreview(value: any, visibleRoots: string[] = []) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  let resolved = '';
  try {
    resolved = path.resolve(raw);
  } catch {
    return '<path>';
  }

  for (const root of visibleRoots) {
    if (!isPathWithin(root, resolved)) {
      continue;
    }
    const relative = portablePath(path.relative(root, resolved));
    return relative && relative !== '.' ? `./${relative}` : '.';
  }

  const segments = portablePath(resolved).split('/').filter(Boolean);
  return segments.length > 0 ? `<path:.../${segments.slice(-2).join('/')}>` : '<path>';
}

function redactAbsolutePaths(value: string, visibleRoots: string[]) {
  let text = String(value || '');
  text = text.replace(/[A-Za-z]:[\\/][^\s"'`]+/gu, (match) => safePathPreview(match, visibleRoots));
  text = text.replace(/(^|[\s"'=])(\/(?:[^\s"'`]+\/?)+)/gu, (match, prefix, absolutePath) => (
    `${prefix}${safePathPreview(absolutePath, visibleRoots)}`
  ));
  return text;
}

export function redactRecoveryText(value: any, options: any = {}) {
  const visibleRoots = normalizePathRoots(options.visiblePathRoots);
  let text = redactContextInspectorSecrets(String(value || ''));

  text = text.replace(/(authorization\s*[:=]\s*bearer\s+)([^\s,;]+)/giu, '$1[redacted]');
  text = text.replace(/(authorization\s*[:=]\s*)([^\s,;]+)/giu, '$1[redacted]');
  text = text.replace(/\b(bearer)\s+([A-Za-z0-9._~+/=-]+)/giu, '$1 [redacted]');
  text = text.replace(
    /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|AUTHORIZATION|COOKIE|CALLBACK)[A-Z0-9_]*)\s*=\s*([^\s,;]+)/giu,
    '$1=[redacted]'
  );
  text = text.replace(
    /\b(token|secret|password|passwd|api[_-]?key|access[_-]?key|authorization|cookie|callbacktoken)\s*[:=]\s*([^\s,;]+)/giu,
    '$1=[redacted]'
  );
  text = text.replace(
    /((?:"|')[^"']*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|callback)[^"']*(?:"|')\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\]]*)/giu,
    '$1"[redacted]"'
  );
  return redactAbsolutePaths(text, visibleRoots);
}

function normalizeContextKey(value: any) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '');
}

function buildContextProjection(snapshot: any, options: any, truncation: any) {
  const sections = Array.isArray(snapshot && snapshot.sections) ? snapshot.sections : [];
  const projected = [] as any[];
  let remaining = MAX_RECOVERY_CONTEXT_CHARS;

  for (const section of sections) {
    if (projected.length >= 8 || remaining <= 0) {
      break;
    }

    const key = normalizeContextKey(section && section.sectionKey);
    if (!CONTEXT_SECTION_ALLOWLIST.has(key)) {
      continue;
    }

    const raw = String(section && (section.displayContent || section.contentPreview) || '');
    const redacted = redactRecoveryText(raw, options);
    const maxLength = Math.min(MAX_RECOVERY_CONTEXT_SECTION_CHARS, remaining);
    const content = clipText(redacted, maxLength);
    const dropped = Math.max(0, redacted.length - content.length);
    truncation.droppedChars += dropped;
    if (dropped > 0) {
      truncation.truncated = true;
    }

    projected.push({
      key,
      title: clipText(section && (section.displayTitle || section.title) || key, 160),
      content,
      truncated: Boolean(section && section.truncated) || dropped > 0,
    });
    remaining -= content.length;
  }

  return projected;
}

function extractObjective(contextSections: any[]) {
  const goal = contextSections.find((section) => section.key === 'session_goal');
  const history = contextSections.find((section) => section.key === 'conversation_history');
  const candidate = String(goal && goal.content || history && history.content || '').trim();
  const objectiveMatch = candidate.match(/(?:^|\n)\s*(?:objective|goal|目标)\s*[:：]\s*([^\n]+)/iu);
  const acceptance = [] as string[];

  for (const line of candidate.split(/\r?\n/u)) {
    const normalized = line.trim();
    if (!normalized) {
      continue;
    }
    if (/^(?:[-*]\s*)?\[[ x~]\]/iu.test(normalized) || /(?:acceptance|验收|checklist)/iu.test(normalized)) {
      acceptance.push(clipText(normalized, 240));
    }
    if (acceptance.length >= 12) {
      break;
    }
  }

  return {
    originalRequest: clipText(objectiveMatch ? objectiveMatch[1] : candidate, 2_000),
    acceptance,
    contextSections,
  };
}

function readBoundedSessionLines(sessionPath: any, agentDir: any, truncation: any) {
  const normalizedPath = String(sessionPath || '').trim();
  const normalizedAgentDir = String(agentDir || '').trim();
  if (!normalizedPath || !normalizedAgentDir) {
    throw new Error('Recovery source session path is missing');
  }

  const sessionsDir = path.resolve(normalizedAgentDir, 'named-sessions');
  const resolvedPath = path.resolve(normalizedPath);
  if (!isPathWithin(sessionsDir, resolvedPath)) {
    throw new Error('Recovery source session path is outside named-sessions');
  }

  const stat = fs.statSync(resolvedPath);
  const start = Math.max(0, stat.size - MAX_RECOVERY_SESSION_BYTES);
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(resolvedPath, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }

  let text = buffer.toString('utf8');
  if (start > 0) {
    const firstNewline = text.indexOf('\n');
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    truncation.truncated = true;
    truncation.droppedChars += start;
  }

  return {
    lines: text.split(/\r?\n/u).filter(Boolean),
    tailTruncated: start > 0,
  };
}

function parseSessionEvidence(lines: string[]) {
  const calls = [] as any[];
  const byId = new Map<string, any>();

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry && entry.type === 'message' && entry.message && typeof entry.message === 'object'
      ? entry.message
      : null;
    if (!message) {
      continue;
    }

    if (message.role === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : [];
      for (const item of content) {
        const type = String(item && item.type || '').toLowerCase().replace(/[_-]/gu, '');
        if (!['toolcall', 'tooluse'].includes(type)) {
          continue;
        }
        const toolCallId = String(item && item.id || '').trim();
        const call = {
          toolCallId,
          toolName: String(item && item.name || 'tool').trim() || 'tool',
          arguments: item && item.arguments !== undefined ? item.arguments : null,
          result: null,
        };
        calls.push(call);
        if (toolCallId) {
          byId.set(toolCallId, call);
        }
      }
      continue;
    }

    if (message.role !== 'toolResult') {
      continue;
    }
    const toolCallId = String(message.toolCallId || '').trim();
    const call = toolCallId ? byId.get(toolCallId) : null;
    if (call) {
      call.result = message;
    }
  }

  return calls;
}

function resultText(result: any) {
  const content = Array.isArray(result && result.content) ? result.content : [];
  return content
    .filter((item: any) => item && item.type === 'text' && item.text)
    .map((item: any) => String(item.text))
    .join('\n');
}

function numericExitCode(result: any) {
  const candidates = [
    result && result.exitCode,
    result && result.exit_code,
    result && result.details && result.details.exitCode,
    result && result.details && result.details.exit_code,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isInteger(value)) {
      return value;
    }
  }
  return null;
}

function isMutatingOrExternal(toolName: any) {
  return MUTATING_OR_EXTERNAL_TOOLS.has(String(toolName || '').trim().toLowerCase());
}

function toolStatus(call: any): ToolEvidenceStatus {
  if (call.result) {
    if (call.result.isError === false) {
      return 'completed';
    }
    if (call.result.isError === true) {
      return isMutatingOrExternal(call.toolName) ? 'possibly_effective' : 'not_completed';
    }
    const exitCode = numericExitCode(call.result);
    if (exitCode === 0) {
      return 'completed';
    }
    if (exitCode !== null) {
      return isMutatingOrExternal(call.toolName) ? 'possibly_effective' : 'not_completed';
    }
    return 'unknown';
  }
  return isMutatingOrExternal(call.toolName) ? 'possibly_effective' : 'unknown';
}

function extractCommandAndPath(args: any, options: any) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const command = input.command ? clipText(redactRecoveryText(input.command, options), MAX_COMMAND_CHARS) : '';
  const rawPath = input.path || input.file_path || input.filePath || '';
  const pathValue = rawPath
    ? clipText(path.isAbsolute(String(rawPath))
      ? safePathPreview(rawPath, normalizePathRoots(options.visiblePathRoots))
      : redactRecoveryText(rawPath, options), MAX_PATH_CHARS)
    : '';
  return { command, path: pathValue };
}

function outputProjection(rawOutput: any, options: any) {
  const redacted = redactRecoveryText(rawOutput, options);
  const lines = redacted
    .split(/\r?\n/u)
    .map((line) => clipText(line, MAX_OUTPUT_LINE_CHARS))
    .filter(Boolean);
  const head = lines.slice(0, 6);
  const tail = lines.length > 6 ? lines.slice(-6) : [];
  const errorLines = lines.filter((line) => ERROR_LINE_PATTERN.test(line)).slice(0, 8);
  return {
    outputHead: head,
    outputTail: tail,
    errorLines,
    truncated: lines.length > head.length + tail.length || redacted.length !== String(rawOutput || '').length,
    droppedChars: Math.max(0, redacted.length - [...head, ...tail, ...errorLines].join('\n').length),
  };
}

function enforceToolBudget(tool: any) {
  while (jsonBytes(tool) > MAX_RECOVERY_TOOL_BYTES) {
    if (tool.errorLines.length > 2) {
      tool.errorLines.pop();
      tool.truncated = true;
      continue;
    }
    if (tool.outputHead.length > 2) {
      tool.outputHead.pop();
      tool.truncated = true;
      continue;
    }
    if (tool.outputTail.length > 2) {
      tool.outputTail.shift();
      tool.truncated = true;
      continue;
    }
    if (tool.command && tool.command.length > 120) {
      tool.command = clipText(tool.command, Math.max(120, Math.floor(tool.command.length * 0.7)));
      tool.truncated = true;
      continue;
    }
    break;
  }
  return tool;
}

function summarizeTool(tool: any) {
  const detail = tool.command || tool.path || tool.outputTail[tool.outputTail.length - 1] || tool.outputHead[0] || '';
  return clipText(`${tool.toolName}${detail ? `: ${detail}` : ''}`, 240);
}

function projectTools(calls: any[], options: any, truncation: any) {
  const projected = calls.map((call, index) => {
    const output = outputProjection(resultText(call.result), options);
    const identifiers = extractCommandAndPath(call.arguments, options);
    const tool = enforceToolBudget({
      sequence: index + 1,
      toolCallId: clipText(call.toolCallId, 160),
      toolName: clipText(call.toolName, 80) || 'tool',
      status: toolStatus(call),
      ...(identifiers.command ? { command: identifiers.command } : {}),
      ...(identifiers.path ? { path: identifiers.path } : {}),
      exitCode: call.result ? numericExitCode(call.result) : null,
      isError: call.result && typeof call.result.isError === 'boolean' ? call.result.isError : null,
      outputHead: output.outputHead,
      outputTail: output.outputTail,
      errorLines: output.errorLines,
      evidence: call.result ? 'tool_result' : 'tool_call_only',
      truncated: output.truncated,
    });
    truncation.droppedChars += output.droppedChars;
    if (tool.truncated) {
      truncation.truncated = true;
    }
    return tool;
  });

  if (projected.length <= MAX_RECOVERY_TOOL_COUNT) {
    return projected;
  }

  const dropped = projected.length - MAX_RECOVERY_TOOL_COUNT;
  truncation.truncated = true;
  truncation.droppedToolCount += dropped;
  return [projected[0], ...projected.slice(-(MAX_RECOVERY_TOOL_COUNT - 1))];
}

function buildEvidenceSummary(tools: any[]) {
  const summary = {
    completed: [] as string[],
    possiblyEffective: [] as string[],
    notCompleted: [] as string[],
    unknown: [] as string[],
  };
  const keyByStatus: Record<ToolEvidenceStatus, keyof typeof summary> = {
    completed: 'completed',
    possibly_effective: 'possiblyEffective',
    not_completed: 'notCompleted',
    unknown: 'unknown',
  };

  for (const tool of tools) {
    const key = keyByStatus[tool.status as ToolEvidenceStatus];
    if (summary[key].length < 12) {
      summary[key].push(summarizeTool(tool));
    }
  }
  return summary;
}

function enforceCapsuleBudget(capsule: any) {
  while (jsonBytes(capsule) > MAX_RECOVERY_CAPSULE_BYTES && capsule.tools.length > 2) {
    capsule.tools.splice(1, 1);
    capsule.truncation.truncated = true;
    capsule.truncation.droppedToolCount += 1;
  }
  capsule.evidenceSummary = buildEvidenceSummary(capsule.tools);

  while (jsonBytes(capsule) > MAX_RECOVERY_CAPSULE_BYTES) {
    const section = capsule.objective.contextSections
      .slice()
      .sort((left: any, right: any) => right.content.length - left.content.length)[0];
    if (!section || section.content.length <= 240) {
      break;
    }
    const before = section.content.length;
    section.content = clipText(section.content, Math.max(240, Math.floor(before * 0.7)));
    section.truncated = true;
    capsule.truncation.truncated = true;
    capsule.truncation.droppedChars += Math.max(0, before - section.content.length);
  }

  if (jsonBytes(capsule) > MAX_RECOVERY_CAPSULE_BYTES) {
    throw new Error('Recovery Capsule cannot fit the hard size limit');
  }
  return capsule;
}

export function buildRecoveryCapsule(input: any = {}) {
  const message = input.message && typeof input.message === 'object' ? input.message : {};
  const task = input.task && typeof input.task === 'object' ? input.task : {};
  const run = input.run && typeof input.run === 'object' ? input.run : {};
  const visiblePathRoots = task.metadata && Array.isArray(task.metadata.visiblePathRoots)
    ? task.metadata.visiblePathRoots
    : [];
  const options = { visiblePathRoots };
  const truncation = { truncated: false, droppedToolCount: 0, droppedChars: 0 };
  const contextSections = buildContextProjection(input.contextSnapshot, options, truncation);
  const session = readBoundedSessionLines(input.sessionPath, input.agentDir, truncation);
  const calls = parseSessionEvidence(session.lines);
  if (session.tailTruncated && !calls.some((call) => call && call.result)) {
    throw new Error('Recovery session tail contains no complete tool call/result evidence');
  }
  const tools = projectTools(calls, options, truncation);
  const capsule = {
    version: 1,
    source: {
      conversationId: String(message.conversationId || '').trim(),
      messageId: String(message.id || '').trim(),
      taskId: String(message.taskId || task.id || '').trim(),
      runId: Number(message.runId || task.runId || run.id || 0),
      agentId: message.agentId ? String(message.agentId) : null,
      agentName: clipText(message.senderName || '', 120),
      failedAt: String(message.createdAt || '').trim(),
    },
    objective: extractObjective(contextSections),
    failure: {
      messageError: clipText(redactRecoveryText(message.errorMessage, options), MAX_SAFE_ERROR_CHARS),
      taskError: clipText(redactRecoveryText(task.errorMessage, options), MAX_SAFE_ERROR_CHARS),
      runError: clipText(redactRecoveryText(run.errorMessage, options), MAX_SAFE_ERROR_CHARS),
      terminationType: clipText(run.terminationType || '', 80),
      assistantErrors: (Array.isArray(run.assistantErrors) ? run.assistantErrors : [])
        .slice(0, 8)
        .map((value: any) => clipText(redactRecoveryText(value, options), MAX_SAFE_ERROR_CHARS)),
    },
    tools,
    evidenceSummary: buildEvidenceSummary(tools),
    truncation,
  };

  return enforceCapsuleBudget(capsule);
}

function listOrPlaceholder(items: any, placeholder: string) {
  const values = (Array.isArray(items) ? items : []).filter(Boolean).slice(0, 12);
  return values.length > 0 ? values.map((value) => `- ${clipText(value, 360)}`).join('\n') : `- ${placeholder}`;
}

export function buildMechanicalRecoveryMessage(capsule: any) {
  const source = capsule && capsule.source || {};
  const failure = capsule && capsule.failure || {};
  const summary = capsule && capsule.evidenceSummary || {};
  const failureText = failure.runError || failure.taskError || failure.messageError
    || (Array.isArray(failure.assistantErrors) ? failure.assistantErrors[0] : '')
    || '现场没有保留可判定的错误详情。';
  const recoveryPoint = Array.isArray(summary.possiblyEffective) && summary.possiblyEffective.length > 0
    ? '先核验“可能已生效但需核验”中的外部状态，再决定后续动作。'
    : '先核验最后一个有证据的工具结果与当前环境状态，再决定后续动作。';

  return clipText([
    '## 执行异常后的现场摘要',
    '',
    `来源：消息 ${source.messageId || 'unknown'} · task ${source.taskId || 'unknown'} · run ${source.runId || 'unknown'}`,
    '',
    '> 这是只读现场整理，不会执行或重放原任务。原失败 Trace 保持 failed。',
    '',
    '### 已经完成',
    listOrPlaceholder(summary.completed, '没有足够的成功 toolResult 证据。'),
    '',
    '### 失败位置',
    `- ${clipText(failureText, 600)}`,
    '',
    '### 可能已生效但需核验',
    listOrPlaceholder(summary.possiblyEffective, '没有识别到可能产生外部副作用但结果不确定的工具。'),
    '',
    '### 尚未完成',
    listOrPlaceholder(summary.notCompleted, '无法仅凭机械现场判断原计划的全部剩余事项。'),
    '',
    '### 建议恢复点',
    `- ${recoveryPoint}`,
    '',
    '### 无法从现场判断',
    listOrPlaceholder(summary.unknown, '原计划语义完成度与未记录的外部状态仍需重新核验。'),
  ].join('\n'), MAX_RECOVERY_OUTPUT_CHARS);
}
