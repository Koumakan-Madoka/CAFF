const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { validatePlanDoc, validateStatusOnlyUpdate } = require('../../build/lib/plan-dag');
const { withTempDir } = require('../helpers/temp-dir');

const TEST_PARTICIPANTS = ['role-family-gpt'];

function createStore(t, prefix = 'caff-chat-plan-') {
  const tempDir = withTempDir(prefix);
  const sqlitePath = path.join(tempDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: tempDir, sqlitePath });
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return store;
}

function createRootConversation(store, id = 'root-conversation') {
  return store.createConversation({ id, title: 'Root', participants: TEST_PARTICIPANTS });
}

function createChildConversation(store, id, parentId) {
  return store.conversationRepository.create({
    id,
    title: 'Child',
    type: 'standard',
    metadataJson: '{}',
    parentConversationId: parentId,
    originConversationId: parentId,
    treeDepth: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function validDoc(overrides = {}) {
  return {
    nodes: [
      { id: 'n1', title: 'Design', goal: 'design the thing', status: 'pending', depends_on: [], kind: 'work' },
      { id: 'n2', title: 'Build', goal: 'build the thing', status: 'pending', depends_on: ['n1'], kind: 'work' },
    ],
    ...overrides,
  };
}

test('validatePlanDoc accepts a minimal valid doc and derives edges', () => {
  const result = validatePlanDoc(validDoc());
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.warnings, []);
});

test('validatePlanDoc rejects duplicate ids, missing deps, self-deps and cycles', () => {
  assert.equal(validatePlanDoc({ nodes: [{ id: 'a' }, { id: 'a' }] }).issues
    .some((issue) => issue.code === 'plan_node_id_duplicate'), true);

  assert.equal(validatePlanDoc({ nodes: [{ id: 'a', depends_on: ['ghost'] }] }).issues
    .some((issue) => issue.code === 'plan_dependency_missing'), true);

  assert.equal(validatePlanDoc({ nodes: [{ id: 'a', depends_on: ['a'] }] }).issues
    .some((issue) => issue.code === 'plan_node_self_dependency'), true);

  const cyclic = validatePlanDoc({
    nodes: [
      { id: 'a', depends_on: ['b'] },
      { id: 'b', depends_on: ['a'] },
    ],
  });
  assert.equal(cyclic.ok, false);
  assert.equal(cyclic.issues.some((issue) => issue.code === 'plan_cycle'), true);
});

test('validatePlanDoc warns on merge nodes with in-degree < 2', () => {
  const result = validatePlanDoc({
    nodes: [
      { id: 'a', depends_on: [] },
      { id: 'm', kind: 'merge', depends_on: ['a'] },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.warnings.some((warning) => warning.code === 'plan_merge_indegree'), true);

  const healthy = validatePlanDoc({
    nodes: [
      { id: 'a', depends_on: [] },
      { id: 'b', depends_on: [] },
      { id: 'm', kind: 'merge', depends_on: ['a', 'b'] },
    ],
  });
  assert.deepEqual(healthy.warnings, []);
});

test('validateStatusOnlyUpdate allows status transitions and blocks structural edits', () => {
  const before = validDoc();

  const statusOnly = JSON.parse(JSON.stringify(before));
  statusOnly.nodes[1].status = 'doing';
  assert.equal(validateStatusOnlyUpdate(before, statusOnly).ok, true);

  const retitled = JSON.parse(JSON.stringify(before));
  retitled.nodes[0].title = 'Changed';
  const retitleResult = validateStatusOnlyUpdate(before, retitled);
  assert.equal(retitleResult.ok, false);
  assert.equal(retitleResult.issues.some((issue) => issue.code === 'plan_locked_field_changed'), true);

  const added = JSON.parse(JSON.stringify(before));
  added.nodes.push({ id: 'n3', title: 'Extra', depends_on: [] });
  assert.equal(validateStatusOnlyUpdate(before, added).issues
    .some((issue) => issue.code === 'plan_locked_node_added'), true);

  const removed = JSON.parse(JSON.stringify(before));
  removed.nodes.pop();
  assert.equal(validateStatusOnlyUpdate(before, removed).issues
    .some((issue) => issue.code === 'plan_locked_node_removed'), true);

  const reWired = JSON.parse(JSON.stringify(before));
  reWired.nodes[1].depends_on = [];
  assert.equal(validateStatusOnlyUpdate(before, reWired).ok, false);
});

test('plan store: create on root, resolve from child, optimistic version guard', (t) => {
  const store = createStore(t);
  const root = createRootConversation(store);
  createChildConversation(store, 'child-conversation', root.id);

  const created = store.savePlanForConversation(root.id, { doc: validDoc() });
  assert.equal(created.ownerConversationId, root.id);
  assert.equal(created.plan.status, 'draft');
  assert.equal(created.plan.version, 1);
  assert.equal(created.plan.doc.nodes.length, 2);

  // Child conversation in the same tree resolves the root-owned plan.
  const fromChild = store.getPlanForConversation('child-conversation');
  assert.equal(fromChild.ownerConversationId, root.id);
  assert.equal(fromChild.plan.id, created.plan.id);

  // Child can write through to the shared plan with the correct version.
  const edited = store.savePlanForConversation('child-conversation', {
    doc: validDoc({ nodes: [...validDoc().nodes, { id: 'n3', title: 'Verify', goal: 'verify', depends_on: ['n2'] }] }),
    version: 1,
  });
  assert.equal(edited.plan.version, 2);
  assert.equal(edited.plan.doc.nodes.length, 3);

  // Stale version → 409 conflict.
  assert.throws(
    () => store.savePlanForConversation(root.id, { doc: validDoc(), version: 1 }),
    (error) => error.code === 'plan_version_conflict' && error.statusCode === 409
  );
});

test('plan store: lifecycle draft → active locks structure, revert unlocks', (t) => {
  const store = createStore(t);
  const root = createRootConversation(store);
  store.savePlanForConversation(root.id, { doc: validDoc() });

  // Activate: version bumps, activatedAt set.
  const active = store.activatePlanForConversation(root.id);
  assert.equal(active.plan.status, 'active');
  assert.equal(active.plan.version, 2);
  assert.ok(active.plan.activatedAt);

  // Double activate rejected.
  assert.throws(
    () => store.activatePlanForConversation(root.id),
    (error) => error.code === 'plan_not_activatable' && error.statusCode === 409
  );

  // Structural edit rejected while active.
  assert.throws(
    () => store.savePlanForConversation(root.id, {
      doc: validDoc({ nodes: [...validDoc().nodes, { id: 'n3', depends_on: [] }] }),
      version: 2,
    }),
    (error) => error.code === 'plan_locked' && error.statusCode === 409
  );

  // Status-only transition accepted while active.
  const statusDoc = validDoc();
  statusDoc.nodes[0].status = 'done';
  statusDoc.nodes[1].status = 'doing';
  const updated = store.savePlanForConversation(root.id, { doc: statusDoc, version: 2 });
  assert.equal(updated.plan.version, 3);
  assert.equal(updated.plan.doc.nodes[0].status, 'done');
  assert.equal(updated.plan.doc.nodes[1].status, 'doing');

  // Revert to draft preserves node statuses, then structural edits work again.
  const reverted = store.revertPlanForConversation(root.id);
  assert.equal(reverted.plan.status, 'draft');
  assert.equal(reverted.plan.doc.nodes[0].status, 'done');

  const grownDoc = validDoc();
  grownDoc.nodes.push({ id: 'n3', title: 'Extra', goal: '', depends_on: ['n2'] });
  const grown = store.savePlanForConversation(root.id, { doc: grownDoc, version: reverted.plan.version });
  assert.equal(grown.plan.doc.nodes.length, 3);
});

test('validatePlanDoc validates execution schema fields (verify / base_branch / result)', () => {
  // verify must be a string
  assert.equal(validatePlanDoc({ nodes: [{ id: 'a', verify: 42 }] }).issues
    .some((issue) => issue.code === 'plan_node_verify_invalid'), true);

  // base_branch must be a string
  assert.equal(validatePlanDoc({ nodes: [{ id: 'a', base_branch: 42 }] }).issues
    .some((issue) => issue.code === 'plan_node_base_branch_invalid'), true);

  // result must be a string within the cap
  assert.equal(validatePlanDoc({ nodes: [{ id: 'a', result: 42 }] }).issues
    .some((issue) => issue.code === 'plan_node_result_invalid'), true);
  assert.equal(validatePlanDoc({ nodes: [{ id: 'a', result: 'x'.repeat(2001) }] }).issues
    .some((issue) => issue.code === 'plan_node_result_too_long'), true);

  // valid doc with all new fields passes
  const okDoc = validatePlanDoc({
    nodes: [
      { id: 'a', branch: 'feat/a', depends_on: [] },
      { id: 'b', branch: 'feat/b', depends_on: [] },
      {
        id: 'm',
        kind: 'merge',
        depends_on: ['a', 'b'],
        branch: 'feat/merge',
        base_branch: 'feat/a',
        verify: 'npm run test:fast',
      },
    ],
  });
  assert.equal(okDoc.ok, true);
  assert.deepEqual(okDoc.issues, []);
});

test('validatePlanDoc enforces base_branch equals a parent branch', () => {
  // mismatch against parent branches
  const mismatch = validatePlanDoc({
    nodes: [
      { id: 'a', branch: 'feat/a', depends_on: [] },
      { id: 'b', depends_on: ['a'], base_branch: 'feat/other' },
    ],
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.issues.some((issue) => issue.code === 'plan_node_base_branch_mismatch'), true);

  // parent without a branch set also mismatches
  const unsetParent = validatePlanDoc({
    nodes: [
      { id: 'a', depends_on: [] },
      { id: 'b', depends_on: ['a'], base_branch: 'feat/a' },
    ],
  });
  assert.equal(unsetParent.issues.some((issue) => issue.code === 'plan_node_base_branch_mismatch'), true);

  // no parents at all → mismatch with guidance to omit the field
  const noParents = validatePlanDoc({ nodes: [{ id: 'a', depends_on: [], base_branch: 'feat/a' }] });
  assert.equal(noParents.issues.some((issue) => issue.code === 'plan_node_base_branch_mismatch'), true);
});

test('validatePlanDoc validates doc.history shape and rolling cap', () => {
  assert.equal(validatePlanDoc({ nodes: [{ id: 'a' }], history: {} }).issues
    .some((issue) => issue.code === 'plan_history_invalid'), true);

  assert.equal(validatePlanDoc({ nodes: [{ id: 'a' }], history: ['nope'] }).issues
    .some((issue) => issue.code === 'plan_history_entry_invalid'), true);

  const badEntry = validatePlanDoc({
    nodes: [{ id: 'a' }],
    history: [{ node_id: '', from: 'todo', to: 'done', at: '', actor: '' }],
  });
  assert.equal(badEntry.issues.filter((issue) => issue.code === 'plan_history_entry_invalid').length >= 3, true);

  const oversized = validatePlanDoc({
    nodes: [{ id: 'a' }],
    history: Array.from({ length: 201 }, (_, index) => ({
      node_id: 'a',
      from: 'pending',
      to: 'doing',
      at: new Date(index).toISOString(),
      actor: 'test',
    })),
  });
  assert.equal(oversized.issues.some((issue) => issue.code === 'plan_history_too_long'), true);

  const valid = validatePlanDoc({
    nodes: [{ id: 'a' }],
    history: [{ node_id: 'a', from: 'pending', to: 'doing', at: new Date().toISOString(), actor: 'user', reason: 'kick off' }],
  });
  assert.equal(valid.ok, true);
});

test('validateStatusOnlyUpdate: result mutable, verify/base_branch locked, history append-only', () => {
  const before = validDoc();

  // result write-back alongside a status transition is allowed
  const withResult = JSON.parse(JSON.stringify(before));
  withResult.nodes[0].status = 'done';
  withResult.nodes[0].result = 'design doc approved';
  assert.equal(validateStatusOnlyUpdate(before, withResult).ok, true);

  // done without result → warning, not an error (manual flips stay allowed)
  const bareCompletion = JSON.parse(JSON.stringify(before));
  bareCompletion.nodes[0].status = 'done';
  const completionResult = validateStatusOnlyUpdate(before, bareCompletion);
  assert.equal(completionResult.ok, true);
  assert.equal(completionResult.warnings.some((warning) => warning.code === 'plan_done_result_missing'), true);

  // verify / base_branch are structural and locked while active
  const verifyChanged = JSON.parse(JSON.stringify(before));
  verifyChanged.nodes[0].verify = 'npm test';
  assert.equal(validateStatusOnlyUpdate(before, verifyChanged).issues
    .some((issue) => issue.code === 'plan_locked_field_changed'), true);

  const baseBranchChanged = JSON.parse(JSON.stringify(before));
  baseBranchChanged.nodes[1].base_branch = 'feat/x';
  assert.equal(validateStatusOnlyUpdate(before, baseBranchChanged).issues
    .some((issue) => issue.code === 'plan_locked_field_changed'), true);

  // history may grow by appending only
  const entry = { node_id: 'n1', from: 'pending', to: 'doing', at: new Date().toISOString(), actor: 'scheduler' };
  const appended = JSON.parse(JSON.stringify(before));
  appended.history = [entry];
  assert.equal(validateStatusOnlyUpdate(before, appended).ok, true);

  const grown = JSON.parse(JSON.stringify(appended));
  grown.history.push({ ...entry, to: 'done', at: new Date().toISOString() });
  assert.equal(validateStatusOnlyUpdate(appended, grown).ok, true);

  const mutated = JSON.parse(JSON.stringify(appended));
  mutated.history[0].actor = 'someone-else';
  assert.equal(validateStatusOnlyUpdate(appended, mutated).issues
    .some((issue) => issue.code === 'plan_locked_history_changed'), true);

  const truncated = JSON.parse(JSON.stringify(appended));
  truncated.history = [];
  assert.equal(validateStatusOnlyUpdate(appended, truncated).issues
    .some((issue) => issue.code === 'plan_locked_history_changed'), true);
});

test('appendPlanHistory appends, defaults timestamp and trims to the rolling cap', () => {
  const { appendPlanHistory } = require('../../build/lib/plan-dag');

  const appended = appendPlanHistory(validDoc(), { node_id: 'n1', from: 'pending', to: 'doing', actor: 'scheduler' });
  assert.equal(appended.history.length, 1);
  assert.ok(appended.history[0].at);
  assert.equal(appended.history[0].reason, undefined);

  const withReason = appendPlanHistory(appended, {
    node_id: 'n1', from: 'doing', to: 'blocked', actor: 'scheduler', reason: 'worktree dirty', at: '2026-08-16T00:00:00.000Z',
  });
  assert.equal(withReason.history.length, 2);
  assert.equal(withReason.history[1].reason, 'worktree dirty');

  let doc = validDoc();
  for (let index = 0; index < 205; index += 1) {
    doc = appendPlanHistory(doc, {
      node_id: 'n1', from: 'pending', to: 'doing', actor: 'scheduler', at: new Date(index).toISOString(),
    });
  }
  assert.equal(doc.history.length, 200);
  assert.equal(validatePlanDoc(doc).ok, true);
});

test('plan store: active done-transition without result succeeds with warning passthrough', (t) => {
  const store = createStore(t);
  const root = createRootConversation(store);
  store.savePlanForConversation(root.id, { doc: validDoc() });
  store.activatePlanForConversation(root.id);

  const doneDoc = validDoc();
  doneDoc.nodes[0].status = 'done';
  const updated = store.savePlanForConversation(root.id, { doc: doneDoc, version: 2 });
  assert.equal(updated.plan.version, 3);
  assert.equal(updated.warnings.some((warning) => warning.code === 'plan_done_result_missing'), true);

  const withResultDoc = validDoc();
  withResultDoc.nodes[0].status = 'done';
  withResultDoc.nodes[0].result = 'design doc approved';
  const clean = store.savePlanForConversation(root.id, { doc: withResultDoc, version: 3 });
  assert.equal(clean.warnings.some((warning) => warning.code === 'plan_done_result_missing'), false);
  assert.equal(clean.plan.doc.nodes[0].result, 'design doc approved');
});

test('plan store: D16 fail-closed — pending→doing rejected while a transitive upstream is blocked', (t) => {
  const store = createStore(t);
  const root = createRootConversation(store);

  const chainDoc = () => ({
    nodes: [
      { id: 'n1', title: 'A', goal: '', status: 'pending', depends_on: [], kind: 'work' },
      { id: 'n2', title: 'B', goal: '', status: 'pending', depends_on: ['n1'], kind: 'work' },
      { id: 'n3', title: 'C', goal: '', status: 'pending', depends_on: ['n2'], kind: 'work' },
    ],
  });

  store.savePlanForConversation(root.id, { doc: chainDoc() });
  store.activatePlanForConversation(root.id);

  // Block the head of the chain (pending→blocked is unrestricted).
  // NOTE: clients must thread the returned doc — the server auto-appends
  // history entries (D18), so docs built from scratch would trip the
  // append-only guard.
  const blockedDoc = chainDoc();
  blockedDoc.nodes[0].status = 'blocked';
  const blocked = store.savePlanForConversation(root.id, { doc: blockedDoc, version: 2 });
  assert.equal(blocked.plan.doc.nodes[0].status, 'blocked');
  const storedDoc = () => JSON.parse(JSON.stringify(blocked.plan.doc));

  // Direct downstream pending→doing rejected with blocking details.
  const startDirect = storedDoc();
  startDirect.nodes[1].status = 'doing';
  assert.throws(
    () => store.savePlanForConversation(root.id, { doc: startDirect, version: 3 }),
    (error) => error.statusCode === 409
      && error.code === 'plan_upstream_blocked'
      && error.issues.some((issue) => issue.code === 'plan_upstream_blocked'
        && issue.nodeId === 'n2'
        && issue.blockedUpstreams.includes('n1'))
  );

  // Transitive downstream (n3 via n2) is rejected as well — fail-closed.
  const startTransitive = storedDoc();
  startTransitive.nodes[2].status = 'doing';
  assert.throws(
    () => store.savePlanForConversation(root.id, { doc: startTransitive, version: 3 }),
    (error) => error.code === 'plan_upstream_blocked'
      && error.issues[0].blockedUpstreams.includes('n1')
  );

  // Non-doing transitions are not affected: n3 may transition to blocked.
  const cascadeDoc = storedDoc();
  cascadeDoc.nodes[2].status = 'blocked';
  const cascaded = store.savePlanForConversation(root.id, { doc: cascadeDoc, version: 3 });
  assert.equal(cascaded.plan.doc.nodes[2].status, 'blocked');

  // Unblock upstream + start downstream in one write is allowed
  // (blocked upstreams are evaluated on the incoming doc).
  const recoveredDoc = JSON.parse(JSON.stringify(cascaded.plan.doc));
  recoveredDoc.nodes[0].status = 'done';
  recoveredDoc.nodes[0].result = 'head fixed';
  recoveredDoc.nodes[1].status = 'doing';
  const recovered = store.savePlanForConversation(root.id, { doc: recoveredDoc, version: 4 });
  assert.equal(recovered.plan.doc.nodes[1].status, 'doing');
});

test('plan store: D18 — active status transitions auto-append history with actor attribution', (t) => {
  const store = createStore(t);
  const root = createRootConversation(store);
  store.savePlanForConversation(root.id, { doc: validDoc() });
  store.activatePlanForConversation(root.id);

  // Default actor (REST/UI channel) records as 'user'.
  const doingDoc = validDoc();
  doingDoc.nodes[0].status = 'doing';
  const doing = store.savePlanForConversation(root.id, { doc: doingDoc, version: 2 });
  assert.equal(doing.plan.doc.history.length, 1);
  assert.equal(doing.plan.doc.history[0].node_id, 'n1');
  assert.equal(doing.plan.doc.history[0].from, 'pending');
  assert.equal(doing.plan.doc.history[0].to, 'doing');
  assert.equal(doing.plan.doc.history[0].actor, 'user');
  assert.ok(doing.plan.doc.history[0].at);

  // Agent actor (bridge channel) is attributed and reason is passed through.
  const blockedDoc = doing.plan.doc;
  blockedDoc.nodes[0].status = 'blocked';
  const blocked = store.savePlanForConversation(root.id, { doc: blockedDoc, version: 3 }, {
    actor: { type: 'agent', agentId: 'role-family-gpt', conversationId: root.id },
    reason: 'worktree dirty',
  });
  const lastEntry = blocked.plan.doc.history[blocked.plan.doc.history.length - 1];
  assert.equal(lastEntry.to, 'blocked');
  assert.equal(lastEntry.actor, 'agent:role-family-gpt');
  assert.equal(lastEntry.reason, 'worktree dirty');

  // Caller-pre-recorded transitions are not double-appended.
  const preRecorded = blocked.plan.doc;
  preRecorded.nodes[0].status = 'done';
  preRecorded.nodes[0].result = 'manual finish';
  preRecorded.history = preRecorded.history.concat([{
    node_id: 'n1',
    from: 'blocked',
    to: 'done',
    at: new Date().toISOString(),
    actor: 'system',
    reason: 'scheduler write-back',
  }]);
  const done = store.savePlanForConversation(root.id, { doc: preRecorded, version: 4 }, {
    actor: { type: 'system' },
  });
  const n1DoneEntries = done.plan.doc.history.filter(
    (entry) => entry.node_id === 'n1' && entry.to === 'done'
  );
  assert.equal(n1DoneEntries.length, 1);
  assert.equal(n1DoneEntries[0].reason, 'scheduler write-back');

  // No status change → no new entries.
  const noop = store.savePlanForConversation(root.id, { doc: done.plan.doc, version: 5 });
  assert.equal(noop.plan.doc.history.length, done.plan.doc.history.length);
});

test('plan store: D15 — activate/revert restricted to user, system or root participant agent', (t) => {
  const store = createStore(t);
  const root = createRootConversation(store);
  createChildConversation(store, 'child-conversation', root.id);
  store.savePlanForConversation(root.id, { doc: validDoc() });

  // Child-conversation agent → 403.
  assert.throws(
    () => store.activatePlanForConversation(root.id, {
      type: 'agent', agentId: 'role-family-gpt', conversationId: 'child-conversation',
    }),
    (error) => error.statusCode === 403 && error.code === 'plan_forbidden'
  );

  // Root conversation but the agent is not a participant → 403.
  assert.throws(
    () => store.activatePlanForConversation(root.id, {
      type: 'agent', agentId: 'role-family-claude', conversationId: root.id,
    }),
    (error) => error.statusCode === 403 && error.code === 'plan_forbidden'
  );

  // Root conversation participant agent → allowed.
  const activated = store.activatePlanForConversation(root.id, {
    type: 'agent', agentId: 'role-family-gpt', conversationId: root.id,
  });
  assert.equal(activated.plan.status, 'active');

  // Revert: child agent forbidden, user (default actor) allowed.
  assert.throws(
    () => store.revertPlanForConversation(root.id, {
      type: 'agent', agentId: 'role-family-gpt', conversationId: 'child-conversation',
    }),
    (error) => error.statusCode === 403 && error.code === 'plan_forbidden'
  );
  const reverted = store.revertPlanForConversation(root.id);
  assert.equal(reverted.plan.status, 'draft');

  // System actor (scheduler) bypasses D15.
  const reactivated = store.activatePlanForConversation(root.id, { type: 'system' });
  assert.equal(reactivated.plan.status, 'active');
});

test('plan store: missing conversation / missing plan error codes', (t) => {
  const store = createStore(t);
  const root = createRootConversation(store);

  assert.throws(
    () => store.getPlanForConversation('ghost-conversation'),
    (error) => error.code === 'conversation_not_found' && error.statusCode === 404
  );

  const empty = store.getPlanForConversation(root.id);
  assert.equal(empty.plan, null);

  assert.throws(
    () => store.activatePlanForConversation(root.id),
    (error) => error.code === 'plan_not_found' && error.statusCode === 404
  );

  assert.throws(
    () => store.savePlanForConversation(root.id, {
      doc: { nodes: [{ id: 'a', depends_on: ['b'] }, { id: 'b', depends_on: ['a'] }] },
    }),
    (error) => error.code === 'plan_validation_failed' && error.statusCode === 422
      && error.issues.some((issue) => issue.code === 'plan_cycle')
  );
});
