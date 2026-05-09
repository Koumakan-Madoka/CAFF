import { createHttpError } from '../../http/http-errors';

const CONVERSATION_EXPERIENCE_DRAFTS_METADATA_KEY = 'experienceDrafts';
const MAX_EXPERIENCE_DRAFTS = 8;
const MAX_EXPERIENCE_DRAFT_ITEMS = 5;
const MAX_EXPERIENCE_DRAFT_TITLE_LENGTH = 100;
const MAX_EXPERIENCE_DRAFT_TEXT_LENGTH = 320;
const MAX_EXPERIENCE_DRAFT_ARTIFACT_LENGTH = 180;
const EXPERIENCE_DRAFT_CATEGORIES = new Set(['bug_fix', 'pattern', 'decision', 'anti_pattern', 'tool_usage', 'other']);
const EXPERIENCE_DRAFT_STATUSES = new Set(['pending', 'absorbed', 'rejected']);
const EXPERIENCE_DRAFT_CONFIDENCE = new Set(['low', 'medium', 'high']);
const EXPERIENCE_SECRET_RE = /\b(password|passwd|secret|token|api[_ -]?key|private[_ -]?key|ssh[_ -]?key|cookie|session|authorization|bearer)\b|密码|口令|令牌|密钥|私钥/iu;
const EXPERIENCE_TRANSCRIPT_RE = /raw\s+tool\s+transcript|完整工具调用|完整日志|full\s+transcript|stack trace dump|BEGIN [A-Z ]+PRIVATE KEY/iu;
const EXPERIENCE_GENERIC_RE = /^(经验|lesson|note|summary|总结|记录|important|misc|other)$/iu;

function nowIso() {
  return new Date().toISOString();
}

function isPlainObject(value: any) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeText(value: any) {
  return String(value || '').trim();
}

function clipText(value: any, maxLength = MAX_EXPERIENCE_DRAFT_TEXT_LENGTH) {
  const text = normalizeText(value).replace(/\s+/gu, ' ');

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function normalizeItems(value: any, maxLength = MAX_EXPERIENCE_DRAFT_TEXT_LENGTH) {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\r?\n/u)
      : [];
  const seen = new Set<string>();
  const result = [] as string[];

  for (const rawItem of rawItems) {
    const item = clipText(rawItem, maxLength);
    const key = item.toLowerCase();

    if (!item || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);

    if (result.length >= MAX_EXPERIENCE_DRAFT_ITEMS) {
      break;
    }
  }

  return result;
}

function currentMetadata(conversation: any) {
  return conversation && isPlainObject(conversation.metadata) ? conversation.metadata : {};
}

function normalizeExperienceDraftStatus(value: any) {
  const status = normalizeText(value).toLowerCase();
  return EXPERIENCE_DRAFT_STATUSES.has(status) ? status : 'pending';
}

function normalizeExperienceDraftCategory(value: any) {
  const category = normalizeText(value).toLowerCase().replace(/[\s-]+/gu, '_');
  return EXPERIENCE_DRAFT_CATEGORIES.has(category) ? category : 'other';
}

function normalizeExperienceDraftConfidence(value: any) {
  const confidence = normalizeText(value).toLowerCase();
  return EXPERIENCE_DRAFT_CONFIDENCE.has(confidence) ? confidence : 'medium';
}

function normalizeExperienceDraft(value: any) {
  if (!isPlainObject(value)) {
    return null;
  }

  const id = normalizeText(value.id);
  const title = clipText(value.title, MAX_EXPERIENCE_DRAFT_TITLE_LENGTH);

  if (!id || !title) {
    return null;
  }

  const source = isPlainObject(value.source) ? value.source : {};
  const normalized: Record<string, any> = {
    id,
    status: normalizeExperienceDraftStatus(value.status),
    title,
    category: normalizeExperienceDraftCategory(value.category),
    scenario: clipText(value.scenario || value.context || value.whenToUse),
    steps: normalizeItems(value.steps),
    pitfalls: normalizeItems(value.pitfalls || value.limitations),
    validation: normalizeItems(value.validation),
    artifacts: normalizeItems(value.artifacts, MAX_EXPERIENCE_DRAFT_ARTIFACT_LENGTH),
    confidence: normalizeExperienceDraftConfidence(value.confidence),
    source: {
      type: normalizeText(source.type) || 'agent-tool',
      agentId: normalizeText(source.agentId),
      agentName: clipText(source.agentName, 80),
      turnId: normalizeText(source.turnId),
      assistantMessageId: normalizeText(source.assistantMessageId),
      conversationId: normalizeText(source.conversationId),
    },
    createdAt: normalizeText(value.createdAt) || nowIso(),
    updatedAt: normalizeText(value.updatedAt) || normalizeText(value.createdAt) || nowIso(),
  };

  const absorbedAt = normalizeText(value.absorbedAt);
  if (absorbedAt) {
    normalized.absorbedAt = absorbedAt;
  }

  const absorbedDigestId = normalizeText(value.absorbedDigestId);
  if (absorbedDigestId) {
    normalized.absorbedDigestId = absorbedDigestId;
  }

  const rejectedAt = normalizeText(value.rejectedAt);
  if (rejectedAt) {
    normalized.rejectedAt = rejectedAt;
  }

  const reason = clipText(value.reason, MAX_EXPERIENCE_DRAFT_TEXT_LENGTH);
  if (reason) {
    normalized.reason = reason;
  }

  return normalized;
}

