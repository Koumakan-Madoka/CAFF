import type { EventEmitter } from 'node:events';

export type SkillTestExecutionPlane = 'host' | 'sandbox';
export type SkillTestPathSemantics = 'host' | 'sandbox';
export type SkillTestEnvironmentMap = Record<string, string>;

export type SkillTestSandboxCommandInput = {
  cwd?: string;
  timeout?: number;
  env?: SkillTestEnvironmentMap;
};

export type SkillTestSandboxCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export interface SkillTestSandboxToolAdapter {
  mapHostPathToRemote?: (hostPath: string) => string;
  access?: (hostPath: string) => Promise<void>;
  mkdir(hostPath: string): Promise<void>;
  readFile(hostPath: string): Promise<Buffer>;
  writeFile(hostPath: string, content: string | Buffer): Promise<void>;
  runCommand(command: string, input?: SkillTestSandboxCommandInput): Promise<SkillTestSandboxCommandResult>;
}

export type SkillTestExecutionEvidence = {
  runtime: SkillTestExecutionPlane | '';
  loopRuntime: SkillTestExecutionPlane | '';
  toolRuntime: SkillTestExecutionPlane | '';
  pathSemantics: SkillTestPathSemantics | '';
  preparedOnly: boolean;
  reason: string;
};

export type SkillTestIsolationMode = 'legacy-local' | 'isolated';
export type SkillTestIsolationTrellisMode = 'none' | 'fixture' | 'readonlysnapshot' | 'liveexplicit';

export type SkillTestIsolationOptions = {
  mode: SkillTestIsolationMode;
  notIsolated: boolean;
  driver: string;
  publishGate: boolean;
  trellisMode: SkillTestIsolationTrellisMode;
  egressMode: 'deny' | 'allow';
  allowedBridgeTools: string[];
};

export type SkillTestIsolationToolPolicyReject = {
  toolName: string;
  reason: string;
  details: Record<string, unknown>;
  createdAt: string;
};

export type SkillTestIsolationToolPolicy = {
  rejects: SkillTestIsolationToolPolicyReject[];
  allowedTools: string[];
};

export type SkillTestIsolationToolPolicyRecorder = SkillTestIsolationToolPolicy & {
  record(toolName: string, reason: string, details?: Record<string, unknown>): void;
};

export type SkillTestIsolationEgressEvidence = {
  mode: string;
  enforced: boolean;
  scope: string;
  reason: string;
};

export type SkillTestIsolationPollutionCheck = {
  checked: boolean;
  ok: boolean;
  changeCount: number;
  changes: Array<string | Record<string, unknown>>;
};

export type SkillTestIsolationCleanupEvidence = {
  ok: boolean;
  error: string;
};

export type SkillTestIsolationEvidence = {
  mode: string;
  notIsolated: boolean;
  publishGate: boolean;
  driver: SkillTestDriverRef;
  sandboxId: string;
  runId: string;
  caseId: string;
  trellisMode: string;
  egressMode: string;
  toolPolicy: SkillTestIsolationToolPolicy;
  execution: SkillTestExecutionEvidence;
  egress: SkillTestIsolationEgressEvidence;
  resources: Record<string, unknown>;
  pollutionCheck: SkillTestIsolationPollutionCheck;
  cleanup: SkillTestIsolationCleanupEvidence;
  unsafe: boolean;
  unsafeReasons: string[];
  createdAt: string;
  finishedAt: string;
};

export type SkillTestIsolationIssue = {
  code: string;
  severity: 'error' | 'warning';
  path: string;
  message: string;
};

export type SkillTestIsolationRef = {
  mode: string;
  egressMode: string;
};

export type SkillTestDriverRef = {
  name: string;
  version: string;
};

export type SkillTestEnvironmentRuntimeInput = {
  sandboxToolAdapter?: unknown;
  toolRuntime?: unknown;
  execution?: unknown;
  isolation?: unknown;
  driver?: unknown;
  projectDir?: unknown;
  outputDir?: unknown;
  privateDir?: unknown;
  skillId?: unknown;
  environmentCacheRootDir?: unknown;
  commandEnv?: unknown;
  availableEnv?: unknown;
  platform?: unknown;
  arch?: unknown;
};

export type SkillTestEnvironmentRuntime = {
  sandboxToolAdapter: SkillTestSandboxToolAdapter | null;
  toolRuntime: SkillTestExecutionPlane;
  execution: SkillTestExecutionEvidence | null;
  isolation: SkillTestIsolationRef | null;
  driver: SkillTestDriverRef | null;
  projectDir: string;
  outputDir: string;
  privateDir: string;
  skillId: string;
  environmentCacheRootDir: string;
  commandEnv: SkillTestEnvironmentMap;
  availableEnv: SkillTestEnvironmentMap;
  platform: string;
  arch: string;
};

