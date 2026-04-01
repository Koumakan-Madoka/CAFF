const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createSkillRegistry } = require('../../build/lib/skill-registry');
const { createAgentToolBridge } = require('../../build/server/domain/runtime/agent-tool-bridge');

const { withTempDir } = require('../helpers/temp-dir');

// ── Helpers ────────────────────────────────────────────────────────────────

function createInvocationFixture(store, suffix, overrides = {}) {
  const agent = store.saveAgent({
    id: `read-skill-agent-${suffix}`,
    name: `Skill Agent ${suffix}`,
    personaPrompt: 'Reply briefly.',
  });
  const conversation = store.createConversation({
    id: `read-skill-conversation-${suffix}`,
    title: `Skill Conversation ${suffix}`,
    participants: [agent.id],
  });
  const assistantMessage = store.createMessage({
    id: `read-skill-message-${suffix}`,
    conversationId: conversation.id,
    turnId: `read-skill-turn-${suffix}`,
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: 'Thinking...',
    status: 'streaming',
  });
  const fullConversation = store.getConversation(conversation.id);
  const turnState = {
    conversationId: conversation.id,
    turnId: assistantMessage.turnId,
    stopRequested: false,
  };
  const stage = {
    status: 'running',
    replyLength: 0,
    preview: '',
    lastTextDeltaAt: null,
  };

  return {
    agent,
    conversation: fullConversation,
    assistantMessage,
    turnState,
    stage,
    ...overrides,
  };
}

function buildReadSkillUrl(invocationId, callbackToken, skillId) {
  const url = new URL('http://127.0.0.1/api/agent-tools/read-skill');
  url.searchParams.set('invocationId', invocationId);
  url.searchParams.set('callbackToken', callbackToken);
  if (skillId !== undefined && skillId !== null) {
    url.searchParams.set('skillId', skillId);
  }
  return url;
}

