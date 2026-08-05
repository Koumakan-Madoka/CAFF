// @ts-check

(function registerNewConversationDialogModule() {
  const chat = window.CaffChat || (window.CaffChat = {});
  const modelOptionUtils = window.CaffShared && window.CaffShared.modelOptions;
  if (!modelOptionUtils) throw new Error('CaffShared.modelOptions helper is required');
  const GAME_TYPES = new Set(['who_is_undercover', 'werewolf']);

  function normalizeText(value) {
    return String(value || '').trim();
  }

  function availabilityReason(availability) {
    return modelOptionUtils.roleAvailabilityReason(availability) || '当前不可用';
  }

  function snapshotRoles(agents) {
    return (Array.isArray(agents) ? agents : [])
      .filter((agent) => agent && normalizeText(agent.id))
      .map((agent) => {
        const availability = agent.availability && typeof agent.availability === 'object'
          ? { ...agent.availability }
          : { status: 'available' };
        const available = modelOptionUtils.isRoleAvailable(availability);
        return Object.freeze({
          id: normalizeText(agent.id),
          name: normalizeText(agent.name) || normalizeText(agent.id),
          description: normalizeText(agent.description),
          roleKind: agent.roleKind === 'model_family' ? 'model_family' : 'custom',
          modelFamily: normalizeText(agent.modelFamily) || null,
          accentColor: normalizeText(agent.accentColor) || '#3d405b',
          isDefaultChatRole: Boolean(agent.isDefaultChatRole),
          availability: Object.freeze(availability),
          available,
          unavailableReason: available ? '' : availabilityReason(availability),
        });
      });
  }

  function initialSelectedRoleIds(snapshot, modeId) {
    if (normalizeText(modeId) !== 'standard') {
      return new Set();
    }
    return new Set(
      (Array.isArray(snapshot) ? snapshot : [])
        .filter((role) => role.available && role.isDefaultChatRole)
        .map((role) => role.id)
    );
  }

  function buildParticipants(snapshot, selectedRoleIds) {
    const selected = selectedRoleIds instanceof Set ? selectedRoleIds : new Set(selectedRoleIds || []);
    return (Array.isArray(snapshot) ? snapshot : [])
      .filter((role) => role.available && selected.has(role.id))
      .map((role) => ({
        agentId: role.id,
        modelProfileId: null,
        conversationSkillIds: [],
      }));
  }

  function createRequestError(code, message) {
    const error = /** @type {Error & { code?: string }} */ (new Error(message));
    error.code = code;
    return error;
  }

  function buildConversationRequest(input) {
    const type = normalizeText(input && input.type) || 'standard';
    const participants = buildParticipants(input && input.snapshot, input && input.selectedRoleIds);
    if (participants.length === 0) {
      throw createRequestError('participants_required', '至少选择一位当前可用的角色');
    }

    return {
      title: normalizeText(input && input.title),
      type,
      participants,
    };
  }

  function requiredRequestText(value, fieldName, code) {
    const normalized = normalizeText(value);
    if (!normalized) {
      throw createRequestError(code, `${fieldName} is required`);
    }
    return normalized;
  }

  function buildConversationSpawnRequest(input) {
    const participants = buildParticipants(input && input.snapshot, input && input.selectedRoleIds);
    if (participants.length === 0) {
      throw createRequestError('participants_required', '至少选择一位当前可用的角色');
    }
    const primaryAgentId = requiredRequestText(
      input && input.primaryAgentId,
      'primaryAgentId',
      'primary_agent_required'
    );
    if (!participants.some((participant) => participant.agentId === primaryAgentId)) {
      throw createRequestError('primary_agent_required', '主理 Agent 必须来自已选择的参与者');
    }

    const request = {
      title: requiredRequestText(input && input.title, 'title', 'title_required'),
      projectScopeId: requiredRequestText(input && input.projectScopeId, 'projectScopeId', 'project_required'),
      participants,
      primaryAgentId,
      initialMessage: requiredRequestText(input && input.initialMessage, 'initialMessage', 'initial_message_required'),
      clientRequestId: requiredRequestText(input && input.clientRequestId, 'clientRequestId', 'client_request_id_required'),
    };
    const sourceMessageId = normalizeText(input && input.sourceMessageId);
    if (sourceMessageId) request.sourceMessageId = sourceMessageId;
    return request;
  }

  function isGameType(type) {
    return GAME_TYPES.has(normalizeText(type));
  }

  function modePolicyLabel(type) {
    if (normalizeText(type) === 'standard') {
      return '默认角色只是本次创建的预选建议，你可以自由增删。';
    }
    if (isGameType(type)) {
      return '游戏模式使用自己的玩家配置：这里的选择就是本房间最终玩家，不读取普通聊天默认。';
    }
    return '该模式要求显式选择参与者，不读取普通聊天默认。';
  }

  function createNewConversationDialogController({ state, dom, helpers, showToast }) {
    const createConversation = helpers && helpers.createConversation;
    const spawnConversation = helpers && helpers.spawnConversation;
    const listProjects = helpers && helpers.listProjects;
    const onCreated = helpers && helpers.onCreated;
    let snapshot = [];
    let selectionByMode = new Map();
    let projectSnapshot = [];
    let returnFocus = null;
    let open = false;
    let submitting = false;
    let dialogMode = 'create';
    let spawnParent = null;
    let spawnSourceMessageId = null;
    let spawnClientRequestId = '';

    function isSpawnMode() {
      return dialogMode === 'spawn';
    }

    function createClientRequestId() {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
      return `spawn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function selectedMode() {
      return normalizeText(dom.newConversationType && dom.newConversationType.value) || 'standard';
    }

    function currentSelection() {
      const modeId = selectedMode();
      if (!selectionByMode.has(modeId)) {
        selectionByMode.set(modeId, initialSelectedRoleIds(snapshot, modeId));
      }
      return selectionByMode.get(modeId);
    }

    function fillSelect(select, entries, emptyLabel) {
      if (!select) return;
      const currentValue = select.value;
      select.replaceChildren();
      if (emptyLabel) {
        const emptyOption = document.createElement('option');
        emptyOption.value = '';
        emptyOption.textContent = emptyLabel;
        select.appendChild(emptyOption);
      }
      entries.forEach((entry) => {
        const option = document.createElement('option');
        option.value = entry.id;
        option.textContent = entry.name || entry.id;
        select.appendChild(option);
      });
      if (currentValue && entries.some((entry) => entry.id === currentValue)) {
        select.value = currentValue;
      } else if (!emptyLabel && entries.some((entry) => entry.id === 'standard')) {
        select.value = 'standard';
      }
    }

    function syncOptions() {
      fillSelect(dom.newConversationType, Array.isArray(state.modes) ? state.modes : [], '');
      renderModeState();
    }

    function syncDialogMode() {
      if (!dom.newConversationDialog) return;
      dom.newConversationDialog.querySelectorAll('.new-conversation-normal-only').forEach((element) => {
        element.classList.toggle('hidden', isSpawnMode());
      });
      dom.newConversationDialog.querySelectorAll('.new-conversation-spawn-only').forEach((element) => {
        element.classList.toggle('hidden', !isSpawnMode());
      });
      if (dom.newConversationDialogTitle) {
        dom.newConversationDialogTitle.textContent = isSpawnMode() ? '派生子会话' : '新建聊天';
      }
      if (dom.newConversationDialogDescription) {
        dom.newConversationDialogDescription.textContent = isSpawnMode()
          ? '显式确认新会话的项目、参与者、主理 Agent 与公开首消息。'
          : '确认后才会创建会话并写入最终参与者。';
      }
      if (dom.newConversationSubmit) {
        dom.newConversationSubmit.textContent = isSpawnMode() ? '创建并启动' : '创建聊天';
      }
    }

    function syncProjectOptions() {
      if (!dom.newConversationProject) return;
      const projectScopeId = normalizeText(spawnParent && spawnParent.projectScopeId);
      const matchingProject = projectSnapshot.find((project) => normalizeText(project && project.id) === projectScopeId);
      const options = matchingProject
        ? [matchingProject]
        : projectScopeId
          ? [{ id: projectScopeId, name: projectScopeId }]
          : [];
      fillSelect(dom.newConversationProject, options, options.length === 0 ? '父会话尚未绑定项目' : '');
      if (projectScopeId) dom.newConversationProject.value = projectScopeId;
      dom.newConversationProject.disabled = options.length === 0;
    }

    function syncPrimaryAgentOptions() {
      if (!dom.newConversationPrimaryAgent) return;
      const selected = currentSelection();
      const entries = snapshot.filter((role) => role.available && selected.has(role.id));
      fillSelect(dom.newConversationPrimaryAgent, entries, '请选择主理 Agent');
    }

    function roleCard(role) {
      const label = document.createElement('label');
      label.className = `new-conversation-role-card${role.available ? '' : ' is-unavailable'}`;
      label.style.setProperty('--role-accent', role.accentColor);

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.name = 'new-conversation-participants';
      checkbox.value = role.id;
      checkbox.checked = role.available && currentSelection().has(role.id);
      checkbox.disabled = !role.available;
      checkbox.addEventListener('change', () => {
        const selected = currentSelection();
        if (checkbox.checked) selected.add(role.id);
        else selected.delete(role.id);
        if (isSpawnMode()) syncPrimaryAgentOptions();
        updateValidation();
      });

      const content = document.createElement('span');
      content.className = 'new-conversation-role-card-content';
      const title = document.createElement('span');
      title.className = 'new-conversation-role-title';
      const name = document.createElement('strong');
      name.textContent = role.name;
      title.appendChild(name);
      if (role.isDefaultChatRole) {
        const badge = document.createElement('span');
        badge.className = 'new-conversation-role-badge';
        badge.textContent = '默认';
        title.appendChild(badge);
      }
      if (!role.available) {
        const badge = document.createElement('span');
        badge.className = 'new-conversation-role-badge warning';
        badge.textContent = '不可用';
        title.appendChild(badge);
      }
      const meta = document.createElement('span');
      meta.className = 'new-conversation-role-meta';
      meta.textContent = role.available
        ? role.description || (role.roleKind === 'model_family' ? `${role.modelFamily || '模型'} 模型族` : '自定义角色')
        : role.unavailableReason;
      content.append(title, meta);
      label.append(checkbox, content);
      return label;
    }

    function renderParticipants() {
      if (!dom.newConversationFamilyParticipants || !dom.newConversationCustomParticipants) return;
      const familyRoles = snapshot.filter((role) => role.roleKind === 'model_family');
      const customRoles = snapshot.filter((role) => role.roleKind === 'custom');
      dom.newConversationFamilyParticipants.replaceChildren(...familyRoles.map(roleCard));
      dom.newConversationCustomParticipants.replaceChildren(...customRoles.map(roleCard));
      if (dom.newConversationCustomGroup) {
        dom.newConversationCustomGroup.classList.toggle('hidden', customRoles.length === 0);
      }
      updateValidation();
    }

    function validationMessage() {
      const type = selectedMode();
      if (isSpawnMode() && !normalizeText(dom.newConversationTitle && dom.newConversationTitle.value)) {
        return '请填写会话标题。';
      }
      if (currentSelection().size === 0) {
        return isGameType(type)
          ? '至少选择一位当前可用的玩家后才能创建游戏房间。'
          : '至少选择一位当前可用的角色后才能创建聊天。';
      }
      if (isSpawnMode()) {
        if (!normalizeText(dom.newConversationProject && dom.newConversationProject.value)) {
          return '父会话需要先绑定项目。';
        }
        if (!normalizeText(dom.newConversationPrimaryAgent && dom.newConversationPrimaryAgent.value)) {
          return '请选择一位已选参与者作为主理 Agent。';
        }
        if (!normalizeText(dom.newConversationInitialMessage && dom.newConversationInitialMessage.value)) {
          return '请填写完整的公开首消息。';
        }
      }
      return '';
    }

    function updateValidation() {
      const message = validationMessage();
      const count = currentSelection().size;
      if (dom.newConversationSelectionCount) dom.newConversationSelectionCount.textContent = String(count);
      if (dom.newConversationError) {
        dom.newConversationError.textContent = message;
        dom.newConversationError.classList.toggle('hidden', !message);
      }
      if (dom.newConversationSubmit) dom.newConversationSubmit.disabled = Boolean(message) || submitting;
    }

    function renderModeState() {
      const type = selectedMode();
      if (dom.newConversationPolicyNote) {
        dom.newConversationPolicyNote.textContent = isSpawnMode()
          ? '参与者与主理 Agent 只对这个全新子会话生效，不会从父会话复制。'
          : modePolicyLabel(type);
      }
      if (dom.newConversationParticipantsTitle) {
        dom.newConversationParticipantsTitle.textContent = isSpawnMode()
          ? '选择子会话参与者'
          : isGameType(type) ? '选择玩家' : '选择参与者';
      }
      if (dom.newConversationClearSelection) {
        dom.newConversationClearSelection.textContent = isGameType(type) ? '清空玩家' : '清空选择';
      }
      if (open) {
        renderParticipants();
        if (isSpawnMode()) syncPrimaryAgentOptions();
      }
      else updateValidation();
    }

    function focusableElements() {
      if (!dom.newConversationDialog) return [];
      return Array.from(dom.newConversationDialog.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      )).filter((element) => !element.closest('.hidden') && element.getClientRects().length > 0);
    }

    function prepareDialog(mode, parentConversation = null, options = {}) {
      if (!dom.newConversationBackdrop || !dom.newConversationTitle || open) return;
      dialogMode = mode;
      spawnParent = parentConversation;
      spawnSourceMessageId = normalizeText(options.sourceMessageId) || null;
      spawnClientRequestId = isSpawnMode() ? createClientRequestId() : '';
      returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : dom.newConversationButton;
      snapshot = snapshotRoles(state.agents);
      selectionByMode = new Map();
      syncOptions();
      if (dom.newConversationType && Array.isArray(state.modes) && state.modes.some((mode) => mode.id === 'standard')) {
        dom.newConversationType.value = 'standard';
      }
      const type = selectedMode();
      selectionByMode.set(type, isSpawnMode() ? new Set() : initialSelectedRoleIds(snapshot, type));
      dom.newConversationTitle.value = '';
      if (dom.newConversationParent) dom.newConversationParent.value = normalizeText(parentConversation && parentConversation.title);
      if (dom.newConversationInitialMessage) dom.newConversationInitialMessage.value = '';
      if (dom.appShell) dom.appShell.inert = true;
      dom.newConversationBackdrop.classList.remove('hidden');
      dom.newConversationBackdrop.setAttribute('aria-hidden', 'false');
      open = true;
      syncDialogMode();
      syncProjectOptions();
      renderModeState();
      window.requestAnimationFrame(() => dom.newConversationTitle.focus());
    }

    function openDialog() {
      prepareDialog('create');
    }

    async function openSpawnDialog(parentConversation, options = {}) {
      if (!parentConversation || !normalizeText(parentConversation.id)) return;
      projectSnapshot = [];
      if (typeof listProjects === 'function') {
        try {
          const result = await listProjects();
          projectSnapshot = Array.isArray(result && result.projects) ? result.projects : [];
        } catch (error) {
          projectSnapshot = [];
        }
      }
      prepareDialog('spawn', parentConversation, options);
    }

    function closeDialog() {
      if (!open || !dom.newConversationBackdrop) return;
      dom.newConversationBackdrop.classList.add('hidden');
      dom.newConversationBackdrop.setAttribute('aria-hidden', 'true');
      if (dom.appShell) dom.appShell.inert = false;
      open = false;
      submitting = false;
      snapshot = [];
      selectionByMode = new Map();
      projectSnapshot = [];
      dialogMode = 'create';
      spawnParent = null;
      spawnSourceMessageId = null;
      spawnClientRequestId = '';
      const target = returnFocus && returnFocus.isConnected ? returnFocus : dom.newConversationButton;
      returnFocus = null;
      if (target && typeof target.focus === 'function') target.focus();
    }

    function handleDialogKeydown(event) {
      if (!open) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDialog();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = focusableElements();
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    async function submit(event) {
      event.preventDefault();
      if (submitting) return;
      let request;
      try {
        request = isSpawnMode()
          ? buildConversationSpawnRequest({
              title: dom.newConversationTitle && dom.newConversationTitle.value,
              projectScopeId: dom.newConversationProject && dom.newConversationProject.value,
              snapshot,
              selectedRoleIds: currentSelection(),
              primaryAgentId: dom.newConversationPrimaryAgent && dom.newConversationPrimaryAgent.value,
              initialMessage: dom.newConversationInitialMessage && dom.newConversationInitialMessage.value,
              sourceMessageId: spawnSourceMessageId,
              clientRequestId: spawnClientRequestId,
            })
          : buildConversationRequest({
              title: dom.newConversationTitle && dom.newConversationTitle.value,
              type: selectedMode(),
              snapshot,
              selectedRoleIds: currentSelection(),
            });
      } catch (error) {
        updateValidation();
        if (showToast) showToast(error && error.message ? error.message : '无法创建聊天');
        return;
      }

      submitting = true;
      updateValidation();
      try {
        const wasSpawn = isSpawnMode();
        const result = wasSpawn
          ? await spawnConversation(normalizeText(spawnParent && spawnParent.id), request)
          : await createConversation(request);
        closeDialog();
        if (typeof onCreated === 'function') onCreated(result);
        if (showToast) showToast(wasSpawn ? '子会话已创建并开始启动' : '新会话已创建');
      } catch (error) {
        submitting = false;
        updateValidation();
        if (showToast) showToast(error && error.message ? error.message : '新会话创建失败');
      }
    }

    function bindEvents() {
      if (dom.newConversationButton) dom.newConversationButton.addEventListener('click', openDialog);
      if (dom.newConversationClose) dom.newConversationClose.addEventListener('click', closeDialog);
      if (dom.newConversationCancel) dom.newConversationCancel.addEventListener('click', closeDialog);
      if (dom.newConversationType) dom.newConversationType.addEventListener('change', renderModeState);
      if (dom.newConversationTitle) dom.newConversationTitle.addEventListener('input', updateValidation);
      if (dom.newConversationProject) dom.newConversationProject.addEventListener('change', updateValidation);
      if (dom.newConversationPrimaryAgent) dom.newConversationPrimaryAgent.addEventListener('change', updateValidation);
      if (dom.newConversationInitialMessage) dom.newConversationInitialMessage.addEventListener('input', updateValidation);
      if (dom.newConversationClearSelection) {
        dom.newConversationClearSelection.addEventListener('click', () => {
          currentSelection().clear();
          renderParticipants();
        });
      }
      if (dom.newConversationForm) dom.newConversationForm.addEventListener('submit', submit);
      if (dom.newConversationBackdrop) {
        dom.newConversationBackdrop.addEventListener('keydown', handleDialogKeydown);
        dom.newConversationBackdrop.addEventListener('click', (event) => {
          if (event.target === dom.newConversationBackdrop) closeDialog();
        });
      }
    }

    return {
      bindEvents,
      close: closeDialog,
      open: openDialog,
      openSpawn: openSpawnDialog,
      syncOptions,
    };
  }

  chat.newConversationDialog = {
    buildConversationRequest,
    buildConversationSpawnRequest,
    buildParticipants,
    initialSelectedRoleIds,
    isGameType,
    modePolicyLabel,
    snapshotRoles,
  };
  chat.createNewConversationDialogController = createNewConversationDialogController;
})();
