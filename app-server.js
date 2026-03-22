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
  resolveSessionPath,
  resolveSetting,
  sanitizeSessionName,
  startRun,
} = require('./minimal-pi');
const { createSqliteRunStore } = require('./sqlite-store');
const { createChatAppStore } = require('./chat-app-store');

const HOST = process.env.CHAT_APP_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.CHAT_APP_PORT || '3100', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_BODY_LIMIT = 4 * 1024 * 1024;
const MAX_HISTORY_MESSAGES = 24;
const HEARTBEAT_EVENT_REASON_LIMIT = 200;
const TURN_PREVIEW_LENGTH = 180;
const SSE_KEEPALIVE_MS = 15000;
const MAX_AGENT_MENTIONS_PER_REPLY = 2;

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

function normalizeMentionToken(value) {
  return String(value || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/^[^\p{L}\p{N}_-]+/gu, '')
    .replace(/[^\p{L}\p{N}._-]+$/gu, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function buildAgentMentionLookup(agents) {
  const lookup = new Map();

  for (const agent of Array.isArray(agents) ? agents : []) {
    const aliases = new Set();
    const id = String(agent && agent.id ? agent.id : '').trim();
    const name = String(agent && agent.name ? agent.name : '').trim();

    if (id) {
      aliases.add(id);

      if (id.startsWith('agent-') && id.length > 6) {
        aliases.add(id.slice(6));
      }
    }

    if (name) {
      aliases.add(name);
      aliases.add(name.replace(/\s+/g, ''));
      aliases.add(name.replace(/\s+/g, '-'));
      aliases.add(name.replace(/\s+/g, '_'));
    }

    for (const alias of aliases) {
      const normalized = normalizeMentionToken(alias);

      if (normalized && !lookup.has(normalized)) {
        lookup.set(normalized, id);
      }
    }
  }

  return lookup;
}

function resolveMentionValues(values, agents, options = {}) {
  const lookup = options.lookup || buildAgentMentionLookup(agents);
  const excludeAgentId = options.excludeAgentId || '';
  const result = [];
  const seen = new Set();

  for (const value of Array.isArray(values) ? values : [values]) {
    const normalized = normalizeMentionToken(value);

    if (!normalized) {
      continue;
    }

    const agentId = lookup.get(normalized);

    if (!agentId || agentId === excludeAgentId || seen.has(agentId)) {
      continue;
    }

    seen.add(agentId);
    result.push(agentId);
  }

  return result;
}

function extractMentionedAgentIds(text, agents, options = {}) {
  const lookup = options.lookup || buildAgentMentionLookup(agents);
  const excludeAgentId = options.excludeAgentId || '';
  const limit =
    Number.isInteger(options.limit) && options.limit > 0 ? options.limit : Number.MAX_SAFE_INTEGER;
  const result = [];
  const seen = new Set();
  const source = String(text || '');
  const mentionRegex = /@([^\s@()[\]{}<>]+)/gu;
  let match;

  while ((match = mentionRegex.exec(source)) !== null) {
    const agentId = lookup.get(normalizeMentionToken(match[1]));

    if (!agentId || agentId === excludeAgentId || seen.has(agentId)) {
      continue;
    }

    seen.add(agentId);
    result.push(agentId);

    if (result.length >= limit) {
      break;
    }
  }

  return result;
}

function extractRoutingMentionedAgentIds(text, agents, options = {}) {
  const lookup = options.lookup || buildAgentMentionLookup(agents);
  const excludeAgentId = options.excludeAgentId || '';
  const limit =
    Number.isInteger(options.limit) && options.limit > 0 ? options.limit : Number.MAX_SAFE_INTEGER;
  const result = [];
  const seen = new Set();
  const source = String(text || '');
  const mentionRegex = /\*\*@([^\s@()[\]{}<>*]+)\*\*/gu;
  let match;

  while ((match = mentionRegex.exec(source)) !== null) {
    const agentId = lookup.get(normalizeMentionToken(match[1]));

    if (!agentId || agentId === excludeAgentId || seen.has(agentId)) {
      continue;
    }

    seen.add(agentId);
    result.push(agentId);

    if (result.length >= limit) {
      break;
    }
  }

  return result;
}

function getAgentById(agents, agentId) {
  return Array.isArray(agents) ? agents.find((agent) => agent.id === agentId) || null : null;
}

function resolveConversationAgentConfig(agent) {
  const selectedModelProfile =
    agent && agent.selectedModelProfile && typeof agent.selectedModelProfile === 'object' ? agent.selectedModelProfile : null;

  return {
    profileId: selectedModelProfile ? selectedModelProfile.id : null,
    profileName: selectedModelProfile ? selectedModelProfile.name : 'Default',
    provider: resolveSetting(selectedModelProfile ? selectedModelProfile.provider : '', agent && agent.provider, ''),
    model: resolveSetting(selectedModelProfile ? selectedModelProfile.model : '', agent && agent.model, ''),
    thinking: resolveSetting(selectedModelProfile ? selectedModelProfile.thinking : '', agent && agent.thinking, ''),
    personaPrompt: resolveSetting(
      selectedModelProfile ? selectedModelProfile.personaPrompt : '',
      agent && agent.personaPrompt,
      ''
    ),
  };
}

function formatAgentMention(agent) {
  const name = String(agent && agent.name ? agent.name : '').trim();

  if (name) {
    return `**@${name.replace(/\s+/g, '')}**`;
  }

  return `**@${String(agent && agent.id ? agent.id : '').trim()}**`;
}

function ensureVisibleMentionText(replyText, mentionedAgents) {
  const reply = String(replyText || '').trim();

  if (!Array.isArray(mentionedAgents) || mentionedAgents.length === 0) {
    return reply;
  }

  const missingTags = mentionedAgents
    .map(formatAgentMention)
    .filter((tag) => {
      return !reply.toLowerCase().includes(tag.toLowerCase());
    });

  if (missingTags.length === 0) {
    return reply;
  }

  if (!reply) {
    return missingTags.join(' ');
  }

  return `${reply}\n\n${missingTags.join(' ')}`;
}

function extractJsonCandidate(text) {
  const raw = String(text || '').trim();
  let candidate = raw;

  if (!candidate) {
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

    for (let index = firstBrace; index < candidate.length; index += 1) {
      const char = candidate[index];

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
          return candidate.slice(firstBrace, index + 1);
        }
      }
    }
  }

  throw new Error('No JSON object found in agent reply');
}

