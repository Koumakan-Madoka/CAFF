const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBadcaseFlagService } = require('../../build/server/domain/runtime/badcase-capture/badcase-flags');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-flags-'));
  let beforeCleanup = () => {};
  t.after(() => { beforeCleanup(); fs.rmSync(root, { recursive: true, force: true }); });
  const conversation = { id: 'room-a', projectScopeId: 'project-a' };
  const message = { id: 'message-a', conversationId: 'room-a', role: 'assistant', status: 'completed',
    turnId: 'turn-a', agentId: 'agent-a', runId: 101, metadata: { badcaseCheckpointId: 'checkpoint-a' },
    content: 'not archived by a flag' };
  let checkpoint = { checkpointId: 'checkpoint-a', projectId: 'project-a', conversationId: 'room-a', turnId: 'turn-a', agentId: 'agent-a' };
  let reads = 0;
  const options = { captureRoot: root, chatStore: {
    getConversationWithoutMessages: id => id === conversation.id ? conversation : null,
    getMessage: id => id === message.id ? message : null,
  }, captureStore: { loadCheckpoint: () => { reads++; return checkpoint; } } };
  const input = { projectId: 'project-a', conversationId: 'room-a', messageId: 'message-a', actual: 'used the wrong file', expected: 'use the selected file' };
  const service = createBadcaseFlagService(options);
  return { root, service, input, options, conversation, message, cleanup: callback => { beforeCleanup = callback; }, reads: () => reads, checkpoint: value => { checkpoint = value; },
    records: () => fs.existsSync(path.join(root, 'projects/project-a/flags')) ? fs.readdirSync(path.join(root, 'projects/project-a/flags')).filter(n => n.endsWith('.json')) : [] };
}
const rejected = code => error => error.code === code;

