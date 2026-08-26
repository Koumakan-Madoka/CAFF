const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { requireSpawn } = require('../helpers/spawn');
const { withTempDir } = require('../helpers/temp-dir');

function createFakeSdkHost(baseDir, scriptLines) {
  const hostPath = path.join(baseDir, 'fake-sdk-host.mjs');
  fs.writeFileSync(hostPath, scriptLines.join('\n'), 'utf8');
  return hostPath;
}

function createFakeSdkHostEchoPrompt(baseDir, usage = null) {
  return createFakeSdkHost(baseDir, [
    "process.on('message', (command) => {",
    "  if (command?.type === 'start') {",
    "    const message = {",
    "      role: 'assistant',",
    "      content: [{ type: 'text', text: command.prompt }],",
    "      stopReason: 'stop',",
    "      timestamp: Date.now(),",
    usage ? `      usage: ${JSON.stringify(usage)},` : '',
    "    };",
    "    process.send({ type: 'pi_event', event: { type: 'message_end', message } });",
    "    return;",
    "  }",
    "  if (command?.type === 'abort') process.exit(0);",
    "});",
  ]);
}

function createFakeSdkHostCompleteThenHang(baseDir) {
  return createFakeSdkHost(baseDir, [
    "process.on('message', (command) => {",
    "  if (command?.type === 'start') {",
    "    const message = {",
    "      role: 'assistant',",
    "      content: [{ type: 'text', text: 'terminal reply' }],",
    "      stopReason: 'stop',",
    "      timestamp: Date.now(),",
    "    };",
    "    process.send({ type: 'pi_event', event: { type: 'message_end', message } });",
    "    return;",
    "  }",
    "  if (command?.type === 'abort') process.exit(0);",
    "});",
    "setInterval(() => {}, 1000).unref();",
  ]);
}

function createFakeSdkHostExternalCompletionAbortTail(baseDir, options = {}) {
  const initialError = String(options.initialError || '');
  return createFakeSdkHost(baseDir, [
    "process.on('message', (command) => {",
    "  if (command?.type === 'start') {",
    initialError
      ? `    const message = { role: 'assistant', responseId: 'before-completion', content: [], stopReason: 'error', errorMessage: ${JSON.stringify(initialError)}, timestamp: 1, usage: { input: 3, output: 1, totalTokens: 4 } };`
      : "    const message = { role: 'assistant', responseId: 'before-completion', content: [{ type: 'text', text: 'completion-before' }, { type: 'toolCall', name: 'send-public', arguments: {} }], stopReason: 'toolUse', timestamp: 1, usage: { input: 3, output: 1, totalTokens: 4 } };",
    "    process.send({ type: 'pi_event', event: { type: 'message_end', message } });",
    "    return;",
    "  }",
    "  if (command?.type === 'abort') {",
    "    const message = { role: 'assistant', responseId: 'completion-tail', content: [{ type: 'text', text: 'completion-after' }], stopReason: 'error', errorMessage: 'This operation was aborted', timestamp: 2, usage: { input: 5, output: 0, totalTokens: 5 } };",
    "    process.send({ type: 'pi_event', event: { type: 'message_update', message: { ...message, stopReason: 'pending' }, assistantMessageEvent: { type: 'text_delta', delta: 'completion-after' } } });",
    "    process.send({ type: 'pi_event', event: { type: 'message_end', message } });",
    "    process.send({ type: 'pi_event', event: { type: 'agent_end', messages: [message] } });",
    "    setTimeout(() => process.exit(0), 20);",
    "  }",
    "});",
  ]);
}

function createFakeSdkHostAssistantError(baseDir) {
  return createFakeSdkHost(baseDir, [
    "process.on('message', (command) => {",
    "  if (command?.type !== 'start') return;",
    "  const message = {",
    "    role: 'assistant',",
    "    content: [],",
    "    stopReason: 'error',",
    "    errorMessage: '402: insufficient quota',",
    "    timestamp: Date.now(),",
    "  };",
    "  process.send({ type: 'pi_event', event: { type: 'message_end', message } });",
    "  setTimeout(() => process.exit(0), 20);",
    "});",
  ]);
}

function createFakeSdkHostAbortedAssistant(baseDir, capturePath) {
  return createFakeSdkHost(baseDir, [
    "import { writeFileSync } from 'node:fs';",
    "let heartbeatTimer = null;",
    "process.on('message', (command) => {",
    "  if (command?.type === 'start') {",
    "    process.send({ type: 'pi_event', event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'aborted partial' }], stopReason: 'aborted', timestamp: Date.now() } } });",
    "    heartbeatTimer = setInterval(() => process.send({ type: 'heartbeat', timestamp: Date.now() }), 10);",
    "    return;",
    "  }",
    "  if (command?.type === 'abort') {",
    "    if (heartbeatTimer) clearInterval(heartbeatTimer);",
    `    writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(command), 'utf8');`,
    "    process.exit(0);",
    "  }",
    "});",
  ]);
}

function createFakeSdkHostWaitingForAbort(baseDir, capturePath = '') {
  return createFakeSdkHost(baseDir, [
    "import { writeFileSync } from 'node:fs';",
    "process.on('message', (command) => {",
    "  if (command?.type === 'start') return;",
    "  if (command?.type === 'abort') {",
    capturePath ? `    writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(command), 'utf8');` : '',
    "    process.exit(0);",
    "  }",
    "});",
    "setInterval(() => {}, 1000).unref();",
  ]);
}

function createFakeSdkHostHeartbeatOnly(baseDir, capturePath, assistantError = '') {
  return createFakeSdkHost(baseDir, [
    "import { writeFileSync } from 'node:fs';",
    "let heartbeatTimer = null;",
    "process.on('message', (command) => {",
    "  if (command?.type === 'start') {",
    assistantError ? `    process.send({ type: 'pi_event', event: { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: ${JSON.stringify(assistantError)}, timestamp: Date.now() } } });` : '',
    "    heartbeatTimer = setInterval(() => {",
    "      process.send({ type: 'heartbeat', timestamp: Date.now() });",
    "    }, 10);",
    "    return;",
    "  }",
    "  if (command?.type === 'abort') {",
    "    if (heartbeatTimer) clearInterval(heartbeatTimer);",
    `    writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(command), 'utf8');`,
    "    process.exit(0);",
    "  }",
    "});",
  ]);
}

