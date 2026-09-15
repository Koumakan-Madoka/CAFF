import { createHash } from 'node:crypto';

import {
  ModelCatalogError,
  validateModelsDevDocument,
} from './models-dev-import';
import {
  atomicReplaceCatalogCache,
  readCatalogCache,
} from './models-dev-catalog-cache';

// Fixed online source for the models.dev catalog. The URL is intentionally
// not configurable: provenance and review guarantees only hold for the
// audited upstream endpoint documented in assets/model-catalog.SOURCE.md.
export const MODELS_DEV_API_URL = 'https://models.dev/api.json';
export const MODELS_DEV_COMMIT_URL = 'https://api.github.com/repos/anomalyco/models.dev/commits/dev';

export const DEFAULT_MODELS_DEV_REFRESH_LIMITS = Object.freeze({
  requestTimeoutMs: 15000,
  commitTimeoutMs: 10000,
  maxPayloadBytes: 32 * 1024 * 1024,
  maxProviders: 2000,
  maxModelsPerProvider: 5000,
});

export type ModelsDevRefreshLimits = typeof DEFAULT_MODELS_DEV_REFRESH_LIMITS;

type CatalogRefreshOutcome =
  | {
      status: 'refreshed';
      provenance: Record<string, any>;
      providerCount: number;
      cachePath: string;
    }
  | {
      status: 'not_modified';
      provenance: Record<string, any> | null;
      providerCount: number | null;
    };

function isAbortError(error: any) {
  return Boolean(error)
    && (error.name === 'AbortError'
      || error.code === 'ABORT_ERR'
      || /abort|timed? ?out/iu.test(String(error?.message || '')));
}

function toRefreshError(error: any) {
  if (error instanceof ModelCatalogError) {
    return error;
  }
  if (isAbortError(error)) {
    return new ModelCatalogError('catalog_refresh_timeout', 'sourceUrl', 'models.dev refresh timed out');
  }
  return new ModelCatalogError(
    'catalog_refresh_source_failed',
    'sourceUrl',
    error?.message || 'models.dev refresh request failed'
  );
}

async function readBodyWithLimit(response: any, maxBytes: number): Promise<Buffer> {
  const contentLengthHeader = response?.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-length')
    : null;
  const contentLength = Number.parseInt(String(contentLengthHeader || ''), 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ModelCatalogError(
      'catalog_refresh_payload_too_large',
      'sourceUrl',
      `models.dev payload content-length ${contentLength} exceeds limit ${maxBytes}`
    );
  }

  const body = response?.body;
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += piece.length;
      if (total > maxBytes) {
        throw new ModelCatalogError(
          'catalog_refresh_payload_too_large',
          'sourceUrl',
          `models.dev payload exceeds limit ${maxBytes}`
        );
      }
      chunks.push(piece);
    }
    return Buffer.concat(chunks);
  }

  if (typeof response?.arrayBuffer === 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new ModelCatalogError(
        'catalog_refresh_payload_too_large',
        'sourceUrl',
        `models.dev payload exceeds limit ${maxBytes}`
      );
    }
    return buffer;
  }

  throw new ModelCatalogError('catalog_refresh_source_failed', 'sourceUrl', 'models.dev response body is not readable');
}

function assertCatalogCounts(document: any, limits: ModelsDevRefreshLimits) {
  const providerIds = Object.keys(document);
  if (providerIds.length > limits.maxProviders) {
    throw new ModelCatalogError(
      'catalog_refresh_provider_count_exceeded',
      'providers',
      `models.dev document has ${providerIds.length} providers, limit is ${limits.maxProviders}`
    );
  }
  for (const [providerId, provider] of Object.entries(document) as Array<[string, any]>) {
    const models = provider && typeof provider === 'object' && provider.models && typeof provider.models === 'object'
      ? provider.models
      : null;
    const modelCount = models ? Object.keys(models).length : 0;
    if (modelCount > limits.maxModelsPerProvider) {
      throw new ModelCatalogError(
        'catalog_refresh_model_count_exceeded',
        `providers.${providerId}.models`,
        `models.dev provider ${providerId} has ${modelCount} models, limit is ${limits.maxModelsPerProvider}`
      );
    }
  }
}

