import { EventEmitter } from 'node:events';
import type { PlannerCli } from './embedded-planner-cli';
import { buildPlannerEnvironment, plannerError } from './embedded-planner-env';
import { plannerAppendPrompt, type PlannerRoom } from './embedded-planner-room';
import { EmbeddedPlannerRepository } from '../../../storage/chat/embedded-planner.repository';
import { launchPlannerPty } from './embedded-planner-pty';
import { createTerminalModeTracker, type TerminalModeTracker } from './embedded-planner-modes';

export type PlannerLaunch = { cli: PlannerCli; args: string[]; cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number };
export type PlannerProcess = EventEmitter & { guardianPid?: number; write(data: string): void; resize(cols: number, rows: number): void; stop(force?: boolean): void };
export type TerminalEvent = { type: string; [key: string]: unknown };
type Listener = (event: TerminalEvent) => void;
type Entry = {
  state: 'starting' | 'interactive-attached' | 'interactive-retained' | 'headless-running' | 'stopping';
  context?: PlannerRoom; process?: PlannerProcess; leaseId?: string; sessionId?: string; listener?: Listener;
  retention?: any; retentionDeadline?: number; stopRequested?: boolean; ended: Promise<void>; end(): void;
  modes?: TerminalModeTracker; size?: { cols: number; rows: number };
  repaint?: { timer?: any; finish(): void };
};
type Options = {
  repository: EmbeddedPlannerRepository; resolveRoom(id: string): PlannerRoom | Promise<PlannerRoom>;
  baseUrl: string; env?: NodeJS.ProcessEnv; credentialPath?: string | null; cli: PlannerCli; maxProcesses?: number;
  launch?: (config: PlannerLaunch) => PlannerProcess | Promise<PlannerProcess>;
  setTimer?: (fn: () => void, ms: number) => any; clearTimer?: (id: any) => void; now?: () => number;
  repaintTimeoutMs?: number;
};
export function validTerminalSize(cols: unknown, rows: unknown): boolean {
  return Number.isInteger(cols) && Number(cols) >= 20 && Number(cols) <= 500
    && Number.isInteger(rows) && Number(rows) >= 5 && Number(rows) <= 300;
}
export function createEmbeddedPlannerHost(options: Options) {
  const entries = new Map<string, Entry>();
  const repository = options.repository;
  const schedule = options.setTimer || ((fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; });
  const cancel = options.clearTimer || clearTimeout;
  const now = options.now || (() => performance.now());
  let closing = false;
  const changes = new Set<() => void>();
  function changed() { for (const fn of changes) fn(); }
  function state(id: string): string {
    return entries.get(id)?.state || (repository.hasLease(id) ? 'uncertain' : 'absent');
  }
  function cancelRepaint(entry: Entry): void {
    if (entry.repaint?.timer) cancel(entry.repaint.timer);
    entry.repaint = undefined;
  }
  function requestRepaint(id: string, entry: Entry, listener: Listener): void {
    if (entries.get(id) !== entry || entry.state !== 'interactive-attached' || entry.listener !== listener) return;
    const pending = { timer: undefined as any, finish() {
      if (entry.repaint !== pending) return;
      cancelRepaint(entry);
      if (entries.get(id) !== entry || entry.state !== 'interactive-attached' || entry.listener !== listener) return;
      const size = entry.size!;
      entry.process!.resize(size.cols, size.rows);
    } };
    entry.repaint = pending;
    pending.timer = schedule(pending.finish, options.repaintTimeoutMs ?? 500);
    const size = entry.size!;
    // libuv samples console size asynchronously: do NOT undo this in the same
    // tick. Restore after forwarding the first output, or at the bounded cap.
    entry.process!.resize(size.cols < 500 ? size.cols + 1 : size.cols - 1, size.rows);
  }
  function stop(entry: Entry): void {
    cancelRepaint(entry);
    if (entry.retention) { cancel(entry.retention); entry.retention = undefined; }
    // Mark intent before stop(): an adapter may emit exit synchronously. State
    // alone is not intent, since an uncertain observation also fences as stopping.
    entry.stopRequested = true; entry.state = 'stopping';
    entry.process?.stop();
  }
  function release(id: string, entry: Entry): void {
    if (entries.get(id) !== entry) return;
    cancelRepaint(entry);
    if (entry.retention) cancel(entry.retention);
    if (entry.leaseId) repository.release(id, entry.leaseId);
    entry.listener = undefined;
    entries.delete(id); entry.end(); changed();
  }
  function admit(id: string): Entry {
    if (closing || entries.has(id)) throw plannerError('planner_room_busy');
    if (repository.hasLease(id)) throw plannerError('planner_process_exit_unconfirmed');
    // Include uncertain persisted leases and starting/stopping/deleted-room children.
    const localLeases = [...entries.entries()].filter(([roomId, e]) => e.leaseId && repository.hasLease(roomId)).length;
    if (entries.size + repository.leaseCount() - localLeases >= (options.maxProcesses ?? 4)) throw plannerError('planner_process_limit');
    let end!: () => void;
    const entry: Entry = { state: 'starting', ended: new Promise<void>(resolve => { end = resolve; }), end: () => end() };
    entries.set(id, entry);
    return entry;
  }
  function recordGuardian(id: string, entry: Entry, child: PlannerProcess): void {
    // Synthetic DI processes may lack a PID; their lease stays unknown. The
    // real guardian adapter always supplies its own PID, never the CLI PID.
    if (child.guardianPid === undefined) return;
    try { repository.recordGuardian(id, entry.leaseId!, child.guardianPid); }
    catch {
      // A child already exists: failed PID persistence must never free its slot.
      // Observe its eventual exit via the installed listeners, otherwise fence.
      entry.listener = undefined; stop(entry);
      throw plannerError('planner_process_exit_unconfirmed');
    }
  }
  // M4 supplies the print-mode launcher and post-admission eligibility/quota
  // reservation. It cannot bypass the PTY's room/session/global admission path.
  async function startHeadless(id: string, launch: (config: PlannerLaunch) => PlannerProcess | Promise<PlannerProcess>,
    prepare: (context: PlannerRoom) => void | Promise<void> = () => {}) {
    const entry = admit(id);
    try {
      entry.context = await options.resolveRoom(id);
      if (!repository.read(id)?.launchAttempted) throw plannerError('session_uninitialized');
      if (closing) throw plannerError('planner_room_busy');
      const env = buildPlannerEnvironment({ source: options.env, baseUrl: options.baseUrl, roomId: id, credentialPath: options.credentialPath });
      const prompt = plannerAppendPrompt(entry.context);
      await prepare(entry.context);
      if (closing) throw plannerError('planner_room_busy');
      const claim = repository.claim(id);
      entry.leaseId = claim.leaseId; entry.sessionId = claim.metadata.sessionId;
      let child: PlannerProcess;
      try {
        child = await launch({ cli: options.cli, args: ['--resume', entry.sessionId, '--append-system-prompt', prompt],
          env, cwd: entry.context.cwd, cols: 120, rows: 30 });
      } catch (error: any) {
        throw plannerError(error?.code === 'planner_process_spawn_failed' ? error.code : 'planner_process_exit_unconfirmed');
      }
      entry.process = child; entry.state = 'headless-running';
      child.once('exit', () => release(id, entry));
      child.once('uncertain', () => { entry.state = 'stopping'; });
      recordGuardian(id, entry, child);
      if (closing) stop(entry);
      return { process: child, sessionId: entry.sessionId, finished: entry.ended, stop: () => stop(entry) };
    } catch (error: any) {
      if (error?.code === 'planner_process_exit_unconfirmed') entry.state = 'stopping';
      else release(id, entry);
      throw error;
    }
  }
  async function attach(id: string, size: { cols: number; rows: number }, listener: Listener) {
    if (closing) throw plannerError('planner_room_busy');
    if (!validTerminalSize(size.cols, size.rows)) throw plannerError('planner_terminal_message_invalid');
    let entry = entries.get(id);
    let resumed = true;
    if (entry && entry.state !== 'interactive-retained') throw plannerError(entry.state === 'interactive-attached' ? 'planner_terminal_in_use' : 'planner_room_busy');
    if (entry) {
      // Reserve writer and suspend expiry while revalidating, without extending
      // the retention deadline on a failed attach. Exit/shutdown may race the await.
      entry.state = 'starting';
      if (entry.retention) { cancel(entry.retention); entry.retention = undefined; }
      try {
        const context = await options.resolveRoom(id);
        if (closing || entries.get(id) !== entry || entry.state !== 'starting') throw plannerError('planner_room_busy');
        if (context.cwd !== entry.context?.cwd || context.projectId !== entry.context?.projectId || context.branch !== entry.context?.branch) throw plannerError('planner_workspace_invalid');
      } catch (error) {
        if (!closing && entries.get(id) === entry && entry.state === 'starting') {
          entry.state = 'interactive-retained';
          entry.retention = schedule(() => stop(entry!), Math.max(0, (entry.retentionDeadline || now()) - now()));
        }
        throw error;
      }
      entry.listener = listener;
      entry.state = 'interactive-attached'; entry.size = { ...size };
      // Restore input/buffer modes before requesting *new* CLI repaint output.
      // No screen contents, transcript replay or input injection. Subscribe first.
      const modes = entry.modes!.restore();
      if (modes) listener({ type: 'output', data: modes });
      requestRepaint(id, entry, listener);
    } else {
      entry = admit(id);
      const current = entry;
      try {
        current.context = await options.resolveRoom(id);
        if (closing) throw plannerError('planner_room_busy');
        const prompt = plannerAppendPrompt(current.context);
        const env = buildPlannerEnvironment({ source: options.env, baseUrl: options.baseUrl, roomId: id,
          credentialPath: options.credentialPath, interactive: true });
        const claim = repository.claim(id);
        current.leaseId = claim.leaseId; current.sessionId = claim.metadata.sessionId; resumed = !claim.first;
        const launch = options.launch || launchPlannerPty;
        let child: PlannerProcess;
        try {
          child = await launch({ cli: options.cli, args: [claim.first ? '--session-id' : '--resume', current.sessionId,
            '--append-system-prompt', prompt], cwd: current.context.cwd, env, ...size });
        } catch (error: any) {
          if (['planner_process_exit_unconfirmed', 'planner_conpty_unavailable'].includes(error?.code)) throw error;
          throw plannerError('planner_process_spawn_failed');
        }
        current.process = child; current.listener = listener; current.state = 'interactive-attached';
        current.size = { ...size }; current.modes = createTerminalModeTracker();
        child.on('data', (data: string) => {
          current.modes!.feed(data);
          // Capture this generation before forwarding: a listener may detach or
          // be replaced during output. It must not finish a later owner's nudge.
          const repaint = current.repaint;
          // UTF-8 code-point boundaries; 8 KiB data also fits the 64 KiB wire
          // budget under worst-case 6x JSON escaping of dense terminal controls.
          let chunk = '', bytes = 0;
          for (const char of data) {
            const n = Buffer.byteLength(char);
            if (bytes + n > 8192) { current.listener?.({ type: 'output', data: chunk }); chunk = ''; bytes = 0; }
            chunk += char; bytes += n;
          }
          if (chunk) current.listener?.({ type: 'output', data: chunk });
          if (data.length) repaint?.finish();
        });
        child.on('overflow', () => current.listener?.({ type: 'error', code: 'planner_terminal_slow_consumer', message: 'Terminal connection is too slow' }));
        child.once('exit', (exit: any) => {
          current.listener?.({ type: 'exit', ...exit, reasonCode: current.stopRequested ? 'planner_process_stopped' : resumed && exit.exitCode !== 0 ? 'planner_session_unavailable' : 'planner_process_exited' });
          release(id, current);
        });
        child.once('uncertain', () => {
          cancelRepaint(current);
          current.state = 'stopping';
          current.listener?.({ type: 'error', code: 'planner_process_exit_unconfirmed', message: 'Process exit could not be confirmed' });
        });
        recordGuardian(id, current, child);
        if (closing) stop(current);
      } catch (error: any) {
        if (error?.code === 'planner_process_exit_unconfirmed') { current.state = 'stopping'; }
        else release(id, current);
        throw error;
      }
    }
    const owned = entry;
    return {
      sessionId: owned.sessionId!, resumed,
      write(data: string) {
        if (owned.listener !== listener || owned.state !== 'interactive-attached') throw plannerError('planner_room_busy');
        owned.process!.write(data);
      },
      resize(cols: number, rows: number) {
        if (!validTerminalSize(cols, rows) || owned.listener !== listener || owned.state !== 'interactive-attached') throw plannerError('planner_terminal_message_invalid');
        owned.size = { cols, rows };
        if (!owned.repaint) owned.process!.resize(cols, rows);
      },
      detach() {
        if (owned.listener !== listener) return;
        cancelRepaint(owned);
        owned.listener = undefined;
        if (owned.state === 'interactive-attached') {
          owned.state = 'interactive-retained';
          owned.retentionDeadline = now() + 30 * 60 * 1000;
          owned.retention = schedule(() => stop(owned), 30 * 60 * 1000);
        }
      },
      terminate() { if (owned.listener === listener) stop(owned); },
    };
  }
  async function close(): Promise<void> {
    closing = true;
    const pending = [...entries.values()];
    pending.forEach(stop);
    if (!pending.length) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(pending.map(e => e.ended)), new Promise<void>(resolve => { timer = setTimeout(resolve, 11000); })]);
    if (timer) clearTimeout(timer);
    // Any uncertain leases deliberately survive; the next boot cannot overlap them.
  }
  return { attach, startHeadless, state, close,
    onChange(fn: () => void) { changes.add(fn); return () => { changes.delete(fn); }; },
    attention(id: string, data: { sequences: number[]; unresolvedCount: number; needsUserCount: number }) { entries.get(id)?.listener?.({ type: 'attention', ...data }); },
    hasEntry: (id: string) => entries.has(id), canWake: (id: string) => !closing && state(id) === 'absent' };
}
export type EmbeddedPlannerHost = ReturnType<typeof createEmbeddedPlannerHost>;
