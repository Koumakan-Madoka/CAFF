import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { createLocalAdminGuard } from '../http/local-admin-guard';
import { readRequestJson } from '../http/request-body';
import { sendJson } from '../http/response';
import { SubscriptionLoginError } from '../domain/models/subscription-login';

type ApiContext = {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  requestUrl: URL;
};

function loginErrorStatus(error: SubscriptionLoginError) {
  switch (error.code) {
    case 'channel_unknown':
      return 400;
    case 'login_in_progress':
    case 'callback_port_unavailable':
      return 409;
    default:
      return 500;
  }
}

function toSafeControllerError(error: any) {
  if (error instanceof SubscriptionLoginError) {
    return createHttpError(loginErrorStatus(error), 'Subscription login operation failed', {
      issues: [{ code: `subscription_auth_${error.code}`, path: error.channel || '' }],
    });
  }

  if (
    Number.isInteger(error && error.statusCode) &&
    Array.isArray(error && error.issues) &&
    error.issues.every((issue: any) => issue && typeof issue.code === 'string' && issue.code.startsWith('subscription_auth_'))
  ) {
    return error;
  }

  return createHttpError(500, 'Subscription login operation failed', {
    issues: [{ code: 'subscription_auth_operation_failed', path: '' }],
  });
}

function decodeSessionId(encodedSessionId: string) {
  try {
    const sessionId = decodeURIComponent(encodedSessionId).trim();
    if (!sessionId) {
      throw new Error('empty session id');
    }
    return sessionId;
  } catch {
    throw createHttpError(400, 'Subscription login session id is invalid', {
      issues: [{ code: 'subscription_auth_session_id_invalid', path: 'sessionId' }],
    });
  }
}

function requireChannel(body: any) {
  const channel = body && typeof body.channel === 'string' ? body.channel.trim() : '';
  if (!channel) {
    throw createHttpError(422, 'Subscription channel is required', {
      issues: [{ code: 'subscription_auth_channel_required', path: 'channel' }],
    });
  }
  return channel;
}

export function createSubscriptionAuthController(options: any = {}): RouteHandler<ApiContext> {
  const service = options.service;
  if (!service || typeof service.getStatus !== 'function') {
    throw new Error('createSubscriptionAuthController requires a subscription login service');
  }

  const guard = createLocalAdminGuard({
    host: options.host,
    port: options.port,
    csrfToken: options.csrfToken,
    getAuthority: options.getAuthority,
    issuePrefix: 'subscription_auth',
    errorMessage: 'Subscription login request was rejected',
  });

  return async function handleSubscriptionAuthRequest(context) {
    const { req, res, pathname } = context;

    if (pathname !== '/api/subscription-auth' && !pathname.startsWith('/api/subscription-auth/')) {
      return false;
    }

    try {
      if (req.method === 'GET' && pathname === '/api/subscription-auth') {
        guard.assertRead(req);
        sendJson(res, 200, service.getStatus());
        return true;
      }

      if (req.method === 'POST' && pathname === '/api/subscription-auth/logins') {
        guard.assertMutation(req);
        const body = await readRequestJson(req);
        const session = await service.startLogin(requireChannel(body));
        sendJson(res, 200, { session });
        return true;
      }

      const sessionMatch = pathname.match(/^\/api\/subscription-auth\/logins\/([^/]+)(?:\/(cancel))?$/u);
      if (sessionMatch) {
        const sessionId = decodeSessionId(sessionMatch[1]);
        const action = sessionMatch[2] || '';

        if (req.method === 'GET' && !action) {
          guard.assertRead(req);
          const session = service.getSession(sessionId);
          if (!session) {
            throw createHttpError(404, 'Subscription login session not found', {
              issues: [{ code: 'subscription_auth_session_not_found', path: 'sessionId' }],
            });
          }
          sendJson(res, 200, { session });
          return true;
        }

        if (req.method === 'POST' && action === 'cancel') {
          guard.assertMutation(req);
          await readRequestJson(req);
          const session = service.cancelSession(sessionId);
          if (!session) {
            throw createHttpError(404, 'Subscription login session not found', {
              issues: [{ code: 'subscription_auth_session_not_found', path: 'sessionId' }],
            });
          }
          sendJson(res, 200, { session });
          return true;
        }

        return false;
      }

      if (req.method === 'POST' && pathname === '/api/subscription-auth/logout') {
        guard.assertMutation(req);
        const body = await readRequestJson(req);
        const result = await service.logout(requireChannel(body));
        sendJson(res, 200, result);
        return true;
      }

      return false;
    } catch (error) {
      throw toSafeControllerError(error);
    }
  };
}
