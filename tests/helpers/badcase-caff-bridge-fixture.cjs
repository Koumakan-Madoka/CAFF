// Synthetic sealed input through existing retention, NOT historical capture.
const fixture = require('./badcase-caff-replay-fixture.cjs');
const crypto = require('node:crypto');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
module.exports = function bridgeFixture(t, mode = 'fresh', platform = 'linux', change = () => {}) {
  const association = { projectId: 'p1', conversationId: 'c1', turnId: 't1', agentId: 'a1', userMessageId: 'user1', assistantMessageId: 'msg1' };
  let trace;
  const v = fixture(t, mode, platform, ({ cp, r, config, session, put }) => {
    config.agentName = 'Archived Agent';
    trace = { schemaVersion: 1, kind: 'caff-evaluation-callback-input-v1', association,
      assistantCreatedAt: '2026-01-01T00:00:03.000Z',
      conversation: { title: 'Retained callback Room', type: 'standard', metadata: { marker: 'RETAINED_ROOM' } },
      participants: [{ id: 'a1', name: config.agentName, description: 'Retained agent' }], publicMessages: [
        { id: 'prior1', turnId: 'prior-turn', role: 'assistant', agentId: 'a1', senderName: config.agentName,
          content: 'Archived reply.', status: 'completed', createdAt: '2026-01-01T00:00:01.000Z',
          publicPostedAt: '2026-01-01T00:00:01.000Z', publicPostCount: 1, publicPostMode: 'replace', mentions: [] },
        { id: 'user1', turnId: 'accepted-A', role: 'user', agentId: null, senderName: 'Original User', content: 'Inspect the worktree.',
          status: 'completed', createdAt: '2026-01-01T00:00:02.000Z', publicPostedAt: '', publicPostCount: 0, publicPostMode: '', mentions: [] },
      ], privateMessages: [], pendingDelegations: [] };
    change({ cp, r, config, trace, session, put });
    const raw = JSON.stringify(trace);
    r.callbackInput = { schemaVersion: 1, kind: 'caff-evaluation-callback-input-reference-v1', blobHash: put(raw), association: { ...association } };
    if (hash(raw) !== r.callbackInput.blobHash) throw Error('fixture_hash');
  });
  return { ...v, association: { ...association }, trace };
};
