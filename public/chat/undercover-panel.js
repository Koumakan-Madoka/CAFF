// @ts-check

(function registerUndercoverPanelModule() {
  const chat = window.CaffChat || (window.CaffChat = {});

  chat.createUndercoverPanelRenderer = function createUndercoverPanelRenderer({ state, dom, helpers }) {
    const {
      activeTurnForConversation,
      isUndercoverConversation,
      undercoverGameState,
      undercoverPlayerEntries,
      undercoverPlayerLabel,
    } = helpers;

    function render() {
      if (!dom.undercoverGameCard) {
        return;
      }

      const conversation = state.currentConversation;
      const game = undercoverGameState(conversation);
      const activeTurn = conversation ? activeTurnForConversation(conversation.id) : null;
      const isGameRoom = isUndercoverConversation(conversation);
      const isBusy = Boolean(state.sending || activeTurn);

      dom.undercoverGameCard.classList.toggle('hidden', !isGameRoom);

      if (!isGameRoom) {
        return;
      }

      const players = undercoverPlayerEntries(conversation);
      const gameStatus = game && game.status ? game.status : 'setup';
      const gamePhase = game && game.phase ? game.phase : 'setup';
      const roundNumber = Number.isInteger(game && game.roundNumber) ? game.roundNumber : 1;

      dom.undercoverGameStatus.textContent =
        gameStatus === 'setup'
          ? `当前还没有开始游戏。请先配置词语并点击“开始全自动新一局”。当前房间共有 ${conversation.agents.length} 名玩家。`
          : gameStatus === 'active'
            ? `全自动托管中 · 阶段：${gamePhase} · 第 ${roundNumber} 轮`
            : `对局已结束 · 状态：${gameStatus} · 第 ${roundNumber} 轮`;

      if (dom.undercoverLastResult) {
        const winnerText =
          game && game.winner
            ? `胜利方：${game.winner.team === 'civilian' ? '平民阵营' : '卧底阵营'}${
                game.winner.reason ? ` · ${game.winner.reason}` : ''
              }`
            : '';
        const voteText =
          game && game.lastVote && game.lastVote.eliminatedName
            ? `上一轮出局：${game.lastVote.eliminatedName}${
                game.lastVote.resolution === 'tie_break_by_seat_order'
                  ? ' · 并列后按座位顺序裁定'
                  : game.lastVote.resolution === 'no_valid_votes_fallback'
                    ? ' · 无有效票后按座位顺序自动裁定'
                    : ''
              }`
            : '';
        dom.undercoverLastResult.textContent = winnerText || voteText || '后端会在开局后自动完成发言、投票、结算与身份揭晓。';
      }

      if (dom.undercoverPlayerStatus) {
        dom.undercoverPlayerStatus.innerHTML = '';

        if (players.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'empty-state compact-empty-state';
          empty.textContent = '开始游戏后，这里会显示玩家存活状态。';
          dom.undercoverPlayerStatus.appendChild(empty);
        } else {
          players.forEach((player) => {
            const chip = document.createElement('div');
            chip.className = `undercover-player-chip${player.isAlive ? '' : ' is-eliminated'}`;

            const name = document.createElement('strong');
            name.textContent = player.name;

            const meta = document.createElement('span');
            meta.className = 'muted';
            meta.textContent = undercoverPlayerLabel(player);

            chip.append(name, meta);
            dom.undercoverPlayerStatus.appendChild(chip);
          });
        }
      }

      const hasStartedGame = gameStatus !== 'setup';
      const canStart = !isBusy && conversation.agents.length >= 3;
      const canReset = !isBusy && hasStartedGame;

      if (dom.undercoverStartButton) {
        dom.undercoverStartButton.disabled = !canStart;
      }

      if (dom.undercoverResetButton) {
        dom.undercoverResetButton.disabled = !canReset;
      }

      if (dom.undercoverUndercoverCount && game && game.config && Number.isInteger(game.config.undercoverCount)) {
        dom.undercoverUndercoverCount.value = String(game.config.undercoverCount);
      }

      if (dom.undercoverBlankCount && game && game.config && Number.isInteger(game.config.blankCount)) {
        dom.undercoverBlankCount.value = String(game.config.blankCount);
      }
    }

    return {
      render,
    };
  };
})();
