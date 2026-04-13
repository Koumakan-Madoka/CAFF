const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  buildAgentTurnPrompt,
  createTurnOrchestrator,
  sanitizePromptMentions,
} = require('../../build/server/domain/conversation/turn-orchestrator');
const { createRoutingExecutor } = require('../../build/server/domain/conversation/turn/routing-executor');
const {
  createAgentExecutor,
  extractLiveSessionToolFromPiEvent,
} = require('../../build/server/domain/conversation/turn/agent-executor');
const { ensureAgentSandbox } = require('../../build/server/domain/conversation/turn/agent-sandbox');
const { createSessionExporter } = require('../../build/server/domain/conversation/turn/session-export');
const { createTurnState, resetTurnStage, summarizeTurnState } = require('../../build/server/domain/conversation/turn/turn-state');
const { createTurnStopper, registerTurnHandle } = require('../../build/server/domain/conversation/turn/turn-stop');
const { createAgentSlotRegistry } = require('../../build/server/domain/conversation/turn/agent-slot-registry');

const { withTempDir } = require('../helpers/temp-dir');

async function waitForCondition(check, timeoutMs = 5000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await check();

    if (result) {
      return result;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error('Condition was not met in time');
}

test('agent slot registry clears held slots without queued waiters', async () => {
  const registry = createAgentSlotRegistry();
  const firstRequest = registry.requestSlot({ conversationId: 'conversation-clear-slot', agentId: 'agent-a', lane: 'side' });
  const firstGrant = await firstRequest.promise;

  assert.equal(firstRequest.queued, false);
  assert.equal(registry.isAgentBusy('conversation-clear-slot', 'agent-a'), true);

  registry.clearConversation('conversation-clear-slot');

  assert.equal(registry.isAgentBusy('conversation-clear-slot', 'agent-a'), false);

  const secondRequest = registry.requestSlot({ conversationId: 'conversation-clear-slot', agentId: 'agent-a', lane: 'side' });
  const secondGrant = await secondRequest.promise;

  assert.equal(secondRequest.queued, false);
  assert.equal(firstGrant.release(), false);
  assert.equal(secondGrant.release(), true);
});

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
  assert.match(prompt, /search-messages --query "topic keywords" --limit 5/u);
  assert.match(prompt, /--speaker "AgentName" or --agent-id "agent-id"/u);
  assert.match(prompt, /list-memories/u);
  assert.match(prompt, /Memory titles are matched exactly after trimming; case matters/u);
  assert.match(prompt, /save-memory --title "preference" --content "User prefers retrieval-first POCs" --ttl-days 30/u);
  assert.match(prompt, /update-memory --title "preference" --content "User now prefers answer-first replies" --reason/u);
  assert.match(prompt, /forget-memory --title "temporary preference" --reason "User said this should not persist" --expected-updated-at/u);
  assert.match(prompt, /Never put raw message text on a new shell line by itself/u);
  assert.doesNotMatch(prompt, /PowerShell example/u);
});

test('buildAgentTurnPrompt includes scoped curated memory cards', () => {
  const agent = {
    id: 'agent-memory-prompt',
    name: 'Builder',
    description: 'Explains implementation details clearly.',
    personaPrompt: 'Stay calm and practical.',
  };
  const conversation = {
    id: 'conversation-memory-prompt',
    title: 'Memory Prompt',
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
      sandboxDir: 'E:/pythonproject/caff/.pi-sandbox/agent-sandboxes/agent-memory-prompt',
      privateDir: 'E:/pythonproject/caff/.pi-sandbox/agent-sandboxes/agent-memory-prompt/private',
    },
    agents: [agent],
    messages: [],
    privateMessages: [],
    memoryCards: [
      {
        scope: 'local-user-agent',
        title: 'preference',
        content: 'User prefers retrieval-first rollouts.',
        expiresAt: '2026-05-01T00:00:00.000Z',
      },
    ],
    trigger: {
      triggerType: 'user',
      enqueueReason: 'default_first_agent',
    },
    remainingSlots: 7,
    routingMode: 'mention_queue',
    allowHandoffs: true,
    agentToolRelativePath: './lib/agent-chat-tools.js',
  });

  assert.match(prompt, /Curated memory cards for you \(conversation overlay \+ local durable\):/u);
  assert.match(prompt, /- \[local-user\] preference: User prefers retrieval-first rollouts\. \(expires 2026-05-01T00:00:00\.000Z\)/u);
});

test('buildAgentTurnPrompt keeps case-distinct curated memory titles separate', () => {
  const agent = {
    id: 'agent-memory-case-prompt',
    name: 'Builder',
    description: 'Explains implementation details clearly.',
    personaPrompt: 'Stay calm and practical.',
  };
  const conversation = {
    id: 'conversation-memory-case-prompt',
    title: 'Memory Case Prompt',
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
      sandboxDir: 'E:/pythonproject/caff/.pi-sandbox/agent-sandboxes/agent-memory-case-prompt',
      privateDir: 'E:/pythonproject/caff/.pi-sandbox/agent-sandboxes/agent-memory-case-prompt/private',
    },
    agents: [agent],
    messages: [],
    privateMessages: [],
    memoryCards: [
      {
        scope: 'conversation-agent',
        title: 'preference',
        content: 'Conversation lowercase preference.',
      },
      {
        scope: 'local-user-agent',
        title: 'Preference',
        content: 'Durable uppercase preference.',
      },
    ],
    trigger: {
      triggerType: 'user',
      enqueueReason: 'default_first_agent',
    },
    remainingSlots: 7,
    routingMode: 'mention_queue',
    allowHandoffs: true,
    agentToolRelativePath: './lib/agent-chat-tools.js',
  });

  assert.match(prompt, /- \[conversation\] preference: Conversation lowercase preference\./u);
  assert.match(prompt, /- \[local-user\] Preference: Durable uppercase preference\./u);
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

test('routing executor keeps late user messages out of the active prompt snapshot', { concurrency: false }, async (t) => {
  const tempDir = withTempDir('caff-turn-snapshot-');
  const sqlitePath = path.join(tempDir, 'prompt-snapshot.sqlite');
  const activeConversationIds = new Set();
  const activeTurns = new Map();

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = {
    id: 'conversation-prompt-snapshot',
    title: 'Prompt snapshot',
    type: 'standard',
    agents: [
      { id: 'agent-a', name: 'Alpha' },
      { id: 'agent-b', name: 'Beta' },
    ],
    messages: [],
  };
  let messageCounter = 0;

  const store = {
    getConversation(conversationId) {
      return conversationId === conversation.id ? conversation : null;
    },
    createMessage(input) {
      messageCounter += 1;
      const message = {
        id: input.id || `message-${messageCounter}`,
        errorMessage: '',
        taskId: null,
        runId: null,
        metadata: null,
        createdAt: input.createdAt || `2026-04-10T00:00:${String(messageCounter).padStart(2, '0')}.000Z`,
        ...input,
      };
      conversation.messages.push(message);
      return message;
    },
  };

  const seenPromptSnapshots = [];

  const executor = createRoutingExecutor({
    store,
    agentDir: tempDir,
    sqlitePath,
    activeConversationIds,
    activeTurns,
    async executeConversationAgent({ promptMessages, completedReplies, agent }) {
      seenPromptSnapshots.push(promptMessages.map((message) => message.content));

      if (agent.id === 'agent-a') {
        store.createMessage({
          conversationId: conversation.id,
          turnId: 'queued-follow-up',
          role: 'user',
          senderName: 'You',
          content: 'Late follow up',
          status: 'completed',
        });
      }

      completedReplies.push({ agentId: agent.id, publicReply: 'ok', senderName: agent.name, status: 'completed' });
      return { stopTurn: false };
    },
  });

  await executor(conversation.id, {
    content: 'Hello there',
    initialAgentIds: ['agent-a', 'agent-b'],
    executionMode: 'queue',
  });

  assert.equal(seenPromptSnapshots.length, 2);
  assert.ok(seenPromptSnapshots.every((snapshot) => snapshot.some((content) => content.includes('Hello there'))));
  assert.ok(seenPromptSnapshots.every((snapshot) => snapshot.every((content) => !content.includes('Late follow up'))));
});

