// @ts-nocheck
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createHttpError } = require('../../http/http-errors');

const DEFAULT_DRIVER_NAME = 'opensandbox';
const DEFAULT_DRIVER_VERSION = '0.4.0';
const DEFAULT_TEMPLATE = 'base';
const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_REMOTE_ROOT = '/workspace/caff-skill-test';
const DEFAULT_REMOTE_NODE_COMMAND = 'node';
const DEFAULT_OFFICIAL_IMAGE = 'node:20-bookworm';
const DEFAULT_PREBAKED_RUNTIME_DIR = '/opt/caff-skill-test/runtime';
const DEFAULT_PREBAKED_PROJECT_DIR = '/opt/caff-skill-test/project';
const DEFAULT_EVENT_POLL_INTERVAL_MS = 250;
const DEFAULT_FORWARD_ENV_NAMES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'PI_PROVIDER',
  'PI_MODEL',
  'PI_THINKING',
  'PI_ENV',
];
const DEFAULT_FORWARD_ENV_PREFIXES = [
  'OPENAI_',
  'ANTHROPIC_',
  'GOOGLE_',
  'GEMINI_',
  'AZURE_OPENAI_',
  'OPENROUTER_',
  'DEEPSEEK_',
  'MOONSHOT_',
  'KIMI_',
  'DASHSCOPE_',
  'QWEN_',
  'ZHIPU_',
  'XAI_',
  'MISTRAL_',
  'GROQ_',
  'TOGETHER_',
  'SILICONFLOW_',
  'VOLCENGINE_',
  'ARK_',
  'PACKY',
  'PACKYCODE_',
];
const DEFAULT_PI_AUTH_FILE_SEGMENTS = ['.pi', 'agent', 'auth.json'];
const PROVIDER_API_KEY_ENV_MAP = {
  openai: 'OPENAI_API_KEY',
  'azure-openai-responses': 'AZURE_OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  xai: 'XAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'vercel-ai-gateway': 'AI_GATEWAY_API_KEY',
  zai: 'ZAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY',
  huggingface: 'HF_TOKEN',
  opencode: 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
  'kimi-coding': 'KIMI_API_KEY',
};

function clipText(value, maxLength = 240) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function normalizeBoolean(value, fallback = false) {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function normalizeInteger(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function normalizeStringArray(value, fallback = []) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  }
  const normalized = String(value || '').trim();
  if (!normalized) {
    return fallback.slice();
  }
  return normalized.split(/[\n\r,;]+/u).map((entry) => entry.trim()).filter(Boolean);
}

function normalizeRemotePath(value, fallback = '/') {
  const normalized = String(value || '').trim().replace(/\\/g, '/');
  if (!normalized) {
    return fallback;
  }
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function joinRemotePath(...segments) {
  const filtered = segments
    .map((segment) => String(segment || '').trim().replace(/\\/g, '/'))
    .filter(Boolean);
  if (filtered.length === 0) {
    return '/';
  }
  const joined = path.posix.join(...filtered);
  return joined.startsWith('/') ? joined : `/${joined}`;
}

function sanitizeRemoteSegment(value, fallback = 'case') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || fallback;
}

function sanitizeSessionName(value, fallback = 'session') {
  const normalized = String(value || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || fallback;
}

function normalizeEnvObject(input = {}) {
  if (!input || typeof input !== 'object') {
    return {};
  }

  const normalized = {};
  for (const [key, value] of Object.entries(input)) {
    const envName = String(key || '').trim();
    if (!envName || value === undefined || value === null) {
      continue;
    }
    normalized[envName] = String(value);
  }
  return normalized;
}

function mapHostPathToRemote(hostBaseDir, hostTargetPath, remoteBaseDir) {
  const baseDir = path.resolve(String(hostBaseDir || '').trim() || '.');
  const targetPath = path.resolve(String(hostTargetPath || '').trim() || '.');
  const relativePath = path.relative(baseDir, targetPath);
  if (!relativePath || relativePath.startsWith('..')) {
    return '';
  }
  return joinRemotePath(remoteBaseDir, relativePath.replace(/\\/g, '/'));
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'"'"'`)}'`;
}

function looksLikeSessionPath(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return false;
  }
  return path.isAbsolute(normalized) || normalized.includes('/') || normalized.includes('\\') || /\.jsonl$/i.test(normalized);
}

function resolveSessionPaths(sessionValue, layout, outputDir) {
  const normalized = String(sessionValue || '').trim();
  if (!normalized) {
    return {
      sessionToken: `sandbox-session-${sanitizeRemoteSegment(randomUUID(), 'session')}`,
      remoteSessionPath: '',
      localSessionPath: '',
    };
  }

  if (looksLikeSessionPath(normalized)) {
    const baseName = path.basename(normalized).replace(/\.jsonl$/i, '');
    const token = sanitizeSessionName(baseName || 'session');
    return {
      sessionToken: token,
      remoteSessionPath: joinRemotePath(layout.remoteOutputDir, 'sessions', `${token}.jsonl`),
      localSessionPath: path.join(outputDir, 'sessions', `${token}.jsonl`),
    };
  }

  const token = sanitizeSessionName(normalized, 'session');
  return {
    sessionToken: token,
    remoteSessionPath: joinRemotePath(layout.remoteAgentDir, 'named-sessions', `${token}.jsonl`),
    localSessionPath: path.join(outputDir, 'named-sessions', `${token}.jsonl`),
  };
}

function ensureLocalDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resolveLegacyOpenSandboxApiUrl(apiUrl) {
  const baseUrl = normalizeText(apiUrl, '') || normalizeText(process.env.OPENSANDBOX_API_URL, '') || 'https://app.opensandbox.ai';
  const trimmed = baseUrl.replace(/\/+$/u, '');
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

function normalizeOpenSandboxLifecycleBaseUrl(apiUrl) {
  const baseUrl = normalizeText(apiUrl, '') || 'http://127.0.0.1:8080';
  return baseUrl.replace(/\/+$/u, '').replace(/\/(?:api|v1)$/u, '');
}

function buildOpenSandboxHeaders(apiKey, token, includeJson = false) {
  const headers = {};
  if (includeJson) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  } else if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }
  return headers;
}

class CompatibilityOpenSandboxFilesystem {
  constructor(apiUrl, apiKey, sandboxId, token = '') {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.sandboxId = sandboxId;
    this.token = token;
  }

  get headers() {
    return buildOpenSandboxHeaders(this.apiKey, this.token, false);
  }

  async read(remotePath) {
    const response = await fetch(`${this.apiUrl}/sandboxes/${this.sandboxId}/files?path=${encodeURIComponent(remotePath)}`, {
      headers: this.headers,
    });
    if (!response.ok) {
      throw new Error(`Failed to read ${remotePath}: ${response.status}`);
    }
    return response.text();
  }

  async write(remotePath, content) {
    const response = await fetch(`${this.apiUrl}/sandboxes/${this.sandboxId}/files?path=${encodeURIComponent(remotePath)}`, {
      method: 'PUT',
      headers: this.headers,
      body: content,
    });
    if (!response.ok) {
      throw new Error(`Failed to write ${remotePath}: ${response.status}`);
    }
  }

  async makeDir(remotePath) {
    const response = await fetch(`${this.apiUrl}/sandboxes/${this.sandboxId}/files/mkdir?path=${encodeURIComponent(remotePath)}`, {
      method: 'POST',
      headers: this.headers,
    });
    if (!response.ok) {
      throw new Error(`Failed to mkdir ${remotePath}: ${response.status}`);
    }
  }

