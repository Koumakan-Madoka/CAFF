const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createWerewolfHost, WEREWOLF_CONVERSATION_TYPE } = require('../../build/lib/werewolf-game');
const { createWerewolfService } = require('../../build/server/domain/werewolf/werewolf-service');
const { withTempDir } = require('../helpers/temp-dir');

function createMockConversation(agentCount = 6) {
  const agents = [];
  for (let i = 0; i < agentCount; i++) {
    agents.push({
      id: `agent-${i}`,
      name: `Player${i + 1}`,
    });
  }
  return {
    id: 'test-conversation',
    type: WEREWOLF_CONVERSATION_TYPE,
    title: 'Test Werewolf Game',
    agents,
  };
}

test('werewolf host creates a game with correct role distribution', () => {
  const tempDir = withTempDir('werewolf-test-');
  const host = createWerewolfHost({ agentDir: tempDir });
  const conversation = createMockConversation(6);

  const state = host.createGame(conversation, { werewolfCount: 2, seerCount: 1 });

  assert.equal(state.status, 'active');
  assert.equal(state.phase, 'night');
  assert.equal(state.roundNumber, 1);
  assert.equal(state.config.werewolfCount, 2);
  assert.equal(state.config.seerCount, 1);
  assert.equal(state.config.villagerCount, 3);
  assert.equal(state.players.length, 6);

  // 验证角色分配
  const roles = state.players.map((p) => p.role);
  const werewolfCount = roles.filter((r) => r === 'werewolf').length;
  const seerCount = roles.filter((r) => r === 'seer').length;
  const villagerCount = roles.filter((r) => r === 'villager').length;

  assert.equal(werewolfCount, 2);
  assert.equal(seerCount, 1);
  assert.equal(villagerCount, 3);
});

test('werewolf host creates a game with witch when configured', () => {
  const tempDir = withTempDir('werewolf-test-');
  const host = createWerewolfHost({ agentDir: tempDir });
  const conversation = createMockConversation(6);

  const state = host.createGame(conversation, { werewolfCount: 2, seerCount: 1, witchCount: 1 });

  assert.equal(state.config.witchCount, 1);
  assert.equal(state.config.villagerCount, 2);

  const roles = state.players.map((p) => p.role);
  const witchCount = roles.filter((r) => r === 'witch').length;
  assert.equal(witchCount, 1);
});

test('werewolf host rejects invalid game configuration', () => {
  const tempDir = withTempDir('werewolf-test-');
  const host = createWerewolfHost({ agentDir: tempDir });

  // 少于 4 人
  const smallConversation = createMockConversation(3);
  assert.throws(() => host.createGame(smallConversation, {}), /至少需要 4 名参与者/);

  // 狼人数量 >= 玩家数量
  const badConfigConversation = createMockConversation(4);
  assert.throws(() => host.createGame(badConfigConversation, { werewolfCount: 4 }), /狼人数量必须小于玩家总数/);
});

test('werewolf host builds role briefing for werewolf', () => {
  const tempDir = withTempDir('werewolf-test-');
  const host = createWerewolfHost({ agentDir: tempDir });
  const conversation = createMockConversation(6);

  const state = host.createGame(conversation, { werewolfCount: 2, seerCount: 1 });
  const werewolfPlayer = state.players.find((p) => p.role === 'werewolf');

  const briefing = host.buildRoleBriefing(werewolfPlayer, state);

  assert.ok(briefing.includes('狼人'));
  assert.ok(briefing.includes('夜间你可以和队友讨论并选择击杀目标'));
});

test('werewolf host builds role briefing for seer', () => {
  const tempDir = withTempDir('werewolf-test-');
  const host = createWerewolfHost({ agentDir: tempDir });
  const conversation = createMockConversation(6);

  const state = host.createGame(conversation, { werewolfCount: 2, seerCount: 1 });
  const seerPlayer = state.players.find((p) => p.role === 'seer');

  const briefing = host.buildRoleBriefing(seerPlayer, state);

  assert.ok(briefing.includes('预言家'));
  assert.ok(briefing.includes('每晚你可以查验一名玩家的身份'));
});

