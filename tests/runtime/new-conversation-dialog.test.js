const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadDialogModule() {
  const sourcePath = path.join(__dirname, '../../public/chat/new-conversation-dialog.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const context = { window: { CaffChat: {} } };
  vm.runInNewContext(source, context, { filename: sourcePath });
  return context.window.CaffChat.newConversationDialog;
}

function role(overrides = {}) {
  return {
    id: 'role-family-gpt',
    name: 'GPT',
    roleKind: 'model_family',
    modelFamily: 'gpt',
    isDefaultChatRole: false,
    availability: { status: 'available', familyModelCount: 2 },
    ...overrides,
  };
}

test('new conversation snapshot freezes runnable defaults and keeps unavailable roles visible', () => {
  const dialog = loadDialogModule();
  const agents = [
    role({ isDefaultChatRole: true }),
    role({ id: 'role-family-claude', name: 'Claude', modelFamily: 'claude', isDefaultChatRole: true }),
    role({
      id: 'role-family-qwen',
      name: 'Qwen',
      modelFamily: 'qwen',
      isDefaultChatRole: true,
      availability: { status: 'base_model_missing', familyModelCount: 0 },
    }),
    role({
      id: 'custom-reviewer',
      name: '架构评审',
      roleKind: 'custom',
      modelFamily: null,
      isDefaultChatRole: false,
    }),
  ];

  const snapshot = dialog.snapshotRoles(agents);
  agents[0].isDefaultChatRole = false;
  agents[0].name = 'mutated';

  assert.deepEqual(Array.from(snapshot, (item) => item.id), [
    'role-family-gpt',
    'role-family-claude',
    'role-family-qwen',
    'custom-reviewer',
  ]);
  assert.equal(snapshot[0].name, 'GPT');
  assert.equal(snapshot[0].isDefaultChatRole, true);
  assert.equal(snapshot[2].available, false);
  assert.match(snapshot[2].unavailableReason, /可用模型/u);
  assert.deepEqual(Array.from(dialog.initialSelectedRoleIds(snapshot, 'standard')), [
    'role-family-gpt',
    'role-family-claude',
  ]);
  assert.deepEqual(Array.from(dialog.initialSelectedRoleIds(snapshot, 'skill_test_design')), []);
  assert.deepEqual(Array.from(dialog.initialSelectedRoleIds(snapshot, 'werewolf')), []);
});

test('new conversation requests contain only the final explicit runnable roster', () => {
  const dialog = loadDialogModule();
  const snapshot = dialog.snapshotRoles([
    role({ isDefaultChatRole: true }),
    role({ id: 'role-family-claude', name: 'Claude', modelFamily: 'claude', isDefaultChatRole: true }),
    role({
      id: 'role-family-qwen',
      name: 'Qwen',
      modelFamily: 'qwen',
      availability: { status: 'base_model_missing', familyModelCount: 0 },
    }),
  ]);

  const request = dialog.buildConversationRequest({
    title: '  模型族协作  ',
    type: 'standard',
    snapshot,
    selectedRoleIds: new Set(['role-family-claude', 'role-family-qwen']),
  });

  assert.equal(request.title, '模型族协作');
  assert.equal(request.type, 'standard');
  assert.deepEqual(JSON.parse(JSON.stringify(request.participants)), [
    {
      agentId: 'role-family-claude',
      modelProfileId: null,
      conversationSkillIds: [],
    },
  ]);
});

test('custom modes and games require their own explicit player selection', () => {
  const dialog = loadDialogModule();
  const snapshot = dialog.snapshotRoles([
    role({ isDefaultChatRole: true }),
    role({ id: 'role-family-claude', name: 'Claude', modelFamily: 'claude' }),
    role({ id: 'role-family-gemini', name: 'Gemini', modelFamily: 'gemini' }),
  ]);

  assert.throws(
    () => dialog.buildConversationRequest({
      title: '',
      type: 'werewolf',
      snapshot,
      selectedRoleIds: new Set(),
    }),
    (error) => error && error.code === 'participants_required'
  );

  const gameRequest = dialog.buildConversationRequest({
    title: '狼人杀',
    type: 'werewolf',
    snapshot,
    selectedRoleIds: new Set(['role-family-gpt', 'role-family-gemini']),
  });
  assert.deepEqual(Array.from(gameRequest.participants, (item) => item.agentId), [
    'role-family-gpt',
    'role-family-gemini',
  ]);
});

test('skill test design keeps selected current roles and adds only skill metadata', () => {
  const dialog = loadDialogModule();
  const snapshot = dialog.snapshotRoles([
    role({ id: 'role-family-gpt', name: 'GPT' }),
    role({ id: 'role-family-claude', name: 'Claude', modelFamily: 'claude' }),
    role({ id: 'custom-reviewer', name: '架构评审', roleKind: 'custom', modelFamily: null }),
  ]);

  assert.throws(
    () => dialog.buildConversationRequest({
      title: '',
      type: 'skill_test_design',
      skillId: 'tdd',
      snapshot,
      selectedRoleIds: new Set(['role-family-gpt', 'role-family-claude']),
    }),
    (error) => error && error.code === 'skill_test_participant_count_invalid'
  );

  const request = dialog.buildConversationRequest({
    title: '',
    type: 'skill_test_design',
    skillId: 'tdd',
    snapshot,
    selectedRoleIds: new Set(['role-family-gpt', 'role-family-claude', 'custom-reviewer']),
  });

  assert.deepEqual(Array.from(request.participants, (item) => item.agentId), [
    'role-family-gpt',
    'role-family-claude',
    'custom-reviewer',
  ]);
  assert.equal(request.skillId, 'tdd');
  assert.equal(request.metadata.skillTestDesign.skillId, 'tdd');
  assert.equal(JSON.stringify(request).includes('agent-strategist'), false);
  assert.equal(JSON.stringify(request).includes('agent-critic'), false);
  assert.equal(JSON.stringify(request).includes('agent-builder'), false);
});
