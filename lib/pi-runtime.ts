const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { fork, spawn, spawnSync } = require('node:child_process');
const { createSqliteRunStore } = require('./sqlite-store');

const DEFAULT_PROVIDER = 'kimi-coding';
const DEFAULT_MODEL = 'k2p5';
const DEFAULT_THINKING = '';
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 1000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60 * 1000;
const DEFAULT_TERMINATE_GRACE_MS = 5 * 1000;
const MAX_STDERR_TAIL_LENGTH = 4000;
const MAX_DEBUG_LINES = 10;
const SDK_HOST_PATH = process.env.PI_SDK_HOST_OVERRIDE || path.resolve(__dirname, 'pi-sdk-host.mjs');
const DEFAULT_AGENT_DIR = resolveDefaultAgentDir();

function resolveSetting(cliValue: any, envValue: any, fallbackValue: any) {
  return String(cliValue || envValue || fallbackValue || '').trim();
}

function getProviderDefaultThinking(provider: any) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();

  if (normalizedProvider === 'packycode') {
    return 'xhigh';
  }

  return DEFAULT_THINKING;
}

function resolveThinkingSetting(provider: any, cliValue: any, envValue: any, fallbackValue = DEFAULT_THINKING) {
  const normalizedFallback = String(fallbackValue || '').trim();
  return resolveSetting(cliValue, envValue, normalizedFallback || getProviderDefaultThinking(provider));
}

function resolveIntegerSetting(cliValue: any, envValue: any, fallbackValue: any, name: any) {
  return resolveIntegerSettingCandidates([cliValue, envValue, fallbackValue], name);
}

