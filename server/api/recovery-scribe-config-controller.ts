import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { createLocalAdminGuard } from '../http/local-admin-guard';
import { readRequestJson } from '../http/request-body';
import { sendJson } from '../http/response';
import { RecoveryScribeConfigError } from '../domain/conversation/recovery-scribe-config';
import { RECOVERY_SCRIBE_SYSTEM_ACTOR } from '../domain/roles/system-actor-catalog';

type ApiContext = {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  requestUrl: URL;
};

const ROUTE = '/api/system-services/recovery-scribe';

function toSafeControllerError(error: any) {
  if (error instanceof RecoveryScribeConfigError) {
    return createHttpError(422, 'Recovery Scribe configuration is invalid', {
      issues: [{ code: error.code, path: error.path }],
    });
  }
  return error;
}

export function createRecoveryScribeConfigController(options: any = {}): RouteHandler<ApiContext> {
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
    || typeof service.updateConfiguration !== 'function') {
    throw new Error('Recovery Scribe configuration service is required');
  }

  return async function handleRecoveryScribeConfigRequest(context) {
    const { req, res, pathname } = context;
    if (pathname !== ROUTE) {
      return false;
    }

    try {
      if (req.method === 'GET') {
        guard.assertRead(req);
        sendJson(res, 200, service.getConfiguration());
        return true;
      }

      if (req.method === 'PUT') {
        guard.assertMutation(req);
        const body = await readRequestJson(req);
        const configuration = service.updateConfiguration(body);
        broadcastEvent('system_service_config_updated', {
          serviceType: RECOVERY_SCRIBE_SYSTEM_ACTOR.type,
          enabled: configuration.config.enabled,
          updatedAt: configuration.updatedAt,
        });
        sendJson(res, 200, configuration);
        return true;
      }

      return false;
    } catch (error) {
      throw toSafeControllerError(error);
    }
  };
}
