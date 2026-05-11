const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAgentContextSnapshot,
  exportAgentContextSnapshotMarkdown,
  materializeAgentContextSnapshot,
} = require('../../build/server/domain/conversation/turn/context-snapshot');

test('context snapshot redacts full-visibility secret-like values', () => {
  const snapshot = createAgentContextSnapshot({
    conversationId: 'conv-1',
    turnId: 'turn-1',
    messageId: 'msg-1',
    agentId: 'agent-1',
    agentName: 'Agent',
    promptVersion: 'test',
    sections: [
      {
        sectionKey: 'conversation_history',
        title: 'Conversation History',
        source: 'conversation/messages',
        visibility: 'full',
        content: 'User: my key is sk-1234567890abcdef and hex deadbeef',
      },
    ],
  });

  const materialized = materializeAgentContextSnapshot(snapshot);
  assert.equal(materialized.sections[0].visibility, 'full');
  assert.equal(materialized.sections[0].redacted, true);
  assert.doesNotMatch(materialized.sections[0].displayContent, /sk-1234567890abcdef/u);
  assert.doesNotMatch(materialized.sections[0].displayContent, /deadbeef/u);
  assert.match(materialized.sections[0].displayContent, /\[REDACTED\]/u);
});

test('context snapshot redacts sensitive context paths without hiding the section', () => {
  const snapshot = createAgentContextSnapshot({
    conversationId: 'conv-1',
    turnId: 'turn-2',
    messageId: 'msg-2',
    agentId: 'agent-1',
    agentName: 'Agent',
    promptVersion: 'test',
    sections: [
      {
        sectionKey: 'local_sandbox',
        title: 'Local Sandbox',
        source: 'runtime/sandbox',
        visibility: 'full',
        content: 'PI_AGENT_PRIVATE_DIR=/tmp/private\nCAFF_CHAT_TOOLS_PATH=/tmp/tools\nUse your sandbox normally.',
      },
    ],
  });

  const materialized = materializeAgentContextSnapshot(snapshot);
  assert.equal(materialized.sections[0].visibility, 'full');
  assert.equal(materialized.sections[0].redacted, true);
  assert.match(materialized.sections[0].displayContent, /PI_AGENT_PRIVATE_DIR=\[REDACTED\]/u);
  assert.match(materialized.sections[0].displayContent, /CAFF_CHAT_TOOLS_PATH=\[REDACTED\]/u);
  assert.match(materialized.sections[0].displayContent, /Use your sandbox normally\./u);
  assert.match(materialized.sections[0].policyNote, /局部脱敏/u);
  assert.doesNotMatch(JSON.stringify(materialized), /\/tmp\/private/u);
  assert.doesNotMatch(JSON.stringify(materialized), /\/tmp\/tools/u);
});

test('context snapshot markdown export includes private mailbox content when selected agent received it', () => {
  const snapshot = createAgentContextSnapshot({
    conversationId: 'conv-1',
    turnId: 'turn-3',
    messageId: 'msg-3',
    agentId: 'agent-1',
    agentName: 'Agent',
    promptVersion: 'test',
    sections: [
      {
        sectionKey: 'private_mailbox',
        title: 'Private Mailbox',
        source: 'conversation/private-messages',
        visibility: 'full',
        content: 'Other Agent: private raw content is part of this agent prompt',
      },
      {
        sectionKey: 'conversation_history',
        title: 'Conversation History',
        source: 'conversation/messages',
        visibility: 'full',
        content: 'User: hello',
      },
    ],
  });

  const markdown = exportAgentContextSnapshotMarkdown(snapshot);
  const materialized = materializeAgentContextSnapshot(snapshot);
  assert.match(materialized.sections[0].displayTitle, /仅自己可见的私有信箱/u);
  assert.match(markdown, /# Agent Context Snapshot \/ 智能体上下文快照/u);
  assert.match(markdown, /Private Mailbox/u);
  assert.match(markdown, /仅自己可见的私有信箱/u);
  assert.match(markdown, /private raw content is part of this agent prompt/u);
  assert.match(markdown, /User: hello/u);
});

test('context snapshot displays current conversation digest as a distinct section', () => {
  const snapshot = createAgentContextSnapshot({
    conversationId: 'conv-1',
    turnId: 'turn-digest',
    messageId: 'msg-digest',
    agentId: 'agent-1',
    agentName: 'Agent',
    promptVersion: 'test',
    sections: [
      {
        sectionKey: 'conversation_digest',
        title: 'Current Conversation Digest',
        source: 'conversation/metadata',
        visibility: 'full',
        content: 'Current Conversation Digest / 当前聊天室摘要:\nSummary: Keep this room aligned.',
      },
    ],
  });

  const materialized = materializeAgentContextSnapshot(snapshot);
  assert.match(materialized.sections[0].displayTitle, /当前聊天室摘要/u);
  assert.match(materialized.sections[0].displayTitle, /Current Conversation Digest/u);
  assert.equal(materialized.sections[0].source, 'conversation/metadata');
  assert.equal(materialized.sections[0].visibility, 'full');
  assert.match(materialized.sections[0].displayContent, /Keep this room aligned/u);
});

test('context snapshots remain isolated by message metadata', () => {
  const first = createAgentContextSnapshot({
    conversationId: 'conv-1',
    turnId: 'turn-a',
    messageId: 'msg-a',
    agentId: 'agent-a',
    agentName: 'Agent A',
    sections: [{ sectionKey: 'conversation_history', title: 'History', content: 'A only', visibility: 'full' }],
  });
  const second = createAgentContextSnapshot({
    conversationId: 'conv-1',
    turnId: 'turn-b',
    messageId: 'msg-b',
    agentId: 'agent-b',
    agentName: 'Agent B',
    sections: [{ sectionKey: 'conversation_history', title: 'History', content: 'B only', visibility: 'full' }],
  });

  assert.notEqual(first.snapshotId, second.snapshotId);
  assert.equal(materializeAgentContextSnapshot(first).agentId, 'agent-a');
  assert.equal(materializeAgentContextSnapshot(second).agentId, 'agent-b');
  assert.match(materializeAgentContextSnapshot(first).sections[0].displayContent, /A only/u);
  assert.doesNotMatch(materializeAgentContextSnapshot(first).sections[0].displayContent, /B only/u);
});