  async exists(remotePath) {
    try {
      const response = await fetch(`${this.apiUrl}/sandboxes/${this.sandboxId}/files?path=${encodeURIComponent(remotePath)}`, {
        headers: this.headers,
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

class CompatibilityOpenSandboxCommands {
  constructor(apiUrl, apiKey, sandboxId, token = '') {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.sandboxId = sandboxId;
    this.token = token;
  }

  get headers() {
    return buildOpenSandboxHeaders(this.apiKey, this.token, true);
  }

  async run(command, options = {}) {
    const timeout = Number.isFinite(options.timeout) ? options.timeout : 60;
    const body = {
      cmd: String(command || ''),
      timeout,
    };
    if (options.cwd) {
      body.cwd = String(options.cwd);
    }
    if (options.env && typeof options.env === 'object') {
      body.envs = options.env;
    }

    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => controller.abort(), (timeout + 5) * 1000);
    try {
      const response = await fetch(`${this.apiUrl}/sandboxes/${this.sandboxId}/commands`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Command failed: ${response.status} ${text}`);
      }
      return response.json();
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }
}

class CompatibilityOpenSandboxSandbox {
  constructor(data, apiUrl, apiKey) {
    this.sandboxId = normalizeText(data && (data.sandboxID || data.sandboxId));
    this.domain = normalizeText(data && data.domain);
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.connectUrl = normalizeText(data && (data.connectURL || data.connectUrl));
    this.token = normalizeText(data && data.token);
    const operationsUrl = this.connectUrl || apiUrl;
    const operationsApiKey = this.connectUrl ? '' : apiKey;
    const operationsToken = this.connectUrl ? this.token : '';
    this.files = new CompatibilityOpenSandboxFilesystem(operationsUrl, operationsApiKey, this.sandboxId, operationsToken);
    this.commands = new CompatibilityOpenSandboxCommands(operationsUrl, operationsApiKey, this.sandboxId, operationsToken);
  }

  static async create(options = {}) {
    const apiUrl = resolveLegacyOpenSandboxApiUrl(options.apiUrl);
    const apiKey = normalizeText(options.apiKey, '') || normalizeText(process.env.OPENSANDBOX_API_KEY, '');
    const body = {
      templateID: options.template || DEFAULT_TEMPLATE,
      timeout: Number.isFinite(options.timeout) ? options.timeout : DEFAULT_TIMEOUT_SECONDS,
    };
    if (options.envs && typeof options.envs === 'object') {
      body.envs = options.envs;
    }
    if (options.metadata && typeof options.metadata === 'object') {
      body.metadata = options.metadata;
    }
    if (options.cpuCount != null) {
      body.cpuCount = options.cpuCount;
    }
    if (options.memoryMB != null) {
      body.memoryMB = options.memoryMB;
    }

    const response = await fetch(`${apiUrl}/sandboxes`, {
      method: 'POST',
      headers: buildOpenSandboxHeaders(apiKey, '', true),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to create sandbox: ${response.status} ${text}`);
    }
    const data = await response.json();
    return new CompatibilityOpenSandboxSandbox(data, apiUrl, apiKey);
  }

  async kill() {
    const response = await fetch(`${this.apiUrl}/sandboxes/${this.sandboxId}`, {
      method: 'DELETE',
      headers: buildOpenSandboxHeaders(this.apiKey, '', false),
    });
    if (!response.ok) {
      throw new Error(`Failed to kill sandbox: ${response.status}`);
    }
  }
}

function buildOpenSandboxCompatibilityModule() {
  return {
    __caffFlavor: 'compat',
    Sandbox: CompatibilityOpenSandboxSandbox,
  };
}

function resolveOpenSandboxSdkModulePath(candidate) {
  const configuredFile = resolveExistingFilePath([candidate]);
  if (configuredFile) {
    return configuredFile;
  }

  const configuredDir = resolveExistingDirectoryPath([candidate]);
  if (!configuredDir) {
    return '';
  }

  return resolveExistingFilePath([
    path.join(configuredDir, 'dist', 'index.js'),
    path.join(configuredDir, 'src', 'index.js'),
  ]);
}

async function importOpenSandboxModule(specifier) {
  return Function('specifier', 'return import(specifier)')(specifier);
}

async function loadOpenSandboxModule(loader, options = {}) {
  if (typeof loader === 'function') {
    return Promise.resolve(loader());
  }

  const localSdkModulePath = resolveOpenSandboxSdkModulePath(options.sdkModulePath);
  const specifiers = [];
  if (localSdkModulePath) {
    specifiers.push(pathToFileURL(localSdkModulePath).href);
  }
  specifiers.push('@alibaba-group/opensandbox', 'opensandbox');

  for (const specifier of specifiers) {
    try {
      return await importOpenSandboxModule(specifier);
    } catch {}
  }

  return buildOpenSandboxCompatibilityModule();
}

function resolveSandboxClass(moduleValue) {
  if (moduleValue && moduleValue.Sandbox) {
    return moduleValue.Sandbox;
  }
  if (moduleValue && moduleValue.default && moduleValue.default.Sandbox) {
    return moduleValue.default.Sandbox;
  }
  if (moduleValue && moduleValue.default && typeof moduleValue.default.create === 'function') {
    return moduleValue.default;
  }
  return null;
}

function detectOpenSandboxFlavor(moduleValue) {
  if (moduleValue && moduleValue.__caffFlavor) {
    return moduleValue.__caffFlavor;
  }

  const root = moduleValue && moduleValue.default ? moduleValue.default : moduleValue;
  if (root && (root.ConnectionConfig || root.SandboxManager)) {
    return 'official';
  }
  return 'legacy';
}

function resolveSandboxId(sandbox) {
  return normalizeText(sandbox && (sandbox.sandboxId || sandbox.id));
}

function resolveSandboxDomain(sandbox) {
  return normalizeText(sandbox && sandbox.domain);
}

async function ensureRemoteDirectory(sandbox, remoteDir) {
  if (!sandbox || !sandbox.files) {
    return;
  }
  if (typeof sandbox.files.makeDir === 'function') {
    await sandbox.files.makeDir(remoteDir);
    return;
  }
  if (typeof sandbox.files.createDirectories === 'function') {
    await sandbox.files.createDirectories([{ path: remoteDir }]);
  }
}

async function writeRemoteFile(sandbox, remotePath, content) {
  if (!sandbox || !sandbox.files) {
    throw new Error('OpenSandbox filesystem is unavailable');
  }
  if (typeof sandbox.files.write === 'function') {
    await sandbox.files.write(remotePath, content);
    return;
  }
  if (typeof sandbox.files.writeFiles === 'function') {
    await sandbox.files.writeFiles([{ path: remotePath, data: content }]);
    return;
  }
  throw new Error('OpenSandbox filesystem.write is unavailable');
}

async function remoteFileExists(sandbox, remotePath) {
  if (!remotePath || !sandbox || !sandbox.files) {
    return false;
  }

  try {
    if (sandbox.files.exists && typeof sandbox.files.exists === 'function') {
      return !!(await sandbox.files.exists(remotePath));
    }
    if (sandbox.files.getFileInfo && typeof sandbox.files.getFileInfo === 'function') {
      const info = await sandbox.files.getFileInfo([remotePath]);
      return !!(info && info[remotePath]);
    }
  } catch {
    return false;
  }

  return true;
}

async function readRemoteFileIfPresent(sandbox, remotePath) {
  if (!remotePath || !sandbox || !sandbox.files) {
    return '';
  }

  try {
    const exists = await remoteFileExists(sandbox, remotePath);
    if (!exists) {
      return '';
    }
    if (typeof sandbox.files.read === 'function') {
      return await sandbox.files.read(remotePath);
    }
    if (typeof sandbox.files.readFile === 'function') {
      return await sandbox.files.readFile(remotePath);
    }
  } catch {
    return '';
  }

  return '';
}

function flattenExecutionText(entries) {
  if (!Array.isArray(entries)) {
    return '';
  }
  return entries
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry;
      }
      if (entry && typeof entry.text === 'string') {
        return entry.text;
      }
      return '';
    })
    .join('');
}

function extractCommandText(commandResult, streamName) {
  if (!commandResult || !streamName) {
    return '';
  }

  if (typeof commandResult[streamName] === 'string') {
    return commandResult[streamName];
  }

  const logsText = flattenExecutionText(commandResult.logs && commandResult.logs[streamName]);
  if (logsText) {
    return logsText;
  }

  if (streamName === 'stderr' && commandResult.error && typeof commandResult.error.value === 'string') {
    return commandResult.error.value;
  }

  return '';
}

function extractCommandExitCode(commandResult) {
  if (commandResult && Number.isInteger(commandResult.exitCode)) {
    return commandResult.exitCode;
  }
  return null;
}

function buildOfficialSandboxResourceLimits(options = {}) {
  const resource = {};
  if (options.cpuCount) {
    resource.cpu = String(options.cpuCount);
  }
  if (options.memoryMB) {
    resource.memory = `${options.memoryMB}Mi`;
  }
  return resource;
}

async function createSandboxInstance(Sandbox, moduleValue, metadata, options = {}) {
  const flavor = detectOpenSandboxFlavor(moduleValue);
  const sandboxEnv = {
    CAFF_SKILL_TEST_RUN_ID: metadata.runId,
    CAFF_SKILL_TEST_CASE_ID: metadata.caseId,
  };

  if (flavor === 'official') {
    const resource = buildOfficialSandboxResourceLimits(options);
    const sandbox = await Sandbox.create({
      connectionConfig: {
        domain: normalizeOpenSandboxLifecycleBaseUrl(options.apiUrl),
        apiKey: options.apiKey || undefined,
        useServerProxy: options.useServerProxy,
      },
      image: options.image || DEFAULT_OFFICIAL_IMAGE,
      timeoutSeconds: options.timeoutSeconds,
      metadata,
      env: sandboxEnv,
      ...(Object.keys(resource).length > 0 ? { resource } : {}),
    });
    return {
      flavor,
      sandbox,
    };
  }

  const sandbox = await Sandbox.create({
    template: options.template,
    timeout: options.timeoutSeconds,
    apiUrl: options.apiUrl || undefined,
    apiKey: options.apiKey || undefined,
    metadata,
    envs: sandboxEnv,
    ...(options.cpuCount ? { cpuCount: options.cpuCount } : {}),
    ...(options.memoryMB ? { memoryMB: options.memoryMB } : {}),
  });
  return {
    flavor,
    sandbox,
  };
}

function describeOpenSandboxError(error, maxLength = 120) {
  return clipText(collectOpenSandboxErrorText(error) || String(error || 'unknown error'), maxLength);
}

function collectOpenSandboxErrorText(error, maxDepth = 4) {
  if (!error) {
    return '';
  }

  const seen = new Set();
  const fragments = [];

  function pushFragment(value) {
    const normalized = String(value || '').trim();
    if (!normalized) {
      return;
    }
    if (!fragments.includes(normalized)) {
      fragments.push(normalized);
    }
  }

  function visit(value, depth) {
    if (value === undefined || value === null || depth > maxDepth) {
      return;
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      pushFragment(value);
      return;
    }

    if (typeof value !== 'object') {
      return;
    }

    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    if (value instanceof Error) {
      pushFragment(value.message);
    }

    if (Array.isArray(value)) {
      value.slice(0, 8).forEach((entry) => visit(entry, depth + 1));
      return;
    }

    const priorityKeys = ['message', 'detail', 'rawBody', 'error', 'cause', 'response', 'body'];
    for (const key of priorityKeys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        visit(value[key], depth + 1);
      }
    }

    for (const [key, entry] of Object.entries(value)) {
      if (priorityKeys.includes(key)) {
        continue;
      }
      if (key === 'code' || key === 'status' || key === 'statusCode' || key === 'name') {
        pushFragment(entry);
        continue;
      }
      if (key === 'requestId') {
        continue;
      }
      if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
        pushFragment(entry);
      }
    }
  }

  visit(error, 0);
  return fragments.join('\n');
}

