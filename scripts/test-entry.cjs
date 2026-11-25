// npm test entry: discard the caller's WikiSkill and capture destinations before
// any test module/build/child loads. Agents inherit production destinations from
// the server's .env.local; tests must not write there. Synthetic roots may be set
// deliberately inside tests.
// This is a guard against inherited configuration, not a filesystem sandbox.
const { spawnSync } = require('node:child_process');
const command = process.argv[2];
if (process.argv.length !== 3 || !command) {
  console.error('test entry requires one command');
  process.exit(2);
}
const env = { ...process.env };
delete env.CAFF_WIKISKILL_DATA_DIR;
delete env.CAFF_BADCASE_CAPTURE_DIR;
// Windows runners may supply an 8.3 TEMP alias. Native legacy fixtures require
// a canonical authorization root; use the same directory's long spelling only
// in the child, not weaker production path/pin checks or another data location.
// Explicit short-path regression fixtures still construct and exercise aliases.
if (process.platform === 'win32') {
  try {
    const temp = require('node:fs').realpathSync.native(require('node:os').tmpdir());
    env.TEMP = temp; env.TMP = temp;
  } catch {
    console.error('test temp directory is unavailable'); process.exit(1);
  }
}
const result = spawnSync(command, { shell: true, stdio: 'inherit', env });
if (result.error) console.error('test command could not start');
process.exit(result.status ?? 1);