function createFakeSdkHostRecoveringTool(baseDir, capturePath, options = {}) {
  const completeAfterRecovery = options.completeAfterRecovery !== false;
  const recoveryDelayMs = Number.isFinite(options.recoveryDelayMs) ? options.recoveryDelayMs : 0;
  const stopHeartbeatOnRecovery = options.stopHeartbeatOnRecovery === true;

  return createFakeSdkHost(baseDir, [
    "import { writeFileSync } from 'node:fs';",
    "let heartbeatTimer = null;",
    "const commands = [];",
    "function persist() { writeFileSync(" + JSON.stringify(capturePath) + ", JSON.stringify(commands), 'utf8'); }",
    "process.on('message', (command) => {",
    "  if (command?.type === 'start') {",
    "    heartbeatTimer = setInterval(() => process.send({ type: 'heartbeat', timestamp: Date.now() }), 10);",
    "    process.send({ type: 'pi_event', event: { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', args: { command: 'sensitive command' } } });",
    "    return;",
    "  }",
    "  if (command?.type === 'recover') {",
    "    commands.push(command); persist();",
    stopHeartbeatOnRecovery ? "    if (heartbeatTimer) clearInterval(heartbeatTimer);" : '',
    "    setTimeout(() => {",
    "      process.send({ type: 'pi_event', event: { type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'bash', isError: true } });",
    "      process.send({ type: 'recovery_started', reason: command.reason, attempt: command.attempt || 1, toolName: command.toolName || '' });",
    completeAfterRecovery
      ? "      process.send({ type: 'pi_event', event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'recovered reply' }], stopReason: 'stop', timestamp: Date.now() } } });"
      : "      process.send({ type: 'pi_event', event: { type: 'tool_execution_start', toolCallId: 'tool-2', toolName: 'bash' } });",
    "    }, " + String(recoveryDelayMs) + ");",
    "    return;",
    "  }",
    "  if (command?.type === 'abort') {",
    "    commands.push(command); persist();",
    "    if (heartbeatTimer) clearInterval(heartbeatTimer);",
    "    process.exit(0);",
    "  }",
    "});",
  ]);
}

function createFakeSdkHostRecoveryExitZero(baseDir) {
  return createFakeSdkHost(baseDir, [
    "let heartbeatTimer = null;",
    "process.on('message', (command) => {",
    "  if (command?.type === 'start') {",
    "    heartbeatTimer = setInterval(() => process.send({ type: 'heartbeat', timestamp: Date.now() }), 10);",
    "    process.send({ type: 'pi_event', event: { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash' } });",
    "    return;",
    "  }",
    "  if (command?.type === 'recover') {",
    "    if (heartbeatTimer) clearInterval(heartbeatTimer);",
    "    process.exit(0);",
    "  }",
    "  if (command?.type === 'abort') process.exit(0);",
    "});",
  ]);
}

function createFakeSdkHostRecoveryProviderError(baseDir) {
  return createFakeSdkHost(baseDir, [
    "let heartbeatTimer = null;",
    "process.on('message', (command) => {",
    "  if (command?.type === 'start') {",
    "    heartbeatTimer = setInterval(() => process.send({ type: 'heartbeat', timestamp: Date.now() }), 10);",
    "    process.send({ type: 'pi_event', event: { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash' } });",
    "    return;",
    "  }",
    "  if (command?.type === 'recover') {",
    "    process.send({ type: 'pi_event', event: { type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'bash', isError: true } });",
    "    process.send({ type: 'recovery_started', reason: command.reason, attempt: command.attempt, toolName: command.toolName });",
    "    process.send({ type: 'pi_event', event: { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'provider unavailable after recovery', timestamp: Date.now() } } });",
    "    if (heartbeatTimer) clearInterval(heartbeatTimer);",
    "    setTimeout(() => process.exit(0), 20);",
    "    return;",
    "  }",
    "  if (command?.type === 'abort') process.exit(0);",
    "});",
  ]);
}

function createFakeSdkHostRecoveryCrash(baseDir) {
  return createFakeSdkHost(baseDir, [
    "let heartbeatTimer = null;",
    "process.on('message', (command) => {",
    "  if (command?.type === 'start') {",
    "    heartbeatTimer = setInterval(() => process.send({ type: 'heartbeat', timestamp: Date.now() }), 10);",
    "    process.send({ type: 'pi_event', event: { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash' } });",
    "    return;",
    "  }",
    "  if (command?.type === 'recover') {",
    "    if (heartbeatTimer) clearInterval(heartbeatTimer);",
    "    process.exit(7);",
    "  }",
    "  if (command?.type === 'abort') process.exit(0);",
    "});",
  ]);
}

function createFakeSdkHostRejectingRecovery(baseDir, capturePath) {
  return createFakeSdkHost(baseDir, [
    "import { writeFileSync } from 'node:fs';",
    "let heartbeatTimer = null;",
    "const commands = [];",
    "function persist() { writeFileSync(" + JSON.stringify(capturePath) + ", JSON.stringify(commands), 'utf8'); }",
    "process.on('message', (command) => {",
    "  if (command?.type === 'start') {",
    "    heartbeatTimer = setInterval(() => process.send({ type: 'heartbeat', timestamp: Date.now() }), 10);",
    "    process.send({ type: 'pi_event', event: { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash' } });",
    "    return;",
    "  }",
    "  if (command?.type === 'recover') {",
    "    commands.push(command); persist();",
    "    process.send({ type: 'recovery_failed', reason: command.reason, attempt: command.attempt, toolName: command.toolName, code: 'recovery_prompt_failed' });",
    "    return;",
    "  }",
    "  if (command?.type === 'abort') {",
    "    commands.push(command); persist();",
    "    if (heartbeatTimer) clearInterval(heartbeatTimer);",
    "    process.exit(0);",
    "  }",
    "});",
  ]);
}

function createFakeSdkHostProgressOnly(baseDir, capturePath) {
  return createFakeSdkHost(baseDir, [
    "import { writeFileSync } from 'node:fs';",
    "let eventTimer = null;",
    "process.on('message', (command) => {",
    "  if (command?.type === 'start') {",
    "    eventTimer = setInterval(() => {",
    "      process.send({ type: 'pi_event', event: { type: 'tool_execution_update', toolCallId: 'running-tool' } });",
    "    }, 10);",
    "    return;",
    "  }",
    "  if (command?.type === 'abort') {",
    "    if (eventTimer) clearInterval(eventTimer);",
    `    writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(command), 'utf8');`,
    "    process.exit(0);",
    "  }",
    "});",
  ]);
}