test('routing executor preserves queued batch context that existed before dispatch', async (t) => {
  const tempDir = withTempDir('caff-turn-batch-context-');
  const sqlitePath = path.join(tempDir, 'batch-context.sqlite');
  const activeConversationIds = new Set();
  const activeTurns = new Map();

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const conversation = {
    id: 'conversation-batch-context',
    title: 'Batch context',
    type: 'standard',
    agents: [{ id: 'agent-a', name: 'Alpha' }],
    messages: [
      {
        id: 'message-1',
        conversationId: 'conversation-batch-context',
        turnId: 'turn-0',
        role: 'user',
        senderName: 'You',
        content: 'Earlier question',
        status: 'completed',
      },
      {
        id: 'message-2',
        conversationId: 'conversation-batch-context',
        turnId: 'turn-0',
        role: 'assistant',
        senderName: 'Alpha',
        agentId: 'agent-a',
        content: 'Earlier answer',
        status: 'completed',
      },
      {
        id: 'message-3',
        conversationId: 'conversation-batch-context',
        turnId: 'turn-1',
        role: 'user',
        senderName: 'You',
        content: 'Queued follow up one',
        status: 'completed',
      },
      {
        id: 'message-4',
        conversationId: 'conversation-batch-context',
        turnId: 'turn-1',
        role: 'assistant',
        senderName: 'Alpha',
        agentId: 'agent-a',
        content: 'Interleaving assistant context',
        status: 'completed',
      },
      {
        id: 'message-5',
        conversationId: 'conversation-batch-context',
        turnId: 'turn-1',
        role: 'user',
        senderName: 'You',
        content: 'Queued follow up two',
        status: 'completed',
      },
      {
        id: 'message-6',
        conversationId: 'conversation-batch-context',
        turnId: 'turn-1',
        role: 'assistant',
        senderName: 'Alpha',
        agentId: 'agent-a',
        content: 'Late previous-turn assistant',
        status: 'completed',
      },
    ],
  };
  let messageCounter = conversation.messages.length;
  const seenPromptSnapshots = [];

  const store = {
    getConversation(conversationId) {
      return conversationId === conversation.id ? conversation : null;
    },
    createMessage(input) {
      messageCounter += 1;
      const message = {
        id: input.id || `message-${messageCounter}`,
        errorMessage: '',
        taskId: null,
        runId: null,
        metadata: null,
        createdAt: input.createdAt || `2026-04-10T00:02:${String(messageCounter).padStart(2, '0')}.000Z`,
        ...input,
      };
      conversation.messages.push(message);
      return message;
    },
  };

  const executor = createRoutingExecutor({
    store,
    agentDir: tempDir,
    sqlitePath,
    activeConversationIds,
    activeTurns,
    async executeConversationAgent({ promptMessages, completedReplies, agent }) {
      seenPromptSnapshots.push(promptMessages.map((message) => message.content));
      completedReplies.push({ agentId: agent.id, publicReply: 'ok', senderName: agent.name, status: 'completed' });
      return { stopTurn: false };
    },
  });

  await executor(conversation.id, {
    batchMessageIds: ['message-3', 'message-5'],
  });

  assert.equal(seenPromptSnapshots.length, 1);
  assert.deepEqual(seenPromptSnapshots[0], [
    'Earlier question',
    'Earlier answer',
    'Queued follow up one',
    'Interleaving assistant context',
    'Queued follow up two',
    'Late previous-turn assistant',
  ]);
});

test('turn orchestrator queues user messages behind the active run and drains them serially', { concurrency: false }, async (t) => {
  const tempDir = withTempDir('caff-turn-queue-');
  const sqlitePath = path.join(tempDir, 'turn-queue.sqlite');
  const conversation = {
    id: 'conversation-queue',
    title: 'Queued Conversation',
    type: 'standard',
    agents: [{ id: 'agent-a', name: 'Alpha' }],
    messages: [],
  };
  let messageCounter = 0;
  let releaseFirstTurn = null;
  const firstTurnGate = new Promise((resolve) => {
    releaseFirstTurn = resolve;
  });
  const seenBatches = [];

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const store = {
    databasePath: sqlitePath,
    getConversation(conversationId) {
      return conversationId === conversation.id ? conversation : null;
    },
    listConversations() {
      const lastMessage = conversation.messages[conversation.messages.length - 1] || null;
      return [
        {
          id: conversation.id,
          title: conversation.title,
          type: conversation.type,
          metadata: {},
          createdAt: '2026-04-10T00:00:00.000Z',
          updatedAt: lastMessage ? lastMessage.createdAt : '2026-04-10T00:00:00.000Z',
          lastMessageAt: lastMessage ? lastMessage.createdAt : null,
          messageCount: conversation.messages.length,
          agentCount: conversation.agents.length,
          lastMessagePreview: lastMessage ? lastMessage.content : '',
        },
      ];
    },
    createMessage(input) {
      messageCounter += 1;
      const message = {
        id: input.id || `queued-message-${messageCounter}`,
        errorMessage: '',
        taskId: null,
        runId: null,
        metadata: null,
        createdAt: input.createdAt || `2026-04-10T00:00:${String(messageCounter).padStart(2, '0')}.000Z`,
        ...input,
      };
      conversation.messages.push(message);
      return message;
    },
  };

  const orchestrator = createTurnOrchestrator({
    store,
    skillRegistry: { listSkills() { return []; }, resolveSkills() { return []; } },
    modeStore: { get() { return null; } },
    agentToolBridge: {},
    host: '127.0.0.1',
    port: 0,
    agentDir: tempDir,
    sqlitePath,
    toolBaseUrl: 'http://127.0.0.1:0',
    agentToolScriptPath: path.join(tempDir, 'agent-chat-tools.js'),
    executeConversationAgent: async ({ promptMessages, completedReplies, agent, turnState }) => {
      seenBatches.push({
        turnId: turnState.turnId,
        batchEndMessageId: turnState.batchEndMessageId,
        queueDepth: turnState.queueDepth,
        promptMessages: promptMessages.map((message) => message.content),
      });

      if (seenBatches.length === 1) {
        await firstTurnGate;
      }

      completedReplies.push({
        agentId: agent.id,
        senderName: agent.name,
        content: 'ok',
        status: 'completed',
      });
      return { stopTurn: false };
    },
  });

  const firstResult = orchestrator.submitConversationMessage(conversation.id, { content: 'First queued message' });
  const secondResult = orchestrator.submitConversationMessage(conversation.id, { content: 'Second queued message' });

  assert.equal(firstResult.dispatch, 'started');
  assert.equal(secondResult.dispatch, 'queued');
  assert.equal(orchestrator.getConversationQueueDepth(conversation.id), 1);

  const activeTurn = orchestrator.listTurnSummaries({ conversationId: conversation.id })[0];
  assert.equal(activeTurn.batchEndMessageId, firstResult.acceptedMessage.id);
  assert.equal(activeTurn.queueDepth, 1);

  releaseFirstTurn();

  await waitForCondition(() => seenBatches.length === 2 && orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 0);

  assert.equal(seenBatches[0].batchEndMessageId, firstResult.acceptedMessage.id);
  assert.equal(seenBatches[1].batchEndMessageId, secondResult.acceptedMessage.id);
  assert.ok(seenBatches[0].promptMessages.some((content) => content.includes('First queued message')));
  assert.ok(seenBatches[0].promptMessages.every((content) => !content.includes('Second queued message')));
  assert.ok(seenBatches[1].promptMessages.some((content) => content.includes('Second queued message')));
});

