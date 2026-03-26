const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const { createSqliteRunStore } = require('./sqlite-store');
const { tryCreateDirectPiNodeSpawnSpec } = require('./pi-cli-spawn');
const { getPiPromptStdio, writePiPromptToStdin } = require('./pi-prompt-transport');

const DEFAULT_PROVIDER = 'kimi-coding';
const DEFAULT_MODEL = 'k2p5';
const DEFAULT_THINKING = '';
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 1000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60 * 1000;
const DEFAULT_TERMINATE_GRACE_MS = 5 * 1000;
const MAX_STDERR_TAIL_LENGTH = 4000;
const MAX_DEBUG_LINES = 10;
const HEARTBEAT_PREFIX = '__PI_HEARTBEAT__';
const HEARTBEAT_EXTENSION_PATH = path.resolve(__dirname, 'pi-heartbeat-extension.mjs');
const DEFAULT_AGENT_DIR = resolveDefaultAgentDir();

function resolveSetting(cliValue, envValue, fallbackValue) {
  return String(cliValue || envValue || fallbackValue || '').trim();
}

function resolveIntegerSetting(cliValue, envValue, fallbackValue, name) {
  return resolveIntegerSettingCandidates([cliValue, envValue, fallbackValue], name);
}

function resolveIntegerSettingCandidates(candidates, name) {
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

  if (!runtimeEnv) {
    return path.join(process.cwd(), '.pi-sandbox');
  }

  return path.join(process.cwd(), `.pi-sandbox-${runtimeEnv}`);
}

function sanitizeSessionName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function looksLikeSessionPath(value) {
  return path.isAbsolute(value) || value.includes('/') || value.includes('\\') || value.endsWith('.jsonl');
}

function resolveSessionPath(sessionValue, agentDir) {
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

function normalizeExtraEnv(extraEnv) {
  if (!extraEnv || typeof extraEnv !== 'object') {
    return {};
  }

  const normalized = {};

  for (const [key, value] of Object.entries(extraEnv)) {
    const envName = String(key || '').trim();

    if (!envName || value === undefined || value === null) {
      continue;
    }

    normalized[envName] = String(value);
  }

  return normalized;
}

function getHeartbeatPayload(line) {
  if (!line.startsWith(HEARTBEAT_PREFIX)) {
    return null;
  }

  const payloadText = line.slice(HEARTBEAT_PREFIX.length).trim();

  if (!payloadText) {
    return {};
  }

  try {
    return JSON.parse(payloadText);
  } catch {
    return { raw: payloadText };
  }
}

function findGitBash() {
  const candidates = [
    process.env.GIT_BASH_PATH,
    'C:\\Environment\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'bash',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'bash' || fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return 'bash';
}

const bashPath = findGitBash();

function findPiScriptPath() {
  const override = process.env.PI_COMMAND_PATH;

  if (override && fs.existsSync(override)) {
    return override;
  }

  if (process.platform !== 'win32') {
    return 'pi';
  }

  try {
    const result = spawnSync('where.exe', ['pi.cmd'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });

    if (result.status === 0 && result.stdout) {
      const lines = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      if (lines.length > 0) {
        const piCmdPath = lines[0];
        const piPs1Path = piCmdPath.replace(/\.cmd$/i, '.ps1');

        if (fs.existsSync(piPs1Path)) {
          return piPs1Path;
        }
      }
    }
  } catch {}

  return 'pi';
}

const piScriptPath = findPiScriptPath();

function createPiSpawnSpec(piArgs) {
  const directNodeSpawnSpec = tryCreateDirectPiNodeSpawnSpec(piScriptPath, piArgs);

  if (directNodeSpawnSpec) {
    return directNodeSpawnSpec;
  }

  if (process.platform === 'win32' && piScriptPath.toLowerCase().endsWith('.ps1')) {
    return {
      command: process.env.POWERSHELL_PATH || 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', piScriptPath, ...piArgs],
    };
  }

  if (process.platform === 'win32') {
    return {
      command: piScriptPath,
      args: piArgs,
    };
  }

  return {
    command: bashPath,
    args: ['-lc', 'pi "$@"', 'bash', ...piArgs],
  };
}

function getAssistantMessageKey(message) {
  if (!message || message.role !== 'assistant') {
    return '';
  }

  if (message.responseId) {
    return `response:${message.responseId}`;
  }

  return `timestamp:${message.timestamp}:${message.provider || ''}:${message.model || ''}`;
}

function extractAssistantText(message) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) {
    return '';
  }

  return message.content
    .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('');
}