function createFakeSdkHostMultipleUsages(baseDir) {
  return createFakeSdkHost(baseDir, [
    "const assistantMessages = [",
    "  { role: 'assistant', responseId: 'tool-step', content: [{ type: 'toolCall', name: 'bash', arguments: {} }], stopReason: 'toolUse', timestamp: 1, usage: { input: 100, output: 40, cacheRead: 900, cacheWrite: 10, totalTokens: 1050, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } } },",
    "  { role: 'assistant', responseId: 'final-step', content: [{ type: 'text', text: '{\\\"action\\\":\\\"final\\\"}' }], stopReason: 'stop', timestamp: 2, usage: { input: 5, output: 9, cacheRead: 1000, cacheWrite: 0, totalTokens: 1014, cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, total: 26 } } },",
    "];",
    "process.on('message', (command) => {",
    "  if (command?.type === 'start') {",
    "    for (const message of assistantMessages) {",
    "      process.send({ type: 'pi_event', event: { type: 'message_end', message } });",
    "    }",
    "    process.send({ type: 'pi_event', event: { type: 'agent_end', messages: assistantMessages } });",
    "    return;",
    "  }",
    "  if (command?.type === 'abort') process.exit(0);",
    "});",
  ]);
}

function createFakeSdkHostNativeRetry(baseDir, options = {}) {
  const terminalFailure = options.terminalFailure === true;
  return createFakeSdkHost(baseDir, [
    "const usage = (sequence) => ({ input: sequence, output: 1, cacheRead: sequence > 1 ? 10 : 0, cacheWrite: 0, totalTokens: sequence + 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });",
    "const sendAttempt = (sequence, text, stopReason, errorMessage = '') => {",
    "  const message = { role: 'assistant', responseId: `retry-${sequence}`, content: text ? [{ type: 'text', text }] : [], stopReason, timestamp: sequence, usage: usage(sequence), ...(errorMessage ? { errorMessage } : {}) };",
    "  if (text) process.send({ type: 'pi_event', event: { type: 'message_update', message: { ...message, stopReason: 'pending' }, assistantMessageEvent: { type: 'text_delta', delta: text } } });",
    "  process.send({ type: 'pi_event', event: { type: 'message_end', message } });",
    "};",
    "process.on('message', (command) => {",
    "  if (command?.type === 'start') {",
    terminalFailure
      ? "    for (let sequence = 1; sequence <= 4; sequence += 1) { sendAttempt(sequence, `discarded-${sequence}`, 'error', 'connection error: stream_read_error'); if (sequence < 4) process.send({ type: 'pi_event', event: { type: 'auto_retry_start', attempt: sequence, maxAttempts: 3, delayMs: 0, errorMessage: 'connection error: stream_read_error' } }); } process.send({ type: 'pi_event', event: { type: 'auto_retry_end', success: false, attempt: 3, finalError: 'connection error: stream_read_error' } }); setTimeout(() => process.exit(0), 20);"
      : "    sendAttempt(1, 'discarded partial', 'error', 'connection error: stream_read_error'); process.send({ type: 'pi_event', event: { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 0, errorMessage: 'connection error: stream_read_error' } }); process.send({ type: 'pi_event', event: { type: 'auto_retry_end', success: true, attempt: 1 } }); sendAttempt(2, 'recovered final', 'stop');",
    "    return;",
    "  }",
    "  if (command?.type === 'abort') process.exit(0);",
    "});",
  ]);
}

function createFakeSdkHostCapturingInfo(baseDir) {
  return createFakeSdkHost(baseDir, [
    "import { writeFileSync } from 'node:fs';",
    "process.on('message', (command) => {",
    "  if (command?.type === 'start') {",
    "    const payload = { cwd: process.cwd(), command };",
    "    if (process.env.TEST_CAPTURE_PATH) {",
    "      writeFileSync(process.env.TEST_CAPTURE_PATH, JSON.stringify(payload), 'utf8');",
    "    }",
    "    const message = {",
    "      role: 'assistant',",
    "      content: [{ type: 'text', text: JSON.stringify(payload) }],",
    "      stopReason: 'stop',",
    "      timestamp: Date.now(),",
    "    };",
    "    process.send({ type: 'pi_event', event: { type: 'message_end', message } });",
    "    return;",
    "  }",
    "  if (command?.type === 'abort') process.exit(0);",
    "});",
  ]);
}

function createFakeSdkHostCrash(baseDir) {
  return createFakeSdkHost(baseDir, [
    "process.on('message', (command) => {",
    "  if (command?.type !== 'start') return;",
    "  process.stderr.write('sdk host exploded\\n');",
    "  process.exit(7);",
    "});",
  ]);
}

function createFakeSdkHostMalformedThenComplete(baseDir) {
  return createFakeSdkHost(baseDir, [
    "process.on('message', (command) => {",
    "  if (command?.type !== 'start') return;",
    "  process.send('malformed-ipc-message');",
    "  const message = {",
    "    role: 'assistant',",
    "    content: [{ type: 'text', text: 'recovered reply' }],",
    "    stopReason: 'stop',",
    "    timestamp: Date.now(),",
    "  };",
    "  process.send({ type: 'pi_event', event: { type: 'message_end', message } });",
    "});",
  ]);
}

function createFakeSdkHostWithNoisyStdout(baseDir) {
  return createFakeSdkHost(baseDir, [
    "function complete() {",
    "  const message = {",
    "    role: 'assistant',",
    "    content: [{ type: 'text', text: 'stdout did not block IPC' }],",
    "    stopReason: 'stop',",
    "    timestamp: Date.now(),",
    "  };",
    "  process.send({ type: 'pi_event', event: { type: 'message_end', message } });",
    "}",
    "process.on('message', (command) => {",
    "  if (command?.type !== 'start') return;",
    "  const chunk = 'x'.repeat(64 * 1024);",
    "  for (let index = 0; index < 512; index += 1) {",
    "    if (!process.stdout.write(chunk)) {",
    "      process.stdout.once('drain', complete);",
    "      return;",
    "    }",
    "  }",
    "  complete();",
    "});",
  ]);
}

function loadRuntimeWithSdkHost(sdkHostPath) {
  const runtimeModulePath = require.resolve('../../build/lib/pi-runtime');
  const previousOverride = process.env.PI_SDK_HOST_OVERRIDE;

  delete require.cache[runtimeModulePath];
  process.env.PI_SDK_HOST_OVERRIDE = sdkHostPath;

  return {
    runtime: require('../../build/lib/pi-runtime'),
    restore() {
      delete require.cache[runtimeModulePath];

      if (previousOverride === undefined) {
        delete process.env.PI_SDK_HOST_OVERRIDE;
        return;
      }

      process.env.PI_SDK_HOST_OVERRIDE = previousOverride;
    },
  };
}

