const fs = require('node:fs');
const path = require('node:path');
const { randomInt } = require('node:crypto');

export const WEREWOLF_CONVERSATION_TYPE = 'werewolf';
export const WEREWOLF_SKILL_ID = 'werewolf';
const DEFAULT_STATE_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function resolveWerewolfStateDir(agentDir: string) {
  return path.resolve(agentDir, 'werewolf-games');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeConversationId(value: string) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function gameStatePath(stateDir: string, conversationId: string) {
  const normalizedId = sanitizeConversationId(conversationId);

  if (!normalizedId) {
    throw new Error('Conversation id is required');
  }

  return path.join(stateDir, `${normalizedId}.json`);
}

function shuffleInPlace(items: any[]) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    const nextValue = items[index];
    items[index] = items[swapIndex];
    items[swapIndex] = nextValue;
  }

  return items;
}

function normalizePositiveInteger(value: any, fallback: number, minimum = 0) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.max(minimum, parsed);
}

function validateGameConfig(config: any = {}, playerCount = 0) {
  // MVP默认配置：狼人×2、预言家×1、村民×其余
  const werewolfCount = normalizePositiveInteger(config.werewolfCount, 2, 1);
  const seerCount = normalizePositiveInteger(config.seerCount, 1, 0);
  const witchCount = normalizePositiveInteger(config.witchCount, 0, 0);

  if (playerCount < 4) {
    throw new Error('狼人杀至少需要 4 名参与者');
  }

  if (werewolfCount >= playerCount) {
    throw new Error('狼人数量必须小于玩家总数');
  }

  if (witchCount > 1) {
    throw new Error('女巫数量目前只支持 0 或 1');
  }

  if (werewolfCount + seerCount + witchCount >= playerCount) {
    throw new Error('狼人数量与预言家数量之和必须小于玩家总数');
  }

  return {
    werewolfCount,
    seerCount,
    witchCount,
    villagerCount: playerCount - werewolfCount - seerCount - witchCount,
  };
}

function createAssignments(agents: any[], config: any) {
  const roles: string[] = [];
  const werewolfCount = normalizePositiveInteger(config.werewolfCount, 2, 1);
  const seerCount = normalizePositiveInteger(config.seerCount, 1, 0);
  const witchCount = normalizePositiveInteger(config.witchCount, 0, 0);

  // 分配狼人角色
  for (let index = 0; index < werewolfCount; index += 1) {
    roles.push('werewolf');
  }

  // 分配预言家角色
  for (let index = 0; index < seerCount; index += 1) {
    roles.push('seer');
  }

  for (let index = 0; index < witchCount; index += 1) {
    roles.push('witch');
  }

  // 其余为村民
  const normalizedAgents = Array.isArray(agents) ? agents : [];
  while (roles.length < normalizedAgents.length) {
    roles.push('villager');
  }

  shuffleInPlace(roles);

  return normalizedAgents.map((agent: any, index: number) => {
    const role = roles[index] || 'villager';

    return {
      agentId: agent.id,
      name: agent.name,
      role,
      eliminatedAt: null as string | null,
      eliminatedPhase: null as string | null,
      eliminatedRound: null as number | null,
    };
  });
}

function isAlive(player: any) {
  return Boolean(player) && !player.eliminatedAt;
}

function countAliveByRole(players: any[], role: string) {
  return (Array.isArray(players) ? players : []).filter((player: any) => isAlive(player) && player.role === role).length;
}

function getWerewolfTeammates(players: any[], player: any) {
  if (!player || player.role !== 'werewolf') {
    return [];
  }

  return (Array.isArray(players) ? players : [])
    .filter((p: any) => p.agentId !== player.agentId && p.role === 'werewolf')
    .map((p: any) => ({ agentId: p.agentId, name: p.name }));
}

function evaluateWinner(state: any) {
  const players = Array.isArray(state && state.players) ? state.players : [];
  const aliveWerewolfCount = countAliveByRole(players, 'werewolf');
  const aliveGoodCount = players.filter((p: any) => isAlive(p) && p.role !== 'werewolf').length;

  // 狼人胜利：所有好人死亡 或 狼人数量 >= 好人数量
  if (aliveWerewolfCount === 0) {
    return {
      team: 'good',
      reason: '所有狼人已被淘汰。',
    };
  }

  if (aliveWerewolfCount >= aliveGoodCount) {
    return {
      team: 'werewolf',
      reason: '狼人数量已追平或超过好人阵营。',
    };
  }

  return null;
}

