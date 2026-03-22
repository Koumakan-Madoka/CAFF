const state = {
  agents: [],
  modelOptions: [],
  selectedAgentId: null,
  toastTimer: null,
};

const MAX_AVATAR_FILE_SIZE = 1024 * 1024;

const dom = {
  refreshButton: document.getElementById('refresh-button'),
  newAgentButton: document.getElementById('new-agent-button'),
  agentList: document.getElementById('agent-list'),
  editorTitle: document.getElementById('editor-title'),
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
  addProfileButton: document.getElementById('add-profile-button'),
  profileList: document.getElementById('profile-list'),
  clearAgentAvatarButton: document.getElementById('clear-agent-avatar-button'),
  deleteAgentButton: document.getElementById('delete-agent-button'),
  toast: document.getElementById('toast'),
};

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(data.error || `Request failed with status ${response.status}`);
  }

  return data;
}

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.remove('hidden');
  state.toastTimer = window.setTimeout(() => {
    dom.toast.classList.add('hidden');
  }, 2600);
}

function agentById(agentId) {
  return state.agents.find((agent) => agent.id === agentId) || null;
}

function ensureSelectedAgent() {
  if (state.selectedAgentId && agentById(state.selectedAgentId)) {
    return;
  }

  state.selectedAgentId = state.agents[0] ? state.agents[0].id : null;
}

