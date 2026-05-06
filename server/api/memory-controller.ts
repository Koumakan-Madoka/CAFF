import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import type { RouteHandler } from '../http/router';
import { readRequestJson } from '../http/request-body';
import { sendJson } from '../http/response';
import { createHttpError } from '../http/http-errors';
import { backfillConversationDigestSummarySegments } from '../domain/conversation/conversation-digest';

type ApiContext = {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  requestUrl: URL;
};

const MAX_MEMORY_SEARCH_QUERY_LENGTH = 240;
const MAX_MEMORY_SEARCH_LIMIT = 10;

function normalizeLimit(value: any) {
  if (value === undefined || value === null || value === '') {
    return 5;
  }

  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    throw createHttpError(400, 'limit must be a positive integer');
  }

  return Math.max(1, Math.min(MAX_MEMORY_SEARCH_LIMIT, parsed));
}

function normalizeQuery(value: any, allowEmpty = false) {
  const query = String(value || '').trim().replace(/\s+/g, ' ');

  if (!query && !allowEmpty) {
    throw createHttpError(400, 'query is required');
  }

  if (query.length > MAX_MEMORY_SEARCH_QUERY_LENGTH) {
    throw createHttpError(400, `query must be at most ${MAX_MEMORY_SEARCH_QUERY_LENGTH} characters`);
  }

  return query;
}

function normalizeOptionalConversationId(value: any) {
  return String(value || '').trim() || undefined;
}

function normalizeOptionalFilterText(value: any, fieldName: string) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');

  if (normalized.length > 120) {
    throw createHttpError(400, `${fieldName} must be at most 120 characters`);
  }

  return normalized || undefined;
}

function normalizeOptionalSourceKind(value: any) {
  const normalized = String(value || '').trim();

  if (!normalized) {
    return undefined;
  }

  if (normalized !== 'entry' && normalized !== 'rollup') {
    throw createHttpError(400, 'sourceKind must be entry or rollup');
  }

  return normalized;
}

