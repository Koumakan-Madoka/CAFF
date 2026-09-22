const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { withTempDir } = require('../helpers/temp-dir');

function fixture(t) {
  const agentDir = withTempDir('caff-room-directory-');
  const store = createChatAppStore({ agentDir, sqlitePath: path.join(agentDir, 'chat.sqlite') });
  t.after(() => store.close());
  const room = (id, project = 'p') => store.createConversation({ id, title: id, projectScopeId: project, metadata: { titleSource: 'manual' }, participants: ['role-family-gpt'] });
  const message = (conversationId, createdAt, extra = {}) => {
    const m = store.createMessage({ conversationId, role: 'user', content: 'SECRET BODY', status: 'completed', ...extra });
    store.db.prepare('UPDATE chat_messages SET created_at = ? WHERE id = ?').run(createdAt, m.id);
  };
  return { store, room, message };
}

test('room directory scopes, excludes self and returns only directory fields', t => {
  const { store, room, message } = fixture(t);
  room('self'); room('same'); room('other', 'q'); room('unbound', null);
  message('same', '2026-01-01T00:00:00.000Z');
  const rows = store.listRoomsForAgent('self', {});
  assert.deepEqual(rows.map(r => r.id), ['same']);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['agents', 'id', 'lastPublicMessageAt', 'projectScopeId', 'title']);
  assert.deepEqual(rows[0].agents, [{ id: 'role-family-gpt', name: 'GPT' }]);
  assert.equal(JSON.stringify(rows).includes('SECRET BODY'), false);
  assert.deepEqual(new Set(store.listRoomsForAgent('self', { scope: 'all_projects' }).map(r => r.id)), new Set(['same', 'other', 'unbound']));
  assert.throws(() => store.listRoomsForAgent('unbound', {}), /all_projects/);
  assert.equal(store.listRoomsForAgent('unbound', { scope: 'all_projects' }).length, 3);
  assert.throws(() => store.listRoomsForAgent('missing', {}), /not found/i);
});

test('activity ignores private messages, placeholders and room update times; empty rooms sort last', t => {
  const { store, room, message } = fixture(t);
  room('self'); room('older'); room('newer'); room('empty');
  message('older', '2026-01-01T00:00:00.000Z');
  message('newer', '2026-01-02T00:00:00.000Z');
  for (const privateOnly of [true, 1, 'yes', [], {}]) {
    message('older', '2026-02-01T00:00:00.000Z', { metadata: { privateOnly } });
  }
  message('older', '2026-02-02T00:00:00.000Z', { metadata: { visibility: ' Private ' } });
  message('older', '2026-02-03T00:00:00.000Z', { role: 'assistant', content: 'Thinking...', status: 'streaming' });
  store.db.prepare('UPDATE chat_conversations SET updated_at = ?, last_message_at = ? WHERE id = ?').run('2099', '2099', 'older');
  const rows = store.listRoomsForAgent('self', {});
  assert.deepEqual(rows.map(r => r.id), ['newer', 'older', 'empty']);
  assert.equal(rows[1].lastPublicMessageAt, '2026-01-01T00:00:00.000Z');
  assert.equal(rows[2].lastPublicMessageAt, null);
});

test('limit defaults to 10, allows 30, validates types and rejects extra identity/filter arguments', t => {
  const { store, room } = fixture(t);
  room('self');
  for (let i = 0; i < 35; i++) room(`room-${String(i).padStart(2, '0')}`);
  assert.equal(store.listRoomsForAgent('self', {}).length, 10);
  assert.equal(store.listRoomsForAgent('self', { limit: 30 }).length, 30);
  assert.equal(store.listRoomsForAgent('self', { limit: 1 })[0].id, 'room-34');
  for (const limit of [0, 31, -1, 1.5, '10', null, true, NaN]) {
    assert.throws(() => store.listRoomsForAgent('self', { limit }), /limit/);
  }
  for (const args of [null, [], { scope: 'all' }, { projectScopeId: 'q' }, { query: 'title' }]) {
    assert.throws(() => store.listRoomsForAgent('self', args));
  }
});