function isOpenSandboxNotFoundError(error) {
  if (!error) {
    return false;
  }

  const status = Number(error.status || error.statusCode || (error.response && error.response.status));
  if (status === 404) {
    return true;
  }

  const code = normalizeText(error.code).toLowerCase();
  if (code === 'not_found' || code === 'notfound') {
    return true;
  }

  const message = describeOpenSandboxError(error, 500).toLowerCase();
  return /\b404\b/u.test(message) || (message.includes('not found') && message.includes('sandbox'));
}

function isOpenSandboxAlreadyDeletingError(error) {
  if (!error) {
    return false;
  }

  const message = collectOpenSandboxErrorText(error).toLowerCase();
  return /removal of container[\s\S]*already(?:\s+in\s+progress)?/u.test(message)
    || /removal of container[\s\S]*is\s+alr(?:eady)?/u.test(message);
}

async function createSandboxInstanceFromModule(moduleValue, metadata, options = {}) {
  const Sandbox = resolveSandboxClass(moduleValue);
  if (!Sandbox || typeof Sandbox.create !== 'function') {
    throw new Error('OpenSandbox SDK does not export Sandbox.create');
  }
  return createSandboxInstance(Sandbox, moduleValue, metadata, options);
}

async function createSandboxInstanceWithFallback(moduleValue, metadata, options = {}) {
  const primaryFlavor = detectOpenSandboxFlavor(moduleValue);

  try {
    return await createSandboxInstanceFromModule(moduleValue, metadata, options);
  } catch (primaryError) {
    if (primaryFlavor === 'compat') {
      throw primaryError;
    }

    const compatibilityModule = buildOpenSandboxCompatibilityModule();
    try {
      return await createSandboxInstanceFromModule(compatibilityModule, metadata, options);
    } catch (fallbackError) {
      const combinedError = new Error(
        `Primary ${primaryFlavor} create failed: ${describeOpenSandboxError(primaryError)}; compatibility fallback failed: ${describeOpenSandboxError(fallbackError)}`
      );
      combinedError.primaryError = primaryError;
      combinedError.fallbackError = fallbackError;
      throw combinedError;
    }
  }
}

async function cleanupSandbox(sandbox) {
  if (!sandbox) {
    return;
  }

  let cleanupError = null;
  try {
    if (typeof sandbox.kill === 'function') {
      await Promise.resolve(sandbox.kill());
    }
  } catch (error) {
    if (!isOpenSandboxNotFoundError(error) && !isOpenSandboxAlreadyDeletingError(error)) {
      cleanupError = error;
    }
  } finally {
    try {
      if (typeof sandbox.close === 'function') {
        await Promise.resolve(sandbox.close());
      }
    } catch (error) {
      if (!cleanupError && !isOpenSandboxNotFoundError(error) && !isOpenSandboxAlreadyDeletingError(error)) {
        cleanupError = error;
      }
    }
  }

  if (cleanupError) {
    throw cleanupError;
  }
}

async function uploadTreeToSandbox(sandbox, localRootDir, remoteRootDir, options = {}) {
  const sourceRoot = path.resolve(String(localRootDir || '').trim() || '.');
  if (!fs.existsSync(sourceRoot)) {
    return [];
  }

  const filter = typeof options.filter === 'function' ? options.filter : null;
  const uploadedFiles = [];
  const stack = [''];
  await ensureRemoteDirectory(sandbox, remoteRootDir);

  while (stack.length > 0) {
    const relativePath = stack.pop() || '';
    const absolutePath = path.join(sourceRoot, relativePath);
    const stat = fs.statSync(absolutePath);

    if (relativePath && filter && filter(relativePath, absolutePath, stat) === false) {
      continue;
    }

    const remotePath = relativePath ? joinRemotePath(remoteRootDir, relativePath.replace(/\\/g, '/')) : remoteRootDir;

    if (stat.isDirectory()) {
      await ensureRemoteDirectory(sandbox, remotePath);
      for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
        const nextRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
        stack.push(nextRelativePath);
      }
      continue;
    }

    await writeRemoteFile(sandbox, remotePath, fs.readFileSync(absolutePath));
    uploadedFiles.push(remotePath);
  }

  uploadedFiles.sort((left, right) => left.localeCompare(right));
  return uploadedFiles;
}