test('turn orchestrator continues with the next queued batch after a stop request', { concurrency: false }, async (t) => {
  const tempDir = withTempDir('caff-turn-stop-queue-');
  const sqlitePath = path.join(tempDir, 'turn-stop-queue.sqlite');
  const conversation = {
    id: 'conversation-stop-queue',
    title: 'Stop then continue',
    type: 'standard',
    agents: [{ id: 'agent-a', name: 'Alpha' }],
    messages: [],
  };
  let messageCounter = 0;
  const seenBatches = [];

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const store = {
    databasePath: sqlitePath,
    getConversation(conversationId) {
      return conversationId === conversation.id ? conversation : null;
    },
    listConversations() {
      return [
        {
          id: conversation.id,
          title: conversation.title,
          type: conversation.type,
          metadata: {},
          createdAt: '2026-04-10T00:00:00.000Z',
          updatedAt: '2026-04-10T00:00:00.000Z',
          lastMessageAt: conversation.messages[conversation.messages.length - 1]
            ? conversation.messages[conversation.messages.length - 1].createdAt
            : null,
          messageCount: conversation.messages.length,
          agentCount: conversation.agents.length,
          lastMessagePreview: conversation.messages[conversation.messages.length - 1]
            ? conversation.messages[conversation.messages.length - 1].content
            : '',
        },
      ];
    },
    createMessage(input) {
      messageCounter += 1;
      const message = {
        id: input.id || `stop-message-${messageCounter}`,
        errorMessage: '',
        taskId: null,
        runId: null,
        metadata: null,
        createdAt: input.createdAt || `2026-04-10T00:01:${String(messageCounter).padStart(2, '0')}.000Z`,
        ...input,
      };
      conversation.messages.push(message);
      return message;
    },
  };

  const orchestrator = createTurnOrchestrator({
    store,
    skillRegistry: { listSkills() { return []; }, resolveSkills() { return []; } },
    modeStore: { get() { return null; } },
    agentToolBridge: {},
    host: '127.0.0.1',
    port: 0,
    agentDir: tempDir,
    sqlitePath,
    toolBaseUrl: 'http://127.0.0.1:0',
    agentToolScriptPath: path.join(tempDir, 'agent-chat-tools.js'),
    executeConversationAgent: async ({ completedReplies, agent, turnState }) => {
      seenBatches.push({
        turnId: turnState.turnId,
        batchEndMessageId: turnState.batchEndMessageId,
      });

      if (seenBatches.length === 1) {
        await waitForCondition(() => turnState.stopRequested === true);
        return { stopTurn: true, terminationReason: 'stopped_by_user' };
      }

      completedReplies.push({
        agentId: agent.id,
        senderName: agent.name,
        content: 'ok',
        status: 'completed',
      });
      return { stopTurn: false };
    },
  });

  const firstResult = orchestrator.submitConversationMessage(conversation.id, { content: 'Please stop this one' });
  const secondResult = orchestrator.submitConversationMessage(conversation.id, { content: 'Run after stop' });

  await waitForCondition(() => orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 1);

  const stopSummary = orchestrator.requestStopConversationTurn(conversation.id, 'User stop');
  assert.equal(stopSummary.stopRequested, true);

  await waitForCondition(() => seenBatches.length === 2 && orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 0);

  assert.equal(seenBatches[0].batchEndMessageId, firstResult.acceptedMessage.id);
  assert.equal(seenBatches[1].batchEndMessageId, secondResult.acceptedMessage.id);
});

test('turn orchestrator keeps failed queued batches pending for a later retry', { concurrency: false }, async (t) => {
  const tempDir = withTempDir('caff-turn-failed-queue-');
  const sqlitePath = path.join(tempDir, 'turn-failed-queue.sqlite');
  const conversation = {
    id: 'conversation-failed-queue',
    title: 'Failed queue retry',
    type: 'standard',
    agents: [{ id: 'agent-a', name: 'Alpha' }],
    messages: [],
  };
  let messageCounter = 0;
  let failNextBatch = true;
  const seenBatches = [];

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const store = {
    databasePath: sqlitePath,
    getConversation(conversationId) {
      return conversationId === conversation.id ? conversation : null;
    },
    listConversations() {
      const lastMessage = conversation.messages[conversation.messages.length - 1] || null;
      return [
        {
          id: conversation.id,
          title: conversation.title,
          type: conversation.type,
          metadata: {},
          createdAt: '2026-04-10T00:00:00.000Z',
          updatedAt: lastMessage ? lastMessage.createdAt : '2026-04-10T00:00:00.000Z',
          lastMessageAt: lastMessage ? lastMessage.createdAt : null,
          messageCount: conversation.messages.length,
          agentCount: conversation.agents.length,
          lastMessagePreview: lastMessage ? lastMessage.content : '',
        },
      ];
    },
    createMessage(input) {
      messageCounter += 1;
      const message = {
        id: input.id || `failed-message-${messageCounter}`,
        errorMessage: '',
        taskId: null,
        runId: null,
        metadata: null,
        createdAt: input.createdAt || `2026-04-10T00:03:${String(messageCounter).padStart(2, '0')}.000Z`,
        ...input,
      };
      conversation.messages.push(message);
      return message;
    },
    getMessage(messageId) {
      return conversation.messages.find((message) => message.id === messageId) || null;
    },
    updateMessage(messageId, patch) {
      const index = conversation.messages.findIndex((message) => message.id === messageId);

      if (index === -1) {
        return null;
      }

      conversation.messages[index] = {
        ...conversation.messages[index],
        ...patch,
      };
      return conversation.messages[index];
    },
    listPrivateMessagesForAgent() {
      return [];
    },
  };

  const orchestrator = createTurnOrchestrator({
    store,
    skillRegistry: { listSkills() { return []; }, resolveSkills() { return []; } },
    modeStore: { get() { return null; } },
    agentToolBridge: {
      createInvocationContext(input) {
        return { ...input, invocationId: 'noop', callbackToken: 'noop' };
      },
      registerInvocation(context) {
        return context;
      },
      unregisterInvocation() {
        return null;
      },
    },
    host: '127.0.0.1',
    port: 0,
    agentDir: tempDir,
    sqlitePath,
    toolBaseUrl: 'http://127.0.0.1:0',
    agentToolScriptPath: path.join(tempDir, 'agent-chat-tools.js'),
    executeConversationAgent: async ({ promptMessages, completedReplies, agent, turnState }) => {
      seenBatches.push({
        turnId: turnState.turnId,
        batchEndMessageId: turnState.batchEndMessageId,
        promptMessages: promptMessages.map((message) => message.content),
      });

      if (failNextBatch) {
        failNextBatch = false;
        throw new Error('Synthetic queued failure');
      }

      completedReplies.push({
        agentId: agent.id,
        senderName: agent.name,
        content: 'ok',
        status: 'completed',
      });
      return { stopTurn: false };
    },
  });

  const firstResult = orchestrator.submitConversationMessage(conversation.id, { content: 'Failed queued message' });

  await waitForCondition(
    () =>
      orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 0
      && orchestrator.getConversationQueueDepth(conversation.id) === 1
  );

  assert.equal(seenBatches.length, 1);
  assert.equal(seenBatches[0].batchEndMessageId, firstResult.acceptedMessage.id);
  assert.equal(orchestrator.getConversationQueueDepth(conversation.id), 1);
  assert.deepEqual(orchestrator.buildRuntimePayload().conversationQueueFailures[conversation.id], {
    failedBatchCount: 1,
    lastFailureAt: orchestrator.buildRuntimePayload().conversationQueueFailures[conversation.id].lastFailureAt,
    lastFailureMessage: 'Synthetic queued failure',
  });

  const secondResult = orchestrator.submitConversationMessage(conversation.id, { content: 'Retry after failure' });
  assert.equal(secondResult.dispatch, 'started');

  await waitForCondition(
    () =>
      seenBatches.length === 2
      && orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 0
      && orchestrator.getConversationQueueDepth(conversation.id) === 0
  );

  assert.equal(seenBatches[1].batchEndMessageId, secondResult.acceptedMessage.id);
  assert.ok(seenBatches[1].promptMessages.some((content) => content.includes('Failed queued message')));
  assert.ok(seenBatches[1].promptMessages.some((content) => content.includes('Retry after failure')));
  assert.equal(orchestrator.buildRuntimePayload().conversationQueueFailures[conversation.id], undefined);
});

