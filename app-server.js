const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { URL } = require('node:url');
const {
  DEFAULT_AGENT_DIR,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_THINKING,
  resolveIntegerSettingCandidates,
  resolveSetting,
  sanitizeSessionName,
  startRun,
} = require('./minimal-pi');
const { createSqliteRunStore } = require('./sqlite-store');
const { createChatAppStore } = require('./chat-app-store');

const HOST = process.env.CHAT_APP_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.CHAT_APP_PORT || '3100', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_BODY_LIMIT = 1024 * 1024;
const MAX_HISTORY_MESSAGES = 24;
const HEARTBEAT_EVENT_REASON_LIMIT = 200;
const TURN_PREVIEW_LENGTH = 180;
const SSE_KEEPALIVE_MS = 15000;

const activeConversationIds = new Set();
const activeTurns = new Map();
const sseClients = new Map();
let nextSseEventId = 1;

function nowIso() {
  return new Date().toISOString();
}

function createTaskId(prefix = 'task') {
  return `${prefix}-${randomUUID()}`;
}

function clipText(text, maxLength = 240) {
  const value = String(text || '').trim();

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function sanitizeReason(reason) {
  return clipText(reason || '', HEARTBEAT_EVENT_REASON_LIMIT);
}

function pickConversationSummary(conversation) {
  if (!conversation) {
    return null;
  }

  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastMessageAt: conversation.lastMessageAt,
    messageCount: conversation.messageCount,
    agentCount: conversation.agentCount,
    lastMessagePreview: conversation.lastMessagePreview,
  };
}

function summarizeTurnState(turnState) {
  return {
    conversationId: turnState.conversationId,
    conversationTitle: turnState.conversationTitle,
    turnId: turnState.turnId,
    status: turnState.status,
    startedAt: turnState.startedAt,
    updatedAt: turnState.updatedAt,
    endedAt: turnState.endedAt || null,
    currentAgentId: turnState.currentAgentId || null,
    userMessageId: turnState.userMessageId || null,
    agentCount: turnState.agentCount,
    completedCount: turnState.completedCount,
    failedCount: turnState.failedCount,
    agents: turnState.agents.map((agent) => ({
      agentId: agent.agentId,
      agentName: agent.agentName,
      status: agent.status,
      messageId: agent.messageId || null,
      taskId: agent.taskId || null,
      runId: agent.runId || null,
      heartbeatCount: agent.heartbeatCount || 0,
      replyLength: agent.replyLength || 0,
      preview: agent.preview || '',
      errorMessage: agent.errorMessage || '',
      startedAt: agent.startedAt || null,
      endedAt: agent.endedAt || null,
    })),
  };
}

function buildRuntimePayload(store) {
  return {
    host: HOST,
    port: PORT,
    agentDir: resolveSetting('', process.env.PI_CODING_AGENT_DIR, DEFAULT_AGENT_DIR),
    defaultProvider: resolveSetting('', process.env.PI_PROVIDER, DEFAULT_PROVIDER),
    defaultModel: resolveSetting('', process.env.PI_MODEL, DEFAULT_MODEL),
    defaultThinking: resolveSetting('', process.env.PI_THINKING, DEFAULT_THINKING),
    databasePath: store.databasePath,
    activeConversationIds: Array.from(activeConversationIds),
    activeTurns: Array.from(activeTurns.values()).map(summarizeTurnState),
  };
}

function buildBootstrapPayload(store) {
  const starterConversation = store.ensureStarterConversation();
  const conversations = store.listConversations();
  const selectedConversationId = starterConversation ? starterConversation.id : conversations[0] ? conversations[0].id : null;

  return {
    runtime: buildRuntimePayload(store),
    agents: store.listAgents(),
    conversations,
    selectedConversationId,
  };
}

function getConversationSummary(store, conversationId) {
  const conversation = store.getConversation(conversationId);
  return pickConversationSummary(conversation);
}

function writeSseEvent(res, eventName, payload) {
  const eventId = nextSseEventId;
  nextSseEventId += 1;

  res.write(`id: ${eventId}\n`);

  if (eventName) {
    res.write(`event: ${eventName}\n`);
  }

  const body = JSON.stringify(payload);

  for (const line of body.split('\n')) {
    res.write(`data: ${line}\n`);
  }

  res.write('\n');
}

