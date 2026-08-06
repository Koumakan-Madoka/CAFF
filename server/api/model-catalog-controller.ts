import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { createLocalAdminGuard } from '../http/local-admin-guard';
import { readRequestJson } from '../http/request-body';
import { sendJson } from '../http/response';
import {
  ModelCatalogError,
  projectCatalogModel,
  validateCatalogProvenance,
  validateModelsDevDocument,
} from '../domain/models/models-dev-import';
import { readCatalogCache } from '../domain/models/models-dev-catalog-cache';
import {
  ModelProviderConfigError,
  patchModelProvider,
  projectModelProviderDocument,
} from '../domain/models/model-provider-config';
import {
  updateModelProviderDocument,
} from '../domain/models/model-provider-persistence';

type ApiContext = {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  requestUrl: URL;
};

const CATALOG_ASSET_PATH = path.resolve(__dirname, '..', '..', '..', 'assets', 'model-catalog.json');
const IMPORT_FIELDS = new Set(['providerId', 'modelId', 'name', 'baseUrl', 'reasoning']);

function catalogErrorStatus(error: ModelCatalogError) {
  if (error.code === 'catalog_provider_not_found' || error.code === 'catalog_model_not_found') {
    return 404;
  }
  if (error.code === 'catalog_source_unavailable') {
    return 503;
  }
  return 422;
}

function toSafeControllerError(error: any) {
  if (error instanceof ModelCatalogError) {
    return createHttpError(catalogErrorStatus(error), 'Model catalog operation failed', {
      issues: [{ code: error.code, path: error.path }],
    });
  }

  if (error instanceof ModelProviderConfigError) {
    return createHttpError(422, 'Model provider configuration is invalid', {
      issues: [{ code: error.code, path: error.path }],
    });
  }

  return error;
}

function readVendoredCatalog() {
  if (!fs.existsSync(CATALOG_ASSET_PATH)) {
    throw new ModelCatalogError('catalog_source_unavailable', CATALOG_ASSET_PATH);
  }

  let document: any;
  try {
    document = JSON.parse(fs.readFileSync(CATALOG_ASSET_PATH, 'utf8'));
  } catch {
    throw new ModelCatalogError('catalog_source_invalid', CATALOG_ASSET_PATH);
  }

  if (!document || typeof document !== 'object' || !document.provenance || !document.providers) {
    throw new ModelCatalogError('catalog_source_invalid', CATALOG_ASSET_PATH);
  }
  validateCatalogProvenance(document.provenance);
  validateModelsDevDocument(document.providers);
  return structuredClone(document);
}

function loadCatalog(options: any, agentDir: string) {
  if (typeof options.loadCatalog === 'function') {
    const document = options.loadCatalog();
    validateCatalogProvenance(document && document.provenance);
    validateModelsDevDocument(document && document.providers);
    return structuredClone(document);
  }

  if (options.catalogDocument) {
    validateCatalogProvenance(options.catalogDocument.provenance);
    validateModelsDevDocument(options.catalogDocument.providers);
    return structuredClone(options.catalogDocument);
  }

  const cached = readCatalogCache(agentDir);
  if (cached) {
    return {
      provenance: cached.provenance,
      providers: cached.providers,
    };
  }

  return readVendoredCatalog();
}

function buildIndex(document: any) {
  const providers = Object.entries(document.providers).map(([providerId, rawProvider]: [string, any]) => {
    const models = Object.keys(rawProvider.models || {}).map((modelId) => {
      const projection = projectCatalogModel(document.providers, providerId, modelId, {
        provenance: document.provenance,
      });
      return {
        id: projection.modelId,
        name: projection.name,
        dialect: projection.dialect,
        family: projection.family,
        familyStatus: projection.familyStatus,
        manualConfigurationRequired: projection.manualConfigurationRequired,
      };
    });

    return {
      id: providerId,
      name: typeof rawProvider.name === 'string' ? rawProvider.name.trim() : '',
      env: Array.isArray(rawProvider.env) ? rawProvider.env.slice() : [],
      models,
    };
  });

  return {
    provenance: document.provenance,
    providers,
  };
}

