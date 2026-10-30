import { createHttpError } from '../../http/http-errors';

const decisionFields = ['committed', 'provisional', 'openQuestions', 'nonGoals', 'rejectedOptions'];
const has = (value: any, field: string) => Object.prototype.hasOwnProperty.call(value, field);
const object = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(path: string): never {
  throw createHttpError(400, `Invalid explicit Goal patch value: ${path}`, { code: 'goal_patch_invalid', path });
}

// Canonicalize BEFORE spreading over a previous record, or e.g. verify_by
// would be shadowed by the old verifyBy. Canonical fields always take priority.
function aliases(value: any, fields: Record<string, string[]>) {
  const result = { ...value };
  for (const [canonical, alternatives] of Object.entries(fields)) {
    if (has(result, canonical)) continue;
    const alias = alternatives.find(field => has(result, field));
    if (alias) result[canonical] = result[alias];
  }
  return result;
}

function textFields(value: any, path: string, fields: string[], required: string[] = []) {
  for (const field of fields) {
    if (!has(value, field)) continue;
    if (typeof value[field] !== 'string' || (required.includes(field) && !value[field].trim())) invalid(`${path}.${field}`);
  }
}

function stringArray(value: any, path: string) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) invalid(path);
}

function criterionDefinition(value: any) {
  return JSON.stringify([value.statement, value.verifyBy, value.risk]);
}

function records(previous: any[], patch: any, kind: string) {
  const max = kind === 'acceptanceCriteria' ? 40 : kind === 'workItems' ? 60 : 100;
  if (!Array.isArray(patch) || patch.length > max) invalid(kind);
  const oldById = new Map(previous.map(item => [item.id, item]));
  return patch.map((raw: any, index: number) => {
    const path = `${kind}[${index}]`;
    let source = typeof raw === 'string' && kind !== 'evidence'
      ? kind === 'workItems' ? { text: raw } : { statement: raw }
      : raw;
    if (!object(source)) invalid(path);
    source = aliases(source, kind === 'acceptanceCriteria' ? {
      statement: ['text'], verifyBy: ['verify_by'], createdAt: ['created_at'], updatedAt: ['updated_at'],
    } : kind === 'workItems' ? {
      text: ['statement', 'title', 'objective', 'content'], status: ['state'], createdAt: ['created_at'], updatedAt: ['updated_at'], completedAt: ['completed_at'],
    } : { criterionIds: ['criterion_ids'], recordedAt: ['recorded_at'] });
    textFields(source, path, ['id'], ['id']);
    if (kind === 'acceptanceCriteria') {
      textFields(source, path, ['statement', 'verifyBy', 'status', 'risk', 'createdAt', 'updatedAt', 'waiverReason'], ['statement', 'verifyBy']);
      if (has(source, 'status') && !['pending', 'passed', 'failed', 'waived'].includes(source.status)) invalid(`${path}.status`);
      if (has(source, 'risk') && !['normal', 'high'].includes(source.risk)) invalid(`${path}.risk`);
      if (has(source, 'evidenceRefs')) stringArray(source.evidenceRefs, `${path}.evidenceRefs`);
      if (has(source, 'waiver')) {
        if (!object(source.waiver)) invalid(`${path}.waiver`);
        textFields(source.waiver, `${path}.waiver`, ['reason', 'waivedBy', 'waivedAt']);
      }
    } else if (kind === 'workItems') {
      textFields(source, path, ['text', 'status', 'createdAt', 'updatedAt', 'completedAt'], ['text']);
      if (has(source, 'status') && !['todo', 'in_progress', 'done', 'doing', 'in-progress'].includes(source.status)) invalid(`${path}.status`);
    } else {
      textFields(source, path, ['summary', 'kind', 'reference', 'recordedBy', 'recordedAt'], ['summary']);
      if (has(source, 'criterionIds')) stringArray(source.criterionIds, `${path}.criterionIds`);
    }
    const old = oldById.get(typeof source.id === 'string' ? source.id.trim() : '');
    const merged = { ...(old || {}), ...source };
    // Waiver is itself a partial record. Clearing it implicitly is forbidden;
    // supplying a new status removes it through the ordinary normalizer.
    if (old?.waiver && has(source, 'waiver')) merged.waiver = { ...old.waiver, ...source.waiver };
    const required = kind === 'acceptanceCriteria' ? ['statement', 'verifyBy'] : kind === 'workItems' ? ['text'] : ['summary'];
    for (const field of required) if (typeof merged[field] !== 'string' || !merged[field].trim()) invalid(`${path}.${field}`);
    return merged;
  });
}

