const { randomUUID } = require('node:crypto');
const {
  DEFAULT_AGENT_DIR,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_TERMINATE_GRACE_MS,
  DEFAULT_THINKING,
  printInvokeError,
  resolveIntegerSetting,
  resolveIntegerSettingCandidates,
  resolveSetting,
  sanitizeSessionName,
  startRun,
} = require('./minimal-pi');
const { createSqliteRunStore } = require('./sqlite-store');

const DEFAULT_WORKFLOW = [
  {
    role: 'planner',
    title: 'Planner agent',
    buildPrompt(context) {
      return [
        'You are the planner agent in a local multi-agent workflow.',
        'Create a concise implementation plan for the request below.',
        'Focus on scope, likely files or modules, and key risks.',
        '',
        'User request:',
        context.userPrompt,
      ].join('\n');
    },
  },
  {
    role: 'coder',
    title: 'Coder agent',
    buildPrompt(context) {
      return [
        'You are the coder agent in a local multi-agent workflow.',
        'Use the planner output to produce an implementation-oriented response.',
        'Be explicit about assumptions, concrete code changes, and validation steps.',
        '',
        'User request:',
        context.userPrompt,
        '',
        'Planner output:',
        context.getStageReply('planner'),
      ].join('\n');
    },
  },
  {
    role: 'reviewer',
    title: 'Reviewer agent',
    buildPrompt(context) {
      return [
        'You are the reviewer agent in a local multi-agent workflow.',
        'Review the proposed implementation for bugs, regressions, and missing tests.',
        'End with a short final recommendation.',
        '',
        'User request:',
        context.userPrompt,
        '',
        'Planner output:',
        context.getStageReply('planner'),
        '',
        'Coder output:',
        context.getStageReply('coder'),
      ].join('\n');
    },
  },
];

function nowIso() {
  return new Date().toISOString();
}

function createTaskId(prefix = 'task') {
  return `${prefix}-${randomUUID()}`;
}

function parseCliArgs(argv) {
  const promptParts = [];
  const result = {
    provider: '',
    model: '',
    thinking: '',
    sqlitePath: '',
    sessionPrefix: '',
    heartbeatIntervalMs: undefined,
    heartbeatTimeoutMs: undefined,
    terminateGraceMs: undefined,
    quiet: false,
    prompt: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--quiet') {
      result.quiet = true;
      continue;
    }

    if (
      arg === '--provider' ||
      arg === '--model' ||
      arg === '--thinking' ||
      arg === '--db-path' ||
      arg === '--session-prefix' ||
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

      if (arg === '--provider') {
        result.provider = value;
      } else if (arg === '--model') {
        result.model = value;
      } else if (arg === '--thinking') {
        result.thinking = value;
      } else if (arg === '--db-path') {
        result.sqlitePath = value;
      } else if (arg === '--session-prefix') {
        result.sessionPrefix = value;
      } else if (arg === '--heartbeat-interval-ms') {
        result.heartbeatIntervalMs = value;
      } else if (arg === '--heartbeat-timeout-ms' || arg === '--timeout-ms' || arg === '--idle-timeout-ms') {
        result.heartbeatTimeoutMs = value;
      } else if (arg === '--terminate-grace-ms') {
        result.terminateGraceMs = value;
      }

      i += 1;
      continue;
    }

    promptParts.push(arg);
  }

  result.prompt = promptParts.join(' ').trim();
  return result;
}

function printStageBanner(stageRole) {
  process.stdout.write(`\n=== ${stageRole} ===\n`);
}

