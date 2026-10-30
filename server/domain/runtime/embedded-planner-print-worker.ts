// Pipe-mode guardian: IPC disconnect tears down the owned tree. Windows
// children are non-detached (Node/libuv's kill-on-close job); POSIX owns a group.
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import type { PlannerLaunch } from './embedded-planner-host';
export function runPlannerPrintWorker() {
  let child: ChildProcessWithoutNullStreams | null = null, stopping = false, finished = false, forceTimer: NodeJS.Timeout | undefined, drainTimer: NodeJS.Timeout | undefined, pending = 0;
  const send = (m: object, bytes = 0) => { if (process.connected) {
    pending += bytes;
    process.send!(m, () => { pending -= bytes; });
  } };
  function kill(force: boolean) {
    if (!child?.pid)
      return;
    if (process.platform === 'win32' && (child.exitCode !== null || child.signalCode)) return;
    if (process.platform === 'win32')
      execFile(path.join(process.env.SystemRoot!, 'System32/taskkill.exe'), ['/pid', String(child.pid), '/t', ...(force ? ['/f'] : [])], { env: process.env, windowsHide: true, timeout: 5000 }, () => { });
    else
      try {
        process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
      }
      catch { }
  }
  function stop() { if (stopping || finished)
    return; stopping = true; kill(false); forceTimer = setTimeout(() => kill(true), 5000); }
  function finish(exitCode: number | null, overflow = false) {
    if (finished)
      return;
    finished = true;
    if (forceTimer)
      clearTimeout(forceTimer);
    if (drainTimer)
      clearTimeout(drainTimer);
    if (overflow)
      send({ type: 'overflow' });
    const done = () => { child?.stdout.destroy(); child?.stderr.destroy(); if (process.connected)
      process.disconnect(); process.exit(0); };
    if (process.connected)
      process.send!({ type: 'exit', exitCode }, done);
    else
      done();
  }
  process.on('disconnect', () => { stop(); if (!child)
    process.exit(0); });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('message', (m: any) => {
    if (m.type === 'stop') {
      if (finished) return;
      if (m.force) {
        stopping = true;
        kill(true);
      }
      else
        stop();
      return;
    }
    if (m.type !== 'start' || child || finished)
      return;
    const c = m.config as PlannerLaunch & {
      prompt: string;
    };
    try {
      child = spawn(c.cli.file, [...c.cli.prefix, ...c.args], { cwd: c.cwd, env: c.env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      child.once('spawn', () => { send({ type: 'started' }); child!.stdin.on('error', () => { }); child!.stdin.end(c.prompt, 'utf8'); if (!process.connected || stopping)
        kill(true); });
      for (const [stream, type] of [[child.stdout, 'data'], [child.stderr, 'stderr']] as const) {
        stream.setEncoding('utf8');
        stream.on('data', (data: string) => { if (pending > 1048576) {
          send({ type: 'overflow' });
          stop();
          return;
        } send({ type, data }, Buffer.byteLength(data)); });
      }
      child.once('error', () => { finished = true; send({ type: 'spawn_failed' }); if (process.connected)
        process.disconnect(); });
      child.once('exit', (code) => {
        if (process.platform !== 'win32')
          kill(true);
        // A descendant may hold the inherited pipe after the CLI exits. Drain
        // normally, but don't let that pin the guardian/job forever. Its forced
        // teardown is reported as overflow/protocol failure, not fabricated success.
        drainTimer = setTimeout(() => finish(code, true), 5000);
      });
      child.once('close', code => finish(code));
    }
    catch {
      finished = true;
      send({ type: 'spawn_failed' });
      if (process.connected)
        process.disconnect();
    }
  });
}
if (require.main === module)
  runPlannerPrintWorker();
