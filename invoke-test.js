const { invoke, printInvokeError } = require('./minimal-pi');

const DEFAULT_PROMPT = '';

function parseCliArgs(argv) {
  const promptParts = [];
  let resume = false;
  let session = '';
  let sqlitePath = '';
  let heartbeatIntervalMs;
  let heartbeatTimeoutMs;
  let terminateGraceMs;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--resume' || arg === '-r' || arg === '--continue' || arg === '-c') {
      resume = true;
      continue;
    }

    if (arg === '--session' || arg === '-s') {
      const value = argv[i + 1];

      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }

      session = value;
      i += 1;
      continue;
    }

    if (arg === '--db-path') {
      const value = argv[i + 1];

      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }

      sqlitePath = value;
      i += 1;
      continue;
    }

    if (
      arg === '--heartbeat-interval-ms' ||
      arg === '--heartbeat-timeout-ms' ||
      arg === '--timeout-ms' ||
      arg === '--idle-timeout-ms' ||
      arg === '--terminate-grace-ms'
    ) {
      const value = argv[i + 1];

      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }

      if (arg === '--heartbeat-interval-ms') {
        heartbeatIntervalMs = value;
      } else if (arg === '--heartbeat-timeout-ms' || arg === '--timeout-ms' || arg === '--idle-timeout-ms') {
        heartbeatTimeoutMs = value;
      } else {
        terminateGraceMs = value;
      }

      i += 1;
      continue;
    }

    promptParts.push(arg);
  }

  return {
    resume,
    session,
    sqlitePath,
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    terminateGraceMs,
    prompt: promptParts.join(' ').trim(),
  };
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const prompt = cli.prompt || DEFAULT_PROMPT;

  const result = await invoke('kimi-coding', 'k2p5', prompt, {
    resume: cli.resume,
    session: cli.session,
    sqlitePath: cli.sqlitePath || undefined,
    heartbeatIntervalMs: cli.heartbeatIntervalMs,
    heartbeatTimeoutMs: cli.heartbeatTimeoutMs,
    terminateGraceMs: cli.terminateGraceMs,
  });

  console.log('run id:', result.runId);
  console.log('sqlite db:', result.databasePath);
  console.log('exit code:', result.code);
  console.log('signal:', result.signal);
  console.log('final reply:', result.reply);
  console.log('session path:', result.sessionPath);
}

main().catch((error) => {
  printInvokeError(error);
  process.exit(error.exitCode || 1);
});
