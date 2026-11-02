import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// Synchronous trusted writers are reentrant only within one JS stack. A file
// worker may instead borrow a supervisor-owned lease. No age/PID-based reclaim:
// supervisor death and legacy locks still fail closed on ordinary writes. Only
// explicit offline recovery below may retire a verified lock. No automatic GC.
const held = new Set<string>();
// Unlike held, these entries span awaits and NEVER confer reentrant write
// permission. Also stop this process from "recovering" its own live action.
const activeAsyncLeases = new Set<string>();
const fail = (code: string) => Object.assign(Error(code), { code });
function location(root: string, projectId: string) {
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) throw fail('capture_lock_invalid');
  return path.join(path.resolve(root), 'projects', projectId, '.writer-lock');
}
const recoveryGate = (lock: string) => path.join(path.dirname(lock), '.writer-recovery');
function assertNoRecovery(lock: string) {
  try { fs.lstatSync(recoveryGate(lock)); }
  catch (e: any) { if (e.code === 'ENOENT') return; throw fail('capture_writer_busy'); }
  throw fail('capture_writer_busy'); // Includes dangling links and crash-left gates.
}
function acquire(lock: string) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  assertNoRecovery(lock);
  try { fs.mkdirSync(lock); }
  catch { throw fail('capture_writer_busy'); }
  // Close the gate-precheck/mkdir window for cooperating new writers. This is
  // not fencing for an already running writer: recovery still requires quiescence.
  try { assertNoRecovery(lock); }
  catch (e) { try { fs.rmdirSync(lock); } catch {} throw e; }
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
  assertNoRecovery(lock);
  verifyOwner(lock, owner);
  if (held.has(lock)) throw fail('capture_lock_invalid');
  held.add(lock);
  try { return action(); } finally { held.delete(lock); }
}
export function withProjectWriteLock<T>(root: string, projectId: string, action: () => T): T {
  const lock = location(root, projectId);
  assertNoRecovery(lock);
  if (held.has(lock)) return action();
  acquire(lock);
  held.add(lock);
  try { return action(); }
  finally { held.delete(lock); fs.rmdirSync(lock); }
}

// Internal async collector orchestration. Own the on-disk lease across ALL
// awaited work; grant reentrancy ONLY on an explicitly invoked synchronous
// commit stack. No AsyncLocalStorage or shared held entry across awaits: other
// requests (including callbacks scheduled inside a commit) must still be busy.
// Trusted callers must await their helpers through close before settling action.
// This is not cancellation, a hard timeout, or an untrusted-closure sandbox.
export async function withAsyncProjectWriteLease<T>(root: string, projectId: string,
  action: (writeSync: <R>(work: () => R) => R) => T | PromiseLike<T>): Promise<T> {
  if (typeof action !== 'function') throw fail('capture_lock_invalid');
  const lock = location(root, projectId), lease = acquireProjectWriteLease(root, projectId);
  activeAsyncLeases.add(lock);
  let open = true, asyncCommit = false;
  const pending: Promise<void>[] = [];
  const writeSync = <R>(work: () => R): R => {
    if (!open || typeof work !== 'function') throw fail('capture_lock_invalid');
    return withDelegatedProjectWriteLock(root, projectId, lease.owner, () => {
      const value = work();
      if (value !== null && (typeof value === 'object' || typeof value === 'function')
        && typeof (value as any).then === 'function') {
        // Programming error, not supported async reentrancy. Observe rejection
        // immediately and drain the returned task before releasing the lease,
        // even if action catches this error. Detached tasks cannot be discovered.
        asyncCommit = true;
        pending.push(Promise.resolve(value).then(() => {}, () => {}));
        throw fail('capture_lock_async_commit');
      }
      return value;
    });
  };
  try {
    const value = await action(writeSync);
    if (asyncCommit) throw fail('capture_lock_async_commit');
    return value;
  } finally {
    open = false; // Revoke leaked commit closures before any cleanup await.
    try { await Promise.all(pending); }
    finally {
      try { lease.release(); }
      finally { activeAsyncLeases.delete(lock); }
    }
  }
}

