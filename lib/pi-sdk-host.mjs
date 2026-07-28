#!/usr/bin/env node
// @ts-nocheck

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SDK_SPECIFIER = '@earendil-works/pi-coding-agent';
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeInteger(value, fallback, name) {
  const candidate = value === undefined || value === null || value === '' ? fallback : value;
  const parsed = Number.parseInt(String(candidate), 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, received: ${candidate}`);
  }

  return parsed;
}

function normalizeExtensionPaths(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeString(entry))
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
}

export function normalizeStartCommand(command) {
  if (!command || typeof command !== 'object' || command.type !== 'start') {
    throw new Error('SDK host expected a structured start command');
  }

  const prompt = typeof command.prompt === 'string' ? command.prompt : '';

  if (!prompt.trim()) {
    throw new Error('SDK host start command requires a non-empty prompt');
  }

  const input = command.config && typeof command.config === 'object' ? command.config : {};
  const cwd = path.resolve(normalizeString(input.cwd) || process.cwd());
  const agentDir = path.resolve(normalizeString(input.agentDir) || path.join(cwd, '.pi-sandbox'));

  return {
    prompt,
    config: {
      provider: normalizeString(input.provider),
      model: normalizeString(input.model),
      thinking: normalizeString(input.thinking),
      agentDir,
      sessionPath: normalizeString(input.sessionPath) ? path.resolve(String(input.sessionPath)) : '',
      resume: Boolean(input.resume),
      cwd,
      extensionPaths: normalizeExtensionPaths(input.extensionPaths),
      heartbeatIntervalMs: normalizeInteger(
        input.heartbeatIntervalMs,
        DEFAULT_HEARTBEAT_INTERVAL_MS,
        'heartbeatIntervalMs'
      ),
    },
  };
}

export function resolveSessionDir(cwd, agentDir) {
  const resolvedCwd = path.resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`;
  return path.join(path.resolve(agentDir), 'sessions', safePath);
}

export function createSessionManager(sdk, config) {
  if (config.sessionPath) {
    return sdk.SessionManager.open(config.sessionPath, path.dirname(config.sessionPath), config.cwd);
  }

  const sessionDir = resolveSessionDir(config.cwd, config.agentDir);

  if (config.resume) {
    return sdk.SessionManager.continueRecent(config.cwd, sessionDir);
  }

  return sdk.SessionManager.create(config.cwd, sessionDir);
}

export async function createSdkSession(sdk, config) {
  const runtimeOptions = {};
  const authPath = path.join(config.agentDir, 'auth.json');
  const modelsPath = path.join(config.agentDir, 'models.json');

  if (existsSync(authPath)) runtimeOptions.authPath = authPath;
  if (existsSync(modelsPath)) runtimeOptions.modelsPath = modelsPath;

  const modelRuntime = await sdk.ModelRuntime.create(runtimeOptions);
  const settingsManager = sdk.SettingsManager.create(config.cwd, config.agentDir);
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: config.cwd,
    agentDir: config.agentDir,
    settingsManager,
    additionalExtensionPaths: config.extensionPaths,
  });
  await resourceLoader.reload();

  const sessionManager = createSessionManager(sdk, config);
  const modelResult = sdk.resolveCliModel({
    cliProvider: config.provider || undefined,
    cliModel: config.model || undefined,
    cliThinking: config.thinking || undefined,
    modelRuntime,
  });

  if (modelResult.error || !modelResult.model) {
    throw new Error(
      modelResult.error || `No model resolved for provider=${config.provider} model=${config.model}`
    );
  }

  const createOptions = {
    cwd: config.cwd,
    agentDir: config.agentDir,
    model: modelResult.model,
    modelRuntime,
    settingsManager,
    resourceLoader,
    sessionManager,
  };
  const thinkingLevel = modelResult.thinkingLevel || config.thinking;

  if (thinkingLevel) {
    createOptions.thinkingLevel = thinkingLevel;
  }

  const result = await sdk.createAgentSession(createOptions);

  return {
    ...result,
    modelRuntime,
    settingsManager,
    resourceLoader,
    sessionManager,
  };
}

