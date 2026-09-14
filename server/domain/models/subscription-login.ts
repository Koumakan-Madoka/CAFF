import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { PI_DEFAULT_CONTEXT_WINDOW, PI_DEFAULT_MAX_TOKENS } from './model-provider-config';
import { readModelProviderDocument, updateModelProviderDocument } from './model-provider-persistence';
import {
  readSubscriptionCredential,
  removeSubscriptionCredential,
  writeSubscriptionCredential,
} from './subscription-auth-store';

export const SUBSCRIPTION_LOGIN_CHANNELS = ['anthropic', 'openai-codex'] as const;

type ChannelId = (typeof SUBSCRIPTION_LOGIN_CHANNELS)[number];

type ChannelConfig = {
  channel: ChannelId;
  providerId: string;
  label: string;
  callbackPort: number;
  flowModule: string;
};

const CHANNEL_CONFIGS: Record<ChannelId, ChannelConfig> = {
  anthropic: {
    channel: 'anthropic',
    providerId: 'anthropic',
    label: 'Claude Pro / Max',
    callbackPort: 53692,
    flowModule: 'anthropic.js',
  },
  'openai-codex': {
    channel: 'openai-codex',
    providerId: 'openai-codex',
    label: 'ChatGPT Codex',
    callbackPort: 1455,
    flowModule: 'openai-codex.js',
  },
};

const CODEX_PROVIDER_ID = 'openai-codex';
const CODEX_PROVIDER_NAME = 'OpenAI Codex';
const CODEX_PROVIDER_BASE_URL = 'https://chatgpt.com/backend-api';
const CODEX_PROVIDER_API = 'openai-codex-responses';
const ACTIVE_LOGIN_STATES = new Set(['starting', 'waiting_browser', 'exchanging']);
const SETTLED_SESSION_HISTORY_PER_CHANNEL = 4;
const MAX_SESSION_EVENTS = 20;
const MAX_ERROR_MESSAGE_LENGTH = 400;
const CALLBACK_HOST_ENV = 'PI_OAUTH_CALLBACK_HOST';
const DEFAULT_CALLBACK_HOST = '127.0.0.1';

export class SubscriptionLoginError extends Error {
  code: string;
  channel: string;

  constructor(code: string, message: string, channel = '') {
    super(message);
    this.name = 'SubscriptionLoginError';
    this.code = code;
    this.channel = channel;
  }
}

// pi-ai ships as ESM-only; tsc's commonjs output would rewrite a plain
// dynamic import() into require(), so import through an opaque function
// (same pattern as conversation-digest's importPiAiModule).
const dynamicImport = Function('specifier', 'return import(specifier)');

function findPiAiPackageDir(startDir: string, maxDepth = 10) {
  let current = path.resolve(String(startDir || '.'));

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidate = path.join(current, 'node_modules', '@earendil-works', 'pi-ai');
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
}

let piAiPackageDirPromise: Promise<string> | null = null;

function resolvePiAiPackageDir() {
  if (!piAiPackageDirPromise) {
    piAiPackageDirPromise = Promise.resolve().then(() => {
      const packageDir = findPiAiPackageDir(__dirname);
      if (!packageDir) {
        throw new SubscriptionLoginError(
          'oauth_flow_unavailable',
          'Could not locate the pinned @earendil-works/pi-ai package for OAuth login flows'
        );
      }
      return packageDir;
    });
  }
  return piAiPackageDirPromise;
}

// The OAuth flow modules (dist/auth/oauth/*.js) are Node-only and are not
// exposed through pi-ai's package exports; load them by file URL, matching
// how lib/pi-model-config-validator.mjs reaches into the pinned dist tree.
export async function loadPiAiOAuthFlow(channel: string) {
  const config = CHANNEL_CONFIGS[channel as ChannelId];
  if (!config) {
    throw new SubscriptionLoginError('channel_unknown', `Unknown subscription channel: ${channel}`, channel);
  }

  const packageDir = await resolvePiAiPackageDir();
  const modulePath = path.join(packageDir, 'dist', 'auth', 'oauth', config.flowModule);
  if (!fs.existsSync(modulePath)) {
    throw new SubscriptionLoginError(
      'oauth_flow_unavailable',
      `The pinned pi-ai OAuth flow module is missing: ${config.flowModule}`,
      channel
    );
  }

  const module: any = await dynamicImport(pathToFileURL(modulePath).href);
  const flow = module && (module.anthropicOAuth || module.openaiCodexOAuth);
  if (!flow || typeof flow.login !== 'function') {
    throw new SubscriptionLoginError(
      'oauth_flow_unavailable',
      `The pinned pi-ai OAuth flow for "${channel}" did not expose a login() function`,
      channel
    );
  }
  return flow;
}

