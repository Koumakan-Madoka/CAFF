import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import Database = require('better-sqlite3');

export const DEFAULT_SQLITE_FILENAME = 'pi-state.sqlite';

function parseSqliteFileUri(sqlitePath?: string) {
  const trimmedPath = String(sqlitePath || '').trim();
  if (!/^file:/i.test(trimmedPath)) {
    return null;
  }

  const rawUri = trimmedPath.slice(5);
  const fragmentIndex = rawUri.indexOf('#');
  const withoutFragment = fragmentIndex >= 0 ? rawUri.slice(0, fragmentIndex) : rawUri;
  const queryIndex = withoutFragment.indexOf('?');

  return {
    rawPath: queryIndex >= 0 ? withoutFragment.slice(0, queryIndex) : withoutFragment,
    query: queryIndex >= 0 ? withoutFragment.slice(queryIndex + 1) : '',
  };
}

function buildNormalizedSqliteFileUri(sqlitePath?: string): string | null {
  const parsedFileUri = parseSqliteFileUri(sqlitePath);
  const resolvedPath = resolveSqliteFileUriPath(sqlitePath);
  if (!parsedFileUri || !resolvedPath) {
    return null;
  }

  const normalizedUri = pathToFileURL(resolvedPath).toString();
  return `${normalizedUri}${parsedFileUri.query ? `?${parsedFileUri.query}` : ''}`;
}

function resolveSqliteOpenOptions(sqlitePath?: string) {
  const parsedFileUri = parseSqliteFileUri(sqlitePath);
  if (!parsedFileUri) {
    return {};
  }

  const params = new URLSearchParams(parsedFileUri.query);
  const unsupportedParamNames = Array.from(
    new Set(
      Array.from(params.keys())
        .map((key) => String(key || '').trim().toLowerCase())
        .filter((key) => key && key !== 'mode')
    )
  );

  if (unsupportedParamNames.length > 0) {
    throw new Error(`Unsupported SQLite URI query parameter(s): ${unsupportedParamNames.join(', ')}`);
  }

  const mode = String(params.get('mode') || '').trim().toLowerCase();
  if (!mode || mode === 'rwc' || mode === 'memory') {
    return {};
  }

  if (mode === 'ro') {
    return { readonly: true };
  }

  if (mode === 'rw') {
    return { fileMustExist: true };
  }

  throw new Error(`Unsupported SQLite URI mode: ${mode}`);
}

function isSpecialSqlitePath(sqlitePath?: string): boolean {
  const normalizedPath = String(sqlitePath || '').trim().toLowerCase();
  if (normalizedPath === ':memory:') {
    return true;
  }

  const parsedFileUri = parseSqliteFileUri(sqlitePath);
  if (!parsedFileUri) {
    return false;
  }

  const params = new URLSearchParams(parsedFileUri.query);
  const mode = String(params.get('mode') || '').trim().toLowerCase();
  return !parsedFileUri.rawPath || parsedFileUri.rawPath === ':memory:' || mode === 'memory';
}

function decodeSqliteUriComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function resolveSqliteFileUriPath(sqlitePath?: string): string | null {
  const parsedFileUri = parseSqliteFileUri(sqlitePath);
  if (!parsedFileUri || isSpecialSqlitePath(sqlitePath)) {
    return null;
  }

  let normalizedPath = decodeSqliteUriComponent(parsedFileUri.rawPath);
  if (normalizedPath.startsWith('//localhost/')) {
    normalizedPath = normalizedPath.slice('//localhost'.length);
  }
  if (/^\/\/\/[A-Za-z]:[\\/]/.test(normalizedPath)) {
    normalizedPath = normalizedPath.slice(3);
  } else if (normalizedPath.startsWith('///')) {
    normalizedPath = normalizedPath.slice(2);
  }

  if (path.isAbsolute(normalizedPath) || /^[A-Za-z]:[\\/]/.test(normalizedPath)) {
    return normalizedPath;
  }

  return path.resolve(normalizedPath);
}

