// Administrative scope count only: one bounded Git worktree inventory, never
// a target content/skill scan or an authorization grant. A registered worktree
// can still fail a later capture (e.g. unreadable HEAD / Git ownership refusal).
import path from 'node:path';
import { inspectSnapshotRepository, readSnapshotGit } from './git-snapshot';
import { createCaptureTimeBudget } from './capture-time-budget';
const key = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
export async function inspectCaptureCoverage(projectPath: string, roomPaths: string[]): Promise<any> {
  const unavailable = { roomWorktreeCount: null, reason: 'coverage_unavailable', basis: 'git-registered-room-worktrees' };
  try {
    if (!Array.isArray(roomPaths)) return unavailable;
    const budget = createCaptureTimeBudget({ captureTimeLimitMs: 2000 });
    const repository = await inspectSnapshotRepository(projectPath, budget);
    if (!repository.ok) return unavailable;
    const output = (await readSnapshotGit(projectPath, ['worktree', 'list', '--porcelain', '-z'], budget)).toString('utf8');
    const registered = new Set<string>();
    let directory = '', prunable = false;
    for (const field of output.split('\0')) {
      if (field.startsWith('worktree ')) directory = field.slice(9);
      else if (field.startsWith('prunable')) prunable = true;
      else if (!field && directory) {
        if (!prunable) registered.add(key(directory));
        directory = ''; prunable = false;
      }
    }
    const rooms = new Set(roomPaths.filter(p => typeof p === 'string' && path.isAbsolute(p)).map(key));
    rooms.delete(key(repository.root));
    return { roomWorktreeCount: [...rooms].filter(p => registered.has(p)).length, reason: '', basis: 'git-registered-room-worktrees' };
  } catch { return unavailable; }
}
