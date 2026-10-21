import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { createLocalAdminGuard } from '../http/local-admin-guard';
import { readRequestJson } from '../http/request-body';
import { sendJson } from '../http/response';

type ApiContext = {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  requestUrl: URL;
};

const ROUTE = '/api/system-services/turn-time-breakdown-jev';
const CACHE_ROUTE = `${ROUTE}/cache`;

// The API key stays env-only (contract §6): a PUT carrying any credential-ish
// field is rejected with 422 instead of silently ignored, so an operator
// never believes the UI stored a secret.
const FORBIDDEN_BODY_KEYS = new Set([
  'apikey',
  'api_key',
  'key',
  'token',
  'secret',
  'password',
  'authorization',
]);

export function createTurnTimeBreakdownJevConfigController(options: any = {}): RouteHandler<ApiContext> {
  const service = options.service;
  const broadcastEvent = typeof options.broadcastEvent === 'function' ? options.broadcastEvent : () => {};
  const guard = createLocalAdminGuard({
    host: options.host,
    port: options.port,
    csrfToken: options.csrfToken,
    getAuthority: options.getAuthority,
    issuePrefix: 'system_service_config',
    errorMessage: 'System service administration request was rejected',
  });

  if (!service
    || typeof service.getConfiguration !== 'function'
    || typeof service.updateConfiguration !== 'function'
    || typeof service.clearCache !== 'function') {
    throw new Error('JEV configuration service is required');
  }

  // `enabled` is the only writable field and it is strictly boolean: a
  // truthy string/number must not be silently coerced into OFF — that would
  // invert the operator's intent without any signal.
  function assertValidEnabled(body: any) {
    if (body && typeof body === 'object' && !Array.isArray(body)
      && Object.prototype.hasOwnProperty.call(body, 'enabled')
      && typeof body.enabled !== 'boolean') {
      throw createHttpError(422, 'enabled must be a boolean', {
        issues: [{ code: 'invalid_enabled_value', path: 'enabled' }],
      });
    }
  }

  function assertNoCredentialFields(body: any) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return;
    }

    for (const key of Object.keys(body)) {
      if (FORBIDDEN_BODY_KEYS.has(String(key).toLowerCase())) {
        throw createHttpError(422, 'The API key is env-only and must not be sent to this endpoint', {
          issues: [{ code: 'credential_field_not_accepted', path: String(key) }],
        });
      }
    }
  }

  return async function handleTurnTimeBreakdownJevConfigRequest(context) {
    const { req, res, pathname } = context;

    if (pathname === CACHE_ROUTE && req.method === 'DELETE') {
      guard.assertMutation(req);
      const result = service.clearCache();
      broadcastEvent('system_service_config_updated', {
        serviceType: 'turn-time-breakdown-jev',
        cacheCleared: true,
      });
      sendJson(res, 200, result);
      return true;
    }

    if (pathname !== ROUTE) {
      return false;
    }

    if (req.method === 'GET') {
      guard.assertRead(req);
      sendJson(res, 200, service.getConfiguration());
      return true;
    }

    if (req.method === 'PUT') {
      guard.assertMutation(req);
      const body = await readRequestJson(req);
      assertNoCredentialFields(body);
      assertValidEnabled(body);
      const configuration = service.updateConfiguration(body);
      broadcastEvent('system_service_config_updated', {
        serviceType: 'turn-time-breakdown-jev',
        enabled: configuration.config.enabled,
      });
      sendJson(res, 200, configuration);
      return true;
    }

    return false;
  };
}