test('turn orchestrator side-dispatches an explicit single mention to an idle agent while the main turn is active', { concurrency: false }, async (t) => {
  const tempDir = withTempDir('caff-side-dispatch-idle-');
  const sqlitePath = path.join(tempDir, 'side-dispatch-idle.sqlite');
  const conversation = {
    id: 'conversation-side-dispatch-idle',
    title: 'Side dispatch idle target',
    type: 'standard',
    agents: [
      { id: 'agent-a', name: 'Alpha' },
      { id: 'agent-b', name: 'Beta' },
    ],
    messages: [],
  };
  let messageCounter = 0;
  let releaseAlpha = null;
  let releaseBeta = null;
  const alphaGate = new Promise((resolve) => {
    releaseAlpha = resolve;
  });
  const betaGate = new Promise((resolve) => {
    releaseBeta = resolve;
  });
  const executions = [];

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const store = {
    databasePath: sqlitePath,
    getConversation(conversationId) {
      return conversationId === conversation.id ? conversation : null;
    },
    listConversations() {
      const lastMessage = conversation.messages[conversation.messages.length - 1] || null;
      return [
        {
          id: conversation.id,
          title: conversation.title,
          type: conversation.type,
          metadata: {},
          createdAt: '2026-04-10T00:00:00.000Z',
          updatedAt: lastMessage ? lastMessage.createdAt : '2026-04-10T00:00:00.000Z',
          lastMessageAt: lastMessage ? lastMessage.createdAt : null,
          messageCount: conversation.messages.length,
          agentCount: conversation.agents.length,
          lastMessagePreview: lastMessage ? lastMessage.content : '',
        },
      ];
    },
    createMessage(input) {
      messageCounter += 1;
      const message = {
        id: input.id || `side-message-${messageCounter}`,
        errorMessage: '',
        taskId: null,
        runId: null,
        metadata: null,
        createdAt: input.createdAt || `2026-04-10T00:10:${String(messageCounter).padStart(2, '0')}.000Z`,
        ...input,
      };
      conversation.messages.push(message);
      return message;
    },
  };

  const orchestrator = createTurnOrchestrator({
    store,
    skillRegistry: { listSkills() { return []; }, resolveSkills() { return []; } },
    modeStore: { get() { return null; } },
    agentToolBridge: {},
    host: '127.0.0.1',
    port: 0,
    agentDir: tempDir,
    sqlitePath,
    toolBaseUrl: 'http://127.0.0.1:0',
    agentToolScriptPath: path.join(tempDir, 'agent-chat-tools.js'),
    executeConversationAgent: async ({ agent, turnState, completedReplies }) => {
      const stage = Array.isArray(turnState.agents) ? turnState.agents.find((item) => item.agentId === agent.id) || turnState.agents[0] : null;

      if (stage) {
        stage.status = 'running';
        stage.messageId = stage.messageId || `${agent.id}-assistant-${executions.length + 1}`;
      }

      turnState.currentAgentId = agent.id;
      turnState.updatedAt = new Date().toISOString();
      executions.push({
        agentId: agent.id,
        lane: turnState.executionLane || 'main',
        turnId: turnState.turnId,
      });

      if (agent.id === 'agent-a') {
        await alphaGate;
      }

      if (agent.id === 'agent-b') {
        await betaGate;
      }

      if (stage) {
        stage.status = 'completed';
      }

      completedReplies.push({
        agentId: agent.id,
        senderName: agent.name,
        content: 'ok',
        status: 'completed',
      });
      return { stopTurn: false };
    },
  });

  const firstResult = orchestrator.submitConversationMessage(conversation.id, { content: '@Alpha 第一条' });
  assert.equal(firstResult.dispatch, 'started');
  assert.equal(firstResult.dispatchLane, 'main');

  await waitForCondition(() => orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 1);

  const secondResult = orchestrator.submitConversationMessage(conversation.id, { content: '@Beta 第二条' });
  assert.equal(secondResult.dispatch, 'started');
  assert.equal(secondResult.dispatchLane, 'side');
  assert.equal(secondResult.dispatchTargetAgentId, 'agent-b');

  await waitForCondition(() => executions.some((entry) => entry.agentId === 'agent-b' && entry.lane === 'side'));
  await waitForCondition(() => orchestrator.listAgentSlotSummaries({ conversationId: conversation.id }).length === 1);

  const slotSummary = orchestrator.listAgentSlotSummaries({ conversationId: conversation.id })[0];
  assert.equal(slotSummary.agentId, 'agent-b');
  assert.equal(slotSummary.sourceMessageId, secondResult.acceptedMessage.id);

  releaseBeta();
  await waitForCondition(() => orchestrator.listAgentSlotSummaries({ conversationId: conversation.id }).length === 0);

  releaseAlpha();
  await waitForCondition(() => orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 0);
});

