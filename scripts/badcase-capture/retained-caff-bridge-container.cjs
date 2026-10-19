// CONTAINER ONLY. Separate operator-selected entry; capsule cannot enable it.
// Common immutable-stage guard runs before restoration, callback or SDK imports.
if (require.main === module) Promise.resolve().then(() => {
  const { runRetainedCaffContainer } = require('./retained-caff-runtime.cjs');
  return runRetainedCaffContainer(undefined, true);
}).then(r => console.log(JSON.stringify(r))).catch(() => {
  process.stderr.write('retained_caff_bridge_failed\n'); process.exitCode = 1;
});
