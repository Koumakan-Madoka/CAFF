// Explicit fault experiment only, invoked by the private-daemon Python owner.
// SIGKILL targets the exact child we spawned, never a PID read from an intent.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { archiveImage } = require('./image-archive.cjs');
const { restoreImageArchive } = require('./image-recovery.cjs');
const { archiveRuntime } = require('./runtime-archive.cjs');
const { archiveHarness } = require('./harness-archive.cjs');
const { recoverProbeIntent } = require('./probe-recovery.cjs');
const { runProbe } = require('./verify-pi-initialization.cjs');
const { deadlinePreparation } = require('./verify-scripted-evaluation.cjs');
const { runDockerCommand } = require('../../build/server/domain/runtime/badcase-capture/docker-sandbox');
const { recordEvaluationApproval, dispatchRecordedEvaluation, readEvaluationRecord } = require('../../build/server/domain/runtime/badcase-capture/evaluation-record');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
let stage = 'prepare';
async function child(config) {
  // A pending Promise alone does not keep Node alive; retain IPC for the two
  // deliberately suspended pre-start crash windows until the supervisor kills us.
  process.on('message', () => {});
  const c = JSON.parse(fs.readFileSync(config));
  const prepared = deadlinePreparation()(c.request, c.image, c.sources,
    { baseline: 'Synthetic baseline role.', candidate: 'Synthetic candidate role.' },
    { expectedHash: hash('done\n'), badcaseHash: hash('draft\n') });
  const approval = { confirmed: true, planHash: prepared.plan.planHash, approvalId: c.approvalId, expiresAt: Date.now() + 120000 };
  recordEvaluationApproval(c.recordRoot, prepared.plan.spec, approval);
  await dispatchRecordedEvaluation(c.recordRoot, approval.approvalId, q => prepared.execute(q, (image, files, options) => runProbe(image, files, {
    ...options, recovery: { directory: c.journal, target: c.target },
    observeIntent: async ref => {
      process.send({ kind: 'intent', ref });
      if (c.scenario === 'before-create') await new Promise(() => {});
    },
    observeCreated: async id => {
      process.send({ kind: 'created', id });
      if (c.scenario === 'before-start') await new Promise(() => {});
    },
    runDocker: (args, options) => runDockerCommand(args, { ...options, dockerHost: c.target.socket }),
  })));
  throw Error('fault_child_finished_unexpectedly');
}
async function main() {
  const args = process.argv.slice(2), arg = n => { const i = args.indexOf('--' + n); assert.ok(i >= 0 && args[i + 1]); return args[i + 1]; };
  const image = { imageId: arg('image-id'), repositoryDigest: arg('repository-digest'), architecture: arg('architecture'), nodeVersion: arg('node-version'), pythonVersion: arg('python-version') };
  const target = { socket: arg('socket'), daemonId: arg('daemon-id'), dataRoot: arg('data-root') };
  const root = path.join(target.dataRoot, '..', 'artifacts'); fs.mkdirSync(root, { mode: 0o700 });
  const repo = path.resolve(__dirname, '../..'), cleanup = [], reports = [], ids = [];
  const local = (a, o) => runDockerCommand(a, { ...o, dockerHost: target.socket });
  const journal = path.join(root, 'intents');
  try {
    const ref = await archiveImage(image, path.join(root, 'image'));
    stage = 'restore'; const restored = await restoreImageArchive(ref, target);
    const sources = { runtimeArchive: archiveRuntime(repo, path.join(root, 'runtime')), harnessArchive: archiveHarness(repo, path.join(root, 'harness')) };
    for (const scenario of ['before-create', 'before-start', 'running-fresh', 'running-resume']) {
      stage = scenario;
      const h = require('../../tests/helpers/badcase-initialization-fixture.cjs')({ after: fn => cleanup.push(fn) }, scenario.endsWith('resume') ? 'resume' : 'fresh');
      const original = fs.readFileSync(h.blobPath(h.r.promptBlobHash));
      const approvalId = 'crashed-' + scenario, config = path.join(root, scenario + '.json');
      fs.writeFileSync(config, JSON.stringify({ scenario, image, target, sources, request: h.request, recordRoot: h.root, journal, approvalId }), { flag: 'wx', mode: 0o600 });
      // Minimal environment, no production auth/db; TMPDIR keeps crash-stage residue
      // inside this experiment's private directory, removed by its Python owner.
      const p = fork(__filename, ['--fault-child', config], { execArgv: [], env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, LANG: 'C.UTF-8' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      let intent, id, seenChild = false, failure;
      p.on('message', m => { if (m.kind === 'intent') intent = m.ref; if (m.kind === 'created') id = m.id; });
      p.on('error', () => { failure = true; });
      const exited = once(p, 'exit');
      try {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          assert.ok(!failure && p.exitCode === null && p.signalCode === null, 'fault_child_exited_early');
          if (scenario === 'before-create' && intent) break;
          if (scenario === 'before-start' && id) break;
          if (scenario.startsWith('running') && id) {
            const top = await local(['top', id, '-eo', 'pid,ppid,args']);
            if (top.code === 0 && !top.failure && top.stdout.includes('caff-deadline-child')) { seenChild = true; break; }
          }
          await new Promise(r => setTimeout(r, 50));
        }
        assert.ok(intent); if (scenario !== 'before-create') assert.match(id, /^[a-f0-9]{64}$/);
        if (scenario.startsWith('running')) assert.equal(seenChild, true);
        stage = 'reserved'; const before = readEvaluationRecord(h.root, approvalId);
        assert.equal(before.dispatchState, 'unresolved'); assert.equal(before.ledger.runs.length, 1);
        assert.equal(before.ledger.runs[0].status, 'reserved'); assert.equal(before.ledger.committedMicroUsd, 1);
        const pins = fs.readdirSync(h.runDir).sort(); assert.equal(pins.length, 2);
        assert.equal(p.kill('SIGKILL'), true);
        const [code, signal] = await exited; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
        let killCount = 0;
        stage = 'recover'; const recovered = await recoverProbeIntent(intent, target, { schedulerStopped: true, runDocker: async (a, o) => {
          if (a[0] === 'kill') killCount++;
          return runDockerCommand(a, o);
        } });
        stage = 'evidence'; assert.equal(recovered.containerId, id || null); assert.equal(recovered.executionState, 'unknown'); assert.equal(recovered.resultSettled, false);
        assert.equal(killCount, scenario.startsWith('running') ? 1 : 0);
        assert.deepEqual(readEvaluationRecord(h.root, approvalId), before);
        assert.deepEqual(fs.readdirSync(h.runDir).sort(), pins);
        assert.deepEqual(fs.readFileSync(h.blobPath(h.r.promptBlobHash)), original);
        await assert.rejects(dispatchRecordedEvaluation(h.root, approvalId, () => assert.fail('replay')), /evaluation_already_consumed/);
        const again = await recoverProbeIntent(intent, target, { schedulerStopped: true }); assert.equal(again.containerId, null);
        if (id) ids.push(id);
        reports.push({ scenario, schedulerExitSignal: signal, childObserved: seenChild, killCount, ...recovered,
          dispatchState: before.dispatchState, committedMicroUsd: before.ledger.committedMicroUsd, protectedReferences: pins.length, recordUnchanged: true });
      } finally {
        if (p.exitCode === null && p.signalCode === null) { p.kill('SIGKILL'); await exited; }
      }
    }
    assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 3);
    console.log(JSON.stringify({ ok: true, identity: restored.identity, archiveBytes: ref.archiveBytes, reports, cleanedContainerIds: ids,
      realModelInvocations: 0, acceptance: false, faithfulReplay: false, artifactsRetainedAfterExperiment: false }));
  } finally { for (const fn of cleanup.reverse()) fn(); }
}
if (require.main === module) (process.argv[2] === '--fault-child' ? child(process.argv[3]) : main()).catch(() => {
  console.error('probe_recovery_verification_failed:' + stage); process.exitCode = 1;
});