test('pi runtime resolves provider-specific default thinking without overriding explicit values', () => {
  const runtime = require('../../build/lib/pi-runtime');

  assert.equal(runtime.getProviderDefaultThinking('packycode'), 'xhigh');
  assert.equal(runtime.getProviderDefaultThinking('kimi-coding'), '');
  assert.equal(runtime.resolveThinkingSetting('packycode', '', '', ''), 'xhigh');
  assert.equal(runtime.resolveThinkingSetting('packycode', 'low', '', ''), 'low');
  assert.equal(runtime.resolveThinkingSetting('packycode', '', 'medium', ''), 'medium');
  assert.equal(runtime.resolveThinkingSetting('kimi-coding', '', '', ''), '');
});

test('pi runtime defaults the absolute watchdog to three hours while preserving explicit overrides', () => {
  const runtime = require('../../build/lib/pi-runtime');
  const agentExecutorSource = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'server', 'domain', 'conversation', 'turn', 'agent-executor.ts'),
    'utf8'
  );

  assert.equal(runtime.DEFAULT_RUN_TIMEOUT_MS, 10_800_000);
  assert.equal(
    runtime.resolveIntegerSettingCandidates(['33000', runtime.DEFAULT_RUN_TIMEOUT_MS], 'timeoutMs'),
    33_000
  );
  assert.equal(
    runtime.resolveIntegerSettingCandidates([0, runtime.DEFAULT_RUN_TIMEOUT_MS], 'timeoutMs'),
    0
  );
  assert.match(
    agentExecutorSource,
    /\[process\.env\.PI_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS\]/u,
    'conversation runs should share the runtime default instead of duplicating it'
  );
});

test('pi runtime treats a terminal assistant message as successful completion even if the child keeps running', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-');
  const sqlitePath = path.join(tempDir, 'pi-runtime.sqlite');
  const fakeHostPath = createFakeSdkHostCompleteThenHang(tempDir);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  const terminatingReasons = [];
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'Say hello', {
    agentDir: tempDir,
    sqlitePath,
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 10000,
    terminateGraceMs: 100,
    streamOutput: false,
  });

  handle.on('run_terminating', (event) => {
    terminatingReasons.push(event.reason || null);
  });

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error('Timed out waiting for runtime completion'));
    }, 2000);
  });

  const result = await Promise.race([handle.resultPromise, timeoutPromise]);

  assert.equal(result.reply, 'terminal reply');
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.completionStopReason, 'stop');
  assert.ok(terminatingReasons.some((reason) => reason && reason.type === 'expected_completion'));
});

test('pi runtime rejects a terminal assistant model error even when the SDK host exits zero', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-assistant-error-');
  const sqlitePath = path.join(tempDir, 'pi-runtime-assistant-error.sqlite');
  const fakeHostPath = createFakeSdkHostAssistantError(tempDir);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'Trigger provider failure', {
    agentDir: tempDir,
    sqlitePath,
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 10000,
    terminateGraceMs: 100,
    streamOutput: false,
  });

  await assert.rejects(
    handle.resultPromise,
    (error) => {
      assert.equal(error.message, 'pi assistant reported a model invocation error');
      assert.deepEqual(error.assistantErrors, ['402: insufficient quota']);
      return true;
    }
  );
});

test('pi runtime ignores assistant abort tail output after caller expected completion', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-completion-abort-tail-');
  const sqlitePath = path.join(tempDir, 'pi-runtime-completion-abort-tail.sqlite');
  const fakeHostPath = createFakeSdkHostExternalCompletionAbortTail(tempDir);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  const stderrWrites = [];
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'Post publicly then stop', {
    agentDir: tempDir,
    sqlitePath,
    heartbeatIntervalMs: 0,
    heartbeatTimeoutMs: 10000,
    terminateGraceMs: 100,
    streamOutput: true,
    stdout: { write() {} },
    stderr: { write(text) { stderrWrites.push(String(text)); } },
  });
  handle.on('assistant_message', (event) => {
    if (event.messageKey === 'response:before-completion') {
      handle.complete('public bridge completed');
    }
  });

  const result = await handle.resultPromise;

  assert.deepEqual(result.assistantErrors, []);
  assert.deepEqual(result.assistantErrorHistory, []);
  assert.equal(result.reply, 'completion-before');
  assert.deepEqual(result.usage, { input: 3, output: 1, totalTokens: 4 });
  assert.equal(result.usageCalls.length, 1);
  assert.equal(stderrWrites.some((text) => text.includes('This operation was aborted')), false);

  const db = new Database(sqlitePath, { readonly: true });
  const run = db.prepare('SELECT status, assistant_errors_json, reply FROM runs WHERE id = ?').get(result.runId);
  db.close();
  assert.deepEqual(run, {
    status: 'succeeded',
    assistant_errors_json: '[]',
    reply: 'completion-before',
  });
});

test('pi runtime preserves an assistant provider error recorded before caller expected completion', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-pre-completion-error-');
  const fakeHostPath = createFakeSdkHostExternalCompletionAbortTail(tempDir, {
    initialError: 'provider failed before public completion',
  });
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'Preserve prior provider failure', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'pre-completion-error.sqlite'),
    heartbeatIntervalMs: 0,
    heartbeatTimeoutMs: 10000,
    terminateGraceMs: 100,
    streamOutput: false,
  });
  handle.on('assistant_error', (event) => {
    if (event.errorMessage === 'provider failed before public completion') {
      handle.complete('external completion after provider error');
    }
  });

  const result = await handle.resultPromise;

  assert.deepEqual(result.assistantErrors, ['provider failed before public completion']);
  assert.deepEqual(result.assistantErrorHistory, ['provider failed before public completion']);
  assert.equal(result.reply, '');
  assert.deepEqual(result.usage, { input: 3, output: 1, totalTokens: 4 });
  assert.equal(result.usageCalls.length, 1);
});

test('pi runtime keeps user cancellation authoritative when the host emits an assistant abort tail', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-cancel-abort-tail-');
  const fakeHostPath = createFakeSdkHostExternalCompletionAbortTail(tempDir);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'Cancel this run', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'cancel-abort-tail.sqlite'),
    heartbeatIntervalMs: 0,
    heartbeatTimeoutMs: 10000,
    terminateGraceMs: 100,
    streamOutput: false,
  });
  handle.cancel('operator cancelled');

  await assert.rejects(handle.resultPromise, (error) => {
    assert.equal(error.terminationReason.type, 'cancelled');
    assert.equal(error.terminationReason.message, 'operator cancelled');
    assert.deepEqual(error.assistantErrors, ['This operation was aborted']);
    return true;
  });
});

