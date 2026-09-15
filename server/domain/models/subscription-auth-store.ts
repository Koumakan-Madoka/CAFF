import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';

// Mirrors the pinned pi runtime's FileAuthStorageBackend contract
// (@earendil-works/pi-coding-agent dist/core/auth-storage.js): auth.json is a
// JSON object keyed by provider id, serialized with 2-space indentation (no
// trailing newline), written with mode 0600 under a proper-lockfile lock so
// CAFF writes serialize against pi runtime token refreshes.
const AUTH_FILE_WRITE_OPTIONS = { encoding: 'utf-8' as const, mode: 0o600 };
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_BASE_DELAY_MS = 10;
const LOCK_RETRY_MAX_DELAY_MS = 1_000;
const RESERVED_CREDENTIAL_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class SubscriptionAuthStoreError extends Error {
  code: string;
  path: string;

  constructor(code: string, message: string, path = '') {
    super(message);
    this.name = 'SubscriptionAuthStoreError';
    this.code = code;
    this.path = path;
  }
}

function isPlainObject(value: any): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveAuthPath(agentDir: any) {
  const normalizedAgentDir = typeof agentDir === 'string' ? agentDir.trim() : '';
  if (!normalizedAgentDir) {
    throw new SubscriptionAuthStoreError('agent_dir_required', 'agentDir is required', 'agentDir');
  }
  return path.join(path.resolve(normalizedAgentDir), 'auth.json');
}

// writeFileSync's mode option only applies when the file is created, so an
// existing auth.json keeps its original (possibly wider) permissions. The
// pinned pi runtime deliberately preserves administrator-managed modes and
// ACLs on its own agentDir, but CAFF writes OAuth credentials into the shared
// auth.json and its acceptance contract requires the file to stay 0600,
// matching the other secret writers in this codebase
// (model-provider-persistence, models-dev-catalog-cache). A pre-existing
// agentDir directory is left untouched for the same pi-alignment reason.
function tightenAuthFileMode(authPath: string) {
  try {
    fs.chmodSync(authPath, 0o600);
  } catch {
    // Some filesystems (Windows network drives, FAT) reject chmod; the
    // creation-mode path already covers the common case, so this stays
    // best-effort and never blocks a login on an exotic filesystem.
  }
}

function ensureAuthFile(authPath: string) {
  const directoryPath = path.dirname(authPath);
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(authPath)) {
    fs.writeFileSync(authPath, '{}', AUTH_FILE_WRITE_OPTIONS);
  }
  tightenAuthFileMode(authPath);
}

function parseAuthDocument(text: string | undefined, authPath: string) {
  if (!text) {
    return {};
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/u, ''));
  } catch {
    throw new SubscriptionAuthStoreError('auth_document_invalid', `auth.json is not valid JSON: ${authPath}`, 'auth.json');
  }

  if (!isPlainObject(parsed)) {
    throw new SubscriptionAuthStoreError('auth_document_invalid', `auth.json must contain a JSON object: ${authPath}`, 'auth.json');
  }

  return parsed;
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Same retry shape as the pi backend: ELOCKED retries with exponential
// backoff and jitter until a 30s deadline, then the error propagates.
async function acquireAuthLock(authPath: string) {
  const deadline = Date.now() + LOCK_STALE_MS;
  let retry = 0;

  for (;;) {
    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(authPath, {
        realpath: false,
        retries: 0,
        stale: LOCK_STALE_MS,
        onCompromised(error) {
          throw error;
        },
      });
      return release;
    } catch (error: any) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
      const remainingMs = deadline - Date.now();
      if (code !== 'ELOCKED' || remainingMs <= 0) {
        throw new SubscriptionAuthStoreError(
          'auth_lock_failed',
          `Could not lock auth.json: ${error instanceof Error ? error.message : String(error)}`,
          'auth.json'
        );
      }
      const baseDelayMs = Math.min(LOCK_RETRY_BASE_DELAY_MS * 2 ** retry, LOCK_RETRY_MAX_DELAY_MS / 2);
      retry += 1;
      await sleep(Math.min(Math.round(baseDelayMs * (1 + Math.random())), remainingMs));
      release = null;
    }
  }
}

