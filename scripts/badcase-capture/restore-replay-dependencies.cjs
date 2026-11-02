// CONTAINER ONLY. A host-verified cache artifact, not an arbitrary user tar.
// Extraction still rejects absolute/traversal entries and non-node_modules roots.
const fs = require('node:fs'), cp = require('node:child_process'), crypto = require('node:crypto'), assert = require('node:assert/strict');
function restoreReplayDependencies(cwd, dependencies) {
  assert.equal(cwd, '/work/restored'); assert.equal(dependencies?.kind, 'npm-ci-linux-v1');
  assert.equal(dependencies.archivePath, 'replay-dependencies.tar.gz'); assert.equal(dependencies.nodeVersion, process.version);
  assert.equal(fs.existsSync(cwd + '/node_modules'), false);
  const archive = '/work/' + dependencies.archivePath;
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), dependencies.archiveHash);
  const run = args => cp.execFileSync('tar', args, { env: { PATH: process.env.PATH }, timeout: 120000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const names = run(['-tzf', archive]).toString('utf8').trimEnd().split('\n');
  assert.ok(names.length && names.every(name => (name === 'node_modules/' || name.startsWith('node_modules/'))
    && !name.startsWith('/') && !name.split('/').some(part => part === '..' || part === '.') && !name.includes('\0')));
  run(['--no-same-owner', '-xzf', archive, '-C', cwd]);
  assert.ok(fs.lstatSync(cwd + '/node_modules').isDirectory() && !fs.lstatSync(cwd + '/node_modules').isSymbolicLink());
  fs.unlinkSync(archive);
  return { kind: dependencies.kind, cacheKey: dependencies.cacheKey, archiveHash: dependencies.archiveHash,
    lockHash: dependencies.lockHash, nodeVersion: process.version, npmVersion: dependencies.npmVersion, installed: true };
}
module.exports = { restoreReplayDependencies };
