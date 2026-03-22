const state = {
  runtime: null,
  modelOptions: [],
  agents: [],
  conversations: [],
  selectedConversationId: null,
  currentConversation: null,
  selectedAgentId: null,
  sending: false,
  toastTimer: null,
  eventSource: null,
  mentionSuggestions: [],
  mentionSelectionIndex: 0,
  activeMentionContext: null,
};

const MAX_AVATAR_FILE_SIZE = 1024 * 1024;

const dom = {
  runtimePill: document.getElementById('runtime-pill'),
  refreshButton: document.getElementById('refresh-button'),
  newConversationForm: document.getElementById('new-conversation-form'),
  newConversationTitle: document.getElementById('new-conversation-title'),
  conversationList: document.getElementById('conversation-list'),
  conversationTitleDisplay: document.getElementById('conversation-title-display'),
  conversationMeta: document.getElementById('conversation-meta'),
  deleteConversationButton: document.getElementById('delete-conversation-button'),
  participantList: document.getElementById('participant-list'),
  messageList: document.getElementById('message-list'),
  composerForm: document.getElementById('composer-form'),
  composerInput: document.getElementById('composer-input'),
  composerMentionMenu: document.getElementById('composer-mention-menu'),
  composerStatus: document.getElementById('composer-status'),
  sendButton: document.getElementById('send-button'),
  conversationSettingsForm: document.getElementById('conversation-settings-form'),
  conversationTitleInput: document.getElementById('conversation-title-input'),
  conversationAgentOptions: document.getElementById('conversation-agent-options'),
  saveConversationButton: document.getElementById('save-conversation-button'),
  newAgentButton: document.getElementById('new-agent-button'),
  agentList: document.getElementById('agent-list'),
  agentForm: document.getElementById('agent-form'),
  agentId: document.getElementById('agent-id'),
  agentName: document.getElementById('agent-name'),
  agentDescription: document.getElementById('agent-description'),
  agentAvatarPreview: document.getElementById('agent-avatar-preview'),
  agentAvatarFile: document.getElementById('agent-avatar-file'),
  agentAvatarData: document.getElementById('agent-avatar-data'),
  agentPersonaPrompt: document.getElementById('agent-persona-prompt'),
  agentProvider: document.getElementById('agent-provider'),
  agentModel: document.getElementById('agent-model'),
  agentThinking: document.getElementById('agent-thinking'),
  agentAccentColor: document.getElementById('agent-accent-color'),
  clearAgentAvatarButton: document.getElementById('clear-agent-avatar-button'),
  deleteAgentButton: document.getElementById('delete-agent-button'),
  toast: document.getElementById('toast'),
};

let pendingConversationRefreshId = null;
let pendingConversationRefreshTimer = null;
let conversationPaneRenderPending = false;
let liveDraftFinalizingTimer = null;
const LIVE_DRAFT_IDLE_MS = 1600;

async function fetchJson(url, options = {}) {
  const fetchOptions = {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  };
  const response = await fetch(url, fetchOptions);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(data.error || `Request failed with status ${response.status}`);
  }

  return data;
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

function defaultModelProfile(agent) {
  return {
    id: '',
    name: '默认配置',
    provider: agent && agent.provider ? agent.provider : '',
    model: agent && agent.model ? agent.model : '',
    thinking: agent && agent.thinking ? agent.thinking : '',
    personaPrompt: agent && agent.personaPrompt ? agent.personaPrompt : '',
  };
}

function modelProfilesForAgent(agent) {
  return [defaultModelProfile(agent), ...((agent && Array.isArray(agent.modelProfiles) ? agent.modelProfiles : []))];
}

function findModelProfileForAgent(agent, profileId) {
  return modelProfilesForAgent(agent).find((profile) => profile.id === String(profileId || '').trim()) || null;
}

function selectedModelProfileName(agent) {
  const profile = findModelProfileForAgent(agent, agent && agent.selectedModelProfileId ? agent.selectedModelProfileId : '');
  return profile ? profile.name : '默认配置';
}

function describeModelProfile(agent, profileId) {
  const profile = findModelProfileForAgent(agent, profileId);

  if (!profile) {
    return '默认配置';
  }

  const parts = [profile.name];

  if (profile.model) {
    parts.push(profile.model);
  }

  if (profile.provider) {
    parts.push(profile.provider);
  }

  return parts.join(' · ');
}

function modelOptionKey(provider, model) {
  return `${String(provider || '').trim()}\u001f${String(model || '').trim()}`;
}

function findModelOption(provider, model) {
  const key = modelOptionKey(provider, model);
  return state.modelOptions.find((option) => option.key === key) || null;
}

function buildModelOptionLabel(option) {
  if (!option) {
    return '系统默认模型';
  }

  const detail = option.sourceLabel ? ` · ${option.sourceLabel}` : '';
  return `${option.label}${detail}`;
}

function fillModelSelect(select, currentProvider = '', currentModel = '') {
  if (!select) {
    return;
  }

  const selectedKey = currentModel ? modelOptionKey(currentProvider, currentModel) : '';
  select.innerHTML = '';

  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = '系统默认模型';
  select.appendChild(defaultOption);

  state.modelOptions.forEach((option) => {
    const element = document.createElement('option');
    element.value = option.key;
    element.textContent = buildModelOptionLabel(option);
    select.appendChild(element);
  });

  if (selectedKey && !state.modelOptions.some((option) => option.key === selectedKey)) {
    const currentOption = document.createElement('option');
    currentOption.value = selectedKey;
    currentOption.textContent = currentProvider ? `${currentProvider} / ${currentModel}` : currentModel;
    select.appendChild(currentOption);
  }

  select.value = selectedKey;
}

