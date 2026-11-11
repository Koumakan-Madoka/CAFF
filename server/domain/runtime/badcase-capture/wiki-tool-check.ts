// Frozen data-only rules. No scripts, model instructions or shell execution.
import { containsSecretSentinel } from './secrets';
export interface WikiToolRule {
  parameter: string; kind: 'max-chars' | 'allowed-values' | 'forbidden-values'; max?: number; values?: string[];
}
export interface WikiToolCheck {
  method: 'code'; target: { kind: 'caff-chat' | 'native'; name: string }; mode: 'on-call' | 'forbid'; rules: WikiToolRule[];
}
const fail = () => Object.assign(Error('wiki_tool_check_invalid'), { code: 'wiki_tool_check_invalid' });
function exact(value: any, keys: string[]) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join('|') !== keys.sort().join('|')) throw fail();
}
export function validateWikiToolCheck(value: unknown): WikiToolCheck {
  const v = value as WikiToolCheck;
  exact(v, ['method', 'target', 'mode', 'rules']); exact(v.target, ['kind', 'name']);
  if (v.method !== 'code' || !['on-call', 'forbid'].includes(v.mode) || !['caff-chat', 'native'].includes(v.target.kind)
    || typeof v.target.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(v.target.name)
    || !Array.isArray(v.rules) || !v.rules.length || v.rules.length > 32) throw fail();
  for (const rule of v.rules) {
    exact(rule, ['parameter', 'kind', ...(rule?.kind === 'max-chars' ? ['max'] : ['values'])]);
    if (typeof rule.parameter !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(rule.parameter)) throw fail();
    if (rule.kind === 'max-chars') {
      if (!Number.isSafeInteger(rule.max) || rule.max! < 0 || rule.max! > 1048576) throw fail();
    } else if (['allowed-values', 'forbidden-values'].includes(rule.kind)) {
      if (!Array.isArray(rule.values) || !rule.values.length || rule.values.length > 128 || new Set(rule.values).size !== rule.values.length
        || rule.values.some(s => typeof s !== 'string' || s !== s.trim() || s.includes('\0') || Buffer.byteLength(s) > 4096
          || Buffer.from(s).toString('utf8') !== s)) throw fail();
    } else throw fail();
  }
  if (Buffer.byteLength(JSON.stringify(v)) > 32768 || containsSecretSentinel(JSON.stringify(v))) throw fail();
  return structuredClone(v);
}
// Matches session-goal.ts normalizeProposalReason / normalizeText exactly:
// String(value || '').trim(), followed by UTF-16 .length, not code points or clipping.
export function wikiToolParameterText(value: string | number | boolean | null): string { return String(value || '').trim(); }
export function wikiToolRulePasses(rule: WikiToolRule, value: string | number | boolean | null): boolean {
  const text = wikiToolParameterText(value);
  return rule.kind === 'max-chars' ? text.length <= rule.max!
    : rule.kind === 'allowed-values' ? rule.values!.includes(text) : !rule.values!.includes(text);
}
