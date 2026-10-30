const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { withTempDir } = require('../helpers/temp-dir');

function createBoundRoom(store, id = 'rename-room') {
  const room = store.createConversation({
    id,
    title: 'Rename Room',
    type: 'standard',
    projectScopeId: 'project-1',
    participants: ['role-family-gpt'],
  });
  store.bindConversationWorkspace(room.id, {
    branch: 'feature/before',
    worktreePath: 'E:/worktrees/room/rename-room',
    workspaceBaseSha: 'a'.repeat(40),
    workspaceBoundAt: new Date().toISOString(),
  });
  return store.getConversationWithoutMessages(room.id);
}

test('workspace branch rename uses a conditional update and keeps the rest of the binding', () => {
  const tempDir = withTempDir('caff-workspace-rename-store-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'rename.sqlite') });
  try {
    const bound = createBoundRoom(store);

    const renamed = store.renameConversationWorkspaceBranch(bound.id, {
      oldBranch: 'feature/before',
      newBranch: 'feature/after',
    });
    assert.equal(renamed.branch, 'feature/after');
    assert.equal(renamed.worktreePath, bound.worktreePath);
    assert.equal(renamed.workspaceBaseSha, bound.workspaceBaseSha);

    // A stale writer holding the previous branch name loses the compare-and-swap.
    assert.throws(
      () => store.renameConversationWorkspaceBranch(bound.id, {
        oldBranch: 'feature/before',
        newBranch: 'feature/stale-writer',
      }),
      (error) => error && error.code === 'room_workspace_binding_conflict'
    );
    assert.equal(store.getConversationWithoutMessages(bound.id).branch, 'feature/after');

    assert.throws(
      () => store.renameConversationWorkspaceBranch('missing-room', {
        oldBranch: 'feature/before',
        newBranch: 'feature/after',
      }),
      (error) => error && error.code === 'conversation_not_found'
    );
  } finally {
    if (typeof store.close === 'function') store.close();
  }
});

test('active execution detection follows non-terminal assistant messages', () => {
  const tempDir = withTempDir('caff-workspace-active-turn-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'active.sqlite') });
  try {
    const bound = createBoundRoom(store, 'active-turn-room');
    assert.equal(store.hasActiveConversationTurn(bound.id), false);
    assert.equal(store.hasActiveConversationTurn(''), false);

    store.createMessage({
      conversationId: bound.id,
      role: 'assistant',
      content: 'done already',
      status: 'completed',
    });
    assert.equal(store.hasActiveConversationTurn(bound.id), false);

    const running = store.createMessage({
      conversationId: bound.id,
      role: 'assistant',
      content: 'still working',
      status: 'streaming',
    });
    assert.equal(store.hasActiveConversationTurn(bound.id), true);

    store.createMessage({
      conversationId: bound.id,
      role: 'user',
      content: 'a user message never blocks',
      status: 'queued',
    });
    const failed = store.createMessage({
      conversationId: bound.id,
      role: 'assistant',
      content: 'terminal failure',
      status: 'failed',
    });
    assert.ok(failed);
    assert.equal(store.hasActiveConversationTurn(bound.id), true);

    // Once the running message reaches a terminal state the room is idle again.
    store.updateMessage(running.id, { status: 'completed' });
    assert.equal(store.hasActiveConversationTurn(bound.id), false);
  } finally {
    if (typeof store.close === 'function') store.close();
  }
});

test('active execution detection excludes only the caller\'s own message, never the whole turn', () => {
  const tempDir = withTempDir('caff-workspace-active-exclude-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'exclude.sqlite') });
  try {
    const bound = createBoundRoom(store, 'exclude-turn-room');
    const caller = store.createMessage({
      conversationId: bound.id,
      turnId: 'turn-shared',
      role: 'assistant',
      content: 'caller is working',
      status: 'streaming',
    });
    assert.equal(store.hasActiveConversationTurn(bound.id), true);
    assert.equal(store.hasActiveConversationTurn(bound.id, { excludeMessageId: caller.id }), false);

    // A second agent streaming in the SAME turn must still block the caller.
    const other = store.createMessage({
      conversationId: bound.id,
      turnId: 'turn-shared',
      role: 'assistant',
      content: 'another agent in the same turn is working',
      status: 'running',
    });
    assert.equal(store.hasActiveConversationTurn(bound.id, { excludeMessageId: caller.id }), true);
    assert.equal(store.hasActiveConversationTurn(bound.id, { excludeMessageId: other.id }), true);

    store.updateMessage(other.id, { status: 'completed' });
    assert.equal(store.hasActiveConversationTurn(bound.id, { excludeMessageId: caller.id }), false);
  } finally {
    if (typeof store.close === 'function') store.close();
  }
});

test('workspace operation records persist the authorized rename intent', () => {
  const tempDir = withTempDir('caff-workspace-operations-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'ops.sqlite') });
  try {
    const bound = createBoundRoom(store, 'operation-room');
    assert.equal(store.getPendingWorkspaceOperation(bound.id), null);

    const created = store.createWorkspaceOperation({
      conversationId: bound.id,
      kind: 'rename',
      oldBranch: 'feature/before',
      newBranch: 'feature/after',
      fingerprint: 'f'.repeat(64),
    });
    assert.equal(created.status, 'pending');
    assert.equal(created.oldBranch, 'feature/before');
    assert.equal(created.newBranch, 'feature/after');
    assert.equal(created.fingerprint, 'f'.repeat(64));
    assert.equal(store.getPendingWorkspaceOperation(bound.id).id, created.id);

    store.completeWorkspaceOperation(created.id);
    assert.equal(store.getPendingWorkspaceOperation(bound.id), null);
    assert.equal(store.getWorkspaceOperation(created.id).status, 'completed');

    const second = store.createWorkspaceOperation({
      conversationId: bound.id,
      kind: 'rename',
      oldBranch: 'feature/after',
      newBranch: 'feature/third',
    });
    assert.equal(second.fingerprint, null);
    store.failWorkspaceOperation(second.id, 'room_workspace_test_failure');
    assert.equal(store.getPendingWorkspaceOperation(bound.id), null);
    assert.equal(store.getWorkspaceOperation(second.id).errorCode, 'room_workspace_test_failure');
  } finally {
    if (typeof store.close === 'function') store.close();
  }
});

test('branch rename and operation close-out commit atomically', () => {
  const tempDir = withTempDir('caff-workspace-rename-atomic-');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath: path.join(tempDir, 'atomic.sqlite') });
  try {
    const bound = createBoundRoom(store, 'atomic-room');
    const operation = store.createWorkspaceOperation({
      conversationId: bound.id,
      kind: 'rename',
      oldBranch: 'feature/before',
      newBranch: 'feature/after',
    });

    // Success: the binding moves and the journal closes in the same commit.
    const renamed = store.renameConversationWorkspaceBranchAndCompleteOperation(bound.id, {
      oldBranch: 'feature/before',
      newBranch: 'feature/after',
    }, operation.id);
    assert.equal(renamed.branch, 'feature/after');
    assert.equal(store.getWorkspaceOperation(operation.id).status, 'completed');
    assert.equal(store.getPendingWorkspaceOperation(bound.id), null);

    // A lost CAS fails the WHOLE transaction: the binding stays and a pending
    // journal row survives as the recovery handle instead of being half-closed.
    const second = store.createWorkspaceOperation({
      conversationId: bound.id,
      kind: 'rename',
      oldBranch: 'feature/after',
      newBranch: 'feature/third',
    });
    assert.throws(
      () => store.renameConversationWorkspaceBranchAndCompleteOperation(bound.id, {
        oldBranch: 'feature/stale-writer',
        newBranch: 'feature/third',
      }, second.id),
      (error) => error && error.code === 'room_workspace_binding_conflict'
    );
    assert.equal(store.getConversationWithoutMessages(bound.id).branch, 'feature/after');
    assert.equal(store.getWorkspaceOperation(second.id).status, 'pending');

    // An unknown or foreign operation id also fails the whole transaction.
    const third = store.createWorkspaceOperation({
      conversationId: bound.id,
      kind: 'rename',
      oldBranch: 'feature/after',
      newBranch: 'feature/fourth',
    });
    assert.throws(
      () => store.renameConversationWorkspaceBranchAndCompleteOperation(bound.id, {
        oldBranch: 'feature/after',
        newBranch: 'feature/fourth',
      }, 'missing-operation-id'),
      (error) => error && error.code === 'room_workspace_operation_conflict'
    );
    assert.equal(store.getConversationWithoutMessages(bound.id).branch, 'feature/after');
    assert.equal(store.getWorkspaceOperation(third.id).status, 'pending');

    // The failed record stays pending, so a replacement supersedes it atomically.
    const replacement = store.replacePendingWorkspaceOperation({
      conversationId: bound.id,
      kind: 'rename',
      oldBranch: 'feature/after',
      newBranch: 'feature/fourth',
    });
    assert.equal(store.getWorkspaceOperation(second.id).status, 'failed');
    assert.equal(store.getWorkspaceOperation(second.id).errorCode, 'superseded_by_consistent_state');
    assert.equal(store.getWorkspaceOperation(third.id).status, 'failed');
    assert.equal(store.getPendingWorkspaceOperation(bound.id).id, replacement.id);
  } finally {
    if (typeof store.close === 'function') store.close();
  }
});