function createTestSkill(skillsDir, id, name, description, body) {
  const skillDir = path.join(skillsDir, id);
  fs.mkdirSync(skillDir, { recursive: true });
  const content = [
    '---',
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
    body,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');
  return skillDir;
}

// ── handleReadSkill tests ──────────────────────────────────────────────────

test('handleReadSkill returns the skill body for an existing skill', (t) => {
  const tempDir = withTempDir('caff-read-skill-basic-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const skillRegistry = createSkillRegistry({ agentDir: tempDir });
  const bridge = createAgentToolBridge({ store, skillRegistry });

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Create a test skill in the registry's skillsDir
  createTestSkill(
    skillRegistry.skillsDir,
    'my-test-skill',
    'My Test Skill',
    'A skill for testing read-skill',
    '# Hello\n\nThis is the body of my test skill.\n'
  );

  const fixture = createInvocationFixture(store, 'basic');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const url = buildReadSkillUrl(context.invocationId, context.callbackToken, 'my-test-skill');
  const result = bridge.handleReadSkill(url);

  assert.equal(result.ok, true);
  assert.equal(result.skill.id, 'my-test-skill');
  assert.equal(result.skill.name, 'My Test Skill');
  assert.equal(result.skill.description, 'A skill for testing read-skill');
  assert.ok(result.skill.body.includes('This is the body of my test skill.'));
});

test('handleReadSkill returns 404 for a non-existent skill', (t) => {
  const tempDir = withTempDir('caff-read-skill-notfound-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const skillRegistry = createSkillRegistry({ agentDir: tempDir });
  const bridge = createAgentToolBridge({ store, skillRegistry });

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createInvocationFixture(store, 'notfound');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const url = buildReadSkillUrl(context.invocationId, context.callbackToken, 'no-such-skill');

  assert.throws(
    () => bridge.handleReadSkill(url),
    (error) => error && error.statusCode === 404 && /not found/i.test(error.message)
  );
});

test('handleReadSkill returns 400 when skillId is missing', (t) => {
  const tempDir = withTempDir('caff-read-skill-noid-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const skillRegistry = createSkillRegistry({ agentDir: tempDir });
  const bridge = createAgentToolBridge({ store, skillRegistry });

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createInvocationFixture(store, 'noid');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  // No skillId in the URL
  const url = buildReadSkillUrl(context.invocationId, context.callbackToken, '');

  assert.throws(
    () => bridge.handleReadSkill(url),
    (error) => error && error.statusCode === 400 && /skillId/i.test(error.message)
  );
});

test('handleReadSkill returns 409 when skillRegistry is not available', (t) => {
  const tempDir = withTempDir('caff-read-skill-noreg-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  // No skillRegistry passed
  const bridge = createAgentToolBridge({ store });

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createInvocationFixture(store, 'noreg');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const url = buildReadSkillUrl(context.invocationId, context.callbackToken, 'any-skill');

  assert.throws(
    () => bridge.handleReadSkill(url),
    (error) => error && error.statusCode === 409
  );
});

test('handleReadSkill truncates body when it exceeds MAX_SKILL_BODY_LENGTH', (t) => {
  const tempDir = withTempDir('caff-read-skill-truncate-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const skillRegistry = createSkillRegistry({ agentDir: tempDir });
  const bridge = createAgentToolBridge({ store, skillRegistry });

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Create a skill with a body larger than 32768 chars
  const longBody = 'X'.repeat(40000);
  createTestSkill(
    skillRegistry.skillsDir,
    'huge-skill',
    'Huge Skill',
    'A skill with a very large body',
    longBody
  );

  const fixture = createInvocationFixture(store, 'truncate');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const url = buildReadSkillUrl(context.invocationId, context.callbackToken, 'huge-skill');
  const result = bridge.handleReadSkill(url);

  assert.equal(result.ok, true);
  assert.equal(result.skill.id, 'huge-skill');
  // Body should be truncated, ending with ...[truncated]
  assert.ok(result.skill.body.endsWith('...[truncated]'), 'Body should be truncated with marker');
  // The truncated body should be shorter than the original
  assert.ok(result.skill.body.length < longBody.length, 'Truncated body should be shorter');
  // The truncated body should be approximately MAX_SKILL_BODY_LENGTH + marker length
  assert.ok(result.skill.body.length <= 32768 + '\n\n...[truncated]'.length);
});

test('handleReadSkill rejects invalid invocation credentials', (t) => {
  const tempDir = withTempDir('caff-read-skill-badauth-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const skillRegistry = createSkillRegistry({ agentDir: tempDir });
  const bridge = createAgentToolBridge({ store, skillRegistry });

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createInvocationFixture(store, 'badauth');
  bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  // Use wrong callback token
  const url = buildReadSkillUrl('nonexistent-id', 'wrong-token', 'my-skill');

  assert.throws(
    () => bridge.handleReadSkill(url),
    (error) => error && error.statusCode === 401
  );
});

test('handleReadSkill records telemetry event on success', (t) => {
  const tempDir = withTempDir('caff-read-skill-telemetry-');
  const sqlitePath = path.join(tempDir, 'telemetry.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const runStore = require('../../build/lib/sqlite-store').createSqliteRunStore({ agentDir: tempDir, sqlitePath });
  const skillRegistry = createSkillRegistry({ agentDir: tempDir });
  const bridge = createAgentToolBridge({ store, skillRegistry });

  t.after(() => {
    try { runStore.close(); } catch {}
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  createTestSkill(
    skillRegistry.skillsDir,
    'telemetry-skill',
    'Telemetry Skill',
    'Testing telemetry events',
    'Body content for telemetry test.'
  );

  const fixture = createInvocationFixture(store, 'telemetry');
  const taskId = 'task-read-skill-telemetry';
  fixture.stage.taskId = taskId;
  runStore.createTask({
    taskId,
    kind: 'conversation_agent_reply',
    title: 'Read Skill Telemetry Task',
    status: 'running',
    metadata: { source: 'test' },
  });

  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
      runStore,
    })
  );

  const url = buildReadSkillUrl(context.invocationId, context.callbackToken, 'telemetry-skill');
  const result = bridge.handleReadSkill(url);

  assert.equal(result.ok, true);

  const events = runStore.listTaskEvents(taskId);
  const readSkillEvents = events.filter(
    (event) => event && event.event_type === 'agent_tool_call' && event.payload && event.payload.tool === 'read-skill'
  );

  assert.ok(readSkillEvents.length >= 1, 'Should have at least one read-skill telemetry event');

  const successEvent = readSkillEvents.find((event) => event.payload.status === 'succeeded');
  assert.ok(successEvent, 'Should have a succeeded read-skill event');
  assert.equal(successEvent.payload.request.skillId, 'telemetry-skill');
  assert.equal(successEvent.payload.result.skillId, 'telemetry-skill');
  assert.equal(successEvent.payload.result.skillName, 'Telemetry Skill');
  assert.ok(successEvent.payload.result.bodyLength > 0);
});

test('handleReadSkill records telemetry event on failure', (t) => {
  const tempDir = withTempDir('caff-read-skill-telemetry-fail-');
  const sqlitePath = path.join(tempDir, 'telemetry-fail.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const runStore = require('../../build/lib/sqlite-store').createSqliteRunStore({ agentDir: tempDir, sqlitePath });
  const skillRegistry = createSkillRegistry({ agentDir: tempDir });
  const bridge = createAgentToolBridge({ store, skillRegistry });

  t.after(() => {
    try { runStore.close(); } catch {}
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createInvocationFixture(store, 'telemetry-fail');
  const taskId = 'task-read-skill-telemetry-fail';
  fixture.stage.taskId = taskId;
  runStore.createTask({
    taskId,
    kind: 'conversation_agent_reply',
    title: 'Read Skill Telemetry Fail Task',
    status: 'running',
    metadata: { source: 'test' },
  });

  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
      runStore,
    })
  );

  const url = buildReadSkillUrl(context.invocationId, context.callbackToken, 'missing-skill');

  assert.throws(
    () => bridge.handleReadSkill(url),
    (error) => error && error.statusCode === 404
  );

  const events = runStore.listTaskEvents(taskId);
  const readSkillEvents = events.filter(
    (event) => event && event.event_type === 'agent_tool_call' && event.payload && event.payload.tool === 'read-skill'
  );

  assert.ok(readSkillEvents.length >= 1, 'Should have at least one read-skill telemetry event');

  const failEvent = readSkillEvents.find((event) => event.payload.status === 'failed');
  assert.ok(failEvent, 'Should have a failed read-skill event');
  assert.equal(failEvent.payload.request.skillId, 'missing-skill');
  assert.equal(failEvent.payload.error.statusCode, 404);
});

test('handleReadSkill finds skills from external skill directories', (t) => {
  const tempDir = withTempDir('caff-read-skill-external-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  const skillRegistry = createSkillRegistry({ agentDir: tempDir });

  // Create an external skill directory
  const externalDir = path.join(tempDir, 'project', '.agents', 'skills');
  createTestSkill(
    externalDir,
    'external-skill',
    'External Skill',
    'A skill from an external project directory',
    '# External Skill\n\nLoaded from project .agents/skills.\n'
  );

  skillRegistry.setExternalSkillDirs([externalDir]);

  const bridge = createAgentToolBridge({ store, skillRegistry });

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const fixture = createInvocationFixture(store, 'external');
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: fixture.conversation.id,
      turnId: fixture.assistantMessage.turnId,
      agentId: fixture.agent.id,
      agentName: fixture.agent.name,
      assistantMessageId: fixture.assistantMessage.id,
      conversationAgents: fixture.conversation.agents,
      stage: fixture.stage,
      turnState: fixture.turnState,
    })
  );

  const url = buildReadSkillUrl(context.invocationId, context.callbackToken, 'external-skill');
  const result = bridge.handleReadSkill(url);

  assert.equal(result.ok, true);
  assert.equal(result.skill.id, 'external-skill');
  assert.equal(result.skill.name, 'External Skill');
  assert.ok(result.skill.body.includes('Loaded from project .agents/skills'));
});

// ── agent-prompt skill format tests ────────────────────────────────────────

test('buildAgentTurnPrompt includes persona skill bodies in full mode', (t) => {
  const tempDir = withTempDir('caff-prompt-full-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = store.saveAgent({
    id: 'prompt-agent-full',
    name: 'Prompt Agent Full',
    personaPrompt: 'Reply briefly.',
  });
  const conversation = store.createConversation({
    id: 'prompt-conversation-full',
    title: 'Prompt Test',
    participants: [agent.id],
  });

  // Save original env
  const originalMode = process.env.CAFF_SKILL_LOADING_MODE;
  delete process.env.CAFF_SKILL_LOADING_MODE;

  try {
    const { buildAgentTurnPrompt } = require('../../build/server/domain/conversation/turn/agent-prompt');

    const personaSkills = [
      {
        id: 'persona-skill',
        name: 'Persona Skill',
        description: 'Core persona behavior',
        body: '# Persona Instructions\n\nBe yourself.\n\nAlways say hi.',
      },
    ];
    const conversationSkills = [
      {
        id: 'conv-skill',
        name: 'Conversation Skill',
        description: 'Gameplay helper',
        body: '# Conversation Instructions\n\nHelp with gameplay.',
      },
    ];

    const prompt = buildAgentTurnPrompt({
      conversation: store.getConversation(conversation.id),
      agent,
      agentConfig: { profileName: 'Default', personaPrompt: 'Reply briefly.' },
      resolvedPersonaSkills: personaSkills,
      resolvedConversationSkills: conversationSkills,
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

    // In full mode (default), persona skills should have body
    assert.ok(prompt.includes('Persona-specific skills:'), 'Should have persona skills section');
    assert.ok(prompt.includes('Persona Instructions'), 'Persona skill body should be included');
    assert.ok(prompt.includes('Be yourself.'), 'Persona skill body content should be present');

    // Conversation skills should also have body in full mode
    assert.ok(prompt.includes('Conversation-only skills for this room:'), 'Should have conversation skills section');
    assert.ok(prompt.includes('Conversation Instructions'), 'Conversation skill body should be included');
    assert.ok(prompt.includes('Help with gameplay.'), 'Conversation skill body content should be present');

    // In full mode, read-skill tool instructions should NOT be present
    assert.ok(!prompt.includes('read-skill'), 'read-skill instructions should not appear in full mode');
  } finally {
    if (originalMode !== undefined) {
      process.env.CAFF_SKILL_LOADING_MODE = originalMode;
    }
  }
});

test('buildAgentTurnPrompt shows only descriptors in dynamic mode for conversation skills', (t) => {
  const tempDir = withTempDir('caff-prompt-dynamic-');
  const sqlitePath = path.join(tempDir, 'bridge.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = store.saveAgent({
    id: 'prompt-agent-dynamic',
    name: 'Prompt Agent Dynamic',
    personaPrompt: 'Reply briefly.',
  });
  const conversation = store.createConversation({
    id: 'prompt-conversation-dynamic',
    title: 'Prompt Dynamic Test',
    participants: [agent.id],
  });

  // Save original env
  const originalMode = process.env.CAFF_SKILL_LOADING_MODE;
  process.env.CAFF_SKILL_LOADING_MODE = 'dynamic';

  try {
    // Clear require cache to pick up env change in getSkillLoadingMode()
    const promptPath = require.resolve('../../build/server/domain/conversation/turn/agent-prompt');
    delete require.cache[promptPath];
    const { buildAgentTurnPrompt } = require('../../build/server/domain/conversation/turn/agent-prompt');

    const personaSkills = [
      {
        id: 'persona-skill-dyn',
        name: 'Persona Skill Dyn',
        description: 'Core persona behavior for dynamic',
        body: '# Always Be Dynamic\n\nJump around!',
      },
    ];
    const conversationSkills = [
      {
        id: 'conv-skill-dyn',
        name: 'Conversation Skill Dyn',
        description: 'Dynamic gameplay helper',
        body: '# Dynamic Instructions\n\nOnly loaded on demand.',
      },
    ];

    const prompt = buildAgentTurnPrompt({
      conversation: store.getConversation(conversation.id),
      agent,
      agentConfig: { profileName: 'Default', personaPrompt: 'Reply briefly.' },
      resolvedPersonaSkills: personaSkills,
      resolvedConversationSkills: conversationSkills,
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

    // Persona skills should STILL have body even in dynamic mode (forceFull: true)
    assert.ok(prompt.includes('Persona-specific skills:'), 'Should have persona skills section');
    assert.ok(prompt.includes('Always Be Dynamic'), 'Persona skill body should be included even in dynamic mode');
    assert.ok(prompt.includes('Jump around!'), 'Persona skill body content should be present');

    // Conversation skills should NOT have body in dynamic mode (only descriptors)
    assert.ok(prompt.includes('Conversation-only skills for this room:'), 'Should have conversation skills section');
    assert.ok(prompt.includes('Dynamic gameplay helper'), 'Conversation skill description should be present');
    assert.ok(!prompt.includes('Dynamic Instructions'), 'Conversation skill body should NOT be included');
    assert.ok(!prompt.includes('Only loaded on demand'), 'Conversation skill body content should NOT be present');

    // In dynamic mode, read-skill tool instructions SHOULD be present
    assert.ok(prompt.includes('read-skill'), 'read-skill instructions should appear in dynamic mode');
    assert.ok(prompt.includes('Dynamic skill loading'), 'Dynamic skill loading hint should be present');
  } finally {
    if (originalMode !== undefined) {
      process.env.CAFF_SKILL_LOADING_MODE = originalMode;
    } else {
      delete process.env.CAFF_SKILL_LOADING_MODE;
    }
    // Clear cache to restore
    const promptPath = require.resolve('../../build/server/domain/conversation/turn/agent-prompt');
    delete require.cache[promptPath];
  }
});
