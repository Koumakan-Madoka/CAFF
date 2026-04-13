// @ts-nocheck
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const MAX_STDERR_TAIL_LENGTH = 4000;
const MAX_DEBUG_LINES = 10;
const DEFAULT_CONTROL_POLL_INTERVAL_MS = 250;
const DEFAULT_TERMINATE_GRACE_MS = 1500;

function nowIso() {
  return new Date().toISOString();
}

function clipText(value, maxLength = 4000) {
  const text = String(value || '');
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(-maxLength);
}

function appendTailText(existing, chunk, limit) {
  const next = `${existing || ''}${chunk || ''}`;
  return next.length <= limit ? next : next.slice(-limit);
}

function pushRecentLine(lines, line, limit) {
  lines.push(line);
  if (lines.length > limit) {
    lines.shift();
  }
}

function getAssistantMessageKey(message) {
  if (!message || message.role !== 'assistant') {
    return '';
  }

  if (message.responseId) {
    return `response:${message.responseId}`;
  }

  return `timestamp:${message.timestamp || ''}:${message.provider || ''}:${message.model || ''}`;
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

    return type === 'tool_use' || type === 'tooluse' || type === 'tool_call' || type === 'toolcall' || type === 'pause_turn';
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

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(pathValue, value) {
  ensureDir(path.dirname(pathValue));
  fs.writeFileSync(pathValue, JSON.stringify(value, null, 2), 'utf8');
}

function loadInput(inputPath) {
  const raw = fs.readFileSync(inputPath, 'utf8');
  return JSON.parse(raw);
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function clearFileIfPresent(targetPath) {
  const normalized = String(targetPath || '').trim();
  if (!normalized) {
    return;
  }
  ensureDir(path.dirname(normalized));
  try {
    fs.unlinkSync(normalized);
  } catch {}
}

function resetEventLog(eventPath) {
  const normalized = String(eventPath || '').trim();
  if (!normalized) {
    return;
  }
  clearFileIfPresent(normalized);
  try {
    fs.writeFileSync(normalized, '', 'utf8');
  } catch {}
}

function appendEvent(eventPath, type, payload = {}) {
  const normalizedPath = String(eventPath || '').trim();
  const normalizedType = String(type || '').trim();
  if (!normalizedPath || !normalizedType) {
    return;
  }

  try {
    ensureDir(path.dirname(normalizedPath));
    fs.appendFileSync(
      normalizedPath,
      `${JSON.stringify({ type: normalizedType, payload, createdAt: nowIso() })}\n`,
      'utf8'
    );
  } catch {}
}

function readControlRequest(controlPath) {
  const normalizedPath = String(controlPath || '').trim();
  if (!normalizedPath || !fs.existsSync(normalizedPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(normalizedPath, 'utf8');
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return null;
  }
}

function terminateChild(child, force = false) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  } catch {}
}

async function runPi(input) {
  const piCliPath = String((input && input.piCliPath) || '').trim();
  const nodeCommand = String((input && input.nodeCommand) || 'node').trim() || 'node';
  const prompt = String((input && input.prompt) || '');
  const provider = String((input && input.provider) || '').trim();
  const model = String((input && input.model) || '').trim();
  const thinking = String((input && input.thinking) || '').trim();
  const sessionPath = String((input && input.sessionPath) || '').trim();
  const cwd = String((input && input.cwd) || '').trim() || process.cwd();
  const agentDir = String((input && input.agentDir) || '').trim();
  const extraEnv = input && input.extraEnv && typeof input.extraEnv === 'object' ? input.extraEnv : {};
  const eventPath = String((input && input.eventPath) || '').trim();
  const controlPath = String((input && input.controlPath) || '').trim();
  const controlPollIntervalMs = normalizePositiveInteger(input && input.controlPollIntervalMs, DEFAULT_CONTROL_POLL_INTERVAL_MS);
  const terminateGraceMs = normalizePositiveInteger(input && input.terminateGraceMs, DEFAULT_TERMINATE_GRACE_MS);

  if (!piCliPath) {
    throw new Error('Sandbox runner requires piCliPath');
  }
  if (!prompt.trim()) {
    throw new Error('Sandbox runner requires a non-empty prompt');
  }

  resetEventLog(eventPath);
  clearFileIfPresent(controlPath);
  appendEvent(eventPath, 'runner_status', {
    stage: 'preparing',
    label: '正在准备 sandbox runner…',
  });

  const args = [piCliPath];
  if (provider) {
    args.push('--provider', provider);
  }
  if (model) {
    args.push('--model', model);
  }
  if (thinking) {
    args.push('--thinking', thinking);
  }
  args.push('--mode', 'json', '--print');
  if (sessionPath) {
    ensureDir(path.dirname(sessionPath));
    args.push('--session', sessionPath);
  }
  args.push(prompt);

  return new Promise((resolve, reject) => {
    const child = spawn(nodeCommand, args, {
      cwd,
      env: {
        ...process.env,
        ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}),
        ...Object.fromEntries(
          Object.entries(extraEnv)
            .filter(([key, value]) => String(key || '').trim() && value !== undefined && value !== null)
            .map(([key, value]) => [String(key), String(value)])
        ),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
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
    };
    let stderrBuffer = '';
    let childExitCode = null;
    let childSignal = null;
    let settled = false;
    let terminating = false;
    let ignoreFurtherAssistantOutput = false;
    let terminationReason = null;
    let controlPollTimer = null;
    let forceKillTimer = null;

    function cleanupTimers() {
      if (controlPollTimer) {
        clearInterval(controlPollTimer);
        controlPollTimer = null;
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
    }

    function requestTermination(reason) {
      if (terminating || settled) {
        return;
      }

      terminating = true;
      terminationReason = reason && typeof reason === 'object'
        ? reason
        : { type: 'cancelled', message: String(reason || 'Sandbox run cancelled') };
      appendEvent(eventPath, 'run_terminating', { reason: terminationReason });
      appendEvent(eventPath, 'runner_status', {
        stage: 'terminating',
        label: '正在收尾…',
      });
      terminateChild(child, false);

      if (terminateGraceMs > 0) {
        forceKillTimer = setTimeout(() => {
          terminateChild(child, true);
        }, terminateGraceMs);
        if (typeof forceKillTimer.unref === 'function') {
          forceKillTimer.unref();
        }
      } else {
        terminateChild(child, true);
      }
    }

    function requestExpectedCompletion(message) {
      if (!isTerminalAssistantMessage(message) || terminating || settled) {
        return;
      }

      ignoreFurtherAssistantOutput = true;
      requestTermination({
        type: 'expected_completion',
        message: '',
        assistantStopReason: normalizeStopReason(message.stopReason) || null,
        assistantMessageKey: getAssistantMessageKey(message) || null,
      });
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
      appendEvent(eventPath, 'assistant_text_delta', {
        delta: text,
        isFallback: true,
        messageKey: key || null,
      });
    }

    function appendAssistantError(message) {
      const key = getAssistantMessageKey(message);
      const stopReason = normalizeStopReason(message && message.stopReason);
      if (!key || state.printedAssistantErrors.has(key) || !message || message.role !== 'assistant' || (stopReason !== 'error' && stopReason !== 'errored') || !message.errorMessage) {
        return;
      }
      state.printedAssistantErrors.add(key);
      state.assistantErrors.push(String(message.errorMessage));
    }

    function maybeApplyControlRequest() {
      if (!controlPath || terminating || settled) {
        return;
      }

      const request = readControlRequest(controlPath);
      if (!request) {
        return;
      }

      const action = String(request.action || request.type || 'cancel').trim().toLowerCase();
      const message = String(request.message || '').trim();

      if (action === 'complete' || action === 'expected_completion') {
        requestTermination({
          type: 'expected_completion',
          message,
          assistantStopReason: null,
          assistantMessageKey: null,
          requestedBy: 'host_control',
        });
        return;
      }

      requestTermination({
        type: 'cancelled',
        message: message || 'Sandbox run cancelled by control file',
        requestedBy: 'host_control',
      });
    }

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      maybeApplyControlRequest();
      if (!String(line || '').trim()) {
        return;
      }

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        state.parseErrors += 1;
        pushRecentLine(state.stdoutLines, String(line), MAX_DEBUG_LINES);
        appendEvent(eventPath, 'stdout_parse_error', {
          line: String(line),
          parseErrors: state.parseErrors,
        });
        return;
      }

      appendEvent(eventPath, 'pi_event', { piEvent: event });

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
        const chunk = String(event.assistantMessageEvent.delta || '');
        if (key) {
          state.streamedAssistantMessages.add(key);
        }
        state.reply += chunk;
        appendEvent(eventPath, 'assistant_text_delta', {
          delta: chunk,
          isFallback: false,
          messageKey: key || null,
        });
        return;
      }

      if (event.type === 'message_end' && event.message && event.message.role === 'assistant') {
        appendAssistantFallback(event.message);
        appendAssistantError(event.message);
        requestExpectedCompletion(event.message);
        return;
      }

      if (event.type === 'agent_end' && Array.isArray(event.messages)) {
        for (const message of event.messages) {
          if (!message || message.role !== 'assistant') {
            continue;
          }
          appendAssistantFallback(message);
          appendAssistantError(message);
          requestExpectedCompletion(message);
          if (ignoreFurtherAssistantOutput) {
            break;
          }
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      maybeApplyControlRequest();
      stderrBuffer += chunk;
      while (true) {
        const newlineIndex = stderrBuffer.indexOf('\n');
        if (newlineIndex === -1) {
          break;
        }
        const rawLine = stderrBuffer.slice(0, newlineIndex);
        stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        state.stderrTail = appendTailText(state.stderrTail, `${line}\n`, MAX_STDERR_TAIL_LENGTH);
      }
    });

    child.on('error', (error) => {
      cleanupTimers();
      rl.close();
      reject(error);
    });

    child.on('exit', (code, signal) => {
      childExitCode = code;
      childSignal = signal;
    });

    appendEvent(eventPath, 'run_started', {
      pid: child.pid || null,
      sessionPath,
    });
    appendEvent(eventPath, 'runner_status', {
      stage: 'running',
      label: '正在 sandbox 内执行…',
      pid: child.pid || null,
    });

    if (controlPath) {
      controlPollTimer = setInterval(maybeApplyControlRequest, controlPollIntervalMs);
      if (typeof controlPollTimer.unref === 'function') {
        controlPollTimer.unref();
      }
    }

    child.on('close', () => {
      cleanupTimers();
      rl.close();
      settled = true;
      if (stderrBuffer) {
        state.stderrTail = appendTailText(state.stderrTail, stderrBuffer, MAX_STDERR_TAIL_LENGTH);
      }

      const result = {
        status: childExitCode === 0 ? 'succeeded' : 'failed',
        reply: state.reply,
        sessionPath,
        exitCode: childExitCode,
        signal: childSignal,
        stderrTail: clipText(state.stderrTail, MAX_STDERR_TAIL_LENGTH),
        parseErrors: state.parseErrors,
        assistantErrors: state.assistantErrors.slice(),
        stdoutLines: state.stdoutLines.slice(),
        errorMessage: childExitCode === 0 ? '' : `Sandbox pi process exited with code ${childExitCode == null ? 'unknown' : childExitCode}`,
      };

      if (terminationReason && terminationReason.type === 'expected_completion') {
        appendEvent(eventPath, 'runner_status', {
          stage: 'completed',
          label: '运行完成',
        });
        resolve({
          ...result,
          status: 'succeeded',
          exitCode: 0,
          signal: null,
          errorMessage: '',
          completionStopReason: terminationReason.assistantStopReason || null,
          completionMessageKey: terminationReason.assistantMessageKey || null,
        });
        return;
      }

      if (terminationReason) {
        const error = new Error(String(terminationReason.message || 'Sandbox runner terminated early'));
        appendEvent(eventPath, 'runner_status', {
          stage: 'failed',
          label: '运行失败',
        });
        Object.assign(error, result, {
          terminationReason,
          exitCode: result.exitCode == null ? 1 : result.exitCode,
          errorMessage: String(terminationReason.message || 'Sandbox runner terminated early'),
        });
        reject(error);
        return;
      }

      if (childExitCode === 0) {
        appendEvent(eventPath, 'runner_status', {
          stage: 'completed',
          label: '运行完成',
        });
        resolve(result);
        return;
      }

      const error = new Error(result.errorMessage || 'Sandbox pi process failed');
      appendEvent(eventPath, 'runner_status', {
        stage: 'failed',
        label: '运行失败',
      });
      Object.assign(error, result);
      reject(error);
    });
  });
}

