import { createHttpError } from '../../http/http-errors';

export const DEFAULT_CONVERSATION_DIRECTORY_PAGE_LIMIT = 50;
export const MAX_CONVERSATION_DIRECTORY_PAGE_LIMIT = 100;

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 2048;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function parsePageLimit(value: string | null) {
  if (value === null || value === '') return DEFAULT_CONVERSATION_DIRECTORY_PAGE_LIMIT;
  if (!/^\d+$/.test(value)) throw createHttpError(400, 'Conversation page limit must be a whole number');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CONVERSATION_DIRECTORY_PAGE_LIMIT) {
    throw createHttpError(400, `Conversation page limit must be between 1 and ${MAX_CONVERSATION_DIRECTORY_PAGE_LIMIT}`);
  }
  return limit;
}

function normalizeQuery(value: string | null) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function escapeLikePattern(value: string) {
  return value.replace(/([%_\\])/g, '\\$1');
}

function encodeCursor(query: string, key: any) {
  return Buffer.from(JSON.stringify({
    v: CURSOR_VERSION,
    query,
    activityAt: key.activityAt,
    id: key.id,
  }), 'utf8').toString('base64url');
}

function decodeCursor(value: string | null, query: string) {
  if (value === null || value === '') return null;
  if (value.length > MAX_CURSOR_LENGTH || !BASE64URL_PATTERN.test(value)) {
    throw createHttpError(400, 'Invalid conversation page cursor');
  }

  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw createHttpError(400, 'Invalid conversation page cursor');
  }

  const activityAt = payload && typeof payload.activityAt === 'string' ? payload.activityAt.trim() : '';
  const id = payload && typeof payload.id === 'string' ? payload.id.trim() : '';
  if (
    !payload || Array.isArray(payload) || payload.v !== CURSOR_VERSION || payload.query !== query
    || !activityAt || !Number.isFinite(Date.parse(activityAt)) || !id
  ) {
    throw createHttpError(400, 'Invalid conversation page cursor');
  }

  return { activityAt, id };
}

export function buildConversationDirectoryPage(store: any, searchParams: URLSearchParams) {
  const limit = parsePageLimit(searchParams.get('limit'));
  const query = normalizeQuery(searchParams.get('q'));
  const before = decodeCursor(searchParams.get('before'), query);
  const page = store.listConversationDirectoryPage({
    limit,
    query,
    before,
  });

  return {
    conversations: page.items,
    nextCursor: page.nextCursor ? encodeCursor(query, page.nextCursor) : null,
    hasMore: page.hasMore,
    query,
  };
}

export function normalizeConversationDirectoryQuery(value: any) {
  return normalizeQuery(value);
}

export function escapeConversationDirectoryLikePattern(value: any) {
  return escapeLikePattern(normalizeQuery(value));
}
