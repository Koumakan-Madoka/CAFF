const fs = require('node:fs');
const path = require('node:path');
const { randomInt } = require('node:crypto');

export const UNDERCOVER_CONVERSATION_TYPE = 'who_is_undercover';
export const UNDERCOVER_SKILL_ID = 'who-is-undercover';
const DEFAULT_STATE_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function resolveUndercoverStateDir(agentDir) {
  return path.resolve(agentDir, 'who-is-undercover-games');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeConversationId(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function gameStatePath(stateDir, conversationId) {
  const normalizedId = sanitizeConversationId(conversationId);

  if (!normalizedId) {
    throw new Error('Conversation id is required');
  }

  return path.join(stateDir, `${normalizedId}.json`);
}

function shuffleInPlace(items) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    const nextValue = items[index];
    items[index] = items[swapIndex];
    items[swapIndex] = nextValue;
  }

  return items;
}

function normalizePositiveInteger(value, fallback, minimum = 0) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.max(minimum, parsed);
}

function normalizeOptionalText(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

function validateGameConfig(config: any = {}, playerCount = 0) {
  const civilianWord = normalizeOptionalText(config.civilianWord);
  const undercoverWord = normalizeOptionalText(config.undercoverWord);
  const blankWord = normalizeOptionalText(config.blankWord);
  const undercoverCount = normalizePositiveInteger(config.undercoverCount, 1, 1);
  const blankCount = normalizePositiveInteger(config.blankCount, 0, 0);

  if (playerCount < 3) {
    throw new Error('谁是卧底至少需要 3 名参与者');
  }

  if (!civilianWord) {
    throw new Error('请填写平民词');
  }

  if (!undercoverWord) {
    throw new Error('请填写卧底词');
  }

  if (civilianWord === undercoverWord) {
    throw new Error('平民词和卧底词不能相同');
  }

  if (undercoverCount + blankCount >= playerCount) {
    throw new Error('卧底人数与白板人数之和必须小于玩家总数');
  }

  if (blankCount > 0 && !blankWord) {
    throw new Error('存在白板时必须填写白板词');
  }

  return {
    civilianWord,
    undercoverWord,
    undercoverCount,
    blankCount,
    blankWord,
  };
}

function createAssignments(agents, config) {
  const roles = [];
  const undercoverCount = normalizePositiveInteger(config.undercoverCount, 1, 1);
  const blankCount = normalizePositiveInteger(config.blankCount, 0, 0);

  for (let index = 0; index < undercoverCount; index += 1) {
    roles.push('undercover');
  }

  for (let index = 0; index < blankCount; index += 1) {
    roles.push('blank');
  }

  while (roles.length < agents.length) {
    roles.push('civilian');
  }

  shuffleInPlace(roles);

  return agents.map((agent, index) => {
    const role = roles[index] || 'civilian';
    const word =
      role === 'undercover'
        ? config.undercoverWord
        : role === 'blank'
          ? config.blankWord
          : config.civilianWord;

    return {
      agentId: agent.id,
      name: agent.name,
      role,
      word,
      eliminatedAt: null,
      eliminatedRound: null,
    };
  });
}

function isAlive(player) {
  return Boolean(player) && !player.eliminatedAt;
}

function countAliveByRole(players, role) {
  return (Array.isArray(players) ? players : []).filter((player) => isAlive(player) && player.role === role).length;
}

function evaluateWinner(state) {
  const players = Array.isArray(state && state.players) ? state.players : [];
  const aliveCivilianCount = countAliveByRole(players, 'civilian');
  const aliveUndercoverCount = countAliveByRole(players, 'undercover');
  const aliveBlankCount = countAliveByRole(players, 'blank');
  const hiddenRoleCount = aliveUndercoverCount + aliveBlankCount;

  if (hiddenRoleCount === 0) {
    return {
      team: 'civilian',
      reason: '所有隐藏身份玩家都已出局。',
    };
  }

  if (hiddenRoleCount >= aliveCivilianCount) {
    return {
      team: 'undercover',
      reason: '隐藏身份阵营人数已追平或超过平民阵营。',
    };
  }

  return null;
}

function summarizeVoteHistoryEntry(entry) {
  if (!entry || entry.type !== 'vote') {
    return null;
  }

  return {
    roundNumber: entry.roundNumber,
    eliminatedAgentId: entry.eliminatedAgentId || null,
    eliminatedName: entry.eliminatedName || '',
    resolution: entry.resolution || '',
    tieAgentIds: Array.isArray(entry.tieAgentIds) ? entry.tieAgentIds : [],
    votes: Array.isArray(entry.votes)
      ? entry.votes.map((vote) => ({
          voterAgentId: vote.voterAgentId,
          voterName: vote.voterName,
          targetAgentId: vote.targetAgentId,
          targetName: vote.targetName,
        }))
      : [],
  };
}

class WhoIsUndercoverHost {
  [key: string]: any;
/**
   * @param {{ agentDir?: string }} [options]
   */
  constructor(options: any = {}) {
    this.agentDir = path.resolve(options.agentDir || process.cwd());
    this.stateDir = resolveUndercoverStateDir(this.agentDir);
    ensureDir(this.stateDir);
  }

  getStatePath(conversationId) {
    return gameStatePath(this.stateDir, conversationId);
  }

  loadState(conversationId) {
    const statePath = this.getStatePath(conversationId);

    if (!fs.existsSync(statePath)) {
      return null;
    }

    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  }

  saveState(state) {
    const conversationId = String(state && state.conversationId ? state.conversationId : '').trim();

    if (!conversationId) {
      throw new Error('缺少会话 ID');
    }

    ensureDir(this.stateDir);
    const nextState = {
      ...state,
      updatedAt: nowIso(),
    };
    fs.writeFileSync(this.getStatePath(conversationId), JSON.stringify(nextState, null, 2), 'utf8');
    return nextState;
  }

  deleteState(conversationId) {
    const statePath = this.getStatePath(conversationId);

    if (fs.existsSync(statePath)) {
      fs.rmSync(statePath, { force: true });
    }
  }

  assertConversation(conversation) {
    if (!conversation) {
      throw new Error('会话不存在');
    }

    if (conversation.type !== UNDERCOVER_CONVERSATION_TYPE) {
      throw new Error('当前会话不是谁是卧底房间');
    }

    if (!Array.isArray(conversation.agents) || conversation.agents.length < 3) {
      throw new Error('谁是卧底至少需要 3 名参与者');
    }
  }

  createGame(conversation, rawConfig: any = {}) {
    this.assertConversation(conversation);
    const config = validateGameConfig(rawConfig, conversation.agents.length);
    const createdAt = nowIso();
    const assignments = createAssignments(conversation.agents, config);

    return this.saveState({
      version: DEFAULT_STATE_VERSION,
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      status: 'active',
      phase: 'ready_for_clues',
      roundNumber: 1,
      createdAt,
      startedAt: createdAt,
      endedAt: null,
      config,
      players: assignments,
      history: [],
      winner: null,
      revealedAt: null,
    });
  }

  getAlivePlayers(state) {
    return (Array.isArray(state && state.players) ? state.players : []).filter(isAlive);
  }

  getAliveAgentIds(state) {
    return this.getAlivePlayers(state).map((player) => player.agentId);
  }

  getPlayer(state, agentId) {
    return (Array.isArray(state && state.players) ? state.players : []).find((player) => player.agentId === agentId) || null;
  }

  getAssignments(state, options: any = {}) {
    const includeSecrets = options.includeSecrets === true;

    return (Array.isArray(state && state.players) ? state.players : []).map((player) => ({
      agentId: player.agentId,
      name: player.name,
      role: includeSecrets ? player.role : undefined,
      word: includeSecrets ? player.word : undefined,
      eliminatedAt: player.eliminatedAt || null,
      eliminatedRound: Number.isInteger(player.eliminatedRound) ? player.eliminatedRound : null,
      isAlive: isAlive(player),
    }));
  }

  buildRoleBriefing(player, state) {
    if (!player) {
      return '';
    }

    const roundNumber = Number.isInteger(state && state.roundNumber) ? state.roundNumber : 1;

    return [
      '你正在参加后端主持的“谁是卧底”房间。',
      `你的词语：${player.word || '无词'}`,
      '主持人不会直接告诉你自己的身份，你只能根据词语和场上发言自行判断。',
      `当前轮次：第 ${roundNumber} 轮`,
      '主持人由后端代码担任，不要自行分配身份、结算或宣布淘汰结果。',
      '发言阶段只给间接描述，不要直接说出词语，不要泄露这条私密消息。',
      '投票阶段按主持人的要求，仅输出一个投票对象，推荐格式：投票：@玩家名。',
      '如果你已经被淘汰，就不要继续参与后续回合发言或投票。',
    ].join('\n');
  }

  markClueRoundStarted(state) {
    return this.saveState({
      ...state,
      phase: 'clue_round',
    });
  }

  markClueRoundCompleted(state, replyMessages = []) {
    return this.saveState({
      ...state,
      phase: 'ready_for_vote',
      history: [
        ...(Array.isArray(state && state.history) ? state.history : []),
        {
          type: 'clue',
          roundNumber: Number.isInteger(state && state.roundNumber) ? state.roundNumber : 1,
          completedAt: nowIso(),
          replyMessageIds: (Array.isArray(replyMessages) ? replyMessages : []).map((message) => message.id).filter(Boolean),
        },
      ],
    });
  }

  applyVoteResult(state, voteResult: any = {}) {
    const nextState = {
      ...state,
      history: [...(Array.isArray(state && state.history) ? state.history : [])],
    };
    const roundNumber = Number.isInteger(state && state.roundNumber) ? state.roundNumber : 1;
    const eliminatedAgentId = voteResult.eliminatedAgentId || null;
    const eliminatedPlayer = eliminatedAgentId ? this.getPlayer(nextState, eliminatedAgentId) : null;

    if (eliminatedPlayer && !eliminatedPlayer.eliminatedAt) {
      eliminatedPlayer.eliminatedAt = nowIso();
      eliminatedPlayer.eliminatedRound = roundNumber;
    }

    nextState.history.push({
      type: 'vote',
      roundNumber,
      completedAt: nowIso(),
      eliminatedAgentId: eliminatedPlayer ? eliminatedPlayer.agentId : null,
      eliminatedName: eliminatedPlayer ? eliminatedPlayer.name : '',
      resolution: voteResult.resolution || '',
      tieAgentIds: Array.isArray(voteResult.tieAgentIds) ? voteResult.tieAgentIds : [],
      votes: Array.isArray(voteResult.votes) ? voteResult.votes : [],
    });

    const winner = evaluateWinner(nextState);

    if (winner) {
      nextState.status = 'completed';
      nextState.phase = 'finished';
      nextState.endedAt = nowIso();
      nextState.winner = winner;
    } else {
      nextState.phase = 'ready_for_clues';
      nextState.roundNumber = roundNumber + 1;
      nextState.winner = null;
    }

    return this.saveState(nextState);
  }

  revealState(state) {
    return this.saveState({
      ...state,
      status: state && state.status === 'completed' ? 'completed' : 'revealed',
      phase: 'finished',
      revealedAt: nowIso(),
    });
  }

  buildPublicState(state) {
    if (!state) {
      return {
        variant: UNDERCOVER_CONVERSATION_TYPE,
        status: 'setup',
        phase: 'setup',
        roundNumber: 1,
        players: [],
        aliveAgentIds: [],
        eliminatedAgentIds: [],
        config: null,
        winner: null,
        revealedAssignments: [],
      };
    }

    const players = this.getAssignments(state, {
      includeSecrets: state.status === 'revealed' || state.revealedAt || state.status === 'completed',
    });
    const lastVoteEntry = [...(Array.isArray(state.history) ? state.history : [])]
      .reverse()
      .find((entry) => entry && entry.type === 'vote');

    return {
      variant: UNDERCOVER_CONVERSATION_TYPE,
      status: state.status || 'setup',
      phase: state.phase || 'setup',
      roundNumber: Number.isInteger(state.roundNumber) ? state.roundNumber : 1,
      createdAt: state.createdAt || null,
      updatedAt: state.updatedAt || null,
      startedAt: state.startedAt || null,
      endedAt: state.endedAt || null,
      config: state.config
        ? {
            undercoverCount: state.config.undercoverCount,
            blankCount: state.config.blankCount,
            hasBlankWord: Boolean(state.config.blankWord),
            playerCount: players.length,
          }
        : null,
      players,
      aliveAgentIds: players.filter((player) => player.isAlive).map((player) => player.agentId),
      eliminatedAgentIds: players.filter((player) => !player.isAlive).map((player) => player.agentId),
      winner: state.winner || null,
      lastVote: summarizeVoteHistoryEntry(lastVoteEntry),
      revealedAssignments:
        state.status === 'revealed' || state.revealedAt || state.status === 'completed'
          ? players.map((player) => ({
              agentId: player.agentId,
              name: player.name,
              role: player.role || '',
              word: player.word || '',
              isAlive: player.isAlive,
            }))
          : [],
    };
  }
}

export function createWhoIsUndercoverHost(options: any = {}) {
  return new WhoIsUndercoverHost(options);
}
