import { plannerError } from './embedded-planner-env';

export const DEFAULT_PLANNER_MAX_PROCESSES = 4;

// Parent startup configuration, never inherited from the sanitized child env.
// Diagnostics are fixed codes: do not echo a possibly sensitive input value.
export function parsePlannerMaxProcesses(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PLANNER_MAX_PROCESSES;
  const text = value.trim();
  const count = Number(text);
  if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(count) || count <= 0) {
    throw plannerError('planner_process_limit_invalid');
  }
  return count;
}
