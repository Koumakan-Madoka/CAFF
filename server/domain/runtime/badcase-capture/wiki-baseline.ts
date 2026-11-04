// Evaluation baselines are operator-owned data, never production prompt writes.
// Only explicit human adoption of a completed production comparison adds a link.
import crypto from 'node:crypto';
import { getWikiTarget } from './wiki-targets';
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const mismatch = () => Object.assign(Error('wiki_candidate_target_mismatch'), { code: 'wiki_candidate_target_mismatch' });
export function resolveWikiBaseline(state: any, targetId: string) {
  const live = getWikiTarget(targetId), links = (state.baselines || []).filter((b: any) => b.targetId === targetId);
  if (!links.length) return { target: live, fragments: [{ baseText: live.baseText, baseHash: live.baseHash }] };
  const first = links[0];
  if (typeof first.rootBaseText !== 'string' || hash(first.rootBaseText) !== first.rootBaseHash) throw mismatch();
  const fragments = [{ baseText: first.rootBaseText, baseHash: first.rootBaseHash }];
  for (const b of links) {
    const candidate = state.candidates.find((c: any) => c.id === b.candidateId), review = state.comparisonReviews.find((r: any) => r.id === b.reviewId);
    if (b.kind !== 'wiki-baseline-v1' || b.rootBaseText !== first.rootBaseText || b.rootBaseHash !== first.rootBaseHash
      || b.parentBaseHash !== fragments.at(-1)!.baseHash || typeof b.baseText !== 'string' || hash(b.baseText) !== b.baseHash
      || !candidate || candidate.status !== 'confirmed' || candidate.targetId !== targetId || candidate.baseHash !== b.parentBaseHash
      || candidate.baseText !== fragments.at(-1)!.baseText || candidate.candidateHash !== b.baseHash || candidate.candidateText !== b.baseText
      || candidate.baseText + candidate.appendedSection !== candidate.candidateText
      || !review || review.decision !== 'adopted' || review.baselineChanged !== true || review.targetId !== targetId
      || review.candidateId !== candidate.id || review.candidateHash !== b.baseHash || review.comparisonId !== b.comparisonId) throw mismatch();
    fragments.push({ baseText: b.baseText, baseHash: b.baseHash });
  }
  // A user may manually merge an accepted fragment into the harness. Unknown
  // edits require an explicit new origin; never silently rebase the chain.
  if (!fragments.some(f => f.baseHash === live.baseHash && f.baseText === live.baseText)) throw mismatch();
  return { target: { ...live, ...fragments.at(-1) }, fragments };
}
export function assertWikiChangeNotRejected(state: any, candidate: any) {
  const rejected = state.comparisonReviews?.some((r: any) => {
    if (r.decision !== 'not-adopted' || r.targetId !== candidate.targetId) return false;
    const previous = state.candidates.find((c: any) => c.id === r.candidateId);
    return r.candidateHash === candidate.candidateHash || previous?.appendedSection === candidate.appendedSection;
  });
  if (rejected) throw Object.assign(Error('wiki_candidate_not_adopted'), { code: 'wiki_candidate_not_adopted' });
}
export function buildWikiBaseline(state: any, candidate: any, review: any) {
  const { target, fragments } = resolveWikiBaseline(state, candidate.targetId);
  if (candidate.baseHash !== target.baseHash || candidate.baseText !== target.baseText) throw mismatch();
  const root = fragments[0];
  return { kind: 'wiki-baseline-v1', id: 'baseline-' + hash(review.id), targetId: candidate.targetId,
    candidateId: candidate.id, reviewId: review.id, comparisonId: review.comparisonId, createdAt: review.createdAt,
    rootBaseText: root.baseText, rootBaseHash: root.baseHash, parentBaseHash: candidate.baseHash,
    baseText: candidate.candidateText, baseHash: candidate.candidateHash };
}