async function withAuthLock<T>(agentDir: any, updater: (document: Record<string, any>) => Promise<T> | T): Promise<T> {
  const authPath = resolveAuthPath(agentDir);
  ensureAuthFile(authPath);

  const release = await acquireAuthLock(authPath);
  try {
    const current = fs.existsSync(authPath) ? fs.readFileSync(authPath, 'utf-8') : undefined;
    const document = parseAuthDocument(current, authPath);
    return await updater(document);
  } finally {
    try {
      await release();
    } catch {
      // Ignore unlock failures; the lock goes stale on its own.
    }
  }
}

function serializeAuthDocument(document: Record<string, any>) {
  return JSON.stringify(document, null, 2);
}

function writeAuthDocument(authPath: string, document: Record<string, any>) {
  fs.writeFileSync(authPath, serializeAuthDocument(document), AUTH_FILE_WRITE_OPTIONS);
  tightenAuthFileMode(authPath);
}

export function validateOAuthCredential(credential: any, providerId: string) {
  const credentialPath = `auth.json.${providerId}`;

  if (!isPlainObject(credential)) {
    throw new SubscriptionAuthStoreError('credential_invalid', 'OAuth credential must be an object', credentialPath);
  }

  if (credential.type !== 'oauth') {
    throw new SubscriptionAuthStoreError('credential_invalid', 'OAuth credential type must be "oauth"', `${credentialPath}.type`);
  }

  if (typeof credential.access !== 'string' || !credential.access) {
    throw new SubscriptionAuthStoreError('credential_invalid', 'OAuth credential requires a string access token', `${credentialPath}.access`);
  }

  if (typeof credential.refresh !== 'string' || !credential.refresh) {
    throw new SubscriptionAuthStoreError('credential_invalid', 'OAuth credential requires a string refresh token', `${credentialPath}.refresh`);
  }

  if (typeof credential.expires !== 'number' || !Number.isFinite(credential.expires)) {
    throw new SubscriptionAuthStoreError('credential_invalid', 'OAuth credential requires a finite numeric expiry', `${credentialPath}.expires`);
  }

  if (
    credential.accountId !== undefined &&
    (typeof credential.accountId !== 'string' || !credential.accountId)
  ) {
    throw new SubscriptionAuthStoreError('credential_invalid', 'OAuth credential accountId must be a non-empty string', `${credentialPath}.accountId`);
  }
}

function validateCredentialKey(providerId: any) {
  const key = typeof providerId === 'string' ? providerId.trim() : '';
  if (!key || key !== providerId || RESERVED_CREDENTIAL_KEYS.has(key)) {
    throw new SubscriptionAuthStoreError('credential_key_invalid', 'auth.json provider key is invalid', 'auth.json');
  }
  return key;
}

export async function writeSubscriptionCredential(agentDir: any, providerId: any, credential: any) {
  const key = validateCredentialKey(providerId);
  validateOAuthCredential(credential, key);

  return withAuthLock(agentDir, (document) => {
    document[key] = credential;
    writeAuthDocument(resolveAuthPath(agentDir), document);
    return true;
  });
}

export async function removeSubscriptionCredential(agentDir: any, providerId: any) {
  const key = validateCredentialKey(providerId);

  return withAuthLock(agentDir, (document) => {
    if (!Object.hasOwn(document, key)) {
      return false;
    }
    delete document[key];
    writeAuthDocument(resolveAuthPath(agentDir), document);
    return true;
  });
}

// Tolerant read for status surfaces: a missing or malformed auth.json simply
// means "not logged in"; malformed content never breaks the provider page.
export function readSubscriptionCredential(agentDir: any, providerId: any) {
  const key = typeof providerId === 'string' ? providerId.trim() : '';
  if (!key) {
    return undefined;
  }

  try {
    const authPath = resolveAuthPath(agentDir);
    if (!fs.existsSync(authPath)) {
      return undefined;
    }
    // A status read must not leave OAuth credentials in a pre-existing wider
    // auth.json either: tighten best-effort so the file cannot keep a mode the
    // acceptance contract forbids just because nobody wrote through the lock.
    tightenAuthFileMode(authPath);
    const parsed = JSON.parse(fs.readFileSync(authPath, 'utf-8').replace(/^\uFEFF/u, ''));
    if (!isPlainObject(parsed)) {
      return undefined;
    }
    const credential = parsed[key];
    return isPlainObject(credential) ? credential : undefined;
  } catch {
    return undefined;
  }
}
