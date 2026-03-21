const state = {
  runtime: null,
  agents: [],
  conversations: [],
  selectedConversationId: null,
  currentConversation: null,
  selectedAgentId: null,
  sending: false,
  toastTimer: null,
};

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
  agentPersonaPrompt: document.getElementById('agent-persona-prompt'),
  agentProvider: document.getElementById('agent-provider'),
  agentModel: document.getElementById('agent-model'),
  agentThinking: document.getElementById('agent-thinking'),
  agentAccentColor: document.getElementById('agent-accent-color'),
  deleteAgentButton: document.getElementById('delete-agent-button'),
  toast: document.getElementById('toast'),
};

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
}

function renderParticipantList(conversation) {
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

    const dot = document.createElement('span');
    dot.className = 'color-dot';
    dot.style.setProperty('--agent-color', agent.accentColor || '#3d405b');

    const text = document.createElement('div');

    const name = document.createElement('strong');
    name.textContent = agent.name;

    const description = document.createElement('div');
    description.className = 'muted';
    description.textContent = agent.description || '未填写角色说明';

    text.append(name, description);
    chip.append(dot, text);
    dom.participantList.appendChild(chip);
  });
}

function renderMessages(conversation) {
  dom.messageList.innerHTML = '';

  if (!conversation || !Array.isArray(conversation.messages) || conversation.messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '发一条消息试试。当前会话里的多个 Agent 会按顺序依次回应。';
    dom.messageList.appendChild(empty);
    return;
  }

  conversation.messages.forEach((message) => {
    const card = document.createElement('article');
    const agent = message.agentId ? agentById(message.agentId) : null;
    card.className = `message-card ${message.role}`;

    if (message.status === 'failed') {
      card.classList.add('failed');
    }

    if (agent && agent.accentColor) {
      card.style.setProperty('--agent-color', agent.accentColor);
    }

    const meta = document.createElement('div');
    meta.className = 'message-meta';

    const sender = document.createElement('span');
    sender.className = 'message-sender';
    sender.textContent = message.role === 'user' ? '你' : message.senderName;

    const time = document.createElement('span');
    time.className = 'message-time';
    time.textContent = formatDateTime(message.createdAt);

    meta.append(sender, time);

    const body = document.createElement('p');
    body.className = 'message-body';
    body.textContent = message.content || `运行失败：${message.errorMessage || '未返回内容'}`;

    card.append(meta, body);
    dom.messageList.appendChild(card);
  });
}

function renderConversationPane() {
  const conversation = state.currentConversation;

  if (!conversation) {
    dom.conversationTitleDisplay.textContent = '请选择一个会话';
    dom.conversationMeta.textContent = '左侧创建或切换会话后即可开始。';
    dom.deleteConversationButton.disabled = true;
    renderParticipantList(null);
    renderMessages(null);
    dom.composerInput.disabled = true;
    dom.sendButton.disabled = true;
    dom.composerStatus.textContent = '先创建一个会话';
    return;
  }

  dom.conversationTitleDisplay.textContent = conversation.title;
  dom.conversationMeta.textContent = `${conversation.agents.length} 个 Agent · ${conversation.messages.length} 条消息`;
  dom.deleteConversationButton.disabled = state.sending;

  renderParticipantList(conversation);
  renderMessages(conversation);

  const hasAgents = conversation.agents.length > 0;
  dom.composerInput.disabled = state.sending || !hasAgents;
  dom.sendButton.disabled = state.sending || !hasAgents;

  if (state.sending) {
    dom.composerStatus.textContent = `正在让 ${conversation.agents.length} 个 Agent 依次作答...`;
  } else if (!hasAgents) {
    dom.composerStatus.textContent = '请先在右侧给这个会话勾选 Agent';
  } else {
    dom.composerStatus.textContent = `当前这一轮将由 ${conversation.agents.length} 个 Agent 参与`;
  }
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
    const wrapper = document.createElement('div');
    wrapper.className = 'option-card';

    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = 'conversation-agent';
    checkbox.value = agent.id;
    checkbox.disabled = disabled;
    checkbox.checked = conversation.agents.some((item) => item.id === agent.id);

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

    const dot = document.createElement('span');
    dot.className = 'color-dot';
    dot.style.setProperty('--agent-color', agent.accentColor || '#3d405b');

    titleLine.append(nameWrap, dot);

    const prompt = document.createElement('div');
    prompt.className = 'muted';
    prompt.textContent = agent.personaPrompt;

    content.append(titleLine, prompt);
    label.append(checkbox, content);
    wrapper.appendChild(label);
    dom.conversationAgentOptions.appendChild(wrapper);
  });
}

