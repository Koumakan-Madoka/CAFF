import { createHttpError } from '../../http/http-errors';

const CONVERSATION_DIGEST_METADATA_KEY = 'conversationDigests';
const CONVERSATION_DIGEST_ACTIONS = new Set(['get', 'create', 'delete', 'clear']);
const MAX_DIGEST_ENTRIES = 5;
const MAX_PROMPT_DIGEST_ENTRIES = 3;
const MAX_DIGEST_SECTION_ITEMS = 8;
const MAX_DIGEST_ITEM_LENGTH = 240;
const MAX_DIGEST_SUMMARY_LENGTH = 800;
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

function normalizeMessage(message: any) {
  if (!message || message.metadata && message.metadata.digestHidden === true) {
    return null;
  }

  const content = clipText(message.content || message.errorMessage || '', MAX_DIGEST_ITEM_LENGTH);

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

  const messageRange = isPlainObject(value.messageRange) ? value.messageRange : {};
  const normalized: Record<string, any> = {
    id,
    createdAt,
    updatedAt: normalizeText(value.updatedAt || value.updated_at) || createdAt,
    createdBy: normalizeText(value.createdBy || value.created_by) || 'user',
    messageRange: {
      fromMessageId: normalizeText(messageRange.fromMessageId || messageRange.from_message_id),
      toMessageId: normalizeText(messageRange.toMessageId || messageRange.to_message_id),
      messageCount: Math.max(0, Number.parseInt(String(messageRange.messageCount || messageRange.message_count || '0'), 10) || 0),
    },
    summary,
  };

  for (const key of DIGEST_SECTION_KEYS) {
    const items = normalizeSectionItems(value[key]);
    normalized[key] = items;
  }

  return normalized;
}

export function getConversationDigests(conversation: any) {
  const metadata = currentMetadata(conversation);
  const rawDigests = Array.isArray(metadata[CONVERSATION_DIGEST_METADATA_KEY])
    ? metadata[CONVERSATION_DIGEST_METADATA_KEY]
    : [];

  return (rawDigests
    .map(normalizeDigestEntry)
    .filter(Boolean) as any[])
    .slice(-MAX_DIGEST_ENTRIES);
}

function buildMetadataWithDigests(conversation: any, digests: any[]) {
  const metadata = currentMetadata(conversation);
  const normalizedDigests = digests.map(normalizeDigestEntry).filter(Boolean).slice(-MAX_DIGEST_ENTRIES);

  if (normalizedDigests.length === 0) {
    const { [CONVERSATION_DIGEST_METADATA_KEY]: _digests, ...remainingMetadata } = metadata;
    return remainingMetadata;
  }

  return {
    ...metadata,
    [CONVERSATION_DIGEST_METADATA_KEY]: normalizedDigests,
  };
}

function updateConversationMetadata(store: any, conversation: any, metadata: any) {
  return store.updateConversation(conversation.id, {
    title: conversation.title,
    type: conversation.type,
    metadata,
  });
}

function classifyDigestItem(bucket: Record<string, string[]>, item: any) {
  const text = item.content;
  const lower = text.toLowerCase();
  const line = `${item.speaker}: ${text}`;

  if (/决定|结论|确认|采用|decision|decided|agreed/u.test(lower)) {
    bucket.decisions.push(line);
  }

  if (/[?？]|问题|待确认|不确定|open question|question/u.test(lower)) {
    bucket.openQuestions.push(line);
  }

  if (/下一步|todo|待办|需要|建议|实现|添加|验证|run|test|should|next/u.test(lower)) {
    bucket.nextActions.push(line);
  }

  const artifactMatches = text.match(/(?:[\w.-]+\/)+[\w.-]+|[\w.-]+\.(?:ts|js|json|md|css|html|py|sqlite|yaml|yml)/giu) || [];
  for (const artifact of artifactMatches) {
    bucket.artifacts.push(artifact);
  }

  bucket.facts.push(line);
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

function buildDigestFromMessages(messages: any[], input: any, timestamp: string) {
  const normalizedMessages = messages.map(normalizeMessage).filter(Boolean) as any[];

  if (normalizedMessages.length === 0) {
    throw createHttpError(400, 'No public conversation messages are available to digest');
  }

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
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: normalizeText(input && input.createdBy) || 'user',
    messageRange: {
      fromMessageId: firstMessage.id,
      toMessageId: lastMessage.id,
      messageCount: normalizedMessages.length,
    },
    summary,
  };

  for (const key of DIGEST_SECTION_KEYS) {
    const overrideItems = input && Object.prototype.hasOwnProperty.call(input, key)
      ? normalizeSectionItems(input[key])
      : [];
    entry[key] = overrideItems.length > 0 ? overrideItems : uniqueSectionItems(bucket[key]);
  }

  return normalizeDigestEntry(entry);
}

function responseForConversation(conversation: any, overrides: any = {}) {
  return {
    conversation,
    digests: getConversationDigests(conversation),
    digest: null,
    deleted: false,
    digestChanged: false,
    ...overrides,
  };
}

export function applyConversationDigestAction(store: any, conversationId: any, input: any = {}) {
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

    const nextConversation = updateConversationMetadata(store, conversation, buildMetadataWithDigests(conversation, nextDigests));
    return responseForConversation(nextConversation, {
      deleted: true,
      digestChanged: true,
    });
  }

  const messages = typeof store.listMessages === 'function' ? store.listMessages(normalizedConversationId) : [];
  const digest = buildDigestFromMessages(messages, input, nowIso());
  const nextDigests = [...getConversationDigests(conversation), digest].slice(-MAX_DIGEST_ENTRIES);
  const nextConversation = updateConversationMetadata(store, conversation, buildMetadataWithDigests(conversation, nextDigests));

  return responseForConversation(nextConversation, {
    digest,
    digestChanged: true,
  });
}

function formatSectionForPrompt(label: string, items: any[]) {
  const normalizedItems = normalizeSectionItems(items);

  if (normalizedItems.length === 0) {
    return '';
  }

  return [`${label}:`, ...normalizedItems.map((item) => `- ${item}`)].join('\n');
}

export function formatConversationDigestsForPrompt(conversation: any) {
  const digests = getConversationDigests(conversation).slice(-MAX_PROMPT_DIGEST_ENTRIES);

  if (digests.length === 0) {
    return '';
  }

  const lines = [
    'Conversation digest memory:',
    'These are historical summaries created by explicit user action. Use them for continuity, but recent raw conversation messages override digest content if there is any conflict.',
  ];

  for (const digest of digests) {
    const range = digest.messageRange && digest.messageRange.messageCount
      ? ` (${digest.messageRange.messageCount} public messages)`
      : '';
    lines.push('', `Digest ${digest.id} · ${digest.createdAt}${range}`, `Summary: ${digest.summary}`);

    for (const [key, label] of [
      ['decisions', 'Decisions'],
      ['facts', 'Facts'],
      ['openQuestions', 'Open questions'],
      ['nextActions', 'Next actions'],
      ['artifacts', 'Artifacts'],
    ] as any[]) {
      const section = formatSectionForPrompt(label, digest[key]);
      if (section) {
        lines.push(section);
      }
    }
  }

  return lines.join('\n');
}
