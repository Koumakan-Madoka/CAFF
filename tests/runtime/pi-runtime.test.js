const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

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