test('turn orchestrator blocks direct main turns while a side-dispatch slot is active', { concurrency: false }, async (t) => {
  const tempDir = withTempDir('caff-side-dispatch-main-gate-');
  const sqlitePath = path.join(tempDir, 'side-dispatch-main-gate.sqlite');
  const conversation = {
    id: 'conversation-side-dispatch-main-gate',
    title: 'Side dispatch main gate',
    type: 'standard',
    agents: [
      { id: 'agent-a', name: 'Alpha' },
      { id: 'agent-b', name: 'Beta' },
    ],
    messages: [],
  };
  let messageCounter = 0;
  let releaseAlpha = null;
  let releaseBeta = null;
  const alphaGate = new Promise((resolve) => {
    releaseAlpha = resolve;
  });
  const betaGate = new Promise((resolve) => {
    releaseBeta = resolve;
  });
  const executions = [];

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const store = {
    databasePath: sqlitePath,
    getConversation(conversationId) {
      return conversationId === conversation.id ? conversation : null;
    },
    listConversations() {
      const lastMessage = conversation.messages[conversation.messages.length - 1] || null;
      return [
        {
          id: conversation.id,
          title: conversation.title,
          type: conversation.type,
          metadata: {},
          createdAt: '2026-04-10T00:00:00.000Z',
          updatedAt: lastMessage ? lastMessage.createdAt : '2026-04-10T00:00:00.000Z',
          lastMessageAt: lastMessage ? lastMessage.createdAt : null,
          messageCount: conversation.messages.length,
          agentCount: conversation.agents.length,
          lastMessagePreview: lastMessage ? lastMessage.content : '',
        },
      ];
    },
    createMessage(input) {
      messageCounter += 1;
      const message = {
        id: input.id || `main-gate-message-${messageCounter}`,
        errorMessage: '',
        taskId: null,
        runId: null,
        metadata: null,
        createdAt: input.createdAt || `2026-04-10T00:11:${String(messageCounter).padStart(2, '0')}.000Z`,
        ...input,
      };
      conversation.messages.push(message);
      return message;
    },
  };

  const orchestrator = createTurnOrchestrator({
    store,
    skillRegistry: { listSkills() { return []; }, resolveSkills() { return []; } },
    modeStore: { get() { return null; } },
    agentToolBridge: {},
    host: '127.0.0.1',
    port: 0,
    agentDir: tempDir,
    sqlitePath,
    toolBaseUrl: 'http://127.0.0.1:0',
    agentToolScriptPath: path.join(tempDir, 'agent-chat-tools.js'),
    executeConversationAgent: async ({ agent, turnState, completedReplies }) => {
      const stage = Array.isArray(turnState.agents) ? turnState.agents.find((item) => item.agentId === agent.id) || turnState.agents[0] : null;

      if (stage) {
        stage.status = 'running';
        stage.messageId = stage.messageId || `${agent.id}-assistant-${executions.length + 1}`;
      }

      turnState.currentAgentId = agent.id;
      turnState.updatedAt = new Date().toISOString();
      executions.push({
        agentId: agent.id,
        lane: turnState.executionLane || 'main',
        turnId: turnState.turnId,
      });

      if (agent.id === 'agent-a') {
        await alphaGate;
      }

      if (agent.id === 'agent-b') {
        await betaGate;
      }

      if (stage) {
        stage.status = 'completed';
      }

      completedReplies.push({
        agentId: agent.id,
        senderName: agent.name,
        content: 'ok',
        status: 'completed',
      });
      return { stopTurn: false };
    },
  });

  const firstResult = orchestrator.submitConversationMessage(conversation.id, { content: '@Alpha 第一条' });
  assert.equal(firstResult.dispatch, 'started');
  assert.equal(firstResult.dispatchLane, 'main');

  await waitForCondition(() => orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 1);

  const secondResult = orchestrator.submitConversationMessage(conversation.id, { content: '@Beta 第二条' });
  assert.equal(secondResult.dispatch, 'started');
  assert.equal(secondResult.dispatchLane, 'side');
  assert.equal(secondResult.dispatchTargetAgentId, 'agent-b');
  assert.equal(secondResult.acceptedMessage.metadata.dispatchLane, 'side');
  assert.equal(secondResult.acceptedMessage.metadata.dispatchTargetAgentId, 'agent-b');

  await waitForCondition(() => executions.some((entry) => entry.agentId === 'agent-b' && entry.lane === 'side'));

  releaseAlpha();
  await waitForCondition(
    () =>
      orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 0
      && orchestrator.listAgentSlotSummaries({ conversationId: conversation.id }).length === 1
  );

  const executionCountBefore = executions.length;
  await assert.rejects(
    () => orchestrator.runConversationTurn(conversation.id, { content: '@Alpha 第三条' }),
    (error) => error && error.statusCode === 409
  );
  assert.equal(executions.length, executionCountBefore);

  releaseBeta();
  await waitForCondition(() => orchestrator.listAgentSlotSummaries({ conversationId: conversation.id }).length === 0);
});

test('turn orchestrator queues explicit single mention side-dispatch when the target agent is busy', { concurrency: false }, async (t) => {
  const tempDir = withTempDir('caff-side-dispatch-busy-');
  const sqlitePath = path.join(tempDir, 'side-dispatch-busy.sqlite');
  const conversation = {
    id: 'conversation-side-dispatch-busy',
    title: 'Side dispatch busy target',
    type: 'standard',
    agents: [{ id: 'agent-a', name: 'Alpha' }],
    messages: [],
  };
  let messageCounter = 0;
  let releaseFirstRun = null;
  const firstRunGate = new Promise((resolve) => {
    releaseFirstRun = resolve;
  });
  const executions = [];

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const store = {
    databasePath: sqlitePath,
    getConversation(conversationId) {
      return conversationId === conversation.id ? conversation : null;
    },
    listConversations() {
      const lastMessage = conversation.messages[conversation.messages.length - 1] || null;
      return [
        {
          id: conversation.id,
          title: conversation.title,
          type: conversation.type,
          metadata: {},
          createdAt: '2026-04-10T00:00:00.000Z',
          updatedAt: lastMessage ? lastMessage.createdAt : '2026-04-10T00:00:00.000Z',
          lastMessageAt: lastMessage ? lastMessage.createdAt : null,
          messageCount: conversation.messages.length,
          agentCount: conversation.agents.length,
          lastMessagePreview: lastMessage ? lastMessage.content : '',
        },
      ];
    },
    createMessage(input) {
      messageCounter += 1;
      const message = {
        id: input.id || `busy-slot-message-${messageCounter}`,
        errorMessage: '',
        taskId: null,
        runId: null,
        metadata: null,
        createdAt: input.createdAt || `2026-04-10T00:12:${String(messageCounter).padStart(2, '0')}.000Z`,
        ...input,
      };
      conversation.messages.push(message);
      return message;
    },
  };

  const orchestrator = createTurnOrchestrator({
    store,
    skillRegistry: { listSkills() { return []; }, resolveSkills() { return []; } },
    modeStore: { get() { return null; } },
    agentToolBridge: {},
    host: '127.0.0.1',
    port: 0,
    agentDir: tempDir,
    sqlitePath,
    toolBaseUrl: 'http://127.0.0.1:0',
    agentToolScriptPath: path.join(tempDir, 'agent-chat-tools.js'),
    executeConversationAgent: async ({ agent, turnState, completedReplies }) => {
      const stage = Array.isArray(turnState.agents) ? turnState.agents.find((item) => item.agentId === agent.id) || turnState.agents[0] : null;

      if (stage) {
        stage.status = 'running';
      }

      executions.push({
        agentId: agent.id,
        lane: turnState.executionLane || 'main',
        turnId: turnState.turnId,
      });

      if (executions.length === 1) {
        await firstRunGate;
      }

      if (stage) {
        stage.status = 'completed';
      }

      completedReplies.push({
        agentId: agent.id,
        senderName: agent.name,
        content: 'ok',
        status: 'completed',
      });
      return { stopTurn: false };
    },
  });

  const firstResult = orchestrator.submitConversationMessage(conversation.id, { content: '@Alpha 第一条' });
  assert.equal(firstResult.dispatch, 'started');
  assert.equal(firstResult.dispatchLane, 'main');

  await waitForCondition(() => orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 1);

  const secondResult = orchestrator.submitConversationMessage(conversation.id, { content: '@Alpha 第二条' });
  assert.equal(secondResult.dispatch, 'queued');
  assert.equal(secondResult.dispatchLane, 'side');
  assert.equal(secondResult.dispatchTargetAgentId, 'agent-a');
  assert.deepEqual(orchestrator.buildRuntimePayload().agentSlotQueueDepths[conversation.id], {
    'agent-a': 1,
  });

  releaseFirstRun();

  await waitForCondition(() => executions.length === 2 && orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 0);
  assert.equal(executions[0].lane, 'main');
  assert.equal(executions[1].lane, 'side');
  assert.equal(orchestrator.buildRuntimePayload().agentSlotQueueDepths[conversation.id], undefined);
});