test('pi runtime allows callers to mark a run complete early', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-complete-');
  const sqlitePath = path.join(tempDir, 'pi-runtime-complete.sqlite');
  const fakeHostPath = createFakeSdkHostWaitingForAbort(tempDir);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'Say hello', {
    agentDir: tempDir,
    sqlitePath,
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 10000,
    terminateGraceMs: 100,
    streamOutput: false,
  });

  handle.complete('external early completion');

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error('Timed out waiting for external completion'));
    }, 2000);
  });

  const result = await Promise.race([handle.resultPromise, timeoutPromise]);

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.completionStopReason, null);
});

test('pi runtime sends the full prompt through structured IPC so quoted history is preserved', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-stdin-');
  const sqlitePath = path.join(tempDir, 'pi-runtime-stdin.sqlite');
  const fakeHostPath = createFakeSdkHostEchoPrompt(tempDir);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  const prompt =
    'Conversation history:\nUser: before "quoted" after\n\nLatest user message:\nKeep "this segment" and the trailing text';
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', prompt, {
    agentDir: tempDir,
    sqlitePath,
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 10000,
    terminateGraceMs: 100,
    streamOutput: false,
  });

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error('Timed out waiting for IPC prompt echo completion'));
    }, 2000);
  });

  const result = await Promise.race([handle.resultPromise, timeoutPromise]);

  assert.equal(result.reply, prompt);
  assert.match(result.reply, /before "quoted" after/u);
  assert.match(result.reply, /Keep "this segment" and the trailing text/u);
});

test('pi runtime preserves unicode IPC prompts through the SDK host', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-unicode-');
  const sqlitePath = path.join(tempDir, 'pi-runtime-unicode.sqlite');
  const fakeHostPath = createFakeSdkHostEchoPrompt(tempDir, {
    input_tokens: 1234,
    output_tokens: 56,
    total_tokens: 1290,
  });
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  const prompt = 'Conversation history:\nUser: 中文内容 "保留后文"\nLatest user message:\n继续看乱码';
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', prompt, {
    agentDir: tempDir,
    sqlitePath,
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 10000,
    terminateGraceMs: 100,
    streamOutput: false,
  });

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error('Timed out waiting for unicode completion'));
    }, 2000);
  });

  const result = await Promise.race([handle.resultPromise, timeoutPromise]);

  assert.equal(result.reply, prompt);
  assert.deepEqual(result.usage, { input_tokens: 1234, output_tokens: 56, total_tokens: 1290 });
  assert.match(result.reply, /中文内容 "保留后文"/u);
  assert.match(result.reply, /继续看乱码/u);
});

test('pi runtime aggregates usage across assistant model calls', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-multiple-usage-');
  const sqlitePath = path.join(tempDir, 'pi-runtime-multiple-usage.sqlite');
  const fakeHostPath = createFakeSdkHostMultipleUsages(tempDir);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'Say hello', {
    agentDir: tempDir,
    sqlitePath,
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 10000,
    terminateGraceMs: 100,
    streamOutput: false,
  });

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error('Timed out waiting for multiple usage completion'));
    }, 2000);
  });

  const result = await Promise.race([handle.resultPromise, timeoutPromise]);

  assert.deepEqual(result.usage, {
    input: 105,
    output: 49,
    cacheRead: 1900,
    cacheWrite: 10,
    totalTokens: 2064,
    cost: { input: 6, output: 8, cacheRead: 10, cacheWrite: 12, total: 36 },
  });
});

test('pi runtime settles a native retry recovery without leaking the failed attempt into final CAFF state', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-native-retry-success-');
  const fakeHostPath = createFakeSdkHostNativeRetry(tempDir);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  const discarded = [];
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}
    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'recover once', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'native-retry.sqlite'),
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 10000,
    terminateGraceMs: 100,
    streamOutput: false,
  });
  handle.on('assistant_retry_discarded', (event) => discarded.push(event));

  const result = await handle.resultPromise;
  assert.equal(result.reply, 'recovered final');
  assert.deepEqual(result.assistantErrors, []);
  assert.deepEqual(result.assistantErrorHistory, ['connection error: stream_read_error']);
  assert.equal(result.usageCalls.length, 2);
  const successDb = new Database(path.join(tempDir, 'native-retry.sqlite'), { readonly: true });
  const successRun = successDb.prepare('SELECT status, assistant_errors_json FROM runs WHERE id = ?').get(result.runId);
  successDb.close();
  assert.deepEqual(successRun, { status: 'succeeded', assistant_errors_json: '[]' });
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0].discardedText, 'discarded partial');
  assert.equal(discarded[0].reply, '');
});

test('pi runtime keeps retry accounting bounded and terminal diagnosis authoritative', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-native-retry-failure-');
  const fakeHostPath = createFakeSdkHostNativeRetry(tempDir, { terminalFailure: true });
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  const discarded = [];
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}
    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'fail after retries', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'native-retry-failure.sqlite'),
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 10000,
    terminateGraceMs: 100,
    streamOutput: false,
  });
  handle.on('assistant_retry_discarded', (event) => discarded.push(event));

  let failedRunId = '';
  await assert.rejects(handle.resultPromise, (error) => {
    failedRunId = error.runId;
    assert.deepEqual(error.assistantErrors, ['connection error: stream_read_error']);
    assert.deepEqual(error.assistantErrorHistory, [
      'connection error: stream_read_error',
      'connection error: stream_read_error',
      'connection error: stream_read_error',
      'connection error: stream_read_error',
    ]);
    assert.equal(error.reply, 'discarded-4');
    assert.equal(error.usageCalls.length, 4);
    return true;
  });
  const failureDb = new Database(path.join(tempDir, 'native-retry-failure.sqlite'), { readonly: true });
  const failureRun = failureDb.prepare('SELECT status, assistant_errors_json FROM runs WHERE id = ?').get(failedRunId);
  failureDb.close();
  assert.deepEqual(failureRun, {
    status: 'failed',
    assistant_errors_json: '["connection error: stream_read_error"]',
  });
  assert.equal(discarded.length, 3);
});

