// Case-owned, content-addressed rubric versions. Drafting is not judging.
import crypto from 'node:crypto';
import { containsSecretSentinel } from './secrets';
export const WIKI_RUBRIC_MODEL = 'deepseek/deepseek-v4-flash';
export const wikiRubricFail = (code: string) => Object.assign(Error(code), { code });
export function wikiValueHash(value: unknown): string {
  const canonical = (v: any): any => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
    }
    throw wikiRubricFail('wiki_rubric_invalid');
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function wikiRubricText(value: unknown, maxBytes: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > maxBytes
    || Buffer.from(value).toString('utf8') !== value || containsSecretSentinel(value)) throw wikiRubricFail('wiki_rubric_invalid');
}
export function wikiExactKeys(value: any, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw wikiRubricFail('wiki_rubric_invalid');
}
export interface WikiRubricQuestion { id: string; question: string; evidence: 'reply' | 'trace' | 'files' }
export interface WikiRubric {
  kind: 'wiki-rubric-v1'; id: string; caseId: string; version: number; model: typeof WIKI_RUBRIC_MODEL;
  sourceHash: string; questions: WikiRubricQuestion[]; hash: string; status: 'draft' | 'frozen';
  confirmedAt?: string; confirmationRecord?: string;
}
export function wikiRubricSourceHash(actual: string, expected: string): string {
  wikiRubricText(actual, 8192); wikiRubricText(expected, 8192);
  return wikiValueHash({ actual, expected });
}
export function validateWikiRubricQuestions(value: unknown): WikiRubricQuestion[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) throw wikiRubricFail('wiki_rubric_invalid');
  for (const q of value) {
    wikiExactKeys(q, ['id', 'question', 'evidence']);
    if (typeof q.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(q.id) || !['reply', 'trace', 'files'].includes(q.evidence)) throw wikiRubricFail('wiki_rubric_invalid');
    wikiRubricText(q.question, 2048);
  }
  if (new Set(value.map(q => q.id)).size !== value.length) throw wikiRubricFail('wiki_rubric_invalid');
  return structuredClone(value);
}
function rubricContent(value: WikiRubric) {
  return { kind: value.kind, caseId: value.caseId, version: value.version, model: value.model, sourceHash: value.sourceHash, questions: value.questions };
}
export function createWikiRubric(input: { caseId: string; version: number; model: string; actual: string; expected: string; questions: unknown }): WikiRubric {
  const content = { kind: 'wiki-rubric-v1' as const, caseId: input.caseId, version: input.version, model: WIKI_RUBRIC_MODEL as typeof WIKI_RUBRIC_MODEL,
    sourceHash: wikiRubricSourceHash(input.actual, input.expected), questions: validateWikiRubricQuestions(input.questions) };
  if (input.model !== WIKI_RUBRIC_MODEL || !/^[A-Za-z0-9_-]{1,128}$/.test(input.caseId)
    || !Number.isSafeInteger(input.version) || input.version < 1) throw wikiRubricFail('wiki_rubric_invalid');
  const hash = wikiValueHash(content);
  return { ...content, hash, id: 'rubric-' + hash, status: 'draft' };
}
export function validateWikiRubric(value: WikiRubric, frozen = false): WikiRubric {
  wikiExactKeys(value, ['kind', 'id', 'caseId', 'version', 'model', 'sourceHash', 'questions', 'hash', 'status',
    ...(value?.status === 'frozen' ? ['confirmedAt', 'confirmationRecord'] : [])]);
  if (value.kind !== 'wiki-rubric-v1' || value.model !== WIKI_RUBRIC_MODEL || !/^[A-Za-z0-9_-]{1,128}$/.test(value.caseId)
    || !Number.isSafeInteger(value.version) || value.version < 1 || !/^[a-f0-9]{64}$/.test(value.sourceHash)
    || !['draft', 'frozen'].includes(value.status)) throw wikiRubricFail('wiki_rubric_invalid');
  validateWikiRubricQuestions(value.questions);
  if (value.hash !== wikiValueHash(rubricContent(value)) || value.id !== 'rubric-' + value.hash) throw wikiRubricFail('wiki_rubric_hash_changed');
  if (value.status === 'frozen') {
    wikiRubricText(value.confirmationRecord, 4096);
    if (typeof value.confirmedAt !== 'string' || !Number.isFinite(Date.parse(value.confirmedAt))
      || new Date(value.confirmedAt).toISOString() !== value.confirmedAt) throw wikiRubricFail('wiki_rubric_invalid');
  } else if (frozen) throw wikiRubricFail('wiki_rubric_confirmation_required');
  return structuredClone(value);
}
export function resolveFrozenWikiRubric(state: { cases: any[]; rubrics?: WikiRubric[] }, caseId: string, hash: string): WikiRubric {
  const source = state.cases.find(c => c.id === caseId);
  if (!source) throw wikiRubricFail('wiki_unknown_case');
  const found = state.rubrics?.find(v => v.caseId === caseId && v.hash === hash);
  if (!found) throw wikiRubricFail('wiki_rubric_not_found');
  const result = validateWikiRubric(found, true);
  if (result.sourceHash !== wikiRubricSourceHash(source.actual, source.expected)) throw wikiRubricFail('wiki_rubric_source_changed');
  return result;
}