test('turn orchestrator stop cancels queued side-dispatch waiters before they start', { concurrency: false }, async (t) => {
  const tempDir = withTempDir('caff-side-dispatch-stop-');
  const sqlitePath = path.join(tempDir, 'side-dispatch-stop.sqlite');
  const conversation = {
    id: 'conversation-side-dispatch-stop',
    title: 'Side dispatch stop',
    type: 'standard',
    agents: [{ id: 'agent-a', name: 'Alpha' }],
    messages: [],
  };
  let messageCounter = 0;
  let releaseFirstRun = null;
  const firstRunGate = new Promise((resolve) => {
    releaseFirstRun = resolve;
  });
  const executions = [];

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const store = {
    databasePath: sqlitePath,
    getConversation(conversationId) {
      return conversationId === conversation.id ? conversation : null;
    },
    listConversations() {
      const lastMessage = conversation.messages[conversation.messages.length - 1] || null;
      return [
        {
          id: conversation.id,
          title: conversation.title,
          type: conversation.type,
          metadata: {},
          createdAt: '2026-04-10T00:00:00.000Z',
          updatedAt: lastMessage ? lastMessage.createdAt : '2026-04-10T00:00:00.000Z',
          lastMessageAt: lastMessage ? lastMessage.createdAt : null,
          messageCount: conversation.messages.length,
          agentCount: conversation.agents.length,
          lastMessagePreview: lastMessage ? lastMessage.content : '',
        },
      ];
    },
    createMessage(input) {
      messageCounter += 1;
      const message = {
        id: input.id || `stop-side-message-${messageCounter}`,
        errorMessage: '',
        taskId: null,
        runId: null,
        metadata: null,
        createdAt: input.createdAt || `2026-04-10T00:13:${String(messageCounter).padStart(2, '0')}.000Z`,
        ...input,
      };
      conversation.messages.push(message);
      return message;
    },
    updateMessage(messageId, updates) {
      const message = conversation.messages.find((item) => item.id === messageId) || null;

      if (!message) {
        return null;
      }

      if (updates.content !== undefined) {
        message.content = String(updates.content || '');
      }
      if (updates.status !== undefined) {
        message.status = updates.status;
      }
      if (updates.taskId !== undefined) {
        message.taskId = updates.taskId || null;
      }
      if (updates.runId !== undefined) {
        message.runId = updates.runId || null;
      }
      if (updates.errorMessage !== undefined) {
        message.errorMessage = String(updates.errorMessage || '');
      }
      if (updates.metadata !== undefined) {
        message.metadata = updates.metadata;
      }

      return message;
    },
  };

  const orchestrator = createTurnOrchestrator({
    store,
    skillRegistry: { listSkills() { return []; }, resolveSkills() { return []; } },
    modeStore: { get() { return null; } },
    agentToolBridge: {},
    host: '127.0.0.1',
    port: 0,
    agentDir: tempDir,
    sqlitePath,
    toolBaseUrl: 'http://127.0.0.1:0',
    agentToolScriptPath: path.join(tempDir, 'agent-chat-tools.js'),
    executeConversationAgent: async ({ agent, turnState, completedReplies }) => {
      const stage = Array.isArray(turnState.agents) ? turnState.agents.find((item) => item.agentId === agent.id) || turnState.agents[0] : null;

      if (stage) {
        stage.status = 'running';
      }

      executions.push({
        agentId: agent.id,
        lane: turnState.executionLane || 'main',
        turnId: turnState.turnId,
      });

      if (executions.length === 1) {
        const waitResult = await new Promise((resolve) => {
          let settled = false;
          const resolveOnce = (value) => {
            if (settled) {
              return;
            }

            settled = true;
            resolve(value);
          };

          registerTurnHandle(turnState, {
            cancel(reason) {
              resolveOnce({ cancelled: true, reason });
            },
          });
          firstRunGate.then(() => resolveOnce({ cancelled: false }));
        });

        if (waitResult && waitResult.cancelled) {
          if (stage) {
            stage.status = 'completed';
          }

          return { stopTurn: true, terminationReason: 'stopped_by_user' };
        }
      }

      if (stage) {
        stage.status = 'completed';
      }

      completedReplies.push({
        agentId: agent.id,
        senderName: agent.name,
        content: 'ok',
        status: 'completed',
      });
      return { stopTurn: false };
    },
  });

  const firstResult = orchestrator.submitConversationMessage(conversation.id, { content: '@Alpha 第一条' });
  assert.equal(firstResult.dispatch, 'started');
  assert.equal(firstResult.dispatchLane, 'main');

  await waitForCondition(() => orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 1);

  const secondResult = orchestrator.submitConversationMessage(conversation.id, { content: '@Alpha 第二条' });
  assert.equal(secondResult.dispatch, 'queued');
  assert.equal(secondResult.dispatchLane, 'side');
  assert.equal(secondResult.dispatchTargetAgentId, 'agent-a');
  assert.deepEqual(orchestrator.buildRuntimePayload().agentSlotQueueDepths[conversation.id], {
    'agent-a': 1,
  });

  const stopSummary = orchestrator.requestStopConversationExecution(conversation.id, 'User stop');
  assert.equal(stopSummary.cancelledQueuedSideDispatchCount, 1);
  assert.equal(orchestrator.buildRuntimePayload().agentSlotQueueDepths[conversation.id], undefined);
  assert.equal(conversation.messages[1].metadata.dispatchCancelled, true);
  assert.equal(conversation.messages[1].metadata.dispatchCancelReason, 'User stop');

  await waitForCondition(() => orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 0);

  releaseFirstRun();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(executions.length, 1);
  assert.equal(orchestrator.listAgentSlotSummaries({ conversationId: conversation.id }).length, 0);
});