test('pi runtime respects explicit cwd and forwards session, resume, and extensions through IPC', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-cwd-');
  const projectDir = path.join(tempDir, 'project-root');
  const sqlitePath = path.join(tempDir, 'pi-runtime-cwd.sqlite');
  const capturePath = path.join(tempDir, 'capture.json');
  const extraExtensionPath = path.join(tempDir, 'extra-extension.mjs');
  const fakeHostPath = createFakeSdkHostCapturingInfo(tempDir);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(extraExtensionPath, 'export default {}\n', 'utf8');

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'check cwd', {
    agentDir: tempDir,
    sqlitePath,
    cwd: projectDir,
    extensionPaths: [extraExtensionPath],
    session: 'named-session',
    resume: true,
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 10000,
    terminateGraceMs: 100,
    streamOutput: false,
    extraEnv: {
      TEST_CAPTURE_PATH: capturePath,
    },
  });

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error('Timed out waiting for cwd capture completion'));
    }, 2000);
  });

  await Promise.race([handle.resultPromise, timeoutPromise]);

  const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  const command = captured.command;

  assert.equal(captured.cwd, projectDir);
  assert.equal(command.type, 'start');
  assert.equal(command.prompt, 'check cwd');
  assert.equal(command.config.cwd, projectDir);
  assert.equal(command.config.resume, true);
  assert.equal(command.config.sessionPath, path.join(tempDir, 'named-sessions', 'named-session.jsonl'));
  assert.deepEqual(command.config.extensionPaths, [path.resolve(extraExtensionPath)]);
});

test('pi runtime sends an IPC abort command before forcing process termination', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-abort-');
  const sqlitePath = path.join(tempDir, 'pi-runtime-abort.sqlite');
  const capturePath = path.join(tempDir, 'abort.json');
  const fakeHostPath = createFakeSdkHostWaitingForAbort(tempDir, capturePath);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'wait for cancel', {
    agentDir: tempDir,
    sqlitePath,
    heartbeatIntervalMs: 0,
    heartbeatTimeoutMs: 10000,
    terminateGraceMs: 500,
    streamOutput: false,
  });

  handle.cancel('operator cancelled');

  await assert.rejects(handle.resultPromise, (error) => {
    assert.equal(error.terminationReason.type, 'cancelled');
    return true;
  });

  const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  assert.equal(captured.type, 'abort');
  assert.equal(captured.reason.type, 'cancelled');
  assert.equal(captured.reason.message, 'operator cancelled');
});

test('pi runtime rejects with host crash diagnostics', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-crash-');
  const fakeHostPath = createFakeSdkHostCrash(tempDir);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'crash', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'pi-runtime-crash.sqlite'),
    heartbeatIntervalMs: 0,
    heartbeatTimeoutMs: 10000,
    terminateGraceMs: 100,
    streamOutput: false,
  });

  await assert.rejects(handle.resultPromise, (error) => {
    assert.equal(error.exitCode, 7);
    assert.match(error.stderrTail, /sdk host exploded/u);
    assert.equal(error.reply, '');
    return true;
  });
});

test('pi runtime preserves stdout_parse_error compatibility for malformed IPC messages', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-malformed-ipc-');
  const fakeHostPath = createFakeSdkHostMalformedThenComplete(tempDir);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  const protocolErrors = [];
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'recover from malformed IPC', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'pi-runtime-malformed-ipc.sqlite'),
    heartbeatIntervalMs: 0,
    heartbeatTimeoutMs: 10000,
    terminateGraceMs: 100,
    streamOutput: false,
  });
  handle.on('stdout_parse_error', (event) => protocolErrors.push(event));

  const result = await handle.resultPromise;

  assert.equal(result.reply, 'recovered reply');
  assert.equal(result.parseErrors, 1);
  assert.equal(protocolErrors.length, 1);
  assert.equal(protocolErrors[0].type, 'stdout_parse_error');
  assert.equal(protocolErrors[0].line, '"malformed-ipc-message"');
  assert.equal(protocolErrors[0].parseErrors, 1);
  assert.equal(protocolErrors[0].source, 'ipc');
  assert.ok(protocolErrors[0].timestamp);
});

test('pi runtime does not let unused SDK host stdout backpressure block IPC completion', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-noisy-stdout-');
  const fakeHostPath = createFakeSdkHostWithNoisyStdout(tempDir);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'ignore noisy stdout', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'pi-runtime-noisy-stdout.sqlite'),
    heartbeatIntervalMs: 0,
    heartbeatTimeoutMs: 300,
    terminateGraceMs: 100,
    streamOutput: false,
  });

  const result = await handle.resultPromise;

  assert.equal(result.reply, 'stdout did not block IPC');
  assert.equal(result.parseErrors, 0);
});

test('pi runtime aborts a heartbeat-only host after the progress timeout', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-progress-timeout-');
  const capturePath = path.join(tempDir, 'progress-abort.json');
  const fakeHostPath = createFakeSdkHostHeartbeatOnly(tempDir, capturePath);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'wait for progress timeout', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'pi-runtime-progress-timeout.sqlite'),
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 500,
    progressTimeoutMs: 75,
    timeoutMs: 1000,
    terminateGraceMs: 500,
    streamOutput: false,
  });

  await assert.rejects(handle.resultPromise, (error) => {
    assert.equal(error.terminationReason.type, 'progress_timeout');
    return true;
  });

  const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  assert.equal(captured.reason.type, 'progress_timeout');
});

test('pi runtime recovers one silent active tool in the same host run', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-tool-recovery-');
  const capturePath = path.join(tempDir, 'tool-recovery.json');
  const fakeHostPath = createFakeSdkHostRecoveringTool(tempDir, capturePath);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'recover the silent tool', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'pi-runtime-tool-recovery.sqlite'),
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 500,
    progressTimeoutMs: 75,
    timeoutMs: 1000,
    terminateGraceMs: 500,
    toolProgressRecovery: true,
    streamOutput: false,
  });

  const recoveringEvents = [];
  const recoveredEvents = [];
  handle.on('run_recovering', (event) => recoveringEvents.push(event));
  handle.on('run_recovery_started', (event) => recoveredEvents.push(event));

  const result = await handle.resultPromise;
  const commands = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  const recoverCommand = commands.find((command) => command.type === 'recover');

  assert.equal(result.reply, 'recovered reply');
  assert.equal(recoveringEvents.length, 1);
  assert.equal(recoveredEvents.length, 1);
  assert.equal(recoverCommand.attempt, 1);
  assert.equal(recoverCommand.toolName, 'bash');
  assert.equal(JSON.stringify(recoverCommand).includes('sensitive command'), false);
});

test('pi runtime keeps active-tool recovery disabled unless the caller opts in', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-tool-recovery-disabled-');
  const capturePath = path.join(tempDir, 'tool-recovery-disabled.json');
  const fakeHostPath = createFakeSdkHostRecoveringTool(tempDir, capturePath);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'keep recovery disabled', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'pi-runtime-tool-recovery-disabled.sqlite'),
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 500,
    progressTimeoutMs: 75,
    timeoutMs: 1000,
    terminateGraceMs: 500,
    streamOutput: false,
  });

  await assert.rejects(handle.resultPromise, (error) => {
    assert.equal(error.terminationReason.type, 'progress_timeout');
    return true;
  });

  const commands = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  assert.equal(commands.some((command) => command.type === 'recover'), false);
  assert.equal(commands.at(-1).type, 'abort');
});

