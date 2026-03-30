const { randomUUID } = require('node:crypto');
const { createHttpError } = require('../../http/http-errors');
const { pickConversationSummary } = require('../conversation/conversation-view');
const { buildAgentMentionLookup, extractMentionedAgentIds, resolveMentionValues } = require('../conversation/mention-routing');
const {
  WEREWOLF_CONVERSATION_TYPE,
  WEREWOLF_SKILL_ID,
  createWerewolfHost,
} = require('../../../lib/werewolf-game');

export function createWerewolfService(options: any = {}) {
  const store = options.store;
  const skillRegistry = options.skillRegistry;
  const turnOrchestrator = options.turnOrchestrator;
  const broadcastEvent = typeof options.broadcastEvent === 'function' ? options.broadcastEvent : () => {};
  const broadcastConversationSummary =
    typeof options.broadcastConversationSummary === 'function' ? options.broadcastConversationSummary : () => {};
  const werewolfHost = options.werewolfHost || createWerewolfHost(options);
  const activeAutoRuns = new Map();

  function getConversationMetadata(conversation: any) {
    return conversation && conversation.metadata && typeof conversation.metadata === 'object' ? conversation.metadata : {};
  }

  function buildWerewolfConversationMetadata(conversation: any, stateOverride: any) {
    return {
      ...getConversationMetadata(conversation),
      werewolfGame: werewolfHost.buildPublicState(
        stateOverride === undefined ? werewolfHost.loadState(conversation.id) : stateOverride
      ),
    };
  }

  function syncWerewolfConversationMetadata(conversationId: string, stateOverride: any = undefined) {
    const conversation = store.getConversation(conversationId);

    if (!conversation || conversation.type !== WEREWOLF_CONVERSATION_TYPE) {
      return conversation;
    }

    return store.updateConversation(conversationId, {
      title: conversation.title,
      type: conversation.type,
      metadata: buildWerewolfConversationMetadata(conversation, stateOverride),
    });
  }

  function mergeConversationSkillIds(skillIds: string[], requiredSkillId: string) {
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

  function syncWerewolfConversationParticipants(conversationId: string) {
    const conversation = store.getConversation(conversationId);

    if (!conversation || conversation.type !== WEREWOLF_CONVERSATION_TYPE) {
      return conversation;
    }

    return store.updateConversation(conversationId, {
      title: conversation.title,
      type: conversation.type,
      metadata: getConversationMetadata(conversation),
      participants: (Array.isArray(conversation.agents) ? conversation.agents : []).map((agent: any) => ({
        agentId: agent.id,
        modelProfileId: agent.selectedModelProfileId || null,
        conversationSkillIds: mergeConversationSkillIds(agent.conversationSkillIds, WEREWOLF_SKILL_ID),
      })),
    });
  }

  function prepareConversation(conversationId: string) {
    syncWerewolfConversationMetadata(conversationId);
    return syncWerewolfConversationParticipants(conversationId);
  }

  function createSystemMessage(conversationId: string, content: string, metadata: any = {}) {
    return store.createMessage({
      conversationId,
      turnId: randomUUID(),
      role: 'system',
      senderName: '主持人',
      content,
      status: 'completed',
      metadata: {
        source: 'werewolf-host',
        ...metadata,
      },
    });
  }

  function broadcastConversationRefresh(conversationId: string, message: any) {
    if (message) {
      broadcastEvent('conversation_message_created', {
        conversationId,
        message,
      });
    }

    broadcastConversationSummary(conversationId);
  }

  function requireConversation(conversationId: string) {
    const conversation = store.getConversation(conversationId);

    if (!conversation) {
      throw createHttpError(404, '会话不存在');
    }

    try {
      werewolfHost.assertConversation(conversation);
    } catch (error) {
      const errorValue = error as any;
      throw createHttpError(400, (errorValue && errorValue.message) || '无效的狼人杀房间');
    }

    return conversation;
  }

  function requireState(conversationId: string) {
    const state = werewolfHost.loadState(conversationId);

    if (!state) {
      throw createHttpError(400, '请先开始一局狼人杀');
    }

    return state;
  }

  function canChatInConversation(conversationId: string) {
    const state = werewolfHost.loadState(conversationId);

    if (!state) {
      return false;
    }

    return state.phase === 'finished' || state.status === 'completed' || state.status === 'revealed';
  }

  function buildStartMessage(conversation: any, state: any) {
    const players = Array.isArray(state && state.players) ? state.players.map((player: any) => player.name) : [];
    const config = state && state.config ? state.config : {};

    return [
      `"${conversation.title}" 已开始新一局狼人杀。`,
      `玩家：${players.join('、')}`,
      `配置：狼人 ${Number.isInteger(config.werewolfCount) ? config.werewolfCount : 2} 人，预言家 ${
        Number.isInteger(config.seerCount) ? config.seerCount : 1
      } 人，女巫 ${Number.isInteger(config.witchCount) ? config.witchCount : 0} 人，村民 ${
        Number.isInteger(config.villagerCount) ? config.villagerCount : 3
      } 人`,
      '主持人现在由后端负责，身份已通过私密信道下发给各位玩家。',
      '从现在开始，后端会自动推进夜间行动、天亮公布、白天讨论、投票处决。',
    ].join('\n');
  }

  function createSecretAssignments(conversation: any, state: any) {
    for (const player of Array.isArray(state && state.players) ? state.players : []) {
      store.createPrivateMessage({
        conversationId: conversation.id,
        turnId: randomUUID(),
        senderName: '主持人',
        recipientAgentIds: [player.agentId],
        content: werewolfHost.buildRoleBriefing(player, state),
        metadata: {
          source: 'werewolf-host',
          uiVisible: false,
          purpose: 'werewolf-assignment',
        },
      });
    }
  }

  function buildNightPrompt(state: any) {
    const roundNumber = Number.isInteger(state && state.roundNumber) ? state.roundNumber : 1;
    const alivePlayers = werewolfHost.getAlivePlayers(state);

    return [
      `【夜间】第 ${roundNumber} 轮，请闭眼。`,
      '狼人请通过私密邮箱讨论并选择击杀目标。',
      '预言家请通过私密邮箱选择查验对象。',
      '女巫请通过私密邮箱选择是否使用药水（救人或毒人）。',
      '村民请安静等待天亮。',
      '格式：',
      '狼人：击杀：@玩家名',
      '预言家：查验：@玩家名',
      '女巫：救：@玩家名 / 毒：@玩家名 / 不使用',
    ].join('\n');
  }

  function buildDayPrompt(state: any) {
    const roundNumber = Number.isInteger(state && state.roundNumber) ? state.roundNumber : 1;
    const alivePlayers = werewolfHost.getAlivePlayers(state);
    const mentions = alivePlayers.map((p: any) => `@${p.name}`).join(' ');

    // 获取昨晚死亡信息
    const lastNightEntry = [...(Array.isArray(state && state.history) ? state.history : [])]
      .reverse()
      .find((entry: any) => entry && entry.type === 'night');

    const deathMessage = lastNightEntry && lastNightEntry.deathMessage
      ? lastNightEntry.deathMessage
      : '昨晚是平安夜，没有人死亡。';

    return [
      `【天亮】第 ${roundNumber} 轮。`,
      deathMessage,
      `存活玩家：${mentions}`,
      '请依次发言讨论，找出狼人。',
      '发言要求：',
      '- 不要直接暴露自己的精确身份',
      '- 可以分享线索、怀疑、推理',
      '- 发言要简洁，不要长篇大论',
    ].join('\n');
  }

  function buildVotePrompt(state: any) {
    const roundNumber = Number.isInteger(state && state.roundNumber) ? state.roundNumber : 1;
    const alivePlayers = werewolfHost.getAlivePlayers(state);
    const candidates = alivePlayers.map((p: any) => `@${p.name}`).join(' ');

    return [
      `【投票】第 ${roundNumber} 轮投票开始。`,
      `候选玩家：${candidates}`,
      '请所有存活玩家投票选择要处决的人。',
      '',
      '⚠️ 重要：你必须使用以下格式投票：',
      '投票：@玩家名',
      '',
      '例如：投票：@咕咕嘎嘎',
      '如果没有这个格式，你的投票将不会生效！',
    ].join('\n');
  }

  function parseVoteTarget(content: string, conversation: any, voterAgentId: string, allowedAgentIds: string[]) {
    const source = String(content || '').trim();

    if (!source) {
      return null;
    }

    const allowed = new Set(Array.isArray(allowedAgentIds) ? allowedAgentIds : []);
    const lookup = buildAgentMentionLookup(conversation && conversation.agents);
    
    // 提取显式的 @提及（仅作为无投票命令时的兜底）
    const explicitMention = extractMentionedAgentIds(source, conversation && conversation.agents, {
      lookup,
      limit: 1,
      excludeAgentId: voterAgentId,
    }).find((agentId: string) => allowed.has(agentId));

    // 支持多种投票格式（优先解析投票命令）
    const match = source.match(/(?:投票|vote|投|选|处决)\s*[:：]?\s*@?([^\s,，。!?]+)/iu);

    if (match && match[1]) {
      const targetName = match[1].trim();
      
      const resolved = resolveMentionValues(targetName, conversation && conversation.agents, {
        lookup,
        excludeAgentId: voterAgentId,
      }).find((agentId: string) => allowed.has(agentId));

      if (!resolved) {
        console.log('[WEREWOLF DEBUG] 投票目标解析失败:', targetName);
      }

      return resolved || null;
    }

    return explicitMention || null;
  }

  function parseWerewolfTarget(content: string, conversation: any, agentId: string, allowedAgentIds: string[]) {
    const source = String(content || '').trim();

    if (!source) {
      return null;
    }

    const allowed = new Set(Array.isArray(allowedAgentIds) ? allowedAgentIds : []);
    const lookup = buildAgentMentionLookup(conversation && conversation.agents);

    // 解析击杀目标：
    // - 避免误匹配像“刀了可以…”这种自然语言
    // - 兼容模型把名字拆行（例如：@牧\n濑红莉栖）
    const compactSource = source.replace(/\s+/g, '');
    const matchWithAt = Array.from(
      compactSource.matchAll(/(?:击杀|刀|杀|kill|target|目标)(?:(?:[:：])?@)([^,，。！？?]+)/giu),
    );
    const matchWithoutAt =
      matchWithAt.length === 0
        ? Array.from(compactSource.matchAll(/(?:击杀|刀|杀|kill|target|目标)(?:[:：])([^,，。！？?]+)/giu))
        : [];
    const matches = matchWithAt.length > 0 ? matchWithAt : matchWithoutAt;

    if (matches.length === 0) {
      return null;
    }

    const lastMatch = matches[matches.length - 1];
    const targetName = String(lastMatch && lastMatch[1] ? lastMatch[1] : '').trim();

    if (!targetName) {
      return null;
    }
    
    // 尝试解析目标
    const resolved = resolveMentionValues(targetName, conversation && conversation.agents, {
      lookup,
      excludeAgentId: agentId,
    }).find((targetId: string) => allowed.has(targetId));

    if (!resolved) {
      console.log('[WEREWOLF DEBUG] 解析目标失败:', targetName, '允许的ID:', Array.from(allowed));
    }

    return resolved || null;
  }

  function parseSeerTarget(content: string, conversation: any, agentId: string, allowedAgentIds: string[]) {
    const source = String(content || '').trim();

    if (!source) {
      return null;
    }

    const allowed = new Set(Array.isArray(allowedAgentIds) ? allowedAgentIds : []);
    const lookup = buildAgentMentionLookup(conversation && conversation.agents);

    // 解析查验目标（避免误匹配“看起来…”之类自然语言 + 兼容拆行名字）
    const compactSource = source.replace(/\s+/g, '');
    const matchWithAt = Array.from(
      compactSource.matchAll(/(?:查验|验|check|verify)(?:(?:[:：])?@)([^,，。！？?]+)/giu),
    );
    const matchWithoutAt =
      matchWithAt.length === 0
        ? Array.from(compactSource.matchAll(/(?:查验|验|check|verify)(?:[:：])([^,，。！？?]+)/giu))
        : [];
    const matches = matchWithAt.length > 0 ? matchWithAt : matchWithoutAt;

    if (matches.length === 0) {
      return null;
    }

    const lastMatch = matches[matches.length - 1];
    const targetName = String(lastMatch && lastMatch[1] ? lastMatch[1] : '').trim();

    if (!targetName) {
      return null;
    }
    
    const resolved = resolveMentionValues(targetName, conversation && conversation.agents, {
      lookup,
      excludeAgentId: agentId,
    }).find((targetId: string) => allowed.has(targetId));

    if (!resolved) {
      console.log('[WEREWOLF DEBUG] 预言家查验目标解析失败:', targetName);
    }

    return resolved || null;
  }

  function parseWitchAction(content: string, conversation: any, agentId: string, allowedAgentIds: string[]) {
    const source = String(content || '').trim();

    if (!source) {
      return null;
    }

    const compactSource = source.replace(/\s+/g, '');
    const lookup = buildAgentMentionLookup(conversation && conversation.agents);
    const allowed = new Set(Array.isArray(allowedAgentIds) ? allowedAgentIds : []);
    allowed.delete(agentId);

    // 先解析毒药（需要目标）
    const poisonMatchesWithAt = Array.from(
      compactSource.matchAll(/(?:毒|poison)(?:(?:[:：])?@)([^,，。！？?]+)/giu),
    );
    const poisonMatchesWithoutAt =
      poisonMatchesWithAt.length === 0
        ? Array.from(compactSource.matchAll(/(?:毒|poison)(?:[:：])([^,，。！？?]+)/giu))
        : [];
    const poisonMatches = poisonMatchesWithAt.length > 0 ? poisonMatchesWithAt : poisonMatchesWithoutAt;

    if (poisonMatches.length > 0) {
      const lastMatch = poisonMatches[poisonMatches.length - 1];
      const targetName = String(lastMatch && lastMatch[1] ? lastMatch[1] : '').trim();

      if (!targetName) {
        return null;
      }

      const resolved = resolveMentionValues(targetName, conversation && conversation.agents, {
        lookup,
        excludeAgentId: agentId,
      }).find((targetId: string) => allowed.has(targetId));

      if (!resolved) {
        console.log('[WEREWOLF DEBUG] 女巫毒人目标解析失败:', targetName);
        return null;
      }

      return { action: 'poison', targetAgentId: resolved };
    }

    // 再解析不使用/跳过（避免把“不救”误当作救人）
    if (/(?:不使用|不用|跳过|pass|skip)/iu.test(compactSource) || /不救|不救人|不救了/iu.test(compactSource)) {
      return { action: 'none' };
    }

    // 最后解析救人（不需要目标）
    if (/(?:救|解药|save)/iu.test(compactSource)) {
      return { action: 'save' };
    }

    return null;
  }

  function buildVoteSummary(state: any, voteResult: any) {
    const playersById = new Map(
      (Array.isArray(state && state.players) ? state.players : []).map((player: any) => [player.agentId, player.name])
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
      .sort(
        (left: any, right: any) =>
          right[1] - left[1] ||
          String(playersById.get(left[0]) || left[0]).localeCompare(String(playersById.get(right[0]) || right[0]), 'zh-CN')
      )
      .map(([agentId, count]) => `${playersById.get(agentId) || agentId}：${count} 票`);

    return [
      `投票结束，出局玩家：${eliminatedName}`,
      summaryLines.length > 0 ? `票数统计：${summaryLines.join('；')}` : '票数统计：无有效票。',
    ].join('\n');
  }

  function buildWinnerMessage(state: any) {
    const winner = state && state.winner ? state.winner : null;

    if (!winner) {
      return '';
    }

    return [
      `游戏结束，胜利方：${winner.team === 'good' ? '好人阵营' : '狼人阵营'}`,
      winner.reason || '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  function buildRevealAssignments(state: any) {
    return (Array.isArray(state && state.players) ? state.players : []).map((player: any) => ({
      agentId: player.agentId,
      name: player.name,
      roleLabel:
        player.role === 'werewolf'
          ? '狼人'
          : player.role === 'seer'
            ? '预言家'
            : player.role === 'witch'
              ? '女巫'
              : '村民',
      isAlive: isAlive(player),
    }));
  }

  function isAlive(player: any) {
    return Boolean(player) && !player.eliminatedAt;
  }

  function buildRevealMessage(state: any) {
    const assignments = buildRevealAssignments(state);

    return [
      '最终身份揭晓：',
      ...assignments.map((item: any) => `${item.name}：${item.roleLabel}${item.isAlive ? '' : '（已死亡）'}`),
    ].join('\n');
  }

  function deleteConversationState(conversationId: string) {
    activeAutoRuns.delete(conversationId);
    werewolfHost.deleteState(conversationId);
  }

  async function revealGame(conversationId: string) {
    requireConversation(conversationId);
    let state = requireState(conversationId);

    state = werewolfHost.revealState(state);
    const revealMessage = createSystemMessage(conversationId, buildRevealMessage(state), {
      phase: 'game_revealed',
    });
    syncWerewolfConversationMetadata(conversationId, state);
    broadcastConversationRefresh(conversationId, revealMessage);

    return {
      conversation: store.getConversation(conversationId),
      summary: pickConversationSummary(store.getConversation(conversationId)),
      conversations: store.listConversations(),
      game: werewolfHost.buildPublicState(state),
    };
  }

  // 夜间阶段：收集狼人、预言家和女巫的行动
  async function runNightPhase(conversationId: string) {
    const conversation = requireConversation(conversationId);
    let state = requireState(conversationId);

    if (state.status !== 'active') {
      throw createHttpError(409, '当前狼人杀对局已结束');
    }

    if (state.phase !== 'night') {
      throw createHttpError(409, '当前不是夜间阶段');
    }

    const alivePlayers = werewolfHost.getAlivePlayers(state);
    const aliveAgentIds = alivePlayers.map((p: any) => p.agentId);
    const werewolfPlayers = alivePlayers.filter((p: any) => p.role === 'werewolf');
    const seerPlayer = alivePlayers.find((p: any) => p.role === 'seer');
    const witchPlayer = alivePlayers.find((p: any) => p.role === 'witch');

    // 发送夜间提示消息
    const nightMessage = createSystemMessage(conversationId, buildNightPrompt(state), {
      phase: 'night',
    });
    broadcastConversationRefresh(conversationId, nightMessage);

    // 运行狼人私密讨论，解析击杀目标
    if (werewolfPlayers.length > 0) {
      const werewolfAgentIds = werewolfPlayers.map((p: any) => p.agentId);

      // 狼人讨论轮数
      const maxWerewolfRounds = 3;
      let werewolfRound = 0;
      let agreedTarget: string | null = null;
      let fallbackTarget: string | null = null;
      let fallbackVotes = 0;

      while (werewolfRound < maxWerewolfRounds && !agreedTarget) {
        werewolfRound += 1;

        // 狼人讨论并投票
        const werewolfPrompt = werewolfRound === 1
          ? [
              '【狼人行动 - 第1轮】',
              '你是狼人，请与队友讨论并选择击杀目标。',
              `存活玩家：${alivePlayers.map((p: any) => `@${p.name}`).join('、')}`,
              '你可以：',
              '1. 用 send-private 与队友私聊讨论（send-private --to "队友名"）',
              '2. 选定目标后，用 send-private 发送 1 条私密消息提交最终目标（不带 --to 会默认发给自己）',
              '',
              '⚠️ 重要：你必须在“私密消息内容”里使用以下格式声明目标：',
              '击杀：@玩家名',
              '',
              '例如：击杀：@咕咕嘎嘎',
              '公开回复可以留空（后端会读取你的私密消息来结算）。',
              '如果没有这个格式，后端将无法解析你的行动。',
            ].join('\n')
          : [
              `【狼人行动 - 第${werewolfRound}轮】`,
              '请继续讨论或确认击杀目标。',
              `存活玩家：${alivePlayers.map((p: any) => `@${p.name}`).join('、')}`,
              '',
              '⚠️ 必须用 send-private 提交：击杀：@玩家名（公开回复可留空）',
              '例如：击杀：@咕咕嘎嘎',
            ].join('\n');

        const werewolfTurnResult = await turnOrchestrator.runConversationTurn(conversationId, {
          role: 'system',
          senderName: '主持人',
          content: werewolfPrompt,
          metadata: {
            source: 'werewolf-host',
            phase: 'night_werewolf',
            round: werewolfRound,
          },
          initialAgentIds: werewolfAgentIds,
          executionMode: 'parallel',
          allowHandoffs: false,
          entryStrategy: 'host_night_werewolf',
          explicitIntent: true,
          privateOnly: true,
        });

        // 收集所有狼人的目标选择
        console.log('[WEREWOLF DEBUG] 狼人行动结果:', JSON.stringify({
          round: werewolfRound,
          replyCount: werewolfTurnResult?.replies?.length || 0,
          replies: (werewolfTurnResult?.replies || []).map((r: any) => ({
            agentId: r.agentId,
            senderName: r.senderName,
            content: (r.content || '').substring(0, 300),
          })),
          werewolfAgentIds,
          aliveAgentIds,
        }));
        const targetVotes = new Map<string, string[]>(); // targetId -> voterAgentIds[]
        const privateMessagesForTurn =
          werewolfTurnResult && werewolfTurnResult.turnId
            ? store
                .listPrivateMessages(conversationId)
                .filter((message: any) => message && message.turnId === werewolfTurnResult.turnId)
            : [];
        const repliesByAgentId = new Map<string, any>(
          (Array.isArray(werewolfTurnResult?.replies) ? werewolfTurnResult.replies : [])
            .filter((reply: any) => reply && reply.agentId && werewolfAgentIds.includes(reply.agentId))
            .map((reply: any) => [String(reply.agentId), reply] as [string, any]),
        );

        for (const werewolfAgentId of werewolfAgentIds) {
          let targetId: string | null = null;
          const agentPrivateMessages = privateMessagesForTurn
            .filter((message: any) => message && message.senderAgentId === werewolfAgentId)
            .sort((left: any, right: any) => {
              const leftTime = left && left.createdAt ? new Date(left.createdAt).getTime() : 0;
              const rightTime = right && right.createdAt ? new Date(right.createdAt).getTime() : 0;

              if (leftTime !== rightTime) {
                return leftTime - rightTime;
              }

              return String(left && left.id ? left.id : '').localeCompare(String(right && right.id ? right.id : ''));
            });

          // 优先解析本轮 turnId 下的私密消息（send-private）
          for (let index = agentPrivateMessages.length - 1; index >= 0 && !targetId; index -= 1) {
            targetId = parseWerewolfTarget(agentPrivateMessages[index].content || '', conversation, werewolfAgentId, aliveAgentIds);
          }

          // 兼容：如果 agent 没有用 send-private，而是直接在公开回复里写了击杀目标
          if (!targetId) {
            const reply = repliesByAgentId.get(werewolfAgentId);
            if (reply) {
              targetId = parseWerewolfTarget(reply.content || '', conversation, werewolfAgentId, aliveAgentIds);
            }
          }

          console.log('[WEREWOLF DEBUG] 解析目标:', werewolfAgentId, '->', targetId);

          if (targetId) {
            const voters = targetVotes.get(targetId) || [];
            voters.push(werewolfAgentId);
            targetVotes.set(targetId, voters);
          }
        }

        // 检查是否达成一致（多数票）
        if (targetVotes.size > 0) {
          const sortedTargets = Array.from(targetVotes.entries())
            .sort((a, b) => b[1].length - a[1].length);
          
          const topTarget = sortedTargets[0];
          const topVotes = topTarget[1].length;

          if (topVotes > fallbackVotes) {
            fallbackTarget = topTarget[0];
            fallbackVotes = topVotes;
          }
          
          // 达到多数票立即确定；最后一轮仍无多数票则使用当前最高票。
          if (topVotes > werewolfAgentIds.length / 2) {
            agreedTarget = topTarget[0];
          } else if (werewolfRound >= maxWerewolfRounds) {
            agreedTarget = topTarget[0];
          }
        }
      }

      // 最后一轮无人投票时，使用之前轮次里出现过的最高票目标兜底。
      if (!agreedTarget && fallbackTarget) {
        agreedTarget = fallbackTarget;
      }

      // 提交狼人行动
      if (agreedTarget) {
        try {
          state = werewolfHost.submitWerewolfAction(state, werewolfAgentIds[0], agreedTarget);
          console.log('[WEREWOLF DEBUG] 狼人行动提交成功，目标:', agreedTarget);
        } catch (error) {
          // 提交失败时继续，结算时会当作无目标处理
          console.log('[WEREWOLF DEBUG] 狼人行动提交失败:', error);
        }
      } else {
        console.log('[WEREWOLF DEBUG] 没有达成一致目标，平安夜');
      }
    }

    // 运行预言家查验
    if (seerPlayer) {
      let seerSuccess = false;
      let seerAttempts = 0;
      const maxSeerAttempts = 3;

      while (!seerSuccess && seerAttempts < maxSeerAttempts) {
        seerAttempts += 1;
        const seerPrompt = seerAttempts === 1
          ? [
              '【预言家行动】',
              '你是预言家，请选择查验对象。',
              `存活玩家：${alivePlayers.filter((p: any) => p.agentId !== seerPlayer.agentId).map((p: any) => `@${p.name}`).join('、')}`,
              '',
              '⚠️ 重要：你必须用 send-private 发送 1 条私密消息提交查验目标（不带 --to 会默认发给自己）：',
              '查验：@玩家名',
              '',
              '例如：查验：@咕咕嘎嘎',
              '公开回复可以留空（后端会读取你的私密消息来结算）。',
            ].join('\n')
          : [
              '【预言家行动 - 重新选择】',
              '你上次的格式有误或目标无效，请重新选择查验对象。',
              `存活玩家：${alivePlayers.filter((p: any) => p.agentId !== seerPlayer.agentId).map((p: any) => `@${p.name}`).join('、')}`,
              '',
              '⚠️ 必须用 send-private 提交：查验：@玩家名（公开回复可留空）',
              '例如：查验：@咕咕嘎嘎',
            ].join('\n');

        const seerTurnResult = await turnOrchestrator.runConversationTurn(conversationId, {
          role: 'system',
          senderName: '主持人',
          content: seerPrompt,
          metadata: {
            source: 'werewolf-host',
            phase: 'night_seer',
            attempt: seerAttempts,
          },
          initialAgentIds: [seerPlayer.agentId],
          executionMode: 'queue',
          allowHandoffs: false,
          entryStrategy: 'host_night_seer',
          explicitIntent: true,
          privateOnly: true,
        });

        // 解析预言家查验目标（优先读 send-private 的私密消息，其次兼容公开回复）
        let seerTargetId: string | null = null;
        const seerPrivateMessages =
          seerTurnResult && seerTurnResult.turnId
            ? store
                .listPrivateMessages(conversationId)
                .filter(
                  (message: any) =>
                    message &&
                    message.turnId === seerTurnResult.turnId &&
                    message.senderAgentId === seerPlayer.agentId
                )
                .sort((left: any, right: any) => {
                  const leftTime = left && left.createdAt ? new Date(left.createdAt).getTime() : 0;
                  const rightTime = right && right.createdAt ? new Date(right.createdAt).getTime() : 0;

                  if (leftTime !== rightTime) {
                    return leftTime - rightTime;
                  }

                  return String(left && left.id ? left.id : '').localeCompare(String(right && right.id ? right.id : ''));
                })
            : [];

        for (let index = seerPrivateMessages.length - 1; index >= 0 && !seerTargetId; index -= 1) {
          seerTargetId = parseSeerTarget(seerPrivateMessages[index].content || '', conversation, seerPlayer.agentId, aliveAgentIds);
        }

        if (!seerTargetId) {
          for (const reply of Array.isArray(seerTurnResult?.replies) ? seerTurnResult.replies : []) {
            if (!reply || reply.agentId !== seerPlayer.agentId) {
              continue;
            }

            seerTargetId = parseSeerTarget(reply.content || '', conversation, seerPlayer.agentId, aliveAgentIds);
            break;
          }
        }

        if (seerTargetId) {
          try {
            state = werewolfHost.submitSeerAction(state, seerPlayer.agentId, seerTargetId);
            seerSuccess = true;
          } catch (error) {
            // 提交失败时继续重试
          }
        }
      }
    }

    // 运行女巫用药（救人 / 毒人 / 不使用）
    if (witchPlayer) {
      const initialPotions = state && state.witchPotions ? state.witchPotions : { antidoteUsed: false, poisonUsed: false };
      const initialVictimId = state.nightActions?.werewolfTarget || null;
      const canUseAntidote = !initialPotions.antidoteUsed && Boolean(initialVictimId);
      const canUsePoison = !initialPotions.poisonUsed;

      if (canUseAntidote || canUsePoison) {
        let witchResolved = false;
        let witchAttempts = 0;
        const maxWitchAttempts = 3;

        while (!witchResolved && witchAttempts < maxWitchAttempts) {
          witchAttempts += 1;

          const potions = state && state.witchPotions ? state.witchPotions : { antidoteUsed: false, poisonUsed: false };
          const victimId = state.nightActions?.werewolfTarget || null;
          const victimPlayer = victimId ? werewolfHost.getPlayer(state, victimId) : null;
          const poisonCandidates = alivePlayers
            .filter((p: any) => p.agentId !== witchPlayer.agentId)
            .map((p: any) => `@${p.name}`)
            .join('、');

          const canSaveNow = !potions.antidoteUsed && Boolean(victimPlayer);
          const canPoisonNow = !potions.poisonUsed;

          const witchPrompt = witchAttempts === 1
            ? [
                '【女巫行动】',
                '你是女巫，请决定是否使用药水（每晚最多使用 1 瓶）。',
                `今晚狼人击杀：${victimPlayer ? `@${victimPlayer.name}` : '无或未形成一致目标'}`,
                `药水状态：解药 ${potions.antidoteUsed ? '已用' : '未用'} / 毒药 ${potions.poisonUsed ? '已用' : '未用'}`,
                '',
                '⬇️ 重要：你必须用 send-private 发送 1 条私密消息提交最终行动（不带 --to 默认发给自己）：',
                canSaveNow ? '救：@玩家名' : '救：当前不可用',
                canPoisonNow ? '毒：@玩家名' : '毒：已用完',
                '不使用',
                '',
                canPoisonNow && poisonCandidates ? `可投毒对象：${poisonCandidates}` : '',
                '公开回复可以留空（后端会读取你的私密消息来结算）。',
              ]
                .filter(Boolean)
                .join('\n')
            : [
                '【女巫行动 - 重新选择】',
                '上一次格式有误或行动不可用，请重新用 send-private 提交。',
                `今晚狼人击杀：${victimPlayer ? `@${victimPlayer.name}` : '无或未形成一致目标'}`,
                `药水状态：解药 ${potions.antidoteUsed ? '已用' : '未用'} / 毒药 ${potions.poisonUsed ? '已用' : '未用'}`,
                '',
                '⬇️ 必须用 send-private 提交：救：@玩家名 / 毒：@玩家名 / 不使用',
              ].join('\n');

          const witchTurnResult = await turnOrchestrator.runConversationTurn(conversationId, {
            role: 'system',
            senderName: '主持人',
            content: witchPrompt,
            metadata: {
              source: 'werewolf-host',
              phase: 'night_witch',
              attempt: witchAttempts,
            },
            initialAgentIds: [witchPlayer.agentId],
            executionMode: 'queue',
            allowHandoffs: false,
            entryStrategy: 'host_night_witch',
            explicitIntent: true,
            privateOnly: true,
          });

          // 解析女巫行动（优先读 send-private 的私密消息，其次兼容公开回复）
          let witchAction: any = null;
          const witchPrivateMessages =
            witchTurnResult && witchTurnResult.turnId
              ? store
                  .listPrivateMessages(conversationId)
                  .filter(
                    (message: any) =>
                      message &&
                      message.turnId === witchTurnResult.turnId &&
                      message.senderAgentId === witchPlayer.agentId
                  )
                  .sort((left: any, right: any) => {
                    const leftTime = left && left.createdAt ? new Date(left.createdAt).getTime() : 0;
                    const rightTime = right && right.createdAt ? new Date(right.createdAt).getTime() : 0;

                    if (leftTime !== rightTime) {
                      return leftTime - rightTime;
                    }

                    return String(left && left.id ? left.id : '').localeCompare(String(right && right.id ? right.id : ''));
                  })
              : [];

          for (let index = witchPrivateMessages.length - 1; index >= 0 && !witchAction; index -= 1) {
            witchAction = parseWitchAction(witchPrivateMessages[index].content || '', conversation, witchPlayer.agentId, aliveAgentIds);
          }

          if (!witchAction) {
            for (const reply of Array.isArray(witchTurnResult?.replies) ? witchTurnResult.replies : []) {
              if (!reply || reply.agentId !== witchPlayer.agentId) {
                continue;
              }

              witchAction = parseWitchAction(reply.content || '', conversation, witchPlayer.agentId, aliveAgentIds);
              break;
            }
          }

          if (!witchAction) {
            continue;
          }

          if (witchAction.action === 'none') {
            witchResolved = true;
            break;
          }

          try {
            if (witchAction.action === 'save') {
              state = werewolfHost.submitWitchSave(state, witchPlayer.agentId);
              witchResolved = true;
              break;
            }

            if (witchAction.action === 'poison' && witchAction.targetAgentId) {
              state = werewolfHost.submitWitchPoison(state, witchPlayer.agentId, witchAction.targetAgentId);
              witchResolved = true;
              break;
            }
          } catch (error) {
            // 提交失败时继续重试
          }
        }
      }
    }

    // 保存查验结果（resolveNight 会重置 nightActions）
    const seerTargetBeforeResolve = state.nightActions?.seerTarget || null;
    const seerResultBeforeResolve = state.nightActions?.seerResult || null;

    // 结算夜间
    state = werewolfHost.resolveNight(state);

    // 发送预言家查验结果
    if (seerPlayer && seerTargetBeforeResolve && seerResultBeforeResolve) {
      const targetPlayer = werewolfHost.getPlayer(state, seerTargetBeforeResolve);
      if (targetPlayer) {
        const resultContent = seerResultBeforeResolve === 'werewolf'
          ? `【查验结果】@${targetPlayer.name} 是 狼人`
          : `【查验结果】@${targetPlayer.name} 是 好人`;
        store.createPrivateMessage({
          conversationId: conversation.id,
          turnId: randomUUID(),
          senderName: '主持人',
          recipientAgentIds: [seerPlayer.agentId],
          content: resultContent,
          metadata: {
            source: 'werewolf-host',
            uiVisible: false,
            purpose: 'seer_result',
          },
        });
      }
    }

    // 发送天亮消息
    const lastNightEntry = [...(Array.isArray(state && state.history) ? state.history : [])]
      .reverse()
      .find((entry: any) => entry && entry.type === 'night');

    const lastNightDeath = lastNightEntry?.deathAgentId || null;

    // resolveNight may already end the game; avoid posting a day-discussion prompt in that case.
    if (state.phase === 'finished' || state.status !== 'active') {
      const nightResolutionMessage = createSystemMessage(conversationId, String(lastNightEntry?.deathMessage || '').trim(), {
        phase: 'night_resolved',
        lastNightDeath,
      });

      if (state.winner) {
        createSystemMessage(conversationId, buildWinnerMessage(state), {
          phase: 'game_finished',
        });
      }

      syncWerewolfConversationMetadata(conversationId, state);
      broadcastConversationRefresh(conversationId, nightResolutionMessage);

      return {
        conversation: store.getConversation(conversationId),
        conversations: store.listConversations(),
        game: werewolfHost.buildPublicState(state),
      };
    }

    const dayStartMessage = createSystemMessage(conversationId, buildDayPrompt(state), {
      phase: state.phase,
      lastNightDeath,
    });

    syncWerewolfConversationMetadata(conversationId, state);
    broadcastConversationRefresh(conversationId, dayStartMessage);

    return {
      conversation: store.getConversation(conversationId),
      conversations: store.listConversations(),
      game: werewolfHost.buildPublicState(state),
    };
  }

  // 白天讨论阶段
  async function runDayPhase(conversationId: string) {
    const conversation = requireConversation(conversationId);
    let state = requireState(conversationId);

    if (state.status !== 'active') {
      throw createHttpError(409, '当前狼人杀对局已结束');
    }

    if (state.phase !== 'day') {
      throw createHttpError(409, '当前不是白天讨论阶段');
    }

    const alivePlayers = werewolfHost.getAlivePlayers(state);
    const aliveAgentIds = alivePlayers.map((p: any) => p.agentId);

    // 运行白天发言
    const turnResult = await turnOrchestrator.runConversationTurn(conversationId, {
      role: 'system',
      senderName: '主持人',
      content: buildDayPrompt(state),
      metadata: {
        source: 'werewolf-host',
        phase: 'day',
      },
      initialAgentIds: aliveAgentIds,
      executionMode: 'queue',
      allowHandoffs: false,
      entryStrategy: 'host_day_discussion',
      explicitIntent: true,
    });

    // 讨论结束后进入投票阶段
    state = werewolfHost.startVote(state);
    syncWerewolfConversationMetadata(conversationId, state);
    broadcastConversationSummary(conversationId);

    return {
      ...turnResult,
      conversation: store.getConversation(conversationId),
      conversations: store.listConversations(),
      game: werewolfHost.buildPublicState(state),
    };
  }

  // 投票阶段
  async function runVotePhase(conversationId: string) {
    const conversation = requireConversation(conversationId);
    let state = requireState(conversationId);

    if (state.status !== 'active') {
      throw createHttpError(409, '当前狼人杀对局已结束');
    }

    if (state.phase !== 'vote') {
      throw createHttpError(409, '当前不是投票阶段');
    }

    const alivePlayers = werewolfHost.getAlivePlayers(state);
    const aliveAgentIds = alivePlayers.map((p: any) => p.agentId);

    // 运行投票
    const turnResult = await turnOrchestrator.runConversationTurn(conversationId, {
      role: 'system',
      senderName: '主持人',
      content: buildVotePrompt(state),
      metadata: {
        source: 'werewolf-host',
        phase: 'vote',
      },
      initialAgentIds: aliveAgentIds,
      executionMode: 'parallel',
      allowHandoffs: false,
      entryStrategy: 'host_vote_round',
      explicitIntent: true,
    });

    // 解析投票结果
    const votes = [];
    for (const reply of Array.isArray(turnResult.replies) ? turnResult.replies : []) {
      if (!reply || !reply.agentId || !aliveAgentIds.includes(reply.agentId)) {
        continue;
      }

      const targetAgentId = parseVoteTarget(reply.content, conversation, reply.agentId, aliveAgentIds);
      if (!targetAgentId || targetAgentId === reply.agentId) {
        continue;
      }

      const targetPlayer = werewolfHost.getPlayer(state, targetAgentId);
      const voterPlayer = werewolfHost.getPlayer(state, reply.agentId);

      if (!targetPlayer || !voterPlayer) {
        continue;
      }

      votes.push({
        voterAgentId: voterPlayer.agentId,
        voterName: voterPlayer.name,
        targetAgentId: targetPlayer.agentId,
        targetName: targetPlayer.name,
      });
    }

    // 结算投票
    state = werewolfHost.resolveVote(state, votes);

    const voteSummaryMessage = createSystemMessage(conversationId, buildVoteSummary(state, {
      eliminatedAgentId: state.history[state.history.length - 1]?.eliminatedAgentId,
      votes,
    }), {
      phase: 'vote_resolved',
    });

    if (state.winner) {
      createSystemMessage(conversationId, buildWinnerMessage(state), {
        phase: 'game_finished',
      });
    }

    syncWerewolfConversationMetadata(conversationId, state);
    broadcastConversationRefresh(conversationId, voteSummaryMessage);

    return {
      ...turnResult,
      conversation: store.getConversation(conversationId),
      conversations: store.listConversations(),
      game: werewolfHost.buildPublicState(state),
    };
  }

  function queueAutoRun(conversationId: string) {
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

          const state = werewolfHost.loadState(conversationId);

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

          if (state.phase === 'night') {
            await runNightPhase(conversationId);
            continue;
          }

          if (state.phase === 'day') {
            await runDayPhase(conversationId);
            continue;
          }

          if (state.phase === 'vote') {
            await runVotePhase(conversationId);
            continue;
          }

          return;
        }

        if (activeAutoRuns.get(conversationId) === runToken) {
          const conversation = store.getConversation(conversationId);

          if (conversation && conversation.type === WEREWOLF_CONVERSATION_TYPE) {
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
        const errorValue = error as any;
        if (activeAutoRuns.get(conversationId) === runToken) {
          const conversation = store.getConversation(conversationId);

          if (conversation && conversation.type === WEREWOLF_CONVERSATION_TYPE) {
            const messageText =
              errorValue && /stopped by user/i.test(String(errorValue.message || ''))
                ? '当前自动对局已被停止，请重置对局后重新开始。'
                : `自动对局已暂停：${errorValue && errorValue.message ? errorValue.message : '未知错误'}`;
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

  async function startGame(conversationId: string, body: any) {
    const conversation = requireConversation(conversationId);
    const existingState = werewolfHost.loadState(conversationId);

    if (existingState && existingState.status === 'active' && existingState.phase !== 'finished') {
      throw createHttpError(409, '请先重置当前狼人杀对局，再开始新一局');
    }

    const state = werewolfHost.createGame(conversation, body);
    createSecretAssignments(conversation, state);
    const hostMessage = createSystemMessage(conversationId, buildStartMessage(conversation, state), {
      phase: 'game_started',
    });
    syncWerewolfConversationMetadata(conversationId, state);
    broadcastConversationRefresh(conversationId, hostMessage);
    queueAutoRun(conversationId);

    return {
      conversation: store.getConversation(conversationId),
      summary: pickConversationSummary(store.getConversation(conversationId)),
      conversations: store.listConversations(),
      game: werewolfHost.buildPublicState(state),
    };
  }

  async function resetGame(conversationId: string) {
    requireConversation(conversationId);
    deleteConversationState(conversationId);
    const resetMessage = createSystemMessage(conversationId, '当前狼人杀对局已重置，可以重新配置并开始新一局。', {
      phase: 'game_reset',
    });
    syncWerewolfConversationMetadata(conversationId, null);
    broadcastConversationRefresh(conversationId, resetMessage);

    return {
      conversation: store.getConversation(conversationId),
      summary: pickConversationSummary(store.getConversation(conversationId)),
      conversations: store.listConversations(),
      game: werewolfHost.buildPublicState(null),
    };
  }

  return {
    canChatInConversation,
    deleteConversationState,
    prepareConversation,
    resetGame,
    revealGame,
    runNightPhase,
    runDayPhase,
    runVotePhase,
    startGame,
    werewolfHost,
  };
}
