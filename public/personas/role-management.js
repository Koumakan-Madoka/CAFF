// @ts-check

(function registerRoleManagement() {
  const namespace = window.CaffPersonas || (window.CaffPersonas = {});
  const shared = window.CaffShared || (window.CaffShared = {});

  namespace.createRoleManagement = function createRoleManagement(options) {
    const utils = namespace.managementUtils;
    const familyList = options.familyList;
    const customList = options.customList;
    let agents = [];
    let modelOptions = [];
    let skills = [];
    let selectedRoleId = '';

    const editor = namespace.createRoleEditor({
      root: options.detail,
      avatarUtils: options.avatarUtils,
      getModelOptions: () => modelOptions,
      getSkills: () => skills,
      showToast: options.showToast,
      onManageProviders: options.onManageProviders,
      onDraftChange: (draft) => {
        const role = agents.find((item) => item.id === draft.id);
        if (role) role.isDefaultChatRole = draft.isDefaultChatRole;
        renderLists();
      },
      onSave: async (draft, payload) => {
        if (draft.roleKind === 'custom' && !String(payload.name || '').trim()) throw new Error('角色名称不能为空');
        const result = await options.fetchJson(draft.id ? `/api/agents/${encodeURIComponent(draft.id)}` : '/api/agents', {
          method: draft.id ? 'PUT' : 'POST', body: payload,
        });
        setDirectory(result, result.agent && result.agent.id);
        options.showToast(draft.id ? '角色已保存' : '自定义角色已创建');
      },
      onDelete: async (draft) => {
        if (!window.confirm(`确定删除自定义角色“${draft.name}”吗？历史身份与消息仍会保留。`)) return;
        const result = await options.fetchJson(`/api/agents/${encodeURIComponent(draft.id)}`, { method: 'DELETE' });
        setDirectory(result);
        options.showToast('自定义角色已删除，历史身份已保留');
      },
    });

    function listRow(role) {
      const available = role.availability && role.availability.status === 'available';
      const { row: item, button } = shared.createManagementListItem({
        id: role.id,
        active: role.id === selectedRoleId,
      });
      button.classList.add('management-list-row');
      if (!available) button.classList.add('unavailable');
      button.dataset.roleId = role.id;
      const avatar = options.avatarUtils.buildAgentAvatarElement(role, 'small');
      const copy = document.createElement('span');
      copy.className = 'management-list-copy';
      const name = document.createElement('strong');
      name.textContent = role.name;
      const meta = document.createElement('small');
      meta.textContent = role.roleKind === 'model_family'
        ? `${utils.familyLabel(role.modelFamily)} · ${utils.availabilityCopy(role.availability)}`
        : '自定义角色 · Persona / Skills';
      copy.append(name, meta);
      const status = document.createElement('span');
      status.className = `status-dot${role.isDefaultChatRole ? ' default' : ''}${available ? '' : ' warning'}`;
      status.title = role.isDefaultChatRole ? '新建聊天默认预选' : utils.availabilityCopy(role.availability);
      button.append(avatar, copy, status);
      button.addEventListener('click', () => selectRole(role.id));
      return item;
    }

    function renderLists() {
      familyList.innerHTML = '';
      customList.innerHTML = '';
      const familyRoles = agents.filter((role) => role.roleKind === 'model_family');
      const customRoles = agents.filter((role) => role.roleKind !== 'model_family');
      familyRoles.forEach((role) => familyList.appendChild(listRow(role)));
      customRoles.forEach((role) => customList.appendChild(listRow(role)));
      if (!customRoles.length) customList.innerHTML = '<li class="empty-state">还没有自定义角色。</li>';
      options.familyCount.textContent = `${familyRoles.length} 个固定身份`;
      options.customCount.textContent = `${customRoles.length} 个自定义角色`;
    }

    function selectRole(roleId) {
      selectedRoleId = roleId;
      renderLists();
      const role = agents.find((item) => item.id === roleId);
      editor.show(role || null);
    }

    function setDirectory(directory, preferredRoleId = '') {
      agents = Array.isArray(directory.agents) ? directory.agents : agents;
      modelOptions = Array.isArray(directory.modelOptions) ? directory.modelOptions : modelOptions;
      skills = Array.isArray(directory.skills) ? directory.skills : skills;
      selectedRoleId = preferredRoleId && agents.some((role) => role.id === preferredRoleId)
        ? preferredRoleId
        : selectedRoleId && agents.some((role) => role.id === selectedRoleId)
          ? selectedRoleId
          : agents[0] && agents[0].id || '';
      renderLists();
      editor.show(agents.find((role) => role.id === selectedRoleId) || null);
    }

    options.newRoleButton.addEventListener('click', () => {
      selectedRoleId = '';
      renderLists();
      editor.show({
        id: '', name: '', description: '', sandboxName: '', avatarDataUrl: '', personaPrompt: '', provider: '', model: '',
        thinking: '', accentColor: '#3d405b', skillIds: [], modelProfiles: [], roleKind: 'custom', modelFamily: null,
        isDefaultChatRole: false, availability: { status: 'available', familyModelCount: 0 },
      });
      const name = document.getElementById('role-name');
      if (name) name.focus();
    });

    return {
      async refresh(preferredRoleId = '') {
        const directory = await options.fetchJson('/api/agents');
        setDirectory(directory, preferredRoleId || selectedRoleId);
      },
      setDirectory,
    };
  };
})();