function selectedModelOption(select) {
  if (!select || !select.value) {
    return null;
  }

  const existingOption = state.modelOptions.find((option) => option.key === select.value);

  if (existingOption) {
    return existingOption;
  }

  const [provider, model] = String(select.value).split('\u001f');

  if (!model) {
    return null;
  }

  return {
    key: select.value,
    provider: provider || '',
    model: model || '',
    label: provider ? `${provider} / ${model}` : model,
    sourceLabel: '',
  };
}

function syncProviderFromModelSelect(select, providerInput) {
  if (!providerInput) {
    return;
  }

  const option = selectedModelOption(select);
  providerInput.value = option ? option.provider || '' : '';
}

function avatarInitial(name) {
  const value = String(name || '').trim();
  return value ? value.slice(0, 1).toUpperCase() : 'A';
}

function buildAgentAvatarElement(agent, className = '') {
  const element = document.createElement('span');
  const classes = ['agent-avatar'];

  if (className) {
    classes.push(...String(className).split(/\s+/).filter(Boolean));
  }

  element.className = classes.join(' ');

  if (agent && agent.accentColor) {
    element.style.setProperty('--agent-color', agent.accentColor);
  }

  if (agent && agent.avatarDataUrl) {
    const image = document.createElement('img');
    image.src = agent.avatarDataUrl;
    image.alt = agent.name ? `${agent.name} avatar` : 'Agent avatar';
    element.appendChild(image);
    return element;
  }

  element.classList.add('avatar-fallback');
  element.textContent = avatarInitial(agent && agent.name ? agent.name : '');
  return element;
}

function renderAvatarPreview(container, dataUrl, name, accentColor = '#3d405b') {
  if (!container) {
    return;
  }

  container.className = 'agent-avatar large avatar-preview';
  container.style.setProperty('--agent-color', accentColor || '#3d405b');
  container.textContent = '';

  if (dataUrl) {
    const image = document.createElement('img');
    image.src = dataUrl;
    image.alt = name ? `${name} avatar preview` : 'Avatar preview';
    container.appendChild(image);
    return;
  }

  container.classList.add('avatar-fallback');
  container.textContent = avatarInitial(name);
}

function readAvatarFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      resolve('');
      return;
    }

    if (!/^image\/(?:png|jpeg|webp|gif)$/i.test(file.type)) {
      reject(new Error('头像仅支持 PNG、JPEG、WEBP 或 GIF'));
      return;
    }

    if (file.size > MAX_AVATAR_FILE_SIZE) {
      reject(new Error('头像文件不能超过 1MB'));
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      reject(new Error('头像读取失败，请重试'));
    };
    reader.readAsDataURL(file);
  });
}

function activeTurnForConversation(conversationId) {
  if (!state.runtime || !Array.isArray(state.runtime.activeTurns)) {
    return null;
  }

  return state.runtime.activeTurns.find((turn) => turn.conversationId === conversationId) || null;
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
    pendingAgentIds: Array.isArray(turn.pendingAgentIds) ? turn.pendingAgentIds : [],
    entryAgentIds: Array.isArray(turn.entryAgentIds) ? turn.entryAgentIds : [],
    terminationReason: turn.terminationReason || '',
    agents: Array.isArray(turn.agents)
      ? turn.agents.map((agent) => ({
          agentId: agent.agentId || null,
          status: agent.status || '',
          messageId: agent.messageId || null,
          replyLength: agent.replyLength || 0,
          preview: agent.preview || '',
          errorMessage: agent.errorMessage || '',
          hop: agent.hop || 0,
          lastTextDeltaAt: agent.lastTextDeltaAt || null,
        }))
      : [],
  });
}