async function prepareSandboxProjectDir(sandbox, factoryInput, layout, options = {}) {
  if (!layout.usesPrebakedProjectSource) {
    return {
      files: await uploadTreeToSandbox(sandbox, factoryInput.projectDir, layout.remoteProjectDir),
      source: 'upload',
      templateDir: '',
      copyCommand: '',
    };
  }

  if (!sandbox || !sandbox.commands || typeof sandbox.commands.run !== 'function') {
    throw new Error('OpenSandbox pre-baked CAFF source requires commands.run to copy the case project template');
  }

  const packageJsonPath = joinRemotePath(layout.remoteProjectTemplateDir, 'package.json');
  if (!(await remoteFileExists(sandbox, packageJsonPath))) {
    throw new Error(`OpenSandbox pre-baked CAFF source is missing package.json in ${layout.remoteProjectTemplateDir}`);
  }

  const remoteProjectParentDir = path.posix.dirname(layout.remoteProjectDir);
  const remoteProjectTemplateContents = `${layout.remoteProjectTemplateDir.replace(/\/+$/u, '')}/.`;
  const copyCommand = [
    `rm -rf ${shellQuote(layout.remoteProjectDir)}`,
    `mkdir -p ${shellQuote(remoteProjectParentDir)}`,
    `cp -a ${shellQuote(remoteProjectTemplateContents)} ${shellQuote(layout.remoteProjectDir)}`,
  ].join(' && ');
  const copyResult = await sandbox.commands.run(copyCommand, {
    timeout: options.timeoutSeconds,
    cwd: '/',
  });
  const exitCode = extractCommandExitCode(copyResult);
  if (exitCode !== null && exitCode !== 0) {
    throw new Error(`OpenSandbox pre-baked CAFF source copy failed with exit code ${exitCode}: ${clipText(extractCommandText(copyResult, 'stderr'), 240)}`);
  }

  return {
    files: await uploadTreeToSandbox(sandbox, factoryInput.projectDir, layout.remoteProjectDir),
    source: 'prebaked',
    templateDir: layout.remoteProjectTemplateDir,
    copyCommand,
  };
}

function buildRemoteLayout(input = {}, options = {}) {
  const remoteRootBase = normalizeRemotePath(options.remoteRoot || DEFAULT_REMOTE_ROOT, DEFAULT_REMOTE_ROOT);
  const remoteRoot = joinRemotePath(
    remoteRootBase,
    sanitizeRemoteSegment(input.runId || 'run', 'run'),
    sanitizeRemoteSegment(input.caseId || 'case', 'case')
  );
  const remoteAgentDir = joinRemotePath(remoteRoot, 'agent');
  const remoteProjectDir = joinRemotePath(remoteRoot, 'project');
  const configuredProjectTemplateDir = normalizeRemotePath(options.prebakedProjectDir || '', '');
  const remoteOutputDir = joinRemotePath(remoteRoot, 'outputs');
  const remoteStoreDir = joinRemotePath(remoteRoot, 'store');
  const remoteRuntimeDir = joinRemotePath(remoteRoot, 'runtime');
  const configuredRuntimeAssetDir = normalizeRemotePath(options.prebakedRuntimeDir || '', '');
  const remoteRuntimeAssetDir = configuredRuntimeAssetDir || remoteRuntimeDir;
  const remoteRunnerInputDir = joinRemotePath(remoteRuntimeDir, 'inputs');
  const remoteRunnerResultDir = joinRemotePath(remoteRuntimeDir, 'results');
  const remoteRunnerEventDir = joinRemotePath(remoteRuntimeDir, 'events');
  const remoteRunnerControlDir = joinRemotePath(remoteRuntimeDir, 'controls');
  const remoteRunnerPath = joinRemotePath(remoteRuntimeAssetDir, 'open-sandbox-runner.js');
  const remoteAgentChatToolsPath = joinRemotePath(remoteRuntimeAssetDir, 'agent-chat-tools.js');
  const remotePiPackageDir = joinRemotePath(remoteRuntimeAssetDir, 'pi-coding-agent');
  const remotePiCliPath = joinRemotePath(remotePiPackageDir, 'dist', 'cli.js');
  const sqliteFileName = path.basename(String(input.sqlitePath || 'chat.sqlite').trim() || 'chat.sqlite');
  const remoteSqlitePath = joinRemotePath(remoteStoreDir, sqliteFileName);
  const remoteSandboxDir = mapHostPathToRemote(input.agentDir, input.sandboxDir, remoteAgentDir);
  const remotePrivateDir = mapHostPathToRemote(input.agentDir, input.privateDir, remoteAgentDir);
  const remoteSkillPath = mapHostPathToRemote(input.agentDir, input.skillPath, remoteAgentDir);

  return {
    remoteRoot,
    remoteAgentDir,
    remoteProjectDir,
    remoteProjectTemplateDir: configuredProjectTemplateDir,
    remoteOutputDir,
    remoteStoreDir,
    remoteRuntimeDir,
    remoteRuntimeAssetDir,
    remoteRunnerInputDir,
    remoteRunnerResultDir,
    remoteRunnerEventDir,
    remoteRunnerControlDir,
    remoteRunnerPath,
    remoteAgentChatToolsPath,
    remotePiPackageDir,
    remotePiCliPath,
    remoteSqlitePath,
    remoteSandboxDir,
    remotePrivateDir,
    remoteSkillPath,
    usesPrebakedRuntimeAssets: !!configuredRuntimeAssetDir,
    usesPrebakedProjectSource: !!configuredProjectTemplateDir,
  };
}

function normalizeOpenSandboxFactoryOptions(input = {}) {
  return {
    enabled: normalizeBoolean(input.enabled !== undefined ? input.enabled : process.env.CAFF_SKILL_TEST_OPENSANDBOX_ENABLED, false),
    apiUrl: normalizeText(input.apiUrl !== undefined ? input.apiUrl : process.env.CAFF_SKILL_TEST_OPENSANDBOX_API_URL || process.env.OPENSANDBOX_API_URL),
    apiKey: normalizeText(input.apiKey !== undefined ? input.apiKey : process.env.CAFF_SKILL_TEST_OPENSANDBOX_API_KEY || process.env.OPENSANDBOX_API_KEY),
    template: normalizeText(input.template !== undefined ? input.template : process.env.CAFF_SKILL_TEST_OPENSANDBOX_TEMPLATE, DEFAULT_TEMPLATE),
    timeoutSeconds: normalizeInteger(input.timeoutSeconds !== undefined ? input.timeoutSeconds : process.env.CAFF_SKILL_TEST_OPENSANDBOX_TIMEOUT_SEC, DEFAULT_TIMEOUT_SECONDS),
    cpuCount: normalizeInteger(input.cpuCount !== undefined ? input.cpuCount : process.env.CAFF_SKILL_TEST_OPENSANDBOX_CPU_COUNT, 0) || undefined,
    memoryMB: normalizeInteger(input.memoryMB !== undefined ? input.memoryMB : process.env.CAFF_SKILL_TEST_OPENSANDBOX_MEMORY_MB, 0) || undefined,
    remoteRoot: normalizeRemotePath(input.remoteRoot !== undefined ? input.remoteRoot : process.env.CAFF_SKILL_TEST_OPENSANDBOX_REMOTE_ROOT, DEFAULT_REMOTE_ROOT),
    driverVersion: normalizeText(input.driverVersion, DEFAULT_DRIVER_VERSION),
    chatApiUrl: normalizeText(input.chatApiUrl !== undefined ? input.chatApiUrl : process.env.CAFF_SKILL_TEST_OPENSANDBOX_CHAT_API_URL),
    sdkModulePath: normalizeText(input.sdkModulePath !== undefined ? input.sdkModulePath : process.env.CAFF_SKILL_TEST_OPENSANDBOX_SDK_PATH),
    image: normalizeText(input.image !== undefined ? input.image : process.env.CAFF_SKILL_TEST_OPENSANDBOX_IMAGE, DEFAULT_OFFICIAL_IMAGE),
    prebakedRuntimeDir: normalizeRemotePath(
      input.prebakedRuntimeDir !== undefined ? input.prebakedRuntimeDir : process.env.CAFF_SKILL_TEST_OPENSANDBOX_PREBAKED_RUNTIME_DIR,
      ''
    ),
    prebakedProjectDir: normalizeRemotePath(
      input.prebakedProjectDir !== undefined ? input.prebakedProjectDir : process.env.CAFF_SKILL_TEST_OPENSANDBOX_PREBAKED_PROJECT_DIR,
      ''
    ),
    useServerProxy: normalizeBoolean(input.useServerProxy !== undefined ? input.useServerProxy : process.env.CAFF_SKILL_TEST_OPENSANDBOX_USE_SERVER_PROXY, true),
    piPackageDir: normalizeText(input.piPackageDir !== undefined ? input.piPackageDir : process.env.CAFF_SKILL_TEST_OPENSANDBOX_PI_PACKAGE_DIR),
    piCommandPath: normalizeText(input.piCommandPath !== undefined ? input.piCommandPath : process.env.CAFF_SKILL_TEST_OPENSANDBOX_PI_COMMAND_PATH || process.env.PI_COMMAND_PATH),
    runnerPath: normalizeText(input.runnerPath !== undefined ? input.runnerPath : process.env.CAFF_SKILL_TEST_OPENSANDBOX_RUNNER_PATH),
    chatToolsPath: normalizeText(input.chatToolsPath !== undefined ? input.chatToolsPath : process.env.CAFF_SKILL_TEST_OPENSANDBOX_CHAT_TOOLS_PATH),
    nodeCommand: normalizeText(input.nodeCommand !== undefined ? input.nodeCommand : process.env.CAFF_SKILL_TEST_OPENSANDBOX_NODE_COMMAND, DEFAULT_REMOTE_NODE_COMMAND),
    eventPollIntervalMs: normalizeInteger(input.eventPollIntervalMs !== undefined ? input.eventPollIntervalMs : process.env.CAFF_SKILL_TEST_OPENSANDBOX_EVENT_POLL_MS, DEFAULT_EVENT_POLL_INTERVAL_MS),
    forwardEnvNames: normalizeStringArray(input.forwardEnvNames !== undefined ? input.forwardEnvNames : process.env.CAFF_SKILL_TEST_OPENSANDBOX_FORWARD_ENV_NAMES, DEFAULT_FORWARD_ENV_NAMES),
    forwardEnvPrefixes: normalizeStringArray(input.forwardEnvPrefixes !== undefined ? input.forwardEnvPrefixes : process.env.CAFF_SKILL_TEST_OPENSANDBOX_FORWARD_ENV_PREFIXES, DEFAULT_FORWARD_ENV_PREFIXES),
    piAuthFilePath: normalizeText(input.piAuthFilePath),
    loadModule: typeof input.loadModule === 'function' ? input.loadModule : null,
  };
}

