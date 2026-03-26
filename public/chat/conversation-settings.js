// @ts-check

(function registerConversationSettingsModule() {
  const chat = window.CaffChat || (window.CaffChat = {});

  chat.createConversationSettingsController = function createConversationSettingsController({
    state,
    dom,
    helpers,
    showToast,
  }) {
    const { buildAgentAvatarElement, normalizedSkillIds } = helpers;

    function skillById(skillId) {
      return state.skills.find((skill) => skill.id === skillId) || null;
    }

    function skillNames(skillIds, emptyLabel = '无') {
      const names = normalizedSkillIds(skillIds).map((skillId) => {
        const skill = skillById(skillId);
        return skill ? skill.name : skillId;
      });

      return names.length > 0 ? names.join('、') : emptyLabel;
    }

    function fillBulkSkillSelect(selectedSkillId = '') {
      if (!dom.bulkSkillSelect) {
        return;
      }

      dom.bulkSkillSelect.innerHTML = '';

      const defaultOption = document.createElement('option');
      defaultOption.value = '';
      defaultOption.textContent = state.skills.length > 0 ? '请选择一个 Skill...' : '暂无 Skill';
      dom.bulkSkillSelect.appendChild(defaultOption);

      state.skills.forEach((skill) => {
        const option = document.createElement('option');
        option.value = skill.id;
        option.textContent = `${skill.name} (${skill.id})`;
        dom.bulkSkillSelect.appendChild(option);
      });

      dom.bulkSkillSelect.value = selectedSkillId && state.skills.some((skill) => skill.id === selectedSkillId) ? selectedSkillId : '';
    }

    function renderSkillChecklist(container, inputName, selectedSkillIds, disabled) {
      if (!container) {
        return;
      }

      container.innerHTML = '';

      if (!Array.isArray(state.skills) || state.skills.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state compact-empty-state';
        empty.textContent = '当前还没有可用 Skill，请先去 Skill 管理页创建。';
        container.appendChild(empty);
        return;
      }

      const selected = new Set(normalizedSkillIds(selectedSkillIds));

      state.skills.forEach((skill) => {
        const option = document.createElement('label');
        option.className = 'option-card compact-option-card skill-option-card';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.name = inputName;
        checkbox.value = skill.id;
        checkbox.checked = selected.has(skill.id);
        checkbox.disabled = disabled;

        const content = document.createElement('div');
        content.className = 'persona-option-content';

        const name = document.createElement('strong');
        name.className = 'persona-option-name';
        name.textContent = skill.name;

        const description = document.createElement('div');
        description.className = 'muted persona-option-description';
        description.textContent = skill.description || skill.id;

        const pathLine = document.createElement('div');
        pathLine.className = 'muted persona-option-description';
        pathLine.textContent = skill.id;

        content.append(name, description, pathLine);
        option.append(checkbox, content);
        container.appendChild(option);
      });
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

    function profileChoiceTitle(profile) {
      if (!profile) {
        return '默认配置';
      }

      return profile.id ? profile.name || '未命名配置' : '默认配置';
    }

    function profileChoiceMeta(profile) {
      if (!profile) {
        return '使用基础人格';
      }

      if (profile.description) {
        return profile.description;
      }

      const parts = [];

      if (profile.model) {
        parts.push(profile.model);
      }

      if (profile.provider) {
        parts.push(profile.provider);
      }

      if (!profile.id) {
        return parts.length > 0 ? parts.join(' / ') : '使用基础人格';
      }

      return parts.length > 0 ? parts.join(' / ') : '模型专属配置';
    }

    function closeAllProfileMenus(exceptGroup = null) {
      Array.from(document.querySelectorAll('.profile-choice-group.is-open')).forEach((group) => {
        if (exceptGroup && group === exceptGroup) {
          return;
        }

        group.classList.remove('is-open');

        const trigger = group.querySelector('.profile-dropdown-trigger');

        if (trigger) {
          trigger.setAttribute('aria-expanded', 'false');
        }
      });
    }

    function setProfileSelectorValue(group, profileId) {
      if (!group) {
        return;
      }

      const hiddenInput = group.querySelector('input[data-role="profile-value"]');

      if (!hiddenInput) {
        return;
      }

      const nextValue = String(profileId || '').trim();
      hiddenInput.value = nextValue;

      Array.from(group.querySelectorAll('.profile-dropdown-option')).forEach((button) => {
        const isActive = String(button.dataset.profileId || '').trim() === nextValue;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });

      const activeButton =
        Array.from(group.querySelectorAll('.profile-dropdown-option')).find(
          (button) => String(button.dataset.profileId || '').trim() === nextValue
        ) || group.querySelector('.profile-dropdown-option');
      const trigger = group.querySelector('.profile-dropdown-trigger');
      const triggerTitle = group.querySelector('.profile-dropdown-trigger-title');
      const triggerMeta = group.querySelector('.profile-dropdown-trigger-meta');

      if (activeButton && triggerTitle) {
        const nextTitle = activeButton.querySelector('.profile-choice-title');
        triggerTitle.textContent = nextTitle ? nextTitle.textContent : '默认配置';
      }

      if (activeButton && triggerMeta) {
        const nextMeta = activeButton.querySelector('.profile-choice-meta');
        triggerMeta.textContent = nextMeta ? nextMeta.textContent : '';
      }

      if (trigger && activeButton) {
        trigger.title = activeButton.title || '';
      }
    }

    function setProfileSelectorDisabled(group, disabled) {
      if (!group) {
        return;
      }

      const isDisabled = Boolean(disabled);
      const hiddenInput = group.querySelector('input[data-role="profile-value"]');

      if (hiddenInput) {
        hiddenInput.disabled = isDisabled;
      }

      group.classList.toggle('is-disabled', isDisabled);
      group.classList.remove('is-open');

      const trigger = group.querySelector('.profile-dropdown-trigger');

      if (trigger) {
        trigger.disabled = isDisabled;
        trigger.setAttribute('aria-expanded', 'false');
      }

      Array.from(group.querySelectorAll('.profile-dropdown-option')).forEach((button) => {
        button.disabled = isDisabled;
      });
    }

    function toggleProfileSelector(group, forceOpen) {
      if (!group || group.classList.contains('is-disabled')) {
        return;
      }

      const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : !group.classList.contains('is-open');
      const trigger = group.querySelector('.profile-dropdown-trigger');

      if (nextOpen) {
        closeAllProfileMenus(group);
      }

      group.classList.toggle('is-open', nextOpen);

      if (trigger) {
        trigger.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
      }
    }

    function createConversationProfileSelector(agent, selectedProfileId, disabled, labelText = '人格配置') {
      const profileRow = document.createElement('div');
      profileRow.className = 'profile-select-row persona-option-config';

      const profileLabel = document.createElement('div');
      profileLabel.className = 'muted persona-option-config-label';
      profileLabel.textContent = labelText;

      const profileGroup = document.createElement('div');
      profileGroup.className = 'profile-choice-group';
      profileGroup.dataset.agentId = agent.id;

      const profileInput = document.createElement('input');
      profileInput.type = 'hidden';
      profileInput.dataset.role = 'profile-value';
      profileInput.value = String(selectedProfileId || '').trim();
      profileGroup.appendChild(profileInput);

      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'profile-dropdown-trigger';
      trigger.dataset.role = 'profile-trigger';
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false');

      const triggerCopy = document.createElement('span');
      triggerCopy.className = 'profile-dropdown-trigger-copy';

      const triggerTitle = document.createElement('span');
      triggerTitle.className = 'profile-dropdown-trigger-title';

      const triggerMeta = document.createElement('span');
      triggerMeta.className = 'profile-dropdown-trigger-meta';

      triggerCopy.append(triggerTitle, triggerMeta);

      const caret = document.createElement('span');
      caret.className = 'profile-dropdown-caret';
      caret.textContent = '▾';

      trigger.append(triggerCopy, caret);
      profileGroup.appendChild(trigger);

      const menu = document.createElement('div');
      menu.className = 'profile-dropdown-menu';
      menu.setAttribute('role', 'listbox');

      modelProfilesForAgent(agent).forEach((profile) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'profile-choice-chip profile-dropdown-option';
        button.dataset.profileId = profile.id;
        button.title = describeModelProfile(agent, profile.id);
        button.setAttribute('role', 'option');

        const title = document.createElement('span');
        title.className = 'profile-choice-title';
        title.textContent = profileChoiceTitle(profile);

        const meta = document.createElement('span');
        meta.className = 'profile-choice-meta';
        meta.textContent = profileChoiceMeta(profile);

        button.append(title, meta);
        menu.appendChild(button);
      });

      profileGroup.appendChild(menu);

      setProfileSelectorValue(profileGroup, selectedProfileId);
      setProfileSelectorDisabled(profileGroup, disabled);
      profileRow.append(profileLabel, profileGroup);
      return profileRow;
    }

    function render() {
      const conversation = state.currentConversation;
      const disabled = !conversation || state.sending;
      const disableSkillControls = disabled || state.agents.length === 0 || state.skills.length === 0;

      if (dom.saveConversationButton) {
        dom.saveConversationButton.disabled = disabled;
      }

      fillBulkSkillSelect(dom.bulkSkillSelect ? dom.bulkSkillSelect.value : '');

      if (dom.bulkSkillSelect) {
        dom.bulkSkillSelect.disabled = disableSkillControls;
      }

      if (dom.applyBulkSkillButton) {
        dom.applyBulkSkillButton.disabled = disableSkillControls;
      }

      if (dom.clearBulkSkillButton) {
        dom.clearBulkSkillButton.disabled = disabled;
      }

      dom.conversationAgentOptions.innerHTML = '';

      if (!conversation) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = '选中一个对话后，再来设置参与人格。';
        dom.conversationAgentOptions.appendChild(empty);
        return;
      }

      if (state.agents.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = '还没有人格，请先去人格管理页创建。';
        dom.conversationAgentOptions.appendChild(empty);
        return;
      }

      state.agents.forEach((agent) => {
        const selectedConversationAgent = conversation.agents.find((item) => item.id === agent.id) || null;
        const selectedProfileId = selectedConversationAgent ? selectedConversationAgent.selectedModelProfileId || '' : '';
        const selectedConversationSkillIds = selectedConversationAgent
          ? normalizedSkillIds(selectedConversationAgent.conversationSkillIds || selectedConversationAgent.conversationSkills)
          : [];

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
        description.textContent = agent.description || '暂无描述';

        nameWrap.append(name, description);
        titleLine.append(avatar, nameWrap);

        const profileRow = createConversationProfileSelector(
          agent,
          selectedProfileId,
          disabled || !selectedConversationAgent,
          '人格配置'
        );
        profileRow.classList.toggle('hidden', !selectedConversationAgent);

        content.append(titleLine);
        label.append(checkbox, content);
        wrapper.append(label, profileRow);

        const baseSkillSummary = document.createElement('div');
        baseSkillSummary.className = 'muted persona-skill-summary';
        baseSkillSummary.textContent = `人格常驻 Skill：${skillNames(agent.skillIds || agent.skills, '无')}`;
        wrapper.appendChild(baseSkillSummary);

        const conversationSkillPanel = document.createElement('div');
        conversationSkillPanel.className = 'conversation-skill-panel';
        conversationSkillPanel.classList.toggle('hidden', !selectedConversationAgent);

        const conversationSkillHeader = document.createElement('div');
        conversationSkillHeader.className = 'section-row';

        const conversationSkillCopy = document.createElement('div');

        const conversationSkillLabel = document.createElement('div');
        conversationSkillLabel.className = 'section-label';
        conversationSkillLabel.textContent = '会话 Skill';

        const conversationSkillHint = document.createElement('div');
        conversationSkillHint.className = 'section-hint';
        conversationSkillHint.textContent = '只在当前房间生效。';

        conversationSkillCopy.append(conversationSkillLabel, conversationSkillHint);
        conversationSkillHeader.append(conversationSkillCopy);

        const conversationSkillList = document.createElement('div');
        conversationSkillList.className = 'option-list conversation-skill-list';
        renderSkillChecklist(
          conversationSkillList,
          `conversation-skill-${agent.id}`,
          selectedConversationSkillIds,
          disabled || !selectedConversationAgent
        );

        conversationSkillPanel.append(conversationSkillHeader, conversationSkillList);
        wrapper.appendChild(conversationSkillPanel);
        dom.conversationAgentOptions.appendChild(wrapper);
      });
    }

    function selectedParticipants() {
      return Array.from(dom.conversationAgentOptions.querySelectorAll('.option-card')).flatMap((card) => {
        const checkbox = card.querySelector('input[name="conversation-agent"]');
        const profileInput = card.querySelector('input[data-role="profile-value"]');

        if (!checkbox || !checkbox.checked) {
          return [];
        }

        const conversationSkillIds = Array.from(
          card.querySelectorAll(`input[name="conversation-skill-${checkbox.value}"]:checked`)
        ).map((input) => input.value);

        return [
          {
            agentId: checkbox.value,
            modelProfileId: profileInput && profileInput.value ? profileInput.value : null,
            conversationSkillIds,
          },
        ];
      });
    }

    function bindEvents() {
      if (dom.conversationAgentOptions) {
        dom.conversationAgentOptions.addEventListener('change', (event) => {
          const checkbox = event.target.closest('input[name="conversation-agent"]');

          if (!checkbox) {
            return;
          }

          const card = checkbox.closest('.option-card');
          const profileGroup = card ? card.querySelector('.profile-choice-group') : null;
          const profileRow = card ? card.querySelector('.profile-select-row') : null;
          const skillPanel = card ? card.querySelector('.conversation-skill-panel') : null;

          setProfileSelectorDisabled(profileGroup, !checkbox.checked || state.sending);

          if (profileRow) {
            profileRow.classList.toggle('hidden', !checkbox.checked);
          }

          if (card) {
            card.classList.toggle('is-selected', checkbox.checked);
          }

          if (skillPanel) {
            skillPanel.classList.toggle('hidden', !checkbox.checked);
          }

          Array.from(card ? card.querySelectorAll(`input[name="conversation-skill-${checkbox.value}"]`) : []).forEach((input) => {
            input.disabled = !checkbox.checked || state.sending;
          });
        });

        dom.conversationAgentOptions.addEventListener('click', (event) => {
          const profileTrigger = event.target.closest('.profile-dropdown-trigger');
          const profileOption = event.target.closest('.profile-dropdown-option');

          if (!profileTrigger && !profileOption) {
            return;
          }

          const profileGroup = (profileTrigger || profileOption).closest('.profile-choice-group');
          const card = (profileTrigger || profileOption).closest('.option-card');
          const checkbox = card ? card.querySelector('input[name="conversation-agent"]') : null;

          if (!profileGroup || !checkbox || !checkbox.checked) {
            return;
          }

          event.preventDefault();

          if (profileTrigger) {
            if (profileTrigger.disabled) {
              return;
            }

            toggleProfileSelector(profileGroup);
            return;
          }

          if (profileOption.disabled) {
            return;
          }

          setProfileSelectorValue(profileGroup, profileOption.dataset.profileId || '');
          toggleProfileSelector(profileGroup, false);
        });
      }

      document.addEventListener('click', (event) => {
        if (event.target instanceof Element && event.target.closest('.profile-choice-group')) {
          return;
        }

        closeAllProfileMenus();
      });

      if (dom.applyBulkSkillButton) {
        dom.applyBulkSkillButton.addEventListener(
          'click',
          (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();

            const skillId = dom.bulkSkillSelect ? dom.bulkSkillSelect.value : '';

            if (!skillId) {
              showToast('请先选择一个 Skill。');
              return;
            }

            const selectedCards = Array.from(dom.conversationAgentOptions.querySelectorAll('.option-card')).filter((card) => {
              const checkbox = card.querySelector('input[name="conversation-agent"]');
              return Boolean(checkbox && checkbox.checked);
            });

            if (selectedCards.length === 0) {
              showToast('请先至少勾选一个参与人格。');
              return;
            }

            selectedCards.forEach((card) => {
              const checkbox = card.querySelector('input[name="conversation-agent"]');
              const skillCheckbox = checkbox
                ? card.querySelector(`input[name="conversation-skill-${checkbox.value}"][value="${skillId}"]`)
                : null;

              if (skillCheckbox) {
                skillCheckbox.checked = true;
              }
            });

            showToast(`已将 ${skillId} 批量分配给 ${selectedCards.length} 个已选人格。`);
          },
          true
        );
      }

      if (dom.clearBulkSkillButton) {
        dom.clearBulkSkillButton.addEventListener(
          'click',
          (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();

            if (dom.bulkSkillSelect) {
              dom.bulkSkillSelect.value = '';
            }
          },
          true
        );
      }
    }

    return {
      bindEvents,
      closeAllProfileMenus,
      render,
      selectedModelProfileName,
      selectedParticipants,
      setProfileSelectorDisabled,
      setProfileSelectorValue,
      toggleProfileSelector,
    };
  };
})();