test('werewolf host submits werewolf action correctly', () => {
  const tempDir = withTempDir('werewolf-test-');
  const host = createWerewolfHost({ agentDir: tempDir });
  const conversation = createMockConversation(6);

  const state = host.createGame(conversation, { werewolfCount: 2, seerCount: 1 });
  const werewolfPlayer = state.players.find((p) => p.role === 'werewolf');
  const villagerPlayer = state.players.find((p) => p.role === 'villager');

  const nextState = host.submitWerewolfAction(state, werewolfPlayer.agentId, villagerPlayer.agentId);

  assert.equal(nextState.nightActions.werewolfTarget, villagerPlayer.agentId);
});

test('werewolf host rejects werewolf targeting teammate', () => {
  const tempDir = withTempDir('werewolf-test-');
  const host = createWerewolfHost({ agentDir: tempDir });
  const conversation = createMockConversation(6);

  const state = host.createGame(conversation, { werewolfCount: 2, seerCount: 1 });
  const werewolves = state.players.filter((p) => p.role === 'werewolf');

  assert.throws(() => host.submitWerewolfAction(state, werewolves[0].agentId, werewolves[1].agentId), /狼人不能选择队友作为目标/);
});

test('werewolf host submits seer action and returns result', () => {
  const tempDir = withTempDir('werewolf-test-');
  const host = createWerewolfHost({ agentDir: tempDir });
  const conversation = createMockConversation(6);

  const state = host.createGame(conversation, { werewolfCount: 2, seerCount: 1 });
  const seerPlayer = state.players.find((p) => p.role === 'seer');
  const werewolfPlayer = state.players.find((p) => p.role === 'werewolf');

  const nextState = host.submitSeerAction(state, seerPlayer.agentId, werewolfPlayer.agentId);

  assert.equal(nextState.nightActions.seerTarget, werewolfPlayer.agentId);
  assert.equal(nextState.nightActions.seerResult, 'werewolf');
});

test('werewolf host allows witch to save werewolf victim', () => {
  const tempDir = withTempDir('werewolf-test-');
  const host = createWerewolfHost({ agentDir: tempDir });
  const conversation = createMockConversation(6);

  let state = host.createGame(conversation, { werewolfCount: 1, seerCount: 0, witchCount: 1 });
  const werewolfPlayer = state.players.find((p) => p.role === 'werewolf');
  const witchPlayer = state.players.find((p) => p.role === 'witch');
  const victimPlayer = state.players.find((p) => p.role === 'villager');

  state = host.submitWerewolfAction(state, werewolfPlayer.agentId, victimPlayer.agentId);
  state = host.submitWitchSave(state, witchPlayer.agentId);
  state = host.resolveNight(state);

  assert.equal(state.witchPotions.antidoteUsed, true);
  const victimAfter = state.players.find((p) => p.agentId === victimPlayer.agentId);
  assert.equal(victimAfter.eliminatedAt, null);
});

test('werewolf host allows witch to poison a player', () => {
  const tempDir = withTempDir('werewolf-test-');
  const host = createWerewolfHost({ agentDir: tempDir });
  const conversation = createMockConversation(6);

  let state = host.createGame(conversation, { werewolfCount: 1, seerCount: 0, witchCount: 1 });
  const witchPlayer = state.players.find((p) => p.role === 'witch');
  const targetPlayer = state.players.find((p) => p.role === 'villager');

  state = host.submitWitchPoison(state, witchPlayer.agentId, targetPlayer.agentId);
  state = host.resolveNight(state);

  assert.equal(state.witchPotions.poisonUsed, true);
  const targetAfter = state.players.find((p) => p.agentId === targetPlayer.agentId);
  assert.ok(targetAfter.eliminatedAt);
});

