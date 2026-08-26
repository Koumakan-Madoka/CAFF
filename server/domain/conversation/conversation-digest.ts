import * as fs from 'node:fs';
import * as path from 'node:path';

import { createHttpError } from '../../http/http-errors';
import { DEFAULT_AGENT_DIR, DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_THINKING, resolveIntegerSetting, resolveSetting, resolveThinkingSetting, startRun } from '../../../lib/minimal-pi';
import { absorbExperienceDraftsInMetadata, experienceDraftsForDigest, getPendingConversationExperienceDrafts } from './experience-draft';

const {
  TITLE_SOURCE_AUTO_FIRST_MESSAGE,
  TITLE_SOURCE_AUTO_LLM,
  TITLE_SOURCE_DEFAULT,
  readConversationTitleSource,
} = require('../../../lib/conversation-title-source');

const CONVERSATION_DIGEST_METADATA_KEY = 'conversationDigests';
const CONVERSATION_DIGEST_STATE_METADATA_KEY = 'conversationDigestState';
const CONVERSATION_DIGEST_ACTIONS = new Set(['get', 'create', 'delete', 'clear', 'compact']);
const MAX_RECENT_DIGEST_ENTRIES = 3;
const MAX_DIGEST_METADATA_ITEMS = 12;
const MAX_PROMPT_DIGEST_ENTRIES = 3;
const MAX_DIGEST_SECTION_ITEMS = 8;
const MAX_DIGEST_EXPERIENCE_ITEMS = 5;
const MAX_DIGEST_EXPERIENCE_STEPS = 5;
const MAX_DIGEST_ITEM_LENGTH = 240;
const MAX_DIGEST_SUMMARY_LENGTH = 800;
const MAX_DIGEST_SOURCE_IDS = 24;
const MAX_DIGEST_MODEL_MESSAGES = 80;
const MAX_DIGEST_MODEL_MESSAGE_LENGTH = 1000;
const MAX_DIGEST_MODEL_TRACE_TEXT_LENGTH = 1200;
const MAX_DIGEST_MODEL_INVALID_OUTPUT_PREVIEW_LENGTH = 4000;
const MAX_DIGEST_MODEL_REPAIR_OUTPUT_LENGTH = 4000;
const DIGEST_MODEL_PROGRESS_MIN_INTERVAL_MS = 500;
const DEFAULT_DIGEST_MODEL_TIMEOUT_MS = 90 * 1000;
const DEFAULT_DIGEST_JSON_MODE_MAX_TOKENS = 4096;
const DEFAULT_DIGEST_AUTO_CREATE_MESSAGE_BUDGET = 24;
const DEFAULT_DIGEST_AUTO_IDLE_MS = 0;
const DEFAULT_DIGEST_AUTO_COOLDOWN_MS = 0;
const DEFAULT_DIGEST_AUTO_HIGH_VALUE = false;
const DEFAULT_DIGEST_AUTO_HIGH_VALUE_MIN_MESSAGES = 12;
const MAX_BACKFILL_DIAGNOSTIC_ITEMS = 10;
const TITLE_REFINED_AT_METADATA_KEY = 'titleRefinedAt';
const MAX_TITLE_REFINE_SOURCE_MESSAGES = 12;
const MAX_TITLE_REFINE_MESSAGE_LENGTH = 300;
const MAX_REFINED_TITLE_LENGTH = 15;
const DEFAULT_TITLE_REFINE_TIMEOUT_MS = 30 * 1000;
const DIGEST_SECTION_KEYS = ['facts', 'decisions', 'openQuestions', 'nextActions', 'artifacts'];
const DIGEST_MODEL_REQUIRED_KEYS = ['summary', ...DIGEST_SECTION_KEYS];

function nowIso() {
  return new Date().toISOString();
}

function isPlainObject(value: any) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeText(value: any) {
  return String(value || '').trim();
}

