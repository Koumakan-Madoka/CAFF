const { randomUUID } = require('node:crypto');
const path = require('node:path');
const {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_THINKING,
  resolveIntegerSettingCandidates,
  resolveSetting,
  sanitizeSessionName,
  startRun,
} = require('../../../../lib/minimal-pi');
const {
  buildAgentMentionLookup,
  ensureVisibleMentionText,
  extractMentionedAgentIds,
  getAgentById,
} = require('../mention-routing');
const { buildAgentTurnPrompt, AGENT_PROMPT_VERSION } = require('./agent-prompt');
const { ensureAgentSandbox, toPortableShellPath } = require('./agent-sandbox');
const { extractChatBridgeReplaysFromText, pickChatBridgeReplay } = require('./chat-bridge-replay');
const { clipText, getTurnStage, nowIso, syncCurrentTurnAgent } = require('./turn-state');
const { registerTurnHandle, unregisterTurnHandle } = require('./turn-stop');

const HEARTBEAT_EVENT_REASON_LIMIT = 200;
const TURN_PREVIEW_LENGTH = 180;
const MAX_PRIVATE_CONTEXT_MESSAGES = 16;
const PROMPT_MENTION_PLACEHOLDER_RE = /<mention:([\p{L}\p{N}._-]+)>/gu;

function createTaskId(prefix = 'task') {
  return `${prefix}-${randomUUID()}`;
}

function sanitizeReason(reason: any) {
  return clipText(reason || '', HEARTBEAT_EVENT_REASON_LIMIT);
}

function normalizePromptMentionPlaceholders(text: any) {
  return String(text || '').replace(PROMPT_MENTION_PLACEHOLDER_RE, (match: any, token: any) => `@${token}`);
}

function resolveConversationAgentConfig(agent: any) {
  const selectedModelProfile =
    agent && agent.selectedModelProfile && typeof agent.selectedModelProfile === 'object' ? agent.selectedModelProfile : null;

  return {
    profileId: selectedModelProfile ? selectedModelProfile.id : null,
    profileName: selectedModelProfile ? selectedModelProfile.name : 'Default',
    provider: resolveSetting(selectedModelProfile ? selectedModelProfile.provider : '', agent && agent.provider, ''),
    model: resolveSetting(selectedModelProfile ? selectedModelProfile.model : '', agent && agent.model, ''),
    thinking: resolveSetting(selectedModelProfile ? selectedModelProfile.thinking : '', agent && agent.thinking, ''),
    personaPrompt: resolveSetting(selectedModelProfile ? selectedModelProfile.personaPrompt : '', agent && agent.personaPrompt, ''),
    skillIds: Array.isArray(agent && (agent.skillIds || agent.skills)) ? agent.skillIds || agent.skills : [],
    conversationSkillIds: Array.isArray(agent && (agent.conversationSkillIds || agent.conversationSkills))
      ? agent.conversationSkillIds || agent.conversationSkills
      : [],
  };
}

