const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { applySessionGoalAction, proposeSessionGoalAction } = require('../../build/server/domain/conversation/session-goal');

const proposer = { agentId: 'role-family-gpt', agentName: 'GPT' };
const planner = { kind: 'planner', plannerId: 'local-planner', plannerName: 'Synthetic Planner' };
const criteria = [{ id: 'c', statement: 'Observe persistence', verifyBy: 'SQLite assertions', status: 'pending' }];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-attention-'));
  const options = { agentDir: root, sqlitePath: path.join(root, 'chat.sqlite') };
  const f = { store: createChatAppStore(options), options };
  t.after(() => { try { f.store?.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
  f.room = f.store.createConversation({ title: 'Attention fixture', participants: [proposer.agentId] });
  f.read = () => f.store.getConversationWithoutMessages(f.room.id);
  f.list = (query = {}) => f.store.listPlannerAttention(query);
  f.propose = (input = {}) => proposeSessionGoalAction(f.store, f.room.id,
    { action: 'set', objective: 'Synthetic Goal', acceptanceCriteria: criteria, status: 'paused', ...input }, proposer);
  f.action = input => applySessionGoalAction(f.store, f.room.id, { ...input, ruledBy: input.ruledBy || { kind: 'user' } });
  f.restart = () => { f.store.close(); f.store = null; f.store = createChatAppStore(options); };
  return f;
}

// Requested M4 null/0 regression: use real domain writes, not fabricated rows.
test('no-Goal set proposal persists null/0 occurrence across restart, reads never consume it', t => {
  const f = fixture(t), proposal = f.propose().proposal;
  const first = f.list();
  assert.equal(first.items.length, 1);
  const item = first.items[0];
  assert.equal(item.conversationId, f.room.id);
  assert.equal(item.goalId, null);
  assert.equal(item.goalRevision, 0);
  assert.equal(item.kind, 'proposal_pending');
  assert.equal(item.sourceId, proposal.id);
  assert.equal(item.resolvedAt, null);
  assert.equal(item.resolution, null);
  assert.equal(first.nextCursor, item.sequence);
  assert.equal(first.highWatermark, item.sequence);
  assert.equal(first.hasMore, false);
  f.restart();
  assert.deepEqual(f.list(), first);
  assert.deepEqual(f.list(), first);
  assert.equal(f.read().metadata.sessionGoal, undefined);
});

for (const action of ['accept-proposal', 'dismiss-proposal', 'clear']) {
  test(`no-Goal proposal ${action} resolves without backfilling occurrence Goal identity`, t => {
    const f = fixture(t), proposal = f.propose().proposal, before = f.list().items[0];
    f.action({ action, proposalId: proposal.id, goalId: null, goalRevision: 0, ruledBy: planner,
      ...(action === 'clear' ? { supersedeProposal: true } : {}) });
    const after = f.list().items[0];
    assert.equal(after.goalId, null);
    assert.equal(after.goalRevision, 0);
    assert.equal(after.sequence, before.sequence);
    assert.equal(after.sourceId, proposal.id);
    assert.equal(after.createdAt, before.createdAt);
    assert.equal(after.resolution, action === 'accept-proposal' ? 'proposal_accepted'
      : action === 'dismiss-proposal' ? 'proposal_rejected' : 'proposal_superseded');
    assert.ok(after.resolvedAt);
    assert.deepEqual(after.resolvedBy, planner);
    if (action === 'accept-proposal') assert.ok(f.read().metadata.sessionGoal.goalId);
    f.restart();
    assert.deepEqual(f.list().items[0], after, 'restart never reopens or re-associates an occurrence');
    assert.deepEqual(f.list({ status: 'unresolved' }).items, []);
  });
}

test('agent draft replacement archives ruling, resolves old attention and creates new attention atomically', t => {
  const f = fixture(t), oldProposal = f.propose().proposal;
  const replacement = f.propose({ objective: 'Replacement draft' }).proposal;
  const items = f.list().items;
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(i => i.sourceId), [oldProposal.id, replacement.id]);
  assert.equal(items[0].resolution, 'proposal_superseded');
  assert.deepEqual(items[0].resolvedBy, { kind: 'agent', ...proposer });
  assert.equal(items[1].resolvedAt, null);
  assert.equal(items[0].goalId, null);
  assert.equal(items[1].goalId, null);
  assert.ok(items[1].sequence > items[0].sequence);
  assert.equal(f.store.listSessionGoalRulings(f.room.id)[0].supersedingProposalId, replacement.id);
  f.restart();
  assert.deepEqual(f.list().items, items);
});

for (const operation of ['INSERT', 'UPDATE', 'METADATA']) {
  test(`attention ${operation} failure rolls back proposal replacement, ruling history and all queue changes`, t => {
    const f = fixture(t); f.propose();
    const before = f.read(), page = f.list(), history = f.store.listSessionGoalRulings(f.room.id);
    f.store.db.exec(`CREATE TRIGGER reject_attention BEFORE ${operation === 'METADATA' ? 'UPDATE' : operation}
      ON ${operation === 'METADATA' ? 'chat_conversations' : 'chat_planner_attention'}
      BEGIN SELECT RAISE(ABORT, 'synthetic attention failure'); END`);
    assert.throws(() => f.propose({ objective: 'Must roll back' }), /synthetic attention failure/);
    assert.deepEqual(f.read().metadata, before.metadata);
    assert.deepEqual(f.list(), page);
    assert.deepEqual(f.store.listSessionGoalRulings(f.room.id), history);
  });
}

test('ruling archive failure rolls back attention resolution and accepted Goal creation', t => {
  const f = fixture(t); f.propose(); const before = f.read(), page = f.list();
  f.store.db.exec("CREATE TRIGGER reject_ruling BEFORE INSERT ON chat_goal_rulings BEGIN SELECT RAISE(ABORT, 'synthetic ruling failure'); END");
  assert.throws(() => f.action({ action: 'accept-proposal' }), /synthetic ruling failure/);
  assert.deepEqual(f.read().metadata, before.metadata);
  assert.deepEqual(f.list(), page);
});

test('live-Goal supersession and clear preserve occurrence revision and resolve retired Goal items', t => {
  const f = fixture(t);
  const original = f.action({ action: 'set', objective: 'Live synthetic Goal', status: 'paused', acceptanceCriteria: criteria }).goal;
  f.propose({ action: 'pause' });
  const before = f.list().items[0];
  assert.equal(before.goalId, original.goalId); assert.equal(before.goalRevision, original.revision);
  f.action({ action: 'revise', goalRevision: original.revision, supersedeProposal: true });
  assert.equal(f.list().items[0].resolution, 'proposal_superseded');
  assert.equal(f.list().items[0].goalRevision, original.revision);
  f.propose({ action: 'pause' });
  f.action({ action: 'clear' });
  assert.equal(f.list().items.length, 2);
  assert.ok(f.list().items.every(i => i.resolvedAt && i.resolution === 'proposal_superseded'));
});

test('startup repairs only current pending proposals idempotently without loading message bodies', t => {
  const f = fixture(t); const proposal = f.propose().proposal;
  // Simulate upgrade from a pre-attention database, not a production repair API.
  f.store.db.prepare('DELETE FROM chat_planner_attention WHERE conversation_id = ?').run(f.room.id);
  const original = f.store.db.prepare;
  f.store.db.prepare = function(sql) {
    assert.doesNotMatch(sql, /chat_messages|chat_private_messages|message_details/iu,
      'attention recovery must not read messages, private content or traces');
    return original.call(this, sql);
  };
  try { f.store.reconcilePlannerAttention(); } finally { f.store.db.prepare = original; }
  assert.equal(f.list().items.length, 1);
  assert.equal(f.list().items[0].sourceId, proposal.id);
  const page = f.list();
  f.store.updateConversationWithoutMessages(f.room.id, { title: 'Unrelated rename' });
  f.store.reconcilePlannerAttention(); f.restart();
  assert.deepEqual(f.list(), page);
});

test('cursor pages replay resolved-offline rows, skip filters safely and retain watermark after Room deletion', t => {
  const f = fixture(t); f.propose(); f.propose({ objective: 'Second' });
  const other = f.store.createConversation({ title: 'Other', participants: [proposer.agentId] });
  proposeSessionGoalAction(f.store, other.id, { action: 'set', objective: 'Other Goal', acceptanceCriteria: criteria }, proposer);
  f.propose({ objective: 'Fourth' });
  const all = f.list(), first = f.list({ limit: 2 });
  assert.equal(first.hasMore, true); assert.equal(first.nextCursor, first.items[1].sequence);
  const next = f.list({ after: first.nextCursor, limit: 2 });
  assert.equal(next.hasMore, false);
  assert.deepEqual([...first.items, ...next.items], all.items);
  assert.equal(next.nextCursor, all.highWatermark);
  assert.equal(all.items.filter(i => i.resolvedAt).length, 2);
  const filtered = f.list({ conversationId: other.id });
  assert.equal(filtered.items.length, 1); assert.equal(filtered.nextCursor, all.highWatermark);
  const empty = f.list({ after: all.highWatermark + 10 });
  assert.equal(empty.nextCursor, all.highWatermark + 10);
  assert.equal(empty.highWatermark, all.highWatermark);
  assert.deepEqual(f.store.countUnresolvedPlannerAttention(), { [f.room.id]: 1, [other.id]: 1 });
  f.store.deleteConversation(f.room.id); f.store.deleteConversation(other.id);
  assert.equal(f.list().highWatermark, all.highWatermark);
  assert.deepEqual(f.list().items, []);
  const another = f.store.createConversation({ title: 'Later', participants: [proposer.agentId] });
  proposeSessionGoalAction(f.store, another.id, { action: 'set', objective: 'Later Goal', acceptanceCriteria: criteria }, proposer);
  assert.ok(f.list().items[0].sequence > all.highWatermark);
});

for (const query of [null, [], { after: null }, { limit: null }, { status: null }, { after: -1 }, { after: Number.MAX_SAFE_INTEGER + 1 }, { after: '1' }, { limit: 0 },
  { limit: 501 }, { limit: 1.5 }, { status: 'pending' }, { conversationId: '' }, { conversationId: ['x'] }]) {
  test(`invalid attention query is rejected without writes: ${JSON.stringify(query)}`, t => {
    const f = fixture(t); f.propose(); const page = f.list();
    assert.throws(() => f.list(query), e => e.statusCode === 400 && e.code === 'attention_query_invalid');
    assert.deepEqual(f.list(), page);
  });
}

test('active proposal cannot be acknowledged; resolved replay is idempotent and cannot overwrite principal/reason', t => {
  const f = fixture(t); f.propose(); const before = f.list().items[0];
  assert.throws(() => f.store.resolvePlannerAttention(before.sequence, { reason: 'Try to hide proposal', principal: planner }),
    e => e.statusCode === 409 && e.code === 'attention_condition_active');
  assert.deepEqual(f.list().items[0], before);
  f.action({ action: 'dismiss-proposal', reason: 'Actual ruling' });
  const resolved = f.list().items[0];
  assert.deepEqual(f.store.resolvePlannerAttention(before.sequence, { reason: 'Different ack', principal: planner }), resolved);
  assert.deepEqual(f.list().items[0], resolved);
  assert.throws(() => f.store.resolvePlannerAttention(99999, { reason: 'Unknown item', principal: planner }),
    e => e.statusCode === 404 && e.code === 'attention_not_found');
});

test('attention occurrence and resolved data cannot be mutated through direct SQLite updates', t => {
  const f = fixture(t); f.propose(); const item = f.list().items[0];
  assert.throws(() => f.store.db.prepare('UPDATE chat_planner_attention SET goal_revision=42 WHERE sequence=?').run(item.sequence), /immutable/);
  f.action({ action: 'dismiss-proposal' }); const resolved = f.list().items[0];
  assert.throws(() => f.store.db.prepare('UPDATE chat_planner_attention SET resolution=? WHERE sequence=?').run('changed', item.sequence), /immutable/);
  assert.throws(() => f.store.db.prepare('UPDATE chat_planner_attention SET resolved_at=NULL WHERE sequence=?').run(item.sequence), /immutable/);
  assert.deepEqual(f.list().items[0], resolved);
});

function seed(f, kind, sourceId = 'synthetic-source', overrides = {}) {
  return f.store.plannerAttentionRepository.append({ conversationId: f.room.id,
    goalId: 'synthetic-goal', goalRevision: 1, kind, sourceId,
    summary: 'Synthetic attention notification', createdAt: '2026-10-23T00:00:00.000Z', ...overrides });
}

for (const kind of ['proposal_pending', 'budget_exhausted', 'failure_paused', 'owner_removed', 'goal_completed', 'turn_failed']) {
  test(`repository supports ${kind}, immutable deduplication and acknowledgement policy`, t => {
    const f = fixture(t), item = seed(f, kind), watermark = f.list().highWatermark;
    assert.deepEqual(seed(f, kind, 'synthetic-source', { goalId: 'must-not-backfill', goalRevision: 99,
      summary: 'must-not-replace' }), item);
    assert.equal(f.list().highWatermark, watermark, 'ordinary re-entry does not allocate another sequence');
    if (['goal_completed', 'turn_failed'].includes(kind)) {
      const resolved = f.store.resolvePlannerAttention(item.sequence, { reason: '  Reviewed synthetic result  ', principal: planner });
      assert.equal(resolved.resolution, 'acknowledged');
      assert.deepEqual(resolved.resolvedBy, planner);
      assert.ok(resolved.resolvedAt);
      assert.equal(f.store.db.prepare('SELECT resolution_reason FROM chat_planner_attention WHERE sequence=?').get(item.sequence).resolution_reason,
        'Reviewed synthetic result');
      assert.deepEqual(f.store.resolvePlannerAttention(item.sequence, { reason: 'Cannot replace original reason', principal: { kind: 'user' } }), resolved);
      assert.equal(f.store.db.prepare('SELECT resolution_reason FROM chat_planner_attention WHERE sequence=?').get(item.sequence).resolution_reason,
        'Reviewed synthetic result');
      assert.deepEqual(seed(f, kind), resolved, 're-entry never reopens a resolved occurrence');
    } else {
      assert.throws(() => f.store.resolvePlannerAttention(item.sequence, { reason: 'Not handled', principal: planner }),
        e => e.statusCode === 409 && e.code === 'attention_condition_active');
      assert.deepEqual(f.list().items[0], item);
    }
    const page = f.list(); f.restart(); assert.deepEqual(f.list(), page);
  });
}

test('summary is bounded to 500 Unicode code points; arbitrary proposal reason never enters the queue', t => {
  const f = fixture(t), marker = 'SYNTHETIC_PRIVATE_MESSAGE_CONTENT';
  f.propose({ reason: marker });
  assert.ok(!JSON.stringify(f.list()).includes(marker));
  const item = seed(f, 'turn_failed', 'emoji-summary', { summary: '\u{1F680}'.repeat(600) });
  assert.equal(Array.from(item.summary).length, 500);
  assert.equal(item.summary, '\u{1F680}'.repeat(500));
});

test('acknowledgement requires a reason and leaves unresolved data unchanged', t => {
  const f = fixture(t), item = seed(f, 'goal_completed');
  for (const reason of [undefined, null, '', '   ', 42]) {
    assert.throws(() => f.store.resolvePlannerAttention(item.sequence, { reason, principal: planner }),
      e => e.statusCode === 400 && e.code === 'attention_reason_required');
    assert.deepEqual(f.list().items[0], item);
  }
});

test('retiring a Goal resolves only its outstanding items without changing previously resolved items or another epoch', t => {
  const f = fixture(t), goal = f.action({ action: 'set', objective: 'Retire synthetic Goal', status: 'paused', acceptanceCriteria: criteria }).goal;
  const retired = seed(f, 'turn_failed', 'old-failed-turn', { goalId: goal.goalId });
  const acked = seed(f, 'turn_failed', 'old-acked-turn', { goalId: goal.goalId });
  const resolved = f.store.resolvePlannerAttention(acked.sequence, { reason: 'Already handled', principal: planner });
  const other = seed(f, 'turn_failed', 'different-epoch');
  f.action({ action: 'set', objective: 'Next Goal', status: 'paused', acceptanceCriteria: criteria });
  const all = f.list().items;
  assert.equal(all.find(i => i.sequence === retired.sequence).resolution, 'goal_replaced');
  assert.deepEqual(all.find(i => i.sequence === acked.sequence), resolved);
  assert.deepEqual(all.find(i => i.sequence === other.sequence), other);
});

test('pending proposal created with a Room rolls back with attention failure', t => {
  const f = fixture(t), proposal = f.propose().proposal;
  f.store.db.exec("CREATE TRIGGER reject_created_attention BEFORE INSERT ON chat_planner_attention BEGIN SELECT RAISE(ABORT, 'synthetic creation failure'); END");
  const count = f.store.db.prepare('SELECT COUNT(*) AS count FROM chat_conversations').get().count;
  assert.throws(() => f.store.createConversation({ title: 'Must roll back', participants: [proposer.agentId],
    metadata: { sessionGoalProposal: { ...proposal, id: 'another-proposal' } } }), /synthetic creation failure/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM chat_conversations').get().count, count);
  assert.equal(f.list().items.length, 1);
});
