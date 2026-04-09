import * as fs from 'node:fs';
import * as path from 'node:path';

import Database = require('better-sqlite3');

export const DEFAULT_SQLITE_FILENAME = 'pi-state.sqlite';

function isSpecialSqlitePath(sqlitePath?: string): boolean {
  const normalizedPath = String(sqlitePath || '').trim().toLowerCase();
  return normalizedPath === ':memory:' || normalizedPath.startsWith('file:');
}

export function resolveSqlitePath(agentDir: string, sqlitePath?: string): string {
  if (sqlitePath) {
    return isSpecialSqlitePath(sqlitePath) ? String(sqlitePath).trim() : path.resolve(sqlitePath);
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

  if (!isSpecialSqlitePath(databasePath)) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
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
