// Immutable panel consent over a measured ORIGINAL-passing gate case. This is
// not execution permission, an automatic approval, or a formal scoring result.
import { wikiValueHash } from './wiki-rubric';
import { projectWikiOriginalPrechecks } from './wiki-original-precheck-projection';
import { projectWikiPatternLabels } from './wiki-initial-split';
import { wikiConfirmedClassification } from './wiki-evaluation-suite';
const fail = (code: string) => Object.assign(Error(code), { code });
const digest = (v: any) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v: any) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
function exact(v: any, fields: string[]) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== [...fields].sort().join(',')) throw fail('wiki_control_case_record_invalid');
}
export function validateWikiGateControl(value: any) {
  exact(value, ['kind', 'caseId', 'binding', 'proposalHash', 'source', 'confirmedRevision', 'confirmedAt', 'confirmationRecord', 'hash']);
  const { hash, ...payload } = value, b = value.binding;
  exact(b, ['kind', 'caseId', 'caseHash', 'rubricHash', 'precheckId', 'precheckPlanHash', 'precheckResultHash', 'pattern']);
  exact(b.pattern, ['entryId', 'patternKey']);
  if (value.kind !== 'wiki-gate-control-v1' || value.source !== 'badcase-page' || !id(value.caseId) || b.caseId !== value.caseId
    || b.kind !== 'wiki-gate-control-input-v1' || ![b.caseHash, b.rubricHash, b.precheckPlanHash, b.precheckResultHash, value.proposalHash, hash].every(digest)
    || typeof b.precheckId !== 'string' || !/^precheck-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(b.precheckId)
    || b.pattern.entryId !== null && !id(b.pattern.entryId) || b.pattern.patternKey !== (b.pattern.entryId ?? 'unclassified')
    || !Number.isSafeInteger(value.confirmedRevision) || value.confirmedRevision < 0
    || typeof value.confirmedAt !== 'string' || !Number.isFinite(Date.parse(value.confirmedAt))) throw fail('wiki_control_case_record_invalid');
  if (new Date(value.confirmedAt).toISOString() !== value.confirmedAt || typeof value.confirmationRecord !== 'string'
    || !value.confirmationRecord.trim() || value.confirmationRecord.length > 4096 || value.confirmationRecord.includes('\0')
    || value.proposalHash !== wikiValueHash(b) || hash !== wikiValueHash(payload)) throw fail('wiki_control_case_record_invalid');
  return structuredClone(value);
}
export function assertWikiControlCaseMutable(state: any, caseId: string) {
  if (state.controlConfirmations?.some((r: any) => r.caseId === caseId)) throw fail('wiki_control_case_frozen');
}
export function projectWikiGateControls(state: any, records: any[], replayChecks: any[], projected?: any[]) {
  const prechecks = projected ?? projectWikiOriginalPrechecks(state, records, replayChecks);
  const labels = projectWikiPatternLabels(state), confirmations = (state.controlConfirmations || []).map(validateWikiGateControl);
  if (new Set(confirmations.map((c: any) => c.caseId)).size !== confirmations.length) throw fail('wiki_control_case_record_invalid');
  return state.cases.map((source: any) => {
    const precheck = prechecks.find((p: any) => p.caseId === source.id), label = labels.find((l: any) => l.caseId === source.id);
    const saved = confirmations.find((c: any) => c.caseId === source.id);
    let classification;
    try { classification = wikiConfirmedClassification(state, source); } catch { /* A label suggestion is not confirmation. */ }
    const patternReady = label?.confirmed && (!label.pendingPatternId || label.entryId !== null)
      && classification && classification.entryId === label.entryId;
    const eligible = source.split === 'gate' && precheck?.controlEligible && patternReady;
    const record = records.find(r => r.reservation.id === precheck?.current?.id);
    const binding = eligible && record?.result ? { kind: 'wiki-gate-control-input-v1', caseId: source.id, caseHash: wikiValueHash(source),
      rubricHash: record.reservation.plan.rubricHash, precheckId: record.reservation.id, precheckPlanHash: record.reservation.plan.planHash,
      precheckResultHash: wikiValueHash(record.result), pattern: { entryId: label.entryId, patternKey: label.patternKey } } : null;
    const proposalHash = binding ? wikiValueHash(binding) : null;
    const confirmed = !!saved && saved.proposalHash === proposalHash;
    return { caseId: source.id, status: saved ? confirmed ? 'confirmed' : 'stale' : eligible ? 'eligible' : 'ineligible',
      eligible: !!eligible, confirmed, proposalHash, binding, confirmation: saved ?? null,
      reason: saved && !confirmed ? 'control_binding_changed' : source.split !== 'gate' ? 'control_gate_required'
        : !precheck?.controlEligible ? 'control_precheck_required' : !patternReady ? 'control_pattern_confirmation_required' : null };
  });
}
export function createWikiGateControlConfirmation(state: any, caseId: string, proposalHash: string, records: any[], replayChecks: any[]) {
  assertWikiControlCaseMutable(state, caseId);
  const view = projectWikiGateControls(state, records, replayChecks).find((r: any) => r.caseId === caseId);
  if (!view) throw fail('wiki_unknown_case');
  if (!view.eligible) throw fail('wiki_control_case_ineligible');
  if (!digest(proposalHash) || proposalHash !== view.proposalHash) throw fail('wiki_control_case_stale');
  const payload = { kind: 'wiki-gate-control-v1', caseId, binding: view.binding, proposalHash, source: 'badcase-page', confirmedRevision: state.revision,
    confirmedAt: new Date().toISOString(), confirmationRecord: '用户在 WikiSkill 面板确认原版预检结果、冻结断言、门槛组及模式身份；冻结为其他模式的防误伤对照，不表示采纳候选或授权执行。' };
  return validateWikiGateControl({ ...payload, hash: wikiValueHash(payload) });
}