function resolveSqliteParentDir(sqlitePath?: string): string | null {
  const trimmedPath = String(sqlitePath || '').trim();
  if (!trimmedPath || isSpecialSqlitePath(trimmedPath)) {
    return null;
  }

  return path.dirname(resolveSqliteFileUriPath(trimmedPath) || trimmedPath);
}

export function resolveSqlitePath(agentDir: string, sqlitePath?: string): string {
  if (sqlitePath) {
    const normalizedPath = String(sqlitePath).trim();

    if (isSpecialSqlitePath(normalizedPath)) {
      return ':memory:';
    }

    return buildNormalizedSqliteFileUri(normalizedPath) || path.resolve(normalizedPath);
  }

  return path.resolve(agentDir, DEFAULT_SQLITE_FILENAME);
}

export type OpenSqliteDatabaseOptions = {
  agentDir?: string;
  sqlitePath?: string;
  timeout?: number;
  prepareChatSchemaMigration?: boolean;
  chatSchemaBackupScriptPath?: string;
};

export type OpenSqliteDatabaseResult = {
  agentDir: string;
  databasePath: string;
  db: any;
  chatSchemaBackupPath: string;
};

function hasLegacyChatAgentSchema(db: any) {
  const table = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'chat_agents'
    LIMIT 1
  `).get();
  if (!table) {
    return false;
  }
  return !db.prepare('PRAGMA table_info(chat_agents)').all()
    .some((column: any) => String(column.name) === 'role_kind');
}

function buildChatSchemaBackupPath(databaseFilePath: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const basePath = `${databaseFilePath}.pre-model-family-roles.${timestamp}`;
  let candidatePath = `${basePath}.bak`;
  let suffix = 1;
  while (fs.existsSync(candidatePath)) {
    candidatePath = `${basePath}.${suffix}.bak`;
    suffix += 1;
  }
  return candidatePath;
}

function createChatSchemaBackupSync(databaseFilePath: string, backupScriptPath?: string) {
  const resolvedScriptPath = path.resolve(
    String(backupScriptPath || '').trim()
      || path.resolve(__dirname, '..', '..', 'scripts', 'chat-schema-backup.mjs')
  );
  const backupPath = buildChatSchemaBackupPath(databaseFilePath);
  const result = spawnSync(process.execPath, [
    resolvedScriptPath,
    '--source',
    databaseFilePath,
    '--target',
    backupPath,
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || !fs.existsSync(backupPath)) {
    const error: any = new Error('Chat schema backup failed');
    error.code = 'chat_schema_backup_failed';
    throw error;
  }
  return backupPath;
}

function configureDatabase(db: any) {
  if (!db.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  db.pragma('foreign_keys = ON');
}

export function openSqliteDatabase(options: OpenSqliteDatabaseOptions = {}): OpenSqliteDatabaseResult {
  const {
    agentDir,
    sqlitePath,
    timeout = 5000,
    prepareChatSchemaMigration = false,
    chatSchemaBackupScriptPath,
  } = options;
  const resolvedAgentDir = path.resolve(agentDir || process.cwd());
  const databasePath = resolveSqlitePath(resolvedAgentDir, sqlitePath);
  const openOptions = { timeout, ...resolveSqliteOpenOptions(sqlitePath || databasePath) };
  const openPath = resolveSqliteFileUriPath(databasePath) || databasePath;
  const parentDir = resolveSqliteParentDir(databasePath);

  if (parentDir) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  let db;
  let chatSchemaBackupPath = '';

  try {
    db = new Database(openPath, openOptions);
    configureDatabase(db);

    if (
      prepareChatSchemaMigration
      && !db.readonly
      && !isSpecialSqlitePath(databasePath)
      && hasLegacyChatAgentSchema(db)
    ) {
      db.close();
      db = null;
      chatSchemaBackupPath = createChatSchemaBackupSync(openPath, chatSchemaBackupScriptPath);
      db = new Database(openPath, openOptions);
      configureDatabase(db);
    }

    return {
      agentDir: resolvedAgentDir,
      databasePath,
      db,
      chatSchemaBackupPath,
    };
  } catch (error) {
    try {
      db && db.close();
    } catch {}
    throw error;
  }
}
