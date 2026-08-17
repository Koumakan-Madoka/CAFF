const { randomUUID } = require('node:crypto');
const { UPLOAD_LEASE_TTL_MS, STAGED_IMAGE_TTL_MS, MAX_IMAGES_PER_MESSAGE } = require('../lib/image-constants');
const { openSqliteDatabase } = require('../storage/sqlite/connection');
const { migrateChatSchema } = require('../storage/sqlite/migrations');
const { createChatAgentRepository } = require('../storage/chat/agent.repository');
const { createChatRoleIdentityRepository } = require('../storage/chat/role-identity.repository');
const { createChatConversationAgentHistoryRepository } = require('../storage/chat/conversation-agent-history.repository');
const { createChatConversationRepository } = require('../storage/chat/conversation.repository');
const { createChatParticipantRepository } = require('../storage/chat/participant.repository');
const { createChatMessageRepository } = require('../storage/chat/message.repository');
const { createChatPrivateMessageRepository } = require('../storage/chat/private-message.repository');
const { createChatMemoryCardRepository } = require('../storage/chat/memory-card.repository');
const { createChatSummarySegmentRepository } = require('../storage/chat/summary-segment.repository');
const { createChatChannelBindingRepository } = require('../storage/chat/channel-binding.repository');
const { createChatExternalEventRepository } = require('../storage/chat/external-event.repository');
const { createImageUploadRepository } = require('../storage/chat/image-upload.repository');
const {
  createCrossConversationDeliveryRepository,
} = require('../storage/chat/cross-conversation-delivery.repository');
const { createChatPlanRepository } = require('../storage/chat/plan.repository');
const {
  NODE_STATUSES,
  validatePlanDoc,
  validateStatusOnlyUpdate,
  appendPlanHistory,
  diffNodeStatusTransitions,
  findBlockedUpstreams,
} = require('./plan-dag');
const {
  TITLE_SOURCE_MANUAL,
  normalizeConversationTitleSource,
  readConversationTitleSource,
  resolveConversationTitleTransition,
} = require('./conversation-title-source');
const { deriveTitleFromFirstMessage } = require('./conversation-first-message-title');

const MAX_AVATAR_DATA_URL_LENGTH = 2 * 1024 * 1024;
const MAX_AGENT_SANDBOX_NAME_LENGTH = 80;
const MAX_MEMORY_CARD_TITLE_LENGTH = 64;
const MAX_MEMORY_CARD_CONTENT_LENGTH = 280;
const MAX_SUMMARY_SEGMENT_TEXT_LENGTH = 800;
const MAX_SUMMARY_SEGMENT_ITEM_LENGTH = 240;
const MAX_SUMMARY_SEGMENT_ITEMS = 8;
const MAX_SUMMARY_SEGMENT_SEARCH_TEXT_LENGTH = 4000;
const MAX_SUMMARY_SEGMENT_SEARCH_LIMIT = 15;
const MAX_SUMMARY_MEMORY_HEALTH_DETAILS = 10;
const MAX_MEMORY_CARDS_PER_SCOPE = 6;
const DEFAULT_MEMORY_CARD_TTL_DAYS = 30;
const MAX_MEMORY_CARD_TTL_DAYS = 90;
const CONVERSATION_MEMORY_SCOPE = 'conversation-agent';
const LOCAL_USER_MEMORY_SCOPE = 'local-user-agent';
const LOCAL_USER_MEMORY_OWNER_KEY = 'local-user';
const DELETED_MEMORY_CARD_STATUS = 'deleted';

function nowIso() {
  return new Date().toISOString();
}

function serializeJson(value: any) {
  if (value === undefined) {
    return null;
  }

  return JSON.stringify(value === undefined ? null : value);
}

function parseJson(value: any) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isSqliteUniqueConstraintError(error: any) {
  const code = String(error && error.code ? error.code : '').trim().toUpperCase();
  return code.startsWith('SQLITE_CONSTRAINT');
}

function normalizeAvatarDataUrl(value: any) {
  const avatarDataUrl = String(value || '').trim();

  if (!avatarDataUrl) {
    return '';
  }

  if (avatarDataUrl.length > MAX_AVATAR_DATA_URL_LENGTH) {
    throw new Error('Agent avatar is too large');
  }

  if (!/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(avatarDataUrl)) {
    throw new Error('Agent avatar must be a PNG, JPEG, WEBP, or GIF image');
  }

  return avatarDataUrl;
}

function normalizeSandboxName(value: any) {
  const rawValue = String(value || '').trim();

  if (!rawValue) {
    return '';
  }

  if (rawValue.length > MAX_AGENT_SANDBOX_NAME_LENGTH) {
    throw new Error(`Agent sandbox name must be ${MAX_AGENT_SANDBOX_NAME_LENGTH} characters or fewer`);
  }

  const normalized = rawValue
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!normalized) {
    throw new Error('Agent sandbox name must include at least one letter, number, dot, underscore, or hyphen');
  }

  return normalized;
}

function resolveEffectiveSandboxName(sandboxName: any, agentId: any) {
  return normalizeSandboxName(sandboxName) || normalizeSandboxName(agentId) || 'agent';
}

function normalizeSkillRef(skill: any) {
  if (typeof skill === 'string') {
    return String(skill).trim() || null;
  }

  if (!skill || typeof skill !== 'object') {
    return null;
  }

  return String(skill.id || skill.skillId || skill.slug || skill.name || '').trim() || null;
}

function parseSkillRefs(value: any) {
  const parsed = parseJson(value);

  if (!Array.isArray(parsed)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];

  for (const skill of parsed) {
    const skillId = normalizeSkillRef(skill);

    if (!skillId || seen.has(skillId)) {
      continue;
    }

    seen.add(skillId);
    normalized.push(skillId);
  }

  return normalized;
}

function normalizeModelProfile(profile: any, index = 0) {
  if (!profile || typeof profile !== 'object') {
    return null;
  }

  const model = String(profile.model || '').trim();
  const provider = String(profile.provider || '').trim();
  const thinking = String(profile.thinking || '').trim();
  const personaPrompt = String(profile.personaPrompt || '').trim();
  const description = String(profile.description || '').trim();
  const name = String(profile.name || '').trim();
  const id = String(profile.id || `profile-${index + 1}`).trim() || `profile-${index + 1}`;

  if (!name && !model && !provider && !thinking && !personaPrompt && !description) {
    return null;
  }

  return {
    id,
    name: name || model || `Profile ${index + 1}`,
    description,
    provider,
    model,
    thinking,
    personaPrompt,
  };
}

function parseModelProfiles(value: any) {
  const parsed = parseJson(value);

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((profile, index) => normalizeModelProfile(profile, index))
    .filter(Boolean);
}

function findModelProfile(modelProfiles: any, profileId: any) {
  if (!profileId) {
    return null;
  }

  return (Array.isArray(modelProfiles) ? modelProfiles : []).find((profile) => profile.id === profileId) || null;
}

function normalizeAgentRow(row: any) {
  if (!row) {
    return null;
  }

  const modelProfiles = parseModelProfiles(row.model_profiles_json);
  const skillIds = parseSkillRefs(row.skills_json);
  const selectedModelProfileId = row.selected_model_profile_id ? String(row.selected_model_profile_id).trim() : null;
  const selectedModelProfile = findModelProfile(modelProfiles, selectedModelProfileId);
  const normalized = {
    id: row.id,
    name: row.name,
    sandboxName: row.sandbox_name ? String(row.sandbox_name).trim() : '',
    description: row.description || '',
    avatarDataUrl: row.avatar_data_url || '',
    personaPrompt: row.persona_prompt || '',
    provider: row.provider || '',
    model: row.model || '',
    thinking: row.thinking || '',
    accentColor: row.accent_color || '#3d405b',
    skillIds,
    skills: skillIds,
    modelProfiles,
    roleKind: row.role_kind || 'custom',
    modelFamily: row.model_family || null,
    isDefaultChatRole: Boolean(row.is_default_chat_role),
    selectedModelProfileId: selectedModelProfileId || null,
    selectedModelProfile,
    conversationSkillIds: parseSkillRefs(row.conversation_skills_json),
    conversationSkills: parseSkillRefs(row.conversation_skills_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sortOrder: row.sort_order !== undefined ? Number(row.sort_order || 0) : undefined,
  };

  return normalized;
}

function normalizeMessageRow(row: any) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    role: row.role,
    agentId: row.agent_id || null,
    senderName: row.sender_name,
    content: row.content,
    status: row.status,
    taskId: row.task_id || null,
    runId: typeof row.run_id === 'number' ? row.run_id : row.run_id ? Number(row.run_id) : null,
    errorMessage: row.error_message || '',
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
  };
}

function deriveMessageContentBlocks(content: any, imageRows: any[] = []) {
  const blocks: any[] = [];
  const normalizedContent = String(content || '');

  if (normalizedContent.trim()) {
    blocks.push({ type: 'text', text: normalizedContent });
  }

  for (const image of imageRows) {
    blocks.push({
      type: 'image',
      imageId: image.imageId,
      url: image.storedPath,
    });
  }

  return blocks;
}

function clipSearchSnippet(value: any, maxLength = 240) {
  const text = String(value || '').trim();

  if (!text) {
    return '';
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function normalizeMessageSearchResultRow(row: any) {
  if (!row) {
    return null;
  }

  const normalized: any = {
    messageId: row.message_id || row.id || '',
    conversationId: row.conversation_id || '',
    turnId: row.turn_id || '',
    role: row.role || '',
    agentId: row.agent_id || null,
    senderName: row.sender_name || '',
    createdAt: row.created_at || '',
    snippet: clipSearchSnippet(row.snippet || row.content || ''),
  };

  if (Number.isFinite(row.score)) {
    normalized.score = Number(row.score);
  }

  return normalized;
}

function normalizePrivateMessageRow(row: any) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    senderAgentId: row.sender_agent_id || null,
    senderName: row.sender_name,
    recipientAgentIds: parseSkillRefs(row.recipient_agent_ids_json),
    content: row.content,
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
  };
}

function normalizeSummarySegmentItems(value: any) {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\r?\n/u)
      : [];

  return rawItems
    .map((item: any) => clipSearchSnippet(item, MAX_SUMMARY_SEGMENT_ITEM_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_SUMMARY_SEGMENT_ITEMS);
}

function normalizeSummarySegmentRow(row: any) {
  if (!row) {
    return null;
  }

  const matchedTerms = Array.isArray(row.matchedTerms)
    ? row.matchedTerms.map((term: any) => String(term || '').trim()).filter(Boolean).slice(0, 8)
    : [];

  return {
    id: row.id,
    conversationId: row.conversation_id,
    sourceDigestId: row.source_digest_id,
    sourceKind: row.source_kind || 'entry',
    conversationTitle: row.conversation_title || '',
    taskName: row.task_name || '',
    summary: row.summary || '',
    facts: normalizeSummarySegmentItems(parseJson(row.facts_json)),
    decisions: normalizeSummarySegmentItems(parseJson(row.decisions_json)),
    openQuestions: normalizeSummarySegmentItems(parseJson(row.open_questions_json)),
    nextActions: normalizeSummarySegmentItems(parseJson(row.next_actions_json)),
    artifacts: normalizeSummarySegmentItems(parseJson(row.artifacts_json)),
    triggerReason: row.trigger_reason || '',
    messageRange: {
      fromMessageId: row.from_message_id || '',
      toMessageId: row.to_message_id || '',
      messageCount: Number.isInteger(row.message_count) ? row.message_count : Number(row.message_count || 0),
    },
    createdBy: row.created_by || '',
    segmentCreatedAt: row.segment_created_at,
    segmentUpdatedAt: row.segment_updated_at,
    metadata: parseJson(row.metadata_json) || {},
    score: Number.isFinite(row.score) ? Number(row.score) : undefined,
    matchedTerms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeConversationDigestList(conversation: any) {
  const metadata = conversation && conversation.metadata && typeof conversation.metadata === 'object'
    ? conversation.metadata
    : {};
  const digests = Array.isArray(metadata.conversationDigests) ? metadata.conversationDigests : [];

  return digests
    .filter((digest: any) => digest && typeof digest === 'object')
    .filter((digest: any) => String(digest.id || '').trim());
}

function buildSummarySegmentSearchText(parts: any[]) {
  return clipSearchSnippet(
    (Array.isArray(parts) ? parts : [])
      .flatMap((part) => Array.isArray(part) ? part : [part])
      .map((part) => String(part || '').trim())
      .filter(Boolean)
      .join('\n'),
    MAX_SUMMARY_SEGMENT_SEARCH_TEXT_LENGTH
  );
}

function resolveSummarySegmentMatchedTerms(segment: any, terms: any) {
  const normalizedTerms = (Array.isArray(terms) ? terms : [])
    .map((term: any) => String(term || '').trim())
    .filter(Boolean)
    .slice(0, 8);

  if (!segment || normalizedTerms.length === 0) {
    return [];
  }

  const searchText = buildSummarySegmentSearchText([
    segment.conversationTitle,
    segment.taskName,
    segment.sourceKind,
    segment.triggerReason,
    segment.createdBy,
    segment.summary,
    segment.facts,
    segment.decisions,
    segment.openQuestions,
    segment.nextActions,
    segment.artifacts,
  ]).toLocaleLowerCase();
  const seen = new Set();
  const matchedTerms = [];

  for (const term of normalizedTerms) {
    const normalizedTerm = term.toLocaleLowerCase();

    if (!normalizedTerm || seen.has(normalizedTerm) || !searchText.includes(normalizedTerm)) {
      continue;
    }

    seen.add(normalizedTerm);
    matchedTerms.push(term);
  }

  return matchedTerms;
}

function normalizeMemoryCardRow(row: any) {
  if (!row) {
    return null;
  }

  const scope = row.scope || CONVERSATION_MEMORY_SCOPE;

  return {
    id: row.id,
    conversationId: row.conversation_id || null,
    agentId: row.agent_id,
    scope,
    ownerKey: row.owner_key || (scope === LOCAL_USER_MEMORY_SCOPE ? LOCAL_USER_MEMORY_OWNER_KEY : row.conversation_id || ''),
    title: row.title || '',
    content: row.content || '',
    source: row.source || 'agent-tool',
    status: row.status || 'active',
    ttlDays: Number.isInteger(row.ttl_days) ? row.ttl_days : row.ttl_days ? Number(row.ttl_days) : null,
    expiresAt: row.expires_at || null,
    metadata: parseJson(row.metadata_json) || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeMemoryCardText(value: any, maxLength: number, fieldName: string) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');

  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }

  if (normalized.length > maxLength) {
    throw new Error(`${fieldName} must be ${maxLength} characters or fewer`);
  }

  return normalized;
}

function normalizeMemoryCardTtlDays(value: any) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_MEMORY_CARD_TTL_DAYS;
  }

  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('ttlDays must be a positive integer');
  }

  return Math.min(parsed, MAX_MEMORY_CARD_TTL_DAYS);
}

function addDaysIso(baseIso: string, days: number) {
  const date = new Date(baseIso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function isMemoryCardActiveAt(card: any, at = nowIso()) {
  if (!card) {
    return false;
  }

  if (String(card.status || '').trim() !== 'active') {
    return false;
  }

  if (!card.expiresAt) {
    return true;
  }

  return String(card.expiresAt).trim() > String(at).trim();
}

function mergeMemoryCardMetadata(existingMetadata: any, nextMetadata: any = {}, lastMutation: any = null) {
  const merged = {
    ...(existingMetadata && typeof existingMetadata === 'object' ? existingMetadata : {}),
    ...(nextMetadata && typeof nextMetadata === 'object' ? nextMetadata : {}),
  };

  if (lastMutation && typeof lastMutation === 'object') {
    merged.lastMutation = lastMutation;
  }

  return merged;
}

function mergeVisibleMemoryCards(primaryCards: any, secondaryCards: any, limit = MAX_MEMORY_CARDS_PER_SCOPE) {
  const visibleCards = [];
  const seenTitles = new Set();

  for (const card of [...(Array.isArray(primaryCards) ? primaryCards : []), ...(Array.isArray(secondaryCards) ? secondaryCards : [])]) {
    if (!card) {
      continue;
    }

    const titleKey = String(card.title || '').trim();

    if (titleKey && seenTitles.has(titleKey)) {
      continue;
    }

    if (titleKey) {
      seenTitles.add(titleKey);
    }

    visibleCards.push(card);

    if (visibleCards.length >= limit) {
      break;
    }
  }

  return visibleCards;
}

function normalizeConversationType(value: any) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return 'standard';
  }
  return normalized;
}

