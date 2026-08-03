import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import {
  ModelProviderConfigError,
  validateModelProviderDocument,
} from './model-provider-config';

const writeQueues = new Map<string, Promise<void>>();
const validatedPiSchemaHashes = new Map<string, true>();
const MAX_SCHEMA_VALIDATION_CACHE_ENTRIES = 64;
const DIRECTORY_SYNC_UNSUPPORTED_CODES = new Set([
  'EACCES',
  'EBADF',
  'EINVAL',
  'EISDIR',
  'ENOTSUP',
  'EPERM',
]);
const PI_MODEL_CONFIG_VALIDATOR_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'lib',
  'pi-model-config-validator.mjs'
);

type Durability = 'durable' | 'directory_sync_unsupported';

type ReplaceOptions = {
  beforeReplace?: (context: { backupPath: string | null; path: string; tempPath: string }) => any;
  now?: () => Date;
};

function resolveAgentDir(agentDir: any) {
  const normalized = typeof agentDir === 'string' ? agentDir.trim() : '';
  if (!normalized) {
    throw new ModelProviderConfigError('provider_agent_dir_required', 'agentDir');
  }

  return path.resolve(normalized);
}

function resolveConfigPath(agentDir: any) {
  return path.join(resolveAgentDir(agentDir), 'models.json');
}

function skipWhitespace(text: string, startIndex: number) {
  let index = startIndex;
  while (/\s/u.test(text[index] || '')) {
    index += 1;
  }
  return index;
}

function readJsonString(text: string, startIndex: number) {
  let index = startIndex + 1;
  let escaped = false;

  while (index < text.length) {
    const character = text[index];
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      const raw = text.slice(startIndex, index + 1);
      return { nextIndex: index + 1, value: JSON.parse(raw) };
    }
    index += 1;
  }

  return { nextIndex: text.length, value: '' };
}

function skipJsonValue(text: string, startIndex: number): number {
  let index = skipWhitespace(text, startIndex);
  const initial = text[index];

  if (initial === '"') {
    return readJsonString(text, index).nextIndex;
  }

  if (initial === '{') {
    index = skipWhitespace(text, index + 1);
    while (text[index] !== '}') {
      const key = readJsonString(text, index);
      index = skipWhitespace(text, key.nextIndex);
      index = skipJsonValue(text, skipWhitespace(text, index + 1));
      index = skipWhitespace(text, index);
      if (text[index] === ',') {
        index = skipWhitespace(text, index + 1);
      }
    }
    return index + 1;
  }

  if (initial === '[') {
    index = skipWhitespace(text, index + 1);
    while (text[index] !== ']') {
      index = skipJsonValue(text, index);
      index = skipWhitespace(text, index);
      if (text[index] === ',') {
        index = skipWhitespace(text, index + 1);
      }
    }
    return index + 1;
  }

  while (index < text.length && !/[\s,}\]]/u.test(text[index])) {
    index += 1;
  }
  return index;
}

function findDuplicateProviderId(text: string) {
  let index = skipWhitespace(text, 0);
  if (text[index] !== '{') {
    return '';
  }

  index = skipWhitespace(text, index + 1);
  while (text[index] !== '}' && index < text.length) {
    const key = readJsonString(text, index);
    index = skipWhitespace(text, key.nextIndex);
    const valueStart = skipWhitespace(text, index + 1);

    if (key.value === 'providers' && text[valueStart] === '{') {
      const providerIds = new Set<string>();
      let providerIndex = skipWhitespace(text, valueStart + 1);
      while (text[providerIndex] !== '}' && providerIndex < text.length) {
        const providerKey = readJsonString(text, providerIndex);
        if (providerIds.has(providerKey.value)) {
          return providerKey.value;
        }
        providerIds.add(providerKey.value);
        providerIndex = skipWhitespace(text, providerKey.nextIndex);
        providerIndex = skipJsonValue(text, skipWhitespace(text, providerIndex + 1));
        providerIndex = skipWhitespace(text, providerIndex);
        if (text[providerIndex] === ',') {
          providerIndex = skipWhitespace(text, providerIndex + 1);
        }
      }
    }

    index = skipJsonValue(text, valueStart);
    index = skipWhitespace(text, index);
    if (text[index] === ',') {
      index = skipWhitespace(text, index + 1);
    }
  }

  return '';
}

function validatePinnedPiSchema(serialized: string) {
  const digest = createHash('sha256').update(serialized).digest('hex');
  if (validatedPiSchemaHashes.has(digest)) {
    return;
  }

  const result = spawnSync(process.execPath, [PI_MODEL_CONFIG_VALIDATOR_PATH, '--stdin'], {
    encoding: 'utf8',
    input: serialized,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });

  let response: any = null;
  try {
    response = JSON.parse(String(result.stdout || ''));
  } catch {}

  if (result.status !== 0 || response?.ok !== true) {
    throw new ModelProviderConfigError('provider_document_schema_invalid', 'models.json');
  }

  validatedPiSchemaHashes.set(digest, true);
  if (validatedPiSchemaHashes.size > MAX_SCHEMA_VALIDATION_CACHE_ENTRIES) {
    const oldestDigest = validatedPiSchemaHashes.keys().next().value;
    if (oldestDigest) {
      validatedPiSchemaHashes.delete(oldestDigest);
    }
  }
}

