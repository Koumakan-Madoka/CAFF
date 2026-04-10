const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  buildAgentTurnPrompt,
  sanitizePromptMentions,
} = require('../../build/server/domain/conversation/turn-orchestrator');
const { createRoutingExecutor } = require('../../build/server/domain/conversation/turn/routing-executor');
const { createAgentExecutor } = require('../../build/server/domain/conversation/turn/agent-executor');
const { ensureAgentSandbox } = require('../../build/server/domain/conversation/turn/agent-sandbox');
const { createSessionExporter } = require('../../build/server/domain/conversation/turn/session-export');
const { createTurnState, resetTurnStage, summarizeTurnState } = require('../../build/server/domain/conversation/turn/turn-state');
const { createTurnStopper, registerTurnHandle } = require('../../build/server/domain/conversation/turn/turn-stop');

const { withTempDir } = require('../helpers/temp-dir');

test('sanitizePromptMentions rewrites raw @mentions into safe placeholders', () => {
  assert.equal(
    sanitizePromptMentions('@Builder hello there @agent-mecha-engineer'),
    '<mention:Builder> hello there <mention:agent-mecha-engineer>'
  );
  assert.equal(
    sanitizePromptMentions('Plain text and email@example.com should stay untouched'),
    'Plain text and email@example.com should stay untouched'
  );
});

test('buildAgentTurnPrompt avoids raw @mention tokens from room context', () => {
  const agent = {
    id: 'agent-mecha-engineer',
    name: 'Builder',
    description: 'Explains implementation details clearly.',
    personaPrompt: 'Stay calm and practical.',
  };
  const conversation = {
    id: 'conversation-1',
    title: 'New Conversation',
    type: 'standard',
    agents: [agent],
  };
  const prompt = buildAgentTurnPrompt({
    conversation,
    agent,
    agentConfig: {
      profileName: 'Default',
      personaPrompt: agent.personaPrompt,
    },
    resolvedPersonaSkills: [],
    resolvedConversationSkills: [],
    sandbox: {
      sandboxDir: 'E:/pythonproject/caff/.pi-sandbox/agent-sandboxes/agent-mecha-engineer',
      privateDir: 'E:/pythonproject/caff/.pi-sandbox/agent-sandboxes/agent-mecha-engineer/private',
    },
    agents: [agent],
    messages: [
      {
        id: 'message-1',
        role: 'user',
        senderName: 'You',
        content: '@Builder hello there',
        status: 'completed',
        metadata: null,
      },
    ],
    privateMessages: [],
    trigger: {
      triggerType: 'user',
      enqueueReason: 'user_mentions',
    },
    remainingSlots: 7,
    routingMode: 'mention_queue',
    allowHandoffs: true,
    agentToolRelativePath: './lib/agent-chat-tools.js',
  });

  assert.match(prompt, /<mention:Builder>/u);
  assert.doesNotMatch(prompt, /@Builder/u);
  assert.doesNotMatch(prompt, /@agent-mecha-engineer/u);
});

test('buildAgentTurnPrompt gives bash-only multiline chat bridge guidance', () => {
  const agent = {
    id: 'agent-builder',
    name: 'Builder',
    description: 'Explains implementation details clearly.',
    personaPrompt: 'Stay calm and practical.',
  };
  const conversation = {
    id: 'conversation-2',
    title: 'New Conversation',
    type: 'standard',
    agents: [agent],
  };
  const prompt = buildAgentTurnPrompt({
    conversation,
    agent,
    agentConfig: {
      profileName: 'Default',
      personaPrompt: agent.personaPrompt,
    },
    resolvedPersonaSkills: [],
    resolvedConversationSkills: [],
    sandbox: {
      sandboxDir: 'E:/pythonproject/caff/.pi-sandbox/agent-sandboxes/agent-builder',
      privateDir: 'E:/pythonproject/caff/.pi-sandbox/agent-sandboxes/agent-builder/private',
    },
    agents: [agent],
    messages: [],
    privateMessages: [],
    trigger: {
      triggerType: 'user',
      enqueueReason: 'default_first_agent',
    },
    remainingSlots: 7,
    routingMode: 'mention_queue',
    allowHandoffs: true,
    agentToolRelativePath: './lib/agent-chat-tools.js',
  });

  assert.match(prompt, /This run executes shell commands with bash/u);
  assert.match(prompt, /cat <<'CAFF_PUBLIC_EOF' \| node "\$CAFF_CHAT_TOOLS_PATH" send-public --content-stdin/u);
  assert.match(
    prompt,
    /cat <<'CAFF_PRIVATE_EOF' \| node "\$CAFF_CHAT_TOOLS_PATH" send-private --to "AgentName" --content-stdin/u
  );
  assert.match(prompt, /Never put raw message text on a new shell line by itself/u);
  assert.doesNotMatch(prompt, /PowerShell example/u);
});