async function main(argv = process.argv.slice(2)) {
  const inputPath = path.resolve(String(argv[0] || '').trim());
  const resultPath = path.resolve(String(argv[1] || '').trim());

  if (!inputPath || !resultPath) {
    throw new Error('Usage: node open-sandbox-runner.js <input.json> <result.json>');
  }

  const input = loadInput(inputPath);

  try {
    const result = await runPi(input);
    writeJson(resultPath, result);
    return 0;
  } catch (error) {
    const failure = {
      status: 'failed',
      reply: String((error && error.reply) || ''),
      sessionPath: String((error && error.sessionPath) || input.sessionPath || ''),
      exitCode: Number.isInteger(error && error.exitCode) ? error.exitCode : null,
      signal: error && error.signal ? String(error.signal) : null,
      stderrTail: clipText(error && error.stderrTail ? error.stderrTail : error && error.stack ? error.stack : String(error || ''), MAX_STDERR_TAIL_LENGTH),
      parseErrors: Number.isInteger(error && error.parseErrors) ? error.parseErrors : 0,
      assistantErrors: Array.isArray(error && error.assistantErrors) ? error.assistantErrors.map((entry) => String(entry)) : [],
      stdoutLines: Array.isArray(error && error.stdoutLines) ? error.stdoutLines.map((entry) => String(entry)) : [],
      errorMessage: String((error && error.message) || error || 'Sandbox runner failed'),
    };
    writeJson(resultPath, failure);
    return 1;
  }
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exit(exitCode);
  }).catch((error) => {
    const message = error && error.stack ? error.stack : String(error || 'Sandbox runner failed');
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}

module.exports = {
  main,
  runPi,
};