test('werewolf host rejects witch using two potions in same night', () => {
  const tempDir = withTempDir('werewolf-test-');
  const host = createWerewolfHost({ agentDir: tempDir });
  const conversation = createMockConversation(6);

  let state = host.createGame(conversation, { werewolfCount: 1, seerCount: 0, witchCount: 1 });
  const werewolfPlayer = state.players.find((p) => p.role === 'werewolf');
  const witchPlayer = state.players.find((p) => p.role === 'witch');
  const victimPlayer = state.players.find((p) => p.role === 'villager');
  const poisonTarget = state.players.find((p) => p.role === 'villager' && p.agentId !== victimPlayer.agentId);

  state = host.submitWerewolfAction(state, werewolfPlayer.agentId, victimPlayer.agentId);
  state = host.submitWitchSave(state, witchPlayer.agentId);

  assert.throws(
    () => host.submitWitchPoison(state, witchPlayer.agentId, poisonTarget.agentId),
    /本夜女巫已行动/
  );
});

test('werewolf host resolves night with death', () => {
  const tempDir = withTempDir('werewolf-test-');
  const host = createWerewolfHost({ agentDir: tempDir });
  const conversation = createMockConversation(6);

  let state = host.createGame(conversation, { werewolfCount: 2, seerCount: 1 });
  const werewolfPlayer = state.players.find((p) => p.role === 'werewolf');
  const villagerPlayer = state.players.find((p) => p.role === 'villager');

  state = host.submitWerewolfAction(state, werewolfPlayer.agentId, villagerPlayer.agentId);
  state = host.resolveNight(state);

  // 被刀的村民应该死亡
  const deadPlayer = state.players.find((p) => p.agentId === villagerPlayer.agentId);
  assert.ok(deadPlayer.eliminatedAt);
  assert.equal(deadPlayer.eliminatedPhase, 'night');
  assert.equal(deadPlayer.eliminatedRound, 1);

  // 应该进入白天阶段
  assert.equal(state.phase, 'day');
});

test('werewolf host resolves night without death (safe night)', () => {
  const tempDir = withTempDir('werewolf-test-');
  const host = createWerewolfHost({ agentDir: tempDir });
  const conversation = createMockConversation(6);

  let state = host.createGame(conversation, { werewolfCount: 2, seerCount: 1 });

  // 不提交任何狼人行动
  state = host.resolveNight(state);

  // 应该是平安夜
  const history = state.history.find((h) => h.type === 'night' && h.roundNumber === 1);
  assert.ok(history.deathMessage.includes('平安夜'));

  // 应该进入白天阶段
  assert.equal(state.phase, 'day');
});

test('werewolf host resolves vote with elimination', () => {
  const tempDir = withTempDir('werewolf-test-');
  const host = createWerewolfHost({ agentDir: tempDir });
  const conversation = createMockConversation(6);

  let state = host.createGame(conversation, { werewolfCount: 2, seerCount: 1 });

  // 跳到投票阶段
  state = host.startVote(state);

  const alivePlayers = host.getAlivePlayers(state);
  const targetPlayer = alivePlayers.find((p) => p.role === 'werewolf');

  // 创建投票：所有人都投给目标
  const votes = alivePlayers.map((p) => ({
    agentId: p.agentId,
    targetAgentId: targetPlayer.agentId,
  }));

  state = host.resolveVote(state, votes);

  // 被投的狼人应该死亡
  const deadPlayer = state.players.find((p) => p.agentId === targetPlayer.agentId);
  assert.ok(deadPlayer.eliminatedAt);
  assert.equal(deadPlayer.eliminatedPhase, 'vote');
});

test('werewolf host resolves vote with tie - no elimination', () => {
  const tempDir = withTempDir('werewolf-test-');
  const host = createWerewolfHost({ agentDir: tempDir });
  const conversation = createMockConversation(6);

  let state = host.createGame(conversation, { werewolfCount: 2, seerCount: 1 });

  // 跳到投票阶段
  state = host.startVote(state);

  const alivePlayers = host.getAlivePlayers(state);
  const target1 = alivePlayers[0];
  const target2 = alivePlayers[1];

  // 创建平票：一半人投 target1，一半人投 target2
  const votes = [
    { agentId: alivePlayers[0].agentId, targetAgentId: target1.agentId },
    { agentId: alivePlayers[1].agentId, targetAgentId: target1.agentId },
    { agentId: alivePlayers[2].agentId, targetAgentId: target2.agentId },
    { agentId: alivePlayers[3].agentId, targetAgentId: target2.agentId },
    { agentId: alivePlayers[4].agentId, targetAgentId: target1.agentId },
    { agentId: alivePlayers[5].agentId, targetAgentId: target2.agentId },
  ];

  state = host.resolveVote(state, votes);

  // 平票，应该无人死亡
  const history = state.history.find((h) => h.type === 'vote' && h.roundNumber === 1);
  assert.ok(history);
  assert.ok(history.voteMessage.includes('无人被处决') || history.eliminatedAgentId === null);
});

