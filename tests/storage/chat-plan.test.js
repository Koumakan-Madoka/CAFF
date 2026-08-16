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
