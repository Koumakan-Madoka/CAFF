import { createHttpError } from '../../http/http-errors';

const DECISION_FIELDS = ['committed', 'provisional', 'openQuestions', 'nonGoals', 'rejectedOptions'] as const;
const CRITERION_STATUSES = new Set(['pending', 'passed', 'failed', 'waived']);
const WORK_STATUSES = new Set(['todo', 'in_progress', 'done']);
const CRITERION_RISKS = new Set(['normal', 'high']);
const EVIDENCE_KINDS = new Set(['command', 'test', 'manual', 'review', 'artifact']);

function objectValue(value: any) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value: any, maxLength: number) {
  return String(value || '').trim().replace(/\s+/gu, ' ').slice(0, maxLength);
}

function list(value: any, maxItems: number) {
  return Array.isArray(value) ? value.slice(0, maxItems) : [];
}

function normalizeDecisionList(value: any, field: typeof DECISION_FIELDS[number]) {
  return list(value, 40).map((item: any, index: number) => {
    const source = typeof item === 'string' ? { statement: item } : objectValue(item);
    const primary = field === 'openQuestions'
      ? text(source.question || source.statement, 500)
      : field === 'rejectedOptions'
        ? text(source.option || source.statement, 500)
        : text(source.statement, 500);
    if (!primary) return null;
    return {
      id: text(source.id, 80) || `${field}-${index + 1}`,
      ...(field === 'openQuestions' ? { question: primary } : field === 'rejectedOptions' ? { option: primary } : { statement: primary }),
      ...(text(source.rationale, 1000) ? { rationale: text(source.rationale, 1000) } : {}),
      ...(text(source.reason, 1000) ? { reason: text(source.reason, 1000) } : {}),
      ...(text(source.changeConditions, 1000) ? { changeConditions: text(source.changeConditions, 1000) } : {}),
      ...(text(source.boundaries, 1000) ? { boundaries: text(source.boundaries, 1000) } : {}),
      ...(text(source.adrPath, 240) ? { adrPath: text(source.adrPath, 240) } : {}),
    };
  }).filter(Boolean);
}

export function normalizeGoalDecisions(value: any) {
  const source = objectValue(value);
  return Object.fromEntries(DECISION_FIELDS.map((field) => [field, normalizeDecisionList(source[field], field)]));
}

export function normalizeGoalAcceptanceCriteria(value: any, timestamp: string) {
  return list(value, 40).map((item: any, index: number) => {
    const source = typeof item === 'string' ? { statement: item } : objectValue(item);
    const statement = text(source.statement || source.text, 500);
    if (!statement) return null;
    const rawStatus = text(source.status, 40).toLowerCase();
    const status = CRITERION_STATUSES.has(rawStatus) ? rawStatus : 'pending';
    const rawRisk = text(source.risk, 40).toLowerCase();
    const risk = CRITERION_RISKS.has(rawRisk) ? rawRisk : 'normal';
    const evidenceRefs = list(source.evidenceRefs, 40).map((entry: any) => text(entry, 80)).filter(Boolean);
    const waiver = status === 'waived' ? objectValue(source.waiver) : {};
    return {
      id: text(source.id, 80) || `criterion-${index + 1}`,
      statement,
      verifyBy: text(source.verifyBy || source.verify_by, 1000),
      status,
      risk,
      evidenceRefs,
      createdAt: text(source.createdAt || source.created_at, 80) || timestamp,
      updatedAt: text(source.updatedAt || source.updated_at, 80) || timestamp,
      ...(status === 'waived' ? {
        waiver: {
          reason: text(waiver.reason || source.waiverReason, 1000),
          ...(text(waiver.waivedBy, 160) ? { waivedBy: text(waiver.waivedBy, 160) } : {}),
          waivedAt: text(waiver.waivedAt, 80) || timestamp,
        },
      } : {}),
    };
  }).filter(Boolean);
}

