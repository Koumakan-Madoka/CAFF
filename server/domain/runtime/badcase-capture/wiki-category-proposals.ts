// Category identity is suggestion-only. Immutable model records and separate
// resolutions preserve history; one store snapshot publishes each consent.
import crypto from 'node:crypto';
import { projectWikiPatternLabels } from './wiki-initial-split';
import { wikiPendingPatternText } from './wiki-pattern-label';
import { containsSecretSentinel } from './secrets';
const fail = (code: string) => Object.assign(Error(code), { code });
const hash = (v: any) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
function closed(v: any, keys: string[]) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw fail('wiki_invalid_input');
}
function identifier(v: any) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v)) throw fail('wiki_invalid_input');
  return v;
}
function digest(v: any) { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) throw fail('wiki_invalid_input'); return v; }
function revision(state: any, expected: any) {
  if (!Number.isSafeInteger(expected)) throw fail('wiki_invalid_input');
  if (state.revision !== expected) throw fail('wiki_revision_conflict');
}
export function wikiCategoryEligibleCases(state: any) {
  const confirmed = new Set(projectWikiPatternLabels(state).filter((l: any) => l.confirmed).map((l: any) => l.caseId));
  return state.cases.filter((c: any) => c.kind === 'marked-badcase' && c.source?.agentId === 'role-family-gpt'
    && c.split === null && !confirmed.has(c.id) && c.preclassification?.kind === 'new');
}
export function projectWikiCategoryProposals(state: any) {
  const eligible = new Set(wikiCategoryEligibleCases(state).map((c: any) => c.id));
  return (state.categoryProposals || []).map((p: any) => {
    const status = state.categoryProposalResolutions?.find((r: any) => r.proposalHash === p.hash)?.status || 'pending';
    return { ...structuredClone(p), status, members: p.members.map((m: any) => ({ ...m,
      canConfirm: status === 'pending' && eligible.has(m.caseId),
      unavailableReason: status !== 'pending' ? 'wiki_category_proposal_resolved' : eligible.has(m.caseId) ? null : 'wiki_pattern_label_frozen' })) };
  });
}
function resolve(state: any, proposalHash: string, status: string, extra: any = {}) {
  const content = { proposalHash, status, ...extra, resolvedAt: new Date().toISOString(), resolvedRevision: state.revision };
  (state.categoryProposalResolutions || (state.categoryProposalResolutions = [])).push({ ...content, hash: hash(content) });
}
function pendingProposal(state: any, proposalHash: any) {
  digest(proposalHash);
  const p = state.categoryProposals?.find((p: any) => p.hash === proposalHash);
  if (!p) throw fail('wiki_category_proposal_not_found');
  if (state.categoryProposalResolutions?.some((r: any) => r.proposalHash === proposalHash)) throw fail('wiki_category_proposal_resolved');
  return p;
}
// Called inside createWikiStore.change, including the combined preclassification
// path. Validation finishes before records/resolutions/labels are appended.
export function appendWikiCategoryProposals(state: any, input: any) {
  closed(input, ['caseIds', 'model', 'proof', 'proposals']);
  const eligible = new Set(wikiCategoryEligibleCases(state).map((c: any) => c.id));
  if (!Array.isArray(input.caseIds) || !input.caseIds.length || input.caseIds.length > 20
    || new Set(input.caseIds).size !== input.caseIds.length || input.caseIds.some((c: any) => !eligible.has(c))) throw fail('wiki_not_pending');
  if (input.model !== 'deepseek/deepseek-v4-flash') throw fail('wiki_invalid_input');
  closed(input.proof, ['inputHash', 'calls', 'cleaned', 'isolation', 'containerId']);
  digest(input.proof.inputHash);
  if (input.proof.cleaned !== true || !Array.isArray(input.proof.calls)) throw fail('wiki_invalid_input');
  const selected = new Set(input.caseIds), seen = new Set<string>(), names = new Set<string>();
  let normalized: any[];
  try {
    if (!Array.isArray(input.proposals) || !input.proposals.length || input.proposals.length > input.caseIds.length) throw Error();
    normalized = input.proposals.map((p: any) => {
      closed(p, ['name', 'scope', 'members', 'pendingPatternId']);
      const name = wikiPendingPatternText(p.name, 'name'), scope = wikiPendingPatternText(p.scope, 'scope');
      if (names.has(name)) throw Error(); names.add(name);
      if (p.pendingPatternId !== undefined) {
        identifier(p.pendingPatternId);
        const pending = state.pendingPatterns?.find((v: any) => v.id === p.pendingPatternId);
        if (!pending || pending.name !== name || (pending.scope !== undefined && pending.scope !== scope)) throw Error();
      } else if (state.pendingPatterns?.some((v: any) => v.name === name)
        || state.versions.at(-1)?.entries.some((e: any) => e.status === 'approved' && e.title.trim() === name)) throw Error();
      if (!Array.isArray(p.members) || !p.members.length || p.members.length > input.caseIds.length) throw Error();
      const members = p.members.map((m: any) => {
        closed(m, ['caseId', 'reason']); identifier(m.caseId);
        if (!selected.has(m.caseId) || seen.has(m.caseId) || typeof m.reason !== 'string' || !m.reason.trim()
          || Buffer.byteLength(m.reason) > 2048 || m.reason.includes('\0') || containsSecretSentinel(m.reason)) throw Error();
        seen.add(m.caseId); return { caseId: m.caseId, reason: m.reason };
      });
      return { name, scope, members, ...(p.pendingPatternId === undefined ? {} : { pendingPatternId: p.pendingPatternId }) };
    });
    if (seen.size !== selected.size) throw Error();
  } catch { throw fail('wiki_model_output_invalid'); }
  const createdAt = new Date().toISOString();
  const proposals = normalized.map(p => {
    const content = { id: 'category-' + crypto.randomUUID(), ...p, model: input.model, proof: structuredClone(input.proof), createdAt, createdRevision: state.revision };
    return { ...content, hash: hash(content) };
  });
  for (const p of projectWikiCategoryProposals(state)) if (p.status === 'pending' && p.members.some((m: any) => seen.has(m.caseId))) {
    resolve(state, p.hash, 'superseded', { replacedBy: proposals.filter(v => v.members.some((m: any) => p.members.some((old: any) => old.caseId === m.caseId))).map(v => v.hash) });
  }
  (state.categoryProposals || (state.categoryProposals = [])).push(...proposals);
  return { proposals };
}
export function confirmWikiCategoryProposal(state: any, input: any) {
  closed(input, ['proposalHash', 'expectedRevision', 'name', 'scope', 'members']);
  revision(state, input.expectedRevision);
  const p = pendingProposal(state, input.proposalHash);
  const name = wikiPendingPatternText(input.name, 'name'), scope = wikiPendingPatternText(input.scope, 'scope');
  if (!Array.isArray(input.members) || !input.members.length || input.members.length > p.members.length) throw fail('wiki_invalid_case_ids');
  const labels = projectWikiPatternLabels(state), eligible = new Set(wikiCategoryEligibleCases(state).map((c: any) => c.id)), seen = new Set();
  // Check against a single pre-write projection. Creating the category changes
  // hashes, so do not confirm each member via a loop of separate transactions.
  for (const m of input.members) {
    closed(m, ['caseId', 'labelHash']); identifier(m.caseId); digest(m.labelHash);
    if (seen.has(m.caseId) || !p.members.some((r: any) => r.caseId === m.caseId)) throw fail('wiki_invalid_case_ids');
    seen.add(m.caseId);
    if (!eligible.has(m.caseId)) throw fail('wiki_pattern_label_frozen');
    if (labels.find((l: any) => l.caseId === m.caseId)?.labelHash !== m.labelHash) throw fail('wiki_pattern_label_stale');
  }
  let pendingPattern = state.pendingPatterns?.find((v: any) => v.id === p.pendingPatternId);
  if (p.pendingPatternId) {
    if (!pendingPattern) throw fail('wiki_pending_pattern_not_found');
    if (name !== pendingPattern.name || scope !== p.scope) throw fail('wiki_invalid_input');
  } else {
    if (state.pendingPatterns?.some((v: any) => v.name === name)
      || state.versions.at(-1)?.entries.some((e: any) => e.status === 'approved' && e.title.trim() === name)) throw fail('wiki_pending_pattern_name_conflict');
    const content = { id: 'pending-' + crypto.randomUUID(), name, scope, sourceProposalHash: p.hash,
      createdRevision: state.revision, createdAt: new Date().toISOString(), source: 'badcase-page' };
    pendingPattern = { ...content, hash: hash(content) };
    (state.pendingPatterns || (state.pendingPatterns = [])).push(pendingPattern);
  }
  const confirmedAt = new Date().toISOString();
  for (const m of input.members) {
    const content = { caseId: m.caseId, entryId: null, pendingPatternId: pendingPattern.id, labelHash: m.labelHash,
      source: 'badcase-page', confirmedRevision: state.revision, confirmedAt };
    (state.patternLabels || (state.patternLabels = [])).push({ ...content, hash: hash(content) });
  }
  resolve(state, p.hash, 'accepted', { pendingPatternId: pendingPattern.id, caseIds: [...seen] });
  return { pendingPattern };
}
export function rejectWikiCategoryProposal(state: any, input: any) {
  closed(input, ['proposalHash', 'expectedRevision']); revision(state, input.expectedRevision);
  pendingProposal(state, input.proposalHash); resolve(state, input.proposalHash, 'rejected');
  return { proposalHash: input.proposalHash, status: 'rejected' };
}