test('buildAgentTurnPrompt skips Trellis context when projectDir is empty', (t) => {
  const tempDir = withTempDir('caff-trellis-skip-');
  fs.mkdirSync(path.join(tempDir, '.trellis'), { recursive: true });

  const previousCwd = process.cwd();
  process.chdir(tempDir);

  t.after(() => {
    process.chdir(previousCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = {
    id: 'agent-skip-trellis',
    name: 'Builder',
    description: 'Explains implementation details clearly.',
    personaPrompt: 'Stay calm and practical.',
  };
  const conversation = {
    id: 'conversation-trellis-skip',
    title: 'Skip Trellis',
    type: 'standard',
    agents: [agent],
  };
  const prompt = buildAgentTurnPrompt({
    conversation,
    agent,
    agentConfig: {
      profileName: 'Default',
      personaPrompt: agent.personaPrompt,
    },
    resolvedPersonaSkills: [],
    resolvedConversationSkills: [],
    sandbox: {
      sandboxDir: 'E:/pythonproject/caff/.pi-sandbox/agent-sandboxes/agent-skip-trellis',
      privateDir: 'E:/pythonproject/caff/.pi-sandbox/agent-sandboxes/agent-skip-trellis/private',
    },
    projectDir: '',
    agents: [agent],
    messages: [],
    privateMessages: [],
    trigger: {
      triggerType: 'user',
      enqueueReason: 'default_first_agent',
    },
    remainingSlots: 7,
    routingMode: 'mention_queue',
    allowHandoffs: true,
    agentToolRelativePath: './lib/agent-chat-tools.js',
  });

  assert.doesNotMatch(prompt, /Trellis project context:/u);
});

test('buildAgentTurnPrompt skips Trellis context for gameplay conversations', (t) => {
  const tempDir = withTempDir('caff-trellis-game-skip-');
  const projectDir = path.join(tempDir, 'project');
  const trellisDir = path.join(projectDir, '.trellis');
  const taskDir = path.join(trellisDir, 'tasks', 'demo');

  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(trellisDir, '.current-task'), 'demo\n', 'utf8');
  fs.writeFileSync(path.join(taskDir, 'prd.md'), 'SENTINEL_TRELLIS_PRD', 'utf8');
  fs.writeFileSync(
    path.join(taskDir, 'implement.jsonl'),
    `${JSON.stringify({ file: '.trellis/tasks/demo/prd.md', reason: 'Test sentinel PRD injection' })}\n`,
    'utf8'
  );

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = {
    id: 'agent-game-skip-trellis',
    name: 'Builder',
    description: 'Explains implementation details clearly.',
    personaPrompt: 'Stay calm and practical.',
  };
  const conversation = {
    id: 'conversation-game-skip-trellis',
    title: 'Skip Trellis Game Mode',
    type: 'werewolf',
    agents: [agent],
  };
  const prompt = buildAgentTurnPrompt({
    conversation,
    agent,
    agentConfig: {
      profileName: 'Default',
      personaPrompt: agent.personaPrompt,
    },
    resolvedPersonaSkills: [],
    resolvedConversationSkills: [],
    sandbox: {
      sandboxDir: 'E:/pythonproject/caff/.pi-sandbox/agent-sandboxes/agent-game-skip-trellis',
      privateDir: 'E:/pythonproject/caff/.pi-sandbox/agent-sandboxes/agent-game-skip-trellis/private',
    },
    projectDir,
    agents: [agent],
    messages: [],
    privateMessages: [],
    trigger: {
      triggerType: 'user',
      enqueueReason: 'default_first_agent',
    },
    remainingSlots: 7,
    routingMode: 'mention_queue',
    allowHandoffs: true,
    agentToolRelativePath: './lib/agent-chat-tools.js',
  });

  assert.doesNotMatch(prompt, /Trellis project context:/u);
  assert.doesNotMatch(prompt, /SENTINEL_TRELLIS_PRD/u);
});

test('buildAgentTurnPrompt blocks absolute Trellis task dirs outside project', (t) => {
  const tempDir = withTempDir('caff-trellis-scope-');
  const projectDir = path.join(tempDir, 'project');
  const outsideDir = path.join(tempDir, 'outside-task');

  fs.mkdirSync(path.join(projectDir, '.trellis', 'tasks'), { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'prd.md'), 'SENTINEL_OUTSIDE_PRD', 'utf8');
  fs.writeFileSync(path.join(projectDir, '.trellis', '.current-task'), outsideDir, 'utf8');

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = {
    id: 'agent-block-abs-task',
    name: 'Builder',
    description: 'Explains implementation details clearly.',
    personaPrompt: 'Stay calm and practical.',
  };
  const conversation = {
    id: 'conversation-trellis-scope',
    title: 'Trellis Scope',
    type: 'standard',
    agents: [agent],
  };
  const prompt = buildAgentTurnPrompt({
    conversation,
    agent,
    agentConfig: {
      profileName: 'Default',
      personaPrompt: agent.personaPrompt,
    },
    resolvedPersonaSkills: [],
    resolvedConversationSkills: [],
    sandbox: {
      sandboxDir: 'E:/pythonproject/caff/.pi-sandbox/agent-sandboxes/agent-block-abs-task',
      privateDir: 'E:/pythonproject/caff/.pi-sandbox/agent-sandboxes/agent-block-abs-task/private',
    },
    projectDir,
    agents: [agent],
    messages: [],
    privateMessages: [],
    trigger: {
      triggerType: 'user',
      enqueueReason: 'default_first_agent',
    },
    remainingSlots: 7,
    routingMode: 'mention_queue',
    allowHandoffs: true,
    agentToolRelativePath: './lib/agent-chat-tools.js',
  });

  assert.match(prompt, /Status: STALE POINTER/u);
  assert.doesNotMatch(prompt, /SENTINEL_OUTSIDE_PRD/u);
});

test('buildAgentTurnPrompt requires loadable JSONL entries before marking task READY', (t) => {
  const tempDir = withTempDir('caff-trellis-jsonl-ready-');
  const projectDir = path.join(tempDir, 'project');
  const trellisDir = path.join(projectDir, '.trellis');
  const taskDir = path.join(trellisDir, 'tasks', 'demo');

  fs.mkdirSync(path.join(trellisDir, 'spec'), { recursive: true });
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(trellisDir, '.current-task'), '.trellis/tasks/demo\n', 'utf8');
  fs.writeFileSync(path.join(taskDir, 'prd.md'), '# Demo PRD\n', 'utf8');
  fs.writeFileSync(path.join(taskDir, 'implement.jsonl'), '{"file": ".trellis/spec"}\n', 'utf8');

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = {
    id: 'agent-jsonl-ready',
    name: 'Builder',
    description: 'Explains implementation details clearly.',
    personaPrompt: 'Stay calm and practical.',
  };
  const conversation = {
    id: 'conversation-trellis-jsonl-ready',
    title: 'Trellis JSONL READY',
    type: 'standard',
    agents: [agent],
  };
  const prompt = buildAgentTurnPrompt({
    conversation,
    agent,
    agentConfig: {
      profileName: 'Default',
      personaPrompt: agent.personaPrompt,
    },
    resolvedPersonaSkills: [],
    resolvedConversationSkills: [],
    sandbox: {
      sandboxDir: 'E:/pythonproject/caff/.pi-sandbox/agent-sandboxes/agent-jsonl-ready',
      privateDir: 'E:/pythonproject/caff/.pi-sandbox/agent-sandboxes/agent-jsonl-ready/private',
    },
    projectDir,
    agents: [agent],
    messages: [],
    privateMessages: [],
    trigger: {
      triggerType: 'user',
      enqueueReason: 'default_first_agent',
    },
    remainingSlots: 7,
    routingMode: 'mention_queue',
    allowHandoffs: true,
    agentToolRelativePath: './lib/agent-chat-tools.js',
  });

  assert.match(prompt, /Status: NOT READY/u);
  assert.match(prompt, /\[no JSONL context loaded\]/u);
});

test('buildAgentTurnPrompt preserves JSONL parse warnings when no context entries are usable', (t) => {
  const tempDir = withTempDir('caff-trellis-jsonl-warn-');
  const projectDir = path.join(tempDir, 'project');
  const trellisDir = path.join(projectDir, '.trellis');
  const taskDir = path.join(trellisDir, 'tasks', 'demo');

  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(trellisDir, '.current-task'), '.trellis/tasks/demo\n', 'utf8');
  fs.writeFileSync(path.join(taskDir, 'prd.md'), '# Demo PRD\n', 'utf8');
  fs.writeFileSync(path.join(taskDir, 'implement.jsonl'), '{not json}\n{"reason":"missing file"}\n', 'utf8');

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = {
    id: 'agent-jsonl-warn',
    name: 'Builder',
    description: 'Explains implementation details clearly.',
    personaPrompt: 'Stay calm and practical.',
  };
  const conversation = {
    id: 'conversation-trellis-jsonl-warn',
    title: 'Trellis JSONL Warnings',
    type: 'standard',
    agents: [agent],
  };
  const prompt = buildAgentTurnPrompt({
    conversation,
    agent,
    agentConfig: {
      profileName: 'Default',
      personaPrompt: agent.personaPrompt,
    },
    resolvedPersonaSkills: [],
    resolvedConversationSkills: [],
    sandbox: {
      sandboxDir: 'E:/pythonproject/caff/.pi-sandbox/agent-sandboxes/agent-jsonl-warn',
      privateDir: 'E:/pythonproject/caff/.pi-sandbox/agent-sandboxes/agent-jsonl-warn/private',
    },
    projectDir,
    agents: [agent],
    messages: [],
    privateMessages: [],
    trigger: {
      triggerType: 'user',
      enqueueReason: 'default_first_agent',
    },
    remainingSlots: 7,
    routingMode: 'mention_queue',
    allowHandoffs: true,
    agentToolRelativePath: './lib/agent-chat-tools.js',
  });

  assert.match(prompt, /Warnings:/u);
  assert.match(prompt, /JSON parse errors: 1/u);
  assert.match(prompt, /Invalid JSONL entries: 1/u);
  assert.match(prompt, /\[no JSONL context loaded\]/u);
});

