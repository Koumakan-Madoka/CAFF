const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createAgentToolsController } = require('../../build/server/api/agent-tools-controller');
const { withTempDir } = require('../helpers/temp-dir');

function createPromptFixture(tempDir) {
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const agent = store.saveAgent({
    id: 'prompt-agent',
    name: 'Prompt Agent',
    personaPrompt: 'Reply briefly.',
  });
  const conversation = store.createConversation({
    id: 'prompt-conversation',
    title: 'Prompt Test',
    participants: [agent.id],
  });

  return {
    store,
    agent,
    conversation: store.getConversation(conversation.id),
  };
}

function loadPromptModule() {
  const promptPath = require.resolve('../../build/server/domain/conversation/turn/agent-prompt');
  delete require.cache[promptPath];
  return require(promptPath);
}

test('buildAgentTurnPrompt defaults to dynamic mode and points skills at SKILL.md via read tool', () => {
  const tempDir = withTempDir('caff-skill-path-dynamic-');
  const { store, agent, conversation } = createPromptFixture(tempDir);
  const originalMode = process.env.CAFF_SKILL_LOADING_MODE;
  delete process.env.CAFF_SKILL_LOADING_MODE;

  try {
    const { buildAgentTurnPrompt } = loadPromptModule();
    const skillPath = path.join(tempDir, 'skills', 'conv-skill');
    const prompt = buildAgentTurnPrompt({
      conversation,
      agent,
      agentConfig: { profileName: 'Default', personaPrompt: 'Reply briefly.' },
      resolvedPersonaSkills: [
        {
          id: 'persona-skill',
          name: 'Persona Skill',
          description: 'Core persona behavior',
          body: '# Persona Instructions\n\nBe yourself.',
          path: path.join(tempDir, 'skills', 'persona-skill'),
        },
      ],
      resolvedConversationSkills: [
        {
          id: 'conv-skill',
          name: 'Conversation Skill',
          description: 'Gameplay helper',
          body: '# Conversation Instructions\n\nHelp with gameplay.',
          path: skillPath,
        },
      ],
      sandbox: { sandboxDir: '/sandbox', privateDir: '/sandbox/private' },
      projectDir: '',
      agents: [agent],
      messages: [],
      privateMessages: [],
      trigger: { triggerType: 'user', enqueueReason: 'user_mentions' },
      remainingSlots: 5,
      routingMode: 'serial',
      allowHandoffs: true,
      agentToolRelativePath: 'build/lib/agent-chat-tools.js',
    });

    const expectedSkillFile = `${skillPath.replace(/\\/g, '/')}/SKILL.md`;
    assert.ok(prompt.includes('Conversation-only skills for this room:'), 'Should include conversation skill section');
    assert.ok(prompt.includes(`Path: ${expectedSkillFile}`), 'Dynamic descriptors should point at SKILL.md');
    assert.ok(prompt.includes('Load with: Use the `read` tool on the `Path` above when you need the full instructions'), 'Dynamic descriptors should teach read-path loading');
    assert.ok(prompt.includes('Dynamic skill loading: when a skill only shows a descriptor, use the `read` tool on its listed `Path`; that `Path` already points directly to `SKILL.md`, so no dedicated skill-loading tool is needed.'), 'Prompt should explain dynamic read loading');
    assert.ok(!prompt.includes('read-skill'), 'Prompt should not mention removed read-skill tool');
    assert.ok(!prompt.includes('Conversation Instructions'), 'Dynamic mode should still avoid full conversation skill body injection');
  } finally {
    if (originalMode !== undefined) {
      process.env.CAFF_SKILL_LOADING_MODE = originalMode;
    } else {
      delete process.env.CAFF_SKILL_LOADING_MODE;
    }
    try { store.close(); } catch {}
  }
});

