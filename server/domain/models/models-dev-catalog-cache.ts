import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  validateCatalogProvenance,
  validateModelsDevDocument,
} from './models-dev-import';

export const CATALOG_CACHE_FILENAME = 'models-dev-catalog.json';

type CatalogCacheDocument = {
  schemaVersion: 1;
  provenance: Record<string, any>;
  providers: Record<string, any>;
};

export class ModelCatalogCacheError extends Error {
  code: string;
  path: string;

  constructor(code: string, path = '', message = code) {
    super(message);
    this.name = 'ModelCatalogCacheError';
    this.code = code;
    this.path = path;
  }
}

function resolveAgentDir(agentDir: any): string {
  if (typeof agentDir !== 'string' || !agentDir.trim()) {
    throw new ModelCatalogCacheError('catalog_cache_agent_dir_required', 'agentDir');
  }
  return path.resolve(agentDir.trim());
}

function resolveCachePath(agentDir: any): string {
  return path.join(resolveAgentDir(agentDir), CATALOG_CACHE_FILENAME);
}

export function validateCatalogCacheDocument(document: any): CatalogCacheDocument {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new ModelCatalogCacheError('catalog_cache_document_invalid');
  }
  if (document.schemaVersion !== 1) {
    throw new ModelCatalogCacheError('catalog_cache_schema_invalid', 'schemaVersion');
  }

  try {
    validateCatalogProvenance(document.provenance);
    validateModelsDevDocument(document.providers);
  } catch (error: any) {
    if (error instanceof ModelCatalogCacheError) {
      throw error;
    }
    throw new ModelCatalogCacheError(
      'catalog_cache_document_invalid',
      error?.path || 'providers',
      error?.message || 'catalog_cache_document_invalid'
    );
  }

  return document as CatalogCacheDocument;
}

export function readCatalogCache(agentDir: any): CatalogCacheDocument | null {
  const cachePath = resolveCachePath(agentDir);
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  let document: any;
  try {
    document = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    throw new ModelCatalogCacheError('catalog_cache_parse_failed', cachePath);
  }

  return structuredClone(validateCatalogCacheDocument(document));
}

export function atomicReplaceCatalogCache(agentDir: any, document: any) {
  const cachePath = resolveCachePath(agentDir);
  const validated = validateCatalogCacheDocument(document);
  const directory = path.dirname(cachePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const tempPath = `${cachePath}.tmp-${randomUUID()}`;
  let tempCreated = false;
  try {
    const handle = fs.openSync(tempPath, 'wx', 0o600);
    tempCreated = true;
    try {
      fs.writeFileSync(handle, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8' });
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(tempPath, cachePath);
    tempCreated = false;
    fs.chmodSync(cachePath, 0o600);

    return {
      path: cachePath,
      document: structuredClone(validated),
    };
  } finally {
    if (tempCreated) {
      fs.rmSync(tempPath, { force: true });
    }
  }
}

export function selectCatalogSource(sources: any = {}) {
  if (sources.modelsJson !== undefined && sources.modelsJson !== null) {
    return { kind: 'models-json', value: sources.modelsJson };
  }
  if (sources.explicitImport !== undefined && sources.explicitImport !== null) {
    return { kind: 'explicit-import', value: sources.explicitImport };
  }
  if (sources.onlineCache !== undefined && sources.onlineCache !== null) {
    return { kind: 'online-cache', value: sources.onlineCache };
  }
  if (sources.vendored !== undefined && sources.vendored !== null) {
    return { kind: 'vendored-snapshot', value: sources.vendored };
  }
  return { kind: 'empty', value: null };
}
