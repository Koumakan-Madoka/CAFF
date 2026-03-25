const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildAgentTurnPrompt,
  sanitizePromptMentions,
} = require('../../server/domain/conversation/turn-orchestrator');
const { createAgentExecutor } = require('../../server/domain/conversation/turn/agent-executor');
const { ensureAgentSandbox } = require('../../server/domain/conversation/turn/agent-sandbox');
const { createSessionExporter } = require('../../server/domain/conversation/turn/session-export');
const { createTurnState } = require('../../server/domain/conversation/turn/turn-state');
const { createTurnStopper, registerTurnHandle } = require('../../server/domain/conversation/turn/turn-stop');

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

test('session export refuses non-assistant messages and out-of-bounds paths', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-session-export-'));
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-session-missing-'));

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { resolveAssistantMessageSessionPath } = createSessionExporter({ agentDir: tempDir });

  assert.throws(
    () => resolveAssistantMessageSessionPath({ role: 'assistant', metadata: {} }),
    (error) => error && error.statusCode === 404
  );
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
});

test('agent sandbox helper creates private directory', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-sandbox-'));

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const agent = { id: 'agent-example', name: 'Example' };
  const sandbox = ensureAgentSandbox(tempDir, agent);

  assert.ok(fs.existsSync(sandbox.sandboxDir));
  assert.ok(fs.existsSync(sandbox.privateDir));
  assert.match(sandbox.privateDir, /private$/u);
});