function extractJsonCandidate(text: any) {
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

function createSilentAgentTurnDecision(input: any = {}) {
  const mentions = Array.isArray(input.mentions) ? input.mentions.filter(Boolean) : [];

  return {
    publicReply: '',
    mentions,
    final: input.final === undefined ? mentions.length === 0 : Boolean(input.final),
    reason: String(input.reason || '').trim(),
    raw: String(input.raw || '').trim(),
    fallback: Boolean(input.fallback),
    silent: true,
  };
}

function parseAgentTurnDecision(text: any, agents: any, options: any = {}) {
  const raw = normalizePromptMentionPlaceholders(text).trim();
  const lookup = options.lookup || buildAgentMentionLookup(agents);
  const excludeAgentId = options.currentAgentId || '';

  if (!raw) {
    if (options.allowEmptyReply) {
      return createSilentAgentTurnDecision({
        reason: 'empty_reply',
        raw,
      });
    }

    throw new Error('Empty agent reply');
  }

  const parsePlainTextReply = () => {
    const mentions = extractMentionedAgentIds(raw, agents, {
      lookup,
      excludeAgentId,
      limit: Array.isArray(agents) ? agents.length : Number.MAX_SAFE_INTEGER,
    });

    return {
      publicReply: raw,
      mentions,
      final: mentions.length === 0,
      reason: 'formatted_text_reply',
      raw,
      fallback: false,
      silent: false,
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
  let publicReply = String(payload.publicReply || payload.reply || payload.message || payload.output || payload.finalReply || '').trim();

  if (!publicReply && typeof payload.final === 'string') {
    publicReply = String(payload.final).trim();
  }

  if (!publicReply && typeof payload.answer === 'string') {
    publicReply = String(payload.answer).trim();
  }

  publicReply = normalizePromptMentionPlaceholders(publicReply);

  const inlineMentions = extractMentionedAgentIds(publicReply, agents, {
    lookup,
    excludeAgentId,
    limit: Array.isArray(agents) ? agents.length : Number.MAX_SAFE_INTEGER,
  });
  const mentions = [];
  const seen = new Set();

  for (const agentId of inlineMentions) {
    if (seen.has(agentId)) {
      continue;
    }

    seen.add(agentId);
    mentions.push(agentId);
  }

  const final = explicitFinal ? true : explicitContinue ? false : mentions.length === 0;
  const reason = String(payload.reason || '').trim();

  if (!publicReply) {
    return createSilentAgentTurnDecision({
      mentions,
      final,
      reason:
        reason ||
        (mentions.length > 0 || explicitContinue || explicitFinal
          ? 'structured_control_reply'
          : options.allowEmptyReply
            ? 'empty_structured_reply'
            : 'structured_reply_without_public_text'),
      raw,
    });
  }

  return {
    publicReply,
    mentions,
    final,
    reason,
    raw,
    fallback: false,
    silent: false,
  };
}

function extractStreamingJsonStringField(text: any, fieldNames: any) {
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

function extractStreamingPublicReplyPreview(text: any) {
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

export function createAgentExecutor(options: any = {}) {
  const store = options.store;
  const skillRegistry = options.skillRegistry;
  const modeStore = options.modeStore;
  const getProjectDir = typeof options.getProjectDir === 'function' ? options.getProjectDir : null;
  const agentToolBridge = options.agentToolBridge;
  const broadcastEvent = typeof options.broadcastEvent === 'function' ? options.broadcastEvent : () => {};
  const broadcastConversationSummary =
    typeof options.broadcastConversationSummary === 'function' ? options.broadcastConversationSummary : () => {};
  const emitTurnProgress = typeof options.emitTurnProgress === 'function' ? options.emitTurnProgress : () => {};
  const agentDir = options.agentDir;
  const sqlitePath = options.sqlitePath;
  const toolBaseUrl = String(options.toolBaseUrl || '').trim();
  const agentToolScriptPath = options.agentToolScriptPath;
  const agentToolRelativePath = String(options.agentToolRelativePath || './lib/agent-chat-tools.js').trim() || './lib/agent-chat-tools.js';

  async function executeConversationAgent({
    runStore,
    conversationId,
    turnId,
    rootTaskId,
    conversation,
    promptMessages,
    promptUserMessage,
    queueItem,
    agent,
    turnState,
    completedReplies,
    failedReplies,
    routingMode,
    hop,
    remainingSlots,
    enqueueAgent,
    allowHandoffs = true,
    finalStopsTurn = true,
    projectDir,
  }: any) {
    const stage = getTurnStage(turnState, agent.id);

    if (!stage) {
      return {
        stopTurn: false,
        terminationReason: '',
      };
    }

    if (turnState.stopRequested) {
      return {
        stopTurn: true,
        terminationReason: 'stopped_by_user',
      };
    }

    const agentConfig = resolveConversationAgentConfig(agent);
    const agentSandbox = ensureAgentSandbox(agentDir, agent);
    const snapshotProvided = projectDir !== undefined;
    const projectDirCandidate = snapshotProvided
      ? String(projectDir || '').trim()
      : getProjectDir
        ? String(getProjectDir(conversation) || '').trim()
        : '';
    const resolvedProjectDir = projectDirCandidate ? path.resolve(projectDirCandidate) : '';
    const extraSkillDirs = resolvedProjectDir
      ? [path.join(resolvedProjectDir, '.agents', 'skills'), path.join(resolvedProjectDir, '.codex', 'skills')]
      : [];
    const resolvedPersonaSkills = skillRegistry.resolveSkills(agentConfig.skillIds, { extraSkillDirs });
    const resolvedConversationSkills = skillRegistry.resolveSkills(agentConfig.conversationSkillIds, { extraSkillDirs });
    const privateMessages = store.listPrivateMessagesForAgent(conversationId, agent.id, {
      limit: MAX_PRIVATE_CONTEXT_MESSAGES,
    });
    const conversationType = conversation && conversation.type ? String(conversation.type).trim() : 'standard';
    const modeForType = modeStore ? modeStore.get(conversationType) : null;
    const modeLoadingStrategy = modeForType ? String(modeForType.loadingStrategy || 'dynamic').trim() : 'dynamic';
    const prompt = buildAgentTurnPrompt({
      conversation,
      agent,
      agentConfig,
      resolvedPersonaSkills,
      resolvedConversationSkills,
      sandbox: agentSandbox,
      projectDir: resolvedProjectDir,
      agents: conversation.agents,
      messages: promptMessages,
      privateMessages,
      trigger: queueItem,
      remainingSlots,
      routingMode,
      allowHandoffs,
      agentToolRelativePath,
      modeLoadingStrategy,
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
    // We already inject the full room history into every prompt, so reusing one
    // long-lived provider session per agent only adds cross-turn contamination
    // risk when a run is interrupted or the provider/tool chain records stray
    // partial input. Keep each agent execution in its own session instead.
    const sessionName =
      sanitizeSessionName(
        `chat-${conversationId}-${turnId}-${agent.id}-${agentConfig.profileId || 'default'}-${String(stageTaskId).slice(-12)}`
      ) || `chat-${conversationId}-${turnId}`;
    const queuedMetadata = {
      provider,
      model,
      promptVersion: AGENT_PROMPT_VERSION,
      modelProfileId: agentConfig.profileId,
      modelProfileName: agentConfig.profileName,
      agentSandboxDir: agentSandbox.sandboxDir,
      agentPrivateDir: agentSandbox.privateDir,
      skillIds: agentConfig.skillIds,
      conversationSkillIds: agentConfig.conversationSkillIds,
      sessionName,
      sessionScope: 'agent_turn',
      streaming: false,
      routingMode,
      hop,
      mentions: [] as any[],
      toolBridgeEnabled: true,
      privateOnly: Boolean(queueItem && queueItem.privateOnly),
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
    stage.startedAt = null;
    stage.endedAt = null;
    stage.lastTextDeltaAt = null;
    turnState.hopCount = Math.max(turnState.hopCount || 0, hop);
    turnState.updatedAt = nowIso();
    syncCurrentTurnAgent(turnState);

    broadcastEvent('conversation_message_created', { conversationId, message: assistantMessage });
    broadcastConversationSummary(conversationId);
    emitTurnProgress(turnState);

    const toolInvocation = agentToolBridge.registerInvocation(
      agentToolBridge.createInvocationContext({
        conversationId,
        turnId,
        projectDir: resolvedProjectDir,
        agentId: agent.id,
        agentName: agent.name,
        assistantMessageId: assistantMessage.id,
        userMessageId: promptUserMessage && promptUserMessage.id ? promptUserMessage.id : null,
        promptUserMessage,
        conversationAgents: conversation.agents,
        runStore,
        stage,
        turnState,
        enqueueAgent,
        allowHandoffs,
      })
    );

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
        promptVersion: AGENT_PROMPT_VERSION,
        agentSandboxDir: agentSandbox.sandboxDir,
        agentPrivateDir: agentSandbox.privateDir,
        modelProfileId: agentConfig.profileId,
        modelProfileName: agentConfig.profileName,
        skillIds: agentConfig.skillIds,
        conversationSkillIds: agentConfig.conversationSkillIds,
        hop,
        routingMode,
        triggerType: queueItem.triggerType || 'user',
        triggeredByAgentId: queueItem.triggeredByAgentId || null,
        triggeredByMessageId: queueItem.triggeredByMessageId || null,
        toolBridgeEnabled: true,
      },
      startedAt: nowIso(),
    });
    runStore.appendTaskEvent(stageTaskId, 'agent_reply_queued', {
      conversationId,
      turnId,
      agentId: agent.id,
      agentName: agent.name,
      promptVersion: AGENT_PROMPT_VERSION,
      modelProfileId: agentConfig.profileId,
      modelProfileName: agentConfig.profileName,
      hop,
      routingMode,
      triggerType: queueItem.triggerType || 'user',
      triggeredByAgentId: queueItem.triggeredByAgentId || null,
    });
    runStore.appendTaskEvent(stageTaskId, 'agent_expectations', {
      schemaVersion: 1,
      promptVersion: AGENT_PROMPT_VERSION,
      policy: {
        id: 'caff_default',
        version: 'v1',
      },
      expectations: {
        'send-public': queuedMetadata.privateOnly ? 'forbidden' : 'required',
        'send-private': queuedMetadata.privateOnly ? 'required' : 'optional',
        'read-context': 'optional',
        participants: 'optional',
        'trellis-init': 'optional',
        'trellis-write': 'optional',
      },
      context: {
        conversationId,
        conversationType: conversation && conversation.type ? conversation.type : 'standard',
        turnId,
        agentId: agent.id,
        agentName: agent.name,
        hop,
        routingMode,
        privateOnly: queuedMetadata.privateOnly,
        allowHandoffs,
        triggerType: queueItem.triggerType || 'user',
        triggeredByAgentId: queueItem.triggeredByAgentId || null,
        triggeredByMessageId: queueItem.triggeredByMessageId || null,
      },
    });

    const handle = startRun(provider, model, prompt, {
      thinking,
      agentDir,
      sqlitePath,
      heartbeatIntervalMs,
      heartbeatTimeoutMs,
      extraEnv: {
        PI_AGENT_ID: agent.id,
        PI_AGENT_NAME: agent.name,
        PI_AGENT_SANDBOX_DIR: agentSandbox.sandboxDir,
        PI_AGENT_PRIVATE_DIR: agentSandbox.privateDir,
        CAFF_CHAT_API_URL: toolBaseUrl,
        CAFF_CHAT_INVOCATION_ID: toolInvocation.invocationId,
        CAFF_CHAT_CALLBACK_TOKEN: toolInvocation.callbackToken,
        CAFF_CHAT_TOOLS_PATH: toPortableShellPath(agentToolScriptPath),
        CAFF_CHAT_TOOLS_RELATIVE_PATH: agentToolRelativePath,
        CAFF_CHAT_CONVERSATION_ID: conversationId,
        CAFF_CHAT_TURN_ID: turnId,
      },
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
        promptVersion: AGENT_PROMPT_VERSION,
        agentSandboxDir: agentSandbox.sandboxDir,
        agentPrivateDir: agentSandbox.privateDir,
        modelProfileId: agentConfig.profileId,
        modelProfileName: agentConfig.profileName,
        skillIds: agentConfig.skillIds,
        conversationSkillIds: agentConfig.conversationSkillIds,
        hop,
        routingMode,
        triggerType: queueItem.triggerType || 'user',
        triggeredByAgentId: queueItem.triggeredByAgentId || null,
        toolBridgeEnabled: true,
      },
    });
    registerTurnHandle(turnState, handle);

    const startedAt = nowIso();
    let rawReply = '';
    const startedMetadata = {
      ...queuedMetadata,
      sessionPath: handle.sessionPath || '',
      streaming: true,
      toolInvocationId: toolInvocation.invocationId,
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
    turnState.updatedAt = startedAt;
    syncCurrentTurnAgent(turnState);

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
      routingMode,
    });

    broadcastEvent('conversation_message_updated', { conversationId, message: startedMessage });
    emitTurnProgress(turnState);

    handle.on('assistant_text_delta', (event: any) => {
      rawReply += event.delta || '';

      if (!toolInvocation.publicToolUsed) {
        return;
      }

      const previewText = toolInvocation.lastPublicContent || extractStreamingPublicReplyPreview(rawReply) || '';
      const deltaTimestamp = nowIso();
      stage.status = 'running';
      stage.replyLength = previewText.length;
      stage.preview = clipText(previewText, TURN_PREVIEW_LENGTH);
      stage.lastTextDeltaAt = deltaTimestamp;
      turnState.updatedAt = deltaTimestamp;
      syncCurrentTurnAgent(turnState);
      emitTurnProgress(turnState);
    });

    handle.on('heartbeat', (event: any) => {
      stage.heartbeatCount = event.count || 0;
      turnState.updatedAt = nowIso();
      runStore.appendTaskEvent(stageTaskId, 'agent_reply_heartbeat', {
        count: event.count,
        reason: sanitizeReason(event.payload && event.payload.reason),
      });
      emitTurnProgress(turnState);
    });

    handle.on('run_terminating', (event: any) => {
      stage.status = 'terminating';
      stage.errorMessage = event.reason && event.reason.message ? event.reason.message : '';
      turnState.updatedAt = nowIso();
      syncCurrentTurnAgent(turnState);
      runStore.appendTaskEvent(stageTaskId, 'agent_reply_terminating', event.reason || null);
      emitTurnProgress(turnState);
    });

    try {
      const result = await handle.resultPromise;
      const finalRawReply = String(result.reply || rawReply || '').trim();

      // Fallback: some models print a bash heredoc as plain text instead of emitting a tool_use block.
      // When that happens, the command never runs and the game host cannot see the intended vote / action.
      // We replay the safest subset of bridge commands (send-public/send-private via --content-stdin heredoc)
      // by directly invoking the agent tool bridge, then continue with normal decision parsing.
      if (
        agentToolBridge &&
        !toolInvocation.publicToolUsed &&
        (toolInvocation.privatePostCount || 0) === 0 &&
        finalRawReply
      ) {
        const replay = pickChatBridgeReplay(extractChatBridgeReplaysFromText(finalRawReply), {
          privateOnly: Boolean(queueItem && queueItem.privateOnly),
        });

        if (replay) {
          try {
            const body: any = {
              invocationId: toolInvocation.invocationId,
              callbackToken: toolInvocation.callbackToken,
              visibility: replay.visibility,
              content: replay.content,
            };

            if (replay.visibility === 'public') {
              body.mode = replay.mode || 'replace';
            } else {
              if (replay.recipients.length > 0) {
                body.recipientAgentIds = replay.recipients;
              }

              if (replay.handoff) {
                body.handoff = true;
              }

              if (replay.noHandoff) {
                body.noHandoff = true;
              }
            }

            agentToolBridge.handlePostMessage(body);
          } catch {
            // Ignore fallback failures and keep the raw reply.
          }
        }
      }

      const suppressRawPublicReply = !toolInvocation.publicToolUsed && (toolInvocation.privatePostCount || 0) > 0;
      const decisionSource =
        toolInvocation.publicToolUsed && String(toolInvocation.lastPublicContent || '').trim()
          ? String(toolInvocation.lastPublicContent || '').trim()
          : finalRawReply;
      const decision = parseAgentTurnDecision(decisionSource, conversation.agents, {
        currentAgentId: agent.id,
        allowEmptyReply: suppressRawPublicReply,
      });
      const mentionedAgents = decision.mentions
        .map((agentId: any) => getAgentById(conversation.agents, agentId))
        .filter(Boolean);
      const publicReply = suppressRawPublicReply ? '' : ensureVisibleMentionText(decision.publicReply, mentionedAgents);
      const publiclySilent = !String(publicReply || '').trim();
      const privateOnly = publiclySilent && suppressRawPublicReply;
      const routedMentions = allowHandoffs ? decision.mentions : [];
      const privateHandoffCount = toolInvocation.privateHandoffCount || 0;
      const continuedByPrivateHandoff = allowHandoffs && privateHandoffCount > 0;
      const effectiveFinal = allowHandoffs ? decision.final && !continuedByPrivateHandoff : true;
      const finalMetadata = {
        provider,
        model,
        promptVersion: AGENT_PROMPT_VERSION,
        heartbeatCount: result.heartbeatCount || 0,
        sessionName,
        sessionScope: 'agent_turn',
        sessionPath: result.sessionPath || handle.sessionPath || '',
        agentSandboxDir: agentSandbox.sandboxDir,
        agentPrivateDir: agentSandbox.privateDir,
        streaming: false,
        routingMode,
        hop,
        mentions: decision.mentions,
        routedMentions,
        mentionNames: mentionedAgents.map((item: any) => item.name),
        final: effectiveFinal,
        reason: decision.reason || '',
        fallback: Boolean(decision.fallback),
        handoffSuppressed: !allowHandoffs && decision.mentions.length > 0,
        toolBridgeEnabled: true,
        publicToolUsed: Boolean(toolInvocation.publicToolUsed),
        publicPostCount: toolInvocation.publicPostCount || 0,
        privatePostCount: toolInvocation.privatePostCount || 0,
        privateHandoffCount,
        continuedByPrivateHandoff,
        publiclySilent,
        privateOnly,
        silentReply: Boolean(decision.silent),
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
      stage.status = 'completed';
      stage.runId = result.runId || handle.runId || null;
      stage.heartbeatCount = result.heartbeatCount || 0;
      stage.replyLength = publicReply.length;
      stage.preview = clipText(publicReply, TURN_PREVIEW_LENGTH);
      stage.errorMessage = '';
      stage.lastTextDeltaAt = stage.lastTextDeltaAt || null;
      stage.endedAt = nowIso();
      turnState.completedCount += 1;
      turnState.updatedAt = nowIso();
      syncCurrentTurnAgent(turnState);

      runStore.updateTask(stageTaskId, {
        status: 'succeeded',
        runId: result.runId || handle.runId || null,
        sessionPath: result.sessionPath,
        outputText: publicReply,
        endedAt: stage.endedAt,
        artifactSummary: {
          kind: 'text/plain',
          name: `${agent.name}-reply.txt`,
          mentions: decision.mentions,
          routedMentions,
          final: effectiveFinal,
          hop,
        },
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
          routedMentions,
          final: effectiveFinal,
          publicToolUsed: Boolean(toolInvocation.publicToolUsed),
          privateHandoffCount,
          continuedByPrivateHandoff,
          publiclySilent,
          privateOnly,
          silentReply: Boolean(decision.silent),
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
        routedMentions,
        final: effectiveFinal,
        privateHandoffCount,
      });

      broadcastEvent('conversation_message_updated', { conversationId, message: assistantMessageDone });
      broadcastConversationSummary(conversationId);
      emitTurnProgress(turnState);

      if (!allowHandoffs) {
        return {
          stopTurn: false,
          terminationReason: '',
        };
      }

      if (effectiveFinal) {
        if (!finalStopsTurn) {
          return {
            stopTurn: false,
            terminationReason: '',
          };
        }

        runStore.appendTaskEvent(rootTaskId, 'agent_turn_finalized', {
          conversationId,
          turnId,
          agentId: agent.id,
          agentName: agent.name,
          messageId: assistantMessageDone.id,
          hop,
        });

        return {
          stopTurn: true,
          terminationReason: 'agent_final',
        };
      }

      const enqueuedAgentIds =
        enqueueAgent && routedMentions.length > 0
          ? enqueueAgent({
              agentIds: routedMentions,
              triggerType: 'agent',
              triggeredByAgentId: agent.id,
              triggeredByAgentName: agent.name,
              triggeredByMessageId: assistantMessageDone.id,
              parentRunId: result.runId || handle.runId || null,
              enqueueReason: decision.reason || '',
            })
          : [];

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

      return {
        stopTurn: false,
        terminationReason: '',
      };
    } catch (error) {
      const errorValue = error as any;
      const errorMessage = errorValue && errorValue.message ? errorValue.message : String(errorValue || 'Unknown error');
      const stopRequested = Boolean(turnState.stopRequested);
      const existingMessage = store.getMessage(assistantMessage.id);
      const assistantMessageFailed = store.updateMessage(assistantMessage.id, {
        content: existingMessage && existingMessage.content !== 'Thinking...' ? existingMessage.content : '',
        status: 'failed',
        taskId: stageTaskId,
        runId: errorValue && errorValue.runId ? errorValue.runId : handle.runId || null,
        errorMessage,
        metadata: {
          provider,
          model,
          sessionName,
          sessionScope: 'agent_turn',
          sessionPath: errorValue && errorValue.sessionPath ? errorValue.sessionPath : handle.sessionPath || '',
          agentSandboxDir: agentSandbox.sandboxDir,
          agentPrivateDir: agentSandbox.privateDir,
          failure: true,
          streaming: false,
          routingMode,
          hop,
          cancelled: stopRequested,
          toolBridgeEnabled: true,
          publicToolUsed: Boolean(toolInvocation.publicToolUsed),
          publicPostCount: toolInvocation.publicPostCount || 0,
          privatePostCount: toolInvocation.privatePostCount || 0,
          privateHandoffCount: toolInvocation.privateHandoffCount || 0,
          triggeredByAgentId: queueItem.triggeredByAgentId || null,
          triggeredByAgentName: queueItem.triggeredByAgentName || '',
          triggeredByMessageId: queueItem.triggeredByMessageId || null,
          triggerType: queueItem.triggerType || 'user',
        },
      });

      stage.status = 'failed';
      stage.runId = errorValue && errorValue.runId ? errorValue.runId : handle.runId || null;
      stage.replyLength = assistantMessageFailed && assistantMessageFailed.content ? assistantMessageFailed.content.length : 0;
      stage.preview = clipText(
        assistantMessageFailed && assistantMessageFailed.content ? assistantMessageFailed.content : errorMessage,
        TURN_PREVIEW_LENGTH
      );
      stage.errorMessage = errorMessage;
      stage.lastTextDeltaAt = stage.lastTextDeltaAt || null;
      stage.endedAt = nowIso();

      if (!stopRequested) {
        failedReplies.push(assistantMessageFailed);
        turnState.failedCount += 1;
      }

      turnState.updatedAt = nowIso();
      syncCurrentTurnAgent(turnState);

      runStore.updateTask(stageTaskId, {
        status: stopRequested ? 'cancelled' : 'failed',
        runId: errorValue && errorValue.runId ? errorValue.runId : handle.runId || null,
        errorMessage,
        endedAt: stage.endedAt,
      });
      runStore.appendTaskEvent(stageTaskId, 'agent_reply_failed', {
        agentId: agent.id,
        agentName: agent.name,
        runId: errorValue && errorValue.runId ? errorValue.runId : handle.runId || null,
        errorMessage,
        hop,
      });

      broadcastEvent('conversation_message_updated', { conversationId, message: assistantMessageFailed });
      broadcastConversationSummary(conversationId);
      emitTurnProgress(turnState);

      if (stopRequested) {
        return {
          stopTurn: true,
          terminationReason: 'stopped_by_user',
        };
      }

      return {
        stopTurn: false,
        terminationReason: '',
      };
    } finally {
      agentToolBridge.unregisterInvocation(toolInvocation && toolInvocation.invocationId);
      unregisterTurnHandle(turnState, handle);
    }
  }

  return {
    executeConversationAgent,
    parseAgentTurnDecision,
  };
}
