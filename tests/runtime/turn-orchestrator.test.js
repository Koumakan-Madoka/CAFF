const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildAgentTurnPrompt,
  sanitizePromptMentions,
} = require('../../server/domain/conversation/turn-orchestrator');

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
    agentToolRelativePath: './agent-chat-tools.js',
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
    agentToolRelativePath: './agent-chat-tools.js',
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
