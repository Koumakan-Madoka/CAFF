// npm test entry: discard the caller's WikiSkill destination before any test
// module/build/child loads. Tests may deliberately configure synthetic roots.
// This is a guard against inherited configuration, not a filesystem sandbox.
const { spawnSync } = require('node:child_process');
const command = process.argv[2];
if (process.argv.length !== 3 || !command) {
  console.error('test entry requires one command');
  process.exit(2);
}
const env = { ...process.env };
delete env.CAFF_WIKISKILL_DATA_DIR;
const result = spawnSync(command, { shell: true, stdio: 'inherit', env });
if (result.error) console.error('test command could not start');
process.exit(result.status ?? 1);
