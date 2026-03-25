const runtime = require('./pi-runtime');

const {
  DEFAULT_AGENT_DIR,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_TERMINATE_GRACE_MS,
  DEFAULT_THINKING,
  invoke,
  resolveIntegerSetting,
  resolveIntegerSettingCandidates,
  resolveSetting,
} = runtime;

function parseCliArgs(argv) {
  const result = {
    provider: '',
    model: '',
    thinking: '',
    sqlitePath: '',
    heartbeatIntervalMs: undefined,
    heartbeatTimeoutMs: undefined,
    terminateGraceMs: undefined,
    resume: false,
    session: '',
    prompt: '',
  };
  const promptParts = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (
      arg === '--provider' ||
      arg === '--model' ||
      arg === '--thinking' ||
      arg === '--session' ||
      arg === '-s' ||
      arg === '--db-path' ||
      arg === '--heartbeat-interval-ms' ||
      arg === '--heartbeat-timeout-ms' ||
      arg === '--timeout-ms' ||
      arg === '--idle-timeout-ms' ||
      arg === '--terminate-grace-ms'
    ) {
      const value = argv[i + 1];

      if (!value || value.startsWith('--')) {
        console.error(`Missing value for ${arg}`);
        process.exit(1);
      }

      if (arg === '--provider') {
        result.provider = value;
      } else if (arg === '--model') {
        result.model = value;
      } else if (arg === '--session' || arg === '-s') {
        result.session = value;
      } else if (arg === '--db-path') {
        result.sqlitePath = value;
      } else if (arg === '--heartbeat-interval-ms') {
        result.heartbeatIntervalMs = value;
      } else if (arg === '--heartbeat-timeout-ms' || arg === '--timeout-ms' || arg === '--idle-timeout-ms') {
        result.heartbeatTimeoutMs = value;
      } else if (arg === '--terminate-grace-ms') {
        result.terminateGraceMs = value;
      } else {
        result.thinking = value;
      }

      i += 1;
      continue;
    }

    if (arg === '--resume' || arg === '-r' || arg === '--continue' || arg === '-c') {
      result.resume = true;
      continue;
    }

    promptParts.push(arg);
  }

  result.prompt = promptParts.join(' ').trim();
  return result;
}

function printUsage() {
  console.error(
    'Usage: node lib/minimal-pi.js [--resume] [--session name|path] [--provider name] [--model name] [--thinking level] [--db-path path] [--heartbeat-interval-ms n] [--heartbeat-timeout-ms n] [--terminate-grace-ms n] "Say hello in one sentence"'
  );
  console.error(`Default provider: ${DEFAULT_PROVIDER}`);
  console.error(`Default model: ${DEFAULT_MODEL}`);
  console.error('Sessions are saved under PI_CODING_AGENT_DIR (defaults to ./.pi-sandbox).');
  console.error('Use --resume to continue the most recent session, or --session <name|path> to bind to a specific session.');
  console.error('If --session is a plain name, it is stored under ./.pi-sandbox/named-sessions/<name>.jsonl.');
  console.error(`Default heartbeatIntervalMs: ${DEFAULT_HEARTBEAT_INTERVAL_MS}`);
  console.error(`Default heartbeatTimeoutMs: ${DEFAULT_HEARTBEAT_TIMEOUT_MS}`);
  console.error(`Default terminateGraceMs: ${DEFAULT_TERMINATE_GRACE_MS}`);
  console.error('SQLite defaults to <agentDir>/pi-state.sqlite. Override with --db-path or PI_SQLITE_PATH.');
  console.error(
    'Optional env: PI_PROVIDER, PI_MODEL, PI_THINKING, PI_CODING_AGENT_DIR, PI_SQLITE_PATH, PI_HEARTBEAT_INTERVAL_MS, PI_HEARTBEAT_TIMEOUT_MS, PI_TERMINATE_GRACE_MS, PI_ENV, GIT_BASH_PATH'
  );
}

