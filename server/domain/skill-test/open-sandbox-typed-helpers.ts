import path = require('node:path');

import type {
  SkillTestSandboxCommandInput,
  SkillTestSandboxCommandResult,
  SkillTestSandboxToolAdapter,
} from './sandbox-tool-contract';

export type OpenSandboxExecutionSupport = {
  startRunAvailable: boolean;
  blockReason: string;
  runnerPath: string;
  chatToolsPath: string;
  piPackageDir: string;
  runtimeAssetSource: 'unavailable' | 'prebaked' | 'upload';
  prebakedRuntimeDir: string;
};

export type OpenSandboxExecutionSupportInput = {
  hasCommandRunner: boolean;
  prebakedRuntimeDir?: string;
  runnerPath?: string;
  chatToolsPath?: string;
  piPackageDir?: string;
};

export type OpenSandboxPathLayout = {
  remoteRoot: string;
  remoteProjectDir: string;
  remoteAgentDir: string;
  remoteOutputDir: string;
  remoteStoreDir: string;
  remoteRuntimeDir: string;
  remoteSandboxDir: string;
  remotePrivateDir: string;
  remoteSkillPath: string;
  remoteSqlitePath: string;
};

export type OpenSandboxFactoryPathInput = {
  caseRoot?: string;
  projectDir?: string;
  agentDir?: string;
  outputDir?: string;
  sqlitePath?: string;
};

export type OpenSandboxCommandRuntime = {
  run(command: string, options?: {
    cwd?: string;
    timeout?: number;
    env?: Record<string, string>;
  }): Promise<unknown>;
};

export type OpenSandboxRuntimeRef = Record<string, unknown> & {
  commands?: OpenSandboxCommandRuntime | null;
};

export type OpenSandboxToolAdapterDependencies = {
  mapHostPathToRemote(hostBaseDir: string, hostTargetPath: string, remoteBaseDir: string): string;
  ensureRemoteDirectory(sandbox: OpenSandboxRuntimeRef, remoteDir: string): Promise<void>;
  remoteFileExists(sandbox: OpenSandboxRuntimeRef, remotePath: string): Promise<boolean>;
  readRemoteFileIfPresent(sandbox: OpenSandboxRuntimeRef, remotePath: string): Promise<unknown>;
  normalizeRemoteFileBuffer(content: unknown): Buffer;
  writeRemoteFile(sandbox: OpenSandboxRuntimeRef, remotePath: string, content: string | Buffer): Promise<void>;
  extractCommandText(commandResult: unknown, streamName: 'stdout' | 'stderr'): string;
  extractCommandExitCode(commandResult: unknown): number | null;
  normalizeEnvObject(input: unknown): Record<string, string>;
};

export type OpenSandboxToolAdapterInput = {
  sandbox: OpenSandboxRuntimeRef;
  layout: OpenSandboxPathLayout;
  factoryInput: OpenSandboxFactoryPathInput;
  dependencies: OpenSandboxToolAdapterDependencies;
};

function normalizeText(value: unknown): string {
  return String(value || '').trim();
}

function normalizeCommandExitCode(value: number | null): number {
  return Number.isInteger(value) ? Number(value) : -1;
}