function normalizeConversationHeader(row: any) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    title: row.title,
    type: normalizeConversationType(row.type),
    metadata: parseJson(row.metadata_json) || {},
    projectScopeId: row.project_scope_id || null,
    parentConversationId: row.parent_conversation_id || null,
    originConversationId: row.origin_conversation_id || null,
    originMessageId: row.origin_message_id || null,
    treeDepth: Number.isInteger(row.tree_depth) ? row.tree_depth : Number(row.tree_depth || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at || null,
    messageCount: Number(row.message_count || 0),
    agentCount: Number(row.agent_count || 0),
    lastMessagePreview: row.last_message_preview || '',
  };
}

function normalizeConversationChannelBindingRow(row: any) {
  if (!row) {
    return null;
  }

  return {
    platform: row.platform,
    externalChatId: row.external_chat_id,
    conversationId: row.conversation_id,
    metadata: parseJson(row.metadata_json) || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeExternalEventRow(row: any) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    platform: row.platform,
    direction: row.direction,
    externalEventId: row.external_event_id || null,
    externalMessageId: row.external_message_id || null,
    conversationId: row.conversation_id || null,
    messageId: row.message_id || null,
    metadata: parseJson(row.metadata_json) || {},
    createdAt: row.created_at,
  };
}

function normalizeCrossConversationDeliveryRow(row: any) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    kind: row.kind,
    idempotencyScope: row.idempotency_scope,
    idempotencyKey: row.idempotency_key,
    principalKind: row.principal_kind,
    sourceConversationId: row.source_conversation_id,
    sourceMessageId: row.source_message_id || null,
    sourceTurnId: row.source_turn_id || null,
    sourceInvocationId: row.source_invocation_id || null,
    sourceAgentId: row.source_agent_id || null,
    sourceAgentName: row.source_agent_name,
    sourceProjectScopeId: row.source_project_scope_id,
    targetConversationId: row.target_conversation_id,
    targetAgentId: row.target_agent_id,
    targetMessageId: row.target_message_id || null,
    sourceReceiptMessageId: row.source_receipt_message_id || null,
    targetProjectScopeId: row.target_project_scope_id,
    traceId: row.trace_id,
    rootDeliveryId: row.root_delivery_id,
    parentDeliveryId: row.parent_delivery_id || null,
    replyToDeliveryId: row.reply_to_delivery_id || null,
    hopCount: Number(row.hop_count || 0),
    messageStatus: row.message_status,
    dispatchStatus: row.dispatch_status,
    responseStatus: row.response_status,
    attemptCount: Number(row.attempt_count || 0),
    deadlineAt: row.deadline_at || null,
    cancelRequestedAt: row.cancel_requested_at || null,
    lastErrorCode: row.last_error_code || null,
    lastErrorMessage: row.last_error_message || null,
    claimOwner: row.claim_owner || null,
    claimExpiresAt: row.claim_expires_at || null,
    nextAttemptAt: row.next_attempt_at || null,
    targetInvocationId: row.target_invocation_id || null,
    deliveredAt: row.delivered_at || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    respondedAt: row.responded_at || null,
    terminalAt: row.terminal_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function compactCrossConversationDeliveryStatus(row: any) {
  const delivery = normalizeCrossConversationDeliveryRow(row);
  if (!delivery) {
    return null;
  }
  return {
    id: delivery.id,
    kind: delivery.kind,
    sourceConversationId: delivery.sourceConversationId,
    targetConversationId: delivery.targetConversationId,
    targetAgentId: delivery.targetAgentId,
    messageStatus: delivery.messageStatus,
    dispatchStatus: delivery.dispatchStatus,
    responseStatus: delivery.responseStatus,
    startedAt: delivery.startedAt,
    targetInvocationId: delivery.targetInvocationId,
    lastErrorCode: delivery.lastErrorCode,
    lastErrorMessage: delivery.lastErrorMessage,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
}

function normalizeCrossConversationDeliveryEventRow(row: any) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    deliveryId: row.delivery_id,
    eventType: row.event_type,
    attemptNumber: Number(row.attempt_number || 0),
    actorKind: row.actor_kind || null,
    actorId: row.actor_id || null,
    event: parseJson(row.event_json) || {},
    createdAt: row.created_at,
  };
}

function normalizeConversation(row: any, agents: any, messages: any) {
  const header = normalizeConversationHeader(row);

  if (!header) {
    return null;
  }

  return {
    ...header,
    agents,
    messages,
  };
}

function normalizePlanRow(row: any) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    ownerConversationId: row.owner_conversation_id,
    status: row.status,
    version: Number(row.version || 1),
    doc: parseJson(row.doc_json) || { nodes: [] },
    activatedAt: row.activated_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createPlanError(statusCode: number, code: string, message: string, details: Record<string, unknown> = {}) {
  const error: any = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  Object.assign(error, details);
  return error;
}

/**
 * Plan actor (D15/D18, .trellis/tasks/dag-execution/prd.md §3.4):
 * - user   — the local single-user REST/UI channel (trusted)
 * - agent  — authenticated agent-tool bridge invocations; D15 restricts
 *            activate/revert to agents participating in the ROOT owner
 *            conversation, invoked from that root conversation
 * - system — internal scheduler write-backs (bypass D15, still audited)
 */
type PlanActor = { type: 'user' | 'agent' | 'system'; agentId?: string; conversationId?: string };

function normalizePlanActor(actor: any): PlanActor {
  if (!actor || typeof actor !== 'object') {
    return { type: 'user' };
  }
  const type = ['user', 'agent', 'system'].includes(actor.type) ? actor.type : 'user';
  return {
    type,
    agentId: typeof actor.agentId === 'string' && actor.agentId.trim() ? actor.agentId.trim() : undefined,
    conversationId: typeof actor.conversationId === 'string' && actor.conversationId.trim()
      ? actor.conversationId.trim()
      : undefined,
  };
}

/** History attribution label (D18): user / agent:<id> / system. */
function planActorLabel(actor: PlanActor): string {
  if (actor.type === 'agent') {
    return `agent:${actor.agentId || 'unknown'}`;
  }
  return actor.type === 'system' ? 'system' : 'user';
}

function createParticipantRosterError(
  statusCode: number,
  code: string,
  message: string,
  path = '',
  details: Record<string, unknown> = {}
) {
  const error: any = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.issues = [{
    code,
    message,
    ...(path ? { path } : {}),
    ...details,
  }];
  return error;
}

function createProjectScopeBindingError(statusCode: number, code: string, message: string) {
  const error: any = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.issues = [{ code, message }];
  return error;
}

function normalizeRecipientAgentIds(recipientAgentIds: any) {
  const seen = new Set();
  const normalized = [];

  for (const value of Array.isArray(recipientAgentIds) ? recipientAgentIds : []) {
    const agentId = String(value || '').trim();

    if (!agentId || seen.has(agentId)) {
      continue;
    }

    seen.add(agentId);
    normalized.push(agentId);
  }

  return normalized;
}

