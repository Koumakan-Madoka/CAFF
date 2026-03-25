const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const { createSqliteRunStore } = require('./sqlite-store');
const runtime = require('./pi-runtime');
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

function parseCliArgs(argv) {
  const result = {
    provider: '',
    model: '',
    thinking: '',
    sqlitePath: '',
    heartbeatIntervalMs: undefined,
    heartbeatTimeoutMs: undefined,
    terminateGraceMs: undefined,
    resume: false,
    session: '',
    prompt: '',
  };
  const promptParts = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (
      arg === '--provider' ||
      arg === '--model' ||
      arg === '--thinking' ||
      arg === '--session' ||
      arg === '-s' ||
      arg === '--db-path' ||
      arg === '--heartbeat-interval-ms' ||
      arg === '--heartbeat-timeout-ms' ||
      arg === '--timeout-ms' ||
      arg === '--idle-timeout-ms' ||
      arg === '--terminate-grace-ms'
    ) {
      const value = argv[i + 1];

      if (!value || value.startsWith('--')) {
        console.error(`Missing value for ${arg}`);
        process.exit(1);
      }

      if (arg === '--provider') {
        result.provider = value;
      } else if (arg === '--model') {
        result.model = value;
      } else if (arg === '--session' || arg === '-s') {
        result.session = value;
      } else if (arg === '--db-path') {
        result.sqlitePath = value;
      } else if (arg === '--heartbeat-interval-ms') {
        result.heartbeatIntervalMs = value;
      } else if (arg === '--heartbeat-timeout-ms' || arg === '--timeout-ms' || arg === '--idle-timeout-ms') {
        result.heartbeatTimeoutMs = value;
      } else if (arg === '--terminate-grace-ms') {
        result.terminateGraceMs = value;
      } else {
        result.thinking = value;
      }

      i += 1;
      continue;
    }

    if (arg === '--resume' || arg === '-r' || arg === '--continue' || arg === '-c') {
      result.resume = true;
      continue;
    }

    promptParts.push(arg);
  }

  result.prompt = promptParts.join(' ').trim();
  return result;
}

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

function appendAssistantFallback(state, message) {
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
  process.stdout.write(text);
}

function emitAssistantError(state, message) {
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
  process.stderr.write(`assistant error: ${message.errorMessage}\n`);
}

