// CONTAINER ONLY. Export a fixed trusted runtime subset, never the project's
// arbitrary npm tree. Native SQLite is opened/queried/closed here, not on host.
const fs = require('node:fs'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function main() {
  const { image } = require('/work/caff-runtime-bootstrap.cjs').verifyCaffRuntimeStage({ replayWorkspace: true });
  fs.renameSync('/work/replay-workspace', '/work/restored');
  const input = JSON.parse(fs.readFileSync('/work/replay-input.json'));
  require('/work/restore-replay-dependencies.cjs').restoreReplayDependencies('/work/restored', input.dependencies);
  const inventory = JSON.parse(fs.readFileSync('/work/runtime-dependency-inventory.json'));
  let total = 0;
  const files = inventory.dependencies.map(name => {
    assert.ok(typeof name === 'string' && name.startsWith('node_modules/') && /^[A-Za-z0-9_.@/-]+$/.test(name)
      && name.split('/').every(part => part && part !== '.' && part !== '..'));
    let current = '/work/restored';
    for (const part of name.split('/').slice(0, -1)) { current += '/' + part; const st = fs.lstatSync(current); assert.ok(st.isDirectory() && !st.isSymbolicLink()); }
    const st = fs.lstatSync('/work/restored/' + name); assert.ok(st.isFile() && !st.isSymbolicLink() && st.size <= 8 * 1024 * 1024);
    total += st.size; assert.ok(total <= 16 * 1024 * 1024);
    const bytes = fs.readFileSync('/work/restored/' + name); assert.equal(bytes.length, st.size);
    return { path: name, size: bytes.length, sha256: hash(bytes), base64: bytes.toString('base64') };
  });
  for (const [name, expected] of Object.entries(inventory.packages)) {
    const metadata = JSON.parse(Buffer.from(files.find(f => f.path === name).base64, 'base64'));
    assert.equal(metadata.name, expected.name); assert.equal(metadata.version, expected.version);
  }
  const Database = require('/work/restored/node_modules/better-sqlite3'), db = new Database(':memory:');
  let nativeSqliteVersion;
  try { nativeSqliteVersion = db.prepare('select sqlite_version() as version').get().version; assert.match(nativeSqliteVersion, /^\d+\.\d+\.\d+$/); }
  finally { db.close(); }
  const descriptors = files.map(({ base64, ...f }) => f).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const artifact = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'fixed-linux-runtime-files-v1', files }));
  fs.writeFileSync('/work/runtime-files.json', artifact, { flag: 'wx', mode: 0o600 });
  return { kind: 'fixed-linux-runtime-export-v1', nodeVersion: process.version, architecture: image.architecture,
    nativeSqliteVerified: true, nativeSqliteVersion, filesHash: hash(JSON.stringify(descriptors)), artifactHash: hash(artifact), modelCalls: 0 };
}
if (require.main === module) {
  try { console.log(JSON.stringify(main())); fs.createReadStream('/work/runtime-files.json').on('error', () => { process.exitCode = 1; }).pipe(process.stdout); }
  catch { process.stderr.write('runtime_dependencies_export_failed\n'); process.exitCode = 1; }
}
module.exports = { main };
