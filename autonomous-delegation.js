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

const DEFAULT_AGENT_REGISTRY = {
  coordinator: {
    title: 'Coordinator agent',
    description: 'Understands the user request, decides whether to answer directly or delegate to a specialist.',
  },
  planner: {
    title: 'Planner agent',
    description: 'Breaks a task into steps, scope, risks, and an execution plan.',
  },
  coder: {
    title: 'Coder agent',
    description: 'Focuses on implementation details, code changes, and validation steps.',
  },
  reviewer: {
    title: 'Reviewer agent',
    description: 'Looks for bugs, regressions, missing tests, and quality risks.',
  },
  summarizer: {
    title: 'Summarizer agent',
    description: 'Combines prior outputs into a concise final answer for the caller.',
  },
};

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
    entryAgent: '',
    maxHops: undefined,
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
      arg === '--entry-agent' ||
      arg === '--max-hops' ||
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
      } else if (arg === '--entry-agent') {
        result.entryAgent = value;
      } else if (arg === '--max-hops') {
        result.maxHops = value;
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

function sanitizeAgentName(agentName) {
  return String(agentName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '');
}

function normalizeAgentName(agentName, registry) {
  const normalized = sanitizeAgentName(agentName);
  return normalized && registry[normalized] ? normalized : '';
}

function listAgentsText(registry) {
  return Object.entries(registry)
    .map(([name, details]) => `- ${name}: ${details.description}`)
    .join('\n');
}

function formatHistory(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return 'No previous turns.';
  }

  return history
    .map((item, index) => {
      const lines = [
        `${index + 1}. agent=${item.agent}`,
        `   action=${item.action}`,
      ];

      if (item.target) {
        lines.push(`   target=${item.target}`);
      }

      if (item.reason) {
        lines.push(`   reason=${item.reason}`);
      }

      if (item.summary) {
        lines.push(`   summary=${item.summary}`);
      }

      if (item.final) {
        lines.push(`   final=${item.final}`);
      }

      return lines.join('\n');
    })
    .join('\n');
}

function clipText(text, maxLength = 400) {
  const value = String(text || '').trim();

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function buildAgentPrompt({ currentAgent, registry, userPrompt, history, currentMessage, remainingHops }) {
  const agentProfile = registry[currentAgent];

  return [
    'You are participating in a local autonomous multi-agent delegation runtime.',
    `Current agent: ${currentAgent}`,
    `Role: ${agentProfile ? agentProfile.description : 'General specialist.'}`,
    '',
    'Your job is to decide the NEXT action yourself.',
    'You must output exactly one JSON object and nothing else.',
    '',
    'Allowed JSON forms:',
    '{"action":"delegate","target":"planner|coder|reviewer|summarizer|coordinator","message":"message for the next agent","reason":"why delegation helps","summary":"one short summary of what you learned"}',
    '{"action":"final","final":"final answer for the original caller","reason":"why this is complete","summary":"one short summary of the completed work"}',
    '',
    'Rules:',
    '- Use "delegate" only when another agent would materially help.',
    '- Use "final" when you can answer the original caller well enough now.',
    '- If you are coordinator and the task is not trivial, prefer delegating to a specialist before finalizing.',
    '- Never delegate to yourself. If you are already the best agent for this turn, use "final".',
    '- Keep "message" self-contained for the next agent.',
    '- Keep "summary" concise.',
    '- Do not invent new action names. Only use "delegate" or "final".',
    '- Do not wrap JSON in markdown fences.',
    '- Do not modify files or run tools. This is reasoning-only.',
    '',
    `Remaining hops after this turn: ${remainingHops}`,
    '',
    'Available agents:',
    listAgentsText(registry),
    '',
    'Original user request:',
    userPrompt,
    '',
    'Current message you are responding to:',
    currentMessage,
    '',
    'Prior delegation history:',
    formatHistory(history),
  ].join('\n');
}

function extractJsonCandidate(text) {
  const raw = String(text || '').trim();
  let candidate = raw;

  if (!raw) {
    throw new Error('Empty agent reply');
  }

  if (candidate.startsWith('```')) {
    const codeBlockMatch = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

    if (codeBlockMatch) {
      candidate = codeBlockMatch[1].trim();
    }
  }

  if (candidate.startsWith('{') && candidate.endsWith('}')) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {}
  }

  const firstBrace = candidate.indexOf('{');

  if (firstBrace !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = firstBrace; i < candidate.length; i += 1) {
      const char = candidate[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }

        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{') {
        depth += 1;
        continue;
      }

      if (char === '}') {
        depth -= 1;

        if (depth === 0) {
          return candidate.slice(firstBrace, i + 1);
        }
      }
    }
  }

  throw new Error('No JSON object found in agent reply');
}

