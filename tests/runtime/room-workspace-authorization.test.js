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

const renamePreview = {
  kind: 'rename',
  conversationId: 'room-1234',
  projectScopeId: 'project-a',
  repositoryPath: 'E:/repo',
  baseBranch: 'develop',
  baseSha: 'a'.repeat(40),
  branch: 'feature/before',
  newBranch: 'feature/after',
  worktreePath: 'E:/worktrees/room/1234-demo',
  alreadyBound: true,
};

test('a bound Room cannot issue a bind card but can issue a rename card', () => {
  const store = new RoomWorkspaceAuthorizationStore({ ttlMs: 30_000 });
  const conversation = { id: 'room-1234', projectScopeId: 'project-a' };
  const boundBindPreview = { ...preview, alreadyBound: true };
  assert.equal(store.issue({ conversation, preview: boundBindPreview, now: 1_000 }), null);

  const card = store.issue({ conversation, preview: renamePreview, invocationId: 'inv-rename', now: 1_001 });
  assert.ok(card);
  const clientCard = store.clientRecord(store.records.get(card.id));
  assert.equal(clientCard.kind, 'rename');
  assert.equal(clientCard.branch, 'feature/before');
  assert.equal(clientCard.newBranch, 'feature/after');
});

test('a newer plan supersedes a still-pending card so the old card can never execute', async () => {
  const store = new RoomWorkspaceAuthorizationStore({ ttlMs: 30_000 });
  const conversation = { id: 'room-1234', projectScopeId: 'project-a' };
  const planA = { ...preview, branch: 'room/1234-plan-a', worktreePath: 'E:/worktrees/room/1234-plan-a' };
  const planB = { ...preview, branch: 'room/1234-plan-b', worktreePath: 'E:/worktrees/room/1234-plan-b' };
  const cardA = store.issue({ conversation, preview: planA, now: 1_000 });
  const clientA = store.clientRecord(store.records.get(cardA.id));
  const cardB = store.issue({ conversation, preview: planB, now: 1_001 });
  assert.ok(cardB);
  assert.notEqual(cardA.id, cardB.id);

  const listed = store.listForClient('room-1234', 1_002);
  assert.equal(listed.find((card) => card.id === cardA.id).status, 'superseded');
  assert.equal(listed.find((card) => card.id === cardB.id).status, 'pending');

  // Approving the superseded card is rejected and executes nothing.
  let executed = false;
  await assert.rejects(
    store.decide({
      id: clientA.id,
      token: clientA.token,
      conversationId: 'room-1234',
      decision: 'accepted',
      fingerprint: clientA.fingerprint,
      execute: () => { executed = true; },
      now: 1_003,
    }),
    (error) => error && error.code === 'room_workspace_authorization_decided'
  );
  assert.equal(executed, false);

  // Re-issuing the identical plan returns the same still-pending card instead of a new one.
  const cardB2 = store.issue({ conversation, preview: planB, now: 1_004 });
  assert.equal(cardB2.id, cardB.id);
});

