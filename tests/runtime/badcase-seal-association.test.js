const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createBadcaseFlagService } = require('../../build/server/domain/runtime/badcase-capture/badcase-flags');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const code = expected => failure => failure.code === expected && failure.message === expected;

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-seal-association-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const association = { projectId: 'project-a', conversationId: 'room-a', messageId: 'message-a',
    turnId: 'turn-a', agentId: 'agent-a', taskId: 'task-a', checkpointId: 'checkpoint-a', runId: 101 };
  const message = { id: association.messageId, conversationId: association.conversationId,
    role: 'assistant', status: 'completed', turnId: association.turnId, agentId: association.agentId,
    taskId: association.taskId, runId: association.runId, metadata: { badcaseCheckpointId: association.checkpointId } };
  const checkpoint = { projectId: association.projectId, conversationId: association.conversationId,
    checkpointId: association.checkpointId, turnId: association.turnId, agentId: association.agentId };
  const input = { projectId: association.projectId, conversationId: association.conversationId,
    messageId: association.messageId, actual: 'wrong file', expected: 'selected file' };
  const options = { captureRoot: root, chatStore: {
    getConversationWithoutMessages: id => id === 'room-a' ? { projectScopeId: 'project-a' } : null,
    getMessage: id => id === message.id ? message : null,
  }, captureStore: { loadCheckpoint: () => checkpoint } };
  const service = createBadcaseFlagService(options);
  const file = path.join(root, 'projects/project-a/flags', `${digest(input.messageId)}.json`);
  const rewrite = mutate => {
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    mutate(envelope.record);
    envelope.checksum = digest(JSON.stringify(envelope.record));
    fs.writeFileSync(file, JSON.stringify(envelope));
  };
  return { root, association, message, checkpoint, input, options, service, file, rewrite };
}

test('first mark freezes all eight seal keys; reconstruction resolves a detached copy without writes', t => {
  const h = setup(t); const result = h.service.mark(h.input);
  assert.deepEqual(result.flag.sealAssociation, h.association);
  const before = fs.readFileSync(h.file);
  const service = createBadcaseFlagService(h.options);
  const resolved = service.resolveSealAssociation(h.input);
  assert.deepEqual(resolved, h.association);
  resolved.taskId = 'caller-mutation';
  assert.deepEqual(service.resolveSealAssociation(h.input), h.association);
  assert.deepEqual(fs.readFileSync(h.file), before);
  assert.equal(service.get(h.input).sealState, 'pending');
  assert.equal(service.get(h.input).captured, false);
});

test('same-text retries never rebind run, checkpoint, turn, agent or task after message mutation', t => {
  for (const key of ['runId', 'checkpointId', 'turnId', 'agentId', 'taskId']) {
    const h = setup(t); const first = h.service.mark(h.input).flag;
    if (key === 'checkpointId') h.message.metadata.badcaseCheckpointId = 'different';
    else h.message[key] = key === 'runId' ? 202 : 'different';
    const before = fs.readFileSync(h.file);
    assert.deepEqual(h.service.mark(h.input).flag, first, key);
    assert.throws(() => h.service.resolveSealAssociation(h.input), code('flag_seal_association_mismatch'), key);
    assert.deepEqual(fs.readFileSync(h.file), before);
  }
});

test('missing or malformed original source keys remain reportable but cannot be retroactively supplied', t => {
  for (const [key, value] of [['taskId', undefined], ['turnId', undefined], ['agentId', undefined],
    ['runId', null], ['taskId', '../outside'], ['taskId', 101]]) {
    const h = setup(t); h.message[key] = value;
    const flag = h.service.mark(h.input).flag;
    assert.equal(flag.sealAssociation, null, key);
    h.message[key] = h.association[key];
    assert.equal(h.service.mark(h.input).flag.sealAssociation, null);
    assert.throws(() => h.service.resolveSealAssociation(h.input), code('flag_seal_association_incomplete'));
  }
});

test('legacy marker without frozen association is readable but never silently upgraded', t => {
  const h = setup(t); h.service.mark(h.input);
  h.rewrite(record => { delete record.sealAssociation; });
  const before = fs.readFileSync(h.file);
  assert.equal(h.service.get(h.input).sealState, 'pending');
  assert.equal(h.service.mark(h.input).created, false);
  assert.throws(() => h.service.resolveSealAssociation(h.input), code('flag_seal_association_incomplete'));
  assert.deepEqual(fs.readFileSync(h.file), before);
});