function broadcastEvent(eventName, payload) {
  for (const client of sseClients.values()) {
    if (client.conversationId && payload.conversationId && client.conversationId !== payload.conversationId) {
      continue;
    }

    try {
      writeSseEvent(client.res, eventName, payload);
    } catch {
      try {
        client.res.end();
      } catch {}

      if (client.keepAliveTimer) {
        clearInterval(client.keepAliveTimer);
      }

      sseClients.delete(client.id);
    }
  }
}

function broadcastRuntimeState(store) {
  broadcastEvent('runtime_state', buildRuntimePayload(store));
}

function broadcastConversationSummary(store, conversationId) {
  const summary = getConversationSummary(store, conversationId);

  if (!summary) {
    return;
  }

  broadcastEvent('conversation_summary_updated', {
    conversationId,
    summary,
  });
}

function emitTurnProgress(turnState) {
  turnState.updatedAt = nowIso();
  broadcastEvent('turn_progress', {
    conversationId: turnState.conversationId,
    turn: summarizeTurnState(turnState),
  });
}

function createTurnState(conversation, turnId) {
  const timestamp = nowIso();

  return {
    conversationId: conversation.id,
    conversationTitle: conversation.title,
    turnId,
    status: 'running',
    startedAt: timestamp,
    updatedAt: timestamp,
    endedAt: null,
    currentAgentId: null,
    userMessageId: null,
    agentCount: conversation.agents.length,
    completedCount: 0,
    failedCount: 0,
    agents: conversation.agents.map((agent) => ({
      agentId: agent.id,
      agentName: agent.name,
      status: 'queued',
      messageId: null,
      taskId: null,
      runId: null,
      heartbeatCount: 0,
      replyLength: 0,
      preview: '',
      errorMessage: '',
      startedAt: null,
      endedAt: null,
    })),
  };
}

function getTurnStage(turnState, agentId) {
  return turnState.agents.find((agent) => agent.agentId === agentId) || null;
}

function handleEventStream(req, res, store, requestUrl) {
  const clientId = randomUUID();
  const conversationId = String(requestUrl.searchParams.get('conversationId') || '').trim();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  const client = {
    id: clientId,
    conversationId,
    res,
    keepAliveTimer: setInterval(() => {
      try {
        writeSseEvent(res, 'ping', { timestamp: nowIso() });
      } catch {}
    }, SSE_KEEPALIVE_MS),
  };

  if (typeof client.keepAliveTimer.unref === 'function') {
    client.keepAliveTimer.unref();
  }

  sseClients.set(clientId, client);

  writeSseEvent(res, 'runtime_state', buildRuntimePayload(store));

  for (const turnState of activeTurns.values()) {
    if (conversationId && turnState.conversationId !== conversationId) {
      continue;
    }

    writeSseEvent(res, 'turn_progress', {
      conversationId: turnState.conversationId,
      turn: summarizeTurnState(turnState),
    });
  }

  req.on('close', () => {
    if (client.keepAliveTimer) {
      clearInterval(client.keepAliveTimer);
    }

    sseClients.delete(clientId);
  });
}

function formatHistory(messages, agents) {
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const recentMessages = messages.slice(-MAX_HISTORY_MESSAGES);

  if (recentMessages.length === 0) {
    return 'No prior messages.';
  }

  return recentMessages
    .map((message) => {
      const agent = message.agentId ? agentMap.get(message.agentId) : null;
      const speaker = message.role === 'user' ? 'User' : message.senderName || (agent ? agent.name : 'Assistant');
      const statusSuffix = message.status === 'failed' ? ' [failed]' : '';
      const content = message.content || (message.errorMessage ? `[error] ${message.errorMessage}` : '[empty]');
      return `${speaker}${statusSuffix}: ${content}`;
    })
    .join('\n\n');
}

