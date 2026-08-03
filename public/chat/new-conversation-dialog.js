// @ts-check

(function registerNewConversationDialogModule() {
  const chat = window.CaffChat || (window.CaffChat = {});
  const GAME_TYPES = new Set(['who_is_undercover', 'werewolf']);

  function normalizeText(value) {
    return String(value || '').trim();
  }

  function availabilityReason(availability) {
    const status = normalizeText(availability && availability.status);
    const reasons = {
      base_model_missing: '没有可用模型，请先到模型供应商或角色管理完成配置',
      base_model_unknown: '默认模型已不在当前模型目录中',
      base_model_out_of_family: '默认模型不属于该模型族',
      thinking_level_unsupported: '当前思考强度不受所选模型支持',
      profile_model_missing: '运行 Profile 缺少模型',
      profile_model_unknown: '运行 Profile 引用了失效模型',
      profile_model_out_of_family: '运行 Profile 使用了跨族模型',
      role_missing: '角色配置不存在',
    };
    return reasons[status] || (status && status !== 'available' ? `当前不可用：${status}` : '当前不可用');
  }

  function snapshotRoles(agents) {
    return (Array.isArray(agents) ? agents : [])
      .filter((agent) => agent && normalizeText(agent.id))
      .map((agent) => {
        const availability = agent.availability && typeof agent.availability === 'object'
          ? { ...agent.availability }
          : { status: 'available' };
        const available = normalizeText(availability.status) === 'available';
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
    if (type === 'skill_test_design' && participants.length !== 3) {
      throw createRequestError('skill_test_participant_count_invalid', 'Skill Test 设计模式需要恰好选择 3 位角色');
    }

    const request = {
      title: normalizeText(input && input.title),
      type,
      participants,
    };

    if (type === 'skill_test_design') {
      const skillId = normalizeText(input && input.skillId);
      if (!skillId) {
        throw createRequestError('skill_required', 'Skill Test 设计模式需要选择一个目标 Skill');
      }
      request.skillId = skillId;
      request.metadata = {
        skillTestDesign: { skillId },
      };
    }

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
    const onCreated = helpers && helpers.onCreated;
    let snapshot = [];
    let selectionByMode = new Map();
    let returnFocus = null;
    let open = false;
    let submitting = false;

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
      fillSelect(dom.newConversationSkill, Array.isArray(state.skills) ? state.skills : [], '-- 选择目标 Skill --');
      renderModeState();
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
      if (currentSelection().size === 0) {
        return isGameType(type)
          ? '至少选择一位当前可用的玩家后才能创建游戏房间。'
          : '至少选择一位当前可用的角色后才能创建聊天。';
      }
      if (type === 'skill_test_design' && currentSelection().size !== 3) {
        return 'Skill Test 设计模式需要恰好选择 3 位角色，依次承担规划、评审和记录职责。';
      }
      if (type === 'skill_test_design' && !(dom.newConversationSkill && dom.newConversationSkill.value)) {
        return 'Skill Test 设计模式需要选择一个目标 Skill。';
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
      const skillMode = type === 'skill_test_design';
      if (dom.newConversationSkillField) dom.newConversationSkillField.classList.toggle('hidden', !skillMode);
      if (dom.newConversationPolicyNote) dom.newConversationPolicyNote.textContent = modePolicyLabel(type);
      if (dom.newConversationParticipantsTitle) {
        dom.newConversationParticipantsTitle.textContent = isGameType(type) ? '选择玩家' : '选择参与者';
      }
      if (dom.newConversationClearSelection) {
        dom.newConversationClearSelection.textContent = isGameType(type) ? '清空玩家' : '清空选择';
      }
      if (open) renderParticipants();
      else updateValidation();
    }

    function focusableElements() {
      if (!dom.newConversationDialog) return [];
      return Array.from(dom.newConversationDialog.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      )).filter((element) => !element.closest('.hidden') && element.getClientRects().length > 0);
    }

    function openDialog() {
      if (!dom.newConversationBackdrop || !dom.newConversationTitle || open) return;
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
      selectionByMode.set(type, initialSelectedRoleIds(snapshot, type));
      dom.newConversationTitle.value = '';
      if (dom.newConversationSkill) dom.newConversationSkill.value = '';
      if (dom.appShell) dom.appShell.inert = true;
      dom.newConversationBackdrop.classList.remove('hidden');
      dom.newConversationBackdrop.setAttribute('aria-hidden', 'false');
      open = true;
      renderModeState();
      window.requestAnimationFrame(() => dom.newConversationTitle.focus());
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
      if (submitting || typeof createConversation !== 'function') return;
      let request;
      try {
        request = buildConversationRequest({
          title: dom.newConversationTitle && dom.newConversationTitle.value,
          type: selectedMode(),
          skillId: dom.newConversationSkill && dom.newConversationSkill.value,
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
        const result = await createConversation(request);
        closeDialog();
        if (typeof onCreated === 'function') onCreated(result);
        if (showToast) showToast('新会话已创建');
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
      if (dom.newConversationSkill) dom.newConversationSkill.addEventListener('change', updateValidation);
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
      syncOptions,
    };
  }

  chat.newConversationDialog = {
    buildConversationRequest,
    buildParticipants,
    initialSelectedRoleIds,
    isGameType,
    modePolicyLabel,
    snapshotRoles,
  };
  chat.createNewConversationDialogController = createNewConversationDialogController;
})();