export type SkillTestAgentSandboxRef = {
  sandboxDir: string;
  privateDir: string;
};

export type SkillTestSkillRef = Record<string, unknown> & {
  id?: string;
  name?: string;
  description?: string;
  body?: string;
  path?: string;
};

export interface SkillTestStoreRef {
  db?: unknown;
  agentDir?: string;
  databasePath?: string;
  close?(): void;
  getAgent(agentId: string): unknown;
  saveAgent(agent: Record<string, unknown>): unknown;
  getConversation(conversationId: string): unknown;
  createConversation(conversation: Record<string, unknown>): unknown;
  getMessage(messageId: string): unknown;
  createMessage(message: Record<string, unknown>): unknown;
}

export type SkillTestIsolationCaseContext = {
  isolation: SkillTestIsolationOptions;
  store: SkillTestStoreRef | null;
  agentDir: string;
  sqlitePath: string;
  sandbox: SkillTestAgentSandboxRef;
  projectDir: string;
  outputDir?: string;
  skill: SkillTestSkillRef | null;
  toolPolicy: SkillTestIsolationToolPolicyRecorder;
  execution: SkillTestExecutionEvidence;
  driver?: SkillTestDriverRef;
  extraEnv: SkillTestEnvironmentMap;
  sandboxToolAdapter: SkillTestSandboxToolAdapter | null;
  finalize(): Promise<SkillTestIsolationEvidence>;
};

export type SkillTestIsolationDriver = {
  normalizeOptions(input?: Record<string, unknown>): SkillTestIsolationOptions;
  createCaseContext(input?: Record<string, unknown>): Promise<SkillTestIsolationCaseContext>;
};

export type SkillTestOpenSandboxStartOptions = {
  thinking?: string;
  session?: string;
  taskId?: string;
  extraEnv?: SkillTestEnvironmentMap;
};

export type SkillTestOpenSandboxCommandEvidence = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  remoteInputPath: string;
  remoteResultPath: string;
  remoteEventPath: string;
  remoteControlPath: string;
  remoteSessionPath: string;
};

export type SkillTestOpenSandboxStartRunResult = {
  reply: string;
  runId: string;
  sessionPath: string;
  stderrTail: string;
  parseErrors: number;
  assistantErrors: unknown[];
  stdoutLines: string[];
  sandboxCommand: SkillTestOpenSandboxCommandEvidence;
  exitCode?: unknown;
  signal?: unknown;
};

export interface SkillTestOpenSandboxRunHandle extends EventEmitter {
  resultPromise: Promise<SkillTestOpenSandboxStartRunResult>;
  cancel(reason?: string): SkillTestOpenSandboxRunHandle;
  complete(reason?: string): SkillTestOpenSandboxRunHandle;
  readonly runId: string;
  readonly sessionPath: string | null;
}

export type SkillTestOpenSandboxStartRun = (
  provider: string,
  model: string,
  prompt: string,
  startOptions?: SkillTestOpenSandboxStartOptions,
) => SkillTestOpenSandboxRunHandle;

export type SkillTestOpenSandboxAdapter = {
  driverName: string;
  driverVersion: string;
  sandboxId: string;
  toolAdapter: SkillTestSandboxToolAdapter | null;
  execution: SkillTestExecutionEvidence;
  egress: SkillTestIsolationEgressEvidence;
  extraEnv: SkillTestEnvironmentMap;
  resources: Record<string, unknown>;
  startRun?: SkillTestOpenSandboxStartRun;
  cleanup(): Promise<void>;
};

export type SkillTestOpenSandboxFactory = (factoryInput?: Record<string, unknown>) => Promise<SkillTestOpenSandboxAdapter>;