function normalizeBooleanSetting(value: any, defaultValue = false) {
  if (typeof value === 'boolean') {
    return value;
  }

  const text = String(value ?? '').trim().toLowerCase();

  if (!text) {
    return defaultValue;
  }

  if (['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(text)) {
    return true;
  }

  if (['0', 'false', 'no', 'off', 'disable', 'disabled'].includes(text)) {
    return false;
  }

  return defaultValue;
}

function normalizeTimestampMs(value: any) {
  const text = normalizeText(value);

  if (!text) {
    return 0;
  }

  const timestampMs = Date.parse(text);
  return Number.isFinite(timestampMs) ? timestampMs : 0;
}

function clipText(value: any, maxLength: number) {
  const text = normalizeText(value).replace(/\s+/gu, ' ');

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function stringifyDigestModelOutput(value: any) {
  if (typeof value === 'string') {
    return value;
  }

  if (value === null || value === undefined) {
    return '';
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function clipRawText(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(1, maxLength - 1))}…`;
}

function shouldLogRawDigestModelOutput(options: any = {}) {
  return normalizeBooleanSetting(
    options.logRawModelOutput,
    normalizeBooleanSetting(process.env.CAFF_DIGEST_LOG_RAW_OUTPUT, false)
  );
}

function warnInvalidModelDigestOutput(output: any, config: any, options: any = {}) {
  const outputText = stringifyDigestModelOutput(output);
  const rawOutputEnabled = shouldLogRawDigestModelOutput(options);
  const renderedOutput = rawOutputEnabled
    ? outputText
    : clipRawText(outputText, MAX_DIGEST_MODEL_INVALID_OUTPUT_PREVIEW_LENGTH);
  const outputLabel = rawOutputEnabled
    ? 'raw output'
    : `output preview first ${MAX_DIGEST_MODEL_INVALID_OUTPUT_PREVIEW_LENGTH} chars; set CAFF_DIGEST_LOG_RAW_OUTPUT=true for full raw output`;
  const purpose = normalizeText(options.purpose) || 'summary';
  const modelLabel = `${normalizeText(config && config.provider) || 'unknown'}/${normalizeText(config && config.model) || 'unknown'}`;
  const diagnostic = clipText(options.diagnostic, 800);
  const diagnosticText = diagnostic ? `\nDiagnostic: ${diagnostic}` : '';

  console.warn(`[conversation-digest] Invalid model digest JSON (${purpose}, ${modelLabel}); ${outputLabel}:\n${renderedOutput || '[empty]'}${diagnosticText}`);
}

function normalizeSectionItems(value: any) {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\r?\n/u)
      : [];

  return rawItems
    .map((item: any) => clipText(item, MAX_DIGEST_ITEM_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_DIGEST_SECTION_ITEMS);
}

function normalizeDigestExperienceItems(value: any) {
  const rawItems = Array.isArray(value) ? value : [];
  const result = [] as any[];
  const seen = new Set<string>();

  for (const rawItem of rawItems) {
    const item = isPlainObject(rawItem) ? rawItem : { title: rawItem };
    const title = clipText(item.title, MAX_DIGEST_ITEM_LENGTH);
    const scenario = clipText(item.scenario || item.context || item.whenToUse, MAX_DIGEST_ITEM_LENGTH);
    const sourceDraftId = clipText(item.sourceDraftId || item.draftId || item.id, 120);

    if (!title && !scenario) {
      continue;
    }

    const key = `${sourceDraftId}:${title}:${scenario}`.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    const normalized: Record<string, any> = {
      title: title || scenario,
      category: clipText(item.category || 'other', 80),
      scenario,
      steps: normalizeSectionItems(item.steps).slice(0, MAX_DIGEST_EXPERIENCE_STEPS),
      pitfalls: normalizeSectionItems(item.pitfalls || item.limitations).slice(0, MAX_DIGEST_EXPERIENCE_STEPS),
      validation: normalizeSectionItems(item.validation).slice(0, MAX_DIGEST_EXPERIENCE_STEPS),
      artifacts: normalizeSectionItems(item.artifacts).slice(0, MAX_DIGEST_EXPERIENCE_STEPS),
      confidence: clipText(item.confidence || 'medium', 40),
    };

    if (sourceDraftId) {
      normalized.sourceDraftId = sourceDraftId;
    }

    result.push(normalized);

    if (result.length >= MAX_DIGEST_EXPERIENCE_ITEMS) {
      break;
    }
  }

  return result;
}

function currentMetadata(conversation: any) {
  return conversation && isPlainObject(conversation.metadata) ? conversation.metadata : {};
}

function normalizeSignalFlags(value: any = {}) {
  const flags = isPlainObject(value) ? value : {};
  const codeChange = Boolean(flags.codeChange);
  return {
    decision: Boolean(flags.decision),
    code: Boolean(flags.code || codeChange),
    codeChange,
    fileArtifact: Boolean(flags.fileArtifact),
    errorFix: Boolean(flags.errorFix),
  };
}

function anySignalFlag(signalFlags: any) {
  const flags = normalizeSignalFlags(signalFlags);
  return Boolean(flags.decision || flags.codeChange || flags.errorFix);
}

function normalizeDigestState(value: any) {
  const state = isPlainObject(value) ? value : {};
  return {
    lastDigestMessageId: normalizeText(state.lastDigestMessageId),
    lastDigestAt: normalizeText(state.lastDigestAt),
    lastAutoDigestAt: normalizeText(state.lastAutoDigestAt),
    pendingPublicMessageCount: Math.max(0, Number.parseInt(String(state.pendingPublicMessageCount || '0'), 10) || 0),
    pendingTokenEstimate: Math.max(0, Number.parseInt(String(state.pendingTokenEstimate || '0'), 10) || 0),
    messageBudget: Math.max(0, Number.parseInt(String(state.messageBudget || '0'), 10) || 0),
    highValueMinMessages: Math.max(0, Number.parseInt(String(state.highValueMinMessages || '0'), 10) || 0),
    signalFlags: normalizeSignalFlags(state.signalFlags),
    lastTriggerReason: normalizeText(state.lastTriggerReason),
    lastFailure: normalizeText(state.lastFailure),
    updatedAt: normalizeText(state.updatedAt),
  };
}

function getConversationDigestState(conversation: any) {
  const metadata = currentMetadata(conversation);
  return normalizeDigestState(metadata[CONVERSATION_DIGEST_STATE_METADATA_KEY]);
}

function compactDigestStateForMetadata(state: any) {
  const normalized = normalizeDigestState(state);
  const result: Record<string, any> = {
    pendingPublicMessageCount: normalized.pendingPublicMessageCount,
    pendingTokenEstimate: normalized.pendingTokenEstimate,
    messageBudget: normalized.messageBudget,
    highValueMinMessages: normalized.highValueMinMessages,
    signalFlags: normalized.signalFlags,
    updatedAt: normalized.updatedAt || nowIso(),
  };

  for (const key of ['lastDigestMessageId', 'lastDigestAt', 'lastAutoDigestAt', 'lastTriggerReason', 'lastFailure']) {
    const value = (normalized as Record<string, any>)[key];

    if (value) {
      result[key] = value;
    }
  }

  return result;
}

function isAutoDigestInput(input: any) {
  return Boolean(input && input.autoCreated === true);
}

function autoDigestCreatedBy(input: any, fallback: string) {
  const explicitCreatedBy = normalizeText(input && input.createdBy);

  if (explicitCreatedBy) {
    return explicitCreatedBy;
  }

  if (!isAutoDigestInput(input)) {
    return fallback;
  }

  if (fallback.startsWith('model:')) {
    return `model:auto-digest:${fallback.replace(/^model:/u, '')}`;
  }

  return 'system:auto-digest';
}

function normalizeMessage(message: any) {
  return normalizeMessageWithLimit(message, MAX_DIGEST_ITEM_LENGTH);
}

function normalizeMessageWithLimit(message: any, maxContentLength: number) {
  if (!message || message.metadata && message.metadata.digestHidden === true) {
    return null;
  }

  const content = clipText(message.content || message.errorMessage || '', maxContentLength);

  if (!content) {
    return null;
  }

  return {
    id: normalizeText(message.id),
    role: normalizeText(message.role) || 'assistant',
    speaker: normalizeText(message.senderName) || (message.role === 'user' ? 'User' : 'Assistant'),
    content,
    createdAt: normalizeText(message.createdAt),
  };
}

function normalizeDigestKind(value: any) {
  return normalizeText(value).toLowerCase() === 'rollup' ? 'rollup' : 'entry';
}

function normalizeSourceDigestIds(value: any) {
  const rawIds = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const result = [] as string[];

  for (const rawId of rawIds) {
    const id = normalizeText(rawId);

    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    result.push(id);

    if (result.length >= MAX_DIGEST_SOURCE_IDS) {
      break;
    }
  }

  return result;
}

function normalizeDigestEntry(value: any) {
  if (!isPlainObject(value)) {
    return null;
  }

  const id = normalizeText(value.id);
  const createdAt = normalizeText(value.createdAt || value.created_at);
  const summary = clipText(value.summary, MAX_DIGEST_SUMMARY_LENGTH);

  if (!id || !createdAt || !summary) {
    return null;
  }

  const kind = normalizeDigestKind(value.kind);
  const messageRange = isPlainObject(value.messageRange) ? value.messageRange : {};
  const normalized: Record<string, any> = {
    id,
    kind,
    createdAt,
    updatedAt: normalizeText(value.updatedAt || value.updated_at) || createdAt,
    createdBy: normalizeText(value.createdBy || value.created_by) || (kind === 'rollup' ? 'system:auto-compaction' : 'user'),
    messageRange: {
      fromMessageId: normalizeText(messageRange.fromMessageId || messageRange.from_message_id),
      toMessageId: normalizeText(messageRange.toMessageId || messageRange.to_message_id),
      messageCount: Math.max(0, Number.parseInt(String(messageRange.messageCount || messageRange.message_count || '0'), 10) || 0),
    },
    summary,
  };

  const triggerReason = normalizeText(value.triggerReason || value.trigger_reason);
  if (triggerReason) {
    normalized.triggerReason = triggerReason;
  }

  if (kind === 'rollup') {
    normalized.compactedAt = normalizeText(value.compactedAt || value.compacted_at) || normalized.updatedAt;
    normalized.sourceDigestIds = normalizeSourceDigestIds(value.sourceDigestIds || value.source_digest_ids);
  }

  for (const key of DIGEST_SECTION_KEYS) {
    const items = normalizeSectionItems(value[key]);
    normalized[key] = items;
  }

  const experience = normalizeDigestExperienceItems(value.experience);
  if (experience.length > 0) {
    normalized.experience = experience;
  }

  return normalized;
}

function orderDigestsForStorage(digests: any[]) {
  const rollups = digests.filter((digest: any) => digest && digest.kind === 'rollup');
  const entries = digests.filter((digest: any) => !digest || digest.kind !== 'rollup');
  const latestRollup = rollups.length > 0 ? rollups[rollups.length - 1] : null;

  return latestRollup ? [latestRollup, ...entries] : entries;
}

export function getConversationDigests(conversation: any) {
  const metadata = currentMetadata(conversation);
  const rawDigests = Array.isArray(metadata[CONVERSATION_DIGEST_METADATA_KEY])
    ? metadata[CONVERSATION_DIGEST_METADATA_KEY]
    : [];

  return orderDigestsForStorage(rawDigests
    .map(normalizeDigestEntry)
    .filter(Boolean) as any[])
    .slice(-MAX_DIGEST_METADATA_ITEMS);
}

function boundDigestsForMetadata(digests: any[]) {
  const orderedDigests = orderDigestsForStorage(digests.map(normalizeDigestEntry).filter(Boolean) as any[]);
  const rollups = orderedDigests.filter((digest: any) => digest.kind === 'rollup');
  const entries = orderedDigests.filter((digest: any) => digest.kind !== 'rollup');
  const latestRollup = rollups.length > 0 ? rollups[rollups.length - 1] : null;
  const recentEntries = entries.slice(-MAX_RECENT_DIGEST_ENTRIES);

  return latestRollup ? [latestRollup, ...recentEntries] : recentEntries;
}

function buildMetadataWithDigests(conversation: any, digests: any[]) {
  const metadata = currentMetadata(conversation);
  const normalizedDigests = boundDigestsForMetadata(digests);

  if (normalizedDigests.length === 0) {
    const { [CONVERSATION_DIGEST_METADATA_KEY]: _digests, [CONVERSATION_DIGEST_STATE_METADATA_KEY]: _state, ...remainingMetadata } = metadata;
    return remainingMetadata;
  }

  return {
    ...metadata,
    [CONVERSATION_DIGEST_METADATA_KEY]: normalizedDigests,
  };
}

function buildMetadataWithDigestState(conversation: any, state: any) {
  return {
    ...currentMetadata(conversation),
    [CONVERSATION_DIGEST_STATE_METADATA_KEY]: compactDigestStateForMetadata(state),
  };
}

function updateConversationMetadata(store: any, conversation: any, metadata: any) {
  // metadata-only 写入：不传 title，避免 titleSource 状态机把
  // “携带现有标题”误判为 manual 改名（manual 终态会永久锁死自动标题）。
  return store.updateConversation(conversation.id, {
    type: conversation.type,
    metadata,
  });
}

function isUserDigestMessage(item: any) {
  return normalizeText(item && item.role).toLowerCase() === 'user';
}

function isQuestionLikeDigestText(lower: string) {
  return /[?？]|问题|待确认|不确定|open question|question/u.test(lower);
}

function isSpeculativeDigestText(lower: string) {
  return /可能|也许|猜测|推测|我觉得|我认为|建议|应该|可以考虑|may\b|might\b|maybe\b|guess|speculat|suggest|recommend|should\b|could\b|would\b/u.test(lower);
}

function isVerifiedDigestText(lower: string) {
  return /已完成|已实现|已修复|已验证|已通过|测试通过|构建通过|提交|合并|落地|verified|implemented|fixed|passed|created|updated|committed|merged/u.test(lower);
}

function shouldRecordAsDigestFact(item: any, lower: string) {
  if (isQuestionLikeDigestText(lower) || isSpeculativeDigestText(lower)) {
    return false;
  }

  if (isUserDigestMessage(item)) {
    return true;
  }

  return isVerifiedDigestText(lower);
}

function classifyDigestItem(bucket: Record<string, string[]>, item: any) {
  const text = item.content;
  const lower = text.toLowerCase();
  const line = `${item.speaker}: ${text}`;
  const isQuestion = isQuestionLikeDigestText(lower);
  const isSpeculative = isSpeculativeDigestText(lower);
  const isVerified = isVerifiedDigestText(lower);
  const isUser = isUserDigestMessage(item);

  if (/决定|结论|确认|采用|同意|decision|decided|agreed|confirmed/u.test(lower) && (isUser || isVerified) && !isQuestion) {
    bucket.decisions.push(line);
  }

  if (isQuestion || (!isUser && isSpeculative && !isVerified)) {
    bucket.openQuestions.push(line);
  }

  if (/下一步|todo|待办|需要|建议|实现|添加|验证|run|test|should|next/u.test(lower)) {
    bucket.nextActions.push(line);
  }

  const artifactMatches = text.match(/(?:[\w.-]+\/)+[\w.-]+|[\w.-]+\.(?:ts|js|json|md|css|html|py|sqlite|yaml|yml)/giu) || [];
  for (const artifact of artifactMatches) {
    bucket.artifacts.push(artifact);
  }

  if (shouldRecordAsDigestFact(item, lower)) {
    bucket.facts.push(line);
  }
}

function uniqueSectionItems(items: string[]) {
  const seen = new Set<string>();
  const result = [] as string[];

  for (const item of items) {
    const clipped = clipText(item, MAX_DIGEST_ITEM_LENGTH);
    const key = clipped.toLowerCase();

    if (!clipped || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(clipped);

    if (result.length >= MAX_DIGEST_SECTION_ITEMS) {
      break;
    }
  }

  return result;
}

function buildExtractiveDigestFromMessages(normalizedMessages: any[], input: any, timestamp: string) {
  const bucket: Record<string, string[]> = {
    facts: [],
    decisions: [],
    openQuestions: [],
    nextActions: [],
    artifacts: [],
  };

  for (const item of normalizedMessages) {
    classifyDigestItem(bucket, item);
  }

  const firstMessage = normalizedMessages[0];
  const lastMessage = normalizedMessages[normalizedMessages.length - 1];
  const recentFacts = normalizedMessages.slice(-5).map((item: any) => `${item.speaker}: ${item.content}`);
  const summary = clipText(
    input && input.summary
      ? input.summary
      : `Extractive digest of ${normalizedMessages.length} public messages. Recent focus: ${recentFacts.join(' / ')}`,
    MAX_DIGEST_SUMMARY_LENGTH
  );

  const entry: Record<string, any> = {
    id: `digest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'entry',
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: autoDigestCreatedBy(input, 'user'),
    messageRange: {
      fromMessageId: firstMessage.id,
      toMessageId: lastMessage.id,
      messageCount: normalizedMessages.length,
    },
    summary,
    triggerReason: normalizeText(input && input.triggerReason),
  };

  for (const key of DIGEST_SECTION_KEYS) {
    const overrideItems = input && Object.prototype.hasOwnProperty.call(input, key)
      ? normalizeSectionItems(input[key])
      : [];
    entry[key] = overrideItems.length > 0 ? overrideItems : uniqueSectionItems(bucket[key]);
  }

  const experience = normalizeDigestExperienceItems(input && input.experience);
  if (experience.length > 0) {
    entry.experience = experience;
  }

  return normalizeDigestEntry(entry);
}

function hasManualDigestOverrides(input: any) {
  if (!input || typeof input !== 'object') {
    return false;
  }

  if (normalizeText(input.summary)) {
    return true;
  }

  return DIGEST_SECTION_KEYS.some((key) => Object.prototype.hasOwnProperty.call(input, key));
}

const DIGEST_MODEL_OVERRIDE_FIELDS = ['provider', 'model', 'thinking'];

function digestSummaryMode(input: any, options: any = {}) {
  return normalizeText(
    input && (input.summaryMode || input.digestMode || input.mode)
      || options.summaryMode
      || process.env.CAFF_DIGEST_SUMMARY_MODE
      || ''
  ).toLowerCase();
}

function resolveSystemModelConfigSnapshot(options: any = {}) {
  if (options.systemModelConfigSnapshot && typeof options.systemModelConfigSnapshot === 'object') {
    return options.systemModelConfigSnapshot;
  }
  if (typeof options.resolveSystemModelConfigSnapshot !== 'function') {
    return null;
  }
  const snapshot = options.resolveSystemModelConfigSnapshot();
  return snapshot && typeof snapshot === 'object' ? snapshot : null;
}

function hasExplicitDigestModelConfig(_input: any, options: any = {}) {
  const systemModelConfig = resolveSystemModelConfigSnapshot(options);
  return Boolean(
    normalizeText(systemModelConfig && systemModelConfig.provider)
    || normalizeText(systemModelConfig && systemModelConfig.model)
    || normalizeText(options.provider)
    || normalizeText(options.model)
    || normalizeText(process.env.CAFF_DIGEST_PROVIDER)
    || normalizeText(process.env.CAFF_DIGEST_MODEL)
  );
}

function shouldUseModelDigest(input: any, options: any = {}) {
  const mode = digestSummaryMode(input, options);

  if (['extractive', 'rules', 'rule', 'off', 'false'].includes(mode)) {
    return false;
  }

  if (['model', 'llm', 'ai', 'true'].includes(mode)) {
    return true;
  }

  if (hasManualDigestOverrides(input)) {
    return false;
  }

  return mode === 'auto' || mode === '' ? hasExplicitDigestModelConfig(input, options) : false;
}

function resolveDigestModelConfig(_input: any, options: any = {}) {
  const systemModelConfig = resolveSystemModelConfigSnapshot(options);
  const provider = resolveSetting(
    systemModelConfig && systemModelConfig.provider,
    options.provider || process.env.CAFF_DIGEST_PROVIDER || process.env.PI_PROVIDER,
    DEFAULT_PROVIDER
  );
  const model = resolveSetting(
    systemModelConfig && systemModelConfig.model,
    options.model || process.env.CAFF_DIGEST_MODEL || process.env.PI_MODEL,
    DEFAULT_MODEL
  );
  const thinking = resolveThinkingSetting(
    provider,
    systemModelConfig && systemModelConfig.thinking,
    options.thinking || process.env.CAFF_DIGEST_THINKING,
    DEFAULT_THINKING
  );
  const heartbeatTimeoutMs = resolveIntegerSetting(
    options.heartbeatTimeoutMs,
    process.env.CAFF_DIGEST_MODEL_TIMEOUT_MS,
    DEFAULT_DIGEST_MODEL_TIMEOUT_MS,
    'digestModelTimeoutMs'
  );

  return {
    provider,
    model,
    thinking,
    heartbeatTimeoutMs,
    agentDir: resolveSetting(options.agentDir, process.env.PI_CODING_AGENT_DIR, DEFAULT_AGENT_DIR),
    sqlitePath: resolveSetting(options.sqlitePath, process.env.PI_SQLITE_PATH, ''),
  };
}

const MODEL_DIGEST_JSON_SHAPE = '{"summary":"string","facts":["string"],"decisions":["string"],"openQuestions":["string"],"nextActions":["string"],"artifacts":["string"],"experience":[{"title":"string","category":"string","scenario":"string","steps":["string"],"pitfalls":["string"],"validation":["string"],"artifacts":["string"],"confidence":"low|medium|high"}]}';

function modelDigestJsonInstructionLines() {
  return [
    'Return exactly one valid compact JSON object. Do not wrap it in markdown, code fences, XML, prose, comments, or multiple JSON objects.',
    'The JSON object must include every top-level key from this exact shape, even when a value is empty:',
    MODEL_DIGEST_JSON_SHAPE,
    'Use double-quoted JSON strings only. Escape newlines inside strings as \\n and literal double quotes inside strings as \\\". Prefer rephrasing quoted terms without quote marks when possible. Do not use trailing commas, comments, undefined, NaN, Infinity, or placeholder text.',
    'Write a concise summary only from supported evidence; when section evidence is missing or uncertain, use empty arrays instead of inventing filler items.',
    'Few-shot example input: [{"role":"user","speaker":"User","content":"决定保留规则摘要兜底。"},{"role":"assistant","speaker":"Agent","content":"已验证 npm run check 通过，修改 server/domain/conversation/conversation-digest.ts。"}]',
    'Few-shot valid output: {"summary":"用户确认保留规则摘要兜底，且实现已通过检查。","facts":["npm run check 通过。"],"decisions":["保留规则摘要作为模型摘要失败时的兜底。"],"openQuestions":[],"nextActions":[],"artifacts":["server/domain/conversation/conversation-digest.ts"],"experience":[]}',
    'Do not copy the few-shot example; summarize only the source data below.',
    'Limits: summary <= 800 characters; each array <= 8 items; each item <= 240 characters; experience <= 5 items and each nested array <= 5 items.',
  ];
}

function buildModelDigestPrompt(normalizedMessages: any[], experience: any[] = []) {
  const sourceMessages = normalizedMessages.slice(-MAX_DIGEST_MODEL_MESSAGES).map((message: any, index: number) => ({
    index: index + 1,
    id: message.id,
    role: message.role,
    speaker: message.speaker,
    createdAt: message.createdAt,
    content: message.content,
  }));
  const sourceExperience = normalizeDigestExperienceItems(experience);

  return [
    'You are CAFF conversation digest writer.',
    'Summarize the provided public chat messages into bounded long-term memory for future agents.',
    'Do not invent facts. Facts must be user-stated facts, explicit tool/results evidence, or verified code/test outcomes; never promote agent speculation into facts.',
    'Decisions must be user-confirmed or already implemented. Put unconfirmed agent proposals in openQuestions or nextActions, not facts.',
    'If source experience drafts are provided, preserve them as reusable experience candidates and keep their caveats bounded.',
    ...modelDigestJsonInstructionLines(),
    '',
    'Source experience drafts JSON:',
    JSON.stringify(sourceExperience, null, 2),
    '',
    'Public messages JSON:',
    JSON.stringify(sourceMessages, null, 2),
  ].join('\n');
}

function buildModelRollupPrompt(sources: any[]) {
  const sourceDigests = sources.map((digest: any, index: number) => ({
    index: index + 1,
    id: digest.id,
    kind: digest.kind,
    createdAt: digest.createdAt,
    summary: digest.summary,
    facts: normalizeSectionItems(digest.facts),
    decisions: normalizeSectionItems(digest.decisions),
    openQuestions: normalizeSectionItems(digest.openQuestions),
    nextActions: normalizeSectionItems(digest.nextActions),
    artifacts: normalizeSectionItems(digest.artifacts),
    experience: normalizeDigestExperienceItems(digest.experience),
  }));

  return [
    'You are CAFF conversation digest rollup writer.',
    'Merge older digest entries into one bounded historical rollup for future agents.',
    'Keep stable history and unresolved work. Remove duplicates. Do not invent facts or promote unconfirmed agent speculation.',
    'If source digests conflict, keep the conflict in openQuestions instead of choosing a winner.',
    'Preserve reusable experience candidates only when they remain supported by the source digests.',
    ...modelDigestJsonInstructionLines(),
    '',
    'Source digest entries JSON:',
    JSON.stringify(sourceDigests, null, 2),
  ].join('\n');
}

function normalizeJsonObjectText(value: any) {
  return normalizeText(value).replace(/^```(?:json)?\s*/iu, '').replace(/```$/u, '').trim();
}

function parseJsonObjectFromText(value: any) {
  const text = normalizeJsonObjectText(value);

  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {}

  const startIndex = text.indexOf('{');
  const endIndex = text.lastIndexOf('}');

  if (startIndex === -1 || endIndex <= startIndex) {
    return null;
  }

  try {
    const parsed = JSON.parse(text.slice(startIndex, endIndex + 1));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function jsonParseErrorPosition(error: any) {
  const match = String(error && error.message ? error.message : '').match(/position\s+(\d+)/iu);
  return match ? Number.parseInt(match[1], 10) : -1;
}

function previousNonWhitespaceIndex(text: string, startIndex: number) {
  for (let index = Math.min(startIndex, text.length - 1); index >= 0; index -= 1) {
    if (!/\s/u.test(text[index])) {
      return index;
    }
  }

  return -1;
}

function snippetAroundPosition(text: string, position: number, radius = 80) {
  const boundedPosition = Math.max(0, Math.min(position, text.length));
  const startIndex = Math.max(0, boundedPosition - radius);
  const endIndex = Math.min(text.length, boundedPosition + radius);
  const prefix = startIndex > 0 ? '…' : '';
  const suffix = endIndex < text.length ? '…' : '';
  return `${prefix}${text.slice(startIndex, endIndex)}${suffix}`.replace(/\s+/gu, ' ');
}

function parseJsonCandidateFailure(value: any) {
  const text = normalizeJsonObjectText(value);

  if (!text) {
    return null;
  }

  try {
    JSON.parse(text);
    return null;
  } catch (error) {
    const startIndex = text.indexOf('{');
    const endIndex = text.lastIndexOf('}');

    if (startIndex !== -1 && endIndex > startIndex) {
      const candidate = text.slice(startIndex, endIndex + 1);
      try {
        JSON.parse(candidate);
        return null;
      } catch (candidateError) {
        return { candidate, error: candidateError };
      }
    }

    return { candidate: text, error };
  }
}

function diagnoseMissingEscapedQuoteJsonFailure(value: any) {
  const failure = parseJsonCandidateFailure(value);

  if (!failure) {
    return '';
  }

  const position = jsonParseErrorPosition(failure.error);
  if (!Number.isFinite(position) || position < 0) {
    return '';
  }

  const failureError = failure.error as any;
  const message = String(failureError && failureError.message ? failureError.message : '');
  const expectsValueDelimiter = /Expected ',' or '[}\]]' after (?:array element|property value)/iu.test(message);
  const previousIndex = previousNonWhitespaceIndex(failure.candidate, position - 1);
  const currentChar = failure.candidate[position] || '';

  if (!expectsValueDelimiter || previousIndex < 0 || failure.candidate[previousIndex] !== '"' || !currentChar || /[,}\]\s]/u.test(currentChar)) {
    return '';
  }

  return clipText(
    `Likely missing escape for an inner double quote in a JSON string near position ${position}. `
      + `JSON.parse reported: ${message}. `
      + `Nearby text: ${snippetAroundPosition(failure.candidate, position)}. `
      + 'Escape literal quote characters inside string values as \\" or rewrite the phrase without quote marks.',
    800
  );
}

function buildModelDigestJsonRepairPrompt(originalPrompt: string, invalidOutput: any, diagnostic: string) {
  return [
    'You are CAFF conversation digest JSON repairer.',
    'The previous digest response failed strict JSON.parse validation.',
    'Return exactly one valid compact JSON object using the original digest schema. Do not add markdown, prose, comments, or multiple JSON objects.',
    `Validation diagnostic: ${diagnostic}`,
    'Repair rule: escape literal double quote characters inside JSON string values as \\" or rewrite the phrase without quote marks. If a field cannot be safely repaired, omit that item or use an empty array.',
    'Use only information supported by the original instructions and source data. Do not invent facts while repairing syntax.',
    '',
    'Original digest instructions and source data:',
    originalPrompt,
    '',
    'Invalid model output to repair, bounded:',
    clipRawText(stringifyDigestModelOutput(invalidOutput), MAX_DIGEST_MODEL_REPAIR_OUTPUT_LENGTH),
  ].join('\n');
}

function normalizeModelDigestPayload(value: any) {
  const payload = isPlainObject(value) ? value : parseJsonObjectFromText(value);

  if (!payload) {
    return null;
  }

  const normalized: Record<string, any> = {
    summary: clipText(payload.summary, MAX_DIGEST_SUMMARY_LENGTH),
  };

  for (const key of DIGEST_SECTION_KEYS) {
    normalized[key] = normalizeSectionItems(payload[key]);
  }

  const experience = normalizeDigestExperienceItems(payload.experience);
  if (experience.length > 0) {
    normalized.experience = experience;
  }

  if (!normalized.summary) {
    const firstItems = DIGEST_SECTION_KEYS.flatMap((key) => normalized[key]).slice(0, 3);
    normalized.summary = clipText(firstItems.join(' / '), MAX_DIGEST_SUMMARY_LENGTH);
  }

  return normalized.summary ? normalized : null;
}

function validateJsonModeDigestPayload(value: any) {
  const payload = isPlainObject(value) ? value : parseJsonObjectFromText(value);

  if (!isPlainObject(payload)) {
    return { ok: false, reason: 'digest JSON must be an object' };
  }

  for (const key of DIGEST_MODEL_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      return { ok: false, reason: `missing required field: ${key}` };
    }
  }

  if (typeof payload.summary !== 'string' || !normalizeText(payload.summary)) {
    return { ok: false, reason: 'summary must be a non-empty string' };
  }

  for (const key of DIGEST_SECTION_KEYS) {
    if (!Array.isArray(payload[key])) {
      return { ok: false, reason: `${key} must be an array` };
    }

    if (!payload[key].every((item: any) => typeof item === 'string')) {
      return { ok: false, reason: `${key} must contain only strings` };
    }
  }

  if (payload.experience !== undefined && !Array.isArray(payload.experience)) {
    return { ok: false, reason: 'experience must be an array when present' };
  }

  const normalized = normalizeModelDigestPayload(payload);
  return normalized
    ? { ok: true, payload: normalized }
    : { ok: false, reason: 'digest JSON did not normalize to a valid digest' };
}