async function runSupervisorFlow(userPrompt, options = {}) {
  if (!userPrompt || !String(userPrompt).trim()) {
    throw new Error('Prompt is required');
  }

  const provider = resolveSetting(options.provider, process.env.PI_PROVIDER, DEFAULT_PROVIDER);
  const model = resolveSetting(options.model, process.env.PI_MODEL, DEFAULT_MODEL);
  const thinking = resolveSetting(options.thinking, process.env.PI_THINKING, DEFAULT_THINKING);
  const agentDir = resolveSetting(options.agentDir, process.env.PI_CODING_AGENT_DIR, DEFAULT_AGENT_DIR);
  const sqlitePath = resolveSetting(options.sqlitePath, process.env.PI_SQLITE_PATH, '');
  const heartbeatIntervalMs = resolveIntegerSettingCandidates(
    [options.heartbeatIntervalMs, process.env.PI_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_INTERVAL_MS],
    'heartbeatIntervalMs'
  );
  const heartbeatTimeoutMs = resolveIntegerSettingCandidates(
    [
      options.heartbeatTimeoutMs,
      process.env.PI_HEARTBEAT_TIMEOUT_MS,
      process.env.PI_IDLE_TIMEOUT_MS,
      process.env.PI_TIMEOUT_MS,
      DEFAULT_HEARTBEAT_TIMEOUT_MS,
    ],
    'heartbeatTimeoutMs'
  );
  const terminateGraceMs = resolveIntegerSetting(
    options.terminateGraceMs,
    process.env.PI_TERMINATE_GRACE_MS,
    DEFAULT_TERMINATE_GRACE_MS,
    'terminateGraceMs'
  );
  const workflowId = options.workflowId || randomUUID();
  const sessionPrefix = sanitizeSessionName(options.sessionPrefix || `workflow-${workflowId}`) || `workflow-${workflowId}`;
  const rootTaskId = options.rootTaskId || createTaskId('task');
  const streamOutput = options.streamOutput !== false;
  const store = createSqliteRunStore({ agentDir, sqlitePath });
  const stageResults = [];
  let parentRunId = null;

  store.createTask({
    taskId: rootTaskId,
    kind: 'supervisor_workflow',
    title: 'planner -> coder -> reviewer',
    status: 'running',
    inputText: userPrompt,
    metadata: {
      workflowId,
      workflow: DEFAULT_WORKFLOW.map((stage) => stage.role),
    },
    startedAt: nowIso(),
  });
  store.appendTaskEvent(rootTaskId, 'workflow_started', {
    workflowId,
    provider,
    model,
    thinking,
  });

  try {
    for (const stage of DEFAULT_WORKFLOW) {
      const stageTaskId = createTaskId('task');
      const stageSession = `${sessionPrefix}-${stage.role}`;
      const stagePrompt = stage.buildPrompt({
        userPrompt,
        getStageReply(role) {
          const match = stageResults.find((item) => item.role === role);
          return match ? match.reply : '';
        },
      });

      store.createTask({
        taskId: stageTaskId,
        parentTaskId: rootTaskId,
        parentRunId,
        kind: 'local_agent',
        title: stage.title,
        status: 'queued',
        assignedAgent: 'pi',
        assignedRole: stage.role,
        provider,
        model,
        requestedSession: stageSession,
        inputText: stagePrompt,
        metadata: {
          workflowId,
          stage: stage.role,
        },
      });
      store.appendTaskEvent(stageTaskId, 'task_queued', {
        role: stage.role,
        parentRunId,
      });

      if (streamOutput) {
        printStageBanner(stage.role);
      }

      const handle = startRun(provider, model, stagePrompt, {
        thinking,
        agentDir,
        sqlitePath,
        heartbeatIntervalMs,
        heartbeatTimeoutMs,
        terminateGraceMs,
        session: stageSession,
        streamOutput,
        parentRunId,
        taskId: stageTaskId,
        taskKind: 'local_agent',
        taskRole: stage.role,
        metadata: {
          workflowId,
          rootTaskId,
          stage: stage.role,
        },
      });

      store.updateTask(stageTaskId, {
        status: 'running',
        parentRunId,
        runId: handle.runId,
        sessionPath: handle.sessionPath,
        startedAt: nowIso(),
      });
      store.appendTaskEvent(stageTaskId, 'task_started', {
        role: stage.role,
        runId: handle.runId,
        sessionPath: handle.sessionPath,
      });

      handle.on('heartbeat', (event) => {
        store.appendTaskEvent(stageTaskId, 'task_heartbeat', {
          count: event.count,
          reason: event.payload && event.payload.reason ? event.payload.reason : null,
        });
      });

      handle.on('run_terminating', (event) => {
        store.appendTaskEvent(stageTaskId, 'task_terminating', event.reason || null);
      });

      let result;

      try {
        result = await handle.resultPromise;
      } catch (error) {
        store.updateTask(stageTaskId, {
          status: 'failed',
          errorMessage: error.message,
          endedAt: nowIso(),
        });
        store.appendTaskEvent(stageTaskId, 'task_failed', {
          errorMessage: error.message,
          runId: error.runId || handle.runId || null,
        });
        throw error;
      }

      parentRunId = result.runId || parentRunId;
      stageResults.push({
        role: stage.role,
        taskId: stageTaskId,
        runId: result.runId || null,
        sessionPath: result.sessionPath,
        heartbeatCount: result.heartbeatCount || 0,
        reply: result.reply,
      });

      store.updateTask(stageTaskId, {
        status: 'succeeded',
        runId: result.runId || handle.runId || null,
        sessionPath: result.sessionPath,
        outputText: result.reply,
        endedAt: nowIso(),
        artifactSummary: {
          kind: 'text/plain',
          name: `${stage.role}-reply.txt`,
        },
      });
      store.appendTaskEvent(stageTaskId, 'task_succeeded', {
        role: stage.role,
        runId: result.runId || null,
        heartbeatCount: result.heartbeatCount || 0,
        replyLength: result.reply.length,
      });
      store.addArtifact(stageTaskId, {
        kind: 'text',
        name: `${stage.role}-reply.txt`,
        mimeType: 'text/plain',
        contentText: result.reply,
        metadata: {
          workflowId,
          stage: stage.role,
        },
      });
      store.appendTaskEvent(rootTaskId, 'stage_completed', {
        stage: stage.role,
        taskId: stageTaskId,
        runId: result.runId || null,
      });
    }

    const finalStage = stageResults.length > 0 ? stageResults[stageResults.length - 1] : null;
    const finalReply = finalStage ? finalStage.reply : '';

    store.updateTask(rootTaskId, {
      status: 'succeeded',
      outputText: finalReply,
      endedAt: nowIso(),
      artifactSummary: {
        finalStage: finalStage ? finalStage.role : null,
        stageTaskIds: stageResults.map((stage) => stage.taskId),
      },
    });
    store.addArtifact(rootTaskId, {
      kind: 'text',
      name: 'workflow-final-reply.txt',
      mimeType: 'text/plain',
      contentText: finalReply,
      metadata: {
        workflowId,
        sourceStage: finalStage ? finalStage.role : null,
      },
    });
    store.appendTaskEvent(rootTaskId, 'workflow_succeeded', {
      workflowId,
      stageTaskIds: stageResults.map((stage) => stage.taskId),
    });

    return {
      workflowId,
      taskId: rootTaskId,
      databasePath: store.databasePath,
      stages: stageResults,
      finalReply,
    };
  } catch (error) {
    store.updateTask(rootTaskId, {
      status: 'failed',
      errorMessage: error.message,
      endedAt: nowIso(),
    });
    store.appendTaskEvent(rootTaskId, 'workflow_failed', {
      workflowId,
      errorMessage: error.message,
    });
    throw error;
  } finally {
    store.close();
  }
}