function parseAgentTurnDecision(text, agents, options = {}) {
  const raw = String(text || '').trim();
  const lookup = options.lookup || buildAgentMentionLookup(agents);
  const excludeAgentId = options.currentAgentId || '';

  if (!raw) {
    throw new Error('Empty agent reply');
  }

  const parsePlainTextReply = () => {
    const mentions = extractRoutingMentionedAgentIds(raw, agents, {
      lookup,
      excludeAgentId,
      limit: MAX_AGENT_MENTIONS_PER_REPLY,
    });

    return {
      publicReply: raw,
      mentions,
      final: mentions.length === 0,
      reason: 'formatted_text_reply',
      raw,
      fallback: false,
    };
  };

  if (!raw.startsWith('{') && !raw.startsWith('```')) {
    return parsePlainTextReply();
  }

  let payload;

  try {
    payload = JSON.parse(extractJsonCandidate(raw));
  } catch {
    return parsePlainTextReply();
  }

  const action = String(payload.action || '').trim().toLowerCase();
  const explicitFinal =
    action === 'final' ||
    action === 'done' ||
    action === 'complete' ||
    action === 'answer' ||
    action === 'respond' ||
    payload.final === true ||
    payload.done === true;
  const explicitContinue =
    action === 'delegate' ||
    action === 'handoff' ||
    action === 'route' ||
    action === 'transfer' ||
    payload.final === false ||
    payload.done === false;
  const candidateMentions = [];

  if (Array.isArray(payload.mentions)) {
    candidateMentions.push(...payload.mentions);
  }

  if (Array.isArray(payload.nextAgents)) {
    candidateMentions.push(...payload.nextAgents);
  }

  if (payload.nextAgent !== undefined) {
    candidateMentions.push(payload.nextAgent);
  }

  if (payload.target !== undefined) {
    candidateMentions.push(payload.target);
  }

  const structuredMentions = resolveMentionValues(candidateMentions, agents, {
    lookup,
    excludeAgentId,
  }).slice(0, MAX_AGENT_MENTIONS_PER_REPLY);

  let publicReply = String(
    payload.publicReply ||
      payload.reply ||
      payload.message ||
      payload.output ||
      payload.finalReply ||
      ''
  ).trim();

  if (!publicReply && typeof payload.final === 'string') {
    publicReply = String(payload.final).trim();
  }

  if (!publicReply && typeof payload.answer === 'string') {
    publicReply = String(payload.answer).trim();
  }

  const inlineMentions = extractRoutingMentionedAgentIds(publicReply, agents, {
    lookup,
    excludeAgentId,
    limit: MAX_AGENT_MENTIONS_PER_REPLY,
  });
  const mentions = [];
  const seen = new Set();

  for (const agentId of [...structuredMentions, ...inlineMentions]) {
    if (seen.has(agentId)) {
      continue;
    }

    seen.add(agentId);
    mentions.push(agentId);

    if (mentions.length >= MAX_AGENT_MENTIONS_PER_REPLY) {
      break;
    }
  }

  if (!publicReply) {
    publicReply = raw;
  }

  return {
    publicReply,
    mentions,
    final: explicitFinal ? true : explicitContinue ? false : mentions.length === 0,
    reason: String(payload.reason || '').trim(),
    raw,
    fallback: false,
  };
}