function normalizeMentionValue(value) {
  return String(value || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/^[^\p{L}\p{N}_-]+/gu, '')
    .replace(/[^\p{L}\p{N}._-]+$/gu, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function agentMentionHandle(agent) {
  const name = String(agent && agent.name ? agent.name : '').trim();
  return `@${(name || String(agent && agent.id ? agent.id : '')).replace(/\s+/g, '')}`;
}

function agentMentionSearchKeys(agent) {
  const keys = new Set();
  const id = String(agent && agent.id ? agent.id : '').trim();
  const name = String(agent && agent.name ? agent.name : '').trim();

  if (id) {
    keys.add(id);

    if (id.startsWith('agent-') && id.length > 6) {
      keys.add(id.slice(6));
    }
  }

  if (name) {
    keys.add(name);
    keys.add(name.replace(/\s+/g, ''));
    keys.add(name.replace(/\s+/g, '-'));
    keys.add(name.replace(/\s+/g, '_'));
  }

  return Array.from(keys).map(normalizeMentionValue).filter(Boolean);
}

function findAgentByMentionToken(token, agents) {
  const normalizedToken = normalizeMentionValue(token);

  if (!normalizedToken) {
    return null;
  }

  return (
    (Array.isArray(agents) ? agents : []).find((agent) => agentMentionSearchKeys(agent).includes(normalizedToken)) || null
  );
}

function findComposerMentionContext(value, cursorIndex) {
  const safeCursor = typeof cursorIndex === 'number' ? cursorIndex : String(value || '').length;
  const prefix = String(value || '').slice(0, safeCursor);
  const atIndex = prefix.lastIndexOf('@');

  if (atIndex === -1) {
    return null;
  }

  const before = atIndex === 0 ? '' : prefix[atIndex - 1];

  if (before && /[\p{L}\p{N}_]/u.test(before)) {
    return null;
  }

  const query = prefix.slice(atIndex + 1);

  if (/\s/.test(query)) {
    return null;
  }

  return {
    start: atIndex,
    end: safeCursor,
    query,
  };
}

function mentionableAgents() {
  return state.currentConversation && Array.isArray(state.currentConversation.agents)
    ? state.currentConversation.agents
    : [];
}

function closeMentionMenu() {
  state.mentionSuggestions = [];
  state.mentionSelectionIndex = 0;
  state.activeMentionContext = null;

  if (dom.composerMentionMenu) {
    dom.composerMentionMenu.innerHTML = '';
    dom.composerMentionMenu.classList.add('hidden');
  }
}

function buildMentionSuggestions(query) {
  const normalizedQuery = normalizeMentionValue(query);

  return mentionableAgents().filter((agent) => {
    const keys = agentMentionSearchKeys(agent);

    if (!normalizedQuery) {
      return true;
    }

    return keys.some((key) => key.includes(normalizedQuery));
  });
}

function renderMentionMenu() {
  if (!dom.composerMentionMenu || state.mentionSuggestions.length === 0) {
    closeMentionMenu();
    return;
  }

  dom.composerMentionMenu.innerHTML = '';
  dom.composerMentionMenu.classList.remove('hidden');

  state.mentionSuggestions.forEach((agent, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `mention-option${index === state.mentionSelectionIndex ? ' active' : ''}`;
    button.dataset.index = String(index);

    const title = document.createElement('strong');
    title.textContent = agentMentionHandle(agent);

    const detail = document.createElement('span');
    detail.className = 'muted';
    detail.textContent = agent.description || agent.id;

    button.append(title, detail);
    dom.composerMentionMenu.appendChild(button);
  });
}

function syncComposerMentionMenu() {
  if (!dom.composerInput || dom.composerInput.disabled) {
    closeMentionMenu();
    return;
  }

  const context = findComposerMentionContext(dom.composerInput.value, dom.composerInput.selectionStart);

  if (!context) {
    closeMentionMenu();
    return;
  }

  const suggestions = buildMentionSuggestions(context.query);

  if (suggestions.length === 0) {
    closeMentionMenu();
    return;
  }

  state.activeMentionContext = context;
  state.mentionSuggestions = suggestions;
  state.mentionSelectionIndex = Math.min(state.mentionSelectionIndex, suggestions.length - 1);
  renderMentionMenu();
}

function applyMentionSuggestion(agent) {
  const context = state.activeMentionContext;

  if (!agent || !context) {
    closeMentionMenu();
    return;
  }

  const mentionText = `**${agentMentionHandle(agent)}** `;
  const currentValue = dom.composerInput.value;
  const nextValue = `${currentValue.slice(0, context.start)}${mentionText}${currentValue.slice(context.end)}`;
  const nextCursor = context.start + mentionText.length;

  dom.composerInput.value = nextValue;
  dom.composerInput.focus();
  dom.composerInput.setSelectionRange(nextCursor, nextCursor);
  closeMentionMenu();
}

function appendHighlightedMessageBody(container, text, agents) {
  const source = String(text || '');
  const mentionRegex = /\*\*@([^\s@()[\]{}<>*]+)\*\*/gu;
  let lastIndex = 0;
  let match;

  while ((match = mentionRegex.exec(source)) !== null) {
    const mentionText = `@${match[1]}`;

    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(source.slice(lastIndex, match.index)));
    }

    const agent = findAgentByMentionToken(mentionText.slice(1), agents);

    if (agent) {
      const chip = document.createElement('span');
      chip.className = 'mention-highlight';

      if (agent.accentColor) {
        chip.style.setProperty('--mention-color', agent.accentColor);
      }

      chip.textContent = mentionText;
      chip.title = agent.name || agent.id;
      container.appendChild(chip);
    } else {
      container.appendChild(document.createTextNode(mentionText));
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < source.length) {
    container.appendChild(document.createTextNode(source.slice(lastIndex)));
  }
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
  window.clearTimeout(state.toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.remove('hidden');
  state.toastTimer = window.setTimeout(() => {
    dom.toast.classList.add('hidden');
  }, 2600);
}

function scrollMessageListToBottom() {
  dom.messageList.scrollTop = dom.messageList.scrollHeight;
}

function isMessageListNearBottom() {
  const distanceFromBottom = dom.messageList.scrollHeight - dom.messageList.scrollTop - dom.messageList.clientHeight;
  return distanceFromBottom < 72;
}

function scheduleConversationPaneRender() {
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

  return runtimeBusyIds.includes(conversationId) || (state.sending && state.selectedConversationId === conversationId);
}

function renderRuntime() {
  if (!state.runtime) {
    dom.runtimePill.textContent = '正在连接本地服务...';
    return;
  }

  const busyCount = Array.isArray(state.runtime.activeConversationIds) ? state.runtime.activeConversationIds.length : 0;
  dom.runtimePill.textContent = `${state.runtime.host}:${state.runtime.port} · ${state.agents.length} Agent · ${busyCount} 个房间处理中`;
}

function renderConversationList() {
  const signature =
    state.conversations.length === 0
      ? 'empty'
      : state.conversations
          .map((conversation) =>
            [
              conversation.id,
              conversation.title,
              conversation.agentCount || 0,
              conversation.messageCount || 0,
              conversation.lastMessagePreview || '',
              conversation.lastMessageAt || '',
              conversation.id === state.selectedConversationId ? 'selected' : '',
              isConversationBusy(conversation.id) ? 'busy' : '',
            ].join('\u001f')
          )
          .join('\u001e');

  if (dom.conversationList.dataset.renderSignature === signature) {
    return;
  }

  dom.conversationList.dataset.renderSignature = signature;
  const previousScrollTop = dom.conversationList.scrollTop;
  dom.conversationList.innerHTML = '';

  if (state.conversations.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '还没有会话，先创建一个。';
    dom.conversationList.appendChild(empty);
    return;
  }

  state.conversations.forEach((conversation) => {
    const item = document.createElement('div');
    item.className = 'conversation-item';
    item.dataset.id = conversation.id;

    if (conversation.id === state.selectedConversationId) {
      item.classList.add('active');
    }

    if (isConversationBusy(conversation.id)) {
      item.classList.add('busy');
    }

    const titleLine = document.createElement('div');
    titleLine.className = 'conversation-title-line';

    const title = document.createElement('strong');
    title.textContent = conversation.title;

    const badge = document.createElement('span');
    badge.className = `mini-badge${isConversationBusy(conversation.id) ? ' busy' : ''}`;
    badge.textContent = isConversationBusy(conversation.id)
      ? '处理中'
      : `${conversation.agentCount || 0}A / ${conversation.messageCount || 0}M`;

    titleLine.append(title, badge);

    const preview = document.createElement('p');
    preview.className = 'conversation-preview';
    preview.textContent = conversation.lastMessagePreview || '新的协作房间，等待第一条消息。';

    const footer = document.createElement('div');
    footer.className = 'section-row';

    const updated = document.createElement('span');
    updated.className = 'muted';
    updated.textContent = conversation.lastMessageAt ? formatDateTime(conversation.lastMessageAt) : '尚未开始';

    const participants = document.createElement('span');
    participants.className = 'muted';
    participants.textContent = `${conversation.agentCount || 0} 个 Agent`;

    footer.append(updated, participants);
    item.append(titleLine, preview, footer);
    dom.conversationList.appendChild(item);
  });

  dom.conversationList.scrollTop = previousScrollTop;
}

function renderParticipantList(conversation) {
  const signature = !conversation
    ? 'none'
    : Array.isArray(conversation.agents) && conversation.agents.length > 0
      ? `${conversation.id}:${conversation.agents
          .map((agent) =>
            [
              agent.id,
              agent.name,
              agent.description || '',
              agent.accentColor || '',
              agent.avatarDataUrl || '',
              agent.selectedModelProfileId || '',
            ].join('\u001f')
          )
          .join('\u001e')}`
      : `${conversation.id}:empty`;

  if (dom.participantList.dataset.renderSignature === signature) {
    return;
  }

  dom.participantList.dataset.renderSignature = signature;
  dom.participantList.innerHTML = '';

  if (!conversation || !Array.isArray(conversation.agents) || conversation.agents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '这个会话还没有挂载 Agent。';
    dom.participantList.appendChild(empty);
    return;
  }

  conversation.agents.forEach((agent) => {
    const chip = document.createElement('div');
    chip.className = 'agent-chip';
    const avatar = buildAgentAvatarElement(agent, 'small');

    const text = document.createElement('div');

    const name = document.createElement('strong');
    name.textContent = agent.name;

    const description = document.createElement('div');
    description.className = 'muted';
    description.textContent = [agent.description || '未填写角色说明', selectedModelProfileName(agent)].join(' · ');

    text.append(name, description);
    chip.append(avatar, text);
    dom.participantList.appendChild(chip);
  });
}

function messageDisplayText(message) {
  return message.content || (message.errorMessage ? `[error] ${message.errorMessage}` : '...');
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
    let errorMessage = `Export failed with status ${response.status}`;

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

function liveStageForMessage(activeTurn, messageId) {
  if (!activeTurn || !Array.isArray(activeTurn.agents) || !messageId) {
    return null;
  }

  return activeTurn.agents.find((agent) => agent.messageId === messageId) || null;
}

function liveStageLabel(stage) {
  if (!stage) {
    return '';
  }

  if (stage.status === 'queued') {
    return 'Thinking';
  }

  if (stage.status === 'running') {
    if (!stage.preview) {
      return 'Thinking';
    }

    if (stage.lastTextDeltaAt) {
      const lastTextDeltaMs = new Date(stage.lastTextDeltaAt).getTime();

      if (!Number.isNaN(lastTextDeltaMs) && Date.now() - lastTextDeltaMs >= LIVE_DRAFT_IDLE_MS) {
        return 'Finalizing';
      }
    }

    return 'Live draft';
  }

  if (stage.status === 'terminating') {
    return 'Finalizing';
  }

  return '';
}

function displayedMessageBody(message, stage) {
  if (!stage || message.status === 'completed' || message.status === 'failed') {
    return messageDisplayText(message);
  }

  if (stage.preview) {
    return stage.preview;
  }

  if (stage.status === 'terminating') {
    return 'Finalizing response...';
  }

  return messageDisplayText(message);
}

function createMessageCard(message, agents, activeTurn) {
  const card = document.createElement('article');
  const meta = document.createElement('div');
  const sender = document.createElement('span');
  const time = document.createElement('span');
  const body = document.createElement('p');
  const liveHint = document.createElement('div');

  meta.className = 'message-meta';
  sender.className = 'message-sender';
  time.className = 'message-time';
  body.className = 'message-body';
  liveHint.className = 'message-live-hint hidden';

  meta.append(sender, time);
  card.append(meta, body, liveHint);
  syncMessageCard(card, message, agents, activeTurn);

  return card;
}

function syncMessageCard(card, message, agents, activeTurn) {
  const agent = message.agentId
    ? (Array.isArray(agents) ? agents.find((item) => item.id === message.agentId) : null) || agentById(message.agentId)
    : null;
  const liveStage = liveStageForMessage(activeTurn, message.id);
  const liveLabel = liveStageLabel(liveStage);
  const bodyText = displayedMessageBody(message, liveStage);
  const sessionInfo = messageSessionInfo(message);
  const signature = [
    message.id,
    message.role,
    message.senderName || '',
    message.createdAt || '',
    message.status || '',
    bodyText,
    message.errorMessage || '',
    agent && agent.accentColor ? agent.accentColor : '',
    agent && agent.avatarDataUrl ? agent.avatarDataUrl : '',
    liveLabel,
    liveStage && liveStage.status ? liveStage.status : '',
    sessionInfo.sessionPath,
    sessionInfo.sessionName,
    sessionInfo.canExport ? 'exportable' : 'locked',
  ].join('\u001f');

  if (card.dataset.renderSignature === signature) {
    return;
  }

  card.dataset.messageId = message.id;
  card.dataset.renderSignature = signature;
  card.className = `message-card ${message.role}`;
  card.classList.toggle('failed', message.status === 'failed');

  if (agent && agent.accentColor) {
    card.style.setProperty('--agent-color', agent.accentColor);
  } else {
    card.style.removeProperty('--agent-color');
  }

  const sender = card.querySelector('.message-sender');
  const time = card.querySelector('.message-time');
  const body = card.querySelector('.message-body');
  const liveHint = card.querySelector('.message-live-hint');

  sender.textContent = '';

  if (message.role !== 'user' && agent) {
    sender.appendChild(buildAgentAvatarElement(agent, 'tiny'));

    if (message.role === 'assistant') {
      const exportButton = document.createElement('button');
      exportButton.type = 'button';
      exportButton.className = 'message-export-button ghost-button';
      exportButton.dataset.messageId = message.id;
      exportButton.disabled = !sessionInfo.canExport;
      exportButton.textContent = '导出';
      exportButton.title = sessionInfo.canExport ? '导出这条 AI 消息的 session' : '这条消息的 session 还不可导出';
      sender.appendChild(exportButton);
    }
  }

  const senderLabel = document.createElement('span');
  senderLabel.className = 'message-sender-label';
  senderLabel.textContent = message.role === 'user' ? 'You' : message.senderName;
  sender.appendChild(senderLabel);
  time.textContent = formatDateTime(message.createdAt);
  body.textContent = '';
  appendHighlightedMessageBody(body, bodyText, agents);

  if (liveHint) {
    const shouldShowLiveHint = Boolean(liveLabel);
    liveHint.textContent = shouldShowLiveHint ? liveLabel : '';
    liveHint.classList.toggle('hidden', !shouldShowLiveHint);
  }

  card.classList.toggle('live-preview', Boolean(liveLabel));
  card.classList.toggle('streaming', liveStage ? liveStage.status === 'running' : message.status === 'streaming');
  card.classList.toggle('queued', liveStage ? liveStage.status === 'queued' : message.status === 'queued');
  card.classList.toggle('terminating', liveStage ? liveStage.status === 'terminating' : false);
}

function renderConversationSettings() {
  const conversation = state.currentConversation;
  const disabled = !conversation || state.sending;

  dom.conversationTitleInput.disabled = disabled;
  dom.saveConversationButton.disabled = disabled;
  dom.conversationTitleInput.value = conversation ? conversation.title : '';
  dom.conversationAgentOptions.innerHTML = '';

  if (!conversation) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '选中一个会话后，这里可以调整参与 Agent。';
    dom.conversationAgentOptions.appendChild(empty);
    return;
  }

  state.agents.forEach((agent) => {
    const selectedConversationAgent = conversation.agents.find((item) => item.id === agent.id) || null;
    const selectedProfileId = selectedConversationAgent ? selectedConversationAgent.selectedModelProfileId || '' : '';
    const wrapper = document.createElement('div');
    wrapper.className = 'option-card';
    wrapper.dataset.agentId = agent.id;

    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = 'conversation-agent';
    checkbox.value = agent.id;
    checkbox.disabled = disabled;
    checkbox.checked = Boolean(selectedConversationAgent);

    const content = document.createElement('div');

    const titleLine = document.createElement('div');
    titleLine.className = 'agent-list-item';

    const nameWrap = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = agent.name;
    const description = document.createElement('div');
    description.className = 'muted';
    description.textContent = agent.description || '未填写角色说明';
    nameWrap.append(name, description);

    const avatar = buildAgentAvatarElement(agent, 'small');

    titleLine.append(nameWrap, avatar);

    const prompt = document.createElement('div');
    prompt.className = 'muted';
    prompt.textContent = agent.personaPrompt;

    const profileRow = document.createElement('div');
    profileRow.className = 'profile-select-row';

    const profileLabel = document.createElement('div');
    profileLabel.className = 'muted';
    profileLabel.textContent = '本会话使用的人格配置';

    const profileSelect = document.createElement('select');
    profileSelect.className = 'profile-select';
    profileSelect.dataset.agentId = agent.id;
    profileSelect.disabled = disabled || !selectedConversationAgent;

    modelProfilesForAgent(agent).forEach((profile) => {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = describeModelProfile(agent, profile.id);
      profileSelect.appendChild(option);
    });

    profileSelect.value = selectedProfileId;

    profileRow.append(profileLabel, profileSelect);
    content.append(titleLine, prompt, profileRow);
    label.append(checkbox, content);
    wrapper.appendChild(label);
    dom.conversationAgentOptions.appendChild(wrapper);
  });
}

function renderConversationPersonaSettings() {
  const conversation = state.currentConversation;
  const disabled = !conversation || state.sending;

  dom.saveConversationButton.disabled = disabled;
  dom.conversationAgentOptions.innerHTML = '';

  if (!conversation) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '选中一个对话后，就可以在这里设置本次对话需要的人格。';
    dom.conversationAgentOptions.appendChild(empty);
    return;
  }

  if (state.agents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '还没有可用人格，请先前往人格管理页创建。';
    dom.conversationAgentOptions.appendChild(empty);
    return;
  }

  state.agents.forEach((agent) => {
    const selectedConversationAgent = conversation.agents.find((item) => item.id === agent.id) || null;
    const selectedProfileId = selectedConversationAgent ? selectedConversationAgent.selectedModelProfileId || '' : '';
    const wrapper = document.createElement('div');
    wrapper.className = 'option-card';
    wrapper.dataset.agentId = agent.id;

    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = 'conversation-agent';
    checkbox.value = agent.id;
    checkbox.disabled = disabled;
    checkbox.checked = Boolean(selectedConversationAgent);

    const content = document.createElement('div');

    const titleLine = document.createElement('div');
    titleLine.className = 'agent-list-item';

    const nameWrap = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = agent.name;
    const description = document.createElement('div');
    description.className = 'muted';
    description.textContent = agent.description || '未填写角色说明';
    nameWrap.append(name, description);

    const avatar = buildAgentAvatarElement(agent, 'small');

    titleLine.append(nameWrap, avatar);

    const prompt = document.createElement('div');
    prompt.className = 'muted';
    prompt.textContent = agent.personaPrompt;

    const profileRow = document.createElement('div');
    profileRow.className = 'profile-select-row';

    const profileLabel = document.createElement('div');
    profileLabel.className = 'muted';
    profileLabel.textContent = '本会话使用的人格配置';

    const profileSelect = document.createElement('select');
    profileSelect.className = 'profile-select';
    profileSelect.dataset.agentId = agent.id;
    profileSelect.disabled = disabled || !selectedConversationAgent;

    modelProfilesForAgent(agent).forEach((profile) => {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = describeModelProfile(agent, profile.id);
      profileSelect.appendChild(option);
    });

    profileSelect.value = selectedProfileId;

    profileRow.append(profileLabel, profileSelect);
    content.append(titleLine, prompt, profileRow);
    label.append(checkbox, content);
    wrapper.appendChild(label);
    dom.conversationAgentOptions.appendChild(wrapper);
  });
}

function renderCompactConversationPersonaSettings() {
  const conversation = state.currentConversation;
  const disabled = !conversation || state.sending;

  dom.saveConversationButton.disabled = disabled;
  dom.conversationAgentOptions.innerHTML = '';

  if (!conversation) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '选中一个对话后，就可以在这里选择本次对话的人格。';
    dom.conversationAgentOptions.appendChild(empty);
    return;
  }

  if (state.agents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '还没有可用人格，请先前往人格管理页创建。';
    dom.conversationAgentOptions.appendChild(empty);
    return;
  }

  state.agents.forEach((agent) => {
    const selectedConversationAgent = conversation.agents.find((item) => item.id === agent.id) || null;
    const selectedProfileId = selectedConversationAgent ? selectedConversationAgent.selectedModelProfileId || '' : '';
    const wrapper = document.createElement('div');
    wrapper.className = 'option-card compact-option-card';
    wrapper.dataset.agentId = agent.id;
    wrapper.classList.toggle('is-selected', Boolean(selectedConversationAgent));

    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = 'conversation-agent';
    checkbox.value = agent.id;
    checkbox.disabled = disabled;
    checkbox.checked = Boolean(selectedConversationAgent);

    const content = document.createElement('div');
    content.className = 'persona-option-content';

    const titleLine = document.createElement('div');
    titleLine.className = 'persona-option-head';

    const avatar = buildAgentAvatarElement(agent, 'small');

    const nameWrap = document.createElement('div');
    nameWrap.className = 'persona-option-copy';

    const name = document.createElement('strong');
    name.className = 'persona-option-name';
    name.textContent = agent.name;

    const description = document.createElement('div');
    description.className = 'muted persona-option-description';
    description.textContent = agent.description || '未填写角色说明';

    nameWrap.append(name, description);
    titleLine.append(avatar, nameWrap);

    const profileRow = document.createElement('div');
    profileRow.className = 'profile-select-row persona-option-config';
    profileRow.classList.toggle('hidden', !selectedConversationAgent);

    const profileLabel = document.createElement('div');
    profileLabel.className = 'muted persona-option-config-label';
    profileLabel.textContent = '配置';

    const profileSelect = document.createElement('select');
    profileSelect.className = 'profile-select';
    profileSelect.dataset.agentId = agent.id;
    profileSelect.disabled = disabled || !selectedConversationAgent;
    profileSelect.title = '本会话使用的人格配置';

    modelProfilesForAgent(agent).forEach((profile) => {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = describeModelProfile(agent, profile.id);
      profileSelect.appendChild(option);
    });

    profileSelect.value = selectedProfileId;

    profileRow.append(profileLabel, profileSelect);
    content.append(titleLine, profileRow);
    label.append(checkbox, content);
    wrapper.appendChild(label);
    dom.conversationAgentOptions.appendChild(wrapper);
  });
}