function resolveExistingFilePath(candidates) {
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const normalized = String(candidate || '').trim();
    if (!normalized) {
      continue;
    }
    const resolved = path.resolve(normalized);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
  }
  return '';
}

function resolveExistingDirectoryPath(candidates) {
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const normalized = String(candidate || '').trim();
    if (!normalized) {
      continue;
    }
    const resolved = path.resolve(normalized);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return resolved;
    }
  }
  return '';
}

function resolvePiAuthFilePath(configuredPath = '') {
  const explicitPath = resolveExistingFilePath([configuredPath]);
  if (explicitPath) {
    return explicitPath;
  }

  try {
    const homeDir = typeof os.homedir === 'function' ? os.homedir() : '';
    if (!homeDir) {
      return '';
    }
    return resolveExistingFilePath([path.join(homeDir, ...DEFAULT_PI_AUTH_FILE_SEGMENTS)]);
  } catch {
    return '';
  }
}

function readPiAuthEntry(provider, options = {}) {
  const providerId = String(provider || '').trim();
  if (!providerId) {
    return null;
  }

  const authFilePath = resolvePiAuthFilePath(options.piAuthFilePath);
  if (!authFilePath) {
    return null;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(authFilePath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return null;
    }
    const entry = raw[providerId];
    return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
  } catch {
    return null;
  }
}

function resolveApiKeyFromAuthEntry(entry, envSource = {}) {
  if (!entry || typeof entry !== 'object') {
    return '';
  }

  if (String(entry.type || '').trim() !== 'api_key') {
    return '';
  }

  const keyValue = String(entry.key || '').trim();
  if (!keyValue || keyValue.startsWith('!')) {
    return '';
  }

  if (/^[A-Z0-9_]+$/u.test(keyValue)) {
    return normalizeText(envSource[keyValue]);
  }

  return keyValue;
}

function resolveProviderAuthEnv(provider, envSource = {}, options = {}) {
  const providerId = String(provider || '').trim();
  if (!providerId) {
    return {};
  }

  const envName = PROVIDER_API_KEY_ENV_MAP[providerId];
  if (!envName) {
    return {};
  }

  const existingValue = normalizeText(envSource[envName]);
  if (existingValue) {
    return { [envName]: existingValue };
  }

  const authEntry = readPiAuthEntry(providerId, options);
  const authValue = resolveApiKeyFromAuthEntry(authEntry, envSource);
  if (!authValue) {
    return {};
  }

  return { [envName]: authValue };
}

function resolveLocalRunnerPath(options = {}) {
  return resolveExistingFilePath([
    options.runnerPath,
    path.join(__dirname, 'open-sandbox-runner.js'),
    path.resolve(process.cwd(), 'server', 'domain', 'skill-test', 'open-sandbox-runner.js'),
    path.resolve(process.cwd(), 'build', 'server', 'domain', 'skill-test', 'open-sandbox-runner.js'),
  ]);
}

function resolveLocalChatToolsPath(options = {}) {
  return resolveExistingFilePath([
    options.chatToolsPath,
    path.resolve(__dirname, '..', '..', '..', 'lib', 'agent-chat-tools.js'),
    path.resolve(process.cwd(), 'build', 'lib', 'agent-chat-tools.js'),
  ]);
}

function isValidPiPackageDir(candidate) {
  const resolved = resolveExistingDirectoryPath([candidate]);
  if (!resolved) {
    return '';
  }
  const cliPath = path.join(resolved, 'dist', 'cli.js');
  return fs.existsSync(cliPath) ? resolved : '';
}

function derivePiPackageDirFromCommandPath(commandPath) {
  const resolvedCommandPath = resolveExistingFilePath([commandPath]);
  if (!resolvedCommandPath) {
    return '';
  }
  const packageDir = path.join(path.dirname(resolvedCommandPath), 'node_modules', '@mariozechner', 'pi-coding-agent');
  return isValidPiPackageDir(packageDir);
}

function findCommandOnPath(commandName) {
  const executable = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const result = spawnSync(executable, [commandName], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout) {
      return '';
    }
    const candidates = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return resolveExistingFilePath(candidates);
  } catch {
    return '';
  }
}

function resolveLocalPiPackageDir(options = {}) {
  const configuredDir = isValidPiPackageDir(options.piPackageDir);
  if (configuredDir) {
    return configuredDir;
  }

  const configuredFromCommand = derivePiPackageDirFromCommandPath(options.piCommandPath);
  if (configuredFromCommand) {
    return configuredFromCommand;
  }

  const discoveredCommand = findCommandOnPath('pi');
  if (discoveredCommand) {
    return derivePiPackageDirFromCommandPath(discoveredCommand);
  }

  return '';
}

function pickForwardedProcessEnv(envSource = {}, options = {}) {
  const result = {};
  const allowedNames = new Set((Array.isArray(options.forwardEnvNames) ? options.forwardEnvNames : []).map((entry) => String(entry || '').trim()).filter(Boolean));
  const allowedPrefixes = (Array.isArray(options.forwardEnvPrefixes) ? options.forwardEnvPrefixes : []).map((entry) => String(entry || '').trim()).filter(Boolean);

  for (const [key, value] of Object.entries(envSource || {})) {
    const envName = String(key || '').trim();
    if (!envName || value === undefined || value === null) {
      continue;
    }
    if (allowedNames.has(envName) || allowedPrefixes.some((prefix) => envName.startsWith(prefix))) {
      result[envName] = String(value);
    }
  }

  return result;
}

function formatRelativeToolPath(fromDir, targetPath) {
  if (!fromDir || !targetPath) {
    return '';
  }

  const relative = path.posix.relative(fromDir, targetPath).replace(/\\/g, '/');
  if (!relative) {
    return './agent-chat-tools.js';
  }
  if (relative.startsWith('.')) {
    return relative;
  }
  return `./${relative}`;
}

function createPiPackageFilter(relativePath, _absolutePath, stat) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').toLowerCase();
  if (!normalized) {
    return true;
  }

  const firstSegment = normalized.split('/')[0];
  if (stat.isDirectory() && (firstSegment === 'docs' || firstSegment === 'examples' || firstSegment === 'test' || firstSegment === 'tests')) {
    return false;
  }
  if (!stat.isDirectory() && (normalized.endsWith('.map') || normalized.startsWith('docs/') || normalized.startsWith('examples/'))) {
    return false;
  }
  return true;
}

