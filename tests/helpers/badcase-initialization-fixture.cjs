// Synthetic sealed inputs only. No project authorization, SDK or real capture.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCaptureStore, sha256Hex: hash } = require('../../build/server/domain/runtime/badcase-capture/capture-store');
const { saveSealedCase } = require('../../build/server/domain/runtime/badcase-capture/sealed-case');
module.exports = function fixture(t, mode = 'fresh', change = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-retained-init-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createCaptureStore({ captureRoot: root });
  const put = value => { const bytes = Buffer.from(value); const h = hash(bytes); store.writeBlob('p1', h, bytes); return h; };
  const session = [
    { type: 'session', version: 3, id: 'synthetic-session', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/historical/not-mounted' },
    { type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:00.001Z', message: { role: 'user', content: 'synthetic retained history', timestamp: 1 } },
  ];
  const config = { piVersion: 'pi:0.85.1', agentPromptVersion: 'v1', toolBridgeEnabled: false, deliveryMode: mode, agentName: 'synthetic' };
  const r = { deliveryMode: mode, complete: true, incompleteReasons: [], verifiedDimensions: [], unverifiedDimensions: [],
    invocationImageCount: 0, controlledReplacements: [], promptBlobHash: put('synthetic retained invocation'),
    sessionBlobHash: mode === 'resume' ? put(session.map(e => JSON.stringify(e)).join('\n') + '\n') : '',
    runConfig: { provider: 'anthropic', model: 'claude-sonnet-4-5', promptVersion: 'v1', skillIds: [], conversationSkillIds: [] },
    harness: { serverVersion: 'synthetic-v1', configSnapshotHash: put(JSON.stringify(config)), skillSnapshots: [] } };
  r.normalizedPromptHash = r.promptBlobHash;
  const cp = { schemaVersion: 1, projectId: 'p1', checkpointId: 'cp1', conversationId: 'c1', turnId: 't1', agentId: 'a1',
    files: { 'source.txt': { type: 'file', size: 14, hash: put('retained bytes') } }, deletions: ['deleted.txt'], uncaptured: [], targetDir: '/historical/not-mounted', replayInput: r };
  change({ r, cp, config, session, put });
  store.saveCheckpoint('p1', cp);
  const association = { projectId: 'p1', checkpointId: 'cp1', conversationId: 'c1', messageId: 'msg1', turnId: 't1', agentId: 'a1', taskId: 'task1', runId: 1 };
  const request = { captureRoot: root, association, flagId: 'flag-' + hash('p1\0msg1'), replayRunId: 'init-run' };
  saveSealedCase({ captureRoot: root, association, flagId: request.flagId });
  return { root, request, store, cp, r, put, source: path.join(root, 'projects/p1/retention', hash(request.flagId) + '.json'),
    runDir: path.join(root, 'projects/p1/runReferences'), blobPath: h => path.join(root, 'projects/p1/blobs', h.slice(0, 2), h) };
};