function appendTailText(existing, chunk, limit) {
  const next = `${existing}${chunk}`;

  if (next.length <= limit) {
    return next;
  }

  return next.slice(-limit);
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

function emitStorageWarning(error) {
  if (!error) {
    return;
  }

  const message = error.stack || error.message || String(error);
  process.stderr.write(`sqlite warning: ${message}\n`);
}

function printInvokeError(error) {
  if (!error) {
    console.error('Unknown invoke error');
    return;
  }

  console.error(error.stack || error.message || String(error));

  if (error.runId) {
    console.error(`run id: ${error.runId}`);
  }

  if (error.databasePath) {
    console.error(`sqlite db: ${error.databasePath}`);
  }

  if (error.signal) {
    console.error(`signal: ${error.signal}`);
  }

  if (typeof error.parseErrors === 'number' && error.parseErrors > 0) {
    console.error(`non-JSON stdout lines: ${error.parseErrors}`);
  }

  if (Array.isArray(error.stdoutLines) && error.stdoutLines.length > 0) {
    console.error('recent stdout lines:');

    for (const line of error.stdoutLines) {
      console.error(line);
    }
  }

  if (error.stderrTail) {
    console.error('stderr tail:');
    console.error(error.stderrTail);
  }
}

function invoke(provider, model, prompt, options = {}) {
  return new Promise((resolve, reject) => {
    if (!prompt || !String(prompt).trim()) {
      reject(new Error('Prompt is required'));
      return;
    }

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
    const piArgs = [];
    let store = null;
    let runRecord = null;

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

    const piSpawnSpec = createPiSpawnSpec(piArgs);
    const child = spawn(piSpawnSpec.command, piSpawnSpec.args, {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_HEARTBEAT_INTERVAL_MS: String(heartbeatIntervalMs),
        PI_HEARTBEAT_PREFIX: HEARTBEAT_PREFIX,
      },
      stdio: getPiPromptStdio(),
      windowsHide: true,
    });

    writePiPromptToStdin(child, prompt);

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

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
    const childState = {
      code: null,
      signal: null,
    };
    const processHandlers = [];
    let settled = false;
    let terminating = false;
    let heartbeatTimeout = null;
    let forceKillTimeout = null;
    let terminationReason = null;
    let stderrBuffer = '';
    let ignoreFurtherAssistantOutput = false;

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

    function beginTermination(reason) {
      if (terminating || settled) {
        return;
      }

      terminating = true;
      terminationReason = reason;

      if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
        heartbeatTimeout = null;
      }

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
    }

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

      settled = true;
      cleanup();
      rl.close();
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

      settled = true;
      cleanup();
      rl.close();
      resolve(result);
    }

    refreshHeartbeatTimeout();

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
      });
    } catch (error) {
      emitStorageWarning(error);
      runRecord = {
        runId: null,
        databasePath: store ? store.databasePath : null,
      };

      if (store) {
        try {
          store.close();
        } catch {}
      }

      store = null;
    }

    addProcessHandler('SIGINT', () => {
      beginTermination({
        type: 'parent_signal',
        signal: 'SIGINT',
        message: 'Parent process received SIGINT',
      });
    });

    addProcessHandler('SIGTERM', () => {
      beginTermination({
        type: 'parent_signal',
        signal: 'SIGTERM',
        message: 'Parent process received SIGTERM',
      });
    });

    if (process.platform === 'win32') {
      addProcessHandler('SIGBREAK', () => {
        beginTermination({
          type: 'parent_signal',
          signal: 'SIGBREAK',
          message: 'Parent process received SIGBREAK',
        });
      });
    }

    addProcessHandler('exit', () => {
      terminateProcessTree(child, true, true);
    });

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
        return;
      }

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
        process.stdout.write(chunk);
        return;
      }

      if (event.type === 'message_end' && event.message && event.message.role === 'assistant') {
        appendAssistantFallback(state, event.message);
        emitAssistantError(state, event.message);
        requestExpectedCompletion(event.message);
        return;
      }

      if (event.type === 'agent_end' && Array.isArray(event.messages)) {
        for (const message of event.messages) {
          if (message && message.role === 'assistant') {
            appendAssistantFallback(state, message);
            emitAssistantError(state, message);
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
          refreshHeartbeatTimeout();
          continue;
        }

        const forwardedLine = `${line}\n`;
        state.stderrTail = appendTailText(state.stderrTail, forwardedLine, MAX_STDERR_TAIL_LENGTH);
        process.stderr.write(forwardedLine);
      }
    });

    child.on('error', (error) => {
      finishWithError(
        createInvokeError(`Failed to start pi: ${error.message}`, {
          cause: error,
          reply: state.reply,
          sessionPath: sessionPath || null,
          stderrTail: state.stderrTail,
          stdoutLines: [...state.stdoutLines],
          parseErrors: state.parseErrors,
        })
      );
    });

    child.on('close', (code, signal) => {
      const finalCode = childState.code === null ? code : childState.code;
      const finalSignal = childState.signal === null ? signal : childState.signal;

      if (stderrBuffer) {
        const line = stderrBuffer.endsWith('\r') ? stderrBuffer.slice(0, -1) : stderrBuffer;
        const heartbeatPayload = getHeartbeatPayload(line);

        if (heartbeatPayload !== null) {
          state.heartbeatCount += 1;
        } else {
          state.stderrTail = appendTailText(state.stderrTail, line, MAX_STDERR_TAIL_LENGTH);
          process.stderr.write(line);
        }

        stderrBuffer = '';
      }

      if (state.reply) {
        process.stdout.write('\n');
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
        finishWithError(
          createInvokeError(terminationReason.message, {
            ...result,
            exitCode: terminationReason.signal ? signalToExitCode(terminationReason.signal) : 1,
            terminationReason,
          })
        );
        return;
      }

      if (finalSignal) {
        finishWithError(
          createInvokeError(`pi exited due to signal ${finalSignal}`, {
            ...result,
            exitCode: signalToExitCode(finalSignal),
          })
        );
        return;
      }

      if (typeof finalCode === 'number' && finalCode !== 0) {
        finishWithError(
          createInvokeError(`pi exited with code ${finalCode}`, {
            ...result,
            exitCode: finalCode,
          })
        );
        return;
      }

      finishWithResult(result);
    });
  });
}

