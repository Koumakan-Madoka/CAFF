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
import { inspectDialectEndpoint } from '../domain/models/endpoint-diagnostics';
import { readCatalogCache } from '../domain/models/models-dev-catalog-cache';
import { refreshModelsDevCatalog } from '../domain/models/models-dev-online-refresh';
import {
  ModelProviderConfigError,
  PI_DEFAULT_CONTEXT_WINDOW,
  PI_DEFAULT_MAX_TOKENS,
  patchModelProvider,
  projectModelProviderDocument,
} from '../domain/models/model-provider-config';
import {
  readModelProviderDocument,
  updateModelProviderDocument,
} from '../domain/models/model-provider-persistence';

type ApiContext = {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  requestUrl: URL;
};

const CATALOG_ASSET_PATH = path.resolve(__dirname, '..', '..', 'assets', 'model-catalog.json');
const CATALOG_REFRESH_ERROR_STATUS: Record<string, number> = {
  catalog_refresh_timeout: 504,
  catalog_refresh_source_failed: 502,
  catalog_refresh_payload_invalid: 502,
  catalog_refresh_payload_too_large: 502,
  catalog_refresh_provider_count_exceeded: 502,
  catalog_refresh_model_count_exceeded: 502,
};
const IMPORT_FIELDS = new Set([
  'providerId',
  'modelId',
  'name',
  'baseUrl',
  'reasoning',
  'input',
  'contextWindow',
  'maxTokens',
]);

