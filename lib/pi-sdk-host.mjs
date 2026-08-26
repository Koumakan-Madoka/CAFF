#!/usr/bin/env node
// @ts-nocheck

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SDK_SPECIFIER = '@earendil-works/pi-coding-agent';
const STREAM_READ_RETRY_EXTENSION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'pi-extensions',
  'caff-stream-read-retry.mjs'
);
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
const MINIMUM_NODE_VERSION = [22, 19, 0];
const MINIMUM_NODE_VERSION_TEXT = MINIMUM_NODE_VERSION.join('.');

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

export function resolveRuntimeExtensionPaths(value) {
  return [...new Set([
    STREAM_READ_RETRY_EXTENSION_PATH,
    ...normalizeExtensionPaths(value),
  ])];
}

export function assertSupportedNodeVersion(version = process.versions.node) {
  const normalized = normalizeString(version).replace(/^v/u, '');
  const parts = normalized.split('.').map((entry) => Number.parseInt(entry, 10));
  const valid = parts.length >= 2 && parts.slice(0, 3).every(Number.isFinite);

  if (valid) {
    const [major = 0, minor = 0, patch = 0] = parts;
    const [minimumMajor, minimumMinor, minimumPatch] = MINIMUM_NODE_VERSION;
    const supported = major > minimumMajor ||
      (major === minimumMajor && minor > minimumMinor) ||
      (major === minimumMajor && minor === minimumMinor && patch >= minimumPatch);

    if (supported) {
      return;
    }
  }

  throw new Error(
    `@earendil-works/pi-coding-agent requires Node.js >=${MINIMUM_NODE_VERSION_TEXT}; ` +
    `current runtime is ${normalized || 'unknown'}`
  );
}

export function normalizeStartCommand(command) {
  if (!command || typeof command !== 'object' || command.type !== 'start') {
    throw new Error('SDK host expected a structured start command');
  }

  const prompt = typeof command.prompt === 'string' ? command.prompt : '';
  const images = Array.isArray(command.images) ? command.images : [];

  if (!prompt.trim()) {
    throw new Error('SDK host start command requires a non-empty prompt');
  }

  const input = command.config && typeof command.config === 'object' ? command.config : {};
  const cwd = path.resolve(normalizeString(input.cwd) || process.cwd());
  const agentDir = path.resolve(normalizeString(input.agentDir) || path.join(cwd, '.pi-sandbox'));

  return {
    prompt,
    images,
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

function formatDiagnosticErrors(diagnostics) {
  return diagnostics
    .filter((diagnostic) => diagnostic?.type === 'error')
    .map((diagnostic) => normalizeString(diagnostic.message))
    .filter(Boolean);
}

export async function createSdkRuntime(sdk, config) {
  const initialSessionManager = createSessionManager(sdk, config);
  const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = await sdk.createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        additionalExtensionPaths: resolveRuntimeExtensionPaths(config.extensionPaths),
      },
    });
    const diagnostics = Array.isArray(services.diagnostics) ? services.diagnostics : [];
    const diagnosticErrors = formatDiagnosticErrors(diagnostics);

    if (diagnosticErrors.length > 0) {
      throw new Error(`Pi SDK runtime initialization failed:\n${diagnosticErrors.join('\n')}`);
    }

    const modelResult = sdk.resolveCliModel({
      cliProvider: config.provider || undefined,
      cliModel: config.model || undefined,
      cliThinking: config.thinking || undefined,
      modelRuntime: services.modelRuntime,
    });

    if (modelResult.error || !modelResult.model) {
      throw new Error(
        modelResult.error || `No model resolved for provider=${config.provider} model=${config.model}`
      );
    }

    const createOptions = {
      services,
      sessionManager,
      sessionStartEvent,
      model: modelResult.model,
    };
    const thinkingLevel = modelResult.thinkingLevel || config.thinking;

    if (thinkingLevel) {
      createOptions.thinkingLevel = thinkingLevel;
    }

    const created = await sdk.createAgentSessionFromServices(createOptions);
    return {
      ...created,
      services,
      diagnostics,
    };
  };

  const runtime = await sdk.createAgentSessionRuntime(createRuntime, {
    cwd: config.cwd,
    agentDir: config.agentDir,
    sessionManager: initialSessionManager,
  });

  return { runtime };
}