function normalizeText(value: unknown, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeExecutionPlane(value: unknown): SkillTestExecutionPlane | '' {
  const normalized = normalizeText(value).toLowerCase();
  return normalized === 'host' || normalized === 'sandbox' ? normalized : '';
}

function normalizePathSemantics(value: unknown): SkillTestPathSemantics | '' {
  const normalized = normalizeText(value).toLowerCase();
  return normalized === 'host' || normalized === 'sandbox' ? normalized : '';
}

export function normalizeSkillTestEnvironmentMap(input: unknown): SkillTestEnvironmentMap {
  if (!isPlainObject(input)) {
    return {};
  }

  const normalized: SkillTestEnvironmentMap = {};
  for (const [key, value] of Object.entries(input)) {
    const envName = normalizeText(key);
    if (!envName || value === undefined || value === null) {
      continue;
    }
    normalized[envName] = String(value);
  }
  return normalized;
}

function normalizeSandboxCommandResult(value: unknown): SkillTestSandboxCommandResult {
  const result = isPlainObject(value) ? value : {};
  const exitCodeValue = result.exitCode;
  const exitCode = Number.isInteger(exitCodeValue)
    ? Number(exitCodeValue)
    : Number.isFinite(Number(exitCodeValue))
      ? Number(exitCodeValue)
      : -1;

  return {
    stdout: normalizeText(result.stdout),
    stderr: normalizeText(result.stderr),
    exitCode,
  };
}

export function coerceSkillTestSandboxToolAdapter(value: unknown): SkillTestSandboxToolAdapter | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const mapHostPathToRemote = value.mapHostPathToRemote;
  const access = value.access;
  const mkdir = value.mkdir;
  const readFile = value.readFile;
  const writeFile = value.writeFile;
  const runCommand = value.runCommand;

  if (
    typeof mkdir !== 'function'
    || typeof readFile !== 'function'
    || typeof writeFile !== 'function'
    || typeof runCommand !== 'function'
  ) {
    return null;
  }

  const adapter: SkillTestSandboxToolAdapter = {
    async mkdir(hostPath: string) {
      await Promise.resolve(mkdir(hostPath));
    },
    async readFile(hostPath: string) {
      const content = await Promise.resolve(readFile(hostPath));
      return Buffer.isBuffer(content) ? content : Buffer.from(content == null ? '' : content);
    },
    async writeFile(hostPath: string, content: string | Buffer) {
      await Promise.resolve(writeFile(hostPath, content));
    },
    async runCommand(command: string, input: SkillTestSandboxCommandInput = {}) {
      const result = await Promise.resolve(runCommand(command, {
        cwd: input.cwd,
        timeout: Number.isFinite(input.timeout) ? Number(input.timeout) : undefined,
        env: normalizeSkillTestEnvironmentMap(input.env),
      }));
      return normalizeSandboxCommandResult(result);
    },
  };

  if (typeof mapHostPathToRemote === 'function') {
    adapter.mapHostPathToRemote = (hostPath: string) => normalizeText(mapHostPathToRemote(hostPath));
  }
  if (typeof access === 'function') {
    adapter.access = async (hostPath: string) => {
      await Promise.resolve(access(hostPath));
    };
  }

  return adapter;
}

function normalizeExecutionEvidence(value: unknown): SkillTestExecutionEvidence | null {
  if (!isPlainObject(value)) {
    return null;
  }

  return {
    runtime: normalizeExecutionPlane(value.runtime),
    loopRuntime: normalizeExecutionPlane(value.loopRuntime),
    toolRuntime: normalizeExecutionPlane(value.toolRuntime),
    pathSemantics: normalizePathSemantics(value.pathSemantics),
    preparedOnly: value.preparedOnly === true,
    reason: normalizeText(value.reason),
  };
}

function normalizeIsolationRef(value: unknown): SkillTestIsolationRef | null {
  if (!isPlainObject(value)) {
    return null;
  }

  return {
    mode: normalizeText(value.mode),
    egressMode: normalizeText(value.egressMode),
  };
}

function normalizeDriverRef(value: unknown): SkillTestDriverRef | null {
  if (!isPlainObject(value)) {
    return null;
  }

  return {
    name: normalizeText(value.name),
    version: normalizeText(value.version),
  };
}

export function createSkillTestEnvironmentRuntime(input: SkillTestEnvironmentRuntimeInput = {}): SkillTestEnvironmentRuntime {
  const execution = normalizeExecutionEvidence(input.execution);
  const commandEnv = normalizeSkillTestEnvironmentMap(input.commandEnv);
  const hasAvailableEnv = Object.prototype.hasOwnProperty.call(input, 'availableEnv');

  return {
    sandboxToolAdapter: coerceSkillTestSandboxToolAdapter(input.sandboxToolAdapter),
    toolRuntime: normalizeExecutionPlane(input.toolRuntime) || execution?.toolRuntime || 'host',
    execution,
    isolation: normalizeIsolationRef(input.isolation),
    driver: normalizeDriverRef(input.driver),
    projectDir: normalizeText(input.projectDir),
    outputDir: normalizeText(input.outputDir),
    privateDir: normalizeText(input.privateDir),
    skillId: normalizeText(input.skillId),
    environmentCacheRootDir: normalizeText(input.environmentCacheRootDir),
    commandEnv,
    availableEnv: hasAvailableEnv ? normalizeSkillTestEnvironmentMap(input.availableEnv) : { ...commandEnv },
    platform: normalizeText(input.platform, process.platform),
    arch: normalizeText(input.arch, process.arch),
  };
}
