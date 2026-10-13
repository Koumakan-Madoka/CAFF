const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createPiCapabilityBridge,
  createRoomWorkspaceCapabilityDefinitions,
} = require('../../build/server/domain/runtime/pi-capability-bridge');

function createPrincipal(overrides = {}) {
  return {
    invocationId: 'invocation-ws',
    sourceConversationId: 'conversation-ws',
    sourceAgentId: 'agent-ws',
    sourceAgentName: 'Workspace Agent',
    projectScopeId: 'project-ws',
    traceId: 'trace-ws',
    incomingDeliveryId: null,
    ...overrides,
  };
}

const bindPreview = {
  kind: 'bind',
  conversationId: 'conversation-ws',
  projectScopeId: 'project-ws',
  repositoryPath: '/repo',
  baseBranch: 'develop',
  baseSha: 'a'.repeat(40),
  branch: 'feature/custom-name',
  worktreePath: '/worktrees/room/abcd1234',
  alreadyBound: false,
  reused: false,
};

const renamePreview = {
  kind: 'rename',
  conversationId: 'conversation-ws',
  projectScopeId: 'project-ws',
  repositoryPath: '/repo',
  baseBranch: 'develop',
  baseSha: 'a'.repeat(40),
  branch: 'feature/before',
  newBranch: 'feature/after',
  worktreePath: '/worktrees/room/abcd1234',
  alreadyBound: true,
};

function createBridge(calls) {
  return createPiCapabilityBridge({
    capabilities: createRoomWorkspaceCapabilityDefinitions({
      preview(input) {
        calls.push({ kind: 'preview', input });
        return bindPreview;
      },
      bind(input) {
        calls.push({ kind: 'bind', input });
        return { ...bindPreview, alreadyBound: true };
      },
      renamePreview(input) {
        calls.push({ kind: 'renamePreview', input });
        return renamePreview;
      },
      renameBind(input) {
        calls.push({ kind: 'renameBind', input });
        return { ...renamePreview, renamed: true, recovered: false };
      },
    }),
  });
}

test('room_workspace_preview accepts an optional full branchName and rejects everything else', async () => {
  const calls = [];
  const bridge = createBridge(calls);
  const principal = createPrincipal();

  const preview = await bridge.invokeFacade('room_workspace_preview', {
    principal,
    arguments: { branchName: 'feature/custom-name' },
  });
  assert.equal(preview.branch, 'feature/custom-name');
  assert.deepEqual(calls[0].input.arguments, { branchName: 'feature/custom-name' });

  await bridge.invokeFacade('room_workspace_preview', { principal, arguments: {} });
  assert.deepEqual(calls[1].input.arguments, {});

  for (const argumentsValue of [
    { branchName: '' },
    { branchName: '   ' },
    { branchName: 42 },
    { branchName: 'x'.repeat(201) },
    { branch: 'attacker-selected' },
    { conversationId: 'other-room' },
    { branchName: 'ok', worktreePath: '/tmp/evil' },
  ]) {
    await assert.rejects(
      bridge.invokeFacade('room_workspace_preview', { principal, arguments: argumentsValue }),
      (error) => error && error.code === 'pi_capability_invalid_arguments'
    );
  }
});

test('room_workspace_bind keeps confirm=true and accepts an optional branchName', async () => {
  const calls = [];
  const bridge = createBridge(calls);
  const principal = createPrincipal();

  for (const argumentsValue of [
    {},
    { confirm: false },
    { confirm: true, branch: 'attacker-selected' },
    { confirm: true, conversationId: 'other-room' },
    { confirm: true, branchName: '' },
  ]) {
    await assert.rejects(
      bridge.invokeFacade('room_workspace_bind', { principal, arguments: argumentsValue }),
      (error) => error && error.code === 'pi_capability_invalid_arguments'
    );
  }

  const bound = await bridge.invokeFacade('room_workspace_bind', {
    principal,
    arguments: { confirm: true, branchName: 'feature/custom-name' },
  });
  assert.equal(bound.branch, 'feature/custom-name');
  assert.deepEqual(calls[0].input.arguments, { confirm: true, branchName: 'feature/custom-name' });
});

test('rename capabilities require branchName and project old and new branch', async () => {
  const calls = [];
  const bridge = createBridge(calls);
  const principal = createPrincipal();

  const preview = await bridge.invokeFacade('room_workspace_rename_preview', {
    principal,
    arguments: { branchName: 'feature/after' },
  });
  assert.equal(preview.branch, 'feature/before');
  assert.equal(preview.newBranch, 'feature/after');
  assert.equal(preview.renamed, false);

  for (const argumentsValue of [
    {},
    { branchName: '' },
    { branchName: 'x'.repeat(201) },
    { branchName: 'feature/after', branch: 'attacker' },
  ]) {
    await assert.rejects(
      bridge.invokeFacade('room_workspace_rename_preview', { principal, arguments: argumentsValue }),
      (error) => error && error.code === 'pi_capability_invalid_arguments'
    );
  }

  for (const argumentsValue of [
    {},
    { confirm: true },
    { branchName: 'feature/after' },
    { confirm: true, branchName: '' },
    { confirm: true, branchName: 'feature/after', conversationId: 'other' },
  ]) {
    await assert.rejects(
      bridge.invokeFacade('room_workspace_rename_bind', { principal, arguments: argumentsValue }),
      (error) => error && error.code === 'pi_capability_invalid_arguments'
    );
  }

  const renamed = await bridge.invokeFacade('room_workspace_rename_bind', {
    principal,
    arguments: { confirm: true, branchName: 'feature/after' },
  });
  assert.equal(renamed.renamed, true);
  assert.equal(renamed.newBranch, 'feature/after');
  assert.equal(renamed.recovered, false);
});

test('rename capability definitions stay optional for older wirings', () => {
  const bridge = createPiCapabilityBridge({
    capabilities: createRoomWorkspaceCapabilityDefinitions({
      preview() { return bindPreview; },
      bind() { return { ...bindPreview, alreadyBound: true }; },
    }),
  });
  return assert.rejects(
    bridge.invokeFacade('room_workspace_rename_preview', {
      principal: createPrincipal(),
      arguments: { branchName: 'feature/after' },
    }),
    (error) => error && error.code === 'pi_capability_unknown_facade'
  );
});