function buildSandboxExecutionSupport(sandbox, options = {}) {
  if (!sandbox || !sandbox.commands || typeof sandbox.commands.run !== 'function') {
    return {
      startRunAvailable: false,
      blockReason: 'OpenSandbox commands.run is unavailable',
      runnerPath: '',
      chatToolsPath: '',
      piPackageDir: '',
      runtimeAssetSource: 'unavailable',
      prebakedRuntimeDir: '',
    };
  }

  const prebakedRuntimeDir = normalizeRemotePath(options.prebakedRuntimeDir, '');
  if (prebakedRuntimeDir) {
    return {
      startRunAvailable: true,
      blockReason: '',
      runnerPath: '',
      chatToolsPath: '',
      piPackageDir: '',
      runtimeAssetSource: 'prebaked',
      prebakedRuntimeDir,
    };
  }

  const runnerPath = resolveLocalRunnerPath(options);
  if (!runnerPath) {
    return {
      startRunAvailable: false,
      blockReason: 'Sandbox-side runner asset is unavailable',
      runnerPath: '',
      chatToolsPath: '',
      piPackageDir: '',
      runtimeAssetSource: 'upload',
      prebakedRuntimeDir: '',
    };
  }

  const chatToolsPath = resolveLocalChatToolsPath(options);
  if (!chatToolsPath) {
    return {
      startRunAvailable: false,
      blockReason: 'Agent chat tools asset is unavailable',
      runnerPath,
      chatToolsPath: '',
      piPackageDir: '',
      runtimeAssetSource: 'upload',
      prebakedRuntimeDir: '',
    };
  }

  const piPackageDir = resolveLocalPiPackageDir(options);
  if (!piPackageDir) {
    return {
      startRunAvailable: false,
      blockReason: 'pi package directory is unavailable for sandbox upload',
      runnerPath,
      chatToolsPath,
      piPackageDir: '',
      runtimeAssetSource: 'upload',
      prebakedRuntimeDir: '',
    };
  }

  return {
    startRunAvailable: true,
    blockReason: '',
    runnerPath,
    chatToolsPath,
    piPackageDir,
    runtimeAssetSource: 'upload',
    prebakedRuntimeDir: '',
  };
}

function buildSandboxRunEnv(startOptions = {}, layout, options = {}, factoryInput = {}, provider = '') {
  const forwarded = pickForwardedProcessEnv(process.env, options);
  const providerAuthEnv = resolveProviderAuthEnv(provider, process.env, options);
  const provided = normalizeEnvObject(startOptions.extraEnv);
  const remoteSkillMarkdownPath = layout.remoteSkillPath ? joinRemotePath(layout.remoteSkillPath, 'SKILL.md') : '';
  const relativeChatToolsPath = formatRelativeToolPath(layout.remoteProjectDir, layout.remoteAgentChatToolsPath);

  return {
    ...forwarded,
    ...providerAuthEnv,
    ...provided,
    PI_CODING_AGENT_DIR: layout.remoteAgentDir,
    PI_AGENT_SANDBOX_DIR: layout.remoteSandboxDir || joinRemotePath(layout.remoteAgentDir, 'agent-sandboxes', 'agent'),
    PI_AGENT_PRIVATE_DIR: layout.remotePrivateDir || joinRemotePath(layout.remoteAgentDir, 'agent-sandboxes', 'agent', 'private'),
    PI_SQLITE_PATH: layout.remoteSqlitePath,
    CAFF_TRELLIS_PROJECT_DIR: layout.remoteProjectDir,
    CAFF_SKILL_TEST_CASE_ROOT: layout.remoteRoot,
    CAFF_SKILL_TEST_OUTPUT_DIR: layout.remoteOutputDir,
    CAFF_CHAT_TOOLS_PATH: layout.remoteAgentChatToolsPath,
    CAFF_CHAT_TOOLS_RELATIVE_PATH: relativeChatToolsPath,
    CAFF_SKILL_TEST_RUN_ID: normalizeText(factoryInput.runId),
    CAFF_SKILL_TEST_CASE_ID: normalizeText(factoryInput.caseId),
    ...(remoteSkillMarkdownPath ? { CAFF_SKILL_TEST_SKILL_PATH: remoteSkillMarkdownPath } : {}),
    ...(options.chatApiUrl ? { CAFF_CHAT_API_URL: options.chatApiUrl } : {}),
  };
}

async function uploadSandboxRuntimeAssets(sandbox, layout, support) {
  await ensureRemoteDirectory(sandbox, layout.remoteRuntimeDir);
  await ensureRemoteDirectory(sandbox, layout.remoteRunnerInputDir);
  await ensureRemoteDirectory(sandbox, layout.remoteRunnerResultDir);
  await ensureRemoteDirectory(sandbox, layout.remoteRunnerEventDir);
  await ensureRemoteDirectory(sandbox, layout.remoteRunnerControlDir);

  if (support.runtimeAssetSource === 'prebaked') {
    const requiredAssets = [
      { name: 'open-sandbox-runner.js', remotePath: layout.remoteRunnerPath },
      { name: 'agent-chat-tools.js', remotePath: layout.remoteAgentChatToolsPath },
      { name: 'pi-coding-agent/dist/cli.js', remotePath: layout.remotePiCliPath },
    ];
    const missingAssets = [];

    for (const asset of requiredAssets) {
      if (!(await remoteFileExists(sandbox, asset.remotePath))) {
        missingAssets.push(asset.name);
      }
    }

    if (missingAssets.length > 0) {
      throw new Error(
        `OpenSandbox pre-baked runtime is missing required assets in ${layout.remoteRuntimeAssetDir}: ${missingAssets.join(', ')}`
      );
    }

    return {
      runnerUploaded: false,
      chatToolsUploaded: false,
      piFileCount: 0,
      source: 'prebaked',
      runtimeAssetDir: layout.remoteRuntimeAssetDir,
    };
  }

  await writeRemoteFile(sandbox, layout.remoteRunnerPath, fs.readFileSync(support.runnerPath));
  await writeRemoteFile(sandbox, layout.remoteAgentChatToolsPath, fs.readFileSync(support.chatToolsPath));
  const piFiles = await uploadTreeToSandbox(sandbox, support.piPackageDir, layout.remotePiPackageDir, {
    filter: createPiPackageFilter,
  });

  return {
    runnerUploaded: true,
    chatToolsUploaded: true,
    piFileCount: piFiles.length,
    source: 'upload',
    runtimeAssetDir: layout.remoteRuntimeAssetDir,
  };
}

function waitForDuration(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}

function emitSandboxRunnerLogEvent(emitter, eventRecord) {
  if (!emitter || !eventRecord || typeof eventRecord !== 'object') {
    return;
  }

  const type = normalizeText(eventRecord.type || eventRecord.event);
  if (!type) {
    return;
  }

  const payload = eventRecord.payload && typeof eventRecord.payload === 'object'
    ? eventRecord.payload
    : eventRecord.data && typeof eventRecord.data === 'object'
      ? eventRecord.data
      : {};

  if (type === 'pi_event') {
    const piEvent = payload.piEvent || eventRecord.piEvent || null;
    if (!piEvent) {
      return;
    }
    emitter.emit('pi_event', { piEvent });
    return;
  }

  emitter.emit(type, payload);
}

function createSandboxRunnerEventPoller(sandbox, remoteEventPath, emitter, options = {}) {
  let stopped = false;
  let processedLength = 0;
  let bufferedRemainder = '';
  const intervalMs = normalizeInteger(options.eventPollIntervalMs, DEFAULT_EVENT_POLL_INTERVAL_MS);

  async function flush(finalPass = false) {
    const content = await readRemoteFileIfPresent(sandbox, remoteEventPath);
    if (!content) {
      if (finalPass && bufferedRemainder.trim()) {
        try {
          emitSandboxRunnerLogEvent(emitter, JSON.parse(bufferedRemainder));
        } catch {}
        bufferedRemainder = '';
      }
      return;
    }

    if (content.length < processedLength) {
      processedLength = 0;
      bufferedRemainder = '';
    }

    const chunk = content.slice(processedLength);
    processedLength = content.length;

    if (!chunk && !finalPass) {
      return;
    }

    let text = `${bufferedRemainder}${chunk}`;
    const hasTrailingNewline = /\r?\n$/u.test(text);
    const lines = text.split(/\r?\n/u);
    bufferedRemainder = hasTrailingNewline ? '' : lines.pop() || '';

    for (const line of lines) {
      const trimmed = String(line || '').trim();
      if (!trimmed) {
        continue;
      }
      try {
        emitSandboxRunnerLogEvent(emitter, JSON.parse(trimmed));
      } catch {}
    }

    if (finalPass && bufferedRemainder.trim()) {
      try {
        emitSandboxRunnerLogEvent(emitter, JSON.parse(bufferedRemainder));
      } catch {}
      bufferedRemainder = '';
    }
  }

  const finished = (async () => {
    while (!stopped) {
      await flush(false);
      if (stopped) {
        break;
      }
      await waitForDuration(intervalMs);
    }
    await flush(true);
  })().catch(() => {});

  return {
    stop() {
      stopped = true;
    },
    finished,
  };
}

