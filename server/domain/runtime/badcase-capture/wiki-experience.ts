// Deterministic evaluation feedback, not model induction. Only fixed literal
// check booleans cross this boundary; no held-out reply, trace, match or path.
import crypto from 'node:crypto';
import { wikiDisplayCases } from './wiki-suite';
const hash = (v: any) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail = (code = 'wiki_experience_invalid') => Object.assign(Error(code), { code });
export function approvedWikiExperiences(state: any, entryId: string, selectedIds?: string[]) {
  const all = (state.experiences || []).filter((e: any) => e.entryId === entryId && e.status === 'approved');
  let selected: any[];
  if (selectedIds === undefined) {
    const latest = new Map<string, any>();
    for (const e of all) if (!latest.has(e.rootId) || latest.get(e.rootId).version < e.version) latest.set(e.rootId, e);
    selected = [...latest.values()].sort((a, b) => a.rootId.localeCompare(b.rootId));
  } else {
    if (!Array.isArray(selectedIds) || selectedIds.length > 1000 || new Set(selectedIds).size !== selectedIds.length) throw fail();
    selected = selectedIds.map(id => all.find((e: any) => e.id === id));
    if (selected.some(e => !e)) throw fail('wiki_experience_review_required');
  }
  return selected.map(e => ({ id: e.id, rootId: e.rootId, version: e.version, methods: e.methods, positiveExamples: e.positiveExamples }));
}
export function revisedWikiExperience(previous: any, fields: any) {
  const version = previous.version + 1;
  const { reviewedAt, ...source } = previous;
  return { ...source, ...fields, id: 'experience-' + hash({ rootId: source.rootId, parentId: source.id, version, fields }),
    version, parentId: source.id, status: 'draft', createdAt: new Date().toISOString() };
}
export function extractWikiLiteralObservations(input: any) {
  const rows: any[] = [];
  for (const c of input.cases || []) if (c.targetReproduction && !c.reportOnly) for (const r of c.runs || []) {
    if (!['pass', 'fail'].includes(r.status) || typeof r.checks?.conclusionInLead !== 'boolean'
      || typeof r.checks?.noForbiddenTerms !== 'boolean' || !Array.isArray(r.replyChecks?.forbidden)) continue;
    rows.push({ sourceCaseId: c.sourceCaseId, variant: r.variant, iteration: r.iteration,
      conclusionInLead: r.checks.conclusionInLead, noForbiddenTerms: r.checks.noForbiddenTerms,
      priorityCode: r.replyChecks.forbidden.some((f: any) => f?.kind === 'pattern' && f.rule === 'priority-code') });
  }
  return rows;
}
export function mergeWikiLiteralObservations(result: any, previous: any[], incoming: any[]) {
  if (!Array.isArray(incoming) || incoming.length > 500 || !Array.isArray(previous)) throw fail();
  const merged = new Map<string, any>();
  for (const row of [...previous, ...incoming]) {
    if (!row || Object.keys(row).sort().join(',') !== 'conclusionInLead,iteration,noForbiddenTerms,priorityCode,sourceCaseId,variant'
      || !['original', 'candidate'].includes(row.variant) || !Number.isSafeInteger(row.iteration)
      || ['conclusionInLead', 'noForbiddenTerms', 'priorityCode'].some(k => typeof row[k] !== 'boolean')) throw fail();
    const c = result.cases.find((c: any) => c.sourceCaseId === row.sourceCaseId && c.targetReproduction && !c.reportOnly);
    const r = c?.runs.find((r: any) => r.variant === row.variant && r.iteration === row.iteration && r.status !== 'error');
    if (!r || row.priorityCode && row.noForbiddenTerms || r.status === 'pass' && (!row.conclusionInLead || !row.noForbiddenTerms)) throw fail();
    const value = { sourceCaseId: row.sourceCaseId, variant: row.variant, iteration: row.iteration,
      conclusionInLead: row.conclusionInLead, noForbiddenTerms: row.noForbiddenTerms, priorityCode: row.priorityCode };
    const key = [row.sourceCaseId, row.variant, row.iteration].join(':');
    if (merged.has(key) && JSON.stringify(merged.get(key)) !== JSON.stringify(value)) throw fail('wiki_experience_evidence_conflict');
    merged.set(key, value);
  }
  return [...merged.values()].sort((a, b) => a.sourceCaseId.localeCompare(b.sourceCaseId) || a.variant.localeCompare(b.variant) || a.iteration - b.iteration);
}
export function buildWikiExperienceDraft(state: any, result: any, observations: any[], previous?: any) {
  const candidate = state.candidates.find((c: any) => c.id === result.candidate.id);
  if (!candidate || candidate.entryIds.length !== 1) throw fail();
  const numbers = new Map(wikiDisplayCases(state.cases, state.deletedCases).map(c => [c.id, c.displayNumber]));
  const rows = result.cases.map((c: any) => ({ sourceCaseId: c.sourceCaseId, displayNumber: numbers.get(c.sourceCaseId), stage: c.stage,
    category: c.category, reportOnly: c.reportOnly, targetReproduction: c.targetReproduction,
    original: c.totals.original, candidate: c.totals.candidate,
    literal: Object.fromEntries(['original', 'candidate'].map(v => {
      const runs = observations.filter(r => r.sourceCaseId === c.sourceCaseId && r.variant === v);
      return [v, { observed: runs.length, conclusionInLead: runs.filter(r => r.conclusionInLead).length,
        noForbiddenTerms: runs.filter(r => r.noForbiddenTerms).length, priorityCode: runs.filter(r => r.priorityCode).length }];
    })) }));
  const review = state.comparisonReviews.find((r: any) => r.comparisonId === result.id);
  const targetRows = rows.filter((r: any) => r.targetReproduction && !r.reportOnly);
  const opening = targetRows.filter((r: any) => r.literal.original.observed && r.literal.candidate.observed);
  const stageLine = (stage: string) => rows.filter((r: any) => r.stage === stage && !r.reportOnly)
    .map((r: any) => `#${r.displayNumber} 原版 ${r.original.passed}/${r.original.scored}，候选 ${r.candidate.passed}/${r.candidate.scored}`
      + (r.original.errors + r.candidate.errors ? `（环境错误 ${r.original.errors + r.candidate.errors}，不改变有效分母）` : '') + (r.original.notRun + r.candidate.notRun ? `（未运行 ${r.original.notRun}/${r.candidate.notRun}）` : '')).join('；') || '未运行';
  const holdout = result.kind === 'wiki-mode-holdout-comparison-v2', holdoutStages = holdout ? '门槛/验证' : '门槛/测试';
  const v = result.validation, repair = result.gateDecision.repair;
  const lines = [`本轮改法：${candidate.appendedSection.trim()}`, ...(holdout ? [
    `门槛（本模式）：${result.gateDecision.outcome}；合计原版 ${repair.original.passed}/${repair.original.total}，候选 ${repair.candidate.passed}/${repair.candidate.total}；单侧 Fisher p=${repair.pValue ?? 'N/A'}（阈值 0.05）；${stageLine('gate')}。`,
    `验证（其他模式对照题）：${v.status}；` + (v.cases.map((c: any) => {
      const stopped = result.cases.find((row: any) => row.sourceCaseId === c.caseId)?.reason === 'wiki_validation_prior_degradation';
      return `#${numbers.get(c.caseId)} 原版 ${c.original.passed}/${c.original.total}，候选 ${c.candidate.passed}/${c.candidate.total}；${stopped ? 'not-run（已有劣化而停止）' : c.degraded === null ? '未完成' : (c.degraded ? '劣化' : '未劣化') + `（少通过 ${c.loss} 次）`}`;
    }).join('；') || '没有可运行的对照题') + '。',
    '未覆盖：' + (v.uncovered.map((c: any) => c.entryId + (c.reason === 'operator-skipped' ? '（操作方跳过）' : '（无已确认对照题）')).join('、') || '无') + '。未覆盖不等于验证通过。',
  ] : [`门槛：${result.gateDecision.outcome}；${stageLine('gate')}。`, `测试：${stageLine('test')}。`])];
  if (opening.length) lines.push('有效/无效观察：“开头先给结论”字面检查：' + opening.map((r: any) =>
    `#${r.displayNumber} 从 ${r.literal.original.conclusionInLead}/${r.literal.original.observed} 到 ${r.literal.candidate.conclusionInLead}/${r.literal.candidate.observed}`).join('；')
    + '。这是分项观察，不等于整体修好或因果证明。');
  else lines.push('有效/无效观察：没有可核验的开头结论分项记录；不推断这项是否改善。');
  if (targetRows.some((r: any) => r.literal.original.priorityCode && r.literal.candidate.priorityCode)) lines.push(
    '规则教训：禁用 P 编号可能与题目主题冲突；遇到以 P 编号为主题的题目会误判，出题和定规则时要避开。此处只是待审核教训，已冻结评分不回改。');
  if (result.completed && targetRows.some((r: any) => r.stage === 'test' && r.candidate.passed === 0)) lines.push(
    '解读边界：门槛改善未在留出复现题上得到支持，不能说模式整体变好了；分项改进不自动变为采纳。');
  if (review) lines.push(review.decision === 'not-adopted' ? '已保存的人工裁决：本轮未采纳，基线未改变，不进生产提示词。'
    + (holdout ? `理由：${({ gate_rejected: '门槛未通过', validation_degraded: '验证劣化', user_declined: '用户拒绝' } as Record<string, string>)[review.reason]}。` : '')
    : '已保存的人工裁决：用户明确采纳为评测基线，生产提示词仍须手动合入。');
  if (!result.completed) lines.push('执行不完整：以上只作观察，不产生修好或采纳结论。');
  lines.push(`轨迹边界：没有从本轮${holdoutStages}轨迹抽取正例，不将其送入训练归纳；以上只使用逐题结果与固定字面检查计数。`);
  const positiveExamples = opening.length ? `建议写法（示意，非回放原文）：结论：最重要的变化是……。对你的影响是……。\n本轮没有可引用的目标模式训练组正例；不把${holdoutStages}输出伪装为训练正例。`
    : `本轮没有抽取可引用的目标模式训练组正例；${holdoutStages}输出不进入正例栏。`;
  const evidenceHash = hash({ comparisonId: result.id, observations, reviewId: review?.id || null }), rootId = 'experience-root-' + hash(result.id), version = previous ? previous.version + 1 : 1;
  return { id: 'experience-' + hash({ rootId, version, evidenceHash }), rootId, version, parentId: previous?.id || null,
    kind: 'wiki-experience-v1', comparisonId: result.id, candidateId: candidate.id, entryId: candidate.entryIds[0],
    status: 'draft', createdAt: new Date().toISOString(), evidenceHash, literalObservations: observations,
    methods: lines.join('\n'), positiveExamples, tracePolicy: 'training-only-no-holdout-trajectories', trainingTraceCount: 0,
    summary: { completed: result.completed, gateOutcome: result.gateDecision.outcome, model: result.model, modelConfig: result.modelConfig,
      rows, byStage: result.byStage, disclosures: result.disclosures, reviewId: review?.id || null,
      ...(holdout ? { outcome: result.outcome, validation: structuredClone(v), adoptionEligible: result.adoptionEligible } : {}) } };
}
