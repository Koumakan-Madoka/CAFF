// Trusted container harness ONLY, not captured code or a general executable archive importer.
// Caller pins reference outside the artifact; integrity hashes are NOT source authentication.
// Host scheduler and same-OS-user ancestors/reference/build remain TCB. Never executes code here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { manifestFor } = require('./pi-probe-materials.cjs');
const MAX = 2 * 1024 * 1024, CONTENT_MAX = 1024 * 1024;
const sourcePaths = Object.freeze({
  'pi-probe-guards.cjs': 'scripts/badcase-capture/pi-probe-guards.cjs',
  'probe.cjs': 'scripts/badcase-capture/retained-sdk-container.cjs',
  ...Object.fromEntries(['retained-sdk-diagnostic', 'capsule-materialization', 'secrets']
    .map(n => [n + '.js', 'build/server/domain/runtime/badcase-capture/' + n + '.js'])),
});
const names = Object.keys(sourcePaths).sort();
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const digest = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const fail = code => { throw Object.assign(Error(code), { code }); };
function readBounded(file, limit, expectedSize) {
  let fd;
  try {
    const before = fs.lstatSync(file); // lstat type check already rejects links; explicit check is defense in depth.
    if (!before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(before.size) || before.size < 0
      || before.size > limit || (expectedSize !== undefined && before.size !== expectedSize)) throw Error('type');
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino || st.size !== before.size) throw Error('changed');
    const bytes = Buffer.alloc(st.size + 1); let offset = 0;
    while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) break; offset += n; }
    if (offset !== st.size) throw Error('changed');
    return bytes.subarray(0, offset);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function verifyFiles(files) {
  const m = manifestFor(files);
  if (files.length !== names.length || files.map(f => f.path).sort().join(',') !== names.join(',')) throw Error('scope');
  const bytes = files.reduce((n, f) => n + f.bytes.length, 0);
  if (bytes <= 0 || bytes > CONTENT_MAX) throw Error('size');
  return { harnessHash: m.inputHash, harnessBytes: bytes };
}
function prepareHarnessFiles(repoRoot) {
  const files = names.map(name => ({ path: name, bytes: readBounded(path.join(repoRoot, sourcePaths[name]), CONTENT_MAX) }));
  verifyFiles(files); return files;
}
function validateReference(ref) {
  if (!exact(ref, ['directory', 'archiveHash', 'archiveBytes', 'harnessHash', 'harnessBytes'])
    || typeof ref.directory !== 'string' || !path.isAbsolute(ref.directory) || !digest(ref.archiveHash) || !digest(ref.harnessHash)
    || !Number.isSafeInteger(ref.archiveBytes) || ref.archiveBytes <= 0 || ref.archiveBytes > MAX
    || !Number.isSafeInteger(ref.harnessBytes) || ref.harnessBytes <= 0 || ref.harnessBytes > CONTENT_MAX) throw Error('reference');
}
function decode(bytes, ref) {
  if (bytes.length !== ref.archiveBytes || hash(bytes) !== ref.archiveHash) throw Error('identity');
  const d = JSON.parse(bytes);
  if (!exact(d, ['schemaVersion', 'kind', 'files']) || d.schemaVersion !== 1 || d.kind !== 'trusted-container-harness'
    || !Array.isArray(d.files) || d.files.length !== names.length) throw Error('schema');
  let total = 0;
  const files = d.files.map(f => {
    if (!exact(f, ['path', 'size', 'sha256', 'base64']) || !Number.isSafeInteger(f.size) || f.size < 0
      || !digest(f.sha256) || typeof f.base64 !== 'string' || !names.includes(f.path)) throw Error('file');
    total += f.size; if (total > CONTENT_MAX) throw Error('size');
    const content = Buffer.from(f.base64, 'base64');
    if (content.toString('base64') !== f.base64 || content.length !== f.size || hash(content) !== f.sha256) throw Error('content');
    return { path: f.path, bytes: content };
  });
  const m = verifyFiles(files);
  if (m.harnessHash !== ref.harnessHash || m.harnessBytes !== ref.harnessBytes) throw Error('harness');
  return files;
}
function readHarnessArchive(ref) {
  try {
    validateReference(ref); // before fs access and allocation
    const dir = fs.lstatSync(ref.directory);
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw Error('directory');
    return decode(readBounded(path.join(ref.directory, 'harness.json'), MAX, ref.archiveBytes), ref);
  } catch { fail('harness_archive_invalid'); }
}
function archiveHarness(repoRoot, destination) {
  let fd;
  try {
    const files = prepareHarnessFiles(repoRoot), m = verifyFiles(files);
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'trusted-container-harness', files: files.map(f => ({
      path: f.path, size: f.bytes.length, sha256: hash(f.bytes), base64: f.bytes.toString('base64'),
    })) }));
    const ref = { directory: destination, archiveHash: hash(bytes), archiveBytes: bytes.length, ...m };
    validateReference(ref); decode(bytes, ref);
    fs.mkdirSync(destination, { mode: 0o700 });
    // wx is additional defense: exclusive mkdir already rejects any preexisting destination.
    fd = fs.openSync(path.join(destination, 'harness.json'), 'wx', 0o600);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    readHarnessArchive(ref); return ref;
  } catch { fail('harness_archive_write_failed'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  // No automatic cleanup, overwrite, directory fsync, or crash-recovery guarantee.
}
module.exports = { archiveHarness, readHarnessArchive, prepareHarnessFiles };
