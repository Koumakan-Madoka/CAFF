import { performance } from 'node:perf_hooks';

export const CAPTURE_TIME_LIMIT_MS = 15000;
export const isCaptureTimeLimit = (error: any): boolean => error?.code === 'capture_time_limit';

// One allowance for coverage/Git/files plus the later SDK skill archive. Only
// active capture time is charged; SDK initialization itself is not capture IO.
// Synchronous local file IO cannot be preempted: check before/after each item.
export function createCaptureTimeBudget(options: any = {}) {
  const now: () => number = options.captureNow || (() => performance.now());
  const limit = Number.isFinite(options.captureTimeLimitMs)
    ? Math.max(0, Math.min(CAPTURE_TIME_LIMIT_MS, options.captureTimeLimitMs)) : CAPTURE_TIME_LIMIT_MS;
  const started = now();
  let exhausted = false;
  const remainingMs = () => exhausted ? 0 : Math.max(0, limit - (now() - started));
  const expire = (): never => { exhausted = true; throw Object.assign(Error('capture_time_limit'), { code: 'capture_time_limit' }); };
  const check = () => { if (remainingMs() <= 0) expire(); };
  return { remainingMs, check, expire };
}

export type CaptureTimeBudget = ReturnType<typeof createCaptureTimeBudget>;
