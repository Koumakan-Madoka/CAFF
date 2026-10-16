// Explicit trusted local operator entry; never called by the server or agents.
// Preview holds a temporary writer lease but does not delete material. Collection
// needs the exact preview digest and confirmation; changes require a new preview.
const { inspectOrphanBlobs, collectOrphanBlobs } = require('../../build/server/domain/runtime/badcase-capture/orphan-gc');
const allowed = new Set(['orphan_gc_invalid', 'orphan_gc_inventory_invalid', 'orphan_gc_plan_changed',
  'orphan_gc_delete_failed', 'orphan_gc_lock_release_failed', 'capture_writer_busy', 'capture_lock_invalid']);
function main(argv) {
  if (![4, 7].includes(argv.length) || argv[0] !== '--capture-root' || argv[2] !== '--project'
    || (argv.length === 7 && (argv[4] !== '--collect' || argv[6] !== '--confirm'))) throw Object.assign(Error(), { code: 'orphan_gc_invalid' });
  const q = { captureRoot: argv[1], projectId: argv[3] };
  return argv.length === 4 ? inspectOrphanBlobs(q) : collectOrphanBlobs(q, { confirmed: true, expected: argv[5] });
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify({ ok: true, result: main(process.argv.slice(2)) }) + '\n'); }
  catch (e) {
    const result = { ok: false, code: allowed.has(e.code) ? e.code : 'orphan_gc_inventory_invalid' };
    if (Number.isSafeInteger(e.deletedBlobCount) && Number.isSafeInteger(e.reclaimedBytes)) {
      result.deletedBlobCount = e.deletedBlobCount; result.reclaimedBytes = e.reclaimedBytes;
    }
    process.stderr.write(JSON.stringify(result) + '\n'); process.exitCode = 1;
  }
}
module.exports = { main };