function createExtensionBindings(runtime, session, onExtensionError) {
  return {
    mode: 'json',
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: async (options) => runtime.newSession(options),
      fork: async (entryId, options) => {
        const result = await runtime.fork(entryId, options);
        return { cancelled: result.cancelled };
      },
      navigateTree: async (targetId, options) => {
        const result = await session.navigateTree(targetId, {
          summarize: options?.summarize,
          customInstructions: options?.customInstructions,
          replaceInstructions: options?.replaceInstructions,
          label: options?.label,
        });
        return { cancelled: result.cancelled };
      },
      switchSession: async (sessionPath, options) => runtime.switchSession(sessionPath, options),
      reload: async () => session.reload(),
    },
    onError: onExtensionError,
  };
}

function normalizeRecoveryRequest(request) {
  const input = request && typeof request === 'object' ? request : {};
  const parsedAttempt = Number.parseInt(String(input.attempt ?? 1), 10);
  const attempt = Number.isFinite(parsedAttempt) && parsedAttempt > 0 ? parsedAttempt : 1;
  const toolNameMatch = normalizeString(input.toolName).match(/^[a-z0-9._:/-]+/iu);
  const toolName = toolNameMatch ? toolNameMatch[0].slice(0, 80) : '';
  const reason = input.reason && typeof input.reason === 'object'
    ? {
        type: normalizeString(input.reason.type) || 'progress_timeout',
        message: normalizeString(input.reason.message).replace(/\s+/gu, ' ').slice(0, 240),
      }
    : { type: 'progress_timeout', message: '' };

  return { attempt, toolName, reason };
}

export function buildToolRecoveryPrompt(request) {
  const normalized = normalizeRecoveryRequest(request);
  const toolLabel = normalized.toolName ? ` \"${normalized.toolName}\"` : '';

  return [
    `The runtime progress watchdog stopped the active${toolLabel} tool because it produced no observable progress.`,
    'Treat the aborted tool result as a recoverable tool error. Do not repeat the same broad operation unchanged.',
    'First use a short, bounded preflight or connectivity check (normally 20-30 seconds), then retry only with an explicit bounded command when the prerequisite is available.',
    'If an external prerequisite such as connectivity, credentials, access, or user-managed environment state is missing, stop and ask the user instead of waiting or retrying broadly.',
  ].join('\n');
}

export async function runAgentRuntime(runtime, prompt, send, options = {}) {
  let session = runtime.session;
  let unsubscribe;
  let originalTurnInFlight = false;
  let acceptingRecovery = false;
  let recoveryVersion = 0;
  let recoveryChain = Promise.resolve();
  const rawOptions = typeof options === 'function' ? { onExtensionError: options } : options;
  const images = Array.isArray(rawOptions.images) ? rawOptions.images : [];
  const onExtensionError = typeof rawOptions.onExtensionError === 'function' ? rawOptions.onExtensionError : () => {};
  const onRecoveryStarted = typeof rawOptions.onRecoveryStarted === 'function' ? rawOptions.onRecoveryStarted : async () => {};
  const onRecoveryFailed = typeof rawOptions.onRecoveryFailed === 'function' ? rawOptions.onRecoveryFailed : async () => {};
  const isStopping = typeof rawOptions.isStopping === 'function' ? rawOptions.isStopping : () => false;

  const rebindSession = async () => {
    session = runtime.session;
    await session.bindExtensions(createExtensionBindings(runtime, session, onExtensionError));
    unsubscribe?.();
    unsubscribe = session.subscribe((event) => {
      send({ type: 'pi_event', event });
    });
  };

  const reportRecoveryFailure = async (request, code) => {
    if (isStopping()) {
      return;
    }

    try {
      await onRecoveryFailed({
        reason: request.reason,
        attempt: request.attempt,
        toolName: request.toolName,
        code,
      });
    } catch (error) {
      const detail = error?.stack || error?.message || String(error);
      onExtensionError({ extensionPath: 'caff:tool-recovery', error: detail });
    }
  };

  const requestRecovery = (input = {}) => {
    const request = normalizeRecoveryRequest(input);

    if (request.attempt !== 1) {
      return reportRecoveryFailure(request, 'invalid_attempt');
    }

    if (!acceptingRecovery || !originalTurnInFlight || session?.isStreaming !== true) {
      return reportRecoveryFailure(request, 'turn_not_active');
    }

    if (recoveryVersion > 0) {
      return reportRecoveryFailure(request, 'recovery_already_used');
    }

    acceptingRecovery = false;
    recoveryVersion = request.attempt;
    recoveryChain = recoveryChain.then(async () => {
      try {
        await session.abort();
        await session.waitForIdle();

        if (isStopping()) {
          return;
        }

        let preflightSettled = false;
        let settlePreflight;
        const preflightPromise = new Promise((resolve) => {
          settlePreflight = (accepted) => {
            if (preflightSettled) {
              return;
            }

            preflightSettled = true;
            resolve(Boolean(accepted));
          };
        });
        const recoveryPromptPromise = Promise.resolve(session.prompt(buildToolRecoveryPrompt(request), {
          preflightResult: settlePreflight,
        })).then((result) => {
          settlePreflight(true);
          return result;
        }, (error) => {
          settlePreflight(false);
          throw error;
        });
        const accepted = await preflightPromise;

        if (!accepted) {
          await recoveryPromptPromise;
          throw new Error('Recovery prompt was not accepted');
        }

        await onRecoveryStarted(request);
        await recoveryPromptPromise;
        await session.waitForIdle();
      } catch (error) {
        if (!isStopping()) {
          const detail = error?.stack || error?.message || String(error);
          onExtensionError({ extensionPath: 'caff:tool-recovery', error: detail });
          await reportRecoveryFailure(request, 'recovery_prompt_failed');
        }
      }
    });

    return recoveryChain;
  };

  rawOptions.onRecoveryRequest?.(requestRecovery);
  runtime.setRebindSession(rebindSession);

  try {
    await rebindSession();
    acceptingRecovery = true;
    originalTurnInFlight = true;

    try {
      await session.prompt(prompt, images.length > 0 ? { images } : undefined);
      await session.waitForIdle();
    } finally {
      originalTurnInFlight = false;
      acceptingRecovery = false;
    }

    while (true) {
      const observedVersion = recoveryVersion;
      await recoveryChain;
      await new Promise((resolve) => setImmediate(resolve));

      if (observedVersion === recoveryVersion) {
        break;
      }
    }
  } finally {
    rawOptions.onRecoveryRequest?.(undefined);
    unsubscribe?.();
    runtime.setRebindSession(undefined);
  }
}

