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
    assert.ok(prompt.includes('Dynamic skill loading: when conversation skills are listed as descriptors without full instructions, use the `read` tool on the listed `Path` to load the full `SKILL.md` on demand.'), 'Prompt should explain dynamic read loading');
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

test('agent tools controller no longer exposes read-skill route', async () => {
  const controller = createAgentToolsController({
    agentToolBridge: {
      handleListParticipants() { return { ok: true }; },
      handlePostMessage() { return { ok: true }; },
      handleReadContext() { return { ok: true }; },
      handleTrellisInit() { return { ok: true }; },
      handleTrellisWrite() { return { ok: true }; },
    },
  });

  const handled = await controller({
    req: { method: 'GET' },
    res: {},
    pathname: '/api/agent-tools/read-skill',
    requestUrl: new URL('http://localhost/api/agent-tools/read-skill'),
  });

  assert.equal(handled, false);
});