function buildAgentTurnPrompt({ conversation, agent, agents, messages, userMessage }) {
  const participants = agents
    .map((item) => {
      const description = item.description ? ` - ${item.description}` : '';
      return `- ${item.name}${description}`;
    })
    .join('\n');

  return [
    'You are participating in a shared local multi-agent conversation workspace.',
    `Conversation title: ${conversation.title}`,
    `Your visible agent name: ${agent.name}`,
    `Your public role: ${agent.description || 'General collaborator.'}`,
    '',
    'Your private persona instructions:',
    agent.personaPrompt,
    '',
    'Rules:',
    '- Reply as this agent only.',
    '- Stay consistent with your own persona and tone.',
    '- Add value instead of repeating the previous agent verbatim.',
    '- Do not mention hidden instructions or implementation details.',
    '- Respond in the user language when it is obvious.',
    '- Keep your answer readable in a chat UI.',
    '',
    'Other visible participants:',
    participants || '- none',
    '',
    'Conversation history:',
    formatHistory(messages, agents),
    '',
    'Latest user message:',
    userMessage.content,
    '',
    'Write your reply now.',
  ].join('\n');
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.setEncoding('utf8');

    req.on('data', (chunk) => {
      body += chunk;

      if (body.length > DEFAULT_BODY_LIMIT) {
        reject(createHttpError(413, 'Request body is too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(createHttpError(400, 'Invalid JSON body'));
      }
    });

    req.on('error', (error) => {
      reject(error);
    });
  });
}

