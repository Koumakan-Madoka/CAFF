import { createHttpError } from '../../http/http-errors';
import { DEFAULT_AGENT_DIR, DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_THINKING, invoke, resolveIntegerSetting, resolveSetting, resolveThinkingSetting } from '../../../lib/minimal-pi';

const CONVERSATION_DIGEST_METADATA_KEY = 'conversationDigests';
const CONVERSATION_DIGEST_STATE_METADATA_KEY = 'conversationDigestState';
const CONVERSATION_DIGEST_ACTIONS = new Set(['get', 'create', 'delete', 'clear', 'compact']);
const MAX_RECENT_DIGEST_ENTRIES = 3;
const MAX_DIGEST_METADATA_ITEMS = 12;
const MAX_PROMPT_DIGEST_ENTRIES = 3;
const MAX_DIGEST_SECTION_ITEMS = 8;
const MAX_DIGEST_ITEM_LENGTH = 240;
const MAX_DIGEST_SUMMARY_LENGTH = 800;
const MAX_DIGEST_SOURCE_IDS = 24;
const MAX_DIGEST_MODEL_MESSAGES = 80;
const MAX_DIGEST_MODEL_MESSAGE_LENGTH = 1000;
const DEFAULT_DIGEST_MODEL_TIMEOUT_MS = 90 * 1000;
const DEFAULT_DIGEST_AUTO_CREATE_MESSAGE_BUDGET = 24;
const DEFAULT_DIGEST_AUTO_IDLE_MS = 0;
const DEFAULT_DIGEST_AUTO_COOLDOWN_MS = 0;
const DEFAULT_DIGEST_AUTO_HIGH_VALUE = false;
const DEFAULT_DIGEST_AUTO_HIGH_VALUE_MIN_MESSAGES = 12;
const MAX_BACKFILL_DIAGNOSTIC_ITEMS = 10;
const DIGEST_SECTION_KEYS = ['facts', 'decisions', 'openQuestions', 'nextActions', 'artifacts'];

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
  return store.updateConversation(conversation.id, {
    title: conversation.title,
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

function digestSummaryMode(input: any, options: any = {}) {
  return normalizeText(
    input && (input.summaryMode || input.digestMode || input.mode)
      || options.summaryMode
      || process.env.CAFF_DIGEST_SUMMARY_MODE
      || ''
  ).toLowerCase();
}

function hasExplicitDigestModelConfig(input: any, options: any = {}) {
  return Boolean(
    normalizeText(input && input.provider)
    || normalizeText(input && input.model)
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

function resolveDigestModelConfig(input: any, options: any = {}) {
  const provider = resolveSetting(
    input && input.provider,
    options.provider || process.env.CAFF_DIGEST_PROVIDER || process.env.PI_PROVIDER,
    DEFAULT_PROVIDER
  );
  const model = resolveSetting(
    input && input.model,
    options.model || process.env.CAFF_DIGEST_MODEL || process.env.PI_MODEL,
    DEFAULT_MODEL
  );
  const thinking = resolveThinkingSetting(
    provider,
    input && input.thinking,
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

function buildModelDigestPrompt(normalizedMessages: any[]) {
  const sourceMessages = normalizedMessages.slice(-MAX_DIGEST_MODEL_MESSAGES).map((message: any, index: number) => ({
    index: index + 1,
    id: message.id,
    role: message.role,
    speaker: message.speaker,
    createdAt: message.createdAt,
    content: message.content,
  }));

  return [
    'You are CAFF conversation digest writer.',
    'Summarize the provided public chat messages into bounded long-term memory for future agents.',
    'Do not invent facts. Facts must be user-stated facts, explicit tool/results evidence, or verified code/test outcomes; never promote agent speculation into facts.',
    'Decisions must be user-confirmed or already implemented. Put unconfirmed agent proposals in openQuestions or nextActions, not facts.',
    'Return ONLY valid compact JSON with this exact shape:',
    '{"summary":"string","facts":["string"],"decisions":["string"],"openQuestions":["string"],"nextActions":["string"],"artifacts":["string"]}',
    'Limits: summary <= 800 characters; each array <= 8 items; each item <= 240 characters.',
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
  }));

  return [
    'You are CAFF conversation digest rollup writer.',
    'Merge older digest entries into one bounded historical rollup for future agents.',
    'Keep stable history and unresolved work. Remove duplicates. Do not invent facts or promote unconfirmed agent speculation.',
    'If source digests conflict, keep the conflict in openQuestions instead of choosing a winner.',
    'Return ONLY valid compact JSON with this exact shape:',
    '{"summary":"string","facts":["string"],"decisions":["string"],"openQuestions":["string"],"nextActions":["string"],"artifacts":["string"]}',
    'Limits: summary <= 800 characters; each array <= 8 items; each item <= 240 characters.',
    '',
    'Source digest entries JSON:',
    JSON.stringify(sourceDigests, null, 2),
  ].join('\n');
}

function parseJsonObjectFromText(value: any) {
  const text = normalizeText(value).replace(/^```(?:json)?\s*/iu, '').replace(/```$/u, '').trim();

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

  if (!normalized.summary) {
    const firstItems = DIGEST_SECTION_KEYS.flatMap((key) => normalized[key]).slice(0, 3);
    normalized.summary = clipText(firstItems.join(' / '), MAX_DIGEST_SUMMARY_LENGTH);
  }

  return normalized.summary ? normalized : null;
}

async function runDigestModelPrompt(prompt: string, config: any, options: any = {}) {
  const runner = typeof options.digestModelRunner === 'function' ? options.digestModelRunner : null;

  if (runner) {
    return runner({ prompt, config, purpose: options.purpose });
  }

  const result = await invoke(config.provider, config.model, prompt, {
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
    },
  });

  return result && result.reply ? result.reply : '';
}

async function generateModelDigestPayload(prompt: string, input: any, options: any = {}) {
  const config = resolveDigestModelConfig(input, options);
  const output = await runDigestModelPrompt(prompt, config, options);
  const normalized = normalizeModelDigestPayload(output);

  if (!normalized) {
    throw new Error('Digest model did not return valid JSON');
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
    const modelPayload = await generateModelDigestPayload(buildModelDigestPrompt(modelMessages), input, {
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
  const conversations = [] as any[];

  if (normalizedConversationId) {
    const conversation = store.getConversation(normalizedConversationId);

    if (!conversation) {
      throw createHttpError(404, 'Conversation not found');
    }

    conversations.push(conversation);
  } else if (typeof store.listConversations === 'function' && typeof store.getConversation === 'function') {
    for (const header of store.listConversations()) {
      const conversationId = normalizeText(header && header.id);
      const conversation = conversationId ? store.getConversation(conversationId) : null;

      if (conversation) {
        conversations.push(conversation);
      }
    }
  }

  let digestCount = 0;
  let segmentCount = 0;
  let failedCount = 0;
  const failures = [] as any[];

  for (const conversation of conversations) {
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
  }

  return {
    conversationCount: conversations.length,
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

function messagesSinceLatestDigest(messages: any[], conversation: any) {
  const publicMessages = messages.filter((message: any) => normalizeMessage(message));
  const latestBoundary = latestDigestCoverageBoundary(conversation);

  if (!latestBoundary.messageId) {
    return publicMessages;
  }

  const latestIndex = publicMessages.findIndex((message: any) => normalizeText(message.id) === latestBoundary.messageId);

  if (latestIndex !== -1) {
    return publicMessages.slice(latestIndex + 1);
  }

  if (latestBoundary.digestTimestampMs <= 0) {
    return [];
  }

  return publicMessages.filter((message: any) => {
    const messageTimestampMs = normalizeTimestampMs(message && message.createdAt);
    return messageTimestampMs > latestBoundary.digestTimestampMs;
  });
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
  const highValueTriggered = digestAutoHighValueEnabled(options)
    && sourceMessages.length >= highValueMinMessages
    && anySignalFlag(state.signalFlags);
  const budgetReached = sourceMessages.length >= messageBudget;
  const triggerReason = highValueTriggered && !budgetReached ? 'high_value_signal' : 'message_budget';

  if (!budgetReached && !highValueTriggered) {
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
  const cooldownRemainingMs = autoDigestCooldownRemainingMs(state, timestamp, cooldownMs);

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
  const idleRemainingMs = autoDigestIdleRemainingMs(sourceMessages, timestamp, idleMs);

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

  const input = {
    action: 'create',
    ...(isPlainObject(options.autoCreateInput) ? options.autoCreateInput : {}),
    autoCreated: true,
    triggerReason,
  };
  const digest = await buildDigestFromMessages(sourceMessages, input, timestamp, options);
  const latestConversation = store.getConversation(normalizedConversationId) || stateConversation;
  const compactResult = await compactDigestEntries([...getConversationDigests(latestConversation), digest], timestamp, {
    ...options,
    input,
  });
  const stateAfterCreate = clearDigestStateAfterCreate(latestConversation, digest, timestamp, {
    lastAutoDigestAt: timestamp,
    lastTriggerReason: triggerReason,
  });
  const metadataWithDigests = buildMetadataWithDigests(latestConversation, compactResult.digests);
  const nextConversation = updateConversationMetadata(
    store,
    latestConversation,
    buildMetadataWithDigestState({ ...latestConversation, metadata: metadataWithDigests }, stateAfterCreate)
  );
  syncSummarySegmentFromDigest(store, nextConversation, digest, timestamp, { trigger: 'auto-create' }, options);
  syncSummarySegmentFromDigest(store, nextConversation, compactResult.rollup, timestamp, { trigger: 'auto-compaction' }, options);
  deleteSummarySegmentsForDigests(store, compactResult.obsoleteDigestIds);

  return responseForConversation(nextConversation, {
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
  const digestInput = {
    ...input,
    triggerReason: normalizeText(input.triggerReason) || 'manual',
  };
  const digest = await buildDigestFromMessages(messages, digestInput, timestamp, options);
  const compactResult = await compactDigestEntries([...getConversationDigests(conversation), digest], timestamp, {
    ...options,
    input: digestInput,
  });
  const stateAfterCreate = clearDigestStateAfterCreate(conversation, digest, timestamp, {
    lastTriggerReason: digestInput.triggerReason,
  });
  const metadataWithDigests = buildMetadataWithDigests(conversation, compactResult.digests);
  const nextConversation = updateConversationMetadata(
    store,
    conversation,
    buildMetadataWithDigestState({ ...conversation, metadata: metadataWithDigests }, stateAfterCreate)
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
    'Conversation digest memory:',
    'These are historical summaries. Rollups are auto-compacted from older digest entries; recent raw conversation messages override digest content if there is any conflict.',
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
