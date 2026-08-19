const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadDialogModule() {
  const modelOptionsPath = path.join(__dirname, '../../public/shared/model-options.js');
  const sourcePath = path.join(__dirname, '../../public/chat/new-conversation-dialog.js');
  const context = { window: { CaffChat: {}, CaffShared: {} } };
  vm.runInNewContext(fs.readFileSync(modelOptionsPath, 'utf8'), context, { filename: modelOptionsPath });
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
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

test('Room snapshot freezes runnable defaults and keeps unavailable roles visible', () => {
  const dialog = loadDialogModule();
  const agents = [
    role({ isDefaultChatRole: true }),
    role({ id: 'role-family-claude', name: 'Claude', modelFamily: 'claude', isDefaultChatRole: true }),
    role({
      id: 'role-family-qwen', name: 'Qwen', modelFamily: 'qwen', isDefaultChatRole: true,
      availability: { status: 'base_model_missing', familyModelCount: 0 },
    }),
  ];
  const snapshot = dialog.snapshotRoles(agents);
  agents[0].name = 'mutated';
  assert.equal(snapshot[0].name, 'GPT');
  assert.equal(snapshot[2].available, false);
  assert.deepEqual(Array.from(dialog.initialSelectedRoleIds(snapshot)), ['role-family-gpt', 'role-family-claude']);
});

test('Room create request requires immutable Project and Mode', () => {
  const dialog = loadDialogModule();
  const snapshot = dialog.snapshotRoles([
    role({ isDefaultChatRole: true }),
    role({ id: 'role-family-claude', name: 'Claude', modelFamily: 'claude' }),
  ]);
  const request = dialog.buildConversationRequest({
    title: '  模型族协作  ', projectScopeId: ' project-1 ', modeId: ' coding ', snapshot,
    selectedRoleIds: new Set(['role-family-claude']),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(request)), {
    title: '模型族协作', projectScopeId: 'project-1', modeId: 'coding',
    participants: [{ agentId: 'role-family-claude', modelProfileId: null, conversationSkillIds: [] }],
  });
  assert.throws(
    () => dialog.buildConversationRequest({ modeId: 'coding', snapshot, selectedRoleIds: new Set(['role-family-gpt']) }),
    (error) => error && error.code === 'project_required'
  );
  assert.throws(
    () => dialog.buildConversationRequest({ projectScopeId: 'project-1', snapshot, selectedRoleIds: new Set(['role-family-gpt']) }),
    (error) => error && error.code === 'mode_required'
  );
});

test('custom Skill-backed Mode still uses explicit participants', () => {
  const dialog = loadDialogModule();
  const snapshot = dialog.snapshotRoles([role({ id: 'role-family-gpt' })]);
  const request = dialog.buildConversationRequest({
    title: 'Review', projectScopeId: 'p1', modeId: 'architecture-review', snapshot,
    selectedRoleIds: new Set(['role-family-gpt']),
  });
  assert.equal(request.modeId, 'architecture-review');
  assert.deepEqual(Array.from(request.participants, (item) => item.agentId), ['role-family-gpt']);
});

test('spawn requests require explicit project, roster, primary Agent, public initial message, and idempotency key', () => {
  const dialog = loadDialogModule();
  const snapshot = dialog.snapshotRoles([
    role({ id: 'role-family-gpt', name: 'GPT' }),
    role({ id: 'role-family-claude', name: 'Claude', modelFamily: 'claude' }),
  ]);
  const request = dialog.buildConversationSpawnRequest({
    title: 'Child investigation', projectScopeId: 'project-1', snapshot,
    selectedRoleIds: new Set(['role-family-gpt', 'role-family-claude']),
    primaryAgentId: 'role-family-claude', initialMessage: 'Investigate.',
    sourceMessageId: 'message-1', clientRequestId: 'request-1',
  });
  assert.equal(request.projectScopeId, 'project-1');
  assert.equal(request.primaryAgentId, 'role-family-claude');
  assert.equal(request.initialMessage, 'Investigate.');
});