function printInvokeError(error) {
  if (!error) {
    console.error('Unknown invoke error');
    return;
  }

  console.error(error.stack || error.message || String(error));

  if (error.runId) {
    console.error(`run id: ${error.runId}`);
  }

  if (error.databasePath) {
    console.error(`sqlite db: ${error.databasePath}`);
  }

  if (error.signal) {
    console.error(`signal: ${error.signal}`);
  }

  if (typeof error.parseErrors === 'number' && error.parseErrors > 0) {
    console.error(`non-JSON stdout lines: ${error.parseErrors}`);
  }

  if (Array.isArray(error.stdoutLines) && error.stdoutLines.length > 0) {
    console.error('recent stdout lines:');

    for (const line of error.stdoutLines) {
      console.error(line);
    }
  }

  if (error.stderrTail) {
    console.error('stderr tail:');
    console.error(error.stderrTail);
  }
}

async function main(argv = process.argv.slice(2)) {
  const cli = parseCliArgs(argv);
  const prompt = cli.prompt;
  const provider = resolveSetting(cli.provider, process.env.PI_PROVIDER, DEFAULT_PROVIDER);
  const model = resolveSetting(cli.model, process.env.PI_MODEL, DEFAULT_MODEL);
  const thinking = resolveSetting(cli.thinking, process.env.PI_THINKING, DEFAULT_THINKING);
  const agentDir = resolveSetting('', process.env.PI_CODING_AGENT_DIR, DEFAULT_AGENT_DIR);
  const sqlitePath = resolveSetting(cli.sqlitePath, process.env.PI_SQLITE_PATH, '');
  const heartbeatIntervalMs = resolveIntegerSettingCandidates(
    [cli.heartbeatIntervalMs, process.env.PI_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_INTERVAL_MS],
    'heartbeatIntervalMs'
  );
  const heartbeatTimeoutMs = resolveIntegerSettingCandidates(
    [
      cli.heartbeatTimeoutMs,
      process.env.PI_HEARTBEAT_TIMEOUT_MS,
      process.env.PI_IDLE_TIMEOUT_MS,
      process.env.PI_TIMEOUT_MS,
      DEFAULT_HEARTBEAT_TIMEOUT_MS,
    ],
    'heartbeatTimeoutMs'
  );
  const terminateGraceMs = resolveIntegerSetting(
    cli.terminateGraceMs,
    process.env.PI_TERMINATE_GRACE_MS,
    DEFAULT_TERMINATE_GRACE_MS,
    'terminateGraceMs'
  );

  if (!prompt) {
    printUsage();
    return 1;
  }

  try {
    await invoke(provider, model, prompt, {
      thinking,
      agentDir,
      sqlitePath,
      heartbeatIntervalMs,
      heartbeatTimeoutMs,
      terminateGraceMs,
      resume: cli.resume,
      session: cli.session,
    });

    return 0;
  } catch (error) {
    printInvokeError(error);
    return error.exitCode || 1;
  }
}

module.exports = {
  DEFAULT_AGENT_DIR: runtime.DEFAULT_AGENT_DIR,
  DEFAULT_HEARTBEAT_INTERVAL_MS: runtime.DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS: runtime.DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_MODEL: runtime.DEFAULT_MODEL,
  DEFAULT_PROVIDER: runtime.DEFAULT_PROVIDER,
  DEFAULT_TERMINATE_GRACE_MS: runtime.DEFAULT_TERMINATE_GRACE_MS,
  DEFAULT_THINKING: runtime.DEFAULT_THINKING,
  invoke: runtime.invoke,
  main,
  parseCliArgs,
  printInvokeError,
  printUsage,
  resolveDefaultAgentDir: runtime.resolveDefaultAgentDir,
  resolveIntegerSetting: runtime.resolveIntegerSetting,
  resolveIntegerSettingCandidates: runtime.resolveIntegerSettingCandidates,
  resolveSessionPath: runtime.resolveSessionPath,
  resolveSetting: runtime.resolveSetting,
  sanitizeSessionName: runtime.sanitizeSessionName,
  startRun: runtime.startRun,
};

if (require.main === module) {
  main().then((exitCode) => {
    process.exit(exitCode);
  });
}