test('buildAgentTurnPrompt full mode includes full skill bodies without dynamic read guidance', () => {
  const tempDir = withTempDir('caff-skill-path-full-');
  const { store, agent, conversation } = createPromptFixture(tempDir);
  const originalMode = process.env.CAFF_SKILL_LOADING_MODE;
  process.env.CAFF_SKILL_LOADING_MODE = 'full';

  try {
    const { buildAgentTurnPrompt } = loadPromptModule();
    const skillPath = path.join(tempDir, 'skills', 'conv-skill');
    const prompt = buildAgentTurnPrompt({
      conversation,
      agent,
      agentConfig: { profileName: 'Default', personaPrompt: 'Reply briefly.' },
      resolvedPersonaSkills: [],
      resolvedConversationSkills: [
        {
          id: 'conv-skill',
          name: 'Conversation Skill',
          description: 'Gameplay helper',
          body: '# Conversation Instructions\n\nHelp with gameplay.',
          path: skillPath,
        },
      ],
      sandbox: { sandboxDir: '/sandbox', privateDir: '/sandbox/private' },
      projectDir: '',
      agents: [agent],
      messages: [],
      privateMessages: [],
      trigger: { triggerType: 'user', enqueueReason: 'user_mentions' },
      remainingSlots: 5,
      routingMode: 'serial',
      allowHandoffs: true,
      agentToolRelativePath: 'build/lib/agent-chat-tools.js',
    });

    const expectedSkillFile = `${skillPath.replace(/\\/g, '/')}/SKILL.md`;
    assert.ok(prompt.includes(`Path: ${expectedSkillFile}`), 'Full mode should still show SKILL.md path');
    assert.ok(prompt.includes('Conversation Instructions'), 'Full mode should inject full conversation skill body');
    assert.ok(!prompt.includes('Dynamic skill loading:'), 'Full mode should not include dynamic loading guidance');
    assert.ok(!prompt.includes('Load with: Use the `read` tool on the `Path` above when you need the full instructions'), 'Full mode should not show descriptor-only load hint');
    assert.ok(!prompt.includes('read-skill'), 'Full mode should not mention removed read-skill tool');
  } finally {
    if (originalMode !== undefined) {
      process.env.CAFF_SKILL_LOADING_MODE = originalMode;
    } else {
      delete process.env.CAFF_SKILL_LOADING_MODE;
    }
    try { store.close(); } catch {}
  }
});

test('buildAgentTurnPrompt can force selected skills dynamic inside a full-loading mode', () => {
  const tempDir = withTempDir('caff-skill-path-force-dynamic-');
  const { store, agent, conversation } = createPromptFixture(tempDir);
  const originalMode = process.env.CAFF_SKILL_LOADING_MODE;
  process.env.CAFF_SKILL_LOADING_MODE = 'full';

  try {
    const { buildAgentTurnPrompt } = loadPromptModule();
    const fullSkillPath = path.join(tempDir, 'skills', 'game-skill');
    const dynamicSkillPath = path.join(tempDir, 'skills', 'skill-creator');
    const prompt = buildAgentTurnPrompt({
      conversation,
      agent,
      agentConfig: { profileName: 'Default', personaPrompt: 'Reply briefly.' },
      resolvedPersonaSkills: [],
      resolvedConversationSkills: [
        {
          id: 'game-skill',
          name: 'Game Skill',
          description: 'Needs full mode behavior',
          body: '# Game Instructions\n\nInline me.',
          path: fullSkillPath,
        },
        {
          id: 'skill-creator',
          name: 'skill-creator',
          description: 'Create and improve skills',
          body: '# Skill Creator\n\nDo not inline me.',
          path: dynamicSkillPath,
        },
      ],
      sandbox: { sandboxDir: '/sandbox', privateDir: '/sandbox/private' },
      projectDir: '',
      agents: [agent],
      messages: [],
      privateMessages: [],
      trigger: { triggerType: 'user', enqueueReason: 'user_mentions' },
      remainingSlots: 5,
      routingMode: 'serial',
      allowHandoffs: true,
      agentToolRelativePath: 'build/lib/agent-chat-tools.js',
      modeLoadingStrategy: 'full',
      forceDynamicConversationSkillIds: ['skill-creator'],
    });

    const expectedDynamicSkillFile = `${dynamicSkillPath.replace(/\\/g, '/')}/SKILL.md`;
    assert.ok(prompt.includes('Game Instructions'), 'Non-forced skill should still use full mode injection');
    assert.ok(prompt.includes(`Path: ${expectedDynamicSkillFile}`), 'Forced dynamic skill should show SKILL.md path');
    assert.ok(prompt.includes('Load with: Use the `read` tool on the `Path` above when you need the full instructions'), 'Forced dynamic skill should show read guidance');
    assert.ok(prompt.includes('Dynamic skill loading:'), 'Prompt should include dynamic guidance for mixed full/dynamic mode');
    assert.ok(!prompt.includes('Do not inline me.'), 'Forced dynamic skill should not inline full body');
  } finally {
    if (originalMode !== undefined) {
      process.env.CAFF_SKILL_LOADING_MODE = originalMode;
    } else {
      delete process.env.CAFF_SKILL_LOADING_MODE;
    }
    try { store.close(); } catch {}
  }
});

test('agent tools controller no longer handles removed read-skill route', async () => {
  const controller = createAgentToolsController({
    agentToolBridge: {
      handleListParticipants() { return { ok: true }; },
      handlePostMessage() { return { ok: true }; },
      handleReadContext() { return { ok: true }; },
      handleTrellisInit() { return { ok: true }; },
      handleTrellisWrite() { return { ok: true }; },
    },
  });

  const res = {
    statusCode: 200,
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(body) {
      this.body = body;
      this.json = JSON.parse(body);
    },
  };

  const handled = await controller({
    req: { method: 'GET' },
    res,
    pathname: '/api/agent-tools/read-skill',
    requestUrl: new URL('http://localhost/api/agent-tools/read-skill'),
  });

  assert.equal(handled, false);
  assert.equal(typeof res.body, 'undefined');
});