export function resolveOpenSandboxExecutionSupport(input: OpenSandboxExecutionSupportInput): OpenSandboxExecutionSupport {
  if (!input.hasCommandRunner) {
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

  const prebakedRuntimeDir = normalizeText(input.prebakedRuntimeDir);
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

  const runnerPath = normalizeText(input.runnerPath);
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

  const chatToolsPath = normalizeText(input.chatToolsPath);
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

  const piPackageDir = normalizeText(input.piPackageDir);
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

export function createOpenSandboxToolAdapter(input: OpenSandboxToolAdapterInput): SkillTestSandboxToolAdapter {
  const { sandbox, layout, factoryInput, dependencies } = input;

  const pathMappings = [
    { hostBaseDir: factoryInput.caseRoot, remoteBaseDir: layout.remoteRoot },
    { hostBaseDir: factoryInput.projectDir, remoteBaseDir: layout.remoteProjectDir },
    { hostBaseDir: factoryInput.agentDir, remoteBaseDir: layout.remoteAgentDir },
    { hostBaseDir: factoryInput.outputDir, remoteBaseDir: layout.remoteOutputDir },
    ...(factoryInput.sqlitePath
      ? [{ hostBaseDir: path.dirname(normalizeText(factoryInput.sqlitePath)), remoteBaseDir: layout.remoteStoreDir }]
      : []),
  ].filter((entry): entry is { hostBaseDir: string; remoteBaseDir: string } => Boolean(entry.hostBaseDir && entry.remoteBaseDir));

  const visiblePathMappings = pathMappings
    .map((entry) => ({
      hostBaseDir: path.resolve(normalizeText(entry.remoteBaseDir) || '.'),
      remoteBaseDir: entry.remoteBaseDir,
    }))
    .filter((entry) => entry.hostBaseDir && entry.remoteBaseDir);

  const allPathMappings = pathMappings.concat(visiblePathMappings);
  const visibleRemoteRoots = [
    layout.remoteRoot,
    layout.remoteProjectDir,
    layout.remoteAgentDir,
    layout.remoteOutputDir,
    layout.remoteStoreDir,
    layout.remoteRuntimeDir,
    layout.remoteSandboxDir,
    layout.remotePrivateDir,
    layout.remoteSkillPath,
    layout.remoteSqlitePath,
  ]
    .map((entry) => normalizeText(entry).replace(/\\/g, '/').replace(/\/+$/u, ''))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  function resolveRemotePath(hostPath: string): string {
    const rawPath = normalizeText(hostPath);
    const portableRawPath = rawPath.replace(/\\/g, '/').replace(/\/+$/u, '');

    if (portableRawPath && portableRawPath.startsWith('/')) {
      for (const root of visibleRemoteRoots) {
        if (portableRawPath === root || portableRawPath.startsWith(`${root}/`)) {
          return portableRawPath;
        }
      }
    }

    const normalizedHostPath = path.resolve(rawPath || '.');

    if (factoryInput.sqlitePath && normalizedHostPath === path.resolve(normalizeText(factoryInput.sqlitePath))) {
      return layout.remoteSqlitePath;
    }

    for (const entry of allPathMappings) {
      const remotePath = dependencies.mapHostPathToRemote(entry.hostBaseDir, normalizedHostPath, entry.remoteBaseDir);
      if (remotePath) {
        return remotePath;
      }
    }

    throw new Error(`Path is outside the sandbox case world: ${normalizedHostPath}`);
  }

  async function runRemoteCommand(command: string, commandInput: SkillTestSandboxCommandInput = {}): Promise<SkillTestSandboxCommandResult> {
    const remoteCwd = commandInput.cwd ? resolveRemotePath(commandInput.cwd) : layout.remoteProjectDir;
    const runner = sandbox.commands && typeof sandbox.commands.run === 'function'
      ? sandbox.commands.run.bind(sandbox.commands)
      : null;

    if (!runner) {
      throw new Error('OpenSandbox commands.run is unavailable');
    }

    const result = await runner(String(command || ''), {
      cwd: remoteCwd,
      timeout: Number.isFinite(commandInput.timeout) ? Number(commandInput.timeout) : undefined,
      env: dependencies.normalizeEnvObject(commandInput.env),
    });

    return {
      stdout: dependencies.extractCommandText(result, 'stdout'),
      stderr: dependencies.extractCommandText(result, 'stderr'),
      exitCode: normalizeCommandExitCode(dependencies.extractCommandExitCode(result)),
    };
  }

  return {
    mapHostPathToRemote(hostPath: string) {
      return resolveRemotePath(hostPath);
    },
    async access(hostPath: string) {
      const remotePath = resolveRemotePath(hostPath);
      if (!(await dependencies.remoteFileExists(sandbox, remotePath))) {
        throw new Error(`File not found in sandbox: ${hostPath}`);
      }
    },
    async mkdir(hostPath: string) {
      const remotePath = resolveRemotePath(hostPath);
      await dependencies.ensureRemoteDirectory(sandbox, remotePath);
    },
    async readFile(hostPath: string) {
      const remotePath = resolveRemotePath(hostPath);
      if (!(await dependencies.remoteFileExists(sandbox, remotePath))) {
        throw new Error(`File not found in sandbox: ${hostPath}`);
      }
      const content = await dependencies.readRemoteFileIfPresent(sandbox, remotePath);
      return dependencies.normalizeRemoteFileBuffer(content);
    },
    async writeFile(hostPath: string, content: string | Buffer) {
      const remotePath = resolveRemotePath(hostPath);
      await dependencies.ensureRemoteDirectory(sandbox, path.posix.dirname(remotePath));
      await dependencies.writeRemoteFile(sandbox, remotePath, content == null ? '' : content);
    },
    async runCommand(command: string, commandInput: SkillTestSandboxCommandInput = {}) {
      return runRemoteCommand(command, commandInput);
    },
  };
}
