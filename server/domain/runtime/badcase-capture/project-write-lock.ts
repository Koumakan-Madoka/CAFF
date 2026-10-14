import fs from 'node:fs';
import path from 'node:path';
// Synchronous trusted writers only. Reentrant within one JS stack, exclusive
// across processes. Never reclaim a lock by age/PID: a crashed writer leaves a
// fail-closed lock requiring operator inspection. No GC is enabled here.
const held = new Set<string>();
export function withProjectWriteLock<T>(root: string, projectId: string, action: () => T): T {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) throw Object.assign(Error('capture_lock_invalid'), { code: 'capture_lock_invalid' });
  const directory = path.join(path.resolve(root), 'projects', projectId);
  const lock = path.join(directory, '.writer-lock');
  if (held.has(lock)) return action();
  fs.mkdirSync(directory, { recursive: true });
  try { fs.mkdirSync(lock); }
  catch { throw Object.assign(Error('capture_writer_busy'), { code: 'capture_writer_busy' }); }
  held.add(lock);
  try { return action(); }
  finally { held.delete(lock); fs.rmdirSync(lock); }
}
