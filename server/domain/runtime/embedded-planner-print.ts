import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import path from 'node:path';
import type { PlannerLaunch, PlannerProcess } from './embedded-planner-host';
import { plannerError } from './embedded-planner-env';
export function launchPlannerPrint(config: PlannerLaunch & {
  prompt: string;
}): Promise<PlannerProcess> {
  return new Promise((resolve, reject) => {
    const events = new EventEmitter() as PlannerProcess;
    const worker = fork(path.join(__dirname, 'embedded-planner-print-worker.js'), [], { env: config.env, cwd: config.cwd, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let started = false, failed = false, exit: any = null, active = false, bytes = 0;
    let stopTimer: NodeJS.Timeout | undefined;
    const initial: any[] = [];
    events.on('newListener', name => { if (name === 'data' && !active)
      queueMicrotask(() => { if (active)
        return; active = true; for (const e of initial)
        events.emit(e.type, e.data); initial.length = 0; }); });
    const send = (m: object) => { if (worker.connected)
      worker.send(m, err => { if (err)
        events.emit('uncertain'); }); };
    events.guardianPid = worker.pid;
    events.write = () => { };
    events.resize = () => { };
    events.stop = (force = false) => { if (!stopTimer) {
      stopTimer = setTimeout(() => events.emit('uncertain'), 10000);
      stopTimer.unref();
    } send({ type: 'stop', force }); };
    const timer = setTimeout(() => { events.stop(); reject(plannerError('planner_process_exit_unconfirmed')); }, 10000);
    timer.unref();
    worker.on('message', (m: any) => {
      if (m.type === 'started') {
        started = true;
        clearTimeout(timer);
        resolve(events);
      }
      else if (m.type === 'data' || m.type === 'stderr') {
        if (active)
          events.emit(m.type, m.data);
        else {
          bytes += Buffer.byteLength(m.data);
          if (bytes <= 1048576)
            initial.push(m);
          else
            events.stop();
        }
      }
      else if (m.type === 'overflow')
        events.emit('overflow');
      else if (m.type === 'exit')
        exit = { exitCode: m.exitCode };
      else if (m.type === 'spawn_failed')
        failed = true;
    });
    worker.once('error', () => { clearTimeout(timer); reject(plannerError('planner_process_exit_unconfirmed')); });
    worker.once('exit', () => { clearTimeout(timer); if (stopTimer)
      clearTimeout(stopTimer); if (!started)
      reject(plannerError(failed ? 'planner_process_spawn_failed' : 'planner_process_exit_unconfirmed'));
    else if (exit)
      events.emit('exit', exit);
    else
      events.emit('uncertain'); });
    send({ type: 'start', config });
  });
}