function parseAgentDecision(text, registry, options = {}) {
  const allowTextFallback = options.allowTextFallback !== false;
  let payload;

  try {
    payload = JSON.parse(extractJsonCandidate(text));
  } catch (error) {
    if (!allowTextFallback) {
      throw error;
    }

    return {
      action: 'final',
      final: String(text || '').trim(),
      reason: 'fallback_non_json_reply',
      summary: clipText(text, 160),
      raw: text,
      fallback: true,
    };
  }

  const action = String(payload.action || '').trim().toLowerCase();
  const normalizedAction =
    action === 'handoff' || action === 'route' || action === 'transfer'
      ? 'delegate'
      : action === 'answer' || action === 'respond' || action === 'complete' || action === 'done'
        ? 'final'
        : action;

  if (normalizedAction === 'delegate') {
    const target = normalizeAgentName(payload.target || payload.nextAgent || payload.next_agent, registry);
    const message = String(payload.message || payload.prompt || '').trim();
    const reason = String(payload.reason || '').trim();
    const summary = String(payload.summary || '').trim();

    if (!target) {
      throw new Error('Delegation decision is missing a valid target');
    }

    if (!message) {
      throw new Error('Delegation decision is missing message');
    }

    return {
      action: 'delegate',
      target,
      message,
      reason,
      summary,
      raw: text,
      fallback: false,
    };
  }

  if (normalizedAction === 'final') {
    const final = String(payload.final || payload.output || payload.answer || payload.message || '').trim();
    const reason = String(payload.reason || '').trim();
    const summary = String(payload.summary || '').trim();

    if (!final) {
      throw new Error('Final decision is missing final text');
    }

    return {
      action: 'final',
      final,
      reason,
      summary,
      raw: text,
      fallback: false,
    };
  }

  if (!normalizedAction) {
    const target = normalizeAgentName(payload.target || payload.nextAgent || payload.next_agent, registry);
    const message = String(payload.message || payload.prompt || '').trim();
    const final = String(payload.final || payload.output || payload.answer || '').trim();

    if (target && message) {
      return {
        action: 'delegate',
        target,
        message,
        reason: String(payload.reason || '').trim(),
        summary: String(payload.summary || '').trim(),
        raw: text,
        fallback: false,
      };
    }

    if (final) {
      return {
        action: 'final',
        final,
        reason: String(payload.reason || '').trim(),
        summary: String(payload.summary || '').trim(),
        raw: text,
        fallback: false,
      };
    }
  }

  throw new Error(`Unsupported decision action: ${payload.action}`);
}

function printAgentBanner(index, agentName) {
  process.stdout.write(`\n=== hop ${index + 1}: ${agentName} ===\n`);
}