export async function loadOpenAICodexModels() {
  const module: any = await dynamicImport('@earendil-works/pi-ai/providers/openai-codex.models');
  const models = module && module.OPENAI_CODEX_MODELS;
  if (!models || typeof models !== 'object') {
    throw new SubscriptionLoginError('codex_models_unavailable', 'Could not load the pinned Codex model catalog');
  }
  return models;
}

export function buildCodexProviderEntry(codexModels: any) {
  const models = Object.values(codexModels || {})
    .filter((model: any): model is Record<string, any> => Boolean(model) && typeof model === 'object')
    .map((model) => {
      const contextWindow = Number.isInteger(model.contextWindow) && model.contextWindow > 0
        ? model.contextWindow
        : PI_DEFAULT_CONTEXT_WINDOW;
      const maxTokens = Number.isInteger(model.maxTokens) && model.maxTokens > 0
        ? model.maxTokens
        : PI_DEFAULT_MAX_TOKENS;

      return {
        id: String(model.id),
        name: String(model.name || model.id),
        api: String(model.api || CODEX_PROVIDER_API),
        baseUrl: String(model.baseUrl || CODEX_PROVIDER_BASE_URL),
        ...(model.reasoning === true ? { reasoning: true } : {}),
        ...(Array.isArray(model.input) && model.input.length ? { input: [...model.input] } : {}),
        contextWindow,
        maxTokens: Math.min(maxTokens, contextWindow),
      };
    });

  return {
    name: CODEX_PROVIDER_NAME,
    baseUrl: CODEX_PROVIDER_BASE_URL,
    api: CODEX_PROVIDER_API,
    models,
  };
}

export function resolveCallbackHost(env: any = process.env) {
  const host = typeof env === 'object' && typeof env[CALLBACK_HOST_ENV] === 'string'
    ? env[CALLBACK_HOST_ENV].trim()
    : '';
  return host || DEFAULT_CALLBACK_HOST;
}

function defaultCheckPortAvailable(host: string, port: number) {
  return new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    const fail = (error: any) => {
      probe.close();
      reject(error);
    };
    probe.once('error', fail);
    probe.listen(port, host, () => {
      probe.close(() => resolve());
    });
  });
}

function sanitizeErrorMessage(error: any) {
  const message = error instanceof Error ? error.message : String(error || 'login failed');
  const text = message.replace(/\s+/gu, ' ').trim();
  return text.slice(0, MAX_ERROR_MESSAGE_LENGTH) || 'login failed';
}

function looksCancelled(error: any, signal: AbortSignal) {
  if (signal.aborted) {
    return true;
  }
  if (error instanceof SubscriptionLoginError) {
    return error.code === 'login_cancelled';
  }
  const name = error && typeof error === 'object' ? String(error.name || '') : '';
  const message = error instanceof Error ? error.message : String(error || '');
  return name === 'AbortError' || /abort|cancel/iu.test(message);
}

export type LoginSessionSnapshot = {
  id: string;
  channel: string;
  state: string;
  authUrl: string | null;
  error: string | null;
  events: Array<{ type: string; message: string }>;
  createdAt: number;
  updatedAt: number;
  providerRegistered: boolean;
};

type LoginSession = {
  id: string;
  channel: ChannelId;
  state: string;
  authUrl: string | null;
  error: string | null;
  events: Array<{ type: string; message: string }>;
  createdAt: number;
  updatedAt: number;
  providerRegistered: boolean;
  abort: AbortController | null;
};

