const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { requireSpawn } = require('../helpers/spawn');
const { withTempDir } = require('../helpers/temp-dir');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const FAKE_PI_PATH = path.join(ROOT_DIR, 'tests', 'fixtures', 'fake-pi-complete-then-hang.ps1');
const FAKE_PI_ECHO_STDIN_PATH = path.join(ROOT_DIR, 'tests', 'fixtures', 'fake-pi-echo-stdin.ps1');

function createFakePiShimWithCli(baseDir) {
  const shimDir = path.join(baseDir, 'fake-pi-shim');
  const cliDir = path.join(shimDir, 'node_modules', '@mariozechner', 'pi-coding-agent', 'dist');
  const shimPath = path.join(shimDir, 'pi.ps1');
  const cliPath = path.join(cliDir, 'cli.js');

  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(shimPath, '# intentionally unused shim', 'utf8');
  fs.writeFileSync(
    cliPath,
    [
      "let data = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { data += chunk; });",
      "process.stdin.on('end', () => {",
      "  const message = {",
      "    type: 'message_end',",
      "    message: {",
      "      role: 'assistant',",
      "      content: [{ type: 'text', text: data }],",
      "      stopReason: 'stop',",
      "      timestamp: Date.now(),",
      "    },",
      "  };",
      "  process.stdout.write(`${JSON.stringify(message)}\\n`);",
      '});',
      'process.stdin.resume();',
    ].join('\n'),
    'utf8'
  );

  return shimPath;
}

function createFakePiShimCapturingRuntimeInfo(baseDir) {
  const shimDir = path.join(baseDir, 'fake-pi-shim-capture');
  const cliDir = path.join(shimDir, 'node_modules', '@mariozechner', 'pi-coding-agent', 'dist');
  const shimPath = path.join(shimDir, 'pi.ps1');
  const cliPath = path.join(cliDir, 'cli.js');

  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(shimPath, '# intentionally unused shim', 'utf8');
  fs.writeFileSync(
    cliPath,
    [
      'const fs = require("node:fs");',
      'const payload = { cwd: process.cwd(), argv: process.argv.slice(2) };',
      'if (process.env.TEST_CAPTURE_PATH) {',
      '  fs.writeFileSync(process.env.TEST_CAPTURE_PATH, JSON.stringify(payload), "utf8");',
      '}',
      'const message = {',
      '  type: "message_end",',
      '  message: {',
      '    role: "assistant",',
      '    content: [{ type: "text", text: JSON.stringify(payload) }],',
      '    stopReason: "stop",',
      '    timestamp: Date.now(),',
      '  },',
      '};',
      'process.stdout.write(`${JSON.stringify(message)}\\n`);',
    ].join('\n'),
    'utf8'
  );

  return shimPath;
}

function loadRuntimeWithCommandPath(commandPath) {
  const runtimeModulePath = require.resolve('../../build/lib/pi-runtime');
  const previousCommandPath = process.env.PI_COMMAND_PATH;

  delete require.cache[runtimeModulePath];
  process.env.PI_COMMAND_PATH = commandPath;

  return {
    runtime: require('../../build/lib/pi-runtime'),
    restore() {
      delete require.cache[runtimeModulePath];

      if (previousCommandPath === undefined) {
        delete process.env.PI_COMMAND_PATH;
        return;
      }

      process.env.PI_COMMAND_PATH = previousCommandPath;
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

test('pi runtime treats a terminal assistant message as successful completion even if the child keeps running', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('PI_COMMAND_PATH override fixture is currently exercised on Windows only');
    return;
  }

  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-');
  const sqlitePath = path.join(tempDir, 'pi-runtime.sqlite');
  const { runtime, restore } = loadRuntimeWithCommandPath(FAKE_PI_PATH);
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

test('pi runtime allows callers to mark a run complete early', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('PI_COMMAND_PATH override fixture is currently exercised on Windows only');
    return;
  }

  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-complete-');
  const sqlitePath = path.join(tempDir, 'pi-runtime-complete.sqlite');
  const { runtime, restore } = loadRuntimeWithCommandPath(FAKE_PI_ECHO_STDIN_PATH);
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

test('pi runtime pipes the full prompt through stdin so quoted history is preserved', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('PI_COMMAND_PATH override fixture is currently exercised on Windows only');
    return;
  }

  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-stdin-');
  const sqlitePath = path.join(tempDir, 'pi-runtime-stdin.sqlite');
  const { runtime, restore } = loadRuntimeWithCommandPath(FAKE_PI_ECHO_STDIN_PATH);
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
      reject(new Error('Timed out waiting for stdin echo completion'));
    }, 2000);
  });

  const result = await Promise.race([handle.resultPromise, timeoutPromise]);

  assert.equal(result.reply, prompt);
  assert.match(result.reply, /before "quoted" after/u);
  assert.match(result.reply, /Keep "this segment" and the trailing text/u);
});

test('pi runtime bypasses PowerShell shims so unicode stdin prompts stay intact on Windows', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('PI_COMMAND_PATH override fixture is currently exercised on Windows only');
    return;
  }

  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-unicode-');
  const sqlitePath = path.join(tempDir, 'pi-runtime-unicode.sqlite');
  const fakeShimPath = createFakePiShimWithCli(tempDir);
  const { runtime, restore } = loadRuntimeWithCommandPath(fakeShimPath);
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
      reject(new Error('Timed out waiting for unicode shim completion'));
    }, 2000);
  });

  const result = await Promise.race([handle.resultPromise, timeoutPromise]);

  assert.equal(result.reply, prompt);
  assert.match(result.reply, /中文内容 "保留后文"/u);
  assert.match(result.reply, /继续看乱码/u);
});

test('pi runtime respects explicit cwd and forwards extra extensions', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('PI_COMMAND_PATH override fixture is currently exercised on Windows only');
    return;
  }

  if (!requireSpawn(t)) {
    return;
  }

  const tempDir = withTempDir('caff-pi-runtime-cwd-');
  const projectDir = path.join(tempDir, 'project-root');
  const sqlitePath = path.join(tempDir, 'pi-runtime-cwd.sqlite');
  const capturePath = path.join(tempDir, 'capture.json');
  const extraExtensionPath = path.join(tempDir, 'extra-extension.mjs');
  const fakeShimPath = createFakePiShimCapturingRuntimeInfo(tempDir);
  const { runtime, restore } = loadRuntimeWithCommandPath(fakeShimPath);
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
  const extensionArgs = [];

  for (let i = 0; i < captured.argv.length; i += 1) {
    if (captured.argv[i] === '--extension' && captured.argv[i + 1]) {
      extensionArgs.push(captured.argv[i + 1]);
    }
  }

  assert.equal(captured.cwd, projectDir);
  assert.ok(extensionArgs.includes(path.resolve(extraExtensionPath)));
});
