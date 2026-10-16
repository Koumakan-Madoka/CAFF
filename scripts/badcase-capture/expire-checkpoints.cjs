// Trusted offline operator entry. Stop capture, turns, sealing and replay writers
// before --writers-stopped; this is an assertion, not process liveness detection.
const { inspectCheckpointExpiry, expireCheckpoints } = require('../../build/server/domain/runtime/badcase-capture/orphan-gc');
const allowed = new Set(['checkpoint_expiry_invalid', 'checkpoint_expiry_inventory_invalid', 'checkpoint_expiry_plan_changed',
  'checkpoint_expiry_delete_failed', 'checkpoint_expiry_lock_release_failed', 'orphan_gc_invalid', 'orphan_gc_inventory_invalid',
  'capture_writer_busy', 'capture_lock_invalid']);
const invalid = () => { throw Object.assign(Error(), { code: 'checkpoint_expiry_invalid' }); };
function main(argv) {
  if (![10, 14].includes(argv.length) || argv[0] !== '--capture-root' || argv[2] !== '--project' || argv[4] !== '--as-of'
    || argv[6] !== '--retention-days' || argv[8] !== '--quota-bytes'
    || !/^[1-9][0-9]*$/.test(argv[7]) || !/^[1-9][0-9]*$/.test(argv[9])
    || (argv.length === 14 && (argv[10] !== '--expire' || argv[12] !== '--confirm' || argv[13] !== '--writers-stopped'))) invalid();
  const q = { captureRoot: argv[1], projectId: argv[3] };
  const rules = { asOf: argv[5], retentionDays: Number(argv[7]), quotaBytes: Number(argv[9]) };
  return argv.length === 10 ? inspectCheckpointExpiry(q, rules)
    : expireCheckpoints(q, rules, { expected: argv[11], confirmed: true, writersStopped: true });
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify({ ok: true, result: main(process.argv.slice(2)) }) + '\n'); }
  catch (e) {
    const result = { ok: false, code: allowed.has(e.code) ? e.code : 'checkpoint_expiry_inventory_invalid' };
    if (Number.isSafeInteger(e.deletedCheckpointCount) && Number.isSafeInteger(e.reclaimedManifestBytes)) {
      result.deletedCheckpointCount = e.deletedCheckpointCount; result.reclaimedManifestBytes = e.reclaimedManifestBytes;
    }
    process.stderr.write(JSON.stringify(result) + '\n'); process.exitCode = 1;
  }
}
module.exports = { main };