function modelOptionKey(provider, model) {
  return `${String(provider || '').trim()}\u001f${String(model || '').trim()}`;
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

function createProfileDraft(profile = {}) {
  return {
    id: String(profile.id || '').trim(),
    name: String(profile.name || '').trim(),
    description: String(profile.description || '').trim(),
    provider: String(profile.provider || '').trim(),
    model: String(profile.model || '').trim(),
    thinking: String(profile.thinking || '').trim(),
    personaPrompt: String(profile.personaPrompt || '').trim(),
  };
}

function profileTitle(profile, index) {
  return profile.name || `配置 ${index + 1}`;
}

function emptyProfileState() {
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.textContent = '还没有模型专属人格配置，点击“添加配置”开始。';
  return empty;
}

function updateProfileHeadings() {
  Array.from(dom.profileList.querySelectorAll('.profile-editor')).forEach((card, index) => {
    const title = card.querySelector('.profile-editor-title');
    const nameInput = card.querySelector('input[data-field="name"]');
    const nextTitle = profileTitle({ name: nameInput ? nameInput.value.trim() : '' }, index);

    if (title) {
      title.textContent = nextTitle;
    }
  });
}

function createProfileEditor(profile = {}) {
  const draft = createProfileDraft(profile);
  const card = document.createElement('section');
  card.className = 'profile-editor';

  card.innerHTML = `
    <input data-field="id" type="hidden" />
    <div class="profile-editor-header">
      <strong class="profile-editor-title"></strong>
      <button class="ghost-button danger" type="button" data-action="remove-profile">移除</button>
    </div>
    <label>
      <span>配置名称</span>
      <input data-field="name" type="text" maxlength="40" placeholder="例如：GPT-5 深度架构师" />
    </label>
    <label>
      <span>配置说明</span>
      <input data-field="description" type="text" maxlength="120" placeholder="可选，说明这套人格适合什么场景" />
    </label>
    <div class="field-grid">
      <label>
        <span>Provider</span>
        <input data-field="provider" type="text" maxlength="80" placeholder="自动带出" readonly />
      </label>
      <label>
        <span>Model</span>
        <select data-field="model"></select>
      </label>
    </div>
    <label>
      <span>Thinking</span>
      <input data-field="thinking" type="text" maxlength="80" placeholder="可选" />
    </label>
    <label>
      <span>人格 Prompt</span>
      <textarea data-field="personaPrompt" rows="5" maxlength="4000" placeholder="这套模型专属人格的完整 Prompt"></textarea>
    </label>
  `;

  card.querySelector('[data-field="id"]').value = draft.id;
  card.querySelector('[data-field="name"]').value = draft.name;
  card.querySelector('[data-field="description"]').value = draft.description;
  card.querySelector('[data-field="provider"]').value = draft.provider;
  fillModelSelect(card.querySelector('[data-field="model"]'), draft.provider, draft.model);
  card.querySelector('[data-field="thinking"]').value = draft.thinking;
  card.querySelector('[data-field="personaPrompt"]').value = draft.personaPrompt;

  return card;
}

function renderProfileList(profiles) {
  dom.profileList.innerHTML = '';

  if (!Array.isArray(profiles) || profiles.length === 0) {
    dom.profileList.appendChild(emptyProfileState());
    return;
  }

  profiles.forEach((profile) => {
    dom.profileList.appendChild(createProfileEditor(profile));
  });
  updateProfileHeadings();
}

function resetAgentForm() {
  dom.editorTitle.textContent = '新建人格';
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
  renderProfileList([]);
}

function fillAgentForm(agent) {
  dom.editorTitle.textContent = `编辑人格 · ${agent.name}`;
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
  renderProfileList(Array.isArray(agent.modelProfiles) ? agent.modelProfiles : []);
}

function collectProfilesFromDom() {
  return Array.from(dom.profileList.querySelectorAll('.profile-editor')).map((card) => {
    const modelSelect = card.querySelector('[data-field="model"]');
    const providerInput = card.querySelector('[data-field="provider"]');
    const modelOption = selectedModelOption(modelSelect);

    return {
      id: card.querySelector('[data-field="id"]') ? card.querySelector('[data-field="id"]').value.trim() : '',
      name: card.querySelector('[data-field="name"]') ? card.querySelector('[data-field="name"]').value.trim() : '',
      description: card.querySelector('[data-field="description"]')
        ? card.querySelector('[data-field="description"]').value.trim()
        : '',
      provider: modelOption ? modelOption.provider || '' : providerInput ? providerInput.value.trim() : '',
      model: modelOption ? modelOption.model || '' : '',
      thinking: card.querySelector('[data-field="thinking"]')
        ? card.querySelector('[data-field="thinking"]').value.trim()
        : '',
      personaPrompt: card.querySelector('[data-field="personaPrompt"]')
        ? card.querySelector('[data-field="personaPrompt"]').value.trim()
        : '',
    };
  });
}

function serializeAgentForm() {
  const baseModelOption = selectedModelOption(dom.agentModel);

  return {
    id: dom.agentId.value.trim(),
    name: dom.agentName.value.trim(),
    description: dom.agentDescription.value.trim(),
    avatarDataUrl: dom.agentAvatarData.value.trim(),
    personaPrompt: dom.agentPersonaPrompt.value.trim(),
    provider: baseModelOption ? baseModelOption.provider || '' : dom.agentProvider.value.trim(),
    model: baseModelOption ? baseModelOption.model || '' : '',
    thinking: dom.agentThinking.value.trim(),
    accentColor: dom.agentAccentColor.value,
    modelProfiles: collectProfilesFromDom(),
  };
}

function renderAgentList() {
  ensureSelectedAgent();
  dom.agentList.innerHTML = '';

  if (state.agents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '还没有人格，先创建一个。';
    dom.agentList.appendChild(empty);
    return;
  }

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

function renderAll() {
  renderAgentList();

  const selectedAgent = agentById(state.selectedAgentId);

  if (selectedAgent) {
    fillAgentForm(selectedAgent);
  } else {
    resetAgentForm();
  }

  dom.deleteAgentButton.disabled = !selectedAgent;
}

async function refreshAgents(preferredAgentId) {
  const data = await fetchJson('/api/agents');
  state.agents = data.agents;
  state.modelOptions = Array.isArray(data.modelOptions) ? data.modelOptions : [];
  state.selectedAgentId =
    preferredAgentId && state.agents.some((agent) => agent.id === preferredAgentId)
      ? preferredAgentId
      : state.selectedAgentId;
  ensureSelectedAgent();
  renderAll();
}

function bindEvents() {
  dom.refreshButton.addEventListener('click', async () => {
    try {
      await refreshAgents(state.selectedAgentId);
      showToast('人格列表已刷新');
    } catch (error) {
      showToast(error.message);
    }
  });

  dom.newAgentButton.addEventListener('click', () => {
    state.selectedAgentId = null;
    renderAll();
    dom.agentName.focus();
  });

  dom.agentList.addEventListener('click', (event) => {
    const item = event.target.closest('.agent-list-item');

    if (!item || !item.dataset.id) {
      return;
    }

    state.selectedAgentId = item.dataset.id;
    renderAll();
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

  dom.addProfileButton.addEventListener('click', () => {
    const empty = dom.profileList.querySelector('.empty-state');

    if (empty) {
      empty.remove();
    }

    dom.profileList.appendChild(createProfileEditor());
    updateProfileHeadings();
  });

  dom.profileList.addEventListener('input', (event) => {
    if (event.target.matches('input[data-field="name"]')) {
      updateProfileHeadings();
    }
  });

  dom.profileList.addEventListener('change', (event) => {
    const modelSelect = event.target.closest('select[data-field="model"]');

    if (!modelSelect) {
      return;
    }

    const card = modelSelect.closest('.profile-editor');
    const providerInput = card ? card.querySelector('[data-field="provider"]') : null;
    syncProviderFromModelSelect(modelSelect, providerInput);
  });

  dom.profileList.addEventListener('click', (event) => {
    const removeButton = event.target.closest('[data-action="remove-profile"]');

    if (!removeButton) {
      return;
    }

    const card = removeButton.closest('.profile-editor');

    if (card) {
      card.remove();
    }

    if (dom.profileList.querySelectorAll('.profile-editor').length === 0) {
      dom.profileList.appendChild(emptyProfileState());
    }

    updateProfileHeadings();
  });

  dom.agentForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const payload = serializeAgentForm();

    if (!payload.name) {
      showToast('人格名称不能为空');
      return;
    }

    if (!payload.personaPrompt) {
      showToast('默认人格 Prompt 不能为空');
      return;
    }

    try {
      const result = await fetchJson(payload.id ? `/api/agents/${payload.id}` : '/api/agents', {
        method: payload.id ? 'PUT' : 'POST',
        body: payload,
      });
      state.agents = result.agents;
      state.modelOptions = Array.isArray(result.modelOptions) ? result.modelOptions : state.modelOptions;
      state.selectedAgentId = result.agent.id;
      renderAll();
      showToast(payload.id ? '人格已更新' : '人格已创建');
    } catch (error) {
      showToast(error.message);
    }
  });

  dom.deleteAgentButton.addEventListener('click', async () => {
    const selectedAgent = agentById(state.selectedAgentId);

    if (!selectedAgent) {
      return;
    }

    if (!window.confirm(`确定删除人格“${selectedAgent.name}”吗？`)) {
      return;
    }

    try {
      await fetchJson(`/api/agents/${selectedAgent.id}`, {
        method: 'DELETE',
      });
      state.selectedAgentId = null;
      await refreshAgents();
      showToast('人格已删除');
    } catch (error) {
      showToast(error.message);
    }
  });
}

async function init() {
  bindEvents();

  try {
    await refreshAgents();
  } catch (error) {
    showToast(error.message);
  }
}

init();
