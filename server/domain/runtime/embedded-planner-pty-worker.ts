// Isolated PTY guardian: IPC disconnect tears down its owned terminal tree.
// Neither this process nor the CLI receives the server's unrestricted env.
import * as pty from 'node-pty';
import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

function conptyOptions(): { useConpty?: boolean; useConptyDll?: boolean } {
  if (process.platform !== 'win32') return {};
  try {
    // Pinned node-pty 1.1.0 selects build/Release, build/Debug, then prebuilds.
    // Validate beside the native module it actually loads, not an unused copy.
    const utilsPath = require.resolve('node-pty/lib/utils');
    const native = require('node-pty/lib/utils').loadNativeModule('conpty');
    const directory = path.resolve(path.dirname(utilsPath), native.dir, 'conpty');
    for (const name of ['conpty.dll', 'OpenConsole.exe']) {
      const file = path.join(directory, name);
      if (!fs.statSync(file).isFile()) throw new Error();
      fs.accessSync(file, fs.constants.R_OK);
    }
    return { useConpty: true, useConptyDll: true };
  } catch {
    throw Object.assign(new Error('planner_conpty_unavailable'), { code: 'planner_conpty_unavailable' });
  }
}
import type { PlannerLaunch } from './embedded-planner-host';

export function runPlannerPtyWorker(): void {
  let terminal: pty.IPty | null = null, stopping = false, finished = false;
  let forceTimer: NodeJS.Timeout | undefined;
  let bytesPending = 0, overflowNotified = false;
  const send = (message: object, bytes = 0) => {
    if (!process.connected) return;
    bytesPending += bytes;
    process.send!(message, () => { bytesPending -= bytes; });
  };
  function force() {
    if (!terminal) return;
    if (process.platform === 'win32') {
      const exe = path.join(process.env.SystemRoot!, 'System32', 'taskkill.exe');
      execFile(exe, ['/pid', String(terminal.pid), '/t', '/f'], { env: process.env, windowsHide: true, timeout: 5000 }, () => {});
    } else {
      try { process.kill(-terminal.pid, 'SIGKILL'); } catch {}
    }
  }
  function stop() {
    if (stopping || finished) return;
    stopping = true;
    if (!terminal) return;
    forceTimer = setTimeout(force, 5000);
    try {
      if (process.platform === 'win32') terminal.kill();
      else process.kill(-terminal.pid, 'SIGHUP');
    } catch { force(); }
  }
  process.on('disconnect', () => { stop(); if (!terminal) process.exit(0); });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('message', (message: any) => {
    if (message.type === 'start' && !terminal && !finished) {
      const config = message.config as PlannerLaunch;
      try {
        terminal = pty.spawn(config.cli.file, [...config.cli.prefix, ...config.args], {
          cwd: config.cwd, env: config.env as Record<string,string>, cols: config.cols, rows: config.rows,
          name: 'xterm-256color', ...conptyOptions(),
        });
        terminal.onData(data => {
          // Bound IPC queue too. Slow peers cannot accumulate a hidden transcript.
          if (bytesPending > 1024 * 1024) { if (!overflowNotified) { overflowNotified = true; send({ type: 'overflow' }); } return; }
          overflowNotified = false;
          send({ type: 'data', data }, Buffer.byteLength(data));
        });
        terminal.onExit(({ exitCode, signal }) => {
          if (finished) return;
          finished = true;
          if (forceTimer) clearTimeout(forceTimer);
          // A process group can outlive its leader; tear it down on natural exit too.
          if (process.platform !== 'win32') force();
          send({ type: 'exit', exitCode, signal });
          if (process.connected) process.disconnect();
          // The ConPTY helper may briefly hold handles; do not keep the guardian alive.
          setTimeout(() => process.exit(0), 100).unref();
        });
        send({ type: 'started' });
        if (!process.connected) stop();
      } catch (error: any) {
        finished = true; send({ type: 'spawn_failed', code: error?.code === 'planner_conpty_unavailable' ? error.code : 'planner_process_spawn_failed' });
        if (process.connected) process.disconnect();
      }
    } else if (terminal && !stopping && message.type === 'input') terminal.write(message.data);
    else if (terminal && !stopping && message.type === 'resize') terminal.resize(message.cols, message.rows);
    else if (message.type === 'stop') stop();
  });
}
if (require.main === module) runPlannerPtyWorker();