test('a retryable execution-active failure keeps the card pending and re-decidable', async () => {
  const store = new RoomWorkspaceAuthorizationStore({ ttlMs: 30_000 });
  const conversation = { id: 'room-1234', projectScopeId: 'project-a' };
  const card = store.issue({ conversation, preview: renamePreview, sourceMessageId: 'msg-issuer', now: 1_000 });
  const clientCard = store.clientRecord(store.records.get(card.id));
  assert.equal(clientCard.sourceMessageId, 'msg-issuer');

  const activeError = Object.assign(new Error('Room has an active execution'), { code: 'room_workspace_execution_active' });
  let calls = 0;
  await assert.rejects(
    store.decide({
      id: clientCard.id,
      token: clientCard.token,
      conversationId: 'room-1234',
      decision: 'accepted',
      fingerprint: clientCard.fingerprint,
      execute: () => {
        calls += 1;
        throw activeError;
      },
      now: 1_001,
    }),
    (error) => error && error.code === 'room_workspace_execution_active'
      && error.authorizationRecord && error.authorizationRecord.id === card.id
  );
  // The transient failure did not burn the card: it is pending and never decided.
  assert.equal(store.records.get(card.id).status, 'pending');
  assert.equal(store.records.get(card.id).decidedAt, null);

  // Retrying the same card once the Room is idle succeeds.
  const result = await store.decide({
    id: clientCard.id,
    token: clientCard.token,
    conversationId: 'room-1234',
    decision: 'accepted',
    fingerprint: clientCard.fingerprint,
    execute: (authorizedPreview, record) => {
      calls += 1;
      assert.equal(authorizedPreview.newBranch, 'feature/after');
      return { issuedBy: record.sourceMessageId };
    },
    now: 1_002,
  });
  assert.equal(result.record.status, 'accepted');
  // A successful retry clears the transient blocker from the record so an
  // accepted card never carries a stale errorCode.
  assert.equal(result.record.errorCode, null);
  assert.equal(calls, 2);
  assert.equal(result.result.issuedBy, 'msg-issuer');
});

test('a non-retryable execution failure burns the card and the decided error carries the cause', async () => {
  const store = new RoomWorkspaceAuthorizationStore({ ttlMs: 30_000 });
  const conversation = { id: 'room-1234', projectScopeId: 'project-a' };
  const card = store.issue({ conversation, preview: renamePreview, now: 1_000 });
  const clientCard = store.clientRecord(store.records.get(card.id));

  const boom = Object.assign(new Error('Remote state unknown'), { code: 'room_workspace_remote_state_unknown' });
  await assert.rejects(
    store.decide({
      id: clientCard.id,
      token: clientCard.token,
      conversationId: 'room-1234',
      decision: 'accepted',
      fingerprint: clientCard.fingerprint,
      execute: () => { throw boom; },
      now: 1_001,
    }),
    (error) => error && error.code === 'room_workspace_remote_state_unknown'
      && error.authorizationRecord && error.authorizationRecord.status === 'failed'
  );
  assert.equal(store.records.get(card.id).status, 'failed');
  assert.equal(store.records.get(card.id).errorCode, 'room_workspace_remote_state_unknown');

  // Retrying the burned card reports the original cause and the remediation.
  await assert.rejects(
    store.decide({
      id: clientCard.id,
      token: clientCard.token,
      conversationId: 'room-1234',
      decision: 'accepted',
      fingerprint: clientCard.fingerprint,
      execute: () => { throw new Error('must not run'); },
      now: 1_002,
    }),
    (error) => error && error.code === 'room_workspace_authorization_decided'
      && /room_workspace_remote_state_unknown/u.test(error.message)
      && /Agent/u.test(error.message)
  );
});

test('the authorization fingerprint binds the operation kind and target branch name', async () => {
  const store = new RoomWorkspaceAuthorizationStore({ ttlMs: 30_000 });
  const conversation = { id: 'room-1234', projectScopeId: 'project-a' };
  assert.notEqual(previewFingerprint(preview), previewFingerprint(renamePreview));
  assert.notEqual(
    previewFingerprint(renamePreview),
    previewFingerprint({ ...renamePreview, newBranch: 'feature/different' })
  );

  const card = store.issue({ conversation, preview: renamePreview, now: 1_000 });
  const clientCard = store.clientRecord(store.records.get(card.id));
  // A fingerprint from a different plan does not match this card.
  const foreignFingerprint = previewFingerprint({ ...renamePreview, newBranch: 'feature/different' });
  let executed = false;
  await assert.rejects(
    store.decide({
      id: clientCard.id,
      token: clientCard.token,
      conversationId: 'room-1234',
      decision: 'accepted',
      fingerprint: foreignFingerprint,
      execute: () => { executed = true; },
      now: 1_001,
    }),
    (error) => error && error.code === 'room_workspace_authorization_stale'
  );
  assert.equal(executed, false);
  assert.equal(store.records.get(card.id).status, 'pending');
});