test('pi runtime does not recover a progress timeout without an active tool', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-no-tool-recovery-');
  const capturePath = path.join(tempDir, 'no-tool-abort.json');
  const fakeHostPath = createFakeSdkHostHeartbeatOnly(tempDir, capturePath);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'do not recover a model stall', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'pi-runtime-no-tool-recovery.sqlite'),
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 500,
    progressTimeoutMs: 75,
    timeoutMs: 1000,
    terminateGraceMs: 500,
    toolProgressRecovery: true,
    streamOutput: false,
  });

  await assert.rejects(handle.resultPromise, (error) => {
    assert.equal(error.terminationReason.type, 'progress_timeout');
    assert.equal(error.terminationReason.recoveryAttempt, undefined);
    return true;
  });

  const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  assert.equal(captured.type, 'abort');
});

test('pi runtime fails closed on a second progress timeout after recovery', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-second-tool-timeout-');
  const capturePath = path.join(tempDir, 'second-tool-timeout.json');
  const fakeHostPath = createFakeSdkHostRecoveringTool(tempDir, capturePath, { completeAfterRecovery: false });
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'fail after one recovery', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'pi-runtime-second-tool-timeout.sqlite'),
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 500,
    progressTimeoutMs: 75,
    timeoutMs: 1000,
    terminateGraceMs: 500,
    toolProgressRecovery: true,
    streamOutput: false,
  });

  await assert.rejects(handle.resultPromise, (error) => {
    assert.equal(error.terminationReason.type, 'progress_timeout');
    assert.equal(error.terminationReason.recoveryAttempt, 1);
    return true;
  });

  const commands = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  assert.equal(commands.filter((command) => command.type === 'recover').length, 1);
  assert.equal(commands.at(-1).type, 'abort');
});

test('pi runtime fails closed when the SDK host rejects recovery', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-recovery-failed-');
  const capturePath = path.join(tempDir, 'recovery-failed.json');
  const fakeHostPath = createFakeSdkHostRejectingRecovery(tempDir, capturePath);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'reject recovery', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'pi-runtime-recovery-failed.sqlite'),
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 500,
    progressTimeoutMs: 75,
    timeoutMs: 1000,
    terminateGraceMs: 500,
    toolProgressRecovery: true,
    streamOutput: false,
  });

  await assert.rejects(handle.resultPromise, (error) => {
    assert.equal(error.terminationReason.type, 'progress_timeout');
    assert.equal(error.terminationReason.recoveryAttempt, 1);
    assert.equal(error.terminationReason.recoveryFailureCode, 'recovery_prompt_failed');
    return true;
  });
});

test('pi runtime fails closed when a zero-exit host never acknowledges recovery', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-recovery-missing-ack-');
  const fakeHostPath = createFakeSdkHostRecoveryExitZero(tempDir);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'host exits before recovery ack', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'pi-runtime-recovery-missing-ack.sqlite'),
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 500,
    progressTimeoutMs: 75,
    timeoutMs: 1000,
    terminateGraceMs: 500,
    toolProgressRecovery: true,
    streamOutput: false,
  });

  await assert.rejects(handle.resultPromise, (error) => {
    assert.equal(error.terminationReason.type, 'progress_timeout');
    assert.equal(error.terminationReason.recoveryAttempt, 1);
    assert.equal(error.terminationReason.recoveryFailureCode, 'missing_acknowledgement');
    return true;
  });
});

test('pi runtime keeps heartbeat timeout authoritative during recovery', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-recovery-heartbeat-timeout-');
  const capturePath = path.join(tempDir, 'recovery-heartbeat-timeout.json');
  const fakeHostPath = createFakeSdkHostRecoveringTool(tempDir, capturePath, {
    recoveryDelayMs: 200,
    stopHeartbeatOnRecovery: true,
  });
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'heartbeat fails during recovery', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'pi-runtime-recovery-heartbeat-timeout.sqlite'),
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 40,
    progressTimeoutMs: 60,
    timeoutMs: 1000,
    terminateGraceMs: 500,
    toolProgressRecovery: true,
    streamOutput: false,
  });

  await assert.rejects(handle.resultPromise, (error) => {
    assert.equal(error.terminationReason.type, 'heartbeat_timeout');
    return true;
  });
});

test('pi runtime keeps the absolute timeout authoritative during recovery', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-recovery-absolute-timeout-');
  const capturePath = path.join(tempDir, 'recovery-absolute-timeout.json');
  const fakeHostPath = createFakeSdkHostRecoveringTool(tempDir, capturePath, { recoveryDelayMs: 200 });
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'absolute timeout during recovery', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'pi-runtime-recovery-absolute-timeout.sqlite'),
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 500,
    progressTimeoutMs: 60,
    timeoutMs: 100,
    terminateGraceMs: 500,
    toolProgressRecovery: true,
    streamOutput: false,
  });

  await assert.rejects(handle.resultPromise, (error) => {
    assert.equal(error.terminationReason.type, 'run_timeout');
    return true;
  });
});

test('pi runtime keeps a provider error authoritative after recovery starts', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-recovery-provider-error-');
  const fakeHostPath = createFakeSdkHostRecoveryProviderError(tempDir);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'provider fails after recovery', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'pi-runtime-recovery-provider-error.sqlite'),
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 500,
    progressTimeoutMs: 75,
    timeoutMs: 1000,
    terminateGraceMs: 500,
    toolProgressRecovery: true,
    streamOutput: false,
  });

  await assert.rejects(handle.resultPromise, (error) => {
    assert.equal(error.message, 'pi assistant reported a model invocation error');
    assert.equal(error.terminationReason, undefined);
    assert.deepEqual(error.assistantErrors, ['provider unavailable after recovery']);
    return true;
  });
});

test('pi runtime keeps a nonzero process exit authoritative during recovery', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-recovery-process-exit-');
  const fakeHostPath = createFakeSdkHostRecoveryCrash(tempDir);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'host crashes during recovery', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'pi-runtime-recovery-process-exit.sqlite'),
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 500,
    progressTimeoutMs: 75,
    timeoutMs: 1000,
    terminateGraceMs: 500,
    toolProgressRecovery: true,
    streamOutput: false,
  });

  await assert.rejects(handle.resultPromise, (error) => {
    assert.equal(error.message, 'pi exited with code 7');
    assert.equal(error.exitCode, 7);
    assert.equal(error.terminationReason, undefined);
    return true;
  });
});