function createHttpError(statusCode, message, details = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStaticFile(res, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const normalizedPath = path
    .normalize(requestedPath)
    .replace(/^(\.\.[\\/])+/, '')
    .replace(/^[\\/]+/, '');
  const absolutePath = path.join(PUBLIC_DIR, normalizedPath);

  if (!absolutePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  let filePath = absolutePath;

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    sendText(res, 404, 'Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType =
    ext === '.html'
      ? 'text/html; charset=utf-8'
      : ext === '.css'
        ? 'text/css; charset=utf-8'
        : ext === '.js'
          ? 'application/javascript; charset=utf-8'
          : 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
}

async function runConversationTurn(store, conversationId, userContent) {
  const conversation = store.getConversation(conversationId);

  if (!conversation) {
    throw createHttpError(404, 'Conversation not found');
  }

  if (activeConversationIds.has(conversationId)) {
    throw createHttpError(409, 'This conversation is already processing another turn');
  }

  if (!userContent || !String(userContent).trim()) {
    throw createHttpError(400, 'Message content is required');
  }

  if (!Array.isArray(conversation.agents) || conversation.agents.length === 0) {
    throw createHttpError(400, 'Add at least one agent to the conversation first');
  }

  const agentDir = resolveSetting('', process.env.PI_CODING_AGENT_DIR, DEFAULT_AGENT_DIR);
  const sqlitePath = resolveSetting('', process.env.PI_SQLITE_PATH, '');
  const runStore = createSqliteRunStore({ agentDir, sqlitePath });
  const turnId = randomUUID();
  const turnState = createTurnState(conversation, turnId);
  let cleanedUp = false;
  let lastRunId = null;

  function cleanupActiveTurn() {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    activeConversationIds.delete(conversationId);
    activeTurns.delete(conversationId);
    broadcastRuntimeState(store);
  }

  activeConversationIds.add(conversationId);
  activeTurns.set(conversationId, turnState);
  broadcastRuntimeState(store);
  emitTurnProgress(turnState);

  const userMessage = store.createMessage({
    conversationId,
    turnId,
    role: 'user',
    senderName: 'You',
    content: String(userContent).trim(),
    status: 'completed',
    metadata: {
      source: 'web-ui',
    },
  });
  turnState.userMessageId = userMessage.id;
  turnState.updatedAt = nowIso();

  broadcastEvent('conversation_message_created', {
    conversationId,
    message: userMessage,
  });
  broadcastConversationSummary(store, conversationId);
  emitTurnProgress(turnState);

  const rootTaskId = createTaskId('conversation-turn');
  const completedReplies = [];
  const failedReplies = [];

  runStore.createTask({
    taskId: rootTaskId,
    kind: 'conversation_turn',
    title: `Conversation turn for ${conversation.title}`,
    status: 'running',
    inputText: userMessage.content,
    metadata: {
      conversationId,
      turnId,
      participantAgentIds: conversation.agents.map((agent) => agent.id),
    },
    startedAt: nowIso(),
  });
  runStore.appendTaskEvent(rootTaskId, 'conversation_turn_started', {
    conversationId,
    turnId,
    agentCount: conversation.agents.length,
  });

  try {
    for (const agent of conversation.agents) {
      const stage = getTurnStage(turnState, agent.id);
      const refreshedConversation = store.getConversation(conversationId);
      const prompt = buildAgentTurnPrompt({
        conversation: refreshedConversation,
        agent,
        agents: refreshedConversation.agents,
        messages: refreshedConversation.messages,
        userMessage,
      });
      const provider = resolveSetting(agent.provider, process.env.PI_PROVIDER, DEFAULT_PROVIDER);
      const model = resolveSetting(agent.model, process.env.PI_MODEL, DEFAULT_MODEL);
      const thinking = resolveSetting(agent.thinking, process.env.PI_THINKING, DEFAULT_THINKING);
      const heartbeatIntervalMs = resolveIntegerSettingCandidates(
        [process.env.PI_HEARTBEAT_INTERVAL_MS, 5000],
        'heartbeatIntervalMs'
      );
      const heartbeatTimeoutMs = resolveIntegerSettingCandidates(
        [process.env.PI_HEARTBEAT_TIMEOUT_MS, process.env.PI_IDLE_TIMEOUT_MS, 60000],
        'heartbeatTimeoutMs'
      );
      const stageTaskId = createTaskId('agent-turn');
      const sessionName = sanitizeSessionName(`chat-${conversationId}-${agent.id}`) || `chat-${conversationId}`;

      const assistantMessage = store.createMessage({
        conversationId,
        turnId,
        role: 'assistant',
        agentId: agent.id,
        senderName: agent.name,
        content: '',
        status: 'queued',
        taskId: stageTaskId,
        metadata: {
          provider,
          model,
          sessionName,
          streaming: true,
        },
      });

      stage.messageId = assistantMessage.id;
      stage.taskId = stageTaskId;
      stage.status = 'queued';
      stage.preview = '';
      stage.errorMessage = '';
      turnState.currentAgentId = agent.id;
      turnState.updatedAt = nowIso();

      broadcastEvent('conversation_message_created', {
        conversationId,
        message: assistantMessage,
      });
      broadcastConversationSummary(store, conversationId);
      emitTurnProgress(turnState);

      runStore.createTask({
        taskId: stageTaskId,
        parentTaskId: rootTaskId,
        parentRunId: lastRunId,
        kind: 'conversation_agent_reply',
        title: `${agent.name} reply`,
        status: 'queued',
        assignedAgent: 'pi',
        assignedRole: agent.name,
        provider,
        model,
        requestedSession: sessionName,
        inputText: prompt,
        metadata: {
          conversationId,
          turnId,
          agentId: agent.id,
          agentName: agent.name,
        },
      });
      runStore.appendTaskEvent(stageTaskId, 'agent_reply_queued', {
        conversationId,
        turnId,
        agentId: agent.id,
        agentName: agent.name,
      });

      const handle = startRun(provider, model, prompt, {
        thinking,
        agentDir,
        sqlitePath,
        heartbeatIntervalMs,
        heartbeatTimeoutMs,
        session: sessionName,
        streamOutput: false,
        parentRunId: lastRunId,
        taskId: stageTaskId,
        taskKind: 'conversation_agent_reply',
        taskRole: agent.name,
        metadata: {
          conversationId,
          turnId,
          agentId: agent.id,
        },
      });

      const startedAt = nowIso();
      stage.runId = handle.runId || null;
      stage.status = 'running';
      stage.startedAt = startedAt;
      stage.endedAt = null;
      stage.heartbeatCount = 0;
      stage.replyLength = 0;
      stage.preview = '';
      stage.errorMessage = '';
      turnState.currentAgentId = agent.id;

      const startedMessage = store.updateMessage(assistantMessage.id, {
        status: 'streaming',
        taskId: stageTaskId,
        runId: handle.runId || null,
        metadata: {
          provider,
          model,
          sessionName,
          streaming: true,
        },
      });

      runStore.updateTask(stageTaskId, {
        status: 'running',
        parentRunId: lastRunId,
        runId: handle.runId,
        sessionPath: handle.sessionPath,
        startedAt,
      });
      runStore.appendTaskEvent(stageTaskId, 'agent_reply_started', {
        agentId: agent.id,
        agentName: agent.name,
        runId: handle.runId,
        sessionPath: handle.sessionPath,
      });

      broadcastEvent('conversation_message_updated', {
        conversationId,
        message: startedMessage,
      });
      emitTurnProgress(turnState);

      handle.on('assistant_text_delta', (event) => {
        const updatedMessage = store.appendMessageText(assistantMessage.id, event.delta || '');

        stage.status = 'running';
        stage.replyLength = updatedMessage && updatedMessage.content ? updatedMessage.content.length : 0;
        stage.preview = clipText(updatedMessage ? updatedMessage.content : '', TURN_PREVIEW_LENGTH);
        turnState.currentAgentId = agent.id;
        turnState.updatedAt = nowIso();

        broadcastEvent('conversation_message_delta', {
          conversationId,
          turnId,
          agentId: agent.id,
          messageId: assistantMessage.id,
          delta: event.delta || '',
          content: updatedMessage ? updatedMessage.content : '',
        });
        emitTurnProgress(turnState);
      });

      handle.on('heartbeat', (event) => {
        stage.heartbeatCount = event.count || 0;
        turnState.updatedAt = nowIso();

        runStore.appendTaskEvent(stageTaskId, 'agent_reply_heartbeat', {
          count: event.count,
          reason: sanitizeReason(event.payload && event.payload.reason),
        });
        emitTurnProgress(turnState);
      });

      handle.on('run_terminating', (event) => {
        stage.status = 'terminating';
        stage.errorMessage = event.reason && event.reason.message ? event.reason.message : '';
        turnState.updatedAt = nowIso();

        runStore.appendTaskEvent(stageTaskId, 'agent_reply_terminating', event.reason || null);
        emitTurnProgress(turnState);
      });

      try {
        const result = await handle.resultPromise;
        lastRunId = result.runId || lastRunId;
        const replyText = String(result.reply || '').trim();
        const finalMetadata = {
          provider,
          model,
          heartbeatCount: result.heartbeatCount || 0,
          sessionPath: result.sessionPath || '',
          streaming: false,
        };
        const assistantMessageDone = store.updateMessage(assistantMessage.id, {
          content: replyText,
          status: 'completed',
          taskId: stageTaskId,
          runId: result.runId || handle.runId || null,
          errorMessage: '',
          metadata: finalMetadata,
        });

        completedReplies.push(assistantMessageDone);

        stage.status = 'completed';
        stage.runId = result.runId || handle.runId || null;
        stage.heartbeatCount = result.heartbeatCount || 0;
        stage.replyLength = replyText.length;
        stage.preview = clipText(replyText, TURN_PREVIEW_LENGTH);
        stage.errorMessage = '';
        stage.endedAt = nowIso();
        turnState.completedCount += 1;
        turnState.currentAgentId = null;
        turnState.updatedAt = nowIso();

        runStore.updateTask(stageTaskId, {
          status: 'succeeded',
          runId: result.runId || handle.runId || null,
          sessionPath: result.sessionPath,
          outputText: replyText,
          endedAt: stage.endedAt,
          artifactSummary: {
            kind: 'text/plain',
            name: `${agent.name}-reply.txt`,
          },
        });
        runStore.addArtifact(stageTaskId, {
          kind: 'text',
          name: `${agent.name}-reply.txt`,
          mimeType: 'text/plain',
          contentText: replyText,
          metadata: {
            conversationId,
            turnId,
            agentId: agent.id,
            agentName: agent.name,
          },
        });
        runStore.appendTaskEvent(stageTaskId, 'agent_reply_succeeded', {
          agentId: agent.id,
          agentName: agent.name,
          runId: result.runId || null,
          replyLength: replyText.length,
        });

        broadcastEvent('conversation_message_updated', {
          conversationId,
          message: assistantMessageDone,
        });
        broadcastConversationSummary(store, conversationId);
        emitTurnProgress(turnState);
      } catch (error) {
        const existingMessage = store.getMessage(assistantMessage.id);
        const assistantMessageFailed = store.updateMessage(assistantMessage.id, {
          content: existingMessage ? existingMessage.content : '',
          status: 'failed',
          taskId: stageTaskId,
          runId: error.runId || handle.runId || null,
          errorMessage: error.message,
          metadata: {
            provider,
            model,
            failure: true,
            streaming: false,
          },
        });

        failedReplies.push(assistantMessageFailed);

        stage.status = 'failed';
        stage.runId = error.runId || handle.runId || null;
        stage.replyLength = assistantMessageFailed && assistantMessageFailed.content ? assistantMessageFailed.content.length : 0;
        stage.preview = clipText(
          assistantMessageFailed && assistantMessageFailed.content ? assistantMessageFailed.content : error.message,
          TURN_PREVIEW_LENGTH
        );
        stage.errorMessage = error.message;
        stage.endedAt = nowIso();
        turnState.failedCount += 1;
        turnState.currentAgentId = null;
        turnState.updatedAt = nowIso();

        runStore.updateTask(stageTaskId, {
          status: 'failed',
          runId: error.runId || handle.runId || null,
          errorMessage: error.message,
          endedAt: stage.endedAt,
        });
        runStore.appendTaskEvent(stageTaskId, 'agent_reply_failed', {
          agentId: agent.id,
          agentName: agent.name,
          runId: error.runId || handle.runId || null,
          errorMessage: error.message,
        });

        broadcastEvent('conversation_message_updated', {
          conversationId,
          message: assistantMessageFailed,
        });
        broadcastConversationSummary(store, conversationId);
        emitTurnProgress(turnState);
      }
    }

    const finalConversation = store.getConversation(conversationId);

    turnState.status = completedReplies.length > 0 ? 'completed' : 'failed';
    turnState.endedAt = nowIso();
    turnState.currentAgentId = null;
    turnState.updatedAt = turnState.endedAt;

    runStore.updateTask(rootTaskId, {
      status: completedReplies.length > 0 ? 'succeeded' : 'failed',
      outputText: completedReplies.map((message) => `${message.senderName}: ${message.content}`).join('\n\n'),
      errorMessage: completedReplies.length > 0 ? null : 'All agents failed to produce a reply',
      endedAt: turnState.endedAt,
      artifactSummary: {
        completedAgentIds: completedReplies.map((message) => message.agentId),
        failedAgentIds: failedReplies.map((message) => message.agentId),
      },
    });
    runStore.appendTaskEvent(rootTaskId, 'conversation_turn_finished', {
      conversationId,
      turnId,
      completedCount: completedReplies.length,
      failedCount: failedReplies.length,
    });

    const finishedTurn = summarizeTurnState(turnState);
    broadcastEvent('turn_finished', {
      conversationId,
      turn: finishedTurn,
      failures: failedReplies.map((message) => ({
        agentId: message.agentId,
        senderName: message.senderName,
        errorMessage: message.errorMessage,
      })),
    });
    broadcastConversationSummary(store, conversationId);
    cleanupActiveTurn();

    return {
      turnId,
      conversation: finalConversation,
      replies: completedReplies,
      failures: failedReplies.map((message) => ({
        agentId: message.agentId,
        senderName: message.senderName,
        errorMessage: message.errorMessage,
      })),
      turn: finishedTurn,
    };
  } catch (error) {
    turnState.status = 'failed';
    turnState.endedAt = nowIso();
    turnState.currentAgentId = null;
    turnState.updatedAt = turnState.endedAt;

    runStore.updateTask(rootTaskId, {
      status: 'failed',
      errorMessage: error.message,
      endedAt: turnState.endedAt,
    });
    runStore.appendTaskEvent(rootTaskId, 'conversation_turn_failed', {
      conversationId,
      turnId,
      errorMessage: error.message,
    });

    broadcastEvent('turn_finished', {
      conversationId,
      turn: summarizeTurnState(turnState),
      failures: [
        {
          agentId: null,
          senderName: 'system',
          errorMessage: error.message,
        },
      ],
    });
    cleanupActiveTurn();
    throw error;
  } finally {
    cleanupActiveTurn();
    runStore.close();
  }
}

async function handleApiRequest(req, res, store, pathname, requestUrl) {
  if (req.method === 'GET' && pathname === '/api/events') {
    handleEventStream(req, res, store, requestUrl);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/bootstrap') {
    sendJson(res, 200, buildBootstrapPayload(store));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/agents') {
    sendJson(res, 200, { agents: store.listAgents() });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/agents') {
    const body = await readRequestJson(req);
    const agent = store.saveAgent(body);
    sendJson(res, 201, { agent, agents: store.listAgents() });
    return;
  }

  const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);

  if (agentMatch) {
    const agentId = decodeURIComponent(agentMatch[1]);

    if (req.method === 'PUT') {
      const body = await readRequestJson(req);
      const agent = store.saveAgent({ ...body, id: agentId });
      sendJson(res, 200, { agent, agents: store.listAgents() });
      return;
    }

    if (req.method === 'DELETE') {
      store.deleteAgent(agentId);
      sendJson(res, 200, {
        deletedId: agentId,
        agents: store.listAgents(),
        conversations: store.listConversations(),
      });
      return;
    }
  }

  if (req.method === 'GET' && pathname === '/api/conversations') {
    sendJson(res, 200, { conversations: store.listConversations() });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/conversations') {
    const body = await readRequestJson(req);
    const conversation = store.createConversation(body);
    sendJson(res, 201, {
      conversation,
      summary: pickConversationSummary(conversation),
      conversations: store.listConversations(),
    });
    return;
  }

  const conversationMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);

  if (conversationMatch) {
    const conversationId = decodeURIComponent(conversationMatch[1]);

    if (req.method === 'GET') {
      const conversation = store.getConversation(conversationId);

      if (!conversation) {
        throw createHttpError(404, 'Conversation not found');
      }

      sendJson(res, 200, { conversation });
      return;
    }

    if (req.method === 'PUT') {
      const body = await readRequestJson(req);
      const conversation = store.updateConversation(conversationId, body);

      if (!conversation) {
        throw createHttpError(404, 'Conversation not found');
      }

      sendJson(res, 200, {
        conversation,
        summary: pickConversationSummary(conversation),
        conversations: store.listConversations(),
      });
      return;
    }

    if (req.method === 'DELETE') {
      store.deleteConversation(conversationId);
      activeConversationIds.delete(conversationId);
      activeTurns.delete(conversationId);
      const bootstrap = buildBootstrapPayload(store);
      sendJson(res, 200, {
        deletedId: conversationId,
        ...bootstrap,
      });
      return;
    }
  }

  const messageMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);

  if (messageMatch && req.method === 'POST') {
    const conversationId = decodeURIComponent(messageMatch[1]);
    const body = await readRequestJson(req);
    const result = await runConversationTurn(store, conversationId, body.content);
    sendJson(res, 200, {
      ...result,
      conversations: store.listConversations(),
    });
    return;
  }

  throw createHttpError(404, 'API route not found');
}

function main() {
  const agentDir = resolveSetting('', process.env.PI_CODING_AGENT_DIR, DEFAULT_AGENT_DIR);
  const sqlitePath = resolveSetting('', process.env.PI_SQLITE_PATH, '');
  const store = createChatAppStore({ agentDir, sqlitePath });
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    try {
      if (requestUrl.pathname.startsWith('/api/')) {
        await handleApiRequest(req, res, store, requestUrl.pathname, requestUrl);
        return;
      }

      serveStaticFile(res, requestUrl.pathname);
    } catch (error) {
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      sendJson(res, statusCode, {
        error: error.message || 'Internal server error',
      });
    }
  });

  server.listen(PORT, HOST, () => {
    process.stdout.write(`Local chat app running at http://${HOST}:${PORT}\n`);
    process.stdout.write(`SQLite database: ${store.databasePath}\n`);
  });

  function shutdown() {
    for (const client of sseClients.values()) {
      if (client.keepAliveTimer) {
        clearInterval(client.keepAliveTimer);
      }

      try {
        client.res.end();
      } catch {}
    }

    sseClients.clear();

    server.close(() => {
      store.close();
      process.exit(0);
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main();
}