function extractDigestModelTextPart(item: any) {
  if (typeof item === 'string') {
    return normalizeText(item);
  }

  if (!item || typeof item !== 'object') {
    return '';
  }

  const type = normalizeDigestModelContentType(item.type);
  if (type === 'thinking' || type === 'reasoning' || type === 'redactedthinking') {
    return '';
  }

  return normalizeText(item.text || item.content || item.output_text || item.refusal);
}

function extractDigestModelText(output: any) {
  if (typeof output === 'string') {
    return output;
  }

  const message = output && (output.message || output.assistantMessage || output);
  if (typeof (message && message.content) === 'string') {
    return normalizeText(message.content);
  }

  const content = Array.isArray(message && message.content) ? message.content : [];
  return content
    .map((item: any) => extractDigestModelTextPart(item))
    .filter(Boolean)
    .join('\n');
}

function buildJsonModeDigestModelContext(prompt: string) {
  return {
    systemPrompt: [
      'You are CAFF structured conversation digest writer.',
      'Return exactly one valid compact JSON object matching the requested digest schema.',
      'Do not add hidden reasoning, markdown, code fences, XML, prose, comments, or multiple JSON objects.',
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      },
    ],
  };
}

function resolveDigestJsonModeMaxTokens(options: any = {}) {
  return Math.max(256, resolveIntegerSetting(
    options.digestJsonModeMaxTokens,
    process.env.CAFF_DIGEST_JSON_MODE_MAX_TOKENS,
    DEFAULT_DIGEST_JSON_MODE_MAX_TOKENS,
    'digest JSON mode max tokens'
  ));
}

