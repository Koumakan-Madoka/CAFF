const { randomUUID } = require('node:crypto');
const { createHttpError } = require('../../http/http-errors');
const { pickConversationSummary } = require('../conversation/conversation-view');
const { buildAgentMentionLookup, extractMentionedAgentIds, resolveMentionValues } = require('../conversation/mention-routing');
const {
  UNDERCOVER_CONVERSATION_TYPE,
  UNDERCOVER_SKILL_ID,
} = require('../../../lib/who-is-undercover-game');

export function createUndercoverService(options: any = {}) {
  const store = options.store;
  const skillRegistry = options.skillRegistry;
  const undercoverHost = options.undercoverHost;
  const turnOrchestrator = options.turnOrchestrator;
  const broadcastEvent = typeof options.broadcastEvent === 'function' ? options.broadcastEvent : () => {};
  const broadcastConversationSummary =
    typeof options.broadcastConversationSummary === 'function' ? options.broadcastConversationSummary : () => {};
  const activeAutoRuns = new Map();

  function getConversationMetadata(conversation) {
    return conversation && conversation.metadata && typeof conversation.metadata === 'object' ? conversation.metadata : {};
  }

  function buildUndercoverConversationMetadata(conversation, stateOverride) {
    return {
      ...getConversationMetadata(conversation),
      undercoverGame: undercoverHost.buildPublicState(
        stateOverride === undefined ? undercoverHost.loadState(conversation.id) : stateOverride
      ),
    };
  }

  function syncUndercoverConversationMetadata(conversationId, stateOverride = undefined) {
    const conversation = store.getConversation(conversationId);

    if (!conversation || conversation.type !== UNDERCOVER_CONVERSATION_TYPE) {
      return conversation;
    }

    return store.updateConversation(conversationId, {
      title: conversation.title,
      type: conversation.type,
      metadata: buildUndercoverConversationMetadata(conversation, stateOverride),
    });
  }

  function mergeConversationSkillIds(skillIds, requiredSkillId) {
    const merged = new Set(
      (Array.isArray(skillIds) ? skillIds : [])
        .map((skillId) => String(skillId || '').trim())
        .filter(Boolean)
    );

    if (requiredSkillId) {
      merged.add(String(requiredSkillId).trim());
    }

    return Array.from(merged);
  }

  function syncUndercoverConversationParticipants(conversationId) {
    const conversation = store.getConversation(conversationId);

    if (!conversation || conversation.type !== UNDERCOVER_CONVERSATION_TYPE) {
      return conversation;
    }

    return store.updateConversation(conversationId, {
      title: conversation.title,
      type: conversation.type,
      metadata: getConversationMetadata(conversation),
      participants: (Array.isArray(conversation.agents) ? conversation.agents : []).map((agent) => ({
        agentId: agent.id,
        modelProfileId: agent.selectedModelProfileId || null,
        conversationSkillIds: mergeConversationSkillIds(agent.conversationSkillIds, UNDERCOVER_SKILL_ID),
      })),
    });
  }

  function prepareConversation(conversationId) {
    syncUndercoverConversationMetadata(conversationId);
    return syncUndercoverConversationParticipants(conversationId);
  }

  function createSystemMessage(conversationId, content, metadata = {}) {
    return store.createMessage({
      conversationId,
      turnId: randomUUID(),
      role: 'system',
      senderName: '主持人',
      content,
      status: 'completed',
      metadata: {
        source: 'undercover-host',
        ...metadata,
      },
    });
  }

  function broadcastConversationRefresh(conversationId, message) {
    if (message) {
      broadcastEvent('conversation_message_created', {
        conversationId,
        message,
      });
    }

    broadcastConversationSummary(conversationId);
  }

  function requireConversation(conversationId) {
    const conversation = store.getConversation(conversationId);

    if (!conversation) {
      throw createHttpError(404, '会话不存在');
    }

    try {
      undercoverHost.assertConversation(conversation);
    } catch (error) {
      throw createHttpError(400, error.message || '无效的谁是卧底房间');
    }

    return conversation;
  }

  function requireState(conversationId) {
    const state = undercoverHost.loadState(conversationId);

    if (!state) {
      throw createHttpError(400, '请先开始一局谁是卧底');
    }

    return state;
  }

  function canChatInConversation(conversationId) {
    const state = undercoverHost.loadState(conversationId);

    if (!state) {
      return false;
    }

    return state.phase === 'finished' || state.status === 'completed' || state.status === 'revealed';
  }

  function buildRoundParticipantsLabel(alivePlayers) {
    return (Array.isArray(alivePlayers) ? alivePlayers : [])
      .map((player) => `@${String(player.name || '').replace(/\s+/g, '')}`)
      .join(' ');
  }

  function buildCluePrompt(state, alivePlayers) {
    const roundNumber = Number.isInteger(state && state.roundNumber) ? state.roundNumber : 1;
    const mentions = buildRoundParticipantsLabel(alivePlayers);

    return [
      `第 ${roundNumber} 轮发言开始。${mentions}`.trim(),
      '后端会按当前座位顺序严格逐个点名发言，请所有仍存活的玩家各自只说 1 条公开线索。',
      '要求：不要直接说出词语，不要暴露身份，不要投票，不要代替主持人宣布任何结果。',
      '如果你已经被淘汰，请不要继续参与这一轮。',
    ].join('\n');
  }

  function buildVotePrompt(state, alivePlayers) {
    const roundNumber = Number.isInteger(state && state.roundNumber) ? state.roundNumber : 1;
    const candidates = (Array.isArray(alivePlayers) ? alivePlayers : [])
      .map((player) => `@${String(player.name || '').replace(/\s+/g, '')}`)
      .join(' ');

    return [
      `第 ${roundNumber} 轮投票开始。候选玩家：${candidates}`.trim(),
      '请所有仍存活的玩家只输出 1 行投票结果。',
      '严格格式：投票：@玩家名',
      '不要解释理由，不要补充第二句，不要投给自己，不要宣布淘汰结果。',
    ].join('\n');
  }

  function parseVoteTarget(content, conversation, voterAgentId, allowedAgentIds) {
    const source = String(content || '').trim();

    if (!source) {
      return null;
    }

    const allowed = new Set(Array.isArray(allowedAgentIds) ? allowedAgentIds : []);
    const lookup = buildAgentMentionLookup(conversation && conversation.agents);
    const explicitMention = extractMentionedAgentIds(source, conversation && conversation.agents, {
      lookup,
      limit: 1,
      excludeAgentId: voterAgentId,
    }).find((agentId) => allowed.has(agentId));

    if (explicitMention) {
      return explicitMention;
    }

    const match = source.match(/(?:投票|vote)\s*[:：]?\s*@?([^\s,，。!?]+)/iu);

    if (!match || !match[1]) {
      return null;
    }

    const resolved = resolveMentionValues(match[1], conversation && conversation.agents, {
      lookup,
      excludeAgentId: voterAgentId,
    }).find((agentId) => allowed.has(agentId));

    return resolved || null;
  }

  function buildStartMessage(conversation, state) {
    const players = Array.isArray(state && state.players) ? state.players.map((player) => player.name) : [];
    const config = state && state.config ? state.config : {};

    return [
      `“${conversation.title}” 已开始新一局谁是卧底。`,
      `玩家：${players.join('、')}`,
      `配置：卧底 ${config.undercoverCount || 1} 人${config.blankCount ? `，白板 ${config.blankCount} 人` : ''}`,
      '主持人现在由后端负责，身份已通过私密信道下发给各位玩家。',
      '从现在开始，后端会自动推进发言轮、投票轮、结算与身份揭晓。',
    ].join('\n');
  }

  function buildVoteSummary(state, voteResult) {
    const playersById = new Map(
      (Array.isArray(state && state.players) ? state.players : []).map((player) => [player.agentId, player.name])
    );
    const eliminatedName = voteResult.eliminatedAgentId ? playersById.get(voteResult.eliminatedAgentId) || '未知玩家' : '无人';
    const tally = new Map();

    for (const vote of Array.isArray(voteResult && voteResult.votes) ? voteResult.votes : []) {
      if (!vote.targetAgentId) {
        continue;
      }

      tally.set(vote.targetAgentId, (tally.get(vote.targetAgentId) || 0) + 1);
    }

    const summaryLines = Array.from(tally.entries())
      .sort((left, right) => right[1] - left[1] || String(playersById.get(left[0]) || left[0]).localeCompare(String(playersById.get(right[0]) || right[0]), 'zh-CN'))
      .map(([agentId, count]) => `${playersById.get(agentId) || agentId}：${count} 票`);

    const resolutionLine =
      voteResult.resolution === 'tie_break_by_seat_order'
        ? '出现并列最高票，主持人按当前座位顺序执行淘汰。'
        : voteResult.resolution === 'no_valid_votes_fallback'
          ? '本轮没有形成有效投票，主持人按当前座位顺序自动裁定淘汰。'
          : '主持人已按得票最高者完成淘汰。';

    return [
      `本轮投票结束，出局玩家：${eliminatedName}`,
      summaryLines.length > 0 ? `票数统计：${summaryLines.join('；')}` : '票数统计：无有效票。',
      resolutionLine,
    ].join('\n');
  }

  function buildWinnerMessage(state) {
    const winner = state && state.winner ? state.winner : null;

    if (!winner) {
      return '';
    }

    return [
      `游戏结束，胜利方：${winner.team === 'civilian' ? '平民阵营' : '卧底阵营'}`,
      winner.reason || '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  function buildRevealAssignments(state) {
    return (Array.isArray(state && state.players) ? state.players : []).map((player) => ({
      agentId: player.agentId,
      name: player.name,
      roleLabel: player.role === 'undercover' ? '卧底' : player.role === 'blank' ? '白板' : '平民',
      word: player.word || '',
    }));
  }

  function buildRevealMessage(state) {
    const assignments = buildRevealAssignments(state);

    return [
      '最终身份揭晓：',
      ...assignments.map((item) => `${item.name}：${item.roleLabel} / ${item.word || '无词'}`),
    ].join('\n');
  }

  function createSecretAssignments(conversation, state) {
    for (const player of Array.isArray(state && state.players) ? state.players : []) {
      store.createPrivateMessage({
        conversationId: conversation.id,
        turnId: randomUUID(),
        senderName: '主持人',
        recipientAgentIds: [player.agentId],
        content: undercoverHost.buildRoleBriefing(player, state),
        metadata: {
          source: 'undercover-host',
          uiVisible: false,
          purpose: 'undercover-assignment',
        },
      });
    }
  }

  function deleteConversationState(conversationId) {
    activeAutoRuns.delete(conversationId);
    undercoverHost.deleteState(conversationId);
  }

  async function revealGame(conversationId) {
    requireConversation(conversationId);
    let state = requireState(conversationId);

    state = undercoverHost.revealState(state);
    const revealMessage = createSystemMessage(conversationId, buildRevealMessage(state), {
      phase: 'game_revealed',
    });
    syncUndercoverConversationMetadata(conversationId, state);
    broadcastConversationRefresh(conversationId, revealMessage);

    return {
      conversation: store.getConversation(conversationId),
      summary: pickConversationSummary(store.getConversation(conversationId)),
      conversations: store.listConversations(),
      game: undercoverHost.buildPublicState(state),
    };
  }

  async function runClueRound(conversationId) {
    const conversation = requireConversation(conversationId);
    let state = requireState(conversationId);

    if (state.status !== 'active') {
      throw createHttpError(409, '当前谁是卧底对局已结束');
    }

    if (state.phase !== 'ready_for_clues') {
      throw createHttpError(409, '当前房间暂时不能开始发言轮');
    }

    const alivePlayers = undercoverHost.getAlivePlayers(state);

    if (alivePlayers.length < 2) {
      throw createHttpError(409, '存活玩家不足，无法继续发言轮');
    }

    state = undercoverHost.markClueRoundStarted(state);
    syncUndercoverConversationMetadata(conversationId, state);
    broadcastConversationSummary(conversationId);

    let turnResult;

    try {
      turnResult = await turnOrchestrator.runConversationTurn(conversationId, {
        role: 'system',
        senderName: '主持人',
        content: buildCluePrompt(state, alivePlayers),
        metadata: {
          source: 'undercover-host',
          phase: 'clue_round',
        },
        initialAgentIds: alivePlayers.map((player) => player.agentId),
        executionMode: 'queue',
        allowHandoffs: false,
        entryStrategy: 'host_clue_round',
        explicitIntent: true,
      });
    } catch (error) {
      state = undercoverHost.saveState({
        ...requireState(conversationId),
        phase: 'ready_for_clues',
      });
      syncUndercoverConversationMetadata(conversationId, state);
      broadcastConversationSummary(conversationId);
      throw error;
    }

    const latestState = requireState(conversationId);
    const replyMessages = Array.isArray(turnResult.replies) ? turnResult.replies : [];
    state = undercoverHost.markClueRoundCompleted(latestState, replyMessages);

    if (replyMessages.length === 0) {
      const emptyClueMessage = createSystemMessage(
        conversationId,
        '本轮没有收到有效发言，主持人将直接进入投票轮。',
        {
          phase: 'clue_round_empty',
        }
      );
      syncUndercoverConversationMetadata(conversationId, state);
      broadcastConversationRefresh(conversationId, emptyClueMessage);
    } else {
      syncUndercoverConversationMetadata(conversationId, state);
      broadcastConversationSummary(conversationId);
    }

    return {
      ...turnResult,
      conversation: store.getConversation(conversationId),
      conversations: store.listConversations(),
      game: undercoverHost.buildPublicState(state),
    };
  }

  async function runVoteRound(conversationId) {
    const conversation = requireConversation(conversationId);
    let state = requireState(conversationId);

    if (state.status !== 'active') {
      throw createHttpError(409, '当前谁是卧底对局已结束');
    }

    if (state.phase !== 'ready_for_vote') {
      throw createHttpError(409, '请先完成一轮发言，再开始投票轮');
    }

    const alivePlayers = undercoverHost.getAlivePlayers(state);

    if (alivePlayers.length < 2) {
      throw createHttpError(409, '存活玩家不足，无法继续投票轮');
    }

    state = undercoverHost.saveState({
      ...state,
      phase: 'vote_round',
    });
    syncUndercoverConversationMetadata(conversationId, state);
    broadcastConversationSummary(conversationId);

    let turnResult;

    try {
      turnResult = await turnOrchestrator.runConversationTurn(conversationId, {
        role: 'system',
        senderName: '主持人',
        content: buildVotePrompt(state, alivePlayers),
        metadata: {
          source: 'undercover-host',
          phase: 'vote_round',
        },
        initialAgentIds: alivePlayers.map((player) => player.agentId),
        executionMode: 'parallel',
        entryStrategy: 'host_vote_round',
        explicitIntent: true,
      });
    } catch (error) {
      state = undercoverHost.saveState({
        ...requireState(conversationId),
        phase: 'ready_for_vote',
      });
      syncUndercoverConversationMetadata(conversationId, state);
      broadcastConversationSummary(conversationId);
      throw error;
    }

    const latestState = requireState(conversationId);
    const aliveAgentIds = alivePlayers.map((player) => player.agentId);
    const validVotes = [];

    for (const reply of Array.isArray(turnResult.replies) ? turnResult.replies : []) {
      if (!reply || !reply.agentId || !aliveAgentIds.includes(reply.agentId)) {
        continue;
      }

      const targetAgentId = parseVoteTarget(reply.content, conversation, reply.agentId, aliveAgentIds);

      if (!targetAgentId || targetAgentId === reply.agentId) {
        continue;
      }

      const targetPlayer = undercoverHost.getPlayer(latestState, targetAgentId);
      const voterPlayer = undercoverHost.getPlayer(latestState, reply.agentId);

      if (!targetPlayer || !voterPlayer) {
        continue;
      }

      validVotes.push({
        voterAgentId: voterPlayer.agentId,
        voterName: voterPlayer.name,
        targetAgentId: targetPlayer.agentId,
        targetName: targetPlayer.name,
      });
    }

    let voteResult;

    if (validVotes.length === 0) {
      const fallbackPlayer = undercoverHost.getAlivePlayers(latestState)[0] || null;
      voteResult = {
        eliminatedAgentId: fallbackPlayer ? fallbackPlayer.agentId : null,
        tieAgentIds: [],
        resolution: 'no_valid_votes_fallback',
        votes: [],
      };
    } else {
      const voteCounts = new Map();

      for (const vote of validVotes) {
        voteCounts.set(vote.targetAgentId, (voteCounts.get(vote.targetAgentId) || 0) + 1);
      }

      const highestVoteCount = Math.max(...voteCounts.values());
      const tiedAgentIds = Array.from(voteCounts.entries())
        .filter(([, count]) => count === highestVoteCount)
        .map(([agentId]) => agentId);
      const seatOrder = Array.isArray(latestState.players) ? latestState.players.map((player) => player.agentId) : [];
      const eliminatedAgentId =
        tiedAgentIds.length <= 1
          ? tiedAgentIds[0]
          : seatOrder.find((agentId) => tiedAgentIds.includes(agentId)) || tiedAgentIds[0];

      voteResult = {
        eliminatedAgentId,
        tieAgentIds: tiedAgentIds.length > 1 ? tiedAgentIds : [],
        resolution: tiedAgentIds.length > 1 ? 'tie_break_by_seat_order' : 'highest_votes',
        votes: validVotes,
      };
    }

    state = undercoverHost.applyVoteResult(latestState, voteResult);
    const voteSummaryMessage = createSystemMessage(conversationId, buildVoteSummary(state, voteResult), {
      phase: 'vote_round_resolved',
    });

    if (state.winner) {
      createSystemMessage(conversationId, buildWinnerMessage(state), {
        phase: 'game_finished',
      });
    }

    syncUndercoverConversationMetadata(conversationId, state);
    broadcastConversationRefresh(conversationId, voteSummaryMessage);

    return {
      ...turnResult,
      conversation: store.getConversation(conversationId),
      conversations: store.listConversations(),
      game: undercoverHost.buildPublicState(state),
    };
  }

  function queueAutoRun(conversationId) {
    if (activeAutoRuns.has(conversationId)) {
      return false;
    }

    const runToken = randomUUID();
    activeAutoRuns.set(conversationId, runToken);

    void (async () => {
      try {
        const maxSteps = 32;

        for (let step = 0; step < maxSteps; step += 1) {
          if (activeAutoRuns.get(conversationId) !== runToken) {
            return;
          }

          const state = undercoverHost.loadState(conversationId);

          if (!state) {
            return;
          }

          if (state.status === 'completed' || state.phase === 'finished') {
            if (!state.revealedAt && activeAutoRuns.get(conversationId) === runToken) {
              await revealGame(conversationId);
            }
            return;
          }

          if (state.status !== 'active') {
            return;
          }

          if (state.phase === 'ready_for_clues') {
            await runClueRound(conversationId);
            continue;
          }

          if (state.phase === 'ready_for_vote') {
            await runVoteRound(conversationId);
            continue;
          }

          return;
        }

        if (activeAutoRuns.get(conversationId) === runToken) {
          const conversation = store.getConversation(conversationId);

          if (conversation && conversation.type === UNDERCOVER_CONVERSATION_TYPE) {
            const warningMessage = createSystemMessage(
              conversationId,
              '自动对局已达到最大安全步数并被暂停，请重置对局后重新开始。',
              {
                phase: 'game_auto_stopped',
              }
            );
            broadcastConversationRefresh(conversationId, warningMessage);
          }
        }
      } catch (error) {
        if (activeAutoRuns.get(conversationId) === runToken) {
          const conversation = store.getConversation(conversationId);

          if (conversation && conversation.type === UNDERCOVER_CONVERSATION_TYPE) {
            const messageText =
              error && /stopped by user/i.test(String(error.message || ''))
                ? '当前自动对局已被停止，请重置对局后重新开始。'
                : `自动对局已暂停：${error && error.message ? error.message : '未知错误'}`;
            const errorMessage = createSystemMessage(conversationId, messageText, {
              phase: 'game_auto_failed',
            });
            broadcastConversationRefresh(conversationId, errorMessage);
          }
        }
      } finally {
        if (activeAutoRuns.get(conversationId) === runToken) {
          activeAutoRuns.delete(conversationId);
        }
      }
    })();

    return true;
  }

  async function startGame(conversationId, body) {
    const conversation = requireConversation(conversationId);
    const existingState = undercoverHost.loadState(conversationId);

    if (existingState && existingState.status === 'active' && existingState.phase !== 'finished') {
      throw createHttpError(409, '请先重置当前谁是卧底对局，再开始新一局');
    }

    const state = undercoverHost.createGame(conversation, body);
    createSecretAssignments(conversation, state);
    const hostMessage = createSystemMessage(conversationId, buildStartMessage(conversation, state), {
      phase: 'game_started',
    });
    syncUndercoverConversationMetadata(conversationId, state);
    broadcastConversationRefresh(conversationId, hostMessage);
    queueAutoRun(conversationId);

    return {
      conversation: store.getConversation(conversationId),
      summary: pickConversationSummary(store.getConversation(conversationId)),
      conversations: store.listConversations(),
      game: undercoverHost.buildPublicState(state),
    };
  }

  async function resetGame(conversationId) {
    requireConversation(conversationId);
    deleteConversationState(conversationId);
    const resetMessage = createSystemMessage(conversationId, '当前谁是卧底对局已重置，可以重新配置并开始新一局。', {
      phase: 'game_reset',
    });
    syncUndercoverConversationMetadata(conversationId, null);
    broadcastConversationRefresh(conversationId, resetMessage);

    return {
      conversation: store.getConversation(conversationId),
      summary: pickConversationSummary(store.getConversation(conversationId)),
      conversations: store.listConversations(),
      game: undercoverHost.buildPublicState(null),
    };
  }

  return {
    canChatInConversation,
    deleteConversationState,
    prepareConversation,
    resetGame,
    revealGame,
    runClueRound,
    runVoteRound,
    startGame,
  };
}