export function createSubscriptionLoginService(options: any = {}) {
  const agentDir = options.agentDir;
  const loadOAuthFlow = typeof options.loadOAuthFlow === 'function' ? options.loadOAuthFlow : loadPiAiOAuthFlow;
  const loadCodexModels = typeof options.loadCodexModels === 'function' ? options.loadCodexModels : loadOpenAICodexModels;
  const checkPortAvailable = typeof options.checkPortAvailable === 'function'
    ? options.checkPortAvailable
    : defaultCheckPortAvailable;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const env = options.env || process.env;
  const onModelsCommitted = typeof options.onModelsCommitted === 'function' ? options.onModelsCommitted : () => {};

  const writeCredential = typeof options.writeCredential === 'function'
    ? options.writeCredential
    : (providerId: string, credential: any) => writeSubscriptionCredential(agentDir, providerId, credential);
  const removeCredential = typeof options.removeCredential === 'function'
    ? options.removeCredential
    : (providerId: string) => removeSubscriptionCredential(agentDir, providerId);
  const readCredential = typeof options.readCredential === 'function'
    ? options.readCredential
    : (providerId: string) => readSubscriptionCredential(agentDir, providerId);

  const sessions = new Map<string, LoginSession>();

  function channelConfig(channel: any): ChannelConfig {
    const config = CHANNEL_CONFIGS[channel as ChannelId];
    if (!config) {
      throw new SubscriptionLoginError('channel_unknown', `Unknown subscription channel: ${String(channel)}`, String(channel));
    }
    return config;
  }

  function snapshotSession(session: LoginSession): LoginSessionSnapshot {
    return {
      id: session.id,
      channel: session.channel,
      state: session.state,
      authUrl: session.authUrl,
      error: session.error,
      events: session.events.map((event) => ({ ...event })),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      providerRegistered: session.providerRegistered,
    };
  }

  function transition(session: LoginSession, state: string) {
    if (session.state === state || !ACTIVE_LOGIN_STATES.has(session.state)) {
      return;
    }
    session.state = state;
    session.updatedAt = now();
  }

  function pushEvent(session: LoginSession, type: string, message: string) {
    session.events.push({ type, message: message.slice(0, 200) });
    if (session.events.length > MAX_SESSION_EVENTS) {
      session.events.splice(0, session.events.length - MAX_SESSION_EVENTS);
    }
    session.updatedAt = now();
  }

  function finalizeSession(
    session: LoginSession,
    state: 'success' | 'error' | 'cancelled',
    error: string | null,
    extra: { providerRegistered?: boolean } = {}
  ) {
    if (!ACTIVE_LOGIN_STATES.has(session.state)) {
      return;
    }
    session.state = state;
    session.error = error;
    session.updatedAt = now();
    if (extra.providerRegistered) {
      session.providerRegistered = true;
    }
    pruneSettledSessions(session.channel);
  }

  function pruneSettledSessions(channel: ChannelId) {
    const settled = [...sessions.values()]
      .filter((session) => session.channel === channel && !ACTIVE_LOGIN_STATES.has(session.state))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    for (const session of settled.slice(SETTLED_SESSION_HISTORY_PER_CHANNEL)) {
      sessions.delete(session.id);
    }
  }

  function handlePrompt(session: LoginSession, abort: AbortController, prompt: any) {
    if (prompt && prompt.type === 'select') {
      // Only openai-codex asks; the confirmed UI always drives the browser
      // flow, so answer it directly instead of surfacing a selector.
      const options = Array.isArray(prompt.options) ? prompt.options : [];
      if (options.some((option: any) => option && option.id === 'browser')) {
        return Promise.resolve('browser');
      }
      return Promise.reject(new SubscriptionLoginError('login_prompt_unsupported', 'The OAuth flow requested an unsupported choice', session.channel));
    }

    if (prompt && prompt.type === 'manual_code') {
      // The web UI has no paste fallback. The prompt must stay pending until
      // the login session aborts and then reject, otherwise a cancelled login
      // deadlocks inside the flow's `await manualPromise` path.
      return new Promise<string>((_resolve, reject) => {
        const rejectCancelled = () => {
          reject(new SubscriptionLoginError('login_cancelled', 'Login cancelled', session.channel));
        };

        if (abort.signal.aborted) {
          rejectCancelled();
          return;
        }
        abort.signal.addEventListener('abort', rejectCancelled, { once: true });

        const promptSignal = prompt.signal;
        if (promptSignal && typeof promptSignal.addEventListener === 'function') {
          if (promptSignal.aborted) {
            rejectCancelled();
            return;
          }
          promptSignal.addEventListener('abort', rejectCancelled, { once: true });
        }
      });
    }

    return Promise.reject(new SubscriptionLoginError('login_prompt_unsupported', 'The OAuth flow requested an unsupported prompt', session.channel));
  }

  function handleNotify(session: LoginSession, event: any) {
    if (!event || typeof event !== 'object') {
      return;
    }

    if (event.type === 'auth_url' && typeof event.url === 'string') {
      session.authUrl = event.url;
      transition(session, 'waiting_browser');
      pushEvent(session, 'auth_url', 'Browser authorization page is ready.');
      return;
    }

    if (event.type === 'progress' && typeof event.message === 'string') {
      if (session.state === 'waiting_browser' || session.state === 'starting') {
        transition(session, 'exchanging');
      }
      pushEvent(session, 'progress', event.message);
      return;
    }

    if (event.type === 'info' && typeof event.message === 'string') {
      pushEvent(session, 'info', event.message);
      return;
    }

    if (event.type === 'device_code') {
      pushEvent(session, 'info', 'The OAuth flow switched to device-code mode.');
    }
  }

  async function registerCodexProviderEntry() {
    const entry = buildCodexProviderEntry(await loadCodexModels());
    const result = await updateModelProviderDocument(agentDir, (document: any) => {
      document.providers = document.providers || {};
      document.providers[CODEX_PROVIDER_ID] = entry;
      return document;
    });
    onModelsCommitted();
    return result;
  }

  async function removeCodexProviderEntry() {
    const current = readModelProviderDocument(agentDir);
    if (!current.providers || !Object.hasOwn(current.providers, CODEX_PROVIDER_ID)) {
      return false;
    }

    await updateModelProviderDocument(agentDir, (document: any) => {
      delete document.providers[CODEX_PROVIDER_ID];
      return document;
    });
    onModelsCommitted();
    return true;
  }

  async function runLogin(session: LoginSession, config: ChannelConfig) {
    const abort = new AbortController();
    session.abort = abort;

    let credential: any;
    try {
      const flow = await loadOAuthFlow(session.channel);
      credential = await flow.login({
        signal: abort.signal,
        prompt: (prompt: any) => handlePrompt(session, abort, prompt),
        notify: (event: any) => handleNotify(session, event),
      });
    } catch (error) {
      const cancelled = looksCancelled(error, abort.signal);
      finalizeSession(
        session,
        cancelled ? 'cancelled' : 'error',
        cancelled ? null : sanitizeErrorMessage(error)
      );
      return;
    }

    if (abort.signal.aborted) {
      finalizeSession(session, 'cancelled', null);
      return;
    }

    try {
      await writeCredential(config.providerId, credential);
      if (session.channel === 'openai-codex') {
        await registerCodexProviderEntry();
        finalizeSession(session, 'success', null, { providerRegistered: true });
        return;
      }
      finalizeSession(session, 'success', null);
    } catch (error) {
      finalizeSession(session, 'error', sanitizeErrorMessage(error));
    }
  }

  function getStatus() {
    return {
      channels: SUBSCRIPTION_LOGIN_CHANNELS.map((channel) => {
        const config = CHANNEL_CONFIGS[channel];
        const credential = readCredential(config.providerId);
        const loggedIn = Boolean(credential) && credential.type === 'oauth';
        return {
          channel,
          loggedIn,
          expiresAt: loggedIn && Number.isFinite(credential.expires) ? credential.expires : null,
          accountId: loggedIn && typeof credential.accountId === 'string' ? credential.accountId : null,
        };
      }),
      logins: [...sessions.values()]
        .filter((session) => ACTIVE_LOGIN_STATES.has(session.state))
        .map(snapshotSession),
    };
  }

  async function startLogin(channel: any) {
    const config = channelConfig(channel);

    for (const session of sessions.values()) {
      if (session.channel === config.channel && ACTIVE_LOGIN_STATES.has(session.state)) {
        throw new SubscriptionLoginError(
          'login_in_progress',
          `A login for "${config.channel}" is already in progress`,
          config.channel
        );
      }
    }

    const callbackHost = resolveCallbackHost(env);
    try {
      await checkPortAvailable(callbackHost, config.callbackPort);
    } catch (error: any) {
      throw new SubscriptionLoginError(
        'callback_port_unavailable',
        `Callback port ${config.callbackPort} is not available on ${callbackHost}; another login may be in progress or another program occupies the port`,
        config.channel
      );
    }

    const session: LoginSession = {
      id: randomUUID(),
      channel: config.channel,
      state: 'starting',
      authUrl: null,
      error: null,
      events: [],
      createdAt: now(),
      updatedAt: now(),
      providerRegistered: false,
      abort: null,
    };
    sessions.set(session.id, session);

    void runLogin(session, config).catch(() => {
      finalizeSession(session, 'error', 'login failed');
    });

    return snapshotSession(session);
  }

  function getSession(id: any) {
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    return session ? snapshotSession(session) : null;
  }

  function cancelSession(id: any) {
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!session) {
      return null;
    }

    if (ACTIVE_LOGIN_STATES.has(session.state)) {
      if (session.abort) {
        session.abort.abort();
      }
      finalizeSession(session, 'cancelled', null);
    }

    return snapshotSession(session);
  }

  async function logout(channel: any) {
    const config = channelConfig(channel);

    for (const session of sessions.values()) {
      if (session.channel === config.channel && ACTIVE_LOGIN_STATES.has(session.state)) {
        throw new SubscriptionLoginError(
          'login_in_progress',
          `Cannot log out of "${config.channel}" while a login is in progress`,
          config.channel
        );
      }
    }

    const credentialRemoved = await removeCredential(config.providerId);
    let modelsUpdated = false;
    if (config.channel === 'openai-codex') {
      modelsUpdated = await removeCodexProviderEntry();
    }

    return {
      channel: config.channel,
      credentialRemoved,
      modelsUpdated,
    };
  }

  function dispose() {
    for (const session of sessions.values()) {
      if (ACTIVE_LOGIN_STATES.has(session.state) && session.abort) {
        session.abort.abort();
        finalizeSession(session, 'cancelled', null);
      }
    }
  }

  return {
    cancelSession,
    dispose,
    getSession,
    getStatus,
    logout,
    startLogin,
  };
}