export class ChatAppStore {
  [key: string]: any;
  constructor({ agentDir, sqlitePath, chatSchemaBackupScriptPath }: any) {
    const connection = openSqliteDatabase({
      agentDir,
      sqlitePath,
      prepareChatSchemaMigration: true,
      chatSchemaBackupScriptPath,
    });

    try {
      this.agentDir = connection.agentDir;
      this.databasePath = connection.databasePath;
      this.db = connection.db;

      migrateChatSchema(this.db, { backupPath: connection.chatSchemaBackupPath });

      this.roleIdentityRepository = createChatRoleIdentityRepository(this.db);
      this.agentRepository = createChatAgentRepository(this.db);
      this.conversationAgentHistoryRepository = createChatConversationAgentHistoryRepository(this.db);
      this.conversationRepository = createChatConversationRepository(this.db);
      this.participantRepository = createChatParticipantRepository(this.db);
      this.messageRepository = createChatMessageRepository(this.db);
      this.privateMessageRepository = createChatPrivateMessageRepository(this.db);
      this.memoryCardRepository = createChatMemoryCardRepository(this.db);
      this.summarySegmentRepository = createChatSummarySegmentRepository(this.db);
      this.channelBindingRepository = createChatChannelBindingRepository(this.db);
      this.externalEventRepository = createChatExternalEventRepository(this.db);
      this.imageUploadRepository = createImageUploadRepository(this.db);
      this.crossConversationDeliveryRepository = createCrossConversationDeliveryRepository(this.db);
      this.planRepository = createChatPlanRepository(this.db);

      this.replaceConversationParticipants = (conversationId: any, participants: any) => {
        const createdAt = nowIso();

        this.participantRepository.replaceForConversation(
          conversationId,
          (Array.isArray(participants) ? participants : []).map((participant: any) => ({
            ...participant,
            conversationSkillsJson: serializeJson(participant.conversationSkills || []),
            createdAt,
          }))
        );
      };

      this.saveAgentTransaction = this.db.transaction((payload: any) => {
        const timestamp = nowIso();

        this.roleIdentityRepository.saveActiveCustom({
          ...payload,
          createdAt: timestamp,
          updatedAt: timestamp,
        });

        return normalizeAgentRow(
          this.agentRepository.save({
            ...payload,
            skillsJson: serializeJson(payload.skills),
            modelProfilesJson: serializeJson(payload.modelProfiles),
            roleKind: payload.roleKind || 'custom',
            modelFamily: payload.modelFamily || null,
            isDefaultChatRole: Boolean(payload.isDefaultChatRole),
            createdAt: timestamp,
            updatedAt: timestamp,
          })
        );
      });

      this.saveSystemRoleConfigTransaction = this.db.transaction((payload: any) => {
        const existing = this.getAgent(payload.id);

        if (!existing || existing.roleKind !== 'model_family') {
          const error: any = new Error('System model-family role not found');
          error.code = 'system_role_not_found';
          throw error;
        }

        const timestamp = nowIso();
        return normalizeAgentRow(
          this.agentRepository.save({
            ...payload,
            id: existing.id,
            name: existing.name,
            sandboxName: existing.sandboxName,
            description: existing.description,
            avatarDataUrl: Object.hasOwn(payload, 'avatarDataUrl') ? payload.avatarDataUrl : existing.avatarDataUrl,
            personaPrompt: '',
            accentColor: existing.accentColor,
            skillsJson: '[]',
            modelProfilesJson: serializeJson(payload.modelProfiles),
            roleKind: 'model_family',
            modelFamily: existing.modelFamily,
            isDefaultChatRole: Boolean(payload.isDefaultChatRole),
            createdAt: existing.createdAt,
            updatedAt: timestamp,
          })
        );
      });

      this.retireRoleConfigTransaction = this.db.transaction((roleId: any, retiredReason: any) => {
        const agent = this.getAgent(roleId);

        if (!agent) {
          const error: any = new Error('Role not found');
          error.code = 'role_not_found';
          throw error;
        }

        if (agent.roleKind !== 'custom') {
          const error: any = new Error('System model-family roles cannot be deleted');
          error.code = 'system_role_delete_forbidden';
          throw error;
        }

        const retiredAt = nowIso();
        const reason = String(retiredReason || 'custom_role_deleted').trim() || 'custom_role_deleted';
        const identity = this.roleIdentityRepository.retireActiveCustom(agent.id, reason, retiredAt);

        if (!identity) {
          const error: any = new Error('Role identity cannot be retired');
          error.code = 'role_identity_not_retirable';
          throw error;
        }

        const historyCount = this.conversationAgentHistoryRepository.snapshotActiveRole(
          agent.id,
          retiredAt,
          reason
        );
        this.agentRepository.delete(agent.id);

        return {
          roleId: agent.id,
          retiredAt,
          retiredReason: reason,
          historyCount,
        };
      });

      this.createConversationTransaction = this.db.transaction((payload: any) => {
        const timestamp = nowIso();

        if (!Array.isArray(payload.participants) || payload.participants.length === 0) {
          throw createParticipantRosterError(
            400,
            'participants_required',
            'At least one explicit conversation participant is required',
            'participants'
          );
        }

        this.conversationRepository.create({
          id: payload.id,
          title: payload.title,
          type: normalizeConversationType(payload.type),
          metadataJson: serializeJson(payload.metadata || {}),
          projectScopeId: null,
          parentConversationId: null,
          originConversationId: null,
          originMessageId: null,
          treeDepth: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          lastMessageAt: null,
        });
        this.replaceConversationParticipants(payload.id, payload.participants);

        return this.getConversation(payload.id);
      });

      this.updateConversationTransaction = this.db.transaction((conversationId: any, updates: any) => {
        if (updates.title !== undefined) {
          this.conversationRepository.update(conversationId, {
            title: updates.title,
            type: normalizeConversationType(updates.type),
            metadataJson: serializeJson(updates.metadata || {}),
            updatedAt: nowIso(),
          });
        } else {
          this.conversationRepository.touch(conversationId, {
            updatedAt: nowIso(),
            lastMessageAt: null,
          });
        }

        if (Array.isArray(updates.participants)) {
          this.replaceConversationParticipants(conversationId, updates.participants);
        }

        return this.getConversation(conversationId);
      });

      this.bindConversationProjectScopeTransaction = this.db.transaction((conversationId: any, projectScopeId: any) => {
        const normalizedConversationId = String(conversationId || '').trim();
        const normalizedProjectScopeId = String(projectScopeId || '').trim();
        const existing = this.getConversationWithoutMessages(normalizedConversationId);

        if (!existing) {
          throw createProjectScopeBindingError(404, 'conversation_not_found', 'Conversation not found');
        }
        if (!normalizedProjectScopeId) {
          throw createProjectScopeBindingError(400, 'project_id_required', 'projectId is required');
        }
        if (existing.projectScopeId === normalizedProjectScopeId) {
          return existing;
        }
        if (existing.projectScopeId) {
          throw createProjectScopeBindingError(
            409,
            'conversation_project_scope_immutable',
            'Conversation project scope is already bound and cannot be changed'
          );
        }
        if (this.crossConversationDeliveryRepository.hasNonTerminalForConversation(normalizedConversationId)) {
          throw createProjectScopeBindingError(
            409,
            'conversation_project_scope_delivery_conflict',
            'Conversation project scope cannot change while a cross-conversation delivery is non-terminal'
          );
        }

        const bound = this.conversationRepository.bindProjectScope(normalizedConversationId, {
          projectScopeId: normalizedProjectScopeId,
          updatedAt: nowIso(),
        });
        if (!bound) {
          throw createProjectScopeBindingError(
            409,
            'conversation_project_scope_conflict',
            'Conversation project scope binding changed concurrently; refresh and retry'
          );
        }

        return this.getConversationWithoutMessages(normalizedConversationId);
      });

      this.createMessageTransaction = this.db.transaction((payload: any) => {
        const createdAt = payload.createdAt || nowIso();

        this.messageRepository.create({
          id: payload.id,
          conversationId: payload.conversationId,
          turnId: payload.turnId,
          role: payload.role,
          agentId: payload.agentId || null,
          senderName: payload.senderName,
          content: payload.content || '',
          status: payload.status || 'completed',
          taskId: payload.taskId || null,
          runId: payload.runId || null,
          errorMessage: payload.errorMessage || null,
          metadataJson: serializeJson(payload.metadata),
          clientRequestId: payload.clientRequestId || null,
          createdAt,
        });

        if (Array.isArray(payload.imageIds) && payload.imageIds.length > 0) {
          const attachedCount = this.imageUploadRepository.attachChildren(
            payload.imageIds,
            payload.conversationId,
            payload.id,
            createdAt
          );

          if (attachedCount !== payload.imageIds.length) {
            const imageError = new Error('IMAGE_ATTACH_FAILED') as any;
            imageError.statusCode = 400;
            imageError.code = 'IMAGE_ALREADY_ATTACHED';
            imageError.message = 'One or more images are not staged or do not belong to this conversation';
            throw imageError;
          }

          for (const batchId of payload.consumedBatchIds || []) {
            this.imageUploadRepository.markBatchConsumed(batchId, createdAt);
          }
        }

        this.conversationRepository.touch(payload.conversationId, {
          updatedAt: createdAt,
          lastMessageAt: createdAt,
        });

        return this.getMessage(payload.id);
      });

      this.attachImageUploadsTransaction = this.db.transaction((payload: any) => {
        return this.imageUploadRepository.attachChildren(
          payload.imageIds,
          payload.conversationId,
          payload.messageId,
          payload.attachedAt
        );
      });

      this.finalizeImageUploadBatchTransaction = this.db.transaction((payload: any) => {
        const children = Array.isArray(payload.children) ? payload.children : [];
        const batch = this.imageUploadRepository.getBatchById(payload.batchId);

        if (!batch) {
          const missingBatchError = new Error('Image upload batch does not exist') as any;
          missingBatchError.code = 'IMAGE_BATCH_NOT_FOUND';
          throw missingBatchError;
        }

        const expectedCount = Number(batch.expectedCount);

        if (children.length !== expectedCount) {
          const countError = new Error(
            `Finalize rejected: expected ${expectedCount} children, got ${children.length}`
          ) as any;
          countError.code = 'IMAGE_BATCH_COUNT_MISMATCH';
          throw countError;
        }

        const slots = children.map((child: any) => child.slot).sort((a: number, b: number) => a - b);

        for (let i = 0; i < slots.length; i += 1) {
          if (slots[i] !== i) {
            const slotError = new Error('Finalize rejected: slots are not continuous 0..n-1') as any;
            slotError.code = 'IMAGE_BATCH_SLOT_MISMATCH';
            throw slotError;
          }
        }

        for (const child of children) {
          this.insertImageUpload({
            imageId: child.imageId || randomUUID(),
            batchId: payload.batchId,
            slot: child.slot,
            fileName: child.fileName,
            storedPath: child.storedPath,
            mimeType: child.mimeType,
            width: child.width,
            height: child.height,
            sizeBytes: child.sizeBytes,
            createdAt: payload.completedAt,
          });
        }

        const completed = this.imageUploadRepository.completeBatch(
          payload.batchId,
          payload.leaseToken,
          payload.completedAt
        );

        if (!completed) {
          const fencedError = new Error('Image upload batch fenced by another lease owner') as any;
          fencedError.code = 'IMAGE_BATCH_FENCED';
          throw fencedError;
        }

        return this.imageUploadRepository.getBatchById(payload.batchId);
      });

      this.recycleImageUploadsByMessageTransaction = this.db.transaction((payload: any) => {
        return this.imageUploadRepository.recycleByMessage(payload.messageId, payload.ttlExpiresAt);
      });

      this.purgeConversationImageUploadsTransaction = this.db.transaction((payload: any) => {
        return this.imageUploadRepository.purgeByConversation(payload.conversationId);
      });

      this.deleteConversationTransaction = this.db.transaction((payload: any) => {
        this.imageUploadRepository.purgeByConversation(payload.conversationId);
        this.conversationRepository.delete(payload.conversationId);
        return { deleted: true };
      });

      this.persistCrossConversationDeliveryTransaction = this.db.transaction((payload: any) => {
        const existing = this.crossConversationDeliveryRepository.getByIdempotency(
          payload.delivery.idempotencyScope,
          payload.delivery.idempotencyKey
        );

        if (existing) {
          return {
            duplicate: true,
            delivery: normalizeCrossConversationDeliveryRow(existing),
            targetMessage: normalizeMessageRow(this.messageRepository.get(existing.target_message_id)),
            sourceReceipt: normalizeMessageRow(this.messageRepository.get(existing.source_receipt_message_id)),
          };
        }

        this.crossConversationDeliveryRepository.create(payload.delivery);
        this.messageRepository.create({
          ...payload.targetMessage,
          metadataJson: serializeJson(payload.targetMessage.metadata),
        });
        this.conversationRepository.touch(payload.delivery.targetConversationId, {
          updatedAt: payload.targetMessage.createdAt,
          lastMessageAt: payload.targetMessage.createdAt,
        });
        this.messageRepository.create({
          ...payload.sourceReceipt,
          metadataJson: serializeJson(payload.sourceReceipt.metadata),
        });
        this.conversationRepository.touch(payload.delivery.sourceConversationId, {
          updatedAt: payload.sourceReceipt.createdAt,
          lastMessageAt: payload.sourceReceipt.createdAt,
        });

        const persisted = this.crossConversationDeliveryRepository.markMessagesPersisted(payload.delivery.id, {
          targetMessageId: payload.targetMessage.id,
          sourceReceiptMessageId: payload.sourceReceipt.id,
          deliveredAt: payload.deliveredAt,
          updatedAt: payload.deliveredAt,
        });

        if (!persisted) {
          throw new Error('Cross-conversation delivery message projection transition failed');
        }

        this.crossConversationDeliveryRepository.appendEvent({
          deliveryId: payload.delivery.id,
          eventType: 'persisted',
          attemptNumber: 0,
          actorKind: payload.delivery.principalKind,
          actorId: payload.delivery.sourceAgentId || null,
          eventJson: serializeJson(payload.persistedEvent),
          createdAt: payload.deliveredAt,
        });

        return {
          duplicate: false,
          delivery: normalizeCrossConversationDeliveryRow(persisted),
          targetMessage: normalizeMessageRow(this.messageRepository.get(payload.targetMessage.id)),
          sourceReceipt: normalizeMessageRow(this.messageRepository.get(payload.sourceReceipt.id)),
        };
      });

      this.persistConversationSpawnTransaction = this.db.transaction((payload: any) => {
        const existing = this.crossConversationDeliveryRepository.getByIdempotency(
          payload.delivery.idempotencyScope,
          payload.delivery.idempotencyKey
        );

        if (existing) {
          return {
            duplicate: true,
            conversation: this.getConversation(existing.target_conversation_id),
            initialMessage: normalizeMessageRow(this.messageRepository.get(existing.target_message_id)),
            sourceReceipt: normalizeMessageRow(this.messageRepository.get(existing.source_receipt_message_id)),
            delivery: normalizeCrossConversationDeliveryRow(existing),
          };
        }

        const conversation = payload.conversation;
        this.conversationRepository.create({
          id: conversation.id,
          title: conversation.title,
          type: normalizeConversationType(conversation.type),
          metadataJson: serializeJson(conversation.metadata || {}),
          projectScopeId: conversation.projectScopeId,
          parentConversationId: conversation.parentConversationId,
          originConversationId: conversation.originConversationId,
          originMessageId: conversation.originMessageId,
          treeDepth: conversation.treeDepth,
          createdAt: conversation.createdAt,
          updatedAt: conversation.createdAt,
          lastMessageAt: null,
        });
        this.replaceConversationParticipants(conversation.id, conversation.participants);

        this.crossConversationDeliveryRepository.create(payload.delivery);
        this.messageRepository.create({
          ...payload.initialMessage,
          metadataJson: serializeJson(payload.initialMessage.metadata),
        });
        this.conversationRepository.touch(conversation.id, {
          updatedAt: payload.initialMessage.createdAt,
          lastMessageAt: payload.initialMessage.createdAt,
        });
        this.messageRepository.create({
          ...payload.sourceReceipt,
          metadataJson: serializeJson(payload.sourceReceipt.metadata),
        });
        this.conversationRepository.touch(payload.delivery.sourceConversationId, {
          updatedAt: payload.sourceReceipt.createdAt,
          lastMessageAt: payload.sourceReceipt.createdAt,
        });

        const persisted = this.crossConversationDeliveryRepository.markMessagesPersisted(payload.delivery.id, {
          targetMessageId: payload.initialMessage.id,
          sourceReceiptMessageId: payload.sourceReceipt.id,
          deliveredAt: payload.deliveredAt,
          updatedAt: payload.deliveredAt,
        });
        if (!persisted) {
          throw new Error('Conversation spawn message projection transition failed');
        }

        this.crossConversationDeliveryRepository.appendEvent({
          deliveryId: payload.delivery.id,
          eventType: 'persisted',
          attemptNumber: 0,
          actorKind: 'operator',
          actorId: null,
          eventJson: serializeJson(payload.persistedEvent),
          createdAt: payload.deliveredAt,
        });

        return {
          duplicate: false,
          conversation: this.getConversation(conversation.id),
          initialMessage: normalizeMessageRow(this.messageRepository.get(payload.initialMessage.id)),
          sourceReceipt: normalizeMessageRow(this.messageRepository.get(payload.sourceReceipt.id)),
          delivery: normalizeCrossConversationDeliveryRow(persisted),
        };
      });

      this.persistCrossConversationResponseTransaction = this.db.transaction((payload: any) => {
        const requestRow = this.crossConversationDeliveryRepository.get(payload.requestDeliveryId);

        if (!requestRow || requestRow.kind !== 'request') {
          throw new Error('Cross-conversation request delivery not found');
        }

        const existingResponse = this.crossConversationDeliveryRepository.getByReplyTo(requestRow.id);
        if (existingResponse) {
          return {
            duplicate: true,
            requestDelivery: normalizeCrossConversationDeliveryRow(requestRow),
            responseDelivery: normalizeCrossConversationDeliveryRow(existingResponse),
            responseMessage: normalizeMessageRow(this.messageRepository.get(existingResponse.target_message_id)),
          };
        }

        const assistantMessage = this.messageRepository.get(payload.assistantMessage.id);
        if (
          !assistantMessage
          || assistantMessage.conversation_id !== requestRow.target_conversation_id
          || assistantMessage.agent_id !== requestRow.target_agent_id
          || assistantMessage.role !== 'assistant'
          || assistantMessage.status !== 'completed'
        ) {
          throw new Error('Cross-conversation response assistant message does not match the request target');
        }
        if (!requestRow.source_agent_id) {
          throw new Error('Cross-conversation Agent request is missing its source Agent');
        }

        const responseDeliveryId = randomUUID();
        const responseMessageId = randomUUID();
        const createdAt = payload.createdAt || nowIso();
        this.crossConversationDeliveryRepository.create({
          id: responseDeliveryId,
          kind: 'notify',
          idempotencyScope: `response:${requestRow.id}`,
          idempotencyKey: assistantMessage.id,
          principalKind: 'agent',
          sourceConversationId: requestRow.target_conversation_id,
          sourceMessageId: assistantMessage.id,
          sourceTurnId: assistantMessage.turn_id,
          sourceInvocationId: requestRow.target_invocation_id || null,
          sourceAgentId: requestRow.target_agent_id,
          sourceAgentName: assistantMessage.sender_name,
          sourceProjectScopeId: requestRow.target_project_scope_id,
          targetConversationId: requestRow.source_conversation_id,
          targetAgentId: requestRow.source_agent_id,
          targetMessageId: null,
          sourceReceiptMessageId: null,
          targetProjectScopeId: requestRow.source_project_scope_id,
          traceId: requestRow.trace_id,
          rootDeliveryId: requestRow.root_delivery_id,
          parentDeliveryId: requestRow.id,
          replyToDeliveryId: requestRow.id,
          hopCount: Number(requestRow.hop_count || 0),
          messageStatus: 'pending',
          dispatchStatus: 'not_requested',
          responseStatus: 'not_expected',
          attemptCount: 0,
          deadlineAt: null,
          cancelRequestedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          claimOwner: null,
          claimExpiresAt: null,
          nextAttemptAt: null,
          targetInvocationId: null,
          deliveredAt: null,
          startedAt: null,
          completedAt: createdAt,
          respondedAt: null,
          terminalAt: createdAt,
          createdAt,
          updatedAt: createdAt,
        });
        this.messageRepository.create({
          id: responseMessageId,
          conversationId: requestRow.source_conversation_id,
          turnId: `cross-response:${responseDeliveryId}`,
          role: 'external_agent',
          agentId: requestRow.target_agent_id,
          senderName: assistantMessage.sender_name,
          content: assistantMessage.content,
          status: 'completed',
          taskId: null,
          runId: null,
          errorMessage: null,
          metadataJson: serializeJson({
            crossConversation: {
              deliveryId: responseDeliveryId,
              replyToDeliveryId: requestRow.id,
              kind: 'response',
              authority: 'external_agent',
              allowHandoffs: false,
              sourceConversationId: requestRow.target_conversation_id,
              sourceAgentId: requestRow.target_agent_id,
              sourceAgentName: assistantMessage.sender_name,
              traceId: requestRow.trace_id,
            },
          }),
          createdAt,
        });
        this.conversationRepository.touch(requestRow.source_conversation_id, {
          updatedAt: createdAt,
          lastMessageAt: createdAt,
        });

        const responseDelivery = this.crossConversationDeliveryRepository.markResponseMessagePersisted(
          responseDeliveryId,
          {
            targetMessageId: responseMessageId,
            deliveredAt: createdAt,
          }
        );
        const requestDelivery = this.crossConversationDeliveryRepository.markRequestResponse(requestRow.id, {
          respondedAt: createdAt,
        });

        if (!responseDelivery || !requestDelivery) {
          throw new Error('Cross-conversation response state transition failed');
        }

        this.crossConversationDeliveryRepository.appendEvent({
          deliveryId: responseDeliveryId,
          eventType: 'response_persisted',
          attemptNumber: 0,
          actorKind: 'agent',
          actorId: requestRow.target_agent_id,
          eventJson: serializeJson({
            replyToDeliveryId: requestRow.id,
            targetMessageId: responseMessageId,
            traceId: requestRow.trace_id,
          }),
          createdAt,
        });
        this.crossConversationDeliveryRepository.appendEvent({
          deliveryId: requestRow.id,
          eventType: requestDelivery.response_status === 'late' ? 'late_response_received' : 'response_received',
          attemptNumber: Number(requestRow.attempt_count || 0),
          actorKind: 'agent',
          actorId: requestRow.target_agent_id,
          eventJson: serializeJson({
            responseDeliveryId,
            responseMessageId,
            responseStatus: requestDelivery.response_status,
          }),
          createdAt,
        });

        return {
          duplicate: false,
          requestDelivery: normalizeCrossConversationDeliveryRow(requestDelivery),
          responseDelivery: normalizeCrossConversationDeliveryRow(responseDelivery),
          responseMessage: normalizeMessageRow(this.messageRepository.get(responseMessageId)),
        };
      });

      this.createPrivateMessageTransaction = this.db.transaction((payload: any) => {
        const createdAt = payload.createdAt || nowIso();

        return normalizePrivateMessageRow(
          this.privateMessageRepository.create({
            id: payload.id,
            conversationId: payload.conversationId,
            turnId: payload.turnId,
            senderAgentId: payload.senderAgentId || null,
            senderName: payload.senderName,
            recipientAgentIdsJson: serializeJson(payload.recipientAgentIds || []),
            content: payload.content || '',
            metadataJson: serializeJson(payload.metadata),
            createdAt,
          })
        );
      });

      this.saveMemoryCardTransaction = this.db.transaction((payload: any) => {
        const timestamp = payload.updatedAt || nowIso();
        const scope = String(payload.scope || CONVERSATION_MEMORY_SCOPE).trim() || CONVERSATION_MEMORY_SCOPE;
        const ownerKey = String(
          payload.ownerKey || (scope === LOCAL_USER_MEMORY_SCOPE ? LOCAL_USER_MEMORY_OWNER_KEY : payload.conversationId || '')
        ).trim();
        const existing = this.memoryCardRepository.getByScopeOwnerAgentTitle(
          scope,
          ownerKey,
          payload.agentId,
          payload.title
        );

        if (!existing) {
          const activeCount = this.memoryCardRepository.countActiveByScopeOwnerAgent(scope, ownerKey, payload.agentId, {
            now: timestamp,
          });

          if (activeCount >= MAX_MEMORY_CARDS_PER_SCOPE) {
            throw new Error(`Memory card budget exceeded: max ${MAX_MEMORY_CARDS_PER_SCOPE} active cards per ${scope}`);
          }

          return normalizeMemoryCardRow(
            this.memoryCardRepository.create({
              id: payload.id,
              conversationId: payload.conversationId || null,
              agentId: payload.agentId,
              scope,
              ownerKey,
              title: payload.title,
              content: payload.content,
              source: payload.source,
              status: 'active',
              ttlDays: payload.ttlDays,
              expiresAt: payload.expiresAt,
              metadataJson: serializeJson(payload.metadata),
              createdAt: timestamp,
              updatedAt: timestamp,
            })
          );
        }

        const existingCard = normalizeMemoryCardRow(existing);
        const existingIsActive = isMemoryCardActiveAt(existingCard, timestamp);

        if (!existingIsActive) {
          const activeCount = this.memoryCardRepository.countActiveByScopeOwnerAgent(scope, ownerKey, payload.agentId, {
            now: timestamp,
          });

          if (activeCount >= MAX_MEMORY_CARDS_PER_SCOPE) {
            throw new Error(`Memory card budget exceeded: max ${MAX_MEMORY_CARDS_PER_SCOPE} active cards per ${scope}`);
          }
        }

        const metadata = mergeMemoryCardMetadata(parseJson(existing.metadata_json), payload.metadata);

        if (!existingIsActive) {
          delete metadata.lastMutation;
        }

        return normalizeMemoryCardRow(
          this.memoryCardRepository.update(existing.id, {
            conversationId: payload.conversationId || null,
            content: payload.content,
            source: payload.source,
            status: 'active',
            ttlDays: payload.ttlDays,
            expiresAt: payload.expiresAt,
            metadataJson: serializeJson(metadata),
            updatedAt: timestamp,
          })
        );
      });

      this.updateLocalUserMemoryCardTransaction = this.db.transaction((payload: any) => {
        const timestamp = payload.updatedAt || nowIso();
        const ownerKey = String(payload.ownerKey || LOCAL_USER_MEMORY_OWNER_KEY).trim() || LOCAL_USER_MEMORY_OWNER_KEY;
        const existingRow = this.memoryCardRepository.getByLocalUserAgentTitle(payload.agentId, payload.title, { ownerKey });
        const existing = normalizeMemoryCardRow(existingRow);

        if (!existing || !isMemoryCardActiveAt(existing, timestamp)) {
          throw new Error('Memory card not found');
        }

        if (payload.expectedUpdatedAt && existing.updatedAt !== payload.expectedUpdatedAt) {
          throw new Error('Memory card changed since it was last read');
        }

        const ttlDays = Number.isInteger(existing.ttlDays) && existing.ttlDays > 0
          ? existing.ttlDays
          : DEFAULT_MEMORY_CARD_TTL_DAYS;

        return normalizeMemoryCardRow(
          this.memoryCardRepository.update(existing.id, {
            conversationId: null,
            content: payload.content,
            source: payload.source,
            status: 'active',
            ttlDays,
            expiresAt: addDaysIso(timestamp, ttlDays),
            metadataJson: serializeJson(
              mergeMemoryCardMetadata(parseJson(existingRow && existingRow.metadata_json), payload.metadata, payload.lastMutation)
            ),
            updatedAt: timestamp,
          })
        );
      });

      this.forgetLocalUserMemoryCardTransaction = this.db.transaction((payload: any) => {
        const timestamp = payload.updatedAt || nowIso();
        const ownerKey = String(payload.ownerKey || LOCAL_USER_MEMORY_OWNER_KEY).trim() || LOCAL_USER_MEMORY_OWNER_KEY;
        const existingRow = this.memoryCardRepository.getByLocalUserAgentTitle(payload.agentId, payload.title, { ownerKey });
        const existing = normalizeMemoryCardRow(existingRow);

        if (!existing || !isMemoryCardActiveAt(existing, timestamp)) {
          throw new Error('Memory card not found');
        }

        if (payload.expectedUpdatedAt && existing.updatedAt !== payload.expectedUpdatedAt) {
          throw new Error('Memory card changed since it was last read');
        }

        return normalizeMemoryCardRow(
          this.memoryCardRepository.update(existing.id, {
            conversationId: null,
            content: existing.content,
            source: payload.source,
            status: DELETED_MEMORY_CARD_STATUS,
            ttlDays: existing.ttlDays,
            expiresAt: existing.expiresAt,
            metadataJson: serializeJson(
              mergeMemoryCardMetadata(parseJson(existingRow && existingRow.metadata_json), payload.metadata, payload.lastMutation)
            ),
            updatedAt: timestamp,
          })
        );
      });

      this.createConversationChannelBindingTransaction = this.db.transaction((payload: any) =>
        normalizeConversationChannelBindingRow(
          this.channelBindingRepository.create({
            platform: payload.platform,
            externalChatId: payload.externalChatId,
            conversationId: payload.conversationId,
            metadataJson: serializeJson(payload.metadata),
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          })
        )
      );

      this.updateConversationChannelBindingTransaction = this.db.transaction((payload: any) =>
        normalizeConversationChannelBindingRow(
          this.channelBindingRepository.update(payload.platform, payload.externalChatId, {
            conversationId: payload.conversationId,
            metadataJson: serializeJson(payload.metadata),
            updatedAt: payload.updatedAt,
          })
        )
      );

      this.getOrCreateExternalConversationTransaction = this.db.transaction((payload: any) => {
        const existingBinding = normalizeConversationChannelBindingRow(
          this.channelBindingRepository.getByExternalChatId(payload.platform, payload.externalChatId)
        );

        if (existingBinding) {
          return {
            binding: existingBinding,
            conversation: this.getConversation(existingBinding.conversationId),
          };
        }

        const timestamp = nowIso();
        const conversationId = String(payload.conversationId || randomUUID()).trim();
        const participants = this.normalizeConversationParticipantsInput(payload);

        this.conversationRepository.create({
          id: conversationId,
          title: payload.title,
          type: normalizeConversationType(payload.type),
          metadataJson: serializeJson(payload.metadata || {}),
          createdAt: timestamp,
          updatedAt: timestamp,
          lastMessageAt: null,
        });
        this.replaceConversationParticipants(
          conversationId,
          participants
        );

        const binding = normalizeConversationChannelBindingRow(
          this.channelBindingRepository.create({
            platform: payload.platform,
            externalChatId: payload.externalChatId,
            conversationId,
            metadataJson: serializeJson(payload.bindingMetadata),
            createdAt: timestamp,
            updatedAt: timestamp,
          })
        );

        return {
          binding,
          conversation: this.getConversation(conversationId),
        };
      });

      this.reserveExternalEventTransaction = this.db.transaction((payload: any) =>
        normalizeExternalEventRow(
          this.externalEventRepository.create({
            platform: payload.platform,
            direction: payload.direction,
            externalEventId: payload.externalEventId || null,
            externalMessageId: payload.externalMessageId || null,
            conversationId: payload.conversationId || null,
            messageId: payload.messageId || null,
            metadataJson: serializeJson(payload.metadata),
            createdAt: payload.createdAt,
          })
        )
      );

      this.updateExternalEventTransaction = this.db.transaction((eventRecordId: any, payload: any) => {
        const existing = normalizeExternalEventRow(this.externalEventRepository.get(eventRecordId));

        if (!existing) {
          return null;
        }

        return normalizeExternalEventRow(
          this.externalEventRepository.update(eventRecordId, {
            externalEventId:
              payload.externalEventId === undefined ? existing.externalEventId : payload.externalEventId || null,
            externalMessageId:
              payload.externalMessageId === undefined ? existing.externalMessageId : payload.externalMessageId || null,
            conversationId: payload.conversationId === undefined ? existing.conversationId : payload.conversationId || null,
            messageId: payload.messageId === undefined ? existing.messageId : payload.messageId || null,
            metadataJson: serializeJson(payload.metadata === undefined ? existing.metadata : payload.metadata),
          })
        );
      });

      this.deleteExternalEventTransaction = this.db.transaction((eventRecordId: any) => {
        this.externalEventRepository.delete(eventRecordId);
      });

    } catch (error) {
      try {
        connection.db.close();
      } catch {}
      throw error;
    }
  }

