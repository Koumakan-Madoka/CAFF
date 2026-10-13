const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { createAgentToolBridge } = require('../../build/server/domain/runtime/agent-tool-bridge');
const { previewFingerprint } = require('../../build/server/domain/conversation/room-workspace-authorization');
const { createChatAppStore } = require('../../build/lib/chat-app-store');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Exclusive outer directory per test: repo at <outer>/repo, worktrees at <outer>/worktrees.
function initRepo() {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-room-workspace-bridge-'));
  const root = path.join(outer, 'repo');
  fs.mkdirSync(root);
  git(root, ['init']);
  git(root, ['config', 'user.name', 'CAFF Test']);
  git(root, ['config', 'user.email', 'caff-test@example.invalid']);
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'base']);
  git(root, ['branch', 'develop']);
  return { outer, root };
}

function createHarness(t, suffix) {
  const { outer, root: repoRoot } = initRepo();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), `caff-bridge-store-${suffix}-`));
  const store = createChatAppStore({ agentDir, sqlitePath: path.join(agentDir, 'bridge.sqlite') });
  const broadcastEvents = [];
  const bridge = createAgentToolBridge({
    store,
    broadcastEvent(eventName, payload) {
      broadcastEvents.push({ eventName, payload });
    },
    resolveProject(projectScopeId) {
      return projectScopeId === 'project-1' ? { id: 'project-1', path: repoRoot } : null;
    },
  });
  const agent = store.saveCustomRoleConfig({
    id: `bridge-ws-agent-${suffix}`,
    name: `Bridge Workspace Agent ${suffix}`,
    personaPrompt: 'Reply briefly.',
  });
  const conversation = store.createConversation({
    id: `bridge-ws-conversation-${suffix}`,
    title: `Bridge Workspace ${suffix}`,
    type: 'standard',
    projectScopeId: 'project-1',
    participants: [agent.id],
  });
  const turnId = `bridge-ws-turn-${suffix}`;
  const assistantMessage = store.createMessage({
    id: `bridge-ws-message-${suffix}`,
    conversationId: conversation.id,
    turnId,
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: 'Thinking...',
    status: 'streaming',
  });
  const context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: conversation.id,
      turnId,
      agentId: agent.id,
      agentName: agent.name,
      assistantMessageId: assistantMessage.id,
      conversationAgents: [agent],
      stage: { status: 'running', taskId: '' },
      turnState: { conversationId: conversation.id, turnId, stopRequested: false },
    })
  );

  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(outer, { recursive: true, force: true });
  });

  async function invoke(facade, args) {
    return bridge.handlePiCapability(facade, {
      invocationId: context.invocationId,
      callbackToken: context.callbackToken,
      arguments: args,
    });
  }

  function pendingCard() {
    const cards = bridge.listRoomWorkspaceAuthorizations(conversation.id);
    return cards.find((card) => card.status === 'pending') || null;
  }

  function decide(card, decision = 'accepted', fingerprintOverride = null) {
    return bridge.handleRoomWorkspaceAuthorization({
      conversationId: conversation.id,
      authorizationId: card.id,
      token: card.token,
      decision,
      fingerprint: fingerprintOverride || card.fingerprint,
    });
  }

  function boundConversation() {
    return store.getConversationWithoutMessages(conversation.id);
  }

  return {
    store,
    bridge,
    conversation,
    assistantMessage,
    context,
    broadcastEvents,
    repoRoot,
    invoke,
    pendingCard,
    decide,
    boundConversation,
  };
}