function createSandboxStartRun(adapterInput = {}) {
  const {
    sandbox,
    layout,
    factoryInput,
    options,
    support,
  } = adapterInput;

  let runtimeAssetsPromise = null;

  async function ensureRuntimeAssets() {
    if (!runtimeAssetsPromise) {
      runtimeAssetsPromise = uploadSandboxRuntimeAssets(sandbox, layout, support);
    }
    return runtimeAssetsPromise;
  }

  return function startRun(provider, model, prompt, startOptions = {}) {
    const emitter = new EventEmitter();
    const outputDir = path.resolve(String(factoryInput.outputDir || path.join(process.cwd(), '.tmp', 'caff-open-sandbox')).trim());
    const session = resolveSessionPaths(startOptions.session, layout, outputDir);
    const runToken = sanitizeRemoteSegment(startOptions.taskId || session.sessionToken || randomUUID(), 'sandbox-run');
    const remoteInputPath = joinRemotePath(layout.remoteRunnerInputDir, `${runToken}.json`);
    const remoteResultPath = joinRemotePath(layout.remoteRunnerResultDir, `${runToken}.json`);
    const remoteEventPath = joinRemotePath(layout.remoteRunnerEventDir, `${runToken}.jsonl`);
    const remoteControlPath = joinRemotePath(layout.remoteRunnerControlDir, `${runToken}.json`);
    const sandboxRunId = `opensandbox-run-${randomUUID()}`;
    let controlRequested = false;

    function emitRunnerStatus(payload = {}) {
      const status = payload && typeof payload === 'object' ? payload : {};
      emitter.emit('runner_status', {
        ...status,
        createdAt: new Date().toISOString(),
      });
    }

    function deferRunnerStatus(payload = {}) {
      const timer = setTimeout(() => emitRunnerStatus(payload), 0);
      if (timer && typeof timer.unref === 'function') {
        timer.unref();
      }
    }

    function requestRemoteControl(action, reason) {
      if (controlRequested) {
        return;
      }
      controlRequested = true;
      const payload = JSON.stringify({
        action,
        message: String(reason || '').trim(),
        createdAt: new Date().toISOString(),
      }, null, 2);
      Promise.resolve(writeRemoteFile(sandbox, remoteControlPath, payload)).catch(() => {});
    }

    const handle = emitter;
    const resultPromise = (async () => {
      deferRunnerStatus({
        stage: 'preparing_assets',
        label: support.runtimeAssetSource === 'prebaked' ? '正在检查预烘焙 sandbox runner…' : '正在准备 sandbox runner…',
        assetSource: support.runtimeAssetSource || 'upload',
      });
      await ensureRuntimeAssets();
      emitRunnerStatus({
        stage: 'assets_ready',
        label: '正在启动 sandbox runner…',
        assetSource: support.runtimeAssetSource || 'upload',
      });

      const runEnv = buildSandboxRunEnv(startOptions, layout, options, factoryInput, provider);
      const inputPayload = {
        provider: String(provider || '').trim(),
        model: String(model || '').trim(),
        thinking: String(startOptions.thinking || '').trim(),
        prompt: String(prompt || ''),
        sessionPath: session.remoteSessionPath,
        agentDir: layout.remoteAgentDir,
        cwd: layout.remoteProjectDir,
        nodeCommand: options.nodeCommand || DEFAULT_REMOTE_NODE_COMMAND,
        piCliPath: layout.remotePiCliPath,
        eventPath: remoteEventPath,
        controlPath: remoteControlPath,
        controlPollIntervalMs: options.eventPollIntervalMs,
        extraEnv: runEnv,
      };

      await writeRemoteFile(sandbox, remoteInputPath, JSON.stringify(inputPayload, null, 2));
      emitRunnerStatus({
        stage: 'input_ready',
        label: '正在启动 sandbox 内进程…',
      });

      const command = `${shellQuote(options.nodeCommand || DEFAULT_REMOTE_NODE_COMMAND)} ${shellQuote(layout.remoteRunnerPath)} ${shellQuote(remoteInputPath)} ${shellQuote(remoteResultPath)}`;
      const eventPoller = createSandboxRunnerEventPoller(sandbox, remoteEventPath, emitter, options);
      emitRunnerStatus({
        stage: 'command_started',
        label: 'sandbox runner 已启动，等待工具或输出…',
      });
      let commandResult = null;
      let commandError = null;

      try {
        commandResult = await sandbox.commands.run(command, {
          timeout: options.timeoutSeconds,
          cwd: layout.remoteProjectDir,
        });
      } catch (error) {
        commandError = error;
      } finally {
        eventPoller.stop();
        await eventPoller.finished;
      }

      const rawResult = await readRemoteFileIfPresent(sandbox, remoteResultPath);
      let parsedResult = null;
      if (rawResult) {
        try {
          parsedResult = JSON.parse(rawResult);
        } catch (error) {
          throw Object.assign(new Error(`Sandbox runner returned invalid JSON: ${clipText(error && error.message ? error.message : String(error || 'unknown error'), 240)}`), {
            runId: sandboxRunId,
            sessionPath: session.localSessionPath || '',
            stderrTail: clipText(rawResult, 4000),
          });
        }
      }

      if (session.remoteSessionPath && session.localSessionPath) {
        const sessionContent = await readRemoteFileIfPresent(sandbox, session.remoteSessionPath);
        if (sessionContent) {
          ensureLocalDirectory(path.dirname(session.localSessionPath));
          fs.writeFileSync(session.localSessionPath, sessionContent, 'utf8');
        }
      }

      if (!parsedResult) {
        const failureMessage = commandError
          ? String(commandError && commandError.message ? commandError.message : commandError || 'Sandbox command failed')
          : 'Sandbox runner did not produce a result payload';
        throw Object.assign(new Error(failureMessage), {
          runId: sandboxRunId,
          sessionPath: session.localSessionPath || '',
          stderrTail: clipText(extractCommandText(commandResult, 'stderr') || failureMessage, 4000),
        });
      }

      const result = {
        reply: String(parsedResult.reply || ''),
        runId: sandboxRunId,
        sessionPath: session.localSessionPath || '',
        stderrTail: clipText(parsedResult.stderrTail || extractCommandText(commandResult, 'stderr') || '', 4000),
        parseErrors: Number.isInteger(parsedResult.parseErrors) ? parsedResult.parseErrors : 0,
        assistantErrors: Array.isArray(parsedResult.assistantErrors) ? parsedResult.assistantErrors.slice() : [],
        stdoutLines: Array.isArray(parsedResult.stdoutLines) ? parsedResult.stdoutLines.slice() : [],
        sandboxCommand: {
          exitCode: extractCommandExitCode(commandResult),
          stdout: extractCommandText(commandResult, 'stdout'),
          stderr: extractCommandText(commandResult, 'stderr'),
          remoteInputPath,
          remoteResultPath,
          remoteEventPath,
          remoteControlPath,
          remoteSessionPath: session.remoteSessionPath,
        },
      };

      if (String(parsedResult.status || '').trim() === 'succeeded' && !commandError) {
        return result;
      }

      const errorMessage = String(parsedResult.errorMessage || (commandError && commandError.message) || 'Sandbox run failed').trim() || 'Sandbox run failed';
      throw Object.assign(new Error(errorMessage), result, {
        exitCode: parsedResult.exitCode,
        signal: parsedResult.signal || null,
      });
    })();

    handle.resultPromise = resultPromise;
    handle.cancel = (reason = 'Run cancelled by caller') => {
      requestRemoteControl('cancel', reason);
      return handle;
    };
    handle.complete = (reason = 'Run completed by caller') => {
      requestRemoteControl('complete', reason);
      return handle;
    };
    Object.defineProperties(handle, {
      runId: { enumerable: true, get: () => sandboxRunId },
      sessionPath: { enumerable: true, get: () => session.localSessionPath || null },
    });

    return handle;
  };
}

