(function registerParticipantPaneModule() {
  const chat = window.CaffChat || (window.CaffChat = {});

  chat.createParticipantPaneRenderer = function createParticipantPaneRenderer({ dom, helpers }) {
    const { buildAgentAvatarElement, normalizedSkillIds, selectedModelProfileName } = helpers;

    function render(conversation) {
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
                  normalizedSkillIds(agent.conversationSkillIds || agent.conversationSkills).length,
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
        description.textContent = `${agent.description || '未填写角色说明'} · ${selectedModelProfileName(agent)} · 会话 Skill ${
          normalizedSkillIds(agent.conversationSkillIds || agent.conversationSkills).length
        }`;

        text.append(name, description);
        chip.append(avatar, text);
        dom.participantList.appendChild(chip);
      });
    }

    return {
      render,
    };
  };
})();