test('stored association validates shape, exact keys and agreement with immutable marker fields', t => {
  for (const mutate of [
    record => { record.sealAssociation.taskId = '../bad'; },
    record => { record.sealAssociation.runId = '101'; },
    record => { record.sealAssociation.runId = 202; },
    record => { record.sealAssociation.checkpointId = 'other'; },
    record => { record.sealAssociation.projectId = 'other'; },
    record => { record.sealAssociation.conversationId = 'other'; },
    record => { record.sealAssociation.messageId = 'other'; },
    record => { record.sealAssociation.extra = true; },
    record => { delete record.sealAssociation.taskId; },
    record => { record.sealAssociation = []; },
  ]) {
    const h = setup(t); h.service.mark(h.input);
    // Correct checksum: this test exercises semantic validation, not just byte corruption.
    h.rewrite(mutate);
    assert.throws(() => h.service.get(h.input), code('flag_record_invalid'));
    assert.throws(() => h.service.resolveSealAssociation(h.input), code('flag_record_invalid'));
  }
});

test('no marker, nonterminal source and source disappearance fail before yielding a seal association', t => {
  const h = setup(t);
  assert.throws(() => h.service.resolveSealAssociation(h.input), code('flag_not_found'));
  h.service.mark(h.input); h.message.status = 'streaming';
  assert.throws(() => h.service.resolveSealAssociation(h.input), code('flag_message_not_terminal'));
  h.message.status = 'completed'; h.message.id = 'deleted';
  assert.throws(() => h.service.resolveSealAssociation(h.input), code('flag_message_not_found'));
});

test('client supplied association cannot influence or manufacture the frozen association', t => {
  const h = setup(t);
  assert.throws(() => h.service.mark({ ...h.input, sealAssociation: h.association }), code('flag_unknown_field'));
  h.service.mark(h.input);
  assert.deepEqual(h.service.resolveSealAssociation({ ...h.input, taskId: 'forged', sealAssociation: {} }), h.association);
});

test('real SQLite message freezes task identity and resolves identically after store restart', t => {
  const h = setup(t);
  const { createChatAppStore } = require('../../build/lib/chat-app-store');
  const dbOptions = { agentDir: h.root, sqlitePath: path.join(h.root, 'test.sqlite') };
  let chat = createChatAppStore(dbOptions);
  try {
    chat.saveCustomRoleConfig({ id: 'agent-a', name: 'Synthetic', personaPrompt: 'test' });
    chat.createConversation({ id: 'room-a', title: 'Synthetic', participants: ['agent-a'], projectScopeId: 'project-a' });
    chat.createMessage({ ...h.message, content: 'not archived', senderName: 'Synthetic' });
    createBadcaseFlagService({ ...h.options, chatStore: chat }).mark(h.input);
    chat.close(); chat = createChatAppStore(dbOptions);
    const rebuilt = createBadcaseFlagService({ ...h.options, chatStore: chat });
    assert.deepEqual(rebuilt.resolveSealAssociation(h.input), h.association);
    chat.db.prepare('UPDATE chat_messages SET task_id=? WHERE id=?').run('different', 'message-a');
    assert.throws(() => rebuilt.resolveSealAssociation(h.input), code('flag_seal_association_mismatch'));
  } finally { chat.close(); }
});

test('first-marker race uses the winning association rather than losing writer message fields', t => {
  const h = setup(t); const original = fs.linkSync; let raced = false, winner;
  try {
    fs.linkSync = (source, target) => {
      if (!raced && target === h.file) {
        raced = true; h.message.taskId = 'task-winner';
        winner = createBadcaseFlagService(h.options).mark(h.input);
      }
      return original(source, target);
    };
    const loser = h.service.mark(h.input);
    assert.equal(loser.created, false);
    assert.deepEqual(loser.flag, winner.flag);
    assert.equal(loser.flag.sealAssociation.taskId, 'task-winner');
    assert.equal(h.service.resolveSealAssociation(h.input).taskId, 'task-winner');
  } finally { fs.linkSync = original; }
});
