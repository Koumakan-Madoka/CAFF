// Offline persistence of a TRUSTED installed distribution, not a captured-code loader.
// Caller pins the returned reference outside the artifact. Hashes are integrity, NOT authenticity.
// Same-OS-user ancestors/install/build/reference are TCB. No SDK import, Docker or network here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { prepareProbeFiles, manifestFor } = require('./pi-probe-materials.cjs');
const MAX = 24 * 1024 * 1024;
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const digest = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const fail = code => { throw Object.assign(Error(code), { code }); };
const versions = [
  ['runtime/package.json', '@earendil-works/pi-coding-agent', '0.85.1'],
  ['runtime/node_modules/@earendil-works/chord/package.json', '@earendil-works/chord', '0.85.1'],
  ['runtime/node_modules/typebox/package.json', 'typebox', '1.3.7'],
  ['runtime/bundled-pi-ai/package.json', '@earendil-works/pi-ai', '0.85.1'],
];
const trees = ['runtime/dist/bundle/', 'runtime/dist/modes/interactive/theme/',
  'runtime/node_modules/@earendil-works/chord/dist/context/', 'runtime/node_modules/typebox/build/'];
function verifyFiles(files) {
  const manifest = manifestFor(files); // path conflicts, duplicate names, 4096 files/16MiB
  if (!files.length || files.some(f => !versions.some(v => f.path === v[0]) && !trees.some(p => f.path.startsWith(p)))) throw Error('scope');
  if (!files.some(f => f.path === 'runtime/dist/bundle/index.js') || trees.some(p => !files.some(f => f.path.startsWith(p)))) throw Error('missing');
  for (const [name, pkg, version] of versions) {
    const bytes = files.find(f => f.path === name)?.bytes;
    if (!bytes) throw Error('metadata');
    const p = JSON.parse(bytes);
    if (p.name !== pkg || p.version !== version) throw Error('version');
  }
  return manifest;
}
function decode(bytes, reference) {
  if (bytes.length !== reference.archiveBytes || hash(bytes) !== reference.archiveHash) throw Error('identity');
  const data = JSON.parse(bytes);
  if (!exact(data, ['schemaVersion', 'kind', 'files']) || data.schemaVersion !== 1 || data.kind !== 'trusted-runtime-distribution'
    || !Array.isArray(data.files) || data.files.length > 4096) throw Error('schema');
  let total = 0;
  const files = data.files.map(f => {
    if (!exact(f, ['path', 'size', 'sha256', 'base64']) || !Number.isSafeInteger(f.size) || f.size < 0 || !digest(f.sha256)
      || typeof f.base64 !== 'string') throw Error('file');
    total += f.size;
    if (total > 16 * 1024 * 1024) throw Error('size');
    const content = Buffer.from(f.base64, 'base64');
    if (content.toString('base64') !== f.base64 || content.length !== f.size || hash(content) !== f.sha256) throw Error('content');
    return { path: f.path, bytes: content };
  });
  const m = verifyFiles(files);
  if (m.runtimeHash !== reference.runtimeHash || m.runtimeBytes !== reference.runtimeBytes) throw Error('runtime');
  return files;
}
function validateReference(ref) {
  if (!exact(ref, ['directory', 'archiveHash', 'archiveBytes', 'runtimeHash', 'runtimeBytes'])
    || typeof ref.directory !== 'string' || !path.isAbsolute(ref.directory) || !digest(ref.archiveHash) || !digest(ref.runtimeHash)
    || !Number.isSafeInteger(ref.archiveBytes) || ref.archiveBytes <= 0 || ref.archiveBytes > MAX
    || !Number.isSafeInteger(ref.runtimeBytes) || ref.runtimeBytes <= 0 || ref.runtimeBytes > 16 * 1024 * 1024) throw Error('reference');
}
function readRuntimeArchive(reference) {
  let fd;
  try {
    validateReference(reference);
    const dir = fs.lstatSync(reference.directory);
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw Error('directory');
    const file = path.join(reference.directory, 'runtime.json'), before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== reference.archiveBytes) throw Error('type');
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino || st.size !== reference.archiveBytes) throw Error('changed');
    // Bounded fd read, including one extra byte to detect growth. Not an RSS or hostile-ancestor guarantee.
    const buffer = Buffer.alloc(reference.archiveBytes + 1); let offset = 0;
    while (offset < buffer.length) { const n = fs.readSync(fd, buffer, offset, buffer.length - offset, offset); if (!n) break; offset += n; }
    return decode(buffer.subarray(0, offset), reference);
  } catch { fail('runtime_archive_invalid'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function archiveRuntime(repoRoot, destination) {
  // Source validation precedes any destination write. Never archives auth/session/case or probe files.
  const files = prepareProbeFiles(repoRoot, 'fresh').filter(f => f.path.startsWith('runtime/'));
  const m = verifyFiles(files);
  const data = { schemaVersion: 1, kind: 'trusted-runtime-distribution', files: files.map(f => ({
    path: f.path, size: f.bytes.length, sha256: hash(f.bytes), base64: f.bytes.toString('base64'),
  })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
  const bytes = Buffer.from(JSON.stringify(data));
  const reference = { directory: destination, archiveHash: hash(bytes), archiveBytes: bytes.length,
    runtimeHash: m.runtimeHash, runtimeBytes: m.runtimeBytes };
  let fd;
  try {
    validateReference(reference); decode(bytes, reference);
    // Exclusive new directory: never overwrite/reuse an old or partially written artifact.
    fs.mkdirSync(destination, { mode: 0o700 });
    fd = fs.openSync(path.join(destination, 'runtime.json'), 'wx', 0o600);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    readRuntimeArchive(reference); // read-back validation before a reference can be published
    return reference;
  } catch { fail('runtime_archive_write_failed'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  // Failure retains partial destination; no delete/overwrite/automatic cleanup or crash recovery.
}
module.exports = { archiveRuntime, readRuntimeArchive };