test('routing executor snapshots project dir once per turn', async (t) => {
  const tempDir = withTempDir('caff-project-snapshot-');
  const sqlitePath = path.join(tempDir, 'snapshot.sqlite');
  const activeConversationIds = new Set();
  const activeTurns = new Map();

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = {
    id: 'conversation-project-snapshot',
    title: 'Project snapshot',
    type: 'standard',
    agents: [
      { id: 'agent-a', name: 'Alpha' },
      { id: 'agent-b', name: 'Beta' },
    ],
    messages: [],
  };

  const store = {
    getConversation(conversationId) {
      return conversationId === conversation.id ? conversation : null;
    },
    createMessage(input) {
      const message = {
        id: `message-${conversation.messages.length + 1}`,
        ...input,
      };
      conversation.messages.push(message);
      return message;
    },
  };

  const seenProjectDirs = [];
  let projectCalls = 0;

  const executor = createRoutingExecutor({
    store,
    agentDir: tempDir,
    sqlitePath,
    activeConversationIds,
    activeTurns,
    getProjectDir() {
      projectCalls += 1;
      return projectCalls === 1 ? 'project-A' : 'project-B';
    },
    async executeConversationAgent({ projectDir, completedReplies, agent }) {
      seenProjectDirs.push(String(projectDir || '').trim());
      completedReplies.push({ agentId: agent.id, publicReply: 'ok', final: true });
      return { stopTurn: false };
    },
  });

  await executor(conversation.id, {
    content: 'Hello',
    initialAgentIds: ['agent-a', 'agent-b'],
    executionMode: 'parallel',
  });

  assert.equal(projectCalls, 1);
  assert.equal(seenProjectDirs.length, 2);
  assert.ok(seenProjectDirs.every((value) => value === 'project-A'));
});

