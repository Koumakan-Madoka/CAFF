import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { sendJson } from '../http/response';
import { migrateRunSchema } from '../../storage/sqlite/migrations';
import { buildAgentEvalReport } from '../domain/metrics/agent-eval-report';

type ApiContext = {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  requestUrl: URL;
};

export function createMetricsController(options: any = {}): RouteHandler<ApiContext> {
  const store = options.store;
  let runSchemaReady = false;

  if (!store || !store.db) {
    return async function handleMissingMetricsController(context) {
      const { req, pathname } = context;

      if (pathname.startsWith('/api/metrics') && req.method) {
        throw createHttpError(501, 'Metrics store is not configured');
      }

      return false;
    };
  }

  function ensureRunSchema() {
    if (runSchemaReady) {
      return;
    }

    migrateRunSchema(store.db);
    runSchemaReady = true;
  }

  return async function handleMetricsRequest(context) {
    const { req, res, pathname, requestUrl } = context;

    if (req.method === 'GET' && pathname === '/api/metrics/agent') {
      ensureRunSchema();

      const since = requestUrl.searchParams.get('since') || '';
      const until = requestUrl.searchParams.get('until') || '';
      const agentId = requestUrl.searchParams.get('agentId') || requestUrl.searchParams.get('agent') || '';

      const report = buildAgentEvalReport(store.db, {
        databasePath: store.databasePath || null,
        since,
        until,
        agentId,
      });

      sendJson(res, 200, report);
      return true;
    }

    return false;
  };
}

