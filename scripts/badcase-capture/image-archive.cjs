// Trusted offline image EXPORT only. Never load/pull/tag/remove or execute archived code.
// Local daemon, caller-pinned references and same-user path ancestors are TCB.
// Opaque Docker save bytes: integrity verification is NOT a restore or provenance proof.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { prepareOfflineTask, runDockerCommand } = require('../../build/server/domain/runtime/badcase-capture/docker-sandbox');
const MAX = 4 * 1024 ** 3, META_MAX = 65536, CHUNK = 1024 * 1024;
let active = false;
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const digest = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const error = code => Object.assign(Error(code), { code });
function validateImage(image) {
  // Reuse the pinned template syntax; this validates declarations, not installed versions.
  return prepareOfflineTask({ image, files: [{ path: 'x.cjs', base64: '', sha256: hash('') }], entrypoint: 'x.cjs', timeoutMs: 1 }).image;
}
function one(r) {
  if (!r || r.code !== 0 || r.failure) throw Error('control');
  const a = JSON.parse(r.stdout); if (!Array.isArray(a) || a.length !== 1) throw Error('control'); return a[0];
}
function inspectIdentity(v, image) {
  if (v?.Id !== image.imageId || !Array.isArray(v.RepoDigests) || !v.RepoDigests.includes(image.repositoryDigest)
    || v.Architecture !== image.architecture || v.Os !== 'linux' || !v.Config
    || Object.keys(v.Config.Volumes || {}).length || (v.Config.OnBuild || []).length
    || (v.Config.Healthcheck?.Test?.length && v.Config.Healthcheck.Test[0] !== 'NONE')) throw Error('image');
}
function validateReference(ref) {
  if (!exact(ref, ['directory', 'archiveHash', 'archiveBytes', 'metadataHash', 'metadataBytes'])
    || typeof ref.directory !== 'string' || !path.isAbsolute(ref.directory) || !digest(ref.archiveHash) || !digest(ref.metadataHash)
    || !Number.isSafeInteger(ref.archiveBytes) || ref.archiveBytes < 1 || ref.archiveBytes > MAX
    || !Number.isSafeInteger(ref.metadataBytes) || ref.metadataBytes < 1 || ref.metadataBytes > META_MAX) throw Error('reference');
}
function openRegular(file, limit, expected) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(before.size) || before.size < 1
    || before.size > limit || (expected !== undefined && before.size !== expected)) throw Error('file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino || st.size !== before.size) throw Error('changed');
    return { fd, size: st.size };
  } catch (e) { fs.closeSync(fd); throw e; }
}
function readFileHash(file, limit, expected, keep = false) {
  const { fd, size } = openRegular(file, limit, expected);
  try {
    const buffer = Buffer.alloc(Math.min(CHUNK, size + 1)), h = crypto.createHash('sha256'), pieces = [];
    let offset = 0;
    while (offset <= size) {
      const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size + 1 - offset), offset);
      if (!n) break;
      offset += n; if (offset > size) throw Error('growth');
      h.update(buffer.subarray(0, n)); if (keep) pieces.push(Buffer.from(buffer.subarray(0, n)));
    }
    if (offset !== size || fs.fstatSync(fd).size !== size) throw Error('changed');
    return { bytes: size, hash: h.digest('hex'), ...(keep ? { content: Buffer.concat(pieces) } : {}) };
  } finally { fs.closeSync(fd); }
}
function verifyImageArchive(ref) {
  try {
    validateReference(ref); // no filesystem reads or large allocations before bounds
    const dir = fs.lstatSync(ref.directory); if (!dir.isDirectory() || dir.isSymbolicLink()) throw Error('directory');
    const meta = readFileHash(path.join(ref.directory, 'metadata.json'), META_MAX, ref.metadataBytes, true);
    if (meta.hash !== ref.metadataHash) throw Error('metadata');
    const d = JSON.parse(meta.content);
    if (!exact(d, ['schemaVersion', 'kind', 'image', 'os', 'archiveHash', 'archiveBytes']) || d.schemaVersion !== 1
      || d.kind !== 'trusted-docker-image-export' || d.os !== 'linux'
      || d.archiveHash !== ref.archiveHash || d.archiveBytes !== ref.archiveBytes) throw Error('metadata');
    const image = validateImage(d.image);
    const a = readFileHash(path.join(ref.directory, 'image.tar'), MAX, ref.archiveBytes);
    if (a.hash !== ref.archiveHash) throw Error('archive');
    return { kind: d.kind, image, os: d.os, archiveBytes: a.bytes, archiveHash: a.hash,
      runtimeVersionsVerified: false, restored: false, runnable: false };
  } catch { throw error('image_archive_invalid'); }
}
// Only internal tests inject spawn/limits; no HTTP/config-controlled executable or Docker options.
function saveImageStream(imageId, fd, options = {}) {
  if (typeof imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(imageId)) return Promise.reject(error('image_archive_stream_failed'));
  const maxBytes = options.maxBytes ?? MAX, timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > 120000) return Promise.reject(error('image_archive_stream_failed'));
  const env = {}; for (const k of ['PATH', 'HOME', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  return new Promise((resolve, reject) => {
    let c, failed = false, bytes = 0, stderrBytes = 0, timer;
    const stop = () => { failed = true; try { c.kill('SIGKILL'); } catch {} };
    try { c = (options.spawn || childProcess.spawn)('docker', ['--context', 'default', 'image', 'save', imageId], { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { reject(error('image_archive_stream_failed')); return; }
    timer = setTimeout(stop, timeoutMs);
    c.stdout.on('data', b => {
      if (failed) return;
      bytes += b.length; if (bytes > maxBytes) { stop(); return; }
      try {
        let offset = 0;
        while (offset < b.length) { const n = fs.writeSync(fd, b, offset, b.length - offset); if (n <= 0) throw Error('write'); offset += n; }
      } catch { stop(); }
    });
    c.stderr.on('data', b => { stderrBytes += b.length; if (stderrBytes > META_MAX) stop(); }); // never retain or echo daemon text
    c.stdout.on('error', stop); c.stderr.on('error', stop); c.on('error', stop);
    c.on('close', code => { clearTimeout(timer); if (failed || code !== 0 || bytes < 1) reject(error('image_archive_stream_failed')); else resolve(); });
    // Hold descriptor/admission until close. Timeout triggers kill, NOT a return-time bound.
  });
}
async function archiveImage(image, destination, options = {}) {
  if (active) throw error('image_archive_busy'); active = true;
  let fd;
  try {
    image = validateImage(image);
    if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw Error('destination');
    if (!options.runDocker && process.platform !== 'linux') throw Error('platform');
    const run = options.runDocker || runDockerCommand;
    const endpoint = one(await run(['context', 'inspect', 'default'])).Endpoints?.docker?.Host;
    if (typeof endpoint !== 'string' || !/^unix:\/\/\/[^\s\0]+$/.test(endpoint)) throw Error('daemon');
    inspectIdentity(one(await run(['image', 'inspect', image.imageId])), image);
    fs.mkdirSync(destination, { mode: 0o700 }); // never overwrite or remove an existing directory
    fd = fs.openSync(path.join(destination, 'image.tar'), 'wx', 0o600);
    await (options.save || saveImageStream)(image.imageId, fd);
    inspectIdentity(one(await run(['image', 'inspect', image.imageId])), image);
    const a = readFileHash(path.join(destination, 'image.tar'), MAX);
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'trusted-docker-image-export', image, os: 'linux', archiveHash: a.hash, archiveBytes: a.bytes }));
    fd = fs.openSync(path.join(destination, 'metadata.json'), 'wx', 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    const ref = { directory: destination, archiveHash: a.hash, archiveBytes: a.bytes, metadataHash: hash(bytes), metadataBytes: bytes.length };
    verifyImageArchive(ref); return ref;
  } catch { throw error('image_archive_write_failed'); }
  finally { try { if (fd !== undefined) fs.closeSync(fd); } finally { active = false; } }
  // Failure keeps partial artifacts. No directory fsync/crash recovery, quota GC, or auto-import.
}
module.exports = { archiveImage, verifyImageArchive, saveImageStream };
