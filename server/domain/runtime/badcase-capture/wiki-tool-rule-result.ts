// Common run/trace rule semantics, over already identified observations only.
// No shell grammar, callbacks, judge, I/O or argument coercion beyond D3.
import { wikiToolRulePasses, type WikiToolCheck } from './wiki-tool-check';
export type WikiToolObservation = { kind: 'other' | 'unknown' }
  | { kind: 'target'; parameters: Record<string, unknown> };
export interface WikiToolCheckResult {
  status: 'pass' | 'fail' | 'invalid' | 'unreached' | 'unconfigured'; reason: string | null;
}
export function evaluateWikiToolObservations(calls: WikiToolObservation[], check: WikiToolCheck): WikiToolCheckResult {
  let reached = check.mode === 'forbid', unresolved = false, failed = false;
  for (const parsed of calls) {
    if (parsed.kind === 'unknown') { unresolved = true; continue; }
    if (parsed.kind !== 'target') continue;
    reached = true;
    for (const rule of check.rules) {
      const value = parsed.parameters[rule.parameter];
      if (!Object.hasOwn(parsed.parameters, rule.parameter)
        || !(value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value))) {
        unresolved = true; continue;
      }
      if (!wikiToolRulePasses(rule, value as string | number | boolean | null)) failed = true;
    }
  }
  // One violation is decisive even when another observed call is unresolved.
  return failed ? { status: 'fail', reason: 'tool_rule_failed' } : unresolved ? { status: 'invalid', reason: 'arguments_unparseable' }
    : reached ? { status: 'pass', reason: null } : { status: 'unreached', reason: 'target_not_called' };
}