  getAgent(agentId: any) {
    return normalizeAgentRow(this.agentRepository.get(agentId));
  }

  getRoleIdentity(roleId: any) {
    return this.roleIdentityRepository.get(String(roleId || '').trim()) || null;
  }

  listAgents() {
    return this.agentRepository.list().map(normalizeAgentRow);
  }

  saveCustomRoleConfig(input: any = {}) {
    const id = String(input.id || randomUUID()).trim();
    const name = String(input.name || '').trim();
    const personaPrompt = String(input.personaPrompt || '').trim();
    const sandboxName = normalizeSandboxName(input.sandboxName);

    if (!name) {
      throw new Error('Agent name is required');
    }

    this.assertUniqueAgentSandboxName(id, sandboxName);

    return this.saveAgentTransaction({
      id,
      name,
      sandboxName,
      description: String(input.description || '').trim(),
      avatarDataUrl: normalizeAvatarDataUrl(input.avatarDataUrl),
      personaPrompt,
      provider: String(input.provider || '').trim(),
      model: String(input.model || '').trim(),
      thinking: String(input.thinking || '').trim(),
      accentColor: String(input.accentColor || '#3d405b').trim() || '#3d405b',
      skills: this.normalizeSkillRefs(input.skillIds || input.skills),
      modelProfiles: this.normalizeModelProfiles(input.modelProfiles),
      roleKind: 'custom',
      modelFamily: null,
      isDefaultChatRole: Boolean(input.isDefaultChatRole),
    });
  }

  saveSystemRoleConfig(input: any = {}) {
    const id = String(input.id || '').trim();
    const existing = this.getAgent(id);

    if (!existing || existing.roleKind !== 'model_family') {
      const error: any = new Error('System model-family role not found');
      error.code = 'system_role_not_found';
      throw error;
    }

    return this.saveSystemRoleConfigTransaction({
      id,
      provider: String(input.provider || '').trim(),
      model: String(input.model || '').trim(),
      thinking: String(input.thinking || '').trim(),
      modelProfiles: this.normalizeModelProfiles(input.modelProfiles),
      isDefaultChatRole: Boolean(input.isDefaultChatRole),
      ...(Object.hasOwn(input, 'avatarDataUrl') ? { avatarDataUrl: normalizeAvatarDataUrl(input.avatarDataUrl) } : {}),
    });
  }

  retireRoleConfig(roleId: any, retiredReason = 'custom_role_deleted') {
    return this.retireRoleConfigTransaction(String(roleId || '').trim(), retiredReason);
  }

  listConversations() {
    return this.conversationRepository.listHeaders().map(normalizeConversationHeader);
  }

  listConversationTree() {
    const latestDeliveryByTarget = new Map(
      this.crossConversationDeliveryRepository
        .listLatestByTarget()
        .map((row: any) => [row.target_conversation_id, compactCrossConversationDeliveryStatus(row)])
    );
    return this.conversationRepository.listTreeHeaders().map((row: any) => ({
      ...normalizeConversationHeader(row),
      crossConversationStatus: latestDeliveryByTarget.get(row.id) || null,
    }));
  }

  listConversationDirectoryPage(options: any = {}) {
    const limit = Number(options.limit);
    const rows = this.conversationRepository.listDirectoryPage({
      limit,
      query: String(options.query || '').trim(),
      before: options.before || null,
    });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(normalizeConversationHeader);
    const latestDeliveryByTarget = new Map(
      this.crossConversationDeliveryRepository
        .listLatestByTargetIds(items.map((item: any) => item.id))
        .map((row: any) => [row.target_conversation_id, compactCrossConversationDeliveryStatus(row)])
    );
    const normalizedItems = items.map((item: any) => ({
      ...item,
      crossConversationStatus: latestDeliveryByTarget.get(item.id) || null,
    }));
    const oldest = rows[limit - 1] || null;

    return {
      items: normalizedItems,
      nextCursor: hasMore && oldest
        ? { activityAt: oldest.activity_at, id: oldest.id }
        : null,
      hasMore,
    };
  }

  bindConversationProjectScope(conversationId: any, projectScopeId: any) {
    return this.bindConversationProjectScopeTransaction(conversationId, projectScopeId);
  }

  getCrossConversationDelivery(deliveryId: any) {
    return normalizeCrossConversationDeliveryRow(
      this.crossConversationDeliveryRepository.get(String(deliveryId || '').trim())
    );
  }

  getCrossConversationDeliveryByIdempotency(idempotencyScope: any, idempotencyKey: any) {
    return normalizeCrossConversationDeliveryRow(
      this.crossConversationDeliveryRepository.getByIdempotency(
        String(idempotencyScope || '').trim(),
        String(idempotencyKey || '').trim()
      )
    );
  }

  getCrossConversationDeliveryBundleByIdempotency(idempotencyScope: any, idempotencyKey: any) {
    const row = this.crossConversationDeliveryRepository.getByIdempotency(
      String(idempotencyScope || '').trim(),
      String(idempotencyKey || '').trim()
    );

    if (!row) {
      return null;
    }

    return {
      duplicate: true,
      delivery: normalizeCrossConversationDeliveryRow(row),
      targetMessage: normalizeMessageRow(this.messageRepository.get(row.target_message_id)),
      sourceReceipt: normalizeMessageRow(this.messageRepository.get(row.source_receipt_message_id)),
    };
  }

  getCrossConversationResponseDelivery(deliveryId: any) {
    return normalizeCrossConversationDeliveryRow(
      this.crossConversationDeliveryRepository.getByReplyTo(String(deliveryId || '').trim())
    );
  }

  getCrossConversationTraceEdge(traceId: any, sourceConversationId: any, targetConversationId: any) {
    return normalizeCrossConversationDeliveryRow(
      this.crossConversationDeliveryRepository.getTraceEdge(
        String(traceId || '').trim(),
        String(sourceConversationId || '').trim(),
        String(targetConversationId || '').trim()
      )
    );
  }

  listCrossConversationDeliveryEvents(deliveryId: any) {
    return this.crossConversationDeliveryRepository
      .listEvents(String(deliveryId || '').trim())
      .map(normalizeCrossConversationDeliveryEventRow)
      .filter(Boolean);
  }

  persistCrossConversationDelivery(payload: any) {
    return this.persistCrossConversationDeliveryTransaction(payload);
  }

  persistConversationSpawn(payload: any) {
    return this.persistConversationSpawnTransaction(payload);
  }

  claimNextCrossConversationDelivery(payload: any) {
    return normalizeCrossConversationDeliveryRow(
      this.crossConversationDeliveryRepository.claimNext(payload)
    );
  }

  markCrossConversationDispatchStarted(deliveryId: any, payload: any) {
    return normalizeCrossConversationDeliveryRow(
      this.crossConversationDeliveryRepository.markDispatchStarted(String(deliveryId || '').trim(), payload)
    );
  }

  markCrossConversationDispatchCompleted(deliveryId: any, payload: any) {
    return normalizeCrossConversationDeliveryRow(
      this.crossConversationDeliveryRepository.markDispatchCompleted(String(deliveryId || '').trim(), payload)
    );
  }

  releaseCrossConversationDeliveryForRetry(deliveryId: any, payload: any) {
    return normalizeCrossConversationDeliveryRow(
      this.crossConversationDeliveryRepository.releaseForRetry(String(deliveryId || '').trim(), payload)
    );
  }

  failCrossConversationDeliveryBeforeStart(deliveryId: any, payload: any) {
    return normalizeCrossConversationDeliveryRow(
      this.crossConversationDeliveryRepository.markDispatchFailedBeforeStart(
        String(deliveryId || '').trim(),
        payload
      )
    );
  }

  failCrossConversationDeliveryUnknownOutcome(deliveryId: any, payload: any) {
    return normalizeCrossConversationDeliveryRow(
      this.crossConversationDeliveryRepository.markDispatchUnknownOutcome(
        String(deliveryId || '').trim(),
        payload
      )
    );
  }

  retryCrossConversationDeliveryBeforeStart(deliveryId: any, payload: any) {
    return normalizeCrossConversationDeliveryRow(
      this.crossConversationDeliveryRepository.retryFailedBeforeStart(
        String(deliveryId || '').trim(),
        payload
      )
    );
  }

  cancelQueuedCrossConversationDelivery(deliveryId: any, payload: any) {
    return normalizeCrossConversationDeliveryRow(
      this.crossConversationDeliveryRepository.cancelQueued(String(deliveryId || '').trim(), payload)
    );
  }

  requestRunningCrossConversationDeliveryCancel(deliveryId: any, payload: any) {
    return normalizeCrossConversationDeliveryRow(
      this.crossConversationDeliveryRepository.requestRunningCancel(
        String(deliveryId || '').trim(),
        payload
      )
    );
  }

  markRunningCrossConversationDeliveryCancelled(deliveryId: any, payload: any) {
    return normalizeCrossConversationDeliveryRow(
      this.crossConversationDeliveryRepository.markRunningCancelled(
        String(deliveryId || '').trim(),
        payload
      )
    );
  }

  listExpiredCrossConversationDeliveryClaims(now: any) {
    return this.crossConversationDeliveryRepository
      .listExpiredClaims(String(now || '').trim())
      .map(normalizeCrossConversationDeliveryRow)
      .filter(Boolean);
  }

  listExpiredCrossConversationRequestDeadlines(now: any) {
    return this.crossConversationDeliveryRepository
      .listExpiredDeadlines(String(now || '').trim())
      .map(normalizeCrossConversationDeliveryRow)
      .filter(Boolean);
  }

