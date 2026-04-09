import * as fs from 'node:fs';
import * as path from 'node:path';

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

function resolveSqliteFileUriPath(sqlitePath?: string): string | null {
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

  return path.dirname(trimmedPath);
}

export function resolveSqlitePath(agentDir: string, sqlitePath?: string): string {
  if (sqlitePath) {
    if (isSpecialSqlitePath(sqlitePath)) {
      return String(sqlitePath).trim();
    }

    return resolveSqliteFileUriPath(sqlitePath) || path.resolve(sqlitePath);
  }

  return path.resolve(agentDir, DEFAULT_SQLITE_FILENAME);
}

export type OpenSqliteDatabaseOptions = {
  agentDir?: string;
  sqlitePath?: string;
  timeout?: number;
};

export type OpenSqliteDatabaseResult = {
  agentDir: string;
  databasePath: string;
  db: any;
};

export function openSqliteDatabase(options: OpenSqliteDatabaseOptions = {}): OpenSqliteDatabaseResult {
  const { agentDir, sqlitePath, timeout = 5000 } = options;
  const resolvedAgentDir = path.resolve(agentDir || process.cwd());
  const databasePath = resolveSqlitePath(resolvedAgentDir, sqlitePath);
  const parentDir = resolveSqliteParentDir(databasePath);

  if (parentDir) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  const db = new Database(databasePath, { timeout });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  return {
    agentDir: resolvedAgentDir,
    databasePath,
    db,
  };
}