// Internal operator API, never an HTTP/agent capability. Root ancestors and the
// same OS user remain TCB. Identity is a change detector, not proof of dead owners.
function checkedProject(root: string, projectId: string) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw fail('capture_lock_invalid');
  const lock = location(root, projectId), project = path.dirname(lock);
  try {
    for (const directory of [path.resolve(root), path.join(path.resolve(root), 'projects'), project]) {
      if (!fs.lstatSync(directory).isDirectory()) throw Error();
    }
  } catch { throw fail('capture_lock_invalid'); }
  return { lock, project };
}
function lockSnapshot(lock: string) {
  try {
    const stat = fs.lstatSync(lock, { bigint: true });
    if (!stat.isDirectory()) throw Error();
    const names = fs.readdirSync(lock);
    if (names.length > 1 || (names.length === 1 && names[0] !== 'owner')) throw Error();
    let owner: string | null = null;
    if (names.length) {
      const file = path.join(lock, 'owner'), entry = fs.lstatSync(file, { bigint: true });
      if (!entry.isFile() || entry.size !== 64n) throw Error();
      const fd = fs.openSync(file, 'r');
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== 64n) throw Error();
        const bytes = Buffer.alloc(65);
        if (fs.readSync(fd, bytes, 0, 65, 0) !== 64) throw Error();
        owner = bytes.subarray(0, 64).toString('utf8');
        if (!/^[a-f0-9]{64}$/.test(owner)) throw Error();
      } finally { fs.closeSync(fd); }
    }
    return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs),
      mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), owner };
  } catch { throw fail('capture_lock_invalid'); }
}
function snapshotHash(lock: string, snapshot: ReturnType<typeof lockSnapshot>) {
  return crypto.createHash('sha256').update(JSON.stringify({ lock, ...snapshot })).digest('hex');
}
export function inspectProjectWriteLock(root: string, projectId: string): string {
  const { lock } = checkedProject(root, projectId);
  return snapshotHash(lock, lockSnapshot(lock));
}
export function recoverProjectWriteLock(root: string, projectId: string, options: any) {
  if (!options || Object.keys(options).sort().join(',') !== 'expected,writersStopped'
    || options.writersStopped !== true || typeof options.expected !== 'string'
    || !/^[a-f0-9]{64}$/.test(options.expected)) throw fail('capture_lock_invalid');
  const { lock, project } = checkedProject(root, projectId);
  if (held.has(lock) || activeAsyncLeases.has(lock)) throw fail('capture_writer_busy');
  const gate = recoveryGate(lock);
  try { fs.mkdirSync(gate, { mode: 0o700 }); }
  catch { throw fail('capture_writer_busy'); }
  let safeToOpen = true;
  try {
    const before = lockSnapshot(lock);
    if (snapshotHash(lock, before) !== options.expected) throw fail('capture_lock_invalid');
    // Exclusive parent guarantees a fresh destination without rename overwrites.
    // Keep all retired artifacts; never recursively delete a lock or any data.
    const quarantine = fs.mkdtempSync(path.join(project, '.writer-lock-retired-'));
    const retired = path.join(quarantine, 'lock');
    fs.renameSync(lock, retired);
    safeToOpen = false;
    const after = lockSnapshot(retired);
    if (after.dev !== before.dev || after.ino !== before.ino || after.owner !== before.owner
      || after.birthtimeNs !== before.birthtimeNs) throw fail('capture_lock_recovery_failed');
    safeToOpen = true;
    return { recovered: true, quarantineName: path.basename(quarantine), materialsChanged: false, executionState: 'unknown' };
  } catch (e: any) {
    if (e.code === 'capture_lock_invalid') throw e;
    throw fail('capture_lock_recovery_failed');
  } finally {
    // A crash leaves the gate closed. No age/PID-based recovery of this second
    // gate is provided. Quiescence MUST include all delegated children, not only
    // the supervisor; the gate does not revoke code already inside a write stack.
    if (safeToOpen) {
      try { fs.rmdirSync(gate); } catch { throw fail('capture_lock_recovery_failed'); }
    }
  }
}