test('pi runtime keeps user cancellation authoritative during recovery', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-cancel-recovery-');
  const capturePath = path.join(tempDir, 'cancel-recovery.json');
  const fakeHostPath = createFakeSdkHostRecoveringTool(tempDir, capturePath, { recoveryDelayMs: 200 });
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'cancel the recovering tool', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'pi-runtime-cancel-recovery.sqlite'),
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 500,
    progressTimeoutMs: 50,
    timeoutMs: 1000,
    terminateGraceMs: 500,
    toolProgressRecovery: true,
    streamOutput: false,
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('run_recovering was not emitted')), 500);
    handle.once('run_recovering', () => {
      clearTimeout(timer);
      handle.cancel('Stopped by user');
      resolve();
    });
  });

  await assert.rejects(handle.resultPromise, (error) => {
    assert.equal(error.terminationReason.type, 'cancelled');
    return true;
  });
});

test('pi runtime keeps a watchdog timeout authoritative after an earlier assistant error', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-error-then-timeout-');
  const capturePath = path.join(tempDir, 'error-then-timeout-abort.json');
  const fakeHostPath = createFakeSdkHostHeartbeatOnly(tempDir, capturePath, 'transient provider error');
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'wait for authoritative progress timeout', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'pi-runtime-error-then-timeout.sqlite'),
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 500,
    progressTimeoutMs: 75,
    timeoutMs: 1000,
    terminateGraceMs: 500,
    streamOutput: false,
  });

  await assert.rejects(handle.resultPromise, (error) => {
    assert.equal(error.terminationReason.type, 'progress_timeout');
    assert.deepEqual(error.assistantErrors, ['transient provider error']);
    return true;
  });
});

test('pi runtime does not treat an aborted assistant message as expected completion', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-aborted-assistant-');
  const capturePath = path.join(tempDir, 'aborted-assistant.json');
  const fakeHostPath = createFakeSdkHostAbortedAssistant(tempDir, capturePath);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'ignore aborted completion', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'pi-runtime-aborted-assistant.sqlite'),
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 500,
    progressTimeoutMs: 75,
    timeoutMs: 1000,
    terminateGraceMs: 500,
    streamOutput: false,
  });

  await assert.rejects(handle.resultPromise, (error) => {
    assert.equal(error.terminationReason.type, 'progress_timeout');
    return true;
  });

  const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  assert.equal(captured.reason.type, 'progress_timeout');
});

test('pi runtime total timeout is not extended by repeated progress events', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-total-timeout-');
  const capturePath = path.join(tempDir, 'run-abort.json');
  const fakeHostPath = createFakeSdkHostProgressOnly(tempDir, capturePath);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'wait for total timeout', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'pi-runtime-total-timeout.sqlite'),
    heartbeatIntervalMs: 0,
    heartbeatTimeoutMs: 500,
    progressTimeoutMs: 500,
    timeoutMs: 75,
    terminateGraceMs: 500,
    streamOutput: false,
  });

  await assert.rejects(handle.resultPromise, (error) => {
    assert.equal(error.terminationReason.type, 'run_timeout');
    return true;
  });

  const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  assert.equal(captured.reason.type, 'run_timeout');
});

test('pi runtime aborts a silent host after heartbeat timeout', async (t) => {
  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-heartbeat-timeout-');
  const capturePath = path.join(tempDir, 'heartbeat-abort.json');
  const fakeHostPath = createFakeSdkHostWaitingForAbort(tempDir, capturePath);
  const { runtime, restore } = loadRuntimeWithSdkHost(fakeHostPath);
  let handle = null;

  t.after(() => {
    try {
      handle && handle.cancel('test cleanup');
    } catch {}

    restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  handle = runtime.startRun('test-provider', 'test-model', 'wait for timeout', {
    agentDir: tempDir,
    sqlitePath: path.join(tempDir, 'pi-runtime-heartbeat-timeout.sqlite'),
    heartbeatIntervalMs: 0,
    heartbeatTimeoutMs: 50,
    terminateGraceMs: 500,
    streamOutput: false,
  });

  await assert.rejects(handle.resultPromise, (error) => {
    assert.equal(error.terminationReason.type, 'heartbeat_timeout');
    return true;
  });

  const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  assert.equal(captured.type, 'abort');
  assert.equal(captured.reason.type, 'heartbeat_timeout');
});

test('pi runtime does not import pi-cli-spawn', () => {
  const runtimeSource = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'lib', 'pi-runtime.ts'),
    'utf8'
  );

  assert.ok(!runtimeSource.includes('pi-cli-spawn'), 'pi-runtime.ts must not import pi-cli-spawn');
  assert.ok(!runtimeSource.includes('tryCreateDirectPiNodeSpawnSpec'), 'pi-runtime.ts must not use tryCreateDirectPiNodeSpawnSpec');
});

test('pi runtime forks the SDK host with a structured IPC channel', () => {
  const runtimeSource = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'lib', 'pi-runtime.ts'),
    'utf8'
  );

  assert.ok(runtimeSource.includes('SDK_HOST_PATH'), 'pi-runtime.ts must reference SDK_HOST_PATH');
  assert.ok(runtimeSource.includes("require('node:child_process')"), 'pi-runtime.ts must use node child_process');
  assert.ok(runtimeSource.includes("child.on('message'"), 'pi-runtime.ts must consume structured IPC messages');
  assert.ok(!runtimeSource.includes("require('node:readline')"), 'pi-runtime.ts must not parse JSONL stdout');
  assert.ok(!runtimeSource.includes('writePiPromptToStdin'), 'pi-runtime.ts must not pipe prompts through stdin');
  assert.ok(!runtimeSource.includes('findPiScriptPath'), 'pi-runtime.ts must not use findPiScriptPath');
});

test('package.json pins pi-coding-agent version without caret', () => {
  const pkg = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'package.json'),
      'utf8'
    )
  );

  const version = pkg.dependencies['@earendil-works/pi-coding-agent'];
  assert.ok(version, 'package.json must depend on @earendil-works/pi-coding-agent');
  assert.ok(!version.startsWith('^'), 'version must be pinned without caret');
  assert.ok(!version.startsWith('~'), 'version must be pinned without tilde');
});

test('runtime execution surfaces use one pi-coding-agent package family', () => {
  const runtimeFiles = [
    'lib/pi-sdk-host.mjs',
  ];

  for (const relativePath of runtimeFiles) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', '..', relativePath), 'utf8');
    assert.doesNotMatch(
      source,
      /@mariozechner\/pi-coding-agent/u,
      `${relativePath} must not reference the legacy coding-agent package family`
    );
  }
});
