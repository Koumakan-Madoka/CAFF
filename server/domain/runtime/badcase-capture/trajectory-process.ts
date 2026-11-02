// Bounded asynchronous source adapter for sealing. This trusted child only
// reads SQLite; it never starts helpers or agents. Killing its PID is sufficient
// for this implementation, NOT a general process-tree/sandbox guarantee.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { trajectoryFailureCodes, validateTrajectoryRequest } from './trajectory';
const fail = (code: string) => Object.assign(new Error(code), { code });
const object = (value: any) => value && typeof value === 'object' && !Array.isArray(value);
let active = 0;
const MAX_ACTIVE = 2;

export async function readBadcaseTrajectoryAsync(request: any, options: any = {}): Promise<any> {
  if (!object(request) || Object.keys(request).some(key => !['databasePath', 'association', 'limits'].includes(key))
    || typeof request.databasePath !== 'string' || !path.isAbsolute(request.databasePath)
    || request.databasePath.includes('\0')) throw fail('trajectory_invalid_input');
  // Detach validated values before any asynchronous work. Caller edits while a
  // reader runs must not change which association its response is checked for.
  const validated = validateTrajectoryRequest(request);
  const bytes = JSON.stringify({ databasePath: request.databasePath, ...validated });
  if (Buffer.byteLength(bytes) > 16384) throw fail('trajectory_invalid_input');
  if (active >= MAX_ACTIVE) throw fail('trajectory_busy');
  const bounded = (value: any, ceiling: number) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, ceiling) : ceiling;
  const timeoutMs = bounded(options.timeoutMs, 30000);
  const maxOutputBytes = bounded(options.maxOutputBytes, 4 * 1024 * 1024 + 1024);
  // Do not propagate NODE_OPTIONS / NODE_PATH preload hooks or host runtime
  // credentials into the reader. Keep only OS temporary/system-path variables.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  active++;
  try {
    return await new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(process.execPath, ['--max-old-space-size=128', options.workerPath || path.join(__dirname, 'trajectory-worker.js')], {
          stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env,
        });
      } catch { reject(fail('trajectory_process_failed')); return; }
      let reason = '', outputBytes = 0;
      const chunks: Buffer[] = [];
      const stop = (code: string) => {
        if (!reason) reason = code;
        // No descendant processes exist in the production worker. On Windows
        // Node implements SIGKILL with forced process termination.
        try { child.kill('SIGKILL'); } catch { /* error/close still determines completion */ }
      };
      const timer = setTimeout(() => stop('trajectory_timeout'), timeoutMs);
      child.on('error', () => stop('trajectory_process_failed'));
      child.stdin!.on('error', () => { /* early worker exit is checked on close */ });
      child.on('spawn', () => {
        try { options.onSpawn?.(child.pid); } catch { stop('trajectory_process_failed'); }
      });
      const consume = (data: Buffer, stdout: boolean) => {
        outputBytes += data.length;
        if (outputBytes > maxOutputBytes) { stop('trajectory_output_limit'); return; }
        if (reason) return;
        if (stdout) {
          chunks.push(data);
          // Internal test observers only, never supplied by HTTP/DB/policy.
          try { options.onOutput?.(data); } catch { stop('trajectory_process_failed'); }
        }
      };
      child.stdout!.on('data', (data: Buffer) => consume(data, true));
      child.stderr!.on('data', (data: Buffer) => consume(data, false)); // never relay diagnostics
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (reason) { reject(fail(reason)); return; }
        if (code !== 0) { reject(fail('trajectory_process_failed')); return; }
        try {
          const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (envelope?.ok === false && trajectoryFailureCodes.includes(envelope.code)) { reject(fail(envelope.code)); return; }
          const result = envelope?.result;
          if (envelope?.ok !== true || !object(result) || result.schemaVersion !== 1
            || result.kind !== 'badcase-database-trajectory' || result.databaseConsistent !== true
            || result.complete !== false || result.strictEvalEligible !== false
            || result.contentPolicy !== 'reject_known_sensitive_and_private_markers'
            || !object(result.association) || Object.keys(result.association).length !== Object.keys(validated.association).length
            || Object.entries(validated.association).some(([key, value]) => result.association[key] !== value)
            || !Array.isArray(result.events) || result.events.length > validated.limits.maxEvents
            || result.archivedEventCount !== result.events.length || !Number.isSafeInteger(result.totalTaskEventCount)
            || result.totalTaskEventCount < result.events.length || !object(result.task) || !object(result.run)
            || !Array.isArray(result.incompleteReasons) || !result.incompleteReasons.length
            || !result.incompleteReasons.every((value: any) => typeof value === 'string')
            || Buffer.byteLength(JSON.stringify(result)) > validated.limits.maxBytes) throw Error('invalid');
          resolve(result);
        } catch { reject(fail('trajectory_output_invalid')); }
      });
      try { child.stdin!.end(bytes); } catch { stop('trajectory_invalid_input'); }
    });
  } finally { active--; }
}