class WerewolfHost {
  agentDir: string;
  stateDir: string;

  constructor(options: any = {}) {
    this.agentDir = path.resolve(options.agentDir || process.cwd());
    this.stateDir = resolveWerewolfStateDir(this.agentDir);
    ensureDir(this.stateDir);
  }

  getStatePath(conversationId: string) {
    return gameStatePath(this.stateDir, conversationId);
  }

  loadState(conversationId: string) {
    const statePath = this.getStatePath(conversationId);

    if (!fs.existsSync(statePath)) {
      return null;
    }

    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  }

  saveState(state: any) {
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

  deleteState(conversationId: string) {
    const statePath = this.getStatePath(conversationId);

    if (fs.existsSync(statePath)) {
      fs.rmSync(statePath, { force: true });
    }
  }

  assertConversation(conversation: any) {
    if (!conversation) {
      throw new Error('会话不存在');
    }

    if (conversation.type !== WEREWOLF_CONVERSATION_TYPE) {
      throw new Error('当前会话不是狼人杀房间');
    }

    if (!Array.isArray(conversation.agents) || conversation.agents.length < 4) {
      throw new Error('狼人杀至少需要 4 名参与者');
    }
  }

  createGame(conversation: any, rawConfig: any = {}) {
    this.assertConversation(conversation);
    const config = validateGameConfig(rawConfig, conversation.agents.length);
    const createdAt = nowIso();
    const assignments = createAssignments(conversation.agents, config);

    return this.saveState({
      version: DEFAULT_STATE_VERSION,
      conversationId: conversation.id,
      conversationTitle: conversation.title,
      status: 'active',
      phase: 'night',
      roundNumber: 1,
      createdAt,
      startedAt: createdAt,
      endedAt: null,
      config,
      players: assignments,
      witchPotions: {
        antidoteUsed: false,
        poisonUsed: false,
      },
      nightActions: {
        werewolfTarget: null as string | null,
        seerTarget: null as string | null,
        seerResult: null as string | null,
        witchSaved: false,
        witchPoisonTarget: null as string | null,
      },
      history: [],
      winner: null,
      revealedAt: null,
    });
  }

  getAlivePlayers(state: any) {
    return (Array.isArray(state && state.players) ? state.players : []).filter(isAlive);
  }

  getAliveAgentIds(state: any) {
    return this.getAlivePlayers(state).map((player: any) => player.agentId);
  }

  getPlayer(state: any, agentId: string) {
    return (Array.isArray(state && state.players) ? state.players : []).find((player: any) => player.agentId === agentId) || null;
  }

  getAssignments(state: any, options: any = {}) {
    const includeSecrets = options.includeSecrets === true;

    return (Array.isArray(state && state.players) ? state.players : []).map((player: any) => ({
      agentId: player.agentId,
      name: player.name,
      role: includeSecrets ? player.role : undefined,
      eliminatedAt: player.eliminatedAt || null,
      eliminatedPhase: player.eliminatedPhase || null,
      eliminatedRound: Number.isInteger(player.eliminatedRound) ? player.eliminatedRound : null,
      isAlive: isAlive(player),
    }));
  }

  buildRoleBriefing(player: any, state: any) {
    if (!player) {
      return '';
    }

    const roundNumber = Number.isInteger(state && state.roundNumber) ? state.roundNumber : 1;
    const phase = state && state.phase ? state.phase : 'night';
    const phaseLabel = phase === 'night' ? '夜间' : phase === 'day' ? '白天' : phase === 'vote' ? '投票' : '未知';

    const baseMessage = [
      '你正在参加后端主持的"狼人杀"房间。',
      `你的身份：${player.role === 'werewolf' ? '狼人' : player.role === 'seer' ? '预言家' : '村民'}`,
      `当前轮次：第 ${roundNumber} 轮 - ${phaseLabel}`,
    ];

    if (player.role === 'witch') {
      baseMessage[1] = '你的身份：女巫';
    }

    if (player.role === 'werewolf') {
      const teammates = getWerewolfTeammates(state.players, player);
      if (teammates.length > 0) {
        baseMessage.push(`你的狼人队友：${teammates.map((t: any) => `@${t.name}`).join('、')}`);
      }
      baseMessage.push('夜间你可以和队友讨论并选择击杀目标。');
    } else if (player.role === 'seer') {
      baseMessage.push('每晚你可以查验一名玩家的身份。');
    } else if (player.role === 'witch') {
      baseMessage.push('每晚你可以选择使用一次性解药救下被狼人袭击的人，或使用一次性毒药毒死一名存活玩家（每晚最多使用 1 瓶）。');
      baseMessage.push('请只通过私密邮箱提交你的行动：');
      baseMessage.push('救：@玩家名  或  毒：@玩家名  或  不使用');
    } else {
      baseMessage.push('你没有特殊技能，通过白天发言和投票找出狼人。');
    }

    baseMessage.push('主持人由后端代码担任，不要自行分配身份、结算或宣布死亡结果。');
    baseMessage.push('身份信息只留在私密邮箱，不要发到公开聊天。');

    return baseMessage.join('\n');
  }

  buildSeerResult(player: any, targetPlayer: any) {
    if (!player || player.role !== 'seer' || !targetPlayer) {
      return '';
    }

    const roleLabel = targetPlayer.role === 'werewolf' ? '狼人' : '好人';
    return `【查验结果】@${targetPlayer.name} 是 ${roleLabel}`;
  }

  submitWerewolfAction(state: any, agentId: string, targetAgentId: string) {
    const player = this.getPlayer(state, agentId);
    const targetPlayer = this.getPlayer(state, targetAgentId);

    if (!player || player.role !== 'werewolf') {
      throw new Error('只有狼人可以执行狼人行动');
    }

    if (!targetPlayer || !isAlive(targetPlayer)) {
      throw new Error('目标玩家不存在或已死亡');
    }

    if (targetPlayer.role === 'werewolf') {
      throw new Error('狼人不能选择队友作为目标');
    }

    const nextState = {
      ...state,
      nightActions: {
        ...state.nightActions,
        werewolfTarget: targetAgentId,
      },
    };

    return this.saveState(nextState);
  }

  submitSeerAction(state: any, agentId: string, targetAgentId: string) {
    const player = this.getPlayer(state, agentId);
    const targetPlayer = this.getPlayer(state, targetAgentId);

    if (!player || player.role !== 'seer') {
      throw new Error('只有预言家可以执行查验行动');
    }

    if (!targetPlayer || !isAlive(targetPlayer)) {
      throw new Error('目标玩家不存在或已死亡');
    }

    const nextState = {
      ...state,
      nightActions: {
        ...state.nightActions,
        seerTarget: targetAgentId,
        seerResult: targetPlayer.role === 'werewolf' ? 'werewolf' : 'good',
      },
    };

    return this.saveState(nextState);
  }

  submitWitchSave(state: any, agentId: string) {
    const player = this.getPlayer(state, agentId);

    if (!player || player.role !== 'witch') {
      throw new Error('只有女巫可以使用药水');
    }

    if (!isAlive(player)) {
      throw new Error('已出局的女巫不能行动');
    }

    const potions = state && state.witchPotions ? state.witchPotions : { antidoteUsed: false, poisonUsed: false };

    if (potions.antidoteUsed) {
      throw new Error('解药已经用过了');
    }

    if (state.nightActions?.witchSaved || state.nightActions?.witchPoisonTarget) {
      throw new Error('本夜女巫已行动（每晚最多使用 1 瓶药）');
    }

    const victimId = state.nightActions?.werewolfTarget || null;

    if (!victimId) {
      throw new Error('当前没有狼人击杀目标，无法使用解药');
    }

    const victim = this.getPlayer(state, victimId);

    if (!victim || !isAlive(victim)) {
      throw new Error('救人目标无效或已出局');
    }

    return this.saveState({
      ...state,
      witchPotions: {
        ...potions,
        antidoteUsed: true,
      },
      nightActions: {
        ...state.nightActions,
        witchSaved: true,
      },
    });
  }

  submitWitchPoison(state: any, agentId: string, targetAgentId: string) {
    const player = this.getPlayer(state, agentId);
    const targetPlayer = this.getPlayer(state, targetAgentId);

    if (!player || player.role !== 'witch') {
      throw new Error('只有女巫可以使用药水');
    }

    if (!isAlive(player)) {
      throw new Error('已出局的女巫不能行动');
    }

    if (!targetPlayer || !isAlive(targetPlayer)) {
      throw new Error('毒人目标无效或已出局');
    }

    if (targetAgentId === agentId) {
      throw new Error('女巫不能毒自己');
    }

    const potions = state && state.witchPotions ? state.witchPotions : { antidoteUsed: false, poisonUsed: false };

    if (potions.poisonUsed) {
      throw new Error('毒药已经用过了');
    }

    if (state.nightActions?.witchSaved || state.nightActions?.witchPoisonTarget) {
      throw new Error('本夜女巫已行动（每晚最多使用 1 瓶药）');
    }

    return this.saveState({
      ...state,
      witchPotions: {
        ...potions,
        poisonUsed: true,
      },
      nightActions: {
        ...state.nightActions,
        witchPoisonTarget: targetAgentId,
      },
    });
  }

  resolveNight(state: any) {
    const nextState = {
      ...state,
      history: [...(Array.isArray(state && state.history) ? state.history : [])],
      players: (Array.isArray(state?.players) ? state.players : []).map((p: any) => ({ ...p })),
      nightActions: {
        ...state.nightActions,
      },
    };

    const roundNumber = Number.isInteger(state && state.roundNumber) ? state.roundNumber : 1;
    const werewolfTarget = state.nightActions && state.nightActions.werewolfTarget;
    let deathMessage = '昨晚是平安夜，没有人死亡。';
    let deathPlayer = null;

    if (werewolfTarget) {
      deathPlayer = this.getPlayer(nextState, werewolfTarget);
      if (deathPlayer && isAlive(deathPlayer)) {
        deathPlayer.eliminatedAt = nowIso();
        deathPlayer.eliminatedPhase = 'night';
        deathPlayer.eliminatedRound = roundNumber;
        deathMessage = `昨晚，@${deathPlayer.name} 被狼人杀害。`;
      }
    }

    const witchSaved = Boolean(state.nightActions && state.nightActions.witchSaved);
    const witchPoisonTarget = state.nightActions && state.nightActions.witchPoisonTarget;
    const deathLines: string[] = [];

    if (werewolfTarget) {
      const targetPlayer = this.getPlayer(nextState, werewolfTarget);

      if (targetPlayer) {
        if (witchSaved) {
          targetPlayer.eliminatedAt = null;
          targetPlayer.eliminatedPhase = null;
          targetPlayer.eliminatedRound = null;
          deathLines.push(`昨晚，@${targetPlayer.name} 遭到袭击，但被女巫救起。`);
          deathPlayer = null;
        } else if (targetPlayer.eliminatedAt) {
          deathLines.push(`昨晚，@${targetPlayer.name} 被狼人杀害。`);
        }
      }
    }

    let poisonDeathPlayer = null;
    if (witchPoisonTarget) {
      poisonDeathPlayer = this.getPlayer(nextState, witchPoisonTarget);
      if (poisonDeathPlayer && isAlive(poisonDeathPlayer)) {
        poisonDeathPlayer.eliminatedAt = nowIso();
        poisonDeathPlayer.eliminatedPhase = 'night';
        poisonDeathPlayer.eliminatedRound = roundNumber;
        deathLines.push(`昨晚，女巫毒死了 @${poisonDeathPlayer.name}。`);
      } else {
        poisonDeathPlayer = null;
      }
    }

    if (!deathPlayer && poisonDeathPlayer) {
      deathPlayer = poisonDeathPlayer;
    }

    if (deathLines.length === 0) {
      deathMessage = '昨晚是平安夜，没有人死亡。';
    } else {
      deathMessage = deathLines.join('\n');
    }

    nextState.history.push({
      type: 'night',
      roundNumber,
      completedAt: nowIso(),
      werewolfTarget,
      deathAgentId: deathPlayer ? deathPlayer.agentId : null,
      deathName: deathPlayer ? deathPlayer.name : '',
      deathMessage,
      seerTarget: state.nightActions?.seerTarget,
      seerResult: state.nightActions?.seerResult,
    });

    // 重置夜间行动
    nextState.nightActions = {
      werewolfTarget: null,
      seerTarget: null,
      seerResult: null,
      witchSaved: false,
      witchPoisonTarget: null,
    };

    // 检查胜负
    const winner = evaluateWinner(nextState);
    if (winner) {
      nextState.status = 'completed';
      nextState.phase = 'finished';
      nextState.endedAt = nowIso();
      nextState.winner = winner;
    } else {
      nextState.phase = 'day';
    }

    return this.saveState(nextState);
  }

  startVote(state: any) {
    return this.saveState({
      ...state,
      phase: 'vote',
    });
  }

  resolveVote(state: any, votes: any[]) {
    const nextState = {
      ...state,
      history: [...(Array.isArray(state && state.history) ? state.history : [])],
      players: (Array.isArray(state?.players) ? state.players : []).map((p: any) => ({ ...p })),
    };

    const roundNumber = Number.isInteger(state && state.roundNumber) ? state.roundNumber : 1;
    const alivePlayers = this.getAlivePlayers(nextState);
    const aliveAgentIds = alivePlayers.map((p: any) => p.agentId);

    // 统计票数
    const voteCounts = new Map<string, number>();
    for (const vote of Array.isArray(votes) ? votes : []) {
      if (!vote.targetAgentId || !aliveAgentIds.includes(vote.targetAgentId)) {
        continue;
      }
      voteCounts.set(vote.targetAgentId, (voteCounts.get(vote.targetAgentId) || 0) + 1);
    }

    // 找出最高票
    let eliminatedAgentId: string | null = null;
    let tieAgentIds: string[] = [];

    if (voteCounts.size > 0) {
      const highestVoteCount = Math.max(...voteCounts.values());
      tieAgentIds = Array.from(voteCounts.entries())
        .filter(([, count]) => count === highestVoteCount)
        .map(([agentId]) => agentId);

      // 只有唯一最高票时才处决，平票则无人处决
      if (tieAgentIds.length === 1) {
        eliminatedAgentId = tieAgentIds[0];
      }
    }

    let voteMessage = '投票结束，无人被处决。';
    let eliminatedPlayer = null;

    if (eliminatedAgentId) {
      eliminatedPlayer = this.getPlayer(nextState, eliminatedAgentId);
      if (eliminatedPlayer) {
        eliminatedPlayer.eliminatedAt = nowIso();
        eliminatedPlayer.eliminatedPhase = 'vote';
        eliminatedPlayer.eliminatedRound = roundNumber;
        voteMessage = `投票结束，@${eliminatedPlayer.name} 被处决。`;
      }
    }

    // 记录投票历史
    nextState.history.push({
      type: 'vote',
      roundNumber,
      completedAt: nowIso(),
      eliminatedAgentId,
      eliminatedName: eliminatedPlayer ? eliminatedPlayer.name : '',
      tieAgentIds,
      votes: Array.isArray(votes) ? votes : [],
      voteCounts: Object.fromEntries(voteCounts),
      voteMessage,
    });

    // 检查胜负
    const winner = evaluateWinner(nextState);
    if (winner) {
      nextState.status = 'completed';
      nextState.phase = 'finished';
      nextState.endedAt = nowIso();
      nextState.winner = winner;
    } else {
      // 进入下一个夜晚
      nextState.phase = 'night';
      nextState.roundNumber = roundNumber + 1;
    }

    return this.saveState(nextState);
  }

  revealState(state: any) {
    return this.saveState({
      ...state,
      status: state && state.status === 'completed' ? 'completed' : 'revealed',
      phase: 'finished',
      revealedAt: nowIso(),
    });
  }

  buildPublicState(state: any) {
    if (!state) {
      return {
        variant: WEREWOLF_CONVERSATION_TYPE,
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

    const shouldReveal = state.status === 'revealed' || state.status === 'completed' || Boolean(state.revealedAt);
    const players = this.getAssignments(state, {
      includeSecrets: shouldReveal,
    });

    return {
      variant: WEREWOLF_CONVERSATION_TYPE,
      status: state.status || 'setup',
      phase: state.phase || 'setup',
      roundNumber: Number.isInteger(state.roundNumber) ? state.roundNumber : 1,
      createdAt: state.createdAt || null,
      updatedAt: state.updatedAt || null,
      startedAt: state.startedAt || null,
      endedAt: state.endedAt || null,
      config: state.config
        ? {
            werewolfCount: state.config.werewolfCount,
            seerCount: state.config.seerCount,
            witchCount: state.config.witchCount,
            villagerCount: state.config.villagerCount,
            playerCount: players.length,
          }
        : null,
      players,
      aliveAgentIds: players.filter((p: any) => p.isAlive).map((p: any) => p.agentId),
      eliminatedAgentIds: players.filter((p: any) => !p.isAlive).map((p: any) => p.agentId),
      winner: state.winner || null,
      revealedAssignments: shouldReveal
          ? players.map((p: any) => ({
              agentId: p.agentId,
              name: p.name,
              role: p.role || '',
              isAlive: p.isAlive,
            }))
          : [],
    };
  }
}

export function createWerewolfHost(options: any = {}) {
  return new WerewolfHost(options);
}