test('werewolf host evaluates werewolf win condition - equal count', () => {
  const tempDir = withTempDir('werewolf-test-');
  const host = createWerewolfHost({ agentDir: tempDir });
  const conversation = createMockConversation(6);

  let state = host.createGame(conversation, { werewolfCount: 2, seerCount: 1 });

  // 杀死 3 个好人，剩下 1 狼人 1 好人
  const werewolf = state.players.find((p) => p.role === 'werewolf');
  const goodPlayers = state.players.filter((p) => p.role !== 'werewolf');

  // 杀死所有好人
  for (const player of goodPlayers) {
    state = host.submitWerewolfAction(state, werewolf.agentId, player.agentId);
    state = host.resolveNight(state);
    if (state.winner) break;
  }

  // 狼人应该胜利
  assert.equal(state.winner.team, 'werewolf');
  assert.equal(state.status, 'completed');
});

test('werewolf host evaluates good win condition - all werewolves dead', () => {
  const tempDir = withTempDir('werewolf-test-');
  const host = createWerewolfHost({ agentDir: tempDir });
  const conversation = createMockConversation(6);

  let state = host.createGame(conversation, { werewolfCount: 2, seerCount: 1 });
  const werewolves = state.players.filter((p) => p.role === 'werewolf');

  // 跳到投票阶段，投死所有狼人
  for (const wolf of werewolves) {
    if (state.winner) break;
    state = host.startVote(state);
    const alivePlayers = host.getAlivePlayers(state);
    const votes = alivePlayers.map((p) => ({
      agentId: p.agentId,
      targetAgentId: wolf.agentId,
    }));
    state = host.resolveVote(state, votes);
  }

  // 好人应该胜利
  assert.equal(state.winner.team, 'good');
  assert.equal(state.status, 'completed');
});

test('werewolf host reveals state at end of game', () => {
  const tempDir = withTempDir('werewolf-test-');
  const host = createWerewolfHost({ agentDir: tempDir });
  const conversation = createMockConversation(6);

  let state = host.createGame(conversation, { werewolfCount: 2, seerCount: 1 });
  const werewolves = state.players.filter((p) => p.role === 'werewolf');

  // 投死所有狼人
  for (const wolf of werewolves) {
    if (state.winner) break;
    state = host.startVote(state);
    const alivePlayers = host.getAlivePlayers(state);
    const votes = alivePlayers.map((p) => ({
      agentId: p.agentId,
      targetAgentId: wolf.agentId,
    }));
    state = host.resolveVote(state, votes);
  }

  // 揭示身份
  state = host.revealState(state);

  const publicState = host.buildPublicState(state);
  assert.ok(publicState.revealedAssignments.length > 0);
  assert.ok(publicState.revealedAssignments.every((p) => p.role));
});

test('werewolf host persists state across instances', () => {
  const tempDir = withTempDir('werewolf-test-');
  const conversation = createMockConversation(6);

  // 创建游戏
  let host = createWerewolfHost({ agentDir: tempDir });
  let state = host.createGame(conversation, { werewolfCount: 2, seerCount: 1 });
  const conversationId = state.conversationId;

  // 创建新实例并加载状态
  host = createWerewolfHost({ agentDir: tempDir });
  state = host.loadState(conversationId);

  assert.ok(state);
  assert.equal(state.conversationId, conversationId);
  assert.equal(state.players.length, 6);
});

