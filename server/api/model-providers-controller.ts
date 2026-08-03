import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { createLocalAdminGuard } from '../http/local-admin-guard';
import { readRequestJson } from '../http/request-body';
import { sendJson } from '../http/response';
import {
  ModelProviderConfigError,
  clearModelProviderSecret,
  patchModelProvider,
  projectModelProviderDocument,
  removeModelProvider,
} from '../domain/models/model-provider-config';
import {
  readModelProviderDocument,
  updateModelProviderDocument,
} from '../domain/models/model-provider-persistence';
import {
  ProviderValidationError,
  validateModelProviderConnection,
} from '../domain/models/provider-validation';

type ApiContext = {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  requestUrl: URL;
};

function configErrorStatus(error: ModelProviderConfigError) {
  return error.code === 'provider_not_found' ? 404 : 422;
}

function toSafeControllerError(error: any) {
  if (error instanceof ModelProviderConfigError) {
    return createHttpError(configErrorStatus(error), 'Model provider configuration is invalid', {
      issues: [{ code: error.code, path: error.path }],
    });
  }

  if (error instanceof ProviderValidationError) {
    return createHttpError(422, 'Model provider validation target is invalid', {
      issues: [{ code: error.code, path: error.path }],
    });
  }

  if (
    Number.isInteger(error && error.statusCode) &&
    Array.isArray(error && error.issues) &&
    error.issues.every((issue: any) => issue && typeof issue.code === 'string' && issue.code.startsWith('provider_config_'))
  ) {
    return error;
  }

  return createHttpError(500, 'Model provider operation failed', {
    issues: [{ code: 'provider_config_operation_failed', path: '' }],
  });
}

function decodeProviderId(encodedProviderId: string) {
  try {
    const providerId = decodeURIComponent(encodedProviderId).trim();
    if (!providerId) {
      throw new Error('empty provider id');
    }
    return providerId;
  } catch {
    throw createHttpError(400, 'Model provider id is invalid', {
      issues: [{ code: 'provider_id_invalid', path: 'providerId' }],
    });
  }
}

export function createModelProvidersController(options: any = {}): RouteHandler<ApiContext> {
  const agentDir = options.agentDir;
  const validateProvider = typeof options.validateProvider === 'function'
    ? options.validateProvider
    : validateModelProviderConnection;
  const guard = createLocalAdminGuard({
    host: options.host,
    port: options.port,
    csrfToken: options.csrfToken,
    getAuthority: options.getAuthority,
  });

  function externalAuthProviderIds() {
    const value = typeof options.externalAuthProviderIds === 'function'
      ? options.externalAuthProviderIds()
      : options.externalAuthProviderIds;
    return value instanceof Set ? value : new Set();
  }

  function project(document: any) {
    return projectModelProviderDocument(document, {
      externalAuthProviderIds: externalAuthProviderIds(),
    });
  }

  function buildWriteResponse(result: any) {
    return {
      ...project(result.document),
      write: {
        backupCreated: Boolean(result.backupPath),
        durability: result.durability,
      },
    };
  }

  return async function handleModelProvidersRequest(context) {
    const { req, res, pathname } = context;
    const isProviderRoute = pathname === '/api/model-providers' || pathname.startsWith('/api/model-providers/');

    if (!isProviderRoute) {
      return false;
    }

    try {
      if (req.method === 'GET' && pathname === '/api/model-providers') {
        guard.assertRead(req);
        sendJson(res, 200, project(readModelProviderDocument(agentDir)));
        return true;
      }

      const match = pathname.match(/^\/api\/model-providers\/([^/]+)(?:\/(secret|validate))?$/u);
      if (!match) {
        return false;
      }

      const providerId = decodeProviderId(match[1]);
      const action = match[2] || '';
      guard.assertMutation(req);

      if (req.method === 'PUT' && !action) {
        const body = await readRequestJson(req);
        const result = await updateModelProviderDocument(agentDir, (document: any) => (
          patchModelProvider(document, providerId, body)
        ));
        sendJson(res, 200, buildWriteResponse(result));
        return true;
      }

      if (req.method === 'DELETE' && action === 'secret') {
        const result = await updateModelProviderDocument(agentDir, (document: any) => (
          clearModelProviderSecret(document, providerId)
        ));
        sendJson(res, 200, buildWriteResponse(result));
        return true;
      }

      if (req.method === 'DELETE' && !action) {
        const result = await updateModelProviderDocument(agentDir, (document: any) => (
          removeModelProvider(document, providerId)
        ));
        sendJson(res, 200, buildWriteResponse(result));
        return true;
      }

      if (req.method === 'POST' && action === 'validate') {
        await readRequestJson(req);
        const document = readModelProviderDocument(agentDir);
        const provider = document.providers[providerId];
        if (!provider) {
          throw new ModelProviderConfigError('provider_not_found', `providers.${providerId}`);
        }
        const validation = await validateProvider(providerId, structuredClone(provider));
        sendJson(res, 200, { validation });
        return true;
      }

      return false;
    } catch (error) {
      throw toSafeControllerError(error);
    }
  };
}