function buildJsonModeDigestPayload(payload: any, model: any) {
  const nextPayload = {
    ...payload,
    response_format: { type: 'json_object' },
  } as Record<string, any>;
  const provider = normalizeText(model && model.provider).toLowerCase();
  const thinkingFormat = normalizeText(model && model.compat && model.compat.thinkingFormat).toLowerCase();

  delete nextPayload.reasoning;
  delete nextPayload.reasoning_effort;
  delete nextPayload.reasoningEffort;

  if (provider === 'deepseek' || thinkingFormat === 'deepseek') {
    nextPayload.thinking = { type: 'disabled' };
  }

  return nextPayload;
}

async function completeDigestModel(complete: any, model: any, context: any, completeOptions: any, options: any = {}, config: any = {}) {
  if (completeOptions && completeOptions.signal) {
    return complete(model, context, completeOptions);
  }

  const timeoutMs = Math.max(1000, resolveIntegerSetting(
    options.digestModelTimeoutMs || config.heartbeatTimeoutMs,
    process.env.CAFF_DIGEST_MODEL_TIMEOUT_MS,
    DEFAULT_DIGEST_MODEL_TIMEOUT_MS,
    'digestModelTimeoutMs'
  ));
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    return await complete(model, context, {
      ...completeOptions,
      ...(controller ? { signal: controller.signal } : {}),
    });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

const PI_AI_MODULE_CACHE = new Map();

async function importPiAiModule(specifier = '@mariozechner/pi-ai') {
  if (!PI_AI_MODULE_CACHE.has(specifier)) {
    PI_AI_MODULE_CACHE.set(specifier, Function('specifier', 'return import(specifier)')(specifier));
  }

  return PI_AI_MODULE_CACHE.get(specifier);
}

function findDigestRepoRoot(startDir: string, maxDepth = 8) {
  let currentDir = path.resolve(String(startDir || ''));

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    if (fs.existsSync(path.join(currentDir, 'package.json'))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      break;
    }

    currentDir = parentDir;
  }

  return '';
}

function resolveDigestModelsJsonPaths() {
  const configuredAgentDir = resolveSetting('', process.env.PI_CODING_AGENT_DIR, DEFAULT_AGENT_DIR);
  const repoRoot = findDigestRepoRoot(process.cwd()) || process.cwd();
  const candidates = [
    path.resolve(configuredAgentDir, 'models.json'),
    path.resolve(repoRoot, '.pi-sandbox', 'models.json'),
  ];
  const seen = new Set<string>();

  return candidates.filter((candidatePath) => {
    const normalizedPath = path.resolve(candidatePath);

    if (seen.has(normalizedPath)) {
      return false;
    }

    seen.add(normalizedPath);
    return true;
  });
}

function readDigestModelsJsonProviders() {
  for (const candidatePath of resolveDigestModelsJsonPaths()) {
    if (!fs.existsSync(candidatePath)) {
      continue;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
      return parsed && typeof parsed.providers === 'object' ? parsed.providers : {};
    } catch {
      return {};
    }
  }

  return {};
}

function normalizeDigestModelCost(value: any) {
  return {
    input: Number.isFinite(Number(value && value.input)) ? Number(value.input) : 0,
    output: Number.isFinite(Number(value && value.output)) ? Number(value.output) : 0,
    cacheRead: Number.isFinite(Number(value && value.cacheRead)) ? Number(value.cacheRead) : 0,
    cacheWrite: Number.isFinite(Number(value && value.cacheWrite)) ? Number(value.cacheWrite) : 0,
  };
}