module.exports = {
  DEFAULT_WORKFLOW,
  parseCliArgs,
  runSupervisorFlow,
};

if (require.main === module) {
  let cli;

  try {
    cli = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  if (!cli.prompt) {
    console.error(
      'Usage: node supervisor.js [--provider name] [--model name] [--thinking level] [--db-path path] [--session-prefix name] [--heartbeat-interval-ms n] [--heartbeat-timeout-ms n] [--terminate-grace-ms n] [--quiet] "Implement feature X"'
    );
    process.exit(1);
  }

  runSupervisorFlow(cli.prompt, {
    provider: cli.provider,
    model: cli.model,
    thinking: cli.thinking,
    sqlitePath: cli.sqlitePath,
    sessionPrefix: cli.sessionPrefix,
    heartbeatIntervalMs: cli.heartbeatIntervalMs,
    heartbeatTimeoutMs: cli.heartbeatTimeoutMs,
    terminateGraceMs: cli.terminateGraceMs,
    streamOutput: !cli.quiet,
  })
    .then((result) => {
      console.log('workflow id:', result.workflowId);
      console.log('root task id:', result.taskId);
      console.log('sqlite db:', result.databasePath);
      console.log('final reply:', result.finalReply);
    })
    .catch((error) => {
      printInvokeError(error);
      process.exit(error.exitCode || 1);
    });
}