module.exports = {
  DEFAULT_AGENT_DIR,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_TERMINATE_GRACE_MS,
  DEFAULT_THINKING,
  invoke: runtime.invoke,
  parseCliArgs,
  printInvokeError,
  resolveDefaultAgentDir,
  resolveIntegerSetting,
  resolveIntegerSettingCandidates,
  resolveSessionPath,
  resolveSetting,
  sanitizeSessionName,
  startRun: runtime.startRun,
};

if (require.main === module) {
  const cli = parseCliArgs(process.argv.slice(2));
  const prompt = cli.prompt;
  const provider = resolveSetting(cli.provider, process.env.PI_PROVIDER, DEFAULT_PROVIDER);
  const model = resolveSetting(cli.model, process.env.PI_MODEL, DEFAULT_MODEL);
  const thinking = resolveSetting(cli.thinking, process.env.PI_THINKING, DEFAULT_THINKING);
  const agentDir = resolveSetting('', process.env.PI_CODING_AGENT_DIR, DEFAULT_AGENT_DIR);
  const sqlitePath = resolveSetting(cli.sqlitePath, process.env.PI_SQLITE_PATH, '');
  const heartbeatIntervalMs = resolveIntegerSettingCandidates(
    [cli.heartbeatIntervalMs, process.env.PI_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_INTERVAL_MS],
    'heartbeatIntervalMs'
  );
  const heartbeatTimeoutMs = resolveIntegerSettingCandidates(
    [
      cli.heartbeatTimeoutMs,
      process.env.PI_HEARTBEAT_TIMEOUT_MS,
      process.env.PI_IDLE_TIMEOUT_MS,
      process.env.PI_TIMEOUT_MS,
      DEFAULT_HEARTBEAT_TIMEOUT_MS,
    ],
    'heartbeatTimeoutMs'
  );
  const terminateGraceMs = resolveIntegerSetting(
    cli.terminateGraceMs,
    process.env.PI_TERMINATE_GRACE_MS,
    DEFAULT_TERMINATE_GRACE_MS,
    'terminateGraceMs'
  );

  if (!prompt) {
    console.error(
      'Usage: node minimal-pi.js [--resume] [--session name|path] [--provider name] [--model name] [--thinking level] [--db-path path] [--heartbeat-interval-ms n] [--heartbeat-timeout-ms n] [--terminate-grace-ms n] "Say hello in one sentence"'
    );
    console.error(`Default provider: ${DEFAULT_PROVIDER}`);
    console.error(`Default model: ${DEFAULT_MODEL}`);
    console.error('Sessions are saved under PI_CODING_AGENT_DIR (defaults to ./.pi-sandbox).');
    console.error('Use --resume to continue the most recent session, or --session <name|path> to bind to a specific session.');
    console.error('If --session is a plain name, it is stored under ./.pi-sandbox/named-sessions/<name>.jsonl.');
    console.error(`Default heartbeatIntervalMs: ${DEFAULT_HEARTBEAT_INTERVAL_MS}`);
    console.error(`Default heartbeatTimeoutMs: ${DEFAULT_HEARTBEAT_TIMEOUT_MS}`);
    console.error(`Default terminateGraceMs: ${DEFAULT_TERMINATE_GRACE_MS}`);
    console.error('SQLite defaults to <agentDir>/pi-state.sqlite. Override with --db-path or PI_SQLITE_PATH.');
    console.error(
      'Optional env: PI_PROVIDER, PI_MODEL, PI_THINKING, PI_CODING_AGENT_DIR, PI_SQLITE_PATH, PI_HEARTBEAT_INTERVAL_MS, PI_HEARTBEAT_TIMEOUT_MS, PI_TERMINATE_GRACE_MS, PI_ENV, GIT_BASH_PATH'
    );
    process.exit(1);
  }

  runtime.invoke(provider, model, prompt, {
    thinking,
    agentDir,
    sqlitePath,
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    terminateGraceMs,
    resume: cli.resume,
    session: cli.session,
  }).catch((error) => {
    printInvokeError(error);
    process.exit(error.exitCode || 1);
  });
}