function normalizeDigestModelPositiveInteger(value: any, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeDigestConfiguredSecret(value: any) {
  const text = normalizeText(value);

  if (!text || text.startsWith('!')) {
    return '';
  }

  if (/^[A-Z][A-Z0-9_]*$/u.test(text)) {
    return normalizeText(process.env[text]);
  }

  return text;
}

function resolveConfiguredDigestModel(config: any) {
  const requestedProvider = normalizeText(config.provider);
  const requestedModel = normalizeText(config.model);

  if (!requestedProvider || !requestedModel) {
    return null;
  }

  const requestedProviderLower = requestedProvider.toLowerCase();
  const requestedModelWithoutProvider = requestedModel.toLowerCase().startsWith(`${requestedProviderLower}/`)
    ? requestedModel.slice(requestedProvider.length + 1)
    : requestedModel;
  const providers = readDigestModelsJsonProviders();

  for (const [providerName, providerConfig] of Object.entries(providers)) {
    if (normalizeText(providerName).toLowerCase() !== requestedProviderLower || !isPlainObject(providerConfig)) {
      continue;
    }

    const models = Array.isArray((providerConfig as any).models) ? (providerConfig as any).models : [];
    const modelConfig = models.find((candidate: any) => {
      const candidateId = normalizeText(candidate && candidate.id);
      const candidateName = normalizeText(candidate && candidate.name);
      return candidateId === requestedModel || candidateId === requestedModelWithoutProvider || candidateName === requestedModel || candidateName === requestedModelWithoutProvider;
    });

    if (!modelConfig) {
      continue;
    }

    const mergedCompat = {
      ...(isPlainObject((providerConfig as any).compat) ? (providerConfig as any).compat : {}),
      ...(isPlainObject(modelConfig.compat) ? modelConfig.compat : {}),
    };
    const modelHeaders = isPlainObject((providerConfig as any).headers) || isPlainObject(modelConfig.headers)
      ? {
        ...(isPlainObject((providerConfig as any).headers) ? (providerConfig as any).headers : {}),
        ...(isPlainObject(modelConfig.headers) ? modelConfig.headers : {}),
      }
      : undefined;

    return {
      model: {
        id: normalizeText(modelConfig.id) || requestedModelWithoutProvider,
        name: normalizeText(modelConfig.name) || normalizeText(modelConfig.id) || requestedModelWithoutProvider,
        api: normalizeText(modelConfig.api) || normalizeText((providerConfig as any).api) || 'openai-completions',
        provider: normalizeText(providerName),
        baseUrl: normalizeText(modelConfig.baseUrl) || normalizeText((providerConfig as any).baseUrl),
        reasoning: Boolean(modelConfig.reasoning),
        input: Array.isArray(modelConfig.input) ? modelConfig.input : ['text'],
        cost: normalizeDigestModelCost(modelConfig.cost),
        contextWindow: normalizeDigestModelPositiveInteger(modelConfig.contextWindow || (providerConfig as any).contextWindow, 128000),
        maxTokens: normalizeDigestModelPositiveInteger(modelConfig.maxTokens || (providerConfig as any).maxTokens, 16384),
        ...(Object.keys(mergedCompat).length > 0 ? { compat: mergedCompat } : {}),
        ...(modelHeaders ? { headers: modelHeaders } : {}),
      },
      apiKey: normalizeDigestConfiguredSecret(modelConfig.apiKey) || normalizeDigestConfiguredSecret((providerConfig as any).apiKey),
    };
  }

  return null;
}

function createDeepSeekDigestPiModel(config: any) {
  const provider = normalizeText(config.provider).toLowerCase();
  const configuredModel = normalizeText(config.model);

  if (provider !== 'deepseek' || !configuredModel) {
    return null;
  }

  const modelId = configuredModel.startsWith('deepseek/')
    ? configuredModel.slice('deepseek/'.length)
    : configuredModel;

  return {
    model: {
      id: modelId,
      name: modelId,
      api: 'openai-completions',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
      compat: {
        maxTokensField: 'max_tokens',
        supportsReasoningEffort: false,
        supportsStrictMode: false,
      },
    },
    apiKey: normalizeText(process.env.DEEPSEEK_API_KEY),
  };
}

function resolveDigestPiModel(piAi: any, config: any) {
  const getModel = typeof piAi.getModel === 'function' ? piAi.getModel : null;
  const getModels = typeof piAi.getModels === 'function' ? piAi.getModels : null;

  if (!getModel) {
    throw new Error('pi-ai module does not expose getModel()');
  }

  let model = getModel(config.provider, config.model);

  if (!model && getModels) {
    const providerModels = getModels(config.provider) || [];
    model = providerModels.find((candidate: any) => candidate && candidate.id === config.model);
  }

  if (model) {
    const configuredModel = resolveConfiguredDigestModel(config);
    return {
      model,
      apiKey: configuredModel && configuredModel.apiKey ? configuredModel.apiKey : '',
    };
  }

  const configuredModel = resolveConfiguredDigestModel(config) || createDeepSeekDigestPiModel(config);

  if (!configuredModel) {
    throw new Error(`Unknown digest model for pi-ai: ${config.provider}/${config.model}`);
  }

  return configuredModel;
}

function createModelDigestError(message: string, output: any) {
  const error = new Error(message) as any;
  error.digestModelOutput = output;
  return error;
}

async function runJsonModeDigestModelPrompt(prompt: string, config: any, options: any = {}) {
  const piAi = await importPiAiModule(normalizeText(options.piAiModuleSpecifier || process.env.CAFF_PI_AI_MODULE) || '@mariozechner/pi-ai');
  const complete = typeof piAi.complete === 'function' ? piAi.complete : null;

  if (!complete) {
    throw new Error('pi-ai module does not expose complete()');
  }

  const resolvedModel = resolveDigestPiModel(piAi, config);
  const model = resolvedModel.model;
  const jsonModeModel = {
    ...model,
    reasoning: false,
    compat: {
      ...(isPlainObject(model && model.compat) ? model.compat : {}),
      maxTokensField: 'max_tokens',
      supportsReasoningEffort: false,
      supportsStrictMode: false,
    },
  };
  const progress = createDigestModelProgressReporter(config, options);
  progress.started();

  let output: any;
  let outputText = '';

  try {
    output = await completeDigestModel(complete, jsonModeModel, buildJsonModeDigestModelContext(prompt), {
      ...(resolvedModel.apiKey ? { apiKey: resolvedModel.apiKey } : {}),
      maxTokens: resolveDigestJsonModeMaxTokens(options),
      onPayload(payload: any) {
        return buildJsonModeDigestPayload(payload, jsonModeModel);
      },
      metadata: {
        source: 'conversation_digest',
        purpose: options.purpose || 'summary',
        conversationId: normalizeText(options.conversationId),
        structuredOutput: 'json_mode',
      },
    }, options, config);
    outputText = extractDigestModelText(output);
    progress.finished(outputText);
  } catch (error) {
    progress.failed(error);
    throw error;
  }

  const validation = outputText
    ? validateJsonModeDigestPayload(outputText)
    : { ok: false, reason: 'digest JSON text was missing from assistant response' };

  if (!validation.ok) {
    const error = createModelDigestError(`Invalid JSON mode digest payload: ${validation.reason}`, output);
    progress.failed(error);
    throw error;
  }

  return validation.payload;
}

function appendTraceText(currentValue: string, nextValue: any) {
  const nextText = normalizeText(nextValue);

  if (!nextText) {
    return currentValue;
  }

  return clipText(`${currentValue}${nextText}`, MAX_DIGEST_MODEL_TRACE_TEXT_LENGTH);
}

function normalizeDigestModelContentType(value: any) {
  return normalizeText(value).replace(/[_-]/gu, '').toLowerCase();
}

function extractDigestModelMessageParts(message: any) {
  const content = Array.isArray(message && message.content) ? message.content : [];
  const thinkingParts = [] as string[];
  const textParts = [] as string[];

  for (const item of content) {
    const type = normalizeDigestModelContentType(item && item.type);

    if (type === 'thinking' || type === 'reasoning') {
      const thinkingText = normalizeText(item && (item.thinking || item.text));
      if (thinkingText) {
        thinkingParts.push(thinkingText);
      }

      const summaries = Array.isArray(item && item.summary) ? item.summary : [];
      for (const summary of summaries) {
        const summaryText = normalizeText(summary && (summary.text || summary.summary));
        if (summaryText) {
          thinkingParts.push(summaryText);
        }
      }
      continue;
    }

    if (type === 'text') {
      const text = normalizeText(item && item.text);
      if (text) {
        textParts.push(text);
      }
    }
  }

  return {
    thinking: thinkingParts.join('\n\n'),
    text: textParts.join(''),
  };
}

function createDigestModelProgressReporter(config: any, options: any = {}) {
  const onModelProgress = typeof options.onModelProgress === 'function' ? options.onModelProgress : null;
  const purpose = normalizeText(options.purpose) || 'summary';
  const conversationId = normalizeText(options.conversationId);
  const modelLabel = `${config.provider}/${config.model}`;
  const message = purpose === 'rollup'
    ? '会话摘要模型正在压缩历史摘要…'
    : '会话摘要模型正在生成 JSON…';
  let outputPreview = '';
  let thinkingPreview = '';
  let eventCount = 0;
  let runId = '';
  let lastEmittedAt = 0;

  function emit(force = false) {
    if (!onModelProgress || !conversationId) {
      return;
    }

    const now = Date.now();
    if (!force && lastEmittedAt > 0 && now - lastEmittedAt < DIGEST_MODEL_PROGRESS_MIN_INTERVAL_MS) {
      return;
    }

    lastEmittedAt = now;
    onModelProgress({
      conversationId,
      status: 'running',
      reason: 'model_digest',
      phase: purpose,
      message,
      model: {
        provider: config.provider,
        model: config.model,
        thinking: config.thinking,
        label: modelLabel,
      },
      modelTrace: {
        eventCount,
        outputPreview,
        thinkingPreview,
        runId,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  return {
    started() {
      eventCount += 1;
      emit(true);
    },
    runStarted(event: any) {
      runId = normalizeText(event && event.runId);
      eventCount += 1;
      emit(true);
    },
    piEvent() {
      eventCount += 1;
      emit(false);
    },
    textDelta(delta: any) {
      eventCount += 1;
      outputPreview = appendTraceText(outputPreview, delta);
      emit(false);
    },
    assistantMessage(messageEvent: any) {
      eventCount += 1;
      const parts = extractDigestModelMessageParts(messageEvent && messageEvent.message);
      outputPreview = appendTraceText('', parts.text || outputPreview);
      thinkingPreview = appendTraceText('', parts.thinking || thinkingPreview);
      emit(true);
    },
    failed(error: any) {
      eventCount += 1;
      outputPreview = appendTraceText(outputPreview, `\n[failed] ${error && error.message ? error.message : String(error || 'Unknown error')}`);
      emit(true);
    },
    finished(reply: any) {
      eventCount += 1;
      outputPreview = appendTraceText('', reply || outputPreview);
      emit(true);
    },
  };
}

async function runDigestModelPrompt(prompt: string, config: any, options: any = {}) {
  const runner = typeof options.digestModelRunner === 'function' ? options.digestModelRunner : null;

  if (runner) {
    return runner({
      prompt,
      config,
      purpose: options.purpose,
      conversationId: normalizeText(options.conversationId),
      onModelProgress: options.onModelProgress,
    });
  }

  const handle = startRun(config.provider, config.model, prompt, {
    thinking: config.thinking,
    agentDir: config.agentDir,
    sqlitePath: config.sqlitePath,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    streamOutput: false,
    taskKind: 'conversation_digest',
    taskRole: options.purpose || 'summary',
    metadata: {
      source: 'conversation_digest',
      purpose: options.purpose || 'summary',
      conversationId: normalizeText(options.conversationId),
    },
  });
  const progress = createDigestModelProgressReporter(config, options);

  handle.on('run_started', (event: any) => progress.runStarted(event));
  handle.on('pi_event', () => progress.piEvent());
  handle.on('assistant_text_delta', (event: any) => progress.textDelta(event && event.delta));
  handle.on('assistant_message', (event: any) => progress.assistantMessage(event));

  try {
    const result = await handle.resultPromise;
    progress.finished(result && result.reply ? result.reply : '');
    return result && result.reply ? result.reply : '';
  } catch (error) {
    progress.failed(error);
    throw error;
  }
}

async function generateModelDigestPayload(prompt: string, input: any, options: any = {}) {
  const config = resolveDigestModelConfig(input, options);
  const shouldUseDirectJsonMode = !options.disableDirectJsonModeDigest
    && !options.disableStructuredDigestTool
    && !options.digestModelRunner;

  if (shouldUseDirectJsonMode) {
    try {
      const jsonModePayload = await runJsonModeDigestModelPrompt(prompt, config, options);
      return {
        ...jsonModePayload,
        createdBy: `model:${config.provider}/${config.model}`,
      };
    } catch (error) {
      const errorValue = error as any;
      warnInvalidModelDigestOutput(errorValue && errorValue.digestModelOutput !== undefined ? errorValue.digestModelOutput : errorValue, config, {
        ...options,
        diagnostic: errorValue && errorValue.message ? errorValue.message : String(errorValue || 'JSON mode digest failure'),
      });
      throw error;
    }
  }

  const output = await runDigestModelPrompt(prompt, config, options);
  let normalized = normalizeModelDigestPayload(output);

  if (!normalized) {
    const diagnostic = diagnoseMissingEscapedQuoteJsonFailure(output);

    if (diagnostic) {
      warnInvalidModelDigestOutput(output, config, { ...options, diagnostic });
      const repairOutput = await runDigestModelPrompt(buildModelDigestJsonRepairPrompt(prompt, output, diagnostic), config, {
        ...options,
        retryReason: 'missing_escaped_quote',
      });
      normalized = normalizeModelDigestPayload(repairOutput);

      if (!normalized) {
        warnInvalidModelDigestOutput(repairOutput, config, options);
        throw new Error('Digest model did not return valid JSON');
      }
    } else {
      warnInvalidModelDigestOutput(output, config, options);
      throw new Error('Digest model did not return valid JSON');
    }
  }

  return {
    ...normalized,
    createdBy: `model:${config.provider}/${config.model}`,
  };
}

async function buildDigestFromMessages(messages: any[], input: any, timestamp: string, options: any = {}) {
  const normalizedMessages = messages.map(normalizeMessage).filter(Boolean) as any[];

  if (normalizedMessages.length === 0) {
    throw createHttpError(400, 'No public conversation messages are available to digest');
  }

  const extractiveDigest = buildExtractiveDigestFromMessages(normalizedMessages, input, timestamp);

  if (!shouldUseModelDigest(input, options)) {
    return extractiveDigest;
  }

  const modelMessages = messages
    .map((message: any) => normalizeMessageWithLimit(message, MAX_DIGEST_MODEL_MESSAGE_LENGTH))
    .filter(Boolean) as any[];

  try {
    const modelPayload = await generateModelDigestPayload(buildModelDigestPrompt(modelMessages, input && input.experience), input, {
      ...options,
      purpose: 'entry',
    });

    return normalizeDigestEntry({
      ...extractiveDigest,
      ...modelPayload,
      createdBy: autoDigestCreatedBy(input, modelPayload.createdBy),
    });
  } catch (error) {
    const errorValue = error as any;
    console.warn(`[conversation-digest] Model digest failed, falling back to extractive digest: ${errorValue && errorValue.stack ? errorValue.stack : errorValue}`);
    return extractiveDigest;
  }
}

function sourceDigestIdsForRollup(sources: any[]) {
  const ids = [] as string[];

  for (const source of sources) {
    if (source.kind === 'rollup') {
      const rollupSourceIds = normalizeSourceDigestIds(source.sourceDigestIds);
      ids.push(...(rollupSourceIds.length > 0 ? rollupSourceIds : [source.id]));
      continue;
    }

    ids.push(source.id);
  }

  return normalizeSourceDigestIds(ids);
}

function messageRangeForRollup(sources: any[]) {
  const ranges = sources
    .map((source: any) => source.messageRange)
    .filter(isPlainObject);
  const firstRange = ranges[0] || {};
  const lastRange = ranges[ranges.length - 1] || {};
  const messageCount = ranges.reduce((total: number, range: any) => {
    return total + (Number.parseInt(String(range.messageCount || '0'), 10) || 0);
  }, 0);

  return {
    fromMessageId: normalizeText(firstRange.fromMessageId),
    toMessageId: normalizeText(lastRange.toMessageId),
    messageCount,
  };
}

function buildExtractiveRollupDigest(sources: any[], timestamp: string) {
  const existingRollup = sources.find((source: any) => source.kind === 'rollup') || null;
  const sourceDigestIds = sourceDigestIdsForRollup(sources);
  const sourceSummaries = sources
    .map((source: any) => source.summary)
    .filter(Boolean)
    .slice(-4);
  const summary = clipText(
    `Auto-compacted rollup of ${sourceDigestIds.length} digest entries. Historical focus: ${sourceSummaries.join(' / ')}`,
    MAX_DIGEST_SUMMARY_LENGTH
  );
  const rollup: Record<string, any> = {
    id: existingRollup ? existingRollup.id : `rollup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'rollup',
    createdAt: existingRollup ? existingRollup.createdAt : timestamp,
    updatedAt: timestamp,
    createdBy: 'system:auto-compaction',
    compactedAt: timestamp,
    sourceDigestIds,
    messageRange: messageRangeForRollup(sources),
    summary,
  };

  for (const key of DIGEST_SECTION_KEYS) {
    rollup[key] = uniqueSectionItems(sources.flatMap((source: any) => normalizeSectionItems(source[key])));
  }

  const experience = normalizeDigestExperienceItems(sources.flatMap((source: any) => normalizeDigestExperienceItems(source.experience)));
  if (experience.length > 0) {
    rollup.experience = experience;
  }

  return normalizeDigestEntry(rollup);
}

async function buildRollupDigest(sources: any[], timestamp: string, input: any = {}, options: any = {}) {
  const extractiveRollup = buildExtractiveRollupDigest(sources, timestamp);

  if (!shouldUseModelDigest(input, options)) {
    return extractiveRollup;
  }

  try {
    const modelPayload = await generateModelDigestPayload(buildModelRollupPrompt(sources), input, {
      ...options,
      purpose: 'rollup',
    });

    return normalizeDigestEntry({
      ...extractiveRollup,
      ...modelPayload,
      createdBy: `model:auto-compaction:${modelPayload.createdBy.replace(/^model:/u, '')}`,
    });
  } catch (error) {
    const errorValue = error as any;
    console.warn(`[conversation-digest] Model rollup failed, falling back to extractive rollup: ${errorValue && errorValue.stack ? errorValue.stack : errorValue}`);
    return extractiveRollup;
  }
}

async function compactDigestEntries(digests: any[], timestamp: string, options: any = {}) {
  const normalizedDigests = orderDigestsForStorage(digests.map(normalizeDigestEntry).filter(Boolean) as any[]);
  const rollups = normalizedDigests.filter((digest: any) => digest.kind === 'rollup');
  const entries = normalizedDigests.filter((digest: any) => digest.kind !== 'rollup');
  const recentEntryBudget = Math.max(1, Number.parseInt(String(options.recentEntryBudget || MAX_RECENT_DIGEST_ENTRIES), 10) || MAX_RECENT_DIGEST_ENTRIES);

  if (entries.length <= recentEntryBudget) {
    return {
      digests: normalizedDigests,
      compacted: false,
      rollup: rollups.length > 0 ? rollups[rollups.length - 1] : null,
      obsoleteDigestIds: [],
    };
  }

  const entriesToCompact = entries.slice(0, Math.max(0, entries.length - recentEntryBudget));
  const recentEntries = entries.slice(-recentEntryBudget);
  const sources = [...rollups, ...entriesToCompact];
  const rollup = await buildRollupDigest(sources, timestamp, options.input || {}, options);
  const nextDigests = [rollup, ...recentEntries];
  const retainedDigestIds = new Set(nextDigests.map((digest: any) => digest.id).filter(Boolean));
  const obsoleteDigestIds = normalizeSourceDigestIds(
    normalizedDigests
      .map((digest: any) => digest.id)
      .filter((digestId: string) => digestId && !retainedDigestIds.has(digestId))
  );

  return {
    digests: nextDigests,
    compacted: true,
    rollup,
    obsoleteDigestIds,
  };
}

function responseForConversation(conversation: any, overrides: any = {}) {
  return {
    conversation,
    digests: getConversationDigests(conversation),
    digest: null,
    rollup: null,
    deleted: false,
    compacted: false,
    digestChanged: false,
    ...overrides,
  };
}

function resolveSummarySegmentTaskName(options: any = {}, conversation: any = null, digest: any = null) {
  const explicitTaskName = normalizeText(options.taskName || options.summaryMemoryTaskName);

  if (explicitTaskName) {
    return explicitTaskName;
  }

  const resolver = typeof options.resolveSummaryMemoryTaskName === 'function'
    ? options.resolveSummaryMemoryTaskName
    : typeof options.resolveTaskName === 'function'
      ? options.resolveTaskName
      : null;

  if (!resolver) {
    return '';
  }

  try {
    const resolved = resolver({ conversation, digest, options });
    if (resolved && typeof resolved === 'object') {
      return normalizeText(resolved.taskName || resolved.title || resolved.name);
    }

    return normalizeText(resolved);
  } catch (error) {
    const errorValue = error as any;
    console.warn(`[conversation-digest] Failed to resolve summary segment task name: ${errorValue && errorValue.stack ? errorValue.stack : errorValue}`);
    return '';
  }
}

function syncSummarySegmentFromDigest(store: any, conversation: any, digest: any, timestamp: string, metadata: any = {}, options: any = {}) {
  if (!digest || !store || typeof store.saveSummarySegmentFromDigest !== 'function') {
    return null;
  }

  try {
    return store.saveSummarySegmentFromDigest(conversation && conversation.id, digest, {
      updatedAt: timestamp,
      taskName: resolveSummarySegmentTaskName(options, conversation, digest),
      metadata: {
        source: 'conversation_digest',
        ...metadata,
      },
    });
  } catch (error) {
    const errorValue = error as any;
    console.warn(`[conversation-digest] Failed to sync summary segment for digest ${digest && digest.id ? digest.id : 'unknown'}: ${errorValue && errorValue.stack ? errorValue.stack : errorValue}`);
    return null;
  }
}

function deleteSummarySegmentForDigest(store: any, digestId: string) {
  if (!digestId || !store || typeof store.deleteSummarySegmentBySourceDigestId !== 'function') {
    return;
  }

  try {
    store.deleteSummarySegmentBySourceDigestId(digestId);
  } catch (error) {
    const errorValue = error as any;
    console.warn(`[conversation-digest] Failed to delete summary segment for digest ${digestId}: ${errorValue && errorValue.stack ? errorValue.stack : errorValue}`);
  }
}

function deleteSummarySegmentsForDigests(store: any, digestIds: any[]) {
  for (const digestId of normalizeSourceDigestIds(digestIds)) {
    deleteSummarySegmentForDigest(store, digestId);
  }
}

function deleteSummarySegmentsForConversation(store: any, conversationId: string) {
  if (!conversationId || !store || typeof store.deleteSummarySegmentsByConversationId !== 'function') {
    return;
  }

  try {
    store.deleteSummarySegmentsByConversationId(conversationId);
  } catch (error) {
    const errorValue = error as any;
    console.warn(`[conversation-digest] Failed to delete summary segments for conversation ${conversationId}: ${errorValue && errorValue.stack ? errorValue.stack : errorValue}`);
  }
}

export function backfillConversationDigestSummarySegments(store: any, input: any = {}, options: any = {}) {
  if (!store || typeof store.saveSummarySegmentFromDigest !== 'function') {
    throw createHttpError(501, 'Summary segment memory is not available');
  }

  const normalizedConversationId = normalizeText(input.conversationId || input.id);
  const explicitTaskName = normalizeText(input.taskName || input.summaryMemoryTaskName || options.taskName || options.summaryMemoryTaskName);
  const timestamp = nowIso();

  // P0 OOM fix: process one lightweight conversation projection at a time.
  // Global mode iterates conversation headers immediately; scoped mode uses
  // getConversationWithoutMessages(). No path reads message history and no
  // fully hydrated conversation is accumulated for the request.
  let conversationCount = 0;
  let digestCount = 0;
  let segmentCount = 0;
  let failedCount = 0;
  const failures = [] as any[];

  const backfillConversation = (conversation: any) => {
    conversationCount += 1;
    const digests = getConversationDigests(conversation);
    digestCount += digests.length;

    for (const digest of digests) {
      try {
        const syncOptions = {
          ...options,
          taskName: explicitTaskName,
          resolveSummaryMemoryTaskName: explicitTaskName ? undefined : options.resolveSummaryMemoryTaskName,
        };
        const segment = store.saveSummarySegmentFromDigest(conversation && conversation.id, digest, {
          updatedAt: timestamp,
          taskName: resolveSummarySegmentTaskName(syncOptions, conversation, digest),
          metadata: {
            source: 'conversation_digest',
            trigger: 'metadata-backfill',
          },
        });

        if (segment) {
          segmentCount += 1;
        }
      } catch (error) {
        const errorValue = error as any;
        const message = errorValue && errorValue.message ? errorValue.message : String(errorValue || 'Unknown backfill error');
        failedCount += 1;
        console.warn(`[conversation-digest] Failed to backfill summary segment for digest ${digest && digest.id ? digest.id : 'unknown'}: ${errorValue && errorValue.stack ? errorValue.stack : errorValue}`);

        if (failures.length < MAX_BACKFILL_DIAGNOSTIC_ITEMS) {
          failures.push({
            conversationId: normalizeText(conversation && conversation.id),
            conversationTitle: clipText(conversation && conversation.title, MAX_DIGEST_ITEM_LENGTH),
            digestId: normalizeText(digest && digest.id),
            kind: normalizeDigestKind(digest && digest.kind),
            reason: 'sync_failed',
            message: clipText(message, MAX_DIGEST_ITEM_LENGTH),
          });
        }
      }
    }
  };

  if (normalizedConversationId) {
    // Fail closed: a store without the no-message projection must never fall
    // back to getConversation() (full message hydration). Real ChatAppStore
    // always provides the projection; missing it is a store-shape error.
    if (typeof store.getConversationWithoutMessages !== 'function') {
      throw createHttpError(501, 'Summary segment memory is not available');
    }
    const conversation = store.getConversationWithoutMessages(normalizedConversationId);

    if (!conversation) {
      throw createHttpError(404, 'Conversation not found');
    }

    backfillConversation(conversation);
  } else if (typeof store.listConversations === 'function') {
    for (const header of store.listConversations()) {
      if (header && normalizeText(header.id)) {
        backfillConversation(header);
      }
    }
  }

  return {
    conversationCount,
    digestCount,
    segmentCount,
    failedCount,
    failures,
  };
}

function digestAutoCreateEnabled(options: any = {}) {
  return normalizeBooleanSetting(
    options.autoCreate !== undefined ? options.autoCreate : options.autoCreateEnabled !== undefined ? options.autoCreateEnabled : process.env.CAFF_DIGEST_AUTO_CREATE,
    false
  );
}

function digestAutoCreateMessageBudget(options: any = {}) {
  return Math.max(1, resolveIntegerSetting(
    options.autoCreateMessageBudget,
    process.env.CAFF_DIGEST_AUTO_CREATE_MESSAGE_BUDGET,
    DEFAULT_DIGEST_AUTO_CREATE_MESSAGE_BUDGET,
    'digestAutoCreateMessageBudget'
  ));
}

function digestAutoIdleMs(options: any = {}) {
  return Math.max(0, resolveIntegerSetting(
    options.autoCreateIdleMs,
    process.env.CAFF_DIGEST_AUTO_IDLE_MS,
    DEFAULT_DIGEST_AUTO_IDLE_MS,
    'digestAutoIdleMs'
  ));
}

function digestAutoCooldownMs(options: any = {}) {
  return Math.max(0, resolveIntegerSetting(
    options.autoCreateCooldownMs,
    process.env.CAFF_DIGEST_AUTO_COOLDOWN_MS,
    DEFAULT_DIGEST_AUTO_COOLDOWN_MS,
    'digestAutoCooldownMs'
  ));
}

function digestAutoHighValueEnabled(options: any = {}) {
  return normalizeBooleanSetting(
    options.autoCreateHighValue !== undefined ? options.autoCreateHighValue : process.env.CAFF_DIGEST_AUTO_HIGH_VALUE,
    DEFAULT_DIGEST_AUTO_HIGH_VALUE
  );
}

function digestAutoHighValueMinMessages(options: any = {}, messageBudget = DEFAULT_DIGEST_AUTO_CREATE_MESSAGE_BUDGET) {
  return Math.max(1, resolveIntegerSetting(
    options.autoCreateHighValueMinMessages,
    process.env.CAFF_DIGEST_AUTO_HIGH_VALUE_MIN_MESSAGES,
    Math.min(messageBudget, DEFAULT_DIGEST_AUTO_HIGH_VALUE_MIN_MESSAGES),
    'digestAutoHighValueMinMessages'
  ));
}

function latestDigestCoverageBoundary(conversation: any) {
  const digests = getConversationDigests(conversation);

  for (let index = digests.length - 1; index >= 0; index -= 1) {
    const digest = digests[index];
    const toMessageId = normalizeText(digest && digest.messageRange && digest.messageRange.toMessageId);

    if (toMessageId) {
      return {
        messageId: toMessageId,
        digestTimestampMs: normalizeTimestampMs(digest.updatedAt || digest.createdAt),
      };
    }
  }

  return {
    messageId: '',
    digestTimestampMs: 0,
  };
}

export function getConversationDigestCoverage(messages: any[], conversation: any) {
  const publicMessages = (Array.isArray(messages) ? messages : []).filter((message: any) => normalizeMessage(message));
  const latestBoundary = latestDigestCoverageBoundary(conversation);

  if (!latestBoundary.messageId) {
    return {
      boundary: latestBoundary,
      coveredMessageIds: [] as string[],
      pendingMessages: publicMessages,
    };
  }

  const latestIndex = publicMessages.findIndex((message: any) => normalizeText(message.id) === latestBoundary.messageId);
  if (latestIndex !== -1) {
    return {
      boundary: latestBoundary,
      coveredMessageIds: publicMessages.slice(0, latestIndex + 1).map((message: any) => normalizeText(message.id)).filter(Boolean),
      pendingMessages: publicMessages.slice(latestIndex + 1),
    };
  }

  if (latestBoundary.digestTimestampMs <= 0) {
    return {
      boundary: latestBoundary,
      coveredMessageIds: publicMessages.map((message: any) => normalizeText(message.id)).filter(Boolean),
      pendingMessages: [],
    };
  }

  const coveredMessageIds: string[] = [];
  const pendingMessages: any[] = [];
  for (const message of publicMessages) {
    const messageTimestampMs = normalizeTimestampMs(message && message.createdAt);
    if (messageTimestampMs > latestBoundary.digestTimestampMs) {
      pendingMessages.push(message);
    } else {
      const messageId = normalizeText(message && message.id);
      if (messageId) {
        coveredMessageIds.push(messageId);
      }
    }
  }

  return { boundary: latestBoundary, coveredMessageIds, pendingMessages };
}

export function isConversationMessageCoveredByLatestDigest(
  message: any,
  conversation: any,
  boundaryMessage: any = null
) {
  const boundary = latestDigestCoverageBoundary(conversation);
  if (!boundary.messageId) {
    return false;
  }

  const messageId = normalizeText(message && message.id);
  const normalizedBoundaryMessageId = normalizeText(boundaryMessage && boundaryMessage.id);
  if (normalizedBoundaryMessageId === boundary.messageId) {
    const messageTimestampMs = normalizeTimestampMs(message && message.createdAt);
    const boundaryTimestampMs = normalizeTimestampMs(boundaryMessage && boundaryMessage.createdAt);
    if (messageTimestampMs > 0 && boundaryTimestampMs > 0) {
      return messageTimestampMs < boundaryTimestampMs
        || (messageTimestampMs === boundaryTimestampMs && messageId <= boundary.messageId);
    }
    return messageId === boundary.messageId;
  }

  if (boundary.digestTimestampMs <= 0) {
    return true;
  }

  return normalizeTimestampMs(message && message.createdAt) <= boundary.digestTimestampMs;
}

function messagesSinceLatestDigest(messages: any[], conversation: any) {
  return getConversationDigestCoverage(messages, conversation).pendingMessages;
}

function estimatePendingTokens(messages: any[]) {
  const characterCount = messages.reduce((total: number, message: any) => {
    return total + normalizeText(message && (message.content || message.errorMessage)).length;
  }, 0);
  return Math.max(0, Math.ceil(characterCount / 4));
}

function detectDigestSignalFlags(messages: any[]) {
  const combinedText = messages
    .map((message: any) => normalizeText(message && (message.content || message.errorMessage)))
    .join('\n')
    .toLowerCase();
  const fileArtifact = /(?:[\w.-]+\/)+[\w.-]+|[\w.-]+\.(?:ts|js|json|md|css|html|py|sqlite|yaml|yml)|配置|接口|测试|构建|typecheck|build/u.test(combinedText);
  const codeChange = /\bpr\b|pull request|commit|merge|diff|提交|合并|补丁|已实现|实现完成|已修复|测试通过|构建通过|typecheck passed|build passed/u.test(combinedText);

  return {
    decision: /决定|结论|确认|采用|同意|decision|decided|agreed|confirmed/u.test(combinedText),
    code: codeChange,
    codeChange,
    fileArtifact,
    errorFix: /修复|报错|错误|异常|失败|bug|fix|error|failed|failure/u.test(combinedText),
  };
}

function latestMessageTimestampMs(messages: any[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const timestampMs = normalizeTimestampMs(messages[index] && messages[index].createdAt);

    if (timestampMs > 0) {
      return timestampMs;
    }
  }

  return 0;
}

function buildDigestStateSnapshot(conversation: any, sourceMessages: any[], timestamp: string, overrides: any = {}) {
  const previousState = getConversationDigestState(conversation);
  return {
    ...previousState,
    pendingPublicMessageCount: sourceMessages.length,
    pendingTokenEstimate: estimatePendingTokens(sourceMessages),
    signalFlags: detectDigestSignalFlags(sourceMessages),
    updatedAt: timestamp,
    ...overrides,
  };
}

function digestStateChanged(previousState: any, nextState: any) {
  const previous = normalizeDigestState(previousState);
  const next = normalizeDigestState(nextState);
  const keys = [
    'lastDigestMessageId',
    'lastDigestAt',
    'lastAutoDigestAt',
    'pendingPublicMessageCount',
    'pendingTokenEstimate',
    'messageBudget',
    'highValueMinMessages',
    'lastTriggerReason',
    'lastFailure',
  ];

  for (const key of keys) {
    if ((previous as Record<string, any>)[key] !== (next as Record<string, any>)[key]) {
      return true;
    }
  }

  return previous.signalFlags.decision !== next.signalFlags.decision
    || previous.signalFlags.code !== next.signalFlags.code
    || previous.signalFlags.codeChange !== next.signalFlags.codeChange
    || previous.signalFlags.fileArtifact !== next.signalFlags.fileArtifact
    || previous.signalFlags.errorFix !== next.signalFlags.errorFix;
}

function updateDigestStateMetadata(store: any, conversation: any, state: any) {
  return updateConversationMetadata(store, conversation, buildMetadataWithDigestState(conversation, state));
}

function clearDigestStateAfterCreate(conversation: any, digest: any, timestamp: string, overrides: any = {}) {
  return buildDigestStateSnapshot(conversation, [], timestamp, {
    lastDigestMessageId: normalizeText(digest && digest.messageRange && digest.messageRange.toMessageId),
    lastDigestAt: timestamp,
    pendingPublicMessageCount: 0,
    pendingTokenEstimate: 0,
    signalFlags: normalizeSignalFlags({}),
    lastFailure: '',
    ...overrides,
  });
}

function autoDigestCooldownRemainingMs(state: any, timestamp: string, cooldownMs: number) {
  if (cooldownMs <= 0) {
    return 0;
  }

  const lastAutoDigestMs = normalizeTimestampMs(state && state.lastAutoDigestAt);
  const nowMs = normalizeTimestampMs(timestamp) || Date.now();

  if (lastAutoDigestMs <= 0 || nowMs <= lastAutoDigestMs) {
    return 0;
  }

  return Math.max(0, cooldownMs - (nowMs - lastAutoDigestMs));
}

function autoDigestIdleRemainingMs(sourceMessages: any[], timestamp: string, idleMs: number) {
  if (idleMs <= 0 || sourceMessages.length === 0) {
    return 0;
  }

  const latestMessageMs = latestMessageTimestampMs(sourceMessages);
  const nowMs = normalizeTimestampMs(timestamp) || Date.now();

  if (latestMessageMs <= 0 || nowMs <= latestMessageMs) {
    return idleMs;
  }

  return Math.max(0, idleMs - (nowMs - latestMessageMs));
}

function titleRefineEnabled(options: any = {}) {
  return normalizeBooleanSetting(
    options.autoTitleRefine !== undefined ? options.autoTitleRefine : process.env.CAFF_DIGEST_AUTO_TITLE_REFINE,
    true
  );
}

function hasTitleRefineModelConfig(options: any = {}) {
  return Boolean(
    typeof options.titleModelRunner === 'function'
      || typeof options.digestModelRunner === 'function'
      || hasExplicitDigestModelConfig({}, options)
      || normalizeText(process.env.PI_MODEL)
      || normalizeText(process.env.PI_PROVIDER)
  );
}

function normalizeRefinedTitle(value: any) {
  const firstLine = normalizeText(value)
    .replace(/^```[a-z]*\s*/iu, '')
    .replace(/```$/u, '')
    .split(/\r?\n/u)[0] || '';
  const text = normalizeText(firstLine)
    .replace(/^(?:title|标题)\s*[:：]\s*/iu, '')
    .replace(/^["'“”‘’「」『』《》\s]+|["'“”‘’「」『』《》\s。.,!！?？:：;；]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();

  if (!text) {
    return '';
  }

  return text.length > MAX_REFINED_TITLE_LENGTH
    ? text.slice(0, MAX_REFINED_TITLE_LENGTH).trimEnd()
    : text;
}

function buildTitleRefinePrompt(normalizedMessages: any[]) {
  const sourceMessages = normalizedMessages.slice(0, MAX_TITLE_REFINE_SOURCE_MESSAGES).map((message: any, index: number) => ({
    index: index + 1,
    role: message.role,
    speaker: message.speaker,
    content: clipText(message.content, MAX_TITLE_REFINE_MESSAGE_LENGTH),
  }));

  return [
    'You are CAFF conversation title writer.',
    'Generate a short title for the conversation based on its first public messages.',
    'Requirements: 5-15 characters; match the conversation language; no quotes, no "Title:" prefix, no trailing punctuation; output only the title text on a single line.',
    '',
    'Public messages JSON:',
    JSON.stringify(sourceMessages, null, 2),
  ].join('\n');
}

function titleRefineAllowedForConversation(conversation: any) {
  const metadata = currentMetadata(conversation);
  const source = readConversationTitleSource(metadata);

  if (source !== TITLE_SOURCE_DEFAULT && source !== TITLE_SOURCE_AUTO_FIRST_MESSAGE) {
    return false;
  }

  return !normalizeText(metadata[TITLE_REFINED_AT_METADATA_KEY]);
}

async function maybeRefineConversationTitle(store: any, conversation: any, sourceMessages: any[], timestamp: string, options: any = {}) {
  if (!store || !conversation || !titleRefineEnabled(options) || !hasTitleRefineModelConfig(options)) {
    return null;
  }

  if (!titleRefineAllowedForConversation(conversation)) {
    return null;
  }

  const normalizedMessages = sourceMessages
    .map((message: any) => normalizeMessageWithLimit(message, MAX_TITLE_REFINE_MESSAGE_LENGTH))
    .filter(Boolean) as any[];

  if (normalizedMessages.length === 0) {
    return null;
  }

  try {
    const titleTimeoutMs = resolveIntegerSetting(
      options.titleRefineTimeoutMs,
      process.env.CAFF_TITLE_REFINE_TIMEOUT_MS,
      DEFAULT_TITLE_REFINE_TIMEOUT_MS,
      'titleRefineTimeoutMs'
    );
    const config = resolveDigestModelConfig({}, { ...options, heartbeatTimeoutMs: titleTimeoutMs });
    const runnerOptions = {
      ...options,
      digestModelRunner: typeof options.titleModelRunner === 'function' ? options.titleModelRunner : options.digestModelRunner,
      purpose: 'title_refine',
      conversationId: normalizeText(conversation.id),
    };
    const output = await runDigestModelPrompt(buildTitleRefinePrompt(normalizedMessages), config, runnerOptions);
    const title = normalizeRefinedTitle(output);

    if (!title) {
      return null;
    }

    const latestConversation = typeof store.getConversation === 'function'
      ? store.getConversation(conversation.id) || conversation
      : conversation;

    // 写入前复核最新 titleSource：模型调用期间用户可能已手动改名（manual 终态）。
    if (!titleRefineAllowedForConversation(latestConversation)) {
      return null;
    }

    const updated = store.updateConversation(conversation.id, {
      title,
      titleSource: TITLE_SOURCE_AUTO_LLM,
      metadata: {
        ...currentMetadata(latestConversation),
        [TITLE_REFINED_AT_METADATA_KEY]: timestamp,
      },
    });

    return updated || null;
  } catch (error) {
    const errorValue = error as any;
    console.warn(`[conversation-digest] Title refine failed, keeping existing title: ${errorValue && errorValue.message ? errorValue.message : String(errorValue || 'Unknown error')}`);
    return null;
  }
}

export function recomputeConversationDigestState(store: any, conversationId: any, options: any = {}) {
  const normalizedConversationId = normalizeText(conversationId);
  const conversation = store.getConversation(normalizedConversationId);

  if (!conversation) {
    throw createHttpError(404, 'Conversation not found');
  }

  const timestamp = nowIso();
  const messages = typeof store.listMessages === 'function' ? store.listMessages(normalizedConversationId) : [];
  const sourceMessages = messagesSinceLatestDigest(messages, conversation);
  const messageBudget = digestAutoCreateMessageBudget(options);
  const highValueMinMessages = digestAutoHighValueMinMessages(options, messageBudget);
  const previousState = getConversationDigestState(conversation);
  const state = buildDigestStateSnapshot(conversation, sourceMessages, timestamp, {
    messageBudget,
    highValueMinMessages,
  });
  const stateChanged = digestStateChanged(previousState, state);
  const stateConversation = stateChanged ? updateDigestStateMetadata(store, conversation, state) : conversation;

  return {
    conversation: stateConversation,
    highValueMinMessages,
    messageBudget,
    sourceMessages,
    state,
    stateChanged,
    timestamp,
  };
}

export async function maybeAutoCreateConversationDigest(store: any, conversationId: any, options: any = {}) {
  const normalizedConversationId = normalizeText(conversationId);
  const conversation = store.getConversation(normalizedConversationId);

  if (!conversation) {
    throw createHttpError(404, 'Conversation not found');
  }

  if (!digestAutoCreateEnabled(options)) {
    return responseForConversation(conversation, {
      autoCreated: false,
      reason: 'disabled',
    });
  }

  const recomputed = recomputeConversationDigestState(store, normalizedConversationId, options);
  const {
    conversation: stateConversation,
    highValueMinMessages,
    messageBudget,
    sourceMessages,
    state,
    stateChanged,
    timestamp,
  } = recomputed;
  const pendingExperienceDrafts = getPendingConversationExperienceDrafts(stateConversation);
  const pendingExperienceTriggered = pendingExperienceDrafts.length > 0 && sourceMessages.length > 0;
  const highValueTriggered = digestAutoHighValueEnabled(options)
    && sourceMessages.length >= highValueMinMessages
    && anySignalFlag(state.signalFlags);
  const budgetReached = sourceMessages.length >= messageBudget;
  const triggerReason = pendingExperienceTriggered && !budgetReached
    ? 'pending_experience'
    : highValueTriggered && !budgetReached
      ? 'high_value_signal'
      : 'message_budget';

  if (!budgetReached && !highValueTriggered && !pendingExperienceTriggered) {
    return responseForConversation(stateConversation, {
      autoCreated: false,
      reason: 'below_budget',
      stateChanged,
      pendingMessageCount: sourceMessages.length,
      pendingTokenEstimate: state.pendingTokenEstimate,
      signalFlags: state.signalFlags,
      messageBudget,
      highValueMinMessages,
    });
  }

  const cooldownMs = digestAutoCooldownMs(options);
  const cooldownRemainingMs = pendingExperienceTriggered ? 0 : autoDigestCooldownRemainingMs(state, timestamp, cooldownMs);

  if (cooldownRemainingMs > 0) {
    return responseForConversation(stateConversation, {
      autoCreated: false,
      reason: 'cooldown',
      stateChanged,
      pendingMessageCount: sourceMessages.length,
      pendingTokenEstimate: state.pendingTokenEstimate,
      signalFlags: state.signalFlags,
      messageBudget,
      retryAfterMs: cooldownRemainingMs,
      triggerReason,
    });
  }

  const idleMs = digestAutoIdleMs(options);
  const idleRemainingMs = pendingExperienceTriggered ? 0 : autoDigestIdleRemainingMs(sourceMessages, timestamp, idleMs);

  if (idleRemainingMs > 0) {
    return responseForConversation(stateConversation, {
      autoCreated: false,
      reason: 'idle_wait',
      stateChanged,
      pendingMessageCount: sourceMessages.length,
      pendingTokenEstimate: state.pendingTokenEstimate,
      signalFlags: state.signalFlags,
      messageBudget,
      retryAfterMs: idleRemainingMs,
      triggerReason,
    });
  }

  const digestExperience = experienceDraftsForDigest(pendingExperienceDrafts);
  const input = {
    action: 'create',
    ...(isPlainObject(options.autoCreateInput) ? options.autoCreateInput : {}),
    ...(digestExperience.length > 0 ? { experience: digestExperience } : {}),
    autoCreated: true,
    triggerReason,
  };
  const digestOptions = {
    ...options,
    conversationId: normalizedConversationId,
  };
  const digest = await buildDigestFromMessages(sourceMessages, input, timestamp, digestOptions);
  if (!digest) {
    throw createHttpError(400, 'Conversation digest could not be generated');
  }

  const latestConversation = store.getConversation(normalizedConversationId) || stateConversation;
  const digestsBeforeCreate = getConversationDigests(latestConversation);
  const compactResult = await compactDigestEntries([...digestsBeforeCreate, digest], timestamp, {
    ...digestOptions,
    input,
  });
  const stateAfterCreate = clearDigestStateAfterCreate(latestConversation, digest, timestamp, {
    lastAutoDigestAt: timestamp,
    lastTriggerReason: triggerReason,
  });
  const metadataWithDigests = buildMetadataWithDigests(latestConversation, compactResult.digests);
  const absorbedMetadata = absorbExperienceDraftsInMetadata(
    { ...latestConversation, metadata: metadataWithDigests },
    digestExperience.map((item: any) => item.sourceDraftId),
    digest.id,
    timestamp
  );
  const nextConversation = updateConversationMetadata(
    store,
    latestConversation,
    buildMetadataWithDigestState({ ...latestConversation, metadata: absorbedMetadata }, stateAfterCreate)
  );
  syncSummarySegmentFromDigest(store, nextConversation, digest, timestamp, { trigger: 'auto-create' }, options);
  syncSummarySegmentFromDigest(store, nextConversation, compactResult.rollup, timestamp, { trigger: 'auto-compaction' }, options);
  deleteSummarySegmentsForDigests(store, compactResult.obsoleteDigestIds);

  // 首次成功生成 digest 时，用同一模型链路精炼一次标题（失败静默兜底，不影响主流程）。
  let resultConversation = nextConversation;
  if (digestsBeforeCreate.length === 0) {
    const refinedConversation = await maybeRefineConversationTitle(store, nextConversation, sourceMessages, timestamp, digestOptions);
    if (refinedConversation) {
      resultConversation = refinedConversation;
    }
  }

  return responseForConversation(resultConversation, {
    digest,
    rollup: compactResult.rollup,
    compacted: compactResult.compacted,
    digestChanged: true,
    stateChanged: true,
    autoCreated: true,
    pendingMessageCount: sourceMessages.length,
    pendingTokenEstimate: state.pendingTokenEstimate,
    signalFlags: state.signalFlags,
    messageBudget,
    triggerReason,
  });
}

export async function applyConversationDigestAction(store: any, conversationId: any, input: any = {}, options: any = {}) {
  const normalizedConversationId = normalizeText(conversationId);
  const conversation = store.getConversation(normalizedConversationId);

  if (!conversation) {
    throw createHttpError(404, 'Conversation not found');
  }

  const action = normalizeText(input.action).toLowerCase() || 'get';

  if (!CONVERSATION_DIGEST_ACTIONS.has(action)) {
    throw createHttpError(400, 'Unsupported digest action');
  }

  const overrideField = DIGEST_MODEL_OVERRIDE_FIELDS.find((field) => (
    Object.prototype.hasOwnProperty.call(input, field)
  ));
  if (overrideField) {
    throw createHttpError(400, 'Digest model selection is managed by the system service configuration', {
      code: 'conversation_digest_model_override_not_allowed',
      field: overrideField,
      issues: [{
        code: 'conversation_digest_model_override_not_allowed',
        path: `body.${overrideField}`,
      }],
    });
  }

  if (action === 'get') {
    return responseForConversation(conversation);
  }

  if (action === 'clear') {
    deleteSummarySegmentsForConversation(store, normalizedConversationId);
    const nextConversation = updateConversationMetadata(store, conversation, buildMetadataWithDigests(conversation, []));
    return responseForConversation(nextConversation, {
      deleted: true,
      digestChanged: true,
    });
  }

  if (action === 'delete') {
    const digestId = normalizeText(input.digestId || input.id);

    if (!digestId) {
      throw createHttpError(400, 'Digest id is required');
    }

    const existingDigests = getConversationDigests(conversation);
    const nextDigests = existingDigests.filter((digest: any) => digest.id !== digestId);

    if (nextDigests.length === existingDigests.length) {
      throw createHttpError(404, 'Conversation digest not found');
    }

    deleteSummarySegmentForDigest(store, digestId);
    const nextConversation = updateConversationMetadata(store, conversation, buildMetadataWithDigests(conversation, nextDigests));
    return responseForConversation(nextConversation, {
      deleted: true,
      digestChanged: true,
    });
  }

  if (action === 'compact') {
    const compactResult = await compactDigestEntries(getConversationDigests(conversation), nowIso(), {
      ...options,
      conversationId: normalizedConversationId,
      input,
      recentEntryBudget: 1,
    });

    if (!compactResult.compacted) {
      return responseForConversation(conversation, {
        rollup: compactResult.rollup,
      });
    }

    const compactedAt = nowIso();
    const nextConversation = updateConversationMetadata(store, conversation, buildMetadataWithDigests(conversation, compactResult.digests));
    syncSummarySegmentFromDigest(store, nextConversation, compactResult.rollup, compactedAt, { trigger: 'manual-compaction' }, options);
    deleteSummarySegmentsForDigests(store, compactResult.obsoleteDigestIds);
    return responseForConversation(nextConversation, {
      rollup: compactResult.rollup,
      compacted: true,
      digestChanged: true,
    });
  }

  const timestamp = nowIso();
  const messages = typeof store.listMessages === 'function' ? store.listMessages(normalizedConversationId) : [];
  const pendingExperienceDrafts = getPendingConversationExperienceDrafts(conversation);
  const digestExperience = experienceDraftsForDigest(pendingExperienceDrafts);
  const digestInput = {
    ...input,
    ...(digestExperience.length > 0 && !Object.prototype.hasOwnProperty.call(input, 'experience') ? { experience: digestExperience } : {}),
    triggerReason: normalizeText(input.triggerReason) || 'manual',
  };
  const digestOptions = {
    ...options,
    conversationId: normalizedConversationId,
  };
  const digest = await buildDigestFromMessages(messages, digestInput, timestamp, digestOptions);
  if (!digest) {
    throw createHttpError(400, 'Conversation digest could not be generated');
  }

  const compactResult = await compactDigestEntries([...getConversationDigests(conversation), digest], timestamp, {
    ...digestOptions,
    input: digestInput,
  });
  const stateAfterCreate = clearDigestStateAfterCreate(conversation, digest, timestamp, {
    lastTriggerReason: digestInput.triggerReason,
  });
  const metadataWithDigests = buildMetadataWithDigests(conversation, compactResult.digests);
  const absorbedMetadata = absorbExperienceDraftsInMetadata(
    { ...conversation, metadata: metadataWithDigests },
    digestExperience.map((item: any) => item.sourceDraftId),
    digest.id,
    timestamp
  );
  const nextConversation = updateConversationMetadata(
    store,
    conversation,
    buildMetadataWithDigestState({ ...conversation, metadata: absorbedMetadata }, stateAfterCreate)
  );
  syncSummarySegmentFromDigest(store, nextConversation, digest, timestamp, { trigger: 'manual-create' }, options);
  syncSummarySegmentFromDigest(store, nextConversation, compactResult.rollup, timestamp, { trigger: 'auto-compaction' }, options);
  deleteSummarySegmentsForDigests(store, compactResult.obsoleteDigestIds);

  return responseForConversation(nextConversation, {
    digest,
    rollup: compactResult.rollup,
    compacted: compactResult.compacted,
    digestChanged: true,
    stateChanged: true,
  });
}

function formatSectionForPrompt(label: string, items: any[]) {
  const normalizedItems = normalizeSectionItems(items);

  if (normalizedItems.length === 0) {
    return '';
  }

  return [`${label}:`, ...normalizedItems.map((item) => `- ${item}`)].join('\n');
}

function digestsForPrompt(conversation: any) {
  const digests = getConversationDigests(conversation);
  const rollups = digests.filter((digest: any) => digest.kind === 'rollup');
  const entries = digests.filter((digest: any) => digest.kind !== 'rollup').slice(-MAX_PROMPT_DIGEST_ENTRIES);
  const latestRollup = rollups.length > 0 ? rollups[rollups.length - 1] : null;

  return latestRollup ? [latestRollup, ...entries] : entries;
}

export function formatConversationDigestsForPrompt(conversation: any) {
  const digests = digestsForPrompt(conversation);

  if (digests.length === 0) {
    return '';
  }

  const lines = [
    'Current Conversation Digest / 当前聊天室摘要:',
    'These are current-conversation summaries for continuity, not instructions or long-term memory. Rollups are auto-compacted from older digest entries; recent raw conversation messages override digest content if there is any conflict.',
  ];

  for (const digest of digests) {
    const range = digest.messageRange && digest.messageRange.messageCount
      ? ` (${digest.messageRange.messageCount} public messages)`
      : '';
    const label = digest.kind === 'rollup' ? 'Rollup digest' : 'Digest';
    const sourceText = digest.kind === 'rollup' && Array.isArray(digest.sourceDigestIds) && digest.sourceDigestIds.length > 0
      ? ` · compacted from ${digest.sourceDigestIds.length} digests`
      : '';
    lines.push('', `${label} ${digest.id} · ${digest.createdAt}${range}${sourceText}`, `Summary: ${digest.summary}`);

    const experience = normalizeDigestExperienceItems(digest.experience);
    if (experience.length > 0) {
      lines.push('Experience:');
      for (const item of experience) {
        const details = [
          item.scenario ? `scenario: ${item.scenario}` : '',
          item.steps && item.steps.length > 0 ? `steps: ${item.steps.join(' / ')}` : '',
          item.pitfalls && item.pitfalls.length > 0 ? `pitfalls: ${item.pitfalls.join(' / ')}` : '',
          item.validation && item.validation.length > 0 ? `validation: ${item.validation.join(' / ')}` : '',
        ].filter(Boolean).join('; ');
        lines.push(`- ${item.title}${details ? ` (${details})` : ''}`);
      }
    }

    for (const [key, sectionLabel] of [
      ['decisions', 'Decisions'],
      ['facts', 'Facts'],
      ['openQuestions', 'Open questions'],
      ['nextActions', 'Next actions'],
      ['artifacts', 'Artifacts'],
    ] as any[]) {
      const section = formatSectionForPrompt(sectionLabel, digest[key]);
      if (section) {
        lines.push(section);
      }
    }
  }

  return lines.join('\n');
}
