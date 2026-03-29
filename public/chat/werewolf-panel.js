// @ts-check

(function registerWerewolfPanelModule() {
  const chat = window.CaffChat || (window.CaffChat = {});

  chat.createWerewolfPanelRenderer = function createWerewolfPanelRenderer({ state, dom, helpers }) {
    const {
      activeTurnForConversation,
      isWerewolfConversation,
      werewolfGameState,
      werewolfPlayerEntries,
      werewolfPlayerLabel,
    } = helpers;

    function render() {
      if (!dom.werewolfGameCard) {
        return;
      }

      const conversation = state.currentConversation;
      const game = werewolfGameState(conversation);
      const activeTurn = conversation ? activeTurnForConversation(conversation.id) : null;
      const isGameRoom = isWerewolfConversation(conversation);
      const isBusy = Boolean(state.sending || activeTurn);

      dom.werewolfGameCard.classList.toggle('hidden', !isGameRoom);

      if (!isGameRoom) {
        return;
      }

      const players = werewolfPlayerEntries(conversation);
      const gameStatus = game && game.status ? game.status : 'setup';
      const gamePhase = game && game.phase ? game.phase : 'setup';
      const roundNumber = Number.isInteger(game && game.roundNumber) ? game.roundNumber : 1;
      const config = game && game.config && typeof game.config === 'object' ? game.config : null;

      dom.werewolfGameStatus.textContent =
        gameStatus === 'setup'
          ? `当前还没有开始游戏。请先配置人数并点击“开始全自动新一局”。当前房间共有 ${conversation.agents.length} 名玩家。`
          : gameStatus === 'active'
            ? `全自动托管中 · 阶段：${gamePhase} · 第 ${roundNumber} 轮`
            : `对局已结束 · 状态：${gameStatus} · 第 ${roundNumber} 轮`;

      if (dom.werewolfLastResult) {
        const winnerText =
          game && game.winner
            ? `胜利方：${game.winner.team === 'good' ? '好人阵营' : '狼人阵营'}${
                game.winner.reason ? ` · ${game.winner.reason}` : ''
              }`
            : '';
        const revealText =
          game && Array.isArray(game.revealedAssignments) && game.revealedAssignments.length > 0 ? '本局已完成身份揭晓。' : '';
        const configText =
          config &&
          Number.isInteger(config.werewolfCount) &&
          Number.isInteger(config.seerCount) &&
          Number.isInteger(config.witchCount) &&
          Number.isInteger(config.villagerCount)
            ? `配置：狼人 ${config.werewolfCount} / 预言家 ${config.seerCount} / 女巫 ${config.witchCount} / 村民 ${config.villagerCount}`
            : '';

        dom.werewolfLastResult.textContent =
          winnerText ||
          revealText ||
          configText ||
          '点击开始后，后端会自动推进夜间行动、天亮公布、白天讨论、投票处决与身份揭晓。';
      }

      if (dom.werewolfPlayerStatus) {
        dom.werewolfPlayerStatus.innerHTML = '';

        if (players.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'empty-state compact-empty-state';
          empty.textContent = '开始游戏后，这里会显示玩家存活状态。';
          dom.werewolfPlayerStatus.appendChild(empty);
        } else {
          players.forEach((player) => {
            const chip = document.createElement('div');
            chip.className = `werewolf-player-chip${player.isAlive ? '' : ' is-eliminated'}`;

            const name = document.createElement('strong');
            name.textContent = player.name;

            const meta = document.createElement('span');
            meta.className = 'muted';
            meta.textContent = werewolfPlayerLabel(player);

            chip.append(name, meta);
            dom.werewolfPlayerStatus.appendChild(chip);
          });
        }
      }

      const hasStartedGame = gameStatus !== 'setup';
      const canStart = !isBusy && conversation.agents.length >= 4;
      const canReset = !isBusy && hasStartedGame;

      if (
        gameStatus === 'setup' &&
        !config &&
        dom.werewolfCount &&
        dom.werewolfSeerCount &&
        dom.werewolfWitchCount &&
        conversation &&
        Array.isArray(conversation.agents)
      ) {
        const werewolfCountValue = Number.parseInt(dom.werewolfCount.value || '0', 10) || 0;
        const seerCountValue = Number.parseInt(dom.werewolfSeerCount.value || '0', 10) || 0;
        const witchCountValue = Number.parseInt(dom.werewolfWitchCount.value || '0', 10) || 0;
        const maxWitchCount = Math.max(0, conversation.agents.length - werewolfCountValue - seerCountValue - 1);

        if (witchCountValue > maxWitchCount) {
          dom.werewolfWitchCount.value = String(Math.min(maxWitchCount, 1));
        }
      }

      if (dom.werewolfStartButton) {
        dom.werewolfStartButton.disabled = !canStart;
      }

      if (dom.werewolfResetButton) {
        dom.werewolfResetButton.disabled = !canReset;
      }

      if (dom.werewolfCount && config && Number.isInteger(config.werewolfCount)) {
        dom.werewolfCount.value = String(config.werewolfCount);
      }

      if (dom.werewolfSeerCount && config && Number.isInteger(config.seerCount)) {
        dom.werewolfSeerCount.value = String(config.seerCount);
      }

      if (dom.werewolfWitchCount && config && Number.isInteger(config.witchCount)) {
        dom.werewolfWitchCount.value = String(config.witchCount);
      }
    }

    return {
      render,
    };
  };
})();