export async function runAgentSession(session, prompt, send) {
  const unsubscribe = session.subscribe((event) => {
    send({ type: 'pi_event', event });
  });

  try {
    await session.prompt(prompt);
    await session.waitForIdle();
  } finally {
    unsubscribe?.();
  }
}

export function disposeSdkSession(session) {
  if (!session) {
    return;
  }

  session.dispose();
}

export async function abortSdkSession(session) {
  if (!session) {
    return;
  }

  try {
    await session.abort();
  } finally {
    disposeSdkSession(session);
  }
}

function isMainModule() {
  const entryPath = process.argv[1];
  return Boolean(entryPath) && import.meta.url === pathToFileURL(path.resolve(entryPath)).href;
}

export function startProcessHost(options = {}) {
  const runtimeProcess = options.runtimeProcess || process;
  const loadSdk = options.loadSdk || (() => import(SDK_SPECIFIER));
  const createSession = options.createSession || createSdkSession;
  let session = null;
  let heartbeatTimer = null;
  let started = false;
  let stopping = false;
  let sendQueue = Promise.resolve();

  function writeStderr(message) {
    runtimeProcess.stderr.write(`${message}\n`);
  }

  function send(message) {
    sendQueue = sendQueue.then(() => new Promise((resolve, reject) => {
      if (typeof runtimeProcess.send !== 'function' || !runtimeProcess.connected) {
        reject(new Error('SDK host IPC channel is not connected'));
        return;
      }

      runtimeProcess.send(message, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    }));

    sendQueue.catch((error) => writeStderr(error?.stack || error?.message || String(error)));
    return sendQueue;
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startHeartbeat(intervalMs) {
    if (intervalMs <= 0 || heartbeatTimer) {
      return;
    }

    heartbeatTimer = setInterval(() => {
      void send({ type: 'heartbeat', timestamp: Date.now() });
    }, intervalMs);
    heartbeatTimer.unref?.();
  }

  async function shutdown(code, abort) {
    if (stopping) {
      return;
    }

    stopping = true;
    stopHeartbeat();

    try {
      if (abort) {
        await abortSdkSession(session);
      } else {
        disposeSdkSession(session);
      }
    } catch (error) {
      writeStderr(error?.stack || error?.message || String(error));
    } finally {
      session = null;
    }

    try {
      await sendQueue;
    } catch {}

    if (runtimeProcess.connected) {
      runtimeProcess.disconnect();
    }

    runtimeProcess.exitCode = code;
  }

  async function start(command) {
    try {
      const normalized = normalizeStartCommand(command);
      startHeartbeat(normalized.config.heartbeatIntervalMs);
      const sdk = await loadSdk();
      const created = await createSession(sdk, normalized.config);

      if (stopping) {
        await abortSdkSession(created.session);
        return;
      }

      session = created.session;

      await send({
        type: 'ready',
        sessionPath: session.sessionFile || normalized.config.sessionPath || null,
      });
      await runAgentSession(session, normalized.prompt, send);
      await sendQueue;
      await shutdown(0, false);
    } catch (error) {
      if (stopping) {
        return;
      }

      const message = error?.stack || error?.message || String(error);
      writeStderr(message);

      try {
        await send({ type: 'host_error', message });
      } catch {}

      await shutdown(1, true);
    }
  }

  runtimeProcess.on('message', (command) => {
    if (command?.type === 'abort') {
      void shutdown(0, true);
      return;
    }

    if (command?.type !== 'start') {
      return;
    }

    if (started) {
      writeStderr('SDK host received more than one start command');
      void shutdown(1, true);
      return;
    }

    started = true;
    void start(command);
  });

  runtimeProcess.on('disconnect', () => {
    void shutdown(1, true);
  });
  runtimeProcess.on('SIGINT', () => {
    void shutdown(130, true);
  });
  runtimeProcess.on('SIGTERM', () => {
    void shutdown(143, true);
  });

  if (runtimeProcess.platform === 'win32') {
    runtimeProcess.on('SIGBREAK', () => {
      void shutdown(149, true);
    });
  }
}

if (isMainModule()) {
  startProcessHost();
}
