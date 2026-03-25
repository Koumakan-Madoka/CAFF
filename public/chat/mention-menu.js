(function registerMentionMenuModule() {
  const chat = window.CaffChat || (window.CaffChat = {});

  function normalizeMentionValue(value) {
    return String(value || '')
      .trim()
      .replace(/^@+/, '')
      .replace(/^[^\p{L}\p{N}_-]+/gu, '')
      .replace(/[^\p{L}\p{N}._-]+$/gu, '')
      .replace(/\s+/g, '')
      .toLowerCase();
  }

  function isAsciiMentionBoundaryChar(value) {
    return /[A-Za-z0-9_]/.test(String(value || ''));
  }

  function isMentionTokenQuery(value) {
    return /^[\p{L}\p{N}._-]*$/u.test(String(value || ''));
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

    if (before && isAsciiMentionBoundaryChar(before)) {
      return null;
    }

    const query = prefix.slice(atIndex + 1);

    if (!isMentionTokenQuery(query)) {
      return null;
    }

    return {
      start: atIndex,
      end: safeCursor,
      query,
    };
  }

  chat.createMentionMenuController = function createMentionMenuController({ state, dom }) {
    function mentionableAgents() {
      return state.currentConversation && Array.isArray(state.currentConversation.agents) ? state.currentConversation.agents : [];
    }

    function closeMenu() {
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

    function renderMenu() {
      if (!dom.composerMentionMenu || state.mentionSuggestions.length === 0) {
        closeMenu();
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

    function syncMenu() {
      if (!dom.composerInput || dom.composerInput.disabled) {
        closeMenu();
        return;
      }

      const context = findComposerMentionContext(dom.composerInput.value, dom.composerInput.selectionStart);

      if (!context) {
        closeMenu();
        return;
      }

      const suggestions = buildMentionSuggestions(context.query);

      if (suggestions.length === 0) {
        closeMenu();
        return;
      }

      state.activeMentionContext = context;
      state.mentionSuggestions = suggestions;
      state.mentionSelectionIndex = Math.min(state.mentionSelectionIndex, suggestions.length - 1);
      renderMenu();
    }

    function applySuggestion(agent) {
      const context = state.activeMentionContext;

      if (!agent || !context) {
        closeMenu();
        return;
      }

      const mentionText = `${agentMentionHandle(agent)} `;
      const currentValue = dom.composerInput.value;
      const nextValue = `${currentValue.slice(0, context.start)}${mentionText}${currentValue.slice(context.end)}`;
      const nextCursor = context.start + mentionText.length;

      dom.composerInput.value = nextValue;
      dom.composerInput.focus();
      dom.composerInput.setSelectionRange(nextCursor, nextCursor);
      closeMenu();
    }

    function appendHighlightedMessageBody(container, text, agents) {
      const source = String(text || '');
      const mentionRegex = /\*\*@([\p{L}\p{N}._-]+)\*\*|@([\p{L}\p{N}._-]+)/gu;
      let lastIndex = 0;
      let match;

      while ((match = mentionRegex.exec(source)) !== null) {
        const boldToken = match[1] || '';
        const plainToken = match[2] || '';
        const token = boldToken || plainToken;

        if (!token) {
          continue;
        }

        if (!boldToken) {
          const before = match.index === 0 ? '' : source[match.index - 1];

          if (before && isAsciiMentionBoundaryChar(before)) {
            continue;
          }
        }

        const mentionText = `@${token}`;

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

    function bindEvents() {
      if (dom.composerInput) {
        dom.composerInput.addEventListener('input', () => {
          syncMenu();
        });

        dom.composerInput.addEventListener('click', () => {
          syncMenu();
        });

        dom.composerInput.addEventListener('blur', () => {
          window.setTimeout(() => {
            closeMenu();
          }, 120);
        });

        dom.composerInput.addEventListener('keydown', (event) => {
          if (state.mentionSuggestions.length === 0) {
            return;
          }

          if (event.key === 'ArrowDown') {
            event.preventDefault();
            state.mentionSelectionIndex = (state.mentionSelectionIndex + 1) % state.mentionSuggestions.length;
            renderMenu();
            return;
          }

          if (event.key === 'ArrowUp') {
            event.preventDefault();
            state.mentionSelectionIndex =
              (state.mentionSelectionIndex - 1 + state.mentionSuggestions.length) % state.mentionSuggestions.length;
            renderMenu();
            return;
          }

          if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            applySuggestion(state.mentionSuggestions[state.mentionSelectionIndex]);
            return;
          }

          if (event.key === 'Escape') {
            event.preventDefault();
            closeMenu();
          }
        });
      }

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

          applySuggestion(state.mentionSuggestions[index]);
        });
      }
    }

    return {
      appendHighlightedMessageBody,
      bindEvents,
      closeMenu,
      syncMenu,
    };
  };
})();