export function getConversationExperienceDrafts(conversation: any) {
  const metadata = currentMetadata(conversation);
  const rawDrafts = Array.isArray(metadata[CONVERSATION_EXPERIENCE_DRAFTS_METADATA_KEY])
    ? metadata[CONVERSATION_EXPERIENCE_DRAFTS_METADATA_KEY]
    : [];

  return rawDrafts
    .map(normalizeExperienceDraft)
    .filter(Boolean)
    .slice(-MAX_EXPERIENCE_DRAFTS);
}

export function getPendingConversationExperienceDrafts(conversation: any) {
  return getConversationExperienceDrafts(conversation).filter((draft: any) => draft && draft.status === 'pending');
}

export function buildMetadataWithExperienceDrafts(conversation: any, drafts: any[]) {
  const metadata = currentMetadata(conversation);
  const normalizedDrafts = drafts
    .map(normalizeExperienceDraft)
    .filter(Boolean)
    .slice(-MAX_EXPERIENCE_DRAFTS);

  if (normalizedDrafts.length === 0) {
    const { [CONVERSATION_EXPERIENCE_DRAFTS_METADATA_KEY]: _drafts, ...remainingMetadata } = metadata;
    return remainingMetadata;
  }

  return {
    ...metadata,
    [CONVERSATION_EXPERIENCE_DRAFTS_METADATA_KEY]: normalizedDrafts,
  };
}

function updateConversationMetadata(store: any, conversation: any, metadata: any) {
  return store.updateConversation(conversation.id, {
    title: conversation.title,
    type: conversation.type,
    metadata,
  });
}

function createExperienceDraftInvalidError(issues: any[]) {
  const normalizedIssues = (Array.isArray(issues) ? issues : [])
    .map((issue: any) => ({
      field: clipText(issue && issue.field ? issue.field : 'draft', 80),
      message: clipText(issue && issue.message ? issue.message : issue, 160),
    }))
    .filter((issue: any) => issue.field && issue.message)
    .slice(0, MAX_EXPERIENCE_DRAFT_ITEMS);
  const diagnostics = normalizedIssues.map((issue: any) => issue.message).filter(Boolean);
  const message = diagnostics.length > 0
    ? `Experience draft is invalid: ${diagnostics.join('; ')}`
    : 'Experience draft is invalid';

  throw createHttpError(400, message, { issues: normalizedIssues });
}

function buildExperienceDraftInputIssues(input: any = {}) {
  const title = clipText(input.title, MAX_EXPERIENCE_DRAFT_TITLE_LENGTH);
  const scenario = clipText(input.scenario || input.context || input.whenToUse);
  const steps = normalizeItems(input.steps);
  const pitfalls = normalizeItems(input.pitfalls || input.limitations);
  const validation = normalizeItems(input.validation);
  const artifacts = normalizeItems(input.artifacts, MAX_EXPERIENCE_DRAFT_ARTIFACT_LENGTH);
  const combined = [title, scenario, ...steps, ...pitfalls, ...validation, ...artifacts].join(' ');
  const issues = [] as any[];

  if (!title) {
    issues.push({ field: 'title', message: 'title is required' });
  } else if (EXPERIENCE_GENERIC_RE.test(title)) {
    issues.push({ field: 'title', message: 'title is too generic' });
  }

  if (!scenario && steps.length === 0 && pitfalls.length === 0 && validation.length === 0) {
    issues.push({ field: 'scenario', message: 'scenario, steps, pitfalls, or validation is required' });
  }

  if (combined.length < 16) {
    issues.push({ field: 'content', message: 'draft needs more concrete reusable detail' });
  }

  return issues;
}