function parseDocument(text: string, configPath: string) {
  let document: any;

  try {
    document = JSON.parse(text);
  } catch {
    throw new ModelProviderConfigError('provider_document_parse_failed', configPath);
  }

  const duplicateProviderId = findDuplicateProviderId(text);
  if (duplicateProviderId) {
    throw new ModelProviderConfigError('provider_duplicate', `providers.${duplicateProviderId}`);
  }

  validateModelProviderDocument(document);
  validatePinnedPiSchema(text);
  return document;
}

function writeAndSyncFile(filePath: string, content: string) {
  const handle = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, content, { encoding: 'utf8' });
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }

  fs.chmodSync(filePath, 0o600);
}

function syncExistingFile(filePath: string) {
  const handle = fs.openSync(filePath, 'r+');
  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function syncDirectory(directoryPath: string): Durability {
  let handle: number | null = null;

  try {
    handle = fs.openSync(directoryPath, 'r');
    fs.fsyncSync(handle);
    return 'durable';
  } catch (error: any) {
    if (DIRECTORY_SYNC_UNSUPPORTED_CODES.has(String(error && error.code))) {
      return 'directory_sync_unsupported';
    }
    throw error;
  } finally {
    if (handle !== null) {
      fs.closeSync(handle);
    }
  }
}

function formatBackupTimestamp(now: Date) {
  return now.toISOString().replace(/[:.]/gu, '-');
}

function createBackup(configPath: string, now: Date) {
  if (!fs.existsSync(configPath)) {
    return null;
  }

  const backupPath = `${configPath}.pre-model-provider-config.${formatBackupTimestamp(now)}.${randomUUID()}.bak`;
  fs.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backupPath, 0o600);
  syncExistingFile(backupPath);
  return backupPath;
}

async function withWriteQueue<T>(configPath: string, operation: () => Promise<T>) {
  const previous = writeQueues.get(configPath) || Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const settled = run.then(() => undefined, () => undefined);
  writeQueues.set(configPath, settled);

  try {
    return await run;
  } finally {
    if (writeQueues.get(configPath) === settled) {
      writeQueues.delete(configPath);
    }
  }
}

async function replaceDocumentUnlocked(configPath: string, document: any, options: ReplaceOptions = {}) {
  validateModelProviderDocument(document);
  const directoryPath = path.dirname(configPath);
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  validatePinnedPiSchema(serialized);
  const tempPath = `${configPath}.tmp-${randomUUID()}`;
  let backupPath: string | null = null;
  let tempCreated = false;

  if (fs.existsSync(configPath)) {
    readModelProviderDocument(directoryPath);
  }

  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });

  try {
    backupPath = createBackup(configPath, (options.now || (() => new Date()))());
    writeAndSyncFile(tempPath, serialized);
    tempCreated = true;

    if (options.beforeReplace) {
      await options.beforeReplace({ backupPath, path: configPath, tempPath });
    }

    fs.renameSync(tempPath, configPath);
    tempCreated = false;
    fs.chmodSync(configPath, 0o600);
    const durability = syncDirectory(directoryPath);

    return {
      backupPath,
      document: structuredClone(document),
      durability,
      path: configPath,
    };
  } finally {
    if (tempCreated) {
      fs.rmSync(tempPath, { force: true });
    }
  }
}

export function readModelProviderDocument(agentDir: any) {
  const configPath = resolveConfigPath(agentDir);
  if (!fs.existsSync(configPath)) {
    return { providers: {} };
  }

  const text = fs.readFileSync(configPath, 'utf8');
  return parseDocument(text, configPath);
}

export async function atomicReplaceModelProviderDocument(
  agentDir: any,
  document: any,
  options: ReplaceOptions = {}
) {
  const configPath = resolveConfigPath(agentDir);
  return withWriteQueue(configPath, () => replaceDocumentUnlocked(configPath, document, options));
}

export async function updateModelProviderDocument(
  agentDir: any,
  updater: (document: any) => any,
  options: ReplaceOptions = {}
) {
  const configPath = resolveConfigPath(agentDir);

  if (typeof updater !== 'function') {
    throw new ModelProviderConfigError('provider_updater_required', 'updater');
  }

  return withWriteQueue(configPath, async () => {
    const current = readModelProviderDocument(path.dirname(configPath));
    const next = await updater(structuredClone(current));
    return replaceDocumentUnlocked(configPath, next, options);
  });
}