function normalizeStopReason(stopReason) {
  return String(stopReason || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function assistantMessageHasPendingToolUse(message) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) {
    return false;
  }

  return message.content.some((item) => {
    const type = String(item && item.type ? item.type : '')
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');

    return type === 'tool_use' || type === 'tooluse' || type === 'tool_call' || type === 'toolcall';
  });
}

function isTerminalAssistantMessage(message) {
  if (!message || message.role !== 'assistant') {
    return false;
  }

  const stopReason = normalizeStopReason(message.stopReason);

  if (stopReason === 'error' || stopReason === 'tool_use' || stopReason === 'tooluse' || stopReason === 'pause_turn') {
    return false;
  }

  return !assistantMessageHasPendingToolUse(message);
}

function appendTailText(existing, chunk, limit) {
  const next = `${existing}${chunk}`;
  return next.length <= limit ? next : next.slice(-limit);
}

function pushRecentLine(lines, line, limit) {
  lines.push(line);

  if (lines.length > limit) {
    lines.shift();
  }
}

function terminateProcessTree(child, force = false, sync = false) {
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

function signalToExitCode(signal) {
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

function createInvokeError(message, details = {}) {
  const error = new Error(message);
  error.name = 'InvokeError';
  Object.assign(error, details);
  return error;
}

function startRun(provider, model, prompt, options: any = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error('Prompt is required');
  }

  const emitter = new EventEmitter();
  const thinking = resolveSetting(options.thinking, process.env.PI_THINKING, DEFAULT_THINKING);
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
  const streamOutput = options.streamOutput !== false;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  let child = null;
  let runRecord = null;
  let beginTermination = (reason) => {};

  function emit(type, payload = {}) {
    const event = {
      type,
      timestamp: new Date().toISOString(),
      ...payload,
    };

    emitter.emit('event', event);
    emitter.emit(type, event);
    return event;
  }

  function writeStdout(text) {
    if (streamOutput && text) {
      stdout.write(text);
    }
  }

  function writeStderr(text) {
    if (streamOutput && text) {
      stderr.write(text);
    }
  }

  const resultPromise = new Promise((resolve, reject) => {
    const piArgs = [];
    let store = null;
    let rl = null;
    const state = {
      reply: '',
      assistantErrors: [],
      stderrTail: '',
      parseErrors: 0,
      stdoutLines: [],
      streamedAssistantMessages: new Set(),
      printedFallbackMessages: new Set(),
      printedAssistantErrors: new Set(),
      heartbeatCount: 0,
    };
    const childState = { code: null, signal: null };
    const processHandlers = [];
    let settled = false;
    let terminating = false;
    let heartbeatTimeout = null;
    let forceKillTimeout = null;
    let terminationReason = null;
    let stderrBuffer = '';
    let ignoreFurtherAssistantOutput = false;

    function emitStorageWarning(error) {
      if (!error) {
        return;
      }

      const message = error.stack || error.message || String(error);
      emit('storage_warning', { message });
      writeStderr(`sqlite warning: ${message}\n`);
    }

    function appendAssistantFallback(message) {
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

    function emitAssistantError(message) {
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
        const [eventName, handler] = processHandlers.pop();
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

      if (rl) {
        rl.close();
        rl = null;
      }
    }

    function persistRun(result) {
      if (!store || !runRecord || !runRecord.runId) {
        return;
      }

      try {
        store.finishRun(runRecord.runId, result);
      } catch (error) {
        emitStorageWarning(error);
      }
    }

    beginTermination = (reason) => {
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
      terminateProcessTree(child, false);

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

    function requestExpectedCompletion(message) {
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

    function addProcessHandler(eventName, handler) {
      process.on(eventName, handler);
      processHandlers.push([eventName, handler]);
    }

    function finishWithError(error) {
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
      });

      emit('run_failed', { error, runId: runRecord ? runRecord.runId : null });
      settled = true;
      cleanup();
      reject(error);
    }

    function finishWithResult(result) {
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
      });

      emit('run_succeeded', { result, runId: result.runId || null });
      settled = true;
      cleanup();
      resolve(result);
    }

    if (provider) {
      piArgs.push('--provider', provider);
    }

    if (model) {
      piArgs.push('--model', model);
    }

    if (thinking) {
      piArgs.push('--thinking', thinking);
    }

    piArgs.push('--mode', 'json', '--print');
    piArgs.push('--extension', HEARTBEAT_EXTENSION_PATH);

    if (sessionPath) {
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      piArgs.push('--session', sessionPath);
    } else if (resume) {
      piArgs.push('--continue');
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
        cwd: process.cwd(),
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

    const piSpawnSpec = createPiSpawnSpec(piArgs);
    child = spawn(piSpawnSpec.command, piSpawnSpec.args, {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_HEARTBEAT_INTERVAL_MS: String(heartbeatIntervalMs),
        PI_HEARTBEAT_PREFIX: HEARTBEAT_PREFIX,
        ...normalizeExtraEnv(options.extraEnv),
      },
      stdio: getPiPromptStdio(),
      windowsHide: true,
    });

    writePiPromptToStdin(child, prompt);

    rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    emit('run_started', { runId: runRecord ? runRecord.runId : null, pid: child.pid || null, sessionPath: sessionPath || null });
    refreshHeartbeatTimeout();

    addProcessHandler('SIGINT', () => beginTermination({ type: 'parent_signal', signal: 'SIGINT', message: 'Parent process received SIGINT' }));
    addProcessHandler('SIGTERM', () => beginTermination({ type: 'parent_signal', signal: 'SIGTERM', message: 'Parent process received SIGTERM' }));

    if (process.platform === 'win32') {
      addProcessHandler('SIGBREAK', () => beginTermination({ type: 'parent_signal', signal: 'SIGBREAK', message: 'Parent process received SIGBREAK' }));
    }

    addProcessHandler('exit', () => terminateProcessTree(child, true, true));

    rl.on('line', (line) => {
      if (!line.trim()) {
        return;
      }

      let event;

      try {
        event = JSON.parse(line);
      } catch {
        state.parseErrors += 1;
        pushRecentLine(state.stdoutLines, line, MAX_DEBUG_LINES);
        emit('stdout_parse_error', { line, parseErrors: state.parseErrors });
        return;
      }

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
        emit('assistant_message', { messageKey: getAssistantMessageKey(event.message) || null, message: event.message, text: extractAssistantText(event.message) });
        appendAssistantFallback(event.message);
        emitAssistantError(event.message);
        requestExpectedCompletion(event.message);
        return;
      }

      if (event.type === 'agent_end' && Array.isArray(event.messages)) {
        for (const message of event.messages) {
          if (message && message.role === 'assistant') {
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
    });

    child.on('exit', (code, signal) => {
      childState.code = code;
      childState.signal = signal;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk;

      while (true) {
        const newlineIndex = stderrBuffer.indexOf('\n');

        if (newlineIndex === -1) {
          break;
        }

        const rawLine = stderrBuffer.slice(0, newlineIndex);
        stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        const heartbeatPayload = getHeartbeatPayload(line);

        if (heartbeatPayload !== null) {
          state.heartbeatCount += 1;
          emit('heartbeat', { count: state.heartbeatCount, payload: heartbeatPayload });
          refreshHeartbeatTimeout();
          continue;
        }

        const forwardedLine = `${line}\n`;
        state.stderrTail = appendTailText(state.stderrTail, forwardedLine, MAX_STDERR_TAIL_LENGTH);
        emit('stderr', { text: line });
        writeStderr(forwardedLine);
      }
    });

    child.on('error', (error) => {
      finishWithError(createInvokeError(`Failed to start pi: ${error.message}`, {
        cause: error,
        reply: state.reply,
        sessionPath: sessionPath || null,
        stderrTail: state.stderrTail,
        stdoutLines: [...state.stdoutLines],
        parseErrors: state.parseErrors,
      }));
    });

    child.on('close', (code, signal) => {
      const finalCode = childState.code === null ? code : childState.code;
      const finalSignal = childState.signal === null ? signal : childState.signal;

      if (stderrBuffer) {
        const line = stderrBuffer.endsWith('\r') ? stderrBuffer.slice(0, -1) : stderrBuffer;
        const heartbeatPayload = getHeartbeatPayload(line);

        if (heartbeatPayload !== null) {
          state.heartbeatCount += 1;
          emit('heartbeat', { count: state.heartbeatCount, payload: heartbeatPayload });
        } else {
          state.stderrTail = appendTailText(state.stderrTail, line, MAX_STDERR_TAIL_LENGTH);
          emit('stderr', { text: line });
          writeStderr(line);
        }

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
  });

  const handle = {
    on(eventName, listener) {
      emitter.on(eventName, listener);
      return handle;
    },
    once(eventName, listener) {
      emitter.once(eventName, listener);
      return handle;
    },
    off(eventName, listener) {
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

function invoke(provider, model, prompt, options = {}) {
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
  invoke,
  resolveDefaultAgentDir,
  resolveIntegerSetting,
  resolveIntegerSettingCandidates,
  resolveSessionPath,
  resolveSetting,
  sanitizeSessionName,
  startRun,
};