function validateExperienceDraftCandidate(candidate: any) {
  const combined = [
    candidate.title,
    candidate.scenario,
    ...candidate.steps,
    ...candidate.pitfalls,
    ...candidate.validation,
    ...candidate.artifacts,
  ].join(' ');

  if (EXPERIENCE_SECRET_RE.test(combined)) {
    throw createHttpError(400, 'Do not save secrets, tokens, passwords, cookies, or private keys in experience drafts');
  }

  if (EXPERIENCE_TRANSCRIPT_RE.test(combined)) {
    throw createHttpError(400, 'Do not save raw tool transcripts, full logs, or unbounded trace dumps in experience drafts');
  }

  const issues = buildExperienceDraftInputIssues(candidate);

  if (issues.length > 0) {
    createExperienceDraftInvalidError(issues);
  }
}

function hasDraftForTurn(drafts: any[], turnId: any) {
  const normalizedTurnId = normalizeText(turnId);

  if (!normalizedTurnId) {
    return false;
  }

  return drafts.some((draft: any) => draft && draft.source && draft.source.turnId === normalizedTurnId);
}

export function createConversationExperienceDraft(store: any, conversationId: any, input: any = {}, options: any = {}) {
  const normalizedConversationId = normalizeText(conversationId);
  const conversation = store.getConversation(normalizedConversationId);

  if (!conversation) {
    throw createHttpError(404, 'Conversation not found');
  }

  const drafts = getConversationExperienceDrafts(conversation);
  const turnId = normalizeText(options.turnId || input.turnId);

  if (hasDraftForTurn(drafts, turnId)) {
    throw createHttpError(409, 'Only one experience draft can be written per agent turn');
  }

  const timestamp = nowIso();
  const draft = normalizeExperienceDraft({
    id: `expdraft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'pending',
    title: input.title,
    category: input.category,
    scenario: input.scenario || input.context || input.whenToUse,
    steps: input.steps,
    pitfalls: input.pitfalls || input.limitations,
    validation: input.validation,
    artifacts: input.artifacts,
    confidence: input.confidence,
    source: {
      type: 'agent-tool',
      agentId: options.agentId,
      agentName: options.agentName,
      turnId,
      assistantMessageId: options.assistantMessageId,
      conversationId: normalizedConversationId,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  if (!draft) {
    createExperienceDraftInvalidError(buildExperienceDraftInputIssues(input));
  }

  validateExperienceDraftCandidate(draft);

  const nextConversation = updateConversationMetadata(
    store,
    conversation,
    buildMetadataWithExperienceDrafts(conversation, [...drafts, draft])
  );

  return {
    conversation: nextConversation,
    experienceDrafts: getConversationExperienceDrafts(nextConversation),
    draft,
    changed: true,
  };
}

export function experienceDraftsForDigest(drafts: any[]) {
  return (Array.isArray(drafts) ? drafts : [])
    .map(normalizeExperienceDraft)
    .filter((draft: any) => draft && draft.status === 'pending')
    .slice(0, MAX_EXPERIENCE_DRAFT_ITEMS)
    .map((draft: any) => ({
      sourceDraftId: draft.id,
      title: draft.title,
      category: draft.category,
      scenario: draft.scenario,
      steps: draft.steps,
      pitfalls: draft.pitfalls,
      validation: draft.validation,
      artifacts: draft.artifacts,
      confidence: draft.confidence,
    }));
}

export function absorbExperienceDraftsInMetadata(conversation: any, draftIds: any[], digestId: any, timestamp = nowIso()) {
  const ids = new Set((Array.isArray(draftIds) ? draftIds : []).map(normalizeText).filter(Boolean));

  if (ids.size === 0) {
    return currentMetadata(conversation);
  }

  const drafts = getConversationExperienceDrafts(conversation).map((draft: any) => {
    if (!ids.has(draft.id) || draft.status !== 'pending') {
      return draft;
    }

    return {
      ...draft,
      status: 'absorbed',
      absorbedAt: timestamp,
      absorbedDigestId: normalizeText(digestId),
      updatedAt: timestamp,
    };
  });

  return buildMetadataWithExperienceDrafts(conversation, drafts);
}
