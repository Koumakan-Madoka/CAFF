import { projectMessageForTransport } from '../../../lib/message-detail-contract';
import { createHttpError } from '../../http/http-errors';

export const DEFAULT_CONVERSATION_MESSAGE_PAGE_LIMIT = 50;
export const MAX_CONVERSATION_MESSAGE_PAGE_LIMIT = 100;

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 2048;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function parsePageLimit(value: string | null) {
  if (value === null || value === '') {
    return DEFAULT_CONVERSATION_MESSAGE_PAGE_LIMIT;
  }

  if (!/^\d+$/.test(value)) {
    throw createHttpError(400, 'Message page limit must be a whole number');
  }

  const limit = Number(value);

  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CONVERSATION_MESSAGE_PAGE_LIMIT) {
    throw createHttpError(
      400,
      `Message page limit must be between 1 and ${MAX_CONVERSATION_MESSAGE_PAGE_LIMIT}`
    );
  }

  return limit;
}

function encodeCursor(conversationId: string, key: any) {
  return Buffer.from(
    JSON.stringify({
      v: CURSOR_VERSION,
      conversationId,
      createdAt: key.createdAt,
      id: key.id,
    }),
    'utf8'
  ).toString('base64url');
}

function decodeCursor(value: string | null, conversationId: string) {
  if (value === null || value === '') {
    return null;
  }

  if (value.length > MAX_CURSOR_LENGTH || !BASE64URL_PATTERN.test(value)) {
    throw createHttpError(400, 'Invalid message page cursor');
  }

  let payload: any;

  try {
    payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw createHttpError(400, 'Invalid message page cursor');
  }

  const createdAt = payload && typeof payload.createdAt === 'string' ? payload.createdAt.trim() : '';
  const id = payload && typeof payload.id === 'string' ? payload.id.trim() : '';

  if (
    !payload ||
    Array.isArray(payload) ||
    payload.v !== CURSOR_VERSION ||
    payload.conversationId !== conversationId ||
    !createdAt ||
    !Number.isFinite(Date.parse(createdAt)) ||
    !id
  ) {
    throw createHttpError(400, 'Invalid message page cursor');
  }

  return { createdAt, id };
}

export function buildConversationMessagePage(store: any, conversationId: string, searchParams: URLSearchParams) {
  const limit = parsePageLimit(searchParams.get('limit'));
  const before = decodeCursor(searchParams.get('before'), conversationId);
  const page = store.listMessagePage(conversationId, { limit, before });

  return {
    items: page.items.map(projectMessageForTransport),
    nextCursor: page.nextBefore ? encodeCursor(conversationId, page.nextBefore) : null,
    hasMore: page.hasMore,
  };
}
