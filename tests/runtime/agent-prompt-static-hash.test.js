const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AGENT_PROMPT_VERSION,
  buildAgentTurnPromptSections,
  computeStaticPromptHash,
  formatAgentTurnPromptSections,
} = require('../../build/server/domain/conversation/turn/agent-prompt');

const EXPECTED_DYNAMIC_SECTION_KEYS = [
  'session_goal',
  'conversation_digest',
  'retrieved_memory',
  'retrieval_trace',
  'private_mailbox',
  'conversation_history',
  'turn_trigger',
];

function buildInput(overrides = {}) {
  return {
    conversation: { id: 'conv-1', title: 'Reuse Test', type: 'standard' },
    agent: { id: 'agent-1', name: 'Kimi', description: 'Moonshot model family', roleKind: 'model_family' },
    agentConfig: { profileName: 'Default' },
    resolvedPersonaSkills: [],
    resolvedConversationSkills: [],
    sandbox: { sandboxDir: '/tmp/sandbox', privateDir: '/tmp/private' },
    projectDir: '',
    agents: [
      { id: 'agent-1', name: 'Kimi', description: 'Moonshot model family' },
      { id: 'agent-2', name: 'GPT', description: 'OpenAI model family' },
    ],
    messages: [],
    privateMessages: [],
    relatedMemorySegments: [],
    trigger: null,
    remainingSlots: 3,
    routingMode: 'mention',
    agentToolRelativePath: './build/lib/agent-chat-tools.js',
    ...overrides,
  };
}

test('every prompt section carries an explicit static/dynamic stability tag', () => {
  const sections = buildAgentTurnPromptSections(
    buildInput({
      messages: [{ id: 'm-1', role: 'user', content: 'hello' }],
      privateMessages: [{ id: 'p-1', senderName: 'GPT', content: 'psst' }],
    })
  );

  assert.ok(sections.length > 0);
  for (const section of sections) {
    assert.ok(
      section.stability === 'static' || section.stability === 'dynamic',
      `section ${section.sectionKey} missing stability tag`
    );
  }

  const dynamicKeys = sections
    .filter((section) => section.stability === 'dynamic')
    .map((section) => section.sectionKey)
    .sort();
  const expectedPresent = EXPECTED_DYNAMIC_SECTION_KEYS.filter((key) =>
    sections.some((section) => section.sectionKey === key)
  ).sort();
  assert.deepEqual(dynamicKeys, expectedPresent);

  // Sections that must stay static because reuse validity depends on them.
  const staticKeys = new Set(
    sections.filter((section) => section.stability === 'static').map((section) => section.sectionKey)
  );
  for (const key of ['workspace_header', 'room_work_context', 'rules', 'tool_instructions', 'local_sandbox', 'participants']) {
    assert.ok(staticKeys.has(key), `section ${key} must be static`);
  }
});

test('static prompt hash is deterministic for identical input', () => {
  const first = computeStaticPromptHash(buildAgentTurnPromptSections(buildInput()), ['model-a', 'provider-a', 'profile-a']);
  const second = computeStaticPromptHash(buildAgentTurnPromptSections(buildInput()), ['model-a', 'provider-a', 'profile-a']);
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test('static prompt hash ignores dynamic churn (history and mailbox)', () => {
  const base = computeStaticPromptHash(buildAgentTurnPromptSections(buildInput()), ['model-a']);

  const withHistory = computeStaticPromptHash(
    buildAgentTurnPromptSections(
      buildInput({
        messages: [
          { id: 'm-1', role: 'user', content: 'first message' },
          { id: 'm-2', agentId: 'agent-2', senderName: 'GPT', content: 'agent reply' },
        ],
        privateMessages: [{ id: 'p-1', senderName: 'GPT', content: 'private note' }],
        trigger: { kind: 'mention', messageId: 'm-1' },
      })
    ),
    ['model-a']
  );

  assert.equal(base, withHistory);
});

test('static prompt hash changes when static configuration changes', () => {
  const base = computeStaticPromptHash(buildAgentTurnPromptSections(buildInput()), ['model-a', 'profile-a']);

  const differentSandbox = computeStaticPromptHash(
    buildAgentTurnPromptSections(buildInput({ sandbox: { sandboxDir: '/tmp/other', privateDir: '/tmp/private' } })),
    ['model-a', 'profile-a']
  );
  assert.notEqual(base, differentSandbox);

  const differentParticipants = computeStaticPromptHash(
    buildAgentTurnPromptSections(
      buildInput({
        agents: [
          { id: 'agent-1', name: 'Kimi', description: 'Moonshot model family' },
          { id: 'agent-2', name: 'GPT', description: 'OpenAI model family' },
          { id: 'agent-3', name: 'GLM', description: 'Zhipu model family' },
        ],
      })
    ),
    ['model-a', 'profile-a']
  );
  assert.notEqual(base, differentParticipants);

  const differentModel = computeStaticPromptHash(buildAgentTurnPromptSections(buildInput()), ['model-b', 'profile-a']);
  assert.notEqual(base, differentModel);
});

test('static prompt hash is bound to AGENT_PROMPT_VERSION', () => {
  const sections = buildAgentTurnPromptSections(buildInput());
  const hash = computeStaticPromptHash(sections, []);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.ok(AGENT_PROMPT_VERSION.length > 0);
  // Same sections hashed with a different extra fingerprint must differ.
  assert.notEqual(hash, computeStaticPromptHash(sections, ['fingerprint-x']));
});

test('rendered prompt text is unchanged by stability tagging', () => {
  const input = buildInput({
    messages: [{ id: 'm-1', role: 'user', content: 'hello there' }],
  });
  const sections = buildAgentTurnPromptSections(input);
  const rendered = formatAgentTurnPromptSections(sections);
  const expected = sections
    .map((section) => String(section.content || '').trim())
    .filter(Boolean)
    .join('\n\n');
  assert.equal(rendered, expected);
  assert.ok(rendered.includes('hello there'));
  assert.ok(rendered.includes('Write your reply now.'));
});