test('werewolf host builds public state without revealing roles during game', () => {
  const tempDir = withTempDir('werewolf-test-');
  const host = createWerewolfHost({ agentDir: tempDir });
  const conversation = createMockConversation(6);

  const state = host.createGame(conversation, { werewolfCount: 2, seerCount: 1 });
  const publicState = host.buildPublicState(state);

  assert.equal(publicState.variant, WEREWOLF_CONVERSATION_TYPE);
  assert.equal(publicState.status, 'active');
  assert.equal(publicState.phase, 'night');

  // 游戏进行中不应显示角色
  assert.ok(publicState.players.every((p) => p.role === undefined));
  assert.equal(publicState.revealedAssignments.length, 0);
});

test('werewolf host provides seer result message', () => {
  const tempDir = withTempDir('werewolf-test-');
  const host = createWerewolfHost({ agentDir: tempDir });
  const conversation = createMockConversation(6);

  const state = host.createGame(conversation, { werewolfCount: 2, seerCount: 1 });
  const seerPlayer = state.players.find((p) => p.role === 'seer');
  const werewolfPlayer = state.players.find((p) => p.role === 'werewolf');
  const villagerPlayer = state.players.find((p) => p.role === 'villager');

  const werewolfResult = host.buildSeerResult(seerPlayer, werewolfPlayer);
  assert.ok(werewolfResult.includes('狼人'));

  const villagerResult = host.buildSeerResult(seerPlayer, villagerPlayer);
  assert.ok(villagerResult.includes('好人'));
});

