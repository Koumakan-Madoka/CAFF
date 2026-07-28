const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

async function loadHostModule() {
  const hostPath = path.resolve(__dirname, '..', '..', 'lib', 'pi-sdk-host.mjs');
  return import(`${pathToFileURL(hostPath).href}?test=${Date.now()}-${Math.random()}`);
}

function createFakeSdk(calls) {
  class DefaultResourceLoader {
    constructor(options) {
      calls.push({ type: 'resource_loader_create', options });
      this.options = options;
    }

    async reload() {
      calls.push({ type: 'resource_loader_reload' });
    }
  }

  return {
    DefaultResourceLoader,
    ModelRuntime: {
      async create(options) {
        calls.push({ type: 'model_runtime_create', options });
        return { kind: 'model_runtime' };
      },
    },
    SettingsManager: {
      create(cwd, agentDir) {
        calls.push({ type: 'settings_manager_create', cwd, agentDir });
        return { kind: 'settings_manager' };
      },
    },
    SessionManager: {
      open(sessionPath, sessionDir, cwdOverride) {
        calls.push({ type: 'session_open', sessionPath, sessionDir, cwdOverride });
        return { kind: 'session_open' };
      },
      continueRecent(cwd, sessionDir) {
        calls.push({ type: 'session_continue', cwd, sessionDir });
        return { kind: 'session_continue' };
      },
      create(cwd, sessionDir) {
        calls.push({ type: 'session_create', cwd, sessionDir });
        return { kind: 'session_create' };
      },
    },
    resolveCliModel(options) {
      calls.push({ type: 'resolve_model', options });
      return { model: { provider: 'test-provider', id: 'test-model' }, thinkingLevel: 'high' };
    },
    async createAgentSession(options) {
      calls.push({ type: 'create_agent_session', options });
      return {
        session: {
          subscribe(listener) {
            calls.push({ type: 'subscribe', listener });
            return () => {};
          },
          async prompt(prompt) {
            calls.push({ type: 'prompt', prompt });
            const subscription = calls.find((entry) => entry.type === 'subscribe');
            subscription?.listener({
              type: 'tool_execution_start',
              toolCallId: 'tool-1',
              toolName: 'read',
            });
          },
          async waitForIdle() {
            calls.push({ type: 'wait_for_idle' });
          },
          async abort() {
            calls.push({ type: 'abort' });
          },
          dispose() {
            calls.push({ type: 'dispose' });
          },
        },
      };
    },
  };
}