export function normalizeGoalWorkItems(value: any, timestamp: string) {
  return list(value, 60).map((item: any, index: number) => {
    const source = typeof item === 'string' ? { text: item } : objectValue(item);
    const itemText = text(source.text || source.statement || source.title, 300);
    if (!itemText) return null;
    const rawStatus = text(source.status, 40).toLowerCase().replace(/-/gu, '_');
    const status = rawStatus === 'doing' ? 'in_progress' : WORK_STATUSES.has(rawStatus) ? rawStatus : 'todo';
    return {
      id: text(source.id, 80) || `work-${index + 1}`,
      text: itemText,
      status,
      createdAt: text(source.createdAt || source.created_at, 80) || timestamp,
      updatedAt: text(source.updatedAt || source.updated_at, 80) || timestamp,
      ...(status === 'done' ? { completedAt: text(source.completedAt || source.completed_at, 80) || timestamp } : {}),
    };
  }).filter(Boolean);
}

export function normalizeGoalEvidence(value: any, timestamp: string) {
  return list(value, 100).map((item: any, index: number) => {
    const source = objectValue(item);
    const summary = text(source.summary, 1000);
    if (!summary) return null;
    const rawKind = text(source.kind, 40).toLowerCase();
    return {
      id: text(source.id, 80) || `evidence-${index + 1}`,
      criterionIds: list(source.criterionIds || source.criterion_ids, 40).map((entry: any) => text(entry, 80)).filter(Boolean),
      kind: EVIDENCE_KINDS.has(rawKind) ? rawKind : 'artifact',
      summary,
      ...(text(source.reference, 1000) ? { reference: text(source.reference, 1000) } : {}),
      ...(text(source.recordedBy, 160) ? { recordedBy: text(source.recordedBy, 160) } : {}),
      recordedAt: text(source.recordedAt || source.recorded_at, 80) || timestamp,
    };
  }).filter(Boolean);
}

export function normalizeGoalDelivery(value: any, timestamp: string, options: any = {}) {
  const source = objectValue(value);
  const legacyWorkItems = options.legacyChecklist && !Object.prototype.hasOwnProperty.call(source, 'workItems')
    ? options.legacyChecklist
    : source.workItems;
  return {
    decisions: normalizeGoalDecisions(source.decisions),
    acceptanceCriteria: normalizeGoalAcceptanceCriteria(source.acceptanceCriteria || source.acceptance_criteria, timestamp),
    workItems: normalizeGoalWorkItems(legacyWorkItems, timestamp),
    evidence: normalizeGoalEvidence(source.evidence, timestamp),
  };
}

export function validateGoalDelivery(delivery: any) {
  const criteria = Array.isArray(delivery?.acceptanceCriteria) ? delivery.acceptanceCriteria : [];
  const evidence = Array.isArray(delivery?.evidence) ? delivery.evidence : [];
  const workItems = Array.isArray(delivery?.workItems) ? delivery.workItems : [];
  for (const [kind, items] of [['criterion', criteria], ['work item', workItems], ['evidence', evidence]] as const) {
    const seen = new Set<string>();
    const duplicate = items.find((item: any) => {
      const id = text(item?.id, 80);
      if (!id || seen.has(id)) return true;
      seen.add(id);
      return false;
    });
    if (duplicate) {
      throw createHttpError(400, `Goal ${kind} ids must be non-empty and unique`, {
        code: 'goal_delivery_id_invalid',
        kind,
        id: text(duplicate?.id, 80),
      });
    }
  }

  const criterionIds = new Set(criteria.map((criterion: any) => criterion.id));
  const evidenceById = new Map(evidence.map((item: any) => [item.id, item]));
  for (const item of evidence) {
    const unknownCriterionId = item.criterionIds.find((id: string) => !criterionIds.has(id));
    if (unknownCriterionId) {
      throw createHttpError(400, `Goal evidence ${item.id} references unknown criterion ${unknownCriterionId}`, {
        code: 'goal_evidence_criterion_missing',
        evidenceId: item.id,
        criterionId: unknownCriterionId,
      });
    }
  }
  for (const criterion of criteria) {
    if (criterion.status === 'waived' && !text(criterion.waiver?.reason, 1000)) {
      throw createHttpError(400, `Goal criterion ${criterion.id} requires a waiver reason`, {
        code: 'goal_waiver_reason_required',
        criterionId: criterion.id,
      });
    }
    if (criterion.status !== 'passed') continue;
    if (criterion.evidenceRefs.length === 0) {
      throw createHttpError(400, `Passed Goal criterion ${criterion.id} requires evidence`, {
        code: 'goal_acceptance_evidence_required',
        criterionId: criterion.id,
      });
    }
    const invalidEvidenceId = criterion.evidenceRefs.find((id: string) => {
      const item: any = evidenceById.get(id);
      return !item || !item.criterionIds.includes(criterion.id);
    });
    if (invalidEvidenceId) {
      throw createHttpError(400, `Goal criterion ${criterion.id} has an invalid evidence reference`, {
        code: 'goal_acceptance_evidence_invalid',
        criterionId: criterion.id,
        evidenceId: invalidEvidenceId,
      });
    }
  }
}

