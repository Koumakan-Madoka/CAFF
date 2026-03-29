const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createHttpError } = require('../../http/http-errors');
const { pickConversationSummary, serializeConversationPrivateMessageForUi } = require('../conversation/conversation-view');
const { buildAgentMentionLookup, formatAgentMention, resolveMentionValues } = require('../conversation/mention-routing');

const MAX_HISTORY_MESSAGES = 24;
const MAX_PRIVATE_CONTEXT_MESSAGES = 16;
const TURN_PREVIEW_LENGTH = 180;

function nowIso() {
  return new Date().toISOString();
}

function clipText(text: any, maxLength = 240) {
  const value = String(text || '').trim();

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function normalizePromptUserMessageSnapshot(message: any, fallback: any = {}) {
  if (!message || typeof message !== 'object') {
    return null;
  }

  return {
    id: String(message.id || fallback.userMessageId || '').trim(),
    turnId: String(message.turnId || fallback.turnId || '').trim(),
    role: String(message.role || 'user').trim() || 'user',
    agentId: message.agentId || null,
    senderName: String(message.senderName || fallback.senderName || 'You').trim() || 'You',
    content: String(message.content || ''),
    status: String(message.status || 'completed').trim() || 'completed',
    createdAt: String(message.createdAt || fallback.createdAt || '').trim() || nowIso(),
  };
}

export function createAgentToolBridge(options: any = {}) {
  const store = options.store;
  const broadcastEvent = typeof options.broadcastEvent === 'function' ? options.broadcastEvent : () => {};
  const broadcastConversationSummary =
    typeof options.broadcastConversationSummary === 'function' ? options.broadcastConversationSummary : () => {};
  const onTurnUpdated = typeof options.onTurnUpdated === 'function' ? options.onTurnUpdated : () => {};
  const activeInvocations = new Map();

  function createInvocationContext(input: any = {}) {
    const invocationId = String(input.invocationId || randomUUID()).trim();
    const callbackToken = String(input.callbackToken || randomUUID()).trim();
    const promptUserMessage = normalizePromptUserMessageSnapshot(input.promptUserMessage, {
      userMessageId: input.userMessageId,
      turnId: input.turnId,
      createdAt: input.createdAt,
    });

    return {
      invocationId,
      callbackToken,
      conversationId: String(input.conversationId || '').trim(),
      turnId: String(input.turnId || '').trim(),
      projectDir: String(input.projectDir || '').trim(),
      agentId: String(input.agentId || '').trim(),
      agentName: String(input.agentName || '').trim() || 'Assistant',
      assistantMessageId: String(input.assistantMessageId || '').trim(),
      userMessageId: String(input.userMessageId || (promptUserMessage && promptUserMessage.id) || '').trim(),
      promptUserMessage,
      conversationAgents: Array.isArray(input.conversationAgents) ? input.conversationAgents.slice() : [],
      stage: input.stage || null,
      turnState: input.turnState || null,
      enqueueAgent: typeof input.enqueueAgent === 'function' ? input.enqueueAgent : null,
      allowHandoffs: input.allowHandoffs !== false,
      publicToolUsed: false,
      publicPostCount: 0,
      privatePostCount: 0,
      privateHandoffCount: 0,
      lastPublicContent: '',
      lastPublicPostedAt: '',
      closedAt: '',
      createdAt: nowIso(),
    };
  }

  function registerInvocation(context: any) {
    if (!context || !context.invocationId) {
      return null;
    }

    activeInvocations.set(context.invocationId, context);
    return context;
  }

  function getInvocation(invocationId: any, callbackToken: any) {
    const normalizedInvocationId = String(invocationId || '').trim();
    const normalizedCallbackToken = String(callbackToken || '').trim();
    const context = activeInvocations.get(normalizedInvocationId);
    const stageStatus = String(context && context.stage && context.stage.status ? context.stage.status : '')
      .trim()
      .toLowerCase();

    if (!context || !normalizedCallbackToken || context.callbackToken !== normalizedCallbackToken) {
      throw createHttpError(401, 'Invalid or expired agent tool credentials');
    }

    if (
      context.closedAt ||
      (context.turnState && context.turnState.stopRequested) ||
      (stageStatus && stageStatus !== 'queued' && stageStatus !== 'running')
    ) {
      activeInvocations.delete(normalizedInvocationId);
      throw createHttpError(409, 'This agent tool invocation is no longer active');
    }

    return context;
  }

  function unregisterInvocation(invocationId: any) {
    const normalizedInvocationId = String(invocationId || '').trim();

    if (!normalizedInvocationId) {
      return null;
    }

    const context = activeInvocations.get(normalizedInvocationId) || null;

    if (context) {
      context.closedAt = nowIso();
    }

    activeInvocations.delete(normalizedInvocationId);
    return context;
  }

  function serializeAgentToolPublicMessage(message: any) {
    const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
    const toolBridgeMetadata =
      metadata && metadata.toolBridge && typeof metadata.toolBridge === 'object' ? metadata.toolBridge : null;
    return {
      id: message.id,
      role: message.role,
      agentId: message.agentId || null,
      senderName: message.senderName,
      content: message.content,
      status: message.status,
      createdAt: message.createdAt,
      publicPostedAt: toolBridgeMetadata && toolBridgeMetadata.lastPublicPostedAt ? toolBridgeMetadata.lastPublicPostedAt : '',
      publicPostCount: toolBridgeMetadata && Number.isInteger(toolBridgeMetadata.publicPostCount) ? toolBridgeMetadata.publicPostCount : 0,
      publicPostMode: toolBridgeMetadata && toolBridgeMetadata.lastPublicMode ? toolBridgeMetadata.lastPublicMode : '',
      mentions: metadata && Array.isArray(metadata.mentions) ? metadata.mentions : [],
    };
  }

  function serializeAgentToolPrivateMessage(message: any) {
    return {
      id: message.id,
      turnId: message.turnId,
      senderAgentId: message.senderAgentId || null,
      senderName: message.senderName,
      recipientAgentIds: Array.isArray(message.recipientAgentIds) ? message.recipientAgentIds : [],
      content: message.content,
      createdAt: message.createdAt,
    };
  }

  function serializeAgentToolParticipants(agents: any) {
    return (Array.isArray(agents) ? agents : []).map((agent: any) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description || '',
      mention: formatAgentMention(agent),
    }));
  }

  function resolveContextUserMessage(context: any, conversation: any) {
    const snapshot = context && context.promptUserMessage ? normalizePromptUserMessageSnapshot(context.promptUserMessage) : null;
    const messages = conversation && Array.isArray(conversation.messages) ? conversation.messages : [];
    const targetUserMessageId = String(context && context.userMessageId ? context.userMessageId : '').trim();
    const matchedConversationMessage =
      messages.find((message: any) => message && message.id === targetUserMessageId && message.role === 'user') ||
      [...messages].reverse().find((message: any) => message && message.role === 'user') ||
      null;

    if (!snapshot && !matchedConversationMessage) {
      return null;
    }

    const base = matchedConversationMessage || snapshot;
    return {
      ...(matchedConversationMessage || {}),
      ...(snapshot || {}),
      id: String(
        (snapshot && snapshot.id) || (matchedConversationMessage && matchedConversationMessage.id) || targetUserMessageId || ''
      ).trim(),
      turnId: String(
        (snapshot && snapshot.turnId) || (matchedConversationMessage && matchedConversationMessage.turnId) || context.turnId || ''
      ).trim(),
      role: 'user',
      agentId:
        (matchedConversationMessage && matchedConversationMessage.agentId) || (snapshot && snapshot.agentId) || null,
      senderName: String(
        (snapshot && snapshot.senderName) || (matchedConversationMessage && matchedConversationMessage.senderName) || 'You'
      ).trim() || 'You',
      content: String(
        snapshot && snapshot.content !== undefined
          ? snapshot.content
          : matchedConversationMessage && matchedConversationMessage.content !== undefined
            ? matchedConversationMessage.content
            : ''
      ),
      status: String(
        (snapshot && snapshot.status) || (matchedConversationMessage && matchedConversationMessage.status) || 'completed'
      ).trim() || 'completed',
      createdAt: String(
        (snapshot && snapshot.createdAt) || (matchedConversationMessage && matchedConversationMessage.createdAt) || nowIso()
      ).trim() || nowIso(),
      metadata:
        matchedConversationMessage && matchedConversationMessage.metadata && typeof matchedConversationMessage.metadata === 'object'
          ? matchedConversationMessage.metadata
          : null,
    };
  }

  function applyContextUserMessageSnapshot(message: any, contextUserMessage: any) {
    if (!message || !contextUserMessage || message.id !== contextUserMessage.id) {
      return message;
    }

    return {
      ...message,
      content: contextUserMessage.content,
      senderName: contextUserMessage.senderName,
      status: contextUserMessage.status,
      createdAt: contextUserMessage.createdAt,
    };
  }

  function buildAgentToolContextPayload(context: any, options: any = {}) {
    const publicLimit = Number.isInteger(options.publicLimit) && options.publicLimit > 0 ? options.publicLimit : MAX_HISTORY_MESSAGES;
    const privateLimit =
      Number.isInteger(options.privateLimit) && options.privateLimit > 0 ? options.privateLimit : MAX_PRIVATE_CONTEXT_MESSAGES;
    const conversation = store.getConversation(context.conversationId);
    const contextUserMessage = resolveContextUserMessage(context, conversation);
    const publicMessageSource = conversation
      ? conversation.messages.filter((message: any) => {
          return !(
            message.id === context.assistantMessageId &&
            message.status !== 'completed' &&
            String(message.content || '').trim() === 'Thinking...'
          );
        })
      : [];
    let selectedPublicMessages = publicMessageSource
      .slice(-publicLimit)
      .map((message: any) => applyContextUserMessageSnapshot(message, contextUserMessage));

    if (
      contextUserMessage &&
      !selectedPublicMessages.some((message: any) => message && message.id === contextUserMessage.id)
    ) {
      selectedPublicMessages = [contextUserMessage, ...selectedPublicMessages];
    }

    const publicMessages = selectedPublicMessages.map(serializeAgentToolPublicMessage);
    const privateMessages = store
      .listPrivateMessagesForAgent(context.conversationId, context.agentId, { limit: privateLimit })
      .map(serializeAgentToolPrivateMessage);

    return {
      conversation: conversation ? pickConversationSummary(conversation) : null,
      agent: {
        id: context.agentId,
        name: context.agentName,
      },
      participants: conversation ? serializeAgentToolParticipants(conversation.agents) : [],
      latestUserMessage: contextUserMessage ? serializeAgentToolPublicMessage(contextUserMessage) : null,
      publicMessages,
      privateMessages,
    };
  }

  function normalizeAgentToolRecipientValues(value: any): string[] {
    if (Array.isArray(value)) {
      return value.flatMap((item: any) => normalizeAgentToolRecipientValues(item));
    }

    if (typeof value === 'string') {
      return value
        .split(/[,\n\r;，；]+/u)
        .map((item: any) => item.trim())
        .filter(Boolean);
    }

    return [];
  }

  function resolveAgentToolRecipientIds(recipientValues: any, agents: any) {
    const lookup = buildAgentMentionLookup(agents);
    return resolveMentionValues(normalizeAgentToolRecipientValues(recipientValues), agents, { lookup });
  }

  function applyAgentToolPublicUpdate(context: any, content: any, mode = 'replace') {
    const existingMessage = store.getMessage(context.assistantMessageId);

    if (!existingMessage) {
      throw createHttpError(404, 'Active assistant message not found');
    }

    const timestamp = nowIso();
    const normalizedMode = String(mode || 'replace').trim().toLowerCase();
    const currentContent = String(existingMessage.content || '');
    const nextContent =
      normalizedMode === 'append' && currentContent && currentContent !== 'Thinking...' ? `${currentContent}${content}` : content;
    const existingMetadata = existingMessage.metadata && typeof existingMessage.metadata === 'object' ? existingMessage.metadata : {};
    const nextMetadata = {
      ...existingMetadata,
      toolBridge: {
        ...(existingMetadata.toolBridge && typeof existingMetadata.toolBridge === 'object' ? existingMetadata.toolBridge : {}),
        enabled: true,
        publicPosted: true,
        publicPostCount: (context.publicPostCount || 0) + 1,
        lastPublicPostedAt: timestamp,
        lastPublicMode: normalizedMode,
      },
    };
    const updatedMessage = store.updateMessage(context.assistantMessageId, {
      content: nextContent,
      metadata: nextMetadata,
    });

    context.publicToolUsed = true;
    context.publicPostCount = (context.publicPostCount || 0) + 1;
    context.lastPublicContent = nextContent;
    context.lastPublicPostedAt = timestamp;

    if (context.stage) {
      context.stage.status = 'running';
      context.stage.replyLength = nextContent.length;
      context.stage.preview = clipText(nextContent, TURN_PREVIEW_LENGTH);
      context.stage.lastTextDeltaAt = timestamp;
    }

    if (context.turnState) {
      context.turnState.updatedAt = timestamp;
      onTurnUpdated(context.turnState);
    }

    broadcastEvent('conversation_message_updated', { conversationId: context.conversationId, message: updatedMessage });
    broadcastConversationSummary(context.conversationId);

    return updatedMessage;
  }

  function handlePostMessage(body: any = {}) {
    const context = getInvocation(body.invocationId, body.callbackToken);
    const content = String(body.content || '').trim();

    if (!content) {
      throw createHttpError(400, 'Message content is required');
    }

    const visibility = String(body.visibility || 'public').trim().toLowerCase();

    if (visibility === 'public') {
      const message = applyAgentToolPublicUpdate(context, content, body.mode);
      return {
        ok: true,
        visibility: 'public',
        message: serializeAgentToolPublicMessage(message),
      };
    }

    if (visibility === 'private') {
      const conversation = store.getConversation(context.conversationId);

      if (!conversation) {
        throw createHttpError(404, 'Conversation not found');
      }

      const recipientAgentIds = resolveAgentToolRecipientIds(
        body.recipientAgentIds !== undefined ? body.recipientAgentIds : body.recipients,
        conversation.agents
      );
      const resolvedRecipientAgentIds = recipientAgentIds.length > 0 ? recipientAgentIds : [context.agentId];
      const handoffAgentIds = resolvedRecipientAgentIds.filter((agentId: any) => agentId && agentId !== context.agentId);
      const explicitHandoff = body.handoff === true || body.triggerReply === true;
      const explicitNoHandoff = body.handoff === false || body.triggerReply === false || body.noHandoff === true;
      const handoffRequested = !explicitNoHandoff && (explicitHandoff || handoffAgentIds.length > 0);

      if (handoffRequested && !context.allowHandoffs) {
        throw createHttpError(409, 'Private handoff is not available in this turn mode');
      }

      if (handoffRequested && typeof context.enqueueAgent !== 'function') {
        throw createHttpError(409, 'Private handoff is not available for this run');
      }

      if (handoffRequested && handoffAgentIds.length === 0) {
        throw createHttpError(400, 'Private handoff requires at least one recipient other than yourself');
      }

      const privateMessage = store.createPrivateMessage({
        conversationId: context.conversationId,
        turnId: context.turnId,
        senderAgentId: context.agentId,
        senderName: context.agentName,
        recipientAgentIds: resolvedRecipientAgentIds,
        content,
        metadata: {
          source: 'agent-tool',
          handoffRequested,
        },
      });

      context.privatePostCount = (context.privatePostCount || 0) + 1;
      let enqueuedAgentIds = [];

      if (handoffRequested) {
        enqueuedAgentIds = context.enqueueAgent({
          agentIds: handoffAgentIds,
          triggerType: 'private',
          triggeredByAgentId: context.agentId,
          triggeredByAgentName: context.agentName,
          triggeredByMessageId: privateMessage.id,
          parentRunId: context.stage && context.stage.runId ? context.stage.runId : null,
          enqueueReason: 'private_message',
        });
        context.privateHandoffCount = (context.privateHandoffCount || 0) + enqueuedAgentIds.length;

        if (context.turnState) {
          context.turnState.updatedAt = nowIso();
          onTurnUpdated(context.turnState);
        }
      }

      broadcastEvent('conversation_private_message_created', {
        conversationId: context.conversationId,
        message: serializeConversationPrivateMessageForUi(privateMessage, conversation.agents),
      });

      return {
        ok: true,
        visibility: 'private',
        message: serializeAgentToolPrivateMessage(privateMessage),
        handoffRequested,
        enqueuedAgentIds,
      };
    }

    throw createHttpError(400, 'Unsupported visibility. Use public or private.');
  }

  function handleReadContext(requestUrl: any) {
    const context = getInvocation(
      requestUrl.searchParams.get('invocationId'),
      requestUrl.searchParams.get('callbackToken')
    );
    const publicLimit = Number.parseInt(requestUrl.searchParams.get('publicLimit') || '', 10);
    const privateLimit = Number.parseInt(requestUrl.searchParams.get('privateLimit') || '', 10);

    return {
      ok: true,
      ...buildAgentToolContextPayload(context, {
        publicLimit: Number.isFinite(publicLimit) ? publicLimit : undefined,
        privateLimit: Number.isFinite(privateLimit) ? privateLimit : undefined,
      }),
    };
  }

  function handleListParticipants(requestUrl: any) {
    const context = getInvocation(
      requestUrl.searchParams.get('invocationId'),
      requestUrl.searchParams.get('callbackToken')
    );
    const conversation = store.getConversation(context.conversationId);

    return {
      ok: true,
      conversation: conversation ? pickConversationSummary(conversation) : null,
      participants: conversation ? serializeAgentToolParticipants(conversation.agents) : [],
    };
  }

  function safeStat(filePath: any) {
    try {
      return fs.statSync(filePath);
    } catch {
      return null;
    }
  }

  function safeLstat(filePath: any) {
    try {
      return fs.lstatSync(filePath);
    } catch {
      return null;
    }
  }

  function isPathWithinDir(rootDir: any, candidatePath: any) {
    const resolvedRoot = path.resolve(String(rootDir || '').trim());
    const resolvedCandidate = path.resolve(String(candidatePath || '').trim());

    if (!resolvedRoot || !resolvedCandidate) {
      return false;
    }

    const rootKey = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
    const candidateKey = process.platform === 'win32' ? resolvedCandidate.toLowerCase() : resolvedCandidate;

    const relative = path.relative(rootKey, candidateKey);

    if (!relative) {
      return true;
    }

    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  function normalizeTaskName(value: any, fallback = 'demo') {
    const normalized = String(value || '').trim() || String(fallback || '').trim();

    if (!normalized) {
      return '';
    }

    if (normalized === '.' || normalized === '..') {
      return '';
    }

    if (normalized.includes('/') || normalized.includes('\\')) {
      return '';
    }

    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)) {
      return '';
    }

    return normalized;
  }

  function normalizeTrellisRelativePath(value: any) {
    let normalized = String(value || '').trim();

    if (!normalized) {
      return '';
    }

    if (path.isAbsolute(normalized)) {
      return '';
    }

    normalized = normalized.replace(/\\/g, '/');
    while (normalized.startsWith('./')) {
      normalized = normalized.slice(2);
    }
    while (normalized.startsWith('/')) {
      normalized = normalized.slice(1);
    }

    const parts = normalized
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => part !== '.');

    if (parts.length === 0) {
      return '';
    }

    if (parts.some((part) => part === '..')) {
      return '';
    }

    if (parts[0] !== '.trellis') {
      parts.unshift('.trellis');
    }

    if (parts.length <= 1) {
      return '';
    }

    return parts.join('/');
  }

  function hasSymlinkInPath(rootDir: any, candidatePath: any) {
    const resolvedRoot = path.resolve(String(rootDir || '').trim());
    const resolvedCandidate = path.resolve(String(candidatePath || '').trim());

    if (!resolvedRoot || !resolvedCandidate) {
      return false;
    }

    if (!isPathWithinDir(resolvedRoot, resolvedCandidate)) {
      return false;
    }

    const relative = path.relative(resolvedRoot, resolvedCandidate);

    if (!relative) {
      const stat = safeLstat(resolvedRoot);
      return Boolean(stat && stat.isSymbolicLink());
    }

    const parts = relative.split(path.sep).filter(Boolean);
    let current = resolvedRoot;

    for (const part of parts) {
      current = path.join(current, part);
      const stat = safeLstat(current);
      if (stat && stat.isSymbolicLink()) {
        return true;
      }
    }

    return false;
  }

  function buildTrellisInitFiles(taskName: string) {
    const safeTaskName = String(taskName || '').trim() || 'demo';

    const trellisGitignore = [
      '# Local-only Trellis runtime files',
      '.developer',
      '.current-task',
      '.ralph-state.json',
      '.agents/',
      '.agent-log',
      '.session-id',
      '.plan-log',
      '',
      '# Atomic update temp files',
      '*.tmp',
      '*.new',
      '',
      '# Update backup directories',
      '.backup-*',
      '',
      '# Python cache (if you use Trellis scripts)',
      '**/__pycache__/',
      '**/*.pyc',
      '',
    ].join('\n');

    const workflow = [
      '# Trellis Workflow',
      '',
      'This folder is used by CAFF to inject lightweight task/PRD/workflow context into agent prompts.',
      '',
      'Quick start:',
      `1) Set the current task in \`.trellis/.current-task\` (example: \`.trellis/tasks/${safeTaskName}\`).`,
      '2) Write a PRD in `.trellis/tasks/<task>/prd.md`.',
      '3) Edit JSONL context files to list relevant specs/files for each phase:',
      '   - implement.jsonl: dev specs + patterns to follow',
      '   - check.jsonl: review/quality criteria',
      '   - spec.jsonl: fallback specs (used when phase-specific JSONL is empty)',
      '',
      'JSONL format (one JSON object per line):',
      '  {"file": ".trellis/spec/backend/index.md", "reason": "Backend guidelines"}',
      '  {"file": "src/server/index.ts", "reason": "Entry point"}',
      '',
      'Optional:',
      '- Add spec index files under `.trellis/spec/**/index.md` for discoverability hints.',
      '',
    ].join('\n');

    const taskJson = JSON.stringify(
      {
        title: `Task: ${safeTaskName}`,
        status: 'active',
        createdAt: new Date().toISOString().slice(0, 10),
      },
      null,
      2
    );

    const prd = [
      `# PRD: ${safeTaskName}`,
      '',
      '## Goal',
      '- Describe what you want to build.',
      '',
      '## Scope',
      '- In scope:',
      '- Out of scope:',
      '',
      '## Acceptance Criteria',
      '- [ ] Item 1',
      '',
    ].join('\n');

    const taskDirRef = `.trellis/tasks/${safeTaskName}`;
    const implementJsonl = [
      JSON.stringify({ file: `${taskDirRef}/prd.md`, reason: 'Task requirements (PRD).' }),
      JSON.stringify({ file: '.trellis/spec/index.md', reason: 'Project spec index (edit/add more spec files).' }),
    ].join('\n');

    const checkJsonl = [JSON.stringify({ file: `${taskDirRef}/prd.md`, reason: 'Acceptance criteria to verify.' })].join(
      '\n'
    );

    const specJsonl = [JSON.stringify({ file: '.trellis/spec/index.md', reason: 'Shared spec fallback.' })].join('\n');

    const specIndex = ['# Spec Index', '', 'Add relevant spec links here.', ''].join('\n');

    return [
      { relativePath: '.trellis/.gitignore', content: trellisGitignore },
      { relativePath: '.trellis/workflow.md', content: workflow },
      { relativePath: '.trellis/.current-task', content: `${taskDirRef}\n` },
      { relativePath: '.trellis/spec/index.md', content: specIndex },
      { relativePath: `.trellis/tasks/${safeTaskName}/task.json`, content: `${taskJson}\n` },
      { relativePath: `.trellis/tasks/${safeTaskName}/prd.md`, content: `${prd}\n` },
      { relativePath: `.trellis/tasks/${safeTaskName}/implement.jsonl`, content: `${implementJsonl}\n` },
      { relativePath: `.trellis/tasks/${safeTaskName}/check.jsonl`, content: `${checkJsonl}\n` },
      { relativePath: `.trellis/tasks/${safeTaskName}/spec.jsonl`, content: `${specJsonl}\n` },
    ];
  }

  function handleTrellisInit(body: any = {}) {
    const context = getInvocation(body.invocationId, body.callbackToken);
    const includeContent = body.includeContent === true;
    const confirm = body.confirm === true;
    const force = body.force === true;
    const taskName = normalizeTaskName(body.taskName || body.task || body.name, 'demo');

    if (!taskName) {
      throw createHttpError(400, 'taskName must be a simple directory name (letters/numbers/._-)');
    }

    const projectDirRaw = String(context.projectDir || '').trim();

    if (!projectDirRaw) {
      throw createHttpError(409, 'No active project directory is available for this invocation');
    }

    const projectDir = path.resolve(projectDirRaw);
    const projectStat = safeStat(projectDir);

    if (!projectStat || !projectStat.isDirectory()) {
      throw createHttpError(409, 'Active project directory does not exist or is not a folder');
    }

    const trellisDir = path.join(projectDir, '.trellis');
    const trellisLstat = safeLstat(trellisDir);

    if (trellisLstat && trellisLstat.isSymbolicLink()) {
      throw createHttpError(400, 'Refusing to write .trellis because it is a symlink');
    }

    const files = buildTrellisInitFiles(taskName);
    const operations: any[] = [];

    for (const file of files) {
      const absolutePath = path.resolve(projectDir, file.relativePath);
      const withinTrellis = isPathWithinDir(trellisDir, absolutePath);

      if (!withinTrellis) {
        throw createHttpError(400, `Refusing to write outside .trellis: ${file.relativePath}`);
      }

      const exists = fs.existsSync(absolutePath);
      const existingStat = exists ? safeStat(absolutePath) : null;
      const action =
        existingStat && existingStat.isDirectory()
          ? 'conflict-directory'
          : exists
            ? force
              ? 'overwrite'
              : 'skip-existing'
            : 'create';

      operations.push({
        path: file.relativePath.replace(/\\/g, '/'),
        action,
        bytes: Buffer.byteLength(file.content, 'utf8'),
        ...(includeContent ? { content: file.content } : {}),
      });
    }

    if (!confirm) {
      return {
        ok: true,
        applied: false,
        projectDir,
        trellisDir,
        taskName,
        operations,
        willWriteCount: operations.filter((op) => op.action === 'create' || op.action === 'overwrite').length,
        skippedCount: operations.filter((op) => op.action === 'skip-existing').length,
        confirmRequired: true,
      };
    }

    fs.mkdirSync(trellisDir, { recursive: true });

    if (hasSymlinkInPath(projectDir, trellisDir)) {
      throw createHttpError(400, 'Refusing to write .trellis because it contains a symlink');
    }

    for (const file of files) {
      const absolutePath = path.resolve(projectDir, file.relativePath);
      const exists = fs.existsSync(absolutePath);
      const existingStat = exists ? safeStat(absolutePath) : null;

      if (existingStat && existingStat.isDirectory()) {
        throw createHttpError(400, `Refusing to write because path is a directory: ${file.relativePath}`);
      }

      if (exists && !force) {
        continue;
      }

      if (hasSymlinkInPath(trellisDir, absolutePath)) {
        throw createHttpError(400, `Refusing to write because path includes a symlink: ${file.relativePath}`);
      }
    }

    const writtenFiles: string[] = [];
    const skippedFiles: string[] = [];

    for (const file of files) {
      const absolutePath = path.resolve(projectDir, file.relativePath);
      const exists = fs.existsSync(absolutePath);
      const existingStat = exists ? safeStat(absolutePath) : null;

      if (exists && !force) {
        skippedFiles.push(file.relativePath.replace(/\\/g, '/'));
        continue;
      }

      if (existingStat && existingStat.isDirectory()) {
        throw createHttpError(400, `Refusing to write because path is a directory: ${file.relativePath}`);
      }

      if (hasSymlinkInPath(trellisDir, absolutePath)) {
        throw createHttpError(400, `Refusing to write because path includes a symlink: ${file.relativePath}`);
      }

      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, file.content, 'utf8');
      writtenFiles.push(file.relativePath.replace(/\\/g, '/'));
    }

    return {
      ok: true,
      applied: true,
      projectDir,
      trellisDir,
      taskName,
      writtenFiles,
      skippedFiles,
    };
  }

  function handleTrellisWrite(body: any = {}) {
    const context = getInvocation(body.invocationId, body.callbackToken);
    const includeContent = body.includeContent === true;
    const confirm = body.confirm === true;
    const force = body.force === true;

    const filesPayload = Array.isArray(body.files) ? body.files : null;
    const files = filesPayload
      ? filesPayload
      : [
          {
            relativePath: body.relativePath || body.path,
            content: body.content,
          },
        ];

    const normalizedFiles: any[] = [];
    const rejectedPaths: string[] = [];

    for (const file of Array.isArray(files) ? files : []) {
      const record = file && typeof file === 'object' ? file : null;
      if (!record) {
        rejectedPaths.push('[invalid file entry]');
        continue;
      }

      const rawPath = record.relativePath ?? record.path ?? '';
      const normalizedPath = normalizeTrellisRelativePath(rawPath);
      if (!normalizedPath) {
        rejectedPaths.push(String(rawPath || '').trim() || '[empty]');
        continue;
      }

      normalizedFiles.push({
        relativePath: normalizedPath,
        content: typeof record.content === 'string' ? record.content : String(record.content ?? ''),
      });
    }

    if (rejectedPaths.length > 0) {
      const examples = rejectedPaths
        .filter(Boolean)
        .slice(0, 6)
        .map((item) => clipText(item, 120));
      const suffix = rejectedPaths.length > examples.length ? ` (+${rejectedPaths.length - examples.length} more)` : '';
      throw createHttpError(
        400,
        `Invalid .trellis paths. Expected a file path under .trellis/**. Rejected: ${examples.join(', ')}${suffix}`
      );
    }

    if (normalizedFiles.length === 0) {
      throw createHttpError(400, 'files must include at least one .trellis-relative path');
    }

    if (normalizedFiles.length > 20) {
      throw createHttpError(400, 'Refusing to write more than 20 files in one request');
    }

    const totalBytes = normalizedFiles.reduce((sum: number, file: any) => sum + Buffer.byteLength(file.content, 'utf8'), 0);
    if (totalBytes > 256 * 1024) {
      throw createHttpError(400, 'Refusing to write more than 256KB of content in one request');
    }

    const projectDirRaw = String(context.projectDir || '').trim();

    if (!projectDirRaw) {
      throw createHttpError(409, 'No active project directory is available for this invocation');
    }

    const projectDir = path.resolve(projectDirRaw);
    const projectStat = safeStat(projectDir);

    if (!projectStat || !projectStat.isDirectory()) {
      throw createHttpError(409, 'Active project directory does not exist or is not a folder');
    }

    const trellisDir = path.join(projectDir, '.trellis');
    const trellisLstat = safeLstat(trellisDir);

    if (trellisLstat && trellisLstat.isSymbolicLink()) {
      throw createHttpError(400, 'Refusing to write .trellis because it is a symlink');
    }

    const operations: any[] = [];

    for (const file of normalizedFiles) {
      const absolutePath = path.resolve(projectDir, file.relativePath);
      const withinTrellis = isPathWithinDir(trellisDir, absolutePath);

      if (!withinTrellis) {
        throw createHttpError(400, `Refusing to write outside .trellis: ${file.relativePath}`);
      }

      const exists = fs.existsSync(absolutePath);
      const existingStat = exists ? safeStat(absolutePath) : null;

      if (existingStat && existingStat.isDirectory()) {
        throw createHttpError(400, `Refusing to write because path is a directory: ${file.relativePath}`);
      }
      const action = exists ? (force ? 'overwrite' : 'skip-existing') : 'create';

      operations.push({
        path: file.relativePath.replace(/\\/g, '/'),
        action,
        bytes: Buffer.byteLength(file.content, 'utf8'),
        ...(includeContent ? { content: file.content } : {}),
      });
    }

    if (!confirm) {
      return {
        ok: true,
        applied: false,
        projectDir,
        trellisDir,
        operations,
        willWriteCount: operations.filter((op) => op.action === 'create' || op.action === 'overwrite').length,
        skippedCount: operations.filter((op) => op.action === 'skip-existing').length,
        confirmRequired: true,
      };
    }

    fs.mkdirSync(trellisDir, { recursive: true });

    if (hasSymlinkInPath(projectDir, trellisDir)) {
      throw createHttpError(400, 'Refusing to write .trellis because it contains a symlink');
    }

    const writtenFiles: string[] = [];
    const skippedFiles: string[] = [];

    for (const file of normalizedFiles) {
      const absolutePath = path.resolve(projectDir, file.relativePath);
      const exists = fs.existsSync(absolutePath);

      if (exists && !force) {
        skippedFiles.push(file.relativePath.replace(/\\/g, '/'));
        continue;
      }

      const existingStat = exists ? safeStat(absolutePath) : null;

      if (existingStat && existingStat.isDirectory()) {
        throw createHttpError(400, `Refusing to write because path is a directory: ${file.relativePath}`);
      }

      if (hasSymlinkInPath(trellisDir, absolutePath)) {
        throw createHttpError(400, `Refusing to write because path includes a symlink: ${file.relativePath}`);
      }

      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, file.content, 'utf8');
      writtenFiles.push(file.relativePath.replace(/\\/g, '/'));
    }

    return {
      ok: true,
      applied: true,
      projectDir,
      trellisDir,
      writtenFiles,
      skippedFiles,
    };
  }

  return {
    createInvocationContext,
    handleListParticipants,
    handlePostMessage,
    handleReadContext,
    handleTrellisInit,
    handleTrellisWrite,
    registerInvocation,
    unregisterInvocation,
  };
}
