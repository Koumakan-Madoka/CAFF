// @ts-check

const messageHistory = window.CaffChat && window.CaffChat.messageHistory;

if (!messageHistory) {
  throw new Error('CaffChat.messageHistory helper is required');
}

const state = {
  runtime: null,
  modelOptions: [],
  skills: [],
  modes: [],
  agents: [],
  conversations: [],
  selectedConversationId: null,
  currentConversation: null,
  messageHistory: messageHistory.createState(),
  selectedAgentId: null,
  sending: false,
  stopRequestConversationIds: new Set(),
  eventSource: null,
  mentionSuggestions: [],
  mentionSelectionIndex: 0,
  activeMentionContext: null,
  messageToolTraceById: new Map(),
  messageToolTraceTimers: new Map(),
  optimisticMessagesByConversation: new Map(),
  digestStatusByConversation: new Map(),
  bindingFeishuChat: false,
  feishuBindingNotice: '',
  feishuBindingNoticeConversationId: null,
  knownFeishuChats: [],
  loadingFeishuChats: false,
  contextInspector: {
    open: false,
    loading: false,
    errorMessage: '',
    conversationId: '',
    messageId: '',
    snapshot: null,
  },
};

const UNDERCOVER_TYPE = 'who_is_undercover';
const WEREWOLF_TYPE = 'werewolf';
const shared = window.CaffShared || {};
const chatModules = window.CaffChat || {};
const fetchJson = shared.fetchJson;
const avatarUtils = shared.avatar || {};
const modelOptionUtils = shared.modelOptions || {};
const copyTextToClipboard = shared.copyTextToClipboard;
const sessionGoalUtils = shared.sessionGoal;
const conversationDigestUtils = shared.conversationDigest;
const summaryMemoryUtils = shared.summaryMemory;

if (!sessionGoalUtils) {
  throw new Error('CaffShared.sessionGoal helper is required');
}

if (!conversationDigestUtils) {
  throw new Error('CaffShared.conversationDigest helper is required');
}

if (!summaryMemoryUtils) {
  throw new Error('CaffShared.summaryMemory helper is required');
}

const dom = {
  runtimePill: /** @type {HTMLSpanElement | null} */ (document.getElementById('runtime-pill')),
  refreshButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('refresh-button')),
  newConversationForm: /** @type {HTMLFormElement | null} */ (document.getElementById('new-conversation-form')),
  newConversationTitle: /** @type {HTMLInputElement | null} */ (document.getElementById('new-conversation-title')),
  newConversationType: /** @type {HTMLSelectElement | null} */ (document.getElementById('new-conversation-type')),
  conversationList: /** @type {HTMLUListElement | null} */ (document.getElementById('conversation-list')),
  conversationTitleDisplay: /** @type {HTMLElement | null} */ (document.getElementById('conversation-title-display')),
  conversationModeBadge: /** @type {HTMLElement | null} */ (document.getElementById('conversation-mode-badge')),
  conversationMeta: /** @type {HTMLElement | null} */ (document.getElementById('conversation-meta')),
  skillDraftToggleButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('skill-draft-toggle-button')),
  conversationDigestToggleButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('conversation-digest-toggle-button')),
  summaryMemoryToggleButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('summary-memory-toggle-button')),
  sessionGoalToggleButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('session-goal-toggle-button')),
  sessionGoalEdgeButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('session-goal-edge-button')),
  deleteConversationButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('delete-conversation-button')),
  sessionGoalDrawer: /** @type {HTMLElement | null} */ (document.getElementById('session-goal-drawer')),
  sessionGoalCloseButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('session-goal-close-button')),
  sessionGoalDrawerStatus: /** @type {HTMLElement | null} */ (document.getElementById('session-goal-drawer-status')),
  sessionGoalDetails: /** @type {HTMLElement | null} */ (document.getElementById('session-goal-details')),
  sessionGoalProgressCard: /** @type {HTMLElement | null} */ (document.getElementById('session-goal-progress-card')),
  sessionGoalProgressSummary: /** @type {HTMLElement | null} */ (document.getElementById('session-goal-progress-summary')),
  sessionGoalProgressFill: /** @type {HTMLElement | null} */ (document.getElementById('session-goal-progress-fill')),
  sessionGoalChecklistPreview: /** @type {HTMLElement | null} */ (document.getElementById('session-goal-checklist-preview')),
  sessionGoalProposalCard: /** @type {HTMLElement | null} */ (document.getElementById('session-goal-proposal-card')),
  sessionGoalProposalStatus: /** @type {HTMLElement | null} */ (document.getElementById('session-goal-proposal-status')),
  sessionGoalProposalDetails: /** @type {HTMLElement | null} */ (document.getElementById('session-goal-proposal-details')),
  sessionGoalAcceptProposalButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('session-goal-accept-proposal-button')),
  sessionGoalDismissProposalButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('session-goal-dismiss-proposal-button')),
  sessionGoalForm: /** @type {HTMLFormElement | null} */ (document.getElementById('session-goal-form')),
  sessionGoalObjective: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('session-goal-objective')),
  sessionGoalChecklist: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('session-goal-checklist')),
  sessionGoalChecklistPresetButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('session-goal-checklist-preset-button')),
  sessionGoalSaveButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('session-goal-save-button')),
  sessionGoalPauseButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('session-goal-pause-button')),
  sessionGoalResumeButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('session-goal-resume-button')),
  sessionGoalCompleteButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('session-goal-complete-button')),
  sessionGoalClearButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('session-goal-clear-button')),
  conversationDigestDrawer: /** @type {HTMLElement | null} */ (document.getElementById('conversation-digest-drawer')),
  conversationDigestCloseButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('conversation-digest-close-button')),
  conversationDigestStatus: /** @type {HTMLElement | null} */ (document.getElementById('conversation-digest-status')),
  conversationDigestCreateButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('conversation-digest-create-button')),
  conversationDigestCompactButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('conversation-digest-compact-button')),
  conversationDigestList: /** @type {HTMLElement | null} */ (document.getElementById('conversation-digest-list')),
  skillDraftDrawer: /** @type {HTMLElement | null} */ (document.getElementById('skill-draft-drawer')),
  skillDraftCloseButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('skill-draft-close-button')),
  skillDraftStatus: /** @type {HTMLElement | null} */ (document.getElementById('skill-draft-status')),
  skillDraftList: /** @type {HTMLElement | null} */ (document.getElementById('skill-draft-list')),
  summaryMemoryDrawer: /** @type {HTMLElement | null} */ (document.getElementById('summary-memory-drawer')),
  summaryMemoryCloseButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('summary-memory-close-button')),
  summaryMemoryStatus: /** @type {HTMLElement | null} */ (document.getElementById('summary-memory-status')),
  summaryMemoryForm: /** @type {HTMLFormElement | null} */ (document.getElementById('summary-memory-form')),
  summaryMemoryQuery: /** @type {HTMLInputElement | null} */ (document.getElementById('summary-memory-query')),
  summaryMemoryTask: /** @type {HTMLInputElement | null} */ (document.getElementById('summary-memory-task')),
  summaryMemoryConversationTitle: /** @type {HTMLInputElement | null} */ (document.getElementById('summary-memory-conversation-title')),
  summaryMemoryUpdatedAfter: /** @type {HTMLInputElement | null} */ (document.getElementById('summary-memory-updated-after')),
  summaryMemoryUpdatedBefore: /** @type {HTMLInputElement | null} */ (document.getElementById('summary-memory-updated-before')),
  summaryMemoryKind: /** @type {HTMLSelectElement | null} */ (document.getElementById('summary-memory-kind')),
  summaryMemoryCurrentTask: /** @type {HTMLInputElement | null} */ (document.getElementById('summary-memory-current-task')),
  summaryMemoryIncludeCurrent: /** @type {HTMLInputElement | null} */ (document.getElementById('summary-memory-include-current')),
  summaryMemorySearchButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('summary-memory-search-button')),
  summaryMemoryRecentButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('summary-memory-recent-button')),
  summaryMemoryBackfillButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('summary-memory-backfill-button')),
  summaryMemoryResults: /** @type {HTMLElement | null} */ (document.getElementById('summary-memory-results')),
  agentContextDrawer: /** @type {HTMLElement | null} */ (document.getElementById('agent-context-drawer')),
  agentContextCloseButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('agent-context-close-button')),
  agentContextStatus: /** @type {HTMLElement | null} */ (document.getElementById('agent-context-status')),
  agentContextSummary: /** @type {HTMLElement | null} */ (document.getElementById('agent-context-summary')),
  agentContextExportButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('agent-context-export-button')),
  agentContextSectionList: /** @type {HTMLElement | null} */ (document.getElementById('agent-context-section-list')),
  participantList: /** @type {HTMLDivElement | null} */ (document.getElementById('participant-list')),
  skillDraftAlert: /** @type {HTMLElement | null} */ (document.getElementById('skill-draft-alert')),
  skillDraftAlertText: /** @type {HTMLElement | null} */ (document.getElementById('skill-draft-alert-text')),
  skillDraftAlertButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('skill-draft-alert-button')),
  messageList: /** @type {HTMLDivElement | null} */ (document.getElementById('message-list')),
  messageTimeline: /** @type {HTMLDivElement | null} */ (document.getElementById('message-timeline')),
  messageHistoryControl: /** @type {HTMLDivElement | null} */ (document.getElementById('message-history-control')),
  messageHistoryButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('message-history-button')),
  messageHistoryStatus: /** @type {HTMLElement | null} */ (document.getElementById('message-history-status')),
  composerForm: /** @type {HTMLFormElement | null} */ (document.getElementById('composer-form')),
  composerInput: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('composer-input')),
  composerMentionMenu: /** @type {HTMLDivElement | null} */ (document.getElementById('composer-mention-menu')),
  composerStatus: /** @type {HTMLElement | null} */ (document.getElementById('composer-status')),
  stopButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('stop-button')),
  sendButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('send-button')),
  conversationSettingsForm: /** @type {HTMLFormElement | null} */ (document.getElementById('conversation-settings-form')),
  conversationTitleInput: /** @type {HTMLInputElement | null} */ (document.getElementById('conversation-title-input')),
  conversationAgentOptions: /** @type {HTMLElement | null} */ (document.getElementById('conversation-agent-options')),
  saveConversationButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('save-conversation-button')),
  bulkSkillSelect: /** @type {HTMLSelectElement | null} */ (document.getElementById('bulk-skill-select')),
  applyBulkSkillButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('apply-bulk-skill-button')),
  clearBulkSkillButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('clear-bulk-skill-button')),
  feishuChatSelect: /** @type {HTMLSelectElement | null} */ (document.getElementById('feishu-chat-select')),
  feishuChatIdInput: /** @type {HTMLInputElement | null} */ (document.getElementById('feishu-chat-id-input')),
  bindFeishuChatButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('bind-feishu-chat-button')),
  feishuBindingStatus: /** @type {HTMLElement | null} */ (document.getElementById('feishu-binding-status')),
  undercoverGameCard: /** @type {HTMLElement | null} */ (document.getElementById('undercover-game-card')),
  undercoverGameStatus: /** @type {HTMLElement | null} */ (document.getElementById('undercover-game-status')),
  undercoverLastResult: /** @type {HTMLElement | null} */ (document.getElementById('undercover-last-result')),
  undercoverPlayerStatus: /** @type {HTMLElement | null} */ (document.getElementById('undercover-player-status')),
  undercoverSetupForm: /** @type {HTMLFormElement | null} */ (document.getElementById('undercover-setup-form')),
  undercoverCivilianWord: /** @type {HTMLInputElement | null} */ (document.getElementById('undercover-civilian-word')),
  undercoverUndercoverWord: /** @type {HTMLInputElement | null} */ (document.getElementById('undercover-undercover-word')),
  undercoverUndercoverCount: /** @type {HTMLInputElement | null} */ (document.getElementById('undercover-undercover-count')),
  undercoverBlankCount: /** @type {HTMLInputElement | null} */ (document.getElementById('undercover-blank-count')),
  undercoverBlankWord: /** @type {HTMLInputElement | null} */ (document.getElementById('undercover-blank-word')),
  undercoverStartButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('undercover-start-button')),
  undercoverResetButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('undercover-reset-button')),
  undercoverClueButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('undercover-clue-button')),
  undercoverVoteButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('undercover-vote-button')),
  undercoverRevealButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('undercover-reveal-button')),
  werewolfGameCard: /** @type {HTMLElement | null} */ (document.getElementById('werewolf-game-card')),
  werewolfGameStatus: /** @type {HTMLElement | null} */ (document.getElementById('werewolf-game-status')),
  werewolfLastResult: /** @type {HTMLElement | null} */ (document.getElementById('werewolf-last-result')),
  werewolfPlayerStatus: /** @type {HTMLElement | null} */ (document.getElementById('werewolf-player-status')),
  werewolfSetupForm: /** @type {HTMLFormElement | null} */ (document.getElementById('werewolf-setup-form')),
  werewolfCount: /** @type {HTMLInputElement | null} */ (document.getElementById('werewolf-count')),
  werewolfSeerCount: /** @type {HTMLInputElement | null} */ (document.getElementById('werewolf-seer-count')),
  werewolfWitchCount: /** @type {HTMLInputElement | null} */ (document.getElementById('werewolf-witch-count')),
  werewolfStartButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('werewolf-start-button')),
  werewolfResetButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('werewolf-reset-button')),
  newAgentButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('new-agent-button')),
  agentList: /** @type {HTMLElement | null} */ (document.getElementById('agent-list')),
  agentForm: /** @type {HTMLFormElement | null} */ (document.getElementById('agent-form')),
  agentId: /** @type {HTMLInputElement | null} */ (document.getElementById('agent-id')),
  agentName: /** @type {HTMLInputElement | null} */ (document.getElementById('agent-name')),
  agentDescription: /** @type {HTMLInputElement | HTMLTextAreaElement | null} */ (document.getElementById('agent-description')),
  agentAvatarPreview: /** @type {HTMLElement | null} */ (document.getElementById('agent-avatar-preview')),
  agentAvatarFile: /** @type {HTMLInputElement | null} */ (document.getElementById('agent-avatar-file')),
  agentAvatarData: /** @type {HTMLInputElement | null} */ (document.getElementById('agent-avatar-data')),
  agentPersonaPrompt: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('agent-persona-prompt')),
  agentProvider: /** @type {HTMLInputElement | null} */ (document.getElementById('agent-provider')),
  agentModel: /** @type {HTMLInputElement | null} */ (document.getElementById('agent-model')),
  agentThinking: /** @type {HTMLInputElement | null} */ (document.getElementById('agent-thinking')),
  agentAccentColor: /** @type {HTMLInputElement | null} */ (document.getElementById('agent-accent-color')),
  clearAgentAvatarButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('clear-agent-avatar-button')),
  deleteAgentButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('delete-agent-button')),
  toast: /** @type {HTMLElement | null} */ (document.getElementById('toast')),
};

const toast = typeof shared.createToastController === 'function' ? shared.createToastController(dom.toast) : { show() {} };

function setComposerValue(value) {
  if (!window.caffShell || typeof window.caffShell.setComposerValue !== 'function') {
    throw new Error('caffShell.setComposerValue helper is required');
  }
  window.caffShell.setComposerValue(value);
}

let pendingConversationRefreshId = null;
let pendingConversationRefreshTimer = null;
let conversationPaneRenderPending = false;
let liveDraftFinalizingTimer = null;
const LIVE_DRAFT_IDLE_MS = 1600;
const MAX_WARM_TOOL_TRACE_MESSAGES = 6;

function applyConversationResponse(result) {
  if (!result) {
    return;
  }

  if (Array.isArray(result.conversations)) {
    state.conversations = result.conversations;
  }

  if (result.conversation) {
    const incomingConversation = result.conversation;
    const currentConversation = state.currentConversation;

    if (currentConversation && currentConversation.id === incomingConversation.id) {
      const projection = { ...incomingConversation };
      delete projection.messages;
      state.currentConversation = {
        ...currentConversation,
        ...projection,
        messages: currentConversation.messages,
      };
    } else {
      messageHistory.reset(state.messageHistory, incomingConversation.id);
      const initialMessages = messageHistory.applyInitialPage(state.messageHistory, {
        items: Array.isArray(incomingConversation.messages) ? incomingConversation.messages.slice(-50) : [],
        nextCursor: null,
        hasMore: false,
      });
      state.currentConversation = {
        ...incomingConversation,
        messages: initialMessages,
      };
    }

    state.selectedConversationId = incomingConversation.id;
  }
}

function digestToDisplayFromResult(result, command) {
  if (!result || result.deleted || !command || command.action === 'clear' || command.action === 'delete' || command.action === 'extract-skill') {
    return null;
  }

  if (command.action === 'compact') {
    return result.compacted ? result.rollup || null : null;
  }

  if (result.compacted && result.rollup) {
    return result.rollup;
  }

  return result.digest || result.rollup || null;
}

function focusDigestResult(result, command) {
  const digest = digestToDisplayFromResult(result, command);

  if (!digest || !digest.id || typeof conversationDigestPanelController.openDigest !== 'function') {
    return;
  }

  conversationDigestPanelController.openDigest(digest.id);
}

async function submitDigestCommand(conversationId, command) {
  if (!command || command.action === 'get') {
    showToast(conversationDigestUtils.formatDigestStatus(state.currentConversation));
    renderConversationPane();
    return null;
  }

  const result = await fetchJson(`/api/conversations/${encodeURIComponent(conversationId)}/digest`, {
    method: 'POST',
    body: command,
  });

  applyConversationResponse(result);
  if (result.summary) {
    mergeConversationSummary(result.summary);
  }

  renderAll();
  focusDigestResult(result, command);
  if (command.action === 'extract-skill' && result.draft && result.draft.skill) {
    showToast(`已生成 Skill 草稿：${result.draft.skill.name}`);
  } else if (result.deleted) {
    showToast('会话摘要已删除');
  } else if (result.compacted) {
    showToast(`会话摘要已压缩 · ${conversationDigestUtils.formatDigestStatus(result.conversation)}`);
  } else if (command.action === 'compact') {
    showToast(`没有可压缩的摘要 · ${conversationDigestUtils.formatDigestStatus(result.conversation)}`);
  } else {
    showToast(conversationDigestUtils.formatDigestStatus(result.conversation));
  }
  return result;
}