/** Check after authority/structural checks, so high-risk changes fail with
 * 403 and factual structural edits with 409, before considering proof state. */
export function assertGoalCriterionPatchState(previous: any, input: any, next: any) {
  const canonical = aliases(input, { acceptanceCriteria: ['acceptance_criteria'] });
  if (!has(canonical, 'acceptanceCriteria')) return;
  const oldById = new Map<string, any>((previous.acceptanceCriteria || []).map((item: any) => [item.id, item]));
  const nextById = new Map<string, any>((next.acceptanceCriteria || []).map((item: any) => [item.id, item]));
  for (const source of canonical.acceptanceCriteria) {
    const old = oldById.get(typeof source?.id === 'string' ? source.id.trim() : '');
    const normalized = old && nextById.get(old.id);
    if (normalized && criterionDefinition(old) !== criterionDefinition(normalized)
      && (!has(source, 'status') || (normalized.status === 'passed' && !has(source, 'evidenceRefs'))
        || (normalized.status === 'waived' && !has(source, 'waiver')))) {
      throw createHttpError(400, 'Changed criterion definition requires explicit acceptance state and proof fields', {
        code: 'goal_acceptance_state_required', criterionId: old.id,
      });
    }
  }
}

/** Merge only writable delivery fields. Never spread the old Goal's lifecycle,
 * identity, owner or revision over the caller's concurrency/action fields. */
export function mergeGoalPatch(previous: any, input: any, options: any = {}) {
  const result = { ...input };
  if (has(input, 'objective') && (typeof input.objective !== 'string' || !input.objective.trim())) invalid('objective');
  result.objective = has(input, 'objective') ? input.objective : previous.objective;
  if (has(input, 'decisions') && !object(input.decisions)) invalid('decisions');
  result.decisions = { ...previous.decisions };
  for (const field of decisionFields) {
    if (!has(input, 'decisions') || !has(input.decisions, field)) continue;
    const items = input.decisions[field];
    if (!Array.isArray(items) || items.length > 40) invalid(`decisions.${field}`);
    result.decisions[field] = items.map((raw: any, index: number) => {
      const primary = field === 'openQuestions' ? 'question' : field === 'rejectedOptions' ? 'option' : 'statement';
      const source = typeof raw === 'string' ? { [primary]: raw } : raw;
      if (!object(source)) invalid(`decisions.${field}[${index}]`);
      const canonical = aliases(source, { [primary]: primary === 'statement' ? [] : ['statement'] });
      textFields(canonical, `decisions.${field}[${index}]`, ['id', primary, 'rationale', 'reason', 'changeConditions', 'boundaries', 'adrPath'], ['id', primary]);
      if (typeof canonical[primary] !== 'string' || !canonical[primary].trim()) invalid(`decisions.${field}[${index}].${primary}`);
      return canonical;
    });
  }
  const canonical = aliases(input, { acceptanceCriteria: ['acceptance_criteria'] });
  if (!has(canonical, 'workItems') && has(options, 'legacyWorkItems')) canonical.workItems = options.legacyWorkItems;
  for (const field of ['acceptanceCriteria', 'workItems', 'evidence']) {
    result[field] = has(canonical, field)
      ? records(previous[field] || [], canonical[field], field)
      : previous[field];
  }
  return result;
}
