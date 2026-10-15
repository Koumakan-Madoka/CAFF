// Explicit synthetic-only real Docker evidence. No capture enabling, model calls or user cases.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const fixture = require('../../tests/helpers/badcase-initialization-fixture.cjs');
const { prepareRetainedInitializationCapsule } = require('../../build/server/domain/runtime/badcase-capture/retained-initialization');
const { runRetainedSdkDiagnostic, stageDiagnostic } = require('./retained-sdk-diagnostic.cjs');
const { runProbe, verifyProbeImage } = require('./verify-pi-initialization.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
async function main() {
  if (process.platform !== 'linux') throw Error('linux_required');
  const args = process.argv.slice(2);
  const arg = name => { const i = args.indexOf('--' + name); if (i < 0 || !args[i + 1]) throw Error('arguments_required'); return args[i + 1]; };
  const image = { imageId: arg('image-id'), repositoryDigest: arg('repository-digest'), architecture: arg('architecture'), nodeVersion: arg('node-version'), pythonVersion: arg('python-version') };
  await verifyProbeImage(image);
  const cleanup = [], reports = [], ids = [];
  try {
    for (const mode of ['fresh', 'resume']) {
      const h = fixture({ after: fn => cleanup.push(fn) }, mode, ({ cp, put }) => {
        for (const [name, text] of [['.pi/extensions/trap.js', 'throw Error("discovery forbidden")'], ['AGENTS.md', 'Unapproved discovery trap']]) {
          cp.files[name] = { type: 'file', size: Buffer.byteLength(text), hash: put(text) };
        }
      });
      fs.unlinkSync(path.join(h.root, 'projects/p1/checkpoints/cp1.json'));
      const a = await runRetainedSdkDiagnostic(h.request, image);
      const b = await runRetainedSdkDiagnostic({ ...h.request, replayRunId: 'copy-b' }, image);
      for (const k of ['capsuleHash', 'checkpointChecksum', 'materializedHash', 'inputHash', 'historyHash', 'invocationHash']) assert.equal(a[k], b[k]);
      assert.notEqual(a.containerId, b.containerId); assert.equal(a.deliveryMode, mode);
      assert.equal(fs.readdirSync(h.runDir).length, 2); ids.push(a.containerId, b.containerId);
      reports.push({ mode, capsuleHash: a.capsuleHash, inputHash: a.inputHash, runtimeHash: a.runtimeHash,
        historyHash: a.historyHash, invocationHash: a.invocationHash, historyMessages: a.historyMessages,
        archivedSessionBytesUnchanged: a.archivedSessionBytesUnchanged,
        workingSessionAppendedThinkingOff: a.workingSessionAppendedThinkingOff, sdkInitialized: a.sdkInitialized,
        missingOpenCreatesEmptySession: a.missingOpenCreatesEmptySession, protectedReferences: 2 });
      const p = prepareRetainedInitializationCapsule(h.request);
      for (const blob of JSON.parse(p.capsule).blobs) assert.equal(hash(h.store.readBlob('p1', blob.sha256)), blob.sha256);
      if (mode !== 'resume') continue;
      for (const scenario of ['wrong-capsule-hash', 'missing-session', 'bridge-required', 'unknown-model', 'wrong-sdk-version',
        'observation-archive', 'observation-working', 'observation-missing-entries', 'observation-missing-context', 'observation-missing-id']) {
        const data = JSON.parse(p.capsule), r = data.checkpoint.replayInput;
        if (scenario === 'missing-session') r.sessionBlobHash = '';
        if (scenario === 'unknown-model') r.runConfig.model = 'synthetic-model-not-in-catalog';
        if (scenario === 'bridge-required') {
          const blob = data.blobs.find(b => b.sha256 === r.harness.configSnapshotHash);
          const config = JSON.parse(Buffer.from(blob.base64, 'base64')); config.toolBridgeEnabled = true;
          const text = JSON.stringify(config); blob.sha256 = hash(text); blob.base64 = Buffer.from(text).toString('base64');
          r.harness.configSnapshotHash = blob.sha256;
        }
        const capsule = JSON.stringify(data);
        const expected = { capsuleHash: scenario === 'wrong-capsule-hash' ? '0'.repeat(64) : hash(capsule), checkpointChecksum: hash(JSON.stringify(data.checkpoint)) };
        const files = stageDiagnostic(capsule, expected, image);
        if (scenario === 'wrong-sdk-version') {
          const file = files.find(f => f.path === 'runtime/package.json'); const pkg = JSON.parse(file.bytes); pkg.version = '999.0.0'; file.bytes = Buffer.from(JSON.stringify(pkg));
        }
        if (scenario.startsWith('observation-')) {
          // Synthetic fault injection into a trusted staged harness AFTER real SDK
          // initialization, never a production override or captured code entry point.
          const inject = {
            'observation-archive': "observations.archivedSessionBytes = Buffer.from('changed archive');",
            'observation-working': "observations.workingSessionBytes = Buffer.from(plan.sessionText);",
            'observation-missing-entries': 'observations.missingEntries = [{}];',
            'observation-missing-context': 'observations.missingMessages = [{}];',
            'observation-missing-id': "observations.missingSessionId = '';",
          }[scenario];
          const probe = files.find(f => f.path === 'probe.cjs'), source = probe.bytes.toString();
          const anchor = 'const receipt = observedDiagnosticReceipt(plan, observations);';
          assert.equal(source.split(anchor).length, 2, 'fault hook must match exactly once');
          probe.bytes = Buffer.from(source.replace(anchor, inject + '\n    ' + anchor));
        }
        const run = await runProbe(image, files);
        assert.equal(run.result.code, 1); assert.equal(run.result.failure, undefined);
        assert.equal(run.result.stdout, ''); assert.equal(run.result.stderr, 'retained_sdk_diagnostic_failed\n');
        ids.push(run.containerId); reports.push({ scenario, blockedInContainer: true });
        assert.equal(fs.readdirSync(h.runDir).length, 2);
      }
      for (const blob of JSON.parse(p.capsule).blobs) assert.equal(hash(h.store.readBlob('p1', blob.sha256)), blob.sha256);
    }
    assert.equal(new Set(ids).size, 14);
    console.log(JSON.stringify({ ok: true, image, reports, cleanedContainerIds: ids, modelInvocations: 0,
      diagnosticSystemPrompt: true, invocationSubmitted: false, imageArchived: false, acceptance: false }, null, 2));
  } finally { for (const fn of cleanup.reverse()) fn(); }
}
if (require.main === module) main().catch(e => { console.error(JSON.stringify({ ok: false, code: 'retained_sdk_verification_failed', containerName: e.containerName || null })); process.exitCode = 1; });