test('flag persists derived association but explicitly does not claim sealing or reproduction', t => {
  const h = setup(t); const result = h.service.mark(h.input);
  assert.equal(result.created, true);
  assert.equal(result.flag.runId, 101); assert.equal(result.flag.checkpointId, 'checkpoint-a');
  assert.equal(result.flag.checkpointState, 'manifest_present_unverified');
  assert.equal(result.flag.sealState, 'pending'); assert.equal(result.flag.captured, false);
  assert.equal(result.flag.runnable, false); assert.equal(result.flag.reproduced, false); assert.equal(result.flag.evaluable, false);
  assert.ok(result.flag.missingEvidence.includes('checkpoint_not_sealed'));
  assert.ok(result.flag.missingEvidence.includes('trajectory_not_archived'));
  assert.equal(result.flag.actual, h.input.actual);
  const rebuilt = createBadcaseFlagService(h.options);
  assert.deepEqual(rebuilt.get(h.input), result.flag);
  assert.equal(h.records().length, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(h.root, 'projects/project-a/flags', h.records()[0]), 'utf8'), /not archived by a flag/);
});
test('identical retry, including a rebuilt service, returns the immutable original without another checkpoint read', t => {
  const h = setup(t); const first = h.service.mark(h.input); const reads = h.reads();
  h.message.runId = 202; h.checkpoint(null);
  const repeated = createBadcaseFlagService(h.options).mark(h.input);
  assert.equal(repeated.created, false); assert.deepEqual(repeated.flag, first.flag);
  assert.equal(h.reads(), reads); assert.equal(h.records().length, 1);
  assert.throws(() => h.service.mark({ ...h.input, actual: 'changed annotation' }), rejected('flag_already_exists'));
});
test('history without checkpoint and missing manifest are markable but never reported as captured', t => {
  for (const kind of ['none', 'missing']) {
    const h = setup(t); if (kind === 'none') delete h.message.metadata.badcaseCheckpointId; else h.checkpoint(null);
    const { flag } = h.service.mark(h.input);
    assert.equal(flag.checkpointState, kind === 'none' ? 'not_recorded' : 'missing_or_unreadable');
    assert.equal(flag.captured, false); assert.equal(flag.sealState, 'pending');
    if (kind === 'none') assert.equal(h.reads(), 0);
  }
});
test('synchronous start failure may have null run ID without inventing one', t => {
  const h = setup(t); h.message.runId = null; h.message.status = 'failed';
  const { flag } = h.service.mark(h.input); assert.equal(flag.runId, null); assert.equal(flag.checkpointId, 'checkpoint-a');
});
test('reject client-supplied association and unsafe or aliased identifiers before persistence', t => {
  const h = setup(t);
  for (const extra of [{ runId: 'fake' }, { checkpointId: 'fake' }, { captured: true }]) {
    assert.throws(() => h.service.mark({ ...h.input, ...extra }), rejected('flag_unknown_field'));
  }
  for (const projectId of ['..', '.', '../x', 'project/a', ' project-a', '', 'a'.repeat(129)]) {
    assert.throws(() => h.service.mark({ ...h.input, projectId }), rejected('flag_invalid_identifier'));
  }
  assert.equal(h.records().length, 0); assert.equal(h.reads(), 0);
});
test('project/message ownership and terminal assistant requirements are authoritative', t => {
  for (const change of [h => { h.conversation.projectScopeId = 'other'; }, h => { h.message.conversationId = 'other'; },
    h => { h.message.role = 'user'; }, h => { h.message.status = 'streaming'; }]) {
    const h = setup(t); change(h); assert.throws(() => h.service.mark(h.input));
    assert.equal(h.records().length, 0); assert.equal(h.reads(), 0);
  }
});
test('checkpoint identity, project, conversation, turn and agent must match before association is recorded', t => {
  for (const field of ['checkpointId', 'projectId', 'conversationId', 'turnId', 'agentId']) {
    const h = setup(t); const checkpoint = { checkpointId: 'checkpoint-a', projectId: 'project-a', conversationId: 'room-a', turnId: 'turn-a', agentId: 'agent-a', [field]: 'other' };
    h.checkpoint(checkpoint);
    assert.throws(() => h.service.mark(h.input), rejected('flag_checkpoint_mismatch')); assert.equal(h.records().length, 0);
  }
});
test('annotations reject missing text, NUL, oversize and secret sentinels without storing content', t => {
  const h = setup(t);
  for (const actual of ['', '   ', 42, 'a\0b', '字'.repeat(3000), 'sk-FAKE_SENTINEL_123456']) {
    assert.throws(() => h.service.mark({ ...h.input, actual }));
  }
  assert.equal(h.records().length, 0); assert.equal(h.reads(), 0);
});
test('real SQLite message uses numeric run ID and survives store/service restart', t => {
  const h = setup(t);
  const { createChatAppStore } = require('../../build/lib/chat-app-store');
  const dbOptions = { agentDir: h.root, sqlitePath: path.join(h.root, 'chat.sqlite') };
  let chat = createChatAppStore(dbOptions);
  h.cleanup(() => chat.close());
  const agent = chat.saveCustomRoleConfig({ id: 'agent-a', name: 'Flag test', personaPrompt: 'test' });
  chat.createConversation({ id: 'room-a', title: 'Flags', participants: [agent.id], projectScopeId: 'project-a' });
  chat.createMessage({ ...h.message, runId: 101 });
  const { createCaptureStore } = require('../../build/server/domain/runtime/badcase-capture/capture-store');
  const captureStore = createCaptureStore({ captureRoot: h.root });
  captureStore.saveCheckpoint('project-a', { checkpointId: 'checkpoint-a', projectId: 'project-a', conversationId: 'room-a', turnId: 'turn-a', agentId: agent.id });
  const options = { ...h.options, chatStore: chat, captureStore };
  const first = createBadcaseFlagService(options).mark(h.input);
  assert.equal(first.flag.runId, 101);
  chat.close(); chat = createChatAppStore(dbOptions);
  const rebuilt = createBadcaseFlagService({ ...options, chatStore: chat });
  assert.deepEqual(rebuilt.get(h.input), first.flag);
  assert.equal(rebuilt.mark(h.input).created, false);
});
test('disk publication failure cannot report success and leaves no partial record; retry succeeds', t => {
  const h = setup(t); const original = fs.linkSync;
  try {
    fs.linkSync = (source, target) => {
      if (String(target).startsWith(h.root)) throw Object.assign(new Error('synthetic disk failure'), { code: 'ENOSPC' });
      return original(source, target);
    };
    assert.throws(() => h.service.mark(h.input), rejected('flag_write_failed'));
    assert.equal(h.records().length, 0);
    assert.deepEqual(fs.readdirSync(path.join(h.root, 'projects/project-a/flags')), []);
  } finally { fs.linkSync = original; }
  assert.equal(h.service.mark(h.input).created, true);
});
test('publication race converges on one record, with conflict instead of overwrite for different text', t => {
  for (const conflict of [false, true]) {
    const h = setup(t); const original = fs.linkSync; let winner; let raced = false;
    try {
      fs.linkSync = (source, target) => {
        if (!raced && String(target).startsWith(h.root)) {
          raced = true;
          winner = createBadcaseFlagService(h.options).mark({ ...h.input, actual: conflict ? 'concurrent annotation' : h.input.actual });
        }
        return original(source, target);
      };
      if (conflict) assert.throws(() => h.service.mark(h.input), rejected('flag_already_exists'));
      else { const loser = h.service.mark(h.input); assert.equal(loser.created, false); assert.deepEqual(loser.flag, winner.flag); }
    } finally { fs.linkSync = original; }
    assert.equal(winner.created, true); assert.equal(h.records().length, 1);
    assert.deepEqual(h.service.get(h.input), winner.flag);
    assert.equal(fs.readdirSync(path.join(h.root, 'projects/project-a/flags')).length, 1, 'no temporary files remain');
  }
});
test('invalid authoritative run IDs fail rather than being silently converted to null', t => {
  for (const runId of [0, -1, NaN, 1.2, '101']) {
    const h = setup(t); h.message.runId = runId;
    assert.throws(() => h.service.mark(h.input), rejected('flag_invalid_run_id'));
    assert.equal(h.records().length, 0);
  }
});
test('corrupt persisted record is not overwritten or treated as absent', t => {
  const h = setup(t); h.service.mark(h.input);
  const file = path.join(h.root, 'projects/project-a/flags', h.records()[0]);
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8')); envelope.record.actual = 'silently changed';
  fs.writeFileSync(file, JSON.stringify(envelope));
  assert.throws(() => h.service.mark(h.input), rejected('flag_record_invalid'));
  assert.throws(() => h.service.get(h.input), rejected('flag_record_invalid'));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).record.actual, 'silently changed');
});
