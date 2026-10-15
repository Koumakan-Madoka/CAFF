// Static DATA restoration only. No SDK, user code, prompt execution or launch permission.
// Container entry uses a fixed fresh /work/restored; host tests use owned temp roots.
// Ancestors of the destination are trusted. Never use this as a general filesystem API.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { containsSecretSentinel } from './secrets';
const hash = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const fail = (code = 'capsule_materials_invalid') => Object.assign(Error(code), { code });
const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: any, keys: string[]) => object(v) && Object.keys(v).sort().join('|') === keys.sort().join('|');
const digest = (v: any) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const relative = (v: any) => typeof v === 'string' && v.length <= 1000 && /^[A-Za-z0-9_.\-/]+$/.test(v)
  && v.split('/').every((p: string) => p && p !== '.' && p !== '..' && p.length <= 255);
const LIMIT = 4 * 1024 * 1024;

export function decodeInitializationCapsule(capsule: any, expected: any) {
  if (typeof capsule !== 'string' || Buffer.byteLength(capsule) > LIMIT
    || !exact(expected, ['capsuleHash', 'checkpointChecksum']) || !digest(expected.capsuleHash)
    || !digest(expected.checkpointChecksum) || hash(capsule) !== expected.capsuleHash) throw fail();
  let data: any;
  try { data = JSON.parse(capsule); } catch { throw fail(); }
  if (!exact(data, ['schemaVersion', 'kind', 'checkpoint', 'blobs']) || data.schemaVersion !== 1
    || data.kind !== 'retained-initialization-inputs' || !object(data.checkpoint) || !Array.isArray(data.blobs)
    || data.blobs.length > 8192 || hash(JSON.stringify(data.checkpoint)) !== expected.checkpointChecksum) throw fail();
  const cp = data.checkpoint, r = cp.replayInput;
  if (containsSecretSentinel(JSON.stringify(cp))) throw fail('capsule_materials_secret');
  if (cp.schemaVersion !== 1 || !object(cp.files) || !Array.isArray(cp.deletions) || cp.deletions.length > 4096
    || (cp.uncaptured !== undefined && (!Array.isArray(cp.uncaptured) || cp.uncaptured.length !== 0))
    || !object(r) || r.complete !== true || !Array.isArray(r.incompleteReasons) || r.incompleteReasons.length !== 0
    || !['fresh', 'resume'].includes(r.deliveryMode) || !digest(r.promptBlobHash)
    || r.normalizedPromptHash !== r.promptBlobHash || !object(r.harness) || !digest(r.harness.configSnapshotHash)
    || !Array.isArray(r.harness.skillSnapshots) || r.harness.skillSnapshots.length > 4096
    || (r.deliveryMode === 'resume' ? !digest(r.sessionBlobHash) : r.sessionBlobHash !== '')) throw fail();
  const blobs = new Map<string, Buffer>(); let total = 0;
  for (const b of data.blobs) {
    if (!exact(b, ['sha256', 'base64']) || !digest(b.sha256) || blobs.has(b.sha256) || typeof b.base64 !== 'string') throw fail();
    const bytes = Buffer.from(b.base64, 'base64'); total += bytes.length;
    if (total > LIMIT || bytes.toString('base64') !== b.base64 || hash(bytes) !== b.sha256) throw fail();
    if (containsSecretSentinel(bytes)) throw fail('capsule_materials_secret');
    blobs.set(b.sha256, bytes);
  }
  const required = new Set<string>();
  function requireBlob(h: any): Buffer {
    if (!digest(h) || !blobs.has(h)) throw fail();
    required.add(h); return blobs.get(h)!;
  }
  requireBlob(r.promptBlobHash); requireBlob(r.harness.configSnapshotHash);
  if (r.deliveryMode === 'resume') requireBlob(r.sessionBlobHash);
  for (const s of r.harness.skillSnapshots) {
    if (!object(s) || s.sha256 !== s.blobHash) throw fail();
    requireBlob(s.blobHash);
  }
  const names = Object.keys(cp.files), nameSet = new Set(names);
  if (names.length > 4094) throw fail();
  const files: { path: string; bytes: Buffer }[] = [];
  for (const name of names) {
    const f = cp.files[name];
    if (!relative(name) || !object(f) || f.type !== 'file' || f.secretExcluded || !Number.isSafeInteger(f.size) || f.size < 0) throw fail();
    const bytes = requireBlob(f.hash);
    if (bytes.length !== f.size) throw fail();
    const parts = name.split('/'); parts.pop();
    while (parts.length) { if (nameSet.has(parts.join('/'))) throw fail(); parts.pop(); }
    files.push({ path: 'snapshot/' + name, bytes });
  }
  if (new Set(cp.deletions).size !== cp.deletions.length || cp.deletions.some((d: any) => !relative(d)
    || names.some(n => n === d || n.startsWith(d + '/') || d.startsWith(n + '/')))
    || required.size !== blobs.size) throw fail();
  // All archived input bytes stay data under fixed hash names, including skills/config.
  // This does NOT apply replacement declarations or validate SDK execution semantics.
  files.push({ path: 'materials/checkpoint.json', bytes: Buffer.from(JSON.stringify(cp)) });
  for (const [sha256, bytes] of blobs) files.push({ path: 'materials/blobs/' + sha256, bytes });
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files, deletions: [...cp.deletions], receipt: { capsuleHash: expected.capsuleHash,
    checkpointChecksum: expected.checkpointChecksum, deliveryMode: r.deliveryMode, fileCount: names.length,
    blobCount: blobs.size, materializedHash: hash(JSON.stringify(files.map(f => ({ path: f.path, size: f.bytes.length, sha256: hash(f.bytes) })))),
    fileModePreserved: false, piExecuted: false, runnable: false, reproduced: false, evaluable: false, strictEvalEligible: false } };
}

export function materializeInitializationCapsule(capsule: any, expected: any, destination: string) {
  const plan = decodeInitializationCapsule(capsule, expected); // validate ALL before first write
  fs.mkdirSync(destination, { mode: 0o700 }); // exclusive: existing directory/link always fails
  fs.mkdirSync(path.join(destination, 'snapshot'), { mode: 0o700 });
  for (const f of plan.files) {
    const target = path.join(destination, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    // wx and read-back are defense in depth beyond exclusive mkdir + validated
    // unique paths. They do not promise atomicity against same-OS-user tampering.
    fs.writeFileSync(target, f.bytes, { flag: 'wx', mode: 0o600 });
    if (!fs.lstatSync(target).isFile() || !fs.readFileSync(target).equals(f.bytes)) throw fail('capsule_materials_write_failed');
  }
  for (const d of plan.deletions) if (fs.existsSync(path.join(destination, 'snapshot', d))) throw fail('capsule_materials_write_failed');
  // Failed I/O may leave a partial NEW directory, never a success receipt. No automatic deletion.
  return plan.receipt;
}
