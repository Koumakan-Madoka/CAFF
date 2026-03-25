const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DEFAULT_SQLITE_FILENAME = 'pi-state.sqlite';

function resolveSqlitePath(agentDir, sqlitePath) {
  if (sqlitePath) {
    return path.resolve(sqlitePath);
  }

  return path.resolve(agentDir, DEFAULT_SQLITE_FILENAME);
}

function openSqliteDatabase({ agentDir, sqlitePath, timeout = 5000 } = {}) {
  const resolvedAgentDir = path.resolve(agentDir || process.cwd());
  const databasePath = resolveSqlitePath(resolvedAgentDir, sqlitePath);

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

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

module.exports = {
  DEFAULT_SQLITE_FILENAME,
  openSqliteDatabase,
  resolveSqlitePath,
};
