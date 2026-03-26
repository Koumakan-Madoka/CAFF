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

function loadRuntimeWithCommandPath(commandPath) {
  const runtimeModulePath = require.resolve('../../lib/pi-runtime');
  const previousCommandPath = process.env.PI_COMMAND_PATH;

  delete require.cache[runtimeModulePath];
  process.env.PI_COMMAND_PATH = commandPath;

  return {
    runtime: require('../../lib/pi-runtime'),
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