async function fetchVerifiedCommitSha(fetchImpl: any, limits: ModelsDevRefreshLimits): Promise<string | undefined> {
  // commitSha is recorded only when independently verified against the
  // upstream GitHub API in the same retrieval window (see AC-1 provenance
  // rules). Any failure here must never block a refresh; provenance simply
  // omits the field.
  try {
    const response = await fetchImpl(MODELS_DEV_COMMIT_URL, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'caff-model-catalog-refresh',
      },
      signal: AbortSignal.timeout(limits.commitTimeoutMs),
    });
    if (!response || !response.ok) {
      return undefined;
    }
    const parsed = await response.json();
    const sha = typeof parsed?.sha === 'string' ? parsed.sha.trim() : '';
    return sha || undefined;
  } catch {
    return undefined;
  }
}

export async function refreshModelsDevCatalog(options: any = {}): Promise<CatalogRefreshOutcome> {
  if (typeof options.agentDir !== 'string' || !options.agentDir.trim()) {
    throw new ModelCatalogError('catalog_refresh_agent_dir_required', 'agentDir');
  }
  const agentDir = options.agentDir;
  const limits: ModelsDevRefreshLimits = { ...DEFAULT_MODELS_DEV_REFRESH_LIMITS, ...(options.limits || {}) };
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  // A corrupted or schema-drifted last-known-good cache must not block a
  // refresh: the refresh path treats it as absent and overwrites on success.
  let priorCache: any = null;
  try {
    priorCache = readCatalogCache(agentDir);
  } catch {
    priorCache = null;
  }
  const priorEtag = priorCache && typeof priorCache.provenance?.etag === 'string' && priorCache.provenance.etag.trim()
    ? priorCache.provenance.etag.trim()
    : '';

  let response: any;
  try {
    response = await fetchImpl(MODELS_DEV_API_URL, {
      headers: {
        accept: 'application/json',
        ...(priorEtag ? { 'if-none-match': priorEtag } : {}),
      },
      signal: AbortSignal.timeout(limits.requestTimeoutMs),
    });
  } catch (error) {
    throw toRefreshError(error);
  }

  if (response && response.status === 304) {
    return {
      status: 'not_modified',
      provenance: priorCache ? priorCache.provenance : null,
      providerCount: priorCache ? Object.keys(priorCache.providers).length : null,
    };
  }
  if (!response || !response.ok) {
    throw new ModelCatalogError(
      'catalog_refresh_source_failed',
      'sourceUrl',
      `models.dev responded with ${response ? response.status : 'no response'}`
    );
  }

  let payload: Buffer;
  try {
    payload = await readBodyWithLimit(response, limits.maxPayloadBytes);
  } catch (error: any) {
    // Body streaming happens after response headers arrive, so a mid-body
    // timeout/reset must still surface as a typed catalog_refresh_* error
    // instead of escaping as a raw AbortError (F1 from review of d539d89).
    throw toRefreshError(error);
  }

  let document: any;
  try {
    document = JSON.parse(payload.toString('utf8'));
  } catch {
    throw new ModelCatalogError('catalog_refresh_payload_invalid', 'sourceUrl', 'models.dev payload is not valid JSON');
  }
  try {
    validateModelsDevDocument(document);
  } catch (error: any) {
    if (error instanceof ModelCatalogError) {
      throw new ModelCatalogError('catalog_refresh_payload_invalid', error.path, error.message);
    }
    throw error;
  }
  assertCatalogCounts(document, limits);

  const etagHeader = response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('etag')
    : null;
  const etag = typeof etagHeader === 'string' && etagHeader.trim() ? etagHeader.trim() : '';
  const commitSha = options.verifyCommitSha === false
    ? undefined
    : await fetchVerifiedCommitSha(fetchImpl, limits);

  const provenance: Record<string, any> = {
    kind: 'online',
    sourceUrl: MODELS_DEV_API_URL,
    payloadSha256: createHash('sha256').update(payload).digest('hex'),
    fetchedAt: now().toISOString(),
  };
  if (etag) {
    provenance.etag = etag;
  }
  if (commitSha) {
    provenance.commitSha = commitSha;
  }

  const write = atomicReplaceCatalogCache(agentDir, {
    schemaVersion: 1,
    provenance,
    providers: document,
  });

  return {
    status: 'refreshed',
    provenance: write.document.provenance,
    providerCount: Object.keys(document).length,
    cachePath: write.path,
  };
}