function resolveIntegerSettingCandidates(candidates: any, name: any) {
  let rawValue;

  for (const candidate of candidates) {
    if (candidate !== '' && candidate !== null && candidate !== undefined) {
      rawValue = candidate;
      break;
    }
  }

  if (rawValue === undefined) {
    return 0;
  }

  const value = Number.parseInt(String(rawValue), 10);

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, received: ${rawValue}`);
  }

  return value;
}

function sanitizeEnvironmentName(value: any) {
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

  if (!runtimeEnv) {
    return path.join(process.cwd(), '.pi-sandbox');
  }

  return path.join(process.cwd(), `.pi-sandbox-${runtimeEnv}`);
}

function sanitizeSessionName(value: any) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function looksLikeSessionPath(value: any) {
  return path.isAbsolute(value) || value.includes('/') || value.includes('\\') || value.endsWith('.jsonl');
}

function resolveSessionPath(sessionValue: any, agentDir: any) {
  const normalizedValue = String(sessionValue || '').trim();

  if (!normalizedValue) {
    return '';
  }

  if (looksLikeSessionPath(normalizedValue)) {
    return path.resolve(normalizedValue);
  }

  const safeName = sanitizeSessionName(normalizedValue);

  if (!safeName) {
    throw new Error(`Invalid session name: ${sessionValue}`);
  }

  return path.join(agentDir, 'named-sessions', `${safeName}.jsonl`);
}

function normalizeExtraEnv(extraEnv: any) {
  if (!extraEnv || typeof extraEnv !== 'object') {
    return {};
  }

  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(extraEnv)) {
    const envName = String(key || '').trim();

    if (!envName || value === undefined || value === null) {
      continue;
    }

    normalized[envName] = String(value);
  }

  return normalized;
}

function normalizeExtensionPaths(value: any) {
  const entries = Array.isArray(value) ? value : [value];
  const seen = new Set();
  const normalized = [];

  for (const entry of entries) {
    const rawPath = String(entry || '').trim();

    if (!rawPath) {
      continue;
    }

    const resolvedPath = path.resolve(rawPath);

    if (seen.has(resolvedPath)) {
      continue;
    }

    seen.add(resolvedPath);
    normalized.push(resolvedPath);
  }

  return normalized;
}

function getAssistantMessageKey(message: any) {
  if (!message || message.role !== 'assistant') {
    return '';
  }

  if (message.responseId) {
    return `response:${message.responseId}`;
  }

  return `timestamp:${message.timestamp}:${message.provider || ''}:${message.model || ''}`;
}

function extractAssistantText(message: any) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) {
    return '';
  }

  return message.content
    .filter((item: any) => item && item.type === 'text' && typeof item.text === 'string')
    .map((item: any) => item.text)
    .join('');
}

function normalizeStopReason(stopReason: any) {
  return String(stopReason || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function assistantMessageHasPendingToolUse(message: any) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) {
    return false;
  }

  return message.content.some((item: any) => {
    const type = String(item && item.type ? item.type : '')
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');

    return type === 'tool_use' || type === 'tooluse' || type === 'tool_call' || type === 'toolcall';
  });
}

function isTerminalAssistantMessage(message: any) {
  if (!message || message.role !== 'assistant') {
    return false;
  }

  const stopReason = normalizeStopReason(message.stopReason);

  if (stopReason === 'error' || stopReason === 'tool_use' || stopReason === 'tooluse' || stopReason === 'pause_turn') {
    return false;
  }

  return !assistantMessageHasPendingToolUse(message);
}

function appendTailText(existing: any, chunk: any, limit: any) {
  const next = `${existing}${chunk}`;
  return next.length <= limit ? next : next.slice(-limit);
}

function pushRecentLine(lines: any, line: any, limit: any) {
  lines.push(line);

  if (lines.length > limit) {
    lines.shift();
  }
}

function terminateProcessTree(child: any, force = false, sync = false) {
  if (!child || !child.pid) {
    return;
  }

  if (process.platform === 'win32') {
    const args = ['/PID', String(child.pid), '/T'];

    if (force) {
      args.push('/F');
    }

    try {
      if (sync) {
        spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
      } else {
        const killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
        killer.on('error', () => {});
      }
    } catch {}

    return;
  }

  try {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  } catch {}
}

function signalToExitCode(signal: any) {
  if (signal === 'SIGINT') {
    return 130;
  }

  if (signal === 'SIGTERM') {
    return 143;
  }

  if (signal === 'SIGBREAK') {
    return 149;
  }

  return 1;
}

function createInvokeError(message: any, details: any = {}) {
  const error = new Error(message);
  error.name = 'InvokeError';
  Object.assign(error, details);
  return error;
}

function extractAssistantUsage(message: any) {
  const usage = message && message.usage && typeof message.usage === 'object' ? message.usage : null;

  if (!usage || Array.isArray(usage)) {
    return null;
  }

  return usage;
}

function aggregateAssistantUsage(usages: any[]) {
  const totals: any = {};
  let hasUsage = false;

  for (const usage of usages) {
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
      continue;
    }

    for (const [key, value] of Object.entries(usage)) {
      if (key === 'cost' || typeof value !== 'number' || !Number.isFinite(value)) {
        continue;
      }

      totals[key] = (totals[key] || 0) + value;
      hasUsage = true;
    }

    const cost = usage.cost && typeof usage.cost === 'object' && !Array.isArray(usage.cost) ? usage.cost : null;

    if (cost) {
      for (const [key, value] of Object.entries(cost)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          continue;
        }

        totals.cost = totals.cost || {};
        totals.cost[key] = (totals.cost[key] || 0) + value;
        hasUsage = true;
      }
    }
  }

  return hasUsage ? totals : null;
}

function assistantUsageCallsFromState(state: any) {
  if (!state || !state.assistantUsageByKey || typeof state.assistantUsageByKey.values !== 'function') {
    return [];
  }

  return Array.from(state.assistantUsageByKey.values()).map((entry: any, index) => ({
    index,
    key: String(entry && entry.key ? entry.key : '').trim(),
    responseId: String(entry && entry.responseId ? entry.responseId : '').trim(),
    stopReason: String(entry && entry.stopReason ? entry.stopReason : '').trim(),
    timestamp: entry && entry.timestamp !== undefined ? entry.timestamp : null,
    usage: entry && entry.usage && typeof entry.usage === 'object' && !Array.isArray(entry.usage) ? entry.usage : null,
  })).filter((entry: any) => entry.usage);
}

function startRun(provider: any, model: any, prompt: any, options: any = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error('Prompt is required');
  }

  const emitter = new EventEmitter();
  const thinking = resolveThinkingSetting(provider, options.thinking, process.env.PI_THINKING, DEFAULT_THINKING);
  const agentDir = resolveSetting(options.agentDir, process.env.PI_CODING_AGENT_DIR, DEFAULT_AGENT_DIR);
  const sqlitePath = resolveSetting(options.sqlitePath, process.env.PI_SQLITE_PATH, '');
  const heartbeatIntervalMs = resolveIntegerSettingCandidates(
    [options.heartbeatIntervalMs, process.env.PI_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_INTERVAL_MS],
    'heartbeatIntervalMs'
  );
  const heartbeatTimeoutMs = resolveIntegerSettingCandidates(
    [
      options.heartbeatTimeoutMs,
      options.idleTimeoutMs,
      options.timeoutMs,
      process.env.PI_HEARTBEAT_TIMEOUT_MS,
      process.env.PI_IDLE_TIMEOUT_MS,
      process.env.PI_TIMEOUT_MS,
      DEFAULT_HEARTBEAT_TIMEOUT_MS,
    ],
    'heartbeatTimeoutMs'
  );
  const terminateGraceMs = resolveIntegerSetting(
    options.terminateGraceMs,
    process.env.PI_TERMINATE_GRACE_MS,
    DEFAULT_TERMINATE_GRACE_MS,
    'terminateGraceMs'
  );
  const resume = Boolean(options.resume);
  const sessionPath = resolveSessionPath(options.session, agentDir);
  const cwd = path.resolve(String(options.cwd || process.cwd()).trim() || process.cwd());
  const extensionPaths = normalizeExtensionPaths(options.extensionPaths || options.extensions);
  const streamOutput = options.streamOutput !== false;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  let child: any = null;
  let runRecord: any = null;
  let beginTermination = (reason: any) => {};

  function emit(type: any, payload: any = {}) {
    const event = {
      type,
      timestamp: new Date().toISOString(),
      ...payload,
    };

    emitter.emit('event', event);
    emitter.emit(type, event);
    return event;
  }

  function writeStdout(text: any) {
    if (streamOutput && text) {
      stdout.write(text);
    }
  }

  function writeStderr(text: any) {
    if (streamOutput && text) {
      stderr.write(text);
    }
  }

  const resultPromise = new Promise((resolve, reject) => {
    let store: any = null;
    const state = {
      reply: '',
      assistantErrors: [] as any[],
      stderrTail: '',
      parseErrors: 0,
      stdoutLines: [] as any[],
      streamedAssistantMessages: new Set(),
      printedFallbackMessages: new Set(),
      printedAssistantErrors: new Set(),
      heartbeatCount: 0,
      assistantUsage: null as any,
      assistantUsageByKey: new Map(),
    };
    const childState = { code: null as any, signal: null as any };
    const processHandlers: Array<[any, any]> = [];
    let settled = false;
    let terminating = false;
    let heartbeatTimeout: any = null;
    let forceKillTimeout: any = null;
    let terminationReason: any = null;
    let stderrBuffer = '';
    let ignoreFurtherAssistantOutput = false;

    function recordAssistantUsage(message: any) {
      const usage = extractAssistantUsage(message);

      if (!usage) {
        return;
      }

      const key = getAssistantMessageKey(message) || `assistant:${state.assistantUsageByKey.size}`;
      state.assistantUsageByKey.set(key, {
        key,
        responseId: message && message.responseId ? String(message.responseId) : '',
        stopReason: message && message.stopReason ? String(message.stopReason) : '',
        timestamp: message && message.timestamp !== undefined ? message.timestamp : null,
        usage,
      });
      state.assistantUsage = aggregateAssistantUsage(
        Array.from(state.assistantUsageByKey.values()).map((entry: any) => entry && entry.usage)
      );
    }

    function emitStorageWarning(error: any) {
      if (!error) {
        return;
      }

      const message = error.stack || error.message || String(error);
      emit('storage_warning', { message });
      writeStderr(`sqlite warning: ${message}\n`);
    }

    function appendAssistantFallback(message: any) {
      const key = getAssistantMessageKey(message);

      if (!key || state.streamedAssistantMessages.has(key) || state.printedFallbackMessages.has(key)) {
        return;
      }

      const text = extractAssistantText(message);

      if (!text) {
        return;
      }

      state.printedFallbackMessages.add(key);
      state.reply += text;
      emit('assistant_text_delta', { delta: text, isFallback: true, messageKey: key, message });
      writeStdout(text);
    }

    function emitAssistantError(message: any) {
      const key = getAssistantMessageKey(message);

      if (
        !key ||
        state.printedAssistantErrors.has(key) ||
        message.role !== 'assistant' ||
        message.stopReason !== 'error' ||
        !message.errorMessage
      ) {
        return;
      }

      state.printedAssistantErrors.add(key);
      state.assistantErrors.push(message.errorMessage);
      emit('assistant_error', { messageKey: key, errorMessage: message.errorMessage, message });
      writeStderr(`assistant error: ${message.errorMessage}\n`);
    }

    function cleanup() {
      if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
        heartbeatTimeout = null;
      }

      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }

      while (processHandlers.length > 0) {
        const entry = processHandlers.pop();

        if (!entry) {
          break;
        }

        const [eventName, handler] = entry;
        process.removeListener(eventName, handler);
      }

      if (store) {
        try {
          store.close();
        } catch (error) {
          emitStorageWarning(error);
        }

        store = null;
      }

    }

    function persistRun(result: any) {
      if (!store || !runRecord || !runRecord.runId) {
        return;
      }

      try {
        store.finishRun(runRecord.runId, result);
      } catch (error) {
        emitStorageWarning(error);
      }
    }

    beginTermination = (reason: any) => {
      if (terminating || settled) {
        return;
      }

      terminating = true;
      terminationReason = reason;

      if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
        heartbeatTimeout = null;
      }

      emit('run_terminating', { reason });
      let abortRequested = false;

      if (child && child.connected && typeof child.send === 'function') {
        try {
          child.send({ type: 'abort', reason }, (error: any) => {
            if (error && !settled) {
              terminateProcessTree(child, false);
            }
          });
          abortRequested = true;
        } catch {
          abortRequested = false;
        }
      }

      if (!abortRequested) {
        terminateProcessTree(child, false);
      }

      if (terminateGraceMs > 0) {
        forceKillTimeout = setTimeout(() => {
          terminateProcessTree(child, true);
        }, terminateGraceMs);

        if (typeof forceKillTimeout.unref === 'function') {
          forceKillTimeout.unref();
        }
      } else {
        terminateProcessTree(child, true);
      }
    };

    function requestExpectedCompletion(message: any) {
      if (!isTerminalAssistantMessage(message) || terminating || settled) {
        return;
      }

      ignoreFurtherAssistantOutput = true;
      beginTermination({
        type: 'expected_completion',
        message: '',
        assistantStopReason: normalizeStopReason(message.stopReason) || null,
        assistantMessageKey: getAssistantMessageKey(message) || null,
      });
    }

    function refreshHeartbeatTimeout() {
      if (!heartbeatTimeoutMs || settled || terminating) {
        return;
      }

      if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
      }

      heartbeatTimeout = setTimeout(() => {
        beginTermination({
          type: 'heartbeat_timeout',
          message: `pi heartbeat missing for ${heartbeatTimeoutMs}ms`,
        });
      }, heartbeatTimeoutMs);

      if (typeof heartbeatTimeout.unref === 'function') {
        heartbeatTimeout.unref();
      }
    }

    function addProcessHandler(eventName: any, handler: any) {
      process.on(eventName, handler);
      processHandlers.push([eventName, handler]);
    }

    function finishWithError(error: any) {
      if (settled) {
        return;
      }

      if (runRecord && runRecord.runId) {
        error.runId = runRecord.runId;
      }

      if (runRecord && runRecord.databasePath) {
        error.databasePath = runRecord.databasePath;
      }

      persistRun({
        status: 'failed',
        exitCode: error.exitCode ?? error.code ?? null,
        signal: error.signal || null,
        terminationType: error.terminationReason ? error.terminationReason.type : null,
        terminationSignal: error.terminationReason ? error.terminationReason.signal || null : null,
        errorMessage: error.message,
        reply: error.reply ?? state.reply,
        stderrTail: error.stderrTail ?? state.stderrTail,
        parseErrors: typeof error.parseErrors === 'number' ? error.parseErrors : state.parseErrors,
        assistantErrors: Array.isArray(error.assistantErrors) ? error.assistantErrors : state.assistantErrors,
        usage: error.usage !== undefined ? error.usage : state.assistantUsage,
        usageCalls: error.usageCalls !== undefined ? error.usageCalls : assistantUsageCallsFromState(state),
      });

      emit('run_failed', { error, runId: runRecord ? runRecord.runId : null });
      settled = true;
      cleanup();
      reject(error);
    }

    function finishWithResult(result: any) {
      if (settled) {
        return;
      }

      if (runRecord && runRecord.runId) {
        result.runId = runRecord.runId;
      }

      if (runRecord && runRecord.databasePath) {
        result.databasePath = runRecord.databasePath;
      }

      persistRun({
        status: 'succeeded',
        exitCode: result.code ?? 0,
        signal: result.signal || null,
        terminationType: null,
        terminationSignal: null,
        errorMessage: null,
        reply: result.reply,
        stderrTail: result.stderrTail,
        parseErrors: result.parseErrors,
        assistantErrors: result.assistantErrors,
        usage: result.usage !== undefined ? result.usage : state.assistantUsage,
        usageCalls: result.usageCalls !== undefined ? result.usageCalls : assistantUsageCallsFromState(state),
      });

      emit('run_succeeded', { result, runId: result.runId || null });
      settled = true;
      cleanup();
      resolve(result);
    }

    if (sessionPath) {
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    }

    try {
      store = createSqliteRunStore({ agentDir, sqlitePath });
      runRecord = store.startRun({
        sessionPath,
        requestedSession: options.session,
        requestedResume: resume,
        provider,
        model,
        thinking,
        prompt,
        heartbeatIntervalMs,
        heartbeatTimeoutMs,
        terminateGraceMs,
        cwd,
        parentRunId: options.parentRunId,
        taskId: options.taskId,
        taskKind: options.taskKind,
        taskRole: options.taskRole,
        metadata: options.metadata,
      });
    } catch (error) {
      emitStorageWarning(error);
      runRecord = { runId: null, databasePath: store ? store.databasePath : null };

      if (store) {
        try {
          store.close();
        } catch {}
      }

      store = null;
    }

    function handlePiEvent(event: any) {
      emit('pi_event', { piEvent: event });

      if (ignoreFurtherAssistantOutput && (event.type === 'message_update' || event.type === 'message_end' || event.type === 'agent_end')) {
        return;
      }

      if (
        event.type === 'message_update' &&
        event.message &&
        event.message.role === 'assistant' &&
        event.assistantMessageEvent &&
        event.assistantMessageEvent.type === 'text_delta'
      ) {
        const key = getAssistantMessageKey(event.message);
        const chunk = event.assistantMessageEvent.delta || '';

        if (key) {
          state.streamedAssistantMessages.add(key);
        }

        state.reply += chunk;
        emit('assistant_text_delta', { delta: chunk, isFallback: false, messageKey: key || null, message: event.message });
        writeStdout(chunk);
        return;
      }

      if (event.type === 'message_end' && event.message && event.message.role === 'assistant') {
        recordAssistantUsage(event.message);
        emit('assistant_message', { messageKey: getAssistantMessageKey(event.message) || null, message: event.message, text: extractAssistantText(event.message) });
        appendAssistantFallback(event.message);
        emitAssistantError(event.message);
        requestExpectedCompletion(event.message);
        return;
      }

      if (event.type === 'agent_end' && Array.isArray(event.messages)) {
        for (const message of event.messages) {
          if (message && message.role === 'assistant') {
            recordAssistantUsage(message);
            emit('assistant_message', { messageKey: getAssistantMessageKey(message) || null, message, text: extractAssistantText(message) });
            appendAssistantFallback(message);
            emitAssistantError(message);
            requestExpectedCompletion(message);

            if (ignoreFurtherAssistantOutput) {
              break;
            }
          }
        }
      }
    }

    function recordProtocolError(message: any) {
      let line;

      try {
        line = JSON.stringify(message);
      } catch {
        line = String(message);
      }

      state.parseErrors += 1;
      pushRecentLine(state.stdoutLines, line, MAX_DEBUG_LINES);
      emit('stdout_parse_error', { line, parseErrors: state.parseErrors, source: 'ipc' });
    }

    child = fork(SDK_HOST_PATH, [], {
      cwd,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        ...normalizeExtraEnv(options.extraEnv),
      },
      execPath: process.execPath,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    emit('run_started', { runId: runRecord ? runRecord.runId : null, pid: child.pid || null, sessionPath: sessionPath || null });
    refreshHeartbeatTimeout();

    addProcessHandler('SIGINT', () => beginTermination({ type: 'parent_signal', signal: 'SIGINT', message: 'Parent process received SIGINT' }));
    addProcessHandler('SIGTERM', () => beginTermination({ type: 'parent_signal', signal: 'SIGTERM', message: 'Parent process received SIGTERM' }));

    if (process.platform === 'win32') {
      addProcessHandler('SIGBREAK', () => beginTermination({ type: 'parent_signal', signal: 'SIGBREAK', message: 'Parent process received SIGBREAK' }));
    }

    addProcessHandler('exit', () => terminateProcessTree(child, true, true));

    child.on('message', (message: any) => {
      if (!message || typeof message !== 'object') {
        recordProtocolError(message);
        return;
      }

      if (message.type === 'heartbeat') {
        state.heartbeatCount += 1;
        emit('heartbeat', {
          count: state.heartbeatCount,
          payload: { timestamp: message.timestamp ?? null },
        });
        refreshHeartbeatTimeout();
        return;
      }

      if (message.type === 'ready') {
        refreshHeartbeatTimeout();
        return;
      }

      if (message.type === 'pi_event' && message.event && typeof message.event === 'object') {
        handlePiEvent(message.event);
        return;
      }

      if (message.type === 'host_error') {
        return;
      }

      recordProtocolError(message);
    });

    child.on('exit', (code: any, signal: any) => {
      childState.code = code;
      childState.signal = signal;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: any) => {
      stderrBuffer += chunk;

      while (true) {
        const newlineIndex = stderrBuffer.indexOf('\n');

        if (newlineIndex === -1) {
          break;
        }

        const rawLine = stderrBuffer.slice(0, newlineIndex);
        stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        const forwardedLine = `${line}\n`;
        state.stderrTail = appendTailText(state.stderrTail, forwardedLine, MAX_STDERR_TAIL_LENGTH);
        emit('stderr', { text: line });
        writeStderr(forwardedLine);
      }
    });

    child.on('error', (error: any) => {
      finishWithError(createInvokeError(`Failed to start pi: ${error.message}`, {
        cause: error,
        reply: state.reply,
        sessionPath: sessionPath || null,
        stderrTail: state.stderrTail,
        stdoutLines: [...state.stdoutLines],
        parseErrors: state.parseErrors,
      }));
    });

    child.on('close', (code: any, signal: any) => {
      const finalCode = childState.code === null ? code : childState.code;
      const finalSignal = childState.signal === null ? signal : childState.signal;

      if (stderrBuffer) {
        const line = stderrBuffer.endsWith('\r') ? stderrBuffer.slice(0, -1) : stderrBuffer;
        state.stderrTail = appendTailText(state.stderrTail, line, MAX_STDERR_TAIL_LENGTH);
        emit('stderr', { text: line });
        writeStderr(line);

        stderrBuffer = '';
      }

      if (streamOutput && state.reply) {
        writeStdout('\n');
      }

      const result = {
        code: finalCode,
        signal: finalSignal || null,
        reply: state.reply,
        sessionPath: sessionPath || null,
        stderrTail: state.stderrTail,
        assistantErrors: [...state.assistantErrors],
        parseErrors: state.parseErrors,
        stdoutLines: [...state.stdoutLines],
        heartbeatCount: state.heartbeatCount,
        usage: state.assistantUsage,
        usageCalls: assistantUsageCallsFromState(state),
      };

      if (terminationReason && terminationReason.type === 'expected_completion') {
        finishWithResult({
          ...result,
          code: 0,
          signal: null,
          completionStopReason: terminationReason.assistantStopReason || null,
          completionMessageKey: terminationReason.assistantMessageKey || null,
        });
        return;
      }

      if (terminationReason) {
        finishWithError(createInvokeError(terminationReason.message, {
          ...result,
          exitCode: terminationReason.signal ? signalToExitCode(terminationReason.signal) : 1,
          terminationReason,
        }));
        return;
      }

      if (finalSignal) {
        finishWithError(createInvokeError(`pi exited due to signal ${finalSignal}`, { ...result, exitCode: signalToExitCode(finalSignal) }));
        return;
      }

      if (typeof finalCode === 'number' && finalCode !== 0) {
        finishWithError(createInvokeError(`pi exited with code ${finalCode}`, { ...result, exitCode: finalCode }));
        return;
      }

      finishWithResult(result);
    });

    try {
      child.send({
        type: 'start',
        prompt: String(prompt),
        config: {
          provider: provider || '',
          model: model || '',
          thinking: thinking || '',
          agentDir,
          sessionPath: sessionPath || '',
          resume,
          cwd,
          heartbeatIntervalMs,
          extensionPaths,
        },
      }, (error: any) => {
        if (!error) {
          return;
        }

        finishWithError(createInvokeError(`Failed to send SDK host start command: ${error.message}`, {
          cause: error,
          reply: state.reply,
          sessionPath: sessionPath || null,
          stderrTail: state.stderrTail,
          stdoutLines: [...state.stdoutLines],
          parseErrors: state.parseErrors,
        }));
      });
    } catch (error: any) {
      finishWithError(createInvokeError(`Failed to send SDK host start command: ${error.message}`, {
        cause: error,
        reply: state.reply,
        sessionPath: sessionPath || null,
        stderrTail: state.stderrTail,
        stdoutLines: [...state.stdoutLines],
        parseErrors: state.parseErrors,
      }));
    }
  });

  const handle = {
    on(eventName: any, listener: any) {
      emitter.on(eventName, listener);
      return handle;
    },
    once(eventName: any, listener: any) {
      emitter.once(eventName, listener);
      return handle;
    },
    off(eventName: any, listener: any) {
      if (typeof emitter.off === 'function') {
        emitter.off(eventName, listener);
      } else {
        emitter.removeListener(eventName, listener);
      }

      return handle;
    },
    cancel(reason = 'Run cancelled by caller') {
      beginTermination({ type: 'cancelled', message: reason });
      return handle;
    },
    complete(reason = 'Run completed by caller') {
      beginTermination({
        type: 'expected_completion',
        message: reason,
        assistantStopReason: null,
        assistantMessageKey: null,
      });
      return handle;
    },
    resultPromise,
  };

  Object.defineProperties(handle, {
    runId: { enumerable: true, get: () => (runRecord && runRecord.runId ? runRecord.runId : null) },
    databasePath: { enumerable: true, get: () => (runRecord && runRecord.databasePath ? runRecord.databasePath : null) },
    sessionPath: { enumerable: true, get: () => sessionPath || null },
    pid: { enumerable: true, get: () => (child && child.pid ? child.pid : null) },
  });

  return handle;
}

function invoke(provider: any, model: any, prompt: any, options: any = {}) {
  try {
    return startRun(provider, model, prompt, options).resultPromise;
  } catch (error) {
    return Promise.reject(error);
  }
}

export {
  DEFAULT_AGENT_DIR,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_TERMINATE_GRACE_MS,
  DEFAULT_THINKING,
  getProviderDefaultThinking,
  invoke,
  resolveDefaultAgentDir,
  resolveIntegerSetting,
  resolveIntegerSettingCandidates,
  resolveSessionPath,
  resolveSetting,
  resolveThinkingSetting,
  sanitizeSessionName,
  startRun,
};
