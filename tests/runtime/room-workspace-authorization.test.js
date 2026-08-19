const test = require('node:test');
const assert = require('node:assert/strict');

const { RoomWorkspaceAuthorizationStore, previewFingerprint } = require('../../build/server/domain/conversation/room-workspace-authorization');

const preview = {
  conversationId: 'room-1234',
  projectScopeId: 'project-a',
  repositoryPath: 'E:/repo',
  baseBranch: 'develop',
  baseSha: 'a'.repeat(40),
  branch: 'room/1234-demo',
  worktreePath: 'E:/worktrees/room/1234-demo',
  alreadyBound: false,
};

function issueClientCard(store, now = 1_000) {
  const card = store.issue({
    conversation: { id: 'room-1234', projectScopeId: 'project-a' },
    preview,
    now,
  });
  return store.clientRecord(store.records.get(card.id));
}

test('workspace authorization is idempotent per Room and preview fingerprint', () => {
  const store = new RoomWorkspaceAuthorizationStore({ ttlMs: 30_000 });
  const first = store.issue({ conversation: { id: 'room-1234', projectScopeId: 'project-a' }, preview, invocationId: 'inv-a', now: 1_000 });
  const second = store.issue({ conversation: { id: 'room-1234', projectScopeId: 'project-a' }, preview, invocationId: 'inv-b', now: 1_001 });
  const clientCard = store.clientRecord(store.records.get(first.id));
  assert.equal(first.id, second.id);
  assert.equal(first.fingerprint, previewFingerprint(preview));
  assert.ok(clientCard.token);
  assert.equal(first.token, undefined);
  const restored = store.listForClient('room-1234', 1_002);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].token, clientCard.token);
});

test('workspace authorization requires matching one-time token and fingerprint', async () => {
  const store = new RoomWorkspaceAuthorizationStore({ ttlMs: 30_000 });
  const card = issueClientCard(store);
  await assert.rejects(
    store.decide({
      id: card.id,
      token: card.token,
      conversationId: 'room-1234',
      decision: 'accepted',
      fingerprint: 'stale',
      execute: () => ({ ok: true }),
      now: 1_001,
    }),
    (error) => error && error.code === 'room_workspace_authorization_stale'
  );
  const result = await store.decide({
    id: card.id,
    token: card.token,
    conversationId: 'room-1234',
    decision: 'accepted',
    fingerprint: card.fingerprint,
    execute: () => ({ ok: true }),
    now: 1_002,
  });
  assert.equal(result.record.status, 'accepted');
  assert.deepEqual(result.result, { ok: true });
  await assert.rejects(
    store.decide({
      id: card.id,
      token: card.token,
      conversationId: 'room-1234',
      decision: 'accepted',
      fingerprint: card.fingerprint,
      execute: () => ({ ok: true }),
      now: 1_003,
    }),
    (error) => error && error.code === 'room_workspace_authorization_decided'
  );
});

test('expired workspace authorization returns 410 before terminal-state replay handling', async () => {
  const store = new RoomWorkspaceAuthorizationStore({ ttlMs: 30_000 });
  const card = issueClientCard(store);
  await assert.rejects(
    store.decide({
      id: card.id,
      token: card.token,
      conversationId: 'room-1234',
      decision: 'accepted',
      fingerprint: card.fingerprint,
      execute: () => ({ ok: true }),
      now: 31_001,
    }),
    (error) => error && error.statusCode === 410 && error.code === 'room_workspace_authorization_expired'
  );
  const restored = store.listForClient('room-1234', 31_002);
  assert.equal(restored[0].status, 'expired');
  assert.equal(restored[0].token, undefined);
});

test('workspace authorization rejects without executing Git mutation', async () => {
  const store = new RoomWorkspaceAuthorizationStore({ ttlMs: 30_000 });
  const card = issueClientCard(store);
  let executed = false;
  const result = await store.decide({
    id: card.id,
    token: card.token,
    conversationId: 'room-1234',
    decision: 'rejected',
    fingerprint: card.fingerprint,
    execute: () => { executed = true; },
    now: 1_002,
  });
  assert.equal(result.record.status, 'rejected');
  assert.equal(executed, false);
});
