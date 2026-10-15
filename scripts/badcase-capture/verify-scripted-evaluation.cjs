// Only invoked by the authorized isolated-daemon Python lifecycle.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { archiveImage } = require('./image-archive.cjs');
const { restoreImageArchive } = require('./image-recovery.cjs');
const { archiveRuntime } = require('./runtime-archive.cjs');
const { archiveHarness } = require('./harness-archive.cjs');
const { prepareScriptedEvaluation } = require('./scripted-evaluation.cjs');
const { runProbe } = require('./verify-pi-initialization.cjs');
// Fault-only trusted harness variant, pinned BEFORE planning/approval. Do not
// mutate the shared source or lie about the original manifest after execution.
function deadlinePreparation() {
  const Module = require('node:module'), filename = require.resolve('./scripted-evaluation.cjs');
  const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  const nativeRequire = m.require.bind(m), taskPath = path.join(__dirname, 'scripted-task-container.cjs');
  const original = fs.readFileSync(taskPath, 'utf8');
  const blocked = original.replace("command: 'cat evaluation-result.txt', timeout: 5",
    'command: ' + JSON.stringify("sh -c 'trap \"\" TERM; while :; do sleep 1; done' caff-deadline-child") + ', timeout: 60');
  assert.notEqual(blocked, original);
  m.require = name => name === 'node:fs' ? { ...fs, readFileSync(p, ...args) {
    return p === taskPath ? Buffer.from(blocked) : fs.readFileSync(p, ...args);
  } } : nativeRequire(name);
  m._compile(fs.readFileSync(filename, 'utf8'), filename);
  return m.exports.prepareScriptedEvaluation;
}
const { recordEvaluationApproval, dispatchRecordedEvaluation, readEvaluationRecord } = require('../../build/server/domain/runtime/badcase-capture/evaluation-record');
const fixture = require('../../tests/helpers/badcase-initialization-fixture.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
async function main() {
  const args = process.argv.slice(2), arg = n => { const i = args.indexOf('--' + n); assert.ok(i >= 0 && args[i + 1]); return args[i + 1]; };
  const image = { imageId: arg('image-id'), repositoryDigest: arg('repository-digest'), architecture: arg('architecture'), nodeVersion: arg('node-version'), pythonVersion: arg('python-version') };
  const target = { socket: arg('socket'), daemonId: arg('daemon-id'), dataRoot: arg('data-root') };
  const root = path.join(target.dataRoot, '..', 'artifacts'); fs.mkdirSync(root, { mode: 0o700 });
  const repo = path.resolve(__dirname, '../..'), cleanup = [], ids = [], reports = [];
  try {
    const ref = await archiveImage(image, path.join(root, 'image'));
    const restored = await restoreImageArchive(ref, target);
    const sources = { runtimeArchive: archiveRuntime(repo, path.join(root, 'runtime')), harnessArchive: archiveHarness(repo, path.join(root, 'harness')) };
    for (const scenario of ['fresh', 'resume', 'expired-in-container', 'skipped-prompt', 'bad-receipt', 'deadline-fresh', 'deadline-resume']) {
      const deadline = scenario.startsWith('deadline-');
      const h = fixture({ after: fn => cleanup.push(fn) }, scenario.endsWith('resume') ? 'resume' : 'fresh');
      fs.unlinkSync(path.join(h.root, 'projects/p1/checkpoints/cp1.json'));
      const originalBlob = fs.readFileSync(h.blobPath(h.r.promptBlobHash));
      const prepare = deadline ? deadlinePreparation() : prepareScriptedEvaluation;
      const prepared = prepare(h.request, image, sources,
        { baseline: 'Synthetic baseline role.', candidate: 'Synthetic candidate role.' },
        { expectedHash: hash('done\n'), badcaseHash: hash('draft\n') });
      const approval = { confirmed: true, planHash: prepared.plan.planHash, approvalId: 'scripted-' + scenario, expiresAt: Date.now() + 120000 };
      recordEvaluationApproval(h.root, prepared.plan.spec, approval);
      let validatedTransports = 0, killCommands = 0, childObserved = false, durationMs = null;
      const report = await dispatchRecordedEvaluation(h.root, approval.approvalId, request => prepared.execute(request, async (img, files, options) => {
        assert.deepEqual(options, { timeoutMs: prepared.plan.spec.timeoutMs });
        if (scenario === 'expired-in-container') {
          const f = files.find(f => f.path === 'task.json'), q = JSON.parse(f.bytes); q.expiresAt = 0; f.bytes = Buffer.from(JSON.stringify(q));
        }
        if (scenario === 'skipped-prompt') {
          const f = files.find(f => f.path === 'probe.cjs'), before = f.bytes.toString();
          const after = before.replace('await session.prompt(plan.invocation, { expandPromptTemplates: false });', '/* fault: no prompt */');
          assert.notEqual(after, before); f.bytes = Buffer.from(after);
        }
        const before = performance.now();
        const run = await restored.runProbe(img, files, { ...options, ...(deadline ? { probe: (i, f, o) => runProbe(i, f, {
          ...o, runDocker: async (a, opts) => {
            if (a[0] === 'kill') {
              const top = await o.runDocker(['top', a[1], '-eo', 'pid,ppid,args']);
              assert.equal(top.code, 0); assert.equal(top.failure, undefined);
              assert.ok(top.stdout.includes('caff-deadline-child'), 'deadline_child_not_observed');
              childObserved = true; killCommands++;
            }
            return o.runDocker(a, opts);
          },
        }) } : {}) });
        durationMs = Math.round(performance.now() - before); ids.push(run.containerId);
        if (deadline) {
          assert.deepEqual(run.termination, { reason: 'deadline', timeoutMs: 25000, stopped: true, removed: true });
          assert.equal(run.result.failure, 'timeout'); assert.equal(run.result.stdout, ''); assert.equal(run.result.stderr, '');
          assert.equal(killCommands, 1); assert.equal(childObserved, true); assert.ok(durationMs >= 25000);
        } else if (['expired-in-container', 'skipped-prompt'].includes(scenario)) {
          assert.equal(run.result.code, 1); assert.equal(run.result.stdout, ''); assert.equal(run.result.stderr, 'scripted_sdk_task_failed\n');
        } else {
          assert.equal(run.result.code, 0); assert.equal(run.result.stderr, '');
          const receipt = JSON.parse(run.result.stdout); assert.equal(receipt.scriptCalls, 5);
          if (scenario === 'bad-receipt') {
            // Tamper only with a completed real container's return receipt, not
            // its manifest, so this specifically tests host receipt validation.
            receipt.scriptCalls = 0; run.result.stdout = JSON.stringify(receipt) + '\n';
          }
        }
        validatedTransports++; return run;
      }));
      assert.equal(validatedTransports, ['fresh', 'resume'].includes(scenario) ? 2 : 1);
      assert.deepEqual(readEvaluationRecord(h.root, approval.approvalId), report);
      if (['fresh', 'resume'].includes(scenario)) {
        assert.equal(report.ledger.state, 'complete'); assert.equal(report.ledger.runs.length, 2);
        assert.equal(report.ledger.summary.baseline.expectationMet, 1); assert.equal(report.ledger.summary.candidate.expectationMet, 1);
        assert.equal(report.ledger.summary.baseline.reproduced, 0); assert.equal(report.ledger.summary.candidate.reproduced, 0);
        assert.equal(fs.readdirSync(h.runDir).length, 3);
      } else if (deadline) {
        assert.equal(report.ledger.runs.length, 1); assert.equal(report.ledger.runs[0].status, 'timed_out');
        assert.equal(report.ledger.runs[0].score, null); assert.equal(report.ledger.runs[0].costMicroUsd, null);
        assert.equal(report.ledger.committedMicroUsd, 1); assert.equal(report.ledger.stopReason, 'cost_unknown');
      } else { assert.equal(report.reason, 'dispatch_failed'); assert.equal(report.dispatchState, 'unresolved'); assert.equal(report.ledger.runs.length, 1); }
      assert.deepEqual(fs.readFileSync(h.blobPath(h.r.promptBlobHash)), originalBlob);
      await assert.rejects(dispatchRecordedEvaluation(h.root, approval.approvalId, () => assert.fail('repeat')), /evaluation_already_consumed/);
      reports.push({ scenario, ...(deadline ? { killCommands, childObserved, durationMs, timeoutMs: 25000 } : {}),
        dispatchState: report.dispatchState, reason: report.reason, model: report.ledger.spec.model,
        inputHash: report.ledger.spec.inputHash, harnessHash: report.ledger.spec.harnessHash,
        summary: report.ledger.summary, runs: report.ledger.runs, protectedReferences: fs.readdirSync(h.runDir).length });
    }
    assert.equal(new Set(ids).size, 9);
    console.log(JSON.stringify({ ok: true, kind: 'offline-scripted-evaluation', identity: restored.identity, archiveBytes: ref.archiveBytes,
      reports, cleanedContainerIds: ids, realModelInvocations: 0, acceptance: false, faithfulReplay: false,
      scoring: 'host-file-sha256-v1', sourceBlobsUnchanged: true, artifactsRetainedAfterExperiment: false }));
  } finally { for (const fn of cleanup.reverse()) fn(); }
}
if (require.main === module) main().catch(() => { console.error('scripted_evaluation_verification_failed'); process.exitCode = 1; });