function extractStreamingJsonStringField(text, fieldNames) {
  const source = String(text || '');

  for (const fieldName of Array.isArray(fieldNames) ? fieldNames : []) {
    const keyPattern = new RegExp(`"${String(fieldName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*"`, 'u');
    const match = keyPattern.exec(source);

    if (!match) {
      continue;
    }

    let result = '';
    let escaping = false;

    for (let index = match.index + match[0].length; index < source.length; index += 1) {
      const character = source[index];

      if (escaping) {
        if (character === 'n') {
          result += '\n';
        } else if (character === 'r') {
          result += '\r';
        } else if (character === 't') {
          result += '\t';
        } else if (character === 'u') {
          const unicodeHex = source.slice(index + 1, index + 5);

          if (/^[0-9a-fA-F]{4}$/.test(unicodeHex)) {
            result += String.fromCharCode(Number.parseInt(unicodeHex, 16));
            index += 4;
          } else {
            break;
          }
        } else {
          result += character;
        }

        escaping = false;
        continue;
      }

      if (character === '\\') {
        escaping = true;
        continue;
      }

      if (character === '"') {
        return result.trim();
      }

      result += character;
    }

    return result.trim();
  }

  return '';
}

function extractStreamingPublicReplyPreview(text) {
  const raw = String(text || '').trim();

  if (!raw) {
    return '';
  }

  const preview = extractStreamingJsonStringField(raw, ['publicReply', 'reply', 'message', 'output', 'finalReply', 'answer']);

  if (preview) {
    return preview;
  }

  return raw.startsWith('{') ? '' : raw;
}

function resolveInitialSpeakerQueue(userText, agents) {
  const lookup = buildAgentMentionLookup(agents);
  const mentionedAgentIds = extractRoutingMentionedAgentIds(userText, agents, {
    lookup,
    limit: Array.isArray(agents) ? agents.length : 0,
  });

  if (mentionedAgentIds.length > 0) {
    return {
      agentIds: mentionedAgentIds,
      strategy: 'user_mentions',
    };
  }

  return {
    agentIds: agents[0] ? [agents[0].id] : [],
    strategy: 'default_first_agent',
  };
}