async function runAutonomousFlow(userPrompt, options = {}) {
  if (!userPrompt || !String(userPrompt).trim()) {
    throw new Error('Prompt is required');
  }

  const registry = options.agentRegistry || DEFAULT_AGENT_REGISTRY;
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
  const maxHops = resolveIntegerSetting(options.maxHops, '', 6, 'maxHops');
  const entryAgent = normalizeAgentName(options.entryAgent || 'coordinator', registry);
  const streamOutput = options.streamOutput !== false;
  const workflowId = options.workflowId || randomUUID();
  const sessionPrefix = sanitizeSessionName(options.sessionPrefix || `autonomous-${workflowId}`) || `autonomous-${workflowId}`;
  const rootTaskId = options.rootTaskId || createTaskId('task');
  const store = createSqliteRunStore({ agentDir, sqlitePath });
  const history = [];
  const turns = [];
  let currentAgent = entryAgent;
  let currentMessage = userPrompt;
  let parentRunId = null;

  if (!currentAgent) {
    throw new Error(`Unknown entry agent: ${options.entryAgent}`);
  }

  store.createTask({
    taskId: rootTaskId,
    kind: 'autonomous_delegation_flow',
    title: 'Autonomous local delegation',
    status: 'running',
    inputText: userPrompt,
    metadata: {
      workflowId,
      entryAgent: currentAgent,
      maxHops,
      mode: 'agent_decides_delegation',
    },
    startedAt: nowIso(),
  });
  store.appendTaskEvent(rootTaskId, 'workflow_started', {
    workflowId,
    entryAgent: currentAgent,
    maxHops,
    provider,
    model,
  });

  try {
    for (let hop = 0; hop < maxHops; hop += 1) {
      const remainingHops = maxHops - hop - 1;
      const taskId = createTaskId('task');
      const session = `${sessionPrefix}-${hop + 1}-${currentAgent}`;
      const prompt = buildAgentPrompt({
        currentAgent,
        registry,
        userPrompt,
        history,
        currentMessage,
        remainingHops,
      });

      store.createTask({
        taskId,
        parentTaskId: rootTaskId,
        parentRunId,
        kind: 'autonomous_agent_turn',
        title: `${currentAgent} turn ${hop + 1}`,
        status: 'queued',
        assignedAgent: 'pi',
        assignedRole: currentAgent,
        provider,
        model,
        requestedSession: session,
        inputText: currentMessage,
        metadata: {
          workflowId,
          hop,
          delegatedFromAgent: history.length > 0 ? history[history.length - 1].agent : null,
          delegatedFromTaskId: turns.length > 0 ? turns[turns.length - 1].taskId : null,
        },
      });
      store.appendTaskEvent(taskId, 'task_queued', {
        hop,
        currentAgent,
        parentRunId,
      });

      if (streamOutput) {
        printAgentBanner(hop, currentAgent);
      }

      const handle = startRun(provider, model, prompt, {
        thinking,
        agentDir,
        sqlitePath,
        heartbeatIntervalMs,
        heartbeatTimeoutMs,
        terminateGraceMs,
        session,
        streamOutput,
        parentRunId,
        taskId,
        taskKind: 'autonomous_agent_turn',
        taskRole: currentAgent,
        metadata: {
          workflowId,
          rootTaskId,
          hop,
          currentAgent,
        },
      });

      store.updateTask(taskId, {
        status: 'running',
        parentRunId,
        runId: handle.runId,
        sessionPath: handle.sessionPath,
        startedAt: nowIso(),
      });
      store.appendTaskEvent(taskId, 'task_started', {
        hop,
        currentAgent,
        runId: handle.runId,
        sessionPath: handle.sessionPath,
      });

      handle.on('heartbeat', (event) => {
        store.appendTaskEvent(taskId, 'task_heartbeat', {
          count: event.count,
          reason: event.payload && event.payload.reason ? event.payload.reason : null,
        });
      });

      handle.on('run_terminating', (event) => {
        store.appendTaskEvent(taskId, 'task_terminating', event.reason || null);
      });

      let result;

      try {
        result = await handle.resultPromise;
      } catch (error) {
        store.updateTask(taskId, {
          status: 'failed',
          errorMessage: error.message,
          endedAt: nowIso(),
        });
        store.appendTaskEvent(taskId, 'task_failed', {
          hop,
          currentAgent,
          runId: error.runId || handle.runId || null,
          errorMessage: error.message,
        });
        throw error;
      }

      let decision;

      try {
        decision = parseAgentDecision(result.reply, registry, {
          allowTextFallback: options.allowTextFallback !== false,
        });
      } catch (error) {
        store.updateTask(taskId, {
          status: 'failed',
          runId: result.runId || handle.runId || null,
          sessionPath: result.sessionPath,
          outputText: result.reply,
          errorMessage: error.message,
          endedAt: nowIso(),
        });
        store.appendTaskEvent(taskId, 'decision_parse_failed', {
          hop,
          currentAgent,
          runId: result.runId || null,
          errorMessage: error.message,
        });
        throw error;
      }

      if (decision.action === 'delegate' && decision.target === currentAgent) {
        const error = new Error(`Self-delegation is not allowed for agent "${currentAgent}"`);

        store.updateTask(taskId, {
          status: 'failed',
          runId: result.runId || handle.runId || null,
          sessionPath: result.sessionPath,
          outputText: result.reply,
          errorMessage: error.message,
          endedAt: nowIso(),
        });
        store.appendTaskEvent(taskId, 'decision_invalid_self_delegate', {
          hop,
          currentAgent,
          runId: result.runId || null,
          target: decision.target,
        });
        throw error;
      }

      store.updateTask(taskId, {
        status: 'succeeded',
        runId: result.runId || handle.runId || null,
        sessionPath: result.sessionPath,
        outputText: result.reply,
        endedAt: nowIso(),
        artifactSummary: {
          action: decision.action,
          target: decision.target || null,
          fallback: Boolean(decision.fallback),
        },
      });
      store.appendTaskEvent(taskId, 'decision_parsed', {
        hop,
        currentAgent,
        action: decision.action,
        target: decision.target || null,
        fallback: Boolean(decision.fallback),
      });
      store.addArtifact(taskId, {
        kind: 'text',
        name: `${currentAgent}-turn-${hop + 1}.txt`,
        mimeType: 'text/plain',
        contentText: result.reply,
        metadata: {
          workflowId,
          hop,
          currentAgent,
          decision,
        },
      });

      turns.push({
        taskId,
        runId: result.runId || null,
        currentAgent,
        heartbeatCount: result.heartbeatCount || 0,
        rawReply: result.reply,
        decision,
      });
      history.push({
        agent: currentAgent,
        action: decision.action,
        target: decision.target || null,
        reason: decision.reason || '',
        summary: decision.summary || clipText(result.reply, 160),
        final: decision.final || '',
      });

      if (decision.action === 'final') {
        store.appendTaskEvent(rootTaskId, 'agent_decided_final', {
          hop,
          currentAgent,
          taskId,
          runId: result.runId || null,
        });
        store.updateTask(rootTaskId, {
          status: 'succeeded',
          outputText: decision.final,
          endedAt: nowIso(),
          artifactSummary: {
            finalAgent: currentAgent,
            hopCount: hop + 1,
          },
        });
        store.addArtifact(rootTaskId, {
          kind: 'text',
          name: 'autonomous-final-reply.txt',
          mimeType: 'text/plain',
          contentText: decision.final,
          metadata: {
            workflowId,
            finalAgent: currentAgent,
          },
        });
        store.appendTaskEvent(rootTaskId, 'workflow_succeeded', {
          workflowId,
          hopCount: hop + 1,
          finalAgent: currentAgent,
        });

        return {
          workflowId,
          taskId: rootTaskId,
          databasePath: store.databasePath,
          finalReply: decision.final,
          turns,
          history,
        };
      }

      store.appendTaskEvent(rootTaskId, 'agent_delegated', {
        hop,
        fromAgent: currentAgent,
        toAgent: decision.target,
        taskId,
        runId: result.runId || null,
      });

      currentAgent = decision.target;
      currentMessage = decision.message;
      parentRunId = result.runId || parentRunId;
    }

    const error = new Error(`Autonomous delegation exceeded maxHops (${maxHops}) without reaching a final answer`);
    store.updateTask(rootTaskId, {
      status: 'failed',
      errorMessage: error.message,
      endedAt: nowIso(),
    });
    store.appendTaskEvent(rootTaskId, 'workflow_exhausted', {
      workflowId,
      maxHops,
    });
    throw error;
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
  DEFAULT_AGENT_REGISTRY,
  parseCliArgs,
  parseAgentDecision,
  runAutonomousFlow,
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
      'Usage: node autonomous-delegation.js [--provider name] [--model name] [--thinking level] [--db-path path] [--session-prefix name] [--entry-agent name] [--max-hops n] [--heartbeat-interval-ms n] [--heartbeat-timeout-ms n] [--terminate-grace-ms n] [--quiet] "Analyze this task"'
    );
    process.exit(1);
  }

  runAutonomousFlow(cli.prompt, {
    provider: cli.provider,
    model: cli.model,
    thinking: cli.thinking,
    sqlitePath: cli.sqlitePath,
    sessionPrefix: cli.sessionPrefix,
    entryAgent: cli.entryAgent,
    maxHops: cli.maxHops,
    heartbeatIntervalMs: cli.heartbeatIntervalMs,
    heartbeatTimeoutMs: cli.heartbeatTimeoutMs,
    terminateGraceMs: cli.terminateGraceMs,
    streamOutput: !cli.quiet,
  })
    .then((result) => {
      console.log('workflow id:', result.workflowId);
      console.log('root task id:', result.taskId);
      console.log('sqlite db:', result.databasePath);
      console.log('turn count:', result.turns.length);
      console.log('final reply:', result.finalReply);
    })
    .catch((error) => {
      printInvokeError(error);
      process.exit(error.exitCode || 1);
    });
}