test('session export refuses non-assistant messages and out-of-bounds paths', (t) => {
  const tempDir = withTempDir('caff-session-export-');
  const agentDir = path.join(tempDir, 'agent-dir');
  fs.mkdirSync(path.join(agentDir, 'named-sessions'), { recursive: true });

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { resolveAssistantMessageSessionPath } = createSessionExporter({ agentDir });

  assert.throws(
    () => resolveAssistantMessageSessionPath({ role: 'user', metadata: { sessionPath: path.join(agentDir, 'named-sessions', 'ok.jsonl') } }),
    (error) => error && error.statusCode === 400
  );

  assert.throws(
    () =>
      resolveAssistantMessageSessionPath({
        role: 'assistant',
        metadata: { sessionPath: path.join(agentDir, '..', 'evil.jsonl') },
      }),
    (error) => error && error.statusCode === 400
  );
});

test('session export requires a resolved session path', (t) => {
  const tempDir = withTempDir('caff-session-missing-');

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { resolveAssistantMessageSessionPath } = createSessionExporter({ agentDir: tempDir });

  assert.throws(
    () => resolveAssistantMessageSessionPath({ role: 'assistant', metadata: {} }),
    (error) => error && error.statusCode === 404
  );
});

test('turn state summary exposes live current tool fields and reset clears them', () => {
  const conversation = {
    id: 'conversation-live-tool',
    title: 'Live tool test',
    agents: [{ id: 'agent-a', name: 'Alpha' }],
  };
  const turnState = createTurnState(conversation, 'turn-live-tool');
  const stage = turnState.agents[0];

  stage.status = 'running';
  stage.currentToolName = 'send-public';
  stage.currentToolKind = 'bridge';
  stage.currentToolStepId = 'tool-123';
  stage.currentToolStartedAt = '2026-04-10T00:00:00.000Z';
  stage.currentToolInferred = true;

  const summary = summarizeTurnState(turnState);

  assert.equal(summary.agents[0].currentToolName, 'send-public');
  assert.equal(summary.agents[0].currentToolKind, 'bridge');
  assert.equal(summary.agents[0].currentToolStepId, 'tool-123');
  assert.equal(summary.agents[0].currentToolStartedAt, '2026-04-10T00:00:00.000Z');
  assert.equal(summary.agents[0].currentToolInferred, true);

  resetTurnStage(stage);

  assert.equal(stage.currentToolName, '');
  assert.equal(stage.currentToolKind, '');
  assert.equal(stage.currentToolStepId, '');
  assert.equal(stage.currentToolStartedAt, null);
  assert.equal(stage.currentToolInferred, false);
});