async function submitSkillDraftCommand(conversationId, draftId, action, body = {}) {
  const normalizedAction = String(action || '').trim();
  const result = await fetchJson(
    `/api/conversations/${encodeURIComponent(conversationId)}/skill-drafts/${encodeURIComponent(draftId)}/${encodeURIComponent(normalizedAction)}`,
    {
      method: 'POST',
      body,
    }
  );

  applyConversationResponse(result);
  if (result.summary) {
    mergeConversationSummary(result.summary);
  }

  renderAll();
  if (normalizedAction === 'confirm' && result.skill) {
    showToast(`Skill 已保存：${result.skill.id}`);
  } else if (normalizedAction === 'reject') {
    showToast('Skill 草稿已移除');
  } else {
    showToast('Skill 草稿已更新');
  }
  return result;
}

async function searchSummaryMemory(options = {}) {
  const body = {
    query: options.query,
    limit: options.limit,
  };

  if (options.latest) {
    body.latest = true;
  }

  if (options.useCurrentTask) {
    body.useCurrentTask = true;
  } else if (options.taskName) {
    body.taskName = options.taskName;
  }

  if (options.sourceKind) {
    body.sourceKind = options.sourceKind;
  }

  if (options.conversationTitle) {
    body.conversationTitle = options.conversationTitle;
  }

  if (options.updatedAfter) {
    body.updatedAfter = options.updatedAfter;
  }

  if (options.updatedBefore) {
    body.updatedBefore = options.updatedBefore;
  }

  if (!options.includeCurrentConversation && state.currentConversation) {
    body.excludeConversationId = state.currentConversation.id;
  }

  return fetchJson('/api/memory/search', {
    method: 'POST',
    body,
  });
}

async function getSummaryMemoryHealth(options = {}) {
  const params = new URLSearchParams();

  if (options.conversationId) {
    params.set('conversationId', options.conversationId);
  }

  const query = params.toString();
  return fetchJson(`/api/memory/health${query ? `?${query}` : ''}`);
}

async function backfillSummaryMemory(options = {}) {
  const body = {};

  if (options.conversationId) {
    body.conversationId = options.conversationId;
  }

  if (options.taskName) {
    body.taskName = options.taskName;
  }

  return fetchJson('/api/memory/backfill', {
    method: 'POST',
    body,
  });
}

async function submitSummaryMemoryCommand(command) {
  if (!summaryMemoryPanelController || typeof summaryMemoryPanelController.openWithQuery !== 'function') {
    showToast('长期经验面板不可用');
    return null;
  }

  const query = String(command && command.query || '').trim();
  await summaryMemoryPanelController.openWithQuery(query, { latest: !query });
  showToast(query ? `已搜索长期经验：${query}` : '已打开最新长期经验');
  return { action: query ? 'search' : 'latest', query };
}

async function submitGoalCommand(conversationId, command) {
  if (!command || command.action === 'get') {
    showToast(sessionGoalUtils.formatConversationStatus(state.currentConversation));
    renderConversationPane();
    return null;
  }

  const result = await fetchJson(`/api/conversations/${encodeURIComponent(conversationId)}/goal`, {
    method: 'POST',
    body: command,
  });

  applyConversationResponse(result);
  if (result.summary) {
    mergeConversationSummary(result.summary);
  }

  renderAll();
  const statusText = sessionGoalUtils.formatConversationStatus(result.conversation);
  const continuationText = result.autoContinuation && result.autoContinuation.scheduled ? ' · 已启动自动续跑' : '';
  showToast(`${statusText}${continuationText}`);
  return result;
}

async function triggerUndercoverAction(action, body = {}) {
  if (!state.currentConversation) {
    return null;
  }

  const result = await fetchJson(`/api/conversations/${state.currentConversation.id}/undercover/${action}`, {
    method: 'POST',
    body,
  });
  applyConversationResponse(result);
  renderAll();
  await refreshConversationFromEvent(state.currentConversation.id);
  scrollMessageListToBottom();
  return result;
}

async function triggerWerewolfAction(action, body = {}) {
  if (!state.currentConversation) {
    return null;
  }

  const result = await fetchJson(`/api/conversations/${state.currentConversation.id}/werewolf/${action}`, {
    method: 'POST',
    body,
  });
  applyConversationResponse(result);
  renderAll();
  await refreshConversationFromEvent(state.currentConversation.id);
  scrollMessageListToBottom();
  return result;
}