function renderMessages(conversation, activeTurn) {
  const messages = conversation && Array.isArray(conversation.messages) ? conversation.messages : [];
  const hasMessages = messages.length > 0;

  if (!hasMessages) {
    if (dom.messageList.childElementCount === 1 && dom.messageList.firstElementChild.classList.contains('empty-state')) {
      return;
    }

    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Send a message to start a multi-agent discussion.';
    dom.messageList.replaceChildren(empty);
    return;
  }

  const existingCards = Array.from(dom.messageList.querySelectorAll('.message-card'));
  const hasOnlyMessageCards = existingCards.length === dom.messageList.childElementCount;
  const matchesExistingPrefix =
    hasOnlyMessageCards &&
    existingCards.every((card, index) => card.dataset.messageId === (messages[index] ? messages[index].id : undefined));

  if (matchesExistingPrefix && existingCards.length === messages.length) {
    existingCards.forEach((card, index) => {
      syncMessageCard(card, messages[index], conversation.agents, activeTurn);
    });
    return;
  }

  if (matchesExistingPrefix && existingCards.length < messages.length) {
    existingCards.forEach((card, index) => {
      syncMessageCard(card, messages[index], conversation.agents, activeTurn);
    });

    messages.slice(existingCards.length).forEach((message) => {
      dom.messageList.appendChild(createMessageCard(message, conversation.agents, activeTurn));
    });
    return;
  }

  const fragment = document.createDocumentFragment();
  messages.forEach((message) => {
    fragment.appendChild(createMessageCard(message, conversation.agents, activeTurn));
  });
  dom.messageList.replaceChildren(fragment);
}