function catalogErrorStatus(error: ModelCatalogError) {
  if (error.code === 'catalog_provider_not_found' || error.code === 'catalog_model_not_found') {
    return 404;
  }
  if (error.code === 'catalog_source_unavailable') {
    return 503;
  }
  if (Object.hasOwn(CATALOG_REFRESH_ERROR_STATUS, error.code)) {
    return CATALOG_REFRESH_ERROR_STATUS[error.code];
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
  if (Object.hasOwn(body, 'input') && !Array.isArray(body.input)) {
    throw new ModelCatalogError('catalog_import_input_invalid', 'body.input');
  }
  for (const field of ['contextWindow', 'maxTokens'] as const) {
    if (Object.hasOwn(body, field) && (!Number.isInteger(body[field]) || body[field] <= 0)) {
      throw new ModelCatalogError('catalog_import_limit_invalid', `body.${field}`);
    }
  }

  return { providerId, modelId };
}

function assertTrustedCatalogLimits(body: any, projection: any) {
  for (const field of ['contextWindow', 'maxTokens'] as const) {
    if (!Object.hasOwn(body, field)) {
      continue;
    }
    if (!Object.hasOwn(projection, field) || body[field] !== projection[field]) {
      throw new ModelCatalogError('catalog_import_limit_mismatch', `body.${field}`);
    }
  }
}

function configText(value: any): string {
  return typeof value === 'string' ? value.trim() : '';
}

// Non-secret stored connection context for advisory endpoint diagnostics. An
// unreadable models.json must not break catalog browsing — the diagnostics
// are advisory and simply fall back to catalog-only projection.
function readExistingEndpointContext(agentDir: string, providerId: string, modelId: string) {
  try {
    const document = readModelProviderDocument(agentDir);
    const provider = document.providers && document.providers[providerId];
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
      return undefined;
    }
    const models = Array.isArray(provider.models) ? provider.models : [];
    const model = models.find((entry: any) => entry && typeof entry === 'object' && configText(entry.id) === modelId);
    return {
      providerApi: configText(provider.api),
      providerBaseUrl: configText(provider.baseUrl),
      modelApi: model ? configText(model.api) : '',
      modelBaseUrl: model ? configText(model.baseUrl) : '',
    };
  } catch {
    return undefined;
  }
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
    const isCatalogRoute = pathname === '/api/model-catalog'
      || pathname === '/api/model-catalog/import'
      || pathname === '/api/model-catalog/refresh';
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
            existing: readExistingEndpointContext(agentDir, providerId, modelId),
          }),
          runtimeDefaults: {
            contextWindow: PI_DEFAULT_CONTEXT_WINDOW,
            maxTokens: PI_DEFAULT_MAX_TOKENS,
          },
        });
        return true;
      }

      if (req.method === 'POST' && pathname === '/api/model-catalog/refresh') {
        guard.assertMutation(req);
        const result = await refreshModelsDevCatalog({
          agentDir,
          fetchImpl: options.fetchImpl,
          now: options.now,
          limits: options.refreshLimits,
          verifyCommitSha: options.verifyCommitSha,
        });
        sendJson(res, 200, result);
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
        assertTrustedCatalogLimits(body, projection);

        const result = await updateModelProviderDocument(agentDir, (configured: any) => {
          const explicitName = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : '';
          const explicitBaseUrl = typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl.trim() : '';
          const modelPatch: any = {
            id: modelId,
            name: explicitName || projection.name,
          };
          if (projection.family) {
            modelPatch.family = projection.family;
          } else {
            modelPatch.family = '';
          }
          if (Object.hasOwn(body, 'reasoning')) {
            modelPatch.reasoning = body.reasoning;
          }
          if (Object.hasOwn(body, 'input')) {
            modelPatch.input = body.input;
          } else if (Array.isArray(projection.input)) {
            modelPatch.input = projection.input;
          }
          for (const field of ['contextWindow', 'maxTokens'] as const) {
            modelPatch[field] = Object.hasOwn(projection, field) ? projection[field] : null;
          }

          const existingProvider = configured.providers && typeof configured.providers[providerId] === 'object' && configured.providers[providerId] !== null
            ? configured.providers[providerId]
            : null;
          const existingModels = existingProvider && Array.isArray(existingProvider.models) ? existingProvider.models : [];

          const mergedModels: any[] = [];
          let replacedExisting = false;
          for (const existingModel of existingModels) {
            const existingId = existingModel && typeof existingModel.id === 'string' ? existingModel.id.trim() : '';
            if (existingId === modelId) {
              mergedModels.push(modelPatch);
              replacedExisting = true;
            } else {
              mergedModels.push(existingModel);
            }
          }
          if (!replacedExisting) {
            mergedModels.push(modelPatch);
          }

          const patch: any = { models: mergedModels };
          const existingName = existingProvider && typeof existingProvider.name === 'string' ? existingProvider.name.trim() : '';
          const existingBaseUrl = existingProvider && typeof existingProvider.baseUrl === 'string' ? existingProvider.baseUrl.trim() : '';
          const existingApi = existingProvider && typeof existingProvider.api === 'string' ? existingProvider.api.trim() : '';
          if (!existingName) {
            patch.name = projection.providerName || projection.providerId;
          }
          if (explicitBaseUrl || !existingBaseUrl) {
            patch.baseUrl = explicitBaseUrl || projection.baseUrl;
          }
          if (!existingApi) {
            patch.api = projection.dialect;
          }

          return patchModelProvider(configured, providerId, patch);
        });
        onCommitted();
        // Advisory post-import diagnostics against the *effective* persisted
        // combination: the stored provider protocol wins over the catalog
        // dialect, and a stored model-level override keeps precedence.
        const persistedProvider = result.document.providers && result.document.providers[providerId];
        const persistedModels = persistedProvider && Array.isArray(persistedProvider.models) ? persistedProvider.models : [];
        const persistedModel = persistedModels.find((entry: any) => entry && typeof entry === 'object' && configText(entry.id) === modelId);
        const providerDiagnostic = persistedProvider
          ? inspectDialectEndpoint(configText(persistedProvider.api), configText(persistedProvider.baseUrl))
          : null;
        const modelEndpointDiagnostic = persistedModel && (configText(persistedModel.api) || configText(persistedModel.baseUrl))
          ? inspectDialectEndpoint(
              configText(persistedModel.api) || configText(persistedProvider.api),
              configText(persistedModel.baseUrl) || configText(persistedProvider.baseUrl))
          : null;
        sendJson(res, 200, {
          ...projectModelProviderDocument(result.document),
          endpointDiagnostic: providerDiagnostic,
          modelEndpointDiagnostic,
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