function assertImportBody(body: any) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ModelCatalogError('catalog_import_body_invalid', 'body');
  }

  for (const key of Object.keys(body)) {
    if (!IMPORT_FIELDS.has(key)) {
      throw new ModelCatalogError('catalog_import_field_not_allowed', `body.${key}`);
    }
  }

  const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
  const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
  if (!providerId || !modelId) {
    throw new ModelCatalogError('catalog_import_target_required', 'body');
  }
  if (Object.hasOwn(body, 'name') && typeof body.name !== 'string') {
    throw new ModelCatalogError('catalog_import_name_invalid', 'body.name');
  }
  if (Object.hasOwn(body, 'baseUrl') && typeof body.baseUrl !== 'string') {
    throw new ModelCatalogError('catalog_import_base_url_invalid', 'body.baseUrl');
  }
  if (Object.hasOwn(body, 'reasoning') && typeof body.reasoning !== 'boolean') {
    throw new ModelCatalogError('catalog_import_reasoning_invalid', 'body.reasoning');
  }

  return { providerId, modelId };
}

export function createModelCatalogController(options: any = {}): RouteHandler<ApiContext> {
  const agentDir = options.agentDir;
  const guard = createLocalAdminGuard({
    host: options.host,
    port: options.port,
    csrfToken: options.csrfToken,
    getAuthority: options.getAuthority,
  });
  const onCommitted = typeof options.onCommitted === 'function' ? options.onCommitted : () => {};

  return async function handleModelCatalogRequest(context) {
    const { req, res, pathname, requestUrl } = context;
    const isCatalogRoute = pathname === '/api/model-catalog' || pathname === '/api/model-catalog/import';
    if (!isCatalogRoute) {
      return false;
    }

    try {
      if (req.method === 'GET' && pathname === '/api/model-catalog') {
        guard.assertRead(req);
        const document = loadCatalog(options, agentDir);
        const providerId = (requestUrl.searchParams.get('providerId') || '').trim();
        const modelId = (requestUrl.searchParams.get('modelId') || '').trim();
        if (!providerId && !modelId) {
          sendJson(res, 200, buildIndex(document));
          return true;
        }
        if (!providerId || !modelId) {
          throw new ModelCatalogError('catalog_query_target_incomplete', 'query');
        }
        sendJson(res, 200, {
          projection: projectCatalogModel(document.providers, providerId, modelId, {
            provenance: document.provenance,
          }),
        });
        return true;
      }

      if (req.method === 'POST' && pathname === '/api/model-catalog/import') {
        guard.assertMutation(req);
        const document = loadCatalog(options, agentDir);
        const body = await readRequestJson(req);
        const { providerId, modelId } = assertImportBody(body);
        const projection = projectCatalogModel(document.providers, providerId, modelId, {
          provenance: document.provenance,
        });
        if (projection.manualConfigurationRequired || !projection.dialect) {
          throw new ModelCatalogError('catalog_manual_configuration_required', `providers.${providerId}.models.${modelId}`);
        }

        const result = await updateModelProviderDocument(agentDir, (configured: any) => {
          const modelPatch: any = {
            id: modelId,
            name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : projection.name,
          };
          if (projection.family) {
            modelPatch.family = projection.family;
          }
          if (Object.hasOwn(body, 'reasoning')) {
            modelPatch.reasoning = body.reasoning;
          }

          return patchModelProvider(configured, providerId, {
            name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : projection.name,
            baseUrl: typeof body.baseUrl === 'string' && body.baseUrl.trim()
              ? body.baseUrl.trim()
              : projection.baseUrl,
            api: projection.dialect,
            models: [modelPatch],
          });
        });
        onCommitted();
        sendJson(res, 200, {
          ...projectModelProviderDocument(result.document),
          write: {
            backupCreated: Boolean(result.backupPath),
            durability: result.durability,
          },
        });
        return true;
      }

      return false;
    } catch (error) {
      throw toSafeControllerError(error);
    }
  };
}