export async function disposeSdkRuntime(runtime) {
  if (!runtime) {
    return;
  }

  await runtime.dispose();
}

export async function abortSdkRuntime(runtime) {
  if (!runtime) {
    return;
  }

  try {
    await runtime.session.abort();
  } finally {
    await disposeSdkRuntime(runtime);
  }
}

function isMainModule() {
  const entryPath = process.argv[1];
  return Boolean(entryPath) && import.meta.url === pathToFileURL(path.resolve(entryPath)).href;
}

export function startProcessHost(options = {}) {
  const runtimeProcess = options.runtimeProcess || process;
  const loadSdk = options.loadSdk || (() => import(SDK_SPECIFIER));
  const createRuntime = options.createRuntime || createSdkRuntime;
  let runtime = null;
  let heartbeatTimer = null;
  let started = false;
  let stopping = false;
  let recoverRun = null;
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
        await abortSdkRuntime(runtime);
      } else {
        await disposeSdkRuntime(runtime);
      }
    } catch (error) {
      writeStderr(error?.stack || error?.message || String(error));
    } finally {
      runtime = null;
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
      assertSupportedNodeVersion(runtimeProcess.versions?.node || process.versions.node);
      startHeartbeat(normalized.config.heartbeatIntervalMs);
      const sdk = await loadSdk();
      const created = await createRuntime(sdk, normalized.config);

      if (stopping) {
        await abortSdkRuntime(created.runtime);
        return;
      }

      runtime = created.runtime;

      await send({
        type: 'ready',
        sessionPath: runtime.session.sessionFile || normalized.config.sessionPath || null,
      });
      await runAgentRuntime(runtime, normalized.prompt, send, {
        images: normalized.images,
        onExtensionError: (error) => {
          const detail = error?.error?.stack || error?.error?.message || error?.error || 'unknown error';
          writeStderr(`Extension error (${error?.extensionPath || 'unknown'}): ${detail}`);
        },
        onRecoveryRequest(handler) {
          recoverRun = typeof handler === 'function' ? handler : null;
        },
        async onRecoveryStarted(event) {
          if (!stopping) {
            await send({ type: 'recovery_started', ...event });
          }
        },
        async onRecoveryFailed(event) {
          if (!stopping) {
            await send({ type: 'recovery_failed', ...event });
          }
        },
        isStopping() {
          return stopping;
        },
      });
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

    if (command?.type === 'recover') {
      if (typeof recoverRun === 'function' && !stopping) {
        void Promise.resolve(recoverRun(command)).catch((error) => {
          writeStderr(error?.stack || error?.message || String(error));
        });
        return;
      }

      if (!stopping) {
        const request = normalizeRecoveryRequest(command);
        void send({
          type: 'recovery_failed',
          reason: request.reason,
          attempt: request.attempt,
          toolName: request.toolName,
          code: 'turn_not_active',
        });
      }
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
