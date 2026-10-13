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