test('custom branchName authorization card replays the exact approved plan through the bridge', async (t) => {
  const harness = createHarness(t, 'custom-card');
  const preview = await harness.invoke('room_workspace_preview', { branchName: 'feature/bridge-custom' });
  assert.equal(preview.branch, 'feature/bridge-custom');
  const key = harness.conversation.id.replace(/[^a-z0-9]/giu, '').toLowerCase().slice(0, 8);
  assert.equal(path.basename(preview.worktreePath), key);

  const card = harness.pendingCard();
  assert.ok(card, 'preview must issue an authorization card');
  assert.equal(card.branch, 'feature/bridge-custom');

  const decision = await harness.decide(card);
  assert.equal(decision.record.status, 'accepted');
  const bound = harness.boundConversation();
  assert.equal(bound.branch, 'feature/bridge-custom');
  assert.equal(path.basename(bound.worktreePath), key);
  assert.equal(git(bound.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/bridge-custom');
  assert.equal(git(bound.worktreePath, ['rev-parse', 'HEAD']), bound.workspaceBaseSha);
});

test('default authorization card keeps the automatic naming through the bridge', async (t) => {
  const harness = createHarness(t, 'default-card');
  const preview = await harness.invoke('room_workspace_preview', {});
  const key = harness.conversation.id.replace(/[^a-z0-9]/giu, '').toLowerCase().slice(0, 8);
  assert.equal(preview.branch, `room/${key}-bridge-workspace-default-card`);

  const card = harness.pendingCard();
  const decision = await harness.decide(card);
  assert.equal(decision.record.status, 'accepted');
  const bound = harness.boundConversation();
  assert.equal(bound.branch, preview.branch);
  assert.equal(git(bound.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), preview.branch);
});

test('rename approval excludes the card-issuing message and executes during the issuing turn', async (t) => {
  const harness = createHarness(t, 'approve-own-turn');
  await harness.invoke('room_workspace_preview', {});
  await harness.decide(harness.pendingCard());
  const bound = harness.boundConversation();
  assert.ok(bound.branch);

  // The caller's own streaming message must not block the read-only rename preview.
  const renamePreview = await harness.invoke('room_workspace_rename_preview', { branchName: 'feature/approved-mid-turn' });
  assert.equal(renamePreview.branch, bound.branch);
  assert.equal(renamePreview.newBranch, 'feature/approved-mid-turn');
  const card = harness.pendingCard();
  assert.ok(card, 'rename preview must issue a card even during an active turn');
  assert.equal(card.kind, 'rename');
  // The card remembers which assistant message issued it.
  assert.equal(card.sourceMessageId, harness.assistantMessage.id);

  // ...and it must not block the user's approval either: the idle check at
  // execution time excludes only the card-issuing message, so the approved
  // rename executes even while the issuing turn is still streaming.
  const decision = await harness.decide(card);
  assert.equal(decision.record.status, 'accepted');
  assert.equal(harness.boundConversation().branch, 'feature/approved-mid-turn');
  assert.equal(git(bound.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/approved-mid-turn');
  assert.equal(git(bound.worktreePath, ['rev-parse', 'HEAD']), bound.workspaceBaseSha);
  assert.equal(path.basename(harness.boundConversation().worktreePath), path.basename(bound.worktreePath));
});

test('a peer execution blocks rename approval but the card stays pending and retries once idle', async (t) => {
  const harness = createHarness(t, 'approve-peer-block');
  await harness.invoke('room_workspace_preview', {});
  await harness.decide(harness.pendingCard());
  const bound = harness.boundConversation();

  const renamePreview = await harness.invoke('room_workspace_rename_preview', { branchName: 'feature/peer-waits' });
  assert.equal(renamePreview.newBranch, 'feature/peer-waits');
  const card = harness.pendingCard();
  assert.ok(card);

  // Another agent's active message must block the approval.
  const otherAgent = harness.store.saveCustomRoleConfig({
    id: 'bridge-ws-agent-approve-peer-block-b',
    name: 'Bridge Workspace Agent approve-peer-block B',
    personaPrompt: 'Reply briefly.',
  });
  const otherMessage = harness.store.createMessage({
    conversationId: harness.conversation.id,
    turnId: 'bridge-ws-turn-approve-peer-block-other',
    role: 'assistant',
    agentId: otherAgent.id,
    senderName: otherAgent.name,
    content: 'Also working...',
    status: 'streaming',
  });
  await assert.rejects(
    harness.decide(card),
    (error) => error && error.code === 'room_workspace_execution_active'
  );

  // Zero side effects, and the blocked card is NOT burned: a transient
  // execution-active failure keeps it pending so the user can retry.
  assert.equal(harness.boundConversation().branch, bound.branch);
  assert.equal(git(bound.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), bound.branch);
  assert.equal(harness.store.getPendingWorkspaceOperation(harness.conversation.id), null);
  const refreshed = harness.bridge
    .listRoomWorkspaceAuthorizations(harness.conversation.id)
    .find((item) => item.id === card.id);
  assert.equal(refreshed.status, 'pending');
  assert.equal(refreshed.decidedAt, null);

  // The failed decision outcome is broadcast so the UI cannot linger on a
  // stale card state.
  assert.ok(harness.broadcastEvents.some((event) =>
    event.eventName === 'room_workspace_authorization_updated'
    && event.payload.authorization
    && event.payload.authorization.id === card.id));

  // Once the peer finishes, approving the SAME card succeeds.
  harness.store.updateMessage(otherMessage.id, { status: 'completed' });
  const decision = await harness.decide(card);
  assert.equal(decision.record.status, 'accepted');
  assert.equal(harness.boundConversation().branch, 'feature/peer-waits');
  assert.equal(git(bound.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/peer-waits');
});

test('rename_bind fallback excludes the caller\'s own turn but executes the rename', async (t) => {
  const harness = createHarness(t, 'rename-fallback');
  await harness.invoke('room_workspace_preview', {});
  await harness.decide(harness.pendingCard());
  const bound = harness.boundConversation();

  // The fixture's streaming message belongs to the calling invocation's turn; the
  // non-UI fallback must not be blocked by it.
  const renamed = await harness.invoke('room_workspace_rename_bind', {
    confirm: true,
    branchName: 'feature/fallback-renamed',
  });
  assert.equal(renamed.renamed, true);
  assert.equal(renamed.newBranch, 'feature/fallback-renamed');
  assert.equal(harness.boundConversation().branch, 'feature/fallback-renamed');
  assert.equal(git(bound.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/fallback-renamed');
});

test('an interrupted rename resumes through the public preview-and-approve entry', async (t) => {
  const harness = createHarness(t, 'resume-public');
  await harness.invoke('room_workspace_preview', {});
  await harness.decide(harness.pendingCard());
  const bound = harness.boundConversation();
  const oldBranch = bound.branch;

  // Authorize a rename, then simulate a crash after the write-ahead record and the
  // git rename but before the DB update.
  const renamePreview = await harness.invoke('room_workspace_rename_preview', { branchName: 'feature/resumed' });
  const card = harness.pendingCard();
  assert.equal(card.kind, 'rename');
  harness.store.createWorkspaceOperation({
    conversationId: harness.conversation.id,
    kind: 'rename',
    oldBranch,
    newBranch: 'feature/resumed',
    fingerprint: card.fingerprint,
  });
  git(bound.worktreePath, ['branch', '-m', oldBranch, 'feature/resumed']);

  // A mismatched fingerprint is rejected before any DB write.
  const pendingBefore = harness.store.getPendingWorkspaceOperation(harness.conversation.id);
  await assert.rejects(
    harness.decide(card, 'accepted', 'definitely-stale'),
    (error) => error && error.code === 'room_workspace_authorization_stale'
  );
  assert.equal(harness.boundConversation().branch, oldBranch);
  assert.equal(harness.store.getPendingWorkspaceOperation(harness.conversation.id).id, pendingBefore.id);

  // Public entry after the "restart": the read-only preview exposes the resumable
  // plan. The plan is identical, so the same still-pending card is returned
  // (idempotent issuance) and can be approved directly.
  const resumePreview = await harness.invoke('room_workspace_rename_preview', { branchName: 'feature/resumed' });
  assert.equal(resumePreview.resume, true);
  assert.equal(resumePreview.branch, oldBranch);
  assert.equal(resumePreview.newBranch, 'feature/resumed');
  const resumeCard = harness.pendingCard();
  assert.ok(resumeCard);
  assert.equal(resumeCard.id, card.id);
  assert.equal(resumeCard.fingerprint, card.fingerprint);

  // Simulate the post-restart idle Room: the interrupted turn's message is terminal.
  harness.store.updateMessage(harness.assistantMessage.id, { status: 'completed' });
  const decision = await harness.decide(resumeCard);
  assert.equal(decision.record.status, 'accepted');
  assert.equal(harness.boundConversation().branch, 'feature/resumed');
  assert.equal(git(bound.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/resumed');
  assert.equal(harness.store.getPendingWorkspaceOperation(harness.conversation.id), null);
});

test('rename_bind fallback is still blocked by another agent active in the SAME turn', async (t) => {
  const harness = createHarness(t, 'same-turn-guard');
  await harness.invoke('room_workspace_preview', {});
  await harness.decide(harness.pendingCard());
  const bound = harness.boundConversation();

  // A second agent streaming in the caller's own turn must still block the rename:
  // the fallback excludes only the caller's own assistant message, never the turn.
  const otherAgent = harness.store.saveCustomRoleConfig({
    id: 'bridge-ws-agent-same-turn-guard-b',
    name: 'Bridge Workspace Agent same-turn-guard B',
    personaPrompt: 'Reply briefly.',
  });
  const otherMessage = harness.store.createMessage({
    conversationId: harness.conversation.id,
    turnId: harness.assistantMessage.turnId,
    role: 'assistant',
    agentId: otherAgent.id,
    senderName: otherAgent.name,
    content: 'Also working...',
    status: 'streaming',
  });
  await assert.rejects(
    harness.invoke('room_workspace_rename_bind', { confirm: true, branchName: 'feature/blocked-by-peer' }),
    (error) => error && error.code === 'room_workspace_execution_active'
  );
  assert.equal(harness.boundConversation().branch, bound.branch);
  assert.equal(git(bound.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), bound.branch);
  assert.equal(harness.store.getPendingWorkspaceOperation(harness.conversation.id), null);

  // Once the peer finishes, the same fallback call succeeds with the caller's own
  // message still excluded.
  harness.store.updateMessage(otherMessage.id, { status: 'completed' });
  const renamed = await harness.invoke('room_workspace_rename_bind', {
    confirm: true,
    branchName: 'feature/blocked-by-peer',
  });
  assert.equal(renamed.newBranch, 'feature/blocked-by-peer');
  assert.equal(harness.boundConversation().branch, 'feature/blocked-by-peer');
});

test('a fallback-originated interrupted rename recovers after a REAL store restart and bridge rebuild', async (t) => {
  const { outer, root: repoRoot } = initRepo();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-bridge-store-restart-'));
  const sqlitePath = path.join(agentDir, 'bridge.sqlite');
  const broadcastEvents = [];
  const resolveProject = (projectScopeId) => (projectScopeId === 'project-1' ? { id: 'project-1', path: repoRoot } : null);
  t.after(() => {
    // Close whichever store generation is still open BEFORE removing the sqlite dir.
    try { store.close(); } catch {}
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(outer, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // --- Before the "crash": bind, then simulate a fallback rename interrupted
  // after the write-ahead record and the git rename, before the DB commit.
  let store = createChatAppStore({ agentDir, sqlitePath });
  let bridge = createAgentToolBridge({
    store,
    broadcastEvent(eventName, payload) { broadcastEvents.push({ eventName, payload }); },
    resolveProject,
  });
  const agent = store.saveCustomRoleConfig({
    id: 'bridge-ws-agent-restart',
    name: 'Bridge Workspace Agent restart',
    personaPrompt: 'Reply briefly.',
  });
  const conversation = store.createConversation({
    id: 'bridge-ws-conversation-restart',
    title: 'Bridge Workspace restart',
    type: 'standard',
    projectScopeId: 'project-1',
    participants: [agent.id],
  });
  const crashedMessage = store.createMessage({
    conversationId: conversation.id,
    turnId: 'bridge-ws-turn-restart-1',
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: 'Thinking...',
    status: 'streaming',
  });
  let context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: conversation.id,
      turnId: 'bridge-ws-turn-restart-1',
      agentId: agent.id,
      agentName: agent.name,
      assistantMessageId: crashedMessage.id,
      conversationAgents: [agent],
      stage: { status: 'running', taskId: '' },
      turnState: { conversationId: conversation.id, turnId: 'bridge-ws-turn-restart-1', stopRequested: false },
    })
  );
  await bridge.handlePiCapability('room_workspace_preview', {
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    arguments: {},
  });
  const bindCard = bridge.listRoomWorkspaceAuthorizations(conversation.id).find((card) => card.status === 'pending');
  await bridge.handleRoomWorkspaceAuthorization({
    conversationId: conversation.id,
    authorizationId: bindCard.id,
    token: bindCard.token,
    decision: 'accepted',
    fingerprint: bindCard.fingerprint,
  });
  const bound = store.getConversationWithoutMessages(conversation.id);
  const oldBranch = bound.branch;

  // Fallback-originated journal: NO card fingerprint was ever recorded.
  store.createWorkspaceOperation({
    conversationId: conversation.id,
    kind: 'rename',
    oldBranch,
    newBranch: 'feature/restarted-resume',
    fingerprint: null,
  });
  git(bound.worktreePath, ['branch', '-m', oldBranch, 'feature/restarted-resume']);
  store.close();

  // --- After the "restart": reopen the SAME SQLite file and rebuild the bridge
  // (fresh in-memory authorization store, so no card from before can be replayed).
  store = createChatAppStore({ agentDir, sqlitePath });
  bridge = createAgentToolBridge({
    store,
    broadcastEvent(eventName, payload) { broadcastEvents.push({ eventName, payload }); },
    resolveProject,
  });
  // Crash recovery finalized the interrupted turn's message.
  store.updateMessage(crashedMessage.id, { status: 'failed' });

  const pending = store.getPendingWorkspaceOperation(conversation.id);
  assert.ok(pending, 'the write-ahead record must survive the restart');
  assert.equal(pending.fingerprint, null);
  assert.equal(store.getConversationWithoutMessages(conversation.id).branch, oldBranch);

  const resumedMessage = store.createMessage({
    conversationId: conversation.id,
    turnId: 'bridge-ws-turn-restart-2',
    role: 'assistant',
    agentId: agent.id,
    senderName: agent.name,
    content: 'Resuming...',
    status: 'streaming',
  });
  context = bridge.registerInvocation(
    bridge.createInvocationContext({
      conversationId: conversation.id,
      turnId: 'bridge-ws-turn-restart-2',
      agentId: agent.id,
      agentName: agent.name,
      assistantMessageId: resumedMessage.id,
      conversationAgents: [agent],
      stage: { status: 'running', taskId: '' },
      turnState: { conversationId: conversation.id, turnId: 'bridge-ws-turn-restart-2', stopRequested: false },
    })
  );

  // The public read-only preview exposes the recorded resumable plan and issues a
  // FRESH authorization card for it (the in-memory store was empty after restart).
  const resumePreview = await bridge.handlePiCapability('room_workspace_rename_preview', {
    invocationId: context.invocationId,
    callbackToken: context.callbackToken,
    arguments: { branchName: 'feature/restarted-resume' },
  });
  assert.equal(resumePreview.resume, true);
  assert.equal(resumePreview.branch, oldBranch);
  assert.equal(resumePreview.newBranch, 'feature/restarted-resume');
  const resumeCard = bridge.listRoomWorkspaceAuthorizations(conversation.id).find((card) => card.status === 'pending');
  assert.ok(resumeCard, 'the resume preview must issue a fresh, executable card');

  // The user approves after the Room is idle again.
  store.updateMessage(resumedMessage.id, { status: 'completed' });
  const decision = await bridge.handleRoomWorkspaceAuthorization({
    conversationId: conversation.id,
    authorizationId: resumeCard.id,
    token: resumeCard.token,
    decision: 'accepted',
    fingerprint: resumeCard.fingerprint,
  });
  assert.equal(decision.record.status, 'accepted');
  assert.equal(store.getConversationWithoutMessages(conversation.id).branch, 'feature/restarted-resume');
  assert.equal(git(bound.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature/restarted-resume');
  assert.equal(store.getPendingWorkspaceOperation(conversation.id), null);
  assert.equal(store.getWorkspaceOperation(pending.id).status, 'completed');
});

test('a newer plan supersedes the pending card and the old card executes nothing', async (t) => {
  const harness = createHarness(t, 'supersede');
  await harness.invoke('room_workspace_preview', { branchName: 'feature/plan-a' });
  const cardA = harness.pendingCard();
  await harness.invoke('room_workspace_preview', { branchName: 'feature/plan-b' });
  const cardB = harness.pendingCard();
  assert.notEqual(cardA.id, cardB.id);

  await assert.rejects(
    harness.decide(cardA),
    (error) => error && error.code === 'room_workspace_authorization_decided'
  );
  assert.equal(harness.boundConversation().branch, null);
  const branches = git(harness.repoRoot, ['branch', '--format=%(refname:short)']).split(/\r?\n/u);
  assert.ok(!branches.includes('feature/plan-a'));

  const decision = await harness.decide(cardB);
  assert.equal(decision.record.status, 'accepted');
  assert.equal(harness.boundConversation().branch, 'feature/plan-b');
});

test('a reflog expansion expression like @{-1} is rejected through the public bridge with zero side effects', async (t) => {
  const harness = createHarness(t, 'reflog-literal');
  // Reproduce the exact scenario: create a checkout history, then delete the
  // branch, so @{-1} would expand to it if the validator ever interpreted it.
  git(harness.repoRoot, ['checkout', '-b', 'feature/previous']);
  git(harness.repoRoot, ['checkout', 'develop']);
  git(harness.repoRoot, ['branch', '-D', 'feature/previous']);
  assert.equal(
    git(harness.repoRoot, ['check-ref-format', '--branch', '@{-1}']),
    'feature/previous',
    'sanity: git would expand @{-1}, which is exactly what the bridge must not accept'
  );

  await assert.rejects(
    harness.invoke('room_workspace_preview', { branchName: '@{-1}' }),
    (error) => error && error.code === 'room_workspace_branch_name_invalid'
  );
  assert.equal(harness.pendingCard(), null, 'no authorization card may be issued');
  assert.equal(harness.boundConversation().branch, null, 'no binding may be persisted');
  const branches = git(harness.repoRoot, ['branch', '--format=%(refname:short)']).split(/\r?\n/u);
  assert.ok(!branches.includes('@{-1}') && !branches.includes('feature/previous'));
  assert.equal(fs.existsSync(path.join(harness.repoRoot, '..', 'worktrees')), false, 'no worktree may be created');
});
