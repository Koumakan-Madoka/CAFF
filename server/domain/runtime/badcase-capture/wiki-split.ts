import crypto from 'node:crypto';
const fail = (code: string) => Object.assign(Error(code), { code });
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const WIKI_SPLIT_SEED = 'wikiskill-holdout-v1';
// D15: only newly marked cases use this per-ID policy. Never reassign existing
// imported/marked records when reading, restarting, or adding another case.
export const WIKI_MARKED_SPLIT_SALT = 'wikiskill-marked-split-v1';
export function assignMarkedCaseSplit(caseId: any): 'train' | 'gate' | 'test' {
  if (typeof caseId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(caseId)) throw fail('wiki_invalid_case_ids');
  const bucket = crypto.createHash('sha256').update(WIKI_MARKED_SPLIT_SALT + '\0' + caseId).digest().readUInt32BE(0);
  return bucket < 0x80000000 ? 'train' : bucket < 0xc0000000 ? 'gate' : 'test';
}
// Legacy fixed cohort; no outcome-dependent seed or reshuffling.
export function planReplaySplit(caseIds: any) {
  if (!Array.isArray(caseIds) || !caseIds.length || caseIds.length > 20 || new Set(caseIds).size !== caseIds.length
    || caseIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))) throw fail('wiki_invalid_case_ids');
  const ordered: string[] = [...caseIds].sort(), ranked = ordered.map(id => ({ id, rank: hash(WIKI_SPLIT_SEED + '\0' + id) }))
    .sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1);
  const testCaseIds = caseIds.length >= 6 ? ranked.slice(0, Math.round(caseIds.length / 3)).map(c => c.id).sort() : [];
  const trainCaseIds = ordered.filter(id => !testCaseIds.includes(id));
  return { id: 'split-' + hash(JSON.stringify(ordered)), seed: WIKI_SPLIT_SEED, caseIds: ordered, trainCaseIds, testCaseIds,
    insufficientSamples: caseIds.length < 6 };
}