function renderConversationPane() {
  const conversation = state.currentConversation;
  const activeTurn = conversation ? activeTurnForConversation(conversation.id) : null;
  clearLiveDraftFinalizingTimer();

  if (!conversation) {
    dom.conversationTitleDisplay.textContent = 'Select a conversation';
    dom.conversationMeta.textContent = 'Choose a room to inspect its agents and messages.';
    dom.deleteConversationButton.disabled = true;
    renderParticipantList(null);
    renderMessages(null, null);
    dom.composerInput.disabled = true;
    dom.sendButton.disabled = true;
    dom.composerStatus.textContent = 'Pick a room to begin.';
    closeMentionMenu();
    return;
  }

  dom.conversationTitleDisplay.textContent = conversation.title;
  dom.conversationMeta.textContent = `${conversation.agents.length} agents / ${conversation.messages.length} messages`;
  dom.deleteConversationButton.disabled = state.sending;

  renderParticipantList(conversation);
  renderMessages(conversation, activeTurn);

  const hasAgents = conversation.agents.length > 0;
  dom.composerInput.disabled = state.sending || !hasAgents;
  dom.sendButton.disabled = state.sending || !hasAgents;
  dom.composerInput.placeholder = 'Type **@Agent** to hand off inside this room.';

  if (activeTurn && activeTurn.currentAgentId) {
    const activeAgent = agentById(activeTurn.currentAgentId);
    const activeStage =
      Array.isArray(activeTurn.agents) && activeTurn.currentAgentId
        ? activeTurn.agents.find((agent) => agent.agentId === activeTurn.currentAgentId) || null
        : null;
    const activeStageLabel = liveStageLabel(activeStage);
    dom.composerStatus.textContent = activeAgent
      ? activeStage && activeStage.preview
        ? activeStageLabel === 'Finalizing'
          ? `${activeAgent.name} is wrapping up the reply below.`
          : `${activeAgent.name} is drafting a reply live below.`
        : `${activeAgent.name} is replying. Use **@Agent** to hand off.`
      : 'This room is routing the current turn via explicit handoffs.';

    if (
      activeStage &&
      activeStage.status === 'running' &&
      activeStage.preview &&
      activeStage.lastTextDeltaAt &&
      activeStageLabel === 'Live draft'
    ) {
      const lastTextDeltaMs = new Date(activeStage.lastTextDeltaAt).getTime();

      if (!Number.isNaN(lastTextDeltaMs)) {
        const msUntilFinalizing = Math.max(0, LIVE_DRAFT_IDLE_MS - (Date.now() - lastTextDeltaMs));
        liveDraftFinalizingTimer = window.setTimeout(() => {
          liveDraftFinalizingTimer = null;
          scheduleConversationPaneRender();
        }, msUntilFinalizing + 16);
      }
    }
  } else if (state.sending) {
    dom.composerStatus.textContent = 'This room is routing the current turn...';
  } else if (!hasAgents) {
    dom.composerStatus.textContent = '先在右侧为本次对话选择至少一个人格。';
  } else {
    dom.composerStatus.textContent = 'Agents hand off only through **@Agent** mentions.';
  }

  if (!hasAgents || state.sending) {
    closeMentionMenu();
  }
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
  renderCompactConversationPersonaSettings();
}