  listCrossConversationRequestsPendingResponse(limit: any = 100) {
    const normalizedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 100;
    return this.crossConversationDeliveryRepository
      .listPendingResponses(normalizedLimit)
      .map(normalizeCrossConversationDeliveryRow)
      .filter(Boolean);
  }

  findCrossConversationReplyMessage(delivery: any) {
    if (!delivery) {
      return null;
    }

    return normalizeMessageRow(
      this.messageRepository.findCompletedCrossConversationReply({
        deliveryId: delivery.id,
        conversationId: delivery.targetConversationId,
        agentId: delivery.targetAgentId,
        startedAt: delivery.startedAt,
      })
    );
  }

  timeoutCrossConversationRequest(deliveryId: any, payload: any) {
    return normalizeCrossConversationDeliveryRow(
      this.crossConversationDeliveryRepository.timeoutRequest(String(deliveryId || '').trim(), payload)
    );
  }

  appendCrossConversationDeliveryEvent(deliveryId: any, payload: any) {
    return normalizeCrossConversationDeliveryEventRow(
      this.crossConversationDeliveryRepository.appendEvent({
        deliveryId: String(deliveryId || '').trim(),
        eventType: payload.eventType,
        attemptNumber: payload.attemptNumber,
        actorKind: payload.actorKind,
        actorId: payload.actorId,
        eventJson: serializeJson(payload.event || {}),
        createdAt: payload.createdAt,
      })
    );
  }

  persistCrossConversationResponse(payload: any) {
    return this.persistCrossConversationResponseTransaction(payload);
  }

  getConversation(conversationId: any) {
    const row = this.conversationRepository.get(conversationId);

    if (!row) {
      return null;
    }

    return normalizeConversation(
      row,
      this.listConversationAgents(conversationId),
      this.listMessages(conversationId)
    );
  }

  getConversationWithoutMessages(conversationId: any) {
    const row = this.conversationRepository.get(conversationId);

    if (!row) {
      return null;
    }

    return normalizeConversation(row, this.listConversationAgents(conversationId), []);
  }

  /**
   * Walk the origin_conversation_id chain to the root conversation that owns
   * the shared plan (PRD D1: one plan per conversation tree, hung on the
   * root). Returns the raw conversation row, or null when the conversation
   * does not exist or the lineage contains a cycle.
   */
  resolvePlanOwnerConversation(conversationId: any) {
    const normalizedId = String(conversationId || '').trim();
    if (!normalizedId) {
      return null;
    }

    const visited = new Set<string>();
    let current = this.conversationRepository.get(normalizedId);
    while (current) {
      if (visited.has(current.id)) {
        return null;
      }
      visited.add(current.id);
      const originId = String(current.origin_conversation_id || '').trim();
      if (!originId) {
        return current;
      }
      current = this.conversationRepository.get(originId);
    }
    return null;
  }

  /** Returns { ownerConversationId, plan } — plan is null when none exists. */
  getPlanForConversation(conversationId: any) {
    const owner = this.resolvePlanOwnerConversation(conversationId);
    if (!owner) {
      throw createPlanError(404, 'conversation_not_found', 'Conversation not found');
    }

    const row = this.planRepository.getByOwnerConversationId(owner.id);
    return {
      ownerConversationId: owner.id,
      plan: normalizePlanRow(row),
    };
  }

