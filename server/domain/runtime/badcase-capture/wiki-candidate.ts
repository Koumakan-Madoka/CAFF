// Deterministic append-only role proposal, never a model-generated replacement.
import crypto from 'node:crypto';
import { containsSecretSentinel } from './secrets';
const fail = (code: string) => Object.assign(Error(code), { code });
const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
// Infer only the two supported archived wrappers from the bound span hash.
// No new persona is invented for the GPT model-family role.
const PREFIXES = ['Your private persona instructions:\n', 'Rules:\n'];
const identifier = (value: any) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

// Literal-only guard: complete nonempty values, nonempty lines, and any shared
// run of >=8 Unicode characters. Shorter paraphrases are NOT semantic detection.
export function assertWikiGuidelinesNoLeak(guidelines: string[], expected: string[], files: any[]) {
  const combined = guidelines.join('\n');
  const sources = expected.filter(s => typeof s === 'string' && s.trim());
  if (!Array.isArray(files) || files.length > 1024) throw fail('wiki_candidate_invalid');
  let size = 0;
  for (const file of files) {
    if (!file || typeof file.base64 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw fail('wiki_candidate_invalid');
    const bytes = Buffer.from(file.base64, 'base64'); size += bytes.length;
    if (size > 4 * 1024 * 1024 || hash(bytes) !== file.sha256) throw fail('wiki_candidate_invalid');
    if (bytes.length && Buffer.from(combined).includes(bytes)) throw fail('wiki_candidate_leak');
    const text = bytes.toString('utf8');
    if (Buffer.from(text).equals(bytes) && text.trim()) sources.push(text);
  }
  const windows = [...new Set(guidelines.flatMap(g => {
    const chars = [...g]; return chars.slice(0, Math.max(0, chars.length - 7)).map((_, i) => chars.slice(i, i + 8).join(''));
  }))];
  for (const source of sources) {
    if (combined.includes(source.trim()) || source.split(/\r?\n/).some(line => line.trim() && combined.includes(line.trim()))
      || windows.some(fragment => source.includes(fragment))) throw fail('wiki_candidate_leak');
  }
}

export function buildWikiCandidate(state: any, input: any) {
  if (!input || Object.keys(input).some(k => !['versionId', 'entryIds', 'baseRole', 'anchor', 'files'].includes(k))
    || !identifier(input.versionId) || !Array.isArray(input.entryIds) || !input.entryIds.length || input.entryIds.length > 100
    || input.entryIds.some((id: any) => !identifier(id)) || new Set(input.entryIds).size !== input.entryIds.length
    || typeof input.baseRole !== 'string' || !input.baseRole.trim() || input.baseRole.includes('\0') || input.baseRole.includes('{{')
    || Buffer.byteLength(input.baseRole) > 60000 || containsSecretSentinel(input.baseRole)) throw fail('wiki_candidate_invalid');
  const anchor = input.anchor;
  if (!anchor || Object.keys(anchor).sort().join(',') !== 'caseId,checkpointId,originalRoleHash'
    || !identifier(anchor.caseId) || !identifier(anchor.checkpointId) || !/^[a-f0-9]{64}$/.test(anchor.originalRoleHash)
    || !PREFIXES.some(prefix => hash(prefix + input.baseRole) === anchor.originalRoleHash)) throw fail('wiki_candidate_role_mismatch');
  const version = state.versions.find((v: any) => v.id === input.versionId && v.role === 'GPT');
  const entries = input.entryIds.map((id: string) => version?.entries.find((e: any) => e.id === id && e.status === 'approved'));
  if (entries.some((e: any) => !e)) throw fail('wiki_candidate_approved_required');
  const guidelines = entries.map((e: any) => e.guideline);
  if (guidelines.some((g: any) => typeof g !== 'string' || !g.trim() || [...g].length > 300 || containsSecretSentinel(g) || g.includes('{{'))) throw fail('wiki_candidate_invalid');
  assertWikiGuidelinesNoLeak(guidelines, state.cases.map((c: any) => c.expected), input.files);
  const appendedSection = '\n\nWikiSkill 已审核准则：\n' + guidelines.map((g: string) => '- ' + g).join('\n');
  const candidateRole = input.baseRole + appendedSection;
  if (Buffer.byteLength(candidateRole) > 65536) throw fail('wiki_candidate_invalid');
  const identity = { versionId: version.id, entryIds: [...input.entryIds], baseRoleHash: hash(input.baseRole),
    candidateRoleHash: hash(candidateRole), anchor: { ...anchor } };
  // A real append-only unified diff, including the original's exact final
  // newline state. The full original body is separately available for review.
  const trailingNewline = input.baseRole.endsWith('\n'), oldLines = input.baseRole.split('\n');
  if (trailingNewline) oldLines.pop();
  const added = appendedSection.split('\n');
  if (!trailingNewline) added.shift(); // first newline terminates the old tail
  if (candidateRole.endsWith('\n')) added.pop();
  let diff = '--- a/GPT-role.txt\n+++ b/GPT-role.txt\n';
  if (trailingNewline) diff += `@@ -${oldLines.length},1 +${oldLines.length},${added.length + 1} @@\n ${oldLines.at(-1)}\n`;
  else diff += `@@ -${oldLines.length},1 +${oldLines.length},${added.length + 1} @@\n-${oldLines.at(-1)}\n\\ No newline at end of file\n+${oldLines.at(-1)}\n`;
  diff += added.map(line => '+' + line).join('\n') + '\n';
  if (!candidateRole.endsWith('\n')) diff += '\\ No newline at end of file\n';
  return { id: 'candidate-' + hash(JSON.stringify(identity)), role: 'GPT', ...identity, baseRole: input.baseRole,
    appendedSection, candidateRole, diff, fileHashes: input.files.map((f: any) => ({ path: f.path, sha256: f.sha256 })) };
}

export function resolveWikiCandidate(state: any, candidateId: string, originalRoleHash: string, files: any[]) {
  const saved = state.candidates?.find((c: any) => c.id === candidateId);
  if (!saved || saved.status !== 'confirmed') throw fail('wiki_candidate_confirmation_required');
  const rebuilt = buildWikiCandidate(state, { versionId: saved.versionId, entryIds: saved.entryIds,
    baseRole: saved.baseRole, anchor: saved.anchor, files });
  if (rebuilt.id !== saved.id || rebuilt.candidateRole !== saved.candidateRole || rebuilt.diff !== saved.diff
    || rebuilt.candidateRoleHash !== saved.candidateRoleHash || saved.anchor.originalRoleHash !== originalRoleHash) throw fail('wiki_candidate_role_mismatch');
  return rebuilt;
}