test('werewolf vote parsing tolerates tool-call wrappers and ignores narrative fragments', async (t) => {
  const tempDir = withTempDir('werewolf-test-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const host = createWerewolfHost({ agentDir: tempDir });

  t.after(() => {
    try {
      store && store.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  const agents = [
    { id: 'test-agent-gg', name: '咕咕' },
    { id: 'test-agent-fbb', name: '菲比啾比' },
    { id: 'test-agent-krs', name: '牧濑红莉栖' },
    { id: 'test-agent-ask', name: '明日香' },
  ];

  for (const agent of agents) {
    store.saveAgent({
      id: agent.id,
      name: agent.name,
      personaPrompt: 'Reply tersely.',
    });
  }

  store.createConversation({
    id: 'test-werewolf-vote-parse',
    title: 'Werewolf Vote Parse Test',
    type: 'werewolf',
    participants: agents.map((agent) => agent.id),
  });

  const conversation = store.getConversation('test-werewolf-vote-parse');
  let state = host.createGame(conversation, { werewolfCount: 1, seerCount: 1 });
  state = host.startVote(state);

  const toolCallWrappedVote = `{\"type\":\"toolCall\",\"id\":\"tool_test\",\"name\":\"bash\",\"arguments\":{\"command\":\"cat <<'CAFF_PUBLIC_EOF' | node \\\"$CAFF_CHAT_TOOLS_PATH\\\" send-public --content-stdin\n（歪头，豆豆眼眨了眨）\n\n咕咕投票…投给菲比啾比姐姐咕…\n\n投票：@菲比啾比\nCAFF_PUBLIC_EOF\"}}`;

  const turnOrchestrator = {
    runConversationTurn: async () => ({
      replies: [
        { agentId: 'test-agent-gg', content: toolCallWrappedVote },
        { agentId: 'test-agent-krs', content: '投票：@菲比啾比' },
        { agentId: 'test-agent-ask', content: '投票：@牧濑红莉栖' },
      ],
    }),
  };

  const service = createWerewolfService({
    store,
    skillRegistry: {},
    turnOrchestrator,
    werewolfHost: host,
    broadcastEvent: () => {},
    broadcastConversationSummary: () => {},
  });

  await service.runVotePhase('test-werewolf-vote-parse');

  const finalState = host.loadState('test-werewolf-vote-parse');
  const lastEntry = finalState.history[finalState.history.length - 1];
  assert.equal(lastEntry.type, 'vote');
  assert.equal(lastEntry.eliminatedAgentId, 'test-agent-fbb');
});

test('werewolf vote parsing does not fall back to @mentions when directives are invalid', async (t) => {
  const tempDir = withTempDir('werewolf-test-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const host = createWerewolfHost({ agentDir: tempDir });

  t.after(() => {
    try {
      store && store.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  const agents = [
    { id: 'test-agent-a', name: 'Alice' },
    { id: 'test-agent-b', name: 'Bob' },
    { id: 'test-agent-c', name: 'Charlie' },
    { id: 'test-agent-d', name: 'Dora' },
  ];

  for (const agent of agents) {
    store.saveAgent({
      id: agent.id,
      name: agent.name,
      personaPrompt: 'Reply tersely.',
    });
  }

  store.createConversation({
    id: 'test-werewolf-vote-no-fallback',
    title: 'Werewolf Vote Parse No Fallback Test',
    type: 'werewolf',
    participants: agents.map((agent) => agent.id),
  });

  const conversation = store.getConversation('test-werewolf-vote-no-fallback');
  let state = host.createGame(conversation, { werewolfCount: 1, seerCount: 1 });
  state = host.startVote(state);

  const invalidDirectiveWithMention = '投票：@NotAPlayer\n@Charlie';

  const turnOrchestrator = {
    runConversationTurn: async () => ({
      replies: [
        { agentId: 'test-agent-a', content: invalidDirectiveWithMention },
        { agentId: 'test-agent-b', content: '投票：@Charlie' },
        { agentId: 'test-agent-c', content: '投票：@Bob' },
        { agentId: 'test-agent-d', content: '投票：@Bob' },
      ],
    }),
  };

  const service = createWerewolfService({
    store,
    skillRegistry: {},
    turnOrchestrator,
    werewolfHost: host,
    broadcastEvent: () => {},
    broadcastConversationSummary: () => {},
  });

  await service.runVotePhase('test-werewolf-vote-no-fallback');

  const finalState = host.loadState('test-werewolf-vote-no-fallback');
  const lastEntry = finalState.history[finalState.history.length - 1];
  assert.equal(lastEntry.type, 'vote');
  assert.equal(lastEntry.eliminatedAgentId, 'test-agent-b');
});

test('werewolf vote parsing supports emoji-prefixed names', async (t) => {
  const tempDir = withTempDir('werewolf-test-');
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const host = createWerewolfHost({ agentDir: tempDir });

  t.after(() => {
    try {
      store && store.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  const agents = [
    { id: 'test-agent-alice', name: 'Alice' },
    { id: 'test-agent-bot', name: '🤖Bot' },
    { id: 'test-agent-charlie', name: 'Charlie' },
    { id: 'test-agent-dora', name: 'Dora' },
  ];

  for (const agent of agents) {
    store.saveAgent({
      id: agent.id,
      name: agent.name,
      personaPrompt: 'Reply tersely.',
    });
  }

  store.createConversation({
    id: 'test-werewolf-vote-emoji-name',
    title: 'Werewolf Vote Parse Emoji Name Test',
    type: 'werewolf',
    participants: agents.map((agent) => agent.id),
  });

  const conversation = store.getConversation('test-werewolf-vote-emoji-name');
  let state = host.createGame(conversation, { werewolfCount: 1, seerCount: 1 });
  state = host.startVote(state);

  const turnOrchestrator = {
    runConversationTurn: async () => ({
      replies: [
        { agentId: 'test-agent-alice', content: '投票：@🤖Bot' },
        { agentId: 'test-agent-charlie', content: '投票：@🤖Bot' },
        { agentId: 'test-agent-dora', content: '投票：@🤖Bot' },
      ],
    }),
  };

  const service = createWerewolfService({
    store,
    skillRegistry: {},
    turnOrchestrator,
    werewolfHost: host,
    broadcastEvent: () => {},
    broadcastConversationSummary: () => {},
  });

  await service.runVotePhase('test-werewolf-vote-emoji-name');

  const finalState = host.loadState('test-werewolf-vote-emoji-name');
  const lastEntry = finalState.history[finalState.history.length - 1];
  assert.equal(lastEntry.type, 'vote');
  assert.equal(lastEntry.eliminatedAgentId, 'test-agent-bot');
});