function describeTurnTrigger(trigger, agents) {
  if (!trigger) {
    return 'You are the first speaker for this user turn.';
  }

  if (trigger.triggerType === 'user') {
    return trigger.enqueueReason === 'user_mentions'
      ? 'The user explicitly mentioned you and wants your perspective first.'
      : 'You are the room entry speaker for this turn.';
  }

  const triggeringAgent =
    getAgentById(agents, trigger.triggeredByAgentId) ||
    (trigger.triggeredByAgentName ? { name: trigger.triggeredByAgentName, id: trigger.triggeredByAgentId } : null);

  if (triggeringAgent) {
    return `${triggeringAgent.name} publicly mentioned you and invited you to continue the turn.`;
  }

  return 'Another visible participant invited you to continue the turn.';
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
    hopCount: turnState.hopCount || 0,
    routingMode: turnState.routingMode || 'sequential',
    pendingAgentIds: Array.isArray(turnState.pendingAgentIds) ? turnState.pendingAgentIds : [],
    entryAgentIds: Array.isArray(turnState.entryAgentIds) ? turnState.entryAgentIds : [],
    terminationReason: turnState.terminationReason || '',
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
      triggeredByAgentId: agent.triggeredByAgentId || null,
      triggeredByAgentName: agent.triggeredByAgentName || '',
      hop: agent.hop || 0,
      lastTextDeltaAt: agent.lastTextDeltaAt || null,
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

function readConfiguredModelsFile() {
  const configuredAgentDir = resolveSetting('', process.env.PI_CODING_AGENT_DIR, DEFAULT_AGENT_DIR);
  const candidatePaths = [
    path.resolve(configuredAgentDir, 'models.json'),
    path.resolve(__dirname, '.pi-sandbox', 'models.json'),
  ];
  const seenPaths = new Set();

  for (const candidatePath of candidatePaths) {
    const normalizedPath = path.resolve(candidatePath);

    if (seenPaths.has(normalizedPath) || !fs.existsSync(normalizedPath)) {
      continue;
    }

    seenPaths.add(normalizedPath);

    try {
      const parsed = JSON.parse(fs.readFileSync(normalizedPath, 'utf8'));
      return {
        path: normalizedPath,
        providers: parsed && typeof parsed.providers === 'object' ? parsed.providers : {},
      };
    } catch {
      return {
        path: normalizedPath,
        providers: {},
      };
    }
  }

  return {
    path: '',
    providers: {},
  };
}

function buildConfiguredModelOptions(store) {
  const seen = new Set();
  const options = [];
  const modelsFile = readConfiguredModelsFile();

  function addOption(provider, model, sourceLabel, displayName = '') {
    const normalizedProvider = String(provider || '').trim();
    const normalizedModel = String(model || '').trim();
    const normalizedDisplayName = String(displayName || '').trim();

    if (!normalizedModel) {
      return;
    }

    const key = `${normalizedProvider}\u001f${normalizedModel}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    options.push({
      key,
      provider: normalizedProvider,
      model: normalizedModel,
      label: normalizedDisplayName || (normalizedProvider ? `${normalizedProvider} / ${normalizedModel}` : normalizedModel),
      sourceLabel: String(sourceLabel || '').trim(),
    });
  }

  addOption(
    resolveSetting('', process.env.PI_PROVIDER, DEFAULT_PROVIDER),
    resolveSetting('', process.env.PI_MODEL, DEFAULT_MODEL),
    '运行时默认配置'
  );

  for (const [providerName, providerConfig] of Object.entries(modelsFile.providers)) {
    for (const modelConfig of Array.isArray(providerConfig && providerConfig.models) ? providerConfig.models : []) {
      addOption(
        providerName,
        modelConfig && modelConfig.id,
        'models.json',
        modelConfig && modelConfig.name
      );
    }
  }

  for (const agent of store.listAgents()) {
    addOption(agent.provider, agent.model, `${agent.name} · 默认配置`);

    for (const profile of Array.isArray(agent.modelProfiles) ? agent.modelProfiles : []) {
      addOption(profile.provider || agent.provider, profile.model, `${agent.name} · ${profile.name || '模型配置'}`);
    }
  }

  return options.sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
}

function buildBootstrapPayload(store) {
  const starterConversation = store.ensureStarterConversation();
  const conversations = store.listConversations();
  const selectedConversationId = starterConversation ? starterConversation.id : conversations[0] ? conversations[0].id : null;

  return {
    runtime: buildRuntimePayload(store),
    modelOptions: buildConfiguredModelOptions(store),
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
    hopCount: 0,
    routingMode: 'mention_queue',
    pendingAgentIds: [],
    entryAgentIds: [],
    terminationReason: '',
    agents: conversation.agents.map((agent) => ({
      agentId: agent.id,
      agentName: agent.name,
      status: 'idle',
      messageId: null,
      taskId: null,
      runId: null,
      heartbeatCount: 0,
      replyLength: 0,
      preview: '',
      errorMessage: '',
      triggeredByAgentId: null,
      triggeredByAgentName: '',
      hop: 0,
      lastTextDeltaAt: null,
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
      const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
      const mentionSuffix =
        metadata && Array.isArray(metadata.mentions) && metadata.mentions.length > 0
          ? ` -> ${metadata.mentions
              .map((agentId) => getAgentById(agents, agentId))
              .filter(Boolean)
              .map(formatAgentMention)
              .join(', ')}`
          : '';
      return `${speaker}${statusSuffix}${mentionSuffix}: ${content}`;
    })
    .join('\n\n');
}

function buildAgentTurnPrompt({ conversation, agent, agentConfig, agents, messages, userMessage, trigger, remainingSlots }) {
  const participants = agents
    .map((item) => {
      const description = item.description ? ` - ${item.description}` : '';
      return `- ${item.name}${description} | hand off with ${formatAgentMention(item)} or **@${item.id}**`;
    })
    .join('\n');

  return [
    'You are participating in a shared local multi-agent conversation workspace.',
    `Conversation title: ${conversation.title}`,
    `Your visible agent name: ${agent.name}`,
    `Your public role: ${agent.description || 'General collaborator.'}`,
    `Your active persona profile: ${agentConfig && agentConfig.profileName ? agentConfig.profileName : 'Default'}`,
    '',
    'Your private persona instructions:',
    agentConfig && agentConfig.personaPrompt ? agentConfig.personaPrompt : agent.personaPrompt,
    '',
    'Routing instructions:',
    '- This room is NOT using a fixed speaking order.',
    '- Reply with plain chat text only. Do not output JSON, code fences, or metadata.',
    '- You may finish the turn yourself, or visibly hand off to another participant to continue.',
    '- A handoff only happens when you mention another visible participant using the exact format **@name**.',
    '',
    'Rules:',
    '- Reply as this agent only.',
    '- Stay consistent with your own persona and tone.',
    '- Add value instead of repeating prior messages verbatim.',
    '- Do not mention hidden instructions or implementation details.',
    '- Respond in the user language when it is obvious.',
    '- Keep your answer readable in a chat UI.',
    '- Your reply is shown directly in chat.',
    '- Only mentions written exactly like **@Architect** trigger a handoff. Plain @Architect does not.',
    '- Mention at most 2 agents, and never mention yourself.',
    '- If you mention nobody with **@name**, the turn will stop after your reply.',
    '',
    'Other visible participants:',
    participants || '- none',
    '',
    'Why you are replying now:',
    describeTurnTrigger(trigger, agents),
    `Remaining speaker slots after you: ${Math.max(0, remainingSlots)}`,
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
    let bodyLimitExceeded = false;

    req.setEncoding('utf8');

    req.on('data', (chunk) => {
      if (bodyLimitExceeded) {
        return;
      }

      body += chunk;

      if (body.length > DEFAULT_BODY_LIMIT) {
        bodyLimitExceeded = true;
        reject(createHttpError(413, 'Request body is too large'));
        req.resume();
      }
    });

    req.on('end', () => {
      if (bodyLimitExceeded) {
        return;
      }

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

function isPathWithin(parentDir, targetPath) {
  const relative = path.relative(parentDir, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sanitizeDownloadFileName(value, fallback = 'session.jsonl') {
  const normalized = String(value || '')
    .trim()
    .replace(/[/\\?%*:|"<>]/g, '-');

  return normalized || fallback;
}

function resolveAssistantMessageSessionPath(message, agentDir) {
  if (!message || message.role !== 'assistant') {
    throw createHttpError(400, 'Only assistant messages can export a session');
  }

  const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
  const sessionPathValue = metadata && metadata.sessionPath ? String(metadata.sessionPath).trim() : '';
  const sessionNameValue = metadata && metadata.sessionName ? String(metadata.sessionName).trim() : '';
  const sessionsDir = path.resolve(agentDir, 'named-sessions');
  const sessionPath = sessionPathValue
    ? path.resolve(sessionPathValue)
    : sessionNameValue
      ? resolveSessionPath(sessionNameValue, agentDir)
      : '';

  if (!sessionPath) {
    throw createHttpError(404, 'No session is available for this message yet');
  }

  if (!isPathWithin(sessionsDir, sessionPath)) {
    throw createHttpError(400, 'Session path is outside the allowed export directory');
  }

  return sessionPath;
}

function sendFileDownload(res, filePath, fileName, contentType = 'application/x-ndjson; charset=utf-8') {
  const stats = fs.statSync(filePath);

  if (!stats.isFile()) {
    throw createHttpError(404, 'Requested session export was not found');
  }

  const safeFileName = sanitizeDownloadFileName(fileName, path.basename(filePath));
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Length': stats.size,
    'Content-Disposition': `attachment; filename="${safeFileName}"; filename*=UTF-8''${encodeURIComponent(safeFileName)}`,
  });

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    res.destroy();
  });
  stream.pipe(res);
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
  const initialQueue = resolveInitialSpeakerQueue(userMessage.content, conversation.agents);
  turnState.userMessageId = userMessage.id;
  turnState.entryAgentIds = initialQueue.agentIds.slice();
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
      routingMode: 'mention_queue',
      entryAgentIds: initialQueue.agentIds.slice(),
      entryStrategy: initialQueue.strategy,
    },
    startedAt: nowIso(),
  });
  runStore.appendTaskEvent(rootTaskId, 'conversation_turn_started', {
    conversationId,
    turnId,
    agentCount: conversation.agents.length,
    routingMode: 'mention_queue',
    entryAgentIds: initialQueue.agentIds.slice(),
    entryStrategy: initialQueue.strategy,
  });

  try {
    const queue = [];
    const queuedAgentIds = new Set();
    const visitedAgentIds = new Set();
    const maxReplies = Math.max(1, conversation.agents.length);
    let terminationReason = 'queue_exhausted';

    function enqueueAgent(queueItem) {
      if (!queueItem || !queueItem.agentId || queuedAgentIds.has(queueItem.agentId) || visitedAgentIds.has(queueItem.agentId)) {
        return false;
      }

      queue.push(queueItem);
      queuedAgentIds.add(queueItem.agentId);

      const stage = getTurnStage(turnState, queueItem.agentId);

      if (stage && stage.status === 'idle') {
        stage.status = 'queued';
        stage.preview = '';
        stage.errorMessage = '';
      }

      turnState.pendingAgentIds = queue.map((item) => item.agentId);
      turnState.updatedAt = nowIso();
      return true;
    }

    for (const agentId of initialQueue.agentIds) {
      enqueueAgent({
        agentId,
        triggerType: 'user',
        triggeredByAgentId: null,
        triggeredByAgentName: 'You',
        triggeredByMessageId: userMessage.id,
        parentRunId: null,
        enqueueReason: initialQueue.strategy,
      });
    }

    emitTurnProgress(turnState);

    while (queue.length > 0 && visitedAgentIds.size < maxReplies) {
      const queueItem = queue.shift();
      queuedAgentIds.delete(queueItem.agentId);
      turnState.pendingAgentIds = queue.map((item) => item.agentId);

      if (visitedAgentIds.has(queueItem.agentId)) {
        continue;
      }

      const refreshedConversation = store.getConversation(conversationId);
      const agent = getAgentById(refreshedConversation.agents, queueItem.agentId);

      if (!agent) {
        continue;
      }

      const stage = getTurnStage(turnState, agent.id);
      const hop = visitedAgentIds.size + 1;
      const agentConfig = resolveConversationAgentConfig(agent);
      const prompt = buildAgentTurnPrompt({
        conversation: refreshedConversation,
        agent,
        agentConfig,
        agents: refreshedConversation.agents,
        messages: refreshedConversation.messages,
        userMessage,
        trigger: queueItem,
        remainingSlots: maxReplies - hop,
      });
      const provider = resolveSetting(agentConfig.provider, process.env.PI_PROVIDER, DEFAULT_PROVIDER);
      const model = resolveSetting(agentConfig.model, process.env.PI_MODEL, DEFAULT_MODEL);
      const thinking = resolveSetting(agentConfig.thinking, process.env.PI_THINKING, DEFAULT_THINKING);
      const heartbeatIntervalMs = resolveIntegerSettingCandidates([process.env.PI_HEARTBEAT_INTERVAL_MS, 5000], 'heartbeatIntervalMs');
      const heartbeatTimeoutMs = resolveIntegerSettingCandidates(
        [process.env.PI_HEARTBEAT_TIMEOUT_MS, process.env.PI_IDLE_TIMEOUT_MS, 60000],
        'heartbeatTimeoutMs'
      );
      const stageTaskId = createTaskId('agent-turn');
      const sessionName =
        sanitizeSessionName(
          `chat-${conversationId}-${agent.id}-${agentConfig.profileId || 'default'}`
        ) || `chat-${conversationId}`;
      const queuedMetadata = {
        provider,
        model,
        modelProfileId: agentConfig.profileId,
        modelProfileName: agentConfig.profileName,
        sessionName,
        streaming: false,
        routingMode: 'mention_queue',
        hop,
        mentions: [],
        triggeredByAgentId: queueItem.triggeredByAgentId || null,
        triggeredByAgentName: queueItem.triggeredByAgentName || '',
        triggeredByMessageId: queueItem.triggeredByMessageId || null,
        triggerType: queueItem.triggerType || 'user',
      };

      const assistantMessage = store.createMessage({
        conversationId,
        turnId,
        role: 'assistant',
        agentId: agent.id,
        senderName: agent.name,
        content: 'Thinking...',
        status: 'queued',
        taskId: stageTaskId,
        metadata: queuedMetadata,
      });

      stage.messageId = assistantMessage.id;
      stage.taskId = stageTaskId;
      stage.status = 'queued';
      stage.preview = '';
      stage.errorMessage = '';
      stage.triggeredByAgentId = queueItem.triggeredByAgentId || null;
      stage.triggeredByAgentName = queueItem.triggeredByAgentName || '';
      stage.hop = hop;
      turnState.currentAgentId = agent.id;
      turnState.hopCount = hop;
      turnState.updatedAt = nowIso();

      broadcastEvent('conversation_message_created', { conversationId, message: assistantMessage });
      broadcastConversationSummary(store, conversationId);
      emitTurnProgress(turnState);

      runStore.createTask({
        taskId: stageTaskId,
        parentTaskId: rootTaskId,
        parentRunId: queueItem.parentRunId || null,
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
          modelProfileId: agentConfig.profileId,
          modelProfileName: agentConfig.profileName,
          hop,
          triggerType: queueItem.triggerType || 'user',
          triggeredByAgentId: queueItem.triggeredByAgentId || null,
          triggeredByMessageId: queueItem.triggeredByMessageId || null,
        },
      });
      runStore.appendTaskEvent(stageTaskId, 'agent_reply_queued', {
        conversationId,
        turnId,
        agentId: agent.id,
        agentName: agent.name,
        modelProfileId: agentConfig.profileId,
        modelProfileName: agentConfig.profileName,
        hop,
        triggerType: queueItem.triggerType || 'user',
        triggeredByAgentId: queueItem.triggeredByAgentId || null,
      });

      const handle = startRun(provider, model, prompt, {
        thinking,
        agentDir,
        sqlitePath,
        heartbeatIntervalMs,
        heartbeatTimeoutMs,
        session: sessionName,
        streamOutput: false,
        parentRunId: queueItem.parentRunId || null,
        taskId: stageTaskId,
        taskKind: 'conversation_agent_reply',
        taskRole: agent.name,
        metadata: {
          conversationId,
          turnId,
          agentId: agent.id,
          modelProfileId: agentConfig.profileId,
          modelProfileName: agentConfig.profileName,
          hop,
          triggerType: queueItem.triggerType || 'user',
          triggeredByAgentId: queueItem.triggeredByAgentId || null,
        },
      });

      const startedAt = nowIso();
      let rawReply = '';
      const startedMetadata = {
        ...queuedMetadata,
        sessionPath: handle.sessionPath || '',
        streaming: true,
      };

      stage.runId = handle.runId || null;
      stage.status = 'running';
      stage.startedAt = startedAt;
      stage.endedAt = null;
      stage.heartbeatCount = 0;
      stage.replyLength = 0;
      stage.preview = '';
      stage.errorMessage = '';
      stage.lastTextDeltaAt = null;
      turnState.currentAgentId = agent.id;

      const startedMessage = store.updateMessage(assistantMessage.id, {
        status: 'streaming',
        taskId: stageTaskId,
        runId: handle.runId || null,
        metadata: startedMetadata,
      });

      runStore.updateTask(stageTaskId, {
        status: 'running',
        parentRunId: queueItem.parentRunId || null,
        runId: handle.runId,
        sessionPath: handle.sessionPath,
        startedAt,
      });
      runStore.appendTaskEvent(stageTaskId, 'agent_reply_started', {
        agentId: agent.id,
        agentName: agent.name,
        runId: handle.runId,
        sessionPath: handle.sessionPath,
        hop,
      });

      broadcastEvent('conversation_message_updated', { conversationId, message: startedMessage });
      emitTurnProgress(turnState);

      handle.on('assistant_text_delta', (event) => {
        rawReply += event.delta || '';
        const previewText = extractStreamingPublicReplyPreview(rawReply);
        const deltaTimestamp = nowIso();
        stage.status = 'running';
        stage.replyLength = previewText.length;
        stage.preview = clipText(previewText, TURN_PREVIEW_LENGTH);
        stage.lastTextDeltaAt = deltaTimestamp;
        turnState.currentAgentId = agent.id;
        turnState.updatedAt = deltaTimestamp;
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
        const finalRawReply = String(result.reply || rawReply || '').trim();
        const decision = parseAgentTurnDecision(finalRawReply, refreshedConversation.agents, { currentAgentId: agent.id });
        const mentionedAgents = decision.mentions.map((agentId) => getAgentById(refreshedConversation.agents, agentId)).filter(Boolean);
        const publicReply = ensureVisibleMentionText(decision.publicReply, mentionedAgents);
        const finalMetadata = {
          provider,
          model,
          heartbeatCount: result.heartbeatCount || 0,
          sessionName,
          sessionPath: result.sessionPath || handle.sessionPath || '',
          streaming: false,
          routingMode: 'mention_queue',
          hop,
          mentions: decision.mentions,
          mentionNames: mentionedAgents.map((item) => item.name),
          final: decision.final,
          reason: decision.reason || '',
          fallback: Boolean(decision.fallback),
          triggeredByAgentId: queueItem.triggeredByAgentId || null,
          triggeredByAgentName: queueItem.triggeredByAgentName || '',
          triggeredByMessageId: queueItem.triggeredByMessageId || null,
          triggerType: queueItem.triggerType || 'user',
        };
        const assistantMessageDone = store.updateMessage(assistantMessage.id, {
          content: publicReply,
          status: 'completed',
          taskId: stageTaskId,
          runId: result.runId || handle.runId || null,
          errorMessage: '',
          metadata: finalMetadata,
        });

        completedReplies.push(assistantMessageDone);
        visitedAgentIds.add(agent.id);
        stage.status = 'completed';
        stage.runId = result.runId || handle.runId || null;
        stage.heartbeatCount = result.heartbeatCount || 0;
        stage.replyLength = publicReply.length;
        stage.preview = clipText(publicReply, TURN_PREVIEW_LENGTH);
        stage.errorMessage = '';
        stage.lastTextDeltaAt = stage.lastTextDeltaAt || null;
        stage.endedAt = nowIso();
        turnState.completedCount += 1;
        turnState.currentAgentId = null;
        turnState.updatedAt = nowIso();

        runStore.updateTask(stageTaskId, {
          status: 'succeeded',
          runId: result.runId || handle.runId || null,
          sessionPath: result.sessionPath,
          outputText: publicReply,
          endedAt: stage.endedAt,
          artifactSummary: { kind: 'text/plain', name: `${agent.name}-reply.txt`, mentions: decision.mentions, final: decision.final, hop },
        });
        runStore.addArtifact(stageTaskId, {
          kind: 'text',
          name: `${agent.name}-reply.txt`,
          mimeType: 'text/plain',
          contentText: publicReply,
          metadata: {
            conversationId,
            turnId,
            agentId: agent.id,
            agentName: agent.name,
            hop,
            mentions: decision.mentions,
            final: decision.final,
            rawReply: finalRawReply,
          },
        });
        runStore.appendTaskEvent(stageTaskId, 'agent_reply_succeeded', {
          agentId: agent.id,
          agentName: agent.name,
          runId: result.runId || null,
          replyLength: publicReply.length,
          hop,
          mentions: decision.mentions,
          final: decision.final,
        });

        broadcastEvent('conversation_message_updated', { conversationId, message: assistantMessageDone });
        broadcastConversationSummary(store, conversationId);
        emitTurnProgress(turnState);

        if (decision.final) {
          terminationReason = 'agent_final';
          runStore.appendTaskEvent(rootTaskId, 'agent_turn_finalized', {
            conversationId,
            turnId,
            agentId: agent.id,
            agentName: agent.name,
            messageId: assistantMessageDone.id,
            hop,
          });
          break;
        }

        const enqueuedAgentIds = [];

        for (const targetAgentId of decision.mentions) {
          if (
            enqueueAgent({
              agentId: targetAgentId,
              triggerType: 'agent',
              triggeredByAgentId: agent.id,
              triggeredByAgentName: agent.name,
              triggeredByMessageId: assistantMessageDone.id,
              parentRunId: result.runId || handle.runId || null,
              enqueueReason: decision.reason || '',
            })
          ) {
            enqueuedAgentIds.push(targetAgentId);
          }
        }

        if (enqueuedAgentIds.length > 0) {
          runStore.appendTaskEvent(rootTaskId, 'agent_turn_routed', {
            conversationId,
            turnId,
            fromAgentId: agent.id,
            fromAgentName: agent.name,
            toAgentIds: enqueuedAgentIds,
            messageId: assistantMessageDone.id,
            hop,
          });
          emitTurnProgress(turnState);
        }
      } catch (error) {
        const existingMessage = store.getMessage(assistantMessage.id);
        const assistantMessageFailed = store.updateMessage(assistantMessage.id, {
          content: existingMessage && existingMessage.content !== 'Thinking...' ? existingMessage.content : '',
          status: 'failed',
          taskId: stageTaskId,
          runId: error.runId || handle.runId || null,
          errorMessage: error.message,
          metadata: {
            provider,
            model,
            sessionName,
            sessionPath: error.sessionPath || handle.sessionPath || '',
            failure: true,
            streaming: false,
            routingMode: 'mention_queue',
            hop,
            triggeredByAgentId: queueItem.triggeredByAgentId || null,
            triggeredByAgentName: queueItem.triggeredByAgentName || '',
            triggeredByMessageId: queueItem.triggeredByMessageId || null,
            triggerType: queueItem.triggerType || 'user',
          },
        });

        failedReplies.push(assistantMessageFailed);
        visitedAgentIds.add(agent.id);
        stage.status = 'failed';
        stage.runId = error.runId || handle.runId || null;
        stage.replyLength = assistantMessageFailed && assistantMessageFailed.content ? assistantMessageFailed.content.length : 0;
        stage.preview = clipText(
          assistantMessageFailed && assistantMessageFailed.content ? assistantMessageFailed.content : error.message,
          TURN_PREVIEW_LENGTH
        );
        stage.errorMessage = error.message;
        stage.lastTextDeltaAt = stage.lastTextDeltaAt || null;
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
          hop,
        });

        broadcastEvent('conversation_message_updated', { conversationId, message: assistantMessageFailed });
        broadcastConversationSummary(store, conversationId);
        emitTurnProgress(turnState);
      }
    }

    const finalConversation = store.getConversation(conversationId);
    if (queue.length > 0 && visitedAgentIds.size >= maxReplies) {
      terminationReason = 'participant_limit_reached';
    }
    turnState.pendingAgentIds = [];
    turnState.terminationReason = terminationReason;

    turnState.status = completedReplies.length > 0 ? 'completed' : 'failed';
    turnState.endedAt = nowIso();
    turnState.currentAgentId = null;
    turnState.updatedAt = turnState.endedAt;

    runStore.updateTask(rootTaskId, {
      status: completedReplies.length > 0 ? 'succeeded' : 'failed',
      outputText: completedReplies.map((message) => `${message.senderName}: ${message.content}`).join('\n\n'),
      errorMessage: completedReplies.length > 0 ? null : 'No agent produced a completed reply',
      endedAt: turnState.endedAt,
      artifactSummary: {
        completedAgentIds: completedReplies.map((message) => message.agentId),
        failedAgentIds: failedReplies.map((message) => message.agentId),
        routingMode: 'mention_queue',
        entryAgentIds: initialQueue.agentIds.slice(),
        entryStrategy: initialQueue.strategy,
        terminationReason,
      },
    });
    runStore.appendTaskEvent(rootTaskId, 'conversation_turn_finished', {
      conversationId,
      turnId,
      completedCount: completedReplies.length,
      failedCount: failedReplies.length,
      hopCount: turnState.hopCount,
      terminationReason,
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
    turnState.pendingAgentIds = [];
    turnState.terminationReason = 'error';
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
    sendJson(res, 200, {
      agents: store.listAgents(),
      modelOptions: buildConfiguredModelOptions(store),
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/agents') {
    const body = await readRequestJson(req);
    const agent = store.saveAgent(body);
    sendJson(res, 201, {
      agent,
      agents: store.listAgents(),
      modelOptions: buildConfiguredModelOptions(store),
    });
    return;
  }

  const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);

  if (agentMatch) {
    const agentId = decodeURIComponent(agentMatch[1]);

    if (req.method === 'PUT') {
      const body = await readRequestJson(req);
      const agent = store.saveAgent({ ...body, id: agentId });
      sendJson(res, 200, {
        agent,
        agents: store.listAgents(),
        modelOptions: buildConfiguredModelOptions(store),
      });
      return;
    }

    if (req.method === 'DELETE') {
      store.deleteAgent(agentId);
      sendJson(res, 200, {
        deletedId: agentId,
        agents: store.listAgents(),
        modelOptions: buildConfiguredModelOptions(store),
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

  const messageSessionMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages\/([^/]+)\/session-export$/);

  if (messageSessionMatch && req.method === 'GET') {
    const conversationId = decodeURIComponent(messageSessionMatch[1]);
    const messageId = decodeURIComponent(messageSessionMatch[2]);
    const conversation = store.getConversation(conversationId);

    if (!conversation) {
      throw createHttpError(404, 'Conversation not found');
    }

    const message = store.getMessage(messageId);

    if (!message || message.conversationId !== conversationId) {
      throw createHttpError(404, 'Message not found');
    }

    const sessionPath = resolveAssistantMessageSessionPath(message, store.agentDir);

    if (!fs.existsSync(sessionPath)) {
      throw createHttpError(404, 'Session file has not been created yet');
    }

    sendFileDownload(res, sessionPath, path.basename(sessionPath));
    return;
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
