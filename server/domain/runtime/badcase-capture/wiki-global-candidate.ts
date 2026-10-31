// Deterministic global-target proposals. No model, production prompt update,
// role change, tool parameter change or automatic iteration occurs here.
import crypto from 'node:crypto';
import { getWikiTarget } from './wiki-targets';
import { containsSecretSentinel } from './secrets';
import { assertWikiCandidateNoLeak, buildAppendOnlyWikiDiff } from './wiki-candidate';
const fail = (code: string) => Object.assign(Error(code), { code });
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const id = (v: any) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export function buildGlobalWikiCandidate(state: any, input: any) {
  if (state.scope !== 'global' || !input || Object.keys(input).some(k => !['versionId', 'entryIds', 'targetId', 'files'].includes(k))
    || !id(input.versionId) || !id(input.targetId) || !Array.isArray(input.entryIds) || !input.entryIds.length || input.entryIds.length > 100
    || input.entryIds.some((v: any) => !id(v)) || new Set(input.entryIds).size !== input.entryIds.length) throw fail('wiki_candidate_invalid');
  const target = getWikiTarget(input.targetId), version = state.versions.find((v: any) => v.id === input.versionId);
  const entries = input.entryIds.map((entryId: string) => version?.entries.find((e: any) => e.id === entryId && e.status === 'approved'));
  if (entries.some((e: any) => !e)) throw fail('wiki_candidate_approved_required');
  const guidelines = entries.map((e: any) => e.guideline);
  if (guidelines.some((g: any) => typeof g !== 'string' || !g.trim() || [...g].length > 300 || g.includes('{{') || containsSecretSentinel(g))) throw fail('wiki_candidate_invalid');
  const appendedSection = '\n\nWikiSkill 已审核准则：\n' + guidelines.map((g: string) => '- ' + g).join('\n');
  const candidateText = target.baseText + appendedSection;
  if (Buffer.byteLength(candidateText) > 65536 || containsSecretSentinel(candidateText)) throw fail('wiki_candidate_invalid');
  assertWikiCandidateNoLeak(candidateText, state.cases.map((c: any) => c.expected), input.files, target);
  const identity = { kind: 'global-wiki-candidate-v1', targetId: target.id, baseHash: target.baseHash,
    candidateHash: hash(candidateText), versionId: version.id, entryIds: [...input.entryIds] };
  return { id: 'candidate-' + hash(JSON.stringify(identity)), ...identity, target, baseText: target.baseText, appendedSection, candidateText,
    diff: buildAppendOnlyWikiDiff(target.baseText, appendedSection, target.id + '.txt'),
    fileHashes: input.files.map((f: any) => ({ path: f.path, sha256: f.sha256 })) };
}
export function resolveGlobalWikiCandidate(state: any, candidateId: string, targetId: string, baseHash: string, files: any[]) {
  const saved = state.candidates?.find((c: any) => c.id === candidateId && c.kind === 'global-wiki-candidate-v1');
  if (!saved || saved.status !== 'confirmed') throw fail('wiki_candidate_confirmation_required');
  const target = getWikiTarget(targetId);
  if (saved.targetId !== targetId || target.baseHash !== baseHash || saved.baseHash !== baseHash || saved.baseText !== target.baseText) throw fail('wiki_candidate_target_mismatch');
  const rebuilt = buildGlobalWikiCandidate(state, { versionId: saved.versionId, entryIds: saved.entryIds, targetId: saved.targetId, files });
  if (saved.targetId !== targetId || rebuilt.baseHash !== baseHash || rebuilt.id !== saved.id || rebuilt.candidateHash !== saved.candidateHash
    || rebuilt.candidateText !== saved.candidateText || rebuilt.diff !== saved.diff || JSON.stringify(rebuilt.target) !== JSON.stringify(saved.target)) throw fail('wiki_candidate_target_mismatch');
  return rebuilt;
}
