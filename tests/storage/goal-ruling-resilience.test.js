const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { applySessionGoalAction, proposeSessionGoalAction } = require('../../build/server/domain/conversation/session-goal');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-ruling-resilience-'));
  const options = { agentDir: root, sqlitePath: path.join(root, 'chat.sqlite') };
  const f = { store: createChatAppStore(options), options };
  t.after(() => { try { f.store?.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
  f.room = f.store.createConversation({ title: 'Ruling resilience', participants: ['role-family-gpt'] });
  applySessionGoalAction(f.store, f.room.id, { action: 'set', objective: 'Synthetic ruling test', status: 'paused',
    acceptanceCriteria: [{ id: 'c', statement: 'Retain audit', verifyBy: 'SQLite assertions', status: 'pending' }], ruledBy: { kind: 'user' } });
  proposeSessionGoalAction(f.store, f.room.id, { action: 'pause' }, { agentId: 'role-family-gpt', agentName: 'GPT' });
  applySessionGoalAction(f.store, f.room.id, { action: 'dismiss-proposal', ruledBy: { kind: 'user' } });
  f.metadata = () => structuredClone(f.store.getConversationWithoutMessages(f.room.id).metadata);
  f.history = () => f.store.listSessionGoalRulings(f.room.id);
  f.rawRuling = ruling => f.store.db.prepare('UPDATE chat_conversations SET metadata_json = ? WHERE id = ?')
    .run(JSON.stringify({ ...f.metadata(), sessionGoalRuling: ruling }), f.room.id);
  return f;
}
function warnings(t) {
  const original = console.warn, messages = [];
  console.warn = (...args) => messages.push(args.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(' '));
  t.after(() => { console.warn = original; });
  return messages;
}

test('N9 unchanged ruling is not re-appended on title/participant/unrelated metadata updates', t => {
  const f = fixture(t), history = f.history();
  f.store.db.exec("CREATE TRIGGER reject_unnecessary_archive BEFORE INSERT ON chat_goal_rulings BEGIN SELECT RAISE(ABORT, 'unexpected archive write'); END");
  f.store.updateConversationWithoutMessages(f.room.id, { title: 'Renamed without archiving' });
  f.store.updateConversation(f.room.id, { participants: ['role-family-gpt'] });
  f.store.updateConversationWithoutMessages(f.room.id, { metadata: { ...f.metadata(), unrelated: 'saved' } });
  assert.equal(f.store.getConversationWithoutMessages(f.room.id).title, 'Renamed without archiving');
  assert.equal(f.metadata().unrelated, 'saved');
  assert.deepEqual(f.history(), history);
});

for (const variant of ['conflicting', 'legacy', 'malformed']) {
  test(`N9 retained ${variant} old ruling cannot freeze unrelated Room writes`, t => {
    const f = fixture(t), history = f.history(), old = history[0];
    const anomaly = variant === 'conflicting' ? { ...old, reason: 'Changed by an old path' }
      : variant === 'legacy' ? { ...old, proposalId: undefined, proposal_id: old.proposalId }
        : { id: old.id, outcome: 'obsolete', reason: 'Unrecognized old projection' };
    f.rawRuling(anomaly);
    const snapshot = f.metadata().sessionGoalRuling;
    f.store.saveCustomRoleConfig({ id: 'ruling-helper', name: 'Helper', personaPrompt: 'Synthetic', provider: 'openai', model: 'gpt-5' });
    f.store.updateConversationWithoutMessages(f.room.id, { title: 'Legacy room renamed' });
    f.store.updateConversation(f.room.id, { participants: ['role-family-gpt', 'ruling-helper'] });
    f.store.updateConversationWithoutMessages(f.room.id, { metadata: { ...f.metadata(), unrelated: { saved: true } } });
    assert.equal(f.store.getConversationWithoutMessages(f.room.id).title, 'Legacy room renamed');
    assert.deepEqual(f.store.getConversationWithoutMessages(f.room.id).agents.map(a => a.id), ['role-family-gpt', 'ruling-helper']);
    assert.deepEqual(f.metadata().sessionGoalRuling, snapshot);
    assert.deepEqual(f.metadata().unrelated, { saved: true });
    assert.deepEqual(f.history(), history, 'immutable archive is never replaced with the anomalous snapshot');
  });
}

test('N9 startup skips an old ID/content conflict with a content-free diagnostic, retaining the archived record', t => {
  const f = fixture(t), history = f.history(), marker = 'SYNTHETIC_PRIVATE_RULING_CONTENT';
  f.rawRuling({ ...history[0], reason: marker });
  f.store.close(); f.store = null;
  const logs = warnings(t);
  f.store = createChatAppStore(f.options);
  assert.deepEqual(f.history(), history);
  assert.ok(logs.some(s => s.includes('goal_ruling_legacy_conflict') && s.includes('backfill')));
  assert.ok(logs.every(s => !s.includes(marker) && !s.includes(history[0].proposalId)));
  f.store.updateConversationWithoutMessages(f.room.id, { title: 'Reopened and writable' });
  assert.equal(f.store.getConversationWithoutMessages(f.room.id).title, 'Reopened and writable');
});

test('N9 a new ruling replaces a conflicting previous snapshot without losing either the immutable archive or the new ruling', t => {
  const f = fixture(t), history = f.history();
  f.rawRuling({ ...history[0], reason: 'Conflicting old snapshot' });
  const next = { ...history[0], id: 'new-ruling', reason: 'New verdict' }, logs = warnings(t);
  f.store.updateConversationWithoutMessages(f.room.id, { metadata: { ...f.metadata(), sessionGoalRuling: next } });
  assert.deepEqual(f.history(), [...history, next]);
  assert.equal(f.metadata().sessionGoalRuling.id, next.id);
  assert.ok(logs.some(s => s.includes('goal_ruling_legacy_conflict') && s.includes('previous_snapshot')));
  assert.ok(logs.every(s => !s.includes('Conflicting old snapshot')));
});

test('N9 explicit changes to an archived ruling ID remain strict and roll back metadata', t => {
  const f = fixture(t), history = f.history(), before = f.metadata();
  assert.throws(() => f.store.updateConversationWithoutMessages(f.room.id, { title: 'Must not persist',
    metadata: { ...before, sessionGoalRuling: { ...history[0], reason: 'New conflicting content' } } }), /cannot be overwritten/);
  assert.deepEqual(f.metadata(), before);
  assert.notEqual(f.store.getConversationWithoutMessages(f.room.id).title, 'Must not persist');
  assert.deepEqual(f.history(), history);
});

for (const stage of ['previous', 'new']) {
  test(`N9 SQLite failures while archiving ${stage} records still abort the entire transition`, t => {
    const f = fixture(t), history = f.history();
    if (stage === 'previous') f.rawRuling({ ...history[0], id: 'unarchived-legacy' });
    const before = f.metadata(), next = { ...history[0], id: 'new-ruling' };
    f.store.db.exec("CREATE TRIGGER reject_archive BEFORE INSERT ON chat_goal_rulings BEGIN SELECT RAISE(ABORT, 'synthetic database failure'); END");
    assert.throws(() => f.store.updateConversationWithoutMessages(f.room.id, { title: 'Must roll back',
      metadata: { ...before, sessionGoalRuling: next } }), /synthetic database failure/);
    assert.deepEqual(f.metadata(), before);
    assert.deepEqual(f.history(), history);
    assert.notEqual(f.store.getConversationWithoutMessages(f.room.id).title, 'Must roll back');
  });
}