export function requireAcceptanceCriteria(delivery: any) {
  if (!delivery || !Array.isArray(delivery.acceptanceCriteria) || delivery.acceptanceCriteria.length === 0) {
    throw createHttpError(400, 'Goal acceptanceCriteria must contain at least one observable criterion', {
      code: 'goal_acceptance_criteria_required',
    });
  }
  const missingVerifyBy = delivery.acceptanceCriteria.find((criterion: any) => !text(criterion.verifyBy, 1000));
  if (missingVerifyBy) {
    throw createHttpError(400, `Goal criterion ${missingVerifyBy.id} requires verifyBy`, {
      code: 'goal_acceptance_verify_by_required',
      criterionId: missingVerifyBy.id,
    });
  }
  validateGoalDelivery(delivery);
}

export function incompleteAcceptanceCriteria(goal: any) {
  const criteria = goal && Array.isArray(goal.acceptanceCriteria) ? goal.acceptanceCriteria : [];
  return criteria.filter((criterion: any) => !criterion || !['passed', 'waived'].includes(String(criterion.status || 'pending')));
}

export function structuralGoalProjection(goal: any) {
  return JSON.stringify({
    objective: text(goal && goal.objective, 2000),
    decisions: goal && goal.decisions || normalizeGoalDecisions(null),
    acceptanceCriteria: (goal && Array.isArray(goal.acceptanceCriteria) ? goal.acceptanceCriteria : []).map((criterion: any) => ({
      id: criterion.id,
      statement: criterion.statement,
      verifyBy: criterion.verifyBy,
      risk: criterion.risk,
    })),
    workItems: (goal && Array.isArray(goal.workItems) ? goal.workItems : []).map((item: any) => ({ id: item.id, text: item.text })),
  });
}

export function acceptedAdrChanges(previousGoal: any, nextGoal: any) {
  const previous = new Map<string, any>((previousGoal?.decisions?.committed || [])
    .filter((item: any) => text(item?.adrPath, 240))
    .map((item: any) => [item.id, item]));
  const next = new Map<string, any>((nextGoal?.decisions?.committed || []).map((item: any) => [item.id, item]));
  const changes: any[] = [];
  for (const [id, oldDecision] of previous) {
    const nextDecision = next.get(id);
    if (!nextDecision || nextDecision.statement !== oldDecision.statement || nextDecision.adrPath !== oldDecision.adrPath) {
      changes.push({
        id,
        adrPath: oldDecision.adrPath,
        previous: oldDecision.statement,
        next: nextDecision ? nextDecision.statement : '(removed)',
      });
    }
  }
  return changes;
}

export function provisionalDecisionChanges(previousGoal: any, nextGoal: any) {
  const previous = new Map<string, any>((previousGoal?.decisions?.provisional || []).map((item: any) => [item.id, item]));
  const next = new Map<string, any>((nextGoal?.decisions?.provisional || []).map((item: any) => [item.id, item]));
  const changes: any[] = [];
  for (const [id, oldDecision] of previous) {
    const nextDecision: any = next.get(id);
    if (!nextDecision || nextDecision.statement !== oldDecision.statement) {
      changes.push({
        id,
        previous: oldDecision.statement,
        next: nextDecision ? nextDecision.statement : '(removed)',
      });
    }
  }
  return changes;
}