test('turn stop cancels active handles and clears queued stages', () => {
  const activeTurns = new Map();
  let broadcastCount = 0;
  let emitCount = 0;
  const requestStopConversationTurn = createTurnStopper({
    activeTurns,
    broadcastRuntimeState() {
      broadcastCount += 1;
    },
    emitTurnProgress() {
      emitCount += 1;
    },
  });

  const conversation = {
    id: 'conversation-1',
    title: 'Stop test',
    agents: [
      { id: 'agent-a', name: 'Alpha' },
      { id: 'agent-b', name: 'Beta' },
    ],
  };
  const turnState = createTurnState(conversation, 'turn-1');
  turnState.pendingAgentIds = ['agent-a', 'agent-b'];
  turnState.agents[0].status = 'queued';

  let cancelCalls = 0;
  let lastReason = '';
  registerTurnHandle(turnState, {
    cancel(reason) {
      cancelCalls += 1;
      lastReason = reason;
    },
  });

  activeTurns.set(conversation.id, turnState);

  const summary = requestStopConversationTurn(conversation.id, 'User stop');

  assert.equal(cancelCalls, 1);
  assert.equal(lastReason, 'User stop');
  assert.equal(turnState.stopRequested, true);
  assert.equal(turnState.status, 'stopping');
  assert.deepEqual(turnState.pendingAgentIds, []);
  assert.equal(turnState.agents[0].status, 'idle');
  assert.equal(summary.stopRequested, true);
  assert.equal(broadcastCount, 1);
  assert.equal(emitCount, 1);
});

test('agent decision routing only extracts actionable trailing mentions', () => {
  const { parseAgentTurnDecision } = createAgentExecutor({});
  const agents = [
    { id: 'agent-a', name: 'Alpha' },
    { id: 'agent-b', name: 'Beta' },
  ];

  assert.deepEqual(parseAgentTurnDecision('Hello @Beta there', agents).mentions, []);
  assert.deepEqual(parseAgentTurnDecision('Thanks @Beta', agents).mentions, ['agent-b']);
  assert.deepEqual(parseAgentTurnDecision('@Beta', agents).mentions, ['agent-b']);
  assert.deepEqual(parseAgentTurnDecision('Hello <mention:Beta> there', agents).mentions, []);
  assert.deepEqual(parseAgentTurnDecision('Thanks <mention:Beta>', agents).mentions, ['agent-b']);
  assert.deepEqual(parseAgentTurnDecision('<mention:Beta>', agents).mentions, ['agent-b']);
});

test('agent sandbox helper creates private directory', (t) => {
  const tempDir = withTempDir('caff-sandbox-');

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = { id: 'agent-example', name: 'Example' };
  const sandbox = ensureAgentSandbox(tempDir, agent);

  assert.ok(fs.existsSync(sandbox.sandboxDir));
  assert.ok(fs.existsSync(sandbox.privateDir));
  assert.match(sandbox.privateDir, /private$/u);
});