  /**
   * Create (first write) or replace the shared plan doc. Draft plans accept
   * structural edits; active plans only accept node status transitions;
   * done/archived plans reject all writes. Version guard: callers must pass
   * the version they read, 409 on mismatch.
   */
  savePlanForConversation(conversationId: any, payload: any = {}, options: any = {}) {
    const owner = this.resolvePlanOwnerConversation(conversationId);
    if (!owner) {
      throw createPlanError(404, 'conversation_not_found', 'Conversation not found');
    }

    const doc = payload.doc;
    const validation = validatePlanDoc(doc);
    if (!validation.ok) {
      throw createPlanError(422, 'plan_validation_failed', 'Plan doc validation failed', {
        issues: validation.issues,
        warnings: validation.warnings,
      });
    }

    const timestamp = nowIso();
    const existing = this.planRepository.getByOwnerConversationId(owner.id);

    if (!existing) {
      const row = this.planRepository.create({
        id: randomUUID(),
        ownerConversationId: owner.id,
        status: 'draft',
        version: 1,
        docJson: JSON.stringify(doc),
        activatedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return {
        ownerConversationId: owner.id,
        plan: normalizePlanRow(row),
        warnings: validation.warnings,
      };
    }

    if (existing.status === 'done' || existing.status === 'archived') {
      throw createPlanError(409, 'plan_locked', `Plan is ${existing.status} and no longer accepts writes`);
    }

    let activeWarnings: any[] = [];
    let docToPersist = doc;
    if (existing.status === 'active') {
      const oldDoc = parseJson(existing.doc_json);
      // history is server-owned: callers that omit the field inherit the
      // stored trail; callers that include it must keep it append-only
      // (enforced by validateStatusOnlyUpdate below).
      const workingDoc = !Array.isArray(doc.history)
        && oldDoc && Array.isArray(oldDoc.history) && oldDoc.history.length > 0
        ? { ...doc, history: oldDoc.history }
        : doc;
      docToPersist = workingDoc;
      const statusOnly = validateStatusOnlyUpdate(oldDoc, workingDoc);
      if (!statusOnly.ok) {
        throw createPlanError(409, 'plan_locked', 'Active plan is structurally locked: only node status may change', {
          issues: statusOnly.issues,
        });
      }
      // Surface soft signals (e.g. done without result summary, D23).
      activeWarnings = statusOnly.warnings;

      const actor = normalizePlanActor(options.actor);
      const transitions = diffNodeStatusTransitions(oldDoc, workingDoc);

      // D16 fail-closed: pending→doing is rejected while any transitive
      // upstream is blocked (evaluated on the incoming doc, so unblocking
      // upstream + starting downstream in one write is allowed).
      const blockedIssues: any[] = [];
      for (const transition of transitions) {
        if (transition.from === 'pending' && transition.to === 'doing') {
          const blockedUpstreams = findBlockedUpstreams(workingDoc, transition.node_id);
          if (blockedUpstreams.length > 0) {
            blockedIssues.push({
              code: 'plan_upstream_blocked',
              nodeId: transition.node_id,
              blockedUpstreams,
              message: `Node ${transition.node_id} cannot start: blocked upstream(s): ${blockedUpstreams.join(', ')}`,
            });
          }
        }
      }
      if (blockedIssues.length > 0) {
        throw createPlanError(409, 'plan_upstream_blocked', 'Blocked upstream node(s); fail-closed (D16)', {
          issues: blockedIssues,
        });
      }

      // D18: server-owned audit trail — auto-append history entries for
      // status transitions the caller did not already record in the
      // appended suffix (pre-recording lets the scheduler attach reasons).
      const oldHistoryLength = Array.isArray(oldDoc && oldDoc.history) ? oldDoc.history.length : 0;
      const appendedSuffix = Array.isArray(workingDoc.history) ? workingDoc.history.slice(oldHistoryLength) : [];
      const reason = typeof options.reason === 'string' && options.reason.trim() ? options.reason.trim() : undefined;
      for (const transition of transitions) {
        const alreadyRecorded = appendedSuffix.some((entry: any) => Boolean(entry)
          && typeof entry === 'object'
          && !Array.isArray(entry)
          && entry.node_id === transition.node_id
          && entry.from === transition.from
          && entry.to === transition.to);
        if (!alreadyRecorded) {
          docToPersist = appendPlanHistory(docToPersist, {
            node_id: transition.node_id,
            from: transition.from,
            to: transition.to,
            actor: planActorLabel(actor),
            reason,
          });
        }
      }
    }

    const expectedVersion = Number(payload.version);
    if (!Number.isInteger(expectedVersion) || expectedVersion !== Number(existing.version)) {
      throw createPlanError(409, 'plan_version_conflict', 'Plan version conflict', {
        issues: [{
          code: 'plan_version_conflict',
          message: `Expected version ${existing.version}, got ${Number.isInteger(expectedVersion) ? expectedVersion : 'none'}`,
        }],
      });
    }

    const row = this.planRepository.updateWithVersionGuard({
      id: existing.id,
      expectedVersion,
      status: existing.status,
      version: expectedVersion + 1,
      docJson: JSON.stringify(docToPersist),
      activatedAt: existing.activated_at,
      updatedAt: timestamp,
    });
    if (!row) {
      throw createPlanError(409, 'plan_version_conflict', 'Plan version conflict');
    }

    return {
      ownerConversationId: owner.id,
      plan: normalizePlanRow(row),
      warnings: validation.warnings.concat(activeWarnings),
    };
  }

  /** Scheduler reconcile (D25): all active plans, oldest updated first. */
  listActivePlans() {
    return this.planRepository.listByStatus('active').map(normalizePlanRow).filter(Boolean);
  }

  /** True while a cross-conversation delivery targeting this conversation is still in flight. */
  hasNonTerminalCrossConversationDelivery(conversationId: any) {
    return this.crossConversationDeliveryRepository.hasNonTerminalForConversation(
      String(conversationId || '').trim()
    );
  }

  /**
   * Internal scheduler channel (D21): apply execution write-backs to an
   * ACTIVE plan — node status transitions, spawned_conversation_id binding
   * and result summaries. Unlike the public savePlanForConversation path,
   * spawned_conversation_id may be bound here; everything else stays
   * structurally locked. D16 fail-closed still guards pending→doing and
   * every status transition is audited to history with actor 'system' (D18).
   *
   * updates: [{ nodeId, status?, spawnedConversationId?, result? }]
   * options: { reason? } — recorded on auto-appended history entries.
   */
  writePlanNodeExecution(conversationId: any, updates: any, options: any = {}) {
    const owner = this.resolvePlanOwnerConversation(conversationId);
    if (!owner) {
      throw createPlanError(404, 'conversation_not_found', 'Conversation not found');
    }
    const existing = this.planRepository.getByOwnerConversationId(owner.id);
    if (!existing) {
      throw createPlanError(404, 'plan_not_found', 'Conversation tree has no plan');
    }
    if (existing.status !== 'active') {
      throw createPlanError(
        409,
        'plan_not_active',
        `Plan is ${existing.status}; execution write-back requires an active plan`
      );
    }

    const updateList = Array.isArray(updates) ? updates : [];
    if (updateList.length === 0) {
      throw createPlanError(400, 'plan_execution_updates_required', 'At least one node execution update is required');
    }

    const oldDoc = parseJson(existing.doc_json) || {};
    const oldNodes = Array.isArray(oldDoc.nodes) ? oldDoc.nodes : [];
    let doc: any = {
      ...oldDoc,
      nodes: oldNodes.map((node: any) => ({ ...node })),
    };
    const reason = typeof options.reason === 'string' && options.reason.trim() ? options.reason.trim() : undefined;
    const transitions: Array<{ node_id: string; from: string; to: string }> = [];

    for (const update of updateList) {
      const nodeId = String(update && update.nodeId || '').trim();
      const node = doc.nodes.find((candidate: any) => candidate && String(candidate.id || '').trim() === nodeId);
      if (!node) {
        throw createPlanError(404, 'plan_node_not_found', `Plan node not found: ${nodeId}`, {
          issues: [{ code: 'plan_node_not_found', nodeId, message: `Plan node not found: ${nodeId}` }],
        });
      }

      if (update.status !== undefined) {
        const to = String(update.status || '').trim();
        if (!NODE_STATUSES.includes(to)) {
          throw createPlanError(422, 'plan_validation_failed', `Invalid node status: ${to}`, {
            issues: [{ code: 'plan_node_status_invalid', nodeId, message: `status must be one of ${NODE_STATUSES.join('/')}` }],
          });
        }
        const from = NODE_STATUSES.includes(node.status) ? node.status : 'pending';
        if (from !== to) {
          transitions.push({ node_id: nodeId, from, to });
          node.status = to;
        }
      }

      if (update.spawnedConversationId !== undefined) {
        node.spawned_conversation_id = update.spawnedConversationId === null
          ? null
          : String(update.spawnedConversationId || '').trim() || null;
      }

      if (update.result !== undefined) {
        node.result = String(update.result || '');
      }
    }

    // D16 fail-closed: scheduler starts are held to the same standard as
    // manual ones — no pending→doing while a transitive upstream is blocked.
    const blockedIssues: any[] = [];
    for (const transition of transitions) {
      if (transition.from === 'pending' && transition.to === 'doing') {
        const blockedUpstreams = findBlockedUpstreams(doc, transition.node_id);
        if (blockedUpstreams.length > 0) {
          blockedIssues.push({
            code: 'plan_upstream_blocked',
            nodeId: transition.node_id,
            blockedUpstreams,
            message: `Node ${transition.node_id} cannot start: blocked upstream(s): ${blockedUpstreams.join(', ')}`,
          });
        }
      }
    }
    if (blockedIssues.length > 0) {
      throw createPlanError(409, 'plan_upstream_blocked', 'Blocked upstream node(s); fail-closed (D16)', {
        issues: blockedIssues,
      });
    }

    // D18: audit every transition with the system actor.
    for (const transition of transitions) {
      doc = appendPlanHistory(doc, {
        node_id: transition.node_id,
        from: transition.from,
        to: transition.to,
        actor: 'system',
        reason,
      });
    }

    const validation = validatePlanDoc(doc);
    if (!validation.ok) {
      throw createPlanError(422, 'plan_validation_failed', 'Plan doc validation failed after execution write-back', {
        issues: validation.issues,
        warnings: validation.warnings,
      });
    }

    const expectedVersion = Number(existing.version);
    const row = this.planRepository.updateWithVersionGuard({
      id: existing.id,
      expectedVersion,
      status: existing.status,
      version: expectedVersion + 1,
      docJson: JSON.stringify(doc),
      activatedAt: existing.activated_at,
      updatedAt: nowIso(),
    });
    if (!row) {
      throw createPlanError(409, 'plan_version_conflict', 'Plan version conflict');
    }

    return {
      ownerConversationId: owner.id,
      plan: normalizePlanRow(row),
    };
  }

  /** draft → active. D15: user / root-conversation participant agent only. */
  activatePlanForConversation(conversationId: any, actor?: any) {
    return this.transitionPlanStatus(conversationId, {
      fromStatus: 'draft',
      toStatus: 'active',
      errorCode: 'plan_not_activatable',
      markActivatedAt: true,
      actor,
    });
  }

  /** active → draft. Doc (including node status history) is preserved. */
  revertPlanForConversation(conversationId: any, actor?: any) {
    return this.transitionPlanStatus(conversationId, {
      fromStatus: 'active',
      toStatus: 'draft',
      errorCode: 'plan_not_revertible',
      markActivatedAt: false,
      actor,
    });
  }

  transitionPlanStatus(conversationId: any, options: any) {
    const owner = this.resolvePlanOwnerConversation(conversationId);
    if (!owner) {
      throw createPlanError(404, 'conversation_not_found', 'Conversation not found');
    }

    // D15: agent actors may only activate/revert when they participate in
    // the ROOT owner conversation and invoke from it; child-conversation
    // agents (and non-participants) are rejected with 403.
    const actor = normalizePlanActor(options.actor);
    if (actor.type === 'agent') {
      const invokingFromRoot = Boolean(actor.conversationId) && actor.conversationId === owner.id;
      const isRootParticipant = invokingFromRoot
        && this.listConversationAgents(owner.id).some((agent: any) => agent && agent.id === actor.agentId);
      if (!isRootParticipant) {
        throw createPlanError(
          403,
          'plan_forbidden',
          'Only the user or a root-conversation participant agent may activate/revert the plan (D15)'
        );
      }
    }

    const existing = this.planRepository.getByOwnerConversationId(owner.id);
    if (!existing) {
      throw createPlanError(404, 'plan_not_found', 'Conversation tree has no plan');
    }
    if (existing.status !== options.fromStatus) {
      throw createPlanError(
        409,
        options.errorCode,
        `Plan is ${existing.status}; expected ${options.fromStatus} for this transition`
      );
    }

    // Activate preflight: the owner conversation must be bound to a project
    // scope. DAG dispatch resolves the repo (worktree + spawn) from it; without
    // a binding every node would fail-closed block with dag_spawn_failed.
    if (options.markActivatedAt && !String(owner.project_scope_id || '').trim()) {
      throw createPlanError(
        409,
        'plan_owner_project_unbound',
        'Bind the conversation to a project before activating the plan; node dispatch requires a project repository'
      );
    }

    const timestamp = nowIso();
    const row = this.planRepository.updateWithVersionGuard({
      id: existing.id,
      expectedVersion: Number(existing.version),
      status: options.toStatus,
      version: Number(existing.version) + 1,
      docJson: existing.doc_json,
      activatedAt: options.markActivatedAt ? timestamp : existing.activated_at,
      updatedAt: timestamp,
    });
    if (!row) {
      throw createPlanError(409, 'plan_version_conflict', 'Plan version conflict');
    }

    return {
      ownerConversationId: owner.id,
      plan: normalizePlanRow(row),
    };
  }

  getConversationChannelBinding(platform: any, externalChatId: any) {
    return normalizeConversationChannelBindingRow(
      this.channelBindingRepository.getByExternalChatId(String(platform || '').trim(), String(externalChatId || '').trim())
    );
  }

  getConversationChannelBindingByConversationId(platform: any, conversationId: any) {
    return normalizeConversationChannelBindingRow(
      this.channelBindingRepository.getByConversationId(String(platform || '').trim(), String(conversationId || '').trim())
    );
  }

  listConversationChannelBindings(platform: any) {
    return this.channelBindingRepository
      .listByPlatform(String(platform || '').trim())
      .map(normalizeConversationChannelBindingRow)
      .filter(Boolean);
  }

  createConversationChannelBinding(input: any = {}) {
    const platform = String(input.platform || '').trim();
    const externalChatId = String(input.externalChatId || '').trim();
    const conversationId = String(input.conversationId || '').trim();

    if (!platform || !externalChatId || !conversationId) {
      throw new Error('platform, externalChatId, and conversationId are required');
    }

    try {
      return this.createConversationChannelBindingTransaction({
        platform,
        externalChatId,
        conversationId,
        metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    } catch (error) {
      if (isSqliteUniqueConstraintError(error)) {
        return null;
      }

      throw error;
    }
  }

  updateConversationChannelBinding(input: any = {}) {
    const platform = String(input.platform || '').trim();
    const externalChatId = String(input.externalChatId || '').trim();
    const conversationId = String(input.conversationId || '').trim();

    if (!platform || !externalChatId || !conversationId) {
      throw new Error('platform, externalChatId, and conversationId are required');
    }

    return this.updateConversationChannelBindingTransaction({
      platform,
      externalChatId,
      conversationId,
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
      updatedAt: nowIso(),
    });
  }

  getOrCreateExternalConversation(input: any = {}) {
    const platform = String(input.platform || '').trim();
    const externalChatId = String(input.externalChatId || '').trim();

    if (!platform || !externalChatId) {
      throw new Error('platform and externalChatId are required');
    }

    return this.getOrCreateExternalConversationTransaction({
      ...input,
      platform,
      externalChatId,
      title: String(input.title || '').trim() || 'External Conversation',
      type: normalizeConversationType(input.type),
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
      bindingMetadata: input.bindingMetadata && typeof input.bindingMetadata === 'object' ? input.bindingMetadata : {},
    });
  }

  reserveExternalEvent(input: any = {}) {
    const platform = String(input.platform || '').trim();
    const direction = String(input.direction || '').trim().toLowerCase();
    const externalEventId = String(input.externalEventId || '').trim();
    const externalMessageId = String(input.externalMessageId || '').trim();
    const conversationId = String(input.conversationId || '').trim();
    const messageId = String(input.messageId || '').trim();

    if (!platform || !direction) {
      throw new Error('platform and direction are required');
    }

    if (!externalEventId && !externalMessageId && !messageId) {
      throw new Error('At least one external or local message identifier is required');
    }

    try {
      return this.reserveExternalEventTransaction({
        platform,
        direction,
        externalEventId,
        externalMessageId,
        conversationId: conversationId || null,
        messageId: messageId || null,
        metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
        createdAt: nowIso(),
      });
    } catch (error) {
      if (isSqliteUniqueConstraintError(error)) {
        return null;
      }

      throw error;
    }
  }

  updateExternalEvent(eventRecordId: any, updates: any = {}) {
    return this.updateExternalEventTransaction(eventRecordId, updates);
  }

  deleteExternalEvent(eventRecordId: any) {
    this.deleteExternalEventTransaction(eventRecordId);
  }

  createConversation(input: any = {}) {
    const id = String(input.id || randomUUID()).trim();
    const title = String(input.title || '').trim() || 'New Conversation';
    const participants = this.normalizeConversationParticipantsInput(input);

    return this.createConversationTransaction({
      id,
      title,
      type: normalizeConversationType(input.type),
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
      participants,
    });
  }

  updateConversation(conversationId: any, updates: any = {}) {
    const existing = this.getConversationWithoutMessages(conversationId);

    if (!existing) {
      return null;
    }

    const currentTitleSource = readConversationTitleSource(existing.metadata);
    let titleSource = currentTitleSource;
    let title = updates.title === undefined ? existing.title : String(updates.title || '').trim() || existing.title;

    if (updates.title !== undefined) {
      // 写标题时同步维护 metadata.titleSource 状态机：
      // 未显式声明来源的标题写入视为 manual（与既有 UI 改名语义一致）；
      // 状态机拒绝的自动写入（例如 manual 终态上的 auto_*）保留原标题与来源。
      const incomingTitleSource = updates.titleSource === undefined
        ? TITLE_SOURCE_MANUAL
        : normalizeConversationTitleSource(updates.titleSource);
      const transition = resolveConversationTitleTransition(currentTitleSource, incomingTitleSource);
      if (transition.applied) {
        titleSource = transition.titleSource;
      } else {
        title = existing.title;
      }
    }

    const type = updates.type === undefined ? existing.type : normalizeConversationType(updates.type);
    const baseMetadata =
      updates.metadata === undefined
        ? existing.metadata && typeof existing.metadata === 'object'
          ? existing.metadata
          : {}
        : updates.metadata && typeof updates.metadata === 'object'
          ? updates.metadata
          : {};
    // metadata.titleSource 由状态机独占维护，调用方在 metadata 中夹带的
    // titleSource 一律以状态机结果为准，避免绕过 manual 终态保护。
    const metadata = { ...baseMetadata, titleSource };
    const participants = this.hasConversationParticipantsInput(updates)
      ? this.normalizeConversationParticipantsInput(updates)
      : undefined;

    return this.updateConversationTransaction(conversationId, {
      title,
      type,
      metadata,
      participants,
    });
  }

  getConversationTitleSource(conversationId: any) {
    const existing = this.getConversationWithoutMessages(conversationId);
    if (!existing) {
      return null;
    }
    return readConversationTitleSource(existing.metadata);
  }

  updateConversationTitleSource(conversationId: any, titleSource: any) {
    const existing = this.getConversationWithoutMessages(conversationId);
    if (!existing) {
      return null;
    }

    const transition = resolveConversationTitleTransition(
      readConversationTitleSource(existing.metadata),
      titleSource
    );
    if (!transition.applied || transition.titleSource === readConversationTitleSource(existing.metadata)) {
      return existing;
    }

    return this.updateConversationTransaction(conversationId, {
      title: existing.title,
      type: existing.type,
      metadata: {
        ...(existing.metadata && typeof existing.metadata === 'object' ? existing.metadata : {}),
        titleSource: transition.titleSource,
      },
    });
  }

  deleteConversation(conversationId: any) {
    return this.deleteConversationTransaction({ conversationId });
  }

  getImageUploadBatchByKey(conversationId: any, clientRequestId: any) {
    return this.imageUploadRepository.getBatchByKey(String(conversationId || ''), String(clientRequestId || ''));
  }

  getImageUploadBatch(batchId: any) {
    return this.imageUploadRepository.getBatchById(String(batchId || ''));
  }

  createImageUploadBatch(payload: any = {}) {
    const conversation = this.conversationRepository.get(payload.conversationId);

    if (!conversation) {
      throw new Error('Conversation not found');
    }

    const timestamp = payload.createdAt || nowIso();
    const leaseExpiresAt = payload.leaseExpiresAt || new Date(Date.now() + UPLOAD_LEASE_TTL_MS).toISOString();
    return this.imageUploadRepository.createBatch({
      batchId: String(payload.batchId || randomUUID()).trim(),
      conversationId: payload.conversationId,
      clientRequestId: String(payload.clientRequestId || '').trim(),
      requestFingerprint: String(payload.requestFingerprint || '').trim(),
      expectedCount: payload.expectedCount,
      leaseToken: String(payload.leaseToken || randomUUID()).trim(),
      leaseExpiresAt,
      createdAt: timestamp,
    });
  }

  takeoverImageUploadLease(batchId: any, newToken: any, newExpiry: any, now: any, requestFingerprint: any, expectedCount: any) {
    return this.imageUploadRepository.takeoverLease(
      String(batchId || ''),
      String(newToken || randomUUID()).trim(),
      newExpiry || null,
      now || nowIso(),
      String(requestFingerprint || ''),
      Number.isInteger(expectedCount) ? expectedCount : -1
    );
  }

  completeImageUploadBatch(batchId: any, leaseToken: any, completedAt: any) {
    return this.imageUploadRepository.completeBatch(
      String(batchId || ''),
      String(leaseToken || ''),
      completedAt || nowIso()
    );
  }

  finalizeImageUploadBatch(payload: any = {}) {
    return this.finalizeImageUploadBatchTransaction({
      batchId: String(payload.batchId || '').trim(),
      leaseToken: String(payload.leaseToken || ''),
      completedAt: payload.completedAt || nowIso(),
      children: Array.isArray(payload.children) ? payload.children : [],
    });
  }

  rejectImageUploadBatch(batchId: any, reason: any, leaseToken: any) {
    return this.imageUploadRepository.rejectBatch(
      String(batchId || ''),
      String(reason || ''),
      String(leaseToken || '')
    );
  }

  insertImageUpload(payload: any = {}) {
    return this.imageUploadRepository.insertChild({
      imageId: String(payload.imageId || randomUUID()).trim(),
      batchId: payload.batchId,
      slot: payload.slot,
      fileName: payload.fileName,
      storedPath: payload.storedPath,
      mimeType: payload.mimeType,
      width: payload.width,
      height: payload.height,
      sizeBytes: payload.sizeBytes,
      createdAt: payload.createdAt || nowIso(),
    });
  }

  listImageUploadsByBatch(batchId: any) {
    return this.imageUploadRepository.listChildrenByBatch(String(batchId || ''));
  }

  listImageUploadsByIds(imageIds: any) {
    return this.imageUploadRepository.listChildrenByIds(imageIds);
  }

  listImageUploadsByConversation(conversationId: any) {
    return this.imageUploadRepository.listByConversation(String(conversationId || ''));
  }

  listImageUploadBatchesByConversation(conversationId: any) {
    return this.imageUploadRepository.listBatchesByConversation(String(conversationId || ''));
  }

  countImageUploadsByBatch(batchId: any) {
    return this.imageUploadRepository.countChildrenByBatch(String(batchId || ''));
  }

  markImageUploadBatchConsumed(batchId: any, consumedAt: any) {
    return this.imageUploadRepository.markBatchConsumed(String(batchId || ''), consumedAt || nowIso());
  }

  listPendingImageUploadBatches() {
    return this.imageUploadRepository.listPendingBatches();
  }

  listUnconsumedCompleteImageUploadBatches(completedBefore: any) {
    return this.imageUploadRepository.listUnconsumedCompleteBatches(completedBefore || nowIso());
  }

  listAllImageUploadBatches() {
    return this.imageUploadRepository.listAllBatches();
  }

  purgeImageUploadBatch(batchId: any) {
    return this.imageUploadRepository.purgeBatch(String(batchId || ''));
  }

  listStagedImageUploadsExpired(now: any) {
    const timestamp = now || nowIso();
    const threshold = new Date(new Date(timestamp).getTime() - STAGED_IMAGE_TTL_MS).toISOString();
    return this.imageUploadRepository.listStagedExpired(threshold);
  }

  deleteImageUpload(imageId: any) {
    return this.imageUploadRepository.deleteChild(String(imageId || ''));
  }

  markImageUploadIntegrityFailure(imageId: any, integrityError: any) {
    return this.imageUploadRepository.markIntegrityFailure(
      String(imageId || ''),
      String(integrityError || ''),
      nowIso()
    );
  }

  attachImageUploads(imageIds: any, conversationId: any, messageId: any) {
    return this.attachImageUploadsTransaction({
      imageIds: (Array.isArray(imageIds) ? imageIds : []).slice(0, 8),
      conversationId,
      messageId,
      attachedAt: nowIso(),
    });
  }

  recycleImageUploadsByMessage(messageId: any) {
    return this.recycleImageUploadsByMessageTransaction({
      messageId,
      ttlExpiresAt: nowIso(),
    });
  }

  purgeConversationImageUploads(conversationId: any) {
    return this.purgeConversationImageUploadsTransaction({ conversationId });
  }

  listConversationAgents(conversationId: any) {
    return this.participantRepository.listByConversationId(conversationId).map(normalizeAgentRow);
  }

  listMessages(conversationId: any) {
    return this.messageRepository.listByConversationId(conversationId).map(normalizeMessageRow);
  }

  listConversationIdsWithPendingUserMessages() {
    return this.messageRepository.listConversationIdsWithPendingUserMessages();
  }

  listMessagePage(conversationId: any, options: any = {}) {
    const page = this.messageRepository.listPageByConversationId(conversationId, options);

    return {
      items: page.items.map(normalizeMessageRow),
      nextBefore: page.nextBefore,
      hasMore: page.hasMore,
    };
  }

  listPrivateMessages(conversationId: any) {
    return this.privateMessageRepository.listByConversationId(conversationId).map(normalizePrivateMessageRow);
  }

  listConversationMemoryCards(conversationId: any, agentId: any, options: any = {}) {
    const normalizedConversationId = String(conversationId || '').trim();
    const normalizedAgentId = String(agentId || '').trim();
    const limit = Number.isInteger(options.limit) && options.limit > 0
      ? Math.min(options.limit, MAX_MEMORY_CARDS_PER_SCOPE)
      : MAX_MEMORY_CARDS_PER_SCOPE;

    if (!normalizedConversationId) {
      throw new Error('Conversation id is required');
    }

    if (!normalizedAgentId) {
      throw new Error('Agent id is required');
    }

    if (!this.conversationRepository.get(normalizedConversationId)) {
      throw new Error('Conversation not found');
    }

    if (!this.agentRepository.get(normalizedAgentId)) {
      throw new Error('Agent not found');
    }

    return this.memoryCardRepository
      .listActiveByConversationAgent(normalizedConversationId, normalizedAgentId, {
        limit,
        now: options.now || nowIso(),
      })
      .map(normalizeMemoryCardRow)
      .filter(Boolean);
  }

  listLocalUserMemoryCards(agentId: any, options: any = {}) {
    const normalizedAgentId = String(agentId || '').trim();
    const limit = Number.isInteger(options.limit) && options.limit > 0
      ? Math.min(options.limit, MAX_MEMORY_CARDS_PER_SCOPE)
      : MAX_MEMORY_CARDS_PER_SCOPE;

    if (!normalizedAgentId) {
      throw new Error('Agent id is required');
    }

    if (!this.agentRepository.get(normalizedAgentId)) {
      throw new Error('Agent not found');
    }

    return this.memoryCardRepository
      .listActiveByLocalUserAgent(normalizedAgentId, {
        ownerKey: options.ownerKey || LOCAL_USER_MEMORY_OWNER_KEY,
        limit,
        now: options.now || nowIso(),
      })
      .map(normalizeMemoryCardRow)
      .filter(Boolean);
  }

  listVisibleMemoryCards(conversationId: any, agentId: any, options: any = {}) {
    const normalizedConversationId = String(conversationId || '').trim();
    const normalizedAgentId = String(agentId || '').trim();
    const limit = Number.isInteger(options.limit) && options.limit > 0
      ? Math.min(options.limit, MAX_MEMORY_CARDS_PER_SCOPE)
      : MAX_MEMORY_CARDS_PER_SCOPE;
    const now = options.now || nowIso();
    const conversationCards = this.listConversationMemoryCards(normalizedConversationId, normalizedAgentId, {
      limit,
      now,
    });
    const localUserCards = this.listLocalUserMemoryCards(normalizedAgentId, {
      ownerKey: options.ownerKey || LOCAL_USER_MEMORY_OWNER_KEY,
      limit,
      now,
    });

    return mergeVisibleMemoryCards(conversationCards, localUserCards, limit);
  }

  saveConversationMemoryCard(conversationId: any, agentId: any, input: any = {}) {
    const normalizedConversationId = String(conversationId || '').trim();
    const normalizedAgentId = String(agentId || '').trim();

    if (!normalizedConversationId) {
      throw new Error('Conversation id is required');
    }

    if (!normalizedAgentId) {
      throw new Error('Agent id is required');
    }

    if (!this.conversationRepository.get(normalizedConversationId)) {
      throw new Error('Conversation not found');
    }

    if (!this.agentRepository.get(normalizedAgentId)) {
      throw new Error('Agent not found');
    }

    const updatedAt = nowIso();
    const title = normalizeMemoryCardText(input.title, MAX_MEMORY_CARD_TITLE_LENGTH, 'title');
    const content = normalizeMemoryCardText(input.content, MAX_MEMORY_CARD_CONTENT_LENGTH, 'content');
    const ttlDays = normalizeMemoryCardTtlDays(input.ttlDays);
    const memoryCard = this.saveMemoryCardTransaction({
      id: String(input.id || randomUUID()).trim(),
      conversationId: normalizedConversationId,
      agentId: normalizedAgentId,
      scope: CONVERSATION_MEMORY_SCOPE,
      ownerKey: normalizedConversationId,
      title,
      content,
      source: String(input.source || 'agent-tool').trim() || 'agent-tool',
      ttlDays,
      expiresAt: addDaysIso(updatedAt, ttlDays),
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
      updatedAt,
    });

    return {
      card: memoryCard,
      cardCount: this.memoryCardRepository.countActiveByConversationAgent(normalizedConversationId, normalizedAgentId, {
        now: updatedAt,
      }),
      budget: {
        maxCards: MAX_MEMORY_CARDS_PER_SCOPE,
      },
    };
  }

  saveLocalUserMemoryCard(agentId: any, input: any = {}) {
    const normalizedAgentId = String(agentId || '').trim();

    if (!normalizedAgentId) {
      throw new Error('Agent id is required');
    }

    if (!this.agentRepository.get(normalizedAgentId)) {
      throw new Error('Agent not found');
    }

    const updatedAt = nowIso();
    const title = normalizeMemoryCardText(input.title, MAX_MEMORY_CARD_TITLE_LENGTH, 'title');
    const content = normalizeMemoryCardText(input.content, MAX_MEMORY_CARD_CONTENT_LENGTH, 'content');
    const ttlDays = normalizeMemoryCardTtlDays(input.ttlDays);
    const ownerKey = String(input.ownerKey || '').trim() || LOCAL_USER_MEMORY_OWNER_KEY;
    const memoryCard = this.saveMemoryCardTransaction({
      id: String(input.id || randomUUID()).trim(),
      conversationId: null,
      agentId: normalizedAgentId,
      scope: LOCAL_USER_MEMORY_SCOPE,
      ownerKey,
      title,
      content,
      source: String(input.source || 'agent-tool').trim() || 'agent-tool',
      ttlDays,
      expiresAt: addDaysIso(updatedAt, ttlDays),
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
      updatedAt,
    });

    return {
      card: memoryCard,
      cardCount: this.memoryCardRepository.countActiveByLocalUserAgent(normalizedAgentId, {
        ownerKey,
        now: updatedAt,
      }),
      budget: {
        maxCards: MAX_MEMORY_CARDS_PER_SCOPE,
      },
    };
  }

  updateLocalUserMemoryCard(agentId: any, input: any = {}) {
    const normalizedAgentId = String(agentId || '').trim();

    if (!normalizedAgentId) {
      throw new Error('Agent id is required');
    }

    if (!this.agentRepository.get(normalizedAgentId)) {
      throw new Error('Agent not found');
    }

    const ownerKey = String(input.ownerKey || '').trim() || LOCAL_USER_MEMORY_OWNER_KEY;
    const updatedAt = nowIso();
    const title = normalizeMemoryCardText(input.title, MAX_MEMORY_CARD_TITLE_LENGTH, 'title');
    const content = normalizeMemoryCardText(input.content, MAX_MEMORY_CARD_CONTENT_LENGTH, 'content');
    const expectedUpdatedAt = String(input.expectedUpdatedAt || '').trim() || null;
    const memoryCard = this.updateLocalUserMemoryCardTransaction({
      agentId: normalizedAgentId,
      ownerKey,
      title,
      content,
      expectedUpdatedAt,
      source: String(input.source || 'agent-tool').trim() || 'agent-tool',
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
      lastMutation: input.lastMutation && typeof input.lastMutation === 'object' ? input.lastMutation : null,
      updatedAt,
    });

    return {
      card: memoryCard,
    };
  }

  forgetLocalUserMemoryCard(agentId: any, input: any = {}) {
    const normalizedAgentId = String(agentId || '').trim();

    if (!normalizedAgentId) {
      throw new Error('Agent id is required');
    }

    if (!this.agentRepository.get(normalizedAgentId)) {
      throw new Error('Agent not found');
    }

    const ownerKey = String(input.ownerKey || '').trim() || LOCAL_USER_MEMORY_OWNER_KEY;
    const updatedAt = nowIso();
    const title = normalizeMemoryCardText(input.title, MAX_MEMORY_CARD_TITLE_LENGTH, 'title');
    const expectedUpdatedAt = String(input.expectedUpdatedAt || '').trim() || null;
    const memoryCard = this.forgetLocalUserMemoryCardTransaction({
      agentId: normalizedAgentId,
      ownerKey,
      title,
      expectedUpdatedAt,
      source: String(input.source || 'agent-tool').trim() || 'agent-tool',
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
      lastMutation: input.lastMutation && typeof input.lastMutation === 'object' ? input.lastMutation : null,
      updatedAt,
    });

    return {
      card: memoryCard,
    };
  }

  listPrivateMessagesForAgent(conversationId: any, agentId: any, options: any = {}) {
    const normalizedAgentId = String(agentId || '').trim();
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 0;
    const visibleMessages = this.listPrivateMessages(conversationId).filter((message: any) => {
      if (!normalizedAgentId) {
        return false;
      }

      const recipients = Array.isArray(message.recipientAgentIds) ? message.recipientAgentIds : [];
      return recipients.includes(normalizedAgentId) || message.senderAgentId === normalizedAgentId;
    });

    return limit > 0 ? visibleMessages.slice(-limit) : visibleMessages;
  }

  getMessage(messageId: any) {
    return normalizeMessageRow(this.messageRepository.get(messageId));
  }

  createMessage(payload: any = {}) {
    const conversation = this.getConversationWithoutMessages(payload.conversationId);

    if (!conversation) {
      throw new Error('Conversation not found');
    }

    const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};

    if (metadata.contentBlocks) {
      const contentBlockError = new Error('Client must not submit contentBlocks; content + imageIds only') as any;
      contentBlockError.statusCode = 400;
      contentBlockError.code = 'TEXT_BLOCK_FROM_CLIENT_REJECTED';
      throw contentBlockError;
    }

    const clientRequestId = String(metadata.clientRequestId || payload.clientRequestId || '').trim();

    const rawImageIds = Array.isArray(payload.imageIds) ? payload.imageIds : [];
    const imageIds = Array.from(new Set(rawImageIds.map((id: any) => String(id || '').trim()).filter(Boolean)));

    if (clientRequestId) {
      const existingByRequest = this.messageRepository.getByClientRequestId(
        payload.conversationId,
        clientRequestId
      );

      if (existingByRequest) {
        const canonical = normalizeMessageRow(existingByRequest);

        if (canonical) {
          const existingBlocks =
            canonical.metadata && Array.isArray(canonical.metadata.contentBlocks)
              ? canonical.metadata.contentBlocks
              : [];
          const existingImageIds = existingBlocks
            .filter((block: any) => block && block.type === 'image')
            .map((block: any) => String(block.imageId || '').trim())
            .filter(Boolean);
          const normalizedContent = String(payload.content || '');
          const sameContent = String(canonical.content || '') === normalizedContent;
          const sameImages =
            existingImageIds.length === imageIds.length &&
            existingImageIds.every((id: string, index: number) => id === imageIds[index]);

          if (sameContent && sameImages) {
            return canonical;
          }

          const conflictError = new Error(
            'Same client_request_id used with a different message payload; retry must reuse the exact content and imageIds'
          ) as any;
          conflictError.statusCode = 409;
          conflictError.code = 'MESSAGE_IDEMPOTENCY_CONFLICT';
          throw conflictError;
        }
      }
    }

    if (imageIds.length > MAX_IMAGES_PER_MESSAGE) {
      const imageLimitError = new Error(`At most ${MAX_IMAGES_PER_MESSAGE} images per message`) as any;
      imageLimitError.statusCode = 400;
      imageLimitError.code = 'IMAGE_COUNT_EXCEEDED';
      throw imageLimitError;
    }

    let imageRows: any[] = [];
    let consumedBatchIdsForMessage: Array<string> = [];
    let nextMetadata = metadata;

    if (imageIds.length > 0) {
      const batchOwnership = this.imageUploadRepository.listChildrenByIds(imageIds);
      const ownedByConversation = batchOwnership.filter(
        (row: any) => {
          const batch = this.imageUploadRepository.getBatchById(row.batchId);
          return batch && batch.conversationId === payload.conversationId;
        }
      );

      if (ownedByConversation.length !== imageIds.length) {
        const notFoundError = new Error('One or more images do not exist or do not belong to this conversation') as any;
        notFoundError.statusCode = 400;
        notFoundError.code = 'IMAGE_NOT_FOUND';
        throw notFoundError;
      }

      const notStaged = ownedByConversation.some((row: any) => row.status !== 'staged');

      if (notStaged) {
        const alreadyAttachedError = new Error('One or more images are already attached') as any;
        alreadyAttachedError.statusCode = 400;
        alreadyAttachedError.code = 'IMAGE_ALREADY_ATTACHED';
        throw alreadyAttachedError;
      }

      const consumedBatchIds: Array<string> = [];
      const byBatch = new Map<string, Array<any>>();

      for (const row of ownedByConversation) {
        const batchId = row.batchId;
        const group = byBatch.get(batchId) || [];
        group.push(row);
        byBatch.set(batchId, group);
      }

      for (const [batchId, referencedChildren] of byBatch) {
        const batch = this.imageUploadRepository.getBatchById(batchId);

        if (!batch) {
          const missingBatchError = new Error('Image batch does not exist') as any;
          missingBatchError.statusCode = 400;
          missingBatchError.code = 'IMAGE_NOT_FOUND';
          throw missingBatchError;
        }

        const stagedChildren = this.imageUploadRepository.listChildrenByBatch(batchId);

        if (stagedChildren.length !== referencedChildren.length) {
          const partialBatchError = new Error(
            'Message must reference all staged images of an upload batch; partial batch attach is rejected'
          ) as any;
          partialBatchError.statusCode = 400;
          partialBatchError.code = 'IMAGE_PARTIAL_BATCH_ATTACH_REJECTED';
          throw partialBatchError;
        }

        consumedBatchIds.push(batchId);
      }

      imageRows = ownedByConversation;
      consumedBatchIdsForMessage = consumedBatchIds;
      nextMetadata = {
        ...metadata,
        contentBlocks: deriveMessageContentBlocks(payload.content, imageRows),
      };
    }

    const senderName =
      String(payload.senderName || '').trim() ||
      (payload.role === 'user' ? 'You' : payload.role === 'assistant' ? 'Assistant' : 'System');

    // 首条用户消息自动标题（auto_first_message）：
    // 仅当会话 titleSource 仍为 default 且此前没有任何 user 消息时触发；
    // 空消息 / 纯空白消息不触发（derive 返回 null）。状态机裁决在
    // updateConversation 内完成（manual 终态等并发改写不会被覆盖）。
    const messageRole = String(payload.role || 'assistant').trim();
    let autoTitleFromFirstMessage: string | null = null;
    if (messageRole === 'user' && readConversationTitleSource(conversation.metadata) === 'default') {
      const priorUserMessageCount = this.messageRepository.countByRole(payload.conversationId, 'user');
      if (priorUserMessageCount === 0) {
        autoTitleFromFirstMessage = deriveTitleFromFirstMessage(payload.content);
      }
    }

    const createdMessage = this.createMessageTransaction({
      id: String(payload.id || randomUUID()).trim(),
      conversationId: payload.conversationId,
      turnId: String(payload.turnId || randomUUID()).trim(),
      role: String(payload.role || 'assistant').trim(),
      agentId: payload.agentId || null,
      senderName,
      content: String(payload.content || ''),
      status: String(payload.status || 'completed').trim() || 'completed',
      taskId: payload.taskId || null,
      runId: payload.runId || null,
      errorMessage: String(payload.errorMessage || '').trim(),
      metadata: nextMetadata,
      imageIds,
      consumedBatchIds: consumedBatchIdsForMessage,
      clientRequestId,
      createdAt: payload.createdAt,
    });

    if (autoTitleFromFirstMessage) {
      this.updateConversation(payload.conversationId, {
        title: autoTitleFromFirstMessage,
        titleSource: 'auto_first_message',
      });
    }

    return createdMessage;
  }

  createPrivateMessage(payload: any = {}) {
    const conversation = this.getConversationWithoutMessages(payload.conversationId);

    if (!conversation) {
      throw new Error('Conversation not found');
    }

    const senderName = String(payload.senderName || '').trim() || 'System';
    const recipientAgentIds = normalizeRecipientAgentIds(payload.recipientAgentIds);

    if (recipientAgentIds.length === 0) {
      throw new Error('At least one private message recipient is required');
    }

    return this.createPrivateMessageTransaction({
      id: String(payload.id || randomUUID()).trim(),
      conversationId: payload.conversationId,
      turnId: String(payload.turnId || randomUUID()).trim(),
      senderAgentId: payload.senderAgentId || null,
      senderName,
      recipientAgentIds,
      content: String(payload.content || ''),
      metadata: payload.metadata,
      createdAt: payload.createdAt,
    });
  }

  updateMessage(messageId: any, updates: any = {}) {
    const existing = this.getMessage(messageId);

    if (!existing) {
      return null;
    }

    const nextContent =
      updates.content === undefined ? existing.content : String(updates.content || '');
    const nextStatus =
      updates.status === undefined ? existing.status : String(updates.status || '').trim() || existing.status;
    const nextTaskId = updates.taskId === undefined ? existing.taskId : updates.taskId || null;
    const nextRunId = updates.runId === undefined ? existing.runId : updates.runId || null;
    const nextErrorMessage =
      updates.errorMessage === undefined ? existing.errorMessage : String(updates.errorMessage || '').trim();
    const nextMetadata = updates.metadata === undefined ? existing.metadata : updates.metadata;

    return normalizeMessageRow(
      this.messageRepository.update(messageId, {
        content: nextContent,
        status: nextStatus,
        taskId: nextTaskId,
        runId: nextRunId,
        errorMessage: nextErrorMessage || null,
        metadataJson: serializeJson(nextMetadata),
      })
    );
  }

  appendMessageText(messageId: any, delta: any) {
    const text = String(delta || '');

    if (!text) {
      return this.getMessage(messageId);
    }

    return normalizeMessageRow(this.messageRepository.appendText(messageId, text));
  }

  searchConversationMessages(conversationId: any, options: any = {}) {
    const normalizedConversationId = String(conversationId || '').trim();
    const query = String(options.query || '').trim().replace(/\s+/g, ' ');
    const limit = Number.isInteger(options.limit) && options.limit > 0
      ? Math.min(options.limit, 5)
      : 5;

    if (!normalizedConversationId) {
      throw new Error('Conversation id is required');
    }

    if (!this.conversationRepository.get(normalizedConversationId)) {
      throw new Error('Conversation not found');
    }

    const speaker = String(options.speaker || options.senderName || options.sender || '').trim().replace(/\s+/g, ' ');
    const agentId = String(options.agentId || options.agentID || '').trim().replace(/\s+/g, ' ');
    const result = this.messageRepository.searchByConversationId(normalizedConversationId, {
      query,
      limit,
      speaker,
      agentId,
    });

    return {
      query,
      scope: 'conversation-public',
      filters: result && result.filters && typeof result.filters === 'object' ? result.filters : {},
      searchMode: result && result.searchMode ? result.searchMode : 'unavailable',
      resultCount: Array.isArray(result && result.rows) ? result.rows.length : 0,
      results: (Array.isArray(result && result.rows) ? result.rows : [])
        .map(normalizeMessageSearchResultRow)
        .filter(Boolean),
      diagnostics: Array.isArray(result && result.diagnostics) ? result.diagnostics : [],
    };
  }

  saveSummarySegmentFromDigest(conversationId: any, digest: any, options: any = {}) {
    const normalizedConversationId = String(conversationId || '').trim();
    const conversation = this.getConversation(normalizedConversationId);

    if (!conversation) {
      throw new Error('Conversation not found');
    }

    const sourceDigestId = String(digest && digest.id || '').trim();
    const summary = clipSearchSnippet(digest && digest.summary, MAX_SUMMARY_SEGMENT_TEXT_LENGTH);

    if (!sourceDigestId) {
      throw new Error('sourceDigestId is required');
    }

    if (!summary) {
      throw new Error('summary is required');
    }

    const timestamp = String(options.updatedAt || '').trim() || nowIso();
    const facts = normalizeSummarySegmentItems(digest && digest.facts);
    const decisions = normalizeSummarySegmentItems(digest && digest.decisions);
    const openQuestions = normalizeSummarySegmentItems(digest && digest.openQuestions);
    const nextActions = normalizeSummarySegmentItems(digest && digest.nextActions);
    const artifacts = normalizeSummarySegmentItems(digest && digest.artifacts);
    const metadata = options.metadata && typeof options.metadata === 'object' ? options.metadata : {};
    const messageRange = digest && digest.messageRange && typeof digest.messageRange === 'object' ? digest.messageRange : {};
    const segment = this.summarySegmentRepository.upsert({
      id: String(options.id || `segment-${sourceDigestId}`).trim(),
      conversationId: normalizedConversationId,
      sourceDigestId,
      sourceKind: String(digest && digest.kind || 'entry').trim() || 'entry',
      conversationTitle: clipSearchSnippet(conversation.title, MAX_SUMMARY_SEGMENT_ITEM_LENGTH),
      taskName: clipSearchSnippet(options.taskName, MAX_SUMMARY_SEGMENT_ITEM_LENGTH),
      summary,
      factsJson: serializeJson(facts),
      decisionsJson: serializeJson(decisions),
      openQuestionsJson: serializeJson(openQuestions),
      nextActionsJson: serializeJson(nextActions),
      artifactsJson: serializeJson(artifacts),
      triggerReason: String(digest && digest.triggerReason || '').trim(),
      messageCount: Number.parseInt(String(messageRange.messageCount || '0'), 10) || 0,
      fromMessageId: String(messageRange.fromMessageId || '').trim(),
      toMessageId: String(messageRange.toMessageId || '').trim(),
      createdBy: String(digest && digest.createdBy || '').trim(),
      segmentCreatedAt: String(digest && digest.createdAt || '').trim() || timestamp,
      segmentUpdatedAt: String(digest && digest.updatedAt || '').trim() || timestamp,
      metadataJson: serializeJson(metadata),
      searchText: buildSummarySegmentSearchText([
        conversation.title,
        options.taskName,
        digest && digest.kind,
        digest && digest.triggerReason,
        digest && digest.createdBy,
        summary,
        facts,
        decisions,
        openQuestions,
        nextActions,
        artifacts,
      ]),
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    return normalizeSummarySegmentRow(segment);
  }

  deleteSummarySegmentBySourceDigestId(sourceDigestId: any) {
    const normalizedSourceDigestId = String(sourceDigestId || '').trim();

    if (!normalizedSourceDigestId) {
      return;
    }

    this.summarySegmentRepository.deleteBySourceDigestId(normalizedSourceDigestId);
  }

  deleteSummarySegmentsByConversationId(conversationId: any) {
    const normalizedConversationId = String(conversationId || '').trim();

    if (!normalizedConversationId) {
      return;
    }

    this.summarySegmentRepository.deleteByConversationId(normalizedConversationId);
  }

  getSummaryMemoryHealth(options: any = {}) {
    const normalizedConversationId = String(options.conversationId || options.id || '').trim();
    const diagnostics = [] as any[];
    let ledger = {
      tableExists: false,
      segmentCount: 0,
      latestSegmentUpdatedAt: '',
      latestSegment: null,
    } as any;
    let searchAvailable = false;
    let searchMode = 'unavailable';
    let searchError = '';

    try {
      if (!this.summarySegmentRepository || typeof this.summarySegmentRepository.getHealthSnapshot !== 'function') {
        throw new Error('Summary segment repository is not available');
      }

      ledger = this.summarySegmentRepository.getHealthSnapshot();
      const selfTest = this.searchSummarySegments({ query: '', limit: 1 });
      searchAvailable = true;
      searchMode = selfTest && selfTest.searchMode ? selfTest.searchMode : 'like_latest';
    } catch (error) {
      const errorValue = error as any;
      searchError = errorValue && errorValue.message ? errorValue.message : String(errorValue || 'Unknown memory health error');
      diagnostics.push({ code: 'summary_memory_unavailable', message: searchError });
    }

    const conversations = [] as any[];

    if (normalizedConversationId) {
      const conversation = this.getConversation(normalizedConversationId);

      if (conversation) {
        conversations.push(conversation);
      } else {
        diagnostics.push({ code: 'conversation_not_found', message: 'Conversation not found' });
      }
    } else if (typeof this.listConversations === 'function') {
      for (const header of this.listConversations()) {
        const conversationId = String(header && header.id || '').trim();
        const conversation = conversationId ? this.getConversation(conversationId) : null;

        if (conversation) {
          conversations.push(conversation);
        }
      }
    }

    let digestConversationCount = 0;
    let digestCount = 0;
    let unsyncedDigestCount = 0;
    const unsyncedDigests = [] as any[];

    for (const conversation of conversations) {
      const digests = normalizeConversationDigestList(conversation);

      if (digests.length > 0) {
        digestConversationCount += 1;
      }

      for (const digest of digests) {
        digestCount += 1;
        const sourceDigestId = String(digest && digest.id || '').trim();

        try {
          const existing = sourceDigestId && this.summarySegmentRepository && typeof this.summarySegmentRepository.getBySourceDigestId === 'function'
            ? this.summarySegmentRepository.getBySourceDigestId(sourceDigestId)
            : null;

          if (!existing) {
            unsyncedDigestCount += 1;

            if (unsyncedDigests.length < MAX_SUMMARY_MEMORY_HEALTH_DETAILS) {
              unsyncedDigests.push({
                conversationId: String(conversation && conversation.id || '').trim(),
                conversationTitle: String(conversation && conversation.title || '').trim(),
                digestId: sourceDigestId,
                kind: String(digest && digest.kind || 'entry').trim() || 'entry',
                reason: 'missing_segment',
              });
            }
          }
        } catch (error) {
          const errorValue = error as any;
          unsyncedDigestCount += 1;

          if (unsyncedDigests.length < MAX_SUMMARY_MEMORY_HEALTH_DETAILS) {
            unsyncedDigests.push({
              conversationId: String(conversation && conversation.id || '').trim(),
              conversationTitle: String(conversation && conversation.title || '').trim(),
              digestId: sourceDigestId,
              kind: String(digest && digest.kind || 'entry').trim() || 'entry',
              reason: 'lookup_failed',
              message: errorValue && errorValue.message ? errorValue.message : String(errorValue || 'Unknown summary segment lookup error'),
            });
          }
        }
      }
    }

    const status = !ledger.tableExists || !searchAvailable
      ? 'unavailable'
      : unsyncedDigestCount > 0
        ? 'needs_backfill'
        : 'ok';

    return {
      ok: status !== 'unavailable',
      status,
      table: {
        name: 'chat_summary_segments',
        exists: Boolean(ledger.tableExists),
      },
      segments: {
        count: Number(ledger.segmentCount || 0),
        latestUpdatedAt: ledger.latestSegmentUpdatedAt || '',
        latest: normalizeSummarySegmentRow(ledger.latestSegment),
      },
      search: {
        available: searchAvailable,
        mode: searchMode,
        error: searchError,
      },
      backfill: {
        available: Boolean(this.summarySegmentRepository && typeof this.summarySegmentRepository.getBySourceDigestId === 'function' && typeof this.saveSummarySegmentFromDigest === 'function'),
        conversationCount: digestConversationCount,
        digestCount,
        unsyncedDigestCount,
        unsyncedDigests,
      },
      diagnostics,
    };
  }

  searchSummarySegments(options: any = {}) {
    const query = String(options.query || '').trim().replace(/\s+/g, ' ');
    const requestedLimit = Number.parseInt(String(options.limit || ''), 10);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_SUMMARY_SEGMENT_SEARCH_LIMIT)
      : 5;
    const taskName = String(options.taskName || options.task || '').trim().replace(/\s+/g, ' ');
    const sourceKind = String(options.sourceKind || options.kind || '').trim();
    const conversationTitle = String(options.conversationTitle || options.title || options.conversation || '').trim().replace(/\s+/g, ' ');
    const updatedAfter = String(options.updatedAfter || options.since || options.from || options.fromDate || '').trim();
    const updatedBefore = String(options.updatedBefore || options.until || options.to || options.toDate || '').trim();
    const excludeConversationId = String(options.excludeConversationId || '').trim();
    const result = this.summarySegmentRepository.search({
      query,
      limit,
      excludeConversationId,
      taskName,
      sourceKind,
      conversationTitle,
      updatedAfter,
      updatedBefore,
    });

    return {
      query,
      scope: 'summary-segments',
      filters: {
        ...(excludeConversationId ? { excludeConversationId } : {}),
        ...(taskName ? { taskName } : {}),
        ...(sourceKind ? { sourceKind } : {}),
        ...(conversationTitle ? { conversationTitle } : {}),
        ...(updatedAfter ? { updatedAfter } : {}),
        ...(updatedBefore ? { updatedBefore } : {}),
      },
      searchMode: result && result.searchMode ? result.searchMode : 'unavailable',
      resultCount: Array.isArray(result && result.rows) ? result.rows.length : 0,
      results: (Array.isArray(result && result.rows) ? result.rows : [])
        .map(normalizeSummarySegmentRow)
        .filter(Boolean)
        .map((segment: any) => ({
          ...segment,
          matchedTerms: resolveSummarySegmentMatchedTerms(segment, result && result.terms),
        })),
      diagnostics: Array.isArray(result && result.diagnostics) ? result.diagnostics : [],
    };
  }

  ensureStarterConversation() {
    if (typeof this.listConversationDirectoryPage === 'function') {
      const page = this.listConversationDirectoryPage({ limit: 1, query: '' });
      return page.items[0] || null;
    }

    const conversations = this.listConversations();
    return conversations[0] || null;
  }

  normalizeSkillRefs(skills: any) {
    const seenIds = new Set();
    const normalized = [];

    for (const skill of Array.isArray(skills) ? skills : []) {
      const nextSkillId = normalizeSkillRef(skill);

      if (!nextSkillId || seenIds.has(nextSkillId)) {
        continue;
      }

      seenIds.add(nextSkillId);
      normalized.push(nextSkillId);
    }

    return normalized;
  }

  assertUniqueAgentSandboxName(agentId: any, sandboxName: any) {
    const candidateSandboxName = resolveEffectiveSandboxName(sandboxName, agentId);

    for (const agent of this.listAgents()) {
      if (!agent || agent.id === agentId) {
        continue;
      }

      if (resolveEffectiveSandboxName(agent.sandboxName, agent.id) === candidateSandboxName) {
        throw new Error(`Agent sandbox name "${candidateSandboxName}" is already used by ${agent.name || agent.id}`);
      }
    }
  }

  normalizeModelProfiles(modelProfiles: any) {
    const seenIds = new Set();
    const normalized = [];

    for (const [index, profile] of Array.isArray(modelProfiles) ? modelProfiles.entries() : []) {
      const nextProfile = normalizeModelProfile(profile, index);

      if (!nextProfile || seenIds.has(nextProfile.id)) {
        continue;
      }

      seenIds.add(nextProfile.id);
      normalized.push(nextProfile);
    }

    return normalized;
  }

  hasConversationParticipantsInput(input: any = {}) {
    return Array.isArray(input.participants) || Array.isArray(input.agentIds);
  }

  normalizeConversationParticipantsInput(input: any = {}) {
    if (Array.isArray(input.participants)) {
      return this.normalizeConversationParticipants(input.participants);
    }

    const agentProfileIds =
      input.agentProfileIds && typeof input.agentProfileIds === 'object' ? input.agentProfileIds : {};
    if (!Array.isArray(input.agentIds)) {
      throw createParticipantRosterError(
        400,
        'participants_required',
        'At least one explicit conversation participant is required',
        'participants'
      );
    }

    const legacyParticipants = input.agentIds
      ? input.agentIds.map((agentId: any) => ({
          agentId,
          modelProfileId: agentProfileIds[agentId] || null,
          conversationSkillIds: [] as any[],
        }))
      : [];

    return this.normalizeConversationParticipants(legacyParticipants);
  }

  normalizeConversationParticipants(participants: any) {
    if (!Array.isArray(participants) || participants.length === 0) {
      throw createParticipantRosterError(
        400,
        'participants_required',
        'At least one explicit conversation participant is required',
        'participants'
      );
    }
    const knownAgents = new Map(this.listAgents().map((agent: any) => [agent.id, agent]));
    const deduped = [];
    const seenAgentIds = new Set();

    for (const [index, participant] of participants.entries()) {
      const agentId =
        typeof participant === 'string'
          ? String(participant || '').trim()
          : String((participant && (participant.agentId || participant.id)) || '').trim();

      if (!agentId) {
        throw createParticipantRosterError(
          422,
          'participant_role_required',
          'Conversation participant role ID is required',
          `participants[${index}].agentId`
        );
      }
      if (seenAgentIds.has(agentId)) {
        throw createParticipantRosterError(
          422,
          'participant_duplicate',
          'Conversation participant roles must be unique',
          `participants[${index}].agentId`,
          { roleId: agentId }
        );
      }
      if (!knownAgents.has(agentId)) {
        throw createParticipantRosterError(
          422,
          'participant_role_unknown',
          'Conversation participant role does not exist',
          `participants[${index}].agentId`,
          { roleId: agentId }
        );
      }

      const agent: any = knownAgents.get(agentId);
      const requestedProfileId =
        typeof participant === 'string'
          ? ''
          : String(
              (participant && (participant.modelProfileId || participant.selectedModelProfileId || '')) || ''
            ).trim();
      const selectedProfile = requestedProfileId
        ? findModelProfile(agent.modelProfiles, requestedProfileId)
        : null;
      if (requestedProfileId && !selectedProfile) {
        throw createParticipantRosterError(
          422,
          'participant_profile_invalid',
          'Selected model profile does not exist for this role',
          `participants[${index}].modelProfileId`,
          { roleId: agentId, profileId: requestedProfileId }
        );
      }
      const modelProfileId = selectedProfile ? requestedProfileId : null;
      const conversationSkillIds =
        typeof participant === 'string'
          ? []
          : this.normalizeSkillRefs(
              (participant &&
                (participant.conversationSkillIds || participant.conversationSkills || participant.sessionSkillIds || participant.sessionSkills || [])) ||
                []
            );

      seenAgentIds.add(agentId);
      deduped.push({
        agentId,
        modelProfileId,
        conversationSkills: conversationSkillIds,
      });
    }

    if (deduped.length === 0) {
      throw createParticipantRosterError(
        400,
        'participants_required',
        'At least one explicit conversation participant is required',
        'participants'
      );
    }

    return deduped;
  }

  findSkillReferences(skillId: any) {
    const targetSkillId = String(skillId || '').trim();

    if (!targetSkillId) {
      return [];
    }

    const references = [];

    for (const agent of this.listAgents()) {
      if (Array.isArray(agent.skillIds) && agent.skillIds.includes(targetSkillId)) {
        references.push({
          type: 'agent',
          id: agent.id,
          name: agent.name,
        });
      }
    }

    for (const conversation of this.listConversations()) {
      const fullConversation = this.getConversation(conversation.id);

      if (!fullConversation) {
        continue;
      }

      for (const agent of Array.isArray(fullConversation.agents) ? fullConversation.agents : []) {
        if (Array.isArray(agent.conversationSkillIds) && agent.conversationSkillIds.includes(targetSkillId)) {
          references.push({
            type: 'conversation',
            id: fullConversation.id,
            name: fullConversation.title,
            agentId: agent.id,
            agentName: agent.name,
          });
        }
      }
    }

    return references;
  }

  close() {
    this.db.close();
  }
}

export function createChatAppStore(options: any) {
  return new ChatAppStore(options);
}