async function loadConversation(conversationId) {
  if (!conversationId) {
    state.currentConversation = null;
    closeMentionMenu();
    renderAll();
    return;
  }

  const data = await fetchJson(`/api/conversations/${conversationId}`);
  state.selectedConversationId = conversationId;
  state.currentConversation = data.conversation;
  closeMentionMenu();
  renderAll();
  scrollMessageListToBottom();
}

async function refreshAll(preferredConversationId) {
  const data = await fetchJson('/api/bootstrap');
  state.runtime = data.runtime;
  state.modelOptions = Array.isArray(data.modelOptions) ? data.modelOptions : [];
  state.agents = data.agents;
  state.conversations = data.conversations;

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
  if (!conversationId || state.selectedConversationId !== conversationId) {
    return;
  }

  const shouldStickToBottom = isMessageListNearBottom();

  try {
    const data = await fetchJson(`/api/conversations/${conversationId}`);

    if (state.selectedConversationId !== conversationId) {
      return;
    }

    state.currentConversation = data.conversation;
    renderConversationPane();

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
  if (state.eventSource || typeof EventSource === 'undefined') {
    return;
  }

  const source = new EventSource('/api/events');
  state.eventSource = source;

  source.addEventListener('runtime_state', (event) => {
    const payload = JSON.parse(event.data);
    state.runtime = payload;
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

  source.addEventListener('turn_progress', (event) => {
    const payload = JSON.parse(event.data);

    if (!state.runtime) {
      state.runtime = {};
    }

    const activeTurns = Array.isArray(state.runtime.activeTurns) ? state.runtime.activeTurns.slice() : [];
    const index = activeTurns.findIndex((turn) => turn.conversationId === payload.conversationId);

    const existingTurn = index === -1 ? null : activeTurns[index];
    const hasChanged = turnProgressSignature(existingTurn) !== turnProgressSignature(payload.turn);

    if (hasChanged) {
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

    if (state.runtime && Array.isArray(state.runtime.activeTurns)) {
      state.runtime.activeTurns = state.runtime.activeTurns.filter((turn) => turn.conversationId !== payload.conversationId);
    }

    renderConversationPane();
    renderConversationList();
    renderRuntime();
    void refreshConversationFromEvent(payload.conversationId);
  });

  source.addEventListener('error', () => {
    if (state.eventSource === source && source.readyState === EventSource.CLOSED) {
      state.eventSource = null;
      window.setTimeout(() => {
        connectEventStream();
      }, 1500);
    }
  });
}

function selectedConversationParticipants() {
  return Array.from(dom.conversationAgentOptions.querySelectorAll('.option-card')).flatMap((card) => {
    const checkbox = card.querySelector('input[name="conversation-agent"]');
    const select = card.querySelector('select.profile-select');

    if (!checkbox || !checkbox.checked) {
      return [];
    }

    return [
      {
        agentId: checkbox.value,
        modelProfileId: select && select.value ? select.value : null,
      },
    ];
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
      const result = await fetchJson('/api/conversations', {
        method: 'POST',
        body: {
          title: dom.newConversationTitle.value.trim(),
        },
      });
      dom.newConversationTitle.value = '';
      state.conversations = result.conversations;
      state.selectedConversationId = result.conversation.id;
      state.currentConversation = result.conversation;
      renderAll();
      showToast('新会话已创建');
    } catch (error) {
      showToast(error.message);
    }
  });

  dom.conversationList.addEventListener('click', async (event) => {
    const item = event.target.closest('.conversation-item');

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
    const button = event.target.closest('.message-export-button');

    if (!button || !state.currentConversation) {
      return;
    }

    const messageId = button.dataset.messageId || '';
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
      showToast('这条消息的 session 还没准备好');
      return;
    }

    const previousText = button.textContent;
    button.disabled = true;
    button.textContent = '导出中';

    try {
      await exportMessageSession(state.currentConversation.id, message);
      showToast('Session 已导出');
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = !messageSessionInfo(message).canExport;
      button.textContent = previousText;
    }
  });

  dom.composerInput.addEventListener('input', () => {
    syncComposerMentionMenu();
  });

  dom.composerInput.addEventListener('click', () => {
    syncComposerMentionMenu();
  });

  dom.composerInput.addEventListener('blur', () => {
    window.setTimeout(() => {
      closeMentionMenu();
    }, 120);
  });

  dom.composerInput.addEventListener('keydown', (event) => {
    if (state.mentionSuggestions.length === 0) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      state.mentionSelectionIndex = (state.mentionSelectionIndex + 1) % state.mentionSuggestions.length;
      renderMentionMenu();
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      state.mentionSelectionIndex =
        (state.mentionSelectionIndex - 1 + state.mentionSuggestions.length) % state.mentionSuggestions.length;
      renderMentionMenu();
      return;
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      applyMentionSuggestion(state.mentionSuggestions[state.mentionSelectionIndex]);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      closeMentionMenu();
    }
  });

  if (dom.composerMentionMenu) {
    dom.composerMentionMenu.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });

    dom.composerMentionMenu.addEventListener('click', (event) => {
      const option = event.target.closest('.mention-option');

      if (!option) {
        return;
      }

      const index = Number.parseInt(option.dataset.index || '', 10);

      if (!Number.isInteger(index) || !state.mentionSuggestions[index]) {
        return;
      }

      applyMentionSuggestion(state.mentionSuggestions[index]);
    });
  }

  dom.composerForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!state.currentConversation || state.sending) {
      return;
    }

    const content = dom.composerInput.value.trim();

    if (!content) {
      showToast('请输入消息内容');
      return;
    }

    state.sending = true;
    state.runtime = state.runtime || {};
    state.runtime.activeConversationIds = Array.from(
      new Set([...(state.runtime.activeConversationIds || []), state.currentConversation.id])
    );
    renderAll();

    try {
      const result = await fetchJson(`/api/conversations/${state.currentConversation.id}/messages`, {
        method: 'POST',
        body: { content },
      });
      dom.composerInput.value = '';
      closeMentionMenu();
      state.currentConversation = result.conversation;
      state.conversations = result.conversations;
      if (state.runtime) {
        state.runtime.activeConversationIds = (state.runtime.activeConversationIds || []).filter(
          (id) => id !== state.currentConversation.id
        );
      }
      renderAll();
      scrollMessageListToBottom();

      if (Array.isArray(result.failures) && result.failures.length > 0) {
        showToast(`本轮完成，但有 ${result.failures.length} 个 Agent 失败`);
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
  });

  dom.conversationAgentOptions.addEventListener('change', (event) => {
    const checkbox = event.target.closest('input[name="conversation-agent"]');

    if (!checkbox) {
      return;
    }

    const card = checkbox.closest('.option-card');
    const select = card ? card.querySelector('select.profile-select') : null;
    const profileRow = card ? card.querySelector('.profile-select-row') : null;

    if (select) {
      select.disabled = !checkbox.checked || state.sending;
    }

    if (profileRow) {
      profileRow.classList.toggle('hidden', !checkbox.checked);
    }

    if (card) {
      card.classList.toggle('is-selected', checkbox.checked);
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
      showToast('会话设置已保存');
    } catch (error) {
      showToast(error.message);
    }
  });

  dom.deleteConversationButton.addEventListener('click', async () => {
    if (!state.currentConversation) {
      return;
    }

    if (!window.confirm(`确定删除对话“${state.currentConversation.title}”吗？`)) {
      return;
    }

    try {
      const result = await fetchJson(`/api/conversations/${state.currentConversation.id}`, {
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
    const item = event.target.closest('.agent-list-item');

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
      showToast('Agent 名称不能为空');
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
      showToast(payload.id ? 'Agent 已更新' : '新 Agent 已创建');
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