test('queued side-dispatch rehydrates snapshot message content when the slot is granted', { concurrency: false }, async (t) => {
  const tempDir = withTempDir('caff-side-dispatch-snapshot-');
  const sqlitePath = path.join(tempDir, 'side-dispatch-snapshot.sqlite');
  const conversation = {
    id: 'conversation-side-dispatch-snapshot',
    title: 'Side dispatch snapshot',
    type: 'standard',
    agents: [{ id: 'agent-a', name: 'Alpha' }],
    messages: [
      {
        id: 'snapshot-message-1',
        conversationId: 'conversation-side-dispatch-snapshot',
        turnId: 'turn-0',
        role: 'user',
        senderName: 'You',
        content: 'Earlier question',
        status: 'completed',
      },
      {
        id: 'snapshot-message-2',
        conversationId: 'conversation-side-dispatch-snapshot',
        turnId: 'turn-0',
        role: 'assistant',
        senderName: 'Alpha',
        agentId: 'agent-a',
        content: 'Earlier answer draft',
        status: 'completed',
      },
    ],
  };
  let messageCounter = conversation.messages.length;
  let releaseFirstRun = null;
  const firstRunGate = new Promise((resolve) => {
    releaseFirstRun = resolve;
  });
  const executions = [];

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const store = {
    databasePath: sqlitePath,
    getConversation(conversationId) {
      return conversationId === conversation.id ? conversation : null;
    },
    listConversations() {
      const lastMessage = conversation.messages[conversation.messages.length - 1] || null;
      return [
        {
          id: conversation.id,
          title: conversation.title,
          type: conversation.type,
          metadata: {},
          createdAt: '2026-04-10T00:00:00.000Z',
          updatedAt: lastMessage ? lastMessage.createdAt : '2026-04-10T00:00:00.000Z',
          lastMessageAt: lastMessage ? lastMessage.createdAt : null,
          messageCount: conversation.messages.length,
          agentCount: conversation.agents.length,
          lastMessagePreview: lastMessage ? lastMessage.content : '',
        },
      ];
    },
    createMessage(input) {
      messageCounter += 1;
      const message = {
        id: input.id || `snapshot-side-message-${messageCounter}`,
        errorMessage: '',
        taskId: null,
        runId: null,
        metadata: null,
        createdAt: input.createdAt || `2026-04-10T00:14:${String(messageCounter).padStart(2, '0')}.000Z`,
        ...input,
      };
      conversation.messages.push(message);
      return message;
    },
  };

  const orchestrator = createTurnOrchestrator({
    store,
    skillRegistry: { listSkills() { return []; }, resolveSkills() { return []; } },
    modeStore: { get() { return null; } },
    agentToolBridge: {},
    host: '127.0.0.1',
    port: 0,
    agentDir: tempDir,
    sqlitePath,
    toolBaseUrl: 'http://127.0.0.1:0',
    agentToolScriptPath: path.join(tempDir, 'agent-chat-tools.js'),
    executeConversationAgent: async ({ agent, turnState, promptMessages, completedReplies }) => {
      const stage = Array.isArray(turnState.agents) ? turnState.agents.find((item) => item.agentId === agent.id) || turnState.agents[0] : null;

      if (stage) {
        stage.status = 'running';
      }

      executions.push({
        agentId: agent.id,
        lane: turnState.executionLane || 'main',
        promptMessages: promptMessages.map((message) => message.content),
      });

      if (executions.length === 1) {
        await firstRunGate;
      }

      if (stage) {
        stage.status = 'completed';
      }

      completedReplies.push({
        agentId: agent.id,
        senderName: agent.name,
        content: 'ok',
        status: 'completed',
      });
      return { stopTurn: false };
    },
  });

  const firstResult = orchestrator.submitConversationMessage(conversation.id, { content: '@Alpha 第一条' });
  assert.equal(firstResult.dispatch, 'started');
  assert.equal(firstResult.dispatchLane, 'main');

  await waitForCondition(() => orchestrator.listTurnSummaries({ conversationId: conversation.id }).length === 1);

  const secondResult = orchestrator.submitConversationMessage(conversation.id, { content: '@Alpha 第二条' });
  assert.equal(secondResult.dispatch, 'queued');
  assert.equal(secondResult.dispatchLane, 'side');
  assert.equal(secondResult.dispatchTargetAgentId, 'agent-a');

  conversation.messages[1].content = 'Earlier answer final';
  releaseFirstRun();

  await waitForCondition(() => executions.length === 2);
  assert.equal(executions[1].lane, 'side');
  assert.ok(executions[1].promptMessages.includes('Earlier answer final'));
  assert.ok(executions[1].promptMessages.every((content) => !content.includes('Earlier answer draft')));
});

test('turn orchestrator recovers persisted side-dispatch messages after restart', { concurrency: false }, async (t) => {
  const tempDir = withTempDir('caff-side-dispatch-restart-');
  const sqlitePath = path.join(tempDir, 'side-dispatch-restart.sqlite');
  const conversation = {
    id: 'conversation-side-dispatch-restart',
    title: 'Side dispatch restart recovery',
    type: 'standard',
    agents: [{ id: 'agent-a', name: 'Alpha' }],
    messages: [
      {
        id: 'restart-history-user',
        conversationId: 'conversation-side-dispatch-restart',
        turnId: 'turn-0',
        role: 'user',
        senderName: 'You',
        content: 'Earlier question',
        status: 'completed',
      },
      {
        id: 'restart-history-assistant',
        conversationId: 'conversation-side-dispatch-restart',
        turnId: 'turn-0',
        role: 'assistant',
        senderName: 'Alpha',
        agentId: 'agent-a',
        content: 'Earlier answer',
        status: 'completed',
        metadata: { triggeredByMessageId: 'restart-history-user' },
      },
      {
        id: 'restart-side-user',
        conversationId: 'conversation-side-dispatch-restart',
        turnId: 'turn-1',
        role: 'user',
        senderName: 'You',
        content: '@Alpha Restart me',
        status: 'completed',
        metadata: {
          dispatchLane: 'side',
          dispatchTargetAgentId: 'agent-a',
        },
      },
      {
        id: 'restart-stale-assistant',
        conversationId: 'conversation-side-dispatch-restart',
        turnId: 'turn-1',
        role: 'assistant',
        senderName: 'Alpha',
        agentId: 'agent-a',
        content: 'Thinking...',
        status: 'streaming',
        metadata: {
          triggeredByMessageId: 'restart-side-user',
        },
      },
    ],
  };
  let messageCounter = conversation.messages.length;
  const executions = [];

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const store = {
    databasePath: sqlitePath,
    getConversation(conversationId) {
      return conversationId === conversation.id ? conversation : null;
    },
    listConversations() {
      const lastMessage = conversation.messages[conversation.messages.length - 1] || null;
      return [
        {
          id: conversation.id,
          title: conversation.title,
          type: conversation.type,
          metadata: {},
          createdAt: '2026-04-10T00:00:00.000Z',
          updatedAt: lastMessage ? lastMessage.createdAt : '2026-04-10T00:00:00.000Z',
          lastMessageAt: lastMessage ? lastMessage.createdAt : null,
          messageCount: conversation.messages.length,
          agentCount: conversation.agents.length,
          lastMessagePreview: lastMessage ? lastMessage.content : '',
        },
      ];
    },
    createMessage(input) {
      messageCounter += 1;
      const message = {
        id: input.id || `restart-side-message-${messageCounter}`,
        errorMessage: '',
        taskId: null,
        runId: null,
        metadata: null,
        createdAt: input.createdAt || `2026-04-10T00:15:${String(messageCounter).padStart(2, '0')}.000Z`,
        ...input,
      };
      conversation.messages.push(message);
      return message;
    },
    updateMessage(messageId, updates) {
      const message = conversation.messages.find((item) => item.id === messageId) || null;

      if (!message) {
        return null;
      }

      if (updates.content !== undefined) {
        message.content = String(updates.content || '');
      }
      if (updates.status !== undefined) {
        message.status = updates.status;
      }
      if (updates.taskId !== undefined) {
        message.taskId = updates.taskId || null;
      }
      if (updates.runId !== undefined) {
        message.runId = updates.runId || null;
      }
      if (updates.errorMessage !== undefined) {
        message.errorMessage = String(updates.errorMessage || '');
      }
      if (updates.metadata !== undefined) {
        message.metadata = updates.metadata;
      }

      return message;
    },
  };

  createTurnOrchestrator({
    store,
    skillRegistry: { listSkills() { return []; }, resolveSkills() { return []; } },
    modeStore: { get() { return null; } },
    agentToolBridge: {},
    host: '127.0.0.1',
    port: 0,
    agentDir: tempDir,
    sqlitePath,
    toolBaseUrl: 'http://127.0.0.1:0',
    agentToolScriptPath: path.join(tempDir, 'agent-chat-tools.js'),
    executeConversationAgent: async ({ agent, turnState, promptUserMessage, promptMessages, completedReplies }) => {
      executions.push({
        agentId: agent.id,
        lane: turnState.executionLane || 'main',
        promptUserMessageId: promptUserMessage.id,
        promptMessages: promptMessages.map((message) => ({
          id: message.id,
          content: message.content,
        })),
      });

      completedReplies.push({
        agentId: agent.id,
        senderName: agent.name,
        content: 'ok',
        status: 'completed',
      });
      return { stopTurn: false };
    },
  });

  await waitForCondition(() => executions.length === 1);

  assert.equal(executions[0].lane, 'side');
  assert.equal(executions[0].promptUserMessageId, 'restart-side-user');
  assert.deepEqual(
    executions[0].promptMessages.map((message) => message.id),
    ['restart-history-user', 'restart-history-assistant', 'restart-side-user']
  );
  assert.equal(conversation.messages[3].status, 'failed');
  assert.equal(conversation.messages[3].errorMessage, 'Recovered after process restart before side dispatch completed');
  assert.equal(conversation.messages[3].metadata.recoveredAfterRestart, true);
});

