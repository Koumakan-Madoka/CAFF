import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import path from 'node:path';
import { plannerError } from './embedded-planner-env';
import type { PlannerLaunch, PlannerProcess } from './embedded-planner-host';

export function launchPlannerPty(config: PlannerLaunch): Promise<PlannerProcess> {
  return new Promise((resolve, reject) => {
    const events = new EventEmitter() as PlannerProcess;
    const worker = fork(path.join(__dirname, 'embedded-planner-pty-worker.js'), [], {
      // Bundled OpenConsole inherits the guardian cwd and can briefly outlive
      // its PTY exit event. Do not let that helper pin the room worktree/temp
      // directory. The actual CLI still gets config.cwd explicitly in spawn.
      env: config.env, cwd: process.platform === 'win32' ? path.dirname(process.execPath) : config.cwd,
      execArgv: [], stdio: ['ignore','ignore','ignore','ipc'],
    });
    let started = false, failureCode = '', exit: any = null;
    let activated = false, initialBytes = 0, initialOverflow = false;
    let initialData: string[] = [];
    // Bound only the initial IPC->listener handoff; never retain/replay output
    // after the host subscribes (including while its browser is detached).
    events.on('newListener', name => {
      if (name !== 'data' || activated) return;
      queueMicrotask(() => {
        if (activated) return;
        activated = true;
        for (const data of initialData) events.emit('data', data);
        initialData = [];
        if (initialOverflow) events.emit('overflow');
      });
    });
    const send = (data: object) => {
      if (worker.connected && !worker.send(data, error => { if (error) events.emit('uncertain'); })) events.emit('overflow');
    };
    events.write = data => send({ type: 'input', data });
    events.resize = (cols, rows) => send({ type: 'resize', cols, rows });
    let stopTimer: NodeJS.Timeout | undefined;
    events.stop = () => {
      if (!stopTimer) { stopTimer = setTimeout(() => events.emit('uncertain'), 10000); stopTimer.unref(); }
      send({ type: 'stop' });
    };
    // Startup uncertainty is fenced by the host, never silently admitted again.
    const timer = setTimeout(() => {
      events.stop(); reject(plannerError('planner_process_exit_unconfirmed'));
    }, 10000);
    worker.on('message', (message: any) => {
      if (message.type === 'started') {
        clearTimeout(timer); started = true;
        events.guardianPid = worker.pid;
        resolve(events);
      }
      else if (message.type === 'data') {
        if (activated) events.emit('data', message.data);
        else {
          initialBytes += Buffer.byteLength(message.data);
          if (initialBytes <= 1024 * 1024) initialData.push(message.data);
          else initialOverflow = true;
        }
      }
      else if (message.type === 'overflow') events.emit('overflow');
      else if (message.type === 'exit') exit = { exitCode: message.exitCode, ...(message.signal ? { signal: String(message.signal) } : {}) };
      else if (message.type === 'spawn_failed') failureCode = message.code === 'planner_conpty_unavailable' ? message.code : 'planner_process_spawn_failed';
    });
    worker.once('error', () => { clearTimeout(timer); failureCode = 'planner_process_spawn_failed'; reject(plannerError(failureCode)); });
    worker.once('exit', () => {
      clearTimeout(timer);
      if (stopTimer) clearTimeout(stopTimer);
      if (!started) reject(plannerError(failureCode || 'planner_process_exit_unconfirmed'));
      else if (exit) events.emit('exit', exit);
      else events.emit('uncertain');
    });
    send({ type: 'start', config });
  });
}