function expectedSessionDir(cwd, agentDir) {
  const resolvedCwd = path.resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`;
  return path.join(path.resolve(agentDir), 'sessions', safePath);
}

test('SDK host maps an explicit CAFF session path and extension list into SDK managers', async () => {
  const { createSdkSession } = await loadHostModule();
  const calls = [];
  const sdk = createFakeSdk(calls);
  const cwd = path.resolve('test-project');
  const agentDir = path.resolve('test-agent-dir');
  const sessionPath = path.join(agentDir, 'named-sessions', 'named.jsonl');
  const extensionPath = path.resolve('test-extension.mjs');

  const result = await createSdkSession(sdk, {
    provider: 'test-provider',
    model: 'test-model',
    thinking: 'high',
    agentDir,
    sessionPath,
    resume: true,
    cwd,
    extensionPaths: [extensionPath],
  });

  const openCall = calls.find((entry) => entry.type === 'session_open');
  assert.deepEqual(openCall, {
    type: 'session_open',
    sessionPath,
    sessionDir: path.dirname(sessionPath),
    cwdOverride: cwd,
  });

  const loaderCall = calls.find((entry) => entry.type === 'resource_loader_create');
  assert.deepEqual(loaderCall.options.additionalExtensionPaths, [extensionPath]);
  assert.equal(loaderCall.options.cwd, cwd);
  assert.equal(loaderCall.options.agentDir, agentDir);
  assert.ok(calls.some((entry) => entry.type === 'resource_loader_reload'));

  const createCall = calls.find((entry) => entry.type === 'create_agent_session');
  assert.equal(createCall.options.sessionManager.kind, 'session_open');
  assert.equal(createCall.options.resourceLoader, result.resourceLoader);
  assert.equal(createCall.options.settingsManager.kind, 'settings_manager');
  assert.equal(result.session.sessionFile, undefined);
});

test('SDK host maps resume and fresh runs to the pinned agent directory session tree', async () => {
  const { createSessionManager } = await loadHostModule();
  const cwd = path.resolve('resume-project');
  const agentDir = path.resolve('resume-agent-dir');
  const sessionDir = expectedSessionDir(cwd, agentDir);

  const resumeCalls = [];
  const resumeSdk = createFakeSdk(resumeCalls);
  const resumed = createSessionManager(resumeSdk, { cwd, agentDir, sessionPath: '', resume: true });
  assert.equal(resumed.kind, 'session_continue');
  assert.deepEqual(resumeCalls.find((entry) => entry.type === 'session_continue'), {
    type: 'session_continue',
    cwd,
    sessionDir,
  });

  const freshCalls = [];
  const freshSdk = createFakeSdk(freshCalls);
  const fresh = createSessionManager(freshSdk, { cwd, agentDir, sessionPath: '', resume: false });
  assert.equal(fresh.kind, 'session_create');
  assert.deepEqual(freshCalls.find((entry) => entry.type === 'session_create'), {
    type: 'session_create',
    cwd,
    sessionDir,
  });
});

test('SDK host forwards typed events and aborts the SDK session before disposal', async () => {
  const { runAgentSession, abortSdkSession } = await loadHostModule();
  const calls = [];
  const sdk = createFakeSdk(calls);
  const { session } = await createSdkSessionForTest(sdk, calls);
  const sent = [];

  await runAgentSession(session, 'hello over IPC', (message) => sent.push(message));
  const typedEvent = { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read' };

  assert.deepEqual(sent, [{ type: 'pi_event', event: typedEvent }]);
  assert.ok(calls.some((entry) => entry.type === 'prompt' && entry.prompt === 'hello over IPC'));
  assert.ok(calls.some((entry) => entry.type === 'wait_for_idle'));

  await abortSdkSession(session);
  assert.ok(calls.findIndex((entry) => entry.type === 'abort') < calls.findIndex((entry) => entry.type === 'dispose'));
});

test('SDK host aborts a session created after shutdown starts without reporting a host error', async () => {
  const { startProcessHost } = await loadHostModule();
  const runtimeProcess = new EventEmitter();
  const sent = [];
  const stderr = [];
  const lifecycle = [];
  let resolveCreatedSession;

  runtimeProcess.connected = true;
  runtimeProcess.platform = process.platform;
  runtimeProcess.stderr = {
    write(message) {
      stderr.push(String(message));
    },
  };
  runtimeProcess.send = (message, callback) => {
    sent.push(message);
    callback?.(null);
  };
  runtimeProcess.disconnect = () => {
    runtimeProcess.connected = false;
  };

  const createdSession = new Promise((resolve) => {
    resolveCreatedSession = resolve;
  });
  const session = {
    async abort() {
      lifecycle.push('abort');
    },
    dispose() {
      lifecycle.push('dispose');
    },
  };

  startProcessHost({
    runtimeProcess,
    loadSdk: async () => ({}),
    createSession: async () => createdSession,
  });

  runtimeProcess.emit('message', {
    type: 'start',
    prompt: 'hello',
    config: { heartbeatIntervalMs: 0 },
  });
  await Promise.resolve();
  runtimeProcess.emit('message', { type: 'abort' });
  resolveCreatedSession({ session });

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(lifecycle, ['abort', 'dispose']);
  assert.deepEqual(stderr, []);
  assert.ok(!sent.some((message) => message.type === 'host_error'));
  assert.equal(runtimeProcess.exitCode, 0);
});

async function createSdkSessionForTest(sdk, calls) {
  const { createSdkSession } = await loadHostModule();
  const result = await createSdkSession(sdk, {
    provider: 'test-provider',
    model: 'test-model',
    thinking: 'high',
    agentDir: path.resolve('test-agent-dir'),
    sessionPath: '',
    resume: false,
    cwd: path.resolve('test-project'),
    extensionPaths: [],
  });
  assert.ok(calls.some((entry) => entry.type === 'create_agent_session'));
  return result;
}
