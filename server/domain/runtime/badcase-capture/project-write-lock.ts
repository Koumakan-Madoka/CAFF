import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// Synchronous trusted writers are reentrant only within one JS stack. A file
// worker may instead borrow a supervisor-owned lease. No age/PID-based reclaim:
// supervisor death, legacy locks and unknown owners still fail closed. No GC.
const held = new Set<string>();
const fail = (code: string) => Object.assign(Error(code), { code });
function location(root: string, projectId: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) throw fail('capture_lock_invalid');
  return path.join(path.resolve(root), 'projects', projectId, '.writer-lock');
}
function acquire(lock: string) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { fs.mkdirSync(lock); }
  catch { throw fail('capture_writer_busy'); }
}
function verifyOwner(lock: string, owner: string) {
  if (typeof owner !== 'string' || !/^[a-f0-9]{64}$/.test(owner)) throw fail('capture_lock_invalid');
  // Storage ancestors remain trusted same-OS-user TCB, not a path-swap sandbox.
  const file = path.join(lock, 'owner');
  try {
    if (!fs.lstatSync(lock).isDirectory() || !fs.lstatSync(file).isFile()) throw Error();
    const fd = fs.openSync(file, 'r');
    try {
      if (fs.fstatSync(fd).size !== 64) throw Error();
      const bytes = Buffer.alloc(65);
      if (fs.readSync(fd, bytes, 0, 65, 0) !== 64 || bytes.subarray(0, 64).toString('ascii') !== owner) throw Error();
    } finally { fs.closeSync(fd); }
  } catch { throw fail('capture_lock_invalid'); }
}
// Internal supervisor API. The returned release closure is called ONLY after
// the delegated child has emitted close (or no child was created). This lease
// is NOT added to held: unrelated parent-side writes must continue to fail busy.
export function acquireProjectWriteLease(root: string, projectId: string) {
  const lock = location(root, projectId), owner = crypto.randomBytes(32).toString('hex');
  acquire(lock);
  try { fs.writeFileSync(path.join(lock, 'owner'), owner, { flag: 'wx', mode: 0o600 }); }
  catch {
    // Only our newly acquired directory, no worker exists yet. Partial owner
    // removal failures leave a fail-closed lock, never recursively delete it.
    try { fs.unlinkSync(path.join(lock, 'owner')); fs.rmdirSync(lock); } catch {}
    throw fail('capture_lock_invalid');
  }
  let released = false;
  return { owner, release() {
    if (released) return;
    verifyOwner(lock, owner);
    try { fs.unlinkSync(path.join(lock, 'owner')); fs.rmdirSync(lock); }
    catch { throw fail('capture_lock_invalid'); }
    released = true;
  } };
}
// Used only by the trusted one-shot worker; owner arrives separately from the
// sanitized seal request. Does not create/release a lock or authorize a caller.
export function withDelegatedProjectWriteLock<T>(root: string, projectId: string, owner: string, action: () => T): T {
  const lock = location(root, projectId);
  verifyOwner(lock, owner);
  if (held.has(lock)) throw fail('capture_lock_invalid');
  held.add(lock);
  try { return action(); } finally { held.delete(lock); }
}
export function withProjectWriteLock<T>(root: string, projectId: string, action: () => T): T {
  const lock = location(root, projectId);
  if (held.has(lock)) return action();
  acquire(lock);
  held.add(lock);
  try { return action(); }
  finally { held.delete(lock); fs.rmdirSync(lock); }
}