function formatDateTime(value) {
  if (!value) {
    return '';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function conversationById(conversationId) {
  return state.conversations.find((item) => item.id === conversationId) || null;
}

function agentById(agentId) {
  return state.agents.find((item) => item.id === agentId) || null;
}

function normalizedSkillIds(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function isUndercoverConversation(conversation) {
  return Boolean(conversation && conversation.type === UNDERCOVER_TYPE);
}

function isWerewolfConversation(conversation) {
  return Boolean(conversation && conversation.type === WEREWOLF_TYPE);
}

function undercoverGameState(conversation) {
  const metadata = conversation && conversation.metadata && typeof conversation.metadata === 'object' ? conversation.metadata : null;
  return metadata && metadata.undercoverGame && typeof metadata.undercoverGame === 'object' ? metadata.undercoverGame : null;
}

function werewolfGameState(conversation) {
  const metadata = conversation && conversation.metadata && typeof conversation.metadata === 'object' ? conversation.metadata : null;
  return metadata && metadata.werewolfGame && typeof metadata.werewolfGame === 'object' ? metadata.werewolfGame : null;
}

function canChatInUndercoverConversation(conversation) {
  if (!isUndercoverConversation(conversation)) {
    return true;
  }

  const game = undercoverGameState(conversation);

  if (!game) {
    return false;
  }

  return game.phase === 'finished' || game.status === 'completed' || game.status === 'revealed';
}

function canChatInWerewolfConversation(conversation) {
  if (!isWerewolfConversation(conversation)) {
    return true;
  }

  const game = werewolfGameState(conversation);

  if (!game) {
    return false;
  }

  return game.phase === 'finished' || game.status === 'completed' || game.status === 'revealed';
}

function parseGoalCommand(content) {
  const text = String(content || '').trim();

  if (text !== '/goal' && !text.startsWith('/goal ')) {
    return null;
  }

  const rest = text.slice('/goal'.length).trim();

  if (!rest) {
    return { action: 'get' };
  }

  const normalized = rest.toLowerCase();
  if (['pause', 'resume', 'complete', 'clear'].includes(normalized)) {
    return { action: normalized };
  }

  if (['accept', 'accept-proposal', 'accept_proposal'].includes(normalized)) {
    return { action: 'accept-proposal' };
  }

  if (['dismiss', 'dismiss-proposal', 'dismiss_proposal'].includes(normalized)) {
    return { action: 'dismiss-proposal' };
  }

  return {
    action: 'set',
    objective: rest,
  };
}

function parseDigestCommand(content) {
  const text = String(content || '').trim();

  if (text !== '/digest' && !text.startsWith('/digest ')) {
    return null;
  }

  const rest = text.slice('/digest'.length).trim();

  if (!rest) {
    return { action: 'create' };
  }

  const normalized = rest.toLowerCase();
  if (normalized === 'status' || normalized === 'list' || normalized === 'get') {
    return { action: 'get' };
  }

  if (normalized === 'clear') {
    return { action: 'clear' };
  }

  if (normalized === 'model' || normalized === 'llm' || normalized === 'ai') {
    return { action: 'create', summaryMode: 'model' };
  }

  if (normalized === 'extractive' || normalized === 'rules' || normalized === 'rule') {
    return { action: 'create', summaryMode: 'extractive' };
  }

  const compactMatch = normalized.match(/^(compact|rollup|compress)(?:\s+(model|llm|ai|extractive|rules|rule))?$/u);
  if (compactMatch) {
    const mode = compactMatch[2] || '';
    return {
      action: 'compact',
      ...(mode ? { summaryMode: mode === 'extractive' || mode === 'rules' || mode === 'rule' ? 'extractive' : 'model' } : {}),
    };
  }

  return {
    action: 'create',
    summary: rest,
  };
}

function parseSummaryMemoryCommand(content) {
  const text = String(content || '').trim();
  const isMemoryCommand = text === '/memory' || text.startsWith('/memory ');
  const isShortMemoryCommand = text === '/mem' || text.startsWith('/mem ');

  if (!isMemoryCommand && !isShortMemoryCommand) {
    return null;
  }

  const prefix = isMemoryCommand ? '/memory' : '/mem';
  const query = text.slice(prefix.length).trim();
  return {
    action: query ? 'search' : 'open',
    query,
  };
}

function undercoverPlayerEntries(conversation) {
  const game = undercoverGameState(conversation);
  return Array.isArray(game && game.players) ? game.players : [];
}

function undercoverPlayerLabel(player) {
  if (!player) {
    return '';
  }

  return player.isAlive ? '存活' : `出局${player.eliminatedRound ? ` · 第 ${player.eliminatedRound} 轮` : ''}`;
}

function werewolfPlayerEntries(conversation) {
  const game = werewolfGameState(conversation);
  return Array.isArray(game && game.players) ? game.players : [];
}

function werewolfPlayerLabel(player) {
  if (!player) {
    return '';
  }

  if (player.isAlive) {
    return '存活';
  }

  const phaseLabel = player.eliminatedPhase === 'night' ? '夜晚' : player.eliminatedPhase === 'vote' ? '投票' : '';
  const roundLabel = player.eliminatedRound ? `第 ${player.eliminatedRound} 轮` : '';
  const tags = [phaseLabel, roundLabel].filter(Boolean).join(' · ');

  return tags ? `出局 · ${tags}` : '出局';
}

function conversationTypeLabel(conversation) {
  if (!conversation || !conversation.type) {
    return '普通对话';
  }

  const mode = state.modes.find((m) => m.id === conversation.type);
  return mode ? mode.name : '普通对话';
}

function modelOptionKey(provider, model) {
  return modelOptionUtils.modelOptionKey(provider, model);
}

function findModelOption(provider, model) {
  const key = modelOptionKey(provider, model);
  return state.modelOptions.find((option) => option.key === key) || null;
}

function buildModelOptionLabel(option) {
  return modelOptionUtils.buildModelOptionLabel(option);
}

function fillModelSelect(select, currentProvider = '', currentModel = '') {
  modelOptionUtils.fillModelSelect(select, state.modelOptions, currentProvider, currentModel);
}

function selectedModelOption(select) {
  return modelOptionUtils.selectedModelOption(select, state.modelOptions);
}

function syncProviderFromModelSelect(select, providerInput) {
  modelOptionUtils.syncProviderFromModelSelect(select, providerInput, state.modelOptions);
}

function buildAgentAvatarElement(agent, className = '') {
  return avatarUtils.buildAgentAvatarElement(agent, className);
}

function renderAvatarPreview(container, dataUrl, name, accentColor = '#3d405b') {
  avatarUtils.renderAvatarPreview(container, dataUrl, name, accentColor);
}

function readAvatarFileAsDataUrl(file) {
  return avatarUtils.readAvatarFileAsDataUrl(file);
}

const noopRenderer = {
  bindEvents(..._args) {},
  async openWithQuery(..._args) {},
  render(..._args) {},
};

const noopMentionMenuController = {
  appendHighlightedMessageBody(container, text, _agents) {
    container.textContent = String(text || '');
  },
  bindEvents() {},
  closeMenu() {},
  syncMenu() {},
};

const noopConversationSettingsController = {
  bindEvents() {},
  closeAllProfileMenus() {},
  render() {},
  selectedModelProfileName(_agent) {
    return '默认配置';
  },
  selectedParticipants() {
    return [];
  },
  setProfileSelectorDisabled(..._args) {},
  setProfileSelectorValue(..._args) {},
  toggleProfileSelector(..._args) {},
};

let mentionMenuController = noopMentionMenuController;
let conversationListRenderer = noopRenderer;
let participantPaneRenderer = noopRenderer;
let messageTimelineRenderer = noopRenderer;
let conversationSettingsController = noopConversationSettingsController;
let undercoverPanelRenderer = noopRenderer;
let werewolfPanelRenderer = noopRenderer;
let sessionGoalPanelController = noopRenderer;
let conversationDigestPanelController = noopRenderer;
let summaryMemoryPanelController = noopRenderer;
let conversationPaneRenderer = noopRenderer;

function setupChatModules() {
  mentionMenuController =
    typeof chatModules.createMentionMenuController === 'function'
      ? chatModules.createMentionMenuController({ state, dom })
      : noopMentionMenuController;

  conversationSettingsController =
    typeof chatModules.createConversationSettingsController === 'function'
      ? chatModules.createConversationSettingsController({
          state,
          dom,
          helpers: {
            buildAgentAvatarElement,
            formatDateTime,
            isConversationBusy,
            normalizedSkillIds,
          },
          showToast,
        })
      : noopConversationSettingsController;

  conversationListRenderer =
    typeof chatModules.createConversationListRenderer === 'function'
      ? chatModules.createConversationListRenderer({
          state,
          dom,
          helpers: {
            conversationPreviewText,
            conversationTypeLabel,
            formatDateTime,
            isConversationBusy,
            isUndercoverConversation,
            isWerewolfConversation,
          },
        })
      : noopRenderer;

  participantPaneRenderer =
    typeof chatModules.createParticipantPaneRenderer === 'function'
      ? chatModules.createParticipantPaneRenderer({
          dom,
          helpers: {
            buildAgentAvatarElement,
            normalizedSkillIds,
            selectedModelProfileName,
          },
        })
      : noopRenderer;

  messageTimelineRenderer =
    typeof chatModules.createMessageTimelineRenderer === 'function'
      ? chatModules.createMessageTimelineRenderer({
          dom,
          helpers: {
            agentById,
            buildAgentAvatarElement,
            canInspectToolTrace,
            displayedMessageBody,
            digestStatusForConversation,
            formatDateTime,
            isPrivateTimelineMessage,
            liveStageForMessage,
            liveStageLabel,
            messageSessionInfo,
            privateRecipientNames,
            renderMessageBody,
            timelineMessagesForConversation,
            toolTraceSignatureForMessage,
            toolTraceStateForMessage,
          },
          showToast,
        })
      : noopRenderer;

  undercoverPanelRenderer =
    typeof chatModules.createUndercoverPanelRenderer === 'function'
      ? chatModules.createUndercoverPanelRenderer({
          state,
          dom,
          helpers: {
            activeTurnForConversation,
            isUndercoverConversation,
            undercoverGameState,
            undercoverPlayerEntries,
            undercoverPlayerLabel,
          },
        })
      : noopRenderer;

  werewolfPanelRenderer =
    typeof chatModules.createWerewolfPanelRenderer === 'function'
      ? chatModules.createWerewolfPanelRenderer({
          state,
          dom,
          helpers: {
            activeTurnForConversation,
            isWerewolfConversation,
            werewolfGameState,
            werewolfPlayerEntries,
            werewolfPlayerLabel,
          },
        })
      : noopRenderer;

  sessionGoalPanelController =
    typeof chatModules.createSessionGoalPanelController === 'function'
      ? chatModules.createSessionGoalPanelController({
          state,
          dom,
          helpers: {
            formatDateTime,
            submitGoalCommand,
          },
          showToast,
        })
      : noopRenderer;

  conversationDigestPanelController =
    typeof chatModules.createConversationDigestPanelController === 'function'
      ? chatModules.createConversationDigestPanelController({
          state,
          dom,
          helpers: {
            formatDateTime,
            submitDigestCommand,
            submitSkillDraftCommand,
          },
          showToast,
        })
      : noopRenderer;

  summaryMemoryPanelController =
    typeof chatModules.createSummaryMemoryPanelController === 'function'
      ? chatModules.createSummaryMemoryPanelController({
          state,
          dom,
          helpers: {
            backfillSummaryMemory,
            formatDateTime,
            getSummaryMemoryHealth,
            loadConversation,
            searchSummaryMemory,
          },
          showToast,
        })
      : noopRenderer;

  conversationPaneRenderer =
    typeof chatModules.createConversationPaneRenderer === 'function'
      ? chatModules.createConversationPaneRenderer({
          state,
          dom,
          helpers: {
            activeTurnForConversation,
            activeAgentSlotsForConversation,
            agentById,
            canChatInUndercoverConversation,
            canChatInWerewolfConversation,
            clearLiveDraftFinalizingTimer,
            closeMentionMenu,
            conversationTypeLabel,
            isConversationBusy,
            digestStatusForConversation,
            isUndercoverConversation,
            isWerewolfConversation,
            liveDraftIdleMs: LIVE_DRAFT_IDLE_MS,
            liveStageLabel,
            queueFailureForConversation,
            renderMessages,
            queuedAgentSlotMessageCountForConversation,
            queuedUserMessageCountForConversation,
            renderParticipantList,
            renderUndercoverGameCard,
            renderWerewolfGameCard,
            scheduleConversationPaneRender,
            timelineMessagesForConversation,
            undercoverGameState,
            werewolfGameState,
          },
        })
      : noopRenderer;
}

function selectedModelProfileName(agent) {
  return conversationSettingsController.selectedModelProfileName(agent);
}

function closeMentionMenu() {
  mentionMenuController.closeMenu();
}

function appendHighlightedMessageBody(container, text, agents) {
  mentionMenuController.appendHighlightedMessageBody(container, text, agents);
}

function renderMessageBody(container, text, agents) {
  if (!container) {
    return;
  }

  container.textContent = '';
  container.classList.remove('plain-text');

  const markdown = shared.safeMarkdown;
  const source = normalizeEscapedMessageText(text);

  if (markdown && typeof markdown.render === 'function') {
    try {
      markdown.render(container, source, {
        appendText(target, value) {
          appendHighlightedMessageBody(target, value, agents);
        },
      });
      return;
    } catch {}
  }

  container.classList.add('plain-text');
  appendHighlightedMessageBody(container, source, agents);
}

function canInspectToolTrace(message) {
  return Boolean(message && message.role === 'assistant');
}

function toolTraceStateForMessage(messageId) {
  return messageId ? state.messageToolTraceById.get(messageId) || null : null;
}

function getMessageToolTraceState(messageId) {
  const normalizedMessageId = String(messageId || '').trim();

  if (!normalizedMessageId) {
    return null;
  }

  const existing = toolTraceStateForMessage(normalizedMessageId);

  if (existing) {
    return existing;
  }

  const created = {
    open: false,
    status: 'idle',
    requestKey: '',
    errorMessage: '',
    data: null,
    promise: null,
    userToggled: false,
  };

  state.messageToolTraceById.set(normalizedMessageId, created);
  return created;
}

function emptyToolTraceSummary() {
  return {
    totalSteps: 0,
    toolExecutionCount: 0,
    sessionToolCount: 0,
    bridgeToolCount: 0,
    failedSteps: 0,
    succeededSteps: 0,
    totalDurationMs: 0,
    retryCount: 0,
    hasRetries: false,
    modelCallCount: 0,
    coldStartModelCallCount: 0,
    postColdModelCallCount: 0,
    providerMissCount: 0,
    status: 'idle',
  };
}

function emptyToolTraceActivity() {
  return {
    status: 'idle',
    hasCurrentTool: false,
    currentToolName: '',
    currentStepId: '',
    currentStepKind: '',
    inferred: false,
    label: '',
  };
}

function emptyToolTraceFailureContext() {
  return {
    hasFailure: false,
    source: '',
    stepId: '',
    toolName: '',
    text: '',
  };
}

function createEmptyToolTraceData(messageId = '') {
  return {
    message: messageId
      ? {
          id: messageId,
          status: '',
          taskId: null,
          runId: null,
          createdAt: '',
        }
      : null,
    task: null,
    session: null,
    modelUsageSummary: null,
    modelUsageCalls: [],
    timelineEvents: [],
    sessionToolCalls: [],
    bridgeToolEvents: [],
    steps: [],
    summary: emptyToolTraceSummary(),
    activity: emptyToolTraceActivity(),
    failureContext: emptyToolTraceFailureContext(),
  };
}

function normalizeToolTraceStepStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();

  if (normalized === 'succeeded' || normalized === 'completed' || normalized === 'ok') {
    return 'succeeded';
  }

  if (normalized === 'failed' || normalized === 'error' || normalized === 'timeout') {
    return 'failed';
  }

  if (normalized === 'running' || normalized === 'queued' || normalized === 'pending') {
    return normalized;
  }

  return normalized || 'observed';
}

function cloneTraceValue(value) {
  if (value == null || typeof value !== 'object') {
    return value;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function currentConversationMessageById(messageId) {
  if (!messageId || !state.currentConversation || !Array.isArray(state.currentConversation.messages)) {
    return null;
  }

  return state.currentConversation.messages.find((item) => item && item.id === messageId) || null;
}

/**
 * @param {any} step
 * @param {string | Record<string, string>} [fallbackStatus='observed']
 */
function resolveFinalizedTraceStatus(step, fallbackStatus = 'observed') {
  if (fallbackStatus && typeof fallbackStatus === 'object') {
    const kind = step && step.kind ? String(step.kind) : '';
    return normalizeToolTraceStepStatus(fallbackStatus[kind] || fallbackStatus.default || 'observed');
  }

  return normalizeToolTraceStepStatus(fallbackStatus || 'observed');
}

function mergeToolTraceStep(existingStep, incomingStep) {
  const nextStep = {
    ...(existingStep && typeof existingStep === 'object' ? existingStep : {}),
    ...(incomingStep && typeof incomingStep === 'object' ? incomingStep : {}),
  };
  const existingStatus = normalizeToolTraceStepStatus(existingStep && existingStep.status ? existingStep.status : '');
  const incomingStatus = normalizeToolTraceStepStatus(incomingStep && incomingStep.status ? incomingStep.status : '');
  const stepKind = String(nextStep && nextStep.kind ? nextStep.kind : '').trim();

  if (stepKind === 'session' && incomingStatus === 'observed' && existingStatus === 'running') {
    nextStep.status = 'running';
  } else {
    nextStep.status = incomingStatus || existingStatus || 'observed';
  }

  return nextStep;
}

function computeTraceModelUsageSummary(trace) {
  const calls = trace && Array.isArray(trace.modelUsageCalls) ? trace.modelUsageCalls.filter(Boolean) : [];
  const primarySummary = trace && trace.modelUsageSummary && typeof trace.modelUsageSummary === 'object'
    ? trace.modelUsageSummary
    : trace && trace.session && trace.session.modelUsageSummary && typeof trace.session.modelUsageSummary === 'object'
      ? trace.session.modelUsageSummary
      : null;
  const summaryFallback = trace && trace.summary && typeof trace.summary === 'object'
    ? trace.summary
    : null;
  const summaryFallbackHasCounts = summaryFallback && (
    Number(summaryFallback.modelCallCount) > 0 ||
    Number(summaryFallback.coldStartModelCallCount) > 0 ||
    Number(summaryFallback.postColdModelCallCount) > 0 ||
    Number(summaryFallback.providerMissCount) > 0
  );
  const explicitSummary = primarySummary || (summaryFallback && (summaryFallbackHasCounts || calls.length === 0) ? summaryFallback : null);

  if (explicitSummary) {
    const modelCallCount = Number(explicitSummary.modelCallCount);
    const coldStartModelCallCount = Number(explicitSummary.coldStartModelCallCount);
    const postColdModelCallCount = Number(explicitSummary.postColdModelCallCount);
    const providerMissCount = Number(explicitSummary.providerMissCount);

    return {
      modelCallCount: Number.isFinite(modelCallCount) ? modelCallCount : 0,
      coldStartModelCallCount: Number.isFinite(coldStartModelCallCount) ? coldStartModelCallCount : 0,
      postColdModelCallCount: Number.isFinite(postColdModelCallCount) ? postColdModelCallCount : 0,
      providerMissCount: Number.isFinite(providerMissCount) ? providerMissCount : 0,
    };
  }

  const coldStartModelCallCount = calls.filter((call) => call.isColdStart || call.coldStart).length;
  const postColdModelCallCount = calls.filter((call) => !(call.isColdStart || call.coldStart)).length;
  const providerMissCount = calls.filter((call) => call.providerMiss).length;

  return {
    modelCallCount: calls.length,
    coldStartModelCallCount,
    postColdModelCallCount,
    providerMissCount,
  };
}

function computeToolTraceSummary(message, task, steps, trace) {
  const normalizedSteps = Array.isArray(steps) ? steps.filter(Boolean) : [];
  const bridgeSteps = normalizedSteps.filter((step) => step && step.kind === 'bridge');
  const sessionSteps = normalizedSteps.filter((step) => step && step.kind === 'session');
  const failedSteps = normalizedSteps.filter((step) => normalizeToolTraceStepStatus(step && step.status) === 'failed');
  const succeededBridgeSteps = bridgeSteps.filter((step) => normalizeToolTraceStepStatus(step && step.status) === 'succeeded');
  const totalDurationMs = bridgeSteps.reduce((sum, step) => {
    const duration = Number(step && step.durationMs);
    return sum + (Number.isFinite(duration) ? duration : 0);
  }, 0);
  const retryFingerprints = new Map();
  let retryCount = 0;

  bridgeSteps.forEach((step) => {
    const fingerprint = JSON.stringify([step && step.toolName ? step.toolName : '', step && step.requestSummary ? step.requestSummary : null]);
    retryFingerprints.set(fingerprint, (retryFingerprints.get(fingerprint) || 0) + 1);
  });

  retryFingerprints.forEach((count) => {
    if (count > 1) {
      retryCount += count - 1;
    }
  });

  const messageStatus = String(message && message.status ? message.status : '').trim().toLowerCase();
  const taskStatus = String(task && task.status ? task.status : '').trim().toLowerCase();
  const hasRunningStep = normalizedSteps.some((step) => {
    const status = normalizeToolTraceStepStatus(step && step.status ? step.status : '');
    return status === 'running' || status === 'queued';
  });
  const running =
    messageStatus === 'queued' ||
    messageStatus === 'streaming' ||
    taskStatus === 'queued' ||
    taskStatus === 'running' ||
    hasRunningStep;
  const failed = failedSteps.length > 0 || messageStatus === 'failed' || taskStatus === 'failed';

  const modelUsageSummary = computeTraceModelUsageSummary(trace);

  return {
    totalSteps: normalizedSteps.length,
    toolExecutionCount: normalizedSteps.length,
    sessionToolCount: sessionSteps.length,
    bridgeToolCount: bridgeSteps.length,
    failedSteps: failedSteps.length,
    succeededSteps: succeededBridgeSteps.length,
    totalDurationMs,
    retryCount,
    hasRetries: retryCount > 0,
    modelCallCount: modelUsageSummary.modelCallCount,
    coldStartModelCallCount: modelUsageSummary.coldStartModelCallCount,
    postColdModelCallCount: modelUsageSummary.postColdModelCallCount,
    providerMissCount: modelUsageSummary.providerMissCount,
    status: failed ? 'failed' : running ? 'running' : normalizedSteps.length > 0 ? 'succeeded' : 'idle',
  };
}

function computeToolTraceActivity(summary, steps) {
  const normalizedSteps = Array.isArray(steps) ? steps.filter(Boolean) : [];
  const summaryStatus = String(summary && summary.status ? summary.status : '').trim().toLowerCase() || 'idle';
  const runningStep =
    normalizedSteps
      .slice()
      .reverse()
      .find((step) => {
        const status = normalizeToolTraceStepStatus(step && step.status ? step.status : '');
        return status === 'running' || status === 'queued';
      }) || null;

  if (runningStep && runningStep.toolName) {
    return {
      status: summaryStatus,
      hasCurrentTool: true,
      currentToolName: String(runningStep.toolName),
      currentStepId: String(runningStep.stepId || ''),
      currentStepKind: String(runningStep.kind || ''),
      inferred: false,
      label: `当前工具：${runningStep.toolName}`,
    };
  }

  if (summaryStatus !== 'running') {
    return emptyToolTraceActivity();
  }

  const lastStep = normalizedSteps.length > 0 ? normalizedSteps[normalizedSteps.length - 1] : null;
  const inferredToolName = String(
    lastStep && (lastStep.bridgeToolHint || lastStep.toolName) ? lastStep.bridgeToolHint || lastStep.toolName : ''
  ).trim();

  if (!lastStep || !inferredToolName || lastStep.kind !== 'session') {
    return {
      ...emptyToolTraceActivity(),
      status: summaryStatus,
    };
  }

  return {
    status: summaryStatus,
    hasCurrentTool: true,
    currentToolName: inferredToolName,
    currentStepId: String(lastStep.stepId || ''),
    currentStepKind: String(lastStep.bridgeToolHint ? 'bridge' : lastStep.kind || 'session'),
    inferred: true,
    label: `当前工具：${inferredToolName}`,
  };
}

function buildFallbackFailureContext(trace, message) {
  const normalizedTrace = trace && typeof trace === 'object' ? trace : createEmptyToolTraceData(message && message.id ? message.id : '');
  const normalizedSteps = Array.isArray(normalizedTrace.steps) ? normalizedTrace.steps.filter(Boolean) : [];
  const failedStep = normalizedSteps.find((step) => normalizeToolTraceStepStatus(step && step.status ? step.status : '') === 'failed') || null;
  const existing = toolTraceFailureContext(normalizedTrace);
  const taskStatus = String(normalizedTrace.task && normalizedTrace.task.status ? normalizedTrace.task.status : '').trim().toLowerCase();
  const messageStatus = String(message && message.status ? message.status : normalizedTrace.message && normalizedTrace.message.status ? normalizedTrace.message.status : '')
    .trim()
    .toLowerCase();

  if (failedStep) {
    const detail = failedStep.errorSummary || failedStep.resultSummary || failedStep.requestSummary || failedStep.partialJson || '';
    return {
      hasFailure: true,
      source: 'step',
      stepId: String(failedStep.stepId || ''),
      toolName: String(failedStep.toolName || ''),
      text: detail ? `${failedStep.toolName || 'tool'} · ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '',
    };
  }

  if (existing && existing.hasFailure) {
    return existing;
  }

  if (taskStatus === 'failed' || messageStatus === 'failed') {
    return {
      hasFailure: true,
      source: taskStatus === 'failed' ? 'task' : 'message',
      stepId: '',
      toolName: '',
      text: '',
    };
  }

  return emptyToolTraceFailureContext();
}

function rebuildMessageToolTraceData(trace, message) {
  const normalizedMessage = message || (trace && trace.message ? trace.message : null);
  const nextTrace = trace && typeof trace === 'object' ? trace : createEmptyToolTraceData(normalizedMessage && normalizedMessage.id ? normalizedMessage.id : '');
  const sourceSteps =
    Array.isArray(nextTrace.steps) && nextTrace.steps.length > 0
      ? nextTrace.steps
      : [].concat(
          Array.isArray(nextTrace.sessionToolCalls) ? nextTrace.sessionToolCalls : [],
          Array.isArray(nextTrace.bridgeToolEvents) ? nextTrace.bridgeToolEvents : []
        );
  const mergedSteps = [];
  const stepIndexById = new Map();

  sourceSteps.forEach((rawStep) => {
    if (!rawStep) {
      return;
    }

    const stepId = String(rawStep.stepId || '').trim() || `tool-step-${mergedSteps.length + 1}`;
    const nextStep = {
      ...rawStep,
      stepId,
      status: normalizeToolTraceStepStatus(rawStep.status),
      kind: rawStep.kind ? String(rawStep.kind) : 'session',
    };
    const existingIndex = stepIndexById.get(stepId);

    if (existingIndex === undefined) {
      stepIndexById.set(stepId, mergedSteps.length);
      mergedSteps.push(nextStep);
      return;
    }

    mergedSteps[existingIndex] = mergeToolTraceStep(mergedSteps[existingIndex], nextStep);
  });

  nextTrace.steps = mergedSteps.map((step, index) => ({
    ...step,
    timelineIndex: index,
  }));
  nextTrace.sessionToolCalls = nextTrace.steps.filter((step) => step && step.kind === 'session');
  nextTrace.bridgeToolEvents = nextTrace.steps.filter((step) => step && step.kind === 'bridge');
  nextTrace.modelUsageCalls = Array.isArray(nextTrace.modelUsageCalls) ? nextTrace.modelUsageCalls.filter(Boolean) : [];
  nextTrace.modelUsageSummary = computeTraceModelUsageSummary(nextTrace);
  nextTrace.summary = computeToolTraceSummary(normalizedMessage, nextTrace.task, nextTrace.steps, nextTrace);
  nextTrace.activity = computeToolTraceActivity(nextTrace.summary, nextTrace.steps);
  nextTrace.failureContext = buildFallbackFailureContext(nextTrace, normalizedMessage);

  if (normalizedMessage || nextTrace.message) {
    nextTrace.message = {
      ...(nextTrace.message && typeof nextTrace.message === 'object' ? nextTrace.message : {}),
      ...(normalizedMessage && typeof normalizedMessage === 'object'
        ? {
            id: normalizedMessage.id || (nextTrace.message && nextTrace.message.id) || '',
            status: normalizedMessage.status || (nextTrace.message && nextTrace.message.status) || '',
            taskId: normalizedMessage.taskId || (nextTrace.message && nextTrace.message.taskId) || null,
            runId: normalizedMessage.runId === undefined ? (nextTrace.message && nextTrace.message.runId) || null : normalizedMessage.runId,
            createdAt: normalizedMessage.createdAt || (nextTrace.message && nextTrace.message.createdAt) || '',
          }
        : {}),
    };
  }

  return nextTrace;
}

function mergeMessageToolTraceData(existingTrace, incomingTrace, message) {
  if (!incomingTrace) {
    return rebuildMessageToolTraceData(existingTrace || createEmptyToolTraceData(message && message.id ? message.id : ''), message);
  }

  if (!existingTrace) {
    return rebuildMessageToolTraceData(cloneTraceValue(incomingTrace), message);
  }

  const nextTrace = {
    ...cloneTraceValue(incomingTrace),
    task: incomingTrace.task || existingTrace.task || null,
    session: incomingTrace.session || existingTrace.session || null,
    message: {
      ...(existingTrace.message && typeof existingTrace.message === 'object' ? existingTrace.message : {}),
      ...(incomingTrace.message && typeof incomingTrace.message === 'object' ? incomingTrace.message : {}),
    },
  };
  const nextSteps = Array.isArray(nextTrace.steps) ? nextTrace.steps.slice() : [];
  const stepIndexById = new Map();

  nextSteps.forEach((step, index) => {
    if (!step || !step.stepId) {
      return;
    }

    stepIndexById.set(String(step.stepId), index);
  });

  const existingSteps = Array.isArray(existingTrace.steps) && existingTrace.steps.length > 0
    ? existingTrace.steps
    : [].concat(
        Array.isArray(existingTrace.sessionToolCalls) ? existingTrace.sessionToolCalls : [],
        Array.isArray(existingTrace.bridgeToolEvents) ? existingTrace.bridgeToolEvents : []
      );

  existingSteps.forEach((step) => {
    if (!step) {
      return;
    }

    const stepId = String(step.stepId || '').trim();

    if (!stepId) {
      nextSteps.push(cloneTraceValue(step));
      return;
    }

    const existingIndex = stepIndexById.get(stepId);

    if (existingIndex === undefined) {
      stepIndexById.set(stepId, nextSteps.length);
      nextSteps.push(cloneTraceValue(step));
      return;
    }

    nextSteps[existingIndex] = mergeToolTraceStep(step, nextSteps[existingIndex]);
  });

  nextTrace.steps = nextSteps;
  return rebuildMessageToolTraceData(nextTrace, message);
}

function mutateMessageToolTrace(messageId, mutator) {
  const traceState = getMessageToolTraceState(messageId);

  if (!traceState) {
    return null;
  }

  const message = currentConversationMessageById(messageId);
  const baseTrace = rebuildMessageToolTraceData(
    traceState.data ? traceState.data : createEmptyToolTraceData(messageId),
    message
  );

  if (typeof mutator === 'function') {
    mutator(baseTrace, message);
  }

  traceState.data = rebuildMessageToolTraceData(baseTrace, message);
  maybeAutoOpenMessageToolTrace(message || { id: messageId, status: traceState.data.message && traceState.data.message.status }, traceState);
  return traceState;
}

/**
 * @param {any} trace
 * @param {string | Record<string, string>} [fallbackStatus='observed']
 * @param {string} [nextStepId='']
 * @param {string[] | null} [kinds=null]
 */
function finalizeRunningStepsInTrace(trace, fallbackStatus = 'observed', nextStepId = '', kinds = null) {
  if (!trace || !Array.isArray(trace.steps)) {
    return false;
  }

  const allowedKinds = Array.isArray(kinds) && kinds.length > 0 ? new Set(kinds.map((kind) => String(kind))) : null;
  let changed = false;

  trace.steps = trace.steps.map((step) => {
    if (!step || normalizeToolTraceStepStatus(step.status) !== 'running' || (nextStepId && step.stepId === nextStepId)) {
      return step;
    }

    if (allowedKinds && !allowedKinds.has(String(step.kind || ''))) {
      return step;
    }

    changed = true;
    return {
      ...step,
      status: resolveFinalizedTraceStatus(step, fallbackStatus),
    };
  });

  return changed;
}

/**
 * @param {string} messageId
 * @param {string} stepId
 * @param {string | Record<string, string>} [fallbackStatus='observed']
 */
function finalizeMessageToolTraceRunningStep(messageId, stepId, fallbackStatus = 'observed') {
  if (!messageId || !stepId) {
    return false;
  }

  const traceState = mutateMessageToolTrace(messageId, (trace) => {
    if (!trace || !Array.isArray(trace.steps)) {
      return;
    }

    trace.steps = trace.steps.map((step) => {
      if (!step || step.stepId !== stepId || normalizeToolTraceStepStatus(step.status) !== 'running') {
        return step;
      }

      return {
        ...step,
        status: resolveFinalizedTraceStatus(step, fallbackStatus),
      };
    });
  });

  return Boolean(traceState);
}

/**
 * @param {string} messageId
 * @param {string | Record<string, string>} [fallbackStatus='observed']
 */
function finalizeMessageToolTraceRunningSteps(messageId, fallbackStatus = 'observed') {
  if (!messageId) {
    return false;
  }

  const traceState = mutateMessageToolTrace(messageId, (trace) => {
    finalizeRunningStepsInTrace(trace, fallbackStatus);
  });

  return Boolean(traceState);
}

function applyConversationToolEvent(payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const messageId = String(payload.messageId || payload.assistantMessageId || '').trim();
  const taskId = String(payload.taskId || '').trim() || null;
  const step = payload.step && typeof payload.step === 'object' ? cloneTraceValue(payload.step) : null;

  if (!messageId || !step) {
    return false;
  }

  const traceState = mutateMessageToolTrace(messageId, (trace, message) => {
    const nextMessage = message || currentConversationMessageById(messageId);

    trace.message = {
      ...(trace.message && typeof trace.message === 'object' ? trace.message : {}),
      id: messageId,
      status: nextMessage && nextMessage.status ? nextMessage.status : trace.message && trace.message.status ? trace.message.status : '',
      taskId: taskId || (nextMessage && nextMessage.taskId ? nextMessage.taskId : trace.message && trace.message.taskId ? trace.message.taskId : null),
      runId: nextMessage && nextMessage.runId !== undefined ? nextMessage.runId : trace.message && trace.message.runId !== undefined ? trace.message.runId : null,
      createdAt: nextMessage && nextMessage.createdAt ? nextMessage.createdAt : trace.message && trace.message.createdAt ? trace.message.createdAt : '',
    };

    if (taskId) {
      trace.task = {
        ...(trace.task && typeof trace.task === 'object' ? trace.task : {}),
        id: taskId,
        status: trace.task && trace.task.status ? trace.task.status : step.status === 'failed' ? 'failed' : 'running',
      };
    }

    if (!Array.isArray(trace.steps)) {
      trace.steps = [];
    }

    if (payload.phase === 'started' && step.kind === 'session') {
      finalizeRunningStepsInTrace(trace, 'observed', step.stepId || '', ['session']);
    }

    const stepId = String(step.stepId || '').trim();
    const existingIndex = stepId ? trace.steps.findIndex((entry) => entry && entry.stepId === stepId) : -1;

    if (existingIndex === -1) {
      trace.steps.push(step);
    } else {
      trace.steps[existingIndex] = mergeToolTraceStep(trace.steps[existingIndex], step);
    }

    if (trace.task && step.status === 'failed') {
      trace.task.status = 'failed';
    }
  });

  if (!traceState) {
    return false;
  }

  if (state.selectedConversationId === payload.conversationId) {
    scheduleConversationPaneRender();
  }

  return true;
}

function syncToolTraceStatesWithConversation(conversation) {
  if (!conversation || !Array.isArray(conversation.messages)) {
    return;
  }

  conversation.messages
    .filter((message) => canInspectToolTrace(message))
    .forEach((message) => {
      const traceState = toolTraceStateForMessage(message.id);

      if (!traceState || !traceState.data) {
        return;
      }

      const finalStatusMap = {
        session: message.status === 'failed' ? 'failed' : 'observed',
        bridge: message.status === 'failed' ? 'failed' : 'succeeded',
        default: message.status === 'failed' ? 'failed' : 'observed',
      };

      mutateMessageToolTrace(message.id, (trace) => {
        if (message.status === 'completed' || message.status === 'failed') {
          finalizeRunningStepsInTrace(trace, finalStatusMap);
        }
      });
    });
}

function syncToolTraceStatesFromTurnProgress(previousTurn, nextTurn) {
  if (!previousTurn || !Array.isArray(previousTurn.agents)) {
    return;
  }

  const nextAgentsById = new Map(
    Array.isArray(nextTurn && nextTurn.agents) ? nextTurn.agents.map((agent) => [agent.agentId, agent]) : []
  );

  previousTurn.agents.forEach((previousAgent) => {
    if (!previousAgent || !previousAgent.messageId || !previousAgent.currentToolStepId) {
      return;
    }

    const nextAgent = nextAgentsById.get(previousAgent.agentId) || null;
    const sameMessage = Boolean(nextAgent && nextAgent.messageId === previousAgent.messageId);
    const sameStep = sameMessage && String(nextAgent.currentToolStepId || '').trim() === String(previousAgent.currentToolStepId || '').trim();
    const nextToolName = sameMessage ? String(nextAgent && nextAgent.currentToolName ? nextAgent.currentToolName : '').trim() : '';

    if (sameStep && nextToolName) {
      return;
    }

    const nextFailed = String(nextAgent && nextAgent.status ? nextAgent.status : '').trim().toLowerCase() === 'failed';
    const fallbackStatus = {
      session: nextFailed ? 'failed' : 'observed',
      bridge: nextFailed ? 'failed' : 'succeeded',
      default: nextFailed ? 'failed' : 'observed',
    };

    finalizeMessageToolTraceRunningStep(previousAgent.messageId, previousAgent.currentToolStepId, fallbackStatus);
  });
}

function syncToolTraceStatesFromAgentSlotProgress(previousSlot, nextSlot) {
  if (!previousSlot || !previousSlot.assistantMessageId || !previousSlot.currentToolStepId) {
    return;
  }

  const sameMessage = Boolean(nextSlot && nextSlot.assistantMessageId === previousSlot.assistantMessageId);
  const sameStep = sameMessage && String(nextSlot.currentToolStepId || '').trim() === String(previousSlot.currentToolStepId || '').trim();
  const nextToolName = sameMessage ? String(nextSlot && nextSlot.currentToolName ? nextSlot.currentToolName : '').trim() : '';

  if (sameStep && nextToolName) {
    return;
  }

  const nextFailed = String(nextSlot && nextSlot.status ? nextSlot.status : '').trim().toLowerCase() === 'failed';
  const fallbackStatus = {
    session: nextFailed ? 'failed' : 'observed',
    bridge: nextFailed ? 'failed' : 'succeeded',
    default: nextFailed ? 'failed' : 'observed',
  };

  finalizeMessageToolTraceRunningStep(previousSlot.assistantMessageId, previousSlot.currentToolStepId, fallbackStatus);
}

function computeMessageToolTraceRequestKey(message) {
  const sessionInfo = messageSessionInfo(message);

  return [
    message && message.taskId ? message.taskId : '',
    message && message.status ? message.status : '',
    message && message.runId ? message.runId : '',
    sessionInfo.sessionPath,
    sessionInfo.sessionName,
  ].join('|');
}

function toolTraceFailureContext(trace) {
  return trace && trace.failureContext && typeof trace.failureContext === 'object' ? trace.failureContext : null;
}

function messageHasFailedStatus(message) {
  return String(message && message.status ? message.status : '').trim().toLowerCase() === 'failed';
}

function messageToolTraceHasFailure(message, traceState) {
  if (traceState && traceState.status === 'error') {
    return true;
  }

  const trace = traceState && traceState.data ? traceState.data : null;
  const failureContext = toolTraceFailureContext(trace);
  const summary = trace && trace.summary ? trace.summary : null;

  return Boolean(
    (failureContext && failureContext.hasFailure) ||
    (summary && summary.status === 'failed') ||
    messageHasFailedStatus(message)
  );
}

function maybeAutoOpenMessageToolTrace(message, traceState) {
  if (!traceState || traceState.open || traceState.userToggled) {
    return false;
  }

  if (!messageToolTraceHasFailure(message, traceState)) {
    return false;
  }

  traceState.open = true;
  return true;
}

function buildMessageToolTraceErrorContext(message, traceState) {
  const trace = traceState && traceState.data ? traceState.data : null;
  const failureContext = toolTraceFailureContext(trace);

  if (failureContext && failureContext.text) {
    return String(failureContext.text);
  }

  if (traceState && traceState.errorMessage) {
    return [
      `消息: ${message && message.id ? message.id : '(unknown)'}`,
      `状态: ${message && message.status ? message.status : 'unknown'}`,
      '',
      `工具链路加载失败：${traceState.errorMessage}`,
    ].join('\n');
  }

  return '';
}

async function copyMessageToolTraceErrorContext(message) {
  const traceState = toolTraceStateForMessage(message && message.id);
  const text = buildMessageToolTraceErrorContext(message, traceState);

  if (!text) {
    showToast('暂无可复制的错误上下文');
    return;
  }

  if (typeof copyTextToClipboard === 'function') {
    await copyTextToClipboard(text);
    showToast('已复制错误上下文');
    return;
  }

  if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    showToast('已复制错误上下文');
    return;
  }

  throw new Error('当前环境不支持复制');
}

function toolTraceDetailSignature(trace) {
  if (!trace) {
    return '';
  }

  function traceValueSignature(value, maxLength = 160) {
    if (value == null || value === '') {
      return '';
    }

    if (typeof value === 'string') {
      return value.slice(0, maxLength);
    }

    try {
      return JSON.stringify(value).slice(0, maxLength);
    } catch {
      return String(value).slice(0, maxLength);
    }
  }

  const timelineSteps = Array.isArray(trace.steps) && trace.steps.length > 0
    ? trace.steps
    : [].concat(
        Array.isArray(trace.sessionToolCalls) ? trace.sessionToolCalls : [],
        Array.isArray(trace.bridgeToolEvents) ? trace.bridgeToolEvents : []
      );

  return timelineSteps
    .map((step) =>
      [
        step && step.stepId ? step.stepId : '',
        step && step.kind ? step.kind : '',
        step && step.toolName ? step.toolName : '',
        step && step.status ? step.status : '',
        step && step.durationMs ? step.durationMs : 0,
        step && step.createdAt ? step.createdAt : '',
        step && step.partialJson ? traceValueSignature(step.partialJson) : '',
        step && step.requestSummary ? traceValueSignature(step.requestSummary) : '',
        step && step.resultSummary ? traceValueSignature(step.resultSummary) : '',
        step && step.errorSummary ? traceValueSignature(step.errorSummary) : '',
        step && step.bridgeToolHint ? step.bridgeToolHint : '',
        step && step.linkedFromStepId ? step.linkedFromStepId : '',
      ].join('\u001c')
    )
    .join('\u001d');
}

function toolTraceSignatureForMessage(message) {
  const traceState = toolTraceStateForMessage(message && message.id);
  const trace = traceState && traceState.data ? traceState.data : null;
  const summary = trace && trace.summary ? trace.summary : null;
  const task = trace && trace.task ? trace.task : null;
  const session = trace && trace.session ? trace.session : null;
  const activity = trace && trace.activity && typeof trace.activity === 'object' ? trace.activity : null;
  const failureContext = toolTraceFailureContext(trace);

  return [
    traceState && traceState.open ? 'open' : 'closed',
    traceState && traceState.status ? traceState.status : 'idle',
    traceState && traceState.requestKey ? traceState.requestKey : '',
    traceState && traceState.errorMessage ? traceState.errorMessage : '',
    traceState && traceState.userToggled ? 'toggled' : 'auto',
    summary && summary.status ? summary.status : '',
    summary && summary.totalSteps ? summary.totalSteps : 0,
    summary && summary.failedSteps ? summary.failedSteps : 0,
    summary && summary.totalDurationMs ? summary.totalDurationMs : 0,
    summary && summary.retryCount ? summary.retryCount : 0,
    task && task.status ? task.status : '',
    task && task.errorMessage ? task.errorMessage : '',
    session && session.stopReason ? session.stopReason : '',
    session && session.assistantMessageTotal ? session.assistantMessageTotal : 0,
    activity && activity.status ? activity.status : '',
    activity && activity.hasCurrentTool ? 'active' : 'idle',
    activity && activity.currentToolName ? activity.currentToolName : '',
    activity && activity.currentStepId ? activity.currentStepId : '',
    activity && activity.currentStepKind ? activity.currentStepKind : '',
    activity && activity.inferred ? 'inferred' : 'direct',
    activity && activity.label ? activity.label : '',
    failureContext && failureContext.hasFailure ? 'failed' : 'ok',
    failureContext && failureContext.source ? failureContext.source : '',
    failureContext && failureContext.stepId ? failureContext.stepId : '',
    failureContext && failureContext.toolName ? failureContext.toolName : '',
    failureContext && failureContext.text ? failureContext.text : '',
    toolTraceDetailSignature(trace),
  ].join('\u001e');
}

function messageToolTraceUrl(conversationId, messageId) {
  return `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/tool-trace`;
}

function clearMessageToolTraceTimer(messageId) {
  const timer = state.messageToolTraceTimers.get(messageId);

  if (!timer) {
    return;
  }

  window.clearTimeout(timer);
  state.messageToolTraceTimers.delete(messageId);
}

function clearAllMessageToolTraceTimers() {
  for (const messageId of Array.from(state.messageToolTraceTimers.keys())) {
    clearMessageToolTraceTimer(messageId);
  }
}

function shouldPollMessageToolTrace(_message, _traceState) {
  return false;
}

function scheduleMessageToolTracePoll(conversationId, message) {
  if (!message || !message.id) {
    return;
  }

  clearMessageToolTraceTimer(message.id);

  const traceState = toolTraceStateForMessage(message.id);

  if (!shouldPollMessageToolTrace(message, traceState)) {
    return;
  }

  const timer = window.setTimeout(() => {
    void fetchMessageToolTrace(conversationId, message, { force: true, silent: true });
  }, 1500);

  state.messageToolTraceTimers.set(message.id, timer);
}

async function fetchMessageToolTrace(conversationId, message, options = {}) {
  if (!conversationId || !canInspectToolTrace(message)) {
    return null;
  }

  const traceState = getMessageToolTraceState(message.id);

  if (!traceState) {
    return null;
  }

  const requestKey = computeMessageToolTraceRequestKey(message);

  if (!options.force && traceState.status === 'loading' && traceState.requestKey === requestKey && traceState.promise) {
    return traceState.promise;
  }

  if (!options.force && traceState.status === 'ready' && traceState.requestKey === requestKey) {
    scheduleMessageToolTracePoll(conversationId, message);
    return traceState.data;
  }

  traceState.status = 'loading';
  traceState.errorMessage = '';
  traceState.requestKey = requestKey;
  scheduleConversationPaneRender();

  const request = fetchJson(messageToolTraceUrl(conversationId, message.id))
    .then((result) => {
      traceState.status = 'ready';
      traceState.data = mergeMessageToolTraceData(traceState.data, result && result.trace ? result.trace : null, message);
      traceState.errorMessage = '';
      maybeAutoOpenMessageToolTrace(message, traceState);
      if (state.selectedConversationId === conversationId) {
        scheduleConversationPaneRender();
      }
      scheduleMessageToolTracePoll(conversationId, message);
      return traceState.data;
    })
    .catch((error) => {
      traceState.status = 'error';
      traceState.errorMessage = error && error.message ? error.message : '工具链路加载失败';
      maybeAutoOpenMessageToolTrace(message, traceState);
      if (state.selectedConversationId === conversationId) {
        scheduleConversationPaneRender();
      }
      clearMessageToolTraceTimer(message.id);
      return null;
    })
    .finally(() => {
      if (traceState.promise === request) {
        traceState.promise = null;
      }
    });

  traceState.promise = request;
  return request;
}

function collectWarmConversationToolTraceMessages(conversation) {
  const inspectableMessages =
    conversation && Array.isArray(conversation.messages)
      ? conversation.messages.filter((message) => canInspectToolTrace(message))
      : [];

  if (inspectableMessages.length <= MAX_WARM_TOOL_TRACE_MESSAGES) {
    return inspectableMessages;
  }

  return inspectableMessages
    .map((message, index) => {
      const traceState = toolTraceStateForMessage(message.id);
      const isPinned = Boolean(traceState && (traceState.open || traceState.status === 'loading'));
      const isRunning = Boolean(message && (message.status === 'queued' || message.status === 'streaming'));
      const isFailed = Boolean(message && message.status === 'failed');
      const hasError = Boolean(traceState && traceState.status === 'error');

      return {
        index,
        message,
        priority: (isPinned ? 300 : 0) + (isRunning ? 200 : 0) + (isFailed ? 100 : 0) + (hasError ? 50 : 0) + index,
      };
    })
    .sort((left, right) => right.priority - left.priority)
    .slice(0, MAX_WARM_TOOL_TRACE_MESSAGES)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.message);
}

function warmConversationToolTraces(conversation) {
  if (!conversation || !conversation.id || !Array.isArray(conversation.messages)) {
    return;
  }

  collectWarmConversationToolTraceMessages(conversation).forEach((message) => {
    const traceState = toolTraceStateForMessage(message.id);
    const requestKey = computeMessageToolTraceRequestKey(message);

    if (
      !traceState ||
      traceState.status === 'idle' ||
      (traceState.status !== 'loading' && traceState.requestKey !== requestKey) ||
      (traceState.status !== 'ready' && traceState.requestKey === requestKey)
    ) {
      void fetchMessageToolTrace(conversation.id, message, { silent: true });
      return;
    }

    maybeAutoOpenMessageToolTrace(message, traceState);
    scheduleMessageToolTracePoll(conversation.id, message);
  });
}

function toggleMessageToolTrace(conversationId, message) {
  if (!conversationId || !canInspectToolTrace(message)) {
    return;
  }

  const traceState = getMessageToolTraceState(message.id);

  if (!traceState) {
    return;
  }

  traceState.userToggled = true;
  traceState.open = !traceState.open;

  if (!traceState.open) {
    scheduleConversationPaneRender();
    scheduleMessageToolTracePoll(conversationId, message);
    return;
  }

  scheduleConversationPaneRender();
  void fetchMessageToolTrace(conversationId, message, {
    force: traceState.status === 'error' || traceState.status === 'idle',
  });
}

function renderConversationList() {
  conversationListRenderer.render();
}

function renderParticipantList(conversation) {
  participantPaneRenderer.render(conversation);
}

function renderMessages(conversation, activeTurn, activeAgentSlots = []) {
  messageTimelineRenderer.render(conversation, activeTurn, activeAgentSlots);
  const view = messageHistory.controlView(state.messageHistory);
  dom.messageHistoryControl.classList.toggle('hidden', view.hidden);
  dom.messageHistoryButton.disabled = view.disabled;
  dom.messageHistoryButton.textContent = view.label;
  dom.messageHistoryStatus.textContent = view.status;
}

function renderCompactConversationPersonaSettings() {
  conversationSettingsController.render();
}

function renderUndercoverGameCard() {
  undercoverPanelRenderer.render();
}

function renderWerewolfGameCard() {
  werewolfPanelRenderer.render();
}

function renderConversationPane() {
  conversationPaneRenderer.render();
  renderSessionGoalPanel();
  renderConversationDigestPanel();
  renderSummaryMemoryPanel();
}

function renderSessionGoalPanel() {
  sessionGoalPanelController.render();
}

function renderConversationDigestPanel() {
  conversationDigestPanelController.render();
}

function renderSummaryMemoryPanel() {
  summaryMemoryPanelController.render();
}

function openSkillDraftPanel() {
  if (typeof conversationDigestPanelController.openSkillDrafts === 'function') {
    conversationDigestPanelController.openSkillDrafts();
    return;
  }

  if (dom.conversationDigestToggleButton) {
    dom.conversationDigestToggleButton.click();
  }
}

function selectedConversationParticipants() {
  return conversationSettingsController.selectedParticipants();
}

function setFeishuBindingNotice(conversationId, message) {
  state.feishuBindingNoticeConversationId = conversationId || null;
  state.feishuBindingNotice = String(message || '').trim();
}

async function refreshKnownFeishuChats(options = {}) {
  const render = options.render !== false;
  const swallowErrors = options.swallowErrors !== false;

  state.loadingFeishuChats = true;
  if (render) {
    renderCompactConversationPersonaSettings();
  }

  try {
    const data = await fetchJson('/api/channel-bindings/feishu');
    state.knownFeishuChats = Array.isArray(data && data.chats) ? data.chats : [];
  } catch (error) {
    state.knownFeishuChats = [];
    if (!swallowErrors) {
      throw error;
    }
  } finally {
    state.loadingFeishuChats = false;
    if (render) {
      renderCompactConversationPersonaSettings();
    }
  }
}

function activeTurnForConversation(conversationId) {
  if (!state.runtime || !Array.isArray(state.runtime.activeTurns)) {
    return null;
  }

  return state.runtime.activeTurns.find((turn) => turn.conversationId === conversationId) || null;
}

function activeAgentSlotsForConversation(conversationId) {
  if (!state.runtime || !Array.isArray(state.runtime.activeAgentSlots)) {
    return [];
  }

  return state.runtime.activeAgentSlots.filter((slot) => slot && slot.conversationId === conversationId);
}

function queuedUserMessageCountForConversation(conversationId) {
  const activeTurn = activeTurnForConversation(conversationId);

  if (activeTurn && Number.isFinite(Number(activeTurn.queueDepth))) {
    return Math.max(0, Number(activeTurn.queueDepth || 0));
  }

  const queueDepths =
    state.runtime && state.runtime.conversationQueueDepths && typeof state.runtime.conversationQueueDepths === 'object'
      ? state.runtime.conversationQueueDepths
      : null;
  const value = queueDepths && conversationId ? Number(queueDepths[conversationId] || 0) : 0;

  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function queuedAgentSlotMessageCountForConversation(conversationId) {
  const queueDepths =
    state.runtime && state.runtime.agentSlotQueueDepths && typeof state.runtime.agentSlotQueueDepths === 'object'
      ? state.runtime.agentSlotQueueDepths
      : null;
  const perAgentDepths = queueDepths && conversationId && typeof queueDepths[conversationId] === 'object' ? queueDepths[conversationId] : null;

  if (!perAgentDepths) {
    return 0;
  }

  return Object.values(perAgentDepths).reduce((sum, value) => {
    return sum + Math.max(0, Number(value || 0));
  }, 0);
}

function queueFailureForConversation(conversationId) {
  const queueFailures =
    state.runtime && state.runtime.conversationQueueFailures && typeof state.runtime.conversationQueueFailures === 'object'
      ? state.runtime.conversationQueueFailures
      : null;
  const failure = queueFailures && conversationId ? queueFailures[conversationId] : null;

  if (!failure || typeof failure !== 'object' || !failure.lastFailureAt) {
    return null;
  }

  return {
    failedBatchCount: Math.max(0, Number(failure.failedBatchCount || 0)),
    lastFailureAt: String(failure.lastFailureAt || ''),
    lastFailureMessage: String(failure.lastFailureMessage || ''),
  };
}

function digestStatusForConversation(conversationId) {
  const normalizedConversationId = String(conversationId || '').trim();

  if (!normalizedConversationId || !state.digestStatusByConversation) {
    return null;
  }

  return state.digestStatusByConversation.get(normalizedConversationId) || null;
}

function applyConversationDigestStatus(payload) {
  const conversationId = String(payload && payload.conversationId || '').trim();

  if (!conversationId) {
    return;
  }

  const status = String(payload && payload.status || '').trim();

  if (status === 'running') {
    const model = payload && payload.model && typeof payload.model === 'object' ? payload.model : null;
    const modelTrace = payload && payload.modelTrace && typeof payload.modelTrace === 'object' ? payload.modelTrace : null;
    state.digestStatusByConversation.set(conversationId, {
      status,
      reason: String(payload && payload.reason || ''),
      phase: String(payload && payload.phase || ''),
      message: String(payload && payload.message || '正在整理本轮经验，并写入会话摘要…'),
      pendingExperienceDraftCount: Math.max(0, Number(payload && payload.pendingExperienceDraftCount || 0)),
      model: model
        ? {
          provider: String(model.provider || ''),
          model: String(model.model || ''),
          thinking: String(model.thinking || ''),
          label: String(model.label || ''),
        }
        : null,
      modelTrace: modelTrace
        ? {
          eventCount: Math.max(0, Number(modelTrace.eventCount || 0)),
          outputPreview: String(modelTrace.outputPreview || ''),
          thinkingPreview: String(modelTrace.thinkingPreview || ''),
          runId: String(modelTrace.runId || ''),
          updatedAt: String(modelTrace.updatedAt || ''),
        }
        : null,
      updatedAt: new Date().toISOString(),
    });
  } else {
    state.digestStatusByConversation.delete(conversationId);
  }

  if (state.selectedConversationId === conversationId) {
    renderConversationPane();
  }
}

function mergeRuntimePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  state.runtime = {
    ...(state.runtime || {}),
    ...payload,
  };
}

function compareMessageOrder(left, right) {
  const leftTime = left && left.createdAt ? Date.parse(left.createdAt) : Number.NaN;
  const rightTime = right && right.createdAt ? Date.parse(right.createdAt) : Number.NaN;

  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return String(left && left.id ? left.id : '').localeCompare(String(right && right.id ? right.id : ''), 'zh-CN');
}

function createClientRequestId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }

  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function messageClientRequestId(message) {
  const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
  return String(metadata && metadata.clientRequestId ? metadata.clientRequestId : '').trim();
}

function optimisticMessagesForConversation(conversationId) {
  const normalizedConversationId = String(conversationId || '').trim();

  if (!normalizedConversationId) {
    return [];
  }

  const optimisticMessages = state.optimisticMessagesByConversation.get(normalizedConversationId);
  return Array.isArray(optimisticMessages) ? optimisticMessages.slice() : [];
}

function setOptimisticMessagesForConversation(conversationId, messages) {
  const normalizedConversationId = String(conversationId || '').trim();

  if (!normalizedConversationId) {
    return;
  }

  const nextMessages = Array.isArray(messages) ? messages.filter(Boolean) : [];

  if (nextMessages.length === 0) {
    state.optimisticMessagesByConversation.delete(normalizedConversationId);
    return;
  }

  state.optimisticMessagesByConversation.set(normalizedConversationId, nextMessages);
}

function applyOptimisticUserMessage(conversationId, content, clientRequestId) {
  const normalizedConversationId = String(conversationId || '').trim();
  const normalizedContent = String(content || '').trim();
  const normalizedClientRequestId = String(clientRequestId || '').trim();

  if (!normalizedConversationId || !normalizedContent || !normalizedClientRequestId) {
    return null;
  }

  const optimisticMessage = {
    id: `optimistic-${normalizedClientRequestId}`,
    turnId: normalizedClientRequestId,
    conversationId: normalizedConversationId,
    role: 'user',
    senderName: 'You',
    content: normalizedContent,
    status: 'pending',
    metadata: {
      source: 'web-ui',
      clientRequestId: normalizedClientRequestId,
      optimistic: true,
    },
    createdAt: new Date().toISOString(),
  };
  const nextMessages = optimisticMessagesForConversation(normalizedConversationId).filter(
    (message) => messageClientRequestId(message) !== normalizedClientRequestId
  );

  nextMessages.push(optimisticMessage);
  nextMessages.sort(compareMessageOrder);
  setOptimisticMessagesForConversation(normalizedConversationId, nextMessages);

  return optimisticMessage;
}

function clearOptimisticUserMessage(conversationId, clientRequestId) {
  const normalizedConversationId = String(conversationId || '').trim();
  const normalizedClientRequestId = String(clientRequestId || '').trim();

  if (!normalizedConversationId || !normalizedClientRequestId) {
    return;
  }

  const nextMessages = optimisticMessagesForConversation(normalizedConversationId).filter(
    (message) => messageClientRequestId(message) !== normalizedClientRequestId
  );
  setOptimisticMessagesForConversation(normalizedConversationId, nextMessages);
}

function pruneOptimisticMessagesForConversation(conversationId, persistedMessages) {
  const normalizedConversationId = String(conversationId || '').trim();

  if (!normalizedConversationId) {
    return;
  }

  const persistedClientRequestIds = new Set(
    (Array.isArray(persistedMessages) ? persistedMessages : []).map(messageClientRequestId).filter(Boolean)
  );

  if (persistedClientRequestIds.size === 0) {
    return;
  }

  const nextMessages = optimisticMessagesForConversation(normalizedConversationId).filter((message) => {
    const clientRequestId = messageClientRequestId(message);
    return !clientRequestId || !persistedClientRequestIds.has(clientRequestId);
  });

  setOptimisticMessagesForConversation(normalizedConversationId, nextMessages);
}

function mergeConversationFromSendResponse(conversationId, payloadConversation, acceptedMessage) {
  if (!state.currentConversation || state.currentConversation.id !== conversationId) {
    return;
  }

  const currentMessages = Array.isArray(state.currentConversation.messages) ? state.currentConversation.messages : [];
  const mergedMessages = messageHistory.mergeMessages(
    currentMessages,
    acceptedMessage && acceptedMessage.id ? [acceptedMessage] : []
  );
  const projection = payloadConversation && typeof payloadConversation === 'object' ? { ...payloadConversation } : {};
  delete projection.messages;
  pruneOptimisticMessagesForConversation(conversationId, mergedMessages);

  state.currentConversation = {
    ...state.currentConversation,
    ...projection,
    messages: mergedMessages,
    privateMessages:
      payloadConversation && Array.isArray(payloadConversation.privateMessages)
        ? payloadConversation.privateMessages
        : state.currentConversation.privateMessages,
  };
}

function upsertRuntimeTurn(turn) {
  if (!turn || !turn.conversationId) {
    return;
  }

  state.runtime = state.runtime || {};
  const activeTurns = Array.isArray(state.runtime.activeTurns) ? state.runtime.activeTurns.slice() : [];
  const index = activeTurns.findIndex((item) => item.conversationId === turn.conversationId);

  if (index === -1) {
    activeTurns.push(turn);
  } else {
    activeTurns[index] = turn;
  }

  state.runtime.activeTurns = activeTurns;
}

function upsertActiveAgentSlot(slot) {
  if (!slot || !slot.slotId) {
    return;
  }

  state.runtime = state.runtime || {};
  const activeAgentSlots = Array.isArray(state.runtime.activeAgentSlots) ? state.runtime.activeAgentSlots.slice() : [];
  const index = activeAgentSlots.findIndex((item) => item && item.slotId === slot.slotId);

  if (index === -1) {
    activeAgentSlots.push(slot);
  } else {
    activeAgentSlots[index] = slot;
  }

  state.runtime.activeAgentSlots = activeAgentSlots;
}

function removeActiveAgentSlot(slotId) {
  if (!slotId || !state.runtime || !Array.isArray(state.runtime.activeAgentSlots)) {
    return;
  }

  state.runtime.activeAgentSlots = state.runtime.activeAgentSlots.filter((slot) => slot && slot.slotId !== slotId);
}

function turnProgressSignature(turn) {
  if (!turn) {
    return 'none';
  }

  return JSON.stringify({
    id: turn.turnId || null,
    status: turn.status || '',
    currentAgentId: turn.currentAgentId || null,
    completedCount: turn.completedCount || 0,
    failedCount: turn.failedCount || 0,
    hopCount: turn.hopCount || 0,
    batchStartMessageId: turn.batchStartMessageId || null,
    batchEndMessageId: turn.batchEndMessageId || null,
    consumedUpToMessageId: turn.consumedUpToMessageId || null,
    inputMessageCount: turn.inputMessageCount || 0,
    queueDepth: turn.queueDepth || 0,
    pendingAgentIds: Array.isArray(turn.pendingAgentIds) ? turn.pendingAgentIds : [],
    entryAgentIds: Array.isArray(turn.entryAgentIds) ? turn.entryAgentIds : [],
    stopRequested: Boolean(turn.stopRequested),
    stopReason: turn.stopReason || '',
    terminationReason: turn.terminationReason || '',
    agents: Array.isArray(turn.agents)
      ? turn.agents.map((agent) => ({
          agentId: agent.agentId || null,
          status: agent.status || '',
          messageId: agent.messageId || null,
          replyLength: agent.replyLength || 0,
          preview: agent.preview || '',
          finalContent: agent.finalContent || '',
          errorMessage: agent.errorMessage || '',
          hop: agent.hop || 0,
          lastTextDeltaAt: agent.lastTextDeltaAt || null,
          currentToolName: agent.currentToolName || '',
          currentToolKind: agent.currentToolKind || '',
          currentToolStepId: agent.currentToolStepId || '',
          currentToolStartedAt: agent.currentToolStartedAt || null,
          currentToolInferred: Boolean(agent.currentToolInferred),
        }))
      : [],
  });
}

function agentSlotProgressSignature(slot) {
  if (!slot) {
    return 'none';
  }

  return JSON.stringify({
    slotId: slot.slotId || null,
    turnId: slot.turnId || null,
    status: slot.status || '',
    turnStatus: slot.turnStatus || '',
    assistantMessageId: slot.assistantMessageId || null,
    taskId: slot.taskId || null,
    runId: slot.runId || null,
    replyLength: slot.replyLength || 0,
    preview: slot.preview || '',
    finalContent: slot.finalContent || '',
    errorMessage: slot.errorMessage || '',
    lastTextDeltaAt: slot.lastTextDeltaAt || null,
    currentToolName: slot.currentToolName || '',
    currentToolKind: slot.currentToolKind || '',
    currentToolStepId: slot.currentToolStepId || '',
    currentToolStartedAt: slot.currentToolStartedAt || null,
    currentToolInferred: Boolean(slot.currentToolInferred),
    stopRequested: Boolean(slot.stopRequested),
    stopReason: slot.stopReason || '',
  });
}

function ensureSelectedAgent() {
  if (state.selectedAgentId && agentById(state.selectedAgentId)) {
    return;
  }

  state.selectedAgentId = state.agents[0] ? state.agents[0].id : null;
}

function getSelectedAgent() {
  return state.selectedAgentId ? agentById(state.selectedAgentId) : null;
}

function showToast(message) {
  toast.show(message);
}

function scrollMessageListToBottom() {
  messageHistory.scrollToBottom(dom.messageList);
}

function isMessageListNearBottom() {
  return messageHistory.isNearBottom(dom.messageList);
}

function scheduleConversationPaneRender(delayMs = 0) {
  if (typeof delayMs === 'number' && delayMs > 0) {
    clearLiveDraftFinalizingTimer();
    liveDraftFinalizingTimer = window.setTimeout(() => {
      liveDraftFinalizingTimer = null;
      scheduleConversationPaneRender();
    }, delayMs);
    return;
  }

  if (conversationPaneRenderPending) {
    return;
  }

  conversationPaneRenderPending = true;
  window.requestAnimationFrame(() => {
    conversationPaneRenderPending = false;
    renderConversationPane();
  });
}

function clearLiveDraftFinalizingTimer() {
  if (!liveDraftFinalizingTimer) {
    return;
  }

  window.clearTimeout(liveDraftFinalizingTimer);
  liveDraftFinalizingTimer = null;
}

function isConversationBusy(conversationId) {
  const runtimeBusyIds = Array.isArray(state.runtime && state.runtime.activeConversationIds)
    ? state.runtime.activeConversationIds
    : [];
  const dispatchingIds = Array.isArray(state.runtime && state.runtime.dispatchingConversationIds)
    ? state.runtime.dispatchingConversationIds
    : [];
  const activeTurnBusy = Boolean(activeTurnForConversation(conversationId));
  const activeSlotBusy = activeAgentSlotsForConversation(conversationId).length > 0;

  return runtimeBusyIds.includes(conversationId) || dispatchingIds.includes(conversationId) || activeTurnBusy || activeSlotBusy;
}

function renderRuntime() {
  if (!state.runtime) {
    dom.runtimePill.textContent = '正在连接本地服务...';
    return;
  }

  const busyConversationIds = new Set(
    []
      .concat(Array.isArray(state.runtime.activeConversationIds) ? state.runtime.activeConversationIds : [])
      .concat(Array.isArray(state.runtime.activeTurns) ? state.runtime.activeTurns.map((turn) => turn.conversationId) : [])
      .concat(Array.isArray(state.runtime.activeAgentSlots) ? state.runtime.activeAgentSlots.map((slot) => slot.conversationId) : [])
      .filter(Boolean)
  );
  dom.runtimePill.textContent = `${state.runtime.host}:${state.runtime.port} · ${state.agents.length} Agent · ${busyConversationIds.size} 个房间处理中`;
}

function messageDisplayText(message) {
  const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : null;

  if (!message.content) {
    if (metadata && metadata.privateOnly) {
      return '[仅私密备注]';
    }

    if (metadata && metadata.publiclySilent) {
      return '[无公开回复]';
    }
  }

  return normalizeEscapedMessageText(message.content || (message.errorMessage ? `[错误] ${message.errorMessage}` : '...'));
}

function normalizeEscapedMessageText(text) {
  return String(text || '').replace(/\\r\\n|\\n|\\r/g, '\n');
}

function conversationPreviewText(text) {
  return normalizeEscapedMessageText(text).replace(/\s+/g, ' ').trim();
}

function isPrivateTimelineMessage(message) {
  return Boolean(message && message.role === 'private');
}

function privateRecipientNames(message) {
  const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
  return Array.isArray(metadata && metadata.recipientNames) ? metadata.recipientNames.filter(Boolean) : [];
}

function timelineMessagesForConversation(conversation) {
  const publicMessages = conversation && Array.isArray(conversation.messages) ? conversation.messages : [];
  const privateMessages = conversation && Array.isArray(conversation.privateMessages) ? conversation.privateMessages : [];
  const optimisticMessages = conversation ? optimisticMessagesForConversation(conversation.id) : [];
  const persistedClientRequestIds = new Set(publicMessages.map(messageClientRequestId).filter(Boolean));
  const timeline = [
    ...publicMessages,
    ...privateMessages,
    ...optimisticMessages.filter((message) => {
      const clientRequestId = messageClientRequestId(message);
      return !clientRequestId || !persistedClientRequestIds.has(clientRequestId);
    }),
  ];

  timeline.sort((left, right) => {
    const leftTime = left && left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightTime = right && right.createdAt ? new Date(right.createdAt).getTime() : 0;

    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    const leftId = left && left.id ? String(left.id) : '';
    const rightId = right && right.id ? String(right.id) : '';
    return leftId.localeCompare(rightId);
  });

  return timeline;
}

function messageSessionInfo(message) {
  const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
  const sessionPath = metadata && metadata.sessionPath ? String(metadata.sessionPath).trim() : '';
  const sessionName = metadata && metadata.sessionName ? String(metadata.sessionName).trim() : '';

  return {
    sessionPath,
    sessionName,
    canExport: Boolean(message && message.role === 'assistant' && (sessionPath || (sessionName && message.status !== 'queued'))),
  };
}

function messageSessionExportUrl(conversationId, messageId) {
  return `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/session-export`;
}

function defaultSessionFileName(message) {
  const sessionInfo = messageSessionInfo(message);

  if (sessionInfo.sessionPath) {
    const segments = sessionInfo.sessionPath.split(/[\\/]+/).filter(Boolean);

    if (segments.length > 0) {
      return segments[segments.length - 1];
    }
  }

  if (sessionInfo.sessionName) {
    return `${sessionInfo.sessionName}.jsonl`;
  }

  return `message-${message && message.id ? message.id : 'session'}.jsonl`;
}

function downloadFileNameFromResponse(response, fallbackName) {
  const contentDisposition = response.headers.get('Content-Disposition') || '';
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);

  if (utf8Match && utf8Match[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {}
  }

  const asciiMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
  return asciiMatch && asciiMatch[1] ? asciiMatch[1] : fallbackName;
}

async function exportMessageSession(conversationId, message) {
  const response = await fetch(messageSessionExportUrl(conversationId, message.id), {
    headers: {
      Accept: 'application/x-ndjson, application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    let errorMessage = `导出失败，状态码 ${response.status}`;

    if (text) {
      try {
        const payload = JSON.parse(text);
        errorMessage = payload && payload.error ? payload.error : errorMessage;
      } catch {
        errorMessage = text;
      }
    }

    throw new Error(errorMessage);
  }

  const blob = await response.blob();
  const fileName = downloadFileNameFromResponse(response, defaultSessionFileName(message));
  const objectUrl = window.URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = objectUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => {
    window.URL.revokeObjectURL(objectUrl);
  }, 0);
}

function messageContextSnapshotUrl(conversationId, messageId, exportMode = false) {
  const suffix = exportMode ? 'context-snapshot-export' : 'context-snapshot';
  return `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/${suffix}`;
}

function setAgentContextDrawerOpen(open, options = {}) {
  state.contextInspector.open = Boolean(open);
  if (!options.fromShell && window.caffShell) {
    if (state.contextInspector.open) {
      window.caffShell.openTab('agent-context-drawer');
    } else {
      window.caffShell.releaseTab('agent-context-drawer');
    }
  }
  renderAgentContextInspector();
}

function formatInspectorNumber(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) {
    return '0';
  }
  return Math.round(number).toLocaleString('zh-CN');
}

function visibilityLabel(value) {
  if (value === 'full') return '完整';
  if (value === 'summary') return '摘要';
  return '受保护';
}

function visibilityClass(value) {
  if (value === 'full') return 'full';
  if (value === 'summary') return 'summary';
  return 'presence';
}

function contextSectionDisplayTitle(section) {
  return section && (section.displayTitle || section.title || section.sectionKey) ? section.displayTitle || section.title || section.sectionKey : '分区';
}

function renderAgentContextInspector() {
  const inspector = state.contextInspector;
  const snapshot = inspector.snapshot;

  if (dom.agentContextStatus) {
    dom.agentContextStatus.textContent = inspector.loading
      ? '正在加载上下文快照…'
      : inspector.errorMessage
        ? inspector.errorMessage
        : snapshot
          ? `${snapshot.agentName || snapshot.agentId || 'Agent'} · 回合 ${snapshot.turnId || '-'} · 约 ${formatInspectorNumber(snapshot.totalApproxTokens)} tokens`
          : '选择一条 AI 消息查看上下文快照';
    dom.agentContextStatus.classList.toggle('paused', Boolean(inspector.errorMessage));
  }

  if (dom.agentContextExportButton) {
    dom.agentContextExportButton.disabled = !snapshot || inspector.loading;
  }

  if (dom.agentContextSummary) {
    dom.agentContextSummary.textContent = '';
    if (snapshot) {
      const totalTokens = Math.max(1, Number(snapshot.totalApproxTokens || 0));
      const meta = document.createElement('div');
      meta.className = 'agent-context-meta-grid';
      const metaItems = [
        ['智能体', snapshot.agentName || snapshot.agentId || '-'],
        ['捕获时间', snapshot.capturedAt || '-'],
        ['系统提示词 tokens 总数', formatInspectorNumber(snapshot.totalApproxTokens)],
        ['总字节数', formatInspectorNumber(snapshot.totalByteSize)],
      ];
      for (const item of metaItems) {
        const cell = document.createElement('div');
        const label = document.createElement('span');
        const value = document.createElement('strong');
        label.textContent = item[0];
        value.textContent = item[1];
        cell.append(label, value);
        meta.appendChild(cell);
      }

      const bar = document.createElement('div');
      bar.className = 'agent-context-token-bar';
      for (const section of Array.isArray(snapshot.sections) ? snapshot.sections : []) {
        const piece = document.createElement('span');
        piece.className = `agent-context-token-piece ${visibilityClass(section.visibility)}`;
        piece.style.width = `${Math.max(2, Math.round((Number(section.approxTokens || 0) / totalTokens) * 100))}%`;
        piece.title = `${contextSectionDisplayTitle(section)}：${formatInspectorNumber(section.approxTokens)} tokens`;
        bar.appendChild(piece);
      }

      dom.agentContextSummary.append(meta, bar);
    }
  }

  if (!dom.agentContextSectionList) {
    return;
  }

  dom.agentContextSectionList.textContent = '';

  if (inspector.loading) {
    const loading = document.createElement('p');
    loading.className = 'muted small-note';
    loading.textContent = '咕咕嘎嘎，正在啄上下文分区…';
    dom.agentContextSectionList.appendChild(loading);
    return;
  }

  if (!snapshot) {
    const empty = document.createElement('p');
    empty.className = 'muted small-note';
    empty.textContent = '点击 AI 消息旁边的“上下文”按钮查看快照。';
    dom.agentContextSectionList.appendChild(empty);
    return;
  }

  for (const section of Array.isArray(snapshot.sections) ? snapshot.sections : []) {
    const details = document.createElement('details');
    details.className = `agent-context-section-card ${visibilityClass(section.visibility)}`;
    const summary = document.createElement('summary');
    const title = document.createElement('span');
    const badges = document.createElement('span');
    title.textContent = contextSectionDisplayTitle(section);
    badges.className = 'agent-context-section-badges';
    badges.textContent = `${visibilityLabel(section.visibility)} · ${formatInspectorNumber(section.approxTokens)} tokens · ${formatInspectorNumber(section.byteSize)} 字节`;
    summary.append(title, badges);

    const meta = document.createElement('div');
    meta.className = 'agent-context-section-meta';
    meta.textContent = `来源=${section.source || 'prompt'} · 哈希=${String(section.contentHash || '').slice(0, 16)} · 截断=${section.truncated ? '是' : '否'}${section.redacted ? ' · 已脱敏' : ''}`;

    const policy = document.createElement('p');
    policy.className = 'agent-context-policy-note';
    policy.textContent = section.policyNote || '';

    const body = document.createElement('pre');
    body.className = 'agent-context-section-content';
    body.textContent = section.displayContent || section.contentPreview || '[empty]';

    details.append(summary, meta, policy, body);
    dom.agentContextSectionList.appendChild(details);
  }
}

async function openAgentContextInspector(conversationId, message) {
  state.contextInspector.open = true;
  state.contextInspector.loading = true;
  state.contextInspector.errorMessage = '';
  state.contextInspector.conversationId = conversationId;
  state.contextInspector.messageId = message && message.id ? message.id : '';
  state.contextInspector.snapshot = null;
  setAgentContextDrawerOpen(true);

  try {
    const result = await fetchJson(messageContextSnapshotUrl(conversationId, message.id));
    state.contextInspector.snapshot = result && result.snapshot ? result.snapshot : null;
    if (!state.contextInspector.snapshot) {
      state.contextInspector.errorMessage = '这条消息没有可展示的上下文快照';
    }
  } catch (error) {
    state.contextInspector.errorMessage = error && error.message ? error.message : '上下文快照加载失败';
  } finally {
    state.contextInspector.loading = false;
    renderAgentContextInspector();
  }
}

async function exportAgentContextSnapshot() {
  const inspector = state.contextInspector;
  if (!inspector.conversationId || !inspector.messageId || !inspector.snapshot) {
    showToast('暂无可导出的上下文快照');
    return;
  }

  const response = await fetch(messageContextSnapshotUrl(inspector.conversationId, inspector.messageId, true), {
    headers: { Accept: 'text/markdown' },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `导出失败，状态码 ${response.status}`);
  }

  const blob = await response.blob();
  const fileName = downloadFileNameFromResponse(response, `agent-context-${inspector.messageId}.md`);
  const objectUrl = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 0);
}

function isActiveLiveStage(stage) {
  return Boolean(stage && (stage.status === 'queued' || stage.status === 'running' || stage.status === 'terminating'));
}

function isFinalizingStageWithContent(stage) {
  return Boolean(stage && stage.status === 'completed' && typeof stage.finalContent === 'string' && stage.finalContent);
}

function liveStageForMessage(conversationId, activeTurn, activeAgentSlots, messageId) {
  if (!messageId) {
    return null;
  }

  if (activeTurn && Array.isArray(activeTurn.agents)) {
    const activeTurnStage = activeTurn.agents.find(
      (agent) => agent.messageId === messageId && (isActiveLiveStage(agent) || isFinalizingStageWithContent(agent))
    ) || null;

    if (activeTurnStage) {
      return activeTurnStage;
    }
  }

  const slotStages = Array.isArray(activeAgentSlots)
    ? activeAgentSlots
    : conversationId
      ? activeAgentSlotsForConversation(conversationId)
      : [];

  return slotStages.find(
    (slot) => slot && slot.assistantMessageId === messageId && (isActiveLiveStage(slot) || isFinalizingStageWithContent(slot))
  ) || null;
}

function liveStageLabel(stage) {
  if (!stage) {
    return '';
  }

  const currentToolName = stage.currentToolName ? String(stage.currentToolName).trim() : '';
  const currentToolLabel = currentToolName
    ? `调用 ${currentToolName}${stage.currentToolInferred ? '（推断）' : ''}`
    : '';

  if (stage.status === 'queued') {
    return currentToolLabel || '思考中';
  }

  if (stage.status === 'running') {
    if (currentToolLabel && !stage.preview) {
      return currentToolLabel;
    }

    if (!stage.preview) {
      return '思考中';
    }

    if (stage.lastTextDeltaAt) {
      const lastTextDeltaMs = new Date(stage.lastTextDeltaAt).getTime();

      if (!Number.isNaN(lastTextDeltaMs) && Date.now() - lastTextDeltaMs >= LIVE_DRAFT_IDLE_MS) {
        return '收尾中';
      }
    }

    return '实时生成中';
  }

  if (stage.status === 'terminating') {
    return currentToolLabel || '收尾中';
  }

  return '';
}

function hasMeaningfulMessageContent(message) {
  const content = normalizeEscapedMessageText(message && message.content ? message.content : '').trim();

  return Boolean(content && content !== 'Thinking...');
}

function displayedMessageBody(message, stage) {
  if (isFinalizingStageWithContent(stage)) {
    return normalizeEscapedMessageText(stage.finalContent);
  }

  if (!stage || message.status === 'completed' || message.status === 'failed') {
    return messageDisplayText(message);
  }

  if (hasMeaningfulMessageContent(message)) {
    return messageDisplayText(message);
  }

  if (stage.preview) {
    return stage.preview;
  }

  if (stage.status === 'terminating') {
    return '正在整理回复...';
  }

  return messageDisplayText(message);
}

function resetAgentForm() {
  dom.agentId.value = '';
  dom.agentName.value = '';
  dom.agentDescription.value = '';
  dom.agentAvatarData.value = '';
  dom.agentAvatarFile.value = '';
  dom.agentPersonaPrompt.value = '';
  dom.agentProvider.value = '';
  fillModelSelect(dom.agentModel);
  dom.agentThinking.value = '';
  dom.agentAccentColor.value = '#3d405b';
  renderAvatarPreview(dom.agentAvatarPreview, '', '', '#3d405b');
}

function fillAgentForm(agent) {
  dom.agentId.value = agent.id;
  dom.agentName.value = agent.name;
  dom.agentDescription.value = agent.description || '';
  dom.agentAvatarData.value = agent.avatarDataUrl || '';
  dom.agentAvatarFile.value = '';
  dom.agentPersonaPrompt.value = agent.personaPrompt || '';
  dom.agentProvider.value = agent.provider || '';
  fillModelSelect(dom.agentModel, agent.provider || '', agent.model || '');
  dom.agentThinking.value = agent.thinking || '';
  dom.agentAccentColor.value = agent.accentColor || '#3d405b';
  renderAvatarPreview(dom.agentAvatarPreview, agent.avatarDataUrl || '', agent.name, agent.accentColor || '#3d405b');
}

function renderAgentStudio() {
  ensureSelectedAgent();
  dom.agentList.innerHTML = '';

  if (state.agents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '还没有 Agent，先创建一个。';
    dom.agentList.appendChild(empty);
  } else {
    state.agents.forEach((agent) => {
      const item = document.createElement('div');
      item.className = 'agent-list-item';
      item.dataset.id = agent.id;

      if (agent.id === state.selectedAgentId) {
        item.classList.add('active');
      }

      const nameWrap = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = agent.name;
      const description = document.createElement('div');
      description.className = 'muted';
      description.textContent = `${agent.description || '未填写角色说明'} · ${Array.isArray(agent.modelProfiles) ? agent.modelProfiles.length : 0} 套模型人格`;
      nameWrap.append(name, description);

      const avatar = buildAgentAvatarElement(agent, 'small');

      item.append(nameWrap, avatar);
      dom.agentList.appendChild(item);
    });
  }

  const selectedAgent = getSelectedAgent();

  if (selectedAgent) {
    fillAgentForm(selectedAgent);
  } else {
    resetAgentForm();
  }

  dom.deleteAgentButton.disabled = !selectedAgent || state.sending;
}

function renderAll() {
  renderRuntime();
  renderConversationList();
  renderConversationPane();
  renderUndercoverGameCard();
  renderWerewolfGameCard();
  renderCompactConversationPersonaSettings();
}

async function loadConversation(conversationId) {
  clearAllMessageToolTraceTimers();

  if (!conversationId) {
    messageHistory.reset(state.messageHistory, '');
    state.currentConversation = null;
    closeMentionMenu();
    renderAll();
    return;
  }

  const normalizedConversationId = String(conversationId).trim();
  const generation = messageHistory.reset(state.messageHistory, normalizedConversationId);
  const request = { conversationId: normalizedConversationId, generation };
  const encodedConversationId = encodeURIComponent(normalizedConversationId);
  const [data, page] = await Promise.all([
    fetchJson(`/api/conversations/${encodedConversationId}?includePrivateMessages=1`),
    fetchJson(`/api/conversations/${encodedConversationId}/messages`),
  ]);

  if (!messageHistory.isRequestCurrent(state.messageHistory, request)) {
    return;
  }

  const messages = messageHistory.applyInitialPage(state.messageHistory, page);
  state.selectedConversationId = normalizedConversationId;
  state.currentConversation = {
    ...data.conversation,
    messages,
  };
  pruneOptimisticMessagesForConversation(normalizedConversationId, messages);
  closeMentionMenu();
  renderAll();
  warmConversationToolTraces(state.currentConversation);
  syncToolTraceStatesWithConversation(state.currentConversation);
  scrollMessageListToBottom();
}

async function loadEarlierMessages() {
  const request = messageHistory.beginOlderRequest(state.messageHistory);

  if (!request || !state.currentConversation || state.currentConversation.id !== request.conversationId) {
    return;
  }

  const scrollAnchor = messageHistory.captureScrollAnchor(dom.messageList);
  renderConversationPane();

  try {
    const page = await fetchJson(
      `/api/conversations/${encodeURIComponent(request.conversationId)}/messages?limit=50&before=${encodeURIComponent(request.before)}`
    );

    if (
      !messageHistory.isRequestCurrent(state.messageHistory, request) ||
      !state.currentConversation ||
      state.currentConversation.id !== request.conversationId
    ) {
      return;
    }

    state.currentConversation = {
      ...state.currentConversation,
      messages: messageHistory.applyOlderPage(
        state.messageHistory,
        state.currentConversation.messages,
        page
      ),
    };
    renderConversationPane();
    warmConversationToolTraces(state.currentConversation);
    syncToolTraceStatesWithConversation(state.currentConversation);
    messageHistory.restoreScrollAnchor(dom.messageList, scrollAnchor);
  } catch (error) {
    if (messageHistory.isRequestCurrent(state.messageHistory, request)) {
      messageHistory.failOlderRequest(state.messageHistory, error);
      renderConversationPane();
      showToast(error && error.message ? error.message : '更早的消息加载失败');
    }
  }
}

function populateModeSelect() {
  const select = dom.newConversationType;
  if (!select) return;

  const currentValue = select.value;
  select.innerHTML = '';

  for (const mode of state.modes) {
    const option = document.createElement('option');
    option.value = mode.id;
    option.textContent = mode.name;
    select.appendChild(option);
  }

  // Restore previous selection if still valid
  if (currentValue && state.modes.some((m) => m.id === currentValue)) {
    select.value = currentValue;
  } else if (state.modes.length > 0) {
    select.value = state.modes[0].id;
  }
}

async function refreshAll(preferredConversationId) {
  const data = await fetchJson('/api/bootstrap');
  state.runtime = data.runtime;
  state.modelOptions = Array.isArray(data.modelOptions) ? data.modelOptions : [];
  state.skills = Array.isArray(data.skills) ? data.skills : [];
  state.modes = Array.isArray(data.modes) ? data.modes : [];
  state.agents = data.agents;
  state.conversations = data.conversations;
  await refreshKnownFeishuChats({ render: false });

  populateModeSelect();

  const desiredConversationId =
    preferredConversationId && state.conversations.some((item) => item.id === preferredConversationId)
      ? preferredConversationId
      : data.selectedConversationId;

  state.selectedConversationId = desiredConversationId || (state.conversations[0] ? state.conversations[0].id : null);
  renderAll();

  if (state.selectedConversationId) {
    await loadConversation(state.selectedConversationId);
  }
}

function mergeConversationSummary(summary) {
  if (!summary || !summary.id) {
    return;
  }

  const index = state.conversations.findIndex((item) => item.id === summary.id);

  if (index === -1) {
    state.conversations.unshift(summary);
  } else {
    state.conversations[index] = {
      ...state.conversations[index],
      ...summary,
    };
  }

  if (state.currentConversation && state.currentConversation.id === summary.id) {
    state.currentConversation = {
      ...state.currentConversation,
      ...summary,
    };
  }
}

async function refreshConversationFromEvent(conversationId) {
  if (
    !conversationId ||
    state.selectedConversationId !== conversationId ||
    state.messageHistory.conversationId !== conversationId
  ) {
    return;
  }

  const shouldStickToBottom = isMessageListNearBottom();
  const request = messageHistory.beginLatestRequest(state.messageHistory);

  try {
    const encodedConversationId = encodeURIComponent(conversationId);
    const [data, page] = await Promise.all([
      fetchJson(`/api/conversations/${encodedConversationId}?includePrivateMessages=1`),
      fetchJson(`/api/conversations/${encodedConversationId}/messages`),
    ]);

    if (
      state.selectedConversationId !== conversationId ||
      !messageHistory.isLatestRequestCurrent(state.messageHistory, request) ||
      !state.currentConversation ||
      state.currentConversation.id !== conversationId
    ) {
      return;
    }

    state.currentConversation = {
      ...state.currentConversation,
      ...data.conversation,
      messages: messageHistory.applyLatestPage(
        state.messageHistory,
        state.currentConversation.messages,
        page
      ),
    };
    pruneOptimisticMessagesForConversation(conversationId, page && page.items);
    renderConversationPane();
    renderUndercoverGameCard();
    warmConversationToolTraces(state.currentConversation);
    syncToolTraceStatesWithConversation(state.currentConversation);

    if (shouldStickToBottom) {
      scrollMessageListToBottom();
    }
  } catch {}
}

function scheduleConversationRefresh(conversationId) {
  if (!conversationId || state.selectedConversationId !== conversationId) {
    return;
  }

  pendingConversationRefreshId = conversationId;

  if (pendingConversationRefreshTimer) {
    return;
  }

  pendingConversationRefreshTimer = window.setTimeout(async () => {
    const nextConversationId = pendingConversationRefreshId;
    pendingConversationRefreshId = null;
    pendingConversationRefreshTimer = null;
    await refreshConversationFromEvent(nextConversationId);
  }, 40);
}

function connectEventStream() {
  if (typeof EventSource === 'undefined') {
    return;
  }

  if (state.eventSource) {
    if (state.eventSource.readyState === EventSource.CLOSED) {
      try {
        state.eventSource.close();
      } catch {}

      state.eventSource = null;
    } else {
      return;
    }
  }

  if (state.eventSource) {
    return;
  }

  const source = new EventSource('/api/events');
  state.eventSource = source;

  source.addEventListener('runtime_state', (event) => {
    const payload = JSON.parse(event.data);
    state.runtime = payload;

    if (state.stopRequestConversationIds.size > 0) {
      for (const conversationId of Array.from(state.stopRequestConversationIds)) {
        const turn =
          Array.isArray(payload.activeTurns) && conversationId
            ? payload.activeTurns.find((item) => item.conversationId === conversationId) || null
            : null;
        const agentSlots =
          Array.isArray(payload.activeAgentSlots) && conversationId
            ? payload.activeAgentSlots.filter((item) => item && item.conversationId === conversationId)
            : [];
        const anyStopRequested = Boolean(turn && turn.stopRequested) || agentSlots.some((slot) => slot.stopRequested);

        if ((!turn && agentSlots.length === 0) || anyStopRequested) {
          state.stopRequestConversationIds.delete(conversationId);
        }
      }
    }

    renderRuntime();
    renderConversationList();
    renderConversationPane();
  });

  source.addEventListener('conversation_summary_updated', (event) => {
    const payload = JSON.parse(event.data);
    mergeConversationSummary(payload.summary);
    renderConversationList();
  });

  source.addEventListener('conversation_message_created', (event) => {
    const payload = JSON.parse(event.data);
    scheduleConversationRefresh(payload.conversationId);
  });

  source.addEventListener('conversation_message_updated', (event) => {
    const payload = JSON.parse(event.data);
    scheduleConversationRefresh(payload.conversationId);
  });

  source.addEventListener('conversation_private_message_created', (event) => {
    const payload = JSON.parse(event.data);
    scheduleConversationRefresh(payload.conversationId);
  });

  source.addEventListener('conversation_goal_updated', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.summary) {
      mergeConversationSummary(payload.summary);
    }
    scheduleConversationRefresh(payload.conversationId);
  });

  source.addEventListener('conversation_goal_cleared', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.summary) {
      mergeConversationSummary(payload.summary);
    }
    scheduleConversationRefresh(payload.conversationId);
  });

  source.addEventListener('conversation_goal_proposal_updated', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.summary) {
      mergeConversationSummary(payload.summary);
    }
    scheduleConversationRefresh(payload.conversationId);
  });

  source.addEventListener('conversation_goal_proposal_cleared', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.summary) {
      mergeConversationSummary(payload.summary);
    }
    scheduleConversationRefresh(payload.conversationId);
  });

  source.addEventListener('conversation_digest_status', (event) => {
    const payload = JSON.parse(event.data);
    applyConversationDigestStatus(payload);
  });

  source.addEventListener('conversation_digest_updated', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.conversationId) {
      state.digestStatusByConversation.delete(payload.conversationId);
    }
    if (payload.summary) {
      mergeConversationSummary(payload.summary);
    }
    scheduleConversationRefresh(payload.conversationId);
  });

  source.addEventListener('conversation_digest_deleted', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.summary) {
      mergeConversationSummary(payload.summary);
    }
    scheduleConversationRefresh(payload.conversationId);
  });

  source.addEventListener('conversation_skill_draft_updated', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.summary) {
      mergeConversationSummary(payload.summary);
    }
    scheduleConversationRefresh(payload.conversationId);
  });

  source.addEventListener('conversation_tool_event', (event) => {
    const payload = JSON.parse(event.data);
    applyConversationToolEvent(payload);
  });

  source.addEventListener('turn_progress', (event) => {
    const payload = JSON.parse(event.data);

    if (!state.runtime) {
      state.runtime = {};
    }

    const activeTurns = Array.isArray(state.runtime.activeTurns) ? state.runtime.activeTurns.slice() : [];
    const index = activeTurns.findIndex((turn) => turn.conversationId === payload.conversationId);

    const existingTurn = index === -1 ? null : activeTurns[index];
    const hasChanged = turnProgressSignature(existingTurn) !== turnProgressSignature(payload.turn);

    if (payload.turn && payload.turn.stopRequested) {
      state.stopRequestConversationIds.delete(payload.conversationId);
    }

    if (hasChanged) {
      syncToolTraceStatesFromTurnProgress(existingTurn, payload.turn);

      if (index === -1) {
        activeTurns.push(payload.turn);
      } else {
        activeTurns[index] = payload.turn;
      }

      state.runtime.activeTurns = activeTurns;

      if (state.selectedConversationId === payload.conversationId) {
        scheduleConversationPaneRender();
      }

      if (!existingTurn || existingTurn.currentAgentId !== payload.turn.currentAgentId || existingTurn.status !== payload.turn.status) {
        renderConversationList();
        renderRuntime();
      }
    }
  });

  source.addEventListener('turn_finished', (event) => {
    const payload = JSON.parse(event.data);
    state.stopRequestConversationIds.delete(payload.conversationId);

    const existingTurn =
      state.runtime && Array.isArray(state.runtime.activeTurns)
        ? state.runtime.activeTurns.find((turn) => turn.conversationId === payload.conversationId) || null
        : null;

    syncToolTraceStatesFromTurnProgress(existingTurn, payload.turn || null);

    if (state.runtime && Array.isArray(state.runtime.activeTurns)) {
      state.runtime.activeTurns = state.runtime.activeTurns.filter((turn) => turn.conversationId !== payload.conversationId);
    }

    if (state.currentConversation && state.currentConversation.id === payload.conversationId) {
      syncToolTraceStatesWithConversation(state.currentConversation);
    }

    renderConversationPane();
    renderConversationList();
    renderRuntime();
    void refreshConversationFromEvent(payload.conversationId);
  });

  source.addEventListener('agent_slot_progress', (event) => {
    const payload = JSON.parse(event.data);

    if (!state.runtime) {
      state.runtime = {};
    }

    const existingSlot =
      state.runtime && Array.isArray(state.runtime.activeAgentSlots)
        ? state.runtime.activeAgentSlots.find((slot) => slot && slot.slotId === payload.slot.slotId) || null
        : null;
    const hasChanged = agentSlotProgressSignature(existingSlot) !== agentSlotProgressSignature(payload.slot);

    if (payload.slot && payload.slot.stopRequested) {
      state.stopRequestConversationIds.delete(payload.conversationId);
    }

    if (hasChanged) {
      syncToolTraceStatesFromAgentSlotProgress(existingSlot, payload.slot);
      upsertActiveAgentSlot(payload.slot);

      if (state.selectedConversationId === payload.conversationId) {
        scheduleConversationPaneRender();
      }

      if (!existingSlot || existingSlot.status !== payload.slot.status) {
        renderConversationList();
        renderRuntime();
      }
    }
  });

  source.addEventListener('agent_slot_finished', (event) => {
    const payload = JSON.parse(event.data);
    const existingSlot =
      state.runtime && Array.isArray(state.runtime.activeAgentSlots)
        ? state.runtime.activeAgentSlots.find((slot) => slot && slot.slotId === payload.slot.slotId) || null
        : null;

    syncToolTraceStatesFromAgentSlotProgress(existingSlot, payload.slot || null);
    removeActiveAgentSlot(payload.slot && payload.slot.slotId ? payload.slot.slotId : '');

    if (state.currentConversation && state.currentConversation.id === payload.conversationId) {
      syncToolTraceStatesWithConversation(state.currentConversation);
    }

    renderConversationPane();
    renderConversationList();
    renderRuntime();
    void refreshConversationFromEvent(payload.conversationId);
  });

  source.addEventListener('error', () => {
    if (state.eventSource !== source) {
      return;
    }

    if (source.readyState === EventSource.OPEN) {
      return;
    }

    try {
      source.close();
    } catch {}

    state.eventSource = null;
    window.setTimeout(() => {
      if (!state.eventSource) {
        connectEventStream();
      }
    }, 1500);
  });
}

function serializeAgentForm() {
  const existingAgent = dom.agentId.value.trim() ? agentById(dom.agentId.value.trim()) : null;
  const modelOption = selectedModelOption(dom.agentModel);

  return {
    id: dom.agentId.value.trim(),
    name: dom.agentName.value.trim(),
    description: dom.agentDescription.value.trim(),
    avatarDataUrl: dom.agentAvatarData.value.trim(),
    personaPrompt: dom.agentPersonaPrompt.value.trim(),
    provider: modelOption ? modelOption.provider || '' : dom.agentProvider.value.trim(),
    model: modelOption ? modelOption.model || '' : '',
    thinking: dom.agentThinking.value.trim(),
    accentColor: dom.agentAccentColor.value,
    modelProfiles: existingAgent && Array.isArray(existingAgent.modelProfiles) ? existingAgent.modelProfiles : [],
  };
}

function bindEvents() {
  async function handleUndercoverAction(action, body, successMessage) {
    if (!state.currentConversation || !isUndercoverConversation(state.currentConversation) || state.sending) {
      return;
    }

    state.sending = true;
    state.runtime = state.runtime || {};
    state.runtime.activeConversationIds = Array.from(
      new Set([...(state.runtime.activeConversationIds || []), state.currentConversation.id])
    );
    renderAll();

    try {
      await triggerUndercoverAction(action, body);
      if (successMessage) {
        showToast(successMessage);
      }
    } catch (error) {
      showToast(error.message);
    } finally {
      state.sending = false;

      if (state.runtime && state.currentConversation) {
        state.runtime.activeConversationIds = (state.runtime.activeConversationIds || []).filter(
          (id) => id !== state.currentConversation.id
        );
      }

      renderAll();
    }
  }

  async function handleWerewolfAction(action, body, successMessage) {
    if (!state.currentConversation || !isWerewolfConversation(state.currentConversation) || state.sending) {
      return;
    }

    state.sending = true;
    state.runtime = state.runtime || {};
    state.runtime.activeConversationIds = Array.from(
      new Set([...(state.runtime.activeConversationIds || []), state.currentConversation.id])
    );
    renderAll();

    try {
      await triggerWerewolfAction(action, body);
      if (successMessage) {
        showToast(successMessage);
      }
    } catch (error) {
      showToast(error.message);
    } finally {
      state.sending = false;

      if (state.runtime && state.currentConversation) {
        state.runtime.activeConversationIds = (state.runtime.activeConversationIds || []).filter(
          (id) => id !== state.currentConversation.id
        );
      }

      renderAll();
    }
  }

  dom.refreshButton.addEventListener('click', async () => {
    try {
      await refreshAll(state.selectedConversationId);
      showToast('已刷新本地状态');
    } catch (error) {
      showToast(error.message);
    }
  });

  dom.newConversationForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    try {
      const conversationType = dom.newConversationType ? dom.newConversationType.value : 'standard';
      const body = {
        title: dom.newConversationTitle.value.trim(),
        type: conversationType,
      };

      const result = await fetchJson('/api/conversations', {
        method: 'POST',
        body,
      });
      dom.newConversationTitle.value = '';
      if (dom.newConversationType) {
        dom.newConversationType.value = 'standard';
      }
      state.conversations = result.conversations;
      state.selectedConversationId = result.conversation.id;
      messageHistory.reset(state.messageHistory, result.conversation.id);
      state.currentConversation = {
        ...result.conversation,
        messages: messageHistory.applyInitialPage(state.messageHistory, {
          items: Array.isArray(result.conversation.messages) ? result.conversation.messages.slice(-50) : [],
          nextCursor: null,
          hasMore: false,
        }),
      };
      renderAll();
      syncToolTraceStatesWithConversation(state.currentConversation);
      showToast('新会话已创建');
    } catch (error) {
      showToast(error.message);
    }
  });

  if (
    dom.undercoverSetupForm &&
    dom.undercoverCivilianWord &&
    dom.undercoverUndercoverWord &&
    dom.undercoverUndercoverCount &&
    dom.undercoverBlankCount &&
    dom.undercoverBlankWord
  ) {
    dom.undercoverSetupForm.addEventListener('submit', async (event) => {
      event.preventDefault();

      await handleUndercoverAction(
        'start',
        {
          civilianWord: dom.undercoverCivilianWord.value.trim(),
          undercoverWord: dom.undercoverUndercoverWord.value.trim(),
          undercoverCount: dom.undercoverUndercoverCount.value,
          blankCount: dom.undercoverBlankCount.value,
          blankWord: dom.undercoverBlankWord.value.trim(),
        },
        '谁是卧底全自动新一局已开始'
      );
    });
  }

  if (dom.undercoverResetButton) {
    dom.undercoverResetButton.addEventListener('click', async () => {
      await handleUndercoverAction('reset', {}, '对局已重置');
    });
  }

  if (dom.werewolfSetupForm && dom.werewolfCount && dom.werewolfSeerCount && dom.werewolfWitchCount) {
    dom.werewolfSetupForm.addEventListener('submit', async (event) => {
      event.preventDefault();

      await handleWerewolfAction(
        'start',
        {
          werewolfCount: dom.werewolfCount.value,
          seerCount: dom.werewolfSeerCount.value,
          witchCount: dom.werewolfWitchCount.value,
        },
        '狼人杀全自动新一局已开始'
      );
    });
  }

  if (dom.werewolfResetButton) {
    dom.werewolfResetButton.addEventListener('click', async () => {
      await handleWerewolfAction('reset', {}, '对局已重置');
    });
  }

  if (dom.skillDraftAlertButton) {
    dom.skillDraftAlertButton.addEventListener('click', openSkillDraftPanel);
  }

  if (dom.agentContextCloseButton) {
    dom.agentContextCloseButton.addEventListener('click', () => setAgentContextDrawerOpen(false));
  }

  if (window.caffShell && typeof window.caffShell.onChange === 'function') {
    window.caffShell.onChange(({ open, tab }) => {
      const shouldBeOpen = open && tab === 'agent-context-drawer';
      if (state.contextInspector && Boolean(state.contextInspector.open) !== shouldBeOpen) {
        setAgentContextDrawerOpen(shouldBeOpen, { fromShell: true });
      }
    });
  }

  if (dom.agentContextExportButton) {
    dom.agentContextExportButton.addEventListener('click', async () => {
      const previousText = dom.agentContextExportButton.textContent;
      dom.agentContextExportButton.disabled = true;
      dom.agentContextExportButton.textContent = '导出中';
      try {
        await exportAgentContextSnapshot();
        showToast('上下文 Markdown 已导出');
      } catch (error) {
        showToast(error && error.message ? error.message : '导出失败');
      } finally {
        dom.agentContextExportButton.textContent = previousText;
        renderAgentContextInspector();
      }
    });
  }

  dom.conversationList.addEventListener('click', async (event) => {
    const item =
      event.target instanceof Element ? /** @type {HTMLElement | null} */ (event.target.closest('.conversation-item')) : null;

    if (!item) {
      return;
    }

    try {
      await loadConversation(item.dataset.id);
    } catch (error) {
      showToast(error.message);
    }
  });

  dom.messageList.addEventListener('click', async (event) => {
    if (!state.currentConversation) {
      return;
    }

    const toolTraceToggle =
      event.target instanceof Element
        ? /** @type {HTMLButtonElement | null} */ (event.target.closest('.message-tool-trace-toggle'))
        : null;

    if (toolTraceToggle) {
      const messageId = toolTraceToggle.dataset.messageId || '';
      const message =
        state.currentConversation && Array.isArray(state.currentConversation.messages)
          ? state.currentConversation.messages.find((item) => item.id === messageId) || null
          : null;

      if (!message) {
        showToast('找不到工具链路对应的消息');
        return;
      }

      toggleMessageToolTrace(state.currentConversation.id, message);
      return;
    }

    const toolTraceCopyButton =
      event.target instanceof Element
        ? /** @type {HTMLButtonElement | null} */ (event.target.closest('.message-tool-trace-copy-button'))
        : null;

    if (toolTraceCopyButton) {
      const messageId = toolTraceCopyButton.dataset.messageId || '';
      const message =
        state.currentConversation && Array.isArray(state.currentConversation.messages)
          ? state.currentConversation.messages.find((item) => item.id === messageId) || null
          : null;

      if (!message) {
        showToast('找不到要复制的错误上下文');
        return;
      }

      const previousText = toolTraceCopyButton.textContent;
      toolTraceCopyButton.disabled = true;
      toolTraceCopyButton.textContent = '复制中';

      try {
        await copyMessageToolTraceErrorContext(message);
      } catch (error) {
        showToast(error && error.message ? error.message : '复制失败');
      } finally {
        toolTraceCopyButton.disabled = false;
        toolTraceCopyButton.textContent = previousText;
      }

      return;
    }

    const contextButton =
      event.target instanceof Element
        ? /** @type {HTMLButtonElement | null} */ (event.target.closest('.message-context-button'))
        : null;

    if (contextButton) {
      const messageId = contextButton.dataset.messageId || '';
      const message =
        state.currentConversation && Array.isArray(state.currentConversation.messages)
          ? state.currentConversation.messages.find((item) => item.id === messageId) || null
          : null;

      if (!message) {
        showToast('找不到要查看上下文的消息');
        return;
      }

      await openAgentContextInspector(state.currentConversation.id, message);
      return;
    }

    const exportButton =
      event.target instanceof Element
        ? /** @type {HTMLButtonElement | null} */ (event.target.closest('.message-export-button'))
        : null;

    if (!exportButton) {
      return;
    }

    const messageId = exportButton.dataset.messageId || '';
    const message =
      state.currentConversation && Array.isArray(state.currentConversation.messages)
        ? state.currentConversation.messages.find((item) => item.id === messageId) || null
        : null;

    if (!message) {
      showToast('找不到要导出的消息');
      return;
    }

    const sessionInfo = messageSessionInfo(message);

    if (!sessionInfo.canExport) {
      showToast('这条消息的会话轨迹还没准备好');
      return;
    }

    const previousText = exportButton.textContent;
    exportButton.disabled = true;
    exportButton.textContent = '导出中';

    try {
      await exportMessageSession(state.currentConversation.id, message);
      showToast('会话轨迹已导出');
    } catch (error) {
      showToast(error.message);
    } finally {
      exportButton.disabled = !messageSessionInfo(message).canExport;
      exportButton.textContent = previousText;
    }
  });

  if (dom.messageHistoryButton) {
    dom.messageHistoryButton.addEventListener('click', () => {
      void loadEarlierMessages();
    });
  }

  dom.composerForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!state.currentConversation) {
      return;
    }

    const conversationId = state.currentConversation.id;
    const content = dom.composerInput.value.trim();

    if (!content) {
      showToast('请输入消息内容');
      return;
    }

    const goalCommand = parseGoalCommand(content);
    if (goalCommand) {
      try {
        await submitGoalCommand(conversationId, goalCommand);
        setComposerValue('');
        closeMentionMenu();
      } catch (error) {
        showToast(error.message);
        renderConversationPane();
      }
      return;
    }

    const digestCommand = parseDigestCommand(content);
    if (digestCommand) {
      try {
        await submitDigestCommand(conversationId, digestCommand);
        setComposerValue('');
        closeMentionMenu();
      } catch (error) {
        showToast(error.message);
        renderConversationPane();
      }
      return;
    }

    const summaryMemoryCommand = parseSummaryMemoryCommand(content);
    if (summaryMemoryCommand) {
      try {
        await submitSummaryMemoryCommand(summaryMemoryCommand);
        setComposerValue('');
        closeMentionMenu();
      } catch (error) {
        showToast(error.message);
        renderConversationPane();
      }
      return;
    }

    const clientRequestId = createClientRequestId();
    const shouldStickToBottom = isMessageListNearBottom();
    setComposerValue('');
    closeMentionMenu();
    applyOptimisticUserMessage(conversationId, content, clientRequestId);
    renderConversationPane();

    if (shouldStickToBottom) {
      scrollMessageListToBottom();
    }

    try {
      const result = await fetchJson(`/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: { content, clientRequestId },
      });

      clearOptimisticUserMessage(conversationId, clientRequestId);

      if (result.runtime) {
        mergeRuntimePayload(result.runtime);
      }

      if (state.selectedConversationId === conversationId) {
        mergeConversationFromSendResponse(conversationId, result.conversation, result.acceptedMessage);

        if (state.currentConversation) {
          warmConversationToolTraces(state.currentConversation);
          syncToolTraceStatesWithConversation(state.currentConversation);
        }
      }

      if (result.conversation && result.conversation.id) {
        mergeConversationSummary({
          id: result.conversation.id,
          title: result.conversation.title,
          type: result.conversation.type,
          metadata: result.conversation.metadata,
          createdAt: result.conversation.createdAt,
          updatedAt: result.conversation.updatedAt,
          lastMessageAt: result.conversation.lastMessageAt,
          messageCount: result.conversation.messageCount,
          agentCount: result.conversation.agentCount,
          lastMessagePreview: result.conversation.lastMessagePreview,
        });
      }

      renderAll();

      if (state.selectedConversationId === conversationId && shouldStickToBottom) {
        scrollMessageListToBottom();
      }
    } catch (error) {
      clearOptimisticUserMessage(conversationId, clientRequestId);

      if (state.selectedConversationId === conversationId && !dom.composerInput.value.trim()) {
        setComposerValue(content);
      }

      showToast(error.message);
      renderConversationPane();
    }
  });

  dom.stopButton.addEventListener('click', async () => {
    if (!state.currentConversation) {
      return;
    }

    const conversationId = state.currentConversation.id;

    if (state.stopRequestConversationIds.has(conversationId)) {
      return;
    }

    state.stopRequestConversationIds.add(conversationId);
    renderConversationPane();

    try {
      const result = await fetchJson(`/api/conversations/${conversationId}/stop`, {
        method: 'POST',
      });

      if (result.runtime) {
        state.runtime = {
          ...(state.runtime || {}),
          ...result.runtime,
        };
      }

      if (result.turn) {
        upsertRuntimeTurn(result.turn);
      }

      if (Array.isArray(result.agentSlots)) {
        result.agentSlots.forEach((slot) => upsertActiveAgentSlot(slot));
      }

      showToast('正在停止当前会话中的活跃执行...');
    } catch (error) {
      showToast(error.message);
    } finally {
      state.stopRequestConversationIds.delete(conversationId);
      renderRuntime();
      renderConversationList();
      renderConversationPane();
    }
  });

  dom.conversationSettingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!state.currentConversation) {
      return;
    }

    const participants = selectedConversationParticipants();

    if (participants.length === 0) {
      showToast('至少选择一个 Agent');
      return;
    }

    try {
      const result = await fetchJson(`/api/conversations/${state.currentConversation.id}`, {
        method: 'PUT',
        body: {
          title: state.currentConversation.title,
          participants,
        },
      });
      state.currentConversation = result.conversation;
      state.conversations = result.conversations;
      renderAll();
      syncToolTraceStatesWithConversation(state.currentConversation);
      showToast('会话设置已保存');
    } catch (error) {
      showToast(error.message);
    }
  });

  if (dom.feishuChatSelect) {
    dom.feishuChatSelect.addEventListener('change', () => {
      const chatId = dom.feishuChatSelect ? dom.feishuChatSelect.value.trim() : '';
      if (chatId && dom.feishuChatIdInput) {
        dom.feishuChatIdInput.value = chatId;
      }
    });
  }

  if (dom.bindFeishuChatButton) {
    dom.bindFeishuChatButton.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();

      if (!state.currentConversation) {
        showToast('请先选择一个会话');
        return;
      }

      const conversationId = state.currentConversation.id;
      const chatId = dom.feishuChatIdInput ? dom.feishuChatIdInput.value.trim() : '';

      if (!chatId) {
        showToast('请输入飞书 chat_id');
        return;
      }

      if (
        isConversationBusy(conversationId) ||
        queuedUserMessageCountForConversation(conversationId) > 0 ||
        queuedAgentSlotMessageCountForConversation(conversationId) > 0
      ) {
        showToast('当前房间正在处理或仍有待处理消息，请稍后再绑定飞书');
        return;
      }

      state.bindingFeishuChat = true;
      conversationSettingsController.render();

      try {
        const result = await fetchJson(
          `/api/conversations/${encodeURIComponent(conversationId)}/channel-bindings/feishu`,
          {
            method: 'PUT',
            body: { chatId },
          }
        );
        await refreshKnownFeishuChats({ render: false });
        const movedText = result && result.moved && result.previousConversationId
          ? `，已从 ${result.previousConversationId} 移动过来`
          : '';
        setFeishuBindingNotice(conversationId, `已绑定飞书 chat_id：${chatId}${movedText}`);
        showToast('飞书会话已绑定到当前会话');
      } catch (error) {
        setFeishuBindingNotice(conversationId, error.message);
        showToast(error.message);
      } finally {
        state.bindingFeishuChat = false;
        conversationSettingsController.render();
      }
    });
  }

  dom.deleteConversationButton.addEventListener('click', async () => {
    if (!state.currentConversation) {
      return;
    }

    const conversationId = state.currentConversation.id;
    const conversationTitle = state.currentConversation.title;

    if (!window.confirm(`确定删除对话“${conversationTitle}”吗？`)) {
      return;
    }

    const activeTurn = activeTurnForConversation(conversationId);
    const activeAgentSlots = activeAgentSlotsForConversation(conversationId);
    const queuedUserCount = queuedUserMessageCountForConversation(conversationId);
    const queuedAgentSlotCount = queuedAgentSlotMessageCountForConversation(conversationId);
    const queueFailure = queueFailureForConversation(conversationId);
    const conversationBusy = isConversationBusy(conversationId);

    if (state.stopRequestConversationIds.has(conversationId)) {
      showToast('正在停止当前会话中的活跃执行，请稍后再试');
      return;
    }

    if (conversationBusy || activeTurn || activeAgentSlots.length > 0) {
      showToast('当前房间正在处理消息，请先停止并等待处理完成后再删除');
      return;
    }

    if (queuedAgentSlotCount > 0) {
      showToast('当前房间仍有按 Agent 排队的待处理消息，请等待执行完成后再删除');
      return;
    }

    let deleteUrl = `/api/conversations/${conversationId}`;

    if (queuedUserCount > 0) {
      if (!queueFailure) {
        showToast('当前房间仍有待处理消息，请等待自动续跑完成后再删除');
        return;
      }

      if (
        !window.confirm(
          `这个对话里还有 ${queuedUserCount} 条失败后保留的待处理消息。强制删除会直接放弃这些消息，确定继续吗？`
        )
      ) {
        return;
      }

      deleteUrl = `${deleteUrl}?force=1`;
    }

    try {
      const result = await fetchJson(deleteUrl, {
        method: 'DELETE',
      });
      state.runtime = result.runtime;
      state.agents = result.agents;
      state.conversations = result.conversations;
      state.selectedConversationId = result.selectedConversationId;
      renderAll();

      if (state.selectedConversationId) {
        await loadConversation(state.selectedConversationId);
      }

      showToast('对话已删除');
    } catch (error) {
      showToast(error.message);
    }
  });

  if (
    dom.newAgentButton &&
    dom.agentModel &&
    dom.agentAvatarFile &&
    dom.clearAgentAvatarButton &&
    dom.agentName &&
    dom.agentAccentColor &&
    dom.agentList &&
    dom.agentForm &&
    dom.deleteAgentButton &&
    dom.agentAvatarPreview &&
    dom.agentAvatarData
  ) {
    dom.newAgentButton.addEventListener('click', () => {
    state.selectedAgentId = null;
    renderAgentStudio();
    dom.agentName.focus();
    });

  dom.agentModel.addEventListener('change', () => {
    syncProviderFromModelSelect(dom.agentModel, dom.agentProvider);
  });

  dom.agentAvatarFile.addEventListener('change', async () => {
    const [file] = Array.from(dom.agentAvatarFile.files || []);

    try {
      const dataUrl = await readAvatarFileAsDataUrl(file);
      dom.agentAvatarData.value = dataUrl;
      renderAvatarPreview(dom.agentAvatarPreview, dataUrl, dom.agentName.value.trim(), dom.agentAccentColor.value);
    } catch (error) {
      dom.agentAvatarFile.value = '';
      showToast(error.message);
    }
  });

  dom.clearAgentAvatarButton.addEventListener('click', () => {
    dom.agentAvatarFile.value = '';
    dom.agentAvatarData.value = '';
    renderAvatarPreview(dom.agentAvatarPreview, '', dom.agentName.value.trim(), dom.agentAccentColor.value);
  });

  dom.agentName.addEventListener('input', () => {
    renderAvatarPreview(
      dom.agentAvatarPreview,
      dom.agentAvatarData.value.trim(),
      dom.agentName.value.trim(),
      dom.agentAccentColor.value
    );
  });

  dom.agentAccentColor.addEventListener('input', () => {
    renderAvatarPreview(
      dom.agentAvatarPreview,
      dom.agentAvatarData.value.trim(),
      dom.agentName.value.trim(),
      dom.agentAccentColor.value
    );
  });

  dom.agentList.addEventListener('click', (event) => {
    const item = event.target instanceof Element ? /** @type {HTMLElement | null} */ (event.target.closest('.agent-list-item')) : null;

    if (!item || !item.dataset.id) {
      return;
    }

    state.selectedAgentId = item.dataset.id;
    renderAgentStudio();
  });

  dom.agentForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const payload = serializeAgentForm();

    if (!payload.name) {
      showToast('人格名称不能为空');
      return;
    }

    if (!payload.personaPrompt) {
      showToast('人格 Prompt 不能为空');
      return;
    }

    try {
      const result = await fetchJson(payload.id ? `/api/agents/${payload.id}` : '/api/agents', {
        method: payload.id ? 'PUT' : 'POST',
        body: payload,
      });
      state.selectedAgentId = result.agent.id;
      await refreshAll(state.selectedConversationId);
      state.selectedAgentId = result.agent.id;
      renderAll();
      showToast(payload.id ? '人格已更新' : '新人格已创建');
    } catch (error) {
      showToast(error.message);
    }
  });

  dom.deleteAgentButton.addEventListener('click', async () => {
    const selectedAgent = getSelectedAgent();

    if (!selectedAgent) {
      return;
    }

    if (!window.confirm(`确定删除 Agent “${selectedAgent.name}”吗？`)) {
      return;
    }

    try {
      await fetchJson(`/api/agents/${selectedAgent.id}`, {
        method: 'DELETE',
      });
      state.selectedAgentId = null;
      await refreshAll(state.selectedConversationId);
      showToast('Agent 已删除');
    } catch (error) {
      showToast(error.message);
    }
  });

  }
}

async function init() {
  setupChatModules();
  mentionMenuController.bindEvents();
  conversationSettingsController.bindEvents();
  sessionGoalPanelController.bindEvents();
  conversationDigestPanelController.bindEvents();
  summaryMemoryPanelController.bindEvents();
  bindEvents();
  connectEventStream();

  try {
    await refreshAll();
  } catch (error) {
    dom.runtimePill.textContent = '服务连接失败';
    showToast(error.message);
  }
}

init();