function normalizeOptionalDateBoundary(value: any, fieldName: string, endOfDay = false) {
  const normalized = String(value || '').trim();

  if (!normalized) {
    return undefined;
  }

  if (normalized.length > 80) {
    throw createHttpError(400, `${fieldName} must be at most 80 characters`);
  }

  const date = /^\d{4}-\d{2}-\d{2}$/u.test(normalized)
    ? new Date(`${normalized}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
    : new Date(normalized);

  if (Number.isNaN(date.getTime())) {
    throw createHttpError(400, `${fieldName} must be a valid ISO date or datetime`);
  }

  return date.toISOString();
}

function normalizeBooleanFlag(value: any, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function resolveTaskNameFilter(options: any, explicitTaskName: any, useCurrentTask: any) {
  const taskName = normalizeOptionalFilterText(explicitTaskName, 'taskName');

  if (taskName || !useCurrentTask) {
    return taskName;
  }

  if (typeof options.resolveCurrentTaskName !== 'function') {
    throw createHttpError(400, 'Unable to resolve the current Trellis task for memory search');
  }

  const resolvedTaskName = normalizeOptionalFilterText(options.resolveCurrentTaskName(), 'taskName');

  if (!resolvedTaskName) {
    throw createHttpError(400, 'Unable to resolve the current Trellis task for memory search');
  }

  return resolvedTaskName;
}

export function createMemoryController(options: any = {}): RouteHandler<ApiContext> {
  const store = options.store;

  return async function handleMemoryRequest(context) {
    const { req, res, pathname, requestUrl } = context;

    if (pathname === '/api/memory/health' && req.method === 'GET') {
      if (!store || typeof store.getSummaryMemoryHealth !== 'function') {
        sendJson(res, 200, {
          ok: false,
          status: 'unavailable',
          table: { name: 'chat_summary_segments', exists: false },
          segments: { count: 0, latestUpdatedAt: '', latest: null },
          search: { available: false, mode: 'unavailable', error: 'Summary memory health is not available' },
          backfill: { available: false, conversationCount: 0, digestCount: 0, unsyncedDigestCount: 0 },
          diagnostics: [{ code: 'summary_memory_unavailable', message: 'Summary memory health is not available' }],
        });
        return true;
      }

      const conversationId = normalizeOptionalConversationId(requestUrl.searchParams.get('conversationId') || requestUrl.searchParams.get('id'));
      sendJson(res, 200, store.getSummaryMemoryHealth({ conversationId }));
      return true;
    }

    if (pathname === '/api/memory/search' && req.method === 'GET') {
      if (!store || typeof store.searchSummarySegments !== 'function') {
        throw createHttpError(501, 'Memory search is not available');
      }

      const latest = normalizeBooleanFlag(requestUrl.searchParams.get('latest') || requestUrl.searchParams.get('recent'), false);
      const query = normalizeQuery(requestUrl.searchParams.get('q') || requestUrl.searchParams.get('query'), latest);
      const limit = normalizeLimit(requestUrl.searchParams.get('limit'));
      const excludeConversationId = normalizeOptionalConversationId(requestUrl.searchParams.get('excludeConversationId'));
      const useCurrentTask = normalizeBooleanFlag(requestUrl.searchParams.get('useCurrentTask') || requestUrl.searchParams.get('currentTask'), false);
      const taskName = resolveTaskNameFilter(options, requestUrl.searchParams.get('taskName') || requestUrl.searchParams.get('task'), useCurrentTask);
      const sourceKind = normalizeOptionalSourceKind(requestUrl.searchParams.get('sourceKind') || requestUrl.searchParams.get('kind'));
      const conversationTitle = normalizeOptionalFilterText(requestUrl.searchParams.get('conversationTitle') || requestUrl.searchParams.get('title') || requestUrl.searchParams.get('conversation'), 'conversationTitle');
      const updatedAfter = normalizeOptionalDateBoundary(requestUrl.searchParams.get('updatedAfter') || requestUrl.searchParams.get('since') || requestUrl.searchParams.get('from') || requestUrl.searchParams.get('fromDate'), 'updatedAfter');
      const updatedBefore = normalizeOptionalDateBoundary(requestUrl.searchParams.get('updatedBefore') || requestUrl.searchParams.get('until') || requestUrl.searchParams.get('to') || requestUrl.searchParams.get('toDate'), 'updatedBefore', true);
      sendJson(res, 200, {
        ok: true,
        ...store.searchSummarySegments({ query, limit, excludeConversationId, taskName, sourceKind, conversationTitle, updatedAfter, updatedBefore }),
      });
      return true;
    }

    if (pathname === '/api/memory/search' && req.method === 'POST') {
      if (!store || typeof store.searchSummarySegments !== 'function') {
        throw createHttpError(501, 'Memory search is not available');
      }

      const body = await readRequestJson(req);
      const latest = normalizeBooleanFlag(body.latest || body.recent, false);
      const query = normalizeQuery(body.query || body.q, latest);
      const limit = normalizeLimit(body.limit);
      const excludeConversationId = normalizeOptionalConversationId(body.excludeConversationId);
      const useCurrentTask = normalizeBooleanFlag(body.useCurrentTask || body.currentTask, false);
      const taskName = resolveTaskNameFilter(options, body.taskName || body.task, useCurrentTask);
      const sourceKind = normalizeOptionalSourceKind(body.sourceKind || body.kind);
      const conversationTitle = normalizeOptionalFilterText(body.conversationTitle || body.title || body.conversation, 'conversationTitle');
      const updatedAfter = normalizeOptionalDateBoundary(body.updatedAfter || body.since || body.from || body.fromDate, 'updatedAfter');
      const updatedBefore = normalizeOptionalDateBoundary(body.updatedBefore || body.until || body.to || body.toDate, 'updatedBefore', true);
      sendJson(res, 200, {
        ok: true,
        ...store.searchSummarySegments({ query, limit, excludeConversationId, taskName, sourceKind, conversationTitle, updatedAfter, updatedBefore }),
      });
      return true;
    }

    if (pathname === '/api/memory/backfill' && req.method === 'POST') {
      const body = await readRequestJson(req);
      const conversationId = normalizeOptionalConversationId(body.conversationId || body.id);
      const taskName = normalizeOptionalFilterText(body.taskName || body.task, 'taskName');
      sendJson(res, 200, {
        ok: true,
        action: 'backfill',
        ...backfillConversationDigestSummarySegments(store, { conversationId, taskName }),
      });
      return true;
    }

    return false;
  };
}