function resetAgentForm() {
  dom.agentId.value = '';
  dom.agentName.value = '';
  dom.agentDescription.value = '';
  dom.agentPersonaPrompt.value = '';
  dom.agentProvider.value = '';
  dom.agentModel.value = '';
  dom.agentThinking.value = '';
  dom.agentAccentColor.value = '#3d405b';
}

function fillAgentForm(agent) {
  dom.agentId.value = agent.id;
  dom.agentName.value = agent.name;
  dom.agentDescription.value = agent.description || '';
  dom.agentPersonaPrompt.value = agent.personaPrompt || '';
  dom.agentProvider.value = agent.provider || '';
  dom.agentModel.value = agent.model || '';
  dom.agentThinking.value = agent.thinking || '';
  dom.agentAccentColor.value = agent.accentColor || '#3d405b';
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
      description.textContent = agent.description || '未填写角色说明';
      nameWrap.append(name, description);

      const dot = document.createElement('span');
      dot.className = 'color-dot';
      dot.style.setProperty('--agent-color', agent.accentColor || '#3d405b');

      item.append(nameWrap, dot);
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
  renderConversationSettings();
  renderAgentStudio();
}

async function loadConversation(conversationId) {
  if (!conversationId) {
    state.currentConversation = null;
    renderAll();
    return;
  }

  const data = await fetchJson(`/api/conversations/${conversationId}`);
  state.selectedConversationId = conversationId;
  state.currentConversation = data.conversation;
  renderAll();
  dom.messageList.scrollTop = dom.messageList.scrollHeight;
}

async function refreshAll(preferredConversationId) {
  const data = await fetchJson('/api/bootstrap');
  state.runtime = data.runtime;
  state.agents = data.agents;
  state.conversations = data.conversations;

  const desiredConversationId =
    preferredConversationId && state.conversations.some((item) => item.id === preferredConversationId)
      ? preferredConversationId
      : data.selectedConversationId;

  state.selectedConversationId = desiredConversationId || (state.conversations[0] ? state.conversations[0].id : null);
  ensureSelectedAgent();
  renderAll();

  if (state.selectedConversationId) {
    await loadConversation(state.selectedConversationId);
  }
}

function selectedConversationAgentIds() {
  return Array.from(dom.conversationAgentOptions.querySelectorAll('input[name="conversation-agent"]:checked')).map(
    (input) => input.value
  );
}

function serializeAgentForm() {
  return {
    id: dom.agentId.value.trim(),
    name: dom.agentName.value.trim(),
    description: dom.agentDescription.value.trim(),
    personaPrompt: dom.agentPersonaPrompt.value.trim(),
    provider: dom.agentProvider.value.trim(),
    model: dom.agentModel.value.trim(),
    thinking: dom.agentThinking.value.trim(),
    accentColor: dom.agentAccentColor.value,
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
      state.currentConversation = result.conversation;
      state.conversations = result.conversations;
      if (state.runtime) {
        state.runtime.activeConversationIds = (state.runtime.activeConversationIds || []).filter(
          (id) => id !== state.currentConversation.id
        );
      }
      renderAll();
      dom.messageList.scrollTop = dom.messageList.scrollHeight;

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

  dom.conversationSettingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!state.currentConversation) {
      return;
    }

    const agentIds = selectedConversationAgentIds();

    if (agentIds.length === 0) {
      showToast('至少选择一个 Agent');
      return;
    }

    try {
      const result = await fetchJson(`/api/conversations/${state.currentConversation.id}`, {
        method: 'PUT',
        body: {
          title: dom.conversationTitleInput.value.trim(),
          agentIds,
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
      ensureSelectedAgent();
      renderAll();

      if (state.selectedConversationId) {
        await loadConversation(state.selectedConversationId);
      }

      showToast('对话已删除');
    } catch (error) {
      showToast(error.message);
    }
  });

  dom.newAgentButton.addEventListener('click', () => {
    state.selectedAgentId = null;
    renderAgentStudio();
    dom.agentName.focus();
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

async function init() {
  bindEvents();

  try {
    await refreshAll();
  } catch (error) {
    dom.runtimePill.textContent = '服务连接失败';
    showToast(error.message);
  }
}

init();