async function createOpenSandboxAdapter(factoryInput = {}, options = {}) {
  const normalizedOptions = normalizeOpenSandboxFactoryOptions(options);
  const openSandboxModule = await loadOpenSandboxModule(normalizedOptions.loadModule, normalizedOptions);

  const metadata = {
    source: 'caff-skill-test',
    runId: normalizeText(factoryInput.runId),
    caseId: normalizeText(factoryInput.caseId),
    isolationMode: normalizeText(factoryInput.isolation && factoryInput.isolation.mode),
    trellisMode: normalizeText(factoryInput.isolation && factoryInput.isolation.trellisMode),
    egressMode: normalizeText(factoryInput.isolation && factoryInput.isolation.egressMode),
  };

  let sandbox = null;
  let sandboxFlavor = 'legacy';
  try {
    const createdSandbox = await createSandboxInstanceWithFallback(openSandboxModule, metadata, normalizedOptions);
    sandbox = createdSandbox.sandbox;
    sandboxFlavor = createdSandbox.flavor;
  } catch (error) {
    throw createHttpError(503, `OpenSandbox is unavailable: ${clipText(error && error.message ? error.message : String(error || 'unknown error'), 240)}`);
  }

  const layout = buildRemoteLayout(factoryInput, normalizedOptions);
  const uploaded = {
    agentFiles: [],
    projectFiles: [],
    projectSource: 'upload',
    projectTemplateDir: '',
    sqliteSeeded: false,
  };

  try {
    await ensureRemoteDirectory(sandbox, layout.remoteRoot);
    await ensureRemoteDirectory(sandbox, layout.remoteOutputDir);
    await ensureRemoteDirectory(sandbox, layout.remoteStoreDir);
    await ensureRemoteDirectory(sandbox, layout.remoteRuntimeDir);
    uploaded.agentFiles = await uploadTreeToSandbox(sandbox, factoryInput.agentDir, layout.remoteAgentDir);
    const projectPreparation = await prepareSandboxProjectDir(sandbox, factoryInput, layout, normalizedOptions);
    uploaded.projectFiles = projectPreparation.files;
    uploaded.projectSource = projectPreparation.source;
    uploaded.projectTemplateDir = projectPreparation.templateDir;
    if (factoryInput.sqlitePath && fs.existsSync(factoryInput.sqlitePath)) {
      await writeRemoteFile(sandbox, layout.remoteSqlitePath, fs.readFileSync(factoryInput.sqlitePath));
      uploaded.sqliteSeeded = true;
    }
  } catch (error) {
    try {
      await cleanupSandbox(sandbox);
    } catch {}
    throw createHttpError(503, `Failed to prepare OpenSandbox case world: ${clipText(error && error.message ? error.message : String(error || 'unknown error'), 240)}`);
  }

  const executionSupport = buildSandboxExecutionSupport(sandbox, normalizedOptions);
  const startRun = executionSupport.startRunAvailable
    ? createSandboxStartRun({
        sandbox,
        layout,
        factoryInput,
        options: normalizedOptions,
        support: executionSupport,
      })
    : null;
  const executionReason = executionSupport.startRunAvailable
    ? 'OpenSandbox runs a sandbox-side Node runner via commands.run for skill-test execution'
    : executionSupport.blockReason || 'OpenSandbox prepared a remote case world, but the current adapter still delegates execution to the host runtime';

  return {
    driverName: DEFAULT_DRIVER_NAME,
    driverVersion: normalizedOptions.driverVersion,
    sandboxId: resolveSandboxId(sandbox),
    execution: {
      runtime: executionSupport.startRunAvailable ? 'sandbox' : 'host',
      preparedOnly: !executionSupport.startRunAvailable,
      adapterStartRun: executionSupport.startRunAvailable,
      reason: executionReason,
    },
    egress: {
      mode: metadata.egressMode || 'deny',
      enforced: false,
      scope: 'record-only',
      reason: 'OpenSandbox adapter records requested egress mode but does not yet configure sandbox network policy',
    },
    extraEnv: {
      CAFF_OPENSANDBOX_SANDBOX_ID: resolveSandboxId(sandbox),
      CAFF_OPENSANDBOX_DOMAIN: resolveSandboxDomain(sandbox),
      CAFF_OPENSANDBOX_FLAVOR: sandboxFlavor,
      CAFF_SKILL_TEST_REMOTE_ROOT: layout.remoteRoot,
      CAFF_SKILL_TEST_REMOTE_AGENT_DIR: layout.remoteAgentDir,
      CAFF_SKILL_TEST_REMOTE_PROJECT_DIR: layout.remoteProjectDir,
      CAFF_SKILL_TEST_REMOTE_OUTPUT_DIR: layout.remoteOutputDir,
      CAFF_SKILL_TEST_REMOTE_SQLITE_PATH: layout.remoteSqlitePath,
      ...(executionSupport.startRunAvailable ? {
        CAFF_SKILL_TEST_REMOTE_RUNNER_PATH: layout.remoteRunnerPath,
        CAFF_SKILL_TEST_REMOTE_PI_CLI_PATH: layout.remotePiCliPath,
        CAFF_SKILL_TEST_REMOTE_CHAT_TOOLS_PATH: layout.remoteAgentChatToolsPath,
      } : {}),
    },
    resources: {
      remoteRoot: layout.remoteRoot,
      remoteAgentDir: layout.remoteAgentDir,
      remoteProjectDir: layout.remoteProjectDir,
      remoteProjectTemplateDir: layout.remoteProjectTemplateDir,
      remoteSandboxDir: layout.remoteSandboxDir,
      remotePrivateDir: layout.remotePrivateDir,
      remoteOutputDir: layout.remoteOutputDir,
      remoteSqlitePath: layout.remoteSqlitePath,
      remoteSkillPath: layout.remoteSkillPath,
      remoteRuntimeDir: layout.remoteRuntimeDir,
      remoteRuntimeAssetDir: layout.remoteRuntimeAssetDir,
      remoteRunnerEventDir: layout.remoteRunnerEventDir,
      remoteRunnerControlDir: layout.remoteRunnerControlDir,
      remoteRunnerPath: layout.remoteRunnerPath,
      remotePiCliPath: layout.remotePiCliPath,
      remoteAgentChatToolsPath: layout.remoteAgentChatToolsPath,
      remoteDomain: resolveSandboxDomain(sandbox),
      sdkFlavor: sandboxFlavor,
      usesPrebakedRuntimeAssets: layout.usesPrebakedRuntimeAssets,
      usesPrebakedProjectSource: layout.usesPrebakedProjectSource,
      startRunAvailable: executionSupport.startRunAvailable,
      startRunBlockReason: executionSupport.startRunAvailable ? '' : executionSupport.blockReason,
      upload: uploaded,
    },
    ...(executionSupport.startRunAvailable ? { startRun } : {}),
    async cleanup() {
      await cleanupSandbox(sandbox);
    },
  };
}

function createConfiguredOpenSandboxFactory(input = {}) {
  const normalizedOptions = normalizeOpenSandboxFactoryOptions(input);
  if (!normalizedOptions.enabled) {
    return null;
  }

  return async function openSandboxFactory(factoryInput = {}) {
    return createOpenSandboxAdapter(factoryInput, normalizedOptions);
  };
}

export {
  DEFAULT_DRIVER_NAME,
  DEFAULT_DRIVER_VERSION,
  DEFAULT_PREBAKED_PROJECT_DIR,
  DEFAULT_PREBAKED_RUNTIME_DIR,
  DEFAULT_REMOTE_ROOT,
  DEFAULT_TEMPLATE,
  DEFAULT_TIMEOUT_SECONDS,
  createPiPackageFilter,
  createConfiguredOpenSandboxFactory,
  createOpenSandboxAdapter,
  normalizeOpenSandboxFactoryOptions,
  resolveLocalChatToolsPath,
  resolveLocalPiPackageDir,
  resolveLocalRunnerPath,
  resolveProviderAuthEnv,
};