test('turn orchestrator finalizes stale cancelled side-dispatch replies during restart recovery', { concurrency: false }, async (t) => {
  const tempDir = withTempDir('caff-side-dispatch-cancelled-restart-');
  const sqlitePath = path.join(tempDir, 'side-dispatch-cancelled-restart.sqlite');
  const conversation = {
    id: 'conversation-side-dispatch-cancelled-restart',
    title: 'Side dispatch cancelled restart cleanup',
    type: 'standard',
    agents: [{ id: 'agent-a', name: 'Alpha' }],
    messages: [
      {
        id: 'cancelled-side-user',
        conversationId: 'conversation-side-dispatch-cancelled-restart',
        turnId: 'turn-1',
        role: 'user',
        senderName: 'You',
        content: '@Alpha Stop me',
        status: 'completed',
        metadata: {
          dispatchLane: 'side',
          dispatchTargetAgentId: 'agent-a',
          dispatchCancelled: true,
          dispatchCancelledAt: '2026-04-10T00:16:00.000Z',
        },
      },
      {
        id: 'cancelled-stale-assistant',
        conversationId: 'conversation-side-dispatch-cancelled-restart',
        turnId: 'turn-1',
        role: 'assistant',
        senderName: 'Alpha',
        agentId: 'agent-a',
        content: 'Thinking...',
        status: 'streaming',
        metadata: {
          triggeredByMessageId: 'cancelled-side-user',
          streaming: true,
        },
      },
    ],
  };
  let messageCounter = conversation.messages.length;
  const executions = [];

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const store = {
    databasePath: sqlitePath,
    getConversation(conversationId) {
      return conversationId === conversation.id ? conversation : null;
    },
    listConversations() {
      const lastMessage = conversation.messages[conversation.messages.length - 1] || null;
      return [
        {
          id: conversation.id,
          title: conversation.title,
          type: conversation.type,
          metadata: {},
          createdAt: '2026-04-10T00:00:00.000Z',
          updatedAt: lastMessage ? lastMessage.createdAt : '2026-04-10T00:00:00.000Z',
          lastMessageAt: lastMessage ? lastMessage.createdAt : null,
          messageCount: conversation.messages.length,
          agentCount: conversation.agents.length,
          lastMessagePreview: lastMessage ? lastMessage.content : '',
        },
      ];
    },
    createMessage(input) {
      messageCounter += 1;
      const message = {
        id: input.id || `cancelled-side-message-${messageCounter}`,
        errorMessage: '',
        taskId: null,
        runId: null,
        metadata: null,
        createdAt: input.createdAt || `2026-04-10T00:16:${String(messageCounter).padStart(2, '0')}.000Z`,
        ...input,
      };
      conversation.messages.push(message);
      return message;
    },
    updateMessage(messageId, updates) {
      const message = conversation.messages.find((item) => item.id === messageId) || null;

      if (!message) {
        return null;
      }

      if (updates.content !== undefined) {
        message.content = String(updates.content || '');
      }
      if (updates.status !== undefined) {
        message.status = updates.status;
      }
      if (updates.taskId !== undefined) {
        message.taskId = updates.taskId || null;
      }
      if (updates.runId !== undefined) {
        message.runId = updates.runId || null;
      }
      if (updates.errorMessage !== undefined) {
        message.errorMessage = String(updates.errorMessage || '');
      }
      if (updates.metadata !== undefined) {
        message.metadata = updates.metadata;
      }

      return message;
    },
  };

  createTurnOrchestrator({
    store,
    skillRegistry: { listSkills() { return []; }, resolveSkills() { return []; } },
    modeStore: { get() { return null; } },
    agentToolBridge: {},
    host: '127.0.0.1',
    port: 0,
    agentDir: tempDir,
    sqlitePath,
    toolBaseUrl: 'http://127.0.0.1:0',
    agentToolScriptPath: path.join(tempDir, 'agent-chat-tools.js'),
    executeConversationAgent: async ({ completedReplies }) => {
      executions.push({ lane: 'side' });
      completedReplies.push({
        agentId: 'agent-a',
        senderName: 'Alpha',
        content: 'ok',
        status: 'completed',
      });
      return { stopTurn: false };
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(executions.length, 0);
  assert.equal(conversation.messages[1].content, '');
  assert.equal(conversation.messages[1].status, 'failed');
  assert.equal(conversation.messages[1].errorMessage, 'Recovered after process restart before side dispatch completed');
  assert.equal(conversation.messages[1].metadata.streaming, false);
  assert.equal(conversation.messages[1].metadata.recoveredAfterRestart, true);
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

test('live session tool extraction gives anonymous calls stable monotonic step ids', () => {
  const anonymousTracker = {
    nextIndex: 0,
    activeStepId: '',
    activeFingerprint: '',
    activeToolName: '',
    activeToolKind: '',
  };

  const first = extractLiveSessionToolFromPiEvent(
    {
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', name: 'read', arguments: { path: '/tmp/a.md' } }],
      },
    },
    {
      createdAt: '2026-04-10T00:00:00.000Z',
      anonymousTracker,
    }
  );

  assert.ok(first);
  assert.equal(first.step.stepId, 'session-1');

  const second = extractLiveSessionToolFromPiEvent(
    {
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', name: 'read', partialJson: '{"path":"/tmp/a.md"' }],
      },
    },
    {
      createdAt: '2026-04-10T00:00:00.100Z',
      currentToolName: first.currentTool.toolName,
      currentToolKind: first.currentTool.toolKind,
      currentToolStepId: first.currentTool.toolStepId,
      anonymousTracker,
    }
  );

  assert.ok(second);
  assert.equal(second.step.stepId, 'session-1');

  const third = extractLiveSessionToolFromPiEvent(
    {
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', name: 'read', arguments: { path: '/tmp/b.md' } }],
      },
    },
    {
      createdAt: '2026-04-10T00:00:00.200Z',
      currentToolName: second.currentTool.toolName,
      currentToolKind: second.currentTool.toolKind,
      currentToolStepId: second.currentTool.toolStepId,
      anonymousTracker,
    }
  );

  assert.ok(third);
  assert.equal(third.step.stepId, 'session-2');

  const fourth = extractLiveSessionToolFromPiEvent(
    {
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', name: 'read', partialJson: '{"path":"/tmp/b.md"' }],
      },
    },
    {
      createdAt: '2026-04-10T00:00:00.300Z',
      currentToolName: third.currentTool.toolName,
      currentToolKind: third.currentTool.toolKind,
      currentToolStepId: third.currentTool.toolStepId,
      anonymousTracker,
    }
  );

  assert.ok(fourth);
  assert.equal(fourth.step.stepId, 'session-2');
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
